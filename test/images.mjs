/**
 * Inbound image tests: message normalization, media-type sniffing, and the
 * bridge's image delivery paths (attachment block, file fallback, disabled,
 * resolver failure).
 */
import assert from 'node:assert/strict'
import { Bridge } from '../lib/bridge.js'
import { SessionMap } from '../lib/session-map.js'
import { StreamingCardManager } from '../lib/cards.js'
import { normalizeMessageEvent, sniffImageMediaType, asFeishuError } from '../lib/transport.js'

let passed = 0
const ok = (name, fn) => {
  fn()
  passed += 1
  console.log(`${name}: true`)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ── transport normalization ────────────────────────────────────────────
ok('normalizes image messages with the image key', () => {
  const msg = normalizeMessageEvent({
    message: {
      message_id: 'om_1',
      chat_id: 'oc_1',
      chat_type: 'p2p',
      message_type: 'image',
      content: JSON.stringify({ image_key: 'img_v3_abc123' }),
      create_time: '1787346000000',
      mentions: [],
    },
    sender: { sender_id: { open_id: 'ou_1' } },
  })
  assert.equal(msg.messageId, 'om_1')
  assert.equal(msg.imageKey, 'img_v3_abc123')
  assert.equal(msg.text, '')
})

ok('text messages keep working without an image key', () => {
  const msg = normalizeMessageEvent({
    message: {
      message_id: 'om_2',
      chat_id: 'oc_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: 'hi' }),
      create_time: '1787346000000',
      mentions: [],
    },
    sender: { sender_id: { open_id: 'ou_1' } },
  })
  assert.equal(msg.text, 'hi')
  assert.equal(msg.imageKey, undefined)
})

ok('unsupported message types are ignored', () => {
  const msg = normalizeMessageEvent({
    message: {
      message_id: 'om_3',
      chat_id: 'oc_1',
      chat_type: 'p2p',
      message_type: 'sticker',
      content: JSON.stringify({ file_key: 'f' }),
      create_time: '1787346000000',
      mentions: [],
    },
    sender: { sender_id: { open_id: 'ou_1' } },
  })
  assert.equal(msg, undefined)
})

// ── media-type sniffing ────────────────────────────────────────────────
ok('sniffs jpeg/png/gif/webp magic bytes', () => {
  assert.equal(sniffImageMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
  assert.equal(sniffImageMediaType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png')
  assert.equal(sniffImageMediaType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), 'image/gif')
  assert.equal(sniffImageMediaType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), 'image/webp')
  assert.equal(sniffImageMediaType(new Uint8Array([0x00, 0x01, 0x02])), undefined)
})

// ── bridge image delivery ──────────────────────────────────────────────
function imageBridge(overrides = {}) {
  const sent = []
  const transport = {
    sent,
    onMessage(h) { this._h = h },
    onCardAction() {},
    async sendText(chatId, text) { sent.push({ chatId, text }) },
    async sendCard(chatId, card) { const id = `m${sent.length}`; sent.push({ chatId, card, id }); return id },
    async updateCard() {},
  }
  const fakeAgent = { id: 's', sent: [], followup(m) { this.sent.push(m) }, cancel() {} }
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
  return { transport, fakeAgent, bridge, cards, sessionMap }
}

const imageEvent = (id, imageKey) => ({
  messageId: id,
  chatId: 'oc_1',
  chatType: 'p2p',
  senderOpenId: 'ou_x',
  text: '',
  imageKey,
  mentions: [],
})

ok('image message delivers an attachment block to the agent', async () => {
  let resolvedArgs = undefined
  const { transport, fakeAgent, bridge, cards } = imageBridge({
    resolveInboundImage: async (...args) => {
      resolvedArgs = args
      return {
        kind: 'attachment',
        ref: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 10, width: 4, height: 4 },
      }
    },
  })
  await transport._h(imageEvent('img-msg-1', 'img_v3_1'))
  await sleep(20)
  assert.deepEqual(resolvedArgs, ['img-msg-1', 'img_v3_1'], 'resolver gets (messageId, imageKey)')
  const content = fakeAgent.sent.at(-1)?.content ?? []
  assert.ok(Array.isArray(content))
  const image = content.find(block => block.type === 'image')
  assert.ok(image !== undefined, 'image block present')
  assert.equal(image.attachment.attachmentId, 'att-1')
  assert.ok(content.some(block => block.type === 'text' && block.text.includes('图片')))
  bridge.dispose()
  cards.dispose()
})

ok('image message falls back to a file path', async () => {
  const { transport, fakeAgent, bridge, cards } = imageBridge({
    resolveInboundImage: async () => ({ kind: 'file', path: '/data/images/1.png' }),
  })
  await transport._h(imageEvent('img2', 'img_v3_2'))
  await sleep(20)
  const content = fakeAgent.sent.at(-1)?.content ?? []
  assert.ok(JSON.stringify(content).includes('/data/images/1.png'), 'file path delivered')
  assert.ok(!JSON.stringify(content).includes('"type":"image"'), 'no image block in file mode')
  bridge.dispose()
  cards.dispose()
})

ok('receiveImages=false replies instead of delivering', async () => {
  const { transport, fakeAgent, bridge, cards, sessionMap } = imageBridge({
    receiveImages: false,
    resolveInboundImage: async () => ({ kind: 'attachment', ref: { attachmentId: 'a', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }),
  })
  await transport._h(imageEvent('img3', 'img_v3_3'))
  await sleep(20)
  assert.equal(fakeAgent.sent.length, 0, 'agent untouched')
  assert.ok(transport.sent.some(m => m.text !== undefined && m.text.includes('图片接收')), 'explains images are off')
  assert.equal(sessionMap.get('oc_1'), undefined, 'no session minted for an ignored image')
  bridge.dispose()
  cards.dispose()
})

ok('resolver failure replies with guidance', async () => {
  const { transport, fakeAgent, bridge, cards } = imageBridge({
    resolveInboundImage: async () => {
      throw new Error('permission denied')
    },
  })
  await transport._h(imageEvent('img4', 'img_v3_4'))
  await sleep(20)
  assert.equal(fakeAgent.sent.length, 0)
  assert.ok(transport.sent.some(m => m.text !== undefined && m.text.includes('图片接收失败')), 'replies with a guidance message')
  bridge.dispose()
  cards.dispose()
})

ok('resolver returning undefined also replies with guidance', async () => {
  const { transport, fakeAgent, bridge, cards } = imageBridge({
    resolveInboundImage: async () => undefined,
  })
  await transport._h(imageEvent('img5', 'img_v3_5'))
  await sleep(20)
  assert.equal(fakeAgent.sent.length, 0)
  assert.ok(transport.sent.some(m => m.text !== undefined && m.text.includes('图片接收失败')))
  bridge.dispose()
  cards.dispose()
})


ok('asFeishuError decodes binary (Buffer/ArrayBuffer) error bodies', () => {
  const body = new TextEncoder().encode(JSON.stringify({ code: 234001, msg: 'Invalid request param.' }))
  const err = { response: { data: body } }
  const folded = asFeishuError('im.v1.message.resource.get', err)
  assert.equal(folded.code, 234001, 'business code survives binary folding')
  assert.ok(folded.message.includes('Invalid request param.'))
})

console.log(`IMAGES OK (${passed} checks)`)
