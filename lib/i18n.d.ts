/**
 * Card copy in zh/en. Cards pick one language at build time (the bridge's
 * configured locale, default zh); the same labels hermes-lark-streaming
 * renders bilingually via i18n_content are provided in both languages here.
 *
 * @module dsh-tui-feishu/i18n
 */
/** Supported card locales. */
export type CardLocale = 'zh' | 'en';
/** One copy key: { zh, en }. */
export type Copy = Record<CardLocale, string>;
export declare const COPY: Record<string, Copy>;
/** Pick one language's copy for a key. */
export declare function t(key: string, locale: CardLocale): string;
