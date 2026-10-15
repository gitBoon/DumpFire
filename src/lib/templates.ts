/**
 * templates.ts — what a card template holds that the card window applies.
 *
 * Save as Template stores the card's labels with it, as a list of label ids
 * in `labels_json` (`POST /api/templates`), and From template read the title,
 * description, priority and subtasks back and left the labels out (card
 * 2163). A template is applied in the New Task window, to a card not yet
 * made, and the label picker shows only once a card is saved (card 2010), so
 * the window keeps them and the board page puts them on the card once it is
 * created (`saveCard` in `$lib/board/card-actions.ts`).
 *
 * It is here and not in the window so that it can be called by a test, and
 * imports nothing from `$lib/server`: a page calls it.
 */

/**
 * The label ids a template holds that can be put on a card of this board:
 * each a whole number that is the id of one of `boardLabels`, in the order the
 * template stored them, once each.
 *
 * Anything else is left out, and nothing is said of it: a label deleted since
 * the template was saved, another board's (a template saved with no board is
 * offered on every board), a number that is not a whole one, an id written as
 * text, a list inside the list, and stored text that is not a list at all.
 * `PUT /api/labels` would refuse the first two, and the rest name no label.
 */
export function templateLabelIds(labelsJson: string | null | undefined, boardLabels: readonly { id: number }[]): number[] {
	let stored: unknown;
	try {
		stored = JSON.parse(labelsJson ?? '');
	} catch {
		return [];
	}
	if (!Array.isArray(stored)) return [];

	const onThisBoard = new Set(boardLabels.map((label) => label.id));
	const kept: number[] = [];
	for (const id of stored) {
		if (typeof id === 'number' && Number.isInteger(id) && onThisBoard.has(id) && !kept.includes(id)) kept.push(id);
	}
	return kept;
}
