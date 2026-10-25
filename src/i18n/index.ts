import { en, type Texts } from './en.js';
import { ru } from './ru.js';

export type { Texts };

export const LANGUAGES = ['en', 'ru'] as const;
export type Language = (typeof LANGUAGES)[number];

export const isLanguage = (value: string): value is Language =>
  (LANGUAGES as readonly string[]).includes(value);

const TEXTS: Record<Language, Texts> = { en, ru };

/**
 * Texts of the bot's language. The language is one per process (LANGUAGE), so it is a
 * live binding set on start rather than a parameter of every formatter.
 */
export let t: Texts = en;

export const setLanguage = (language: Language) => {
  t = TEXTS[language];
};
