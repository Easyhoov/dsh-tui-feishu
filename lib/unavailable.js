/**
 * Message-unavailability tracking.
 *
 * When a Feishu API call reports that a message was deleted or recalled,
 * patching it again will keep failing. Remember such message ids for a
 * bounded TTL so downstream pipelines can stop immediately instead of
 * retrying a dead card. Ported from hermes-lark-streaming's
 * `streaming/unavailable_guard.py`.
 *
 * @module dsh-tui-feishu/unavailable
 */
/** Feishu codes that mean the message is gone for good. */
export const TERMINAL_MESSAGE_CODES = new Set([
    1000023, // message not found / deleted
    231003, // message deleted
    230011, // message recalled
]);
/** Whether an API error code means the target message no longer exists. */
export function isTerminalMessageCode(code) {
    return code !== undefined && TERMINAL_MESSAGE_CODES.has(code);
}
/** How long a "message unavailable" record stays valid. */
const UNAVAILABLE_TTL_MS = 30 * 60_000;
const unavailable = new Map();
function prune() {
    const now = Date.now();
    for (const [id, record] of unavailable) {
        if (now - record.at > UNAVAILABLE_TTL_MS)
            unavailable.delete(id);
    }
}
/** Mark a message id as gone (deleted/recalled) until the TTL expires. */
export function markUnavailable(messageId, code) {
    prune();
    unavailable.set(messageId, { code, at: Date.now() });
}
/** Whether a message id is known to be gone. */
export function isUnavailable(messageId) {
    if (messageId === undefined || messageId === '')
        return false;
    prune();
    return unavailable.has(messageId);
}
