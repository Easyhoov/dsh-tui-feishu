export declare function mimeForFileName(fileName: string): string;
export declare const OUTBOUND_FILE_TOOL = "dsh_im_return_file";
/** Structural subset of the dsh `tools` service (soft-probed at runtime). */
export interface ToolsRegistryLike {
    register(definition: {
        name: string;
        description: string;
        parameters?: unknown;
        output: {
            schema: unknown;
            render: (args: {
                result: unknown;
            }) => Array<{
                type: string;
                text: string;
            }>;
        };
        execute: (args: Record<string, unknown>) => Promise<unknown>;
        timeoutMs?: number;
    }): {
        dispose?: () => void;
    };
}
export interface OutboundFileSender {
    (chatId: string, data: Uint8Array, fileName: string): Promise<string>;
}
/** Result of one registration attempt. */
export type OutboundFileRegistration = {
    readonly status: 'registered';
    readonly dispose?: () => void;
} | {
    readonly status: 'unavailable';
    readonly reason: string;
} | {
    readonly status: 'disabled';
};
/**
 * Register the tool on one agent's context. All failures map to
 * `unavailable` — the bridge keeps working without the feature.
 */
export declare function installOutboundFileTool(options: {
    readonly agentCtx: {
        get(key: string): unknown;
    };
    /** Resolve the chat bound to the session the tool is running in. */
    readonly chatForCurrentSession: () => string | undefined;
    readonly sendFile: OutboundFileSender;
}): OutboundFileRegistration;
