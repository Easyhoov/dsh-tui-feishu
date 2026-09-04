# dsh-tui-feishu

> 飞书远程遥控你的 dsh-TUI agent——扫码建机器人，飞书里聊，审批卡片里批。

Feishu (Lark) remote-control surface for [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI): a Feishu private chat maps to a persistent dsh session, replies stream back as one live card per turn, risky tool calls arrive as 🔐 approval cards, and the ⏹ Stop button cancels a running turn.

本插件是 [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) 生态插件，运行在其 profile 之上；宿主仓库：https://github.com/ccch1mneyyy/dsh-TUI

**dsh-TUI ecosystem plugin (Community v0.15 admission profile).** Refactored from [PGZXB/dsh-feishu](https://github.com/PGZXB/dsh-feishu) (MIT), simplified to the p2p chat loop and rebuilt on the official [飞书开放平台「扫码一键创建应用」SDK](https://open.feishu.cn/document/mcp_open_tools/integrating-agents-with-feishu/overview) (`@larksuiteoapi/node-sdk` ≥ 1.61.1, `registerApp` Device Authorization Grant).

## 效果

```
你（飞书）                        dsh-TUI（你的电脑）
  │  帮我看下今天的提交                   │
  │ ──────────────────────────────> │  agents.create/resume + followup
  │                                 │  agent 开始干活（工具/思考/回复）
  │  ⏳ bash: git log --oneline    <│  流式卡片（原地 patch，无打扰通知）
  │  ✅ bash: npm test              │
  │  📝 今天有 3 个提交……           │
  │                                 │
  │  🔐 Approval needed: bash       <│  高风险操作
  │  [✅ Allow once] [❌ Reject]    │  ── 点按钮，turn 继续
```

## 安装

```bash
# 在 dsh-TUI 的 profile 里安装（或任意 dsh profile）
dsh plugin --profile dsh-tui add dsh-tui-feishu

# 从源码：构建并打包后本地安装
npm run verify && npm pack
dsh plugin --profile dsh-tui add file:dsh-tui-feishu-0.3.1.tgz
```

> `npm run verify` 的 `validate:manifest` 步骤需要一个同级检出的
> `dsh-ecosystem-spec` 仓库（放在本仓库 `../..` 目录）。本地没有时该步骤会
> 打印提示并跳过（不影响构建/测试），或用 `DSH_SPEC_DIR=/path/to/dsh-ecosystem-spec`
> 显式指定其位置。

> 也可以直接从 [GitHub Releases](https://github.com/Easyhoov/dsh-tui-feishu/releases) 下载最新 tgz。

## 扫码配对（推荐）

在 TUI 里输入：

```
/feishu pair
```

配对页面会自动在浏览器打开（页面上自带二维码），用手机飞书扫码确认，飞书云端就会建好一个自带机器人能力、长连接事件和卡片回调的应用，凭据自动回传并写入 `$DSH_HOME/dsh-tui-feishu/credentials.json`，桥接立即启动。**扫码的人自动成为唯一授权用户**（只允许他使唤你的 agent）。浏览器打不开时，命令结果和日志里会给出一次性配对链接。

已配置过凭据后再次 `/feishu pair` 会被拒绝（防止覆盖在跑的桥）；换凭据先删 `credentials.json`。

## 手动配置（已有飞书应用时）

任选其一：

1. 环境变量：`FEISHU_APP_ID` / `FEISHU_APP_SECRET`
2. 配置键：profile 的 cordis.patch.yml 中给本插件的 config 加 `appId` / `appSecret`

手动配置时需要应用已具备：`im:message`、`im:message:send_as_bot`、`im:chat`、`im:resource`（接收图片消息需要）权限，事件订阅 `im.message.receive_v1`（长连接模式），卡片回调 `card.action.trigger`。

## 用法

飞书里私聊机器人：

- 发任何消息 = 给 agent 下指令，回复以流式卡片实时更新（思考/工具行 + 正文 + ⏹ Stop 按钮）
- `/new` 开新会话（旧会话留在磁盘上）；`/status` 看桥接状态；`/help` 帮助
- 会话跨重启持久化：`$DSH_HOME/dsh-tui-feishu/session-map.json` 记录 飞书会话 ↔ dsh session 绑定，重启后自动 `agents.resume()` 恢复

TUI 里：

- `/feishu` 查看连接状态；`/feishu pair` 扫码配对

会话与 TUI 互通：飞书创建的会话会出现在 TUI 的 `/resume` 列表里（同一 dsh host），反之亦然。

## 架构

一条出站长连接承载两个方向（**无需公网 IP / 回调地址**）：

```
飞书消息 ──WSClient──> Bridge ──> sessionMap(chat↔session) ──> agents.create/resume + agent.followup
                                                                    │
流式卡片 <── CardStream 引擎 <── session/event 流（chunk/tool/turn/end）
审批卡片 <── Allow/Reject 按钮 ── approval/request 瀑布（只接自己的 agent）
```

卡片引擎二选一（`cardEngine` 配置，默认 `cardkit`）：

- **`cardkit`（默认）**：卡片 JSON 2.0 打字机流式——`cardkit_create` 建实体 →
  `batch_update` 面板结构更新 → `stream_element` 单元素打字机 → 完成时
  `close_streaming` + 全量终态卡；按钮经 `behaviors[].type=callback` 触发与
  v1 相同的 `card.action.trigger` 回调（已对照官方文档并真机验证）。需要
  应用支持卡片 2.0 流式（「扫码一键创建」的应用默认支持；旧应用不支持时
  显式配置 `cardEngine: 'v1'` 回退）
- **`v1`**：`im.v1.message.patch` 全卡节流合并更新——兼容性兜底

- `src/transport.ts` — Lark 传输层（`WSClient` 长连接 + `Client` REST + `registerApp` 扫码配对 + CardKit API）
- `src/bridge.ts` — 编排：消息→会话投递、session 事件→卡片折叠、审批/停止/详情/会话切换按钮路由、白名单
- `src/cards.ts` — v1 卡片构建 + 节流合并的流式 patch 管线（`CardStream` 接口定义）
- `src/streaming/` — CardKit 2.0 引擎：`cardkit-builder.ts`（schema 2.0 构建）+ `cardkit-manager.ts`（流式生命周期）
- `src/redact.ts` / `src/cardmd.ts` / `src/i18n.ts` / `src/tools.ts` — 脱敏、markdown 优化、双语文案、工具描述符
- `src/session-map.ts` — 会话绑定与凭据的原子持久化（写临时文件 + rename）
- `src/index.ts` — cordis 入口（`name`/`inject`/`Config`/`apply`）+ `/feishu` 命令

## 安全模型

- **白名单**：默认只服务扫码创建者（`allowedUsers` 配置可扩展）；飞书侧按钮回调同样校验操作者 open_id
- **审批不会自动通过**：bridge 只回答自己创建的 agent 的 `approval/request`，其余 `next()` 下放给 TUI 自己的审批面板；无应答者时宿主按 fail-closed 处理
- **凭据不落浏览器**：App Secret 只存在本机文件（0600，尽力而为）；二维码链接一次性、10 分钟过期
- **工具详情脱敏**：工具参数/结果在上卡前经过脱敏（`key=secret`、`Authorization` 头、`--flag secret`、路径只留 basename），凭证不会出现在流式卡片或审批卡片上
- **消息删除/撤回守卫**：patch 命中删除/撤回错误码后立即退休该卡片并转纯文本兜底，不会对不存在的消息无限重试
- v1 只服务**私聊**；群消息静默忽略

## 配置项

| 键 | 说明 | 默认 |
|---|---|---|
| `appId` / `appSecret` | 飞书应用凭据 | 读 env 或凭据文件 |
| `defaultCwd` | 新会话的工作目录 | 进程 cwd |
| `dataDir` | 状态目录 | `$DSH_HOME/dsh-tui-feishu` |
| `provider` / `model` | 桥接 agent 的模型路由 | 宿主默认 |
| `cardThrottleMs` | 卡片 patch 节流 | 500 |
| `cardTtlMs` | 无更新自动退休流式卡片的时长（ms） | 900000（15 分钟） |
| `locale` | 卡片文案语言 `zh` / `en` | `zh` |
| `resolveImages` | 回合结束时把答案里的远程图片上传为飞书 img_key | `true` |
| `receiveImages` | 接收飞书发来的图片：下载后经宿主附件服务以 ImageBlock 投递给 agent（无附件服务时降级为存文件并附路径） | `true` |
| `receiveFiles` | 接收飞书发来的文件：下载后按魔数识别类型保存并投递路径 | `true` |
| `replyReference` | 引用/回复消息时拉取被引用内容，以 `<dsh_im_reply_to>` 注入回合（清洗+防注入+失败不阻断） | `true` |
| `imageFileFallback` | 当前模型不支持图片输入时，图片自动降级为落盘+工具识图指引（fail-open） | `true` |
| `outboundFiles` | 允许 agent 用 `dsh_im_return_file` 把文件发回聊天（host 无 tools 注册时自动降级） | `true` |
| `cardEngine` | 卡片引擎：`cardkit`（CardKit 2.0 打字机流式，默认；需应用支持卡片 2.0）或 `v1`（message.patch 兼容兜底） | `cardkit` |
| `showReasoning` | 是否在卡片上展示思考过程行 | `true` |
| `allowedUsers` | 允许的 sender open_id 白名单 | 扫码创建者 |

## 飞书端命令

在与机器人的私聊里发送：

| 命令 | 作用 |
|---|---|
| `/new` | 开新会话（旧会话留在列表里可切回） |
| `/sessions` | 列出本聊天的所有会话（当前 ✅，带标题） |
| `/switch <序号>` | 切换到列表中第 n 个会话 |
| `/rename <新名字>` | 给当前会话改名；`/rename <序号> <新名字>` 改指定会话 |
| `/delete <序号>` | 忘掉第 n 个会话（磁盘历史保留） |
| `/model` | 查看当前模型路由 + 所有 provider 的全部可用模型 |
| `/model <model>` 或 `/model <provider>/<model>` | 切换模型（下一步生效，持久化） |
| `/effort` | 查看当前思考强度 |
| `/effort <id>` / `/effort off` | 设置 / 恢复默认思考强度 |
| `/status` | 桥接状态、当前会话、工作目录 |
| `/remind 10m 喝水` | 一次性提醒（s/m/h/d，最长 7 天） |
| `/remind 09:00 站会` | 每天定时提醒（重启不丢） |
| `/reminders` / `/unremind <序号>` | 查看 / 取消提醒 |
| `/help` | 全部命令一览 |

回合卡片上的按钮：⏹ Stop 中断当前回合；🔍 详情 展开/收起工具调用的参数和结果（回合结束后也能展开）；🔐 审批卡片 Allow/Reject 放行或拒绝危险操作；🗂 会话列表卡片上每个会话一个「切换到 N」按钮。

## 文件与图片

**入站文件**（飞书 → agent）：私聊发文件（PDF/Word/Excel/文本等），桥接下载原始字节并按魔数识别类型保存到 `$DSH_HOME/dsh-tui-feishu/files/`，把路径投递给 agent 读取/解析。只接受公开文本或可用工具解析的格式；`receiveFiles` 默认开。

**入站图片**（飞书 → agent）：私聊发图片，桥接下载原图并经宿主附件服务以 ImageBlock 投递给 agent（视觉模型可直接看图）；附件服务不可用时降级为保存文件并附路径。需要配对应用具备 `im:resource` 权限（v0.3.0 新建的应用已包含；旧应用在飞书开发者后台开通并发布版本）。`imageFileFallback`（默认开）：当前会话模型不支持图片输入时，自动改为"落盘 + 工具识图指引"的纯文本回合并提示可 `/model` 切换。

**引用回复**（飞书 → agent）：引用/回复某条消息提问时，`replyReference`（默认开）拉取被引用内容，经入站清洗（终端转义/控制字符/双向符剥离、码点截断、防标签逃逸）后以 `<dsh_im_reply_to>` 注入本回合；被引用内容是数据不是指令，永远不会触发命令；拉取失败不阻断提问。

**出站文件**（agent → 飞书）：`outboundFiles`（默认开）给 agent 注册 `dsh_im_return_file(path, caption?)` 工具——把工作区文件（≤30MB，doc/pdf/xls/ppt/mp4 等）上传并发回当前聊天，用户可直接下载。host 未暴露工具注册时自动降级并在 `/status` 标注。

**出站图片**（agent → 飞书）：`resolveImages`（默认开）在回合结束时把回复里的远程图片下载并上传为飞书 `img_key`，卡片上直接显示。

## 命令补充

- `/repair` — 权限自检：探测 `im:chat` / `im:resource`，缺权限时给出补全步骤（开发者后台 → 权限管理 → 发布 → 重新配对）。
- `/history [n]` — 回放最近对话（进程内保留 50 条，重启清空）。
- `/compact` — 压缩当前会话（宿主无 `compaction` 服务时提示不支持）。

## 连接自愈（watchdog）

桥每 60s 检查长连接健康：连接持续 error/reconnecting 或静默（无任何入站消息）超过 10 分钟时，自动全量重连长连接并记日志；`/status` 可查连接状态。进程内生效，不需要外部守护脚本。

## 未做（路线图）

群聊 @ 路由、物理删除会话磁盘历史（`/delete` 只从会话列表移除，磁盘日志保留）——参考实现 PGZXB/dsh-feishu 里都有成熟做法，按需要移植。

## 已知限制

- CardKit 工具面板最多展示最近 30 步工具调用（标题带总数，早期步骤折叠）——超长回合的拆卡机制在路线图中。
- footer 仅展示耗时/模型：dsh 宿主事件不带 tokens/context 元数据。
- 模型需支持视觉才能"看懂"入站图片（v0.3.0 起推荐 `deepseek-v4-flash-vision-exp`）。

## 许可

MIT。包含 PGZXB/dsh-feishu（MIT）的重构代码；飞书侧逻辑基于 `@larksuiteoapi/node-sdk`（MIT）。
