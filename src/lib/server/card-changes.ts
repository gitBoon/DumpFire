/**
 * card-changes.ts — which of the fields a card update sends are changes
 * (card 2183).
 *
 * Both card update handlers wrote every field the body named, whether or not
 * it changed. The card window sends a card's whole state back on every save,
 * so a save that changed nothing still wrote the row, moved `updated_at`,
 * recorded "Updated fields: title, description, priority, colorTag,
 * categoryId, dueDate, summary, theme, customerImpact, closeReason,
 * releaseState", sent `card.updated` to every webhook of the board, and put
 * the card in the activity report as touched by whoever pressed Save. The
 * same went for every API call that repeated a value the card held.
 *
 * The comparison is made here, on the server, so that no caller has to send
 * only what it changed. Each handler asks it of the fields as they will be
 * written (after every reader and after `normaliseReportingFields`), against
 * the card as it stands at that point in its transaction: after a move, the
 * moved row.
 */

/**
 * Whether a value sent is the value stored: `===`, or both empty, where empty
 * is null or `''`. A nullable text column holds either for "nothing", and a
 * page may send either. Nothing else is coerced: a number sent as text is
 * compared as text (the readers have made it a number by now).
 */
export function sameValue(stored: unknown, sent: unknown): boolean {
	if (stored === sent) return true;
	const empty = (value: unknown) => value === null || value === '';
	return empty(stored) && empty(sent);
}

/**
 * The entries of `update` whose value is not `sameValue` with `row`'s, in
 * `update`'s order, which is the order an activity entry names them in. An
 * empty object means the update changes nothing.
 */
export function changedFields<U extends object>(row: object, update: U): Partial<U> {
	const stored = row as Record<string, unknown>;
	const changed: Partial<U> = {};
	for (const key of Object.keys(update) as (keyof U & string)[]) {
		if (!sameValue(stored[key], update[key])) changed[key] = update[key];
	}
	return changed;
}
