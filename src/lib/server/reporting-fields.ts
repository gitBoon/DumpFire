/**
 * reporting-fields — the five facts a management report needs that a card's own
 * text cannot supply.
 *
 * Card titles and descriptions are written for engineers, which is correct: they
 * are what someone picking the work up has to read. But a report for senior
 * management cannot use them, so the first 30-day report was built by
 * hand-writing 196 plain-English summaries — about 18 minutes of the work, and
 * a judgement call on every line that nobody could check afterwards.
 *
 * Two of these fields fix outright wrong reporting rather than slow reporting:
 *
 * - `closeReason` — delivered, not needed, superseded and parked all land in the
 *   Complete column and are indistinguishable once there, so a headline count of
 *   completions overstates what was actually built. The first report had to open
 *   individual cards to find the eight that were closed with nothing built.
 * - `releaseState` — "done" means the development is finished, which is not the
 *   same as customers having it. Reports that blur the two promise things that
 *   have not shipped.
 *
 * Every field is optional everywhere. A card that records none of them reports
 * as "not recorded", which is honest and useful; a required field would be
 * filled in with whatever gets the dialog closed.
 */

import {
	CLOSE_REASONS,
	THEMES,
	RELEASE_STATES,
	CUSTOMER_IMPACTS,
	SUMMARY_MAX,
	type ReportingFields
} from '$lib/reporting';

export {
	CLOSE_REASONS,
	THEMES,
	RELEASE_STATES,
	CUSTOMER_IMPACTS,
	SUMMARY_MAX,
	type ReportingFields
};
export type { CloseReason, Theme, ReleaseState } from '$lib/reporting';


export class ReportingFieldError extends Error {}

/** Case-insensitive match against a fixed vocabulary, returning the canonical spelling. */
function oneOf<T extends readonly string[]>(
	value: string,
	allowed: T,
	field: string
): T[number] {
	const hit = allowed.find((a) => a.toLowerCase() === value.toLowerCase());
	if (!hit) {
		throw new ReportingFieldError(
			`${field} must be one of: ${allowed.join(', ')} (got "${value}")`
		);
	}
	return hit;
}

/**
 * `live customers: Quickline` → prefix `live customers`, detail preserved.
 * The prefix is canonicalised so reports can group on it; the detail is kept
 * exactly as written, because it names real customers.
 */
function customerImpactOf(value: string): string {
	const sep = value.indexOf(':');
	const head = (sep === -1 ? value : value.slice(0, sep)).trim();
	const tail = sep === -1 ? '' : value.slice(sep + 1).trim();
	const canonical = oneOf(head, CUSTOMER_IMPACTS, 'customerImpact');
	return tail ? `${canonical}: ${tail}` : canonical;
}

/**
 * Read the reporting fields out of a request body.
 *
 * Only fields actually present are returned, so this can be spread into both an
 * insert and a partial update without a missing key clobbering a stored value.
 * An explicit `null` clears a field — that is how a value recorded in error gets
 * removed, and it has to be distinguishable from "not mentioned".
 *
 * @throws {ReportingFieldError} when a value is outside its vocabulary. Callers
 * turn this into a 400: a silently dropped invalid value would report as "not
 * recorded" and look identical to never having been set.
 */
export function normaliseReportingFields(body: Record<string, unknown>): ReportingFields {
	const out: ReportingFields = {};

	const read = (key: keyof ReportingFields, parse: (v: string) => string) => {
		if (!(key in body)) return;
		const raw = body[key];
		if (raw === null || raw === '') {
			out[key] = null;
			return;
		}
		if (typeof raw !== 'string') {
			throw new ReportingFieldError(`${key} must be a string or null`);
		}
		const trimmed = raw.trim();
		out[key] = trimmed === '' ? null : parse(trimmed);
	};

	read('summary', (v) => {
		if (v.length > SUMMARY_MAX) {
			throw new ReportingFieldError(
				`summary must be ${SUMMARY_MAX} characters or fewer — it is quoted verbatim into report appendices (got ${v.length})`
			);
		}
		return v;
	});
	read('theme', (v) => oneOf(v, THEMES, 'theme'));
	read('customerImpact', customerImpactOf);
	read('closeReason', (v) => oneOf(v, CLOSE_REASONS, 'closeReason'));
	read('releaseState', (v) => oneOf(v, RELEASE_STATES, 'releaseState'));

	return out;
}
