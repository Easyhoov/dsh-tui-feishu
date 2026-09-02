/**
 * Image fallback tests (Feature B, SPEC §5): when the chat's effective model
 * lacks image input, the attachment path downgrades to a text delivery
 * instead of an image block; visual/unknown models keep the old behavior.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Bridge } from '../lib/bridge.js'
import { SessionMap } from '../lib/session-map.js'
import { StreamingCardManager } from '../lib/cards.js'

const until = async (cond, ms = 2000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('condition not met within ' + ms + 'ms')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function imageBridge(overrides = {}) {
  const sent = []
  const transport = {
    async start() {},
    async stop() {},
    onMessage(h) { this._h = h },
    onCardAction() {},
    async sendText(chatId, text) { sent.push({ chatId, text }) },
    async sendCard(chatId, card) { const id = `m${sent.length}`; sent.push({ chatId, card, id }); return id },
    async updateCard() {},
  }
  const fakeAgent = { id: 's1', sent: [], followup(m) { this.sent.push(m) }, cancel() {} }
  const agentStore = {
    get: id => (id === fakeAgent.id ? fakeAgent : undefined),
    resume: async () => { throw new Error('no log') },
    create: async sessionId => { fakeAgent.id = sessionId; return fakeAgent },
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
    ...overrides,
  })
  bridge.start()
  return { transport, fakeAgent, sent }
}

const imageEvent = () => ({
  messageId: `om_${Math.random().toString(36).slice(2, 8)}`,
  chatId: 'oc_1',
  chatType: 'p2p',
  senderOpenId: 'ou_x',
  text: '',
  imageKey: 'img_v3_key',
  mentions: [],
})

const attachmentResult = () => ({
  kind: 'attachment',
  ref: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 10, width: 4, height: 4 },
})

const modelControlOf = route => ({
  get: () => route,
  setModel: async () => {},
  setEffort: async () => {},
})

const lastFollowupHasImage = agent => {
  const followup = agent.sent.at(-1)
  return JSON.stringify(followup).includes('"type":"image"')
}

test('visual model (probe=true) keeps the image attachment block', async () => {
  let probeCalls = 0
  const { transport, fakeAgent } = imageBridge({
    modelControl: modelControlOf({ provider: 'p', model: 'vision' }),
    resolveModelSupportsImages: async () => { probeCalls += 1; return true },
    resolveInboundImage: async () => attachmentResult(),
  })
  await transport._h(imageEvent())
  await until(() => fakeAgent.sent.length > 0)
  assert.equal(lastFollowupHasImage(fakeAgent), true)
  assert.equal(probeCalls, 1)
})

test('non-visual model (probe=false) downgrades to text delivery', async () => {
  const { transport, fakeAgent, sent } = imageBridge({
    modelControl: modelControlOf({ provider: 'p', model: 'text-only' }),
    resolveModelSupportsImages: async () => false,
    resolveInboundImage: async () => attachmentResult(),
  })
  await transport._h(imageEvent())
  await until(() => fakeAgent.sent.length > 0)
  assert.equal(lastFollowupHasImage(fakeAgent), false)
  const followup = JSON.stringify(fakeAgent.sent.at(-1))
  assert.ok(followup.includes('read_image'), 'agent prompt mentions tool reading')
  assert.ok(followup.includes('不支持直接看图'), 'agent prompt explains downgrade')
  assert.ok(sent.some(m => m.text.includes('/model')), 'user hint suggests /model')
})

test('unknown modalities (probe=undefined) keep the image block (fail open)', async () => {
  const { transport, fakeAgent } = imageBridge({
    modelControl: modelControlOf({ provider: 'p', model: 'mystery' }),
    resolveModelSupportsImages: async () => undefined,
    resolveInboundImage: async () => attachmentResult(),
  })
  await transport._h(imageEvent())
  await until(() => fakeAgent.sent.length > 0)
  assert.equal(lastFollowupHasImage(fakeAgent), true)
})

test('probe failure keeps the image block (fail open)', async () => {
  const { transport, fakeAgent } = imageBridge({
    modelControl: modelControlOf({ provider: 'p', model: 'mystery' }),
    resolveModelSupportsImages: async () => { throw new Error('rpc down') },
    resolveInboundImage: async () => attachmentResult(),
  })
  await transport._h(imageEvent())
  await until(() => fakeAgent.sent.length > 0)
  assert.equal(lastFollowupHasImage(fakeAgent), true)
})

test('absent modelControl keeps the image block', async () => {
  const { transport, fakeAgent } = imageBridge({
    resolveModelSupportsImages: async () => false,
    resolveInboundImage: async () => attachmentResult(),
  })
  await transport._h(imageEvent())
  await until(() => fakeAgent.sent.length > 0)
  assert.equal(lastFollowupHasImage(fakeAgent), true)
})

test('imageFileFallback=false disables the pre-check entirely (0.3.2 behavior)', async () => {
  let probeCalls = 0
  const { transport, fakeAgent } = imageBridge({
    modelControl: modelControlOf({ provider: 'p', model: 'text-only' }),
    imageFileFallback: false,
    resolveModelSupportsImages: async () => { probeCalls += 1; return false },
    resolveInboundImage: async () => attachmentResult(),
  })
  await transport._h(imageEvent())
  await until(() => fakeAgent.sent.length > 0)
  assert.equal(lastFollowupHasImage(fakeAgent), true)
  assert.equal(probeCalls, 0)
})

