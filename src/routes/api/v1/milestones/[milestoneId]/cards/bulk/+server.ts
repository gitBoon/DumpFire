import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { inTransaction } from '$lib/server/db/transaction';
import { cards, columns } from '$lib/server/db/schema';
import { eq, inArray, isNull, and } from 'drizzle-orm';
import { canEditBoard } from '$lib/server/board-access';
import { requireMilestone, MilestoneError } from '$lib/server/milestones';
import { emit } from '$lib/server/events';
import { getMilestoneSummary } from '$lib/server/planning';
import { notifyPlanCreated } from '$lib/server/notifications';
import { linkBaseUrl } from '$lib/server/email';
import { pathId, readBody, readIds, type RequestBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
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

/**
 * The batch's card ids, each read as an id: `null` is
 * `400 cardIds[<n>] must be an id` (decision 18), where it was read as card 0
 * and reported as a card that does not exist.
 */
function parseCardIds(body: RequestBody): number[] {
	const ids = readIds(body, 'cardIds', {
		required: true,
		min: 1,
		says: { missing: 'cardIds must be an array of card ids', type: 'cardIds must be an array of card ids', empty: 'cardIds is empty' }
	});
	if (ids.length > 500) throw error(400, 'Batch too large (max 500 cards)');
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
 * response names those explicitly so it is never a silent surprise. Moving it
 * takes it out of that goal, so the caller must be able to change that goal
 * too (R5); a card in one they cannot is listed under `problems`.
 */
export const POST: RequestHandler = async ({ params, request, url, locals }) => {
	const user = requireUser(locals.user);
	const milestoneId = pathId(params.milestoneId, 'milestone');
	const body = await readBody(request);

	// One transaction from the first check to the last write. The milestone and
	// the cards are read in it, so what was checked is what is written to, and
	// every card is attached or none is. The cards used to be written one
	// statement at a time with nothing around them, and a failure part of the
	// way left some attached under a contract that says nothing is.
	const outcome = inTransaction(() => {
		let milestone;
		try {
			milestone = requireMilestone(user, milestoneId, true);
		} catch (e) {
			if (e instanceof MilestoneError) throw error(e.status, e.message);
			throw e;
		}

		const cardIds = parseCardIds(body);
		const loaded = loadCards(cardIds);

		const editable = new Map<number, boolean>();
		const mayEdit = (boardId: number) => {
			if (!editable.has(boardId)) editable.set(boardId, canEditBoard(user, boardId));
			return editable.get(boardId)!;
		};
		// A card in another goal leaves it, which is R5's removal rule: the
		// caller must be able to change that goal too, as on every route that
		// takes a card out. It was moved whoever asked.
		const goalsEditable = new Map<number, boolean>();
		const mayLeave = (goalId: number) => {
			if (!goalsEditable.has(goalId)) {
				let may = true;
				try {
					requireMilestone(user, goalId, true);
				} catch (e) {
					if (!(e instanceof MilestoneError)) throw e;
					may = false;
				}
				goalsEditable.set(goalId, may);
			}
			return goalsEditable.get(goalId)!;
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
				if (!mayLeave(card.milestoneId)) {
					problems.push({ cardId: id, reason: `No edit access to milestone #${card.milestoneId}, which holds card #${id}` });
					continue;
				}
				movedFromOtherGoal.push({ cardId: id, title: card.title, fromMilestoneId: card.milestoneId });
			}
			toAttach.push(card);
		}

		if (problems.length > 0) {
			return { rejected: true as const, problems, wouldAttach: toAttach.length, wouldSkipAlreadyIn: alreadyIn.length };
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

		return { rejected: false as const, milestone, toAttach, alreadyIn, movedFromOtherGoal, touched, wasEmpty };
	});

	if (outcome.rejected) {
		return json(
			{
				message: 'Batch rejected — nothing was written',
				attached: 0,
				problems: outcome.problems,
				wouldAttach: outcome.wouldAttach,
				wouldSkipAlreadyIn: outcome.wouldSkipAlreadyIn
			},
			{ status: 409 }
		);
	}
	const { milestone, toAttach, alreadyIn, movedFromOtherGoal, touched, wasEmpty } = outcome;

	if (wasEmpty && toAttach.length > 0) {
		// Never let a notification failure fail the attach. This is after the
		// commit and outside the transaction, so a failure here is caught with
		// nothing half written behind it.
		try {
			// As the one who attached the cards sees the plan: work on a board
			// they cannot open is withheld (card 2129). Others are mailed it
			// too, who may open fewer boards: that is card 2152.
			const summary = getMilestoneSummary(milestoneId, user);
			if (summary) {
				// `criticalPath` puts a subtask's card in its place, and that card
				// need not be in the plan. A step that is shown is on a board the
				// attacher can open, and so is its card, whose title is read. A
				// withheld one has no card given, and the card is said to be on a
				// board they cannot open, where it was printed with no title at all.
				const titleOf = (id: number) => {
					const card = summary.graph.nodes.find((n) => n.kind === 'card' && n.id === id);
					if (card) return card.title;
					const shownStep = summary.graph.nodes.some((n) => n.kind === 'subtask' && !n.withheld && n.parentCardId === id);
					const stored = shownStep ? db.select({ title: cards.title }).from(cards).where(eq(cards.id, id)).get() : undefined;
					return stored?.title ?? 'a card on a board you cannot open';
				};
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
					user.username,
					user.id,
					linkBaseUrl(url)
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
	const user = requireUser(locals.user);
	const milestoneId = pathId(params.milestoneId, 'milestone');
	const body = await readBody(request);

	// One transaction, as for the attach: every card is taken out or none is.
	const outcome = inTransaction(() => {
		try {
			requireMilestone(user, milestoneId, true);
		} catch (e) {
			if (e instanceof MilestoneError) throw error(e.status, e.message);
			throw e;
		}

		const cardIds = parseCardIds(body);
		const loaded = loadCards(cardIds);

		const editable = new Map<number, boolean>();
		const mayEdit = (boardId: number) => {
			if (!editable.has(boardId)) editable.set(boardId, canEditBoard(user, boardId));
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

		if (problems.length > 0) return { rejected: true as const, problems };

		const now = new Date().toISOString();
		for (const card of toDetach) {
			db.update(cards).set({ milestoneId: null, updatedAt: now }).where(eq(cards.id, card.cardId)).run();
		}

		const touched = new Set(toDetach.map((c) => c.boardId));
		for (const boardId of touched) emit(boardId, 'update', { type: 'card' });

		return { rejected: false as const, toDetach, notInMilestone, touched };
	});

	if (outcome.rejected) {
		return json(
			{ message: 'Batch rejected — nothing was written', detached: 0, problems: outcome.problems },
			{ status: 409 }
		);
	}
	const { toDetach, notInMilestone, touched } = outcome;

	return json({
		milestoneId,
		detached: toDetach.length,
		skippedNotInMilestone: notInMilestone.length,
		boardsTouched: [...touched]
	});
};
