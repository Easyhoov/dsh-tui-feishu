/**
 * Card copy in zh/en. Cards pick one language at build time (the bridge's
 * configured locale, default zh); the same labels hermes-lark-streaming
 * renders bilingually via i18n_content are provided in both languages here.
 *
 * @module dsh-tui-feishu/i18n
 */

/** Supported card locales. */
export type CardLocale = 'zh' | 'en'

/** One copy key: { zh, en }. */
export type Copy = Record<CardLocale, string>

export const COPY: Record<string, Copy> = {
  thinking: { zh: '💭 思考…', en: '💭 Thinking…' },
  workingNote: { zh: '… 思考中', en: '… working' },
  doneNote: { zh: '✅ 完成', en: '✅ Done' },
  stoppedNote: { zh: '⏹ 已停止', en: '⏹ Stopped' },
  errorNote: { zh: '⚠️ 回合出错结束', en: '⚠️ turn ended with an error' },
  truncated: { zh: '…（更多内容略）', en: '… (more omitted)' },
  earlierTrimmed: { zh: '…(earlier output trimmed)', en: '…(earlier output trimmed)' },
  detailArgs: { zh: '📥 参数', en: '📥 Args' },
  detailResult: { zh: '📤 结果', en: '📤 Result' },
  detailError: { zh: '❌ 错误', en: '❌ Error' },
  status: { zh: '状态', en: 'Status' },
  elapsed: { zh: '耗时', en: 'Elapsed' },
  model: { zh: '模型', en: 'Model' },
  toolsTitle: { zh: '🛠️ 工具调用', en: '🛠️ Tool use' },
  running: { zh: '运行中', en: 'Running' },
  succeeded: { zh: '成功', en: 'Succeeded' },
  failed: { zh: '失败', en: 'Failed' },
  stopped: { zh: '已停止', en: 'Stopped' },
}

/** Pick one language's copy for a key. */
export function t(key: string, locale: CardLocale): string {
  return COPY[key]?.[locale] ?? key
}
