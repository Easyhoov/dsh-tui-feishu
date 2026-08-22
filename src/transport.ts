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

import {
  Client,
  EventDispatcher,
  registerApp,
  WSClient,
  type RawCardActionEvent,
  type RawMessageEvent,
} from '@larksuiteoapi/node-sdk'

/** Feishu app credentials. */
export interface FeishuCredentials {
  readonly appId: string
  readonly appSecret: string
}

/** A normalized inbound Feishu message. */
export interface FeishuMessage {
  readonly messageId: string
  readonly chatId: string
  readonly chatType: 'p2p' | 'group'
  readonly senderOpenId: string
  /** Visible text for `text` messages ('' for image-only messages). */
  readonly text: string
  /** `image` messages carry the platform image key (download via `downloadImage`). */
  readonly imageKey?: string
  /** Open ids of users @-mentioned in the message (bot excluded by caller). */
  readonly mentions: readonly string[]
}

/** A normalized card-button callback. */
export interface FeishuCardAction {
  readonly messageId: string
  readonly chatId: string
  readonly operatorOpenId: string
  readonly value: Record<string, string>
}

/** Result of a successful QR pairing. */
export interface PairingResult extends FeishuCredentials {
  /** Open id of the scanning user - seeded as the bridge's first owner. */
  readonly ownerOpenId?: string
}

/** Logger surface the transport needs. */
export interface TransportLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** A failed Feishu API call (non-zero business `code`). */
export class FeishuApiError extends Error {
  constructor(
    readonly operation: string,
    readonly code: number,
    message: string,
  ) {
    super(`feishu ${operation} failed: ${message} (code ${code})`)
    this.name = 'FeishuApiError'
  }
}

/**
 * Business codes treated as transient (gateway timeouts / CardKit internal
 * errors) - the message itself is fine, the platform hiccuped. Retried with
 * short backoff. Mirrors hermes-lark-streaming's transient-error set.
 */
const TRANSIENT_CODES: ReadonlySet<number> = new Set([
  99991400, // gateway timeout
  2200, // CardKit gateway timeout
  1663, // CardKit internal error
  300000, // CardKit server internal error
])

/** Backoff delays between transient retries, in ms. */
const TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [150, 500, 1000]

/**
 * Run one Feishu API call with transient-error retry: business codes in the
 * transient set and network-level failures (errors that are not business
 * `FeishuApiError`s) are retried with short backoff; everything else
 * (terminal message errors, permissions, rate limits) surfaces immediately.
 * The call is expected to throw `FeishuApiError` for business failures.
 */
async function withTransientRetry<T>(call: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= TRANSIENT_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await call()
    } catch (error: unknown) {
      lastError = error
      const apiError = error instanceof FeishuApiError ? error : undefined
      const transient = apiError !== undefined ? TRANSIENT_CODES.has(apiError.code) : true
      if (!transient || attempt === TRANSIENT_RETRY_DELAYS_MS.length) throw error
      await new Promise(resolve => setTimeout(resolve, TRANSIENT_RETRY_DELAYS_MS[attempt] ?? 150))
    }
  }
  throw lastError
}

/**
 * Fold an HTTP-layer SDK error (axios) into a FeishuApiError carrying the
 * platform's business code/message, so logs show the real rejection reason
 * instead of a bare 'Request failed with status code 400'. Binary response
 * modes (arraybuffer/blob) return the error body as an ArrayBuffer - decode
 * it before parsing so the business code survives.
 */
export function asFeishuError(operation: string, error: unknown): Error {
  let data = (error as { response?: { data?: unknown } } | null)?.response?.data
  if (data instanceof ArrayBuffer) {
    try {
      data = JSON.parse(new TextDecoder().decode(data)) as unknown
    } catch {
      // Not JSON; keep the raw buffer (falls through to the message below).
    }
  }
  if (data !== null && typeof data === 'object') {
    const { code, msg } = data as { code?: unknown; msg?: unknown }
    return new FeishuApiError(
      operation,
      typeof code === 'number' ? code : -1,
      typeof msg === 'string' ? msg : error instanceof Error ? error.message : String(error),
    )
  }
  return error instanceof Error ? error : new Error(String(error))
}

/** Strip `<at …>name</at>` mention placeholders from Feishu text content. */
const MENTION_PATTERN = /<at[^>]*>.*?<\/at>/g
/** Message types the bridge understands; everything else is ignored. */
const SUPPORTED_MESSAGE_TYPES = new Set(['text', 'image'])

/**
 * Normalize a raw `im.message.receive_v1` payload into a bridge message, or
 * `undefined` when the message is not a supported type. Pure function.
 */
export function normalizeMessageEvent(data: RawMessageEvent): FeishuMessage | undefined {
  const message = data.message
  if (message === undefined || !SUPPORTED_MESSAGE_TYPES.has(message.message_type)) return undefined
  const senderOpenId = data.sender?.sender_id?.open_id ?? ''
  let text = ''
  let imageKey: string | undefined
  try {
    const content = JSON.parse(message.content) as { text?: string; image_key?: string }
    text = content.text ?? ''
    imageKey = content.image_key
  } catch {
    return undefined
  }
  text = text.replace(MENTION_PATTERN, ' ').replace(/\s+/g, ' ').trim()
  return {
    messageId: message.message_id,
    chatId: message.chat_id,
    chatType: message.chat_type === 'group' ? 'group' : 'p2p',
    senderOpenId,
    text,
    ...(imageKey === undefined || imageKey === '' ? {} : { imageKey }),
    mentions: (message.mentions ?? [])
      .map(mention => mention.id?.open_id)
      .filter((id): id is string => id !== undefined && id !== ''),
    createdAt: Number(message.create_time) || Date.now(),
  } as FeishuMessage
}

/**
 * Normalize a raw `card.action.trigger` payload into a bridge action, or
 * `undefined` when no actionable payload is present. Pure function.
 *
 * Accepts both callback shapes: the v1 payload (fields at the root:
 * `operator` / `action` / `context`) and the schema-2.0 callback payload
 * (fields nested under `event`: `event.operator` / `event.action` /
 * `event.context` - see 卡片回传交互回调).
 */
export function normalizeCardAction(data: RawCardActionEvent): FeishuCardAction | undefined {
  const root = (data as { event?: unknown }).event
  const event = root !== null && typeof root === 'object' ? (root as Record<string, unknown>) : undefined
  const context = (event?.context ?? data.context ?? undefined) as
    | { open_message_id?: string; open_chat_id?: string }
    | undefined
  const messageId = context?.open_message_id ?? data.open_message_id
  const chatId = context?.open_chat_id ?? data.open_chat_id
  const operator = (event?.operator ?? data.operator ?? undefined) as { open_id?: string } | undefined
  const operatorOpenId = operator?.open_id ?? ''
  const value = (event?.action ?? data.action ?? undefined) as { value?: unknown } | undefined
  const actionValue = value?.value
  if (
    messageId === undefined ||
    chatId === undefined ||
    typeof actionValue !== 'object' ||
    actionValue === null
  ) {
    return undefined
  }
  return {
    messageId,
    chatId,
    operatorOpenId,
    value: actionValue as Record<string, string>,
  }
}

/**
 * Run the official scan-to-create-app bootstrap. The returned promise settles
 * with the new app's credentials once the user scans the QR and confirms in
 * Feishu; `onQRCodeReady` fires earlier with the one-time launcher URL.
 */
export async function pairByQrCode(options: {
  onQRCodeReady: (info: { url: string; expireIn: number }) => void
  onStatusChange?: (status: 'polling' | 'slow_down' | 'domain_switched') => void
  signal?: AbortSignal
}): Promise<PairingResult> {
  const onStatus = options.onStatusChange
  const result = await registerApp({
    onQRCodeReady: info => options.onQRCodeReady(info),
    ...(onStatus === undefined ? {} : { onStatusChange: info => onStatus(info.status) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    createOnly: true,
    appPreset: { name: 'dsh-TUI Agent', desc: 'Your dsh-TUI agent, remote-controlled from Feishu' },
    addons: {
      preset: true,
      // `im:resource` covers inbound image downloads (im/v1/images/{key}).
      scopes: { tenant: ['im:message', 'im:message:send_as_bot', 'im:chat', 'im:resource'] },
      events: { items: { tenant: ['im.message.receive_v1'] } },
      callbacks: { items: ['card.action.trigger'] },
    },
  })
  return {
    appId: result.client_id,
    appSecret: result.client_secret,
    ...(result.user_info?.open_id !== undefined && result.user_info.open_id !== ''
      ? { ownerOpenId: result.user_info.open_id }
      : {}),
  }
}

/** One downloaded inbound image: raw bytes plus the sniffed media type. */
export interface DownloadedImage {
  readonly data: Uint8Array
  readonly mediaType: string
}

/** Sniff the media type of raw image bytes (JPEG/PNG/GIF/WebP). */
export function sniffImageMediaType(data: Uint8Array): string | undefined {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  if (data.length >= 6 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return 'image/gif'
  if (
    data.length >= 12 &&
    data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
    data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
  ) return 'image/webp'
  return undefined
}

/**
 * Download an inbound image message's raw bytes by its `image_key`
 * (`GET /open-apis/im/v1/images/{image_key}`, needs the `im:resource`
 * permission). Resolves `undefined` when the bytes are not a supported
 * image; throws `FeishuApiError` on a platform business error (e.g. a
 * missing `im:resource` scope on the paired app).
 */
async function downloadFeishuImage(
  client: Client,
  imageKey: string,
  logger: TransportLogger | undefined,
): Promise<DownloadedImage | undefined> {
  let response
  try {
    response = await withTransientRetry(async () => {
      try {
        return await client.request<unknown>({
          method: 'GET',
          url: `/open-apis/im/v1/images/${encodeURIComponent(imageKey)}`,
          responseType: 'arraybuffer',
          timeout: 20_000,
        })
      } catch (error: unknown) {
        throw asFeishuError('im.v1.image.get', error)
      }
    })
  } catch (error: unknown) {
    throw asFeishuError('im.v1.image.get', error)
  }
  // A platform error arrives as a JSON body even with arraybuffer mode.
  const bytes = response instanceof ArrayBuffer ? new Uint8Array(response) : undefined
  if (bytes === undefined || bytes.length === 0) {
    logger?.warn(`image download returned no bytes for key ${imageKey.slice(0, 12)}…`)
    return undefined
  }
  if (bytes[0] === 0x7b /* '{' */) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { code?: number; msg?: string }
      const code = typeof parsed.code === 'number' ? parsed.code : -1
      throw new FeishuApiError('im.v1.image.get', code, parsed.msg ?? 'image download rejected')
    } catch (error: unknown) {
      if (error instanceof FeishuApiError) throw error
      // Not JSON after all - fall through to sniffing.
    }
  }
  const mediaType = sniffImageMediaType(bytes)
  if (mediaType === undefined) {
    logger?.warn(`image download for key ${imageKey.slice(0, 12)}… is not a supported image type`)
    return undefined
  }
  return { data: bytes, mediaType }
}

/**
 * The Feishu transport: long-connection receive + API send/update.
 */
export class LarkTransport {
  private readonly client: Client
  private readonly ws: WSClient
  private readonly dispatcher = new EventDispatcher({})
  private handler: ((message: FeishuMessage) => void) | undefined
  private actionHandler: ((action: FeishuCardAction) => void) | undefined
  private readonly logger: TransportLogger | undefined
  private connectionStateValue: 'starting' | 'ready' | 'reconnecting' | 'error' = 'starting'
  private botOpenIdValue: string | undefined

  constructor(credentials: FeishuCredentials, logger?: TransportLogger) {
    this.logger = logger
    this.client = new Client({ appId: credentials.appId, appSecret: credentials.appSecret })
    this.ws = new WSClient({
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      autoReconnect: true,
      onReady: () => {
        this.connectionStateValue = 'ready'
        this.logger?.info('feishu long connection ready')
      },
      onError: (error: Error) => {
        this.connectionStateValue = 'error'
        this.logger?.error(`feishu long connection failed: ${error.message}`)
      },
      onReconnecting: () => {
        this.connectionStateValue = 'reconnecting'
        this.logger?.warn('feishu long connection reconnecting')
      },
      onReconnected: () => {
        this.connectionStateValue = 'ready'
        this.logger?.info('feishu long connection reconnected')
      },
    })
  }

  /** The live long-connection state. */
  connectionState(): 'starting' | 'ready' | 'reconnecting' | 'error' {
    return this.connectionStateValue
  }

  /** Connect the long connection and begin delivering events. */
  async start(): Promise<void> {
    this.dispatcher.register({
      'im.message.receive_v1': data => {
        const message = normalizeMessageEvent(data as RawMessageEvent)
        if (message === undefined) {
          this.logger?.info('feishu event received but not a supported text message (ignored)')
        } else {
          this.logger?.info(
            `feishu message ${message.messageId} from ${message.senderOpenId} in ${message.chatType} ${message.chatId}: ${message.text.slice(0, 60)}`,
          )
          this.handler?.(message)
        }
        return undefined
      },
      'card.action.trigger': (data: RawCardActionEvent) => {
        const action = normalizeCardAction(data as RawCardActionEvent)
        if (action !== undefined) {
          this.logger?.info(`feishu card action from ${action.operatorOpenId} on ${action.messageId}`)
          this.actionHandler?.(action)
        } else {
          this.logger?.info('feishu card action received without actionable payload (ignored)')
        }
        // ACK with no UI update; an undefined return is rejected by the
        // Feishu client as an invalid ACK and re-renders stale card state.
        return {}
      },
    })
    await this.ws.start({ eventDispatcher: this.dispatcher })
    void this.resolveBotOpenId().catch((error: unknown) => {
      this.logger?.warn(`bot open id resolution failed: ${String(error)}`)
    })
  }

  /** Close the long connection. */
  stop(): void {
    this.ws.close()
  }

  /** Register the single inbound-message handler. */
  onMessage(handler: (message: FeishuMessage) => void): void {
    this.handler = handler
  }

  /** Register the single card-button handler. */
  onCardAction(handler: (action: FeishuCardAction) => void): void {
    this.actionHandler = handler
  }

  /** The bot's own open id, or `undefined` until resolved. */
  getBotOpenId(): string | undefined {
    return this.botOpenIdValue
  }

  /** Download an inbound image message's bytes by its `image_key`. */
  async downloadImage(imageKey: string): Promise<DownloadedImage | undefined> {
    return downloadFeishuImage(this.client, imageKey, this.logger)
  }

  /** Send a plain text message to a chat. */
  async sendText(chatId: string, text: string): Promise<void> {
    await this.createMessage(chatId, 'text', JSON.stringify({ text }))
  }

  /** Send an interactive card; resolves with the created message id. */
  async sendCard(chatId: string, card: unknown): Promise<string> {
    const response = await this.createMessage(chatId, 'interactive', JSON.stringify(card))
    const messageId = response.data?.message_id
    if (messageId === undefined) {
      throw new FeishuApiError('im.v1.message.create', -1, 'response carried no message_id')
    }
    return messageId
  }

  /** Update an already-sent card in place (silent: no unread notification). */
  async updateCard(messageId: string, card: unknown): Promise<void> {
    let response
    try {
      response = await withTransientRetry(async () => {
        try {
          return await this.client.im.v1.message.patch({
            data: { content: JSON.stringify(card) },
            path: { message_id: messageId },
          })
        } catch (error: unknown) {
          throw asFeishuError('im.v1.message.patch', error)
        }
      })
    } catch (error: unknown) {
      throw asFeishuError('im.v1.message.patch', error)
    }
    this.assertOk(response, 'im.v1.message.patch')
  }

  /**
   * Download a remote image and upload it to Feishu (`im.v1.image.create`),
   * resolving the platform `image_key` (or `undefined` on any failure - the
   * caller keeps the original URL). Mirrors hermes-lark-streaming's
   * download-then-upload flow.
   */
  async uploadImage(url: string, timeoutMs = 10_000): Promise<string | undefined> {
    let data: Buffer
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'dsh-tui-feishu/0.2' },
        })
        if (!response.ok) return undefined
        data = Buffer.from(await response.arrayBuffer())
      } finally {
        clearTimeout(timer)
      }
    } catch {
      return undefined
    }
    // The platform caps uploads at 10 MB and rejects empty images.
    if (data.length === 0 || data.length > 10 * 1024 * 1024) return undefined
    try {
      const response = await this.client.im.v1.image.create({
        data: { image_type: 'message', image: data },
      })
      const key = response?.image_key
      return key === undefined || key === '' ? undefined : key
    } catch (error: unknown) {
      this.logger?.warn(`image upload failed: ${String(error)}`)
      return undefined
    }
  }

  /**
   * Create a CardKit card entity from card JSON 2.0; resolves the `card_id`.
   * (CardKit cards stream per-element and are updated via the cardkit APIs,
   * not `im.v1.message.patch`.)
   */
  async cardkitCreate(card: unknown): Promise<string> {
    let response
    try {
      response = await withTransientRetry(async () => {
        try {
          return await this.client.cardkit.v1.card.create({
            data: { type: 'card_json', data: JSON.stringify(card) },
          })
        } catch (error: unknown) {
          throw asFeishuError('cardkit.v1.card.create', error)
        }
      })
    } catch (error: unknown) {
      throw asFeishuError('cardkit.v1.card.create', error)
    }
    this.assertOk(response, 'cardkit.v1.card.create')
    const cardId = response.data?.card_id
    if (cardId === undefined || cardId === '') {
      throw new FeishuApiError('cardkit.v1.card.create', -1, 'response carried no card_id')
    }
    return cardId
  }

  /** Send a CardKit card entity into a chat as a new message; resolves the message id. */
  async cardkitSendToChat(chatId: string, cardId: string): Promise<string> {
    let response
    try {
      response = await withTransientRetry(async () => {
        try {
          return await this.client.im.v1.message.create({
            data: {
              receive_id: chatId,
              msg_type: 'interactive',
              content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
            },
            params: { receive_id_type: 'chat_id' },
          })
        } catch (error: unknown) {
          throw asFeishuError('im.v1.message.create', error)
        }
      })
    } catch (error: unknown) {
      throw asFeishuError('im.v1.message.create', error)
    }
    this.assertOk(response, 'im.v1.message.create')
    const messageId = response.data?.message_id
    if (messageId === undefined || messageId === '') {
      throw new FeishuApiError('im.v1.message.create', -1, 'response carried no message_id')
    }
    return messageId
  }

  /** Structurally update a CardKit card (add/replace elements), sequence-ordered. */
  async cardkitBatchUpdate(cardId: string, actions: readonly unknown[], sequence: number): Promise<void> {
    let response
    try {
      response = await withTransientRetry(async () => {
        try {
          return await this.client.cardkit.v1.card.batchUpdate({
            data: { actions: JSON.stringify(actions), sequence },
            path: { card_id: cardId },
          })
        } catch (error: unknown) {
          throw asFeishuError('cardkit.v1.card.batchUpdate', error)
        }
      })
    } catch (error: unknown) {
      throw asFeishuError('cardkit.v1.card.batchUpdate', error)
    }
    this.assertOk(response, 'cardkit.v1.card.batchUpdate')
  }

  /** Stream one element's text content (typing effect while streaming_mode is on). */
  async cardkitStreamElement(
    cardId: string,
    elementId: string,
    content: string,
    sequence: number,
  ): Promise<void> {
    let response
    try {
      response = await withTransientRetry(async () => {
        try {
          return await this.client.cardkit.v1.cardElement.content({
            data: { content, sequence },
            path: { card_id: cardId, element_id: elementId },
          })
        } catch (error: unknown) {
          throw asFeishuError('cardkit.v1.cardElement.content', error)
        }
      })
    } catch (error: unknown) {
      throw asFeishuError('cardkit.v1.cardElement.content', error)
    }
    this.assertOk(response, 'cardkit.v1.cardElement.content')
  }

  /** Full replace of a CardKit card (must follow close-streaming at the end). */
  async cardkitUpdate(cardId: string, card: unknown, sequence: number): Promise<void> {
    let response
    try {
      response = await withTransientRetry(async () => {
        try {
          return await this.client.cardkit.v1.card.update({
            data: { card: { type: 'card_json', data: JSON.stringify(card) }, sequence },
            path: { card_id: cardId },
          })
        } catch (error: unknown) {
          throw asFeishuError('cardkit.v1.card.update', error)
        }
      })
    } catch (error: unknown) {
      throw asFeishuError('cardkit.v1.card.update', error)
    }
    this.assertOk(response, 'cardkit.v1.card.update')
  }

  /** Turn streaming mode off (required before the final full update). */
  async cardkitCloseStreaming(cardId: string, sequence: number): Promise<void> {
    let response
    try {
      response = await withTransientRetry(async () => {
        try {
          return await this.client.cardkit.v1.card.settings({
            data: { settings: JSON.stringify({ streaming_mode: false }), sequence },
            path: { card_id: cardId },
          })
        } catch (error: unknown) {
          throw asFeishuError('cardkit.v1.card.settings', error)
        }
      })
    } catch (error: unknown) {
      throw asFeishuError('cardkit.v1.card.settings', error)
    }
    this.assertOk(response, 'cardkit.v1.card.settings')
  }

  /** Fetch and cache the bot's own open id (`bot/v3/info`). */
  private async resolveBotOpenId(): Promise<void> {    const response = await this.client.request<{
      code?: number
      msg?: string
      data?: { open_id?: string }
    }>({ method: 'GET', url: '/open-apis/bot/v3/info' })
    const code = response?.code ?? -1
    if (code !== 0) {
      throw new FeishuApiError('bot.v3.info', code, response?.msg ?? 'unknown error')
    }
    const openId = response.data?.open_id
    if (openId !== undefined && openId !== '') this.botOpenIdValue = openId
  }

  /** Create a message in a chat; assert the API succeeded. */
  private async createMessage(chatId: string, msgType: string, content: string) {
    let response
    try {
      response = await withTransientRetry(async () => {
        try {
          return await this.client.im.v1.message.create({
            data: { receive_id: chatId, msg_type: msgType, content },
            params: { receive_id_type: 'chat_id' },
          })
        } catch (error: unknown) {
          throw asFeishuError('im.v1.message.create', error)
        }
      })
    } catch (error: unknown) {
      throw asFeishuError('im.v1.message.create', error)
    }
    this.assertOk(response, 'im.v1.message.create')
    return response
  }

  private assertOk(
    response: { code?: number | undefined; msg?: string | undefined },
    operation: string,
  ): void {
    const code = response.code ?? -1
    if (code !== 0) {
      throw new FeishuApiError(operation, code, response.msg ?? 'unknown error')
    }
  }
}
