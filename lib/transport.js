/**
 * Feishu (Lark) transport over the official `@larksuiteoapi/node-sdk`.
 *
 * One WebSocket long connection (`WSClient`, outbound only - no public
 * endpoint or public IP needed) delivers `im.message.receive_v1` message
 * events and `card.action.trigger` card-button callbacks; one `Client`
 * drives the outbound REST surface (`im.v1.message.create` / `patch`).
 *
 * `pairByQrCode` wraps the SDK's Device-Authorization-Grant app bootstrap
 * (`registerApp`): it returns the one-time launcher URL for the user to scan
 * in Feishu and resolves with the freshly created app credentials plus the
 * scanning user's open id (the natural first owner of this bridge).
 *
 * Refactored from PGZXB/dsh-feishu (MIT), simplified to the p2p chat loop.
 *
 * @module dsh-tui-feishu/transport
 */
import { Client, EventDispatcher, registerApp, WSClient, } from '@larksuiteoapi/node-sdk';
/** A failed Feishu API call (non-zero business `code`). */
export class FeishuApiError extends Error {
    operation;
    code;
    constructor(operation, code, message) {
        super(`feishu ${operation} failed: ${message} (code ${code})`);
        this.operation = operation;
        this.code = code;
        this.name = 'FeishuApiError';
    }
}
/**
 * Business codes treated as transient (gateway timeouts / CardKit internal
 * errors) - the message itself is fine, the platform hiccuped. Retried with
 * short backoff. Mirrors hermes-lark-streaming's transient-error set.
 */
const TRANSIENT_CODES = new Set([
    99991400, // gateway timeout
    2200, // CardKit gateway timeout
    1663, // CardKit internal error
    300000, // CardKit server internal error
]);
/** Backoff delays between transient retries, in ms. */
const TRANSIENT_RETRY_DELAYS_MS = [150, 500, 1000];
/**
 * Run one Feishu API call with transient-error retry: business codes in the
 * transient set and network-level failures (errors that are not business
 * `FeishuApiError`s) are retried with short backoff; everything else
 * (terminal message errors, permissions, rate limits) surfaces immediately.
 * The call is expected to throw `FeishuApiError` for business failures.
 */
async function withTransientRetry(call) {
    let lastError;
    for (let attempt = 0; attempt <= TRANSIENT_RETRY_DELAYS_MS.length; attempt += 1) {
        try {
            return await call();
        }
        catch (error) {
            lastError = error;
            const apiError = error instanceof FeishuApiError ? error : undefined;
            const transient = apiError !== undefined ? TRANSIENT_CODES.has(apiError.code) : true;
            if (!transient || attempt === TRANSIENT_RETRY_DELAYS_MS.length)
                throw error;
            await new Promise(resolve => setTimeout(resolve, TRANSIENT_RETRY_DELAYS_MS[attempt] ?? 150));
        }
    }
    throw lastError;
}
/**
 * Fold an HTTP-layer SDK error (axios) into a FeishuApiError carrying the
 * platform's business code/message, so logs show the real rejection reason
 * instead of a bare 'Request failed with status code 400'.
 */
export function asFeishuError(operation, error) {
    const data = error?.response?.data;
    if (data !== null && typeof data === 'object') {
        const { code, msg } = data;
        return new FeishuApiError(operation, typeof code === 'number' ? code : -1, typeof msg === 'string' ? msg : error instanceof Error ? error.message : String(error));
    }
    return error instanceof Error ? error : new Error(String(error));
}
/** Strip `<at …>name</at>` mention placeholders from Feishu text content. */
const MENTION_PATTERN = /<at[^>]*>.*?<\/at>/g;
/** Message types the bridge understands; everything else is ignored. */
const SUPPORTED_MESSAGE_TYPE = 'text';
/**
 * Normalize a raw `im.message.receive_v1` payload into a bridge message, or
 * `undefined` when the message is not a supported type. Pure function.
 */
export function normalizeMessageEvent(data) {
    const message = data.message;
    if (message === undefined || message.message_type !== SUPPORTED_MESSAGE_TYPE)
        return undefined;
    const senderOpenId = data.sender?.sender_id?.open_id ?? '';
    let text = '';
    try {
        text = JSON.parse(message.content).text ?? '';
    }
    catch {
        return undefined;
    }
    text = text.replace(MENTION_PATTERN, ' ').replace(/\s+/g, ' ').trim();
    return {
        messageId: message.message_id,
        chatId: message.chat_id,
        chatType: message.chat_type === 'group' ? 'group' : 'p2p',
        senderOpenId,
        text,
        mentions: (message.mentions ?? [])
            .map(mention => mention.id?.open_id)
            .filter((id) => id !== undefined && id !== ''),
        createdAt: Number(message.create_time) || Date.now(),
    };
}
/**
 * Normalize a raw `card.action.trigger` payload into a bridge action, or
 * `undefined` when no actionable payload is present. Pure function.
 */
export function normalizeCardAction(data) {
    const messageId = data.context?.open_message_id ?? data.open_message_id;
    const chatId = data.context?.open_chat_id ?? data.open_chat_id;
    const operatorOpenId = data.operator?.open_id ?? '';
    const value = data.action?.value;
    if (messageId === undefined ||
        chatId === undefined ||
        typeof value !== 'object' ||
        value === null) {
        return undefined;
    }
    return {
        messageId,
        chatId,
        operatorOpenId,
        value: value,
    };
}
/**
 * Run the official scan-to-create-app bootstrap. The returned promise settles
 * with the new app's credentials once the user scans the QR and confirms in
 * Feishu; `onQRCodeReady` fires earlier with the one-time launcher URL.
 */
export async function pairByQrCode(options) {
    const onStatus = options.onStatusChange;
    const result = await registerApp({
        onQRCodeReady: info => options.onQRCodeReady(info),
        ...(onStatus === undefined ? {} : { onStatusChange: info => onStatus(info.status) }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        createOnly: true,
        appPreset: { name: 'dsh-TUI Agent', desc: 'Your dsh-TUI agent, remote-controlled from Feishu' },
        addons: {
            preset: true,
            scopes: { tenant: ['im:message', 'im:message:send_as_bot', 'im:chat'] },
            events: { items: { tenant: ['im.message.receive_v1'] } },
            callbacks: { items: ['card.action.trigger'] },
        },
    });
    return {
        appId: result.client_id,
        appSecret: result.client_secret,
        ...(result.user_info?.open_id !== undefined && result.user_info.open_id !== ''
            ? { ownerOpenId: result.user_info.open_id }
            : {}),
    };
}
/**
 * The Feishu transport: long-connection receive + API send/update.
 */
export class LarkTransport {
    client;
    ws;
    dispatcher = new EventDispatcher({});
    handler;
    actionHandler;
    logger;
    connectionStateValue = 'starting';
    botOpenIdValue;
    constructor(credentials, logger) {
        this.logger = logger;
        this.client = new Client({ appId: credentials.appId, appSecret: credentials.appSecret });
        this.ws = new WSClient({
            appId: credentials.appId,
            appSecret: credentials.appSecret,
            autoReconnect: true,
            onReady: () => {
                this.connectionStateValue = 'ready';
                this.logger?.info('feishu long connection ready');
            },
            onError: (error) => {
                this.connectionStateValue = 'error';
                this.logger?.error(`feishu long connection failed: ${error.message}`);
            },
            onReconnecting: () => {
                this.connectionStateValue = 'reconnecting';
                this.logger?.warn('feishu long connection reconnecting');
            },
            onReconnected: () => {
                this.connectionStateValue = 'ready';
                this.logger?.info('feishu long connection reconnected');
            },
        });
    }
    /** The live long-connection state. */
    connectionState() {
        return this.connectionStateValue;
    }
    /** Connect the long connection and begin delivering events. */
    async start() {
        this.dispatcher.register({
            'im.message.receive_v1': data => {
                const message = normalizeMessageEvent(data);
                if (message === undefined) {
                    this.logger?.info('feishu event received but not a supported text message (ignored)');
                }
                else {
                    this.logger?.info(`feishu message ${message.messageId} from ${message.senderOpenId} in ${message.chatType} ${message.chatId}: ${message.text.slice(0, 60)}`);
                    this.handler?.(message);
                }
                return undefined;
            },
            'card.action.trigger': (data) => {
                const action = normalizeCardAction(data);
                if (action !== undefined) {
                    this.logger?.info(`feishu card action from ${action.operatorOpenId} on ${action.messageId}`);
                    this.actionHandler?.(action);
                }
                else {
                    this.logger?.info('feishu card action received without actionable payload (ignored)');
                }
                // ACK with no UI update; an undefined return is rejected by the
                // Feishu client as an invalid ACK and re-renders stale card state.
                return {};
            },
        });
        await this.ws.start({ eventDispatcher: this.dispatcher });
        void this.resolveBotOpenId().catch((error) => {
            this.logger?.warn(`bot open id resolution failed: ${String(error)}`);
        });
    }
    /** Close the long connection. */
    stop() {
        this.ws.close();
    }
    /** Register the single inbound-message handler. */
    onMessage(handler) {
        this.handler = handler;
    }
    /** Register the single card-button handler. */
    onCardAction(handler) {
        this.actionHandler = handler;
    }
    /** The bot's own open id, or `undefined` until resolved. */
    getBotOpenId() {
        return this.botOpenIdValue;
    }
    /** Send a plain text message to a chat. */
    async sendText(chatId, text) {
        await this.createMessage(chatId, 'text', JSON.stringify({ text }));
    }
    /** Send an interactive card; resolves with the created message id. */
    async sendCard(chatId, card) {
        const response = await this.createMessage(chatId, 'interactive', JSON.stringify(card));
        const messageId = response.data?.message_id;
        if (messageId === undefined) {
            throw new FeishuApiError('im.v1.message.create', -1, 'response carried no message_id');
        }
        return messageId;
    }
    /** Update an already-sent card in place (silent: no unread notification). */
    async updateCard(messageId, card) {
        let response;
        try {
            response = await withTransientRetry(async () => {
                try {
                    return await this.client.im.v1.message.patch({
                        data: { content: JSON.stringify(card) },
                        path: { message_id: messageId },
                    });
                }
                catch (error) {
                    throw asFeishuError('im.v1.message.patch', error);
                }
            });
        }
        catch (error) {
            throw asFeishuError('im.v1.message.patch', error);
        }
        this.assertOk(response, 'im.v1.message.patch');
    }
    /** Fetch and cache the bot's own open id (`bot/v3/info`). */
    async resolveBotOpenId() {
        const response = await this.client.request({ method: 'GET', url: '/open-apis/bot/v3/info' });
        const code = response?.code ?? -1;
        if (code !== 0) {
            throw new FeishuApiError('bot.v3.info', code, response?.msg ?? 'unknown error');
        }
        const openId = response.data?.open_id;
        if (openId !== undefined && openId !== '')
            this.botOpenIdValue = openId;
    }
    /** Create a message in a chat; assert the API succeeded. */
    async createMessage(chatId, msgType, content) {
        let response;
        try {
            response = await withTransientRetry(async () => {
                try {
                    return await this.client.im.v1.message.create({
                        data: { receive_id: chatId, msg_type: msgType, content },
                        params: { receive_id_type: 'chat_id' },
                    });
                }
                catch (error) {
                    throw asFeishuError('im.v1.message.create', error);
                }
            });
        }
        catch (error) {
            throw asFeishuError('im.v1.message.create', error);
        }
        this.assertOk(response, 'im.v1.message.create');
        return response;
    }
    assertOk(response, operation) {
        const code = response.code ?? -1;
        if (code !== 0) {
            throw new FeishuApiError(operation, code, response.msg ?? 'unknown error');
        }
    }
}
