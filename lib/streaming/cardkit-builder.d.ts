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
import type { CardRow, CardSnapshot } from '../cards.js';
import { type CardLocale } from '../i18n.js';
/** Element ids the manager addresses. */
export declare const KIT_ANSWER_ELEMENT = "streaming_content";
export declare const KIT_TOOL_PANEL_ELEMENT = "tool_panel";
export declare const KIT_REASONING_PANEL_ELEMENT = "reasoning_panel";
export declare const KIT_REASONING_TEXT_ELEMENT = "reasoning_text";
/** Build the tool panel element from rows (or the pending placeholder).
 *
 *  Long turns keep the panel bounded: only the newest `MAX_PANEL_STEPS` steps
 *  render as full rows; earlier steps fold into one compact history element
 *  (title-only lines) so the card never grows unbounded past the platform's
 *  element budget (a full hermes-style card split stays on the roadmap).
 */
export declare function buildToolPanel(rows: readonly CardRow[], locale: CardLocale, options?: {
    expanded?: boolean;
    elementId?: string;
}): Record<string, unknown>;
/** Build the reasoning panel element from think rows. */
export declare function buildReasoningPanel(rows: readonly CardRow[], locale: CardLocale, options?: {
    expanded?: boolean;
    elementId?: string;
}): Record<string, unknown>;
/**
 * The streaming placeholder card, hermes-lark-streaming layout: reasoning
 * panel + tool-use panel (pending placeholder) + answer element in
 * streaming mode + animated loading icon + Stop button.
 */
export declare function buildCardKitStreamingCard(snapshot: CardSnapshot, locale: CardLocale, options?: {
    showReasoning?: boolean;
}): Record<string, unknown>;
/** The terminal card: panels + answer chunks + footer (streaming off). */
export declare function buildCardKitCompleteCard(snapshot: CardSnapshot, locale: CardLocale, options?: {
    showReasoning?: boolean;
}): Record<string, unknown>;
