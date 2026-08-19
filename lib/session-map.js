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
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
/**
 * The chat↔session map. Not concurrency-hardened beyond write-atomicity:
 * one bridge instance owns the file, and a torn write is repaired by the
 * rename dance below (a partial `credentials.json`-style loss is impossible;
 * the worst case is losing the last unsaved mutation).
 */
export class SessionMap {
    path;
    chats = new Map();
    constructor(path) {
        this.path = path;
    }
    /** Load the persisted map; a missing or corrupt file starts empty. */
    async load() {
        let raw;
        try {
            raw = await readFile(this.path, 'utf8');
        }
        catch {
            return;
        }
        try {
            const parsed = JSON.parse(raw);
            if (parsed !== null && typeof parsed === 'object' && typeof parsed.chats === 'object') {
                this.chats = new Map(Object.entries(parsed.chats));
                // Migrate bindings written before sessionIds/titles existed.
                for (const binding of this.chats.values()) {
                    if (!Array.isArray(binding.sessionIds))
                        binding.sessionIds = [binding.sessionId];
                    if (binding.titles === null || typeof binding.titles !== 'object')
                        binding.titles = {};
                }
            }
        }
        catch {
            // Corrupt map: start empty rather than crash the bridge.
        }
    }
    /** Persist atomically (write temp + rename over the target). */
    async persist() {
        const file = { chats: Object.fromEntries(this.chats) };
        const tmp = `${this.path}.tmp`;
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(tmp, JSON.stringify(file, undefined, 2), 'utf8');
        await rename(tmp, this.path);
    }
    /** The binding for a chat, or `undefined` when unbound. */
    get(chatId) {
        return this.chats.get(chatId);
    }
    /** Bind a chat to a (new or resumed) session id. */
    set(chatId, sessionId, cwd) {
        const previous = this.chats.get(chatId);
        const sessionIds = previous?.sessionIds ?? [];
        this.chats.set(chatId, {
            sessionId,
            sessionIds: sessionIds.includes(sessionId) ? sessionIds : [...sessionIds, sessionId],
            titles: previous?.titles ?? {},
            cwd,
            lastActiveAt: Date.now(),
            ...(previous?.route === undefined ? {} : { route: previous.route }),
            ...(previous?.effort === undefined ? {} : { effort: previous.effort }),
        });
    }
    /** A chat's sessions for /sessions, most recent first. */
    list(chatId) {
        const binding = this.chats.get(chatId);
        if (binding === undefined)
            return [];
        return [...binding.sessionIds].reverse().map(sessionId => ({
            sessionId,
            title: binding.titles[sessionId],
            active: sessionId === binding.sessionId,
        }));
    }
    /** Make another of the chat's known sessions active; false when unknown. */
    switchTo(chatId, sessionId) {
        const binding = this.chats.get(chatId);
        if (binding === undefined || !binding.sessionIds.includes(sessionId))
            return false;
        binding.sessionId = sessionId;
        binding.lastActiveAt = Date.now();
        return true;
    }
    /**
     * Forget one of the chat's sessions (the on-disk log is kept). When the
     * active session is forgotten the most recent remaining one takes over;
     * forgetting the last session unbinds the chat (a fresh one starts on the
     * next message).
     */
    remove(chatId, sessionId) {
        const binding = this.chats.get(chatId);
        if (binding === undefined || !binding.sessionIds.includes(sessionId))
            return 'not-found';
        binding.sessionIds = binding.sessionIds.filter(id => id !== sessionId);
        delete binding.titles[sessionId];
        binding.lastActiveAt = Date.now();
        if (sessionId !== binding.sessionId)
            return 'removed';
        const successor = binding.sessionIds[binding.sessionIds.length - 1];
        if (successor === undefined) {
            this.chats.delete(chatId);
            return 'unbound';
        }
        binding.sessionId = successor;
        return 'activated-successor';
    }
    /** Record a session's title preview once (first prompt); true when stored. */
    recordTitle(chatId, sessionId, title) {
        const binding = this.chats.get(chatId);
        if (binding === undefined || binding.titles[sessionId] !== undefined)
            return false;
        binding.titles[sessionId] = title;
        return true;
    }
    /** Rename a session, overwriting any recorded or pinned title. */
    rename(chatId, sessionId, title) {
        const binding = this.chats.get(chatId);
        if (binding === undefined || !binding.sessionIds.includes(sessionId))
            return false;
        binding.titles[sessionId] = title;
        binding.lastActiveAt = Date.now();
        return true;
    }
    /** Pin a model route for a chat (persisted by the caller). */
    setRoute(chatId, route) {
        const binding = this.chats.get(chatId);
        if (binding === undefined)
            return;
        binding.route = route;
        binding.lastActiveAt = Date.now();
    }
    /** Pin or clear a reasoning effort for a chat (persisted by the caller). */
    setEffort(chatId, effort) {
        const binding = this.chats.get(chatId);
        if (binding === undefined)
            return;
        if (effort === undefined) {
            delete binding.effort;
        }
        else {
            binding.effort = effort;
        }
        binding.lastActiveAt = Date.now();
    }
    /** Drop a chat's binding (it rebinds on the next message). */
    delete(chatId) {
        this.chats.delete(chatId);
    }
    /** The chat bound to a session id, or `undefined`. */
    chatFor(sessionId) {
        for (const [chatId, binding] of this.chats) {
            if (binding.sessionId === sessionId)
                return chatId;
        }
        return undefined;
    }
    /** Mint a fresh session id for a chat (old sessions stay in the list). */
    remint(chatId) {
        const previous = this.chats.get(chatId);
        const sessionId = randomUUID();
        this.chats.set(chatId, {
            sessionId,
            sessionIds: [...(previous?.sessionIds ?? []), sessionId],
            titles: previous?.titles ?? {},
            cwd: previous?.cwd ?? process.cwd(),
            lastActiveAt: Date.now(),
            ...(previous?.route === undefined ? {} : { route: previous.route }),
            ...(previous?.effort === undefined ? {} : { effort: previous.effort }),
        });
        return sessionId;
    }
    /** Number of bound chats. */
    get size() {
        return this.chats.size;
    }
    /** All bindings, for status rendering. */
    entries() {
        return this.chats;
    }
}
/**
 * Read paired credentials from `<dataDir>/credentials.json`, or `undefined`
 * when absent/corrupt.
 */
export async function readCredentials(path) {
    let raw;
    try {
        raw = await readFile(path, 'utf8');
    }
    catch {
        return undefined;
    }
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed.appId === 'string' && typeof parsed.appSecret === 'string') {
            return {
                appId: parsed.appId,
                appSecret: parsed.appSecret,
                ...(typeof parsed.ownerOpenId === 'string' && parsed.ownerOpenId !== ''
                    ? { ownerOpenId: parsed.ownerOpenId }
                    : {}),
            };
        }
    }
    catch {
        // fall through
    }
    return undefined;
}
/** Persist paired credentials (best-effort 0600; Windows ignores the mode). */
export async function writeCredentials(path, credentials) {
    const tmp = `${path}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmp, JSON.stringify(credentials, undefined, 2), { mode: 0o600, encoding: 'utf8' });
    await rename(tmp, path);
}
/** Default plugin data file locations under one directory. */
export function dataFiles(dataDir) {
    return {
        sessionMap: join(dataDir, 'session-map.json'),
        credentials: join(dataDir, 'credentials.json'),
        reminders: join(dataDir, 'reminders.json'),
    };
}
