/**
 * Scheduled reminders: `/remind 10m 喝水` arms a timer that fires a
 * reminder into the chat's agent (a normal turn, so the agent phrases it);
 * `/remind 09:00 站会` repeats daily. Reminders persist to a JSON file so
 * they survive host restarts - on load, overdue one-shots fire shortly
 * after boot and future ones re-arm.
 *
 * @module dsh-tui-feishu/reminders
 */
/** One reminder. Exactly one of `at` (one-shot epoch ms) / `daily` (HH:MM). */
export interface Reminder {
    readonly id: string;
    readonly chatId: string;
    readonly text: string;
    /** One-shot fire time (epoch ms). */
    readonly at?: number;
    /** Daily fire time, local 'HH:MM'. */
    readonly daily?: string;
    readonly createdAt: number;
}
/** Parsed `/remind` time argument. */
export type ReminderTime = {
    readonly kind: 'once';
    readonly at: number;
} | {
    readonly kind: 'daily';
    readonly daily: string;
};
/**
 * Parse a `/remind` time argument: `<n>s|m|h|d` for a one-shot, `HH:MM`
 * (24h, local time) for a daily repeat. `undefined` when unparseable.
 */
export declare function parseReminderTime(arg: string, now?: number): ReminderTime | undefined;
/** The next local epoch ms a daily 'HH:MM' fires at (today, else tomorrow). */
export declare function nextDailyAt(daily: string, now?: number): number;
/** Human-readable fire-time label for listings. */
export declare function describeReminder(reminder: Reminder): string;
/**
 * The reminder registry: owns one timer per reminder, persists every
 * mutation atomically. Firing is delegated to the caller.
 */
export declare class ReminderStore {
    private readonly path;
    private readonly fire;
    private readonly logger;
    private reminders;
    private readonly timers;
    constructor(path: string, fire: (reminder: Reminder) => void, logger?: {
        warn(message: string): void;
    });
    /** Load persisted reminders and arm their timers (corrupt file starts empty). */
    load(): Promise<void>;
    /** Persist atomically (best effort - a lost write costs the last mutation). */
    private persist;
    /** Add and arm a reminder. */
    add(chatId: string, text: string, time: ReminderTime): Reminder;
    /** A chat's reminders in creation order. */
    list(chatId: string): readonly Reminder[];
    /** Remove the chat's n-th reminder (1-based, as listed); `undefined` when out of range. */
    removeAt(chatId: string, index: number): Reminder | undefined;
    /** Clear every timer (host shutdown). */
    dispose(): void;
    private arm;
    private onTimer;
}
