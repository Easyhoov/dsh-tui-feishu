# Changelog

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
