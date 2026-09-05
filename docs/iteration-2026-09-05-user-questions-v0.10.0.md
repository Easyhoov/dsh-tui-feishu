# 迭代记录：ask_user_question 飞书问卷卡（v0.10.0，2026-09-05）

> 背景：`docs/2026-09-05-ask-user-question-stuck-diagnosis.md`（Hermes 诊断）
> 修复方向 1 的实现。诊断结论：`ask_user_question` 卡死根因 = user-questions
> seam 只有一个 UI provider 席位且被 dsh-tui 自带 QuestionStore（TUI 面板）
> 占用，飞书用户看不到问卷 → 当前回合永不结束 → 后续消息永远排队（死锁闭环）。
>
> 产出：v0.10.0（本迭代），测试 20 项新增全绿。

> ⚠️ **v0.10.1 补丁（2026-09-05，Hermes 实施）**：v0.10.0 的
> `installUserQuestionsProvider` 用 `const register = service.registerProvider;
> register(provider)` 解绑调用，ESM 严格模式 `this = undefined` →
> 启动崩溃 `reading 'ctx'`（详见 CHANGELOG 0.10.1）。已直调修复并重新
> 打包装入；本迭代文档其余内容不变。

## 1. 为什么不能直接 registerProvider

宿主配对（dsh 0.1.1-rc.2 / dsh-tui 0.10.0-beta.4）的
`@deepseek-ai/dsh-user-questions` 是 **legacy 单席位**：

- `UserQuestionService.registerProvider(provider)` 席位全局唯一，已占用时抛
  `DUPLICATE_PROVIDER`；**没有** alpha.2 的 `user-questions/request` waterfall
  （全 profile node_modules 内唯一出现该事件名的是 dsh-tui 的
  `questions-answerer.js` 监听器，无任何 emittter → waterfall 分支在此配对下
  永远不触发）。
- dsh-tui 启动即经 `prepareQuestionAnswerer` 注册 QuestionStore（面板），席位
  已被占用；桥再调 `registerProvider` 必抛 DUPLICATE。
- 唯一公平的前门方案是**席位交接 + 委派**：桥成为 provider 席位，但对**非桥接
  agent 的提问委派回被捕获的 incumbent**（TUI 的 `{ask}` 包装），TUI 面板行为
  原样保留——两扇门各答各的问题。

## 2. 实现

### 2.1 `src/user-questions.ts`（新）

- 结构性子集类型（不 import `@deepseek-ai/dsh-user-questions`，与既有
  approval/agent 的 loose-coupling 风格一致）。
- `createQuestionError`：镜像上游 `UserQuestionError` 的 name + code
  （`ASK_ABORTED`/`ASK_CANCELLED` 文案同 upstream），dsh-plan-mode 可按 code 识别。
- `installUserQuestionsProvider(service, provider, onHandover)` → `QuestionSeat`：
  1. 空席位：走公开 `registerProvider`（活跃 ctx 上同步执行，返回 disposer）；
  2. `DUPLICATE_PROVIDER`（或没有 registerProvider）：结构性交接——探针
     `service.provider`（与 dsh-tui providerGuard 同款结构读取），捕获 incumbent
     作为 `delegate`，直接替换 `service.provider`；dispose 时仅当自己仍持席位才
     还原 incumbent（幂等）；
  3. 连 provider 槽都没有（waterfall 世代宿主）：**不安装**（防止对不可用槽位
     的静默 no-op 再次造成死锁），告警日志说明。
- 卡片构建纯函数：`buildQuestionCardBody`（单选按钮/多选 toggled+完成按钮/
  plan-review violet 模板与 approve 高亮/note 提示打字兜底）、settled/cancelled
  终态卡、纯文本降级文案。

### 2.2 `src/bridge.ts`：问答批生命周期

- `askUserQuestion(chatId, request)`：每聊天空闲时注册 batch（忙时抛
  `ASK_IN_PROGRESS`）；多问题逐张卡片顺序呈现；`request.signal` abort / bridge
  dispose → `ASK_ABORTED` 拒绝 + 灰卡收尾。
- 操作**串行链**（`batch.op` promise chain，`withQuestionOp`）：卡片点击与文字
  回答共享链，任何迟到点击（旧卡消息 id / 旧 qid）在链内复查后忽略——不会答错
  题。单选 = 点选项即答；多选 = 点选高亮（updateCard 重渲染 primary）+
  「✅ 完成选择」；无卡片能力（sendCard 失败）→ 纯文本提问，收到文字回答后发
  ✅ 回执。
- 文本兜底：`tryAnswerQuestionText`（handleIncoming 内，命令之外）：pending 时
  下一条文字即答案——与选项 label 完全匹配（空白归一）按选项计，否则 custom。
  被消费的文字**不进 agent inbox**（这正是修复死锁的关键：inbox 只是下一回合
  消息流，无法 settle 挂起的 ask）。
- 授权：卡片按钮 operator 走既有 senderAllowed 白名单。

### 2.3 `src/index.ts`：席位接线

- `startBridge` 内软探测 `ctx.get('userQuestions')`：缺失 → warn 降级（桥其他
  能力不受影响）。
- 构建路由 provider：`agent` 能映射到桥接 chat（`sessionMap.chatFor`）→
  `bridge.askUserQuestion`（飞书卡片）；否则 `questionSeat.delegate`（TUI 面板）；
  两者皆无 → 明确错误拒绝（不静默挂起）。
- 席位在桥替换/停用时归还（startBridge 顶部 dispose 旧 seat + ctx.effect 清理）。

## 3. 验证

- `test/user-questions.mjs`（20 项 node:test）：seat 空位注册 / 占用交接+委派 /
  waterfall 世代跳过、卡片构建（单选/多选/plan-review/终态/纯文本）、单选即答、
  打字 custom 答案不进 inbox、选项文字精确匹配、多题顺序、多选 toggle+done、
  abort 拒绝、dispose 拒绝、同聊并发的第二次 ask 拒绝、卡片失败纯文本兜底+回执、
  迟到点击不串题、越权 operator 拒绝。
- `npm run verify`：构建 + validate:manifest + 全部套件绿。

## 4. 部署与线上行为

- profile 内 `dsh plugin --profile dsh-tui add file:...tgz`，重启 dsh-tui 后生效。
- 预期线上行为（bridge.log 可观测）：
  - 启动日志：`user-questions seat handed over from the incumbent provider...`；
  - Feishu 端 ask 出现 ❓ 卡片，点选/打字后当前回合继续（不再卡死）；
  - TUI 端发起的提问仍弹 TUI 面板（委派路径），行为不变。
