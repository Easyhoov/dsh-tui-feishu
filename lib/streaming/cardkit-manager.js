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
import { buildCardKitCompleteCard, buildCardKitStreamingCard, buildToolPanel, KIT_ANSWER_ELEMENT, KIT_REASONING_TEXT_ELEMENT, } from './cardkit-builder.js';
/** Per-chat stale-card sweep. */
const SWEEP_INTERVAL_MS = 60_000;
/** batch_update action: insert elements before the answer element. */
function addBeforeAnswer(element) {
    return {
        action: 'add_elements',
        params: { type: 'insert_before', target_element_id: KIT_ANSWER_ELEMENT, elements: [element] },
    };
}
/** batch_update action: patch one element's header/elements. */
function partialUpdate(elementId, partial) {
    return { action: 'partial_update_element', params: { element_id: elementId, partial_element: partial } };
}
/** Compare two row lists by the fields the panels render. */
function rowsKey(rows) {
    return JSON.stringify(rows);
}
export class CardKitStreamingManager {
    transport;
    active = new Map();
    /** The most recent CardKit card per chat, for the detail toggle on finished cards. */
    lastCards = new Map();
    throttleMs;
    cardTtlMs;
    locale;
    showReasoning;
    sweepTimer;
    logger;
    constructor(transport, options = {}) {
        this.transport = transport;
        this.throttleMs = options.throttleMs ?? 100;
        this.cardTtlMs = options.cardTtlMs ?? 15 * 60_000;
        this.locale = options.locale ?? 'zh';
        this.showReasoning = options.showReasoning ?? true;
        this.logger = options.logger ?? { warn: () => { } };
        this.sweepTimer = setInterval(() => this.sweepStale(), options.sweepIntervalMs ?? SWEEP_INTERVAL_MS);
        this.sweepTimer.unref?.();
    }
    /** Create the streaming placeholder card (typing mode on). */
    async open(chatId, title) {
        const stale = this.active.get(chatId);
        if (stale !== undefined)
            await this.finalize(chatId, 'done');
        const snapshot = { title, content: '', rows: [], status: 'working' };
        const card = buildCardKitStreamingCard(snapshot, this.locale, { showReasoning: this.showReasoning });
        const cardId = await this.transport.cardkitCreate(card);
        const messageId = await this.transport.cardkitSendToChat(chatId, cardId);
        this.lastCards.set(chatId, { cardId, messageId });
        const now = Date.now();
        this.active.set(chatId, {
            chatId,
            cardId,
            messageId,
            seq: 1,
            lastSnapshot: snapshot,
            // The placeholder card always carries the tool panel (pending state),
            // so the first real tool update patches it in place.
            hasToolPanel: true,
            pending: null,
            timer: null,
            flushing: false,
            closed: false,
            openedAt: now,
            lastPatchAt: now,
        });
    }
    /** Stage the next snapshot; flushed after `throttleMs` or in-flight settle. */
    patch(chatId, snapshot) {
        const card = this.active.get(chatId);
        if (card === undefined || card.closed)
            return;
        card.pending = snapshot;
        card.lastPatchAt = Date.now();
        if (card.timer === null && !card.flushing) {
            card.timer = setTimeout(() => {
                card.timer = null;
                void this.flush(card);
            }, this.throttleMs);
        }
    }
    /** Close streaming, replace with the terminal card, retire. */
    async finalize(chatId, status, footer, snapshot) {
        const card = this.active.get(chatId);
        if (card === undefined || card.closed)
            return;
        card.closed = true;
        if (card.timer !== null) {
            clearTimeout(card.timer);
            card.timer = null;
        }
        const base = snapshot ?? card.pending ?? card.lastSnapshot;
        if (base !== null) {
            const final = { ...base, status, ...(footer === undefined ? {} : { footer }) };
            card.pending = final;
            await this.flush(card, { terminal: true });
        }
        this.active.delete(chatId);
    }
    isActive(chatId) {
        return this.active.has(chatId);
    }
    activeMessageId(chatId) {
        return this.active.get(chatId)?.messageId;
    }
    lastMessageId(chatId) {
        return this.active.get(chatId)?.messageId ?? this.lastCards.get(chatId)?.messageId;
    }
    /** Re-render a finished card (the detail toggle) via a full CardKit update. */
    async refresh(chatId, snapshot) {
        const live = this.active.get(chatId);
        if (live !== undefined && !live.closed) {
            this.patch(chatId, snapshot);
            return;
        }
        const last = this.lastCards.get(chatId);
        if (last === undefined)
            return;
        try {
            const card = buildCardKitCompleteCard(snapshot, this.locale, { showReasoning: this.showReasoning });
            await this.transport.cardkitUpdate(last.cardId, card, 1);
        }
        catch (error) {
            this.logger.warn(`cardkit refresh failed: ${String(error)}`);
        }
    }
    dispose() {
        if (this.sweepTimer !== null)
            clearInterval(this.sweepTimer);
        for (const card of this.active.values()) {
            if (card.timer !== null)
                clearTimeout(card.timer);
        }
        this.active.clear();
    }
    async flush(card, options = {}) {
        if (card.flushing)
            return;
        card.flushing = true;
        try {
            while (card.pending !== null) {
                const snapshot = card.pending;
                card.pending = null;
                if (!(await this.apply(card, snapshot, options.terminal === true)))
                    return;
            }
        }
        finally {
            card.flushing = false;
        }
    }
    /** Push one snapshot to the platform; false retires the card on failure. */
    async apply(card, snapshot, terminal) {
        const previous = card.lastSnapshot;
        try {
            if (terminal) {
                // End of turn: stop the typing mode, then replace with the final card.
                card.seq += 1;
                await this.transport.cardkitCloseStreaming(card.cardId, card.seq);
                const finalCard = buildCardKitCompleteCard(snapshot, this.locale, {
                    showReasoning: this.showReasoning,
                });
                card.seq += 1;
                await this.transport.cardkitUpdate(card.cardId, finalCard, card.seq);
                card.lastSnapshot = snapshot;
                return true;
            }
            const actions = [];
            const toolRows = snapshot.rows.filter(row => row.kind === 'tool');
            const thinkRows = snapshot.rows.filter(row => row.kind === 'think');
            const prevToolRows = previous?.rows.filter(row => row.kind === 'tool') ?? [];
            const prevThinkRows = previous?.rows.filter(row => row.kind === 'think') ?? [];
            if (toolRows.length > 0 && rowsKey(toolRows) !== rowsKey(prevToolRows)) {
                const panel = buildToolPanel(toolRows, this.locale);
                if (card.hasToolPanel) {
                    actions.push(partialUpdate(panel.element_id, {
                        header: panel.header,
                        elements: panel.elements,
                    }));
                }
                else {
                    actions.push(addBeforeAnswer(panel));
                    card.hasToolPanel = true;
                }
            }
            if (actions.length > 0) {
                // Structural failures make the card state untrustworthy: retire it
                // so the bridge falls back to plain text instead of fighting a
                // broken card.
                card.seq += 1;
                await this.transport.cardkitBatchUpdate(card.cardId, actions, card.seq);
            }
            // Text streaming is best-effort: a failed stream_element (e.g. a
            // transient error) must NOT retire the card - the terminal card's full
            // update carries the complete content anyway (hermes logs and moves on).
            if (this.showReasoning && thinkRows.length > 0 && rowsKey(thinkRows) !== rowsKey(prevThinkRows)) {
                const text = thinkRows.map(row => row.text).join('\n').slice(0, 600) || ' ';
                card.seq += 1;
                try {
                    await this.transport.cardkitStreamElement(card.cardId, KIT_REASONING_TEXT_ELEMENT, text, card.seq);
                }
                catch (error) {
                    this.logger.warn(`thinking stream failed (continuing): ${String(error)}`);
                }
            }
            if (previous === null || snapshot.content !== previous.content) {
                card.seq += 1;
                try {
                    await this.transport.cardkitStreamElement(card.cardId, KIT_ANSWER_ELEMENT, snapshot.content || ' ', card.seq);
                }
                catch (error) {
                    this.logger.warn(`answer stream failed (continuing): ${String(error)}`);
                }
            }
            card.lastSnapshot = snapshot;
            return true;
        }
        catch (error) {
            // Structural/terminal failures retire the card: the bridge falls back
            // to plain text at turn end instead of fighting a broken card.
            this.logger.warn(`cardkit update failed (retiring card): ${String(error)}`);
            this.active.delete(card.chatId);
            this.lastCards.delete(card.chatId);
            return false;
        }
    }
    /** Retire cards idle past the TTL. */
    sweepStale() {
        const cutoff = Date.now() - this.cardTtlMs;
        for (const [chatId, card] of this.active) {
            if (card.lastPatchAt > cutoff)
                continue;
            this.logger.warn(`cardkit card for ${chatId} idle > ${Math.round(this.cardTtlMs / 1000)}s; retiring`);
            card.closed = true;
            if (card.timer !== null) {
                clearTimeout(card.timer);
                card.timer = null;
            }
            this.active.delete(chatId);
        }
    }
}
