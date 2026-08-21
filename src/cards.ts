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
import { isTerminalMessageCode, markUnavailable } from './unavailable.js'
import { t, type CardLocale } from './i18n.js'
import { formatCodeBlock, prettyJsonOrText, splitLongText } from './cardmd.js'
import { toolDisplayTitle } from './tools.js'

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
      /** Tool wall time, shown on the row when finished. */
      readonly durationMs?: number
      /** Raw tool arguments (truncated), shown in the expanded detail view. */
      readonly detailIn?: string
      /** Tool result text (truncated), shown in the expanded detail view. */
      readonly detailOut?: string
    }

/** Terminal metadata rendered as a card footer (best effort). */
export interface CardFooter {
  readonly elapsedMs?: number
  readonly model?: string
}

/** A full card snapshot - the single source for every patch. */
export interface CardSnapshot {
  readonly title: string
  readonly content: string
  readonly rows: readonly CardRow[]
  readonly status: CardStatus
  /** Render activity rows with their argument/result details. */
  readonly expanded?: boolean
  /** Terminal metadata (status/elapsed/model) for the footer. */
  readonly footer?: CardFooter
}

/** Keep the card body bounded (the tail is what the user is waiting on). */
const MAX_BODY_CHARS = 12000
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
  return `${t('earlierTrimmed', 'zh')}\n${text.slice(-MAX_BODY_CHARS)}`
}

/** Detail blocks stay small - the full output is on the host anyway. */
const MAX_DETAIL_CHARS = 800
const MAX_THINK_CHARS = 600

function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n${t('truncated', 'zh')}`
}

function formatElapsed(ms: number): string {
  const seconds = ms / 1000
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`
}

function rowLine(row: CardRow, locale: CardLocale): string {
  if (row.kind === 'think') return t('thinking', locale)
  const icon = ROW_ICON[row.status]
  const title = toolDisplayTitle(row.name)
  const label = row.summary === '' ? title : `${title}: ${row.summary}`
  const duration = row.durationMs !== undefined ? ` · ${formatElapsed(row.durationMs)}` : ''
  return `${icon} ${label}${duration}`
}

/** Extra lines for one row in the expanded view. */
function rowDetailLines(row: CardRow, locale: CardLocale): string[] {
  if (row.kind === 'think') {
    return row.text === '' ? [] : [`💭 ${truncateMiddle(row.text.trim(), MAX_THINK_CHARS)}`]
  }
  const lines: string[] = []
  if (row.detailIn !== undefined && row.detailIn !== '') {
    lines.push(`　${t('detailArgs', locale)}：${truncateMiddle(row.detailIn, MAX_DETAIL_CHARS)}`)
  }
  if (row.detailOut !== undefined && row.detailOut !== '') {
    const isError = row.status === 'error'
    const { language, text } = prettyJsonOrText(row.detailOut)
    const body = formatCodeBlock(truncateMiddle(text, MAX_DETAIL_CHARS), language) || truncateMiddle(text, MAX_DETAIL_CHARS)
    lines.push(`　${isError ? t('detailError', locale) : t('detailResult', locale)}：`)
    lines.push(body)
  }
  return lines
}

/** Footer lines (status · elapsed · model) for a finished card. */
function footerLines(snapshot: CardSnapshot, locale: CardLocale): string[] {
  const footer = snapshot.footer
  if (footer === undefined) return []
  const parts: string[] = []
  const status =
    snapshot.status === 'error'
      ? t('errorNote', locale)
      : snapshot.status === 'stopped'
        ? t('stopped', locale)
        : t('doneNote', locale)
  parts.push(status)
  if (footer.elapsedMs !== undefined && footer.elapsedMs > 0) {
    parts.push(`${t('elapsed', locale)} ${formatElapsed(footer.elapsedMs)}`)
  }
  if (footer.model !== undefined && footer.model !== '') {
    parts.push(`${t('model', locale)} ${footer.model}`)
  }
  return parts.length === 0 ? [] : [`${parts.join(' · ')}`]
}

/** Build the streaming-card JSON for one snapshot. */
export function buildCard(snapshot: CardSnapshot, locale: CardLocale = 'zh'): unknown {
  const elements: Record<string, unknown>[] = []
  if (snapshot.rows.length > 0) {
    const lines: string[] = []
    for (const row of snapshot.rows) {
      lines.push(rowLine(row, locale))
      if (snapshot.expanded === true) lines.push(...rowDetailLines(row, locale))
    }
    elements.push({ tag: 'markdown', content: lines.join('\n') })
  }
  // Long bodies split into multiple markdown elements (each ≤ 2400 chars).
  const body = truncateTail(toFeishuMarkdown(snapshot.content)).trim()
  if (body !== '') {
    for (const chunk of splitLongText(body)) {
      if (elements.length > 0) elements.push({ tag: 'hr' })
      elements.push({ tag: 'markdown', content: chunk })
    }
  }
  const footer = footerLines(snapshot, locale)
  if (footer.length > 0) {
    if (elements.length > 0) elements.push({ tag: 'hr' })
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: footer.join('\n') }] })
  }
  // The status note is skipped when a footer already carries it.
  if ((snapshot.status !== 'working' || body === '') && footer.length === 0) {
    if (elements.length > 0) elements.push({ tag: 'hr' })
    const note =
      snapshot.status === 'working'
        ? t('workingNote', locale)
        : snapshot.status === 'error'
          ? t('errorNote', locale)
          : snapshot.status === 'stopped'
            ? t('stoppedNote', locale)
            : t('doneNote', locale)
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
  /** The last snapshot actually flushed to Feishu (for terminal re-renders). */
  lastFlushed: CardSnapshot | null
  timer: ReturnType<typeof setTimeout> | null
  flushing: boolean
  closed: boolean
  /** Epoch ms of the card's creation. */
  openedAt: number
  /** Epoch ms of the last staged snapshot. */
  lastPatchAt: number
}

/** How often the idle-card sweep runs (also the test override knob). */
const SWEEP_INTERVAL_MS = 60_000

/**
 * The card-stream surface the bridge drives - implemented by both the v1
 * `StreamingCardManager` and the CardKit `CardKitStreamingManager`, so the
 * engine is a configuration choice, not a bridge fork.
 */
export interface CardStream {
  open(chatId: string, title: string): Promise<void>
  patch(chatId: string, snapshot: CardSnapshot): void
  finalize(
    chatId: string,
    status: 'done' | 'error' | 'stopped',
    footer?: CardFooter,
    snapshot?: CardSnapshot,
  ): Promise<void>
  isActive(chatId: string): boolean
  activeMessageId(chatId: string): string | undefined
  lastMessageId(chatId: string): string | undefined
  refresh(chatId: string, snapshot: CardSnapshot): Promise<void>
  dispose(): void
}

/**
 * Manages one active streaming card per chat: throttled, coalesced patches;
 * a failed patch never kills the stream (logged, latest snapshot retried),
 * except when the platform reports the message as deleted/recalled - then
 * the card is retired immediately and the message id remembered so nothing
 * keeps patching a dead card. Cards idle for `cardTtlMs` are swept (the
 * turn's reply then falls back to plain text).
 */
export class StreamingCardManager implements CardStream {
  private readonly active = new Map<string, ActiveCard>()
  /** The most recently opened card per chat, kept after finalization so
   *  finished cards can still be re-rendered (the detail toggle). */
  private readonly lastMessageIds = new Map<string, string>()
  private readonly throttleMs: number
  private readonly cardTtlMs: number
  private readonly locale: CardLocale
  private readonly sweepTimer: ReturnType<typeof setInterval> | null
  private readonly logger: { warn(message: string): void }

  constructor(
    private readonly transport: LarkTransport,
    options: {
      throttleMs?: number
      cardTtlMs?: number
      sweepIntervalMs?: number
      locale?: CardLocale
      logger?: { warn(message: string): void }
    } = {},
  ) {
    this.throttleMs = options.throttleMs ?? 500
    this.cardTtlMs = options.cardTtlMs ?? 15 * 60_000
    this.locale = options.locale ?? 'zh'
    this.logger = options.logger ?? { warn: () => {} }
    this.sweepTimer = setInterval(
      () => this.sweepStale(),
      options.sweepIntervalMs ?? SWEEP_INTERVAL_MS,
    )
    this.sweepTimer.unref?.()
  }

  /** Open a new streaming card for one chat (flushing any stale one first). */
  async open(chatId: string, title: string): Promise<void> {
    const stale = this.active.get(chatId)
    if (stale !== undefined) await this.finalize(chatId, 'done')
    const card = buildCard({ title, content: '', rows: [], status: 'working' }, this.locale)
    const messageId = await this.transport.sendCard(chatId, card)
    this.lastMessageIds.set(chatId, messageId)
    const now = Date.now()
    this.active.set(chatId, {
      chatId,
      messageId,
      pending: null,
      lastFlushed: null,
      timer: null,
      flushing: false,
      closed: false,
      openedAt: now,
      lastPatchAt: now,
    })
  }

  /** Stage the next snapshot; flushed after `throttleMs` or in-flight settle. */
  patch(chatId: string, snapshot: CardSnapshot): void {
    const card = this.active.get(chatId)
    if (card === undefined || card.closed) return
    card.pending = snapshot
    card.lastPatchAt = Date.now()
    if (card.timer === null && !card.flushing) {
      card.timer = setTimeout(() => {
        card.timer = null
        void this.flush(card)
      }, this.throttleMs)
    }
  }

  /**
   * Mark the card terminal: stage the terminal status (plus optional footer
   * metadata) and flush, then retire it. A terminal snapshot is staged even
   * when nothing is pending, so finished cards always render their final
   * state (status note / footer) rather than freezing mid-stream.
   * `snapshot` (optional) overrides the staged base - used when the caller
   * holds a newer version of the content than the last flush (e.g. image
   * resolution at turn end).
   */
  async finalize(
    chatId: string,
    status: 'done' | 'error' | 'stopped',
    footer?: CardFooter,
    snapshot?: CardSnapshot,
  ): Promise<void> {
    const card = this.active.get(chatId)
    if (card === undefined || card.closed) return
    card.closed = true
    if (card.timer !== null) {
      clearTimeout(card.timer)
      card.timer = null
    }
    const base = snapshot ?? card.pending ?? card.lastFlushed
    if (base !== null) {
      card.pending = { ...base, status, ...(footer === undefined ? {} : { footer }) }
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
      await this.transport.updateCard(messageId, buildCard(snapshot, this.locale))
    } catch (error: unknown) {
      if (this.handlePatchFailure(messageId, error)) return
      this.logger.warn(`card refresh failed: ${String(error)}`)
    }
  }

  /** Dispose every active card without further patching. */
  dispose(): void {
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer)
    for (const card of this.active.values()) {
      if (card.timer !== null) clearTimeout(card.timer)
    }
    this.active.clear()
  }

  /**
   * Handle one card-patch failure. Returns true when the message is gone
   * for good (terminal code): the card is retired and the message id is
   * remembered so nothing patches it again.
   */
  private handlePatchFailure(messageId: string, error: unknown): boolean {
    const code = (error as { code?: number } | null)?.code
    if (!isTerminalMessageCode(code)) return false
    markUnavailable(messageId, code ?? -1)
    this.logger.warn(`card message ${messageId} gone (code ${String(code)}); stream retired`)
    for (const [chatId, card] of this.active) {
      if (card.messageId !== messageId) continue
      card.closed = true
      if (card.timer !== null) {
        clearTimeout(card.timer)
        card.timer = null
      }
      this.active.delete(chatId)
      this.lastMessageIds.delete(chatId)
      return true
    }
    // A finalized card's message died: drop the id so toggles stop targeting it.
    for (const [chatId, id] of this.lastMessageIds) {
      if (id === messageId) this.lastMessageIds.delete(chatId)
    }
    return true
  }

  /** Retire cards that have seen no patch activity for `cardTtlMs`. */
  private sweepStale(): void {
    const cutoff = Date.now() - this.cardTtlMs
    for (const [chatId, card] of this.active) {
      if (card.lastPatchAt > cutoff) continue
      this.logger.warn(`streaming card for ${chatId} idle > ${Math.round(this.cardTtlMs / 1000)}s; retiring`)
      card.closed = true
      if (card.timer !== null) {
        clearTimeout(card.timer)
        card.timer = null
      }
      this.active.delete(chatId)
    }
  }

  private async flush(card: ActiveCard): Promise<void> {
    if (card.flushing) return
    card.flushing = true
    try {
      while (card.pending !== null) {
        const snapshot = card.pending
        card.pending = null
        try {
          await this.transport.updateCard(card.messageId, buildCard(snapshot, this.locale))
          card.lastFlushed = snapshot
        } catch (error: unknown) {
          if (this.handlePatchFailure(card.messageId, error)) return
          this.logger.warn(`streaming card patch failed (continuing): ${String(error)}`)
        }
      }
    } finally {
      card.flushing = false
    }
  }
}
