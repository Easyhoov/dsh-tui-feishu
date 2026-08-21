/**
 * Standalone scan-to-pair bootstrap for a live trial.
 *
 * Runs the plugin's own `pairByQrCode` (the exact production code path the
 * in-TUI `/feishu pair` uses), prints the one-time launcher URL for the user
 * to scan, and on success writes the paired credentials to the plugin's
 * data dir (`$DSH_HOME/dsh-tui-feishu/credentials.json`) so the bridge
 * auto-starts on the next TUI boot - no in-TUI pairing step needed.
 *
 * Usage: node scripts/standalone-pair.mjs
 */
import { mkdir, writeFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { pairByQrCode } from '../lib/transport.js'

const dataDir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-tui-feishu')
const credentialsPath = join(dataDir, 'credentials.json')

const startedAt = Date.now()
try {
  const result = await pairByQrCode({
    onQRCodeReady: info => {
      console.log(`PAIRING_URL ${info.url}`)
      console.log(`PAIRING_EXPIRES_IN_S ${Math.round(info.expireIn / 1000)}`)
    },
    onStatusChange: status => console.log(`PAIRING_STATUS ${status}`),
  })
  await mkdir(dirname(credentialsPath), { recursive: true })
  const tmp = `${credentialsPath}.tmp`
  await writeFile(
    tmp,
    JSON.stringify(
      {
        appId: result.appId,
        appSecret: result.appSecret,
        ...(result.ownerOpenId === undefined ? {} : { ownerOpenId: result.ownerOpenId }),
      },
      undefined,
      2,
    ),
    { mode: 0o600, encoding: 'utf8' },
  )
  await rename(tmp, credentialsPath)
  console.log(`PAIRING_OK appId=${result.appId} owner=${result.ownerOpenId ?? 'unknown'} elapsed=${Math.round((Date.now() - startedAt) / 1000)}s`)
  console.log(`CREDENTIALS_WRITTEN ${credentialsPath}`)
} catch (error) {
  console.error(`PAIRING_FAILED ${String(error)}`)
  process.exit(1)
}
