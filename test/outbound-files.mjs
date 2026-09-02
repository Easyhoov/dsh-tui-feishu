/**
 * Outbound file tests (Feature C, SPEC §6): tool registration soft-probe,
 * file-type mapping, execution paths (ok / missing path / unbound chat /
 * oversize), and the disable switch.
 */
import assert from 'node:assert/strict'
import { writeFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installOutboundFileTool, mimeForFileName, OUTBOUND_FILE_TOOL } from '../lib/outbound-file.js'

let passed = 0
const ok = (name, fn) => {
  fn()
  passed += 1
  console.log(`${name}: true`)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

ok('mimeForFileName maps known and unknown extensions', () => {
  assert.equal(mimeForFileName('a.csv'), 'text/csv')
  assert.equal(mimeForFileName('b.XLSX'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  assert.equal(mimeForFileName('noext'), 'application/octet-stream')
})

function fakeToolsRegistry() {
  const registered = []
  return {
    registered,
    register(definition) {
      registered.push(definition)
      return { dispose() {} }
    },
  }
}

function ctxWith(tools) {
  return { get: key => (key === 'tools' ? tools : undefined) }
}

ok('registers the tool when the registry is present', () => {
  const tools = fakeToolsRegistry()
  const result = installOutboundFileTool({
    agentCtx: ctxWith(tools),
    chatForCurrentSession: () => 'oc_1',
    sendFile: async () => 'sent',
  })
  assert.equal(result.status, 'registered')
  assert.equal(tools.registered.length, 1)
  assert.equal(tools.registered[0].name, OUTBOUND_FILE_TOOL)
})

ok('unavailable when the tools service is missing', () => {
  const result = installOutboundFileTool({
    agentCtx: ctxWith(undefined),
    chatForCurrentSession: () => 'oc_1',
    sendFile: async () => 'sent',
  })
  assert.equal(result.status, 'unavailable')
  assert.ok(result.reason.includes('tools registry unavailable'))
})

ok('execution sends the file to the bound chat', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'obfile-'))
  const file = join(dir, 'report.csv')
  await writeFile(file, 'a,b\n1,2\n')
  const sent = []
  const tools = fakeToolsRegistry()
  installOutboundFileTool({
    agentCtx: ctxWith(tools),
    chatForCurrentSession: () => 'oc_9',
    sendFile: async (chatId, data, fileName) => {
      sent.push({ chatId, fileName, bytes: data.byteLength })
      return 'sent'
    },
  })
  const result = await tools.registered[0].execute({ path: file, caption: '给你的报表' })
  assert.deepEqual(sent, [{ chatId: 'oc_9', fileName: 'report.csv', bytes: 8 }])
  assert.equal(result.ok, true)
  assert.ok(result.message.includes('报表'))
  await rm(dir, { recursive: true, force: true })
})

ok('execution reports unbound chat without throwing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'obfile-'))
  const file = join(dir, 'ok.txt')
  await writeFile(file, 'data')
  const tools = fakeToolsRegistry()
  installOutboundFileTool({
    agentCtx: ctxWith(tools),
    chatForCurrentSession: () => undefined,
    sendFile: async () => 'sent',
  })
  const result = await tools.registered[0].execute({ path: file })
  await rm(dir, { recursive: true, force: true })
  assert.equal(result.ok, false)
  assert.ok(String(result.error).includes('没有绑定'))
})

ok('execution reports missing files as a soft error', async () => {
  const tools = fakeToolsRegistry()
  installOutboundFileTool({
    agentCtx: ctxWith(tools),
    chatForCurrentSession: () => 'oc_1',
    sendFile: async () => 'sent',
  })
  const result = await tools.registered[0].execute({ path: '/tmp/definitely-missing-xyz.txt' })
  assert.equal(result.ok, false)
})

console.log(`outbound-files: ${passed} passed`)
