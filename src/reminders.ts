/**
 * Scheduled reminders: `/remind 10m 喝水` arms a timer that fires a
 * reminder into the chat's agent (a normal turn, so the agent phrases it);
 * `/remind 09:00 站会` repeats daily. Reminders persist to a JSON file so
 * they survive host restarts - on load, overdue one-shots fire shortly
 * after boot and future ones re-arm.
 *
 * @module dsh-tui-feishu/reminders
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/** One reminder. Exactly one of `at` (one-shot epoch ms) / `daily` (HH:MM). */
export interface Reminder {
  readonly id: string
  readonly chatId: string
  readonly text: string
  /** One-shot fire time (epoch ms). */
  readonly at?: number
  /** Daily fire time, local 'HH:MM'. */
  readonly daily?: string
  readonly createdAt: number
}

/** Parsed `/remind` time argument. */
export type ReminderTime = { readonly kind: 'once'; readonly at: number } | { readonly kind: 'daily'; readonly daily: string }

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }
/** One-shot horizon cap: a week. */
const MAX_ONCE_MS = 7 * 86_400_000

/**
 * Parse a `/remind` time argument: `<n>s|m|h|d` for a one-shot, `HH:MM`
 * (24h, local time) for a daily repeat. `undefined` when unparseable.
 */
export function parseReminderTime(arg: string, now = Date.now()): ReminderTime | undefined {
  const relative = /^(\d+)([smhd])$/.exec(arg)
  if (relative !== null) {
    const amount = Number.parseInt(relative[1] ?? '0', 10)
    const unit = UNIT_MS[relative[2] ?? '']
    if (unit === undefined || amount <= 0) return undefined
    const delta = amount * unit
    if (delta > MAX_ONCE_MS) return undefined
    return { kind: 'once', at: now + delta }
  }
  const clock = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(arg)
  if (clock !== null) {
    return { kind: 'daily', daily: `${(clock[1] ?? '0').padStart(2, '0')}:${clock[2]}` }
  }
  return undefined
}

/** The next local epoch ms a daily 'HH:MM' fires at (today, else tomorrow). */
export function nextDailyAt(daily: string, now = Date.now()): number {
  const [hours, minutes] = daily.split(':').map(part => Number.parseInt(part, 10))
  const next = new Date(now)
  next.setHours(hours ?? 0, minutes ?? 0, 0, 0)
  if (next.getTime() <= now) next.setDate(next.getDate() + 1)
  return next.getTime()
}

/** Human-readable fire-time label for listings. */
export function describeReminder(reminder: Reminder): string {
  if (reminder.daily !== undefined) return `每天 ${reminder.daily}`
  const at = reminder.at ?? 0
  const date = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

interface ReminderFile {
  reminders: Reminder[]
}

/** How long after boot an overdue one-shot fires (lets the transport connect). */
const OVERDUE_GRACE_MS = 10_000

/**
 * The reminder registry: owns one timer per reminder, persists every
 * mutation atomically. Firing is delegated to the caller.
 */
export class ReminderStore {
  private reminders: Reminder[] = []
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private readonly path: string,
    private readonly fire: (reminder: Reminder) => void,
    private readonly logger: { warn(message: string): void } = { warn: () => {} },
  ) {}

  /** Load persisted reminders and arm their timers (corrupt file starts empty). */
  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch {
      return
    }
    try {
      const parsed = JSON.parse(raw) as ReminderFile
      if (Array.isArray(parsed?.reminders)) this.reminders = parsed.reminders
    } catch {
      return
    }
    for (const reminder of this.reminders) this.arm(reminder)
  }

  /** Persist atomically (best effort - a lost write costs the last mutation). */
  private async persist(): Promise<void> {
    const tmp = `${this.path}.tmp`
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(tmp, JSON.stringify({ reminders: this.reminders } satisfies ReminderFile, undefined, 2), 'utf8')
    await rename(tmp, this.path)
  }

  /** Add and arm a reminder. */
  add(chatId: string, text: string, time: ReminderTime): Reminder {
    const reminder: Reminder = {
      id: randomUUID(),
      chatId,
      text,
      createdAt: Date.now(),
      ...(time.kind === 'once' ? { at: time.at } : { daily: time.daily }),
    }
    this.reminders.push(reminder)
    this.arm(reminder)
    void this.persist().catch((error: unknown) => this.logger.warn(`reminder persist failed: ${String(error)}`))
    return reminder
  }

  /** A chat's reminders in creation order. */
  list(chatId: string): readonly Reminder[] {
    return this.reminders.filter(reminder => reminder.chatId === chatId)
  }

  /** Remove the chat's n-th reminder (1-based, as listed); `undefined` when out of range. */
  removeAt(chatId: string, index: number): Reminder | undefined {
    const owned = this.list(chatId)
    const target = owned[index - 1]
    if (target === undefined) return undefined
    this.reminders = this.reminders.filter(reminder => reminder.id !== target.id)
    const timer = this.timers.get(target.id)
    if (timer !== undefined) clearTimeout(timer)
    this.timers.delete(target.id)
    void this.persist().catch((error: unknown) => this.logger.warn(`reminder persist failed: ${String(error)}`))
    return target
  }

  /** Clear every timer (host shutdown). */
  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  private arm(reminder: Reminder): void {
    const now = Date.now()
    let delay: number
    if (reminder.daily !== undefined) {
      delay = nextDailyAt(reminder.daily, now) - now
    } else {
      const at = reminder.at ?? now
      // Overdue one-shot (host was off): fire shortly after boot, not instantly.
      delay = at <= now ? OVERDUE_GRACE_MS : at - now
    }
    const timer = setTimeout(() => this.onTimer(reminder), delay)
    timer.unref?.()
    this.timers.set(reminder.id, timer)
  }

  private onTimer(reminder: Reminder): void {
    this.timers.delete(reminder.id)
    this.fire(reminder)
    if (reminder.daily !== undefined) {
      this.arm(reminder) // daily repeats re-arm for tomorrow
    } else {
      this.reminders = this.reminders.filter(entry => entry.id !== reminder.id)
      void this.persist().catch(() => {})
    }
  }
}
