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
import type { LarkTransport } from './transport.js';
/** Terminal status of a turn card. */
export type CardStatus = 'working' | 'done' | 'stopped' | 'error';
/** One collapsed activity row above the reply body. */
export type CardRow = {
    readonly kind: 'think';
    readonly text: string;
} | {
    readonly kind: 'tool';
    readonly callId?: string;
    readonly name: string;
    readonly summary: string;
    readonly status: 'running' | 'done' | 'error';
    /** Raw tool arguments (truncated), shown in the expanded detail view. */
    readonly detailIn?: string;
    /** Tool result text (truncated), shown in the expanded detail view. */
    readonly detailOut?: string;
};
/** A full card snapshot - the single source for every patch. */
export interface CardSnapshot {
    readonly title: string;
    readonly content: string;
    readonly rows: readonly CardRow[];
    readonly status: CardStatus;
    /** Render activity rows with their argument/result details. */
    readonly expanded?: boolean;
}
/**
 * Feishu card markdown is a narrow subset (bold/italic/links; no headings,
 * no tables, no inline code). Degrade unsupported constructs:
 * - headings become one balanced bold line (an opening `**` without its
 *   closer renders as literal text),
 * - GFM tables become a bold header line plus one list line per row,
 * - inline-code backticks are dropped (the text itself stays).
 */
export declare function toFeishuMarkdown(markdown: string): string;
/** Build the streaming-card JSON for one snapshot. */
export declare function buildCard(snapshot: CardSnapshot): unknown;
/**
 * Manages one active streaming card per chat: throttled, coalesced patches;
 * a failed patch never kills the stream (logged, latest snapshot retried).
 */
export declare class StreamingCardManager {
    private readonly transport;
    private readonly active;
    /** The most recently opened card per chat, kept after finalization so
     *  finished cards can still be re-rendered (the detail toggle). */
    private readonly lastMessageIds;
    private readonly throttleMs;
    private readonly logger;
    constructor(transport: LarkTransport, options?: {
        throttleMs?: number;
        logger?: {
            warn(message: string): void;
        };
    });
    /** Open a new streaming card for one chat (flushing any stale one first). */
    open(chatId: string, title: string): Promise<void>;
    /** Stage the next snapshot; flushed after `throttleMs` or in-flight settle. */
    patch(chatId: string, snapshot: CardSnapshot): void;
    /** Mark the card terminal: flush pending content, then retire it. */
    finalize(chatId: string, status: 'done' | 'error' | 'stopped'): Promise<void>;
    /** Whether a chat currently has an active streaming card. */
    isActive(chatId: string): boolean;
    /** Message id of the active card, for button routing. */
    activeMessageId(chatId: string): string | undefined;
    /** Message id of the most recent card (active or finalized), for button routing. */
    lastMessageId(chatId: string): string | undefined;
    /**
     * Re-render a card from a snapshot: staged through the throttle when the
     * card is live, patched directly when it is finalized (the detail toggle
     * on a finished card). No-op when no card exists for the chat.
     */
    refresh(chatId: string, snapshot: CardSnapshot): Promise<void>;
    /** Dispose every active card without further patching. */
    dispose(): void;
    private flush;
}
