/**
 * card-restore.ts — bring a card back from the archive.
 *
 * The other half of `archiveCard` in `deletes.ts`. Archiving stamps the card
 * and touches nothing else, so restoring it only has to clear the stamp (and
 * the discard mark of an option, milestone 22): its subtasks, attachments,
 * dependency links and sub-boards never went anywhere.
 *
 * Three routes restore a card: `POST /api/cards/:id/restore`,
 * `POST /api/boards/:id/archive`, and `PUT /api/v1/cards/:cardId` with
 * `archivedAt: null`. The first two each had their own copy of this.
 *
 * Like the functions in `deletes.ts`, this opens its own `inTransaction` and
 * does not check access. A route calls it inside the one in which it read the
 * card and checked the caller, and that makes this a savepoint of it.
 */
import { eq } from 'drizzle-orm';
import { db } from './db';
import { inTransaction } from './db/transaction';
import { cards, columns, type Card } from './db/schema';
import { stamp } from '$lib/timestamps';
import { ACTIONS, actorOf, logActivity, type ActivitySource } from './logActivity';

/** Who is restoring: the signed-in user. */
export type RestoreActor = { id: number; username: string; emoji?: string | null };

/**
 * Restore a card: `archived_at` cleared, with any discard mark, `updated_at`
 * set to now, and a `card_restored` entry on its board with the detail
 * `"<title>"`, as the archive's entry has (card 2108). A restore wrote no
 * entry, so the activity log showed a card archived and never brought back.
 *
 * Returns the card as it is afterwards and whether it was restored, or null
 * if there is no such card. A card that is not archived is handed back as it
 * is, with nothing written: no stamp, no entry. The route tells the board only
 * when `restored` is true.
 *
 * A discarded card, an option archived from upstream, has its discard mark
 * cleared with `archived_at` (milestone 22, card 2461): it returns to its
 * column, still upstream, an option again. Its entry is still
 * `card_restored`, with the detail `"<title>": back in <column>` (the S3
 * review's E7). The `card_discarded` entry stays where it is: the discard
 * happened.
 */
export function restoreCard(
	cardId: number,
	actor: RestoreActor,
	source: ActivitySource
): { card: Card; restored: boolean } | null {
	return inTransaction(() => {
		// The card, its board and whether it is archived, read before anything is written.
		const found = db
			.select({ card: cards, boardId: columns.boardId, columnTitle: columns.title })
			.from(cards)
			.innerJoin(columns, eq(columns.id, cards.columnId))
			.where(eq(cards.id, cardId))
			.get();
		if (!found) return null;
		if (found.card.archivedAt === null) return { card: found.card, restored: false };

		const restored = db
			.update(cards)
			.set({ archivedAt: null, discardedAt: null, discardedBy: null, updatedAt: stamp() })
			.where(eq(cards.id, cardId))
			.returning()
			.get()!;
		const wasDiscarded = found.card.discardedAt !== null;
		logActivity({
			boardId: found.boardId,
			cardId,
			action: ACTIONS.cardRestored,
			detail: wasDiscarded ? `"${found.card.title}": back in ${found.columnTitle}` : `"${found.card.title}"`,
			source,
			...actorOf(actor)
		});
		return { card: restored, restored: true };
	});
}
