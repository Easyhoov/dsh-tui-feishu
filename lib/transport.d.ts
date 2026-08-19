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
import { type RawCardActionEvent, type RawMessageEvent } from '@larksuiteoapi/node-sdk';
/** Feishu app credentials. */
export interface FeishuCredentials {
    readonly appId: string;
    readonly appSecret: string;
}
/** A normalized inbound Feishu message. */
export interface FeishuMessage {
    readonly messageId: string;
    readonly chatId: string;
    readonly chatType: 'p2p' | 'group';
    readonly senderOpenId: string;
    readonly text: string;
    /** Open ids of users @-mentioned in the message (bot excluded by caller). */
    readonly mentions: readonly string[];
}
/** A normalized card-button callback. */
export interface FeishuCardAction {
    readonly messageId: string;
    readonly chatId: string;
    readonly operatorOpenId: string;
    readonly value: Record<string, string>;
}
/** Result of a successful QR pairing. */
export interface PairingResult extends FeishuCredentials {
    /** Open id of the scanning user - seeded as the bridge's first owner. */
    readonly ownerOpenId?: string;
}
/** Logger surface the transport needs. */
export interface TransportLogger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}
/** A failed Feishu API call (non-zero business `code`). */
export declare class FeishuApiError extends Error {
    readonly operation: string;
    readonly code: number;
    constructor(operation: string, code: number, message: string);
}
/**
 * Fold an HTTP-layer SDK error (axios) into a FeishuApiError carrying the
 * platform's business code/message, so logs show the real rejection reason
 * instead of a bare 'Request failed with status code 400'.
 */
export declare function asFeishuError(operation: string, error: unknown): Error;
/**
 * Normalize a raw `im.message.receive_v1` payload into a bridge message, or
 * `undefined` when the message is not a supported type. Pure function.
 */
export declare function normalizeMessageEvent(data: RawMessageEvent): FeishuMessage | undefined;
/**
 * Normalize a raw `card.action.trigger` payload into a bridge action, or
 * `undefined` when no actionable payload is present. Pure function.
 */
export declare function normalizeCardAction(data: RawCardActionEvent): FeishuCardAction | undefined;
/**
 * Run the official scan-to-create-app bootstrap. The returned promise settles
 * with the new app's credentials once the user scans the QR and confirms in
 * Feishu; `onQRCodeReady` fires earlier with the one-time launcher URL.
 */
export declare function pairByQrCode(options: {
    onQRCodeReady: (info: {
        url: string;
        expireIn: number;
    }) => void;
    onStatusChange?: (status: 'polling' | 'slow_down' | 'domain_switched') => void;
    signal?: AbortSignal;
}): Promise<PairingResult>;
/**
 * The Feishu transport: long-connection receive + API send/update.
 */
export declare class LarkTransport {
    private readonly client;
    private readonly ws;
    private readonly dispatcher;
    private handler;
    private actionHandler;
    private readonly logger;
    private connectionStateValue;
    private botOpenIdValue;
    constructor(credentials: FeishuCredentials, logger?: TransportLogger);
    /** The live long-connection state. */
    connectionState(): 'starting' | 'ready' | 'reconnecting' | 'error';
    /** Connect the long connection and begin delivering events. */
    start(): Promise<void>;
    /** Close the long connection. */
    stop(): void;
    /** Register the single inbound-message handler. */
    onMessage(handler: (message: FeishuMessage) => void): void;
    /** Register the single card-button handler. */
    onCardAction(handler: (action: FeishuCardAction) => void): void;
    /** The bot's own open id, or `undefined` until resolved. */
    getBotOpenId(): string | undefined;
    /** Send a plain text message to a chat. */
    sendText(chatId: string, text: string): Promise<void>;
    /** Send an interactive card; resolves with the created message id. */
    sendCard(chatId: string, card: unknown): Promise<string>;
    /** Update an already-sent card in place (silent: no unread notification). */
    updateCard(messageId: string, card: unknown): Promise<void>;
    /** Fetch and cache the bot's own open id (`bot/v3/info`). */
    private resolveBotOpenId;
    /** Create a message in a chat; assert the API succeeded. */
    private createMessage;
    private assertOk;
}
