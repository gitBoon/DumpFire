import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cards, columns } from '$lib/server/db/schema';
import { eq, inArray, isNull, and } from 'drizzle-orm';
import { canEditBoard } from '$lib/server/board-access';
import { requireMilestone, MilestoneError } from '$lib/server/milestones';
import { emit } from '$lib/server/events';
import { getMilestoneSummary } from '$lib/server/planning';
import { notifyPlanCreated } from '$lib/server/notifications';
import { resolveBaseUrl } from '$lib/server/email';
import type { RequestHandler } from './$types';

interface CardRow {
	cardId: number;
	boardId: number;
	title: string;
	milestoneId: number | null;
}

/** Resolve every card in the request in one query, with its board. */
function loadCards(cardIds: number[]): Map<number, CardRow> {
	if (cardIds.length === 0) return new Map();
	const rows = db
		.select({
			cardId: cards.id,
			boardId: columns.boardId,
			title: cards.title,
			milestoneId: cards.milestoneId
		})
		.from(cards)
		.innerJoin(columns, eq(cards.columnId, columns.id))
		.where(and(inArray(cards.id, cardIds), isNull(cards.archivedAt)))
		.all();
	return new Map(rows.map((r) => [r.cardId, r]));
}

function parseCardIds(body: { cardIds?: unknown }): number[] {
	if (!Array.isArray(body.cardIds)) throw error(400, 'cardIds must be an array of card ids');
	if (body.cardIds.length === 0) throw error(400, 'cardIds is empty');
	if (body.cardIds.length > 500) throw error(400, 'Batch too large (max 500 cards)');
	const ids = body.cardIds.map(Number);
	if (ids.some((n) => isNaN(n))) throw error(400, 'cardIds must contain only card ids');
	return [...new Set(ids)];
}

/**
 * POST /api/v1/milestones/:milestoneId/cards/bulk — put many cards in a goal.
 *
 * Body: `{ "cardIds": [1686, 1559, 1444] }`
 *
 * Validated as a whole and all-or-nothing, like the bulk dependency endpoint:
 * every card must exist and be editable, and a board-scoped milestone still
 * refuses cards from other boards — with every violation reported at once
 * rather than one per attempt.
 *
 * Cards already in this milestone are skipped, not errors, so re-running the
 * same list is safe. A card belonging to a *different* goal is moved, and the
 * response names those explicitly so it is never a silent surprise.
 */
export const POST: RequestHandler = async ({ params, request, url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const milestoneId = Number(params.milestoneId);
	if (isNaN(milestoneId)) throw error(400, 'Invalid milestone ID');

	let milestone;
	try {
		milestone = requireMilestone(locals.user, milestoneId, true);
	} catch (e) {
		if (e instanceof MilestoneError) throw error(e.status, e.message);
		throw e;
	}

	const cardIds = parseCardIds(await request.json());
	const loaded = loadCards(cardIds);

	const editable = new Map<number, boolean>();
	const mayEdit = (boardId: number) => {
		if (!editable.has(boardId)) editable.set(boardId, canEditBoard(locals.user!, boardId));
		return editable.get(boardId)!;
	};

	const problems: { cardId: number; reason: string }[] = [];
	const toAttach: CardRow[] = [];
	const alreadyIn: number[] = [];
	const movedFromOtherGoal: { cardId: number; title: string; fromMilestoneId: number }[] = [];

	for (const id of cardIds) {
		const card = loaded.get(id);
		if (!card) {
			problems.push({ cardId: id, reason: 'Card does not exist or is archived' });
			continue;
		}
		if (!mayEdit(card.boardId)) {
			problems.push({ cardId: id, reason: `No edit access to the board holding card #${id}` });
			continue;
		}
		if (milestone.boardId !== null && milestone.boardId !== card.boardId) {
			problems.push({
				cardId: id,
				reason: `This milestone belongs to a single board; card #${id} is on another. Make the milestone cross-board, or move the card.`
			});
			continue;
		}
		if (card.milestoneId === milestoneId) {
			alreadyIn.push(id);
			continue;
		}
		if (card.milestoneId !== null) {
			movedFromOtherGoal.push({ cardId: id, title: card.title, fromMilestoneId: card.milestoneId });
		}
		toAttach.push(card);
	}

	if (problems.length > 0) {
		return json(
			{
				error: 'Batch rejected — nothing was written',
				attached: 0,
				problems,
				wouldAttach: toAttach.length,
				wouldSkipAlreadyIn: alreadyIn.length
			},
			{ status: 409 }
		);
	}

	// Was this goal empty before? If so, this call is the moment the plan came
	// into existence, which is what is worth telling people about — a milestone
	// is created empty and only means something once it has work in it.
	const wasEmpty =
		db.select({ id: cards.id }).from(cards).where(eq(cards.milestoneId, milestoneId)).all().length === 0;

	const now = new Date().toISOString();
	for (const card of toAttach) {
		db.update(cards).set({ milestoneId, updatedAt: now }).where(eq(cards.id, card.cardId)).run();
	}

	const touched = new Set(toAttach.map((c) => c.boardId));
	for (const boardId of touched) emit(boardId, 'update', { type: 'card' });

	if (wasEmpty && toAttach.length > 0) {
		// Never let a notification failure fail the attach.
		try {
			const summary = getMilestoneSummary(milestoneId);
			if (summary) {
				const titleOf = (id: number) =>
					summary.graph.nodes.find((n) => n.kind === 'card' && n.id === id)?.title ?? '';
				notifyPlanCreated(
					{
						milestoneId,
						name: milestone.name,
						cardCount: summary.progress.total,
						boards: summary.progress.boards.map((b) => b.name),
						criticalPath: summary.criticalPath.map((id) => ({ id, title: titleOf(id) })),
						startable: summary.nextActionable.length,
						blocked: summary.blocked.length
					},
					toAttach.map((c) => c.cardId),
					locals.user.username,
					locals.user.id,
					resolveBaseUrl(request, url)
				);
			}
		} catch {
			/* notification only — the cards are attached either way */
		}
	}

	return json({
		milestoneId,
		attached: toAttach.length,
		skippedAlreadyIn: alreadyIn.length,
		movedFromOtherGoal,
		boardsTouched: [...touched]
	});
};

/**
 * DELETE /api/v1/milestones/:milestoneId/cards/bulk — take many cards out.
 *
 * Body: `{ "cardIds": [...] }`. Cards that are not in this milestone are
 * skipped rather than erroring. The cards themselves are untouched.
 */
export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const milestoneId = Number(params.milestoneId);
	if (isNaN(milestoneId)) throw error(400, 'Invalid milestone ID');

	try {
		requireMilestone(locals.user, milestoneId, true);
	} catch (e) {
		if (e instanceof MilestoneError) throw error(e.status, e.message);
		throw e;
	}

	const cardIds = parseCardIds(await request.json());
	const loaded = loadCards(cardIds);

	const editable = new Map<number, boolean>();
	const mayEdit = (boardId: number) => {
		if (!editable.has(boardId)) editable.set(boardId, canEditBoard(locals.user!, boardId));
		return editable.get(boardId)!;
	};

	const problems: { cardId: number; reason: string }[] = [];
	const toDetach: CardRow[] = [];
	const notInMilestone: number[] = [];

	for (const id of cardIds) {
		const card = loaded.get(id);
		if (!card) {
			problems.push({ cardId: id, reason: 'Card does not exist or is archived' });
			continue;
		}
		if (!mayEdit(card.boardId)) {
			problems.push({ cardId: id, reason: `No edit access to the board holding card #${id}` });
			continue;
		}
		if (card.milestoneId !== milestoneId) {
			notInMilestone.push(id);
			continue;
		}
		toDetach.push(card);
	}

	if (problems.length > 0) {
		return json(
			{ error: 'Batch rejected — nothing was written', detached: 0, problems },
			{ status: 409 }
		);
	}

	const now = new Date().toISOString();
	for (const card of toDetach) {
		db.update(cards).set({ milestoneId: null, updatedAt: now }).where(eq(cards.id, card.cardId)).run();
	}

	const touched = new Set(toDetach.map((c) => c.boardId));
	for (const boardId of touched) emit(boardId, 'update', { type: 'card' });

	return json({
		milestoneId,
		detached: toDetach.length,
		skippedNotInMilestone: notInMilestone.length,
		boardsTouched: [...touched]
	});
};
