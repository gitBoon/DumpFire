/**
 * escape-html.ts — the one function that makes text safe to put into HTML.
 *
 * Pages and the server both import it from here: the `/docs` page draws the
 * OpenAPI document's text through it (`docs-format.ts`), and every mail the
 * server sends puts the text it carries through it.
 *
 * The rule for a mail (card 2149): every text put into a mail's HTML is passed
 * through `escapeHtml` where it is put, a link in `href` included. A board's
 * name, a card's title, a username, a schedule's name and the error another
 * server answered are all somebody's typing, and a report can be mailed to any
 * address, so without it anyone with an account could have the server's own
 * sender deliver HTML of their choosing: a link, or a "sign in again" button.
 * Left bare are only a number, a value taken from a fixed table in the same
 * function (a colour), and a piece of HTML built in the same function from
 * values already escaped. A subject is not escaped: it is plain text, not
 * HTML, and its reader would see `&lt;`.
 */

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with the five characters HTML reads as markup written as entities. */
export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (character) => ENTITIES[character]);
}
