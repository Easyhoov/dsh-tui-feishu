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
dsh plugin --profile dsh-tui add file:dsh-tui-feishu-0.1.0.tgz
```

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

手动配置时需要应用已具备：`im:message`、`im:message:send_as_bot`、`im:chat` 权限，事件订阅 `im.message.receive_v1`（长连接模式），卡片回调 `card.action.trigger`。

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
流式卡片 <── message.patch ── StreamingCardManager <── session/event 流（chunk/tool/turn/end）
审批卡片 <── Allow/Reject 按钮 ── approval/request 瀑布（只接自己的 agent）
```

- `src/transport.ts` — Lark 传输层（`WSClient` 长连接 + `Client` REST + `registerApp` 扫码配对）
- `src/bridge.ts` — 编排：消息→会话投递、session 事件→卡片折叠、审批/停止按钮路由、白名单
- `src/cards.ts` — v1 卡片 JSON 构建 + 节流合并的流式 patch 管线
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

回合卡片上的按钮：⏹ Stop 中断当前回合；🔍 详情 展开/收起工具调用的参数和结果（回合结束后也能展开）；🔐 审批卡片 Allow/Reject 放行或拒绝危险操作。

## 未做（路线图）

群聊 @ 路由、会话列表卡片化（目前是文本列表）、物理删除会话磁盘历史——参考实现 PGZXB/dsh-feishu 里都有成熟做法，按需要移植。

## 许可

MIT。包含 PGZXB/dsh-feishu（MIT）的重构代码；飞书侧逻辑基于 `@larksuiteoapi/node-sdk`（MIT）。
