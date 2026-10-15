/**
 * Session-authenticated sibling of /api/v1/cards/:cardId/dependencies.
 *
 * The board UI runs on the session cookie and cannot send a bearer token, so
 * the card modal talks to this route. The rules — cycle rejection, edit access
 * on both ends, cross-board allowed, subtasks as valid ends — are the same;
 * only the auth differs. So are the answers to a link that is refused: both
 * routes take them from dependency-refusals.ts. Who may remove a link is
 * decided there as well: an editor of the board of the end that waits. So is
 * the write, with the activity entry it records, from the source `ui`: these
 * two wrote none until card 2114.
 */
import { json, error } from '@sveltejs/kit';
import { canViewBoard, canEditBoard, type Actor } from '$lib/server/board-access';
import { inTransaction } from '$lib/server/db/transaction';
import { getWorkDependencies, type WorkKind, type WorkRef } from '$lib/server/planning';
import { addDependencyLink, cycleAnswer, removeDependencyLink } from '$lib/server/dependency-refusals';
import { pathId, readBody, readId, type RequestBody } from '$lib/server/request-body';
import { getCardBoardId } from '$lib/server/work-access';
import type { RequestHandler } from './$types';

/**
 * Shape a dependency end for the card modal. An end on a board the caller
 * cannot open comes withheld from planning.ts: its id, kind and whether it is
 * finished, and text in place of its title and board (card 2129).
 */
function shape(refs: ReturnType<typeof getWorkDependencies>['blockedBy']) {
	return refs.map((r) => ({
		kind: r.kind,
		cardId: r.id,
		parentCardId: r.parentCardId ?? null,
		title: r.title,
		boardId: r.boardId,
		boardName: r.boardName,
		columnName: r.columnTitle,
		priority: r.priority,
		resolved: r.isComplete,
		withheld: r.withheld
	}));
}

/**
 * The two ends, from the modal's body.
 *
 * `dependsOnCardId` / `blocksCardId` are the card-only spellings the modal has
 * always sent; the `*SubtaskId` pair is their subtask equivalent. Each is read
 * as an id; `null` is the same as not sent.
 */
function resolveEnds(cardId: number, body: RequestBody): { blocked: WorkRef; blocker: WorkRef } {
	const self: WorkRef = { kind: 'card', id: cardId };
	const given = [
		{ id: readId(body, 'dependsOnCardId', { nullable: true }), kind: 'card' as WorkKind, waits: true },
		{ id: readId(body, 'dependsOnSubtaskId', { nullable: true }), kind: 'subtask' as WorkKind, waits: true },
		{ id: readId(body, 'blocksCardId', { nullable: true }), kind: 'card' as WorkKind, waits: false },
		{ id: readId(body, 'blocksSubtaskId', { nullable: true }), kind: 'subtask' as WorkKind, waits: false }
	].filter((g): g is { id: number; kind: WorkKind; waits: boolean } => typeof g.id === 'number');

	if (given.length === 0) throw error(400, 'Nothing to link');
	if (given.length > 1) throw error(400, 'Provide only one end');

	const g = given[0];
	const other: WorkRef = { kind: g.kind, id: g.id };

	return g.waits ? { blocked: self, blocker: other } : { blocked: other, blocker: self };
}

/** The card's links, as the modal draws them for `user`. */
function linksOf(cardId: number, user: Actor) {
	const state = getWorkDependencies({ kind: 'card', id: cardId }, user);
	return { blockedBy: shape(state.blockedBy), blocks: shape(state.blocks), isBlocked: state.isBlocked };
}

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = pathId(params.id, 'card');

	const boardId = getCardBoardId(cardId);
	if (!boardId) throw error(404, 'Card not found');
	if (!canViewBoard(locals.user, boardId)) throw error(403, 'No access');

	const state = getWorkDependencies({ kind: 'card', id: cardId }, locals.user);
	return json({
		cardId,
		isBlocked: state.isBlocked,
		blockedBy: shape(state.blockedBy),
		blocks: shape(state.blocks)
	});
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const user = locals.user;

	const cardId = pathId(params.id, 'card');
	const body = await readBody(request);

	// One transaction from the card to the answer's list: the card read and the
	// caller checked, the graph the link is checked against, the link and its
	// activity entry. Nothing another request writes can come between the
	// check and the write, and the link is recorded with its entry or not at all.
	const outcome = inTransaction(() => {
		const boardId = getCardBoardId(cardId);
		if (!boardId) throw error(404, 'Card not found');
		if (!canEditBoard(user, boardId)) throw error(403, 'No edit access');

		const { blocked, blocker } = resolveEnds(cardId, body);

		// The other end (404, 403), then the check: 409 for a link that is
		// already there, 400 for an end that waits on itself or is archived. A
		// cycle is returned, and answered with its chain once this is over.
		const added = addDependencyLink(user, blocked, blocker, { at: { kind: 'card', id: cardId }, source: 'ui' });
		if (added.rejected) return added;

		return { rejected: false as const, links: linksOf(cardId, user) };
	});

	if (outcome.rejected) return cycleAnswer(outcome);
	return json(outcome.links, { status: 201 });
};

export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const user = locals.user;

	const cardId = pathId(params.id, 'card');
	const body = await readBody(request);

	const links = inTransaction(() => {
		// The card in the path is whichever end the caller is looking at, and
		// they are answered with its links, so they must be able to read it.
		// Whether they may remove the link is not asked of this card's board: it
		// is asked of the board of the end that waits, in removeDependencyLink.
		const boardId = getCardBoardId(cardId);
		if (!boardId) throw error(404, 'Card not found');
		if (!canViewBoard(user, boardId)) throw error(403, 'No access');

		const { blocked, blocker } = resolveEnds(cardId, body);

		// Throws 403 for a caller who may not edit the board of the end that
		// waits, and then 404 for a link that is not there. It writes the
		// `dependency_removed` entry, and sends the live event to both ends'
		// boards: the card in the path may be on either.
		removeDependencyLink(user, blocked, blocker, { at: { kind: 'card', id: cardId }, source: 'ui' });

		return linksOf(cardId, user);
	});

	return json(links);
};
