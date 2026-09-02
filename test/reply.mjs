/**
 * Reply-reference tests (Feature A, SPEC §4): sanitizer rules, target id
 * resolution, reference building per message type, tag escaping, and
 * unavailable-reason mapping.
 */
import assert from 'node:assert/strict'
import {
  cleanString,
  escapeForTag,
} from '../lib/inbound-sanitize.js'
import {
  REPLY_NOTE,
  buildReplyReference,
  replyTargetId,
  unavailableReasonFromError,
} from '../lib/reply-reference.js'
import { normalizeMessageEvent } from '../lib/transport.js'

let passed = 0
const ok = (name, fn) => {
  fn()
  passed += 1
  console.log(`${name}: true`)
}

// ── sanitizer ──────────────────────────────────────────────────────────
ok('cleanString strips OSC/CSI/ESC sequences', () => {
  assert.equal(cleanString('\u001b]0;title\u0007hello', 100).value, 'hello')
  assert.equal(cleanString('\u001b[31mred\u001b[0m', 100).value, 'red')
  // A bare ESC is itself stripped; the following char survives.
  assert.equal(cleanString('\u001bAplain', 100).value, 'plain')
})

ok('cleanString strips bidi/invisible marks and C0/C1', () => {
  assert.equal(cleanString('a\u200bb\u202ec\u202dd\ufeffe', 100).value, 'abcde')
  // C0/C1 controls are replaced with a space, then whitespace folds.
  assert.equal(cleanString('x\u0007y\u001fz\u009fw', 100).value, 'x y z w')
})

ok('cleanString folds whitespace unless multiline', () => {
  assert.equal(cleanString('a  b\n\n  c', 100).value, 'a b c')
  const multi = cleanString('line1\nline2\r\nline3', 100, { multiline: true })
  assert.equal(multi.value, 'line1\nline2\nline3')
  assert.equal(multi.truncated, false)
})

ok('cleanString truncates by code points (emoji safe)', () => {
  const cleaned = cleanString('👍'.repeat(10), 5)
  assert.equal([...cleaned.value].length, 5)
  assert.equal(cleaned.truncated, true)
})

ok('cleanString basename reduces paths', () => {
  assert.equal(cleanString('/tmp/a\\b/report.xlsx', 100, { basename: true }).value, 'report.xlsx')
})

ok('cleanString rejects non-strings and empty results', () => {
  assert.equal(cleanString(42, 10).value, undefined)
  assert.equal(cleanString('   ', 10).value, undefined)
})

ok('escapeForTag escapes < > &', () => {
  assert.equal(escapeForTag('{"a":"<b>&"}'), '{"a":"\\u003cb\\u003e\\u0026"}')
})

// ── target resolution ──────────────────────────────────────────────────
ok('replyTargetId prefers parent_id over root_id', () => {
  assert.equal(replyTargetId({ messageId: 'om_1', parentId: 'om_p', rootId: 'om_r' }), 'om_p')
  assert.equal(replyTargetId({ messageId: 'om_1', rootId: 'om_1' }), undefined)
  assert.equal(replyTargetId({ messageId: 'om_1', rootId: 'om_root' }), 'om_root')
  assert.equal(replyTargetId({ messageId: 'om_1' }), undefined)
})

// ── unavailable reasons ────────────────────────────────────────────────
ok('error mapping covers status codes and pass-through codes', () => {
  assert.equal(unavailableReasonFromError({ status: 403 }), 'permission-denied')
  assert.equal(unavailableReasonFromError({ status: 404 }), 'not-found')
  assert.equal(unavailableReasonFromError({ status: 410 }), 'deleted')
  assert.equal(unavailableReasonFromError({ code: 'permission-denied' }), 'permission-denied')
  assert.equal(unavailableReasonFromError(new Error('boom')), 'not-delivered')
})

// ── reference building ─────────────────────────────────────────────────
ok('builds reference for text message with author', () => {
  const ref = buildReplyReference({
    ok: true,
    message: {
      messageId: 'om_x',
      messageType: 'text',
      content: { text: 'quoted question' },
      senderId: 'ou_1',
      senderName: '张三',
    },
  })
  assert.equal(ref.note, REPLY_NOTE)
  assert.equal(ref.content, 'quoted question')
  assert.equal(ref.authorName, '张三')
  assert.deepEqual(ref.attachments, [])
  assert.equal(ref.unavailableReason, undefined)
})

ok('builds reference for file message with basename name', () => {
  const ref = buildReplyReference({
    ok: true,
    message: {
      messageId: 'om_f',
      messageType: 'file',
      content: { file_name: '/up/dir/data.csv' },
    },
  })
  assert.equal(ref.content, undefined)
  assert.deepEqual(ref.attachments, [{ kind: 'file', name: 'data.csv' }])
})

ok('marks interactive cards as unsupported', () => {
  const ref = buildReplyReference({
    ok: true,
    message: { messageId: 'om_c', messageType: 'interactive', content: {} },
  })
  assert.equal(ref.unavailableReason, 'unsupported')
})

ok('lookup failure yields unavailable skeleton, never throws', () => {
  const ref = buildReplyReference({ ok: false, reason: 'permission-denied' })
  assert.equal(ref.unavailableReason, 'permission-denied')
  assert.deepEqual(ref.attachments, [])
})

// ── transport normalization carries parent/root ids ────────────────────
ok('normalizeMessageEvent parses parent_id/root_id', () => {
  const msg = normalizeMessageEvent({
    message: {
      message_id: 'om_2',
      chat_id: 'oc_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '看这条' }),
      parent_id: 'om_p1',
      root_id: 'om_root1',
      create_time: '1787346000000',
      mentions: [],
    },
    sender: { sender_id: { open_id: 'ou_1' } },
  })
  assert.equal(msg.parentId, 'om_p1')
  assert.equal(msg.rootId, 'om_root1')
})

ok('normalizeMessageEvent omits absent parent/root', () => {
  const msg = normalizeMessageEvent({
    message: {
      message_id: 'om_3',
      chat_id: 'oc_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: 'hi' }),
      create_time: '1787346000000',
      mentions: [],
    },
    sender: { sender_id: { open_id: 'ou_1' } },
  })
  assert.equal(msg.parentId, undefined)
  assert.equal(msg.rootId, undefined)
})

console.log(`reply: ${passed} passed`)
