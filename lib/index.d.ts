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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Stable cordis plugin name (also the bundle row id in cordis.patch.yml). */
export declare const name = "dsh-tui-feishu";
/** Plugin configuration. */
export interface Config {
    /** Feishu app id; falls back to `FEISHU_APP_ID` or stored pairing credentials. */
    readonly appId?: string;
    /** Feishu app secret; falls back to `FEISHU_APP_SECRET` or stored pairing credentials. */
    readonly appSecret?: string;
    /** Working directory for bridge-created sessions (default: the process cwd). */
    readonly defaultCwd?: string;
    /** Directory for durable bridge state; default `$DSH_HOME/dsh-tui-feishu`. */
    readonly dataDir?: string;
    /** Provider route for bridge-created agents (default: the host default). */
    readonly provider?: string;
    /** Model for bridge-created agents (default: the provider default). */
    readonly model?: string;
    /** Streaming-card patch throttle in ms (default 500). */
    readonly cardThrottleMs?: number;
    /** Retire a streaming card after this many ms without patch activity (default 900000 = 15min). */
    readonly cardTtlMs?: number;
    /** Allowed Feishu sender open ids; empty serves every p2p sender. */
    readonly allowedUsers?: string[];
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config?: Config): void;
