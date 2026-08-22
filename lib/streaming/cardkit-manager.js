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
        this.logger = { info: () => { }, warn: () => { }, ...options.logger };
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
            terminalRequested: false,
            streamClosed: false,
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
    /** Close streaming, replace with the terminal card, retire. Resolves true
     *  when the terminal card was applied (or is guaranteed to be applied by an
     *  in-flight flush); false when the card could not be finished - the caller
     *  should fall back to plain text so the reply is never lost. */
    async finalize(chatId, status, footer, snapshot) {
        const card = this.active.get(chatId);
        if (card === undefined || card.closed)
            return false;
        card.closed = true;
        if (card.timer !== null) {
            clearTimeout(card.timer);
            card.timer = null;
        }
        const base = snapshot ?? card.pending ?? card.lastSnapshot;
        if (base === null) {
            this.active.delete(chatId);
            return false;
        }
        const final = { ...base, status, ...(footer === undefined ? {} : { footer }) };
        card.pending = final;
        if (card.flushing) {
            // A patch flush is in flight: it will pick up the terminal snapshot.
            // Flag it so the in-flight loop applies terminal semantics (close
            // streaming + full update) and retires the card. Without this flag the
            // terminal snapshot is applied by the NON-terminal branch - content
            // streams fine but streaming mode is never closed, so the card stays in
            // "working" state on Feishu forever (the reported bug).
            card.terminalRequested = true;
            return true;
        }
        const ok = await this.flush(card, { terminal: true });
        this.active.delete(chatId);
        return ok;
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
            return true;
        card.flushing = true;
        try {
            while (card.pending !== null) {
                const snapshot = card.pending;
                card.pending = null;
                const terminal = options.terminal === true || card.terminalRequested;
                card.terminalRequested = false;
                if (!(await this.apply(card, snapshot, terminal)))
                    return false;
                if (terminal) {
                    // Terminal applied: retire here so an in-flight (non-terminal)
                    // flush that picked up the terminal snapshot cleans up too;
                    // finalize()'s own delete is idempotent.
                    this.active.delete(card.chatId);
                    return true;
                }
            }
            return true;
        }
        finally {
            card.flushing = false;
        }
    }
    /** Whether a stream failure means the platform closed the card's streaming
     *  mode for good (idle timeout / already closed). */
    isStreamClosedError(error) {
        const code = error?.code;
        return code === 300309 || code === 200850;
    }
    /** Push one snapshot to the platform; false retires the card on failure. */
    async apply(card, snapshot, terminal) {
        const previous = card.lastSnapshot;
        try {
            if (terminal) {
                // End of turn: stop the typing mode, then replace with the final card.
                card.seq += 1;
                try {
                    await this.transport.cardkitCloseStreaming(card.cardId, card.seq);
                }
                catch (error) {
                    // The platform may already have closed streaming (idle timeout
                    // 200850 / "streaming mode is closed" 300309). The full update
                    // still works - tolerate the close failure and continue.
                    if (!this.isStreamClosedError(error))
                        throw error;
                    this.logger.warn(`cardkit closeStreaming already closed (continuing): ${String(error)}`);
                }
                const finalCard = buildCardKitCompleteCard(snapshot, this.locale, {
                    showReasoning: this.showReasoning,
                });
                card.seq += 1;
                await this.transport.cardkitUpdate(card.cardId, finalCard, card.seq);
                card.lastSnapshot = snapshot;
                this.logger.info(`cardkit card finalized: chat=${card.chatId} msg=${card.messageId} status=${snapshot.status} elements=${finalCard.body.elements?.length ?? 0}`);
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
            // Once the platform closes streaming (idle timeout / already closed),
            // every stream call fails: remember it and stop trying - the content
            // still lands in the terminal full update.
            if (this.showReasoning && thinkRows.length > 0 && rowsKey(thinkRows) !== rowsKey(prevThinkRows)) {
                if (!card.streamClosed) {
                    const text = thinkRows.map(row => row.text).join('\n').slice(0, 600) || ' ';
                    card.seq += 1;
                    try {
                        await this.transport.cardkitStreamElement(card.cardId, KIT_REASONING_TEXT_ELEMENT, text, card.seq);
                    }
                    catch (error) {
                        if (this.isStreamClosedError(error))
                            card.streamClosed = true;
                        this.logger.warn(`thinking stream failed (continuing): ${String(error)}`);
                    }
                }
            }
            if (previous === null || snapshot.content !== previous.content) {
                if (!card.streamClosed) {
                    card.seq += 1;
                    try {
                        await this.transport.cardkitStreamElement(card.cardId, KIT_ANSWER_ELEMENT, snapshot.content || ' ', card.seq);
                    }
                    catch (error) {
                        if (this.isStreamClosedError(error))
                            card.streamClosed = true;
                        this.logger.warn(`answer stream failed (continuing): ${String(error)}`);
                    }
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
