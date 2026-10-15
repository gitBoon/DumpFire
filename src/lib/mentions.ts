/**
 * mentions.ts — where an @mention is in a text, for the page and the server alike.
 *
 * The one place the mention rule lives (cards 2210 and 2207; see
 * docs/authentication-security.md, "Markdown in Descriptions and Comments").
 * The server's `parseMentions` (`$lib/server/mentions.ts`) reads it to decide
 * who is mailed, and the card window's Markdown renderer (`$lib/markdown.ts`)
 * reads it to decide what to draw as a chip, so a chip shows who was told.
 * It imports nothing, so a page can load it.
 *
 * The server reads it over the stored text, the renderer over the text of
 * the HTML drawn, so the two agree for text written as text. Until card 2207
 * they differ for text written as HTML: a mention in an HTML comment, an
 * attribute or a link's address is mailed but not chipped, and one written
 * with an entity (`&#64;name`) is chipped but not mailed.
 */

/** One mention: where it is in the text, and the name after the `@`, as written. */
export type Mention = { start: number; end: number; username: string };

/**
 * Every mention in `text`, in order. The rule is `@` and then letters, digits
 * or `_`. `usernames` is the list of names that may be mentioned; it is not
 * read yet (card 2207 replaces the rule and uses it), so callers that have the
 * list pass it already.
 */
export function findMentions(text: string, usernames?: readonly string[]): Mention[] {
	void usernames;
	const found: Mention[] = [];
	for (const m of text.matchAll(/@(\w+)/g)) {
		found.push({ start: m.index, end: m.index + m[0].length, username: m[1] });
	}
	return found;
}
