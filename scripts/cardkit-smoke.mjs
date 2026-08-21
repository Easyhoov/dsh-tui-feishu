/**
 * CardKit real-platform smoke test.
 *
 * Creates ONE CardKit card entity with the configured Feishu app and
 * immediately forgets it (entities expire in 14 days and are never sent, so
 * nothing appears in any chat). This proves the credentials work, the app
 * accepts CardKit (card JSON 2.0) API calls, and our transport layer's
 * cardkitCreate path is correct against the real platform.
 *
 * Usage: node scripts/cardkit-smoke.mjs [appId] [appSecret]
 * Credentials fall back to FEISHU_APP_ID / FEISHU_APP_SECRET env vars.
 */
import { LarkTransport } from '../lib/transport.js'

const appId = process.argv[2] ?? process.env.FEISHU_APP_ID
const appSecret = process.argv[3] ?? process.env.FEISHU_APP_SECRET
if (appId === undefined || appSecret === undefined) {
  console.error('usage: node scripts/cardkit-smoke.mjs <appId> <appSecret> (or FEISHU_APP_ID/SECRET)')
  process.exit(2)
}

const transport = new LarkTransport({ appId, appSecret })

const card = {
  schema: '2.0',
  config: { wide_screen_mode: true },
  header: { title: { tag: 'plain_text', content: 'dsh-tui-feishu smoke' }, template: 'blue' },
  body: { elements: [{ tag: 'markdown', content: 'cardkit smoke' }] },
}

try {
  const cardId = await transport.cardkitCreate(card)
  console.log(`CARDKIT SMOKE OK: created card entity ${cardId} (never sent; expires in 14 days)`)
  process.exit(0)
} catch (error) {
  console.error(`CARDKIT SMOKE FAILED: ${String(error)}`)
  process.exit(1)
}
