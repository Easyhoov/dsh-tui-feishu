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
    /** Visible text for `text` messages ('' for image/file-only messages). */
    readonly text: string;
    /** `image` messages carry the platform image key (download via `downloadImage`). */
    readonly imageKey?: string;
    /** `file` messages carry the platform file key (download via `downloadFile`). */
    readonly fileKey?: string;
    /** `message_id` this message replies-to/quotes, when present. */
    readonly parentId?: string;
    /** Thread-root `message_id` for quoted replies (≠ messageId). */
    readonly rootId?: string;
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
 * instead of a bare 'Request failed with status code 400'. Binary response
 * modes (arraybuffer/blob) return the error body as an ArrayBuffer - decode
 * it before parsing so the business code survives.
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
 *
 * Accepts both callback shapes: the v1 payload (fields at the root:
 * `operator` / `action` / `context`) and the schema-2.0 callback payload
 * (fields nested under `event`: `event.operator` / `event.action` /
 * `event.context` - see 卡片回传交互回调).
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
/** One downloaded inbound image: raw bytes plus the sniffed media type. */
export interface DownloadedImage {
    readonly data: Uint8Array;
    readonly mediaType: string;
}
/** Sniff the media type of raw image bytes (JPEG/PNG/GIF/WebP). */
export declare function sniffImageMediaType(data: Uint8Array): string | undefined;
/** Sniff a generic download's extension from magic bytes ('' for unknown). */
export declare function sniffFileType(data: Uint8Array): string;
/** One downloaded inbound file: raw bytes plus the sniffed extension. */
export interface DownloadedFile {
    readonly data: Uint8Array;
    readonly extension: string;
}
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
    /** Download an inbound image message's bytes by its message id + image key. */
    downloadImage(messageId: string, imageKey: string): Promise<DownloadedImage | undefined>;
    /** Download an inbound file message's bytes by its message id + file key. */
    downloadFile(messageId: string, fileKey: string): Promise<DownloadedFile | undefined>;
    /**
     * Fetch one message by id (for reply references). Returns the platform
     * shape needed by `buildReplyReference`; throws on failure so the caller
     * maps errors to unavailableReason. Single attempt, bounded by `timeoutMs`.
     */
    getMessage(messageId: string, timeoutMs?: number): Promise<{
        messageId: string;
        messageType: string;
        content: Record<string, unknown>;
        senderId?: string;
        senderName?: string;
    }>;
    /** Send a plain text message to a chat. */
    sendText(chatId: string, text: string): Promise<void>;
    /** Send an interactive card; resolves with the created message id. */
    sendCard(chatId: string, card: unknown): Promise<string>;
    /** Update an already-sent card in place (silent: no unread notification). */
    updateCard(messageId: string, card: unknown): Promise<void>;
    /**
     * Download a remote image and upload it to Feishu (`im.v1.image.create`),
     * resolving the platform `image_key` (or `undefined` on any failure - the
     * caller keeps the original URL). Mirrors hermes-lark-streaming's
     * download-then-upload flow.
     */
    uploadImage(url: string, timeoutMs?: number): Promise<string | undefined>;
    /**
     * Create a CardKit card entity from card JSON 2.0; resolves the `card_id`.
     * (CardKit cards stream per-element and are updated via the cardkit APIs,
     * not `im.v1.message.patch`.)
     */
    cardkitCreate(card: unknown): Promise<string>;
    /** Send a CardKit card entity into a chat as a new message; resolves the message id. */
    cardkitSendToChat(chatId: string, cardId: string): Promise<string>;
    /** Structurally update a CardKit card (add/replace elements), sequence-ordered. */
    cardkitBatchUpdate(cardId: string, actions: readonly unknown[], sequence: number): Promise<void>;
    /** Stream one element's text content (typing effect while streaming_mode is on). */
    cardkitStreamElement(cardId: string, elementId: string, content: string, sequence: number): Promise<void>;
    /** Full replace of a CardKit card (must follow close-streaming at the end). */
    cardkitUpdate(cardId: string, card: unknown, sequence: number): Promise<void>;
    /** Turn streaming mode off (required before the final full update). */
    cardkitCloseStreaming(cardId: string, sequence: number): Promise<void>;
    /** Fetch and cache the bot's own open id (`bot/v3/info`). */
    private resolveBotOpenId;
    /** Create a message in a chat; assert the API succeeded. */
    private createMessage;
    private assertOk;
}
