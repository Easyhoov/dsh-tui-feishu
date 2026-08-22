/**
 * CardKit engine tests: card JSON 2.0 builders (buttons via behaviors,
 * streaming mode), the manager's create→stream→close→complete lifecycle,
 * and bridge integration with the CardKit engine.
 */
import assert from 'node:assert/strict'
import { buildCardKitStreamingCard, buildCardKitCompleteCard } from '../lib/streaming/cardkit-builder.js'
import { CardKitStreamingManager } from '../lib/streaming/cardkit-manager.js'
import { Bridge } from '../lib/bridge.js'
import { normalizeCardAction } from '../lib/transport.js'
import { SessionMap } from '../lib/session-map.js'

let passed = 0
const ok = (name, fn) => {
  fn()
  passed += 1
  console.log(`${name}: true`)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ── builders ───────────────────────────────────────────────────────────
ok('streaming card is schema 2.0 with streaming mode and a callback Stop button', () => {
  const card = buildCardKitStreamingCard(
    { title: 't', content: 'hi', rows: [], status: 'working' },
    'zh',
  )
  assert.equal(card.schema, '2.0')
  assert.equal(card.config.streaming_mode, true)
  const json = JSON.stringify(card)
  assert.ok(json.includes('behaviors'))
  assert.ok(json.includes('"type":"callback"'))
  assert.ok(json.includes('"kind":"stop"'))
  assert.ok(card.body.elements.some(el => el.element_id === 'streaming_content'))
})
ok('complete card carries panels, footer and a detail callback button', () => {
  const card = buildCardKitCompleteCard(
    {
      title: 't',
      content: 'answer',
      rows: [
        { kind: 'tool', name: 'bash', summary: 'ls', status: 'done', durationMs: 1500 },
      ],
      status: 'done',
      footer: { elapsedMs: 5000, model: 'deepseek/x' },
    },
    'en',
  )
  const json = JSON.stringify(card)
  assert.equal(card.schema, '2.0')
  assert.ok(json.includes('Run command'))
  assert.ok(json.includes('1.5s'))
  assert.ok(json.includes('Elapsed 5.0s'))
  assert.ok(json.includes('"kind":"detail"'))
})

// ── manager lifecycle with a fake transport ────────────────────────────
function fakeCardKitTransport() {
  const calls = []
  const transport = {
    calls,
    connectionState: () => 'ready',
    onMessage() {},
    onCardAction() {},
    async sendText() {},
    async sendCard() {
      throw new Error('v1 sendCard should not be used by the CardKit engine')
    },
    async cardkitCreate(card) {
      calls.push(['cardkitCreate', card])
      return 'card-1'
    },
    async cardkitSendToChat(chatId, cardId) {
      calls.push(['cardkitSendToChat', chatId, cardId])
      return 'msg-1'
    },
    async cardkitBatchUpdate(cardId, actions, sequence) {
      calls.push(['cardkitBatchUpdate', cardId, actions, sequence])
    },
    async cardkitStreamElement(cardId, elementId, content, sequence) {
      calls.push(['cardkitStreamElement', cardId, elementId, content, sequence])
    },
    async cardkitCloseStreaming(cardId, sequence) {
      calls.push(['cardkitCloseStreaming', cardId, sequence])
    },
    async cardkitUpdate(cardId, card, sequence) {
      calls.push(['cardkitUpdate', cardId, card, sequence])
    },
  }
  return transport
}

ok('manager runs create → add tool panel → stream text → close → complete', async () => {
  const transport = fakeCardKitTransport()
  const manager = new CardKitStreamingManager(transport, { throttleMs: 1, logger: { warn() {} } })
  await manager.open('chat', 'hello')
  assert.ok(manager.isActive('chat'))
  assert.equal(manager.activeMessageId('chat'), 'msg-1')

  manager.patch('chat', {
    title: 'hello',
    content: 'work',
    rows: [{ kind: 'tool', name: 'bash', summary: 'ls', status: 'done' }],
    status: 'working',
  })
  await sleep(40)
  assert.ok(transport.calls.some(call => call[0] === 'cardkitBatchUpdate'), 'tool panel updated')
  const batch = transport.calls.find(call => call[0] === 'cardkitBatchUpdate')
  assert.equal(batch[2][0].action, 'partial_update_element')
  assert.equal(batch[2][0].params.element_id, 'tool_panel')
  const stream = transport.calls.find(call => call[0] === 'cardkitStreamElement')
  assert.equal(stream[2], 'streaming_content')
  assert.equal(stream[3], 'work')

  await manager.finalize('chat', 'done', { elapsedMs: 1000 }, {
    title: 'hello',
    content: 'work',
    rows: [{ kind: 'tool', name: 'bash', summary: 'ls', status: 'done' }],
    status: 'done',
  })
  assert.ok(transport.calls.some(call => call[0] === 'cardkitCloseStreaming'), 'streaming closed')
  const done = transport.calls.find(call => call[0] === 'cardkitUpdate')
  assert.ok(done !== undefined, 'terminal card pushed')
  assert.equal(done[2].schema, '2.0')
  assert.ok(!manager.isActive('chat'))
  assert.equal(manager.lastMessageId('chat'), 'msg-1')
  manager.dispose()
})

// ── bridge integration with the CardKit engine ─────────────────────────
ok('bridge drives the CardKit engine end to end', async () => {
  const transport = fakeCardKitTransport()
  transport.onMessage = h => {
    transport._h = h
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
  const cards = new CardKitStreamingManager(transport, { throttleMs: 1, logger })
  const sessionMap = new SessionMap('/tmp/nonexistent/session-map.json')
  const bridge = new Bridge({ transport, sessionMap, agentStore, cards, logger, defaultCwd: '/work' })
  bridge.start()
  const events = []
  bridge.bindSessionEvents(listener => {
    events.push(listener)
    return () => {}
  })

  await transport._h({
    messageId: 'msg-0',
    chatId: 'chat',
    chatType: 'p2p',
    senderOpenId: 'owner',
    text: 'go',
    mentions: [],
  })
  await sleep(20)
  const sessionId = sessionMap.get('chat').sessionId
  await events[0](sessionId, {
    type: 'tool/call',
    data: { name: 'bash', callId: 'c1', arguments: '{"command":"echo hi"}' },
  })
  await events[0](sessionId, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'done.' }] } },
  })
  await sleep(30)
  await events[0](sessionId, { type: 'turn/end', data: { reason: { kind: 'done' } } })
  await sleep(30)

  const kinds = transport.calls.map(call => call[0])
  assert.ok(kinds.includes('cardkitCreate'), 'card created')
  assert.ok(kinds.includes('cardkitBatchUpdate'), 'tool panel pushed')
  assert.ok(kinds.includes('cardkitStreamElement'), 'answer streamed')
  assert.ok(kinds.includes('cardkitCloseStreaming'), 'streaming closed')
  assert.ok(kinds.includes('cardkitUpdate'), 'terminal card pushed')
  bridge.dispose()
  cards.dispose()
})

// ── card action callback normalization (v1 and schema-2.0 shapes) ───────
ok('normalizes both v1 and schema-2.0 card action callbacks', () => {
  const v1 = normalizeCardAction({
    operator: { open_id: 'ou_1' },
    action: { value: { kind: 'stop' } },
    context: { open_message_id: 'om_1', open_chat_id: 'oc_1' },
  })
  assert.equal(v1.messageId, 'om_1')
  assert.equal(v1.operatorOpenId, 'ou_1')
  assert.equal(v1.value['kind'], 'stop')
  const v2 = normalizeCardAction({
    header: { event_type: 'card.action.trigger' },
    event: {
      operator: { open_id: 'ou_2' },
      action: { value: { kind: 'session', action: 'switch', n: '1' } },
      context: { open_message_id: 'om_2', open_chat_id: 'oc_2' },
    },
  })
  assert.equal(v2.messageId, 'om_2')
  assert.equal(v2.operatorOpenId, 'ou_2')
  assert.equal(v2.value['kind'], 'session')
  assert.equal(normalizeCardAction({}), undefined)
})

// ── thinking streams into its own element (typing effect) ──────────────
ok('thinking streams into its own element (typing effect)', async () => {
  const transport = fakeCardKitTransport()
  const manager = new CardKitStreamingManager(transport, { throttleMs: 1, logger: { warn() {} } })
  await manager.open('chat', 't')
  manager.patch('chat', {
    title: 't',
    content: '',
    rows: [{ kind: 'think', text: 'hmm' }],
    status: 'working',
  })
  await sleep(40)
  const streams = transport.calls.filter(call => call[0] === 'cardkitStreamElement')
  const reasoning = streams.find(call => call[2] === 'reasoning_text')
  assert.ok(reasoning !== undefined, 'thinking streamed to the reasoning text element')
  assert.equal(reasoning[3], 'hmm')
  manager.dispose()
})

// ── showReasoning=false hides thinking rows ────────────────────────────
ok('showReasoning=false drops reasoning rows', async () => {
  const transport = fakeCardKitTransport()
  transport.onMessage = h => {
    transport._h = h
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
  const cards = new CardKitStreamingManager(transport, {
    throttleMs: 1,
    showReasoning: false,
    logger,
  })
  const sessionMap = new SessionMap('/tmp/nonexistent/session-map.json')
  const bridge = new Bridge({
    transport,
    sessionMap,
    agentStore,
    cards,
    logger,
    defaultCwd: '/work',
    showReasoning: false,
  })
  bridge.start()
  const events = []
  bridge.bindSessionEvents(listener => {
    events.push(listener)
    return () => {}
  })
  await transport._h({
    messageId: 'msg-0',
    chatId: 'chat',
    chatType: 'p2p',
    senderOpenId: 'owner',
    text: 'go',
    mentions: [],
  })
  await sleep(20)
  const sessionId = sessionMap.get('chat').sessionId
  await events[0](sessionId, {
    type: 'assistant/chunk',
    data: { chunk: { type: 'reasoning-delta', text: 'secret thinking' } },
  })
  await sleep(20)
  await events[0](sessionId, { type: 'turn/end', data: { reason: { kind: 'done' } } })
  await sleep(30)
  const json = JSON.stringify(transport.calls)
  assert.ok(!json.includes('secret thinking'), 'thinking hidden with showReasoning=false')
  bridge.dispose()
  cards.dispose()
})

// ── regression: finalize while a patch flush is in flight ───────────────
// The reported bug: turn/end lands while the 100ms patch flush is streaming
// the last chunk; finalize's flush was dropped by the `flushing` guard, the
// terminal snapshot was applied by the NON-terminal branch, streaming mode
// was never closed, and the card stayed in "working" state forever.
ok('finalize during an in-flight flush still closes streaming and pushes the terminal card', async () => {
  const transport = fakeCardKitTransport()
  // Block the first stream_element so the patch flush is provably in flight
  // when finalize runs.
  let releaseStream
  const streamGate = new Promise(resolve => {
    releaseStream = resolve
  })
  let blocked = false
  const originalStream = transport.cardkitStreamElement
  transport.cardkitStreamElement = async (...args) => {
    if (args[1] === 'streaming_content' && !blocked) {
      blocked = true
      await streamGate
    }
    return originalStream(...args)
  }
  const manager = new CardKitStreamingManager(transport, { throttleMs: 1, logger: { warn() {} } })
  await manager.open('chat', 'hello')

  manager.patch('chat', {
    title: 'hello',
    content: 'work',
    rows: [],
    status: 'working',
  })
  // Let the throttle timer fire and the flush enter the blocked stream.
  await sleep(30)
  assert.ok(blocked, 'patch flush is in flight inside stream_element')

  const finalized = await manager.finalize('chat', 'done', { elapsedMs: 1000 }, {
    title: 'hello',
    content: 'work',
    rows: [],
    status: 'done',
  })
  assert.equal(finalized, true)
  // The in-flight flush is still blocked - the terminal apply must wait for it.
  assert.ok(manager.isActive('chat'), 'card not retired before the terminal apply')

  releaseStream()
  await sleep(50)

  assert.ok(transport.calls.some(call => call[0] === 'cardkitCloseStreaming'), 'streaming closed despite in-flight flush')
  const done = transport.calls.filter(call => call[0] === 'cardkitUpdate')
  assert.equal(done.length, 1, 'terminal card pushed exactly once')
  assert.equal(done[0][2].schema, '2.0')
  assert.ok(!manager.isActive('chat'), 'card retired after the terminal apply')
  manager.dispose()
})

console.log(`CARDKIT OK (${passed} checks)`)
