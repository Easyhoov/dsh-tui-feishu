/**
 * Plan §2.6 tests: auto-downgrade from the CardKit engine to the v1 engine
 * when the first turn card is rejected with a business-level error (an app
 * without card JSON 2.0 / CardKit support), plus the conservative bounds
 * (one swap per process, business rejections only, config off switch).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FallbackCardStream } from '../lib/streaming/fallback-card-stream.js'
import { StreamingCardManager } from '../lib/cards.js'
import { CardKitStreamingManager } from '../lib/streaming/cardkit-manager.js'
import { FeishuApiError } from '../lib/transport.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** A transport whose CardKit create always fails with a business code. */
function rejectingTransport({ code = 99991672, msg = 'no permission' } = {}) {
  const calls = []
  const transport = {
    calls,
    connectionState: () => 'ready',
    onMessage() {},
    onCardAction() {},
    async sendText() {},
    async sendCard(chatId, card) {
      calls.push(['sendCard', chatId, card])
      return 'v1-msg-1'
    },
    async updateCard(messageId, card) {
      calls.push(['updateCard', messageId, card])
    },
    async cardkitCreate() {
      calls.push(['cardkitCreate'])
      throw new FeishuApiError('cardkit.v1.card.create', code, msg)
    },
    async cardkitSendToChat() {
      throw new Error('cardkitSendToChat must not run after a create rejection')
    },
    async cardkitBatchUpdate() {
      throw new Error('cardkitBatchUpdate must not run on the v1 engine')
    },
    async cardkitStreamElement() {
      throw new Error('cardkitStreamElement must not run on the v1 engine')
    },
    async cardkitCloseStreaming() {
      throw new Error('cardkitCloseStreaming must not run on the v1 engine')
    },
    async cardkitUpdate() {
      throw new Error('cardkitUpdate must not run on the v1 engine')
    },
  }
  return transport
}

const noopLogger = { info() {}, warn() {} }

test('a business-level CardKit open rejection swaps to v1 once and the turn card still opens', async () => {
  const transport = rejectingTransport()
  const primary = new CardKitStreamingManager(transport, { throttleMs: 1, logger: { warn() {} } })
  const fallback = () => new StreamingCardManager(transport, { throttleMs: 1, logger: { warn() {} } })
  const cards = new FallbackCardStream({ primary, fallback, logger: noopLogger })

  await cards.open('chat', 'hello')
  assert.equal(cards.currentEngine(), 'v1', 'engine swapped to v1')
  assert.ok(transport.calls.some(call => call[0] === 'sendCard'), 'v1 opened the card')
  assert.ok(transport.calls.some(call => call[0] === 'cardkitCreate'), 'cardkit create was attempted first')
  assert.ok(cards.isActive('chat'))
  assert.equal(cards.activeMessageId('chat'), 'v1-msg-1')

  // Later stream traffic goes through the v1 engine (message.patch updates).
  cards.patch('chat', { title: 'hello', content: 'work', rows: [], status: 'working' })
  await sleep(40)
  assert.ok(transport.calls.some(call => call[0] === 'updateCard'), 'v1 engine applied the patch')
  assert.ok(!transport.calls.some(call => call[0] === 'cardkitStreamElement'), 'no CardKit calls after the swap')

  const finalized = await cards.finalize('chat', 'done', { elapsedMs: 100 })
  assert.equal(finalized, true)
  assert.ok(!cards.isActive('chat'))
  cards.dispose()
})

test('the swap happens at most once per bridge lifetime', async () => {
  const transport = rejectingTransport()
  const primary = new CardKitStreamingManager(transport, { throttleMs: 1, logger: { warn() {} } })
  let built = 0
  const cards = new FallbackCardStream({
    primary,
    fallback: () => {
      built += 1
      return new StreamingCardManager(transport, { throttleMs: 1, logger: { warn() {} } })
    },
    logger: noopLogger,
  })

  await cards.open('chat-1', 'a') // triggers the single swap
  assert.equal(built, 1)
  await cards.open('chat-2', 'b') // v1 engine now serves every chat
  assert.equal(built, 1, 'fallback factory invoked exactly once')
  assert.equal(cards.currentEngine(), 'v1')
  const sends = transport.calls.filter(call => call[0] === 'sendCard')
  assert.equal(sends.length, 2, 'both chats opened on the v1 engine')
  cards.dispose()
})

test('enabled=false propagates the open failure (plain-text fail-safe kept)', async () => {
  const transport = rejectingTransport()
  const primary = new CardKitStreamingManager(transport, { throttleMs: 1, logger: { warn() {} } })
  const cards = new FallbackCardStream({
    primary,
    fallback: () => new StreamingCardManager(transport, { throttleMs: 1, logger: { warn() {} } }),
    enabled: false,
    logger: noopLogger,
  })
  await assert.rejects(() => cards.open('chat', 'hello'), /no permission/)
  assert.equal(cards.currentEngine(), 'cardkit', 'no swap when disabled')
  assert.ok(!transport.calls.some(call => call[0] === 'sendCard'), 'v1 never used')
  cards.dispose()
})

test('a non-business open failure (network shape) never flips the engine', async () => {
  const calls = []
  const transport = rejectingTransport()
  transport.cardkitCreate = async () => {
    calls.push(['cardkitCreate'])
    throw new Error('socket hang up') // network-level, not a FeishuApiError
  }
  const primary = new CardKitStreamingManager(transport, { throttleMs: 1, logger: { warn() {} } })
  const cards = new FallbackCardStream({
    primary,
    fallback: () => new StreamingCardManager(transport, { throttleMs: 1, logger: { warn() {} } }),
    logger: noopLogger,
  })
  await assert.rejects(() => cards.open('chat', 'hello'), /socket hang up/)
  assert.equal(cards.currentEngine(), 'cardkit', 'network errors do not swap engines')
  assert.ok(!calls.some(call => call[0] === 'sendCard'))
  cards.dispose()
})

test('a late business rejection (after the swap) surfaces instead of a second swap', async () => {
  const transport = rejectingTransport()
  // After the swap the v1 engine must be able to fail with a business code
  // too (e.g. the app also lacks im:message) - that failure must propagate.
  const originalSendCard = transport.sendCard
  let failV1 = true
  transport.sendCard = async (chatId, card) => {
    if (failV1) throw new FeishuApiError('im.v1.message.create', 99991672, 'no permission either')
    return originalSendCard(chatId, card)
  }
  const primary = new CardKitStreamingManager(transport, { throttleMs: 1, logger: { warn() {} } })
  const cards = new FallbackCardStream({
    primary,
    fallback: () => new StreamingCardManager(transport, { throttleMs: 1, logger: { warn() {} } }),
    logger: noopLogger,
  })
  await assert.rejects(() => cards.open('chat-1', 'a'), /no permission either/)
  assert.equal(cards.currentEngine(), 'v1', 'swap happened once')
  failV1 = false
  await cards.open('chat-2', 'b') // v1 works now
  assert.equal(cards.activeMessageId('chat-2'), 'v1-msg-1')
  cards.dispose()
})
