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
 * The rule (card 2207). A mention starts at an `@` that begins the text or
 * follows anything but a letter, a digit or `_` (of any language), so
 * `bob@example.com` holds none. Its name is the longest username the text
 * after the `@` begins with, case ignored, and it must end a word: not be
 * followed by a letter, a digit or `_`, nor by `.` or `-` and then one of
 * those. So `@jane.doe` is `jane.doe` where that account exists and nobody
 * where it does not, never `jane`, while `@jane.` and `@jane's` are `jane`.
 * Where two usernames differ only in case, the one typed exactly is the name,
 * and neither when it is typed in neither spelling: a mention never guesses.
 * A username may hold a space or any other mark, and every one can be
 * mentioned as it is spelt.
 *
 * Who gives the usernames. The server matches against every account's
 * username and then mails only those who can open the board (card 2198): were
 * it to match against the board's people alone, `@Jane Doe`, written for
 * someone off the board, would be cut to `jane` on it. Every username is
 * already listed to every signed-in user. The card window chips the names of
 * the card's own board's people (`boardUsers`: its owner, members, the members
 * of teams it is shared with, and administrators), from the board page, the
 * plan, All Tasks and All To Do alike; the last two gave every account until
 * the review of card 2198, and now read them with the card's context. So the
 * two differ only in the safe direction: someone named on a public board who
 * is not one of them is mailed and not chipped.
 *
 * What it costs. The server finds mentions inside the comment's write
 * transaction, and the page on every text node it draws, so the usernames are
 * grouped once per call by their first character, an `@` that cannot start a
 * name (at the end, or before a space or another `@`) is passed over, and no
 * more than the first 200 `@` that could are looked up (review of card 2207:
 * 50,000 `@` against 1,000 accounts had taken about 713 ms).
 *
 * The server reads the stored text, the renderer the text of the HTML drawn,
 * so the two agree for text written as text. They differ for text written as
 * HTML: a mention in an HTML comment, an attribute or a link's address is
 * mailed but not chipped, and one written with an entity (`&#64;name`) is
 * chipped but not mailed.
 */

/** One mention: where it is in the text, and the account's username as it is stored. */
export type Mention = { start: number; end: number; username: string };

/** A letter, a digit or `_`, of any language; a combining mark goes with its letter. */
const WORD = /[\p{L}\p{M}\p{N}_]/u;

const isWord = (ch: string | undefined) => ch !== undefined && WORD.test(ch);

/** Does a name that ends at `end` end a word? */
function endsWord(text: string, end: number): boolean {
	const next = text[end];
	if (isWord(next)) return false;
	return !((next === '.' || next === '-') && isWord(text[end + 1]));
}

/**
 * No more than this many `@` in one text are looked up (review of card 2207):
 * the server finds mentions inside the comment's write transaction, so one
 * long comment must not hold every other write up. A mention after them is
 * neither mailed nor chipped.
 */
const MOST_LOOKED_UP = 200;

/**
 * The usernames of one length that begin with one character: each name lower-
 * cased, with every account that spells it so (two where they differ only in
 * case).
 */
type SameLength = { length: number; byLower: Map<string, string[]> };

/** The first character of `s` from `at`, lower-cased: a whole code point, so a pair of surrogates stays one. */
const firstLower = (s: string, at: number) => String.fromCodePoint(s.codePointAt(at)!).toLowerCase()[0];

/**
 * The usernames grouped by their first character lower-cased, each group's
 * lengths longest first, so an `@` is checked against the names that could
 * follow it, one look-up per length, rather than against every account.
 */
function lookup(usernames: readonly string[]): Map<string, SameLength[]> {
	const groups = new Map<string, SameLength[]>();
	for (const name of usernames) {
		if (name.length === 0) continue;
		const key = firstLower(name, 0);
		let group = groups.get(key);
		if (!group) groups.set(key, (group = []));
		let same = group.find((g) => g.length === name.length);
		if (!same) group.push((same = { length: name.length, byLower: new Map() }));
		const lower = name.toLowerCase();
		same.byLower.set(lower, [...(same.byLower.get(lower) ?? []), name]);
	}
	for (const group of groups.values()) group.sort((a, b) => b.length - a.length);
	return groups;
}

/**
 * Every mention in `text`, in order, of the accounts named in `usernames`.
 * `start` is at the `@`, `end` just after the name, so the text between them
 * is the mention as written; `username` is the account's name as given.
 * Only the first 200 `@` that could start a name are looked up.
 */
export function findMentions(text: string, usernames: readonly string[]): Mention[] {
	const found: Mention[] = [];
	let at = text.indexOf('@');
	if (at === -1) return found;
	const groups = lookup(usernames);
	let lookedUp = 0;
	while (at !== -1 && lookedUp < MOST_LOOKED_UP) {
		const next = text[at + 1];
		// An `@` at the end, or before another `@` or a space, starts no name
		// (usernames are trimmed), so it costs no look-up.
		const couldStart = next !== undefined && next !== '@' && !/\s/u.test(next) && (at === 0 || !isWord(text[at - 1]));
		const mention = couldStart ? mentionAt(text, at, groups) : null;
		if (couldStart) lookedUp++;
		if (mention) found.push(mention);
		at = text.indexOf('@', mention ? mention.end : at + 1);
	}
	return found;
}

/** The mention whose `@` is at `at`, if the text after it names one account. */
function mentionAt(text: string, at: number, groups: Map<string, SameLength[]>): Mention | null {
	const from = at + 1;
	// The longest name the text after the `@` begins with, case ignored.
	for (const { length, byLower } of groups.get(firstLower(text, from)) ?? []) {
		if (from + length > text.length) continue;
		const typed = text.slice(from, from + length);
		const candidates = byLower.get(typed.toLowerCase());
		if (!candidates) continue;
		// Two names that differ only in case: the one typed exactly, or neither.
		const chosen = candidates.length === 1 ? candidates[0] : candidates.find((name) => name === typed);
		if (!chosen) return null;
		const end = from + length;
		return endsWord(text, end) ? { start: at, end, username: chosen } : null;
	}
	return null;
}
