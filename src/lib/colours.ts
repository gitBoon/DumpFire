/**
 * colours.ts — what a colour from a request may be.
 *
 * A colour sent to the API is written into a `style` attribute on every page
 * that draws it, and the pages make a pale shade of one by appending two hex
 * digits to it (`{cat.color}20`). So the one form taken is `#rrggbb`: `#` and
 * six hex digits, in either case. `red;background:url(//x.io)` is not one, nor
 * is `#fff`, whose shade `#fff20` is no colour.
 *
 * It is here and not under `$lib/server` so that a page can ask it too (card
 * 2162; docs/authentication-security.md, "Colours From a Request"). The server reads
 * a colour with `readColour` in `$lib/server/request-body.ts`, which asks
 * this, and a card's cover with `readCover`, which asks `isCoverValue` below
 * (card 2010).
 */

const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

/** Is `value` a colour written `#rrggbb`? Text only: nothing else is a colour. */
export function isHexColour(value: unknown): value is string {
	return typeof value === 'string' && HEX_COLOUR.test(value);
}

// ─── Drawing a stored colour ─────────────────────────────────────────────────

/**
 * The grey a page draws in place of a stored colour that is no colour: the
 * one the reports already use for "Uncategorised".
 */
export const NEUTRAL_COLOUR = '#94a3b8';

const SAFE_HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const SAFE_WORD = /^[a-z]{1,30}$/i;
const SAFE_VAR = /^var\(--[a-z0-9-]+\)$/i;

/**
 * Can `value` be written into a `style` attribute as a colour and do nothing
 * else? A `#` and 3, 4, 6 or 8 hex digits; one word of letters, up to 30,
 * such as `red`; or `var(--name)`. None of them can end the declaration, call
 * any function but `var()` (so never `url()`), or leave the attribute.
 *
 * Wider than `isHexColour` on purpose: a colour stored before the rule, such
 * as `red` or `#fff`, still draws as it did (card 2162, decision 3). SQL 1 in
 * docs/deployment.md ("The Update That Brings the Content-Security-Policy")
 * is this test written in SQL, on the value trimmed as `drawnColour` trims
 * it, to list on production what will be drawn grey: change the two together.
 */
export function isSafeColour(value: unknown): value is string {
	return typeof value === 'string' && (SAFE_HEX.test(value) || SAFE_WORD.test(value) || SAFE_VAR.test(value));
}

/**
 * The colour a page draws for a stored value: nothing (`''`) for no value,
 * the value itself when it is a colour and nothing more (`isSafeColour`), and
 * `fallback` for anything else, so a stored `red;background:url(//x.io)` is
 * drawn grey and fetches nothing. The value is tested, and drawn, with its
 * leading and trailing spaces, tabs and line breaks trimmed, so an old
 * `#ef4444 ` still draws; one that is nothing but those is drawn grey.
 *
 * Every colour interpolated into a `style`, `fill` or `stroke` attribute of a
 * `.svelte` file goes through this, constants included, which
 * `tests/colours.test.ts` checks by reading the source.
 */
export function drawnColour(value: unknown, fallback: string = NEUTRAL_COLOUR): string {
	if (value === null || value === undefined || value === '') return '';
	const trimmed = typeof value === 'string' ? value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '') : value;
	return isSafeColour(trimmed) ? trimmed : fallback;
}

// ─── Card covers ─────────────────────────────────────────────────────────────

/**
 * The eight gradients the card window offers as a cover, each exactly as it
 * is stored. A cover is drawn as a `background`, so a gradient is taken only
 * if it is one of these, word for word (card 2010).
 */
const COVER_GRADIENTS = [
	'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
	'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
	'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
	'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
	'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
	'linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)',
	'linear-gradient(135deg, #fccb90 0%, #d57eeb 100%)',
	'linear-gradient(135deg, #e0c3fc 0%, #8ec5fc 100%)'
] as const;

/** The covers the card window offers: the eight gradients, then eight colours. */
export const COVER_PRESETS: readonly string[] = [
	...COVER_GRADIENTS,
	'#6366f1', '#ef4444', '#f59e0b', '#10b981', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'
];

/**
 * Is `value` a card cover: a colour written `#rrggbb`, or one of the eight
 * gradients exactly? `cover_url` holds a colour, not an address, and it is
 * written into a `style` attribute for every viewer of the board, so nothing
 * else is a cover: not `url(...)`, not a gradient of the writer's own. No
 * cover (`null`, empty text) is not a value; the server's reader
 * (`readCover` in `$lib/server/request-body.ts`) reads that as null. A page
 * asks this before it draws a cover, so a value stored before the rule is
 * kept and not drawn.
 */
export function isCoverValue(value: unknown): value is string {
	return isHexColour(value) || (typeof value === 'string' && (COVER_GRADIENTS as readonly string[]).includes(value));
}

/** Where the card window's custom cover colour opens when the card has no cover of a colour: the first colour preset. */
export const COVER_PICKER_DEFAULT = '#6366f1';

/**
 * The colour the card window's custom cover box opens on: the cover's own
 * colour, the first colour of one of the gradients, or the default.
 *
 * A colour box takes only `#rrggbb`, and shows black for anything else. It
 * was handed the cover as it is, so a gradient cover opened it on black
 * (card 2280, slice B5b; card 2010's found nearby).
 */
export function coverPickerColour(cover: string | null | undefined): string {
	if (isHexColour(cover)) return cover;
	if (isCoverValue(cover)) return /#[0-9a-fA-F]{6}/.exec(cover)?.[0] ?? COVER_PICKER_DEFAULT;
	return COVER_PICKER_DEFAULT;
}
