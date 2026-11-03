import { isHttpError, json } from '@sveltejs/kit';
import { addressToCount } from '$lib/server/client-address';
import { refuseWrongLink } from '$lib/server/decision-view';
import { recordSeenByLink } from '$lib/server/decisions';
import { readBody } from '$lib/server/request-body';
import { requireSameOriginJson } from '$lib/server/same-origin';
import { writeAs } from '$lib/server/write-as';
import { tooManyWrongLinks } from '$lib/decision-words';
import type { RequestHandler } from './$types';

/**
 * POST /api/decision-by-link/seen — record that a link holder has seen a
 * version (card 2677, decisions 4, 9 and 14): `{ token, versionNumber, stage }`.
 * The page sends it after the person's first genuine action, never on load.
 * A public route, with the token in the body, as
 * `POST /api/decision-by-link/responses` is, and refused and limited as it
 * is: same-origin JSON only first, the one 404 for any link that opens no
 * decision, and a 429 with `Retry-After` past the wrong-link limit.
 */
export const POST: RequestHandler = async ({ request, url, locals, getClientAddress }) => {
	requireSameOriginJson({ request, url });
	const address = addressToCount({ getClientAddress });
	const body = await readBody(request);
	const token = typeof body.token === 'string' ? body.token : '';

	try {
		const answer = writeAs(locals, (caller) => recordSeenByLink(caller, { token }, body, { source: 'ui' }));
		return json(answer);
	} catch (thrown) {
		if (!isHttpError(thrown, 404)) throw thrown;
		const { limited, retryAfterSecs } = refuseWrongLink(address);
		if (!limited) throw thrown;
		return json({ message: tooManyWrongLinks(retryAfterSecs) }, { status: 429, headers: { 'Retry-After': String(retryAfterSecs) } });
	}
};
