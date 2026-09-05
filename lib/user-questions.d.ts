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
    readonly label: string;
    readonly description?: string;
}
/** One question (subset of `AskUserQuestionItem`). */
export interface UserQuestionLike {
    readonly id: string;
    readonly question: string;
    readonly header?: string;
    readonly detail?: string;
    readonly options?: readonly UserQuestionOptionLike[];
    readonly multiSelect?: boolean;
    /** Presentation intent (e.g. plan-review); changes chrome only. */
    readonly intent?: {
        readonly kind?: string;
        readonly approve?: string;
    };
}
/** One answered question (subset of `AskUserQuestionAnswerItem`). */
export interface UserQuestionAnswerItemLike {
    readonly id: string;
    readonly selected: readonly string[];
    readonly custom?: string;
}
/** The human's answer (subset of `AskUserQuestionAnswer`). */
export interface UserQuestionAnswerLike {
    readonly answers: readonly UserQuestionAnswerItemLike[];
}
/** An `ask()` request (subset of `AskUserQuestionRequest`). */
export interface UserQuestionRequestLike {
    readonly questions: readonly UserQuestionLike[];
    readonly agent?: {
        readonly id: unknown;
    };
    readonly signal?: AbortSignal;
}
/** UI-side provider contract (subset of `UserQuestionProvider`). */
export interface UserQuestionProviderLike {
    ask(request: UserQuestionRequestLike): Promise<UserQuestionAnswerLike>;
}
/** The host service as the bridge needs it (subset of `UserQuestionService`). */
export interface UserQuestionsServiceLike {
    /** The legacy rc.2 seat API; absent on alpha.2 waterfall pairings. */
    readonly registerProvider?: (provider: UserQuestionProviderLike) => () => void;
    /** The incumbent provider object (structural probe, like providerGuard). */
    readonly provider?: unknown;
}
/** Failure codes shared with the upstream user-questions contract. */
export declare const QUESTION_ABORTED = "ASK_ABORTED";
export declare const QUESTION_CANCELLED = "ASK_CANCELLED";
/**
 * Build an error shaped like upstream's `UserQuestionError` (same name and
 * stable `code` property) without importing the package. dsh-plan-mode keys
 * on the code (`ASK_CANCELLED` = the human dismissed the question to speak)
 * so the codes must match exactly; the messages mirror upstream wording.
 */
export declare function createQuestionError(message: string, code: string): Error & {
    code: string;
};
/** Result of installing the bridge's provider into the legacy seat. */
export interface QuestionSeat {
    /** Unregister/replace: restores the prior seat state. */
    dispose(): void;
    /**
     * Provider to delegate non-bridge asks to (the captured incumbent), or
     * `undefined` when the bridge registered into an empty seat (there was no
     * incumbent to defer to).
     */
    readonly delegate: UserQuestionProviderLike | undefined;
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
export declare function installUserQuestionsProvider(service: UserQuestionsServiceLike, provider: UserQuestionProviderLike, onHandover: (detail: string) => void): QuestionSeat;
/** Human-readable summary of one answered question (card settle copy). */
export declare function summarizeAnswer(answer: {
    readonly selected: readonly string[];
    readonly custom?: string;
}): string;
/** Build the interactive question card JSON (Feishu interactive v1). */
export declare function buildQuestionCardBody(question: UserQuestionLike, options?: {
    readonly toggled?: ReadonlySet<string>;
}): unknown;
/** Build the settled (answered) card JSON for one question. */
export declare function buildQuestionSettledBody(question: UserQuestionLike, answerText: string): unknown;
/** Build the cancelled-card JSON (ask aborted before an answer). */
export declare function buildQuestionCancelledBody(question: UserQuestionLike): unknown;
/** Plain-text rendering of a question (card-send fallback). */
export declare function buildQuestionPlainText(question: UserQuestionLike): string;
