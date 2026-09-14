/**
 * reporting — the vocabularies behind the card reporting fields.
 *
 * Shared by the server (which validates against them) and the card modal (which
 * offers them), so the list a person picks from and the list the API accepts
 * cannot drift apart. That drift is how a field ends up with six spellings of
 * "maintenance" and stops being groupable at all.
 *
 * The reasoning for each field lives in `$lib/server/reporting-fields.ts`,
 * alongside the validation.
 */

/** Why a card left the board. All four look identical in a Complete column. */
export const CLOSE_REASONS = ['delivered', 'not needed', 'superseded', 'parked'] as const;

/** What kind of work it was. Drives the prose sections of a report. */
export const THEMES = [
	'new capability',
	'customer issue',
	'security & compliance',
	'maintenance'
] as const;

/** How far the work has actually travelled towards customers. */
export const RELEASE_STATES = ['built', 'on UAT', 'live'] as const;

/**
 * Who felt it. Free text is allowed after a recognised prefix, so
 * "live customers: Quickline" is valid and reports can name them.
 */
export const CUSTOMER_IMPACTS = ['none', 'internal', 'live customers'] as const;

export type CloseReason = (typeof CLOSE_REASONS)[number];
export type Theme = (typeof THEMES)[number];
export type ReleaseState = (typeof RELEASE_STATES)[number];

/**
 * Summaries are quoted verbatim into report appendices, one per table row.
 * The guidance is ~12 words; the cap is generous enough not to truncate a
 * careful sentence and tight enough to reject a pasted description.
 */
export const SUMMARY_MAX = 200;

/** The five reporting fields, as they travel between client and API. */
export interface ReportingFields {
	summary?: string | null;
	theme?: string | null;
	customerImpact?: string | null;
	closeReason?: string | null;
	releaseState?: string | null;
}

/** Short help shown next to each field, so the vocabulary explains itself. */
export const FIELD_HINTS = {
	summary: 'Plain English, about 12 words. Quoted straight into the report appendix.',
	theme: 'What kind of work this was.',
	customerImpact: 'Who felt it. Add a colon to name customers, e.g. "live customers: Quickline".',
	closeReason: 'Why it left the board. Without this, work that was dropped counts as delivered.',
	releaseState: 'How far it has travelled. "Built" is not the same as customers having it.'
} as const;
