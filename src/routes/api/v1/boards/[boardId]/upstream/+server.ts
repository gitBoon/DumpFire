import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { pathId, readQueryCount } from '$lib/server/request-body';
import { requireBoard } from '$lib/server/route-guards';
import { committedAll, upstreamFigures } from '$lib/server/upstream';
import { stamp } from '$lib/timestamps';
import type { RequestHandler } from './$types';

/** The longest window asked for, in days: a year, as the board's own metrics allow. */
const MAX_DAYS = 365;

/** The refusal of a `days` that is not a whole number from 1 to `MAX_DAYS`, written out so that the OpenAPI document's example of it can be found. */
const DAYS_REFUSAL = 'days must be a whole number from 1 to 365';

/**
 * GET /api/v1/boards/:boardId/upstream — what happened upstream of the
 * commitment point on one board over a window, and the options it holds now
 * (milestone 22, card 2464, item 5).
 *
 * View access to the board: 404 for a board that is not there, to everyone,
 * then 403 for one the caller cannot open, as every read of a board answers.
 * `days` is the window, ending now, both ends included as `upstreamFigures`
 * takes them (the S3 review's E4): a whole number from 1 to 365, 30 when it is
 * not sent or empty, and anything else 400. The figures are
 * `upstreamFigures`'s, the ones the board's Stats panel shows from
 * `GET /api/boards/:id/metrics`, which asks the same function: options now and
 * their aging, committed from options, returned to options, discarded, sent
 * on, abandoned and the discard rate. Beside them `committedAll`, "Committed
 * (all)", the cards that arrived as committed work in the window, the arrival
 * figure the panel puts beside throughput (ruling d). An ideas board answers
 * the same figures: every card on it is an option.
 *
 * Nothing is written: a read, with no entry.
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	const boardId = pathId(params.boardId, 'board');
	// A board that is not there is 404 to everyone, then one the caller cannot open 403.
	const board = requireBoard(locals.user, boardId, 'view');

	const days = readQueryCount(url.searchParams.get('days'), 'days', { fallback: 30, says: DAYS_REFUSAL });
	if (days < 1 || days > MAX_DAYS) error(400, DAYS_REFUSAL);

	// In the stored form, as the activity log's moments are (card 2095): the
	// window's two ends compare with them as text. Answered in ISO 8601, as
	// every moment is (`$lib/server/v1-json`).
	const now = Date.now();
	const from = stamp(new Date(now - days * 86400000));
	const to = stamp(new Date(now));

	return json({
		boardId: board.id,
		kind: board.kind,
		days,
		period: { from, to },
		...upstreamFigures([board.id], from, to, now),
		committedAll: committedAll([board.id], from, to)
	});
};
