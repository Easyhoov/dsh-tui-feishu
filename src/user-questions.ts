/**
 * Feishu answer cards for `ask_user_question` — the bridge half of the dsh
 * user-interaction seam (`ctx.userQuestions`).
 *
 * The model-facing `ask_user_question` tool parks the agent turn on
 * `UserQuestionService.ask()` until a registered UI provider answers. On the
 * dsh-TUI host the seat is normally held by the TUI's own QuestionStore
 * (panel in the tmux UI), which a Feishu user can neither see nor operate —
 * that deadlock is what this module fixes: the bridge takes the single legacy
 * provider seat and renders interactive question cards in the bound Feishu
 * chat instead. Questions that do not belong to a bridge-bound agent (typed
 * in the TUI itself, or agentless wizard asks) delegate back to the captured
 * incumbent provider so the TUI panel keeps working for its own front door.
 *
 * Host pairing (dsh 0.1.1-rc.2) exposes the legacy single-seat
 * `registerProvider` API only; the alpha.2 `user-questions/request` waterfall
 * does not exist on this pairing. The seat is therefore handled structurally:
 * registration through the public API when the seat is empty, and a
 * capture-and-replace handover when the TUI already holds it (the same
 * `service.provider` read the TUI's own providerGuard performs). All types
 * here are structural subsets of `@deepseek-ai/dsh-user-questions` — the
 * plugin intentionally never imports that package, staying compatible with
 * hosts that omit it.
 *
 * @module dsh-tui-feishu/user-questions
 */

/** One option of a question (subset of `AskUserQuestionOption`). */
export interface UserQuestionOptionLike {
  readonly label: string
  readonly description?: string
}

/** One question (subset of `AskUserQuestionItem`). */
export interface UserQuestionLike {
  readonly id: string
  readonly question: string
  readonly header?: string
  readonly detail?: string
  readonly options?: readonly UserQuestionOptionLike[]
  readonly multiSelect?: boolean
  /** Presentation intent (e.g. plan-review); changes chrome only. */
  readonly intent?: { readonly kind?: string; readonly approve?: string }
}

/** One answered question (subset of `AskUserQuestionAnswerItem`). */
export interface UserQuestionAnswerItemLike {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

/** The human's answer (subset of `AskUserQuestionAnswer`). */
export interface UserQuestionAnswerLike {
  readonly answers: readonly UserQuestionAnswerItemLike[]
}

/** An `ask()` request (subset of `AskUserQuestionRequest`). */
export interface UserQuestionRequestLike {
  readonly questions: readonly UserQuestionLike[]
  readonly agent?: { readonly id: unknown }
  readonly signal?: AbortSignal
}

/** UI-side provider contract (subset of `UserQuestionProvider`). */
export interface UserQuestionProviderLike {
  ask(request: UserQuestionRequestLike): Promise<UserQuestionAnswerLike>
}

/** The host service as the bridge needs it (subset of `UserQuestionService`). */
export interface UserQuestionsServiceLike {
  /** The legacy rc.2 seat API; absent on alpha.2 waterfall pairings. */
  readonly registerProvider?: (provider: UserQuestionProviderLike) => () => void
  /** The incumbent provider object (structural probe, like providerGuard). */
  readonly provider?: unknown
}

/** Failure codes shared with the upstream user-questions contract. */
export const QUESTION_ABORTED = 'ASK_ABORTED'
export const QUESTION_CANCELLED = 'ASK_CANCELLED'

/**
 * Build an error shaped like upstream's `UserQuestionError` (same name and
 * stable `code` property) without importing the package. dsh-plan-mode keys
 * on the code (`ASK_CANCELLED` = the human dismissed the question to speak)
 * so the codes must match exactly; the messages mirror upstream wording.
 */
export function createQuestionError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string }
  error.name = 'UserQuestionError'
  error.code = code
  return error
}

/** Whether `value` looks like a provider (an object with an `ask` function). */
function isProviderLike(value: unknown): value is UserQuestionProviderLike {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { ask?: unknown }).ask === 'function'
  )
}

/** Result of installing the bridge's provider into the legacy seat. */
export interface QuestionSeat {
  /** Unregister/replace: restores the prior seat state. */
  dispose(): void
  /**
   * Provider to delegate non-bridge asks to (the captured incumbent), or
   * `undefined` when the bridge registered into an empty seat (there was no
   * incumbent to defer to).
   */
  readonly delegate: UserQuestionProviderLike | undefined
}

/**
 * Put `provider` into the single legacy user-questions seat.
 *
 * Strategy: try the public `registerProvider` API first (clean when the seat
 * is empty). When it reports DUPLICATE_PROVIDER — the dsh-TUI host registers
 * its QuestionStore at boot, before this plugin's bridge starts — hand the
 * seat over structurally: capture the incumbent as the delegation target and
 * replace `service.provider`. The captured incumbent is what keeps
 * TUI-originated questions on the TUI panel.
 *
 * The incumbent capture mirrors the dsh-tui providerGuard probe: the compiled
 * service stores the active provider on a plain `provider` property that the
 * upstream guard itself reads structurally. Registration is synchronous on an
 * active context (the bridge starts long after boot), so the DUPLICATE error
 * surfaces directly from the call.
 *
 * Never throws for a busy seat; throws for any other registration failure.
 */
export function installUserQuestionsProvider(
  service: UserQuestionsServiceLike,
  provider: UserQuestionProviderLike,
  onHandover: (detail: string) => void,
): QuestionSeat {
  if (typeof service.registerProvider === 'function') {
    try {
      // Sync on an active context. Call the method directly — the unbound
      // `register` reference would lose its receiver (ESM strict mode makes
      // `this` undefined inside registerProvider, which reads `this.ctx`).
      const dispose = service.registerProvider(provider)
      return { dispose: () => void dispose(), delegate: undefined }
    } catch (error: unknown) {
      if ((error as { code?: unknown } | undefined)?.code !== 'DUPLICATE_PROVIDER') {
        throw error
      }
      onHandover('user-questions provider seat already occupied; handing over (incumbent kept for delegation)')
    }
  } else {
    onHandover('user-questions service exposes no registerProvider seat; falling back to the structural provider slot')
  }
  const holder = service as unknown as { provider?: unknown }
  if (!('provider' in holder)) {
    // No legacy single-seat slot at all (a waterfall-era service): setting a
    // property would be a silent no-op and leave model questions unanswered.
    onHandover('service exposes neither registerProvider nor a provider slot (waterfall-era host?); not installing')
    return { delegate: undefined, dispose: () => {} }
  }
  const incumbent = holder.provider
  const delegate = isProviderLike(incumbent) ? incumbent : undefined
  if (delegate === undefined) {
    onHandover('no incumbent provider found to delegate non-bridge questions to (TUI-driven asks cannot open the panel)')
  }
  holder.provider = provider
  return {
    delegate,
    dispose: () => {
      // Restore only when we still own the seat (a later reinstall may have
      // replaced us already).
      if (holder.provider === provider) holder.provider = incumbent
    },
  }
}

/** Human-readable summary of one answered question (card settle copy). */
export function summarizeAnswer(answer: {
  readonly selected: readonly string[]
  readonly custom?: string
}): string {
  const labels = answer.selected.join('、')
  const custom = answer.custom
  if (custom !== undefined && custom !== '') {
    return labels === '' ? custom : `${labels}：${custom}`
  }
  return labels === '' ? '（未选择）' : labels
}

/** Long-label display cap for card buttons. */
const BUTTON_LABEL_CHARS = 36
/** Truncation caps for card markdown sections. */
const QUESTION_CHARS = 4000
const DETAIL_CHARS = 6000
const OPTION_DESCRIPTION_CHARS = 300
/** Options above this count are listed as text, not buttons. */
const BUTTON_OPTION_LIMIT = 10
/** One action element holds at most this many buttons (Feishu layout cap). */
const BUTTONS_PER_ACTION = 5

/** Card chrome copy (default bridge locale zh; matches recent card copy). */
const CHROME = {
  headerGeneric: '❓ 需要你确认',
  headerPlan: '📋 计划待审批',
  headerAnswered: '✅ 已回答',
  headerCancelled: '⛔ 提问已取消',
  customHint: '💬 不想点按钮？直接回复文字即可作为答案。',
  optionsNote: (count: number): string => `（选项较多，仅展示前 ${count} 个；其余可直接回复文字）`,
  truncateNote: '…（内容过长已截断）',
  answeredNote: (question: string, answer: string): string =>
    `**${question}**\n\n✅ 你的回答：${answer}`,
  cancelledNote: '这个提问已被取消（agent 回合可能已停止）。',
} as const

/** True when the label is the intent's approve option (recommended). */
function isApproveOption(label: string, question: UserQuestionLike): boolean {
  const approve = question.intent?.approve
  if (approve !== undefined && approve !== '') return label === approve
  return /\((?:Recommended|推荐)\)|（推荐）/.test(label)
}

/** Trim a long markdown fragment with a truncation note. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}${CHROME.truncateNote}`
}

/** Collapse excessive blank lines and markdown-tricky control chars. */
function tidy(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Build one option line for the card body (`1. label — desc`). */
function optionLine(option: UserQuestionOptionLike, index: number): string {
  const label = tidy(option.label)
  if (option.description === undefined || option.description === '') return `${index}. ${label}`
  const description = clip(tidy(option.description), OPTION_DESCRIPTION_CHARS).replace(/\n/g, ' ')
  return `${index}. ${label} — ${description}`
}

/** The markdown body shared by the card and the plain-text fallback. */
function questionBody(question: UserQuestionLike): string {
  const parts: string[] = []
  const header = question.header
  if (header !== undefined && header.trim() !== '') {
    parts.push(`**${clip(tidy(header), 80)}**`)
  }
  parts.push(clip(tidy(question.question), QUESTION_CHARS))
  const detail = question.detail
  if (detail !== undefined && detail.trim() !== '') {
    parts.push(`> ${clip(tidy(detail), DETAIL_CHARS).replace(/\n/g, '\n> ')}`)
  }
  const options = question.options ?? []
  if (options.length > 0) {
    const lines = options
      .slice(0, BUTTON_OPTION_LIMIT + 10) // text list keeps a few beyond the buttons
      .map((option, index) => optionLine(option, index + 1))
    parts.push(''.concat('**选项：**\n', lines.join('\n')))
    if (options.length > BUTTON_OPTION_LIMIT + 10) {
      parts.push(CHROME.optionsNote(options.length - BUTTON_OPTION_LIMIT - 10))
    }
  }
  return parts.join('\n\n')
}

/** Button value payload shared by every question-button kind. */
function buttonValue(question: UserQuestionLike, extra: Record<string, string>): Record<string, string> {
  return { kind: 'question', qid: question.id, ...extra }
}

/** Build the interactive question card JSON (Feishu interactive v1). */
export function buildQuestionCardBody(
  question: UserQuestionLike,
  options: { readonly toggled?: ReadonlySet<string> } = {},
): unknown {
  const planReview = question.intent?.kind === 'plan-review'
  const all = question.options ?? []
  const multiSelect = question.multiSelect === true
  const buttons = all
    .slice(0, BUTTON_OPTION_LIMIT)
    .map((option, index) => {
      const label = option.label
      const toggled = multiSelect && options.toggled !== undefined && options.toggled.has(label)
      const display = label.length > BUTTON_LABEL_CHARS ? `${label.slice(0, BUTTON_LABEL_CHARS)}…` : label
      return {
        tag: 'button',
        text: { tag: 'plain_text', content: display },
        type: toggled || (!multiSelect && isApproveOption(label, question)) ? 'primary' : 'default',
        value: buttonValue(question, { action: 'choose', option: label }),
      }
    })
  const elements: Record<string, unknown>[] = [{ tag: 'markdown', content: questionBody(question) }]
  if (buttons.length > 0) {
    // Split into several action rows (Feishu renders ~5 buttons per row max).
    for (let i = 0; i < buttons.length; i += BUTTONS_PER_ACTION) {
      elements.push({ tag: 'action', actions: buttons.slice(i, i + BUTTONS_PER_ACTION) })
    }
  }
  if (multiSelect && all.length > 0) {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '✅ 完成选择' },
          type: 'primary',
          value: buttonValue(question, { action: 'done' }),
        },
      ],
    })
  }
  elements.push({
    tag: 'note',
    elements: [
      {
        tag: 'plain_text',
        content: all.length > 0 ? `${CHROME.customHint} ⏹ 停止请用回复卡片上的按钮。` : '💬 请直接回复文字作为答案。',
      },
    ],
  })
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: planReview ? CHROME.headerPlan : CHROME.headerGeneric },
      template: planReview ? 'violet' : 'blue',
    },
    elements,
  }
}

/** Build the settled (answered) card JSON for one question. */
export function buildQuestionSettledBody(question: UserQuestionLike, answerText: string): unknown {
  const body = `${questionBody(question)}\n\n---\n\n${CHROME.answeredNote(
    clip(tidy(question.question), QUESTION_CHARS),
    answerText,
  )}`
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: CHROME.headerAnswered }, template: 'green' },
    elements: [{ tag: 'markdown', content: body }],
  }
}

/** Build the cancelled-card JSON (ask aborted before an answer). */
export function buildQuestionCancelledBody(question: UserQuestionLike): unknown {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: CHROME.headerCancelled }, template: 'grey' },
    elements: [{ tag: 'markdown', content: `${questionBody(question)}\n\n---\n\n${CHROME.cancelledNote}` }],
  }
}

/** Plain-text rendering of a question (card-send fallback). */
export function buildQuestionPlainText(question: UserQuestionLike): string {
  const lines: string[] = []
  const header = question.header
  lines.push(header !== undefined && header.trim() !== '' ? `❓ [${clip(tidy(header), 80)}] ${clip(tidy(question.question), QUESTION_CHARS)}` : `❓ ${clip(tidy(question.question), QUESTION_CHARS)}`)
  const options = question.options ?? []
  if (options.length > 0) {
    lines.push('')
    lines.push(...options.slice(0, BUTTON_OPTION_LIMIT + 10).map((option, index) => optionLine(option, index + 1)))
  }
  lines.push('', '💬 直接回复文字即可作为答案（也可以回复上面的选项文字）。')
  return lines.join('\n')
}
