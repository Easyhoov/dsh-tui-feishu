/** Smoke test: bridge message flow with fake transport + agent store. */
import { Bridge } from '../lib/bridge.js'
import { SessionMap } from '../lib/session-map.js'
import { buildCard, StreamingCardManager, toFeishuMarkdown } from '../lib/cards.js'
import { parseReminderTime, nextDailyAt, ReminderStore } from '../lib/reminders.js'

const sent = []
const fakeTransport = {
  connectionState: () => 'ready',
  onMessage(h) { this._h = h },
  onCardAction(h) { this._a = h },
  async sendText(chatId, text) { sent.push({ chatId, text }) },
  async sendCard(chatId, card) { const id = `m${sent.length}`; sent.push({ chatId, card, id }); return id },
  async updateCard(messageId, card) { sent.push({ patch: messageId, card }) },
}
const fakeAgent = {
  id: 'sess-1',
  sent: [],
  followup(m) { this.sent.push(m) },
  cancel() { this.cancelled = true },
}
const agentStore = {
  get: id => (id === fakeAgent.id ? fakeAgent : undefined),
  resume: async () => { throw new Error('no log') },
  create: async (sessionId, cwd) => { fakeAgent.id = sessionId; return fakeAgent },
}
const logger = { info() {}, warn: console.warn, error: console.error }
const cards = new StreamingCardManager(fakeTransport, { throttleMs: 1, logger })
const sessionMap = new SessionMap('/tmp/nonexistent/session-map.json')
const controlCalls = []
const modelControl = {
  get: chatId => {
    const binding = sessionMap.get(chatId)
    return binding?.route ?? { provider: 'deepseek', model: 'deepseek-v4-flash' }
  },
  setModel: async (chatId, provider, model) => {
    controlCalls.push(['model', chatId, provider, model])
    if (sessionMap.get(chatId) === undefined) sessionMap.remint(chatId)
    sessionMap.setRoute(chatId, { provider, model })
  },
  setEffort: async (chatId, effort) => {
    controlCalls.push(['effort', chatId, effort])
    if (sessionMap.get(chatId) === undefined) sessionMap.remint(chatId)
    sessionMap.setEffort(chatId, effort)
  },
  listAll: async () => [{ provider: 'deepseek', models: ['deepseek-v4-flash', 'deepseek-v4-pro'] }],
}
let bridgeRef
const reminderStore = new ReminderStore('/tmp/nonexistent/reminders.json', r => bridgeRef.fireReminder(r), logger)
const bridge = new Bridge({
  transport: fakeTransport,
  sessionMap,
  agentStore,
  cards,
  logger,
  defaultCwd: '/work',
  modelControl,
  reminders: reminderStore,
})
bridgeRef = bridge
bridge.start()
const settle = () => new Promise(r => setTimeout(r, 60))

// 1. inbound message -> session created + user message delivered
await fakeTransport._h({ messageId: 'a1', chatId: 'oc_1', chatType: 'p2p', senderOpenId: 'ou_x', text: 'hello agent', mentions: [] })
await settle()
console.log('bound session:', sessionMap.get('oc_1')?.sessionId === 'sess-1' || typeof sessionMap.get('oc_1')?.sessionId === 'string')
console.log('agent got message:', fakeAgent.sent.length === 1, JSON.stringify(fakeAgent.sent[0]?.content))

// 2. dedup: same message id twice -> no second delivery
await fakeTransport._h({ messageId: 'a1', chatId: 'oc_1', chatType: 'p2p', senderOpenId: 'ou_x', text: 'hello agent', mentions: [] })
await settle()
console.log('dedup works:', fakeAgent.sent.length === 1)

// 3. session events -> card patches (text delta, tool call, turn end)
const sessId = sessionMap.get('oc_1').sessionId
let eventListener
bridge.bindSessionEvents(l => { eventListener = l; return () => {} })
eventListener(sessId, { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'world' } } })
await new Promise(r => setTimeout(r, 10))
console.log('card patched with text:', sent.some(m => m.patch !== undefined))
eventListener(sessId, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'npm test' }) } })
eventListener(sessId, { type: 'tool/result', data: { turn: 1, step: 1, message: { content: [{ toolCallId: 'c1' }] } } })
eventListener(sessId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
await new Promise(r => setTimeout(r, 10))
console.log('turn finalized:', !cards.isActive('oc_1'))

// 4. tool/call card JSON sanity: summary line present
const toolCard = buildCard({ title: 't', content: '', rows: [{ kind: 'tool', callId: 'c1', name: 'bash', summary: 'npm test', status: 'done' }], status: 'done' })
console.log('card builds:', JSON.stringify(toolCard).includes('npm test'))

// 5. approval flow: request for own agent -> card sent; button resolves
const outcome = bridge.handleApprovalRequest({ agent: { id: sessId }, toolName: 'bash', reason: 'runs a test' }, () => Promise.resolve('unavailable'))
await settle()
const approvalCard = sent.filter(m => m.card !== undefined).at(-1)
console.log('approval card sent:', JSON.stringify(approvalCard.card).includes('Allow once'))
await fakeTransport._a({ messageId: approvalCard.id, chatId: 'oc_1', operatorOpenId: 'ou_x', value: { kind: 'approval', decision: 'allowed-once' } })
await settle()
console.log('approval outcome:', await outcome)

// 6. approval for foreign agent delegates to next()
const foreign = await bridge.handleApprovalRequest({ agent: { id: 'other' }, toolName: 'bash' }, () => Promise.resolve('unavailable'))
console.log('foreign approval delegates:', foreign === 'unavailable')

// 7. markdown degradation: balanced bold headings, tables -> list lines, backticks stripped
const degraded = toFeishuMarkdown('## 顶层结构\n\n| 类型 | 名称 |\n|---|---|\n| 📁 | `src/` |\n\n用 `npm test` 跑')
console.log('heading balanced bold:', degraded.includes('**顶层结构**'))
console.log('table degraded:', degraded.includes('- 📁 ｜ src/') && !degraded.includes('|---|'))
console.log('backticks stripped:', degraded.includes('用 npm test 跑') && !degraded.includes('`'))

// 8. /model and /effort commands reach the control and persist pins
await fakeTransport._h({ messageId: 'm1', chatId: 'oc_1', chatType: 'p2p', senderOpenId: 'ou_x', text: '/model deepseek-v4-pro', mentions: [] })
await settle()
console.log('model pinned:', sessionMap.get('oc_1')?.route?.model === 'deepseek-v4-pro')
await fakeTransport._h({ messageId: 'm2', chatId: 'oc_1', chatType: 'p2p', senderOpenId: 'ou_x', text: '/effort high', mentions: [] })
await settle()
console.log('effort pinned:', sessionMap.get('oc_1')?.effort === 'high')
await fakeTransport._h({ messageId: 'm3', chatId: 'oc_1', chatType: 'p2p', senderOpenId: 'ou_x', text: '/effort off', mentions: [] })
await settle()
console.log('effort cleared:', sessionMap.get('oc_1')?.effort === undefined)
console.log('control calls:', JSON.stringify(controlCalls))

// 9. session list / switch / delete with titles
const firstSession = sessionMap.get('oc_1').sessionId
await fakeTransport._h({ messageId: 's1', chatId: 'oc_1', chatType: 'p2p', senderOpenId: 'ou_x', text: '/new', mentions: [] })
await settle()
const secondSession = sessionMap.get('oc_1').sessionId
console.log('new session minted:', secondSession !== firstSession)
console.log('both listed:', sessionMap.list('oc_1').length === 2)
console.log('title recorded:', sessionMap.list('oc_1').some(s => s.title === 'hello agent'))
await fakeTransport._h({ messageId: 's2', chatId: 'oc_1', chatType: 'p2p', senderOpenId: 'ou_x', text: '/switch 2', mentions: [] })
await settle()
console.log('switched back:', sessionMap.get('oc_1')?.sessionId === firstSession)
await fakeTransport._h({ messageId: 's3', chatId: 'oc_1', chatType: 'p2p', senderOpenId: 'ou_x', text: '/delete 1', mentions: [] })
await settle()
console.log('delete forgets:', sessionMap.list('oc_1').length === 1 && sessionMap.list('oc_1')[0].sessionId === firstSession)
await fakeTransport._h({ messageId: 's4', chatId: 'oc_1', chatType: 'p2p', senderOpenId: 'ou_x', text: '/delete 1', mentions: [] })
await settle()
console.log('deleting last unbinds:', sessionMap.get('oc_1') === undefined)

// 10. rename: active session by default, numbered with an explicit index
await fakeTransport._h({ messageId: 'r1', chatId: 'oc_1', chatType: 'p2p', senderOpenId: 'ou_x', text: '起个会话', mentions: [] })
await settle()
await fakeTransport._h({ messageId: 'r2', chatId: 'oc_1', chatType: 'p2p', senderOpenId: 'ou_x', text: '/rename 我的项目', mentions: [] })
await settle()
console.log('rename active:', sessionMap.list('oc_1')[0]?.title === '我的项目')
await fakeTransport._h({ messageId: 'r3', chatId: 'oc_1', chatType: 'p2p', senderOpenId: 'ou_x', text: '/new', mentions: [] })
await settle()
await fakeTransport._h({ messageId: 'r4', chatId: 'oc_1', chatType: 'p2p', senderOpenId: 'ou_x', text: '/rename 2 旧会话', mentions: [] })
await settle()
console.log('rename by index:', sessionMap.list('oc_1')[1]?.title === '旧会话')

// 11. queue: a message sent mid-turn neither opens a new card nor clobbers state
const sentBefore = sent.length
await fakeTransport._h({ messageId: 'q1', chatId: 'oc_1', chatType: 'p2p', senderOpenId: 'ou_x', text: '第一条消息', mentions: [] })
await settle()
const sessQ = sessionMap.get('oc_1').sessionId
const cardsAfterFirst = sent.filter(m => m.card !== undefined).length
await fakeTransport._h({ messageId: 'q2', chatId: 'oc_1', chatType: 'p2p', senderOpenId: 'ou_x', text: '插队的第二条', mentions: [] })
await settle()
console.log('mid-turn message queued:', sent.some(m => m.text?.includes('已排队')))
console.log('no second card opened:', sent.filter(m => m.card !== undefined).length === cardsAfterFirst)
eventListener(sessQ, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
await new Promise(r => setTimeout(r, 10))
eventListener(sessQ, { type: 'turn/start', data: { turn: 2 } })
await new Promise(r => setTimeout(r, 10))
const queuedCard = sent.filter(m => m.card !== undefined).at(-1)
console.log('queued turn opens card with its title:', JSON.stringify(queuedCard?.card).includes('插队的第二条'))
console.log('both messages reached agent:', fakeAgent.sent.length >= 2)

// 12. detail toggle: tool args/result appear when expanded, on live and finished cards
await fakeTransport._h({ messageId: 'd1', chatId: 'oc_1', chatType: 'p2p', senderOpenId: 'ou_x', text: '详情测试', mentions: [] })
await settle()
const liveCard = sent.filter(m => m.card !== undefined).at(-1)
const sessD = sessionMap.get('oc_1').sessionId
eventListener(sessD, { type: 'tool/call', data: { turn: 9, step: 1, callId: 'tc1', name: 'bash', arguments: JSON.stringify({ command: 'ls -la' }) } })
eventListener(sessD, { type: 'tool/result', data: { turn: 9, step: 1, message: { content: [{ toolCallId: 'tc1', text: 'file-a\nfile-b' }] } } })
await new Promise(r => setTimeout(r, 10))
await fakeTransport._a({ messageId: liveCard.id, chatId: 'oc_1', operatorOpenId: 'ou_x', value: { kind: 'detail' } })
await settle()
console.log('detail toggle patches live card:', sent.some(m => m.patch === liveCard.id && JSON.stringify(m.card).includes('📥 参数')))
console.log('result captured in detail:', sent.some(m => m.patch === liveCard.id && JSON.stringify(m.card).includes('file-a')))
eventListener(sessD, { type: 'turn/end', data: { turn: 9, reason: { kind: 'completed' } } })
await settle()
const beforeFinishedToggle = sent.length
await fakeTransport._a({ messageId: liveCard.id, chatId: 'oc_1', operatorOpenId: 'ou_x', value: { kind: 'detail' } })
await settle()
console.log('finished card re-renders on toggle:', sent.slice(beforeFinishedToggle).some(m => m.patch === liveCard.id))

// 13. reminders: parse, arm via command, fire into the agent
const now = Date.now()
console.log('parse 10m:', parseReminderTime('10m', now)?.at === now + 600_000)
console.log('parse 09:30:', parseReminderTime('09:30', now)?.daily === '09:30')
console.log('parse junk rejected:', parseReminderTime('明天下午', now) === undefined)
console.log('daily next is future:', nextDailyAt('09:00', now) > now)
const agentMsgsBefore = fakeAgent.sent.length
await fakeTransport._h({ messageId: 'rm1', chatId: 'oc_1', chatType: 'p2p', senderOpenId: 'ou_x', text: '/remind 1s 测试提醒', mentions: [] })
await settle()
console.log('reminder armed:', reminderStore.list('oc_1').length === 1)
await new Promise(r => setTimeout(r, 1400))
const fired = fakeAgent.sent.slice(agentMsgsBefore).some(m => JSON.stringify(m.content).includes('测试提醒'))
console.log('reminder fired into agent:', fired)
reminderStore.dispose()

console.log('SMOKE OK')
