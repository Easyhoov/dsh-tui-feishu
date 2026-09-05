# dsh-tui-feishu 故障诊断：ask_user_question 卡死（2026-09-05）

## 现象

- 飞书端：用户消息（「好了告诉我」）后，agent 回复「收到。开工前我先确认一下范围…」，随后**卡住**——没有出现任何可点击的问卷/审批卡片，用户后续消息（「把还没做完的修复」「你好」）也永远得不到处理。
- 用户猜测「要权限、审批卡片没出现」，实际不是权限审批。

## 根因（已源码验证）

1. `ask_user_question` 是 dsh 的 **user-interaction seam**：模型调用后，`UserQuestionService.ask()`（`@deepseek-ai/dsh-user-questions`，位于 `/root/.dsh/profiles/node_modules/@deepseek-ai/dsh-user-questions/lib/index.js`）**挂起在唯一 UI provider 上等人类回答**。
2. 当前唯一 provider 是 **dsh-tui 自带的 QuestionStore**（`@deepseek-harness-tui/dsh-tui/lib/types/dsh-adapter/questions.js`，Claude Code 式问卷面板）。面板显示在 tmux 里的 TUI 界面，**飞书用户看不见也摸不着**。
3. **dsh-tui-feishu@0.9.0 没有实现任何 userQuestions / ask_user_question 处理**：`grep -rln 'userQuestions\|UserQuestionService\|ask_user_question' node_modules/dsh-tui-feishu/lib/` 零命中。插件只有 approval/request 瀑布（危险工具权限 → Allow/Reject 卡片，bridge.ts `handleApprovalRequest`），那是另一套机制（@deepseek-ai/dsh-user-approval），与本次无关。
4. 宿主 channel.js（`dsh-adapter/channel.js` 约 6421 行，`case 'tool/call'`）对 `ask_user_question` **特意 break**——跳过工具卡片渲染（注释：model is parked waiting for the human, so no running card, no active-tool spinner）。所以飞书上连「工具调用中」的痕迹都没有。
5. bridge.ts 约 1188 行：回合还在跑时新消息走 `agent.followup()` 只进 inbox 队列（「当前回合还在跑——已排队」）。当前回合永不结束 → 排队消息永远不处理。**死锁闭环**。

## 证据

- 会话 `938d13e4-2b3f-4bf2-bfdc-8fa0256b5c87`（飞书 chat `oc_ba983a0b227404f0deef706066f4ebd2`）session 日志 `/root/.dsh/sessions/--root--/938d13e4-2b3f-4bf2-bfdc-8fa0256b5c87/session.jsonl.zstd` 尾部：
  - `tool/call`（`ask_user_question`，参数含 4 选项：「P2 全部 + P3 一起修（推荐）」「只修 P2 三项」「先补拆卡方案文档」「不是这个意思」）seq=13406 @ 2026-09-04T19:57:04Z
  - 之后**无 tool/result**；只有两条 `agent/inbox/spliced`（用户消息排队，seq 13407/13408）
- tmux 面板（`tmux capture-pane -t dsh-tui`）可见问卷 UI：`❯● P2 全部 + P3 一起修（推荐）…` `✎ Custom answer：Type directly…` `↑/↓ select · Type text to attach an answer · Enter submit · Esc cancel`
- bridge.log：`session/event tool/call` 后无 WARN/ERROR/approval 相关行。

## 修复方向（供实现参考）

1. **首选**：桥插件实现 user-questions provider：
   - `ctx.get('userQuestions')` 软探测（宿主 plugin.js 已保证该服务存在：`ctx.get('userQuestions') ?? new UserQuestionService(ctx)`；注意 host 已 `ctx.plugin(toolAskUser)` 暴露模型端工具）。
   - 当前 dsh-user-questions 版本是 **legacy `registerProvider` 单席位**（`hasLegacyProvider` 判定），而 **dsh-tui 已注册**（`prepareQuestionAnswerer`，见 `questions-answerer.js`）→ 桥再注册会抛 `DUPLICATE_PROVIDER`。dsh-tui 的 `prepareQuestionAnswerer` 在 DUPLICATE 时会走 `decideQuestionProviderYield`（`providerGuard.js`）决策——**需要分析 providerGuard 的让位逻辑**，或确认 dsh-user-questions 是否支持 alpha.2 的 `user-questions/request` waterfall 事件（`questions-answerer.js` 中有 waterfall 分支：`events.on('user-questions/request', (request, next) => ...)`，按 `request.agent.id` 过滤，只认自己 agent——这个更适合桥，只管自己 agent 的 ask）。
   - provider 实现：把问题渲染成飞书可交互卡片（问题 + 选项按钮 + 自定义输入），用户点选/输入后 settle `ask()` promise；**文本消息兜底**：监听该 chat 的下一条用户消息作为回答（用户习惯打字而非点卡片）。
2. **兜底方案**：桥把 ask_user_question 降级为普通文本消息发送（问题原文 + 选项），用户在飞书回复文本 → 桥把文本作为回答注入（需绕过 provider 或直接 settle）。
   - 但注意：直接文本消息进 inbox **不会** settle ask()（inbox 是下一回合的消息流，ask 挂在 promise 上），必须走 provider/waterfall 才能让当前回合继续。

## 约束提醒

- 插件 repo：`/root/dsh-tui-feishu`（当前 main = 0.9.0，commit c8c83d6），profile 内运行包同版本（file: tgz 安装）。
- 宿主版本：dsh-tui 0.10.0-beta.4（peer 兼容官方配对 dsh 0.1.1-rc.2）。
- 代码风格：`exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`（见 repo 内测试与既有代码）。
- 修改后流程：`npm run verify`（validate:manifest 依赖 `/dsh-ecosystem-spec` 符号链接）→ `npm pack` → `dsh plugin --profile dsh-tui add file:...tgz`（重启生效前 profile 内会保持旧版）。
