/**
 * CardKit (card JSON 2.0) card builders: the streaming placeholder card and
 * the terminal complete card. Ported from hermes-lark-streaming's
 * `cardkit/builder.py`, adapted to dsh-tui-feishu's snapshot/row model and
 * zh/en copy.
 *
 * Card JSON 2.0 notes (verified against the Feishu docs):
 * - buttons use `behaviors: [{ type: 'callback', value: {...} }]` and fire
 *   the `card.action.trigger` callback with `context.open_message_id` and
 *   `context.open_chat_id` - the same callback the v1 cards use, so the
 *   existing bridge button routing works unchanged;
 * - text streaming needs `config.streaming_mode: true`; per-element text is
 *   pushed with the cardkit element-content API.
 *
 * @module dsh-tui-feishu/streaming/cardkit-builder
 */
import { splitLongText } from '../cardmd.js';
import { t } from '../i18n.js';
import { resolveToolDescriptor, toolDisplayTitle } from '../tools.js';
/** Element ids the manager addresses. */
export const KIT_ANSWER_ELEMENT = 'streaming_content';
export const KIT_TOOL_PANEL_ELEMENT = 'tool_panel';
export const KIT_REASONING_PANEL_ELEMENT = 'reasoning_panel';
export const KIT_REASONING_TEXT_ELEMENT = 'reasoning_text';
/** The animated loading icon hermes-lark-streaming ships on streaming cards. */
const LOADING_IMG_KEY = 'img_v3_02vb_496bec09-4b43-4773-ad6b-0cdd103cd2bg';
/** Icon tokens for row statuses (hermes colors). */
const STATUS_INFO = {
    running: { labelKey: 'running', color: 'turquoise' },
    done: { labelKey: 'succeeded', color: 'green' },
    error: { labelKey: 'failed', color: 'red' },
};
function formatElapsed(ms) {
    const seconds = ms / 1000;
    return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}
/** Escape markdown specials for lark_md titles. */
function escapeMd(value) {
    return value.replace(/\\/g, '\\\\').replace(/([`*_{}\[\]<>])/g, '\\$1');
}
/** A collapsible panel (schema 2.0). One icon only: the emoji in the title. */
function collapsiblePanel(options) {
    const panel = {
        tag: 'collapsible_panel',
        expanded: options.expanded,
        header: {
            title: { tag: 'plain_text', content: options.title, text_color: 'grey', text_size: 'notation' },
            vertical_align: 'center',
        },
        border: { color: 'grey', corner_radius: '5px' },
        vertical_spacing: '4px',
        padding: '8px 8px 8px 8px',
        elements: options.elements,
    };
    if (options.elementId !== undefined)
        panel['element_id'] = options.elementId;
    return panel;
}
/** One tool step inside the tool panel (hermes-lark-streaming layout). */
function toolStepElements(row, locale) {
    const statusInfo = STATUS_INFO[row.status];
    const descriptor = resolveToolDescriptor(row.name);
    const title = toolDisplayTitle(row.name);
    const duration = row.durationMs !== undefined ? ` (${formatElapsed(row.durationMs)})` : '';
    const elements = [
        {
            tag: 'div',
            icon: {
                tag: 'standard_icon',
                token: descriptor?.icon ?? 'setting-inter_outlined',
                color: 'grey',
            },
            text: {
                tag: 'lark_md',
                content: `**${escapeMd(title)}${duration}** · <font color='${statusInfo.color}'>${t(statusInfo.labelKey, locale)}</font>`,
                text_size: 'notation',
            },
        },
    ];
    if (row.summary !== '') {
        elements.push({
            tag: 'div',
            margin: '0px 0px 0px 22px',
            text: { tag: 'plain_text', content: row.summary, text_color: 'grey', text_size: 'notation' },
        });
    }
    if (row.detailOut !== undefined && row.detailOut !== '') {
        const label = row.status === 'error' ? t('detailError', locale) : t('detailResult', locale);
        const fence = '```';
        elements.push({
            tag: 'div',
            margin: '0px 0px 0px 22px',
            text: {
                tag: 'lark_md',
                content: `**${label}**\n${fence}text\n${row.detailOut.slice(0, 800)}\n${fence}`,
                text_size: 'notation',
            },
        });
    }
    return elements;
}
/** How many of the NEWEST tool steps render as full rows in the panel. */
const MAX_PANEL_STEPS = 30;
/** History summary entries shown inside the folded history element. */
const MAX_HISTORY_LINES = 20;
/** History text budget (keeps the folded element small). */
const MAX_HISTORY_CHARS = 700;
/** Build the tool panel element from rows (or the pending placeholder).
 *
 *  Long turns keep the panel bounded: only the newest `MAX_PANEL_STEPS` steps
 *  render as full rows; earlier steps fold into one compact history element
 *  (title-only lines) so the card never grows unbounded past the platform's
 *  element budget (a full hermes-style card split stays on the roadmap).
 */
export function buildToolPanel(rows, locale, options = {}) {
    const steps = rows.filter((row) => row.kind === 'tool');
    if (steps.length === 0) {
        // hermes shows a collapsed "tool use pending" panel while waiting.
        return collapsiblePanel({
            title: t('toolPending', locale),
            expanded: false,
            elements: [],
            elementId: options.elementId ?? KIT_TOOL_PANEL_ELEMENT,
        });
    }
    const history = steps.slice(0, Math.max(0, steps.length - MAX_PANEL_STEPS));
    const visible = steps.slice(-MAX_PANEL_STEPS);
    const parts = [`🛠️ ${t('toolUse', locale)}`, t('steps', locale).replace('{}', String(steps.length))];
    const running = steps.filter(step => step.status === 'running').length;
    if (running > 0)
        parts.push(`⏳ ${running}`);
    if (history.length > 0)
        parts.push(`前 ${history.length} 步折叠`);
    const elements = [];
    if (history.length > 0) {
        elements.push(buildToolHistoryElement(history, locale));
    }
    elements.push(...visible.flatMap(step => toolStepElements(step, locale)));
    return collapsiblePanel({
        title: parts.join(' · '),
        expanded: options.expanded ?? true,
        elements,
        elementId: options.elementId ?? KIT_TOOL_PANEL_ELEMENT,
    });
}
/** One compact markdown element summarizing the folded older steps. */
function buildToolHistoryElement(history, locale) {
    const lines = [];
    for (const step of history) {
        if (lines.length >= MAX_HISTORY_LINES)
            break;
        const title = toolDisplayTitle(step.name);
        const label = step.summary === '' ? title : `${title}: ${step.summary}`;
        lines.push(`· ${label}`);
    }
    const omitted = history.length - lines.length;
    if (omitted > 0)
        lines.push(`…（共 ${history.length} 步，更早省略）`);
    let text = `**📜 ${t('toolHistory', locale)}**\n${lines.join('\n')}`;
    if (text.length > MAX_HISTORY_CHARS)
        text = `${text.slice(0, MAX_HISTORY_CHARS)}…`;
    return {
        tag: 'div',
        margin: '0px 0px 0px 0px',
        text: {
            tag: 'lark_md',
            content: text,
            text_color: 'grey',
            text_size: 'notation',
        },
    };
}
/** Build the reasoning panel element from think rows. */
export function buildReasoningPanel(rows, locale, options = {}) {
    const thinkRows = rows.filter((row) => row.kind === 'think');
    const text = thinkRows.map(row => row.text).join('\n');
    // One icon only: the 💭 emoji in the title (no collapsible arrow).
    const label = thinkRows.length === 0 ? t('thinkingPanel', locale) : t('thought', locale);
    return collapsiblePanel({
        title: `💭 ${label}`,
        expanded: options.expanded ?? true,
        elements: [
            {
                tag: 'markdown',
                content: text.slice(0, 600),
                text_size: 'notation',
                // The inner text element must carry a stable id: the manager streams
                // thinking deltas into it (cardkit cardElement.content by element_id).
                element_id: KIT_REASONING_TEXT_ELEMENT,
            },
        ],
        elementId: options.elementId ?? KIT_REASONING_PANEL_ELEMENT,
    });
}
/** Footer lines for the terminal card. */
function footerMarkdown(snapshot, locale) {
    const footer = snapshot.footer;
    const parts = [];
    const status = snapshot.status === 'error'
        ? t('errorNote', locale)
        : snapshot.status === 'stopped'
            ? t('stopped', locale)
            : t('doneNote', locale);
    parts.push(status);
    if (footer?.elapsedMs !== undefined && footer.elapsedMs > 0) {
        parts.push(`${t('elapsed', locale)} ${formatElapsed(footer.elapsedMs)}`);
    }
    if (footer?.model !== undefined && footer.model !== '') {
        parts.push(footer.model);
    }
    return parts.join(' · ');
}
/**
 * The streaming placeholder card, hermes-lark-streaming layout: reasoning
 * panel + tool-use panel (pending placeholder) + answer element in
 * streaming mode + animated loading icon + Stop button.
 */
export function buildCardKitStreamingCard(snapshot, locale, options = {}) {
    const elements = [];
    if (options.showReasoning !== false) {
        elements.push(buildReasoningPanel(snapshot.rows, locale));
    }
    // The tool panel always exists (pending placeholder while idle), so the
    // manager can stream first tool updates into it instead of adding it.
    elements.push(buildToolPanel(snapshot.rows, locale));
    elements.push({
        tag: 'markdown',
        content: snapshot.content || ' ',
        text_size: 'normal_v2',
        margin: '0px 0px 0px 0px',
        element_id: KIT_ANSWER_ELEMENT,
    });
    elements.push({
        tag: 'markdown',
        content: ' ',
        icon: { tag: 'custom_icon', img_key: LOADING_IMG_KEY, size: '16px 16px' },
    });
    // Card JSON 2.0 has no `action` container: interactive components sit
    // directly in body.elements (a v1-style {"tag":"action","actions":[...]}
    // wrapper is rejected with code 200861).
    elements.push({
        tag: 'button',
        element_id: 'btn_stop',
        text: { tag: 'plain_text', content: t('stopButton', locale) },
        type: 'danger',
        size: 'small',
        behaviors: [{ type: 'callback', value: { kind: 'stop' } }],
    });
    // No card header (hermes's default: header.enabled=false) - the status
    // lives in the footer of the terminal card and the loading icon/panels of
    // the streaming card.
    return {
        schema: '2.0',
        config: {
            streaming_mode: true,
            streaming_config: {
                print_frequency_ms: { default: 15 },
                print_step: { default: 1 },
                print_strategy: 'fast',
            },
            wide_screen_mode: true,
            summary: { content: snapshot.title.slice(0, 120) },
        },
        body: { elements },
    };
}
/** The terminal card: panels + answer chunks + footer (streaming off). */
export function buildCardKitCompleteCard(snapshot, locale, options = {}) {
    const elements = [];
    const thinkRows = snapshot.rows.filter(row => row.kind === 'think');
    const toolRows = snapshot.rows.filter(row => row.kind === 'tool');
    if (options.showReasoning !== false && thinkRows.length > 0) {
        elements.push(buildReasoningPanel(thinkRows, locale, { expanded: false }));
    }
    if (toolRows.length > 0) {
        elements.push(buildToolPanel(toolRows, locale, { expanded: snapshot.expanded === true }));
    }
    const body = snapshot.content.trim();
    if (body !== '') {
        for (const chunk of splitLongText(body)) {
            elements.push({ tag: 'markdown', content: chunk, text_size: 'normal_v2' });
        }
    }
    const footer = footerMarkdown(snapshot, locale);
    elements.push({ tag: 'hr' });
    // Card JSON 2.0 has no `note` component; render the footer as markdown.
    elements.push({ tag: 'markdown', content: footer, text_size: 'notation' });
    if (toolRows.length > 0) {
        elements.push({
            tag: 'button',
            element_id: 'btn_detail',
            text: { tag: 'plain_text', content: snapshot.expanded === true ? '🔼 收起' : '🔍 详情' },
            type: 'default',
            behaviors: [{ type: 'callback', value: { kind: 'detail' } }],
        });
    }
    return {
        schema: '2.0',
        config: {
            wide_screen_mode: true,
            update_multi: true,
            summary: { content: (snapshot.content || snapshot.title).slice(0, 120) },
        },
        body: { elements },
    };
}
