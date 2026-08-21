/**
 * Markdown text handling for Feishu cards.
 *
 * Feishu card markdown is a narrow subset: headings render oddly, GFM
 * tables are unreliable, inline images need platform `img_key`s. These
 * helpers degrade unsupported constructs and keep long bodies chunked.
 * Ported from hermes-lark-streaming's `cardkit/markdown.py` and
 * `streaming/text.py`.
 *
 * @module dsh-tui-feishu/cardmd
 */
/**
 * Remove `<think>…</think>`-style reasoning blocks (and an unclosed tail)
 * from answer text so internal reasoning never reaches the card. Blocks are
 * removed before lone tags so fully-tagged content disappears entirely.
 * Text that starts with a "Reasoning:" prefix is treated as reasoning-only
 * and discarded (hermes-lark-streaming semantics).
 */
export declare function stripReasoningTags(text: string): string;
/**
 * Downgrade tables beyond `limit` to fenced code blocks (content stays
 * visible, but Feishu does not try to render them as table elements).
 */
export declare function downgradeTables(text: string, limit?: number): string;
/** Remove markdown image references that are not Feishu `img_key`s. */
export declare function stripInvalidImageKeys(text: string): string;
/**
 * Optimize body markdown for Feishu rendering:
 * 1. protect fenced code blocks, 2. downgrade headings (H1 → H4, H2-6 → H5),
 * 3. restore code blocks, 4. collapse excess blank lines, 5. strip invalid
 * image keys. Failures return the input unchanged.
 */
export declare function optimizeMarkdown(text: string): string;
/**
 * Split a long body into chunks of at most `limit` chars, cutting at
 * paragraph/line boundaries when possible.
 */
export declare function splitLongText(text: string, limit?: number): string[];
/** Wrap content in a markdown code fence sized past any inner backticks. */
export declare function formatCodeBlock(content: string, language?: string): string;
/** Pretty-print JSON-ish text; non-JSON returns the original text. */
export declare function prettyJsonOrText(value: string): {
    language: string;
    text: string;
};
