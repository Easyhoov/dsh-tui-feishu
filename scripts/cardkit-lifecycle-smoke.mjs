/**
 * Full CardKit lifecycle smoke against the real platform.
 *
 * Exercises every API path the CardKit engine uses - create → stream
 * thinking → stream answer → close streaming → terminal update - WITHOUT
 * sending any message to a chat (card entities are never delivered, they
 * expire in 14 days). Run with the app credentials:
 *
 *   node scripts/cardkit-lifecycle-smoke.mjs <appId> <appSecret>
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { LarkTransport } from '../lib/transport.js'
import { buildCardKitStreamingCard, buildCardKitCompleteCard } from '../lib/streaming/cardkit-builder.js'

const appId = process.argv[2] ?? process.env.FEISHU_APP_ID
let appSecret = process.argv[3] ?? process.env.FEISHU_APP_SECRET
if (appSecret === undefined) {
  // Fall back to the plugin's paired credentials (the live-trial app).
  const path = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-tui-feishu', 'credentials.json')
  const stored = JSON.parse(await readFile(path, 'utf8'))
  appSecret = stored.appSecret
}
if (appId === undefined || appSecret === undefined) {
  console.error('usage: node scripts/cardkit-lifecycle-smoke.mjs <appId> <appSecret> (or FEISHU_APP_ID/SECRET)')
  process.exit(2)
}

const transport = new LarkTransport({ appId, appSecret })
const steps = []

async function step(name, fn) {
  await fn()
  steps.push(name)
  console.log(`  ✓ ${name}`)
}

try {
  await step('cardkitCreate (streaming card)', async () => {
    const card = buildCardKitStreamingCard(
      { title: '冒烟', content: ' ', rows: [{ kind: 'think', text: '' }], status: 'working' },
      'zh',
    )
    transport._smokeCardId = await transport.cardkitCreate(card)
    console.log(`    card_id=${transport._smokeCardId}`)
  })
  await step('cardkitStreamElement (reasoning_text)', async () => {
    await transport.cardkitStreamElement(transport._smokeCardId, 'reasoning_text', '正在思考…', 2)
  })
  await step('cardkitStreamElement (streaming_content)', async () => {
    await transport.cardkitStreamElement(transport._smokeCardId, 'streaming_content', '这是答案。', 3)
  })
  await step('cardkitCloseStreaming', async () => {
    await transport.cardkitCloseStreaming(transport._smokeCardId, 4)
  })
  await step('cardkitUpdate (terminal card)', async () => {
    const card = buildCardKitCompleteCard(
      {
        title: '冒烟',
        content: '这是答案。',
        rows: [
          { kind: 'think', text: '正在思考…' },
          { kind: 'tool', name: 'bash', summary: 'ls -la', status: 'done', durationMs: 1500 },
        ],
        status: 'done',
        footer: { elapsedMs: 5000, model: 'deepseek/x' },
      },
      'zh',
    )
    await transport.cardkitUpdate(transport._smokeCardId, card, 5)
  })
  console.log(`LIFECYCLE SMOKE OK: ${steps.join(' → ')}`)
  process.exit(0)
} catch (error) {
  console.error(`LIFECYCLE SMOKE FAILED at ${steps.length}/${5 + 1} steps: ${String(error)}`)
  process.exit(1)
}
