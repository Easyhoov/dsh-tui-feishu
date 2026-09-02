/**
 * Inbound file tests: message normalization, file-type sniffing, and the
 * bridge's file delivery paths (save / disabled / failure).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Bridge } from '../lib/bridge.js'
import { SessionMap } from '../lib/session-map.js'
import { StreamingCardManager } from '../lib/cards.js'
import { normalizeMessageEvent, sniffFileType } from '../lib/transport.js'

const until = async (cond, ms = 2000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('condition not met within ' + ms + 'ms')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

// ── transport normalization ────────────────────────────────────────────
test('normalizes file messages with the file key', () => {
  const msg = normalizeMessageEvent({
    message: {
      message_id: 'om_f1',
      chat_id: 'oc_1',
      chat_type: 'p2p',
      message_type: 'file',
      content: JSON.stringify({ file_key: 'file_v3_abc' }),
      create_time: '1787346000000',
      mentions: [],
    },
    sender: { sender_id: { open_id: 'ou_1' } },
  })
  assert.equal(msg.fileKey, 'file_v3_abc')
  assert.equal(msg.imageKey, undefined)
  assert.equal(msg.text, '')
})

test('file sniffing covers pdf/zip/ole/gz/text/bin', () => {
  assert.equal(sniffFileType(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])), 'pdf')
  assert.equal(sniffFileType(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])), 'zip')
  assert.equal(sniffFileType(new Uint8Array([0x1f, 0x8b, 0x08, 0, 0])), 'gz')
  const text = new TextEncoder().encode('hello world\nthis is a text file\n')
  assert.equal(sniffFileType(text), 'txt')
  assert.equal(sniffFileType(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00])), 'ole')
  assert.equal(sniffFileType(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0])), 'bin')
})

// ── bridge file delivery ───────────────────────────────────────────────
function fileBridge(overrides = {}) {
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

const fileEvent = (id, fileKey) => ({
  messageId: id,
  chatId: 'oc_1',
  chatType: 'p2p',
  senderOpenId: 'ou_x',
  text: '',
  fileKey,
  mentions: [],
})

test('file message delivers a saved path to the agent', async () => {
  let resolvedArgs = undefined
  const { transport, fakeAgent, bridge, cards } = fileBridge({
    resolveInboundFile: async (...args) => {
      resolvedArgs = args
      return { path: '/data/files/feishu-1.pdf' }
    },
  })
  await transport._h(fileEvent('f-msg-1', 'file_v3_1'))
  await until(() => fakeAgent.sent.length > 0)
  assert.deepEqual(resolvedArgs, ['f-msg-1', 'file_v3_1'], 'resolver gets (messageId, fileKey)')
  const content = fakeAgent.sent.at(-1)?.content ?? []
  assert.ok(JSON.stringify(content).includes('/data/files/feishu-1.pdf'), 'file path delivered')
  bridge.dispose()
  cards.dispose()
})

test('receiveFiles=false replies instead of delivering', async () => {
  const { transport, fakeAgent, bridge, cards, sessionMap } = fileBridge({
    receiveFiles: false,
    resolveInboundFile: async () => ({ path: '/data/files/x.pdf' }),
  })
  await transport._h(fileEvent('f-msg-2', 'file_v3_2'))
  await until(() => transport.sent.length > 0)
  assert.equal(fakeAgent.sent.length, 0, 'agent untouched')
  assert.ok(transport.sent.some(m => m.text !== undefined && m.text.includes('文件接收')), 'explains files are off')
  assert.equal(sessionMap.get('oc_1'), undefined, 'no session minted for an ignored file')
  bridge.dispose()
  cards.dispose()
})

test('resolver failure replies with guidance', async () => {
  const { transport, fakeAgent, bridge, cards } = fileBridge({
    resolveInboundFile: async () => {
      throw new Error('download rejected')
    },
  })
  await transport._h(fileEvent('f-msg-3', 'file_v3_3'))
  await until(() => transport.sent.length > 0)
  assert.equal(fakeAgent.sent.length, 0)
  assert.ok(transport.sent.some(m => m.text !== undefined && m.text.includes('文件接收失败')))
  bridge.dispose()
  cards.dispose()
})

