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

/**
 * The one answer to a personal link that does not open a decision (card
 * 2677, decision 6): unknown, expired, revoked and no longer reaching its
 * holder alike, on the page and on both of its routes, so that the answer
 * says nothing of the decision or the person.
 */
export const DEAD_DECISION_LINK =
	'This link does not open a decision. It may have expired, or a newer email may have replaced it. Ask whoever sent it to you for a new one.';

/**
 * The 429 for an address past its limit of links that open no decision (card
 * 2677, decision 8), on the link's page and on both of its routes alike: the
 * wait, `retryAfterSecs`, in whole minutes.
 */
export const tooManyWrongLinks = (retryAfterSecs: number) =>
	`Too many links that do not work were tried from your network. Try again in ${Math.ceil(retryAfterSecs / 60)} minute(s).`;

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

/**
 * The participant page's banner (card 2677, decision 19, D8): when the
 * participant was told of the decision, from their latest record mail, and
 * "by email" only when that mail was recorded as delivered. A mail not yet
 * known to be delivered, or none, gives the neutral words, from when they were
 * included.
 */
export function toldWords(
	role: 'consulted' | 'informed',
	told: { kind: 'invited' | 'asked_again' | 'told_of_change'; at: string; delivered: boolean } | null,
	includedAt: string
): string {
	if (told === null || !told.delivered) return `You were included in this decision on ${shownMoment(includedAt, '')}.`;
	const at = shownMoment(told.at, '');
	if (told.kind === 'asked_again') return `This decision changed, and you were asked for your view again on ${at}, by email.`;
	if (told.kind === 'told_of_change') return `You were told of a change to this decision on ${at}, by email.`;
	if (role === 'informed') return `You were told of this decision on ${at}, by email, to keep you informed.`;
	return `You were asked for your view on this decision on ${at}, by email.`;
}

/** A withdrawn decision's banner, with the reason its withdrawal mail carries (decision 19). */
export const withdrawnWords = (at: string | null, reason: string | null) =>
	`This decision was withdrawn on ${shownMoment(at, 'a date not recorded')}${reason ? `: ${reason}` : '.'}`;

/**
 * The label of a participant's own response given on a version older than
 * the one shown (card 2677, code review C1), as after a re-publish that only
 * told of a change: "Given on version N." Null for one given on the version
 * shown, or where no version is shown.
 */
export const givenOnWords = (response: { versionNumber: number }, shownVersion: number | undefined) =>
	shownVersion !== undefined && response.versionNumber < shownVersion ? `Given on version ${response.versionNumber}.` : null;

/**
 * A participant's own response, as the page says it back, one line each: what
 * they chose, then their comment and each comment on an option. Plain text,
 * never markdown (decision 17). `options` are the options the page shows; one
 * no longer among them is named by what it was not.
 */
export function responseLines(
	response: { kind: string; optionId: number | null; scores: Record<string, number> | null; comment: string | null; optionComments: Record<string, string> },
	options: { optionId: number; label: string; title: string }[]
): string[] {
	const labelOf = (id: number) => options.find((option) => option.optionId === id)?.label ?? null;
	const lines: string[] = [];
	if (response.kind === 'abstain') lines.push('You abstained.');
	else if (response.kind === 'no_concerns') lines.push('You have no concerns.');
	else if (response.scores !== null) {
		const scored = Object.entries(response.scores).map(([id, score]) => `${labelOf(Number(id)) ?? 'an option no longer offered'} ${score}`);
		lines.push(`Your scores: ${scored.join(', ')}.`);
	} else if (response.optionId !== null) {
		const option = options.find((candidate) => candidate.optionId === response.optionId);
		lines.push(option === undefined ? 'You chose an option no longer offered.' : `You chose option ${option.label}${option.title ? `: ${option.title}` : ''}.`);
	}
	if (response.comment !== null && response.comment !== '') lines.push(`Your comment: ${response.comment}`);
	for (const [id, text] of Object.entries(response.optionComments)) lines.push(`On option ${labelOf(Number(id)) ?? 'no longer offered'}: ${text}`);
	return lines;
}
