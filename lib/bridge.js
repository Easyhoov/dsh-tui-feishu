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
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { stripReasoningTags } from './cardmd.js';
import { installOutboundFileTool } from './outbound-file.js';
import { parseReminderTime, describeReminder } from './reminders.js';
import { redactInlineSecrets, sanitizeToolDetail } from './redact.js';
import { buildReplyReference, replyTag, replyTargetId, unavailableReasonFromError } from './reply-reference.js';
import { resolveToolDescriptor } from './tools.js';
/** Max rows kept per chat and max chars per row for /history. */
const HISTORY_CAP_PER_CHAT = 50;
const HISTORY_ROW_CHARS = 400;
/** Target max chars per /history message (SPEC §9: send as multiple texts). */
const HISTORY_MESSAGE_CHARS = 3500;
/** /compact hard cap: a stalled compaction aborts with a clear message. */
const COMPACTION_TIMEOUT_MS = 120_000;
/** Cap the in-memory dedup window (Feishu redelivers on reconnect). */
const DEDUP_MAX = 512;
/** Card title cut-off. */
const TITLE_CHARS = 28;
/** Cap how many remote images one turn resolves (upload is slow). */
const MAX_RESOLVED_IMAGES = 6;
/**
 * Replace remote image references in answer markdown with Feishu `img_key`s
 * (download → upload). Failures keep the original URL. Only non-`img_` refs
 * are touched.
 */
async function resolveContentImages(content, transport, logger) {
    if (!content.includes('!['))
        return content;
    const refs = [...content.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)].slice(0, MAX_RESOLVED_IMAGES);
    if (refs.length === 0)
        return content;
    let result = content;
    for (const match of refs) {
        const url = match[2];
        if (url === undefined || url.startsWith('img_'))
            continue;
        try {
            const key = await transport.uploadImage(url);
            if (key !== undefined && key !== '') {
                result = result.replace(match[0], `![${match[1] ?? ''}](${key})`);
            }
        }
        catch (error) {
            logger.warn(`image resolution failed (keeping URL): ${String(error)}`);
        }
    }
    return result;
}
/** Extract visible text from assistant message content blocks. */
function assistantText(content) {
    if (!Array.isArray(content))
        return '';
    let text = '';
    for (const block of content) {
        if (block !== null &&
            typeof block === 'object' &&
            block.type === 'text') {
            const blockText = block.text;
            if (typeof blockText === 'string')
                text += blockText;
        }
    }
    return text;
}
/** Cap captured tool detail (the full I/O lives on the host). */
const DETAIL_CAPTURE_CHARS = 1000;
/** Extract readable text from a tool-result message's content blocks. */
function extractResultText(message) {
    if (message === null || typeof message !== 'object')
        return '';
    const content = message.content;
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const block of content) {
        if (block === null || typeof block !== 'object')
            continue;
        const record = block;
        let picked = false;
        for (const key of ['text', 'output', 'result']) {
            const value = record[key];
            if (typeof value === 'string') {
                parts.push(value);
                picked = true;
                break;
            }
        }
        if (!picked && Array.isArray(record['content'])) {
            for (const inner of record['content']) {
                const text = inner?.text;
                if (typeof text === 'string')
                    parts.push(text);
            }
        }
    }
    return parts.join('\n');
}
/** One-line summary of a tool call for the activity rows. */
export function toolRowSummary(name, argsJson) {
    const sanitizer = resolveToolDescriptor(name)?.sanitizer;
    try {
        const args = JSON.parse(argsJson);
        for (const key of ['command', 'path', 'file_path', 'pattern', 'query', 'url', 'description']) {
            const value = args[key];
            if (typeof value === 'string' && value.trim() !== '') {
                // The summary is the first thing anyone sees: sanitize it like the
                // tool's detail so credentials never make it onto the card.
                return truncateSummary(sanitizeToolDetail(value, sanitizer) ?? redactInlineSecrets(value));
            }
        }
        const first = Object.values(args).find(value => typeof value === 'string');
        if (typeof first === 'string') {
            return truncateSummary(sanitizeToolDetail(first, sanitizer) ?? redactInlineSecrets(first));
        }
    }
    catch {
        // Non-JSON or absent arguments - the bare tool name says enough.
    }
    return '';
}
/** Cap a one-line summary at a readable length. */
function truncateSummary(text) {
    return text.length > 72 ? `${text.slice(0, 72)}…` : text;
}
/**
 * The Feishu↔dsh bridge.
 */
export class Bridge {
    options;
    seen = new Set();
    turns = new Map();
    outboundFileState;
    /** Rolling transcript per chat (Feature F: /history backing store). */
    history = new Map();
    watchdogTimer;
    /** When the transport first entered a sustained-bad state (watchdog, SPEC §8.1). */
    unhealthySince;
    /** Guards against concurrent watchdog restarts (one can take >1 tick on bad networks). */
    restartInFlight = false;
    /** Consecutive watchdog-triggered restarts since the connection was last healthy. */
    restartCount = 0;
    /** Restart backoff ladder (SPEC §8.1: 250ms→1s→3s→5s→10s→30s, then capped). */
    static RESTART_LADDER = [250, 1_000, 3_000, 5_000, 10_000, 30_000];
    /** Titles of messages queued while a chat's turn was still running. */
    queuedTurns = new Map();
    /** Final snapshots per chat, so the detail toggle works on finished cards. */
    lastSnapshots = new Map();
    approvals = new Map();
    turnDisposers = [];
    counters = { received: 0, delivered: 0, dropped: 0 };
    /** Agent ids whose outbound-file tool registration already ran (Feature C). */
    outboundToolsInstalled = new Set();
    /** Per-agent disposers for the outbound-file tool registration, released on dispose. */
    outboundToolDisposers = new Map();
    constructor(options) {
        this.options = options;
    }
    /** Inbound-message counters for the /feishu status surface. */
    stats() {
        return { ...this.counters };
    }
    /** Wire transport handlers; call after `transport.start()`. */
    start() {
        this.options.transport.onMessage(message => {
            void this.handleIncoming(message).catch((error) => {
                this.options.logger.error(`inbound message failed: ${String(error)}`);
            });
        });
        this.options.transport.onCardAction(action => {
            void this.handleCardAction(action).catch((error) => {
                this.options.logger.error(`card action failed: ${String(error)}`);
            });
        });
        // Feature E watchdog (SPEC §8): full-restart a long connection that stays
        // unhealthy (error/reconnecting, or `ready` contradicted by the SDK's raw
        // socket state). Silence is not unhealthiness. Best-effort; never fatal.
        this.watchdogTimer = setInterval(() => {
            void this.watchdogTick().catch((error) => {
                this.options.logger.error(`watchdog tick failed: ${String(error)}`);
            });
        }, 60_000);
        this.watchdogTimer.unref?.();
    }
    /** One watchdog pass: full transport restart on prolonged unhealthy state. */
    async watchdogTick() {
        if (this.restartInFlight)
            return;
        const state = this.options.transport.connectionState();
        // A connection the SDK reports as open is healthy. Inbound silence is
        // not a failure (a personal bot goes quiet for hours), and `lastReadyAt`
        // only refreshes on (re)connect, so it can never justify a restart on
        // its own — a healthy idle connection used to be torn down every 10
        // minutes. Trust the SDK's live socket state instead: restart on a
        // sustained error/reconnecting state (SPEC §8.1), or when the bridge
        // claims `ready` while the raw socket is demonstrably not connected.
        const liveness = this.options.transport.livenessState?.();
        const unhealthy = state === 'error' ||
            state === 'reconnecting' ||
            (state === 'ready' && liveness !== undefined && liveness !== 'connected');
        if (!unhealthy) {
            this.unhealthySince = undefined;
            this.restartCount = 0;
            return;
        }
        // SPEC §8.1: only restart after the bad state has persisted for 5 min —
        // the SDK's own autoReconnect backoff usually recovers sooner, and an
        // early close() invalidates its in-flight reconnect loop.
        this.unhealthySince ??= Date.now();
        if (Date.now() - this.unhealthySince < 5 * 60_000)
            return;
        this.restartInFlight = true;
        try {
            const delay = Bridge.RESTART_LADDER[Math.min(this.restartCount, Bridge.RESTART_LADDER.length - 1)] ??
                30_000;
            this.options.logger.warn(`watchdog: connection ${state} (sdk liveness ${liveness ?? 'unknown'}) for ${Math.round((Date.now() - this.unhealthySince) / 1000)}s; restarting long connection (attempt ${this.restartCount + 1}, settle delay ${delay}ms)`);
            await this.options.transport.restart(delay);
            this.restartCount += 1;
        }
        finally {
            this.restartInFlight = false;
        }
    }
    /** Subscribe to session events (the host owns the actual cordis listener). */
    bindSessionEvents(subscribe) {
        this.turnDisposers.push(subscribe((sessionId, event) => {
            void this.handleSessionEvent(sessionId, event).catch((error) => {
                this.options.logger.error(`session event render failed: ${String(error)}`);
            });
        }));
    }
    /** Tear the bridge down: settle approvals as cancelled, drop listeners. */
    async dispose() {
        if (this.watchdogTimer !== undefined) {
            clearInterval(this.watchdogTimer);
            this.watchdogTimer = undefined;
        }
        for (const dispose of this.turnDisposers.splice(0))
            dispose();
        for (const dispose of this.outboundToolDisposers.values())
            dispose();
        this.outboundToolDisposers.clear();
        this.outboundToolsInstalled.clear();
        for (const pending of this.approvals.values()) {
            if (!pending.settled)
                pending.resolve('cancelled');
        }
        this.approvals.clear();
        this.queuedTurns.clear();
        this.options.cards.dispose();
    }
    /** Whether a sender may drive the bridge. */
    senderAllowed(senderOpenId) {
        const allow = this.options.allowedUsers ?? [];
        return allow.length === 0 || allow.includes(senderOpenId);
    }
    dedupe(messageId) {
        if (this.seen.has(messageId))
            return false;
        this.seen.add(messageId);
        if (this.seen.size > DEDUP_MAX) {
            // Set iteration order is insertion order: drop the oldest half.
            const drop = Math.floor(DEDUP_MAX / 2);
            let i = 0;
            for (const id of this.seen) {
                this.seen.delete(id);
                if (++i >= drop)
                    break;
            }
        }
        return true;
    }
    async handleIncoming(message) {
        this.counters.received += 1;
        if (!this.dedupe(message.messageId)) {
            this.counters.dropped += 1;
            this.options.logger.info(`duplicate message ${message.messageId} dropped`);
            return;
        }
        if (message.chatType === 'group') {
            this.counters.dropped += 1;
            this.options.logger.info(`group message from ${message.senderOpenId} ignored (p2p only)`);
            return;
        }
        if (!this.senderAllowed(message.senderOpenId)) {
            this.counters.dropped += 1;
            this.options.logger.warn(`ignoring message from unauthorized sender ${message.senderOpenId}`);
            return;
        }
        const text = message.text.trim();
        if (message.imageKey !== undefined && message.imageKey !== '') {
            this.counters.delivered += 1;
            await this.deliverImage(message.chatId, message.messageId, message.imageKey);
            return;
        }
        if (message.fileKey !== undefined && message.fileKey !== '') {
            this.counters.delivered += 1;
            await this.deliverFile(message.chatId, message.messageId, message.fileKey);
            return;
        }
        if (text === '') {
            this.counters.dropped += 1;
            return;
        }
        this.counters.delivered += 1;
        if (text.startsWith('/')) {
            await this.handleCommand(message.chatId, text);
            return;
        }
        // Feature F: keep user turns in the rolling transcript too.
        this.appendHistory(message.chatId, 'user', text);
        const replyTag = await this.resolveReplyTag(message);
        await this.deliver(message.chatId, text, replyTag === undefined ? undefined : [replyTag, { type: 'text', text }]);
    }
    /**
     * Feature A (SPEC §4): resolve the quoted-message context for one inbound
     * message into a `<dsh_im_reply_to>` text block. Bounded, single attempt,
     * never throws; quoted content is data and never reaches command dispatch.
     */
    async resolveReplyTag(message) {
        if (this.options.replyReference === false)
            return undefined;
        const target = replyTargetId(message);
        if (target === undefined)
            return undefined;
        let lookup;
        try {
            const fetched = await this.options.transport.getMessage(target);
            lookup = { ok: true, message: fetched };
        }
        catch (error) {
            this.options.logger.warn(`reply reference lookup failed for ${target}: ${String(error)}`);
            lookup = { ok: false, reason: unavailableReasonFromError(error) };
        }
        return { type: 'text', text: `<dsh_im_reply_to>${replyTag(buildReplyReference(lookup))}</dsh_im_reply_to>` };
    }
    /** Materialize and deliver an inbound file message to the chat's agent. */
    async deliverFile(chatId, messageId, fileKey) {
        const resolve = this.options.resolveInboundFile;
        if (this.options.receiveFiles === false || resolve === undefined) {
            this.options.logger.warn(`inbound file ignored (receiveFiles=${this.options.receiveFiles === false ? 'off' : 'unavailable'})`);
            await this.options.transport.sendText(chatId, '📎 当前未开启文件接收（或宿主不支持）。');
            return;
        }
        let result;
        try {
            result = await resolve(messageId, fileKey);
        }
        catch (error) {
            this.options.logger.warn(`inbound file resolution failed: ${String(error)}`);
        }
        if (result === undefined) {
            await this.options.transport.sendText(chatId, '📎 文件接收失败（下载出错）——请重试；若持续失败可在 TUI 里看日志。');
            return;
        }
        await this.deliver(chatId, '📎 文件', [
            { type: 'text', text: `📎 用户发来文件：${result.path}（如需查看/解析可用 read_file 等工具读取）` },
        ]);
    }
    /** Materialize and deliver an inbound image message to the chat's agent. */
    async deliverImage(chatId, messageId, imageKey) {
        const resolve = this.options.resolveInboundImage;
        if (this.options.receiveImages === false || resolve === undefined) {
            this.options.logger.warn(`inbound image ignored (receiveImages=${this.options.receiveImages === false ? 'off' : 'unavailable'})`);
            await this.options.transport.sendText(chatId, '📷 当前未开启图片接收（或宿主不支持）。');
            return;
        }
        // Feature B (SPEC §5): decide the materialization BEFORE resolving — a
        // non-visual model gets the file saved to the workspace so the delivery
        // can carry the real path (SPEC §5.1「已保存到 <path>」), instead of
        // telling the agent to read an attachment that has no path at all.
        const lacksImage = (await this.modelLacksImageInput(chatId)) === true;
        let result;
        try {
            result = await resolve(messageId, imageKey, lacksImage);
        }
        catch (error) {
            this.options.logger.warn(`inbound image resolution failed: ${String(error)}`);
        }
        if (result === undefined) {
            await this.options.transport.sendText(chatId, '📷 图片接收失败（下载出错）——请重试；若持续失败可在 TUI 里看日志。');
            return;
        }
        // Defensive fallback: the host ignored `preferFile` and returned an
        // attachment anyway (older adapter) — degrade to text as before. The
        // prompt intentionally omits a path: the bridge never saw one.
        if (result.kind === 'attachment' && lacksImage) {
            this.options.logger.info(`model for ${chatId} lacks image input; delivering attachment as text`);
            await this.options.transport.sendText(chatId, '📷 当前模型不支持直接看图——图片已作为文件保存到会话工作区，agent 会用工具读取分析；可 /model 切换视觉模型。');
            await this.deliver(chatId, '📷 图片（转文件）', [
                { type: 'text', text: '📷 用户发来一张图片，当前模型不支持直接看图。图片已通过入站文件管线保存到会话工作区。请用 read_image / run_code 等工具读取该文件分析图片内容；不要假设自己能直接看到图片。' },
            ]);
            return;
        }
        const blocks = result.kind === 'attachment'
            ? [
                { type: 'image', attachment: result.ref },
                { type: 'text', text: '📷 用户发来一张图片。' },
            ]
            : [{ type: 'text', text: `📷 用户发来一张图片，已保存到 ${result.path}（如需查看可用 read_image 读取）。` }];
        await this.deliver(chatId, '📷 图片', blocks);
    }
    /**
     * Whether the chat's effective model definitively lacks image input.
     * `false`/`undefined` (visual model, unknown, probe absent, or probe
     * failure) keeps the default image-block behavior — fail open, like
     * dsh-llm's own admission check.
     */
    async modelLacksImageInput(chatId) {
        if (this.options.imageFileFallback === false)
            return false;
        const probe = this.options.resolveModelSupportsImages;
        if (probe === undefined)
            return undefined;
        const route = this.options.modelControl?.get(chatId);
        if (route === undefined)
            return undefined;
        try {
            const supports = await probe(route);
            return supports === undefined ? undefined : !supports;
        }
        catch (error) {
            this.options.logger.warn(`image-input probe failed: ${String(error)}`);
            return undefined;
        }
    }
    async handleCommand(chatId, line) {
        const command = line.slice(1).split(/\s+/)[0];
        const rest = line.slice(1 + (command?.length ?? 0)).trim();
        switch (command) {
            case 'new': {
                await this.abandonActiveTurn(chatId);
                this.options.sessionMap.remint(chatId);
                await this.options.sessionMap.persist();
                await this.options.transport.sendText(chatId, '🆕 已开新会话——旧会话还在列表里，/sessions 查看、/switch <序号> 切回。');
                break;
            }
            case 'status': {
                const binding = this.options.sessionMap.get(chatId);
                const transport = this.options.transport;
                const { lastReadyAt } = transport.healthTimestamps();
                await transport.sendText(chatId, [
                    `🟢 dsh-TUI 飞书桥`,
                    `- 连接状态：${transport.connectionState()}`,
                    `- 最近就绪：${lastReadyAt === undefined ? '从未' : new Date(lastReadyAt).toLocaleString()}`,
                    `- 本次进程内重建次数：${this.restartCount}`,
                    `- 出站文件：${this.outboundFilesStatus}`,
                    `- 当前会话：${binding === undefined ? '还没有（发条消息就开始了）' : binding.sessionId}`,
                    `- 工作目录：${binding?.cwd ?? this.options.defaultCwd}`,
                    `- 已绑定聊天数：${this.options.sessionMap.size}`,
                    '- 命令一览：/help',
                ].join('\n'));
                break;
            }
            case 'sessions': {
                await this.handleSessionsCommand(chatId);
                break;
            }
            case 'switch':
            case 'use': {
                await this.handleSwitchCommand(chatId, rest);
                break;
            }
            case 'rename': {
                await this.handleRenameCommand(chatId, rest);
                break;
            }
            case 'delete':
            case 'drop': {
                await this.handleDeleteCommand(chatId, rest);
                break;
            }
            case 'model': {
                await this.handleModelCommand(chatId, rest);
                break;
            }
            case 'effort': {
                await this.handleEffortCommand(chatId, rest);
                break;
            }
            case 'remind': {
                await this.handleRemindCommand(chatId, rest);
                break;
            }
            case 'reminders': {
                await this.handleRemindersCommand(chatId);
                break;
            }
            case 'unremind':
            case 'delremind': {
                await this.handleUnremindCommand(chatId, rest);
                break;
            }
            case 'help': {
                await this.options.transport.sendText(chatId, [
                    '💬 直接发消息即可与你电脑上的 dsh agent 对话。',
                    '会话：',
                    '- /new - 开新会话（旧会话保留，可切回）',
                    '- /sessions - 列出本聊天的所有会话（当前 ✅）',
                    '- /switch <序号> - 切换到指定会话',
                    '- /rename <新名字> - 给当前会话改名（/rename <序号> <新名字> 改指定会话）',
                    '- /delete <序号> - 忘掉指定会话（磁盘历史保留）',
                    '模型：',
                    '- /model - 查看当前模型和全部可用模型',
                    '- /model <模型> 或 /model <provider>/<模型> - 切换模型',
                    '- /effort [强度 | off] - 查看 / 设置 / 恢复默认思考强度',
                    '提醒：',
                    '- /remind 10m 喝水 - 一次性提醒（支持 s/m/h/d，最长 7 天）',
                    '- /remind 09:00 站会 - 每天定时提醒',
                    '- /reminders - 查看提醒列表，/unremind <序号> 取消',
                    '运行中：',
                    '- 回复卡片上有 ⏹ Stop 按钮可中断，🔍 详情按钮展开工具参数和结果',
                    '- 危险操作会发 🔐 审批卡片，点 Allow/Reject 放行或拒绝',
                    '其他：',
                    '- /status - 桥接状态、当前会话、工作目录',
                    '- /repair - 检查配对应用的权限是否齐全（收不到图片/文件时先跑这个）',
                    '- /history [n] - 查看最近 n 条对话（默认全部，进程内 50 条上限）',
                    '- /compact - 压缩当前会话（宿主持有压缩服务时可用）',
                ].join('\n'));
                break;
            }
            case 'repair': {
                await this.handleRepairCommand(chatId);
                break;
            }
            case 'history': {
                await this.handleHistoryCommand(chatId, rest);
                break;
            }
            case 'compact': {
                await this.handleCompactCommand(chatId);
                break;
            }
            default: {
                // A bare unknown word is probably a typo'd command; anything with
                // arguments reads as a slash line meant for the model.
                if (/^\/\S+$/.test(line)) {
                    await this.options.transport.sendText(chatId, `未知命令 "/${command}"——输入 /help 查看全部命令。`);
                }
                else {
                    await this.deliver(chatId, line);
                }
            }
        }
    }
    /** Best-effort persist of the session map (never breaks a command). */
    async persistMap() {
        await this.options.sessionMap.persist().catch((error) => {
            this.options.logger.warn(`session map persist failed: ${String(error)}`);
        });
    }
    /** `/sessions` — numbered list of this chat's sessions, newest first. */
    async handleSessionsCommand(chatId) {
        const sessions = this.options.sessionMap.list(chatId);
        if (sessions.length === 0) {
            await this.options.transport.sendText(chatId, '还没有会话——随便发条消息就开始了一个。');
            return;
        }
        const lines = sessions.map((entry, index) => `${index + 1}. ${entry.active ? '✅' : '　'} ${entry.title ?? '（未命名）'}  · ${entry.sessionId.slice(0, 8)}`);
        // Interactive card: one switch button per session (cap 8 rows keeps the
        // card within element limits); rename/delete stay text commands.
        const buttons = sessions.slice(0, 8).map((entry, index) => ({
            tag: 'button',
            text: { tag: 'plain_text', content: `切换到 ${index + 1}` },
            type: entry.active ? 'primary' : 'default',
            value: { kind: 'session', action: 'switch', n: String(index + 1) },
        }));
        const elements = [
            { tag: 'markdown', content: [`🗂 会话列表（最新在前）：`, ...lines].join('\n') },
        ];
        if (buttons.length > 0)
            elements.push({ tag: 'action', actions: buttons });
        try {
            await this.options.transport.sendCard(chatId, {
                config: { wide_screen_mode: true },
                header: { title: { tag: 'plain_text', content: '🗂 会话列表' }, template: 'blue' },
                elements,
            });
        }
        catch (error) {
            this.options.logger.warn(`sessions card failed (falling back to text): ${String(error)}`);
            await this.options.transport.sendText(chatId, [...lines, '- /switch <序号> 切换 · /rename <序号> <名字> 改名 · /delete <序号> 删除'].join('\n'));
        }
    }
    /**
     * Abandon the chat's live turn when the binding is switched away (/new,
     * /switch, /delete of the active session): cancel the agent, close the
     * card as stopped, drop queued titles. Without this the orphaned turn
     * state would send every later message into the queue forever.
     */
    async abandonActiveTurn(chatId) {
        const turn = this.turns.get(chatId);
        if (turn === undefined)
            return;
        this.turns.delete(chatId);
        this.queuedTurns.delete(chatId);
        this.lastSnapshots.set(chatId, {
            title: turn.title,
            content: turn.content,
            rows: turn.rows,
            status: 'stopped',
            expanded: turn.expanded,
        });
        this.options.agentStore.get(turn.sessionId)?.cancel({ kind: 'user' });
        await this.options.cards.finalize(chatId, 'stopped').catch(() => { });
    }
    /** `/switch <n>` — make the n-th listed session active. */
    async handleSwitchCommand(chatId, arg) {
        const sessions = this.options.sessionMap.list(chatId);
        const index = Number.parseInt(arg, 10) - 1;
        const target = Number.isInteger(index) ? sessions[index] : undefined;
        if (target === undefined) {
            await this.options.transport.sendText(chatId, '⚠️ 用法：/switch <序号>——序号见 /sessions。');
            return;
        }
        if (!this.options.sessionMap.switchTo(chatId, target.sessionId)) {
            await this.options.transport.sendText(chatId, '⚠️ 这个会话已经不在了——重新 /sessions 看看。');
            return;
        }
        await this.abandonActiveTurn(chatId);
        await this.persistMap();
        await this.options.transport.sendText(chatId, `🔀 已切换到：${target.title ?? target.sessionId.slice(0, 8)}——下一条消息接着它聊。`);
    }
    /** `/rename [n] <name>` — rename the active session, or the n-th one. */
    async handleRenameCommand(chatId, arg) {
        if (arg === '') {
            await this.options.transport.sendText(chatId, '⚠️ 用法：/rename <新名字>（改当前会话），或 /rename <序号> <新名字>。');
            return;
        }
        const numbered = /^(\d+)\s+(.+)$/.exec(arg);
        let sessionId;
        let name;
        if (numbered !== null) {
            const target = this.options.sessionMap.list(chatId)[Number.parseInt(numbered[1] ?? '', 10) - 1];
            if (target === undefined) {
                await this.options.transport.sendText(chatId, '⚠️ 序号超出范围——/sessions 查看列表。');
                return;
            }
            sessionId = target.sessionId;
            name = (numbered[2] ?? '').trim();
        }
        else {
            sessionId = this.options.sessionMap.get(chatId)?.sessionId;
            if (sessionId === undefined) {
                await this.options.transport.sendText(chatId, '⚠️ 还没有会话——先发条消息再改名。');
                return;
            }
            name = arg;
        }
        if (name === '') {
            await this.options.transport.sendText(chatId, '⚠️ 名字不能为空。');
            return;
        }
        const finalName = name.length > 40 ? `${name.slice(0, 40)}…` : name;
        if (!this.options.sessionMap.rename(chatId, sessionId, finalName)) {
            await this.options.transport.sendText(chatId, '⚠️ 改名失败——会话已经不在了。');
            return;
        }
        await this.persistMap();
        await this.options.transport.sendText(chatId, `✏️ 已命名为：${finalName}`);
    }
    /** `/delete <n>` — forget the n-th listed session (disk log is kept). */
    async handleDeleteCommand(chatId, arg) {
        const sessions = this.options.sessionMap.list(chatId);
        const index = Number.parseInt(arg, 10) - 1;
        const target = Number.isInteger(index) ? sessions[index] : undefined;
        if (target === undefined) {
            await this.options.transport.sendText(chatId, '⚠️ 用法：/delete <序号>——序号见 /sessions。');
            return;
        }
        if (target.active)
            await this.abandonActiveTurn(chatId);
        const outcome = this.options.sessionMap.remove(chatId, target.sessionId);
        await this.persistMap();
        const label = target.title ?? target.sessionId.slice(0, 8);
        const note = outcome === 'activated-successor'
            ? '已自动切到最近一个剩下的会话。'
            : outcome === 'unbound'
                ? '列表空了——下一条消息会开新会话。'
                : '';
        await this.options.transport.sendText(chatId, `🗑 已忘掉：${label}。${note}（磁盘上的历史保留）`);
    }
    /** `/remind <time> <text>` — arm a one-shot or daily reminder. */
    async handleRemindCommand(chatId, arg) {
        const store = this.options.reminders;
        if (store === undefined) {
            await this.options.transport.sendText(chatId, '⚠️ 当前宿主不支持定时提醒。');
            return;
        }
        const parts = /^(\S+)\s+(.+)$/s.exec(arg);
        if (parts === null) {
            await this.options.transport.sendText(chatId, '⚠️ 用法：/remind <时间> <内容>——如 /remind 10m 喝水（s/m/h/d），/remind 09:00 站会（每天）。');
            return;
        }
        const time = parseReminderTime(parts[1] ?? '');
        if (time === undefined) {
            await this.options.transport.sendText(chatId, '⚠️ 时间格式不对——支持 10s/5m/2h/1d（最长 7 天）或 HH:MM（每天）。');
            return;
        }
        const text = (parts[2] ?? '').trim();
        if (text === '') {
            await this.options.transport.sendText(chatId, '⚠️ 提醒内容不能为空。');
            return;
        }
        const reminder = store.add(chatId, text.length > 200 ? text.slice(0, 200) : text, time);
        await this.options.transport.sendText(chatId, `⏰ 已设定：${describeReminder(reminder)}——「${reminder.text}」`);
    }
    /** `/reminders` — list this chat's armed reminders. */
    async handleRemindersCommand(chatId) {
        const store = this.options.reminders;
        if (store === undefined) {
            await this.options.transport.sendText(chatId, '⚠️ 当前宿主不支持定时提醒。');
            return;
        }
        const list = store.list(chatId);
        if (list.length === 0) {
            await this.options.transport.sendText(chatId, '没有进行中的提醒——/remind 10m 喝水 试试。');
            return;
        }
        const lines = list.map((reminder, index) => `${index + 1}. ${describeReminder(reminder)} — ${reminder.text}`);
        await this.options.transport.sendText(chatId, ['⏰ 提醒列表：', ...lines, '- /unremind <序号> 取消'].join('\n'));
    }
    /** `/unremind <n>` — cancel the n-th reminder. */
    async handleUnremindCommand(chatId, arg) {
        const store = this.options.reminders;
        if (store === undefined) {
            await this.options.transport.sendText(chatId, '⚠️ 当前宿主不支持定时提醒。');
            return;
        }
        const removed = store.removeAt(chatId, Number.parseInt(arg, 10));
        if (removed === undefined) {
            await this.options.transport.sendText(chatId, '⚠️ 用法：/unremind <序号>——序号见 /reminders。');
            return;
        }
        await this.options.transport.sendText(chatId, `🗑 已取消提醒：「${removed.text}」`);
    }
    /** ReminderStore callback: deliver the reminder as a normal agent turn. */
    fireReminder(reminder) {
        void this.deliver(reminder.chatId, `⏰ 定时提醒：${reminder.text}`).catch((error) => {
            this.options.logger.error(`reminder delivery failed: ${String(error)}`);
        });
    }
    /** `/model` — show the effective route, or pin a new one for this chat. */
    async handleModelCommand(chatId, arg) {
        const control = this.options.modelControl;
        if (control === undefined) {
            await this.options.transport.sendText(chatId, '⚠️ 当前宿主不支持切换模型。');
            return;
        }
        const current = control.get(chatId);
        const describe = (route) => route === undefined
            ? '宿主默认'
            : `${route.provider}/${route.model}${route.reasoningEffort === undefined ? '' : `（强度 ${route.reasoningEffort}）`}`;
        if (arg === '') {
            const lines = [`🧭 当前模型：${describe(current)}`, '- 切换：/model <模型> 或 /model <provider>/<模型>'];
            const all = await control.listAll?.().catch(() => undefined);
            if (all !== undefined && all.length > 0) {
                lines.push('- 可用模型：');
                let shown = 0;
                for (const group of all) {
                    for (const id of group.models) {
                        if (shown >= 40)
                            break;
                        lines.push(`  · ${group.provider}/${id}`);
                        shown += 1;
                    }
                }
            }
            await this.options.transport.sendText(chatId, lines.join('\n'));
            return;
        }
        const slash = arg.indexOf('/');
        const provider = slash >= 0 ? arg.slice(0, slash) : current?.provider;
        const model = slash >= 0 ? arg.slice(slash + 1) : arg;
        if (provider === undefined || provider === '' || model === '') {
            await this.options.transport.sendText(chatId, '⚠️ 还不知道当前 provider——先用 /model <provider>/<模型> 完整指定一次。');
            return;
        }
        await control.setModel(chatId, provider, model);
        await this.options.transport.sendText(chatId, `✅ 模型已切换：${provider}/${model}（下一步生效）`);
    }
    /**
     * `/repair` (Feature D, SPEC §7): probe the paired app's tenant scopes and
     * report which capabilities are missing with fix instructions. Probes are
     * single-shot, 5s-bounded, and never throw.
     */
    async handleRepairCommand(chatId) {
        await this.options.transport.sendText(chatId, '🔧 正在检查权限（im:chat / im:resource）……');
        const rows = [];
        // im:chat — reading the current chat's metadata.
        rows.push((await this.probe('im:chat（会话信息）', () => this.options.transport.getChat(chatId))) === undefined
            ? '❌ im:chat（会话信息）—— 不可用'
            : '✅ im:chat（会话信息）');
        // im:resource — downloading an image resource; the probe is three-state
        // (true / false / undefined): an inconclusive probe (network down) must
        // surface as ⚠️, never as a green check (SPEC §7.1).
        const resourceOk = await this.probe('im:resource（图片/文件下载）', async () => {
            // A bogus image key still exercises the scope: a missing-permission
            // rejection (99991672 family) differs from a not-found.
            return this.options.transport.probeImageResourceAccess();
        });
        rows.push(resourceOk === false
            ? '❌ im:resource（图片/文件下载）—— 缺权限：图片接收/出站图片不可用'
            : resourceOk === true
                ? '✅ im:resource（图片/文件下载）'
                : '⚠️ im:resource（图片/文件下载）—— 无法判定（网络异常或探测超时），请重试');
        rows.push('✅ im:message（收消息）—— 你能收到这条回复即说明正常');
        // SPEC §7.1 lists four checks; send_as_bot is proven implicitly — the
        // probe-results message above went out via the bot — but the report
        // must show it so the user can see it was checked.
        rows.push('✅ im:message:send_as_bot（发消息）—— 本条检查结果发出即说明正常');
        const missing = rows.some(row => row.startsWith('❌'));
        const inconclusive = !missing && rows.some(row => row.startsWith('⚠️'));
        await this.options.transport.sendText(chatId, [
            missing
                ? '🔧 权限检查结果（有缺失）：'
                : inconclusive
                    ? '🔧 权限检查结果（存在无法判定的项，建议稍后重试）：'
                    : '🔧 权限检查结果（全部正常）：',
            ...rows,
            ...(missing
                ? ['补全步骤：飞书开发者后台 → 打开配对的应用 → 权限管理 → 申请缺失权限 → 创建版本并发布；发布后重新扫码配对（/feishu pair）。']
                : []),
        ].join('\n'));
    }
    /** Run one probe, settling to `undefined` on any rejection. */
    async probe(label, run) {
        try {
            return await run();
        }
        catch (error) {
            this.options.logger.warn(`repair probe ${label} failed: ${String(error)}`);
            return undefined;
        }
    }
    /**
     * Append one transcript row (dedup consecutive identical agent text).
     * Redacts inline secrets at the entry: the in-memory store holds clean
     * data, so every present and future consumer (SPEC §9) is safe by
     * construction instead of relying on each reader remembering to redact.
     */
    appendHistory(chatId, role, rawText) {
        if (rawText === '')
            return;
        const text = redactInlineSecrets(rawText);
        const rows = this.history.get(chatId) ?? [];
        const last = rows.at(-1);
        if (role === 'agent' && last?.role === 'agent' && last.text === text)
            return;
        rows.push({ role, text: text.slice(0, HISTORY_ROW_CHARS), at: Date.now() });
        if (rows.length > HISTORY_CAP_PER_CHAT)
            rows.splice(0, rows.length - HISTORY_CAP_PER_CHAT);
        this.history.set(chatId, rows);
    }
    /** `/history [n]` — replay the bounded in-process transcript for this chat. */
    async handleHistoryCommand(chatId, arg) {
        const rows = this.history.get(chatId) ?? [];
        if (rows.length === 0) {
            await this.options.transport.sendText(chatId, '📜 暂无历史（进程内保留最近 50 条；重启后清空）。');
            return;
        }
        const want = Number.parseInt(arg.trim(), 10);
        const count = Number.isInteger(want) && want > 0 ? Math.min(want, rows.length) : rows.length;
        // HistoryEntry.at was written but never read: surface it as HH:MM so the
        // replay carries a usable time alongside role and text.
        const lines = rows.slice(-count).map(row => {
            const at = new Date(row.at);
            const clock = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
            return `${row.role === 'user' ? '🧑' : '🤖'} ${clock} ${row.text}`;
        });
        // SPEC §9: send as several plain texts instead of one hard-truncated
        // message — a head-truncation dropped the NEWEST rows, exactly the ones
        // the user asked for. Pack lines into ≤3500-char chunks, oldest first.
        const chunks = [];
        let current = `📜 最近 ${count} 条：`;
        for (const line of lines) {
            if (current.length > 0 && current.length + 1 + line.length > HISTORY_MESSAGE_CHARS) {
                chunks.push(current);
                current = '';
            }
            current = current === '' ? line : `${current}\n${line}`;
        }
        if (current !== '')
            chunks.push(current);
        for (const chunk of chunks)
            await this.options.transport.sendText(chatId, chunk);
    }
    /** `/compact` — request a compaction of the current session (soft-probed). */
    async handleCompactCommand(chatId) {
        // Pure diagnostics must not create a session (SPEC: keep cancel-signal
        // semantics and avoid side effects): a running turn or a chat with no
        // session yet exits before any agent work.
        if (this.turns.has(chatId)) {
            await this.options.transport.sendText(chatId, '⏳ 当前回合还在跑——结束后再压缩。');
            return;
        }
        if (this.options.sessionMap.get(chatId) === undefined) {
            await this.options.transport.sendText(chatId, '📉 还没有会话——先聊点什么再压缩。');
            return;
        }
        const agent = await this.ensureAgent(chatId);
        if (agent === undefined)
            return;
        let compaction;
        try {
            compaction = agent.ctx.get('compaction');
        }
        catch (error) {
            this.options.logger.warn(`compaction probe failed: ${String(error)}`);
        }
        if (compaction?.compactNow === undefined) {
            await this.options.transport.sendText(chatId, '📉 当前宿主没有压缩服务（宿主不支持 /compact）。');
            return;
        }
        await this.options.transport.sendText(chatId, '📉 正在压缩会话……');
        try {
            // Hard 120s cap (SPEC principle 3: preserve cancellation semantics) —
            // a stalled compaction must end with a clear message, not silence.
            const did = await compaction.compactNow(agent, AbortSignal.timeout(COMPACTION_TIMEOUT_MS));
            await this.options.transport.sendText(chatId, did ? '✅ 会话已压缩。' : 'ℹ️ 没有可压缩的内容。');
        }
        catch (error) {
            if (error instanceof Error && error.name === 'TimeoutError') {
                this.options.logger.warn(`compaction timed out after ${COMPACTION_TIMEOUT_MS}ms`);
                await this.options.transport.sendText(chatId, `⏱ 压缩超时（${COMPACTION_TIMEOUT_MS / 1000} 秒）——会话可能过大，稍后再试。`);
            }
            else {
                this.options.logger.warn(`compaction failed: ${String(error)}`);
                await this.options.transport.sendText(chatId, `❌ 压缩失败：${String(error)}`);
            }
        }
    }
    /** `/effort` — show the pinned reasoning effort, or set/clear it. */
    async handleEffortCommand(chatId, arg) {
        const control = this.options.modelControl;
        if (control === undefined) {
            await this.options.transport.sendText(chatId, '⚠️ 当前宿主不支持切换思考强度。');
            return;
        }
        if (arg === '') {
            const current = control.get(chatId);
            await this.options.transport.sendText(chatId, `🧠 当前思考强度：${current?.reasoningEffort ?? 'provider 默认'}——/effort <强度> 设置（如 high），/effort off 恢复默认`);
            return;
        }
        const effort = arg === 'off' || arg === 'default' ? undefined : arg;
        await control.setEffort(chatId, effort);
        await this.options.transport.sendText(chatId, effort === undefined ? '✅ 已恢复 provider 默认强度' : `✅ 思考强度已设为：${effort}（下一步生效）`);
    }
    /** Resolve (or create) the chat's agent, then deliver one user turn.
     *  `blocks` overrides the default text-only content (e.g. an image block). */
    async deliver(chatId, text, blocks) {
        const agent = await this.ensureAgent(chatId);
        if (agent === undefined) {
            await this.options.transport.sendText(chatId, '⚠️ 宿主上没有 agent 服务——dsh 是否在运行？');
            return;
        }
        const content = blocks ?? [{ type: 'text', text }];
        const title = text.length > TITLE_CHARS ? `${text.slice(0, TITLE_CHARS)}…` : text;
        // A turn is already running: the agent inbox queues the message for the
        // next turn, so queue the title too instead of clobbering the live card.
        if (this.turns.has(chatId)) {
            const queue = this.queuedTurns.get(chatId) ?? [];
            queue.push(title);
            this.queuedTurns.set(chatId, queue);
            try {
                agent.followup(createUserMessage({ content: content, source: { kind: 'user' } }));
            }
            catch (error) {
                queue.pop();
                this.options.logger.error(`queued followup failed: ${String(error)}`);
                await this.options.transport.sendText(chatId, '⚠️ 消息投递失败——请重发一次。');
                return;
            }
            await this.options.transport.sendText(chatId, '⏳ 当前回合还在跑——已排队，结束后自动接着处理。');
            return;
        }
        if (this.options.sessionMap.recordTitle(chatId, String(agent.id), title)) {
            await this.persistMap();
        }
        this.turns.set(chatId, {
            title,
            content: '',
            rows: [],
            openThink: false,
            expanded: false,
            sessionId: String(agent.id),
            startedAt: Date.now(),
            toolStarts: new Map(),
        });
        try {
            await this.options.cards.open(chatId, title);
        }
        catch (error) {
            this.options.logger.warn(`streaming card open failed: ${String(error)}`);
        }
        try {
            agent.followup(createUserMessage({
                content: content,
                source: { kind: 'user' },
            }));
        }
        catch (error) {
            this.options.logger.error(`followup failed: ${String(error)}`);
            this.turns.delete(chatId);
            await this.options.cards.finalize(chatId, 'error').catch(() => { });
            await this.options.transport.sendText(chatId, '⚠️ 消息投递失败——请重发一次。');
        }
    }
    /** Live agent for the chat's bound session, resuming or creating as needed. */
    async ensureAgent(chatId) {
        const store = this.options.agentStore;
        const map = this.options.sessionMap;
        const binding = map.get(chatId);
        if (binding !== undefined) {
            const live = store.get(binding.sessionId);
            if (live !== undefined) {
                this.registerOutboundTool(live);
                return live;
            }
            try {
                const resumed = await store.resume(binding.sessionId, {
                    ...(binding.route === undefined ? {} : { route: binding.route }),
                    ...(binding.effort === undefined ? {} : { effort: binding.effort }),
                });
                this.registerOutboundTool(resumed);
                return resumed;
            }
            catch (error) {
                this.options.logger.warn(`resume of session ${binding.sessionId} failed (${String(error)}); rebinding fresh`);
                map.delete(chatId);
            }
        }
        // remint keeps a previous cwd and pinned route/effort; the map persists
        // after the create resolves.
        const sessionId = map.remint(chatId);
        const fresh = map.get(chatId);
        const cwd = fresh?.cwd ?? this.options.defaultCwd;
        this.options.logger.info(`creating session ${sessionId} for chat ${chatId} (cwd ${cwd})`);
        const agent = await store.create(sessionId, cwd, {
            ...(fresh?.route === undefined ? {} : { route: fresh.route }),
            ...(fresh?.effort === undefined ? {} : { effort: fresh.effort }),
        });
        map.set(chatId, String(agent.id), cwd);
        await map.persist().catch((error) => {
            this.options.logger.warn(`session map persist failed: ${String(error)}`);
        });
        this.registerOutboundTool(agent);
        return agent;
    }
    /**
     * Feature C (SPEC §6): soft-probe the tools registry once per agent so the
     * session can send files back to the chat. Runs on EVERY ensureAgent path
     * (live reuse, resume, create) — a resumed session after a TUI restart
     * must regain the tool, not silently lose it. Idempotent per agent id;
     * never fatal.
     */
    registerOutboundTool(agent) {
        const id = String(agent.id);
        if (this.outboundToolsInstalled.has(id))
            return;
        this.outboundToolsInstalled.add(id);
        if (this.options.outboundFiles !== false && this.options.sendFileToChat !== undefined) {
            const registration = installOutboundFileTool({
                agentCtx: agent.ctx,
                chatForCurrentSession: () => this.options.sessionMap.chatFor(id),
                sendFile: async (boundChatId, data, fileName) => this.options.sendFileToChat(boundChatId, data, fileName),
            });
            if (registration.status === 'registered') {
                this.outboundFileState = 'registered';
                if (registration.dispose !== undefined)
                    this.outboundToolDisposers.set(id, registration.dispose);
                this.options.logger.info(`outbound file tool registered for session ${id}`);
            }
            else if (registration.status === 'unavailable') {
                if (this.outboundFileState === undefined) {
                    this.outboundFileState = `unavailable: ${registration.reason}`;
                    this.options.logger.warn(`outbound files unavailable: ${registration.reason}`);
                }
            }
        }
        else if (this.outboundFileState === undefined) {
            this.outboundFileState = 'disabled';
        }
    }
    /** /status hook: Feature C availability. */
    get outboundFilesStatus() {
        return this.outboundFileState ?? 'not-probed';
    }
    /** Fold one session event into the owning chat's streaming card. */
    async handleSessionEvent(sessionId, event) {
        const chatId = this.options.sessionMap.chatFor(sessionId);
        if (chatId === undefined) {
            this.options.logger.warn(`session event for unknown session ${sessionId} ignored (chatFor miss)`);
            return;
        }
        let state = this.turns.get(chatId);
        // Session events carry their payload directly on the event object in
        // dsh-session 0.1.1 (turn/reason at the top level); older builds wrapped
        // it in `data`. Read both shapes.
        const eventRecord = event;
        const data = eventRecord.data ?? {};
        const topLevel = (key) => eventRecord[key];
        switch (event.type) {
            case 'user/message':
            case 'turn/start': {
                if (state === undefined) {
                    // A turn we did not open a card for: either an agent-initiated turn
                    // (e.g. a schedule reminder) or a message queued while the previous
                    // turn was running - the queued title wins when present.
                    const queue = this.queuedTurns.get(chatId);
                    const queuedTitle = queue !== undefined && queue.length > 0 ? queue.shift() : undefined;
                    if (queue !== undefined && queue.length === 0)
                        this.queuedTurns.delete(chatId);
                    state = { title: queuedTitle ?? '⏰ Agent', content: '', rows: [], openThink: false, expanded: false, sessionId, startedAt: Date.now(), toolStarts: new Map() };
                    this.turns.set(chatId, state);
                    try {
                        await this.options.cards.open(chatId, state.title);
                    }
                    catch (error) {
                        this.options.logger.warn(`agent-initiated card open failed: ${String(error)}`);
                    }
                }
                return;
            }
            case 'assistant/chunk': {
                if (state === undefined)
                    return;
                const chunk = data.chunk;
                if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
                    // Deltas may carry reasoning tags; strip them so internal thinking
                    // never renders (a delta fully inside a tag contributes nothing).
                    const text = stripReasoningTags(chunk.text);
                    if (text !== '') {
                        state.content += text;
                        this.syncCard(chatId, state, 'working');
                    }
                }
                else if (chunk?.type === 'reasoning-delta' &&
                    typeof chunk.text === 'string' &&
                    this.options.showReasoning !== false) {
                    if (!state.openThink) {
                        state.rows = [...state.rows, { kind: 'think', text: chunk.text }];
                        state.openThink = true;
                    }
                    else {
                        const rows = [...state.rows];
                        const index = rows.length - 1;
                        const last = rows[index];
                        if (last !== undefined && last.kind === 'think') {
                            rows[index] = { kind: 'think', text: last.text + chunk.text };
                            state.rows = rows;
                        }
                    }
                    this.syncCard(chatId, state, 'working');
                }
                return;
            }
            case 'tool/call': {
                if (state === undefined)
                    return;
                state.openThink = false;
                const args = String(data.arguments ?? '');
                const callId = data.callId === undefined ? undefined : String(data.callId);
                if (callId !== undefined)
                    state.toolStarts.set(callId, Date.now());
                state.rows = [
                    ...state.rows,
                    {
                        kind: 'tool',
                        ...(callId === undefined ? {} : { callId }),
                        name: String(data.name ?? 'tool'),
                        summary: toolRowSummary(String(data.name ?? ''), args),
                        status: 'running',
                        // Raw arguments may embed credentials; redact before capture.
                        ...(args === ''
                            ? {}
                            : { detailIn: redactInlineSecrets(args).slice(0, DETAIL_CAPTURE_CHARS) }),
                    },
                ];
                this.syncCard(chatId, state, 'working');
                return;
            }
            case 'tool/result': {
                if (state === undefined)
                    return;
                const message = data.message;
                const toolCallId = message?.content?.[0]?.toolCallId;
                const error = data.error !== undefined;
                const rows = [...state.rows];
                // Match the running tool row by call id; fall back to the latest
                // running row when the result carries no correlating id.
                let matched = -1;
                let lastRunning = -1;
                for (let i = 0; i < rows.length; i += 1) {
                    const row = rows[i];
                    if (row === undefined || row.kind !== 'tool' || row.status !== 'running')
                        continue;
                    lastRunning = i;
                    if (toolCallId !== undefined && row.callId === toolCallId)
                        matched = i;
                }
                if (matched === -1)
                    matched = lastRunning;
                if (matched >= 0) {
                    const row = rows[matched];
                    if (row !== undefined && row.kind === 'tool') {
                        // Sanitize by the tool's kind when known; always redact
                        // credential-shaped text as a base layer.
                        const sanitizer = resolveToolDescriptor(row.name)?.sanitizer;
                        const rawResult = extractResultText(data.message);
                        const resultText = sanitizer === undefined
                            ? redactInlineSecrets(rawResult)
                            : sanitizeToolDetail(rawResult, sanitizer);
                        const rawError = typeof data.error === 'string'
                            ? data.error
                            : (data.error?.message ?? '');
                        const errorText = redactInlineSecrets(rawError);
                        const detail = [resultText, errorText].filter(part => part !== '').join('\n');
                        let durationMs;
                        if (row.callId !== undefined) {
                            const started = state.toolStarts.get(row.callId);
                            if (started !== undefined) {
                                durationMs = Date.now() - started;
                                state.toolStarts.delete(row.callId);
                            }
                        }
                        rows[matched] = {
                            ...row,
                            status: error ? 'error' : 'done',
                            ...(durationMs === undefined ? {} : { durationMs }),
                            ...(detail === '' ? {} : { detailOut: detail.slice(0, DETAIL_CAPTURE_CHARS) }),
                        };
                        state.rows = rows;
                    }
                }
                this.syncCard(chatId, state, 'working');
                return;
            }
            case 'assistant/message': {
                if (state === undefined)
                    return;
                state.openThink = false;
                const text = stripReasoningTags(assistantText(data.message?.content));
                if (text !== '')
                    state.content = text;
                // Feature F: keep a bounded rolling transcript per chat for /history.
                this.appendHistory(chatId, 'agent', text);
                this.syncCard(chatId, state, 'working');
                return;
            }
            case 'turn/end': {
                if (state === undefined)
                    return;
                const reason = (topLevel('reason') ?? data.reason);
                const status = reason?.kind === 'error' ? 'error' : reason?.kind === 'aborted' ? 'stopped' : 'done';
                if (reason?.kind === 'error') {
                    this.options.logger.error(`turn failed: ${reason.error?.code ?? 'UNKNOWN'}: ${reason.error?.message ?? ''}`);
                }
                state.openThink = false;
                const footer = state.startedAt === 0
                    ? undefined
                    : {
                        elapsedMs: Date.now() - state.startedAt,
                        ...(() => {
                            const model = this.options.modelControl?.get(chatId)?.model;
                            return model === undefined || model === '' ? {} : { model };
                        })(),
                    };
                // Resolve remote images in the final answer before the card closes.
                const content = this.options.resolveImages === false
                    ? state.content
                    : await resolveContentImages(state.content, this.options.transport, this.options.logger);
                state.content = content;
                this.turns.delete(chatId);
                const finalSnapshot = {
                    title: state.title,
                    content,
                    rows: state.rows,
                    status,
                    expanded: state.expanded,
                    ...(footer === undefined ? {} : { footer }),
                };
                this.lastSnapshots.set(chatId, finalSnapshot);
                if (this.options.cards.isActive(chatId)) {
                    let finalized = false;
                    try {
                        finalized = await this.options.cards.finalize(chatId, status, footer, finalSnapshot);
                    }
                    catch (error) {
                        this.options.logger.warn(`card finalize threw; falling back to plain text: ${String(error)}`);
                    }
                    if (!finalized) {
                        // The streaming card could not be finished (dead card / retired):
                        // don't lose the reply - fall back to plain text.
                        this.options.logger.warn(`card finalize failed; falling back to plain text`);
                        const fallback = status === 'error'
                            ? `⚠️ ${reason?.error?.message ?? 'turn ended with an error'}`
                            : state.content;
                        if (fallback !== '') {
                            await this.options.transport
                                .sendText(chatId, fallback.length > 3000 ? `…${fallback.slice(-3000)}` : fallback)
                                .catch((error) => {
                                this.options.logger.warn(`plain-text fallback failed: ${String(error)}`);
                            });
                        }
                    }
                }
                else {
                    // The streaming card never opened (e.g. a rejected card payload):
                    // don't lose the reply - fall back to plain text.
                    const fallback = status === 'error'
                        ? `⚠️ ${reason?.error?.message ?? 'turn ended with an error'}`
                        : state.content;
                    if (fallback !== '') {
                        await this.options.transport
                            .sendText(chatId, fallback.length > 3000 ? `…${fallback.slice(-3000)}` : fallback)
                            .catch((error) => {
                            this.options.logger.warn(`plain-text fallback failed: ${String(error)}`);
                        });
                    }
                }
                return;
            }
            default:
                return;
        }
    }
    syncCard(chatId, state, status) {
        this.options.cards.patch(chatId, {
            title: state.title,
            content: state.content,
            rows: state.rows,
            status,
            expanded: state.expanded,
        });
    }
    /**
     * Answerer for the `approval/request` waterfall: requests for the
     * bridge's own agents become Feishu approval cards; everything else
     * delegates down the chain (`next()`).
     */
    handleApprovalRequest(request, next) {
        const chatId = this.options.sessionMap.chatFor(String(request.agent.id));
        if (chatId === undefined)
            return next();
        return new Promise(resolve => {
            void (async () => {
                let messageId;
                try {
                    messageId = await this.options.transport.sendCard(chatId, buildApprovalCardBody(request));
                }
                catch (error) {
                    this.options.logger.error(`approval card send failed: ${String(error)}`);
                    resolve('unavailable');
                    return;
                }
                const pending = {
                    chatId,
                    messageId,
                    request,
                    resolve,
                    settled: false,
                };
                this.approvals.set(messageId, pending);
                const onAbort = () => {
                    if (pending.settled)
                        return;
                    pending.settled = true;
                    this.approvals.delete(messageId);
                    resolve('cancelled');
                };
                request.signal?.addEventListener('abort', onAbort, { once: true });
            })();
        });
    }
    /** Route a card-button callback (approval decision, stop, detail toggle, session switch). */
    async handleCardAction(action) {
        const kind = action.value['kind'];
        if (kind === 'session') {
            // The /sessions card's switch buttons act like /switch <n>.
            if (!this.senderAllowed(action.operatorOpenId)) {
                this.options.logger.warn(`session switch from unauthorized operator ${action.operatorOpenId} ignored`);
                return;
            }
            const n = action.value['n'];
            if (action.value['action'] === 'switch' && n !== undefined && n !== '') {
                await this.handleSwitchCommand(action.chatId, n);
            }
            return;
        }
        if (kind === 'detail') {
            // The 🔍 详情/收起 toggle re-renders the card with tool arguments and
            // results inline; works on the live card and on the finished one.
            if (!this.senderAllowed(action.operatorOpenId)) {
                this.options.logger.warn(`detail toggle from unauthorized operator ${action.operatorOpenId} ignored`);
                return;
            }
            for (const [chatId, turn] of this.turns) {
                if (this.options.cards.activeMessageId(chatId) !== action.messageId)
                    continue;
                turn.expanded = !turn.expanded;
                this.syncCard(chatId, turn, 'working');
                return;
            }
            for (const [chatId, snapshot] of this.lastSnapshots) {
                if (this.options.cards.lastMessageId(chatId) !== action.messageId)
                    continue;
                const toggled = { ...snapshot, expanded: snapshot.expanded !== true };
                this.lastSnapshots.set(chatId, toggled);
                await this.options.cards.refresh(chatId, toggled);
                return;
            }
            return;
        }
        if (kind === 'approval') {
            const pending = this.approvals.get(action.messageId);
            if (pending === undefined)
                return;
            if (!this.senderAllowed(action.operatorOpenId)) {
                this.options.logger.warn(`approval button from unauthorized operator ${action.operatorOpenId} ignored`);
                return;
            }
            const decision = action.value['decision'] === 'allowed-once' ? 'allowed-once' : 'rejected';
            if (pending.settled)
                return;
            pending.settled = true;
            this.approvals.delete(action.messageId);
            pending.resolve(decision);
            try {
                await this.options.transport.updateCard(action.messageId, buildApprovalSettledBody(pending.request, decision === 'allowed-once' ? '✅ allowed' : '❌ rejected'));
            }
            catch (error) {
                this.options.logger.warn(`approval card settle failed: ${String(error)}`);
            }
            return;
        }
        if (kind === 'stop') {
            // The ⏹ Stop button on a chat's active streaming card cancels that chat's agent.
            for (const [chatId, turn] of this.turns) {
                if (this.options.cards.activeMessageId(chatId) !== action.messageId)
                    continue;
                const agent = this.options.agentStore.get(turn.sessionId);
                agent?.cancel({ kind: 'user' });
                return;
            }
        }
    }
}
/** Approval card JSON (kept here to avoid a circular import with cards.ts). */
function buildApprovalCardBody(request) {
    const lines = [`**${request.toolName}** wants to run`];
    if (request.reason !== undefined && request.reason !== '') {
        lines.push(`> ${request.reason}`);
    }
    return {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: '🔐 Approval needed' }, template: 'orange' },
        elements: [
            { tag: 'markdown', content: lines.join('\n') },
            {
                tag: 'action',
                actions: [
                    {
                        tag: 'button',
                        text: { tag: 'plain_text', content: '✅ Allow once' },
                        type: 'primary',
                        // No action_type: value buttons default to card.action.trigger.
                        value: { kind: 'approval', decision: 'allowed-once' },
                    },
                    {
                        tag: 'button',
                        text: { tag: 'plain_text', content: '❌ Reject' },
                        type: 'danger',
                        value: { kind: 'approval', decision: 'rejected' },
                    },
                ],
            },
        ],
    };
}
/** Settled approval card JSON. */
function buildApprovalSettledBody(request, outcome) {
    const lines = [`**${request.toolName}** - ${outcome}`];
    if (request.reason !== undefined && request.reason !== '') {
        lines.push(`> ${request.reason}`);
    }
    return {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: '🔐 Approval' }, template: 'grey' },
        elements: [{ tag: 'markdown', content: lines.join('\n') }],
    };
}
