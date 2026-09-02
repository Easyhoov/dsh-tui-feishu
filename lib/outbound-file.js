/**
 * Outbound file return (Feature C, SPEC §6): registers a
 * `dsh_im_return_file` tool so the agent can send a workspace file back to
 * the Feishu chat. Soft-probed: when the host's tools registry is unavailable
 * the registration is skipped and the bridge reports the feature as
 * unavailable in /status.
 */
import { readFile, stat } from 'node:fs/promises';
export const OUTBOUND_FILE_TOOL = 'dsh_im_return_file';
/** Platform upload cap (im.v1.file.create); enforced BEFORE reading the file. */
const MAX_OUTBOUND_BYTES = 30 * 1024 * 1024;
/**
 * Register the tool on one agent's context. All failures map to
 * `unavailable` — the bridge keeps working without the feature.
 */
export function installOutboundFileTool(options) {
    let tools;
    try {
        tools = options.agentCtx.get('tools');
    }
    catch (error) {
        return { status: 'unavailable', reason: `tools service probe failed: ${String(error)}` };
    }
    if (tools === undefined || typeof tools.register !== 'function') {
        return { status: 'unavailable', reason: 'tools registry unavailable on this host' };
    }
    try {
        const disposer = tools.register({
            name: OUTBOUND_FILE_TOOL,
            description: '把本机工作区里的一个文件发回当前飞书聊天（用户可直接下载）。返回发送结果；失败时返回原因。',
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
                const rawPath = typeof args.path === 'string' ? args.path.trim() : '';
                if (rawPath === '')
                    return { ok: false, error: 'path 不能为空' };
                const fileName = rawPath.replaceAll('\\', '/').split('/').at(-1) ?? 'file';
                // SPEC §6.3 pre-flight: exists, is a plain file, non-empty, ≤30 MB —
                // all BEFORE readFile, so a 2 GB path is rejected without being read
                // into memory and a directory never surfaces as a raw EISDIR error.
                let info;
                try {
                    info = await stat(rawPath);
                }
                catch (error) {
                    const reason = error.code === 'ENOENT'
                        ? '文件不存在'
                        : error.code === 'EACCES'
                            ? '没有读取权限'
                            : String(error);
                    return { ok: false, error: `无法读取 ${fileName}：${reason}` };
                }
                if (!info.isFile())
                    return { ok: false, error: `${fileName} 不是普通文件（目录/设备无法发送）` };
                if (info.size === 0)
                    return { ok: false, error: `${fileName} 是空文件` };
                if (info.size > MAX_OUTBOUND_BYTES) {
                    return { ok: false, error: `${fileName} 超过 30MB 上限（${info.size} 字节）` };
                }
                let data;
                try {
                    data = await readFile(rawPath);
                }
                catch (error) {
                    const reason = error.code === 'ENOENT'
                        ? '文件不存在'
                        : error.code === 'EACCES'
                            ? '没有读取权限'
                            : String(error);
                    return { ok: false, error: `无法读取 ${fileName}：${reason}` };
                }
                const chatId = options.chatForCurrentSession();
                if (chatId === undefined)
                    return { ok: false, error: '当前会话没有绑定的飞书聊天（可能不是从飞书发起的回合）' };
                // SPEC §6.3: upload failures surface as a soft, agent-translatable
                // error — never an exception out of `execute`.
                let messageId;
                try {
                    messageId = await options.sendFile(chatId, new Uint8Array(data), fileName);
                }
                catch (error) {
                    return { ok: false, error: `发送 ${fileName} 失败：${String(error)}` };
                }
                const caption = typeof args.caption === 'string' && args.caption.trim() !== ''
                    ? args.caption.trim()
                    : undefined;
                return {
                    ok: true,
                    file: fileName,
                    bytes: data.byteLength,
                    ...(messageId !== '' ? { messageId } : {}),
                    message: `文件已发到飞书聊天${caption !== undefined ? `（附言：${caption}）` : ''}`,
                };
            },
        });
        return { status: 'registered', ...(disposer !== undefined ? { dispose: () => disposer.dispose?.() } : {}) };
    }
    catch (error) {
        return { status: 'unavailable', reason: `tool registration failed: ${String(error)}` };
    }
}
