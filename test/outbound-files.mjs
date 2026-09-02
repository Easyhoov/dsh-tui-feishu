/**
 * Outbound file tests (Feature C, SPEC §6): tool registration soft-probe,
 * execution paths (ok / missing path / unbound chat / pre-flight rejections:
 * directory, empty, >30 MB), and the disable switch. Wire-level file_type
 * mapping lives in transport.uploadAndSendFile.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installOutboundFileTool, OUTBOUND_FILE_TOOL } from '../lib/outbound-file.js'

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

test('registers the tool when the registry is present', () => {
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

test('unavailable when the tools service is missing', () => {
  const result = installOutboundFileTool({
    agentCtx: ctxWith(undefined),
    chatForCurrentSession: () => 'oc_1',
    sendFile: async () => 'sent',
  })
  assert.equal(result.status, 'unavailable')
  assert.ok(result.reason.includes('tools registry unavailable'))
})

test('execution sends the file to the bound chat', async () => {
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

test('execution reports unbound chat without throwing', async () => {
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

test('execution reports missing files as a soft error', async () => {
  const tools = fakeToolsRegistry()
  installOutboundFileTool({
    agentCtx: ctxWith(tools),
    chatForCurrentSession: () => 'oc_1',
    sendFile: async () => 'sent',
  })
  const result = await tools.registered[0].execute({ path: '/tmp/definitely-missing-xyz.txt' })
  assert.equal(result.ok, false)
})
// ── S4 pre-flight rejections (SPEC §6.3: plain file, non-empty, ≤30 MB) ──
test('execution rejects a directory before reading it (no raw EISDIR)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'obfile-'))
  const tools = fakeToolsRegistry()
  installOutboundFileTool({ agentCtx: ctxWith(tools), chatForCurrentSession: () => 'oc_1', sendFile: async () => 'sent' })
  const result = await tools.registered[0].execute({ path: dir })
  await rm(dir, { recursive: true, force: true })
  assert.equal(result.ok, false)
  assert.ok(String(result.error).includes('不是普通文件'), String(result.error))
})

test('execution rejects an empty file before reading it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'obfile-'))
  const file = join(dir, 'empty.txt')
  await writeFile(file, '')
  const tools = fakeToolsRegistry()
  installOutboundFileTool({ agentCtx: ctxWith(tools), chatForCurrentSession: () => 'oc_1', sendFile: async () => 'sent' })
  const result = await tools.registered[0].execute({ path: file })
  await rm(dir, { recursive: true, force: true })
  assert.equal(result.ok, false)
  assert.ok(String(result.error).includes('是空文件'), String(result.error))
})

test('execution rejects a >30 MB file via stat, without reading it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'obfile-'))
  const file = join(dir, 'big.bin')
  const fh = await (await import('node:fs/promises')).open(file, 'w')
  await fh.truncate(31 * 1024 * 1024)
  await fh.close()
  const tools = fakeToolsRegistry()
  installOutboundFileTool({ agentCtx: ctxWith(tools), chatForCurrentSession: () => 'oc_1', sendFile: async () => 'sent' })
  const result = await tools.registered[0].execute({ path: file })
  await rm(dir, { recursive: true, force: true })
  assert.equal(result.ok, false)
  assert.ok(String(result.error).includes('超过 30MB 上限'), String(result.error))
})
