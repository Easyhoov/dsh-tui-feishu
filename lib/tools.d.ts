/**
 * Tool descriptors: per-tool display metadata (icon, human title) and the
 * sanitizer kind applied to its arguments/results before anything reaches a
 * Feishu card. Ported from hermes-lark-streaming's `streaming/tooluse.py`.
 *
 * @module dsh-tui-feishu/tools
 */
/** One known tool shape. */
export interface ToolDescriptor {
    /** Tool-name prefixes/aliases that map to this descriptor. */
    readonly aliases: readonly string[];
    /** Feishu standard icon token for the activity row. */
    readonly icon: string;
    /** Human-readable tool title. */
    readonly title: string;
    /** Detail sanitizer kind (see `sanitizeToolDetail`). */
    readonly sanitizer?: 'command' | 'path' | 'search' | 'url';
    /** Tools whose results are not shown on the card. */
    readonly noResult?: boolean;
}
/** The descriptor roster (order matters: first alias match wins). */
export declare const TOOL_DESCRIPTORS: readonly ToolDescriptor[];
/**
 * Resolve the descriptor for a tool name: normalized exact alias or
 * `alias_*` prefix match, else `undefined` for unknown tools.
 */
export declare function resolveToolDescriptor(name: string | undefined): ToolDescriptor | undefined;
/** Humanize a raw tool name: `web_search` → `Web search`. */
export declare function humanizeToolName(name: string): string;
/** The descriptor's display title for a tool name (falls back to humanized). */
export declare function toolDisplayTitle(name: string): string;
