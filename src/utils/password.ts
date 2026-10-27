import crypto from 'crypto';

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; // no look-alikes (I, l, O, 0 ...)
const DIGITS = '23456789';
const SYMBOLS = '@#$%&*?';

const pick = (chars: string) => chars[crypto.randomInt(chars.length)];

/**
 * A random one-time password for accounts that an owner creates for someone else.
 * 14 characters, always containing a letter and a digit, drawn from a cryptographic source.
 */
export function generateTemporaryPassword(length = 14): string {
  const chars = [pick(LETTERS), pick(LETTERS.toUpperCase()), pick(DIGITS), pick(SYMBOLS)];
  const all = LETTERS + DIGITS + SYMBOLS;
  while (chars.length < length) chars.push(pick(all));
  // Fisher-Yates so the guaranteed characters are not always first
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
