/**
 * CardKit (card JSON 2.0) streaming-card manager.
 *
 * Implements the same surface as the v1 `StreamingCardManager` so the bridge
 * is engine-agnostic. The card is created as a CardKit entity in streaming
 * mode; answer text is pushed per-element with the typing effect, tool and
 * reasoning panels are structure-updated with `batch_update`, and at the end
 * streaming is closed and the card is fully replaced by the terminal card.
 *
 * Simplified vs hermes-lark-streaming: no card splitting (the tool panel
 * caps at 30 visible steps and reports the full count in its title), and a
 * flush failure retires the card so the bridge falls back to plain text.
 *
 * @module dsh-tui-feishu/streaming/cardkit-manager
 */

import type { CardFooter, CardRow, CardSnapshot, CardStream } from '../cards.js'
import type { CardLocale } from '../i18n.js'
import type { LarkTransport } from '../transport.js'
import {
  buildCardKitCompleteCard,
  buildCardKitStreamingCard,
  buildToolPanel,
  KIT_ANSWER_ELEMENT,
  KIT_REASONING_TEXT_ELEMENT,
} from './cardkit-builder.js'

/** One chat's live CardKit card state. */
interface KitCard {
  readonly chatId: string
  readonly cardId: string
  readonly messageId: string
  /** CardKit sequence counter (must increase per mutation). */
  seq: number
  lastSnapshot: CardSnapshot | null
  hasToolPanel: boolean
  pending: CardSnapshot | null
  timer: ReturnType<typeof setTimeout> | null
  flushing: boolean
  closed: boolean
  openedAt: number
  lastPatchAt: number
}

/** Per-chat stale-card sweep. */
const SWEEP_INTERVAL_MS = 60_000

/** batch_update action: insert elements before the answer element. */
function addBeforeAnswer(element: unknown): Record<string, unknown> {
  return {
    action: 'add_elements',
    params: { type: 'insert_before', target_element_id: KIT_ANSWER_ELEMENT, elements: [element] },
  }
}

/** batch_update action: patch one element's header/elements. */
function partialUpdate(
  elementId: string,
  partial: Record<string, unknown>,
): Record<string, unknown> {
  return { action: 'partial_update_element', params: { element_id: elementId, partial_element: partial } }
}

/** Compare two row lists by the fields the panels render. */
function rowsKey(rows: readonly CardRow[]): string {
  return JSON.stringify(rows)
}

export class CardKitStreamingManager implements CardStream {
  private readonly active = new Map<string, KitCard>()
  /** The most recent CardKit card per chat, for the detail toggle on finished cards. */
  private readonly lastCards = new Map<string, { cardId: string; messageId: string }>()
  private readonly throttleMs: number
  private readonly cardTtlMs: number
  private readonly locale: CardLocale
  private readonly showReasoning: boolean
  private readonly sweepTimer: ReturnType<typeof setInterval> | null
  private readonly logger: { warn(message: string): void }

  constructor(
    private readonly transport: LarkTransport,
    options: {
      throttleMs?: number
      cardTtlMs?: number
      sweepIntervalMs?: number
      locale?: CardLocale
      showReasoning?: boolean
      logger?: { warn(message: string): void }
    } = {},
  ) {
    this.throttleMs = options.throttleMs ?? 100
    this.cardTtlMs = options.cardTtlMs ?? 15 * 60_000
    this.locale = options.locale ?? 'zh'
    this.showReasoning = options.showReasoning ?? true
    this.logger = options.logger ?? { warn: () => {} }
    this.sweepTimer = setInterval(() => this.sweepStale(), options.sweepIntervalMs ?? SWEEP_INTERVAL_MS)
    this.sweepTimer.unref?.()
  }

  /** Create the streaming placeholder card (typing mode on). */
  async open(chatId: string, title: string): Promise<void> {
    const stale = this.active.get(chatId)
    if (stale !== undefined) await this.finalize(chatId, 'done')
    const snapshot: CardSnapshot = { title, content: '', rows: [], status: 'working' }
    const card = buildCardKitStreamingCard(snapshot, this.locale, { showReasoning: this.showReasoning })
    const cardId = await this.transport.cardkitCreate(card)
    const messageId = await this.transport.cardkitSendToChat(chatId, cardId)
    this.lastCards.set(chatId, { cardId, messageId })
    const now = Date.now()
    this.active.set(chatId, {
      chatId,
      cardId,
      messageId,
      seq: 1,
      lastSnapshot: snapshot,
      hasToolPanel: false,
      pending: null,
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

  /** Close streaming, replace with the terminal card, retire. */
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
    const base = snapshot ?? card.pending ?? card.lastSnapshot
    if (base !== null) {
      const final: CardSnapshot = { ...base, status, ...(footer === undefined ? {} : { footer }) }
      card.pending = final
      await this.flush(card, { terminal: true })
    }
    this.active.delete(chatId)
  }

  isActive(chatId: string): boolean {
    return this.active.has(chatId)
  }

  activeMessageId(chatId: string): string | undefined {
    return this.active.get(chatId)?.messageId
  }

  lastMessageId(chatId: string): string | undefined {
    return this.active.get(chatId)?.messageId ?? this.lastCards.get(chatId)?.messageId
  }

  /** Re-render a finished card (the detail toggle) via a full CardKit update. */
  async refresh(chatId: string, snapshot: CardSnapshot): Promise<void> {
    const live = this.active.get(chatId)
    if (live !== undefined && !live.closed) {
      this.patch(chatId, snapshot)
      return
    }
    const last = this.lastCards.get(chatId)
    if (last === undefined) return
    try {
      const card = buildCardKitCompleteCard(snapshot, this.locale, { showReasoning: this.showReasoning })
      await this.transport.cardkitUpdate(last.cardId, card, 1)
    } catch (error: unknown) {
      this.logger.warn(`cardkit refresh failed: ${String(error)}`)
    }
  }

  dispose(): void {
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer)
    for (const card of this.active.values()) {
      if (card.timer !== null) clearTimeout(card.timer)
    }
    this.active.clear()
  }

  private async flush(card: KitCard, options: { terminal?: boolean } = {}): Promise<void> {
    if (card.flushing) return
    card.flushing = true
    try {
      while (card.pending !== null) {
        const snapshot = card.pending
        card.pending = null
        if (!(await this.apply(card, snapshot, options.terminal === true))) return
      }
    } finally {
      card.flushing = false
    }
  }

  /** Push one snapshot to the platform; false retires the card on failure. */
  private async apply(card: KitCard, snapshot: CardSnapshot, terminal: boolean): Promise<boolean> {
    const previous = card.lastSnapshot
    try {
      if (terminal) {
        // End of turn: stop the typing mode, then replace with the final card.
        card.seq += 1
        await this.transport.cardkitCloseStreaming(card.cardId, card.seq)
        const finalCard = buildCardKitCompleteCard(snapshot, this.locale, {
          showReasoning: this.showReasoning,
        })
        card.seq += 1
        await this.transport.cardkitUpdate(card.cardId, finalCard, card.seq)
        card.lastSnapshot = snapshot
        return true
      }
      const actions: Record<string, unknown>[] = []
      const toolRows = snapshot.rows.filter(row => row.kind === 'tool')
      const thinkRows = snapshot.rows.filter(row => row.kind === 'think')
      const prevToolRows = previous?.rows.filter(row => row.kind === 'tool') ?? []
      const prevThinkRows = previous?.rows.filter(row => row.kind === 'think') ?? []
      if (toolRows.length > 0 && rowsKey(toolRows) !== rowsKey(prevToolRows)) {
        const panel = buildToolPanel(toolRows, this.locale)
        if (card.hasToolPanel) {
          actions.push(partialUpdate(panel.element_id as string, {
            header: panel.header,
            elements: panel.elements,
          }))
        } else {
          actions.push(addBeforeAnswer(panel))
          card.hasToolPanel = true
        }
      }
      if (actions.length > 0) {
        card.seq += 1
        await this.transport.cardkitBatchUpdate(card.cardId, actions, card.seq)
      }
      // Thinking text streams into its own element (typing effect while
      // streaming_mode is on) - the same per-element streaming hermes uses.
      if (this.showReasoning && thinkRows.length > 0 && rowsKey(thinkRows) !== rowsKey(prevThinkRows)) {
        const text = thinkRows.map(row => row.text).join('\n').slice(0, 600) || ' '
        card.seq += 1
        await this.transport.cardkitStreamElement(card.cardId, KIT_REASONING_TEXT_ELEMENT, text, card.seq)
      }
      if (previous === null || snapshot.content !== previous.content) {
        card.seq += 1
        await this.transport.cardkitStreamElement(
          card.cardId,
          KIT_ANSWER_ELEMENT,
          snapshot.content || ' ',
          card.seq,
        )
      }
      card.lastSnapshot = snapshot
      return true
    } catch (error: unknown) {
      // Any CardKit failure retires the card: the bridge falls back to plain
      // text at turn end instead of fighting a broken card.
      this.logger.warn(`cardkit update failed (retiring card): ${String(error)}`)
      this.active.delete(card.chatId)
      this.lastCards.delete(card.chatId)
      return false
    }
  }

  /** Retire cards idle past the TTL. */
  private sweepStale(): void {
    const cutoff = Date.now() - this.cardTtlMs
    for (const [chatId, card] of this.active) {
      if (card.lastPatchAt > cutoff) continue
      this.logger.warn(`cardkit card for ${chatId} idle > ${Math.round(this.cardTtlMs / 1000)}s; retiring`)
      card.closed = true
      if (card.timer !== null) {
        clearTimeout(card.timer)
        card.timer = null
      }
      this.active.delete(chatId)
    }
  }
}

