/**
 * Look-alikes used by address poisoning: token symbols that imitate a popular ticker with
 * letters of other scripts and invisible characters, and addresses that share the
 * beginning and the end of one the owner knows, which is all a wallet shows.
 */

/** Tickers worth imitating: what people hold and send */
const TICKERS = new Set([
  'USDC',
  'USDT',
  'DAI',
  'ETH',
  'WETH',
  'STETH',
  'WSTETH',
  'WBTC',
  'PYUSD',
  'USDE',
  'EURC',
]);

/** Letters of other scripts that look like Latin ones; enough for tickers */
const CONFUSABLES: Record<string, string> = {
  // Cyrillic
  А: 'A',
  В: 'B',
  Е: 'E',
  К: 'K',
  М: 'M',
  Н: 'H',
  О: 'O',
  Р: 'P',
  С: 'C',
  Т: 'T',
  Х: 'X',
  У: 'Y',
  Ѕ: 'S',
  І: 'I',
  Ј: 'J',
  Ԁ: 'D',
  Ԛ: 'Q',
  Ԝ: 'W',
  // Greek
  Α: 'A',
  Β: 'B',
  Ε: 'E',
  Ζ: 'Z',
  Η: 'H',
  Ι: 'I',
  Κ: 'K',
  Μ: 'M',
  Ν: 'N',
  Ο: 'O',
  Ρ: 'P',
  Τ: 'T',
  Υ: 'Y',
  Χ: 'X',
  // Lisu, a favourite of fake USDC
  ꓐ: 'B',
  ꓑ: 'P',
  ꓒ: 'D',
  ꓓ: 'D',
  ꓔ: 'T',
  ꓖ: 'G',
  ꓗ: 'K',
  ꓙ: 'J',
  ꓚ: 'C',
  ꓛ: 'C',
  ꓜ: 'Z',
  ꓝ: 'F',
  ꓞ: 'F',
  ꓟ: 'M',
  ꓠ: 'N',
  ꓡ: 'L',
  ꓢ: 'S',
  ꓣ: 'R',
  ꓤ: 'R',
  ꓥ: 'V',
  ꓦ: 'V',
  ꓧ: 'H',
  ꓨ: 'U',
  ꓩ: 'Z',
  ꓪ: 'W',
  ꓫ: 'X',
  ꓬ: 'Y',
  ꓭ: 'A',
  ꓮ: 'A',
  ꓯ: 'E',
  ꓰ: 'E',
  ꓱ: 'E',
  ꓲ: 'I',
  ꓳ: 'O',
  ꓴ: 'U',
};

/** Invisible and formatting characters (zero width, word joiners, bidi controls) */
const INVISIBLE = /[\p{Cf}\p{Zs}]/gu;

/**
 * The ticker a symbol imitates, e.g. "U⁯S⁯Dꓚ" or "ÚЅDС" for USDC; null for an honest
 * symbol, including the real "USDC" itself
 */
export const imitatedTicker = (symbol: string): string | null => {
  const folded = Array.from(
    symbol.replace(INVISIBLE, '').normalize('NFKD').replace(/\p{M}/gu, ''),
  )
    .map((char) => CONFUSABLES[char] ?? char)
    .join('')
    .toUpperCase();
  return TICKERS.has(folded) && folded !== symbol.toUpperCase() ? folded : null;
};

/** How many characters a wallet shows at each end of an address */
const SHOWN = 4;

/**
 * Whether two different addresses look the same in a wallet: equal first and last hex
 * characters, the way poisoners grind them
 */
export const looksLike = (a: string, b: string) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return (
    x !== y &&
    x.slice(2, 2 + SHOWN) === y.slice(2, 2 + SHOWN) &&
    x.slice(-SHOWN) === y.slice(-SHOWN)
  );
};
