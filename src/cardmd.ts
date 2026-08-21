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

/** Reasoning delimiters Hermes-style models may emit in answer text. */
const REASONING_TAG = '(?:think(?:ing)?|thought|antthinking)'
const REASONING_OPEN = new RegExp(`<\\s*${REASONING_TAG}\\s*>`, 'gi')
const REASONING_CLOSE = new RegExp(`<\\s*/\\s*${REASONING_TAG}\\s*>`, 'gi')
const REASONING_BLOCK = new RegExp(
  `<\\s*${REASONING_TAG}\\s*>[\\s\\S]*?<\\s*/\\s*${REASONING_TAG}\\s*>`,
  'gi',
)
const REASONING_TAIL = new RegExp(`<\\s*${REASONING_TAG}\\s*>[\\s\\S]*$`, 'gi')

/**
 * Remove `<think>…</think>`-style reasoning blocks (and an unclosed tail)
 * from answer text so internal reasoning never reaches the card. Blocks are
 * removed before lone tags so fully-tagged content disappears entirely.
 * Text that starts with a "Reasoning:" prefix is treated as reasoning-only
 * and discarded (hermes-lark-streaming semantics).
 */
export function stripReasoningTags(text: string): string {
  let result = text
    .replace(REASONING_BLOCK, '')
    .replace(REASONING_TAIL, '')
    .replace(REASONING_OPEN, '')
    .replace(REASONING_CLOSE, '')
  if (result.trimStart().startsWith('Reasoning:')) return ''
  return result
}

/** How many GFM tables a card body may keep before downgrading the rest. */
const MAX_CARD_TABLES = 5
/** Per-element body chunk cap (Feishu markdown elements stay small). */
const MAX_CHUNK_CHARS = 2400

/** Table blocks outside fenced code: [start, end, raw]. */
function findTablesOutsideCodeBlocks(text: string): [number, number, string][] {
  const codeRanges: [number, number][] = []
  for (const match of text.matchAll(/```[\s\S]*?```/g)) {
    codeRanges.push([match.index, match.index + match[0].length])
  }
  const inCode = (index: number): boolean =>
    codeRanges.some(([start, end]) => index >= start && index < end)
  const results: [number, number, string][] = []
  const tableRe = /\|.+\|\n\|[-:| ]+\|[\s\S]*?(?=\n\n|\n(?!\|)|$)/g
  for (const match of text.matchAll(tableRe)) {
    if (match.index === undefined || inCode(match.index)) continue
    results.push([match.index, match.index + match[0].length, match[0]])
  }
  return results
}

/**
 * Downgrade tables beyond `limit` to fenced code blocks (content stays
 * visible, but Feishu does not try to render them as table elements).
 */
export function downgradeTables(text: string, limit: number = MAX_CARD_TABLES): string {
  const matches = findTablesOutsideCodeBlocks(text)
  if (matches.length <= limit) return text
  let result = text
  for (const [start, end, raw] of matches.slice(limit).reverse()) {
    result = `${result.slice(0, start)}\`\`\`\n${raw}\`\`\`${result.slice(end)}`
  }
  return result
}

/** Remove markdown image references that are not Feishu `img_key`s. */
export function stripInvalidImageKeys(text: string): string {
  if (!text.includes('![')) return text
  return text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (match, _alt: string, url: string) =>
    url.startsWith('img_') ? match : '',
  )
}

/**
 * Optimize body markdown for Feishu rendering:
 * 1. protect fenced code blocks, 2. downgrade headings (H1 → H4, H2-6 → H5),
 * 3. restore code blocks, 4. collapse excess blank lines, 5. strip invalid
 * image keys. Failures return the input unchanged.
 */
export function optimizeMarkdown(text: string): string {
  try {
    const mark = '___CB_'
    const codeBlocks: string[] = []
    let result = text.replace(/(^|\n)(`{3,})([^\n]*)\n[\s\S]*?\n\2(?=\n|$)/g, (match, lead: string) => {
      const block = match.slice((lead ?? '').length)
      const index = codeBlocks.length
      codeBlocks.push(block)
      return `${lead ?? ''}${mark}${index}___`
    })
    if (/^#{1,3} /m.test(result)) {
      result = result.replace(/^#{2,6} (.+)$/gm, '##### $1')
      result = result.replace(/^# (.+)$/gm, '#### $1')
    }
    for (let i = 0; i < codeBlocks.length; i += 1) {
      result = result.replace(`${mark}${i}___`, codeBlocks[i] ?? '')
    }
    result = result.replace(/\n{3,}/g, '\n\n')
    return stripInvalidImageKeys(result)
  } catch {
    return text
  }
}

/**
 * Split a long body into chunks of at most `limit` chars, cutting at
 * paragraph/line boundaries when possible.
 */
export function splitLongText(text: string, limit: number = MAX_CHUNK_CHARS): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > 0) {
    if (rest.length <= limit) {
      chunks.push(rest)
      break
    }
    let cut = rest.lastIndexOf('\n\n', limit)
    if (cut < limit / 2) cut = rest.lastIndexOf('\n', limit)
    if (cut < limit / 2) cut = limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  return chunks
}

/** Longest backtick run in a value (drives the fence length). */
function longestBacktickRun(value: string): number {
  let longest = 0
  for (const match of value.matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
  return longest
}

/** Wrap content in a markdown code fence sized past any inner backticks. */
export function formatCodeBlock(content: string, language = 'text'): string {
  const normalized = content.replace(/\r\n/g, '\n').trim()
  if (normalized === '') return ''
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(normalized) + 1))
  return `${fence}${language}\n${normalized}\n${fence}`
}

/** Pretty-print JSON-ish text; non-JSON returns the original text. */
export function prettyJsonOrText(value: string): { language: string; text: string } {
  const normalized = value.trim()
  if (normalized.startsWith('{') || normalized.startsWith('[')) {
    try {
      return { language: 'json', text: JSON.stringify(JSON.parse(normalized), undefined, 2) }
    } catch {
      // fall through to plain text
    }
  }
  return { language: 'text', text: normalized }
}
