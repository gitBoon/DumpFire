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
 * The 403 for a participant `reachOf` no longer reaches through their account
 * (card 2677, decision 10, D12): the participant writes' refusal, and card
 * 2678's questions read's (moved here from decisions.ts, unchanged, so that
 * both say it in the same words).
 */
export const NO_LONGER_REACHED = 'This decision no longer reaches you as a participant: ask whoever sent it to you';

/**
 * The 429 for an address past its limit of links that open no decision (card
 * 2677, decision 8), on the link's page and on both of its routes alike: the
 * wait, `retryAfterSecs`, in whole minutes.
 */
export const tooManyWrongLinks = (retryAfterSecs: number) =>
	`Too many links that do not work were tried from your network. Try again in ${Math.ceil(retryAfterSecs / 60)} minute(s).`;

// ─── The who-sees statement, and its version (card 2679, decisions 21 and 25) ─

/**
 * The version of the who-sees statement, `whoSeesStatement`'s words. The page
 * sends it with every response, and `responded` records it, so that a
 * response given under words that promised no totals is never released (S1).
 * Version 1 was the statement before card 2679, which said nothing of a
 * release. Any change to the statement's words moves this version on.
 */
export const WHO_SEES_STATEMENT_VERSION = 2;

/** What the participant page tells a consulted participant of who sees their response, `decider` the decider's name. */
export const whoSeesStatement = (decider: string) =>
	`While this decision is open, only ${decider}, who decides, sees your response. DumpFire's administrators can also see it in the record. ` +
	'No other participant sees it, or any totals. ' +
	'After the ruling, the decider may show the totals and the comments, without names, to everyone who can see this decision.';

// ─── The ruling and its release (card 2679) ──────────────────────────────────

/**
 * A released figure the server withheld (decision 10; code review S3): a
 * cell of 1 or 2, one within 2 of everyone, one beside another release in the
 * supersede chain, a mean whose scores could single someone out, or the
 * number who responded. It says no number, as any number would say something
 * of the figure.
 */
export const WITHHELD = 'withheld';

/** A released figure as every page shows it (code review F3): the number, or `WITHHELD`. */
export const releasedFigure = (value: number | null) => (value === null ? WITHHELD : String(value));

/**
 * What the release dialog says before the decider releases (decision 26, S5):
 * "against" is shown to nobody else, but can be worked out once the totals are
 * shown beside the public ruling.
 */
export const RELEASE_INFERENCE =
	'Once released, anyone who can see this decision can work out from the totals whether the ruling followed the most chosen option. This cannot be undone.';

/** The 409 for a concern raised past `ruled_at` plus 90 days, signed in (decision 4). */
export const CONCERN_WINDOW_ENDED = 'A concern about this ruling could be raised for 90 days after it: that time has ended';

/** The 409 for a concern on a ruling that has been superseded (decision 4). */
export const CONCERN_SUPERSEDED = 'This ruling has been superseded: raise a concern on the decision that superseded it';

/** What the concern form tells a participant of who sees a concern (decision 4, F5): the release never carries one. */
export const CONCERN_WHO_SEES = "The decider and DumpFire's administrators see your concern with your name. A release of the results never includes concerns.";

// ─── Clarification questions: the writes' refusals (card 2678, decisions 10 and 17) ─

/**
 * The 409 for a question asked on a ruled decision (decision 10, S9): after
 * the ruling, a concern about it is the way to speak. A superseded or
 * withdrawn decision is refused in `requireTransition`'s words, which point
 * to no concern, as none can be raised there.
 */
export const QUESTIONS_CLOSED = 'This decision has been ruled: questions are closed. You can raise a concern about the ruling instead';

/** The 409 for a second answer to a question, and for any answer to one a person's answer settled (decision 7). */
export const ANSWERED = 'This question has been answered';

/** The 409 for an answer to a question an agent's draft waits on, without replacing the draft (decision 17). */
export const DRAFT_PENDING = 'An agent has drafted an answer to this question: publish it or replace it';

/** The 409 for replacing a draft where no agent's draft waits on the question (decision 17). */
export const NO_DRAFT = "No agent's draft waits on this question: there is nothing to replace";

/** The 409 for publishing an answer to a question that has none (decision 17). */
export const NOTHING_TO_PUBLISH = "This question has not been answered: there is no agent's draft to publish";

/** The 409 for publishing a person's answer, a replaced draft among them (decision 17): only an agent's draft is published. */
export const PERSON_ANSWERED = "This question was answered by a person: there is no agent's draft to publish";

/** The 409 for publishing an agent's draft a second time (decision 17). */
export const ALREADY_PUBLISHED = "This agent's answer has already been published";

// ─── The agent-drafted label (card 2712, folded into card 2678, decision 20) ─

/**
 * The label on what an agent drafted through an API key and no person has
 * reviewed yet: a decision's section or option, on the participant page and
 * in the editor, and an agent's draft of an answer, which only the author,
 * the decider and administrators see. `AgentLabel` draws it; nothing else
 * writes these words.
 */
export const AGENT_UNREVIEWED = 'Drafted by an agent and not yet reviewed by a person';

/** The label on an agent's draft of an answer that a person published (decision 8): it shows to everyone with it. */
export const AGENT_REVIEWED = 'Drafted by an agent and reviewed by a person';

/**
 * What the results page says beside its open questions to a viewer who may
 * not answer them now (decision 9, F11): an administrator who is neither the
 * author nor the decider, or a decider who has lost board edit. No link.
 */
export const RESULTS_ANSWER_ELSEWHERE = "The author or the decider answers questions on the decision's page";

/**
 * What the results page says beside its open questions once none can be
 * answered (decision 10; code review F3): "Not answered before the ruling" on
 * a ruled or superseded decision, "…before the withdrawal" on a withdrawn
 * one, and "Questions are closed" on any other that takes no answer; null
 * while the decision is open or awaiting its ruling, when the link or
 * `RESULTS_ANSWER_ELSEWHERE` is shown instead.
 */
export function resultsQuestionsClosedWords(shownStatus: string): string | null {
	if (shownStatus === 'open' || shownStatus === 'awaiting_ruling') return null;
	if (shownStatus === 'ruled' || shownStatus === 'superseded') return unansweredWords('ruling');
	if (shownStatus === 'withdrawn') return unansweredWords('withdrawal');
	return 'Questions are closed';
}

// ─── Clarification questions: the panel and the form (card 2678, decisions 2, 8, 10, 13 and 21) ─

/**
 * The label on a question asked through an API key (decision 8, S8): shown
 * only to the author, the decider, administrators and the asker, since to
 * anyone else it would say something about who asked.
 */
export const ASKED_BY_AGENT = "Asked by an agent on the participant's behalf";

/** What the question form tells a participant of who sees a question, before Send (decision 13, S8). */
export const QUESTION_WHO_SEES =
	'Everyone included in this decision sees your question and its answer, without your name. ' +
	"The decider, the author and DumpFire's administrators see your name. " +
	'In a decision with only a few people, others may be able to guess who asked.';

/** What the panel says of a question no person's answer stands behind (decision 10): open, or left unanswered by the ruling or the withdrawal. */
export const unansweredWords = (closedBy: 'ruling' | 'withdrawal' | null) =>
	closedBy === 'ruling' ? 'Not answered before the ruling' : closedBy === 'withdrawal' ? 'Not answered before the withdrawal' : 'Not answered yet';

/** "Asked about version N", for a question asked about a version older than the one shown; null otherwise. */
export const askedInWords = (askedInVersion: number, shownVersion: number | undefined) =>
	shownVersion !== undefined && askedInVersion < shownVersion ? `Asked about version ${askedInVersion}` : null;

/**
 * Who answered, and in which role, as the answer's event recorded it
 * (decision 19, S7): "Answered by Ann, the author". An answer whose event
 * recorded no role names the answerer alone.
 */
export const answeredByWords = (name: string, role: 'author' | 'decider' | null) =>
	role === null ? `Answered by ${name}` : `Answered by ${name}, the ${role}`;

/**
 * The refusal of a participant's question past the most one may ask on a
 * decision, `max` (decision 4; code review F5): the server's 409 and the
 * closed question form's words alike, written once.
 */
export const questionsLimitWords = (max: number) => `You have asked ${max} questions on this decision: no more can be asked`;

/**
 * Why the question form offers no textarea (decision 21, F4): the
 * participant has asked as many as one may, the decision is ruled,
 * superseded or withdrawn, or it cannot take their question now for another
 * reason (a personal link past its time, or a participant no longer reached).
 */
export function questionsClosedWords(ownQuestions: number, max: number, shownStatus: string): string {
	if (ownQuestions >= max) return `${questionsLimitWords(max)}.`;
	if (shownStatus === 'ruled' || shownStatus === 'superseded' || shownStatus === 'withdrawn') return 'Questions on this decision are closed.';
	return 'You cannot ask a question on this decision now.';
}

/** The answer field's and Send's names for the question shown `n`th (decision 21, F6). */
export const answerFieldName = (n: number) => `Answer to question ${n}`;
export const sendAnswerName = (n: number) => `Send answer to question ${n}`;

/** The publish control's name for the question shown `n`th (decision 21, F6): an agent's draft alone is published. */
export const publishDraftName = (n: number) => `Publish the agent's answer to question ${n}`;

/** The replace control's name, and its field's, for the question shown `n`th (decision 21, F6). */
export const replaceDraftName = (n: number) => `Replace the agent's answer to question ${n}`;
export const replaceFieldName = (n: number) => `Your answer in place of the agent's, to question ${n}`;

/**
 * The participant page's note on what its seen watch records (card 2677,
 * decision 14): the ruling on a ruled or superseded decision (card 2679,
 * decision 9), this version otherwise.
 */
export const seenNoteWords = (stage: 'question' | 'ruling' | 'withdrawal') =>
	`Your first tap, click, key press or turn of the mouse wheel on this page is recorded as your having seen ${stage === 'ruling' ? 'the ruling' : 'this version'}.`;

/** The ruled banner's first line (decision 9): who ruled, and on what. No moment. */
export function rulingWords(ruling: { label: string | null; title: string | null; noneOfThese: boolean; ruledByName: string }): string {
	if (ruling.noneOfThese || ruling.label === null) return `Ruled by ${ruling.ruledByName}: None of these`;
	return `Ruled by ${ruling.ruledByName}: Option ${ruling.label}${ruling.title ? `: ${ruling.title}` : ''}`;
}

/**
 * The line on a decision a later one supersedes, or was ruled on beside it
 * (decision 5, S8): its title only where the viewer may view it.
 */
export function laterDecisionWords(later: { superseded: boolean; title?: string }): string {
	if (later.superseded) return later.title === undefined ? 'Superseded by a later decision' : `Superseded by ${later.title}`;
	return later.title === undefined
		? 'A later decision was ruled on without superseding this one'
		: `A later decision, ${later.title}, was ruled on without superseding this one`;
}

/** The line on a decision that supersedes another (decision 5, S8): the earlier one's title only where the viewer may view it. */
export const earlierDecisionWords = (earlier: { title?: string }) =>
	earlier.title === undefined ? 'This decision supersedes an earlier decision' : `This decision supersedes ${earlier.title}`;

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
