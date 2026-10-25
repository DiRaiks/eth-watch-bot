import { AsyncLocalStorage } from 'node:async_hooks';

import { en, type Texts } from './en.js';
import { ru } from './ru.js';

export type { Texts };

export const LANGUAGES = ['en', 'ru'] as const;
export type Language = (typeof LANGUAGES)[number];

export const isLanguage = (value: string): value is Language =>
  (LANGUAGES as readonly string[]).includes(value);

const TEXTS: Record<Language, Texts> = { en, ru };

let fallback: Language = 'en';
const current = new AsyncLocalStorage<Language>();

/** The language texts are in right now */
export const currentLanguage = (): Language => current.getStore() ?? fallback;

/** Each language under its own name, so it can be found by someone who reads only it */
export const LANGUAGE_NAMES: Record<Language, string> = {
  en: '🇬🇧 English',
  ru: '🇷🇺 Русский',
};

/**
 * Texts of the chat being served: its own language inside `withLanguage`, the bot's
 * default (LANGUAGE) elsewhere. A proxy, so formatters keep reading `t.something`
 * instead of taking the language as a parameter.
 */
export const t: Texts = new Proxy({} as Texts, {
  get: (_target, key) => TEXTS[currentLanguage()][key as keyof Texts],
});

/** The bot's default language, from LANGUAGE */
export const setLanguage = (language: Language) => {
  fallback = language;
};

/** Runs `fn`, including what it awaits, in the language; the default when undefined */
export const withLanguage = <T>(language: Language | undefined, fn: () => T) =>
  language ? current.run(language, fn) : fn();

/** A Telegram client's `language_code` as one of the bot's languages, if it has it */
export const languageOf = (code: string | undefined): Language | undefined => {
  const base = code?.toLowerCase().split('-')[0];
  return base && isLanguage(base) ? base : undefined;
};
