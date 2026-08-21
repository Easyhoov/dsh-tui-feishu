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
/** Key/flag names that look like credentials (checked case-insensitively). */
const SENSITIVE_NAME = /token|secret|password|api[_-]?key|authorization|cookie|credential|bearer|session[_-]?id|client[_-]?secret|access[_-]?key/i;
/** `key=value` inline assignments (quoted or bare values). */
const INLINE_ASSIGNMENT = /(^|[\s"'`])([A-Za-z_][A-Za-z0-9_]*)(=(?:"[^"]*"|'[^']*'|[^\s"'`]+))/g;
/** `Authorization: Bearer|Basic|Token <credential>` headers. */
const AUTH_HEADER = /(Authorization\s*:\s*(?:Bearer|Basic|Token)\s+)([^'"\s]+)/gi;
/** `--flag value` / `-f value` pairs (quoted or bare values). */
const SECRET_FLAG = /(^|[\s"'`])(--?[A-Za-z0-9][A-Za-z0-9-]*)(=|\s+)("[^"]*"|'[^']*'|[^\s"'`]+)/g;
/** Path-like tokens: `~/x`, `./x`, `/x` or `a/b` starting with a dot or slash. */
const PATH_LIKE = /(^|[\s='"()])([~./][^\s'"()]+)/g;
/**
 * Redact credential-looking values from a text blob:
 * - `key=secret` inline assignments whose key matches a sensitive name
 * - `Authorization: <scheme> <value>` headers
 * - `--flag <value>` pairs whose flag matches a sensitive name
 *
 * Non-sensitive assignments are left untouched. Idempotent.
 */
export function redactInlineSecrets(value) {
    const redactAssign = (match, lead, key) => SENSITIVE_NAME.test(key) ? `${lead}${key}=[redacted]` : match;
    const redactFlag = (match, lead, flag, sep) => SENSITIVE_NAME.test(flag.replace(/^-+/, '')) ? `${lead}${flag}${sep}[redacted]` : match;
    return value
        .replace(INLINE_ASSIGNMENT, redactAssign)
        .replace(AUTH_HEADER, '$1[redacted]')
        .replace(SECRET_FLAG, redactFlag);
}
/** Keep only the basename of a path-like string (POSIX or Windows separators). */
export function basenameOnly(text) {
    if (text === '')
        return text;
    const normalized = text.replace(/\\/g, '/').replace(/\/+$/, '');
    if (normalized === '')
        return text;
    const parts = normalized.split('/');
    const last = parts[parts.length - 1];
    return last === undefined || last === '' ? text : last;
}
/** Reduce path-like tokens in a command/script to their basenames. */
export function redactPaths(text) {
    return text.replace(PATH_LIKE, (match, lead, path) => `${lead}${basenameOnly(path)}`);
}
/** Strip leading/trailing quote characters (Python `str.strip("'\"")`). */
function stripQuotes(text) {
    return text.replace(/^['"]+/, '').replace(/['"]+$/, '');
}
/**
 * Sanitize one tool-detail string according to its tool's sanitizer kind:
 * - `command` - redact inline secrets, then reduce paths to basenames
 * - `path` - keep only the basename
 * - `search` - strip surrounding quotes
 * - `url` - drop a leading "from ", strip surrounding quotes
 * - anything else (or empty after HTML-stripping) - unchanged
 */
export function sanitizeToolDetail(text, sanitizer) {
    if (text === '' || sanitizer === undefined)
        return text;
    const cleaned = text.replace(/<[^>]+>/g, '').trim();
    if (cleaned === '')
        return text;
    switch (sanitizer) {
        case 'command':
            return redactPaths(redactInlineSecrets(cleaned));
        case 'path':
            return basenameOnly(cleaned.replace(/^(?:from|file|path)\s+/, '').trim());
        case 'search':
            return stripQuotes(cleaned);
        case 'url':
            return stripQuotes(cleaned.replace(/^from\s+/i, ''));
        default:
            return cleaned;
    }
}
