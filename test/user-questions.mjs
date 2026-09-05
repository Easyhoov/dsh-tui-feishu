/**
 * User-question tests: Feishu answer-card builders, the legacy seat
 * handover (TUI incumbent → bridge, with delegation), and the bridge's
 * ask → card/text answer lifecycle (single/multi question, single/multi
 * select, abort, card-failure text fallback).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Bridge } from '../lib/bridge.js'
import { SessionMap } from '../lib/session-map.js'
import { StreamingCardManager } from '../lib/cards.js'
import {
  buildQuestionCancelledBody,
  buildQuestionCardBody,
  buildQuestionPlainText,
  buildQuestionSettledBody,
  createQuestionError,
  installUserQuestionsProvider,
  summarizeAnswer,
} from '../lib/user-questions.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Minimal fake of the host UserQuestionService (legacy rc.2 shape). */
function fakeService({ occupied } = {}) {
  const calls = { registered: 0 }
  // The compiled service stores the incumbent on a plain `provider` property
  // (the structural slot the installer and providerGuard probe).
  let provider = occupied ? { ask: async () => ({ answers: [] }), name: 'dsh-tui' } : undefined
  return {
    calls,
    get provider() {
      return provider
    },
    set provider(next) {
      provider = next
    },
    registerProvider(next) {
      calls.registered += 1
      if (provider !== undefined) {
        throw createQuestionError('a user-questions provider is already registered', 'DUPLICATE_PROVIDER')
      }
      provider = next
      return () => {
        if (provider === next) provider = undefined
      }
    },
  }
}

// ── error + summary helpers ────────────────────────────────────────────
test('createQuestionError mirrors the upstream error surface', () => {
  const error = createQuestionError('boom', 'ASK_ABORTED')
  assert.equal(error.name, 'UserQuestionError')
  assert.equal(error.code, 'ASK_ABORTED')
  assert.equal(error.message, 'boom')
})
test('summarizeAnswer combines labels and custom text', () => {
  assert.equal(summarizeAnswer({ selected: ['P2 全部', 'P3 一起修'] }), 'P2 全部、P3 一起修')
  assert.equal(summarizeAnswer({ selected: [], custom: '别的方案' }), '别的方案')
  assert.equal(summarizeAnswer({ selected: ['A'], custom: '补充' }), 'A：补充')
  assert.equal(summarizeAnswer({ selected: [] }), '（未选择）')
})

// ── card builders ──────────────────────────────────────────────────────
const question = {
  id: 'scope',
  question: '修哪些问题？',
  header: '范围确认',
  detail: 'P2 三项 + P3 的拆卡方案',
  options: [
    { label: 'P2 全部 + P3 一起修（推荐）', description: '一次到位' },
    { label: '只修 P2 三项' },
    { label: '不是这个意思' },
  ],
}

test('single-select card carries one option button per option', () => {
  const card = buildQuestionCardBody(question)
  assert.equal(card.header.template, 'blue')
  assert.ok(String(card.header.title.content).includes('需要你确认'))
  const actions = card.elements.filter(el => el.tag === 'action')
  const buttons = actions.flatMap(el => el.actions)
  assert.equal(buttons.length, 3)
  const recommended = buttons.find(b => String(b.text.content).includes('推荐'))
  assert.equal(recommended.type, 'primary', 'recommended option is highlighted')
  const plain = buttons.find(b => String(b.text.content) === '只修 P2 三项')
  assert.equal(plain.type, 'default')
  const value = plain.value
  assert.deepEqual(
    { kind: value.kind, qid: value.qid, action: value.action, option: value.option },
    { kind: 'question', qid: 'scope', action: 'choose', option: '只修 P2 三项' },
  )
  const note = card.elements.find(el => el.tag === 'note')
  assert.ok(String(note.elements[0].content).includes('直接回复文字'))
})

test('multi-select card adds a done action and honors toggled state', () => {
  const multi = { ...question, multiSelect: true }
  const card = buildQuestionCardBody(multi, { toggled: new Set(['只修 P2 三项']) })
  const actions = card.elements.filter(el => el.tag === 'action')
  const buttons = actions.flatMap(el => el.actions)
  assert.ok(buttons.some(b => b.value.action === 'done'))
  const toggled = buttons.find(b => b.value.option === '只修 P2 三项')
  assert.equal(toggled.type, 'primary')
  const untoggled = buttons.find(b => b.value.option === '不是这个意思')
  assert.equal(untoggled.type, 'default')
})

test('plan-review intent gets its own template and approve highlight', () => {
  const plan = {
    ...question,
    header: undefined,
    question: '批准这个计划吗？',
    intent: { kind: 'plan-review', approve: '批准' },
    options: [{ label: '批准' }, { label: '拒绝' }],
  }
  const card = buildQuestionCardBody(plan)
  assert.equal(card.header.template, 'violet')
  const buttons = card.elements.filter(el => el.tag === 'action').flatMap(el => el.actions)
  const approve = buttons.find(b => b.value.option === '批准')
  assert.equal(approve.type, 'primary')
})

test('settled/cancelled bodies and plain-text fallback carry the answer', () => {
  const settled = buildQuestionSettledBody(question, '只修 P2 三项')
  assert.equal(settled.header.template, 'green')
  assert.ok(JSON.stringify(settled).includes('你的回答：只修 P2 三项'))
  const cancelled = buildQuestionCancelledBody(question)
  assert.equal(cancelled.header.template, 'grey')
  assert.ok(JSON.stringify(cancelled).includes('已取消'))
  const plain = buildQuestionPlainText(question)
  assert.ok(plain.includes('修哪些问题？'))
  assert.ok(plain.includes('P2 全部 + P3 一起修（推荐）'))
  assert.ok(plain.includes('回复文字'))
})

// ── seat handover ──────────────────────────────────────────────────────
test('empty seat: provider registers through the API with no delegate', () => {
  const service = fakeService()
  const provider = { ask: async () => ({ answers: [] }) }
  const notices = []
  const seat = installUserQuestionsProvider(service, provider, notice => notices.push(notice))
  assert.equal(service.calls.registered, 1)
  assert.equal(service.provider, provider)
  assert.equal(seat.delegate, undefined)
  assert.equal(notices.length, 0)
  seat.dispose()
  assert.equal(service.provider, undefined, 'dispose unregisters')
})

test('occupied seat: DUPLICATE_PROVIDER falls back to handover and delegation', () => {
  const service = fakeService({ occupied: true })
  const tui = service.provider
  const provider = { ask: async () => ({ answers: [] }) }
  const notices = []
  const seat = installUserQuestionsProvider(service, provider, notice => notices.push(notice))
  assert.equal(service.calls.registered, 1, 'registration was attempted')
  assert.equal(service.provider, provider, 'bridge holds the seat after handover')
  assert.equal(seat.delegate, tui, 'captured incumbent becomes the delegation target')
  assert.ok(notices.some(notice => notice.includes('occupied')))
  seat.dispose()
  assert.equal(service.provider, tui, 'dispose restores the incumbent')
  seat.dispose()
  assert.equal(service.provider, tui, 'dispose is idempotent')
})

test('waterfall-era service (no provider slot) is skipped, not clobbered', () => {
  const service = { registerProvider: undefined }
  const notices = []
  const seat = installUserQuestionsProvider(service, { ask: async () => ({ answers: [] }) }, n => notices.push(n))
  assert.ok(notices.some(notice => notice.includes('not installing')))
  assert.equal(seat.delegate, undefined)
  seat.dispose() // no-op, must not throw
})

// ── bridge lifecycle ───────────────────────────────────────────────────
function makeHarness({ allowCardFailure = false } = {}) {
  const outbound = []
  const transport = {
    connectionState: () => 'ready',
    onMessage(handler) {
      this.messageHandler = handler
    },
    onCardAction(handler) {
      this.cardHandler = handler
    },
    async sendText(chatId, text) {
      outbound.push({ op: 'text', chatId, text })
    },
    async sendCard(chatId, card) {
      if (allowCardFailure) {
        allowCardFailure = false
        throw new Error('card rejected by platform')
      }
      const id = `card-${outbound.length}`
      outbound.push({ op: 'create', chatId, id, card })
      return id
    },
    async updateCard(messageId, card) {
      outbound.push({ op: 'patch', messageId, card })
    },
  }
  const followups = []
  const fakeAgent = {
    id: 'sess-1',
    followup(message) {
      followups.push(message)
    },
    cancel() {},
  }
  const agentStore = {
    get: id => (id === fakeAgent.id ? fakeAgent : undefined),
    resume: async () => fakeAgent,
    create: async sessionId => fakeAgent,
  }
  const logger = { info() {}, warn() {}, error() {} }
  const cards = new StreamingCardManager(transport, { throttleMs: 1, logger })
  const bridge = new Bridge({
    transport,
    sessionMap: new SessionMap('/tmp/nonexistent/session-map-user-questions.json'),
    agentStore,
    cards,
    logger,
    defaultCwd: '/work',
    allowedUsers: ['user-1'],
  })
  bridge.start()
  const inboundText = async text => {
    await transport.messageHandler({
      messageId: `in-${Math.random()}`,
      chatId: 'chat-1',
      chatType: 'p2p',
      senderOpenId: 'user-1',
      mentions: [],
      text,
    })
  }
  const click = async (messageId, value) => {
    await transport.cardHandler({ messageId, chatId: 'chat-1', operatorOpenId: 'user-1', value })
  }
  const waitFor = (promise, label) =>
    Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), 2000)),
    ])
  return { transport, outbound, bridge, followups, inboundText, click, waitFor }
}

test('single question: option button settles the ask and the card', async () => {
  const h = makeHarness()
  const ask = h.bridge.askUserQuestion('chat-1', {
    questions: [{ id: 'q1', question: '继续吗？', options: [{ label: '继续' }, { label: '停下' }] }],
  })
  await sleep(10)
  const created = h.outbound.find(entry => entry.op === 'create')
  assert.ok(created, 'question card was sent')
  assert.equal(created.card.header.template, 'blue')
  await h.click(created.id, { kind: 'question', qid: 'q1', action: 'choose', option: '继续' })
  const answer = await h.waitFor(ask, 'ask resolves after a click')
  assert.deepEqual(answer, { answers: [{ id: 'q1', selected: ['继续'] }] })
  const patch = h.outbound.find(entry => entry.op === 'patch')
  assert.ok(patch, 'card was settled in place')
  assert.ok(JSON.stringify(patch.card).includes('你的回答：继续'))
  h.bridge.dispose()
})

test('typed reply is consumed as the custom answer (no agent followup)', async () => {
  const h = makeHarness()
  const ask = h.bridge.askUserQuestion('chat-1', {
    questions: [{ id: 'q1', question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] }],
  })
  await sleep(10)
  await h.inboundText('都不选，我有别的想法')
  const answer = await h.waitFor(ask, 'ask resolves after typed text')
  assert.deepEqual(answer, { answers: [{ id: 'q1', selected: [], custom: '都不选，我有别的想法' }] })
  assert.equal(h.followups.length, 0, 'answer text never reached the agent inbox')
  h.bridge.dispose()
})

test('typed reply matching an option label counts as that option', async () => {
  const h = makeHarness()
  const ask = h.bridge.askUserQuestion('chat-1', {
    questions: [{ id: 'q1', question: '选哪个？', options: [{ label: 'P2 全部' }, { label: '只修 P2' }] }],
  })
  await sleep(10)
  await h.inboundText('  P2   全部  ') // whitespace normalized
  const answer = await h.waitFor(ask, 'ask resolves')
  assert.deepEqual(answer, { answers: [{ id: 'q1', selected: ['P2 全部'] }] })
  h.bridge.dispose()
})

test('multi-question batch presents one card at a time and answers in order', async () => {
  const h = makeHarness()
  const ask = h.bridge.askUserQuestion('chat-1', {
    questions: [
      { id: 'q1', question: '问题一？', options: [{ label: '一甲' }, { label: '一乙' }] },
      { id: 'q2', question: '问题二？', options: [{ label: '二甲' }, { label: '二乙' }] },
    ],
  })
  await sleep(10)
  const created = h.outbound.filter(entry => entry.op === 'create')
  assert.equal(created.length, 1, 'only the first question card is open')
  await h.click(created[0].id, { kind: 'question', qid: 'q1', action: 'choose', option: '一乙' })
  await sleep(10)
  const second = h.outbound.filter(entry => entry.op === 'create').at(-1)
  assert.ok(JSON.stringify(second.card).includes('问题二？'))
  await h.click(second.id, { kind: 'question', qid: 'q2', action: 'choose', option: '二甲' })
  const answer = await h.waitFor(ask, 'batch resolves after both questions')
  assert.deepEqual(answer, {
    answers: [
      { id: 'q1', selected: ['一乙'] },
      { id: 'q2', selected: ['二甲'] },
    ],
  })
  h.bridge.dispose()
})

test('multi-select: toggles mark buttons and done settles the batch', async () => {
  const h = makeHarness()
  const ask = h.bridge.askUserQuestion('chat-1', {
    questions: [
      {
        id: 'q1',
        question: '多选？',
        multiSelect: true,
        options: [{ label: '甲' }, { label: '乙' }, { label: '丙' }],
      },
    ],
  })
  await sleep(10)
  const cardId = h.outbound.find(entry => entry.op === 'create').id
  await h.click(cardId, { kind: 'question', qid: 'q1', action: 'choose', option: '甲' })
  await h.click(cardId, { kind: 'question', qid: 'q1', action: 'choose', option: '丙' })
  await h.click(cardId, { kind: 'question', qid: 'q1', action: 'choose', option: '甲' }) // untoggle
  const togglePatch = h.outbound.filter(entry => entry.op === 'patch').at(-1)
  assert.ok(JSON.stringify(togglePatch.card).includes('丙'), 'toggle re-renders the card')
  await h.click(cardId, { kind: 'question', qid: 'q1', action: 'done' })
  const answer = await h.waitFor(ask, 'multi-select settles on done')
  assert.deepEqual(answer, { answers: [{ id: 'q1', selected: ['丙'] }] })
  h.bridge.dispose()
})

test('abort signal rejects the parked ask with ASK_ABORTED', async () => {
  const h = makeHarness()
  const controller = new AbortController()
  const ask = h.bridge.askUserQuestion('chat-1', {
    questions: [{ id: 'q1', question: '继续吗？' }],
    signal: controller.signal,
  })
  await sleep(10)
  controller.abort()
  await assert.rejects(ask, error => error.code === 'ASK_ABORTED')
  h.bridge.dispose()
})

test('bridge dispose rejects pending asks instead of parking forever', async () => {
  const h = makeHarness()
  const ask = h.bridge.askUserQuestion('chat-1', {
    questions: [{ id: 'q1', question: '继续吗？' }],
  })
  await sleep(10)
  const rejection = h.waitFor(
    ask.then(
      () => Promise.reject(new Error('expected rejection')),
      error => error,
    ),
    'dispose settles the ask',
  )
  await h.bridge.dispose()
  const error = await rejection
  assert.equal(error.code, 'ASK_ABORTED')
})

test('a second ask in the same chat rejects while one is pending', async () => {
  const h = makeHarness()
  const first = h.bridge.askUserQuestion('chat-1', {
    questions: [{ id: 'q1', question: '继续吗？' }],
  })
  await sleep(10)
  const second = h.bridge.askUserQuestion('chat-1', {
    questions: [{ id: 'q2', question: '再来一个？' }],
  })
  await assert.rejects(second, error => error.code === 'ASK_IN_PROGRESS')
  // The first ask has no options: it is answered by text.
  await h.inboundText('继续')
  const answer = await h.waitFor(first, 'first ask still answerable')
  assert.deepEqual(answer, { answers: [{ id: 'q1', selected: [], custom: '继续' }] })
  h.bridge.dispose()
})

test('card rejection degrades to plain text; typed text still answers and acks', async () => {
  const h = makeHarness({ allowCardFailure: true })
  const ask = h.bridge.askUserQuestion('chat-1', {
    questions: [{ id: 'q1', question: '点不了卡片怎么办？', options: [{ label: '甲' }] }],
  })
  await sleep(10)
  const textOut = h.outbound.find(entry => entry.op === 'text')
  assert.ok(textOut, 'plain-text fallback was sent')
  assert.ok(textOut.text.includes('点不了卡片怎么办？'))
  await h.inboundText('直接打字回答')
  const answer = await h.waitFor(ask, 'typed answer settles')
  assert.deepEqual(answer, { answers: [{ id: 'q1', selected: [], custom: '直接打字回答' }] })
  const ack = h.outbound.find(entry => entry.op === 'text' && entry.text.includes('已收到'))
  assert.ok(ack, 'cardless answers are acknowledged by text')
  h.bridge.dispose()
})

test('stale click on an answered card cannot settle the next question', async () => {
  const h = makeHarness()
  const ask = h.bridge.askUserQuestion('chat-1', {
    questions: [
      { id: 'q1', question: '问题一？', options: [{ label: '一甲' }] },
      { id: 'q2', question: '问题二？', options: [{ label: '二甲' }, { label: '二乙' }] },
    ],
  })
  await sleep(10)
  const first = h.outbound.find(entry => entry.op === 'create')
  await h.click(first.id, { kind: 'question', qid: 'q1', action: 'choose', option: '一甲' })
  await sleep(10)
  const second = h.outbound.filter(entry => entry.op === 'create').at(-1)
  // The stale click carries q1's card id/qid - it must be ignored entirely.
  await h.click(first.id, { kind: 'question', qid: 'q1', action: 'choose', option: '一甲' })
  await sleep(20)
  await h.click(second.id, { kind: 'question', qid: 'q2', action: 'choose', option: '二乙' })
  const answer = await h.waitFor(ask, 'batch resolves via the current card only')
  assert.deepEqual(answer, {
    answers: [
      { id: 'q1', selected: ['一甲'] },
      { id: 'q2', selected: ['二乙'] },
    ],
  })
  h.bridge.dispose()
})

test('unauthorized card operators cannot answer questions', async () => {
  const h = makeHarness()
  const ask = h.bridge.askUserQuestion('chat-1', {
    questions: [{ id: 'q1', question: '继续吗？', options: [{ label: '继续' }] }],
  })
  await sleep(10)
  const cardId = h.outbound.find(entry => entry.op === 'create').id
  await h.transport.cardHandler({
    messageId: cardId,
    chatId: 'chat-1',
    operatorOpenId: 'evil-user',
    value: { kind: 'question', qid: 'q1', action: 'choose', option: '继续' },
  })
  await sleep(20)
  const settled = h.outbound.filter(entry => entry.op === 'patch').length
  assert.equal(settled, 0, 'no settle happened for the unauthorized click')
  // The authorized owner can still answer.
  await h.click(cardId, { kind: 'question', qid: 'q1', action: 'choose', option: '继续' })
  const answer = await h.waitFor(ask, 'authorized click settles')
  assert.deepEqual(answer, { answers: [{ id: 'q1', selected: ['继续'] }] })
  h.bridge.dispose()
})
