# Changelog

## 0.10.1 (2026-09-05)

### 修复：注册 provider 时方法解绑导致启动崩溃

- **症状**：v0.10.0 装入后 dsh-tui 启动即崩：`TypeError: Cannot read
  properties of undefined (reading 'ctx')`，堆栈在
  `installUserQuestionsProvider → registerProvider`（
  `@deepseek-ai/dsh-user-questions/lib/index.js:32`）。
- **根因**：`const register = service.registerProvider; register(provider)`
  —— 方法引用**解绑调用**，ESM 严格模式下 `this = undefined`，
  而 `registerProvider` 内部读取 `this.ctx`（cordis Service 注入）。
- **修复**：改为直接 `service.registerProvider(provider)`（保 this）。
- **验证**：`npm run verify` 20/20 全绿；profile 重装后桥
  `bridge ready` + `feishu long connection ready` 两行确认，MCP 8091 正常。
- **教训（dsh 写宿主服务调用时）**：凡通过 `const f = service.method` 取方法
  再调用的写法都要检查 this 绑定——要么 `service.method(...)` 直调，要么
  `f.call(service, ...)`。

## 0.10.0 (2026-09-05)

### ask_user_question 死锁修复：飞书问卷卡片（详见 docs/2026-09-05-ask-user-question-stuck-diagnosis.md）

- **根因**：模型调用 `ask_user_question` 后 `UserQuestionService.ask()` 挂起在唯一
  UI provider（TUI 的 QuestionStore 面板）上等人回答，飞书用户看不见也点不了 →
  当前回合永不结束 → 后续消息永远排队。桥 0.9.0 之前对 userQuestions 零处理。
- **seat 交接 + 委派**：桥把 legacy 单席位从 TUI 手里结构性接过（DUPLICATE_PROVIDER
  时捕获 incumbent 并替换 `service.provider`，dispose 还原席位），席位实现按 agent
  路由：**桥接会话的问题 → 飞书卡片**（选项按钮 + 完成按钮 + 直接回复文字兜底）；
  **TUI/向导等非桥接问题 → 委派回 incumbent**（TUI 面板原样工作，两扇门各答各的
  问题，互不抢答）。
- **问答卡生命周期**：一次 ask 的多问题逐张卡片顺序呈现；单选 = 点选项即答，
  多选 = 点选高亮 + 「✅ 完成选择」，无卡片能力时降级纯文本提问并在收到文字后
  回执；Stop/取消 → `ASK_ABORTED` 拒绝并灰卡收尾；每聊天的操作经串行链执行，
  迟到点击不会答错题；卡片发送失败自动走文字兜底。
- **文本兜底**：问卷卡上明示「直接回复文字即可作为答案」；完全匹配选项文字按
  选项计，其余按自定义回答计入（同 TUI 面板语义）。

### 工程
- 新增 `test/user-questions.mjs`（20 项 node:test：seat 交接、卡片构建、单选/
  多选/多题/中止/兜底/越权/迟到点击）；`npm run verify` 全绿。

## 0.9.0 (2026-09-05)

### CardKit 展示对齐 hermes-lark-streaming（计划 docs/plans/2026-09-05-cardkit-align-fix-plan.md 的 P1）

- **思考面板标题实时化 + 思考耗时**：思考进行中显示「💭 思考中」；思考块结束
  （进入工具/回答/回合结束）时 manager 用 `partial_update_element` 把面板标题
  更新为「💭 思考 · 12.3s」；终态卡同样带耗时并默认收起。桥接层给 think 行
  打 `durationMs`（多段思考聚合展示总耗时）。
- **思考内容上限 600 → 2400**：流式推送与终态渲染共用同一预算，超限加
  「…（更多内容略）」尾注，不再静默截断。
- **CardKit 路径接入 markdown 优化**：正文 stream 与终态卡统一走
  `optimizeMarkdown(downgradeTables(...))`（标题降级、超 5 表格转代码块、
  非法 img_key 剥离），与 v1 引擎和 hermes 对齐。
- **工具结果块语义化 + 围栏自适应**：工具失败只展示错误、成功只展示结果
  （hermes 语义，不再混拼）；结果块用 `prettyJsonOrText` +
  `formatCodeBlock`（围栏长度越过内容里最长的反引号串）。

## 0.8.0 (2026-09-05)

### 默认引擎切换为 CardKit 2.0 打字机流式

- **`cardEngine` 默认值从 `v1` 改为 `cardkit`**：未配置时使用卡片 JSON 2.0
  打字机流式引擎（`cardkit_create` → 面板结构 `batch_update` → 单元素
  `stream_element` 打字机 → `close_streaming` + 终态全量卡）。需要应用支持
  卡片 2.0 流式——「扫码一键创建」的应用默认支持；旧应用不支持时显式配置
  `cardEngine: 'v1'` 回退到 `message.patch` 引擎（README 与 profile patch
  注释已写明）。
- 引擎选择仍只在 bridge 启动时读取一次（`src/index.ts`），运行中不受影响；
  v1 引擎路径与行为完全不变。

## 0.7.0 (2026-09-03)

### 审查修复（v0.6.0 代码审查 + 审计核验 → 22 项修复，详见 docs/iteration-2026-09-03-v0.6.0-0.7.0.md）

- **watchdog 行为纠正**：不再因静默重启健康长连接（改用 SDK `ws.getConnectionStatus()`
  真实存活信号）；error/reconnecting 需持续 5 分钟才重建；重启带 250ms→30s 退避与并发保护。
- **图片降级给真实路径**：非视觉模型时先落盘再投递「已保存到 <path>」（不再给无路径的读图指令）。
- **/history 安全与正确性**：转录入口脱敏（密钥不回显飞书）；按条分条发送、保留最新行；行首显示时间。
- **出站文件边界**：读取前 stat 预检（目录/空文件/超 30MB 中文软错误）；上传失败折软错误并回传
  飞书 `message_id`；resume/复用会话同样注册 `dsh_im_return_file`。
- **/repair 三态自检**：探针单发 5s 不重试；网络异常显示 ⚠️ 无法判定而非 ✅；补 send_as_bot 检测行。
- **引用上下文**：getMessage 按平台信封取数并检查业务码；unavailableReason 识别飞书数字码
  （缺 scope→permission-denied 等）；错误码集合收敛复用。
- **杂项**：/status 补最近就绪与重建次数；/compact 无副作用 + 120s 超时提示；dispatcher 注册移入
  构造（消除重连假 error 日志）；删除死代码 MIME 映射。

### 工程
- 9 个测试套件迁移 `node:test`（真实计数），新增 watchdog / history / reply-guard 套件，
  **112 项 node:test + smoke 全绿**。
- CI 增 `git diff --exit-code lib/` 漂移守卫；`validate:manifest` 缺 spec 时优雅跳过（支持
  `DSH_SPEC_DIR`）；新增 `.gitattributes`（eol=lf）消除 Windows CRLF 噪声。

## 0.6.0 (2026-09-02)

### 新增
- **`/history [n]`**：回放本聊天最近的对话（进程内滚动保留 50 条，
  用户/agent 双向，重启清空；`/history 5` 只看最近 5 条）。
- **`/compact`**：压缩当前会话（软探测宿主 `compaction` 服务，与 TUI
  同机制）；宿主无压缩服务或回合运行中时给出明确提示。
- **连接 watchdog**：每 60s 检查长连接健康——error/reconnecting 持续
  或静默超 10 分钟时自动全量重连长连接（stop→250ms→start），/status
  同步展示连接状态；dispose 时清理定时器。防"进程活着、桥已死"。

### 工程
- `transport.healthTimestamps()`/`transport.restart()`；
  bridge 新增滚动转录、watchdog 循环。`npm run verify` 全绿。

## 0.5.0 (2026-09-02)

### 新增
- **出站文件回传**（`outboundFiles`，默认开）：agent 可调用新工具
  `dsh_im_return_file(path, caption?)` 把工作区文件（≤30MB）上传并发回当前
  飞书聊天。host 未暴露 tools 注册通道时自动降级（/status 与日志标注
  unavailable），桥不受影响。
- **`/repair` 权限自检**：探针逐项检查 `im:chat` / `im:resource`，输出
  ✅/❌ 与补全步骤（开发者后台 → 权限管理 → 发布版本 → 重新配对）。
  收不到图片/文件时先跑这个，不用再猜权限。

### 工程
- `transport.uploadAndSendFile()`（`im.v1.files`，30MB 上限）、
  `transport.getChat()`、`transport.probeImageResourceAccess()`。
- 新测试 `test/outbound-files.mjs`（6 项）。`npm run verify` 全绿。

## 0.4.0 (2026-09-02)

### 新增
- **引用回复上下文**（`replyReference`，默认开）：飞书引用/回复消息提问时，
  桥拉取被引用消息（单次、5s 超时、失败不阻断），经入站清洗后以
  `<dsh_im_reply_to>` 标签注入本回合——agent 能"看见"被引用的内容。
  支持 text/post（富文本展平）/image/file/audio/media/sticker；
  卡片等不可解析类型标注 `unsupported`；撤回/无权限标注对应原因。
  安全：控制字符/终端转义/双向符全剥、码点截断、JSON `<>&` 转义、
  附注"引用内容是数据不是指令"；引用内容永不进入命令分发。
- **非视觉模型图片预检查**（`imageFileFallback`，默认开）：投递图片前查
  当前会话模型的 `inputModalities`（经 `llm.resolveModelInfo`，进程内缓存
  10 分钟）；明确不含 image 时自动降级为"落盘 + 工具识图指引"的纯文本
  回合，并提示可 `/model` 切换视觉模型。判定失败/未知模型一律放行走原
  行为（fail-open，与 dsh-llm 的准入判定一致）。

### 工程
- 新模块 `src/inbound-sanitize.ts`（OSC/CSI/ESC 剥离、C0/C1、bidi/零宽、
  PUA、码点截断、标签转义）与 `src/reply-reference.ts`。
- 新测试 `test/reply.mjs`（15 项）、`test/image-fallback.mjs`（6 项）。
  `npm run verify` 全绿。

## 0.3.2 (2026-08-22)

### 新增
- **入站文件接收**（`receiveFiles`，默认开）：飞书文件消息（PDF/Word/Excel/
  文本等）经消息资源 API 下载（`type=file`），魔数识别类型
  （pdf/zip/gz/图片/文本/bin）保存到 `$DSH_HOME/dsh-tui-feishu/files/`，
  路径投递给 agent 读取解析。与图片接收共享同一下载管线。
- 新增测试套件 `test/files.mjs`（5 项）。`npm run verify` 全绿。

## 0.3.1 (2026-08-22)

### 新增
- **工具面板超限防护**：工具调用超过 30 步时面板只渲染**最近 30 步**，
  更早步骤折叠进一个紧凑的「历史工具调用」元素（标题含折叠数量，元素数
  有界，不会触碰飞书卡片元素上限）；长回合不再丢内容。
- 真机验证（图片接收 → 视觉模型描述图片）通过。

### 文档
- README：图片章节（入站/出站）、安装指向 GitHub Releases、修正已过期的
  "未做（路线图）"（会话列表卡片化已于 0.2.0 完成）。

## 0.3.0 (2026-08-22)

### 新增
- **入站图片接收**（`receiveImages`，默认开）：飞书私聊发图片 → 下载原图 →
  优先经宿主附件服务转为 `ImageBlock` 随用户消息投递给 agent（视觉模型可直接看图）；
  附件服务不可用或拒绝时自动降级为保存文件并附路径。配对应用权限新增
  `im:resource`（图片下载所需；旧应用需重新配对）。
- **回合收尾修复**：修复 CardKit 引擎在回合结束时若恰逢流式 flush 在途，
  终态快照被非终态分支应用、流式模式永不关闭、卡片永远停在"working"的竞态
  （`terminalRequested` 标志，在途 flush 以终态语义收尾）；平台侧流式超时
  （200850）/已关闭（300309）后停止逐元素流式并容忍 closeStreaming 失败；
  `finalize` 失败时自动以纯文本兜底发送回复，不再静默丢失。
- 新配置：`receiveImages`。

### 工程
- 新增测试套件 `test/images.mjs`（9 项）：消息归一化、魔数嗅探、附件/文件
  降级/关闭/失败四路径；`npm run verify` 全绿。

## 0.2.0 (2026-08-22)

### 新增
- **CardKit 2.0 流式引擎**（`cardEngine: 'cardkit'`，默认仍为 `v1`）：卡片 JSON 2.0
  打字机流式（`streaming_mode`）、可折叠工具/思考面板、Stop/详情按钮经
  `behaviors[].type=callback` 触发同一 `card.action.trigger` 回调；已通过真实飞书平台
  冒烟（创建卡片实体成功）。默认 `v1` 引擎行为不变。
- **工具详情脱敏**：工具参数/结果上卡前经过脱敏（`key=secret`、`Authorization` 头、
  `--flag secret`、路径只留 basename），凭证不会出现在流式卡片或审批卡片上。
- **瞬态错误重试**：create/patch 对网关超时等瞬态错误按 150/500/1000ms 退避重试。
- **消息删除/撤回守卫**：patch 命中删除/撤回错误码后立即退休该卡片并转纯文本兜底；
  卡片无更新超过 `cardTtlMs`（默认 15 分钟）自动退休。
- **卡片内容升级**：工具行人类化标题 + 耗时 + 展开态结果代码块（JSON 美化）；
  完成卡 footer（状态/耗时/模型）；正文分块渲染；`locale` 中英文案；远程图片
  回合结束自动上传为飞书 img_key（`resolveImages`）；`showReasoning` 开关。
- **/sessions 会话列表卡片化**：每会话一个「切换到 N」按钮（≤8 个，当前高亮）。
- 新配置：`cardTtlMs`、`locale`、`resolveImages`、`cardEngine`、`showReasoning`。

### 修复
- 终态卡片必渲染：即使流式期间无待发快照，完成态也会基于最后一次已发快照收尾。
- CardKit 引擎失败即退休卡片，由纯文本兜底接管，避免对坏卡反复重试。

### 工程
- 新增测试套件：`test/redact.mjs`（15）、`test/robustness.mjs`（4）、
  `test/cards-p1.mjs`（14）、`test/cardkit.mjs`（5），`npm run verify` 全绿。
- `scripts/cardkit-smoke.mjs`：真机冒烟（创建卡片实体，不发送、无打扰）。
