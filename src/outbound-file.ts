/**
 * Outbound file return (Feature C, SPEC §6): registers a
 * `dsh_im_return_file` tool so the agent can send a workspace file back to
 * the Feishu chat. Soft-probed: when the host's tools registry is unavailable
 * the registration is skipped and the bridge reports the feature as
 * unavailable in /status.
 */
import { readFile } from 'node:fs/promises'

/** MIME mapping for common extensions (SPEC §6.3); unknown → octet-stream. */
const MIME_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  ['.csv', 'text/csv'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.json', 'application/json'],
  ['.md', 'text/markdown'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.rar', 'application/vnd.rar'],
  ['.txt', 'text/plain'],
  ['.webp', 'image/webp'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.xml', 'application/xml'],
  ['.zip', 'application/zip'],
])

export function mimeForFileName(fileName: string): string {
  return MIME_BY_EXTENSION.get(fileName.toLowerCase().match(/\.[^.]+$/)?.[0] ?? '') ??
    'application/octet-stream'
}

export const OUTBOUND_FILE_TOOL = 'dsh_im_return_file'

/** Structural subset of the dsh `tools` service (soft-probed at runtime). */
export interface ToolsRegistryLike {
  register(definition: {
    name: string
    description: string
    parameters?: unknown
    output: { schema: unknown; render: (args: { result: unknown }) => Array<{ type: string; text: string }> }
    execute: (args: Record<string, unknown>) => Promise<unknown>
    timeoutMs?: number
  }): { dispose?: () => void }
}

export interface OutboundFileSender {
  (chatId: string, data: Uint8Array, fileName: string): Promise<string>
}

/** Result of one registration attempt. */
export type OutboundFileRegistration =
  | { readonly status: 'registered'; readonly dispose?: () => void }
  | { readonly status: 'unavailable'; readonly reason: string }
  | { readonly status: 'disabled' }

/**
 * Register the tool on one agent's context. All failures map to
 * `unavailable` — the bridge keeps working without the feature.
 */
export function installOutboundFileTool(options: {
  readonly agentCtx: {
    get(key: string): unknown
  }
  /** Resolve the chat bound to the session the tool is running in. */
  readonly chatForCurrentSession: () => string | undefined
  readonly sendFile: OutboundFileSender
}): OutboundFileRegistration {
  let tools: ToolsRegistryLike | undefined
  try {
    tools = options.agentCtx.get('tools') as ToolsRegistryLike | undefined
  } catch (error: unknown) {
    return { status: 'unavailable', reason: `tools service probe failed: ${String(error)}` }
  }
  if (tools === undefined || typeof tools.register !== 'function') {
    return { status: 'unavailable', reason: 'tools registry unavailable on this host' }
  }
  try {
    const disposer = tools.register({
      name: OUTBOUND_FILE_TOOL,
      description:
        '把本机工作区里的一个文件发回当前飞书聊天（用户可直接下载）。返回发送结果；失败时返回原因。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '要发送的文件的绝对路径（或相对当前工作区的路径）' },
          caption: { type: 'string', description: '可选：随文件发给用户的说明文字' },
        },
        required: ['path'],
      },
      output: {
        schema: { type: 'object' },
        render: ({ result }) => [
          { type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) },
        ],
      },
      timeoutMs: 150_000,
      execute: async (args) => {
        const rawPath = typeof args.path === 'string' ? args.path.trim() : ''
        if (rawPath === '') return { ok: false, error: 'path 不能为空' }
        const fileName = rawPath.replaceAll('\\', '/').split('/').at(-1) ?? 'file'
        let data: Awaited<ReturnType<typeof readFile>>
        try {
          data = await readFile(rawPath)
        } catch (error: unknown) {
          const reason = (error as { code?: unknown }).code === 'ENOENT'
            ? '文件不存在'
            : (error as { code?: unknown }).code === 'EACCES'
              ? '没有读取权限'
              : String(error)
          return { ok: false, error: `无法读取 ${fileName}：${reason}` }
        }
        const chatId = options.chatForCurrentSession()
        if (chatId === undefined) return { ok: false, error: '当前会话没有绑定的飞书聊天（可能不是从飞书发起的回合）' }
        await options.sendFile(chatId, new Uint8Array(data), fileName)
        const caption = typeof args.caption === 'string' && args.caption.trim() !== ''
          ? args.caption.trim()
          : undefined
        return {
          ok: true,
          file: fileName,
          bytes: data.byteLength,
          message: `文件已发到飞书聊天${caption !== undefined ? `（附言：${caption}）` : ''}`,
        }
      },
    })
    return { status: 'registered', ...(disposer !== undefined ? { dispose: () => disposer.dispose?.() } : {}) }
  } catch (error: unknown) {
    return { status: 'unavailable', reason: `tool registration failed: ${String(error)}` }
  }
}
