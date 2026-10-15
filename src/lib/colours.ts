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
 * 2162's plan, `docs/planning/card-2162-colours-and-csp.md`). The server reads
 * a colour with `readColour` in `$lib/server/request-body.ts`, which asks
 * this, and a card's cover with `readCover`, which asks `isCoverValue` below
 * (card 2010).
 */

const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

/** Is `value` a colour written `#rrggbb`? Text only: nothing else is a colour. */
export function isHexColour(value: unknown): value is string {
	return typeof value === 'string' && HEX_COLOUR.test(value);
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
