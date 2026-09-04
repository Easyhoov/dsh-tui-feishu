/**
 * CardKit → v1 engine fallback (plan §2.6: auto-downgrade after card 2.0
 * became the default engine).
 *
 * Apps that predate card JSON 2.0 / CardKit (or lack the cardkit permission)
 * reject the very first `cardkitCreate`/`cardkitSendToChat` with a permanent
 * business error. Without a fallback the whole turn degrades to plain text
 * (the bridge's fail-safe) even though the same app renders v1 cards fine.
 *
 * This wrapper owns the engine choice for the bridge and swaps it exactly
 * once per bridge lifetime: when `open()` fails on the primary (CardKit)
 * engine with a business-level `FeishuApiError` (transient codes and network
 * failures are already retried inside the transport, so a surfaced error is
 * a permanent platform rejection), the CardKit manager is disposed, the v1
 * `StreamingCardManager` takes over and the same `open()` is retried. Every
 * other `CardStream` call delegates to the current engine, so the bridge
 * stays engine-agnostic.
 *
 * The swap is conservative by construction:
 * - only the *first* turn-card open triggers it (one swap per process);
 * - only business rejections trigger it (a network hiccup never flips the
 *   engine);
 * - a payload-shaped rejection (e.g. element-count 300305) still lands on
 *   v1 instead of losing the card — strictly better availability, and the
 *   swap is logged loudly with the platform code/msg for diagnosis;
 * - `enabled: false` (config `cardEngineFallback: false`) keeps the old
 *   behavior: the open failure propagates and the bridge falls back to
 *   plain text at turn end.
 *
 * @module dsh-tui-feishu/streaming/fallback-card-stream
 */
import type { CardFooter, CardSnapshot, CardStream } from '../cards.js';
/** Minimal logger surface the wrapper needs. */
export interface FallbackLogger {
    info(message: string): void;
    warn(message: string): void;
}
/** Options for the fallback wrapper. */
export interface FallbackCardStreamOptions {
    /** The engine used first (the CardKit streaming manager). */
    readonly primary: CardStream;
    /**
     * Factory for the fallback engine (the v1 streaming manager), invoked at
     * swap time so the failed primary is disposed before its replacement is
     * built.
     */
    readonly fallback: () => CardStream;
    /** Auto-downgrade on a business-level open failure (default true). */
    readonly enabled?: boolean;
    readonly logger?: FallbackLogger;
}
export declare class FallbackCardStream implements CardStream {
    private engine;
    private readonly fallbackFactory;
    private readonly enabled;
    private readonly logger;
    /** Exactly one swap per bridge lifetime (plan §2.6). */
    private swapped;
    constructor(options: FallbackCardStreamOptions);
    /** The engine currently serving (exposed for tests / /status surfaces). */
    currentEngine(): 'cardkit' | 'v1';
    open(chatId: string, title: string): Promise<void>;
    patch(chatId: string, snapshot: CardSnapshot): void;
    finalize(chatId: string, status: 'done' | 'error' | 'stopped', footer?: CardFooter, snapshot?: CardSnapshot): Promise<boolean>;
    isActive(chatId: string): boolean;
    activeMessageId(chatId: string): string | undefined;
    lastMessageId(chatId: string): string | undefined;
    refresh(chatId: string, snapshot: CardSnapshot): Promise<void>;
    dispose(): void;
    private swap;
}
