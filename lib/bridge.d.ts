/**
 * The bridge orchestrator: Feishu chats ↔ dsh agent sessions.
 *
 * Inbound Feishu messages are delivered into a per-chat dsh session
 * (`agent.followup`); dsh session events stream back into the chat as one
 * live streaming card per turn (the card is patched in place - silent, no
 * unread notification). Approval requests for the bridge's own agents
 * become Allow/Reject cards; `ask_user_question` from a bridge-bound agent
 * becomes interactive question cards (option buttons, multi-select, and a
 * type-your-answer fallback); the Stop button cancels the running turn.
 *
 * The bridge never touches agent internals beyond the public surface:
 * create/resume, followup, cancel, and the `session/event` stream.
 *
 * Refactored from PGZXB/dsh-feishu (MIT), scoped to the p2p chat loop.
 *
 * @module dsh-tui-feishu/bridge
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { CardStream } from './cards.js';
import { type Reminder, type ReminderStore } from './reminders.js';
import type { LarkTransport } from './transport.js';
import type { SessionMap } from './session-map.js';
import { type UserQuestionAnswerLike, type UserQuestionRequestLike } from './user-questions.js';
/** Minimal logger surface the bridge needs. */
export interface BridgeLogger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}
/** A chat's pinned model preferences, applied at create/resume time. */
export interface SessionPrefs {
    readonly route?: {
        readonly provider: string;
        readonly model: string;
    };
    readonly effort?: string;
}
/** Structural subset of the host's `ImageAttachmentRef` (kept local for loose coupling). */
export interface ImageAttachmentRefLike {
    readonly attachmentId: string;
    readonly mediaType: string;
    readonly bytes: number;
    readonly width: number;
    readonly height: number;
    readonly name?: string;
}
/** How an inbound Feishu image was materialized for the agent. */
export type InboundImageResult = {
    readonly kind: 'attachment';
    readonly ref: ImageAttachmentRefLike;
} | {
    readonly kind: 'file';
    readonly path: string;
};
/** How an inbound Feishu file was materialized for the agent. */
export type InboundFileResult = {
    readonly path: string;
};
/** Adapts the dsh agent registry to the bridge's needs (injectable for tests). */
export interface AgentStore {
    /** The live agent for a session, or `undefined`. */
    get(sessionId: string): Agent | undefined;
    /** Resume an agent on a persisted session (daemon restart); throws when no log exists. */
    resume(sessionId: string, prefs?: SessionPrefs): Promise<Agent>;
    /** Create an agent (and its session) for the given id and working directory. */
    create(sessionId: string, cwd: string, prefs?: SessionPrefs): Promise<Agent>;
}
/** The approval settlement union (structural subset of dsh's ApprovalOutcome). */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
/** Structural subset of dsh's approval request (kept local for loose coupling). */
export interface ApprovalRequestLike {
    readonly agent: {
        readonly id: unknown;
    };
    readonly toolName: string;
    readonly callId?: string;
    readonly reason?: string;
    readonly signal?: AbortSignal;
}
/** A chat's effective model route, for /model status and switching. */
export interface ChatRoute {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string;
}
/** Model/effort control for one chat's session (host-provided; optional). */
export interface ModelControl {
    /** The chat's effective route: live selection, else pinned route, else host default. */
    get(chatId: string): ChatRoute | undefined;
    /** Pin a route for the chat; applies to the live agent from the next step and persists for resume. */
    setModel(chatId: string, provider: string, model: string): Promise<void>;
    /** Pin or clear (`undefined`) the reasoning effort; same application rules. */
    setEffort(chatId: string, effort: string | undefined): Promise<void>;
    /** Every provider's advertised models, or `undefined` when the host cannot list. */
    listAll?(): Promise<readonly {
        provider: string;
        models: readonly string[];
    }[] | undefined>;
}
/** Bridge options. */
export interface BridgeOptions {
    readonly transport: LarkTransport;
    readonly sessionMap: SessionMap;
    readonly agentStore: AgentStore;
    readonly cards: CardStream;
    readonly logger: BridgeLogger;
    /** Working directory for newly created sessions. */
    readonly defaultCwd: string;
    /** Allowed sender open ids; when empty, every p2p sender is served. */
    readonly allowedUsers?: readonly string[];
    /** Model/effort switching for /model and /effort; absent disables both commands. */
    readonly modelControl?: ModelControl;
    /** Scheduled reminders backing /remind, /reminders, /unremind. */
    readonly reminders?: ReminderStore;
    /** Resolve remote answer images to Feishu keys at turn end (default true). */
    readonly resolveImages?: boolean;
    /** Deliver inbound Feishu image messages to the agent (default true). */
    readonly receiveImages?: boolean;
    /** Materialize one inbound image (download + attach/save); absent disables image delivery.
     *  `preferFile` asks the host to skip the attachment pipeline and save the bytes
     *  to a workspace file instead (Feature B: the model cannot see images anyway). */
    readonly resolveInboundImage?: (messageId: string, imageKey: string, preferFile?: boolean) => Promise<InboundImageResult | undefined>;
    /** Deliver inbound Feishu file messages to the agent (default true). */
    readonly receiveFiles?: boolean;
    /** Materialize one inbound file (download + save); absent disables file delivery. */
    readonly resolveInboundFile?: (messageId: string, fileKey: string) => Promise<InboundFileResult | undefined>;
    /** Resolve quoted-message context (default on; needs transport.getMessage). */
    readonly replyReference?: boolean;
    /** Model-info probe for Feature B pre-check; absent keeps 0.3.2 behavior. */
    readonly resolveModelSupportsImages?: (route: {
        provider: string;
        model: string;
    }) => Promise<boolean | undefined>;
    /** Feature B: deliver images as files for non-visual models (default on). */
    readonly imageFileFallback?: boolean;
    /** Feature C: agent tool to send files back to the chat (default on when sender given). */
    readonly outboundFiles?: boolean;
    /** Feature C transport: upload + send one file into a chat; resolves the sent Feishu message id (absent disables). */
    readonly sendFileToChat?: (chatId: string, data: Uint8Array, fileName: string) => Promise<string>;
    /** Render reasoning/thinking rows on cards (default true). */
    readonly showReasoning?: boolean;
}
/** One-line summary of a tool call for the activity rows. */
export declare function toolRowSummary(name: string, argsJson: string): string;
/**
 * The Feishu↔dsh bridge.
 */
export declare class Bridge {
    private readonly options;
    private readonly seen;
    private readonly turns;
    private outboundFileState;
    /** Rolling transcript per chat (Feature F: /history backing store). */
    private readonly history;
    private watchdogTimer;
    /** When the transport first entered a sustained-bad state (watchdog, SPEC §8.1). */
    private unhealthySince;
    /** Guards against concurrent watchdog restarts (one can take >1 tick on bad networks). */
    private restartInFlight;
    /** Consecutive watchdog-triggered restarts since the connection was last healthy. */
    private restartCount;
    /** Restart backoff ladder (SPEC §8.1: 250ms→1s→3s→5s→10s→30s, then capped). */
    private static readonly RESTART_LADDER;
    /** Titles of messages queued while a chat's turn was still running. */
    private readonly queuedTurns;
    /** Final snapshots per chat, so the detail toggle works on finished cards. */
    private readonly lastSnapshots;
    private readonly approvals;
    /** Pending user-question batches, one per chat (a chat runs one turn at a time). */
    private readonly questionBatches;
    private readonly turnDisposers;
    private readonly counters;
    /** Agent ids whose outbound-file tool registration already ran (Feature C). */
    private readonly outboundToolsInstalled;
    /** Per-agent disposers for the outbound-file tool registration, released on dispose. */
    private readonly outboundToolDisposers;
    constructor(options: BridgeOptions);
    /** Inbound-message counters for the /feishu status surface. */
    stats(): {
        received: number;
        delivered: number;
        dropped: number;
    };
    /** Wire transport handlers; call after `transport.start()`. */
    start(): void;
    /** One watchdog pass: full transport restart on prolonged unhealthy state. */
    private watchdogTick;
    /** Subscribe to session events (the host owns the actual cordis listener). */
    bindSessionEvents(subscribe: (listener: (sessionId: string, event: SessionEvent) => void) => () => void): void;
    /** Tear the bridge down: settle approvals as cancelled, drop listeners. */
    dispose(): Promise<void>;
    /** Whether a sender may drive the bridge. */
    private senderAllowed;
    private dedupe;
    private handleIncoming;
    /**
     * Feature A (SPEC §4): resolve the quoted-message context for one inbound
     * message into a `<dsh_im_reply_to>` text block. Bounded, single attempt,
     * never throws; quoted content is data and never reaches command dispatch.
     */
    private resolveReplyTag;
    /** Materialize and deliver an inbound file message to the chat's agent. */
    private deliverFile;
    /** Materialize and deliver an inbound image message to the chat's agent. */
    private deliverImage;
    /**
     * Whether the chat's effective model definitively lacks image input.
     * `false`/`undefined` (visual model, unknown, probe absent, or probe
     * failure) keeps the default image-block behavior — fail open, like
     * dsh-llm's own admission check.
     */
    private modelLacksImageInput;
    private handleCommand;
    /** Best-effort persist of the session map (never breaks a command). */
    private persistMap;
    /** `/sessions` — numbered list of this chat's sessions, newest first. */
    private handleSessionsCommand;
    /**
     * Abandon the chat's live turn when the binding is switched away (/new,
     * /switch, /delete of the active session): cancel the agent, close the
     * card as stopped, drop queued titles. Without this the orphaned turn
     * state would send every later message into the queue forever.
     */
    private abandonActiveTurn;
    /** `/switch <n>` — make the n-th listed session active. */
    private handleSwitchCommand;
    /** `/rename [n] <name>` — rename the active session, or the n-th one. */
    private handleRenameCommand;
    /** `/delete <n>` — forget the n-th listed session (disk log is kept). */
    private handleDeleteCommand;
    /** `/remind <time> <text>` — arm a one-shot or daily reminder. */
    private handleRemindCommand;
    /** `/reminders` — list this chat's armed reminders. */
    private handleRemindersCommand;
    /** `/unremind <n>` — cancel the n-th reminder. */
    private handleUnremindCommand;
    /** ReminderStore callback: deliver the reminder as a normal agent turn. */
    fireReminder(reminder: Reminder): void;
    /** `/model` — show the effective route, or pin a new one for this chat. */
    private handleModelCommand;
    /**
     * `/repair` (Feature D, SPEC §7): probe the paired app's tenant scopes and
     * report which capabilities are missing with fix instructions. Probes are
     * single-shot, 5s-bounded, and never throw.
     */
    private handleRepairCommand;
    /** Run one probe, settling to `undefined` on any rejection. */
    private probe;
    /**
     * Append one transcript row (dedup consecutive identical agent text).
     * Redacts inline secrets at the entry: the in-memory store holds clean
     * data, so every present and future consumer (SPEC §9) is safe by
     * construction instead of relying on each reader remembering to redact.
     */
    private appendHistory;
    /** `/history [n]` — replay the bounded in-process transcript for this chat. */
    private handleHistoryCommand;
    /** `/compact` — request a compaction of the current session (soft-probed). */
    private handleCompactCommand;
    /** `/effort` — show the pinned reasoning effort, or set/clear it. */
    private handleEffortCommand;
    /** Resolve (or create) the chat's agent, then deliver one user turn.
     *  `blocks` overrides the default text-only content (e.g. an image block). */
    private deliver;
    /** Live agent for the chat's bound session, resuming or creating as needed. */
    private ensureAgent;
    /**
     * Feature C (SPEC §6): soft-probe the tools registry once per agent so the
     * session can send files back to the chat. Runs on EVERY ensureAgent path
     * (live reuse, resume, create) — a resumed session after a TUI restart
     * must regain the tool, not silently lose it. Idempotent per agent id;
     * never fatal.
     */
    private registerOutboundTool;
    /** /status hook: Feature C availability. */
    get outboundFilesStatus(): string;
    /** Fold one session event into the owning chat's streaming card. */
    private handleSessionEvent;
    /**
     * Close the open thinking block: stamp its wall time on the last think row
     * (the card engines show "思考中" while open and "思考 · Xs" once closed).
     * Called wherever thinking demonstrably ends (tool call, final message,
     * turn end). No-op when no thinking block is open.
     */
    private finalizeOpenThink;
    private syncCard;
    /**
     * Answerer for the `approval/request` waterfall: requests for the
     * bridge's own agents become Feishu approval cards; everything else
     * delegates down the chain (`next()`).
     */
    handleApprovalRequest(request: ApprovalRequestLike, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome>;
    /**
     * Feishu side of the user-questions seam: present one ask batch as
     * interactive question cards in `chatId` and settle with the human's
     * answer. Called by the seat provider only for bridge-bound agents; the
     * promise parks until every question is answered, the ask is aborted
     * (Stop/cancel fires the step signal), or the bridge is torn down.
     */
    askUserQuestion(chatId: string, request: UserQuestionRequestLike): Promise<UserQuestionAnswerLike>;
    /**
     * Run one batch op after every previously queued op (buttons, inbound text
     * and follow-up presentations share the chain, so the batch state can
     * never be mutated by two paths at once). Ops never throw; the chain stays
     * alive for later ops.
     */
    private withQuestionOp;
    /** Reject one pending question batch (signal abort / bridge teardown). */
    private interruptQuestionBatch;
    /**
     * Show the batch's current question card (or its plain-text fallback).
     * Runs inside the batch op chain; re-checks liveness after each await so
     * an abort that lands mid-send cannot leave a stray interactive card.
     */
    private presentQuestionNow;
    /**
     * Record one question's answer, ack it visually, then advance — or settle
     * the batch when every question is answered. Runs inside the op chain.
     */
    private settleQuestionNow;
    /** Complete a fully answered batch: settle the parked tool promise. */
    private finishQuestionBatch;
    /**
     * Consume one inbound text as the pending question's answer (the fallback
     * promised on every question card). Returns true when the message was
     * consumed; exact option-label matches count as that option, anything else
     * becomes the custom answer. Waits for any in-flight batch op so two quick
     * texts answer two questions instead of racing on one.
     */
    private tryAnswerQuestionText;
    /**
     * Route one question-card button callback (choose / done). Guards run
     * inside the batch op chain: a click that raced an earlier answer can
     * never settle the wrong question, whatever its arrival order.
     */
    private handleQuestionAction;
    /** Route a card-button callback (approval decision, stop, detail toggle, session switch). */
    private handleCardAction;
}
