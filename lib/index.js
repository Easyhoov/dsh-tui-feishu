/**
 * @module dsh-tui-feishu
 *
 * Feishu (Lark) as a remote-control surface for a dsh-TUI host: a Feishu
 * private chat maps to a persistent dsh session, replies stream back as one
 * live card per turn, approval requests become Allow/Reject cards, and the
 * ⏹ Stop button cancels the running turn.
 *
 * Setup is scan-to-pair: `/feishu pair` in the TUI shows a QR (official
 * Device-Authorization-Grant bootstrap); the scanning user becomes the
 * bridge's first owner. Credentials can also be supplied via config keys or
 * the `FEISHU_APP_ID` / `FEISHU_APP_SECRET` environment variables.
 *
 * The plugin is a dsh-native cordis plugin admitted to the dsh-TUI ecosystem
 * (dsh-plugin.json, Community v0.15): it drives only public host surfaces
 * (`agents`, `session/event`, `approval/request`, `commands`) and needs no
 * public IP - one outbound WebSocket long connection carries both directions.
 *
 * Refactored from PGZXB/dsh-feishu (MIT).
 */
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';
import { Bridge } from './bridge.js';
import { StreamingCardManager } from './cards.js';
import { CardKitStreamingManager } from './streaming/cardkit-manager.js';
import { ReminderStore } from './reminders.js';
import { dataFiles, readCredentials, SessionMap, writeCredentials, } from './session-map.js';
import { LarkTransport, pairByQrCode } from './transport.js';
/** Stable cordis plugin name (also the bundle row id in cordis.patch.yml). */
export const name = 'dsh-tui-feishu';
export const Config = z.object({
    appId: z.string().required(false),
    appSecret: z.string().required(false),
    defaultCwd: z.string().required(false),
    dataDir: z.string().required(false),
    provider: z.string().required(false),
    model: z.string().required(false),
    cardThrottleMs: z.natural().min(1).required(false),
    cardTtlMs: z.natural().min(1000).required(false),
    locale: z.union([z.const('zh'), z.const('en')]).required(false),
    resolveImages: z.boolean().required(false),
    receiveImages: z.boolean().required(false),
    receiveFiles: z.boolean().required(false),
    replyReference: z.boolean().required(false),
    imageFileFallback: z.boolean().required(false),
    cardEngine: z.union([z.const('v1'), z.const('cardkit')]).required(false),
    showReasoning: z.boolean().required(false),
    allowedUsers: z.array(z.string()).required(false),
});
/** The dsh home directory (`$DSH_HOME` or `~/.dsh`). */
function dshHome() {
    return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}
/** Open a URL in the system browser (best effort; the launcher page shows its own QR). */
function openInBrowser(url) {
    try {
        const command = process.platform === 'win32'
            ? { cmd: 'cmd', args: ['/c', 'start', '', url] }
            : process.platform === 'darwin'
                ? { cmd: 'open', args: [url] }
                : { cmd: 'xdg-open', args: [url] };
        const child = spawn(command.cmd, command.args, { detached: true, stdio: 'ignore' });
        child.on('error', () => { });
        child.unref();
        return true;
    }
    catch {
        return false;
    }
}
/** How long `/feishu pair` waits for the pairing URL before giving up. */
const QR_READY_TIMEOUT_MS = 10_000;
/** Rotate bridge.log past this size (kept as bridge.log.old). */
const LOG_MAX_BYTES = 256 * 1024;
/**
 * Tee logger: forwards to the host logger AND appends one line per entry to
 * a file. The dsh host logger keeps messages in an in-memory buffer only, so
 * without this sink bridge diagnostics are invisible to users.
 */
function createFileLogger(file, base) {
    const write = (level, message) => {
        try {
            mkdirSync(dirname(file), { recursive: true });
            if (existsSync(file) && statSync(file).size > LOG_MAX_BYTES) {
                renameSync(file, `${file}.old`);
            }
            appendFileSync(file, `${new Date().toISOString()} ${level} ${message}\n`);
        }
        catch {
            // Logging must never break the bridge.
        }
    };
    return {
        info: message => {
            base.info(message);
            write('INFO', message);
        },
        warn: message => {
            base.warn(message);
            write('WARN', message);
        },
        error: message => {
            base.error(message);
            write('ERROR', message);
        },
    };
}
export function apply(ctx, config = {}) {
    const dataDir = config.dataDir ?? join(dshHome(), 'dsh-tui-feishu');
    const files = dataFiles(dataDir);
    const logger = createFileLogger(join(dataDir, 'bridge.log'), ctx.logger);
    let active;
    let pairing;
    /** Resolve credentials: config > env > stored pairing result. */
    const resolveCredentials = async () => {
        const appId = config.appId ?? process.env.FEISHU_APP_ID;
        const appSecret = config.appSecret ?? process.env.FEISHU_APP_SECRET;
        if (appId !== undefined && appSecret !== undefined) {
            return { appId, appSecret };
        }
        return readCredentials(files.credentials);
    };
    const agentOptions = config.provider === undefined && config.model === undefined
        ? {}
        : {
            ...(config.provider === undefined ? {} : { provider: config.provider }),
            ...(config.model === undefined ? {} : { model: config.model }),
        };
    /** Compose the roster default preset for one create/resume (mirrors the TUI's composePreset). */
    const composePreset = async () => {
        const roster = ctx.get('agentPresets');
        if (roster === undefined)
            return {};
        try {
            const { id } = await roster.resolve();
            return {
                agentPreset: id,
                setup: async (agentCtx) => {
                    await roster.mount(agentCtx, id);
                },
            };
        }
        catch (error) {
            logger.warn(`[dsh-tui-feishu] default agent preset unavailable (${String(error)}); composing without a preset`);
            return {};
        }
    };
    /**
     * The host-advertised default route (the dsh-TUI profile mounts this
     * service); undefined on bare compositions.
     */
    const defaultRoute = () => {
        const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
        return typeof selection?.provider === 'string' &&
            selection.provider !== '' &&
            typeof selection?.model === 'string' &&
            selection.model !== ''
            ? { provider: selection.provider, model: selection.model }
            : undefined;
    };
    /**
     * Couple a model selection to the agent's assembly/request waterfalls
     * (mirrors the TUI's installModelSelection seeding, issue #155): without
     * it the persona prompt's `{{model}}` variable has no value and prompt
     * assembly throws before any model call. Route precedence: chat pin
     * (/model) > plugin config > the agent's own create options > host default.
     * The ref is kept per session so /model and /effort can retarget it live.
     */
    const selections = new Map();
    const installSelection = (agent, prefs) => {
        const ref = { current: undefined, assembled: undefined };
        const pinned = prefs?.route ??
            (config.provider !== undefined && config.model !== undefined
                ? { provider: config.provider, model: config.model }
                : undefined);
        const own = agent.options?.provider !== undefined &&
            agent.options.provider !== '' &&
            agent.options.model !== undefined &&
            agent.options.model !== ''
            ? { provider: agent.options.provider, model: agent.options.model }
            : undefined;
        const route = pinned ?? own ?? defaultRoute();
        if (route !== undefined) {
            ref.current = {
                provider: route.provider,
                model: route.model,
                // An absent effort clears any inherited one, restoring default behavior.
                ...(prefs?.effort === undefined
                    ? {}
                    : { reasoningEffort: ReasoningEffortId(prefs.effort) }),
            };
        }
        installModelSelection(agent.ctx, ref);
        selections.set(String(agent.id), ref);
    };
    const agentStore = {
        get: sessionId => ctx.get('agents')?.get(sessionId),
        resume: async (sessionId, prefs) => {
            const agents = ctx.get('agents');
            if (agents === undefined)
                throw new Error('agents service unavailable; cannot resume a session');
            const composed = await composePreset();
            const { agent } = await agents.resume({
                resumeSessionId: sessionId,
                ...(Object.keys(agentOptions).length === 0 ? {} : { agentOptions }),
                ...(composed.setup === undefined ? {} : { setup: composed.setup }),
            });
            installSelection(agent, prefs);
            return agent;
        },
        create: async (sessionId, cwd, prefs) => {
            const agents = ctx.get('agents');
            if (agents === undefined)
                throw new Error('agents service unavailable; cannot create a session');
            const composed = await composePreset();
            const { agent } = await agents.create({
                sessionId: sessionId,
                meta: {
                    cwd,
                    // Durable header value: a later resume re-mounts the same preset.
                    ...(composed.agentPreset === undefined ? {} : { agentPreset: composed.agentPreset }),
                },
                ...(Object.keys(agentOptions).length === 0 ? {} : { agentOptions }),
                ...(composed.setup === undefined ? {} : { setup: composed.setup }),
            });
            installSelection(agent, prefs);
            return agent;
        },
    };
    /**
     * Single-bridge lock: only one process may run the bridge per data dir.
     * Multiple TUI instances on the same profile would each open a Feishu
     * long connection, all receive every message and all reply with cards.
     * A lock file holding a live pid blocks the second instance; a stale
     * lock (crashed process) is taken over.
     */
    const acquireBridgeLock = () => {
        const lockPath = join(dataDir, 'bridge.lock');
        let stale = false;
        try {
            const pid = Number(readFileSync(lockPath, 'utf8').trim());
            if (Number.isInteger(pid) && pid > 0) {
                try {
                    process.kill(pid, 0); // signal 0 only probes existence
                    logger.warn(`[dsh-tui-feishu] bridge lock held by pid ${pid}; skipping bridge start in this instance`);
                    return false;
                }
                catch {
                    // Stale lock: the holder is gone, take it over.
                    stale = true;
                }
            }
        }
        catch {
            // No lock file yet.
        }
        try {
            mkdirSync(dataDir, { recursive: true });
            // A stale lock must be overwritten; 'wx' would fail on the leftover file.
            writeFileSync(lockPath, String(process.pid), { flag: stale ? 'w' : 'wx' });
            // Clean up on a normal exit; a crash leaves the file for the stale path.
            process.once('exit', () => {
                try {
                    if (readFileSync(lockPath, 'utf8').trim() === String(process.pid))
                        unlinkSync(lockPath);
                }
                catch {
                    // Already gone or unreadable - nothing to clean.
                }
            });
            return true;
        }
        catch {
            logger.warn('[dsh-tui-feishu] could not acquire bridge lock; skipping bridge start');
            return false;
        }
    };
    /** Mount the bridge for one credential set (replacing any active one). */
    const startBridge = (credentials) => {
        if (!acquireBridgeLock())
            return;
        if (active !== undefined) {
            void active.bridge.dispose();
            active.reminders.dispose();
            active.transport.stop();
            active = undefined;
        }
        const allowed = config.allowedUsers !== undefined && config.allowedUsers.length > 0
            ? config.allowedUsers
            : credentials.ownerOpenId !== undefined
                ? [credentials.ownerOpenId]
                : [];
        const transport = new LarkTransport(credentials, logger);
        const baseCardOptions = {
            ...(config.cardThrottleMs === undefined ? {} : { throttleMs: config.cardThrottleMs }),
            ...(config.cardTtlMs === undefined ? {} : { cardTtlMs: config.cardTtlMs }),
            ...(config.locale === undefined ? {} : { locale: config.locale }),
            logger,
        };
        const cards = (config.cardEngine ?? 'v1') === 'cardkit'
            ? new CardKitStreamingManager(transport, {
                ...baseCardOptions,
                ...(config.showReasoning === undefined ? {} : { showReasoning: config.showReasoning }),
            })
            : new StreamingCardManager(transport, baseCardOptions);
        const sessionMap = new SessionMap(files.sessionMap);
        // The store fires into the bridge, which is constructed right after.
        let bridgeRef;
        const reminders = new ReminderStore(files.reminders, reminder => bridgeRef?.fireReminder(reminder), logger);
        /** /model and /effort control: live selection ref + persisted pin. */
        const persistMap = () => {
            void sessionMap
                .persist()
                .catch((error) => logger.warn(`[dsh-tui-feishu] session map persist failed: ${String(error)}`));
        };
        const modelControl = {
            get: chatId => {
                const binding = sessionMap.get(chatId);
                const live = binding === undefined ? undefined : selections.get(binding.sessionId)?.current;
                if (live !== undefined) {
                    return {
                        provider: live.provider,
                        model: live.model,
                        ...(live.reasoningEffort === undefined
                            ? {}
                            : { reasoningEffort: String(live.reasoningEffort) }),
                    };
                }
                if (binding?.route !== undefined) {
                    return {
                        ...binding.route,
                        ...(binding.effort === undefined ? {} : { reasoningEffort: binding.effort }),
                    };
                }
                return defaultRoute();
            },
            setModel: async (chatId, provider, model) => {
                if (sessionMap.get(chatId) === undefined)
                    sessionMap.remint(chatId);
                sessionMap.setRoute(chatId, { provider, model });
                const binding = sessionMap.get(chatId);
                const ref = binding === undefined ? undefined : selections.get(binding.sessionId);
                if (ref !== undefined) {
                    ref.current = {
                        provider,
                        model,
                        ...(binding?.effort === undefined
                            ? {}
                            : { reasoningEffort: ReasoningEffortId(binding.effort) }),
                    };
                }
                persistMap();
            },
            setEffort: async (chatId, effort) => {
                if (sessionMap.get(chatId) === undefined)
                    sessionMap.remint(chatId);
                sessionMap.setEffort(chatId, effort);
                const binding = sessionMap.get(chatId);
                const ref = binding === undefined ? undefined : selections.get(binding.sessionId);
                if (ref?.current !== undefined) {
                    const { provider, model } = ref.current;
                    ref.current =
                        effort === undefined
                            ? { provider, model }
                            : { provider, model, reasoningEffort: ReasoningEffortId(effort) };
                }
                persistMap();
            },
            listAll: async () => {
                const llm = ctx.get('llm');
                if (llm?.listProviders === undefined || llm.listModels === undefined)
                    return undefined;
                const groups = [];
                for (const provider of llm.listProviders()) {
                    const id = provider.id ?? provider.name;
                    if (id === undefined || id === '')
                        continue;
                    try {
                        const models = (await llm.listModels(id)).map(entry => entry.id);
                        if (models.length > 0)
                            groups.push({ provider: id, models });
                    }
                    catch {
                        // A provider that cannot list skips itself rather than the roster.
                    }
                }
                return groups;
            },
        };
        // Inbound image delivery: prefer the host attachment service (durable
        // ImageAttachmentRef usable in user-message image blocks), fall back to
        // saving the raw bytes under the plugin data dir and handing the agent a
        // file path.
        const attachments = ctx.get('attachments');
        const resolveInboundImage = async (messageId, imageKey) => {
            const downloaded = await transport.downloadImage(messageId, imageKey);
            if (downloaded === undefined)
                return undefined;
            const name = `feishu-${imageKey.slice(0, 8)}`;
            if (attachments !== undefined) {
                try {
                    const [ref] = await attachments.saveImages([
                        { data: downloaded.data, mediaType: downloaded.mediaType, name },
                    ]);
                    return { kind: 'attachment', ref: ref };
                }
                catch (error) {
                    // Attachment service refused (limits/type policy): degrade to the
                    // file fallback instead of losing the image.
                    logger.warn(`attachment save failed (falling back to file): ${String(error)}`);
                }
            }
            const dir = join(dataDir, 'images');
            mkdirSync(dir, { recursive: true });
            const ext = downloaded.mediaType.split('/')[1] ?? 'img';
            const file = join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`);
            writeFileSync(file, Buffer.from(downloaded.data));
            return { kind: 'file', path: file };
        };
        const resolveInboundFile = async (messageId, fileKey) => {
            const downloaded = await transport.downloadFile(messageId, fileKey);
            if (downloaded === undefined)
                return undefined;
            const dir = join(dataDir, 'files');
            mkdirSync(dir, { recursive: true });
            const file = join(dir, `feishu-${Date.now()}-${randomUUID().slice(0, 8)}.${downloaded.extension || 'bin'}`);
            writeFileSync(file, Buffer.from(downloaded.data));
            return { path: file };
        };
        /** Feature B: provider:model → {at, supports} modality cache (TTL 10 min). */
        const modelModalityCache = new Map();
        const resolveModelSupportsImages = async (route) => {
            // Process-level cache keyed by provider:model (SPEC §5.2): avoid one
            // resolveModelInfo RPC per inbound image; TTL 10 min.
            const key = `${route.provider}:${route.model}`;
            const cached = modelModalityCache.get(key);
            const now = Date.now();
            if (cached !== undefined && now - cached.at < 600_000)
                return cached.supports;
            const llm = ctx.get('llm');
            if (llm?.resolveModelInfo === undefined)
                return undefined;
            const info = await llm.resolveModelInfo(route.provider, route.model);
            // Same rule as dsh-llm's own admission check: undefined modalities =
            // unknown = allow; explicit absence of 'image' = not supported.
            const supports = info.inputModalities === undefined ? undefined : info.inputModalities.includes('image');
            modelModalityCache.set(key, { at: now, supports });
            return supports;
        };
        const bridge = new Bridge({
            transport,
            sessionMap,
            agentStore,
            cards,
            logger,
            defaultCwd: config.defaultCwd ?? process.cwd(),
            modelControl,
            reminders,
            ...(config.resolveImages === undefined ? {} : { resolveImages: config.resolveImages }),
            ...(config.receiveImages === undefined ? {} : { receiveImages: config.receiveImages }),
            ...(config.receiveFiles === undefined ? {} : { receiveFiles: config.receiveFiles }),
            ...(config.showReasoning === undefined ? {} : { showReasoning: config.showReasoning }),
            ...(config.replyReference === undefined ? {} : { replyReference: config.replyReference }),
            ...(config.imageFileFallback === undefined ? {} : { imageFileFallback: config.imageFileFallback }),
            ...(allowed.length === 0 ? {} : { allowedUsers: allowed }),
            resolveInboundImage,
            resolveInboundFile,
            resolveModelSupportsImages,
        });
        bridgeRef = bridge;
        bridge.start();
        bridge.bindSessionEvents(listener => ctx.on('session/event', (session, event) => {
            // Diagnostic: the live trial showed turns never finalize - this line
            // proves whether host session events reach the bridge at all.
            logger.info(`[dsh-tui-feishu] session/event ${String(event.type ?? '?')} for session ${String(session.id)}`);
            listener(String(session.id), event);
        }));
        // The approval waterfall: answer only for agents this bridge owns.
        if (ctx.get('approval') !== undefined) {
            ctx.on('approval/request', (req, next) => bridge.handleApprovalRequest(req, next));
        }
        else {
            logger.warn('[dsh-tui-feishu] approval service unavailable; approvals fail closed');
        }
        ctx.effect(() => () => {
            void bridge.dispose();
            void sessionMap.persist().catch(() => { });
            reminders.dispose();
            transport.stop();
        });
        active = { bridge, transport, reminders, appId: credentials.appId };
        void reminders
            .load()
            .catch((error) => {
            logger.warn(`[dsh-tui-feishu] reminders load failed: ${String(error)}`);
        })
            .then(() => sessionMap.load())
            .catch((error) => {
            logger.warn(`[dsh-tui-feishu] session map load failed (starting empty): ${String(error)}`);
        })
            .then(() => transport
            .start()
            .then(() => logger.info(`[dsh-tui-feishu] bridge ready for app ${credentials.appId} (card engine: ${config.cardEngine ?? 'v1'})`))
            .catch((error) => {
            logger.error(`[dsh-tui-feishu] bridge start failed: ${String(error)}`);
        }));
    };
    /** Run the scan-to-pair bootstrap; the returned text is a short notice. */
    const runPairing = async () => {
        if (pairing !== undefined)
            pairing.controller.abort();
        const controller = new AbortController();
        pairing = { controller, startedAt: Date.now() };
        let onQrReady;
        const qrReady = new Promise(resolve => {
            onQrReady = resolve;
        });
        const pending = pairByQrCode({
            onQRCodeReady: info => onQrReady?.(info),
            signal: controller.signal,
        });
        const qr = await Promise.race([
            qrReady,
            new Promise(resolve => setTimeout(() => resolve(undefined), QR_READY_TIMEOUT_MS)),
        ]);
        if (pairing.controller !== controller)
            return ''; // superseded by a newer pairing
        if (qr === undefined) {
            controller.abort();
            pairing = undefined;
            return '⚠️ 连不上飞书开放平台（没拿到二维码链接）。检查网络后重试 /feishu pair。';
        }
        logger.info(`[dsh-tui-feishu] pairing URL (one-time, valid ~${Math.round(qr.expireIn / 60)}min): ${qr.url}`);
        const opened = openInBrowser(qr.url);
        // Settle in the background: the scan may take minutes; when it lands the
        // credentials persist and the bridge starts immediately.
        void pending
            .then(async (result) => {
            if (pairing?.controller !== controller)
                return;
            pairing = undefined;
            await writeCredentials(files.credentials, {
                appId: result.appId,
                appSecret: result.appSecret,
                ...(result.ownerOpenId === undefined ? {} : { ownerOpenId: result.ownerOpenId }),
            });
            logger.info(`[dsh-tui-feishu] paired with new app ${result.appId}; starting bridge`);
            startBridge(result);
        })
            .catch((error) => {
            if (pairing?.controller === controller)
                pairing = undefined;
            logger.error(`[dsh-tui-feishu] pairing failed: ${String(error)}`);
        });
        return opened
            ? '已在浏览器打开飞书配对页面 - 用手机飞书扫码确认后，回来 /feishu 看状态。'
            : `手动打开配对链接（一次性）：${qr.url}`;
    };
    ctx.effect(() => ctx.commands.register({
        name: 'feishu',
        description: 'Feishu bridge status; "pair" starts scan-to-pair setup',
        recordInput: false,
        handler: async ({ rawInput }) => {
            const sub = rawInput.trim();
            if (sub === 'pair') {
                if (active !== undefined) {
                    return { kind: 'error', text: '桥接已在运行——如需重新配对，先删除凭据文件或移除 FEISHU_APP_ID/SECRET 环境变量。' };
                }
                const text = await runPairing();
                return text === ''
                    ? { kind: 'error', text: '这次配对已被更新的配对请求取代。' }
                    : { kind: 'success', text };
            }
            if (sub !== '') {
                return { kind: 'error', text: '用法：/feishu [pair]' };
            }
            if (active === undefined) {
                return {
                    kind: 'success',
                    text: '飞书桥：未配置。输入 /feishu pair 扫码创建机器人，或设置 FEISHU_APP_ID/FEISHU_APP_SECRET 环境变量。',
                };
            }
            const stats = active.bridge.stats();
            return {
                kind: 'success',
                text: [
                    `飞书桥：应用 ${active.appId}`,
                    `- 连接状态：${active.transport.connectionState()}`,
                    `- 工作目录：${config.defaultCwd ?? process.cwd()}`,
                    `- 消息统计：收到 ${stats.received}，投递 ${stats.delivered}，丢弃 ${stats.dropped}`,
                    `- 日志：${join(dataDir, 'bridge.log')}`,
                    '在飞书里私聊机器人即可远程驱动会话。',
                ].join('\n'),
            };
        },
    }), 'dsh-tui-feishu command');
    void resolveCredentials().then(credentials => {
        if (credentials === undefined) {
            logger.info('[dsh-tui-feishu] not configured: run /feishu pair, or set FEISHU_APP_ID and FEISHU_APP_SECRET');
            return;
        }
        startBridge(credentials);
    });
}
