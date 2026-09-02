/**
 * Inbound content sanitizer: strip terminal escape sequences, control
 * characters, and bidi/invisible marks from platform-supplied text before it
 * is embedded into model prompts. Pure functions, ported from dsh-im's
 * reply-reference.mjs cleaning rules (see SPEC §4.3).
 */
export interface CleanOptions {
    /** Keep newlines (multi-line content); default folds all whitespace. */
    readonly multiline?: boolean;
    /** Reduce a path-like value to its basename; also normalizes backslashes. */
    readonly basename?: boolean;
}
export interface Cleaned {
    readonly value: string | undefined;
    readonly truncated: boolean;
}
/**
 * Clean one platform-supplied string: strip escape/control/bidi characters,
 * normalize newlines, fold whitespace (unless multiline), trim, and enforce a
 * code-point limit. Non-strings return `{value: undefined, truncated: false}`.
 */
export declare function cleanString(value: unknown, limit: number, options?: CleanOptions): Cleaned;
/**
 * Escape `<`, `>`, `&` as \uXXXX so JSON embedded inside an XML-like prompt
 * tag cannot break out of the tag.
 */
export declare function escapeForTag(json: string): string;
