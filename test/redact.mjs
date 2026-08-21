/** Unit tests: secret redaction, detail sanitizers, tool descriptors. */
import assert from 'node:assert/strict'
import {
  basenameOnly,
  redactInlineSecrets,
  redactPaths,
  sanitizeToolDetail,
} from '../lib/redact.js'
import { humanizeToolName, resolveToolDescriptor, toolDisplayTitle } from '../lib/tools.js'

let passed = 0
const ok = (name, fn) => {
  fn()
  passed += 1
  console.log(`${name}: true`)
}

// ── redactInlineSecrets ────────────────────────────────────────────────
ok('redacts API_KEY=sk-xxx assignment', () => {
  const out = redactInlineSecrets('export API_KEY=sk-abc123def456')
  assert.ok(!out.includes('sk-abc123def456'))
  assert.ok(out.includes('API_KEY=[redacted]'))
})
ok('redacts quoted secret assignment', () => {
  const out = redactInlineSecrets('curl -H "Authorization: Bearer tok-987" https://api.example.com')
  assert.ok(!out.includes('tok-987'))
  assert.ok(out.includes('Bearer [redacted]'))
})
ok('redacts --flag secret pairs', () => {
  const out = redactInlineSecrets('mysqldump --password hunter2 --user root')
  assert.ok(!out.includes('hunter2'))
  assert.ok(out.includes('--password [redacted]'))
  assert.ok(out.includes('--user root')) // non-sensitive flag untouched
})
ok('redacts short flag -t secret', () => {
  const out = redactInlineSecrets('gh auth --token ghp_1234567890')
  assert.ok(!out.includes('ghp_1234567890'))
})
ok('leaves non-sensitive text alone', () => {
  const out = redactInlineSecrets('npm run build && ls -la /var/log')
  assert.equal(out, 'npm run build && ls -la /var/log')
})
ok('redact is idempotent', () => {
  const once = redactInlineSecrets('k=sk-111 token=abc')
  assert.equal(redactInlineSecrets(once), once)
})

// ── basenameOnly / redactPaths ─────────────────────────────────────────
ok('basenameOnly strips directories', () => {
  assert.equal(basenameOnly('/a/b/c.sh'), 'c.sh')
  assert.equal(basenameOnly('C:\\Users\\x\\y.txt'), 'y.txt')
  assert.equal(basenameOnly('~/notes.md'), 'notes.md')
})
ok('redactPaths keeps only basenames', () => {
  const out = redactPaths('cat /etc/shadow; ls ~/private/keys')
  assert.ok(!out.includes('/etc/shadow'))
  assert.ok(!out.includes('~/private/keys'))
  assert.ok(out.includes('shadow'))
  assert.ok(out.includes('keys'))
})

// ── sanitizeToolDetail ─────────────────────────────────────────────────
ok('command sanitizer redacts secrets and paths', () => {
  const out = sanitizeToolDetail('curl -H "Authorization: Bearer sk-42" https://x /etc/passwd', 'command')
  assert.ok(!out.includes('sk-42'))
  assert.ok(!out.includes('/etc/passwd'))
  assert.ok(out.includes('passwd'))
})
ok('path sanitizer keeps basename only', () => {
  assert.equal(sanitizeToolDetail('from /home/me/file.txt', 'path'), 'file.txt')
  assert.equal(sanitizeToolDetail('/etc/hosts', 'path'), 'hosts')
})
ok('search sanitizer strips quotes', () => {
  assert.equal(sanitizeToolDetail("'needle phrase'", 'search'), 'needle phrase')
})
ok('url sanitizer drops leading "from" and quotes', () => {
  assert.equal(sanitizeToolDetail('from "https://example.com/a?b=1"', 'url'), 'https://example.com/a?b=1')
})
ok('no sanitizer leaves text unchanged', () => {
  assert.equal(sanitizeToolDetail('<b>hi</b>', undefined), '<b>hi</b>')
})

// ── tool descriptors ───────────────────────────────────────────────────
ok('resolves tool descriptors by alias/prefix', () => {
  assert.equal(resolveToolDescriptor('bash')?.sanitizer, 'command')
  assert.equal(resolveToolDescriptor('web_search')?.sanitizer, 'search')
  assert.equal(resolveToolDescriptor('read_file')?.sanitizer, 'path')
  assert.equal(resolveToolDescriptor('unknown_tool'), undefined)
})
ok('humanizes and titles tool names', () => {
  assert.equal(humanizeToolName('web_search'), 'Web search')
  assert.equal(toolDisplayTitle('bash'), 'Run command')
  assert.equal(toolDisplayTitle('mystery_tool'), 'Mystery tool')
})

console.log(`REDACT OK (${passed} checks)`)
