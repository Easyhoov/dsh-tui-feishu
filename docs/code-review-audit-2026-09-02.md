# 审查报告审计核验（Audit）

> 审计对象：`code-review-2026-09-02.md` 中列出的全部 22 项发现（阻塞 2 / 严重 6 / 一般 11 / 建议组 7）
> 审计日期：2026-09-02
> 代码基线：`Easyhoov/dsh-tui-feishu` @ `4faf685`（v0.6.0），与原审查同一快照
> 审计方式：**静态复核**（逐条重读源码/git 证据/依赖源码）+ **可执行实证**（`audit-verify.mjs`，11 项行为类结论跑真实编译产物 `lib/` 验证）

## 审计结论（一句话）

**22 项发现中 21 项完全属实，1 项（M1）属实但机制描述需修正（已回改原报告）；未发现捏造、夸大或误判的条目。**

---

## 一、实证核验结果（11 项，跑真实代码）

验证脚本：`.workbuddy/artifacts/audit-verify.mjs`（对编译产物 `lib/` 直接调用，TS `private` 编译后可访问，故能驱动 `watchdogTick` / `handleHistoryCommand` / `handleRepairCommand` 等内部方法）。运行结果原样摘录：

```
[属实] B2  健康连接 + 11 分钟无入站消息 → watchdog 强制重启 — restart() 被调用 1 次（期望 0）
[属实] S1a error 状态首个 tick（持续时长 0）即触发重启，无 5 分钟持续判定 — restart() 1 次
[属实] S1b restart 未完成时再次 tick 会并发触发第二次 restart — restart() 2 次
[属实] S2  /history 原样回放密钥，未调用 redactInlineSecrets — 密钥明文出现在输出中
[属实] M4  /history 4000 字符截断保留最旧、丢弃最新 — ROW00 在、END49 不在，长度 4000
[属实] S6b im:resource 探针无法判定（网络异常）时，/repair 输出 ✅ — 无 ⚠️ 不确定态
[属实(机制需修正)] M1 数字码 99991672→not-delivered（期望 permission-denied），230002→not-delivered
[属实] B1  降级投递要求 agent 读文件但未提供路径/附件标识 — ref 字段=[attachmentId,mediaType,bytes,width,height]
[属实] S3  上传失败时 execute 向外抛异常 — 抛出: Error: upload timed out after 120000ms
[属实] S4  传入目录时返回原始英文错误 — error=…Error: EISDIR: illegal operation on a directory, read
[属实] M3  重复 dispatcher.register 触发 SDK error 日志 — "this im.message.receive_v1 handle is registered"
```

各实证的构造方式与判定依据：

| 项 | 构造 | 判定 |
|---|---|---|
| B2 | mock transport：`connectionState()→'ready'`，`healthTimestamps()` 返回 11 分钟前的时间戳 | `watchdogTick()` 后 `restart()` 被调 1 次。**健康空闲连接确实会被重启**，报告推演成立 |
| S1a | `connectionState()→'error'`，时间戳为**当前时刻**（持续时长=0） | 首个 tick 立即 restart。SPEC §8.1 的「持续超过 5min」不存在于代码 |
| S1b | `restart()` 返回永不 resolve 的 Promise，并发调用两个 `watchdogTick()` | restart 计数=2。无 in-flight guard，坏网络下（start 含 15s 握手重试）必然可并发 |
| S2 | `appendHistory` 写入含 `sk-audit-secret-123456` 的行 → `handleHistoryCommand` | 明文密钥原样出现在 `sendText` 输出 |
| M4 | 写入 50 行 × ~400 字符的转录 → `handleHistoryCommand` | 输出恰好 4000 字符，含最旧行 ROW00、不含最新行 END49——截断方向确认为「砍最新」 |
| S6b | `probeImageResourceAccess()` 直接抛错（模拟网络异常/超时） | `/repair` 最终输出 `✅ im:resource`，无任何不确定态提示 |
| M1 | 传入各种错误形状：`{code:99991672}`、`{code:230002}`、`{status:403}`、真实 `axios@1.19` 的 `AxiosError`（顶层 `.status=403`） | 见下文「需修正」小节 |
| B1 | probe=false + attachment 结果走完整入站链路（`handleIncoming`→`deliverImage`） | followup 消息含 `read_image` 指令，但无任何路径/attachmentId；`ref` 的字段列表证实无 path |
| S3 | `sendFile` 抛 `Error('upload timed out')`，真实临时文件 | `execute` 向外 reject，未返回 `{ok:false,error}` 软错误 |
| S4 | `execute({path: <目录>})`（脚本自身所在目录） | 返回 `ok:false` + 原始英文 `EISDIR` 错误——无「普通文件」前置校验 |
| M3 | 实例化 SDK `EventDispatcher`，同一 key 注册两次（捕获 logger 输出） | SDK 打印 error 级 `this im.message.receive_v1 handle is registered`——`restart()→start()` 二次注册必触发 |

## 二、静态复核结果（其余各项）

| 项 | 核验方式 | 裁定 |
|---|---|---|
| B2 前提「`lastReadyAt` 健康期不刷新」 | `grep lastReadyAtValue src/transport.ts` → 仅 448（声明）/461（onReady）/474（onReconnected）/487（读） | **属实**。无其它赋值点 |
| S5 resume/复用路径不注册工具 | `grep installOutboundFileTool src/bridge.ts` → 唯一调用点 1170；`ensureAgent`（1133-1148）中 `return live` 与 `return await store.resume(...)` 两条早退均在 1170 之前 | **属实** |
| S6a 探针重试链 | `downloadMessageResource`（transport.ts:367-378）为 `withTransientRetry` 包裹的 `client.request({timeout:20_000})`，非 `FeishuApiError` 一律视为 transient 重试 3 次 | **属实**。一处细化：连接拒绝（ECONNREFUSED）会快速失败（只是白重试 4 次）；「最坏 ≈82s」发生在网络黑洞/超时场景。原报告表述成立但补充了触发条件 |
| M2 MIME 表死代码 | 全仓 grep：`mimeForFileName` 仅 `src/outbound-file.ts:32`（定义）与 `test/outbound-files.mjs`（引用） | **属实** |
| M5 `/status` 缺字段 | 重读 bridge.ts:577-588：仅连接状态/出站文件/会话/工作目录/绑定数/帮助六行 | **属实**。无 lastReadyAt、无重建计数 |
| M6 `/repair` 缺 send_as_bot | 重读 bridge.ts:949-963：输出行仅 im:chat / im:resource / im:message 三项 | **属实** |
| M7 测试脚手架不 await | 原审查会话中已注入必然失败的断言实证：输出仍打印 `image-fallback: 6 passed`，随后才出现 AssertionError；退出码 1 | **属实**（既有证据） |
| M8 v0.6.0 零测试 | `git show --stat b26931f | grep -c "test/"` → **0**；`npm test` 实跑计数 reply 15 + image-fallback 6 + outbound-files 6 = 27，恰为迭代文档所称「新 27 项」，而它们全部来自 v0.4.0/v0.5.0 提交 | **属实** |
| M9 flattenPost/命令不触发无测试 | `grep -c "flattenPost\|'post'" test/reply.mjs` → 0；`grep -c "命令\|/new"` → 0 | **属实** |
| M10 verify 本地 ENOENT | 原审查会话实跑 `npm run verify` → `ENOENT: E:\dsh-ecosystem-spec\registry\registry-0.15.json` | **属实**（既有证据） |
| M11 /compact 顺序与 signal | 重读 `handleCompactCommand`：`ensureAgent` 在 `turns.has` 之前；`compactNow(agent, new AbortController().signal)`——该 controller 无任何 abort 调用路径 | **属实** |
| 建议：缺 `.gitattributes` | `ls` 仓库根 → 无；Windows 检出后 32 个 lib/ 文件显示 M | **属实** |
| 建议：lib/ 与 src/ 一致 | `git diff --ignore-all-space --stat lib/` → 空（内容零差异，纯 CRLF） | **属实**（原报告未把 CRLF 误报为实质漂移，判断正确） |
| 建议：CI 无漂移守卫 | 重读 `.github/workflows/ci.yml` → build/test 之间无 `git diff --exit-code lib/` 步骤 | **属实** |
| 建议：命名/死字段/行数/import 位置/注释失实 | grep 与重读：`outboundFileStatus`(297) vs `outboundFilesStatus`(1194)；`HistoryEntry.at` 只在 993 写入、无读取点；`wc -l src/bridge.ts`=1606；import 在 290-292；outbound-files.mjs 文档注释声称 oversize 但无用例 | **全部属实** |

## 三、需修正的一处：M1 的机制描述

原报告称「`transport.getMessage()` 的失败会被 `asFeishuError()` 折成 `FeishuApiError`」——**核验不成立**：`getMessage()`（transport.ts:578-618）直接调 `client.im.v1.message.get`，未经 `asFeishuError` 包装。

实证补全后的真实情况（均已跑真实 `axios@1.19.0` 验证）：

| 错误形状 | 实测映射 | SPEC 期望 | 判定 |
|---|---|---|---|
| HTTP 403/404/410（axios 1.19 `AxiosError`，顶层 `.status`） | permission-denied / not-found / deleted | 同左 | ✅ 正常工作（原报告低估了这条路径） |
| 数字业务码 `{code: 99991672}` | not-delivered | permission-denied | ❌ 缺口属实 |
| 数字业务码 `{code: 230002}` | not-delivered | not-found | ❌ 缺口属实 |
| HTTP 200 + body `code!=0`（本仓库 `assertOk()` 的存在证明该形状真实存在） | `getMessage` 只看 `items`，缺失即抛自造的 `'not-found'`（transport.ts:599-603），body code 被丢弃 | 按 body code 分类 | ❌ 误分类路径属实 |

**裁定：M1 属实（数字码映射缺口 + HTTP-200 带错误码的误分类路径均真实存在），但原机制描述有误，已回改原报告 M1 段落。** 修复建议不变：让 `getMessage` 检查 body `code` 并构造带数字码的错误，`unavailableReasonFromError` 增加数字码分支，错误码集合与 `unavailable.ts` 收敛。

## 四、核验中确认无误的关键依赖事实

以下结论来自依赖源码阅读，是 S1/M3/B2 推演的地基，复核均通过：

- **lark SDK `EventDispatcher.register`**（`node_modules/@larksuiteoapi/node-sdk/lib/index.js:100936-100943`）：重复 key 只 `logger.error` 并覆盖，不 throw——restart 功能不因此中断，但必打假 error 日志（已实证）。
- **lark SDK `WSClient.close()`**（`:102596-102621`）：`this.reconnectGeneration++` 作废进行中的重连循环——watchdog 重启会打断 SDK 自身 autoReconnect 的推演成立。
- **lark SDK `WSClient.start()`**（`:102625` 起）：显式重置 terminalError / currentReconnectAttempts，注释写明支持 close 后再 start——「restart 用同一 WSClient 可行」的判断成立。
- **axios 1.19 `AxiosError`**（`node_modules/axios/lib/core/AxiosError.js:167`）：`this.status = response.status`——见上表，这修正了 M1 的部分论据。

## 五、原报告中被判定为「判断」而非「事实」的内容

完成度百分比（90%/50%/60%/35% 等）、各问题严重级分级、代码质量评语、改进建议的优先级排序——这些是审查者的工程判断，不属于可证伪的事实声明，不在本次核验范围内。可核验的部分（文件位置、行为描述、SPEC 条款引用、git/测试证据）已全部覆盖。

---

**审计方法说明**：静态复核 = 重读源码与 git 历史；实证 = `node .workbuddy/artifacts/audit-verify.mjs`（可在同一快照上复跑，输出 11 项裁定）。唯一被修正的内容是 M1 的机制描述，已同步回原报告。
