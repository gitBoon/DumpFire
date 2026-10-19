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
 *
 * The work of each is in `$lib/server/work-dependencies`, which the v1 route
 * and both subtask routes share (card 2012). This route keeps the card
 * window's words: `No access` and `No edit access` for the card, and
 * `Nothing to link` (`nothingToLink`) for a body that names no end.
 */
import { json, error } from '@sveltejs/kit';
import { cycleAnswer } from '$lib/server/dependency-refusals';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { addWorkDependency, readWorkDependencies, removeWorkDependency } from '$lib/server/work-dependencies';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = pathId(params.id, 'card');

	const { isBlocked, blockedBy, blocks } = readWorkDependencies(locals.user, { kind: 'card', id: cardId }, {});
	return json({ cardId, isBlocked, blockedBy, blocks });
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);

	const cardId = pathId(params.id, 'card');
	const body = await readBody(request);

	// One transaction from the card to the answer's list: the session asked
	// again and who its account is now (card 2253), the card read and the
	// caller checked, the graph the link is checked against, the link and its
	// activity entry. Nothing another request writes can come between the
	// check and the write, and the link is recorded with its entry or not at all.
	const outcome = writeAs(locals, (caller) => {
		const added = addWorkDependency(caller, { kind: 'card', id: cardId }, body, { source: 'ui', nothingToLink: true });
		// A link that would close a loop wrote nothing: it is answered 409, with its chain.
		if (added.rejected) return cycleAnswer(added);
		return { blockedBy: added.blockedBy, blocks: added.blocks, isBlocked: added.isBlocked };
	});

	if (outcome instanceof Response) return outcome;
	return json(outcome, { status: 201 });
};

export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);

	const cardId = pathId(params.id, 'card');
	const body = await readBody(request);

	// One transaction, which asks first whether the session is still open, and
	// who its account is now (card 2253). The card in the path is whichever end
	// the caller is looking at, so they must be able to read it; whether they
	// may remove the link is asked of the board of the end that waits.
	const { blockedBy, blocks, isBlocked } = writeAs(locals, (caller) =>
		removeWorkDependency(caller, { kind: 'card', id: cardId }, body, { source: 'ui', nothingToLink: true })
	);

	return json({ blockedBy, blocks, isBlocked });
};
