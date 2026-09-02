/**
 * Reply-guard tests (Feature A, SPEC §4.5/§4.6): quoted content is DATA —
 * a quoted message whose own text starts with '/' (e.g. '/new') must NOT be
 * dispatched as a command; only the inbound message's own text is. Locks the
 * ordering in handleIncoming (command check precedes reply resolution).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Bridge } from '../lib/bridge.js'
import { SessionMap } from '../lib/session-map.js'
import { StreamingCardManager } from '../lib/cards.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function replyBridge({ getMessage }) {
  const sent = []
  const transport = {
    sent,
    connectionState: () => 'ready',
    livenessState: () => 'connected',
    restart: async () => {},
    onMessage(h) { this._h = h },
    onCardAction() {},
    getMessage,
    async sendText(chatId, text) { sent.push({ chatId, text }) },
    async sendCard(chatId, card) { const id = 'm' + sent.length; sent.push({ chatId, card, id }); return id },
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
  const sessionMap = new SessionMap('/tmp/nonexistent/reply-guard.json')
  const bridge = new Bridge({
    transport,
    sessionMap,
    agentStore,
    cards,
    logger,
    defaultCwd: '/work',
  })
  bridge.start()
  return { transport, fakeAgent, sent, bridge, cards, sessionMap }
}

const quotedText = (id, text) => ({
  messageId: id,
  chatId: 'oc_1',
  chatType: 'p2p',
  senderOpenId: 'ou_x',
  text,
  mentions: [],
})

test('SPEC §4.6: a quoted message containing /new does NOT open a new session', async () => {
  const { transport, fakeAgent, sent, bridge, cards, sessionMap } = replyBridge({
    getMessage: async () => ({ messageId: 'om_parent', messageType: 'text', content: { text: '/new' } }),
  })
  const quoted = quotedText('om_q1', '看下这条引用')
  quoted.parentId = 'om_parent'
  await transport._h(quoted)
  await sleep(20)
  // Delivered as a normal turn carrying the quoted tag — no command side effect.
  assert.equal(fakeAgent.sent.length, 1, 'the turn reaches the agent once')
  const followup = JSON.stringify(fakeAgent.sent[0])
  assert.ok(followup.includes('<dsh_im_reply_to>'), 'quoted context is injected as data')
  assert.ok(followup.includes('/new'), 'the quoted /new text is present inside the tag')
  assert.ok(!sent.some(m => m.text?.includes('🆕 已开新会话')), 'no /new side effect from quoted content')
  assert.equal(sessionMap.list('oc_1').length, 1, 'exactly one session — no extra mint for the quoted /new')
  bridge.dispose()
  cards.dispose()
})

test('positive control: the chat OWN text /new still opens a new session', async () => {
  const { transport, fakeAgent, sent, bridge, cards, sessionMap } = replyBridge({
    getMessage: async () => { throw new Error('should not be called') },
  })
  await transport._h(quotedText('om_n1', 'hello'))
  await sleep(20)
  const firstSession = sessionMap.get('oc_1')?.sessionId
  assert.ok(firstSession !== undefined, 'first turn mints a session')
  await transport._h(quotedText('om_n2', '/new'))
  await sleep(20)
  assert.ok(sent.some(m => m.text?.includes('🆕 已开新会话')), 'own /new dispatches as a command')
  const sessions = sessionMap.list('oc_1')
  assert.equal(sessions.length, 2, 'a second session was minted')
  assert.notEqual(sessionMap.get('oc_1').sessionId, firstSession, 'the new session is now active')
  assert.equal(fakeAgent.sent.length, 1, 'no agent turn for the /new command')
  bridge.dispose()
  cards.dispose()
})

test('a quoted message whose own text is a slash line is still delivered as text data', async () => {
  const { transport, fakeAgent, bridge, cards } = replyBridge({
    getMessage: async () => ({ messageId: 'om_parent', messageType: 'text', content: { text: '/status' } }),
  })
  const quoted = quotedText('om_q2', '这个命令能用吗')
  quoted.parentId = 'om_parent'
  await transport._h(quoted)
  await sleep(20)
  assert.equal(fakeAgent.sent.length, 1, 'quoted /status is data, not a command')
  assert.ok(JSON.stringify(fakeAgent.sent[0]).includes('/status'))
  bridge.dispose()
  cards.dispose()
})

