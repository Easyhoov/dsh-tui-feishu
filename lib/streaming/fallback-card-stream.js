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
import { FeishuApiError } from '../transport.js';
/** Whether one engine should be replaced after an `open()` failure. */
function isBusinessRejection(error) {
    return error instanceof FeishuApiError;
}
export class FallbackCardStream {
    engine;
    fallbackFactory;
    enabled;
    logger;
    /** Exactly one swap per bridge lifetime (plan §2.6). */
    swapped = false;
    constructor(options) {
        this.engine = options.primary;
        this.fallbackFactory = options.fallback;
        this.enabled = options.enabled ?? true;
        this.logger = options.logger ?? { info: () => { }, warn: () => { } };
    }
    /** The engine currently serving (exposed for tests / /status surfaces). */
    currentEngine() {
        return this.swapped ? 'v1' : 'cardkit';
    }
    async open(chatId, title) {
        try {
            await this.engine.open(chatId, title);
        }
        catch (error) {
            if (this.swapped || !this.enabled || !isBusinessRejection(error))
                throw error;
            this.logger.warn(`cardkit turn card rejected at open (code ${error.code}: ${error.message}); ` +
                'swapping to the v1 card engine once and retrying (config cardEngineFallback=false disables)');
            this.swap();
            await this.engine.open(chatId, title);
            this.logger.info('card engine auto-downgraded to v1 after a CardKit open rejection');
        }
    }
    patch(chatId, snapshot) {
        this.engine.patch(chatId, snapshot);
    }
    finalize(chatId, status, footer, snapshot) {
        return this.engine.finalize(chatId, status, footer, snapshot);
    }
    isActive(chatId) {
        return this.engine.isActive(chatId);
    }
    activeMessageId(chatId) {
        return this.engine.activeMessageId(chatId);
    }
    lastMessageId(chatId) {
        return this.engine.lastMessageId(chatId);
    }
    refresh(chatId, snapshot) {
        return this.engine.refresh(chatId, snapshot);
    }
    dispose() {
        this.engine.dispose();
    }
    swap() {
        try {
            this.engine.dispose();
        }
        catch (error) {
            this.logger.warn(`cardkit engine dispose failed during downgrade: ${String(error)}`);
        }
        this.engine = this.fallbackFactory();
        this.swapped = true;
    }
}
