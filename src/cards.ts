/**
 * Feishu interactive-card builders plus the throttled streaming-card
 * pipeline.
 *
 * One card per turn: POST it when the turn starts, then repeatedly
 * `im.v1.message.patch` the same message as output arrives. Patching is
 * silent (no unread notification) - exactly right for intermediate progress.
 * Patches are throttled and coalesced: at most one patch in flight per card
 * and the newest snapshot always wins.
 *
 * Card layout is v1 (root `elements`, no `schema` field) - the only layout
 * that supports interactive callback buttons together with message.patch.
 *
 * Refactored from PGZXB/dsh-feishu (MIT).
 *
 * @module dsh-tui-feishu/cards
 */

import type { LarkTransport } from './transport.js'

/** Terminal status of a turn card. */
export type CardStatus = 'working' | 'done' | 'stopped' | 'error'

/** One collapsed activity row above the reply body. */
export type CardRow =
  | { readonly kind: 'think'; readonly text: string }
  | {
      readonly kind: 'tool'
      readonly callId?: string
      readonly name: string
      readonly summary: string
      readonly status: 'running' | 'done' | 'error'
      /** Raw tool arguments (truncated), shown in the expanded detail view. */
      readonly detailIn?: string
      /** Tool result text (truncated), shown in the expanded detail view. */
      readonly detailOut?: string
    }

/** A full card snapshot - the single source for every patch. */
export interface CardSnapshot {
  readonly title: string
  readonly content: string
  readonly rows: readonly CardRow[]
  readonly status: CardStatus
  /** Render activity rows with their argument/result details. */
  readonly expanded?: boolean
}

/** Keep the card body bounded: the tail is the part the user is waiting on. */
const MAX_BODY_CHARS = 3000
const STATUS_TEMPLATE: Record<CardStatus, string> = {
  working: 'blue',
  done: 'green',
  stopped: 'grey',
  error: 'red',
}
const ROW_ICON: Record<'running' | 'done' | 'error', string> = {
  running: '⏳',
  done: '✅',
  error: '❌',
}

/** A table row line: `| a | b |` (tolerates missing outer pipes). */
function isTableRow(line: string): boolean {
  const t = line.trim()
  return t.startsWith('|') && t.endsWith('|') && t.length > 2
}

/** The GFM separator line under a table header: `|---|---|` or `|:---|---:|`. */
function isTableSeparator(line: string): boolean {
  const t = line.trim()
  return t.includes('-') && /^\|?[\s:|-]+\|?$/.test(t)
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map(cell => cell.trim().replace(/`([^`]*)`/g, '$1'))
}

/**
 * Feishu card markdown is a narrow subset (bold/italic/links; no headings,
 * no tables, no inline code). Degrade unsupported constructs:
 * - headings become one balanced bold line (an opening `**` without its
 *   closer renders as literal text),
 * - GFM tables become a bold header line plus one list line per row,
 * - inline-code backticks are dropped (the text itself stays).
 */
export function toFeishuMarkdown(markdown: string): string {
  const lines = markdown.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading !== null) {
      out.push(`**${heading[1] ?? ''}**`)
      i += 1
      continue
    }
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1] ?? '')) {
      out.push(`**${splitTableRow(line).join(' ｜ ')}**`)
      i += 2 // header + separator
      while (i < lines.length && isTableRow(lines[i] ?? '') && !isTableSeparator(lines[i] ?? '')) {
        out.push(`- ${splitTableRow(lines[i] ?? '').join(' ｜ ')}`)
        i += 1
      }
      continue
    }
    out.push(line.replace(/`([^`\n]*)`/g, '$1'))
    i += 1
  }
  return out.join('\n')
}

function truncateTail(text: string): string {
  if (text.length <= MAX_BODY_CHARS) return text
  return `…(earlier output trimmed)\n${text.slice(-MAX_BODY_CHARS)}`
}

/** Detail blocks stay small - the full output is on the host anyway. */
const MAX_DETAIL_CHARS = 800
const MAX_THINK_CHARS = 600

function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…（更多内容略）`
}

function rowLine(row: CardRow): string {
  if (row.kind === 'think') return `💭 _思考…_`
  const icon = ROW_ICON[row.status]
  const label = row.summary === '' ? row.name : `${row.name}: ${row.summary}`
  return `${icon} ${label}`
}

/** Extra lines for one row in the expanded view. */
function rowDetailLines(row: CardRow): string[] {
  if (row.kind === 'think') {
    return row.text === '' ? [] : [`💭 ${truncateMiddle(row.text.trim(), MAX_THINK_CHARS)}`]
  }
  const lines: string[] = []
  if (row.detailIn !== undefined && row.detailIn !== '') {
    lines.push(`　📥 参数：${truncateMiddle(row.detailIn, MAX_DETAIL_CHARS)}`)
  }
  if (row.detailOut !== undefined && row.detailOut !== '') {
    lines.push(`　📤 结果：${truncateMiddle(row.detailOut, MAX_DETAIL_CHARS)}`)
  }
  return lines
}

/** Build the streaming-card JSON for one snapshot. */
export function buildCard(snapshot: CardSnapshot): unknown {
  const elements: Record<string, unknown>[] = []
  if (snapshot.rows.length > 0) {
    const lines: string[] = []
    for (const row of snapshot.rows) {
      lines.push(rowLine(row))
      if (snapshot.expanded === true) lines.push(...rowDetailLines(row))
    }
    elements.push({ tag: 'markdown', content: lines.join('\n') })
  }
  const body = truncateTail(toFeishuMarkdown(snapshot.content)).trim()
  if (body !== '') {
    if (elements.length > 0) elements.push({ tag: 'hr' })
    elements.push({ tag: 'markdown', content: body })
  }
  if (snapshot.status !== 'working' || body === '') {
    if (elements.length > 0) elements.push({ tag: 'hr' })
    const note =
      snapshot.status === 'working'
        ? '… 思考中'
        : snapshot.status === 'error'
          ? '⚠️ 回合出错结束'
          : snapshot.status === 'stopped'
            ? '⏹ 已停止'
            : '✅ 完成'
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: note }] })
  }
  const actions: Record<string, unknown>[] = []
  if (snapshot.status === 'working') {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '⏹ Stop' },
      type: 'danger',
      // No action_type: a v1 button with a value defaults to the
      // card.action.trigger callback. ('callback' is rejected with
      // ErrCode 11310 - valid values are request|link|multi.)
      value: { kind: 'stop' },
    })
  }
  if (snapshot.rows.length > 0) {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: snapshot.expanded === true ? '🔼 收起' : '🔍 详情' },
      type: 'default',
      value: { kind: 'detail' },
    })
  }
  if (actions.length > 0) elements.push({ tag: 'action', actions })
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: snapshot.title },
      template: STATUS_TEMPLATE[snapshot.status],
    },
    elements,
  }
}

/** One chat's active card state. */
interface ActiveCard {
  readonly chatId: string
  messageId: string
  pending: CardSnapshot | null
  timer: ReturnType<typeof setTimeout> | null
  flushing: boolean
  closed: boolean
}

/**
 * Manages one active streaming card per chat: throttled, coalesced patches;
 * a failed patch never kills the stream (logged, latest snapshot retried).
 */
export class StreamingCardManager {
  private readonly active = new Map<string, ActiveCard>()
  /** The most recently opened card per chat, kept after finalization so
   *  finished cards can still be re-rendered (the detail toggle). */
  private readonly lastMessageIds = new Map<string, string>()
  private readonly throttleMs: number
  private readonly logger: { warn(message: string): void }

  constructor(
    private readonly transport: LarkTransport,
    options: { throttleMs?: number; logger?: { warn(message: string): void } } = {},
  ) {
    this.throttleMs = options.throttleMs ?? 500
    this.logger = options.logger ?? { warn: () => {} }
  }

  /** Open a new streaming card for one chat (flushing any stale one first). */
  async open(chatId: string, title: string): Promise<void> {
    const stale = this.active.get(chatId)
    if (stale !== undefined) await this.finalize(chatId, 'done')
    const card = buildCard({ title, content: '', rows: [], status: 'working' })
    const messageId = await this.transport.sendCard(chatId, card)
    this.lastMessageIds.set(chatId, messageId)
    this.active.set(chatId, {
      chatId,
      messageId,
      pending: null,
      timer: null,
      flushing: false,
      closed: false,
    })
  }

  /** Stage the next snapshot; flushed after `throttleMs` or in-flight settle. */
  patch(chatId: string, snapshot: CardSnapshot): void {
    const card = this.active.get(chatId)
    if (card === undefined || card.closed) return
    card.pending = snapshot
    if (card.timer === null && !card.flushing) {
      card.timer = setTimeout(() => {
        card.timer = null
        void this.flush(card)
      }, this.throttleMs)
    }
  }

  /** Mark the card terminal: flush pending content, then retire it. */
  async finalize(chatId: string, status: 'done' | 'error' | 'stopped'): Promise<void> {
    const card = this.active.get(chatId)
    if (card === undefined || card.closed) return
    card.closed = true
    if (card.timer !== null) {
      clearTimeout(card.timer)
      card.timer = null
    }
    if (card.pending !== null) {
      card.pending = { ...card.pending, status }
      await this.flush(card)
    }
    this.active.delete(chatId)
  }

  /** Whether a chat currently has an active streaming card. */
  isActive(chatId: string): boolean {
    return this.active.has(chatId)
  }

  /** Message id of the active card, for button routing. */
  activeMessageId(chatId: string): string | undefined {
    return this.active.get(chatId)?.messageId
  }

  /** Message id of the most recent card (active or finalized), for button routing. */
  lastMessageId(chatId: string): string | undefined {
    return this.active.get(chatId)?.messageId ?? this.lastMessageIds.get(chatId)
  }

  /**
   * Re-render a card from a snapshot: staged through the throttle when the
   * card is live, patched directly when it is finalized (the detail toggle
   * on a finished card). No-op when no card exists for the chat.
   */
  async refresh(chatId: string, snapshot: CardSnapshot): Promise<void> {
    const live = this.active.get(chatId)
    if (live !== undefined && !live.closed) {
      this.patch(chatId, snapshot)
      return
    }
    const messageId = this.lastMessageIds.get(chatId)
    if (messageId === undefined) return
    try {
      await this.transport.updateCard(messageId, buildCard(snapshot))
    } catch (error: unknown) {
      this.logger.warn(`card refresh failed: ${String(error)}`)
    }
  }

  /** Dispose every active card without further patching. */
  dispose(): void {
    for (const card of this.active.values()) {
      if (card.timer !== null) clearTimeout(card.timer)
    }
    this.active.clear()
  }

  private async flush(card: ActiveCard): Promise<void> {
    if (card.flushing) return
    card.flushing = true
    try {
      while (card.pending !== null) {
        const snapshot = card.pending
        card.pending = null
        try {
          await this.transport.updateCard(card.messageId, buildCard(snapshot))
        } catch (error: unknown) {
          this.logger.warn(`streaming card patch failed (continuing): ${String(error)}`)
        }
      }
    } finally {
      card.flushing = false
    }
  }
}
