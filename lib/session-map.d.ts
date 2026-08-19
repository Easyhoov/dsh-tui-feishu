/**
 * Durable Feishu-chat ↔ dsh-session mapping.
 *
 * One JSON file under the plugin data dir holds every binding plus the
 * chat's working directory. A chat keeps its session across restarts
 * (resume keeps history); `/new` in Feishu mints a fresh session id and
 * rebinds the chat.
 *
 * Refactored from PGZXB/dsh-feishu (MIT).
 *
 * @module dsh-tui-feishu/session-map
 */
/** A model route a chat pinned via /model. */
export interface ModelRoute {
    provider: string;
    model: string;
}
/** One chat binding. */
export interface ChatBinding {
    /** The dsh session id currently serving this chat (the active one). */
    sessionId: string;
    /** Every session id this chat has used, oldest first; sessionId ∈ sessionIds. */
    sessionIds: string[];
    /** First-prompt previews per session id, for the /sessions listing. */
    titles: Record<string, string>;
    /** Working directory the session was created in. */
    cwd: string;
    /** Unix epoch ms of the binding's last activity. */
    lastActiveAt: number;
    /** Chat-pinned model route (takes effect on the live agent and on resume). */
    route?: ModelRoute;
    /** Chat-pinned reasoning effort id; absent restores provider default. */
    effort?: string;
}
/**
 * The chat↔session map. Not concurrency-hardened beyond write-atomicity:
 * one bridge instance owns the file, and a torn write is repaired by the
 * rename dance below (a partial `credentials.json`-style loss is impossible;
 * the worst case is losing the last unsaved mutation).
 */
export declare class SessionMap {
    private readonly path;
    private chats;
    constructor(path: string);
    /** Load the persisted map; a missing or corrupt file starts empty. */
    load(): Promise<void>;
    /** Persist atomically (write temp + rename over the target). */
    persist(): Promise<void>;
    /** The binding for a chat, or `undefined` when unbound. */
    get(chatId: string): ChatBinding | undefined;
    /** Bind a chat to a (new or resumed) session id. */
    set(chatId: string, sessionId: string, cwd: string): void;
    /** A chat's sessions for /sessions, most recent first. */
    list(chatId: string): {
        sessionId: string;
        title: string | undefined;
        active: boolean;
    }[];
    /** Make another of the chat's known sessions active; false when unknown. */
    switchTo(chatId: string, sessionId: string): boolean;
    /**
     * Forget one of the chat's sessions (the on-disk log is kept). When the
     * active session is forgotten the most recent remaining one takes over;
     * forgetting the last session unbinds the chat (a fresh one starts on the
     * next message).
     */
    remove(chatId: string, sessionId: string): 'removed' | 'activated-successor' | 'unbound' | 'not-found';
    /** Record a session's title preview once (first prompt); true when stored. */
    recordTitle(chatId: string, sessionId: string, title: string): boolean;
    /** Rename a session, overwriting any recorded or pinned title. */
    rename(chatId: string, sessionId: string, title: string): boolean;
    /** Pin a model route for a chat (persisted by the caller). */
    setRoute(chatId: string, route: ModelRoute): void;
    /** Pin or clear a reasoning effort for a chat (persisted by the caller). */
    setEffort(chatId: string, effort: string | undefined): void;
    /** Drop a chat's binding (it rebinds on the next message). */
    delete(chatId: string): void;
    /** The chat bound to a session id, or `undefined`. */
    chatFor(sessionId: string): string | undefined;
    /** Mint a fresh session id for a chat (old sessions stay in the list). */
    remint(chatId: string): string;
    /** Number of bound chats. */
    get size(): number;
    /** All bindings, for status rendering. */
    entries(): ReadonlyMap<string, ChatBinding>;
}
/** Durable credential storage for the paired Feishu app. */
export interface StoredCredentials {
    appId: string;
    appSecret: string;
    /** Open id of the pairing user - the bridge's default owner. */
    ownerOpenId?: string;
}
/**
 * Read paired credentials from `<dataDir>/credentials.json`, or `undefined`
 * when absent/corrupt.
 */
export declare function readCredentials(path: string): Promise<StoredCredentials | undefined>;
/** Persist paired credentials (best-effort 0600; Windows ignores the mode). */
export declare function writeCredentials(path: string, credentials: StoredCredentials): Promise<void>;
/** Default plugin data file locations under one directory. */
export declare function dataFiles(dataDir: string): {
    sessionMap: string;
    credentials: string;
    reminders: string;
};
