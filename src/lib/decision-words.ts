/**
 * decision-words.ts — words about a decision that the server and the browser
 * both use (card 2676, the code review's C6 and C7). Plain constants and
 * functions with no imports, so a module the browser loads can use them, as
 * `mail-words.ts` is used.
 */

/**
 * The 409 for a revision that is not the decision's as it is now (decision
 * 10). The editor and the picker offer Reload on these words alone: any other
 * refusal keeps the edits and offers nothing that would throw them away.
 */
export const STALE_REVISION = 'This decision was changed since you opened it: reload it to see the change';

/** A decision's shown status, as the list and the editor name it. */
export const STATUS_WORDS: Readonly<Record<string, string>> = {
	draft: 'Draft',
	open: 'Open',
	awaiting_ruling: 'Awaiting ruling',
	ruled: 'Ruled',
	superseded: 'Superseded',
	withdrawn: 'Withdrawn'
};

/** A stored moment as a page shows it, to the minute, in UTC; `unset` where there is none. */
export const shownMoment = (at: string | null, unset: string) => (at === null ? unset : `${at.slice(0, 16)} UTC`);
