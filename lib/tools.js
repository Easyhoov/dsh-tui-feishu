/**
 * Tool descriptors: per-tool display metadata (icon, human title) and the
 * sanitizer kind applied to its arguments/results before anything reaches a
 * Feishu card. Ported from hermes-lark-streaming's `streaming/tooluse.py`.
 *
 * @module dsh-tui-feishu/tools
 */
/** The descriptor roster (order matters: first alias match wins). */
export const TOOL_DESCRIPTORS = [
    { aliases: ['skill'], icon: 'app-default_outlined', title: 'Load skill' },
    { aliases: ['read', 'open'], icon: 'file-link-text_outlined', title: 'Read', sanitizer: 'path', noResult: true },
    { aliases: ['write', 'edit'], icon: 'edit_outlined', title: 'Edit', sanitizer: 'path', noResult: true },
    { aliases: ['web_search', 'web-search', 'search'], icon: 'search_outlined', title: 'Search', sanitizer: 'search' },
    { aliases: ['web_fetch', 'web-fetch', 'fetch'], icon: 'language_outlined', title: 'Fetch web page', sanitizer: 'url', noResult: true },
    { aliases: ['grep'], icon: 'doc-search_outlined', title: 'Search text', sanitizer: 'search' },
    { aliases: ['glob'], icon: 'folder_outlined', title: 'Search files', sanitizer: 'path' },
    { aliases: ['exec', 'bash', 'command', 'run'], icon: 'setting_outlined', title: 'Run command', sanitizer: 'command' },
    { aliases: ['browser', 'playwright', 'navigate'], icon: 'browser-mac_outlined', title: 'Browser', noResult: true },
    { aliases: ['agent', 'task', 'spawn'], icon: 'robot_outlined', title: 'Run sub-agent' },
    { aliases: ['check', 'determine', 'verify'], icon: 'list-check_outlined', title: 'Check' },
    { aliases: ['summarize', 'analyze', 'prepare'], icon: 'report_outlined', title: 'Analyze' },
    { aliases: ['clarify'], icon: 'chat_outlined', title: 'Clarify', noResult: true },
];
/**
 * Resolve the descriptor for a tool name: normalized exact alias or
 * `alias_*` prefix match, else `undefined` for unknown tools.
 */
export function resolveToolDescriptor(name) {
    if (name === undefined || name === '')
        return undefined;
    const normalized = name.trim().toLowerCase().replace(/-/g, '_');
    for (const descriptor of TOOL_DESCRIPTORS) {
        for (const alias of descriptor.aliases) {
            if (normalized === alias || normalized.startsWith(`${alias}_`))
                return descriptor;
        }
    }
    return undefined;
}
/** Humanize a raw tool name: `web_search` → `Web search`. */
export function humanizeToolName(name) {
    const cleaned = name.replace(/-/g, ' ').replace(/_/g, ' ').trim();
    if (cleaned === '')
        return 'Tool';
    return cleaned[0]?.toUpperCase() + cleaned.slice(1);
}
/** The descriptor's display title for a tool name (falls back to humanized). */
export function toolDisplayTitle(name) {
    return resolveToolDescriptor(name)?.title ?? humanizeToolName(name);
}
