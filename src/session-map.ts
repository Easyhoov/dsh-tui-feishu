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

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** A model route a chat pinned via /model. */
export interface ModelRoute {
  provider: string
  model: string
}

/** One chat binding. */
export interface ChatBinding {
  /** The dsh session id currently serving this chat (the active one). */
  sessionId: string
  /** Every session id this chat has used, oldest first; sessionId ∈ sessionIds. */
  sessionIds: string[]
  /** First-prompt previews per session id, for the /sessions listing. */
  titles: Record<string, string>
  /** Working directory the session was created in. */
  cwd: string
  /** Unix epoch ms of the binding's last activity. */
  lastActiveAt: number
  /** Chat-pinned model route (takes effect on the live agent and on resume). */
  route?: ModelRoute
  /** Chat-pinned reasoning effort id; absent restores provider default. */
  effort?: string
}

interface SessionMapFile {
  chats: Record<string, ChatBinding>
}

/**
 * The chat↔session map. Not concurrency-hardened beyond write-atomicity:
 * one bridge instance owns the file, and a torn write is repaired by the
 * rename dance below (a partial `credentials.json`-style loss is impossible;
 * the worst case is losing the last unsaved mutation).
 */
export class SessionMap {
  private readonly path: string
  private chats = new Map<string, ChatBinding>()

  constructor(path: string) {
    this.path = path
  }

  /** Load the persisted map; a missing or corrupt file starts empty. */
  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch {
      return
    }
    try {
      const parsed = JSON.parse(raw) as SessionMapFile
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.chats === 'object') {
        this.chats = new Map(Object.entries(parsed.chats))
        // Migrate bindings written before sessionIds/titles existed.
        for (const binding of this.chats.values()) {
          if (!Array.isArray(binding.sessionIds)) binding.sessionIds = [binding.sessionId]
          if (binding.titles === null || typeof binding.titles !== 'object') binding.titles = {}
        }
      }
    } catch {
      // Corrupt map: start empty rather than crash the bridge.
    }
  }

  /** Persist atomically (write temp + rename over the target). */
  async persist(): Promise<void> {
    const file: SessionMapFile = { chats: Object.fromEntries(this.chats) }
    const tmp = `${this.path}.tmp`
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(tmp, JSON.stringify(file, undefined, 2), 'utf8')
    await rename(tmp, this.path)
  }

  /** The binding for a chat, or `undefined` when unbound. */
  get(chatId: string): ChatBinding | undefined {
    return this.chats.get(chatId)
  }

  /** Bind a chat to a (new or resumed) session id. */
  set(chatId: string, sessionId: string, cwd: string): void {
    const previous = this.chats.get(chatId)
    const sessionIds = previous?.sessionIds ?? []
    this.chats.set(chatId, {
      sessionId,
      sessionIds: sessionIds.includes(sessionId) ? sessionIds : [...sessionIds, sessionId],
      titles: previous?.titles ?? {},
      cwd,
      lastActiveAt: Date.now(),
      ...(previous?.route === undefined ? {} : { route: previous.route }),
      ...(previous?.effort === undefined ? {} : { effort: previous.effort }),
    })
  }

  /** A chat's sessions for /sessions, most recent first. */
  list(chatId: string): { sessionId: string; title: string | undefined; active: boolean }[] {
    const binding = this.chats.get(chatId)
    if (binding === undefined) return []
    return [...binding.sessionIds].reverse().map(sessionId => ({
      sessionId,
      title: binding.titles[sessionId],
      active: sessionId === binding.sessionId,
    }))
  }

  /** Make another of the chat's known sessions active; false when unknown. */
  switchTo(chatId: string, sessionId: string): boolean {
    const binding = this.chats.get(chatId)
    if (binding === undefined || !binding.sessionIds.includes(sessionId)) return false
    binding.sessionId = sessionId
    binding.lastActiveAt = Date.now()
    return true
  }

  /**
   * Forget one of the chat's sessions (the on-disk log is kept). When the
   * active session is forgotten the most recent remaining one takes over;
   * forgetting the last session unbinds the chat (a fresh one starts on the
   * next message).
   */
  remove(chatId: string, sessionId: string): 'removed' | 'activated-successor' | 'unbound' | 'not-found' {
    const binding = this.chats.get(chatId)
    if (binding === undefined || !binding.sessionIds.includes(sessionId)) return 'not-found'
    binding.sessionIds = binding.sessionIds.filter(id => id !== sessionId)
    delete binding.titles[sessionId]
    binding.lastActiveAt = Date.now()
    if (sessionId !== binding.sessionId) return 'removed'
    const successor = binding.sessionIds[binding.sessionIds.length - 1]
    if (successor === undefined) {
      this.chats.delete(chatId)
      return 'unbound'
    }
    binding.sessionId = successor
    return 'activated-successor'
  }

  /** Record a session's title preview once (first prompt); true when stored. */
  recordTitle(chatId: string, sessionId: string, title: string): boolean {
    const binding = this.chats.get(chatId)
    if (binding === undefined || binding.titles[sessionId] !== undefined) return false
    binding.titles[sessionId] = title
    return true
  }

  /** Rename a session, overwriting any recorded or pinned title. */
  rename(chatId: string, sessionId: string, title: string): boolean {
    const binding = this.chats.get(chatId)
    if (binding === undefined || !binding.sessionIds.includes(sessionId)) return false
    binding.titles[sessionId] = title
    binding.lastActiveAt = Date.now()
    return true
  }

  /** Pin a model route for a chat (persisted by the caller). */
  setRoute(chatId: string, route: ModelRoute): void {
    const binding = this.chats.get(chatId)
    if (binding === undefined) return
    binding.route = route
    binding.lastActiveAt = Date.now()
  }

  /** Pin or clear a reasoning effort for a chat (persisted by the caller). */
  setEffort(chatId: string, effort: string | undefined): void {
    const binding = this.chats.get(chatId)
    if (binding === undefined) return
    if (effort === undefined) {
      delete binding.effort
    } else {
      binding.effort = effort
    }
    binding.lastActiveAt = Date.now()
  }

  /** Drop a chat's binding (it rebinds on the next message). */
  delete(chatId: string): void {
    this.chats.delete(chatId)
  }

  /** The chat bound to a session id, or `undefined`. */
  chatFor(sessionId: string): string | undefined {
    for (const [chatId, binding] of this.chats) {
      if (binding.sessionId === sessionId) return chatId
    }
    return undefined
  }

  /** Mint a fresh session id for a chat (old sessions stay in the list). */
  remint(chatId: string): string {
    const previous = this.chats.get(chatId)
    const sessionId = randomUUID()
    this.chats.set(chatId, {
      sessionId,
      sessionIds: [...(previous?.sessionIds ?? []), sessionId],
      titles: previous?.titles ?? {},
      cwd: previous?.cwd ?? process.cwd(),
      lastActiveAt: Date.now(),
      ...(previous?.route === undefined ? {} : { route: previous.route }),
      ...(previous?.effort === undefined ? {} : { effort: previous.effort }),
    })
    return sessionId
  }

  /** Number of bound chats. */
  get size(): number {
    return this.chats.size
  }

  /** All bindings, for status rendering. */
  entries(): ReadonlyMap<string, ChatBinding> {
    return this.chats
  }
}

/** Durable credential storage for the paired Feishu app. */
export interface StoredCredentials {
  appId: string
  appSecret: string
  /** Open id of the pairing user - the bridge's default owner. */
  ownerOpenId?: string
}

/**
 * Read paired credentials from `<dataDir>/credentials.json`, or `undefined`
 * when absent/corrupt.
 */
export async function readCredentials(path: string): Promise<StoredCredentials | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredCredentials>
    if (typeof parsed.appId === 'string' && typeof parsed.appSecret === 'string') {
      return {
        appId: parsed.appId,
        appSecret: parsed.appSecret,
        ...(typeof parsed.ownerOpenId === 'string' && parsed.ownerOpenId !== ''
          ? { ownerOpenId: parsed.ownerOpenId }
          : {}),
      }
    }
  } catch {
    // fall through
  }
  return undefined
}

/** Persist paired credentials (best-effort 0600; Windows ignores the mode). */
export async function writeCredentials(
  path: string,
  credentials: StoredCredentials,
): Promise<void> {
  const tmp = `${path}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(tmp, JSON.stringify(credentials, undefined, 2), { mode: 0o600, encoding: 'utf8' })
  await rename(tmp, path)
}

/** Default plugin data file locations under one directory. */
export function dataFiles(dataDir: string): { sessionMap: string; credentials: string; reminders: string } {
  return {
    sessionMap: join(dataDir, 'session-map.json'),
    credentials: join(dataDir, 'credentials.json'),
    reminders: join(dataDir, 'reminders.json'),
  }
}
