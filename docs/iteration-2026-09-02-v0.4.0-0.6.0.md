# 迭代记录：dsh-im 对齐补全（SPEC → v0.4.0 → v0.6.0）

> 日期：2026-09-02
> 范围：对比 github.com/xmanrui/dsh-im 飞书渠道 → 写 SPEC → 三阶段实施 → 发版上线
> 产出：v0.4.0 / v0.5.0 / v0.6.0（均装入 dsh-tui profile 并重启验证）
> 仓库：Easyhoov/dsh-tui-feishu（upstream: FUSU123fusu/dsh-tui-feishu）

## 1. 起因

用户要求把本机 `dsh-tui-feishu`（v0.3.2）与 `github.com/xmanrui/dsh-im`（v4.7.0）的飞书渠道实现做对比，
找出值得参考与可补全的功能点。

**对比结论**：两者不是同一项目的两个版本，而是不同宿主形态的插件——本地插件面向 dsh-tui（终端 TUI，
`compat.hosts: [dsh-tui]`），dsh-im 面向 dsh web/Desktop（React 设置 UI + 9 渠道 + AI Office）。
dsh-im 在三个方向领先本地：引用回复上下文、非视觉模型图片回退、出站文件回传，另有工程做法
（入站清洗器、有界查找、取消语义）值得移植。

## 2. SPEC（docs/plans/2026-09-02-dsh-im-parity-spec.md）

6 个 Feature，3 个 Phase，每个含 gate 与验收标准：

| Phase | Feature | 内容 |
|---|---|---|
| 1 (v0.4.0) | A 引用回复上下文 | `parent_id`/`root_id` → 有界单次拉取 → `<dsh_im_reply_to>` 注入 |
| | B 非视觉模型图片降级 | modalities 预检查 → 落盘 + 工具识图指引 |
| 2 (v0.5.0) | C 出站文件回传 | `dsh_im_return_file` 工具（tools.register 软探测） |
| | D /repair 权限自检 | 探针检测 im:chat / im:resource |
| 3 (v0.6.0) | E 连接 watchdog | 60s 对账 + 静默/异常自动重连 |
| | F /history /compact | 滚动转录回放 + 会话压缩（软探测 compaction 服务） |

## 3. 前置验证与设计变更（关键决策）

三项 gate 全部**先验证再动手**，其中两项推翻了原设计：

1. **`MODEL_DOES_NOT_SUPPORT_IMAGES` 不存在于 TUI 路径**（grep dsh-host-apiproxy / dsh-llm 源码）：
   该码只由 web host 的 api-proxy 抛出；TUI 路径下 dsh-llm 对非视觉模型是**静默把图片投影为文本占位符**
   （`projectImagesForTextModel`），无任何可捕获失败信号 → Feature B 从"错误驱动重试"改为
   **投递前预检查**（`llm.resolveModelInfo` 查 `inputModalities`，10min 缓存，fail-open）——更简单、无竞态。
2. **tools facet 可用**：TUI 宿主 `ctx.get('tools')` + `tools.register(definition)` 存在
   （`output:{schema,render}` 必需，`run_code` 保留名）→ Feature C 走真实工具注册通道，仍保留运行时软探测。
3. **飞书增量授权仅适用 user OAuth**（网页授权 scope 链路），机器人自建应用 tenant 权限只能后台申请
   审批发布，SDK 无 patch 接口 → Feature D 降级为"探针自检 + 补全指引"，不再幻想免审批增量授权。

## 4. 实施记录

### v0.4.0 — Feature A + B（commit 2bf6713 / ca6f264）

- `src/inbound-sanitize.ts`：入站清洗器（OSC/CSI/ESC 终端序列、C0/C1、bidi/零宽、PUA 剥离；
  码点截断；`escapeForTag` 防 `<dsh_im_reply_to>` 标签逃逸）
- `src/reply-reference.ts`：`replyTargetId`（parent 优先）、`buildReplyReference`（text/post
  富文本展平/image/file/audio/media/sticker/interactive 全类型 + unavailableReason 五态）、
  `replyTag` 序列化（附注引用是数据不是指令）
- transport：`FeishuMessage` + `parentId`/`rootId`；`getMessage()`（`im.v1.message.get`，
  withTimeout 5s）；`withTimeout` 辅助
- bridge：`resolveReplyTag()` 在访问控制通过后、命令分发之外注入；**引用永不进命令分发**
- 图片降级：`modelLacksImageInput()` 三态判定（true 降级/false 或 undefined 放行），
  配置 `imageFileFallback`（默认 on）
- 测试：`test/reply.mjs` 15 项、`test/image-fallback.mjs` 6 项

### v0.5.0 — Feature C + D（commit dd5b479）

- `src/outbound-file.ts`：`installOutboundFileTool()` 软探测注册 `dsh_im_return_file(path, caption?)`；
  文件读取错误转软错误（ENOENT/EACCES 中文提示）
- transport：`uploadAndSendFile()`（`im.v1.files` multipart、30MB 上限、fileTypeFor 枚举映射）、
  `getChat()`、`probeImageResourceAccess()`（错误码分类：99991672/234001/91403/401/403 → 缺权限）
- bridge：`ensureAgent()` 时每 agent 注册工具 + `/status` 标注 outboundFiles；`/repair` 命令
- 测试：`test/outbound-files.mjs` 6 项

### v0.6.0 — Feature E + F（commit b26931f）

- transport：`healthTimestamps()`（lastReadyAt/lastInboundAt）、`restart()`（stop→250ms→start）
- bridge：watchdog interval 60s——error/reconnecting 或 ready 超 10min 或静默超 10min → 全量重启；
  dispose 清理；滚动转录（50 条/chat，user+agent，去重）→ `/history [n]`；
  `/compact` 软探测 agent scope 链的 `compaction` 服务（与 TUI 同机制）
- 测试：verify 全绿（现有套件 + 新 27 项）

## 5. 发版流程（每版一致）

```bash
npm run verify          # build + validate:manifest + 全部测试
npm pack                # dsh-tui-feishu-<ver>.tgz
dsh plugin --profile dsh-tui add file:...tgz
dsh plugin --profile dsh-tui ls   # 确认版本
# 重启：杀 dsh-tui 进程 → tmux kill-server → tmux new-session -d -s dsh-tui /root/start-dsh-tui.sh
tail bridge.log         # 确认 "bridge ready" + "feishu long connection ready"
```

**运维坑记录**：
- `pkill -f "dsh"` 会误杀自己所在的 shell（匹配到 hermes-snap 包装命令）→ 用精确
  `pgrep -f "dsh --profile dsh-tui"` 逐 pid kill，且与启动拆成两条命令
- 桥有单实例锁：旧进程不死透会 `bridge lock held by pid N; skipping bridge start`，
  必须确认无残留再启动
- lib/ 已入库（历史惯例，npm pack 的 files 白名单依赖），保持不动

## 6. GitHub Action

新增 `.github/workflows/ci.yml`：push / PR / workflow_dispatch 触发，
`npm ci && npm run verify`（node 22，对应 engines `^22.19 || >=24`）。
仓库此前无任何 CI；package-lock.json 已入库，`npm ci` 可复现。

## 7. 待办（真机验收，需用户操作）

1. 引用消息提问 → agent 应看到被引用内容
2. 发图（当前模型非视觉时）→ "转文件 + 识图指引"文案
3. `/repair` / `/history` / `/compact` / `/status` 各跑一次
4. agent 生成文件调 `dsh_im_return_file` → 飞书收到文件
5. CI 首个 run 结果确认（推送到 GitHub 后）
