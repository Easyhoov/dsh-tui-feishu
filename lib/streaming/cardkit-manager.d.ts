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
import type { CardFooter, CardSnapshot, CardStream } from '../cards.js';
import type { CardLocale } from '../i18n.js';
import type { LarkTransport } from '../transport.js';
export declare class CardKitStreamingManager implements CardStream {
    private readonly transport;
    private readonly active;
    /** The most recent CardKit card per chat, for the detail toggle on finished cards. */
    private readonly lastCards;
    private readonly throttleMs;
    private readonly cardTtlMs;
    private readonly locale;
    private readonly showReasoning;
    private readonly sweepTimer;
    private readonly logger;
    constructor(transport: LarkTransport, options?: {
        throttleMs?: number;
        cardTtlMs?: number;
        sweepIntervalMs?: number;
        locale?: CardLocale;
        showReasoning?: boolean;
        logger?: {
            info?(message: string): void;
            warn(message: string): void;
        };
    });
    /** Create the streaming placeholder card (typing mode on). */
    open(chatId: string, title: string): Promise<void>;
    /** Stage the next snapshot; flushed after `throttleMs` or in-flight settle. */
    patch(chatId: string, snapshot: CardSnapshot): void;
    /** Close streaming, replace with the terminal card, retire. */
    finalize(chatId: string, status: 'done' | 'error' | 'stopped', footer?: CardFooter, snapshot?: CardSnapshot): Promise<void>;
    isActive(chatId: string): boolean;
    activeMessageId(chatId: string): string | undefined;
    lastMessageId(chatId: string): string | undefined;
    /** Re-render a finished card (the detail toggle) via a full CardKit update. */
    refresh(chatId: string, snapshot: CardSnapshot): Promise<void>;
    dispose(): void;
    private flush;
    /** Push one snapshot to the platform; false retires the card on failure. */
    private apply;
    /** Retire cards idle past the TTL. */
    private sweepStale;
}
