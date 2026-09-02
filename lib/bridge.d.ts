/**
 * The bridge orchestrator: Feishu chats ↔ dsh agent sessions.
 *
 * Inbound Feishu messages are delivered into a per-chat dsh session
 * (`agent.followup`); dsh session events stream back into the chat as one
 * live streaming card per turn (the card is patched in place - silent, no
 * unread notification). Approval requests for the bridge's own agents
 * become Allow/Reject cards; the Stop button cancels the running turn.
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
    /** Materialize one inbound image (download + attach/save); absent disables image delivery. */
    readonly resolveInboundImage?: (messageId: string, imageKey: string) => Promise<InboundImageResult | undefined>;
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
    /** Render reasoning/thinking rows on cards (default true). */
    readonly showReasoning?: boolean;
}
/** One-line summary of a tool call for the activity rows. */
export declare function toolRowSummary(name: string, argsJson: string): string;
export declare class Bridge {
    private readonly options;
    private readonly seen;
    private readonly turns;
    /** Titles of messages queued while a chat's turn was still running. */
    private readonly queuedTurns;
    /** Final snapshots per chat, so the detail toggle works on finished cards. */
    private readonly lastSnapshots;
    private readonly approvals;
    private readonly turnDisposers;
    private readonly counters;
    constructor(options: BridgeOptions);
    /** Inbound-message counters for the /feishu status surface. */
    stats(): {
        received: number;
        delivered: number;
        dropped: number;
    };
    /** Wire transport handlers; call after `transport.start()`. */
    start(): void;
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
    /** `/effort` — show the pinned reasoning effort, or set/clear it. */
    private handleEffortCommand;
    /** Resolve (or create) the chat's agent, then deliver one user turn.
     *  `blocks` overrides the default text-only content (e.g. an image block). */
    private deliver;
    /** Live agent for the chat's bound session, resuming or creating as needed. */
    private ensureAgent;
    /** Fold one session event into the owning chat's streaming card. */
    private handleSessionEvent;
    private syncCard;
    /**
     * Answerer for the `approval/request` waterfall: requests for the
     * bridge's own agents become Feishu approval cards; everything else
     * delegates down the chain (`next()`).
     */
    handleApprovalRequest(request: ApprovalRequestLike, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome>;
    /** Route a card-button callback (approval decision, stop, detail toggle, session switch). */
    private handleCardAction;
}
