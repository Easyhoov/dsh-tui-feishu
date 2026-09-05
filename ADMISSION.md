# dsh-TUI 准入说明（Admission Notes）

对照 [`dsh-TUI Ecosystem Plugin Admission v0.15`](https://github.com/T-Auto/dsh-ecosystem-spec/tree/e1b902b0f95f4280a8e68d414ec7a4d25d6ce106)（基线：Community v0.15 / dsh-std 固定 submodule）逐条说明本插件的合规方式。

## TUI-PKG-001 包身份

包根有唯一 `dsh-plugin.json`（manifestVersion `0.15`）。`npm run validate:manifest` 用本仓库 `dsh-ecosystem-spec` 内固定 revision 的 dsh-std Manifest schema + `registry-0.15.json` + `permissions-0.1.json` 做静态校验（CI 可复跑）。本源码树不做 Verified 声明；发布 artifact 的 SHA-256 digest 应在发版时生成并绑定。

## TUI-PKG-002 声明闭包

清单静态声明了全部入口：

- **requires**：`commands.dsh/v1alpha1` `Command`（注册 `/feishu` 状态与配对命令，TUI 可直接解析）。
- **permissions**：`commands.invoke`（/feishu 命令）、`storage.local.read`/`storage.local.write`（插件命名空间 `$DSH_HOME/dsh-tui-feishu/`）、`messages.observe.read`（仅本桥接拥有的会话）。未声明任何 `*.intercept` 权限——本插件不拦截用户输入/回退/切换/压缩；唯一输入消费点是「有未决 ask_user_question 问卷时，把下一条文字当作问卷回答」（问卷卡上已明示此行为，等同 TUI 面板打字即答语义）。
- **contributes**：一个命令 `io.github.fusu123fusu.dsh-tui-feishu.status`。
- **overrides**：Community 契约之外的框架面（agents、session/event、approval/request、
  userQuestions 单席位交接、agentPresets/agentDefaultModel 软探测）与网络面集中记录在
  `x-ccch1mneyyy.tui.host-services` 一条 override 里，无旁路注入。

## TUI-HOST-001 宿主描述符

宿主侧职责（dsh-TUI profile 提供 host descriptor），插件侧只消费 `ctx.get(...)` 软探测到的服务，不因包已安装而假定 live support——每个服务调用前都判空，缺失时降级（见下）。

## TUI-RUN-001 远程确定性

不假定运行机器有浏览器或 GUI：

- 无凭据时插件退化为 `/feishu` 说明命令；
- `/feishu pair` 尝试打开系统浏览器只是 best-effort，失败时把一次性配对链接作为命令结果文本返回，用户可手动打开；
- 运行期全部输出走飞书长连接与日志文件，不依赖任何 TUI 呈现组件，也不要求 Presentation 客户端；
- 不把 remote/local 或 Presentation 保存为 activation 全局状态；无 remote-attach 声明。

## TUI-OBS-001 归属与清理

所有运行时 effect 归属本次 cordis 激活，deactivate 时全部回收：

- `/feishu` 命令注册（`ctx.effect` 包裹）；
- `session/event` 监听器、`approval/request` 瀑布应答器（外源 agent 一律 `next()` 下放）；
- userQuestions 单席位租约（`installUserQuestionsProvider`：结构捕获 incumbent →
  替换 `service.provider` → 桥停用时原样归还；未决 `ask_user_question` 批全部以
  `ASK_ABORTED` 拒绝，卡片灰化收尾）；
- 飞书 WebSocket 长连接（`transport.stop()`）；
- 流式卡片节流定时器（card manager `dispose()`）；
- 提醒定时器（ReminderStore `dispose()`）；
- 未决审批全部以 `cancelled` 落槌，session map 落盘。

持久状态目录 `$DSH_HOME/dsh-tui-feishu/`：`credentials.json`（0600 尽力而为）、`session-map.json`、`reminders.json`、`bridge.log`（256KB 轮转）。全部写入为 tmp+rename 原子提交；卸载即删该目录。

## TUI-DEP-001 依赖闭包

`npm run verify` = 构建（tsc）+ 清单校验 + 测试（node:test 各套件，fake transport/agent
端到端覆盖消息流、审批、ask_user_question 问卷卡、详情展开、提醒触发）。运行时依赖只有
一个：`@larksuiteoapi/node-sdk`（MIT，官方）；框架包以 peerDependencies 声明由宿主提供。
无 native/build step、无 override 依赖替换。`user-questions` 面不 import
`@deepseek-ai/dsh-user-questions`（结构性子集 + 软探测），宿主缺该服务时降级为「不支持
飞书答题」并告警，不影响桥其他能力。

## TUI-TRUST-001 信任披露

本插件运行于 `trusted-in-process`。清单中的 permission 仅作兼容性、授权提示与审计元数据，不构成 OS/进程/realm 安全边界。市场与安装界面应明确展示这一点。

## 隐私

插件在飞书开放平台与本地 agent 之间双向搬运聊天内容——这就是功能本身。App Secret 只写本机 `credentials.json`，只发往飞书令牌交换。入站消息与卡片按钮均校验 sender/operator open_id 白名单（默认仅扫码创建者）。
