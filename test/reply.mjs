/**
 * Reply-reference tests (Feature A, SPEC §4): sanitizer rules, target id
 * resolution, reference building per message type, tag escaping, and
 * unavailable-reason mapping.
 */
import { test } from 'node:test'
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
import { FeishuApiError, normalizeMessageEvent } from '../lib/transport.js'


// ── sanitizer ──────────────────────────────────────────────────────────
test('cleanString strips OSC/CSI/ESC sequences', () => {
  assert.equal(cleanString('\u001b]0;title\u0007hello', 100).value, 'hello')
  assert.equal(cleanString('\u001b[31mred\u001b[0m', 100).value, 'red')
  // A bare ESC is itself stripped; the following char survives.
  assert.equal(cleanString('\u001bAplain', 100).value, 'plain')
})

test('cleanString strips bidi/invisible marks and C0/C1', () => {
  assert.equal(cleanString('a\u200bb\u202ec\u202dd\ufeffe', 100).value, 'abcde')
  // C0/C1 controls are replaced with a space, then whitespace folds.
  assert.equal(cleanString('x\u0007y\u001fz\u009fw', 100).value, 'x y z w')
})

test('cleanString folds whitespace unless multiline', () => {
  assert.equal(cleanString('a  b\n\n  c', 100).value, 'a b c')
  const multi = cleanString('line1\nline2\r\nline3', 100, { multiline: true })
  assert.equal(multi.value, 'line1\nline2\nline3')
  assert.equal(multi.truncated, false)
})

test('cleanString truncates by code points (emoji safe)', () => {
  const cleaned = cleanString('👍'.repeat(10), 5)
  assert.equal([...cleaned.value].length, 5)
  assert.equal(cleaned.truncated, true)
})

test('cleanString basename reduces paths', () => {
  assert.equal(cleanString('/tmp/a\\b/report.xlsx', 100, { basename: true }).value, 'report.xlsx')
})

test('cleanString rejects non-strings and empty results', () => {
  assert.equal(cleanString(42, 10).value, undefined)
  assert.equal(cleanString('   ', 10).value, undefined)
})

test('escapeForTag escapes < > &', () => {
  assert.equal(escapeForTag('{"a":"<b>&"}'), '{"a":"\\u003cb\\u003e\\u0026"}')
})

// ── target resolution ──────────────────────────────────────────────────
test('replyTargetId prefers parent_id over root_id', () => {
  assert.equal(replyTargetId({ messageId: 'om_1', parentId: 'om_p', rootId: 'om_r' }), 'om_p')
  assert.equal(replyTargetId({ messageId: 'om_1', rootId: 'om_1' }), undefined)
  assert.equal(replyTargetId({ messageId: 'om_1', rootId: 'om_root' }), 'om_root')
  assert.equal(replyTargetId({ messageId: 'om_1' }), undefined)
})

// ── unavailable reasons ────────────────────────────────────────────────
test('error mapping covers status codes and pass-through codes', () => {
  assert.equal(unavailableReasonFromError({ status: 403 }), 'permission-denied')
  assert.equal(unavailableReasonFromError({ status: 404 }), 'not-found')
  assert.equal(unavailableReasonFromError({ status: 410 }), 'deleted')
  assert.equal(unavailableReasonFromError({ code: 'permission-denied' }), 'permission-denied')
  assert.equal(unavailableReasonFromError(new Error('boom')), 'not-delivered')
})

// ── reference building ─────────────────────────────────────────────────
test('builds reference for text message with author', () => {
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

test('builds reference for file message with basename name', () => {
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

test('marks interactive cards as unsupported', () => {
  const ref = buildReplyReference({
    ok: true,
    message: { messageId: 'om_c', messageType: 'interactive', content: {} },
  })
  assert.equal(ref.unavailableReason, 'unsupported')
})

test('lookup failure yields unavailable skeleton, never throws', () => {
  const ref = buildReplyReference({ ok: false, reason: 'permission-denied' })
  assert.equal(ref.unavailableReason, 'permission-denied')
  assert.deepEqual(ref.attachments, [])
})

// ── transport normalization carries parent/root ids ────────────────────
test('normalizeMessageEvent parses parent_id/root_id', () => {
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

test('normalizeMessageEvent omits absent parent/root', () => {
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
// ── M1: Feishu numeric business codes (audit-corrected) ────────────────
test('M1: numeric Feishu business codes map to permission-denied / not-found / deleted', () => {
  assert.equal(unavailableReasonFromError({ code: 99991672 }), 'permission-denied')
  assert.equal(unavailableReasonFromError({ code: 230002 }), 'not-found')
  assert.equal(unavailableReasonFromError({ code: 231003 }), 'deleted')
  assert.equal(unavailableReasonFromError({ code: 1000023 }), 'not-found')
})

test('M1: a real FeishuApiError instance maps by its numeric code', () => {
  // SDK/business errors surface as FeishuApiError(code): the string-code and
  // HTTP-status branches alone would misclassify them as not-delivered.
  assert.equal(unavailableReasonFromError(new FeishuApiError('im.v1.message.get', 99991672, 'no permission')), 'permission-denied')
  assert.equal(unavailableReasonFromError(new FeishuApiError('im.v1.message.get', 230002, 'not found')), 'not-found')
  assert.equal(unavailableReasonFromError(new FeishuApiError('im.v1.message.get', 231003, 'deleted')), 'deleted')
})

test('M1: HTTP statuses and pass-through reason codes still work', () => {
  assert.equal(unavailableReasonFromError({ status: 401 }), 'permission-denied')
  assert.equal(unavailableReasonFromError({ statusCode: 410 }), 'deleted')
  assert.equal(unavailableReasonFromError({ code: 'deleted' }), 'deleted')
  assert.equal(unavailableReasonFromError({ code: 'not-found' }), 'not-found')
})

// ── M9: flattenPost across element kinds (SPEC §4.3) ────────────────────
test('M9: post message flattens paragraphs, links, mentions and counts images', () => {
  // flattenPost traverses each top-level key's { content: [[element,...],...] }
  // (the layered rich-text shape the implementation actually handles).
  const ref = buildReplyReference({
    ok: true,
    message: {
      messageId: 'om_post',
      messageType: 'post',
      content: {
        body: {
          title: '标题',
          content: [
            [{ tag: 'text', text: '你好' }, { tag: 'a', text: { text: ' 链接' } }],
            [{ tag: 'at', user_id: 'ou_1' }, { tag: 'text', text: ' 在吗' }],
            [{ tag: 'img', image_key: 'img_1' }],
            [{ tag: 'img', image_key: 'img_2' }],
          ],
        },
      },
    },
  })
  assert.ok(ref.content?.includes('你好') && ref.content?.includes('链接'), 'text + link text joined')
  assert.ok(ref.content?.includes('在吗'), 'mention line flattened')
  assert.deepEqual(ref.attachments, [{ kind: 'image' }, { kind: 'image' }], 'images count as attachments')
  assert.equal(ref.unavailableReason, undefined)
  assert.equal(ref.truncated, false)
})

test('M9: post message with only images yields attachments but no content', () => {
  const ref = buildReplyReference({
    ok: true,
    message: {
      messageId: 'om_imgpost',
      messageType: 'post',
      content: { body: { content: [[{ tag: 'img', image_key: 'img_x' }]] } },
    },
  })
  assert.equal(ref.content, undefined)
  assert.deepEqual(ref.attachments, [{ kind: 'image' }])
  assert.equal(ref.unavailableReason, undefined, 'an image-only quote is still usable')
})

test('M9: unsupported quoted types mark the reference instead of guessing', () => {
  for (const messageType of ['interactive', 'share_chat', 'share_user']) {
    const ref = buildReplyReference({ ok: true, message: { messageId: 'om_t', messageType, content: {} } })
    assert.equal(ref.unavailableReason, 'unsupported', messageType)
  }
})

test('M9: image/audio/media/sticker quoted types map to attachment kinds', () => {
  const image = buildReplyReference({ ok: true, message: { messageId: 'om_i', messageType: 'image', content: { image_key: 'k' } } })
  assert.deepEqual(image.attachments, [{ kind: 'image' }])
  assert.equal(image.unavailableReason, undefined)
  const audio = buildReplyReference({ ok: true, message: { messageId: 'om_a', messageType: 'audio', content: {} } })
  assert.deepEqual(audio.attachments, [{ kind: 'audio' }])
  const media = buildReplyReference({ ok: true, message: { messageId: 'om_m', messageType: 'media', content: { file_name: '/d/x.mp4' } } })
  assert.deepEqual(media.attachments, [{ kind: 'video', name: 'x.mp4' }])
  const sticker = buildReplyReference({ ok: true, message: { messageId: 'om_s', messageType: 'sticker', content: {} } })
  assert.deepEqual(sticker.attachments, [{ kind: 'other' }])
})
