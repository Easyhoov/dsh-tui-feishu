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
import { toolDisplayTitle } from '../tools.js';
/** Element ids the manager addresses. */
export const KIT_ANSWER_ELEMENT = 'streaming_content';
export const KIT_TOOL_PANEL_ELEMENT = 'tool_panel';
export const KIT_REASONING_PANEL_ELEMENT = 'reasoning_panel';
export const KIT_REASONING_TEXT_ELEMENT = 'reasoning_text';
/** Icon tokens for row statuses. */
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
/** A collapsible panel (schema 2.0). */
function collapsiblePanel(options) {
    const panel = {
        tag: 'collapsible_panel',
        expanded: options.expanded,
        header: {
            title: { tag: 'plain_text', content: options.title, text_color: 'grey', text_size: 'notation' },
            vertical_align: 'center',
            icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', color: 'grey', size: '16px 16px' },
            icon_position: 'right',
            icon_expanded_angle: -180,
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
/** One tool step inside the tool panel. */
function toolStepElements(row, locale) {
    const statusInfo = STATUS_INFO[row.status];
    const title = toolDisplayTitle(row.name);
    const duration = row.durationMs !== undefined ? ` (${formatElapsed(row.durationMs)})` : '';
    const elements = [
        {
            tag: 'div',
            icon: { tag: 'standard_icon', token: 'tool_02', color: 'grey' },
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
/** Build the tool panel element from rows. */
export function buildToolPanel(rows, locale, options = {}) {
    const steps = rows.filter((row) => row.kind === 'tool');
    const running = steps.filter(step => step.status === 'running').length;
    const parts = [t('toolsTitle', locale)];
    if (steps.length > 0)
        parts.push(t('steps', locale).replace('{}', String(steps.length)));
    if (running > 0)
        parts.push(`⏳ ${running}`);
    return collapsiblePanel({
        title: parts.join(' · '),
        expanded: options.expanded ?? true,
        elements: steps.slice(0, 30).flatMap(step => toolStepElements(step, locale)),
        elementId: options.elementId ?? KIT_TOOL_PANEL_ELEMENT,
    });
}
/** Build the reasoning panel element from think rows. */
export function buildReasoningPanel(rows, locale, options = {}) {
    const thinkRows = rows.filter((row) => row.kind === 'think');
    const text = thinkRows.map(row => row.text).join('\n');
    const label = thinkRows.length === 0 ? t('thinking', locale) : t('thought', locale);
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
        parts.push(`${t('model', locale)} ${footer.model}`);
    }
    return parts.join(' · ');
}
/**
 * The streaming placeholder card: reasoning + tool panels (empty placeholders
 * are omitted), one answer element in streaming mode, plus a Stop button.
 */
export function buildCardKitStreamingCard(snapshot, locale, options = {}) {
    const elements = [];
    if (options.showReasoning !== false) {
        elements.push(buildReasoningPanel(snapshot.rows, locale));
    }
    if (snapshot.rows.some(row => row.kind === 'tool')) {
        elements.push(buildToolPanel(snapshot.rows, locale));
    }
    elements.push({
        tag: 'markdown',
        content: snapshot.content || ' ',
        text_size: 'normal_v2',
        margin: '0px 0px 0px 0px',
        element_id: KIT_ANSWER_ELEMENT,
    });
    // Card JSON 2.0 has no `action` container: interactive components sit
    // directly in body.elements (a v1-style {"tag":"action","actions":[...]}
    // wrapper is rejected with code 200861).
    elements.push({
        tag: 'button',
        element_id: 'btn_stop',
        text: { tag: 'plain_text', content: '⏹ Stop' },
        type: 'danger',
        behaviors: [{ type: 'callback', value: { kind: 'stop' } }],
    });
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
        header: {
            title: { tag: 'plain_text', content: snapshot.title },
            template: 'blue',
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
    const template = snapshot.status === 'error' ? 'red' : snapshot.status === 'stopped' ? 'grey' : 'green';
    return {
        schema: '2.0',
        config: {
            wide_screen_mode: true,
            update_multi: true,
            summary: { content: (snapshot.content || snapshot.title).slice(0, 120) },
        },
        header: {
            title: { tag: 'plain_text', content: snapshot.title },
            template,
        },
        body: { elements },
    };
}
