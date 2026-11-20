/**
 * printable.ts — text as a log line holds it, and as a page shows a stored value it must not let turn round (card 3012,
 * R8). Browser-safe: no server import, so a Svelte page can use it; logger.ts imports and re-exports both, so that the
 * class keeps one home and no server importer changes.
 */

/**
 * The characters `printable` replaces, as one class: the C0 range with the tab and every line break, DEL, the C1 range
 * (U+0085 is a line break to some viewers), U+2028 and U+2029; the bidi controls (U+202A to U+202E, U+2066 to U+2069),
 * which can make a line read in an order other than its own; U+200B to U+200F and U+FEFF, which show as nothing; and
 * every other format character Unicode names (`\p{Cf}`, card 2675's code review, S6): U+00AD, U+061C, U+180E, U+2060 to
 * U+2064, U+206A to U+206F, U+FFF9 to U+FFFB and the tag characters among them, each of which shows as nothing or turns
 * the text round. A decision's title may hold none of them (card 2675, decision 30), so that a mail's subject and heading
 * read as written. No `g` flag: `.test` keeps no state.
 */
export const UNPRINTABLE = /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff\p{Cf}]/u;

/** `UNPRINTABLE`, for every match in a text. */
const UNPRINTABLE_EVERYWHERE = new RegExp(UNPRINTABLE.source, 'gu');

/**
 * Text with each character of `UNPRINTABLE` as one space (card 2214). What is not text is made text first, so a caller
 * that passes `undefined` gets a line and not a throw.
 */
export function printable(text: string): string {
	return String(text).replace(UNPRINTABLE_EVERYWHERE, ' ');
}

/**
 * Text with every character outside printable ASCII (U+0020 to U+007E) shown as its code point, `\u{202E}`, so that an
 * address a restore may have taken from a file shows each look-alike, direction override or hidden character for what it
 * is (card 3012's code review, FP3). What is not text is made text first.
 */
export function asciiShown(text: string): string {
	return String(text).replace(/[^\x20-\x7e]/gu, (character) => `\\u{${character.codePointAt(0)!.toString(16).toUpperCase()}}`);
}
