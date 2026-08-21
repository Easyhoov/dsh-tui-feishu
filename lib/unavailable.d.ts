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
export declare const TERMINAL_MESSAGE_CODES: ReadonlySet<number>;
/** Whether an API error code means the target message no longer exists. */
export declare function isTerminalMessageCode(code: number | undefined): boolean;
/** Mark a message id as gone (deleted/recalled) until the TTL expires. */
export declare function markUnavailable(messageId: string, code: number): void;
/** Whether a message id is known to be gone. */
export declare function isUnavailable(messageId: string | undefined): boolean;
