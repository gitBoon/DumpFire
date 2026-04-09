import { db } from '$lib/server/db';
import { cards, columns, subtasks, boards } from '$lib/server/db/schema';
import { eq, inArray } from 'drizzle-orm';

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

		const completeColIds = new Set(
			sbCols
				.filter(c => c.title.toLowerCase() === 'complete' || c.title.toLowerCase() === 'done')
				.map(c => c.id)
		);

		const incompleteCards = sbCards.filter(c => !completeColIds.has(c.columnId));
		if (incompleteCards.length > 0) {
			return `Sub-board "${sb.name}" has ${incompleteCards.length} incomplete card${incompleteCards.length > 1 ? 's' : ''} that must be completed first`;
		}
	}

	return null;
}

/**
 * Returns true if the given column title represents a "complete" column.
 */
export function isCompleteColumnTitle(title: string): boolean {
	const lower = title.toLowerCase();
	return lower === 'complete' || lower === 'done';
}
