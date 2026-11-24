/**
 * Text the standard PDF fonts can draw (card 2688, R11): `pdfSafe` in
 * `src/lib/server/pdf-text.ts`. The case is the plan's,
 * `docs/planning/card-2688-decision-pdf-export.md`, section 9, T1: one case
 * over its five branches. The note a decision's PDF ends with where any
 * character was drawn as "?" is tests/decision-export.test.ts's T2.
 */
import { describe, expect, it } from 'vitest';
import { pdfSafe } from '$lib/server/pdf-text';

describe('pdfSafe', () => {
	it.each([
		// 1. WinAnsi kept as it is: Latin-1 letters, the euro, the curly quote and the dash of the 0x80 row.
		{ branch: 'kept', text: 'Café — €5 ’n’ Œuvre Šik', shown: 'Café — €5 ’n’ Œuvre Šik', replaced: false },
		// 2. Folded to the base letter where it decomposes to one: Romanian, Hungarian, Czech.
		{ branch: 'folded by NFD', text: 'Brașov ăla Győr Čapek', shown: 'Brasov ala Gyor Capek', replaced: false },
		// 3. Folded from the table where it does not decompose: Polish, Croatian, Turkish.
		{ branch: 'folded by the table', text: 'Łódź łaska Đurđa ılık', shown: 'Lódz laska Durda ilik', replaced: false },
		// 4. Anything else drawn as "?", one for each character (an emoji is one): Cyrillic, CJK, an emoji.
		{ branch: 'replaced', text: 'Иван 张伟 ok 🎉', shown: '???? ?? ok ?', replaced: true },
		// 5. Control and format characters dropped (C0, C1, bidi, zero-width, soft hyphen); tab and line breaks kept, CR LF as one.
		{ branch: 'dropped', text: 'a\u0007b\u0085c\u202Ed\u2066e\u200Bf\u00ADg\th\r\ni\rj\u2028k', shown: 'abcdefg\th\ni\nj\nk', replaced: false }
	])('draws $branch characters as the standard fonts can, and says whether any became "?" (T1)', ({ text, shown, replaced }) => {
		expect(pdfSafe(text)).toEqual({ text: shown, replaced });
	});
});
