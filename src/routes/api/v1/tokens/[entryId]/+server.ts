import { json } from '$lib/server/v1-json';
import { removeTokenEntry } from '$lib/server/token-service';
import { pathId } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * DELETE /api/v1/tokens/:entryId — remove one ledger entry.
 *
 * For an over-report, a negative entry is usually the better correction: it
 * leaves the original visible, so the history still shows what was believed at
 * the time. Use this for an entry that should never have existed at all — one
 * posted against the wrong card, say.
 *
 * The work is `removeTokenEntry` in `$lib/server/token-service` (card 2012).
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireUser(locals.user);

	const entryId = pathId(params.entryId, 'entry');

	// The entry read, the caller checked, the entry removed and the card's
	// total read in one transaction that asks first whether the key or session
	// is still open, and who its account is now (card 2253). The board is told
	// once it has committed.
	const { cardId, total } = writeAs(locals, (caller) => removeTokenEntry(caller, { entryId }, null, { source: 'api' }));
	return json({ deleted: entryId, cardId, recorded: total.entries > 0, ...total });
};
