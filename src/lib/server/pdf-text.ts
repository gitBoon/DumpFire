/**
 * pdf-text.ts — text the standard PDF fonts can draw (card 2688, R11).
 *
 * Every PDF DumpFire makes draws in Helvetica, one of the fourteen standard
 * fonts, which `pdfkit` encodes as WinAnsi: printable ASCII, the Latin-1
 * letters and signs (U+00A0 to U+00FF), and the 27 characters of the Windows
 * code page's 0x80 to 0x9F row (the euro, curly quotes, dashes, Œ, Š, Ž…).
 * Any other character is written as its own code, more than one byte, and
 * comes out wrong on the page (`node_modules/pdfkit/js/pdfkit.js`,
 * `encodeText`). A font of the document's own would draw them, but the image
 * holds none, a CJK font is many megabytes, and tests/helpers/pdf.ts reads the
 * standard fonts' text alone (card 2688, row 11).
 *
 * So `pdfSafe` makes text drawable, and says when it had to give something up:
 *
 *   1. NFC, so a letter written as a base and a mark is one character;
 *   2. tab and line breaks kept (CR LF, CR, U+2028 and U+2029 as one line
 *      break); every other control character and every format character
 *      (`\p{Cc}`, `\p{Cf}`, the bidi controls and zero-width characters among
 *      them) dropped, as each shows as nothing or turns the text round;
 *   3. a WinAnsi character kept as it is;
 *   4. one outside it folded to its base letter where it decomposes to one
 *      (ă, ș, ő, č to a, s, o, c), or from a short table where it does not
 *      (Ł ł Đ đ ı to L l D d i);
 *   5. anything else drawn as "?", and `replaced` true, so that the document
 *      can say once that some characters could not be shown.
 *
 * `oneLine` then makes a value drawn as a line of the document's own one line.
 *
 * A plain module: no row, no caller. Card 2688's decision PDF puts every
 * string it draws through it; the board reports and the plan PDF do not yet
 * (card 2688, F1).
 */

/** The characters of the Windows code page's 0x80 to 0x9F row, which WinAnsi draws, by code point. */
const WIN_ANSI_EXTRA = new Set([
	0x0152, 0x0153, 0x0160, 0x0161, 0x0178, 0x017d, 0x017e, 0x0192, 0x02c6, 0x02dc, 0x2013, 0x2014, 0x2018, 0x2019, 0x201a,
	0x201c, 0x201d, 0x201e, 0x2020, 0x2021, 0x2022, 0x2026, 0x2030, 0x2039, 0x203a, 0x20ac, 0x2122
]);

/** Letters that do not decompose to a base letter, and the letter each is drawn as (R11). */
const FOLDED: Readonly<Record<string, string>> = { 'Ł': 'L', 'ł': 'l', 'Đ': 'D', 'đ': 'd', 'ı': 'i' };

/** A control or format character, which is dropped (tab and line breaks are taken care of first). */
const DROPPED = /[\p{Cc}\p{Cf}]/u;

/** A combining mark, taken off a decomposed letter. */
const MARKS = /\p{M}/gu;

/** Whether the standard fonts draw `code` as itself. */
function drawable(code: number): boolean {
	return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.has(code);
}

/**
 * `text` as the standard fonts can draw it (R11), and whether any character
 * had to be drawn as "?". Folding a letter to its base, and dropping a
 * control or format character, are not counted as replacing one.
 */
export function pdfSafe(text: string): { text: string; replaced: boolean } {
	let replaced = false;
	let out = '';
	const normal = String(text).normalize('NFC').replace(/\r\n?|[\u2028\u2029]/g, '\n');
	for (const char of normal) {
		const code = char.codePointAt(0)!;
		if (char === '\t' || char === '\n') {
			out += char;
		} else if (DROPPED.test(char)) {
			continue;
		} else if (drawable(code)) {
			out += char;
		} else if (Object.hasOwn(FOLDED, char)) {
			out += FOLDED[char];
		} else {
			const base = char.normalize('NFD').replace(MARKS, '');
			if (base.length > 0 && [...base].every((part) => drawable(part.codePointAt(0)!))) {
				out += base;
			} else {
				out += '?';
				replaced = true;
			}
		}
	}
	return { text: out, replaced };
}

/**
 * Text `pdfSafe` has made, as one line (card 2688's code review, S-L1): each
 * run of line breaks and tabs one space. For every value a PDF draws as a line,
 * heading or label of its own (a board's name, a person's or a group's, a
 * quoted block's label), so that a value written over several lines cannot
 * draw what reads as a line of the document. A person's own words, drawn in
 * their quoted block, keep their line breaks. `pdfSafe` has already made every
 * line break `\n`.
 */
export function oneLine(text: string): string {
	return text.replace(/[\n\t]+/g, ' ');
}
