import { isChainName, type ChainName } from '../chains.js';

/** How a chat wants its alerts; set with /settings */
export type ChatPrefs = {
  /** Chains the chat wants no alerts from */
  mutedChains: ChainName[];
  /** Incoming transfers worth less (in USD) are skipped; 0 reports everything */
  minIncomingUsd: number;
  /** Local hours [from, to) when alerts arrive without a sound; risky ones still ring */
  quiet: { from: number; to: number } | null;
  /** IANA time zone of the chat, for quiet hours and the digest */
  timeZone: string;
  /** Fake transfers and tokens without a price: shown with a warning, or hidden */
  spam: 'show' | 'hide';
  /**
   * `each`: a message per transaction. `digest`: incoming activity goes into a daily
   * summary; outgoing transfers, approvals and other risky things still come at once.
   */
  mode: 'each' | 'digest';
  /** Local hour of the daily digest */
  digestHour: number;
  /**
   * `hidden`: amounts, addresses and links of an alert go under a spoiler, so the chat
   * list and a glance at the screen show only which address did what
   */
  details: 'hidden' | 'shown';
};

export const DEFAULT_PREFS: ChatPrefs = {
  mutedChains: [],
  minIncomingUsd: 0,
  quiet: null,
  timeZone: 'Europe/Moscow',
  spam: 'show',
  mode: 'each',
  digestHour: 9,
  details: 'hidden',
};

export const THRESHOLDS = [0, 10, 100, 1000] as const;

/** Zones offered by /settings, west to east */
export const TIME_ZONES = [
  'America/Los_Angeles',
  'America/New_York',
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Kaliningrad',
  'Europe/Kyiv',
  'Europe/Moscow',
  'Asia/Tbilisi',
  'Europe/Samara',
  'Asia/Dubai',
  'Asia/Yekaterinburg',
  'Asia/Almaty',
  'Asia/Kolkata',
  'Asia/Novosibirsk',
  'Asia/Krasnoyarsk',
  'Asia/Bangkok',
  'Asia/Irkutsk',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Asia/Vladivostok',
] as const;
export const QUIET_PRESETS = [
  { from: 23, to: 8 },
  { from: 0, to: 9 },
] as const;

const hour = (value: unknown, fallback: number) =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) < 24
    ? (value as number)
    : fallback;

/** Reads prefs saved in chat settings, ignoring anything malformed */
export const readPrefs = (settings: Record<string, unknown>): ChatPrefs => {
  const raw = (settings.prefs ?? {}) as Partial<
    Record<keyof ChatPrefs, unknown>
  >;
  const quiet = raw.quiet as
    { from?: unknown; to?: unknown } | null | undefined;
  return {
    mutedChains: Array.isArray(raw.mutedChains)
      ? raw.mutedChains.filter((chain): chain is ChainName =>
          isChainName(String(chain)),
        )
      : DEFAULT_PREFS.mutedChains,
    minIncomingUsd:
      typeof raw.minIncomingUsd === 'number' && raw.minIncomingUsd >= 0
        ? raw.minIncomingUsd
        : DEFAULT_PREFS.minIncomingUsd,
    quiet:
      quiet && typeof quiet === 'object'
        ? { from: hour(quiet.from, 23), to: hour(quiet.to, 8) }
        : null,
    timeZone: (TIME_ZONES as readonly unknown[]).includes(raw.timeZone)
      ? (raw.timeZone as string)
      : DEFAULT_PREFS.timeZone,
    spam: raw.spam === 'hide' ? 'hide' : 'show',
    mode: raw.mode === 'digest' ? 'digest' : 'each',
    digestHour: hour(raw.digestHour, DEFAULT_PREFS.digestHour),
    details: raw.details === 'shown' ? 'shown' : DEFAULT_PREFS.details,
  };
};

const parts = (timeZone: string, ms: number) => {
  const values = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
  }).formatToParts(ms);
  const part = (type: string) =>
    values.find((value) => value.type === type)?.value ?? '';
  return {
    hour: Number(part('hour')),
    day: `${part('year')}-${part('month')}-${part('day')}`,
  };
};

/** The chat's local hour at `ms` */
export const localHour = (prefs: ChatPrefs, ms: number) =>
  parts(prefs.timeZone, ms).hour;

/** The chat's local calendar day at `ms`, e.g. 2026-10-25 */
export const localDay = (prefs: ChatPrefs, ms: number) =>
  parts(prefs.timeZone, ms).day;

export const isQuietTime = (prefs: ChatPrefs, ms: number) => {
  if (!prefs.quiet) return false;
  const { from, to } = prefs.quiet;
  const now = localHour(prefs, ms);
  return from < to ? now >= from && now < to : now >= from || now < to;
};

/** "Moscow, GMT+3" */
export const formatTimeZone = (timeZone: string, ms = Date.now()) => {
  const offset =
    new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
      .formatToParts(ms)
      .find((part) => part.type === 'timeZoneName')?.value ?? '';
  const city = timeZone.split('/').at(-1)!.replace(/_/g, ' ');
  return timeZone === 'UTC' ? 'UTC' : `${city}, ${offset}`;
};
