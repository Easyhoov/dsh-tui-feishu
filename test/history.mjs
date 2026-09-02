/**
 * Feature F history tests (SPEC §9): the in-process rolling transcript —
 * 50-row cap, 400-char row cap, consecutive-agent dedup, secret redaction at
 * the append entry (S2), and chunked replay that keeps the NEWEST rows (M4).
 * appendHistory / handleHistoryCommand are driven directly on the compiled
 * bridge (TS `private` compiles to plain methods).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Bridge } from '../lib/bridge.js'

const noopLogger = { info() {}, warn() {}, error() {} }
const stubCards = {
  open: async () => {}, patch() {}, finalize: async () => true, dispose() {},
  isActive: () => false, refresh: async () => {}, activeMessageId: () => undefined,
  lastMessageId: () => undefined,
}
const stubSessionMap = {
  get: () => undefined, remint: () => 's', persist: async () => {}, list: () => [], size: 0,
  chatFor: () => undefined, set: () => {}, recordTitle: () => false, switchTo: () => false,
  remove: () => 'unbound', rename: () => false, delete: () => {},
}
const stubAgentStore = {
  get: () => undefined, resume: async () => { throw new Error('no log') },
  create: async () => { throw new Error('no log') },
}

function historyBridge() {
  const sentTexts = []
  const bridge = new Bridge({
    transport: {
      connectionState: () => 'ready',
      livenessState: () => 'connected',
      restart: async () => {},
      sendText: async (chatId, text) => { sentTexts.push(text) },
    },
    sessionMap: stubSessionMap,
    agentStore: stubAgentStore,
    cards: stubCards,
    logger: noopLogger,
    defaultCwd: '/w',
  })
  return { bridge, sentTexts }
}

test('appendHistory caps at 50 rows per chat (oldest evicted)', () => {
  const { bridge } = historyBridge()
  for (let i = 0; i < 60; i += 1) bridge.appendHistory('oc_1', 'user', 'row' + i)
  const rows = bridge.history.get('oc_1')
  assert.equal(rows.length, 50)
  assert.equal(rows[0].text, 'row10', 'the ten oldest rows were evicted')
  assert.equal(rows[49].text, 'row59')
})

test('appendHistory caps each row at 400 chars', () => {
  const { bridge } = historyBridge()
  bridge.appendHistory('oc_1', 'user', 'x'.repeat(500))
  assert.equal(bridge.history.get('oc_1')[0].text.length, 400)
})

test('appendHistory dedups consecutive identical agent rows', () => {
  const { bridge } = historyBridge()
  bridge.appendHistory('oc_1', 'agent', 'same')
  bridge.appendHistory('oc_1', 'agent', 'same')
  bridge.appendHistory('oc_1', 'agent', 'different')
  bridge.appendHistory('oc_1', 'agent', 'different')
  assert.deepEqual(bridge.history.get('oc_1').map(r => r.text), ['same', 'different'])
})

test('appendHistory ignores strictly empty text (whitespace is kept as-is)', () => {
  const { bridge } = historyBridge()
  bridge.appendHistory('oc_1', 'user', '')
  bridge.appendHistory('oc_1', 'agent', '')
  assert.equal(bridge.history.get('oc_1'), undefined, 'only empty rows never create an entry')
  bridge.appendHistory('oc_1', 'user', 'a')
  assert.equal(bridge.history.get('oc_1').length, 1)
})

test('S2: appendHistory stores redacted text — secrets never enter the transcript', () => {
  const { bridge } = historyBridge()
  bridge.appendHistory('oc_1', 'user', 'export api_key=sk-leak-12345 now')
  const stored = bridge.history.get('oc_1')[0].text
  assert.ok(!stored.includes('sk-leak-12345'))
  assert.ok(stored.includes('[redacted]'))
})

test('empty /history replies with the placeholder', async () => {
  const { bridge, sentTexts } = historyBridge()
  await bridge.handleHistoryCommand('oc_1', '')
  assert.ok(sentTexts[0].includes('暂无历史'))
})

test('M4: /history chunks 50 rows and keeps the newest rows', async () => {
  const { bridge, sentTexts } = historyBridge()
  for (let i = 0; i < 49; i += 1) {
    bridge.appendHistory('oc_1', 'user', 'ROW' + String(i).padStart(2, '0') + ' ' + 'x'.repeat(380))
  }
  bridge.appendHistory('oc_1', 'user', 'NEWEST-marker')
  await bridge.handleHistoryCommand('oc_1', '')
  const all = sentTexts.join('\n')
  assert.ok(sentTexts.length > 1, 'sent as multiple messages, not one truncated blob')
  assert.ok(all.includes('ROW00'), 'oldest row kept')
  assert.ok(all.includes('NEWEST-marker'), 'newest row kept — the rows the old head-truncation dropped')
  assert.ok(sentTexts.every(t => t.length <= 3500), 'every chunk within the 3500-char bound')
})

test('S2: /history replay output carries no secrets end to end', async () => {
  const { bridge, sentTexts } = historyBridge()
  bridge.appendHistory('oc_1', 'user', 'password=hunter2acct')
  bridge.appendHistory('oc_1', 'agent', 'Authorization: Bearer tok-zzz999')
  await bridge.handleHistoryCommand('oc_1', '')
  const all = sentTexts.join('\n')
  assert.ok(!all.includes('hunter2acct') && !all.includes('tok-zzz999'))
  assert.ok(all.includes('[redacted]'))
})

