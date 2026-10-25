import { hexToBytes, type Hex } from 'viem';

const MIN_BYTES = 4;
const MAX_BYTES = 8192;

const utf8 = new TextDecoder('utf-8', { fatal: true });

// Machine-generated payloads that happen to be readable text
const SPAM_PATTERNS: RegExp[] = [
  /^data:/i, // ethscriptions
  /^\s*[{[]/, // JSON: inscriptions, mint operations
  /['"]op['"]\s*:\s*['"]mint['"]/i,
  /^[^\s:]{1,12}:[A-Z0-9-]+\.[A-Z0-9-]+/i, // cross-chain swap memos: =:ETH.ETH:…, SWAP:BTC.BTC:…
  /BFX_REFILL_SWEEP/,
  /^[\w-]+\.(eth|tree)$/i, // bare names
];

// Control characters other than tab and line breaks
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** Heuristics for text a person wrote, replacing the dictionary lookup of the old bot */
export const isMeaningfulText = (text: string) => {
  if (text.length < 2) return false;
  if (SPAM_PATTERNS.some((pattern) => pattern.test(text))) return false;

  const visible = text.replace(/\s/g, '');
  const letters = visible.match(/\p{L}/gu)?.length ?? 0;
  if (letters / visible.length < 0.6) return false;

  // A single long token without spaces is an id, a hash or base64, not a message
  if (!/\s/.test(text.trim()) && text.length > 24) return false;

  const words = text.match(/\p{L}{2,}/gu) ?? [];
  if (words.length >= 2) return true;
  return (words[0]?.length ?? 0) >= 4;
};

/** The UTF-8 text in transaction input, or null when the input is calldata or noise */
export const decodeMessage = (input: Hex): string | null => {
  if (input.length < 2 + MIN_BYTES * 2 || input.length % 2 !== 0) return null;
  const bytes = hexToBytes(input);
  if (bytes.length > MAX_BYTES) return null;

  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return null;
  }
  // Some wallets pad the message with zero bytes
  text = text.replace(/\0+$/, '').trim();
  if (!text || CONTROL.test(text) || text.includes('�')) return null;
  return isMeaningfulText(text) ? text : null;
};
