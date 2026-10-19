import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { cycleAnswer } from '$lib/server/dependency-refusals';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { addWorkDependency, readWorkDependencies, removeWorkDependency } from '$lib/server/work-dependencies';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/** This route's words for a caller who may not read the card in its path, which it keeps (card 2012, R2). */
const NO_ACCESS = "No access to this card's board";

/** And for one who may not edit it. */
const NO_EDIT = "No edit access to this card's board";

/**
 * GET /api/v1/cards/:cardId/dependencies — what blocks this card and what it blocks.
 *
 * `?direction=blocked-by|blocks|both` (default `both`). Each entry carries its
 * `kind`, because "#32" is ambiguous between card 32 and subtask 32, and the
 * board it lives on so a cross-board dependency shows as "Board / #id". An end
 * on a board the key's user cannot open is listed withheld: its id, kind and
 * whether it is finished, `withheld: true`, and text in place of its title and
 * board (card 2129).
 *
 * The read is `readWorkDependencies` in `$lib/server/work-dependencies`, which
 * the internal route shares (card 2012); this route asks it for each link's
 * id, who made it and when (`withLinkDetails`). The card is looked for and the
 * caller checked (404, then 403) before `direction` is read (400).
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = pathId(params.cardId, 'card');

	const links = readWorkDependencies(locals.user, { kind: 'card', id: cardId }, { says: NO_ACCESS, withLinkDetails: true });

	const direction = url.searchParams.get('direction') ?? 'both';
	if (!['blocked-by', 'blocks', 'both'].includes(direction)) {
		throw error(400, 'direction must be one of: blocked-by, blocks, both');
	}

	return json({
		cardId,
		isBlocked: links.isBlocked,
		...(direction !== 'blocks' ? { blockedBy: links.blockedBy } : {}),
		...(direction !== 'blocked-by' ? { blocks: links.blocks } : {})
	});
};

/**
 * POST /api/v1/cards/:cardId/dependencies — record that this card waits on
 * something, or that something waits on it.
 *
 * `dependsOnCardId` / `blocksCardId` are the long-standing card-only spellings
 * and keep working untouched. `dependsOnSubtaskId` / `blocksSubtaskId` are their
 * subtask equivalents, so linking to a subtask needs no new endpoint.
 *
 * Cross-board dependencies are allowed — a migration touches several projects —
 * so edit access is required on both ends. A dependency that would close a loop
 * is rejected with 409 and the offending chain listed. The work is
 * `addWorkDependency`, which the internal route and both subtask routes share
 * (card 2012).
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);

	const cardId = pathId(params.cardId, 'card');

	const body = await readBody(request);

	// One transaction from the access checks to the activity entry. The graph
	// the link is checked against is read in it, so a link written by another
	// request cannot close a loop between the check and the write, and the
	// link is recorded with the entry that says so or not at all. It asks first
	// whether the key or session is still open, and who its account is now
	// (card 2253).
	const outcome = writeAs(locals, (caller) => {
		const added = addWorkDependency(caller, { kind: 'card', id: cardId }, body, { source: 'api', says: NO_EDIT });
		// A link that would close a loop wrote nothing: it is answered 409, with its chain.
		if (added.rejected) return cycleAnswer(added);
		const { blocked, blocker, isBlocked } = added;
		return { blocked: { kind: blocked.kind, id: blocked.id }, blocker: { kind: blocker.kind, id: blocker.id }, isBlocked };
	});

	if (outcome instanceof Response) return outcome;
	return json(outcome, { status: 201 });
};

/**
 * DELETE /api/v1/cards/:cardId/dependencies — remove a dependency.
 *
 * Takes the same body spellings as POST, so a caller never has to work out
 * which end of the pair stores the row.
 */
export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);

	const cardId = pathId(params.cardId, 'card');

	const body = await readBody(request);

	// One transaction: the card is read and the caller checked in the one that
	// removes the link and writes the entry, which asks first whether the key
	// or session is still open, and who its account is now (card 2253). The
	// card in the path is whichever end the caller is looking at, so they must
	// be able to read it; whether they may remove the link is asked of the
	// board of the end that waits. The `api:dependency_removed` entry goes on
	// that board, naming this card where it is on that board and otherwise the
	// card that waits. The work is `removeWorkDependency` (card 2012).
	const { removed } = writeAs(locals, (caller) =>
		removeWorkDependency(caller, { kind: 'card', id: cardId }, body, { source: 'api', says: NO_ACCESS })
	);

	return json({ success: true, removed });
};
