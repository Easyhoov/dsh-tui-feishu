/**
 * Phase-1 card tests: markdown optimization, card rendering (footer, tool
 * durations, code blocks, chunking, locale), and bridge-side reasoning-tag
 * stripping.
 */
import assert from 'node:assert/strict'
import { buildCard, StreamingCardManager } from '../lib/cards.js'
import { Bridge } from '../lib/bridge.js'
import { SessionMap } from '../lib/session-map.js'
import {
  downgradeTables,
  formatCodeBlock,
  optimizeMarkdown,
  prettyJsonOrText,
  splitLongText,
  stripReasoningTags,
} from '../lib/cardmd.js'

let passed = 0
const ok = (name, fn) => {
  fn()
  passed += 1
  console.log(`${name}: true`)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ── cardmd ─────────────────────────────────────────────────────────────
ok('strips think tags and Reasoning prefix', () => {
  assert.equal(stripReasoningTags('a<think>hidden</think>b'), 'ab')
  assert.equal(stripReasoningTags('Reasoning:\nsecret\n\nanswer'), '')
  assert.equal(stripReasoningTags('<thinking>open tail'), '')
})
ok('downgrades overflow tables to code blocks', () => {
  const text = ['| a | b |', '|---|---|', '| 1 | 2 |'].join('\n')
  assert.equal(downgradeTables(text, 0), `\`\`\`\n${text}\`\`\``)
  assert.equal(downgradeTables(text, 5), text)
})
ok('optimizeMarkdown downgrades headings and keeps code blocks', () => {
  const out = optimizeMarkdown('# Title\n\n## Sub\n\n```js\n# not-a-heading\n```\n')
  assert.ok(out.includes('#### Title'))
  assert.ok(out.includes('##### Sub'))
  assert.ok(out.includes('```js\n# not-a-heading\n```'))
})
ok('strips non-img image keys', () => {
  assert.equal(stripReasoningTags(''), '')
  const out = optimizeMarkdown('![x](https://example.com/a.png) ok ![y](img_v2_abc)')
  assert.ok(!out.includes('https://example.com/a.png'))
  assert.ok(out.includes('img_v2_abc'))
})
ok('splits long text at paragraph boundaries', () => {
  const chunks = splitLongText('a'.repeat(100) + '\n\n' + 'b'.repeat(100), 150)
  assert.equal(chunks.length, 2)
  assert.ok(chunks.every(chunk => chunk.length <= 150))
})
ok('formats code fences past inner backticks', () => {
  assert.ok(formatCodeBlock('a`b', 'json').startsWith('```json'))
  assert.ok(formatCodeBlock('a```b', 'json').startsWith('````json'))
})
ok('pretty-prints JSON-ish results', () => {
  assert.equal(prettyJsonOrText('{"a":1}').language, 'json')
  assert.equal(prettyJsonOrText('plain').language, 'text')
})

// ── buildCard rendering ────────────────────────────────────────────────
ok('footer renders status/elapsed/model on finished cards', () => {
  const card = buildCard({
    title: 't',
    content: 'answer',
    rows: [],
    status: 'done',
    footer: { elapsedMs: 1234, model: 'deepseek/deepseek-v4' },
  })
  const json = JSON.stringify(card)
  assert.ok(json.includes('1.2s'))
  assert.ok(json.includes('deepseek/deepseek-v4'))
  assert.ok(json.includes('✅ 完成'))
})
ok('tool row shows humanized title and duration', () => {
  const card = buildCard({
    title: 't',
    content: '',
    rows: [{ kind: 'tool', name: 'bash', summary: 'ls -la', status: 'done', durationMs: 2500 }],
    status: 'done',
  })
  const json = JSON.stringify(card)
  assert.ok(json.includes('Run command'))
  assert.ok(json.includes('2.5s'))
})
ok('expanded tool detail renders fenced result block', () => {
  const card = buildCard({
    title: 't',
    content: '',
    rows: [{ kind: 'tool', name: 'bash', summary: 'x', status: 'done', detailOut: '{"ok":true}' }],
    status: 'done',
    expanded: true,
  })
  const json = JSON.stringify(card)
  assert.ok(json.includes('```json'))
  assert.ok(json.includes('\\"ok\\": true')) // pretty-printed inside the markdown string
})
ok('long bodies split into multiple markdown elements', () => {
  const card = buildCard({ title: 't', content: 'x'.repeat(3000), rows: [], status: 'done' })
  const elements = card.elements.filter(el => el.tag === 'markdown')
  assert.ok(elements.length >= 2)
})
ok('en locale renders English copy', () => {
  const card = buildCard({ title: 't', content: '', rows: [], status: 'done' }, 'en')
  assert.ok(JSON.stringify(card).includes('✅ Done'))
})

// ── bridge: reasoning stripped from content; tool durations tracked ────
ok('bridge strips reasoning tags from answers and tracks tool duration', async () => {
  const sent = []
  const transport = {
    connectionState: () => 'ready',
    onMessage(h) {
      this._h = h
    },
    onCardAction() {},
    async sendText(chatId, text) {
      sent.push({ chatId, text })
    },
    async sendCard(chatId, card) {
      const id = `m${sent.length}`
      sent.push({ chatId, card, id })
      return id
    },
    async updateCard(messageId, card) {
      sent.push({ patch: messageId, card })
    },
  }
  const fakeAgent = { id: 's', followup() {}, cancel() {} }
  const agentStore = {
    get: id => (id === fakeAgent.id ? fakeAgent : undefined),
    resume: async () => {
      throw new Error('no log')
    },
    create: async sessionId => {
      fakeAgent.id = sessionId
      return fakeAgent
    },
  }
  const logger = { info() {}, warn() {}, error() {} }
  const cards = new StreamingCardManager(transport, { throttleMs: 1, logger })
  const sessionMap = new SessionMap('/tmp/nonexistent/session-map.json')
  const bridge = new Bridge({ transport, sessionMap, agentStore, cards, logger, defaultCwd: '/work' })
  bridge.start()
  const events = []
  bridge.bindSessionEvents(listener => {
    events.push(listener)
    return () => {}
  })

  await transport._h({
    messageId: 'msg-1',
    chatId: 'chat',
    chatType: 'p2p',
    senderOpenId: 'owner',
    text: 'hi',
    mentions: [],
  })
  await sleep(20)
  const sessionId = sessionMap.get('chat').sessionId

  await events[0](sessionId, {
    type: 'tool/call',
    data: { name: 'bash', callId: 'c1', arguments: '{"command":"echo hi"}' },
  })
  await sleep(5)
  await events[0](sessionId, {
    type: 'tool/result',
    data: { name: 'bash', callId: 'c1', message: { content: [{ toolCallId: 'c1', text: 'hi' }] } },
  })
  await events[0](sessionId, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'final <think>secret</think> answer' }] } },
  })
  await sleep(10)
  await events[0](sessionId, { type: 'turn/end', data: { reason: { kind: 'done' } } })
  await sleep(30)

  const json = JSON.stringify(sent)
  assert.ok(!json.includes('<think>'), 'reasoning tags stripped before the card')
  assert.ok(!json.includes('secret</think>'), 'hidden reasoning not on the card')
  assert.ok(json.includes('final  answer') || json.includes('final answer'), 'clean answer present')
  assert.ok(json.includes('完成'), 'terminal note rendered')
  bridge.dispose()
  cards.dispose()
})

console.log(`CARDS-P1 OK (${passed} checks)`)
