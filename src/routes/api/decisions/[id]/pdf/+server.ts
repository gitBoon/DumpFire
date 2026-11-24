import { error, json } from '@sveltejs/kit';
import { BodyReadTimedOut, readBodyWithin } from '$lib/server/body-limits';
import { readFullExport, readShareableExport, requireExportable, type DecisionExport } from '$lib/server/decision-export';
import { recordExport } from '$lib/server/decision-export-writes';
import {
	decisionPdfFilename,
	EXPORT_READ_DEADLINE_MS,
	EXPORT_WINDOW_MS,
	exportAllowanceKey,
	EXPORTS_AN_HOUR,
	generateDecisionPdf,
	holdDrawing
} from '$lib/server/decision-report';
import { createLogger } from '$lib/server/logger';
import { allowanceState, takeAllowance } from '$lib/server/rate-limit';
import { pathId, readBody, readChoice, type RequestBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import { EXPORT_BUSY, exportLateWords, exportsSpentWords } from '$lib/decision-words';
import { stamp } from '$lib/timestamps';
import type { RequestHandler } from './$types';

const log = createLogger('DECISIONS');

/** The two copies (card 2688, R1): the shareable copy, `view`'s; the full record, `record`'s. */
const COPIES = ['full', 'shareable'] as const;

/** The 429 past the account's hour, naming when the next export may be taken. */
const spent = (retryAfterSecs: number) => exportsSpentWords(EXPORTS_AN_HOUR, stamp(new Date(Date.now() + retryAfterSecs * 1000)));

/**
 * POST /api/decisions/:id/pdf — a decision as a PDF, downloaded on its page
 * (card 2688): `{ copy: 'full' | 'shareable' }`, required. Session only: an
 * API key never reaches an internal route (R2). In order (R6, decision 25;
 * card 2688's code review, S-M1):
 *
 *   1. the session (401), the decision's id (400);
 *   2. the body read, given `EXPORT_READ_DEADLINE_MS` to arrive
 *      (`readBodyWithin`, as an upload's read is, card 2910): past it 408 with
 *      `Connection: close`, nothing counted or held. Nothing is held while it
 *      is read, so a body that trickles in keeps nobody else from exporting;
 *   3. a writeAs, read only: `copy` (400 naming it); the account's hour, 20
 *      exports of either copy, looked at with nothing taken (`allowanceState`,
 *      429 naming when the next may be taken), before anything is read; and
 *      whether the caller may take that copy (`requireExportable`: the full
 *      record `record`, 404 then 403; the shareable copy `view`, 404; either
 *      409 for a draft). The server never hands one copy in place of the
 *      other;
 *   4. the one place on the server where a decision's PDF is drawn
 *      (`holdDrawing`, R9a), taken only now, so that a caller refused above
 *      never holds it: held by another export, 503 with `Retry-After: 10` and
 *      `EXPORT_BUSY`, nothing counted. The `try` whose `finally` gives it back
 *      opens on the next line, and closes once the PDF is drawn;
 *   5. a writeAs, read only, run with no turn of the event loop since 3: the
 *      hour taken (`takeAllowance`), then the projection, which guards itself
 *      again: `readFullExport` or `readShareableExport`;
 *   6. the PDF drawn outside any transaction (`generateDecisionPdf`, which
 *      gives the event loop back as it draws); the place given back;
 *   7. for the full record alone, a writeAs that notes the export on the
 *      decision's record (`recordExport`): it asks `record` and "not a draft"
 *      again, and refuses 409 `EXPORT_CHANGED` where the decision's version,
 *      status, `updatedAt` or release moved while the copy was drawn, so that
 *      the entry names exactly what is handed over and nothing leaves without
 *      it;
 *   8. one INFO line (R15: ids, copy, pages, whether the ceiling stopped it;
 *      no title, no content), and the PDF as an attachment named by
 *      `decisionPdfFilename`. `Cache-Control: no-store` and `X-Robots-Tag`
 *      are the route's `UNPUBLISHED_HEADERS` (`ROUTE_HEADERS`).
 *
 * The refusals come in the order they did before the code review, but for the
 * 503, which now follows the access checks. A drawing that fails is a 500 with
 * no entry; the place is given back however the drawing ends.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'decision');

	let body: RequestBody;
	try {
		body = await readBodyWithin(request, EXPORT_READ_DEADLINE_MS, () => readBody(request));
	} catch (failed) {
		if (failed instanceof BodyReadTimedOut) {
			return json({ message: exportLateWords(EXPORT_READ_DEADLINE_MS / 1000) }, { status: 408, headers: { Connection: 'close' } });
		}
		throw failed;
	}

	const copy = writeAs(locals, (caller) => {
		const user = requireUser(caller);
		const asked = readChoice(body, 'copy', { required: true, from: COPIES });
		const hour = allowanceState(exportAllowanceKey(user.id), EXPORTS_AN_HOUR, EXPORT_WINDOW_MS, Date.now());
		if (hour.used >= EXPORTS_AN_HOUR) error(429, spent(hour.retryAfterSecs));
		requireExportable(user, id, asked);
		return asked;
	});

	const release = holdDrawing();
	if (release === null) return json({ message: EXPORT_BUSY }, { status: 503, headers: { 'Retry-After': '10' } });
	let exported: DecisionExport;
	let userId: number;
	let drawing: Awaited<ReturnType<typeof generateDecisionPdf>>;
	try {
		({ exported, userId } = writeAs(locals, (caller) => {
			const user = requireUser(caller);
			const took = takeAllowance(exportAllowanceKey(user.id), 1, EXPORTS_AN_HOUR, EXPORT_WINDOW_MS);
			if (!took.taken) error(429, spent(took.retryAfterSecs));
			const projection: DecisionExport = copy === 'full' ? readFullExport(user, id) : readShareableExport(user, id);
			return { exported: projection, userId: user.id };
		}));
		drawing = await generateDecisionPdf(exported);
	} finally {
		release();
	}
	const { pdf, pages, stopped } = drawing;

	if (exported.copy === 'full') {
		const drawn = exported.drawn;
		writeAs(locals, (caller) => recordExport(caller, { decisionId: id }, drawn, { source: 'ui' }));
	}

	log.info(
		`Decision ${exported.decision.id} exported as a PDF, the ${exported.copy === 'full' ? 'full record' : 'shareable copy'}, by account ${userId}: ` +
			`${pages} pages${stopped ? ', stopped at the ceiling' : ''}`,
		{ decisionId: exported.decision.id, copy: exported.copy, pages, stopped },
		{ userId }
	);
	const filename = decisionPdfFilename(exported.decision.id, exported.decision.title, exported.copy, exported.exporter.date);
	return new Response(new Uint8Array(pdf), {
		status: 200,
		headers: {
			'Content-Type': 'application/pdf',
			'Content-Disposition': `attachment; filename="${filename}"`,
			'Content-Length': String(pdf.length)
		}
	});
};
