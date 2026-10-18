import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { inTransaction } from '$lib/server/db/transaction';
import { canViewBoard, canEditBoard } from '$lib/server/board-access';
import { getWorkDependencies, type WorkKind, type WorkRef } from '$lib/server/planning';
import { addDependencyLink, cycleAnswer, removeDependencyLink } from '$lib/server/dependency-refusals';
import { pathId, readBody, readId, type RequestBody } from '$lib/server/request-body';
import { getCardBoardId } from '$lib/server/work-access';
import type { RequestHandler } from './$types';

/**
 * GET /api/v1/cards/:cardId/dependencies — what blocks this card and what it blocks.
 *
 * `?direction=blocked-by|blocks|both` (default `both`). Each entry carries its
 * `kind`, because "#32" is ambiguous between card 32 and subtask 32, and the
 * board it lives on so a cross-board dependency shows as "Board / #id". An end
 * on a board the key's user cannot open is listed withheld: its id, kind and
 * whether it is finished, `withheld: true`, and text in place of its title and
 * board (card 2129).
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = pathId(params.cardId, 'card');

	const boardId = getCardBoardId(cardId);
	if (!boardId) throw error(404, 'Card not found');
	if (!canViewBoard(locals.user, boardId)) throw error(403, 'No access to this card\'s board');

	const direction = url.searchParams.get('direction') ?? 'both';
	if (!['blocked-by', 'blocks', 'both'].includes(direction)) {
		throw error(400, 'direction must be one of: blocked-by, blocks, both');
	}

	const state = getWorkDependencies({ kind: 'card', id: cardId }, locals.user);
	const shape = (refs: typeof state.blockedBy) =>
		refs.map((r) => ({
			id: r.dependencyId,
			kind: r.kind,
			cardId: r.id,
			parentCardId: r.parentCardId ?? null,
			title: r.title,
			boardId: r.boardId,
			boardName: r.boardName,
			columnName: r.columnTitle,
			priority: r.priority,
			resolved: r.isComplete,
			withheld: r.withheld,
			createdByUserId: r.createdByUserId,
			createdAt: r.createdAt
		}));

	return json({
		cardId,
		isBlocked: state.isBlocked,
		...(direction !== 'blocks' ? { blockedBy: shape(state.blockedBy) } : {}),
		...(direction !== 'blocked-by' ? { blocks: shape(state.blocks) } : {})
	});
};

/**
 * Work out the two ends from the request body.
 *
 * `dependsOnCardId` / `blocksCardId` are the long-standing card-only spellings
 * and keep working untouched. `dependsOnSubtaskId` / `blocksSubtaskId` are their
 * subtask equivalents, so linking to a subtask needs no new endpoint. Each is
 * read as an id; `null` is the same as not sent.
 */
function resolveEnds(cardId: number, body: RequestBody): { blocked: WorkRef; blocker: WorkRef } {
	const self: WorkRef = { kind: 'card', id: cardId };
	const given = [
		{ id: readId(body, 'dependsOnCardId', { nullable: true }), kind: 'card' as WorkKind, thisCardWaits: true },
		{ id: readId(body, 'dependsOnSubtaskId', { nullable: true }), kind: 'subtask' as WorkKind, thisCardWaits: true },
		{ id: readId(body, 'blocksCardId', { nullable: true }), kind: 'card' as WorkKind, thisCardWaits: false },
		{ id: readId(body, 'blocksSubtaskId', { nullable: true }), kind: 'subtask' as WorkKind, thisCardWaits: false }
	].filter((g): g is { id: number; kind: WorkKind; thisCardWaits: boolean } => typeof g.id === 'number');

	if (given.length === 0) {
		throw error(
			400,
			'Provide one of dependsOnCardId, dependsOnSubtaskId (this card waits on it), blocksCardId or blocksSubtaskId (it waits on this card)'
		);
	}
	if (given.length > 1) throw error(400, 'Provide only one of the dependsOn*/blocks* fields');

	const g = given[0];
	const other: WorkRef = { kind: g.kind, id: g.id };

	return g.thisCardWaits ? { blocked: self, blocker: other } : { blocked: other, blocker: self };
}

/**
 * POST /api/v1/cards/:cardId/dependencies — record that this card waits on
 * something, or that something waits on it.
 *
 * Cross-board dependencies are allowed — a migration touches several projects —
 * so edit access is required on both ends. A dependency that would close a loop
 * is rejected with 409 and the offending chain listed.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = pathId(params.cardId, 'card');

	const user = locals.user;
	const body = await readBody(request);

	// One transaction from the access checks to the activity entry. The graph
	// the link is checked against is read in it, so a link written by another
	// request cannot close a loop between the check and the write, and the
	// link is recorded with the entry that says so or not at all.
	const outcome = inTransaction(() => {
		const boardId = getCardBoardId(cardId);
		if (!boardId) throw error(404, 'Card not found');
		if (!canEditBoard(user, boardId)) throw error(403, 'No edit access to this card\'s board');

		const { blocked, blocker } = resolveEnds(cardId, body);

		// The other end (404, 403), the check, the link, its `api:dependency_added`
		// entry and the live events, as the session route and both subtask routes
		// make them: see dependency-refusals.ts. A cycle is answered below, once
		// the transaction is over. Nothing was written.
		const added = addDependencyLink(user, blocked, blocker, { at: { kind: 'card', id: cardId }, source: 'api' });
		if (added.rejected) return added;

		const state = getWorkDependencies({ kind: 'card', id: cardId }, user);
		return { rejected: false as const, blocked, blocker, isBlocked: state.isBlocked };
	});

	if (outcome.rejected) return cycleAnswer(outcome);

	const { blocked, blocker, isBlocked } = outcome;
	return json(
		{
			blocked: { kind: blocked.kind, id: blocked.id },
			blocker: { kind: blocker.kind, id: blocker.id },
			isBlocked
		},
		{ status: 201 }
	);
};

/**
 * DELETE /api/v1/cards/:cardId/dependencies — remove a dependency.
 *
 * Takes the same body spellings as POST, so a caller never has to work out
 * which end of the pair stores the row.
 */
export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = pathId(params.cardId, 'card');

	const user = locals.user;
	const body = await readBody(request);

	// One transaction: the card is read and the caller checked in the one that
	// removes the link and writes the entry.
	const removed = inTransaction(() => {
		// The card in the path is whichever end the caller is looking at, so
		// they must be able to read it. Whether they may remove the link is not
		// asked of this card's board: it is asked of the board of the end that
		// waits, in removeDependencyLink.
		const boardId = getCardBoardId(cardId);
		if (!boardId) throw error(404, 'Card not found');
		if (!canViewBoard(user, boardId)) throw error(403, 'No access to this card\'s board');

		const { blocked, blocker } = resolveEnds(cardId, body);

		// Throws 403 for a caller who may not edit the board of the end that
		// waits, and then 404 for a link that is not there. It writes the
		// `api:dependency_removed` entry on the board of the end that waits,
		// naming this card where it is on that board and otherwise the card
		// that waits, and sends the live event to both ends' boards.
		return removeDependencyLink(user, blocked, blocker, { at: { kind: 'card', id: cardId }, source: 'api' });
	});

	return json({ success: true, removed });
};
