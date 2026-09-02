# 迭代记录：代码审查 → 审计核验 → 22 项修复（v0.6.0 → v0.7.0）

> 日期：2026-09-03
> 范围：v0.6.0 交付后代码审查 + 独立审计核验 → 按严重级逐项修复 → 补测试与 CI 守卫 → 发版
> 产出：v0.7.0（commit 4cb1031；docs/code-review-2026-09-02.md 与 docs/code-review-audit-2026-09-02.md 随仓库归档）
> 仓库：Easyhoov/dsh-tui-feishu

## 1. 起因

v0.6.0 上线后对提交 `4faf685` 做了一次独立代码审查（`docs/code-review-2026-09-02.md`），
随后又做了一轮**审计核验**（`docs/code-review-audit-2026-09-02.md`）：22 项发现逐条重读源码/
git 证据/依赖源码，并用 `audit-verify.mjs` 跑真实编译产物（11 项行为类结论）。
审计结论：**22 项发现中 21 项完全属实，1 项（M1）属实但机制描述被修正**——没有捏造或误判。
本轮迭代 = 把这份结论逐项修掉。

## 2. 审查/审计结论摘要

| 结论 | 内容 |
|---|---|
| Phase 1（v0.4.0）质量最高 | 接近可交付 |
| Phase 3（v0.6.0）完成度最低 | watchdog/历史 无任何测试，且 watchdog 会把健康连接每 10 分钟拆一次 |
| 系统性偏差 ① | 三态探针被消费端压成二态，「查不出来」被输出成「一切正常」 |
| 系统性偏差 ② | 工具 execute 软错误边界不齐：readFile 软错误、紧邻的 sendFile 裸抛 |
| 错误码集合三处分散 | unavailable.ts / transport.ts / reply-reference.ts 各自维护 |
| 测试脚手架缺陷 | `ok()` 不 await 异步用例，「N passed」先于断言打印，9 个文件同缺陷 |

## 3. 关键设计决策（修复过程中的确认与修正）

1. **S2 脱敏位置**：采用「在 `appendHistory` 入口脱敏」（比读取点更稳妥，报告原文亦倾向此）；
   存进内存的转录即干净数据，未来新增消费点不会再次遗漏。
2. **M7 迁移范围**：9 个使用 `ok()` 脚手架的测试文件全部迁移 `node:test`（不只是点名 3 个），
   一次消除同类缺陷。
3. **M2 MIME 表**：技术判定为删除——飞书 `im/v1/files` 只接受 `file_type` 枚举
   （transport.ts `fileTypeFor()`），请求无 content-type 参数，MIME 表无处可接。
4. **M1 机制修正（审计回改）**：`getMessage` 现在按平台信封读取 `data.items` 并检查 body `code`。
   SDK 拦截器返回原始信封 `{code,msg,data}`，原 `response.items` 读取路径运行时恒为空——
   这意味着修复前引用主链可能从未真正取到内容（详见 §7 遗留）。
5. **watchdog 存活信号**：`lastReadyAt>10min` 条件本身不可满足（健康期无人刷新它），
   改为信任 SDK `ws.getConnectionStatus()` 的原始 socket 状态。

## 4. 修复记录（22 项，按严重级）

### 🔴 阻塞

- **B1**（bridge.ts/index.ts）：模型预检查提前到 `resolve()` 前，`resolveInboundImage` 增 `preferFile`；
  非视觉模型先落盘再投递 `<path>`，不再给 agent 一条没有路径的「读文件」指令。
- **B2**（bridge.ts/transport.ts）：删除「静默 10 分钟即重启」；新增 `livenessState()`
  （`ws.getConnectionStatus().state`）——健康空闲连接永不被重启；`ready` 但 socket 已死仍可兜底。

### 🟠 严重

- **S1**（bridge.ts/transport.ts）：error/reconnecting 需**持续 5 分钟**才重启（`unhealthySince`）；
  `restartInFlight` 防并发；重启退避阶梯 250ms→1s→3s→5s→10s→30s（`RESTART_LADDER`）；
  `restart(delayMs)` 后与 SDK 原始状态对账，避免卡死 `reconnecting`。
- **S2**（bridge.ts）：转录入口 `redactInlineSecrets`，`/history` 回放零明文。
- **S3**（transport/bridge/index/outbound-file）：`sendFile` 失败折软错误（agent 可转述）；
  `uploadAndSendFile` 返回 `{fileKey, messageId}`，工具结果携带飞书 `message_id`（SPEC §6.3）。
- **S4**（outbound-file.ts）：`readFile` 前 `stat` 预检——普通文件/非空/≤30MB，全中文软错误；
  目录不再泄漏原始 EISDIR，大文件不再整读进内存。
- **S5**（bridge.ts）：抽 `registerOutboundTool`，`ensureAgent` 的 live/resume/create 三条路径都注册；
  `Set` 按 agent.id 去重；disposer 存入 `dispose()` 释放。
- **S6**（transport/bridge）：`downloadMessageResource` 增 `bounded` 单发通道（5s、不重试）；
  `/repair` 三态上报——网络异常显示 ⚠️ 不确定，不再误报 ✅（最坏耗时 82s→5s）。

### 🟡 一般

- **M1**：`unavailableReasonFromError` 识别飞书数字业务码（99991672/230002/231003/1000023…），
  终态码复用 `unavailable.ts`；`getMessage` 检查 body `code` 并抛带数字码的 `FeishuApiError`。
- **M2**：删除 18 条 MIME 表 + `mimeForFileName` 及其测试（死代码）。
- **M3**：`dispatcher.register` 移入构造函数——restart→start 不再二次注册、不再打假 error 日志。
- **M4**：`/history` 按 SPEC §9 分条发送（每条 ≤3500），不再头部截断砍掉最新内容。
- **M5**：`/status` 补「最近就绪」（lastReadyAt）与「本次进程内重建次数」（restartCount）。
- **M6**：`/repair` 补 `im:message:send_as_bot` 检测行（SPEC §7.1 四项齐全）。
- **M7**：9 个测试文件全部迁移 `node:test`；image-fallback/files 的 `sleep(20)` 换确定性轮询。
- **M8**：新增 `test/watchdog.mjs`（8 项）+ `test/history.mjs`（8 项），锁定 B2/S1/S2/M4 行为。
- **M9**：新增 `test/reply-guard.mjs`（引用含 `/new` 不触发命令）+ reply.mjs 补 post/媒体类型/flattenPost 用例。
- **M10**：`validate-manifest.mjs` 缺 schema 时提示 + exit 0；`DSH_SPEC_DIR` 覆盖；README 前置说明。
- **M11**：`/compact` turn/会话检查提前（fresh chat 不建会话）；`AbortSignal.timeout(120s)` + 超时提示。

### 🟢 建议（6 执行 / 1 跳过）

- `.gitattributes`（`* text=auto eol=lf`，commit c8a8343）——消除 Windows 检出 CRLF 噪声
- CI 增 `git diff --exit-code lib/` 漂移守卫（构建产物与 src 必须一致）
- 私有字段 `outboundFileStatus` → `outboundFileState`（与 getter `outboundFilesStatus` 拉开距离）
- `HistoryEntry.at` 在 `/history` 行首显示 HH:MM（死字段转有用信息）
- bridge.ts 中部三条 import 并入文件头
- outbound-files.mjs 文档注释对齐实际覆盖，并补 S4 预检三项测试
- ⏭️ bridge.ts 1606 行拆 `commands/` 子模块：架构级重构，**本轮不做**（与缺陷修复不成比例，留待专门迭代）

## 5. 测试变化

| 之前 | 之后 |
|---|---|
| 10 个套件，`ok()` 脚手架（不 await、假计数） | 13 个套件：12 个 node:test + smoke |
| reply 15 / image-fallback 6 / outbound-files 6…（v0.6.0 净新增 0） | **112 项 node:test + smoke，全部通过** |
| watchdog/历史/引用守卫：无任何测试 | watchdog 8 + history 8 + reply-guard 3 + 断言扩展 |

`npm run verify` = build（tsc）+ validate:manifest（缺 spec 优雅跳过）+ 全部测试。

## 6. 遗留问题与后续建议（真机/产品层面）

1. **裸 sk- token 脱敏缺口**：`redactInlineSecrets` 只覆盖 `key=value`/`Authorization:`/`--flag`
   三类模式，无上下文的裸 token 不脱敏（redact.ts 既有契约，卡片链路共用）。需扩展模式 + redact 单测。
2. **引用主链需真机联调**：M1 修正揭示了 SDK 信封形状问题——修复前 `response.items` 恒为空，
   Feature A 的引用内容可能从未真正被取到（审查仅静态确认主链完整）。发版后请真机引用一条消息验证。
3. **flattenPost 入站形状需实测**：测试按实现实际遍历的嵌套形状构造；仓库无真实 post 报文 fixture，
   真实 `msg_type=post` 引用报文结构与实现是否一致待真机确认（本次未改函数）。
4. **watchdog 首连挂死未覆盖**：state 停在 `starting`（首次 start 抛错被捕获）时 watchdog 不动作
   ——报告 22 项未列此场景，仅记录待议。
5. **文档失真待回写**：CHANGELOG v0.6.0 的「持续」措辞、迭代文档「新 27 项」测试表述不准确；
   SPEC §8.1 的 lastReadyAt 条款本身不可满足。建议作为 SPEC/CHANGELOG 修订项回写（本项目惯例：SPEC 有错改 SPEC）。
6. **3 项审计脚本仍报「属实」是脚本旧假设**（非代码缺陷）：B1 脚本 mock 未按新 `preferFile` 契约更新；
   M3 脚本直接演示 SDK 内部重复注册行为；S2 脚本使用无上下文的裸 token 形状。

## 7. 发版

```bash
npm run verify   # 112 项 node:test + smoke 全绿
git tag v0.7.0   # 指向本迭代文档提交（对齐 v0.6.0 打在迭代文档提交的惯例）
git push origin main --tags
```

CHANGELOG 新增 0.7.0 条目；审计报告（code-review + audit 两份）随本提交归档于 docs/。

