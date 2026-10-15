import { db } from '$lib/server/db';
import { cards, columns, subtasks, boards, type Column } from '$lib/server/db/schema';
import { count, eq, inArray } from 'drizzle-orm';
import { completeColumnIds, isCompleteColumnTitle, isHoldColumnTitle } from '$lib/column-role';

/**
 * Checks whether a card has incomplete subtasks or incomplete sub-boards.
 *
 * A sub-board is considered incomplete if it has any cards NOT in a column
 * whose title is "complete" or "done" (case-insensitive).
 *
 * Returns `null` if the card is ready to complete, or an error message string
 * describing what's still incomplete.
 */
export function getCompletionBlocker(cardId: number): string | null {
	// 1. Check subtasks
	const cardSubtasks = db.select().from(subtasks)
		.where(eq(subtasks.cardId, cardId))
		.all();

	if (cardSubtasks.length > 0) {
		const incomplete = cardSubtasks.filter(st => !st.completed);
		if (incomplete.length > 0) {
			return `Card has ${incomplete.length} incomplete subtask${incomplete.length > 1 ? 's' : ''} that must be completed first`;
		}
	}

	// 2. Check sub-boards
	const subBoards = db.select().from(boards)
		.where(eq(boards.parentCardId, cardId))
		.all();

	for (const sb of subBoards) {
		const sbCols = db.select().from(columns)
			.where(eq(columns.boardId, sb.id))
			.all();
		const sbColIds = sbCols.map(c => c.id);
		if (sbColIds.length === 0) continue;

		const sbCards = db.select().from(cards)
			.where(inArray(cards.columnId, sbColIds))
			.all();
		if (sbCards.length === 0) continue;

		const completeColIds = completeColumnIds(sbCols);

		const incompleteCards = sbCards.filter(c => !completeColIds.has(c.columnId));
		if (incompleteCards.length > 0) {
			return `Sub-board "${sb.name}" has ${incompleteCards.length} incomplete card${incompleteCards.length > 1 ? 's' : ''} that must be completed first`;
		}
	}

	return null;
}

/**
 * Why a column may not be given this title, or `null` if it may.
 *
 * A card is finished because the column it is in is called Complete or Done.
 * So a rename into one of those titles, or out of them, changes what every
 * card in the column means: renaming "Done" to "Shipped" would turn finished
 * work back into open work on every screen while each card kept its
 * completion date, and renaming "Review" to "Done" would make cards finished
 * that nobody finished, with no date, no XP and no entry (card 2134). Every
 * completion and reopening goes through a move, with its checks, so a rename
 * that would change the role is refused while the column holds any card.
 * Archived cards count: a restore puts them back in it. An empty column is
 * renamed freely, and so is one whose role the new title keeps (Complete to
 * Done, To Do to Backlog).
 *
 * `column` is the row as it was and `storedTitle` the title as written. The
 * two column routes ask this inside the transaction that writes the title, so
 * a refusal rolls the write back, and no card can be moved in or created
 * between the count and the write.
 *
 * Each message is one template, so the OpenAPI document's check of its
 * examples can find it here.
 */
export function completionRoleRefusal(column: Pick<Column, 'id' | 'title'>, storedTitle: string): string | null {
	const wasComplete = isCompleteColumnTitle(column.title);
	if (wasComplete === isCompleteColumnTitle(storedTitle)) return null;

	const held = db
		.select({ total: count(), archived: count(cards.archivedAt) })
		.from(cards)
		.where(eq(cards.columnId, column.id))
		.get();
	const total = held?.total ?? 0;
	const archived = held?.archived ?? 0;
	if (total === 0) return null;

	const holds =
		total === 1
			? `1 card${archived > 0 ? ', which is archived' : ''}`
			: `${total} cards${archived === 0 ? '' : archived === total ? ', all of them archived' : `, ${archived} of them archived`}`;
	const [they, them] = total === 1 ? ['It counts', 'it'] : ['They count', 'them'];

	if (wasComplete) {
		return `This column holds ${holds}. ${they} as finished because the column is called Complete or Done, and renaming it to "${storedTitle}" would turn ${them} back into open work. Keep it called Complete or Done.`;
	}
	return `This column holds ${holds}. Renaming it to "${storedTitle}" would mark ${them} finished without anyone finishing ${them}. Move each finished card to a Complete column and the rest out of this one first, or choose another name.`;
}

// The definitions of a complete and an on-hold column live in `$lib/column-role`,
// where the browser can share them. Re-exported so server code has one import.
export { isCompleteColumnTitle, isHoldColumnTitle };
