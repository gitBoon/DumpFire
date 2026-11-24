/**
 * decision-export-writes.ts — the entry a full record's PDF writes on the
 * decision's record (card 2688, R5, R6): `recordExport`, called by the PDF
 * route in a `writeAs` of its own once the PDF is drawn, outside any
 * transaction, from the projection `readFullExport` read (decision-export.ts).
 *
 * The shareable copy writes nothing: it holds only what every viewer of the
 * decision already sees. No activity entry, no live event, no mail and no
 * webhook: the entry is a record event, seen by the decider and
 * administrators on the record view and by their API keys on the v1 record
 * (A10), and webhooks are sent from board activity actions alone (R5, S-L5).
 *
 * Each write has the one shape of a service, as decision-write-shared.ts's
 * header says.
 */
import { error } from '@sveltejs/kit';
import type { SessionUser } from './auth';
import { actorFor, appendEvent } from './decision-record';
import { keyed, sourceOf } from './decision-write-shared';
import { requireDecision, requireUser } from './route-guards';
import { DRAFT_NOT_EXPORTED, EXPORT_CHANGED } from '$lib/decision-words';
import type { Stamp } from '$lib/timestamps';
import { inWrite, type ServiceOptions } from './write-as';

/** The one export here is a write, and starts with `inWrite()`. */
export const READS: readonly string[] = [];

/**
 * Note a full record taken as a PDF on the decision's record (R5, R6.5): one
 * `record_exported` event naming no participant, `version_number` the version
 * drawn, detail `{}`, by the exporter through the page.
 *
 * Inside the write's transaction it asks again what the drawing was let in
 * by, so that access lost between the read and this write refuses and nothing
 * is noted (or handed over): `record` (404, then 403), an API key refused
 * (403, R2), a draft (409); and then whether the decision is still as it was
 * drawn, its current version, stored status, `updatedAt` and the moment its
 * results were released (card 2688's code review, E-L2: a release does set
 * `updatedAt`, but to the second, so on its own it would miss a release in the
 * same second as the change before it) all equal to `drawn`'s, else 409
 * `EXPORT_CHANGED` (E-L1, S-L4), so that the entry names exactly what was
 * handed over.
 */
export function recordExport(
	caller: SessionUser | null,
	at: { decisionId: number },
	drawn: { versionNumber: number; status: string; updatedAt: Stamp; resultsReleasedAt: Stamp | null },
	opts: ServiceOptions
): void {
	inWrite();
	const user = requireUser(caller);
	const { decision } = requireDecision(user, at.decisionId, 'record');
	if (keyed(opts)) error(403, "A decision's full record is exported on its page: an API key cannot");
	if (decision.status === 'draft') error(409, DRAFT_NOT_EXPORTED);
	if (
		decision.currentVersion !== drawn.versionNumber ||
		decision.status !== drawn.status ||
		decision.updatedAt !== drawn.updatedAt ||
		decision.resultsReleasedAt !== drawn.resultsReleasedAt
	) {
		error(409, EXPORT_CHANGED);
	}
	appendEvent({ decisionId: decision.id, kind: 'record_exported', versionNumber: drawn.versionNumber, detail: {} }, actorFor(user, sourceOf(opts)));
}
