/**
 * Watchdog tests (Feature E, SPEC §8). Locks the corrected behavior:
 * - B2: a healthy connection (SDK liveness = connected) is NEVER restarted,
 *   no matter how quiet the chat has been;
 * - S1: error/reconnecting must persist 5 min before a restart; restarts are
 *   guarded against concurrency and back off through the SPEC ladder
 *   (250ms → 1s → 3s → 5s → 10s → 30s).
 * watchdogTick is exercised directly — TS `private` compiles to a plain
 * method on the lib class, so the compiled bridge is fully drivable.
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

function makeBridge(transport) {
  return new Bridge({
    transport,
    sessionMap: stubSessionMap,
    agentStore: stubAgentStore,
    cards: stubCards,
    logger: noopLogger,
    defaultCwd: '/w',
  })
}

const realNow = Date.now
const minutesFromNow = minutes => { Date.now = () => realNow() + minutes * 60_000 }
const restoreClock = () => { Date.now = realNow }

test('B2: healthy connection + 11 min of inbound silence is NOT restarted', async () => {
  const restarts = []
  const bridge = makeBridge({
    connectionState: () => 'ready',
    livenessState: () => 'connected',
    healthTimestamps: () => ({ lastReadyAt: realNow() - 11 * 60_000, lastInboundAt: realNow() - 11 * 60_000 }),
    restart: async delayMs => { restarts.push(delayMs) },
  })
  try {
    await bridge.watchdogTick()
    assert.deepEqual(restarts, [], 'a healthy idle connection must not be torn down')
  } finally { restoreClock() }
})

test('B2: legacy transport without a liveness probe is not restarted on silence', async () => {
  const restarts = []
  const bridge = makeBridge({
    connectionState: () => 'ready',
    healthTimestamps: () => ({ lastReadyAt: realNow() - 11 * 60_000, lastInboundAt: realNow() - 11 * 60_000 }),
    restart: async delayMs => { restarts.push(delayMs) },
  })
  await bridge.watchdogTick()
  assert.deepEqual(restarts, [], 'no liveness signal = cross-check disabled, ready wins')
})

test('B2: bridge claims ready but the raw socket is dead (idle) → restart', async () => {
  const restarts = []
  const bridge = makeBridge({
    connectionState: () => 'ready',
    livenessState: () => 'idle',
    restart: async delayMs => { restarts.push(delayMs) },
  })
  try {
    await bridge.watchdogTick()
    minutesFromNow(6)
    await bridge.watchdogTick()
    assert.equal(restarts.length, 1, 'the dead-while-claiming-ready case still recovers')
  } finally { restoreClock() }
})

test('S1: error state of zero duration never restarts on the first tick', async () => {
  const restarts = []
  const bridge = makeBridge({
    connectionState: () => 'error',
    livenessState: () => 'failed',
    restart: async delayMs => { restarts.push(delayMs) },
  })
  await bridge.watchdogTick()
  assert.deepEqual(restarts, [], 'SPEC §8.1 requires the bad state to persist 5 min')
})

test('S1: error sustained past 5 min restarts exactly once with ladder[0]=250ms', async () => {
  const restarts = []
  const bridge = makeBridge({
    connectionState: () => 'error',
    livenessState: () => 'failed',
    restart: async delayMs => { restarts.push(delayMs) },
  })
  try {
    await bridge.watchdogTick()          // arm unhealthySince at real now
    minutesFromNow(6)
    await bridge.watchdogTick()          // ≥5 min elapsed → restart
    assert.deepEqual(restarts, [250], 'one restart, first ladder step')
    minutesFromNow(7)
    await bridge.watchdogTick()          // still bad → second ladder step
    assert.deepEqual(restarts, [250, 1000], 'second restart backs off to 1s')
    minutesFromNow(9)
    await bridge.watchdogTick()          // ladder continues: 3s
    assert.deepEqual(restarts, [250, 1000, 3000], 'third restart backs off to 3s')
  } finally { restoreClock() }
})

test('S1: reconnecting state sustained past 5 min restarts (SDK autoReconnect left to win first)', async () => {
  const restarts = []
  const bridge = makeBridge({
    connectionState: () => 'reconnecting',
    livenessState: () => 'reconnecting',
    restart: async delayMs => { restarts.push(delayMs) },
  })
  try {
    minutesFromNow(0.5)
    await bridge.watchdogTick()          // <5 min → nothing
    assert.deepEqual(restarts, [])
    minutesFromNow(6)
    await bridge.watchdogTick()
    assert.deepEqual(restarts, [250], 'restart only after the sustained window')
  } finally { restoreClock() }
})

test('S1: an in-flight restart blocks a second concurrent restart', async () => {
  let calls = 0
  let release
  const bridge = makeBridge({
    connectionState: () => 'error',
    livenessState: () => 'failed',
    restart: () => new Promise(resolve => { calls += 1; release = resolve }),
  })
  try {
    await bridge.watchdogTick()          // arm unhealthySince
    minutesFromNow(6)
    const first = bridge.watchdogTick()  // reaches restart(), hangs
    await bridge.watchdogTick()          // must short-circuit on restartInFlight
    release()
    await first
    assert.equal(calls, 1, 'no concurrent restart on the same WSClient')
  } finally { restoreClock() }
})

test('S1/M5: a healthy tick resets the failure clock and the restart count', async () => {
  const restarts = []
  let state = 'error'
  const bridge = makeBridge({
    connectionState: () => state,
    livenessState: () => (state === 'ready' ? 'connected' : 'failed'),
    restart: async delayMs => { restarts.push(delayMs) },
  })
  try {
    await bridge.watchdogTick()          // arm unhealthySince
    minutesFromNow(6)
    await bridge.watchdogTick()
    assert.equal(bridge.restartCount, 1, 'one failure incident counted')
    state = 'ready'                      // connection recovered
    minutesFromNow(7)
    await bridge.watchdogTick()
    assert.equal(bridge.restartCount, 0, 'health resets the restart counter')
    assert.equal(bridge.unhealthySince, undefined, 'health resets the failure clock')
    minutesFromNow(13)
    await bridge.watchdogTick()
    assert.equal(restarts.length, 1, 'a healthy bridge is never restarted')
  } finally { restoreClock() }
})

