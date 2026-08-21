/**
 * Secret redaction and tool-detail sanitizers.
 *
 * Everything that leaves the host and renders in Feishu - streaming-card
 * tool rows, detail blocks, approval cards - must pass through here first.
 * Ported from hermes-lark-streaming's `streaming/tooluse.py` (redaction
 * patterns) so the same leak classes stay covered on this side.
 *
 * @module dsh-tui-feishu/redact
 */
/**
 * Redact credential-looking values from a text blob:
 * - `key=secret` inline assignments whose key matches a sensitive name
 * - `Authorization: <scheme> <value>` headers
 * - `--flag <value>` pairs whose flag matches a sensitive name
 *
 * Non-sensitive assignments are left untouched. Idempotent.
 */
export declare function redactInlineSecrets(value: string): string;
/** Keep only the basename of a path-like string (POSIX or Windows separators). */
export declare function basenameOnly(text: string): string;
/** Reduce path-like tokens in a command/script to their basenames. */
export declare function redactPaths(text: string): string;
/**
 * Sanitize one tool-detail string according to its tool's sanitizer kind:
 * - `command` - redact inline secrets, then reduce paths to basenames
 * - `path` - keep only the basename
 * - `search` - strip surrounding quotes
 * - `url` - drop a leading "from ", strip surrounding quotes
 * - anything else (or empty after HTML-stripping) - unchanged
 */
export declare function sanitizeToolDetail(text: string, sanitizer: string | undefined): string;
