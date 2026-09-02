# dsh-tui-feishu 代码审查报告

> 审查对象：`Easyhoov/dsh-tui-feishu` @ `4faf685`（v0.6.0）
> 审查依据：`docs/plans/2026-09-02-dsh-im-parity-spec.md`、`docs/iteration-2026-09-02-v0.4.0-0.6.0.md`
> 审查日期：2026-09-02
> 环境验证：`tsc --noEmit` 通过；`npm test` 27 项通过；`npm run validate:manifest` 本地失败（缺同级依赖仓库）

---

## 1. 项目概况与设计意图

**形态**：dsh-TUI 宿主的 cordis 插件（`compat.hosts: [dsh-tui]`），把飞书私聊变成本机 agent 的远程操控面。一条出站 WebSocket 长连接双向承载，不需要公网 IP。飞书 p2p 会话 ↔ 持久 dsh session 一一映射，每回合渲染一张就地 patch 的流式卡片，审批请求转为 Allow/Reject 卡片。

**代码规模**：`src/` 16 文件 5907 行 TypeScript，测试 10 个 `.mjs` 套件。核心分层清晰：

| 层 | 文件 | 职责 |
|---|---|---|
| 宿主适配 | `index.ts` (752) | cordis `apply()`、配置 schema、服务软探测、凭据/配对 |
| 编排 | `bridge.ts` (1606) | 入站分发、命令、会话事件 → 卡片、watchdog |
| 平台 | `transport.ts` (960) | lark SDK 封装、长连接、上传下载、重试/超时 |
| 渲染 | `cards.ts` / `streaming/*` / `cardmd.ts` | v1 patch 与 CardKit 2.0 两套卡片引擎 |
| 纯函数 | `inbound-sanitize.ts` / `reply-reference.ts` / `redact.ts` / `tools.ts` / `unavailable.ts` | 清洗、引用组装、脱敏、工具元数据 |

**本次迭代（SPEC）的设计意图**：对齐 `dsh-im` v4.7.0 飞书渠道的三项领先能力（引用回复上下文、非视觉模型图片回退、出站文件回传），并移植其安全工程做法。SPEC 定了三条总原则：

1. 全部功能**软探测、优雅降级**——宿主能力缺失时功能关闭，桥不崩；
2. 入站内容注入 prompt 前必须过统一清洗器；
3. **单一重试**，且必须保留取消信号语义。

值得肯定的是 SPEC §11 记录了三项前置 gate 的验证结果，其中两项推翻了原设计（`MODEL_DOES_NOT_SUPPORT_IMAGES` 在 TUI 路径不存在 → Feature B 从错误驱动改为投递前预检查；飞书增量授权仅适用 user OAuth → Feature D 降级为探针自检）。**先验证再动手、结论反向就改设计**，这是本次迭代最扎实的部分。

---

## 2. 最新迭代完成度评估

迭代文档声明 6 个 Feature / 3 个 Phase。逐项核查实现是否覆盖：

| Feature | 声明 | 实现 | 完成度 |
|---|---|---|---|
| A 引用回复 | `parent_id`/`root_id` → 有界单次拉取 → `<dsh_im_reply_to>` 注入 | `reply-reference.ts` + `inbound-sanitize.ts` + `transport.getMessage()` + `bridge.resolveReplyTag()` | **90%**：主链路完整，安全约束到位；错误码映射漏飞书数字码（M1），`post` 展平无测试（M9） |
| B 图片降级 | modalities 预检查 → 落盘 + 工具识图指引 | `modelLacksImageInput()` + `resolveModelSupportsImages()`（10min 缓存、fail-open） | **50%**：判定逻辑与缓存正确，但**降级投递不给 agent 文件路径**（B1），指令无法执行 |
| C 出站文件 | `dsh_im_return_file`（tools.register 软探测） | `outbound-file.ts` + `transport.uploadAndSendFile()` | **60%**：注册与软探测正确；resume 路径漏注册（S5）、上传失败抛错而非软错误（S3）、无前置体积校验（S4）、MIME 表死代码（M2）、不回 message_id |
| D `/repair` | 探针检测 im:chat / im:resource | `handleRepairCommand()` + `probeImageResourceAccess()` | **60%**：框架与文案完整；违反「不重试/5s 上限」（S6）、不确定态误报 ✅（S6）、漏 send_as_bot（M6） |
| E watchdog | 60s 对账 + 静默/异常自动重连 | `watchdogTick()` + `transport.restart()` + `healthTimestamps()` | **35%**：会周期重启健康连接（B2）、无持续时长判定与并发保护（S1）、无退避阶梯、`/status` 缺 SPEC 要求字段（M5）、**零测试**（M8） |
| F `/history` `/compact` | 滚动转录回放 + 软探测压缩 | `appendHistory()` + `handleHistoryCommand()` + `handleCompactCommand()` | **55%**：软探测与提示文案正确；**未脱敏**（S2）、截断截掉最新内容（M4）、默认值与分条发送均偏离 SPEC、**零测试**（M8） |

**整体判断**：Phase 1（v0.4.0）质量最高，接近可交付；Phase 2（v0.5.0）主干可用但边界处理欠缺；**Phase 3（v0.6.0）完成度最低且未经任何测试**——`git show --stat b26931f` 显示该提交只改了 `src/bridge.ts`、`src/transport.ts`、文档和 `lib/`，**没有新增一个 test 文件**，直接违反 SPEC §10「每个 Feature 独立 TDD：先写失败测试 → 最小实现」。迭代文档 §4 写「测试：verify 全绿（现有套件 + 新 27 项）」，而 27 = reply 15 + image-fallback 6 + outbound-files 6，正是 v0.4.0/v0.5.0 的既有数量，v0.6.0 净新增为 0。这处表述容易让人误以为 Phase 3 有测试覆盖。

---

## 3. 问题清单

### 🔴 阻塞

#### B1. Feature B 降级投递不含文件路径，agent 无法完成被指派的动作

**位置**：`src/bridge.ts:521-531`

```ts
if (result.kind === 'attachment' && (await this.modelLacksImageInput(chatId)) === true) {
  await this.deliver(chatId, '📷 图片（转文件）', [
    { type: 'text', text: '📷 用户发来一张图片，当前模型不支持直接看图。图片已通过入站文件管线保存到会话工作区。请用 read_image / run_code 等工具读取该文件分析图片内容；...' },
  ])
```

**问题**：进入该分支的前提是 `result.kind === 'attachment'`，即图片已交给宿主 attachment 服务，`result.ref` 是 `ImageAttachmentRefLike`（`src/bridge.ts:43-50`：`{attachmentId, mediaType, bytes, width, height, name?}`）——**没有任何文件系统路径**。文案却告诉 agent「已保存到会话工作区」「读取该文件」，既未给路径也未给 attachmentId。agent 无从定位，只能空转或编造。

SPEC §5.1 的原文要求是「图片字节直接走**现有文件落盘管线**……投递『📷 用户发来一张图片，已保存到 `<path>`……』」。实现跳过了落盘管线，直接复用了 attachment 结果。

**修改建议**：在预检查通过后**再决定落盘方式**，而不是在 attachment 已生成后打补丁。把预检查提到 `resolve()` 之前，并给 `resolveInboundImage` 增加 `preferFile` 入参：

```ts
// bridge.deliverImage
const lacksImage = (await this.modelLacksImageInput(chatId)) === true
const result = await resolve(messageId, imageKey, { preferFile: lacksImage })
// index.ts resolveInboundImage：preferFile 时跳过 attachments.saveImages，直接写 join(dataDir,'images')
```

这样 `result.kind === 'file'` 分支（`src/bridge.ts:538`）已有的「已保存到 `${result.path}`」文案天然满足 SPEC。同时也省掉一次无用的 attachment 写入。

---

#### B2. watchdog 会周期性重启**健康**的长连接

**位置**：`src/bridge.ts:340-357`

```ts
const notReadyFor = lastReadyAt === undefined ? Infinity : now - lastReadyAt
const silentFor   = lastInboundAt === undefined ? Infinity : now - lastInboundAt
const unhealthy = state === 'error' || state === 'reconnecting' || notReadyFor > 10 * 60_000
if (!unhealthy) return
const silentTooLong = silentFor > 10 * 60_000
if (state !== 'error' && state !== 'reconnecting' && !silentTooLong) return
await this.options.transport.restart()
```

**问题**：`lastReadyAtValue` 只在 `onReady` / `onReconnected` 回调里赋值（`src/transport.ts:461,474`），健康运行期间**没有任何机制刷新它**。因此连接建立满 10 分钟后，`notReadyFor > 10min` 恒为 true，`unhealthy` 恒为 true。此时唯一的闸门是 `silentTooLong`——而对个人 bot（一天几条消息）而言,「10 分钟无入站消息」是常态。

**推演**：连接于 T0 就绪 → T0+10min 起 `unhealthy=true` 且 `silentTooLong=true` → 强制 `restart()` → `onReady` 刷新 `lastReadyAt` → 再过 10 分钟又重启。结果是**空闲状态下长连接每 10 分钟被拆建一次，永久循环**。日志每 10 分钟一条 warn，叠加 M3 的 SDK error 日志；重连窗口内的消息依赖飞书重投兜底。

这与 Feature E 的动机（防「进程活着、桥已死」）正好相反：它把一个稳定连接变成了周期性抖动。SPEC §8.1 从未提出「静默」作为重启条件；`lastInboundAt` 与静默判定是实现自行引入的。

**修改建议**：静默不等于不健康，必须换用真实存活信号。

1. 删除 `silentTooLong` 作为**重启**条件（可保留为日志维度）；
2. 用 SDK 已有的 `ws.getConnectionStatus()` 或在 `pingLoop` 侧记录 `lastPongAt` 作为存活证据，`transport` 暴露之，替代 `lastReadyAt > 10min` 这个不可满足的条件；
3. 若坚持要一个空闲兜底，应改为**主动探测**（如 `getChat` 自检成功即视为健康），探测失败才重启。

---

### 🟠 严重

#### S1. watchdog 缺「持续 5 分钟」判定与并发保护，会打断 SDK 自身的重连

**位置**：`src/bridge.ts:331-336, 346-355`

三个独立缺陷：

1. **无持续时长**：SPEC §8.1 要求「`error/reconnecting` 持续超过 **5min**」才重建。实现在**第一个**采样到 `error`/`reconnecting` 的 tick 就重启。网络抖动时 SDK 的 `autoReconnect` 正在按自己的退避阶梯恢复，watchdog 在 ≤60s 内插进来调 `close()`——而 SDK 的 `close()` 会 `this.reconnectGeneration++`（`node_modules/@larksuiteoapi/node-sdk/lib/index.js:102599`）**作废进行中的重连循环**。watchdog 在和 SDK 的恢复机制互相拆台。
2. **无 in-flight guard**：`setInterval` 每 60s 无条件触发 `void this.watchdogTick().catch(...)`。`restart()` 内部 `await this.start()` → `ws.start()` 含 `fetchBotIdentity` 重试与 15s 握手，坏网络下可能超过 60s，于是**多个 `restart()` 在同一个 WSClient 上并发**。
3. **无退避阶梯**：SPEC §8.1 要求 `250ms→1s→3s→5s→10s→30s`（封顶 30s 循环）。实现只有固定 250ms（`src/transport.ts:542`）；失败后靠 60s 的 tick 间隔重试，等于固定 60s 轮询。另外若 `ws.start()` 提前 `return`（如 appId 格式不符，SDK 直接 `logger.error` 后返回），`connectionStateValue` 会永久停在 `'reconnecting'`（`src/transport.ts:540`），触发**每 60s 重启一次的死循环**。

**修改建议**：

```ts
private unhealthySince: number | undefined
private restartInFlight = false
private restartCount = 0
private readonly RESTART_LADDER = [250, 1_000, 3_000, 5_000, 10_000, 30_000]

private async watchdogTick(): Promise<void> {
  if (this.restartInFlight) return                       // 修 (2)
  const state = this.options.transport.connectionState()
  const bad = state === 'error' || state === 'reconnecting'
  if (!bad) { this.unhealthySince = undefined; return }  // 修 (1)
  this.unhealthySince ??= Date.now()
  if (Date.now() - this.unhealthySince < 5 * 60_000) return
  this.restartInFlight = true
  try {
    const delay = this.RESTART_LADDER[Math.min(this.restartCount, this.RESTART_LADDER.length - 1)]
    await this.options.transport.restart(delay)          // 修 (3)
    this.restartCount += 1
  } finally { this.restartInFlight = false }
}
```

并在 `restart()` 成功后把 `connectionStateValue` 交还给 SDK 回调管理，避免卡在 `'reconnecting'`。

---

#### S2. `/history` 输出未脱敏，可把 agent 答复里的密钥回显到飞书

**位置**：`src/bridge.ts:998-1011`

```ts
const lines = rows.slice(-count).map(row => `${row.role === 'user' ? '🧑' : '🤖'} ${row.text}`)
await this.options.transport.sendText(chatId, [`📜 最近 ${count} 条：`, ...lines].join('\n').slice(0, 4000))
```

**问题**：SPEC §9 明文要求「拉最近 n 条……**经 `redactInlineSecrets` 后**以纯文本分条发送」。实现完全没有调用该函数。仓库里 `redactInlineSecrets` 已在卡片链路的工具入参/结果/错误三处使用（`src/bridge.ts:1281, 1315, 1321`），说明脱敏能力现成可用，只是 `/history` 漏掉了。

转录来源是 `assistant/message` 的完整文本（`src/bridge.ts:1351`）。agent 读过 `.env`、跑过 `printenv`、贴过 token 的答复都会原样进入转录，`/history` 一条命令即全量回放。

**修改建议**：

```ts
const lines = rows.slice(-count).map(row =>
  `${row.role === 'user' ? '🧑' : '🤖'} ${redactInlineSecrets(row.text)}`)
```

更稳妥的做法是在 `appendHistory()` 入口就脱敏——存进内存的就是干净数据，避免后续新增消费点再次遗漏。

---

#### S3. Feature C 上传失败会抛出异常，而非 SPEC 要求的软错误文本

**位置**：`src/outbound-file.ts:117-128`

```ts
const chatId = options.chatForCurrentSession()
if (chatId === undefined) return { ok: false, error: '当前会话没有绑定的飞书聊天…' }
await options.sendFile(chatId, new Uint8Array(data), fileName)   // ← 未包 try/catch
```

**问题**：`readFile` 的失败被细致地转成了软错误（ENOENT/EACCES 中文提示），但 `sendFile` 没有。`transport.uploadAndSendFile()` 在空文件、超 30MB、`file_key` 缺失、上传超时、发送超时时全部 `throw`（`src/transport.ts:749-770`），异常直接穿透 `execute`。

SPEC §6.3 明确要求「上传失败工具返回明确 error 文本（**agent 可转述**），不重试」。抛出后 agent 拿到的是框架级工具错误，转述质量不可控，且这些恰恰是最常见的失败（体积超限、网络超时）。

**修改建议**：

```ts
try {
  const messageId = await options.sendFile(chatId, new Uint8Array(data), fileName)
  return { ok: true, file: fileName, bytes: data.byteLength, messageId, message: `文件已发到飞书聊天${...}` }
} catch (error: unknown) {
  return { ok: false, error: `发送 ${fileName} 失败：${String(error)}` }
}
```

顺带修掉一处 SPEC 偏离：§6.3 要求「工具结果返回飞书 message_id 供 agent 确认」。当前 `uploadAndSendFile` 返回的是 `file_key`（`src/transport.ts:771`，`createMessage` 的返回值被丢弃），而 `index.ts:595` 的 `sendFileToChat` 签名是 `Promise<void>`，连 `file_key` 都没往上传。需要把 `createMessage` 的 `message_id` 一路带回。

---

#### S4. Feature C 无前置体积/类型校验，任意大文件被整体读入内存

**位置**：`src/outbound-file.ts:106-116`

```ts
data = await readFile(rawPath)      // 无 stat，无体积上限
```

**问题**：30MB 上限的检查在 `transport.uploadAndSendFile()`（`src/transport.ts:750`），即**读完之后**。路径由 agent 自由决定，一个 2GB 日志文件会先被完整读进 Buffer 才被拒绝——足以打爆 TUI 宿主进程。Feature C 的失败模式因此从「工具报错」升级为「桥连同宿主一起挂」。

SPEC §6.3 的校验清单是「路径存在且为**普通文件**；非空；**≤30MB**」，三项都要求在上传前完成。当前实现里「普通文件」判定完全缺失（传目录会走到 `readFile` 抛 EISDIR，落到 `String(error)` 兜底，给用户一条英文原始错误）。

**修改建议**：在 `readFile` 之前加一次 `stat`：

```ts
import { stat, readFile } from 'node:fs/promises'
const MAX_OUTBOUND_BYTES = 30 * 1024 * 1024
let info
try { info = await stat(rawPath) } catch { return { ok: false, error: `文件不存在或无法访问：${fileName}` } }
if (!info.isFile()) return { ok: false, error: `${fileName} 不是普通文件（目录/设备无法发送）` }
if (info.size === 0) return { ok: false, error: `${fileName} 是空文件` }
if (info.size > MAX_OUTBOUND_BYTES) return { ok: false, error: `${fileName} 超过 30MB 上限（${info.size} 字节）` }
```

---

#### S5. resume / 复用活 agent 路径不注册出站文件工具，Feature C 跨重启静默失效

**位置**：`src/bridge.ts:1139-1148`（早退）vs `src/bridge.ts:1168-1188`（注册）

```ts
private async ensureAgent(chatId: string): Promise<Agent | undefined> {
  const binding = map.get(chatId)
  if (binding !== undefined) {
    const live = store.get(binding.sessionId)
    if (live !== undefined) return live                  // ← 直接返回，无注册
    try { return await store.resume(binding.sessionId, {...}) }  // ← 直接返回，无注册
    catch { ... map.delete(chatId) }
  }
  // …只有 create 分支才 installOutboundFileTool
```

**问题**：`installOutboundFileTool` 只在 `create` 分支调用。而 `dsh-tui-feishu` 的核心价值就是**持久会话**：TUI 重启后首条消息走 `resume` 路径，`dsh_im_return_file` 从此不存在，`/status` 显示 `not-probed`——用户看到的是「功能没坏，只是没探测过」，排查方向被误导。代码注释写「soft-probe the tools registry **once per agent**」，实际是 once per *created* agent。

**修改建议**：把注册抽成 `private registerOutboundTool(agent: Agent): void`，在 `ensureAgent` 的三条返回路径上都调用一次，并用 `Set<string>` 按 `agent.id` 去重防止重复注册：

```ts
private readonly toolInstalled = new Set<string>()
private registerOutboundTool(agent: Agent): void {
  const id = String(agent.id)
  if (this.toolInstalled.has(id)) return
  this.toolInstalled.add(id)
  /* …现有 installOutboundFileTool 逻辑… */
}
```

顺带：`installOutboundFileTool` 返回的 `dispose` 当前被完全丢弃（`src/bridge.ts:1170`），应存起来在 `Bridge.dispose()` 里释放。

---

#### S6. `/repair` 的 im:resource 探针违反有界约束，且不确定态被误报为 ✅

**位置**：`src/bridge.ts:957-962`、`src/transport.ts:640-662`、`src/transport.ts:367-378`

两个独立问题：

**(a) 探针带重试且远超时间预算。** SPEC §7.1 写「**不做自动重试循环**；探针超时 **5s/项**，总计 **<15s**」。而 `probeImageResourceAccess()` 调的 `downloadMessageResource()` 内部是 `withTransientRetry(...)` 包裹的 `client.request({ timeout: 20_000 })`——单请求 20s，最多 4 次尝试，加上 150/500/1000ms 退避，最坏 **≈82s**。网络不可用时 `/repair` 会静静挂一分多钟，而它恰恰是「收不到图片/文件时先跑这个」的诊断入口。

**(b) 不确定态误报为通过。**

```ts
const resourceOk = await this.probe('im:resource…', async () => this.options.transport.probeImageResourceAccess())
rows.push(resourceOk === false ? '❌ im:resource…' : '✅ im:resource（图片/文件下载）')
```

`probeImageResourceAccess()` 的契约是三态：`true` 有权限 / `false` 缺权限 / `undefined` **判定不了**（`src/transport.ts:660` 注释写明）；`this.probe()` 又会把任何异常吞成 `undefined`（`src/bridge.ts:978-985`）。而判定只区分 `=== false`，于是**「网络挂了，查不出来」被输出为「✅ 正常」**。叠加 (a)，坏网络下的典型体验是：等 80 秒 → 得到一份全绿报告 → 用户据此排除权限问题，方向彻底错了。

**修改建议**：

```ts
rows.push(
  resourceOk === false ? '❌ im:resource（图片/文件下载）—— 缺权限：图片接收/出站图片不可用'
  : resourceOk === true ? '✅ im:resource（图片/文件下载）'
  : '⚠️ im:resource（图片/文件下载）—— 无法判定（网络异常或探测超时），请重试',
)
```

并给 `probeImageResourceAccess()` 增加 `bypassRetry` 通道，直接用 `withTimeout(client.request({...timeout: 5_000}), 5_000)`，跳过 `withTransientRetry`，以满足 SPEC 的「不重试 / 5s」。`missing` 的计算也要相应处理 `⚠️`（当前 `rows.some(r => r.startsWith('❌'))` 会漏掉不确定态）。

---

### 🟡 一般

#### M1. `unavailableReasonFromError` 不识别飞书数字错误码，缺 scope 被误报为 not-delivered

**位置**：`src/reply-reference.ts:65-78`

只识别字符串 `code`（自定义枚举）与数字 `status`/`statusCode`（HTTP 层）。**已实证**（见 `code-review-audit-2026-09-02.md` 对 M1 的修正）：axios 1.19 的 `AxiosError` 带顶层 `.status`，HTTP 401/403/404/410 的拒绝能被正确映射；真正的缺口在两条路径：① 数字业务码——`{code: 99991672}` 实测落入 `'not-delivered'`（SPEC §4.2 期望 `permission-denied`）；② 飞书以 HTTP 200 + body `code != 0` 返回的业务错误（本仓库 `assertOk()` 的存在证明这种形状真实存在）——`getMessage()` 只读 `response.items`，items 缺失时不看 body code 直接抛自造的 `not-found`（`src/transport.ts:599-603`），真实原因（如无权限）被吞掉。

SPEC §4.2 明确列了「SDK 缺 scope 错误码→`permission-denied`，404→`not-found`，410→`deleted`」。数字业务码这条没实现，`test/reply.mjs:75-81` 也只覆盖了 `status` 数字与 `code` 字符串两种形状，正好绕过了真实的 `FeishuApiError`。后果：引用一条无权访问的消息，agent 收到的 `unavailableReason` 是「未送达」而非「无权限」，用户拿不到「去补 scope」的正确暗示。

**建议**：补一条数字码分支，并在测试里用真实的 `FeishuApiError` 实例断言：

```ts
const FEISHU_PERMISSION_CODES = new Set([99991672, 99991671, 91403, 234001])
if (typeof code === 'number') {
  if (FEISHU_PERMISSION_CODES.has(code)) return 'permission-denied'
  if (code === 230002 || code === 1000023) return 'not-found'
  if (code === 231003 || code === 230011) return 'deleted'
}
```

注意 `unavailable.ts:14-18` 已经维护了一份终态码集合（`1000023/231003/230011`），应复用而非重复定义。

#### M2. `mimeForFileName` 与 18 项 MIME 表是死代码

**位置**：`src/outbound-file.ts:11-35`

`MIME_BY_EXTENSION`（18 条）+ `mimeForFileName()` 在 `src/` 内**零调用**（已全仓 grep 确认）。生产路径实际使用的是 `transport.ts:106` 的 `fileTypeFor()`——飞书 `im/v1/files` 需要的是 `file_type` 枚举（doc/pdf/xls/ppt/mp4/avi/stream），不是 MIME。

更麻烦的是 `test/outbound-files.mjs:21-25` 专门测了它并通过，给出「SPEC §6.3 的 MIME 映射已落实」的假信号。要么把它接进 `uploadAndSendFile`（若飞书上传确实需要 content-type），要么整块删除并同步删测试。保留一个只有测试引用的导出，是后续维护者的陷阱。

#### M3. `restart()` 重复注册 dispatcher，每次重连打一条 SDK error 日志

**位置**：`src/transport.ts:492-518`（`start()` 内 `dispatcher.register`）+ `:534-544`（`restart()` 调 `start()`）

`this.dispatcher` 在构造时创建一次（`:441`），`register()` 却写在 `start()` 里。`restart()` → `start()` 会二次注册相同 key。已在依赖里确认 SDK 行为（`node_modules/@larksuiteoapi/node-sdk/lib/index.js:100936-100943`）：

```js
if (this.handles.has(key) && key !== CAppTicketHandle) {
  this.logger.error(`this ${key} handle is registered`);
}
this.handles.set(key, handles[key]);
```

只 `logger.error` 不 throw，且用新 handler 覆盖——功能不受影响，但每次重启会往日志打两条 `error` 级别的假告警（`im.message.receive_v1`、`card.action.trigger`）。叠加 B2 的每 10 分钟重启，日志会被这些假 error 污染，真问题更难被发现。

**建议**：把 `dispatcher.register({...})` 移到构造函数，或在 `start()` 里加 `registered` 标志位守卫。

#### M4. `/history` 的 4000 字符截断砍掉的是**最新**内容

**位置**：`src/bridge.ts:1008-1011`

```ts
[`📜 最近 ${count} 条：`, ...lines].join('\n').slice(0, 4000)
```

`rows.slice(-count)` 保持时间正序（旧→新），`slice(0, 4000)` 从头保留，因此被丢掉的是**末尾即最新的几条**——恰好是用户最想看的。50 条 × 每条最多 400 字符 = 最多 2 万字符，远超 4000，触发概率不低。

SPEC §9 要求「以纯文本**分条**发送」，正是为了规避单条长度限制。**建议**改为按条聚合、每条 ≤3500 字符分多次 `sendText`，或至少改成 `.slice(-4000)` 保留最新。

#### M5. `/status` 缺 SPEC §8.1 要求的 lastReadyAt 与重建次数

**位置**：`src/bridge.ts:574-589`

v0.6.0 只往 `/status` 加了一行「出站文件」。SPEC §8.1 写「`/status` 输出：当前状态、**lastReadyAt**、**本次进程内重建次数**」，两项都没有；`connectionState()` 那行在 v0.6.0 之前就存在。提交信息声称「/status shows outbound-files + **connection health**」，`README.md:174` 也写「`/status` 可查连接状态」——实际能查的仍只有一个枚举状态。而 watchdog 是否在反复重启（B2）恰恰只能靠重建次数看出来，这个可观测性缺口让 B2 更难被用户自己发现。

#### M6. `/repair` 未上报 `im:message:send_as_bot`

**位置**：`src/bridge.ts:945-974`

SPEC §7.1 的检测项有四条，实现只输出三行（im:chat、im:resource、im:message）。`im:message:send_as_bot` 其实已被隐式证明——`sendText('🔧 正在检查权限……')` 成功即说明发消息权限正常，SPEC 也写「任一探针成功即证」——但结果里没有这一行，用户无法确认它被检查过。补一行 `✅ im:message:send_as_bot（发消息）—— 本条消息发出即说明正常` 即可，零成本。

#### M7. 测试脚手架不 await 异步用例：通过统计先于断言打印

**位置**：`test/image-fallback.mjs:13-17`、`test/outbound-files.mjs:13-17`、`test/files.mjs:12-18`

```js
const ok = (name, fn) => {
  fn()                       // async fn 返回 Promise，未 await
  passed += 1
  console.log(`${name}: true`)
}
```

已实证：把 `test/image-fallback.mjs` 的 `assert.equal(probeCalls, 1)` 改成必然失败的断言后运行，输出仍是

```
visual model (probe=true) keeps the image attachment block: true
...
image-fallback: 6 passed
AssertionError [ERR_ASSERTION]: DELIBERATE FAILURE
```

退出码确为 1（Node 22 默认把 unhandled rejection 视为致命），所以 CI **不会漏过**失败——但日志里那句「6 passed」是在断言执行前打印的，纯属误导。迭代文档「reply 15、image-fallback 6、outbound-files 6」这类计数因此不能当作覆盖率证据。

更实际的隐患有两个：一是若某个 async 用例 `await` 在永不 resolve 的 promise 上，断言根本不执行，用例**静默"通过"**；二是各 async 用例统一用 `await sleep(20)` 等待副作用（`test/image-fallback.mjs:86` 等），这是时间竞态，CI 机器负载高时会偶发失败。

**建议**：迁移到 `node:test`（Node 22 内置，零依赖）：

```js
import { test } from 'node:test'
test('non-visual model downgrades to text delivery', async () => { /* 断言 */ })
```

它自带 async 等待、真实计数、TAP 输出。同时把 `sleep(20)` 换成对确定信号的等待（如轮询 `fakeAgent.sent.length > 0`）。

#### M8. Feature E / F 零测试，违反 SPEC §10 的 TDD 铁律

`git show --stat b26931f` 显示 v0.6.0 提交改动 10 个文件，`test/` 下**一个都没有**。SPEC §10 写「每个 Feature 独立 TDD：先写失败测试 → 最小实现 → `npm run verify` 全绿」。watchdog 的触发条件（B2/S1）恰恰是最需要单测锁定的纯逻辑——`watchdogTick` 只依赖 `connectionState()` 和 `healthTimestamps()` 两个可注入接口，写表驱动测试的成本极低：

```js
// 健康且空闲 20 分钟 → 不应重启（当前实现会失败，正好暴露 B2）
// error 持续 1 分钟 → 不应重启；持续 6 分钟 → 应重启一次
// restart 未完成时再次 tick → 不应并发触发
```

`appendHistory` / `handleHistoryCommand` 同理（纯内存 + 一个 `sendText` mock），50 条上限、去重、脱敏、截断方向都可覆盖。

#### M9. `flattenPost` 与「引用内容不触发命令」均无测试

**位置**：`src/reply-reference.ts:94-128`；SPEC §4.5 / §4.6

- `flattenPost()` 是 Feature A 最复杂的函数（35 行，三层嵌套遍历 + `postElementText` 的多 key 回退），`test/reply.mjs` 只覆盖了 text / file / interactive 三种类型，`post`、`image`、`audio`、`media`、`sticker` 全无用例。
- SPEC §4.5 列的「命令不触发」和 §4.6 的验收项「引用内容含 `/new` → 不会开新会话」没有测试。代码层面这条约束是成立的（`src/bridge.ts:441-448`：`text.startsWith('/')` 分支先 return，`resolveReplyTag` 在其后才执行），属于设计正确但未被测试锁定——将来重排这几行就可能悄悄破坏一条安全约束。

#### M10. `npm run verify` 在缺少同级依赖仓库时以 ENOENT 崩溃

**位置**：`scripts/validate-manifest.mjs:10`

本地实测：

```
Error: ENOENT: no such file or directory, open 'E:\dsh-ecosystem-spec\registry\registry-0.15.json'
    at async load (file:///E:/dsh-tui-feishu/scripts/validate-manifest.mjs:10:39)
```

校验脚本硬依赖仓库**外部两级**的 `dsh-ecosystem-spec` 检出。CI 里靠 `.github/workflows/ci.yml` 显式 clone 解决，但本地 clone 后跑 `npm run verify`（README 与迭代文档 §5 都把它作为发版第一步）会直接崩，且异常栈没有任何可操作提示。

**建议**：脚本检测到 schema 缺失时打印可操作的 warning 并 `process.exit(0)`（跳过而非失败），或提供 `DSH_SPEC_DIR` 环境变量覆盖路径，同时在 README 记一句前置条件。

#### M11. `/compact` 的取消语义与副作用顺序

**位置**：`src/bridge.ts:1014-1039`

两处：

1. `await compaction.compactNow(agent, new AbortController().signal)` —— 传入一个**永不 abort** 的 signal，等于放弃取消能力。压缩挂住时用户侧只有「📉 正在压缩会话……」，再无反馈。SPEC 总原则第 3 条特别强调「必须保留取消信号语义」。建议改 `AbortSignal.timeout(120_000)` 并在超时后回一条明确提示。
2. `const agent = await this.ensureAgent(chatId)` 在 `if (this.turns.has(chatId))` **之前**。对一个全新聊天执行 `/compact`，会先创建一个 session + agent，然后才回「宿主没有压缩服务」。诊断类命令不该有建会话的副作用。把 turn 检查和 compaction 服务探测提到 `ensureAgent` 之前即可。

---

### 🟢 建议

- **缺 `.gitattributes`**：Windows 检出后 `git status` 立刻显示 `lib/` 下 32 个文件 "M"。已确认内容完全一致（`git diff --ignore-all-space` 为空），纯 CRLF/LF 噪声。加一行 `* text=auto eol=lf` 可消除，避免真实改动被淹没。
- **构建产物入库但无漂移守卫**：`lib/` 入库（迭代文档 §5 说明是 `npm pack` files 白名单的历史惯例），`package.json` 的 `main`/`files` 都指向它，测试也 `import '../lib/*.js'`。CI 虽然先 `npm run build` 再 `npm test`，但从不校验提交的 `lib/` 与 `src/` 一致。建议 CI 加一步 `git diff --exit-code lib/`，否则某次忘记重新构建就会发布出与源码不符的包。
- **命名易混**：私有字段 `outboundFileStatus`（`bridge.ts:297`）与公开 getter `outboundFilesStatus`（`:1194`）只差一个 `s`，`/status` 里用的是后者。建议字段改名 `outboundFileState` 之类，拉开距离。
- **死字段**：`HistoryEntry.at`（`bridge.ts:86`）被写入却从不读取——`handleHistoryCommand` 只用 role 和 text。要么在输出里加时间（对 `/history` 是有用信息），要么删掉。
- **`bridge.ts` 1606 行偏大**：`handleCommand` 的 switch 有 15+ 分支，命令处理、卡片渲染、watchdog、转录四类职责挤在一个类里。建议按命令族拆出 `commands/` 子模块（`commands/session.ts`、`commands/model.ts`、`commands/diagnostics.ts`），`Bridge` 只保留分发。
- **import 位置不规范**：`bridge.ts:290-292` 三条 `import` 出现在文件中部（第 283 行 `truncateSummary` 函数定义之后）。ESM 会被提升，功能无碍，但破坏阅读顺序，建议并入文件头。
- **测试注释与实际覆盖不符**：`test/outbound-files.mjs:1-5` 的文档注释声称覆盖「oversize」，`test/outbound-files.mjs` 实际没有体积用例；SPEC §6.4 要求的「大小 / 空文件 / 未知扩展 / 超时」矩阵里，只有未知扩展被测到（且测的是死代码 `mimeForFileName`，见 M2）。体积与空文件的校验都在 `transport.uploadAndSendFile()`，而 `transport.ts` 全无测试。

---

## 4. 代码质量点评

**命名（良好）**。`replyTargetId` / `buildReplyReference` / `modelLacksImageInput` / `probeImageResourceAccess` 都能从名字读出契约。三态返回的函数（`modelLacksImageInput`、`probeImageResourceAccess`）在 JSDoc 里明确写了 `true/false/undefined` 各自含义，这是本仓库很好的习惯。扣分项只有 M2 的 `outboundFileStatus`/`outboundFilesStatus` 一处。

**结构分层（良好，但编排层过厚）**。`index.ts`（宿主适配）→ `bridge.ts`（编排）→ `transport.ts`（平台）→ 纯函数模块，边界干净：纯函数模块（`inbound-sanitize`、`reply-reference`、`redact`、`tools`、`unavailable`）不 import 任何平台代码，因此可独立单测，`test/reply.mjs` 15 项全是同步纯函数测试，跑得快也稳。宿主能力全部通过结构化子集接口注入（`ToolsRegistryLike`、`ModelControl`、`AgentStore`、`ImageAttachmentRefLike`），松耦合做得到位，也让 `test/image-fallback.mjs` 能用纯 mock 驱动整个 Bridge。主要问题是 `bridge.ts` 1606 行承担了四类职责（见建议）。

**错误处理（整体强，但有系统性偏差）**。优点很实在：`asFeishuError()` 把 axios 层错误折成带业务码的 `FeishuApiError`，连 arraybuffer 响应体里的 JSON 错误都会解码（`transport.ts:172-190`）；`withTimeout` / `withTransientRetry` 分离了超时与重试；`markUnavailable` 用 TTL 记住已删除消息，避免对死卡片反复 patch。降级路径也普遍写对——`resolveInboundImage` 在 attachment 服务拒绝时回落到落盘（`index.ts:527-531`），`composePreset` 在 roster 不可用时无 preset 继续。

偏差集中在两类：

1. **三态被压成二态**。`probeImageResourceAccess` 明确返回三态，消费端只判 `=== false`（S6b）；`this.probe()` 把异常也吞成 `undefined`，两层叠加后「查不出来」变成「一切正常」。这是本仓库最需要建立纪律的地方：**凡返回 `boolean | undefined` 的探针，消费端必须显式处理三个分支**。
2. **软错误边界不齐**。`outbound-file.ts` 的 `execute` 里，`readFile` 失败被细致地转成中文软错误，紧邻的 `sendFile` 却裸调（S3）。同一函数内两种错误策略并存，说明缺少「工具 execute 内一律不抛」的显式约定。

`withTransientRetry` 的重试语义也有一处越界：它被用在了本应「不重试」的诊断探针上（S6a），说明重试策略是按 API 封装层统一施加的，而没有留出 per-call 的 opt-out 通道。

**重复代码（少，但有几处值得收敛）**：

- **错误码集合分散**。终态消息码在 `unavailable.ts:14-18`（`1000023/231003/230011`），权限码散落在 `transport.ts:653`（`99991672/234001/91403`）和 `reply-reference.ts:74`（HTTP 401/403/404/410），三处各自维护。建议集中到一个 `feishu-codes.ts`，`unavailableReasonFromError` 复用它即可顺手修掉 M1。
- **`withTransientRetry` + `asFeishuError` 的双层 try/catch 模板**在 `transport.ts` 里重复了 4 次以上（`updateCard`、`cardkitCreate`、`cardkitSendToChat`、`cardkitBatchUpdate`），且内外都调 `asFeishuError`，形状完全一致。抽一个 `callApi(operation, fn)` 辅助函数可以消掉约 40 行样板。
- **basename 提取写了两遍**：`inbound-sanitize.ts:66`（`cleanString` 的 basename 选项）和 `outbound-file.ts:105`（`rawPath.replaceAll('\\','/').split('/').at(-1)`）逻辑相同。后者应直接复用前者。
- 测试里 `const ok = (name, fn) => {...}` 在 9 个文件中逐字复制（且都带 M7 的缺陷）——迁到 `node:test` 可一次性消除。

**文档-实现一致性**。SPEC §10 自称「文档-实现一致性铁律」，实际执行参差：README 对 watchdog 的描述（`README.md:174`「静默……超过 10 分钟时自动全量重连」）**忠实反映了代码**，所以文档没说谎，是**代码偏离了 SPEC 的设计意图**——这比文档失真更值得警惕，因为它意味着实现期的临时决策没有回写 SPEC 评审。而 CHANGELOG「error/reconnecting **持续** 或静默超 10 分钟」里的「持续」在代码中并不存在（S1），迭代文档「新 27 项」测试的表述也不准确（M8）——这两处是真的文档失真。

---

## 5. 后续迭代改进建议

**优先级 0 — 先止血（建议不再叠加新 Feature）**

1. 修 **B1**（Feature B 给出真实路径）与 **B2**（watchdog 不再重启健康连接）。这两条让已声明「已上线」的功能实际可用。
2. 修 **S2**（`/history` 脱敏）。这是唯一有数据外泄性质的问题，改动量只有一行。
3. 为 `watchdogTick` 补表驱动单测（**M8**），把 B2/S1 的正确行为锁死。watchdog 是唯一会**自主改变系统状态**的组件，没有测试保护的自愈逻辑比没有自愈更危险。

**优先级 1 — 补齐 Feature 边界**

4. Feature C 三件套：前置 `stat` 校验（S4）、`sendFile` 软错误化（S3）、resume 路径注册（S5）、回传 message_id。
5. Feature D：探针脱离 `withTransientRetry`、三态如实上报、补 `send_as_bot` 行（S6/M6）。
6. `unavailableReasonFromError` 支持飞书数字码，并集中错误码定义（M1）。

**优先级 2 — 工程基建（收益跨所有后续迭代）**

7. **测试框架迁到 `node:test`**（M7）。当前 `ok()` 脚手架让「N passed」失去意义，这会持续污染每次迭代的自我验证——迭代文档已经因此写下不准确的覆盖率结论。这是本轮最应该优先偿还的技术债，因为它影响的是**判断能力本身**。
8. `validate-manifest.mjs` 缺 schema 时优雅跳过（M10）；CI 增加 `git diff --exit-code lib/` 漂移守卫；加 `.gitattributes`。
9. 拆分 `bridge.ts`：先把命令处理抽到 `commands/`，再抽 watchdog 为独立可测类（如 `ConnectionWatchdog`，依赖注入 `connectionState`/`healthTimestamps`/`restart` 三个函数）。

**优先级 3 — 设计层面的两条建议**

10. **建立「三态探针」编码约定并写入 SPEC**。本仓库已有三个三态探针（`modelLacksImageInput`、`probeImageResourceAccess`、`resolveModelSupportsImages`），其中两个的消费端处理不完整。建议约定：三态函数一律返回带判别标签的联合类型（`{kind:'yes'} | {kind:'no'} | {kind:'unknown', reason}`），让 TypeScript 的穷尽性检查替人工纪律把关——`undefined` 太容易被 `=== false` 这类判断顺手吞掉。
11. **重新审视「静默」与「健康」的关系**（B2 的根因）。SPEC §8.1 的「lastReadyAt 超过 10min 未刷新」这一条本身就不可满足（没有任何机制会在健康期刷新它），实现为了让它可用而引入了「静默」，结果把空闲误判为故障。正确的方向是从 SDK 拿真实存活信号（`getConnectionStatus()` / ping-pong 时间戳），或用低频主动探测。建议把这一条作为 SPEC 修订项回写，而不是继续在 bridge 侧打补丁——**SPEC 有错就改 SPEC**，这与本次迭代前置 gate 推翻两个原设计时的做法保持一致，也是本项目已经证明有效的工作方式。
