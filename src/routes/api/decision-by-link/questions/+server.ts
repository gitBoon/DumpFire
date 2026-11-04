import { isHttpError, json } from '@sveltejs/kit';
import { addressToCount } from '$lib/server/client-address';
import { refuseWrongLink } from '$lib/server/decision-view';
import { askQuestionByLink } from '$lib/server/decisions';
import { readBody } from '$lib/server/request-body';
import { requireSameOriginJson } from '$lib/server/same-origin';
import { writeAs } from '$lib/server/write-as';
import { tooManyWrongLinks } from '$lib/decision-words';
import type { RequestHandler } from './$types';

/**
 * POST /api/decision-by-link/questions — a link holder's clarification
 * question (card 2678, decisions 12, 13 and 17): `{ token, question }`, the
 * body of `POST /api/decisions/:id/questions` with the personal link's token
 * beside it. A public route: the token decides, and nobody is signed in by it.
 * The token is in the body and the path is fixed, so no address the log
 * keeps holds it.
 *
 * Same-origin JSON only, before anything else. A token that is not text is
 * sent on as `''`, which opens no decision. Any link that opens none is the
 * one 404 (`DEAD_DECISION_LINK`), counted against the caller's address; past
 * the limit it is a 429 with `Retry-After` (card 2677, decision 8). A link
 * that works is never counted, whatever else refuses the question (its 400,
 * 409 or 429). The answer is `{ question }`, with no id.
 */
export const POST: RequestHandler = async ({ request, url, locals, getClientAddress }) => {
	requireSameOriginJson({ request, url });
	const address = addressToCount({ getClientAddress });
	const body = await readBody(request);
	const token = typeof body.token === 'string' ? body.token : '';

	try {
		const answer = writeAs(locals, (caller) => askQuestionByLink(caller, { token }, body, { source: 'ui' }));
		return json(answer);
	} catch (thrown) {
		if (!isHttpError(thrown, 404)) throw thrown;
		const { limited, retryAfterSecs } = refuseWrongLink(address);
		if (!limited) throw thrown;
		return json({ message: tooManyWrongLinks(retryAfterSecs) }, { status: 429, headers: { 'Retry-After': String(retryAfterSecs) } });
	}
};
