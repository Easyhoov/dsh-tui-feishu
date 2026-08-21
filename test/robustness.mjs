/**
 * Robustness tests: dead-card retirement on terminal Feishu codes, the
 * idle-card TTL sweep, plain-text fallback when the card dies, and
 * redaction of tool arguments/results before they reach a card.
 */
import assert from 'node:assert/strict'
import { Bridge } from '../lib/bridge.js'
import { SessionMap } from '../lib/session-map.js'
import { StreamingCardManager } from '../lib/cards.js'
import { FeishuApiError } from '../lib/transport.js'
import { isTerminalMessageCode } from '../lib/unavailable.js'

let passed = 0
const ok = (name, fn) => {
  fn()
  passed += 1
  console.log(`${name}: true`)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ── terminal-code classification ───────────────────────────────────────
ok('classifies terminal message codes', () => {
  assert.ok(isTerminalMessageCode(1000023))
  assert.ok(isTerminalMessageCode(231003))
  assert.ok(isTerminalMessageCode(230011))
  assert.ok(!isTerminalMessageCode(99991400))
  assert.ok(!isTerminalMessageCode(undefined))
})

// ── dead-card retirement at the manager level ──────────────────────────
ok('terminal patch failure retires the card and stops patching', async () => {
  const patches = []
  const transport = {
    connectionState: () => 'ready',
    onMessage() {},
    onCardAction() {},
    async sendText() {},
    async sendCard(chatId, card) {
      const id = `m${patches.length}`
      patches.push({ op: 'create', chatId, card, id })
      return id
    },
    async updateCard(messageId, card) {
      patches.push({ op: 'patch', messageId, card })
      if (patches.filter(p => p.op === 'patch').length === 1) {
        throw new FeishuApiError('im.v1.message.patch', 1000023, 'message not found')
      }
    },
  }
  const cards = new StreamingCardManager(transport, { throttleMs: 1, logger: { warn() {} } })
  await cards.open('chat', 't')
  assert.ok(cards.isActive('chat'))
  cards.patch('chat', { title: 't', content: 'x', rows: [], status: 'working' })
  await sleep(60)
  assert.ok(!cards.isActive('chat'), 'card retired after terminal error')
  assert.equal(cards.lastMessageId('chat'), undefined, 'dead message id dropped')
  // Further patches are no-ops (no additional updateCard calls).
  const patchCount = patches.filter(p => p.op === 'patch').length
  cards.patch('chat', { title: 't', content: 'y', rows: [], status: 'working' })
  await sleep(30)
  assert.equal(patches.filter(p => p.op === 'patch').length, patchCount)
  cards.dispose()
})

// ── idle-card TTL sweep ────────────────────────────────────────────────
ok('idle card is retired by the TTL sweep', async () => {
  const patches = []
  const transport = {
    connectionState: () => 'ready',
    onMessage() {},
    onCardAction() {},
    async sendText() {},
    async sendCard(chatId, card) {
      const id = `m${patches.length}`
      patches.push({ op: 'create', chatId, card, id })
      return id
    },
    async updateCard(messageId, card) {
      patches.push({ op: 'patch', messageId, card })
    },
  }
  const cards = new StreamingCardManager(transport, {
    throttleMs: 1,
    cardTtlMs: 60,
    sweepIntervalMs: 40,
    logger: { warn() {} },
  })
  await cards.open('chat', 't')
  cards.patch('chat', { title: 't', content: 'x', rows: [], status: 'working' })
  await sleep(30)
  assert.ok(cards.isActive('chat'))
  await sleep(120) // let the sweep run
  assert.ok(!cards.isActive('chat'), 'idle card swept')
  cards.dispose()
})

// ── bridge-level: secrets never reach a card; dead card falls back to text ─
ok('tool args/results are redacted on the card and dead cards fall back to text', async () => {
  const sent = []
  const transport = {
    connectionState: () => 'ready',
    onMessage(h) {
      this._h = h
    },
    onCardAction(h) {
      this._a = h
    },
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
      // The very first patch reports the message as deleted: the card dies
      // and the bridge must fall back to plain text at turn end.
      if (sent.filter(entry => 'patch' in entry).length === 1) {
        throw new FeishuApiError('im.v1.message.patch', 230011, 'message recalled')
      }
    },
  }
  const fakeAgent = {
    id: 'sess-1',
    followup() {},
    cancel() {},
  }
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
  const bridge = new Bridge({
    transport,
    sessionMap,
    agentStore,
    cards,
    logger,
    defaultCwd: '/work',
  })
  bridge.start()
  const events = []
  bridge.bindSessionEvents((listener) => {
    events.push(listener)
    return () => {}
  })

  // A message arrives → turn starts → tool call with a secret in args.
  await transport._h({
    messageId: 'msg-1',
    chatId: 'chat',
    chatType: 'p2p',
    senderOpenId: 'owner',
    text: 'run it',
    mentions: [],
  })
  await sleep(20)
  const sessionId = sessionMap.get('chat').sessionId
  assert.ok(sessionId !== undefined, 'session bound after first message')
  events[0](sessionId, {
    type: 'tool/call',
    data: {
      name: 'bash',
      callId: 'call-1',
      arguments: '{"command":"curl -H \\"Authorization: Bearer sk-topsecret\\" https://x"}',
    },
  })
  await sleep(60)

  // Every card payload that left must be clean of the secret.
  for (const entry of sent) {
    const payload = JSON.stringify(entry.card ?? '')
    assert.ok(!payload.includes('sk-topsecret'), 'secret leaked into a card payload')
  }
  // The summary row itself is redacted (it lives in the patch payload - the
  // first patch is the one that reports the message as dead).
  const patchEntry = sent.find(entry => 'patch' in entry)
  assert.ok(patchEntry !== undefined, 'a patch attempt happened')
  const patchJson = JSON.stringify(patchEntry.card)
  assert.ok(patchJson.includes('[redacted]'), 'summary shows the redacted marker')

  // Turn ends after the card died → plain-text fallback with the answer.
  await events[0](sessionId, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'done: the answer' }] } },
  })
  await events[0](sessionId, { type: 'turn/end', data: { reason: { kind: 'done' } } })
  await sleep(40)
  const fallback = sent.find(entry => typeof entry.text === 'string')
  assert.ok(fallback !== undefined, 'plain-text fallback sent after card death')
  assert.ok(fallback.text.includes('done: the answer'))
  bridge.dispose()
  cards.dispose()
})

console.log(`ROBUSTNESS OK (${passed} checks)`)
