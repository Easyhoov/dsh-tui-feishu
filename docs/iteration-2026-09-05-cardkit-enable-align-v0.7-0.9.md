# 迭代记录：CardKit 2.0 打字机流式 — 启用、默认化与展示对齐（v0.7.0 → v0.9.0）

> 日期：2026-09-05
> 范围：对照 hermes_lark_streaming 0.12.0（生产基线）检查 CardKit 2.0 引擎 → 运行时启用 →
> 默认引擎切换 → P1 展示对齐 → 验证、打包、装机
> 产出：v0.8.0（commit e7457a9）、v0.9.0（commit f3fc4e9）、方案文档
> `docs/plans/2026-09-05-cardkit-align-fix-plan.md`（commit a32eb2d）
> 仓库：Easyhoov/dsh-tui-feishu（本机 profile 已装 0.9.0，桥以 cardkit 引擎运行）

## 1. 起因与检查结论

用户反馈：「CardKit 2.0 打字机流式我并没有看到；思考内容和工具链展示要对齐
hermes_lark_streaming」。逐行核对了 dsh-tui-feishu 的 CardKit 实现（`src/streaming/*` +
`transport.ts` 六个 cardkit API）与 hermes_lark_streaming 0.12.0 的
`cardkit/builder.py`、`streaming/controller.py`、`segments.py`、`segment_helper.py`、
`tooluse.py`、`feishu.py`。

结论（详见方案文档 §0）：

1. **打字机流式代码完整存在，但运行时没启用**：`cardEngine` 默认 `v1`
   （`src/index.ts` `?? 'v1'`），profile 无任何插件配置 → 桥全程走
   `message.patch` 整卡替换，飞书端自然看不到打字机。
2. 与 hermes 的展示差异集中在：卡片何时出现哪些面板、思考面板标题/耗时、
   思考内容截断、CardKit 路径缺少 markdown 优化、工具结果块混拼 + 固定代码围栏。

## 2. 做了什么（v0.8.0 + v0.9.0）

### 2.1 运行时启用 + 默认引擎切换（v0.8.0，commit e7457a9）

- `/root/.dsh/profiles/dsh-tui/cordis.patch.yml`：为 `dsh-tui-feishu` 配置
  `cardEngine: cardkit`（loader 按 id 命中、键级覆盖；patch 语义核对了
  dsh-app-boot `applyEntryPatches` 源码）。
- `src/index.ts`：引擎选择与启动日志的默认值 `?? 'v1'` → `?? 'cardkit'`；
  `Config.cardEngine` 文档同步。
- `package.json` 0.7.0 → 0.8.0；README 引擎章节与配置表默认列更新；
  CHANGELOG 0.8.0 条目。
- 决策：v1 保留为显式配置的兼容兜底；未做自动能力探测降级（见 §4）。

### 2.2 P1 展示对齐 hermes（v0.9.0，commit f3fc4e9）

1. **思考面板标题实时化 + 思考耗时**（hermes `build_reasoning_finalized_action` 语义）
   - bridge（`src/bridge.ts`）：TurnState 增加 `thinkStartedAt`，新增
     `finalizeOpenThink()`，在 tool/call、assistant/message、turn/end 三处关闭
     思考块并给 think 行打 `durationMs`；
   - `cards.ts` think 行类型增加可选 `durationMs`；i18n 新增 `thoughtFor`；
   - `cardkit-builder.ts` 导出 `reasoningPanelTitle()`：思考中 →「💭 思考中」，
     块关闭后 →「💭 思考 · 12.3s」（多块聚合总耗时）；
   - `cardkit-manager.ts`：流式期间用 `partial_update_element` 原位更新面板
     header 标题（不再停留「思考中」）；终态卡收起并带耗时。
2. **思考内容上限 600 → 2400**：流式推送与终态渲染共用 `MAX_REASONING_CHARS`
   （2400），超限追加「…（更多内容略）」尾注。
3. **CardKit 路径接入 markdown 优化**：回答正文 stream 与终态卡统一走
   `optimizeMarkdown(downgradeTables(...))`（标题降级、超 5 张表转代码块、
   非法 img_key 剥离），与 v1 引擎和 hermes 一致。
4. **工具结果块语义化 + 围栏自适应**：失败只呈现错误、成功只呈现结果
   （hermes error-xor-result 语义，不再混拼）；结果块用
   `prettyJsonOrText` + `formatCodeBlock`（围栏越过内容最长反引号串）。

### 2.3 工程与验证

- `npm run verify` 全绿（构建 + Community v0.15 manifest 校验 + smoke 36 断言 +
  12 套 node:test），lib/ 随 CI drift guard 同步提交；
- 打包 0.8.0 / 0.9.0 tgz，profile `package.json` 指向新 tgz 并 pnpm 重装；
- 运行时：旧桥实例（含 2026-09-03 起在跑的一次）清理后重启，
  `bridge ready … (card engine: cardkit)`，锁 pid 正常轮换；
  本机 profile 当前运行 0.9.0。

## 3. 没做什么（有意搁置，见方案文档 P2/P3）

1. **多段思考按序成独立面板**（P2.3）：hermes 每次 reasoning 块是独立 segment，
   工具调用后再思考会新开面板、终态按真实顺序交错渲染；dsh 目前全部 think 行
   聚合进一个面板。
2. **loading-only 渐进建卡**（P2.7）：hermes 消息开始只发 loading 占位，面板随
   内容到达按序 `add_elements`；dsh 目前 open 时预置 reasoning/工具/答案元素。
3. **超长回合拆卡**（P2 背景）：hermes 在 ~180 元素处把旧卡封存、新开卡续写；
   dsh 仍用「30 步折叠 + 历史元素」的单卡方案。
4. **卡片 2.0 能力自动探测降级**：默认 cardkit 后，不支持卡片 2.0 的旧应用需
   显式配置 `cardEngine: 'v1'`（README/profile 注释已写明）；未做启动探测 + 自动降级。
5. **P3 视觉细节**：面板折叠箭头图标、工具面板总耗时、i18n_content 双语等。

## 4. 遗留风险与回退

- 风险：默认引擎变为 cardkit 后，不支持卡片 2.0 的应用回合卡会创建失败，
  按既有 fail-safe 退化为纯文本回复。回退：profile patch 中
  `cardEngine: v1`（或装回 0.7.x）。
- 运行中加载旧版模块的实例需重启才生效（本机已完成重启；其他装机点同）。
- 三个 commit 未推送时的本地状态已在本记录归档时完成推送（见仓库 remote）。
