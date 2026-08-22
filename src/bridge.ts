/**
 * The bridge orchestrator: Feishu chats ↔ dsh agent sessions.
 *
 * Inbound Feishu messages are delivered into a per-chat dsh session
 * (`agent.followup`); dsh session events stream back into the chat as one
 * live streaming card per turn (the card is patched in place - silent, no
 * unread notification). Approval requests for the bridge's own agents
 * become Allow/Reject cards; the Stop button cancels the running turn.
 *
 * The bridge never touches agent internals beyond the public surface:
 * create/resume, followup, cancel, and the `session/event` stream.
 *
 * Refactored from PGZXB/dsh-feishu (MIT), scoped to the p2p chat loop.
 *
 * @module dsh-tui-feishu/bridge
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { CardFooter, CardRow, CardSnapshot, CardStatus, CardStream } from './cards.js'
import { stripReasoningTags } from './cardmd.js'
import { parseReminderTime, describeReminder, type Reminder, type ReminderStore } from './reminders.js'
import { redactInlineSecrets, sanitizeToolDetail } from './redact.js'
import { resolveToolDescriptor } from './tools.js'
import type { FeishuCardAction, FeishuMessage, LarkTransport } from './transport.js'
import type { SessionMap } from './session-map.js'

/** Minimal logger surface the bridge needs. */
export interface BridgeLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** A chat's pinned model preferences, applied at create/resume time. */
export interface SessionPrefs {
  readonly route?: { readonly provider: string; readonly model: string }
  readonly effort?: string
}

/** Adapts the dsh agent registry to the bridge's needs (injectable for tests). */
export interface AgentStore {
  /** The live agent for a session, or `undefined`. */
  get(sessionId: string): Agent | undefined
  /** Resume an agent on a persisted session (daemon restart); throws when no log exists. */
  resume(sessionId: string, prefs?: SessionPrefs): Promise<Agent>
  /** Create an agent (and its session) for the given id and working directory. */
  create(sessionId: string, cwd: string, prefs?: SessionPrefs): Promise<Agent>
}

/** The approval settlement union (structural subset of dsh's ApprovalOutcome). */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** Structural subset of dsh's approval request (kept local for loose coupling). */
export interface ApprovalRequestLike {
  readonly agent: { readonly id: unknown }
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

/** A chat's effective model route, for /model status and switching. */
export interface ChatRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Model/effort control for one chat's session (host-provided; optional). */
export interface ModelControl {
  /** The chat's effective route: live selection, else pinned route, else host default. */
  get(chatId: string): ChatRoute | undefined
  /** Pin a route for the chat; applies to the live agent from the next step and persists for resume. */
  setModel(chatId: string, provider: string, model: string): Promise<void>
  /** Pin or clear (`undefined`) the reasoning effort; same application rules. */
  setEffort(chatId: string, effort: string | undefined): Promise<void>
  /** Every provider's advertised models, or `undefined` when the host cannot list. */
  listAll?(): Promise<readonly { provider: string; models: readonly string[] }[] | undefined>
}

/** Bridge options. */
export interface BridgeOptions {
  readonly transport: LarkTransport
  readonly sessionMap: SessionMap
  readonly agentStore: AgentStore
  readonly cards: CardStream
  readonly logger: BridgeLogger
  /** Working directory for newly created sessions. */
  readonly defaultCwd: string
  /** Allowed sender open ids; when empty, every p2p sender is served. */
  readonly allowedUsers?: readonly string[]
  /** Model/effort switching for /model and /effort; absent disables both commands. */
  readonly modelControl?: ModelControl
  /** Scheduled reminders backing /remind, /reminders, /unremind. */
  readonly reminders?: ReminderStore
  /** Resolve remote answer images to Feishu keys at turn end (default true). */
  readonly resolveImages?: boolean
  /** Render reasoning/thinking rows on cards (default true). */
  readonly showReasoning?: boolean
}

/** One chat's live turn-card state (bridge-owned). */
interface TurnState {
  title: string
  content: string
  rows: CardRow[]
  openThink: boolean
  expanded: boolean
  sessionId: string
  /** Epoch ms when the turn's card was opened (footer elapsed). */
  startedAt: number
  /** Tool-call start times by call id (row duration). */
  toolStarts: Map<string, number>
}

/** A pending approval card. */
interface PendingApproval {
  readonly chatId: string
  readonly messageId: string
  readonly request: ApprovalRequestLike
  resolve: (outcome: ApprovalOutcome) => void
  settled: boolean
}

/** Cap the in-memory dedup window (Feishu redelivers on reconnect). */
const DEDUP_MAX = 512
/** Card title cut-off. */
const TITLE_CHARS = 28

/** Cap how many remote images one turn resolves (upload is slow). */
const MAX_RESOLVED_IMAGES = 6

/**
 * Replace remote image references in answer markdown with Feishu `img_key`s
 * (download → upload). Failures keep the original URL. Only non-`img_` refs
 * are touched.
 */
async function resolveContentImages(
  content: string,
  transport: LarkTransport,
  logger: BridgeLogger,
): Promise<string> {
  if (!content.includes('![')) return content
  const refs = [...content.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)].slice(0, MAX_RESOLVED_IMAGES)
  if (refs.length === 0) return content
  let result = content
  for (const match of refs) {
    const url = match[2]
    if (url === undefined || url.startsWith('img_')) continue
    try {
      const key = await transport.uploadImage(url)
      if (key !== undefined && key !== '') {
        result = result.replace(match[0], `![${match[1] ?? ''}](${key})`)
      }
    } catch (error: unknown) {
      logger.warn(`image resolution failed (keeping URL): ${String(error)}`)
    }
  }
  return result
}

/** Extract visible text from assistant message content blocks. */
function assistantText(content: readonly unknown[] | undefined): string {
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (
      block !== null &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text'
    ) {
      const blockText = (block as { text?: unknown }).text
      if (typeof blockText === 'string') text += blockText
    }
  }
  return text
}

/** Cap captured tool detail (the full I/O lives on the host). */
const DETAIL_CAPTURE_CHARS = 1000

/** Extract readable text from a tool-result message's content blocks. */
function extractResultText(message: unknown): string {
  if (message === null || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const record = block as Record<string, unknown>
    let picked = false
    for (const key of ['text', 'output', 'result']) {
      const value = record[key]
      if (typeof value === 'string') {
        parts.push(value)
        picked = true
        break
      }
    }
    if (!picked && Array.isArray(record['content'])) {
      for (const inner of record['content'] as unknown[]) {
        const text = (inner as { text?: unknown } | null)?.text
        if (typeof text === 'string') parts.push(text)
      }
    }
  }
  return parts.join('\n')
}

/** One-line summary of a tool call for the activity rows. */
export function toolRowSummary(name: string, argsJson: string): string {
  const sanitizer = resolveToolDescriptor(name)?.sanitizer
  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>
    for (const key of ['command', 'path', 'file_path', 'pattern', 'query', 'url', 'description']) {
      const value = args[key]
      if (typeof value === 'string' && value.trim() !== '') {
        // The summary is the first thing anyone sees: sanitize it like the
        // tool's detail so credentials never make it onto the card.
        return truncateSummary(sanitizeToolDetail(value, sanitizer) ?? redactInlineSecrets(value))
      }
    }
    const first = Object.values(args).find(value => typeof value === 'string')
    if (typeof first === 'string') {
      return truncateSummary(sanitizeToolDetail(first, sanitizer) ?? redactInlineSecrets(first))
    }
  } catch {
    // Non-JSON or absent arguments - the bare tool name says enough.
  }
  return ''
}

/** Cap a one-line summary at a readable length. */
function truncateSummary(text: string): string {
  return text.length > 72 ? `${text.slice(0, 72)}…` : text
}

/**
 * The Feishu↔dsh bridge.
 */
export class Bridge {
  private readonly seen = new Set<string>()
  private readonly turns = new Map<string, TurnState>()
  /** Titles of messages queued while a chat's turn was still running. */
  private readonly queuedTurns = new Map<string, string[]>()
  /** Final snapshots per chat, so the detail toggle works on finished cards. */
  private readonly lastSnapshots = new Map<string, CardSnapshot>()
  private readonly approvals = new Map<string, PendingApproval>()
  private readonly turnDisposers: (() => void)[] = []
  private readonly counters = { received: 0, delivered: 0, dropped: 0 }

  constructor(private readonly options: BridgeOptions) {}

  /** Inbound-message counters for the /feishu status surface. */
  stats(): { received: number; delivered: number; dropped: number } {
    return { ...this.counters }
  }

  /** Wire transport handlers; call after `transport.start()`. */
  start(): void {
    this.options.transport.onMessage(message => {
      void this.handleIncoming(message).catch((error: unknown) => {
        this.options.logger.error(`inbound message failed: ${String(error)}`)
      })
    })
    this.options.transport.onCardAction(action => {
      void this.handleCardAction(action).catch((error: unknown) => {
        this.options.logger.error(`card action failed: ${String(error)}`)
      })
    })
  }

  /** Subscribe to session events (the host owns the actual cordis listener). */
  bindSessionEvents(
    subscribe: (listener: (sessionId: string, event: SessionEvent) => void) => () => void,
  ): void {
    this.turnDisposers.push(
      subscribe((sessionId, event) => {
        void this.handleSessionEvent(sessionId, event).catch((error: unknown) => {
          this.options.logger.error(`session event render failed: ${String(error)}`)
        })
      }),
    )
  }

  /** Tear the bridge down: settle approvals as cancelled, drop listeners. */
  async dispose(): Promise<void> {
    for (const dispose of this.turnDisposers.splice(0)) dispose()
    for (const pending of this.approvals.values()) {
      if (!pending.settled) pending.resolve('cancelled')
    }
    this.approvals.clear()
    this.queuedTurns.clear()
    this.options.cards.dispose()
  }

  /** Whether a sender may drive the bridge. */
  private senderAllowed(senderOpenId: string): boolean {
    const allow = this.options.allowedUsers ?? []
    return allow.length === 0 || allow.includes(senderOpenId)
  }

  private dedupe(messageId: string): boolean {
    if (this.seen.has(messageId)) return false
    this.seen.add(messageId)
    if (this.seen.size > DEDUP_MAX) {
      // Set iteration order is insertion order: drop the oldest half.
      const drop = Math.floor(DEDUP_MAX / 2)
      let i = 0
      for (const id of this.seen) {
        this.seen.delete(id)
        if (++i >= drop) break
      }
    }
    return true
  }

  private async handleIncoming(message: FeishuMessage): Promise<void> {
    this.counters.received += 1
    if (!this.dedupe(message.messageId)) {
      this.counters.dropped += 1
      this.options.logger.info(`duplicate message ${message.messageId} dropped`)
      return
    }
    if (message.chatType === 'group') {
      this.counters.dropped += 1
      this.options.logger.info(`group message from ${message.senderOpenId} ignored (p2p only)`)
      return
    }
    if (!this.senderAllowed(message.senderOpenId)) {
      this.counters.dropped += 1
      this.options.logger.warn(`ignoring message from unauthorized sender ${message.senderOpenId}`)
      return
    }
    const text = message.text.trim()
    if (text === '') {
      this.counters.dropped += 1
      return
    }
    this.counters.delivered += 1
    if (text.startsWith('/')) {
      await this.handleCommand(message.chatId, text)
      return
    }
    await this.deliver(message.chatId, text)
  }

  private async handleCommand(chatId: string, line: string): Promise<void> {
    const command = line.slice(1).split(/\s+/)[0]
    const rest = line.slice(1 + (command?.length ?? 0)).trim()
    switch (command) {
      case 'new': {
        await this.abandonActiveTurn(chatId)
        this.options.sessionMap.remint(chatId)
        await this.options.sessionMap.persist()
        await this.options.transport.sendText(chatId, '🆕 已开新会话——旧会话还在列表里，/sessions 查看、/switch <序号> 切回。')
        break
      }
      case 'status': {
        const binding = this.options.sessionMap.get(chatId)
        const transport = this.options.transport
        await transport.sendText(
          chatId,
          [
            `🟢 dsh-TUI 飞书桥`,
            `- 连接状态：${transport.connectionState()}`,
            `- 当前会话：${binding === undefined ? '还没有（发条消息就开始了）' : binding.sessionId}`,
            `- 工作目录：${binding?.cwd ?? this.options.defaultCwd}`,
            `- 已绑定聊天数：${this.options.sessionMap.size}`,
            '- 命令一览：/help',
          ].join('\n'),
        )
        break
      }
      case 'sessions': {
        await this.handleSessionsCommand(chatId)
        break
      }
      case 'switch':
      case 'use': {
        await this.handleSwitchCommand(chatId, rest)
        break
      }
      case 'rename': {
        await this.handleRenameCommand(chatId, rest)
        break
      }
      case 'delete':
      case 'drop': {
        await this.handleDeleteCommand(chatId, rest)
        break
      }
      case 'model': {
        await this.handleModelCommand(chatId, rest)
        break
      }
      case 'effort': {
        await this.handleEffortCommand(chatId, rest)
        break
      }
      case 'remind': {
        await this.handleRemindCommand(chatId, rest)
        break
      }
      case 'reminders': {
        await this.handleRemindersCommand(chatId)
        break
      }
      case 'unremind':
      case 'delremind': {
        await this.handleUnremindCommand(chatId, rest)
        break
      }
      case 'help': {
        await this.options.transport.sendText(
          chatId,
          [
            '💬 直接发消息即可与你电脑上的 dsh agent 对话。',
            '会话：',
            '- /new - 开新会话（旧会话保留，可切回）',
            '- /sessions - 列出本聊天的所有会话（当前 ✅）',
            '- /switch <序号> - 切换到指定会话',
            '- /rename <新名字> - 给当前会话改名（/rename <序号> <新名字> 改指定会话）',
            '- /delete <序号> - 忘掉指定会话（磁盘历史保留）',
            '模型：',
            '- /model - 查看当前模型和全部可用模型',
            '- /model <模型> 或 /model <provider>/<模型> - 切换模型',
            '- /effort [强度 | off] - 查看 / 设置 / 恢复默认思考强度',
            '提醒：',
            '- /remind 10m 喝水 - 一次性提醒（支持 s/m/h/d，最长 7 天）',
            '- /remind 09:00 站会 - 每天定时提醒',
            '- /reminders - 查看提醒列表，/unremind <序号> 取消',
            '运行中：',
            '- 回复卡片上有 ⏹ Stop 按钮可中断，🔍 详情按钮展开工具参数和结果',
            '- 危险操作会发 🔐 审批卡片，点 Allow/Reject 放行或拒绝',
            '其他：',
            '- /status - 桥接状态、当前会话、工作目录',
          ].join('\n'),
        )
        break
      }
      default: {
        // A bare unknown word is probably a typo'd command; anything with
        // arguments reads as a slash line meant for the model.
        if (/^\/\S+$/.test(line)) {
          await this.options.transport.sendText(chatId, `未知命令 "/${command}"——输入 /help 查看全部命令。`)
        } else {
          await this.deliver(chatId, line)
        }
      }
    }
  }

  /** Best-effort persist of the session map (never breaks a command). */
  private async persistMap(): Promise<void> {
    await this.options.sessionMap.persist().catch((error: unknown) => {
      this.options.logger.warn(`session map persist failed: ${String(error)}`)
    })
  }

  /** `/sessions` — numbered list of this chat's sessions, newest first. */
  private async handleSessionsCommand(chatId: string): Promise<void> {
    const sessions = this.options.sessionMap.list(chatId)
    if (sessions.length === 0) {
      await this.options.transport.sendText(chatId, '还没有会话——随便发条消息就开始了一个。')
      return
    }
    const lines = sessions.map(
      (entry, index) =>
        `${index + 1}. ${entry.active ? '✅' : '　'} ${entry.title ?? '（未命名）'}  · ${entry.sessionId.slice(0, 8)}`,
    )
    // Interactive card: one switch button per session (cap 8 rows keeps the
    // card within element limits); rename/delete stay text commands.
    const buttons = sessions.slice(0, 8).map((entry, index) => ({
      tag: 'button',
      text: { tag: 'plain_text', content: `切换到 ${index + 1}` },
      type: entry.active ? 'primary' : 'default',
      value: { kind: 'session', action: 'switch', n: String(index + 1) },
    }))
    const elements: Record<string, unknown>[] = [
      { tag: 'markdown', content: [`🗂 会话列表（最新在前）：`, ...lines].join('\n') },
    ]
    if (buttons.length > 0) elements.push({ tag: 'action', actions: buttons })
    try {
      await this.options.transport.sendCard(chatId, {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: '🗂 会话列表' }, template: 'blue' },
        elements,
      })
    } catch (error: unknown) {
      this.options.logger.warn(`sessions card failed (falling back to text): ${String(error)}`)
      await this.options.transport.sendText(chatId, [...lines, '- /switch <序号> 切换 · /rename <序号> <名字> 改名 · /delete <序号> 删除'].join('\n'))
    }
  }

  /**
   * Abandon the chat's live turn when the binding is switched away (/new,
   * /switch, /delete of the active session): cancel the agent, close the
   * card as stopped, drop queued titles. Without this the orphaned turn
   * state would send every later message into the queue forever.
   */
  private async abandonActiveTurn(chatId: string): Promise<void> {
    const turn = this.turns.get(chatId)
    if (turn === undefined) return
    this.turns.delete(chatId)
    this.queuedTurns.delete(chatId)
    this.lastSnapshots.set(chatId, {
      title: turn.title,
      content: turn.content,
      rows: turn.rows,
      status: 'stopped',
      expanded: turn.expanded,
    })
    this.options.agentStore.get(turn.sessionId)?.cancel({ kind: 'user' })
    await this.options.cards.finalize(chatId, 'stopped').catch(() => {})
  }

  /** `/switch <n>` — make the n-th listed session active. */
  private async handleSwitchCommand(chatId: string, arg: string): Promise<void> {
    const sessions = this.options.sessionMap.list(chatId)
    const index = Number.parseInt(arg, 10) - 1
    const target = Number.isInteger(index) ? sessions[index] : undefined
    if (target === undefined) {
      await this.options.transport.sendText(chatId, '⚠️ 用法：/switch <序号>——序号见 /sessions。')
      return
    }
    if (!this.options.sessionMap.switchTo(chatId, target.sessionId)) {
      await this.options.transport.sendText(chatId, '⚠️ 这个会话已经不在了——重新 /sessions 看看。')
      return
    }
    await this.abandonActiveTurn(chatId)
    await this.persistMap()
    await this.options.transport.sendText(
      chatId,
      `🔀 已切换到：${target.title ?? target.sessionId.slice(0, 8)}——下一条消息接着它聊。`,
    )
  }

  /** `/rename [n] <name>` — rename the active session, or the n-th one. */
  private async handleRenameCommand(chatId: string, arg: string): Promise<void> {
    if (arg === '') {
      await this.options.transport.sendText(chatId, '⚠️ 用法：/rename <新名字>（改当前会话），或 /rename <序号> <新名字>。')
      return
    }
    const numbered = /^(\d+)\s+(.+)$/.exec(arg)
    let sessionId: string | undefined
    let name: string
    if (numbered !== null) {
      const target = this.options.sessionMap.list(chatId)[Number.parseInt(numbered[1] ?? '', 10) - 1]
      if (target === undefined) {
        await this.options.transport.sendText(chatId, '⚠️ 序号超出范围——/sessions 查看列表。')
        return
      }
      sessionId = target.sessionId
      name = (numbered[2] ?? '').trim()
    } else {
      sessionId = this.options.sessionMap.get(chatId)?.sessionId
      if (sessionId === undefined) {
        await this.options.transport.sendText(chatId, '⚠️ 还没有会话——先发条消息再改名。')
        return
      }
      name = arg
    }
    if (name === '') {
      await this.options.transport.sendText(chatId, '⚠️ 名字不能为空。')
      return
    }
    const finalName = name.length > 40 ? `${name.slice(0, 40)}…` : name
    if (!this.options.sessionMap.rename(chatId, sessionId, finalName)) {
      await this.options.transport.sendText(chatId, '⚠️ 改名失败——会话已经不在了。')
      return
    }
    await this.persistMap()
    await this.options.transport.sendText(chatId, `✏️ 已命名为：${finalName}`)
  }

  /** `/delete <n>` — forget the n-th listed session (disk log is kept). */
  private async handleDeleteCommand(chatId: string, arg: string): Promise<void> {
    const sessions = this.options.sessionMap.list(chatId)
    const index = Number.parseInt(arg, 10) - 1
    const target = Number.isInteger(index) ? sessions[index] : undefined
    if (target === undefined) {
      await this.options.transport.sendText(chatId, '⚠️ 用法：/delete <序号>——序号见 /sessions。')
      return
    }
    if (target.active) await this.abandonActiveTurn(chatId)
    const outcome = this.options.sessionMap.remove(chatId, target.sessionId)
    await this.persistMap()
    const label = target.title ?? target.sessionId.slice(0, 8)
    const note =
      outcome === 'activated-successor'
        ? '已自动切到最近一个剩下的会话。'
        : outcome === 'unbound'
          ? '列表空了——下一条消息会开新会话。'
          : ''
    await this.options.transport.sendText(chatId, `🗑 已忘掉：${label}。${note}（磁盘上的历史保留）`)
  }

  /** `/remind <time> <text>` — arm a one-shot or daily reminder. */
  private async handleRemindCommand(chatId: string, arg: string): Promise<void> {
    const store = this.options.reminders
    if (store === undefined) {
      await this.options.transport.sendText(chatId, '⚠️ 当前宿主不支持定时提醒。')
      return
    }
    const parts = /^(\S+)\s+(.+)$/s.exec(arg)
    if (parts === null) {
      await this.options.transport.sendText(
        chatId,
        '⚠️ 用法：/remind <时间> <内容>——如 /remind 10m 喝水（s/m/h/d），/remind 09:00 站会（每天）。',
      )
      return
    }
    const time = parseReminderTime(parts[1] ?? '')
    if (time === undefined) {
      await this.options.transport.sendText(chatId, '⚠️ 时间格式不对——支持 10s/5m/2h/1d（最长 7 天）或 HH:MM（每天）。')
      return
    }
    const text = (parts[2] ?? '').trim()
    if (text === '') {
      await this.options.transport.sendText(chatId, '⚠️ 提醒内容不能为空。')
      return
    }
    const reminder = store.add(chatId, text.length > 200 ? text.slice(0, 200) : text, time)
    await this.options.transport.sendText(chatId, `⏰ 已设定：${describeReminder(reminder)}——「${reminder.text}」`)
  }

  /** `/reminders` — list this chat's armed reminders. */
  private async handleRemindersCommand(chatId: string): Promise<void> {
    const store = this.options.reminders
    if (store === undefined) {
      await this.options.transport.sendText(chatId, '⚠️ 当前宿主不支持定时提醒。')
      return
    }
    const list = store.list(chatId)
    if (list.length === 0) {
      await this.options.transport.sendText(chatId, '没有进行中的提醒——/remind 10m 喝水 试试。')
      return
    }
    const lines = list.map((reminder, index) => `${index + 1}. ${describeReminder(reminder)} — ${reminder.text}`)
    await this.options.transport.sendText(chatId, ['⏰ 提醒列表：', ...lines, '- /unremind <序号> 取消'].join('\n'))
  }

  /** `/unremind <n>` — cancel the n-th reminder. */
  private async handleUnremindCommand(chatId: string, arg: string): Promise<void> {
    const store = this.options.reminders
    if (store === undefined) {
      await this.options.transport.sendText(chatId, '⚠️ 当前宿主不支持定时提醒。')
      return
    }
    const removed = store.removeAt(chatId, Number.parseInt(arg, 10))
    if (removed === undefined) {
      await this.options.transport.sendText(chatId, '⚠️ 用法：/unremind <序号>——序号见 /reminders。')
      return
    }
    await this.options.transport.sendText(chatId, `🗑 已取消提醒：「${removed.text}」`)
  }

  /** ReminderStore callback: deliver the reminder as a normal agent turn. */
  fireReminder(reminder: Reminder): void {
    void this.deliver(reminder.chatId, `⏰ 定时提醒：${reminder.text}`).catch((error: unknown) => {
      this.options.logger.error(`reminder delivery failed: ${String(error)}`)
    })
  }

  /** `/model` — show the effective route, or pin a new one for this chat. */
  private async handleModelCommand(chatId: string, arg: string): Promise<void> {
    const control = this.options.modelControl
    if (control === undefined) {
      await this.options.transport.sendText(chatId, '⚠️ 当前宿主不支持切换模型。')
      return
    }
    const current = control.get(chatId)
    const describe = (route: ChatRoute | undefined): string =>
      route === undefined
        ? '宿主默认'
        : `${route.provider}/${route.model}${route.reasoningEffort === undefined ? '' : `（强度 ${route.reasoningEffort}）`}`
    if (arg === '') {
      const lines = [`🧭 当前模型：${describe(current)}`, '- 切换：/model <模型> 或 /model <provider>/<模型>']
      const all = await control.listAll?.().catch(() => undefined)
      if (all !== undefined && all.length > 0) {
        lines.push('- 可用模型：')
        let shown = 0
        for (const group of all) {
          for (const id of group.models) {
            if (shown >= 40) break
            lines.push(`  · ${group.provider}/${id}`)
            shown += 1
          }
        }
      }
      await this.options.transport.sendText(chatId, lines.join('\n'))
      return
    }
    const slash = arg.indexOf('/')
    const provider = slash >= 0 ? arg.slice(0, slash) : current?.provider
    const model = slash >= 0 ? arg.slice(slash + 1) : arg
    if (provider === undefined || provider === '' || model === '') {
      await this.options.transport.sendText(
        chatId,
        '⚠️ 还不知道当前 provider——先用 /model <provider>/<模型> 完整指定一次。',
      )
      return
    }
    await control.setModel(chatId, provider, model)
    await this.options.transport.sendText(chatId, `✅ 模型已切换：${provider}/${model}（下一步生效）`)
  }

  /** `/effort` — show the pinned reasoning effort, or set/clear it. */
  private async handleEffortCommand(chatId: string, arg: string): Promise<void> {
    const control = this.options.modelControl
    if (control === undefined) {
      await this.options.transport.sendText(chatId, '⚠️ 当前宿主不支持切换思考强度。')
      return
    }
    if (arg === '') {
      const current = control.get(chatId)
      await this.options.transport.sendText(
        chatId,
        `🧠 当前思考强度：${current?.reasoningEffort ?? 'provider 默认'}——/effort <强度> 设置（如 high），/effort off 恢复默认`,
      )
      return
    }
    const effort = arg === 'off' || arg === 'default' ? undefined : arg
    await control.setEffort(chatId, effort)
    await this.options.transport.sendText(
      chatId,
      effort === undefined ? '✅ 已恢复 provider 默认强度' : `✅ 思考强度已设为：${effort}（下一步生效）`,
    )
  }

  /** Resolve (or create) the chat's agent, then deliver one user turn. */
  private async deliver(chatId: string, text: string): Promise<void> {
    const agent = await this.ensureAgent(chatId)
    if (agent === undefined) {
      await this.options.transport.sendText(chatId, '⚠️ 宿主上没有 agent 服务——dsh 是否在运行？')
      return
    }
    const title = text.length > TITLE_CHARS ? `${text.slice(0, TITLE_CHARS)}…` : text
    // A turn is already running: the agent inbox queues the message for the
    // next turn, so queue the title too instead of clobbering the live card.
    if (this.turns.has(chatId)) {
      const queue = this.queuedTurns.get(chatId) ?? []
      queue.push(title)
      this.queuedTurns.set(chatId, queue)
      try {
        agent.followup(
          createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
        )
      } catch (error: unknown) {
        queue.pop()
        this.options.logger.error(`queued followup failed: ${String(error)}`)
        await this.options.transport.sendText(chatId, '⚠️ 消息投递失败——请重发一次。')
        return
      }
      await this.options.transport.sendText(chatId, '⏳ 当前回合还在跑——已排队，结束后自动接着处理。')
      return
    }
    if (this.options.sessionMap.recordTitle(chatId, String(agent.id), title)) {
      await this.persistMap()
    }
    this.turns.set(chatId, {
      title,
      content: '',
      rows: [],
      openThink: false,
      expanded: false,
      sessionId: String(agent.id),
      startedAt: Date.now(),
      toolStarts: new Map(),
    })
    try {
      await this.options.cards.open(chatId, title)
    } catch (error: unknown) {
      this.options.logger.warn(`streaming card open failed: ${String(error)}`)
    }
    try {
      agent.followup(
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        }),
      )
    } catch (error: unknown) {
      this.options.logger.error(`followup failed: ${String(error)}`)
      this.turns.delete(chatId)
      await this.options.cards.finalize(chatId, 'error').catch(() => {})
      await this.options.transport.sendText(chatId, '⚠️ 消息投递失败——请重发一次。')
    }
  }

  /** Live agent for the chat's bound session, resuming or creating as needed. */
  private async ensureAgent(chatId: string): Promise<Agent | undefined> {
    const store = this.options.agentStore
    const map = this.options.sessionMap
    const binding = map.get(chatId)
    if (binding !== undefined) {
      const live = store.get(binding.sessionId)
      if (live !== undefined) return live
      try {
        return await store.resume(binding.sessionId, {
          ...(binding.route === undefined ? {} : { route: binding.route }),
          ...(binding.effort === undefined ? {} : { effort: binding.effort }),
        })
      } catch (error: unknown) {
        this.options.logger.warn(
          `resume of session ${binding.sessionId} failed (${String(error)}); rebinding fresh`,
        )
        map.delete(chatId)
      }
    }
    // remint keeps a previous cwd and pinned route/effort; the map persists
    // after the create resolves.
    const sessionId = map.remint(chatId)
    const fresh = map.get(chatId)
    const cwd = fresh?.cwd ?? this.options.defaultCwd
    this.options.logger.info(`creating session ${sessionId} for chat ${chatId} (cwd ${cwd})`)
    const agent = await store.create(sessionId, cwd, {
      ...(fresh?.route === undefined ? {} : { route: fresh.route }),
      ...(fresh?.effort === undefined ? {} : { effort: fresh.effort }),
    })
    map.set(chatId, String(agent.id), cwd)
    await map.persist().catch((error: unknown) => {
      this.options.logger.warn(`session map persist failed: ${String(error)}`)
    })
    return agent
  }

  /** Fold one session event into the owning chat's streaming card. */
  private async handleSessionEvent(sessionId: string, event: SessionEvent): Promise<void> {
    const chatId = this.options.sessionMap.chatFor(sessionId)
    if (chatId === undefined) {
      this.options.logger.warn(`session event for unknown session ${sessionId} ignored (chatFor miss)`)
      return
    }
    let state = this.turns.get(chatId)
    // Session events carry their payload directly on the event object in
    // dsh-session 0.1.1 (turn/reason at the top level); older builds wrapped
    // it in `data`. Read both shapes.
    const eventRecord = event as { data?: Record<string, unknown>; reason?: unknown } & Record<string, unknown>
    const data = eventRecord.data ?? {}
    const topLevel = (key: string): unknown => eventRecord[key]
    switch (event.type) {
      case 'user/message':
      case 'turn/start': {
        if (state === undefined) {
          // A turn we did not open a card for: either an agent-initiated turn
          // (e.g. a schedule reminder) or a message queued while the previous
          // turn was running - the queued title wins when present.
          const queue = this.queuedTurns.get(chatId)
          const queuedTitle = queue !== undefined && queue.length > 0 ? queue.shift() : undefined
          if (queue !== undefined && queue.length === 0) this.queuedTurns.delete(chatId)
          state = { title: queuedTitle ?? '⏰ Agent', content: '', rows: [], openThink: false, expanded: false, sessionId, startedAt: Date.now(), toolStarts: new Map() }
          this.turns.set(chatId, state)
          try {
            await this.options.cards.open(chatId, state.title)
          } catch (error: unknown) {
            this.options.logger.warn(`agent-initiated card open failed: ${String(error)}`)
          }
        }
        return
      }
      case 'assistant/chunk': {
        if (state === undefined) return
        const chunk = data.chunk as { type?: string; text?: string } | undefined
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
          // Deltas may carry reasoning tags; strip them so internal thinking
          // never renders (a delta fully inside a tag contributes nothing).
          const text = stripReasoningTags(chunk.text)
          if (text !== '') {
            state.content += text
            this.syncCard(chatId, state, 'working')
          }
        } else if (
          chunk?.type === 'reasoning-delta' &&
          typeof chunk.text === 'string' &&
          this.options.showReasoning !== false
        ) {
          if (!state.openThink) {
            state.rows = [...state.rows, { kind: 'think', text: chunk.text }]
            state.openThink = true
          } else {
            const rows = [...state.rows]
            const index = rows.length - 1
            const last = rows[index]
            if (last !== undefined && last.kind === 'think') {
              rows[index] = { kind: 'think', text: last.text + chunk.text }
              state.rows = rows
            }
          }
          this.syncCard(chatId, state, 'working')
        }
        return
      }
      case 'tool/call': {
        if (state === undefined) return
        state.openThink = false
        const args = String(data.arguments ?? '')
        const callId = data.callId === undefined ? undefined : String(data.callId)
        if (callId !== undefined) state.toolStarts.set(callId, Date.now())
        state.rows = [
          ...state.rows,
          {
            kind: 'tool' as const,
            ...(callId === undefined ? {} : { callId }),
            name: String(data.name ?? 'tool'),
            summary: toolRowSummary(String(data.name ?? ''), args),
            status: 'running' as const,
            // Raw arguments may embed credentials; redact before capture.
            ...(args === ''
              ? {}
              : { detailIn: redactInlineSecrets(args).slice(0, DETAIL_CAPTURE_CHARS) }),
          },
        ]
        this.syncCard(chatId, state, 'working')
        return
      }
      case 'tool/result': {
        if (state === undefined) return
        const message = data.message as
          | { content?: Array<{ toolCallId?: string }> }
          | undefined
        const toolCallId = message?.content?.[0]?.toolCallId
        const error = data.error !== undefined
        const rows = [...state.rows]
        // Match the running tool row by call id; fall back to the latest
        // running row when the result carries no correlating id.
        let matched = -1
        let lastRunning = -1
        for (let i = 0; i < rows.length; i += 1) {
          const row = rows[i]
          if (row === undefined || row.kind !== 'tool' || row.status !== 'running') continue
          lastRunning = i
          if (toolCallId !== undefined && row.callId === toolCallId) matched = i
        }
        if (matched === -1) matched = lastRunning
        if (matched >= 0) {
          const row = rows[matched]
          if (row !== undefined && row.kind === 'tool') {
            // Sanitize by the tool's kind when known; always redact
            // credential-shaped text as a base layer.
            const sanitizer = resolveToolDescriptor(row.name)?.sanitizer
            const rawResult = extractResultText(data.message)
            const resultText =
              sanitizer === undefined
                ? redactInlineSecrets(rawResult)
                : sanitizeToolDetail(rawResult, sanitizer)
            const rawError =
              typeof data.error === 'string'
                ? data.error
                : ((data.error as { message?: string } | undefined)?.message ?? '')
            const errorText = redactInlineSecrets(rawError)
            const detail = [resultText, errorText].filter(part => part !== '').join('\n')
            let durationMs: number | undefined
            if (row.callId !== undefined) {
              const started = state.toolStarts.get(row.callId)
              if (started !== undefined) {
                durationMs = Date.now() - started
                state.toolStarts.delete(row.callId)
              }
            }
            rows[matched] = {
              ...row,
              status: error ? 'error' : 'done',
              ...(durationMs === undefined ? {} : { durationMs }),
              ...(detail === '' ? {} : { detailOut: detail.slice(0, DETAIL_CAPTURE_CHARS) }),
            }
            state.rows = rows
          }
        }
        this.syncCard(chatId, state, 'working')
        return
      }
      case 'assistant/message': {
        if (state === undefined) return
        state.openThink = false
        const text = stripReasoningTags(
          assistantText((data.message as { content?: readonly unknown[] } | undefined)?.content),
        )
        if (text !== '') state.content = text
        this.syncCard(chatId, state, 'working')
        return
      }
      case 'turn/end': {
        if (state === undefined) return
        const reason = ((topLevel('reason') ?? data.reason) as
          | { kind?: string; error?: { message?: string; code?: string } }
          | undefined)
        const status: CardStatus =
          reason?.kind === 'error' ? 'error' : reason?.kind === 'aborted' ? 'stopped' : 'done'
        if (reason?.kind === 'error') {
          this.options.logger.error(
            `turn failed: ${reason.error?.code ?? 'UNKNOWN'}: ${reason.error?.message ?? ''}`,
          )
        }
        state.openThink = false
        const footer: CardFooter | undefined =
          state.startedAt === 0
            ? undefined
            : {
                elapsedMs: Date.now() - state.startedAt,
                ...(() => {
                  const model = this.options.modelControl?.get(chatId)?.model
                  return model === undefined || model === '' ? {} : { model }
                })(),
              }
        // Resolve remote images in the final answer before the card closes.
        const content =
          this.options.resolveImages === false
            ? state.content
            : await resolveContentImages(state.content, this.options.transport, this.options.logger)
        state.content = content
        this.turns.delete(chatId)
        const finalSnapshot: CardSnapshot = {
          title: state.title,
          content,
          rows: state.rows,
          status,
          expanded: state.expanded,
          ...(footer === undefined ? {} : { footer }),
        }
        this.lastSnapshots.set(chatId, finalSnapshot)
        if (this.options.cards.isActive(chatId)) {
          let finalized = false
          try {
            finalized = await this.options.cards.finalize(chatId, status, footer, finalSnapshot)
          } catch (error: unknown) {
            this.options.logger.warn(`card finalize threw; falling back to plain text: ${String(error)}`)
          }
          if (!finalized) {
            // The streaming card could not be finished (dead card / retired):
            // don't lose the reply - fall back to plain text.
            this.options.logger.warn(`card finalize failed; falling back to plain text`)
            const fallback =
              status === 'error'
                ? `⚠️ ${reason?.error?.message ?? 'turn ended with an error'}`
                : state.content
            if (fallback !== '') {
              await this.options.transport
                .sendText(chatId, fallback.length > 3000 ? `…${fallback.slice(-3000)}` : fallback)
                .catch((error: unknown) => {
                  this.options.logger.warn(`plain-text fallback failed: ${String(error)}`)
                })
            }
          }
        } else {
          // The streaming card never opened (e.g. a rejected card payload):
          // don't lose the reply - fall back to plain text.
          const fallback =
            status === 'error'
              ? `⚠️ ${reason?.error?.message ?? 'turn ended with an error'}`
              : state.content
          if (fallback !== '') {
            await this.options.transport
              .sendText(chatId, fallback.length > 3000 ? `…${fallback.slice(-3000)}` : fallback)
              .catch((error: unknown) => {
                this.options.logger.warn(`plain-text fallback failed: ${String(error)}`)
              })
          }
        }
        return
      }
      default:
        return
    }
  }

  private syncCard(chatId: string, state: TurnState, status: CardStatus): void {
    this.options.cards.patch(chatId, {
      title: state.title,
      content: state.content,
      rows: state.rows,
      status,
      expanded: state.expanded,
    })
  }

  /**
   * Answerer for the `approval/request` waterfall: requests for the
   * bridge's own agents become Feishu approval cards; everything else
   * delegates down the chain (`next()`).
   */
  handleApprovalRequest(
    request: ApprovalRequestLike,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    const chatId = this.options.sessionMap.chatFor(String(request.agent.id))
    if (chatId === undefined) return next()
    return new Promise<ApprovalOutcome>(resolve => {
      void (async () => {
        let messageId: string | undefined
        try {
          messageId = await this.options.transport.sendCard(chatId, buildApprovalCardBody(request))
        } catch (error: unknown) {
          this.options.logger.error(`approval card send failed: ${String(error)}`)
          resolve('unavailable')
          return
        }
        const pending: PendingApproval = {
          chatId,
          messageId,
          request,
          resolve,
          settled: false,
        }
        this.approvals.set(messageId, pending)
        const onAbort = () => {
          if (pending.settled) return
          pending.settled = true
          this.approvals.delete(messageId!)
          resolve('cancelled')
        }
        request.signal?.addEventListener('abort', onAbort, { once: true })
      })()
    })
  }

  /** Route a card-button callback (approval decision, stop, detail toggle, session switch). */
  private async handleCardAction(action: FeishuCardAction): Promise<void> {
    const kind = action.value['kind']
    if (kind === 'session') {
      // The /sessions card's switch buttons act like /switch <n>.
      if (!this.senderAllowed(action.operatorOpenId)) {
        this.options.logger.warn(`session switch from unauthorized operator ${action.operatorOpenId} ignored`)
        return
      }
      const n = action.value['n']
      if (action.value['action'] === 'switch' && n !== undefined && n !== '') {
        await this.handleSwitchCommand(action.chatId, n)
      }
      return
    }
    if (kind === 'detail') {
      // The 🔍 详情/收起 toggle re-renders the card with tool arguments and
      // results inline; works on the live card and on the finished one.
      if (!this.senderAllowed(action.operatorOpenId)) {
        this.options.logger.warn(`detail toggle from unauthorized operator ${action.operatorOpenId} ignored`)
        return
      }
      for (const [chatId, turn] of this.turns) {
        if (this.options.cards.activeMessageId(chatId) !== action.messageId) continue
        turn.expanded = !turn.expanded
        this.syncCard(chatId, turn, 'working')
        return
      }
      for (const [chatId, snapshot] of this.lastSnapshots) {
        if (this.options.cards.lastMessageId(chatId) !== action.messageId) continue
        const toggled: CardSnapshot = { ...snapshot, expanded: snapshot.expanded !== true }
        this.lastSnapshots.set(chatId, toggled)
        await this.options.cards.refresh(chatId, toggled)
        return
      }
      return
    }
    if (kind === 'approval') {
      const pending = this.approvals.get(action.messageId)
      if (pending === undefined) return
      if (!this.senderAllowed(action.operatorOpenId)) {
        this.options.logger.warn(
          `approval button from unauthorized operator ${action.operatorOpenId} ignored`,
        )
        return
      }
      const decision = action.value['decision'] === 'allowed-once' ? 'allowed-once' : 'rejected'
      if (pending.settled) return
      pending.settled = true
      this.approvals.delete(action.messageId)
      pending.resolve(decision)
      try {
        await this.options.transport.updateCard(
          action.messageId,
          buildApprovalSettledBody(pending.request, decision === 'allowed-once' ? '✅ allowed' : '❌ rejected'),
        )
      } catch (error: unknown) {
        this.options.logger.warn(`approval card settle failed: ${String(error)}`)
      }
      return
    }
    if (kind === 'stop') {
      // The ⏹ Stop button on a chat's active streaming card cancels that chat's agent.
      for (const [chatId, turn] of this.turns) {
        if (this.options.cards.activeMessageId(chatId) !== action.messageId) continue
        const agent = this.options.agentStore.get(turn.sessionId)
        agent?.cancel({ kind: 'user' })
        return
      }
    }
  }
}

/** Approval card JSON (kept here to avoid a circular import with cards.ts). */
function buildApprovalCardBody(request: ApprovalRequestLike): unknown {
  const lines = [`**${request.toolName}** wants to run`]
  if (request.reason !== undefined && request.reason !== '') {
    lines.push(`> ${request.reason}`)
  }
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '🔐 Approval needed' }, template: 'orange' },
    elements: [
      { tag: 'markdown', content: lines.join('\n') },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ Allow once' },
            type: 'primary',
            // No action_type: value buttons default to card.action.trigger.
            value: { kind: 'approval', decision: 'allowed-once' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '❌ Reject' },
            type: 'danger',
            value: { kind: 'approval', decision: 'rejected' },
          },
        ],
      },
    ],
  }
}

/** Settled approval card JSON. */
function buildApprovalSettledBody(request: ApprovalRequestLike, outcome: string): unknown {
  const lines = [`**${request.toolName}** - ${outcome}`]
  if (request.reason !== undefined && request.reason !== '') {
    lines.push(`> ${request.reason}`)
  }
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '🔐 Approval' }, template: 'grey' },
    elements: [{ tag: 'markdown', content: lines.join('\n') }],
  }
}
