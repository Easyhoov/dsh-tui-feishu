/**
 * Inbound content sanitizer: strip terminal escape sequences, control
 * characters, and bidi/invisible marks from platform-supplied text before it
 * is embedded into model prompts. Pure functions, ported from dsh-im's
 * reply-reference.mjs cleaning rules (see SPEC §4.3).
 */
/** OSC (ESC ] … BEL/ST), CSI (ESC [ … final), and bare ESC sequences. */
const OSC_SEQUENCE = /(?:\u001b\]|\u009d)(?:(?!\u0007|\u001b\\)[\s\S])*(?:\u0007|\u001b\\|$)/gu;
const CSI_SEQUENCE = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/gu;
const ESC_SEQUENCE = /\u001b[@-_]/gu;
/** C0 controls except \n, DEL, and C1 controls. */
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;
/** All C0 controls including \n (for single-line fields). */
const CONTROL_WITH_NEWLINE = /[\u0000-\u001f\u007f-\u009f]/gu;
/** Zero-width, bidi (LRM/RLM/embeds/overrides/isolates), and BOM marks. */
const DIRECTIONAL_CONTROL = /[\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/gu;
/** Private-use characters (tag smuggle / vendor-specific glyphs). */
const PRIVATE_USE = /[\ue000-\uf8ff]/gu;
function codePointLength(value) {
    return [...value].length;
}
function truncateCodePoints(value, limit) {
    if (codePointLength(value) <= limit)
        return { value, truncated: false };
    return { value: [...value].slice(0, limit).join(''), truncated: true };
}
/**
 * Clean one platform-supplied string: strip escape/control/bidi characters,
 * normalize newlines, fold whitespace (unless multiline), trim, and enforce a
 * code-point limit. Non-strings return `{value: undefined, truncated: false}`.
 */
export function cleanString(value, limit, options = {}) {
    if (typeof value !== 'string')
        return { value: undefined, truncated: false };
    let cleaned = value.replace(/\r\n?/gu, '\n');
    cleaned = cleaned
        .replace(OSC_SEQUENCE, '')
        .replace(CSI_SEQUENCE, '')
        .replace(ESC_SEQUENCE, '')
        .replace(options.multiline === true ? CONTROL_CHARACTER : CONTROL_WITH_NEWLINE, ' ')
        .replace(DIRECTIONAL_CONTROL, '')
        .replace(PRIVATE_USE, '');
    if (options.basename === true) {
        cleaned = cleaned.replaceAll('\\', '/').split('/').at(-1) ?? '';
    }
    if (options.multiline !== true)
        cleaned = cleaned.replace(/\s+/gu, ' ');
    cleaned = cleaned.trim();
    if (cleaned === '')
        return { value: undefined, truncated: false };
    return truncateCodePoints(cleaned, limit);
}
/**
 * Escape `<`, `>`, `&` as \uXXXX so JSON embedded inside an XML-like prompt
 * tag cannot break out of the tag.
 */
export function escapeForTag(json) {
    return json.replace(/[<>&]/gu, (character) => character === '<' ? '\\u003c' : character === '>' ? '\\u003e' : '\\u0026');
}
