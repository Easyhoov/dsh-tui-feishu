# CardKit 2.0 打字机流式：启用、默认化与展示对齐方案

日期：2026-09-05
基线：hermes_lark_streaming 0.12.0（`/root/.hermes/hermes-agent/venv/lib/python3.11/site-packages/hermes_lark_streaming`，生产基线）；dsh-tui-feishu v0.7.0 → 0.8.0

## 0. 结论摘要

1. **CardKit 2.0 打字机流式引擎在代码中完整存在**（`src/streaming/cardkit-builder.ts` +
   `cardkit-manager.ts` + `transport.ts` 的 6 个 cardkit API，另有 `test/cardkit.mjs`、
   `scripts/cardkit-*.mjs`），但此前 **profile 未配置 `cardEngine`，默认走 v1
   `message.patch` 引擎**——整卡节流替换，飞书端看不到打字机效果。
2. 与 hermes_lark_streaming 相比，dsh 的 CardKit 引擎在「思考内容」与「工具链」
   的展示上存在若干差异（见 §2 差异清单），其中一部分影响观感/正确性，值得对齐。
3. 本文件记录：已执行项（§1）与待执行项（§2 修复方案），每项含改动文件与验收口径。

## 1. 已执行（v0.8.0）

### 1.1 profile 显式启用 cardkit（运行配置）

`/root/.dsh/profiles/dsh-tui/cordis.patch.yml` 增加：

```yaml
- id: dsh-tui-feishu
  config:
    cardEngine: cardkit
```

- patch 语义（dsh-app-boot `applyEntryPatches`）：非 `insert` 条目按 `id` 命中
  bundle 行并逐键覆盖；`config` 为键级替换。命中行
  `{id: dsh-tui-feishu, name: dsh-tui-feishu, inject: [commands]}` 的
  `name`/`inject` 不受影响。
- 生效条件：dsh-tui 进程重启后由 loader 重读该文件。

### 1.2 代码默认引擎改为 cardkit

`src/index.ts`：

- `Config.cardEngine` 注释与取值顺序改为 `'cardkit' | 'v1'`；
- 引擎选择 `(config.cardEngine ?? 'v1')` → `?? 'cardkit'`（唯一选择点，行 407）；
- 启动日志 `card engine: ${config.cardEngine ?? 'cardkit'}`（行 645）。

配套：

- `package.json` version → `0.8.0`；
- `README.md`：架构节「卡片引擎二选一」默认改为 `cardkit` 并注明「扫码一键创建
  应用默认支持卡片 2.0；旧应用不支持时显式 `cardEngine: 'v1'` 回退」；配置表默认列更新；
- `CHANGELOG.md` 新增 0.8.0 条目；
- 构建产物 `lib/` 已同步（CI drift guard 要求 lib 与 src 一致）。

风险：默认 cardkit 后，不支持卡片 2.0 流式的旧应用若未显式配 `v1`，回合卡会创建
失败并退化为纯文本回复（bridge 既有 fail-safe 路径）。可选项（未做，见 §2.6）：
启动时探测 `cardkitCreate` 失败码并自动降级 v1。

## 2. 待执行：展示对齐修复方案（对照 hermes_lark_streaming）

### 2.1 [P1] 思考面板标题实时化 + 思考耗时 — ✅ 已实现（v0.9.0）（hermes: `segment_helper.py build_reasoning_finalized_action`）

问题：streaming 期间 reasoning header 一直显示「💭 思考中」；思考结束/进入工具或
回答时 hermes 会把面板标题更新为「💭 Thought for 12.3s」（含耗时）并在终态卡收起。

改法（dsh `cardkit-manager.ts` / `cardkit-builder.ts`）：

- bridge 在 `openThink` 关闭处（tool/call、assistant/message、turn/end）产生
  「思考结束」信号：manager 增加 `reasoningElapsedMs`（think 行起止时间差），
  下一次 flush 用 `partial_update_element` 把 reasoning panel header 的
  title 更新为带耗时文案（zh/en：思考 · 12.3s）；
- 终态卡 `buildCardKitCompleteCard` 里 reasoning 面板标题同样带耗时；
- i18n 增加 `thoughtFor` 键。

验收：一回合含思考时，飞书端思考结束后标题变为「💭 思考 · 8.4s」；无思考时无面板。

### 2.2 [P1] reasoning 内容上限与分段 — ✅ 已实现（v0.9.0，上限 600→2400 + 截断尾注；多段分段见 2.3）

问题：think 文本 `.slice(0, 600)`（builder 与 manager 各一处），长思考被截断且无提示。

改法：上限提高到 2400（与正文分块一致），超限加「…（更多内容略）」尾注；若后续做
多段思考（2.3）则每段独立面板、互不截断。

### 2.3 [P2] 多段思考按序成面板（hermes: `segments.py` SegmentState 按事件序建段）

问题：dsh 把所有 think 行 join 进顶部唯一面板；hermes 每次 reasoning 块是独立
segment，工具调用后再次思考会新建面板插在工具链之后，终态卡按真实顺序
reasoning/tool/answer 交错渲染。

改法（较大）：CardRow 已有 think/tool 交错序（bridge rows 保留顺序），把
`cardkit-builder` 改为按 rows 顺序生成面板段列表：think 连续段→一个 reasoning
面板；tool 连续段→tool 面板（每段独立 element_id 供 streaming）。manager 的
「唯一 reasoning 元素」假设改为按面板元素 id 流式。v1 引擎行文本渲染可保持现状。

### 2.4 [P1] cardkit 路径接入 markdown 优化 — ✅ 已实现（v0.9.0，stream 与终态统一 optimize+降级表格）

问题：`cardkit-builder.ts` 终态正文只 `splitLongText`；`optimizeMarkdown` /
`downgradeTables` / `stripInvalidImageKeys`（cardmd.ts 已有，hermes 同源）未接入，
超 5 张表、非法 `![]()`、标题层级在卡上渲染不稳。

改法：终态正文与 stream 内容统一走 `optimizeMarkdown(downgradeTables(text))`；
stream 推送也做（与 hermes `controller.py _do_flush` 一致）。

验收：含 ≥6 张表/`![]` 假图的回答，卡片渲染不破版。

### 2.5 [P1] 代码围栏自适应 + 工具结果块语义化 — ✅ 已实现（v0.9.0，error xor result + prettyJson + 自适应围栏）

问题：`toolStepElements` 输出块用固定 ` ```text`（内容含反引号会破块），
Error/Result 混在一个 `detailOut` 里按状态选一个标签；hermes 用
`_format_code_block`（fence = 最长反引号串 +1）并区分 Error/Result 块。

改法：

- 用 cardmd 的 `formatCodeBlock`（已自适应 fence）+ `prettyJsonOrText`；
- bridge `tool/result` 拆分 `detailOut` 的 error/result 两个字段（或按 status
  只渲染其一），对齐 hermes 语义；
- 截断上限统一 800→1000（与 `DETAIL_CAPTURE_CHARS` 一致）。

### 2.6 [P2] 不支持卡片 2.0 时的自动降级（默认化后的兜底）— ✅ 已实现（v0.10.0，commit 3c34bc9）

改法：`startBridge` 首个回合卡 `cardkitCreate`/`cardkitSendToChat` 命中明确
「能力不支持」错误码时，把该桥的 `cards` 替换为 `StreamingCardManager` 并记日志
（引擎在桥生命周期内可替换一次）。v1 已可手动兜底，此项为体验优化。

实现（2026-09-05 定稿）：

- 新增 `src/streaming/fallback-card-stream.ts` `FallbackCardStream`：包装引擎选择，
  全部 `CardStream` 调用委托给当前引擎；`open()` 失败且错误为业务级
  `FeishuApiError` 时（瞬时码 2200/1663/300000/99991400 与网络错误已在 transport
  `withTransientRetry` 内重试，能冒出来的都是平台级永久拒绝）→ 记录日志、
  dispose 旧 CardKit manager、`fallback()` 工厂建 v1 manager、重试同一次 `open()`。
- 仅第一个回合卡触发、整桥生命周期至多换一次；`cardEngineFallback: false`
  （默认 true）保留旧 fail-safe（纯文本）。
- `src/index.ts`：默认 cardkit 且 fallback 未关时包一层；启动日志标注
  `auto-fallback to v1 armed`。
- 测试 `test/fallback.mjs` 5 例：业务拒绝→换 v1 且回合卡仍开；至多换一次；关掉
  fallback 时错误透传；网络型错误不换引擎；换后 v1 再被业务拒绝时透传不二次换。
  `npm run verify` 全绿。

### 2.7 [P3] 视觉/结构细节（hermes builder）

- collapsible header 折叠箭头（icon_position right + `down-small-ccm_outlined` +
  `icon_expanded_angle: -180`）——hermes 样式；
- 工具面板标题补「面板总耗时」；
- streaming 占位卡从「全元素预置」改为「loading 优先、按内容到达渐进加元素」
  （hermes `_do_create_card` 只放 loading，随后 add_elements）——观感最接近 hermes，
  但改动面最大，涉及 open()/apply() 结构，放最后。

## 2.8 设计定稿：P2.3 多段思考 / 拆卡 / 2.7 渐进建卡 = 一次统一重构（2026-09-05）

三者互相咬合（真实时序交错需要按到达顺序渐进加元素；加元素才谈得上 180 预算与
拆卡），合成一次 cardkit-builder + cardkit-manager 重构，逐个验收。基线对照
hermes：`segments.py`（reasoning/tool/answer 扁平段、事件序建段）、
`segment_helper.py`（ELEMENT_THRESHOLD=180、FOOTER_RESERVE=2、
`build_add_segment_action` 全部 `insert_before` loading 元素）、
`controller.py _do_split_card`（flush 已挂 actions → 封旧卡 → 建新卡继续）。

### 2.8.1 统一行模型 → 段模型（builder）

- `deriveLayout(rows)`：按行序把 rows 切段——连续 think 行→reasoning 段、
  连续 tool 行→tool 段（每段独立 element_id、独立序号）；段只增不改边界
  （bridge 只在末尾追加行），所以序号跨 snapshot 稳定。
- element_id：reasoning 段 `reasoning_panel_${i}` + 内层文本
  `reasoning_text_${i}`（每段独立文本预算，各自 truncate 2400 +
  「…（更多内容略）」尾注）；tool 段 `tool_panel_${j}`；answer 元素
  `streaming_content`；loading 元素 `loading_icon`（新增常量，作插入锚点）。
- reasoning 面板标题/耗时按段：段开 →「💭 思考中」，段闭 → 段内行耗时合计
  「💭 思考 · 12.3s」；终态卡与流式卡同一函数。
- 终态卡（complete）按段序交错渲染 reasoning/tool（不再「唯一 reasoning 面板
  压顶 + 唯一 tool 面板」），answer 分块在其后，hr + footer + 详情按钮照旧。
- 折叠箭头 + i18n_content 双语（`zh_cn`/`en_us` + config.locales）随本重构进入
  collapsiblePanel；工具面板总耗时在全部 steps 带 durationMs 时显示。

### 2.8.2 渐进建卡（P2.7）+ 流式 diff（manager）

- `open()` 只建：loading 图标 + Stop 按钮（保留桥的中断能力），不预置任何面板。
- 每次 flush 按 layout 逐段核对：缺面板→`add_elements`（`insert_before` 指向
  `loading_icon`，按到达顺序自然排列）；reasoning 段文本变化→`cardElement.content`
  推全段文本（沿用现语义：替换式推送）；段由开转闭→`partial_update_element` 改本
  段 header 标题带耗时；tool 段行变化→整体 `partial_update_element`。
- 首个非空正文到达时才加 answer 元素（占位 ' '）并开始流式；流式失败沿用
  best-effort + `streamClosed` 停推（200850/300309）；结构失败 retire 卡不变。

### 2.8.3 拆卡（迭代记录 §3-3 的 P2 背景项，验收口径补齐）

- 预算：`ELEMENT_THRESHOLD = 180`（平台硬上限 200，留 20 给 footer/波动）、
  `FOOTER_RESERVE = 2`，与 hermes 一致；元素数按新增子树 JSON 内带 `tag` 的节点
  数估算（reasoning 段 =4、每 tool step =3+detail 2+output 2 与 hermes 估算同源，
  用通用递归计数实现，天然覆盖嵌套 icon）。
- 触发：某 flush 中「当前卡已创建元素数 + 待加段估算 + FOOTER_RESERVE > 180」，
  且该卡元素数 >1（首卡刚建不算）→ 拆：先发掉本 flush 已挂 actions → 用已建段 +
  当前完整内容封旧卡（closeStreaming + full update，无 footer、带「前段已封存」
  灰色尾注、无按钮）→ 建新流式卡（loading + Stop，`slotBase` = 未建段起点，
  内容游标 = 当前完整内容）→ 未建段落到新卡继续。建新卡失败→
  `splitDisabled` 降级继续写旧卡（hermes 同款，避免反复撞同一边界）。
- 内容续写：answer 只在旧卡上滚到封存点；新卡从封存点之后的增量续推
  （content 前缀不匹配的改写场景整段重推一次，容忍重复）。
- 终态：只在当前尾卡 closeStreaming + full update（窗口化内容与窗口内行）；
  封存旧卡保持静态。🔍 详情 refresh 同样只重建尾卡窗口；多卡回合里旧卡不提供
  展开切换（封存卡无按钮）。
- 验收：单回合工具/思考段数逼近 200 元素（构造 60+ 工具段场景）→ 飞书端出现
  第二张续卡、旧卡封存完整、无 300305 元素超限错误；`/stop` 与详情按钮作用在
  最新卡；终态不丢字（跨卡拼接检查）。
- 遗留取舍（记录在案）：封存瞬间仍 running 的 tool 行、封存时仍开着的 reasoning
  段的后续增量不再更新（hermes 对 `i < split_index` 的段同样跳过）；正常回合
  （远低于 180）不受影响。

### 2.8.4 实施顺序与验证

1. builder 段模型 + 终态卡按序渲染；2. manager 渐进建卡 + 段级流式；
3. 预算计数 + 拆卡续写；4. 更新 `test/cardkit.mjs`（含段序、拆卡假 transport
   计数测试）+ `scripts/cardkit-lifecycle-smoke.mjs`（先 add 再 stream 的新语义）；
  每步 `npm run verify` 全绿后提交；5. 文档/版本收尾。

## 3. 验收与回归（P1 已全绿：npm run verify）

- `npm run verify`（build + manifest + 13 套件）全绿；
- 真机：配对应用（支持卡片 2.0）私聊触发一回合 → 观察：占位卡 → 工具行/思考
  打字机 → 终态卡；`/status` 与启动日志显示 `card engine: cardkit`；
- 旧应用（不支持卡片 2.0）显式 `cardEngine: 'v1'` 回归 v1 行为不变。
