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
 * What the results page says once a ruling or a release met `STALE_REVISION`
 * and the page read its data again (card 2734, D3 and D4): the results and
 * their revision drawn afresh together, what was chosen and typed kept.
 */
export const RESULTS_READ_AGAIN =
	'The results changed since you opened them and are now shown as they are: read them, then try again. What you chose and typed is kept.';

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
 * 2678's questions read's (moved here from the former decision service (card
 * 2713), unchanged, so that both say it in the same words).
 */
export const NO_LONGER_REACHED = 'This decision no longer reaches you as a participant: ask whoever sent it to you';

/**
 * What a mail that mints no link tells a link holder in its place (card
 * 2685's code review, F5): the closing-date reminder (`decision-mail.ts`) and
 * the answer notice (`notifications.ts`, card 2678) alike, so that both say
 * it in the same words. Neither mints a link, so the one in their latest
 * record mail stays the only one. Said only while the row holds a live link
 * and that mail was delivered (`mailedLinkOf`, card 2721): the reminder is
 * not sent otherwise, and the answer notice says `ASK_FOR_LINK_LINE` instead.
 */
export const LATEST_LINK_LINE = 'Open the decision from the personal link in the latest email you were sent about it.';

/**
 * What the answer notice tells a link holder in place of `LATEST_LINK_LINE`
 * where they may hold no working link (card 2721, D3): their link was ended,
 * by a restore among others, has lapsed, or the mail that carried it was not
 * delivered. The notice issues no link (D1); the author or the decider gives
 * a new one with Resend. Names roles, not people (card 2678, decision 5).
 */
export const ASK_FOR_LINK_LINE =
	'The personal link you were last sent may no longer open the decision. Ask its author or its decider to send you a new one.';

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

/**
 * What the participant page tells a consulted participant of who sees their response, `decider` the decider's name.
 *
 * Card 2683 (R10): on a round that puts no options to a vote (a survey), the page shows it without its last
 * sentence, the release one, as such a round releases nothing (`releases` false). The words of version 2 are not
 * changed, so the version recorded stays 2: changing them would hold back every release of responses given under them.
 */
export const whoSeesStatement = (decider: string, releases = true) =>
	`While this decision is open, only ${decider}, who decides, sees your response. DumpFire's administrators can also see it in the record. ` +
	'No other participant sees it, or any totals.' +
	(releases ? ' After the ruling, the decider may show the totals and the comments, without names, to everyone who can see this decision.' : '');

/**
 * What the page says beside a decision's survey questions (card 2683, R10), `decider` the decider's name now: the
 * role first, as the decider can change. Its own fixed words, not the versioned who-sees statement.
 *
 * Binding on a later card: one that wants to release answers, as totals or otherwise, must give this sentence a
 * version, record it with each response, and refuse to release answers given before it. A comment given with an
 * `answered` response is never releasable.
 */
export const surveyWhoSees = (decider: string) =>
	`Your answers to these questions are seen by whoever decides (now ${decider}) and DumpFire's administrators, with your name. ` +
	'Nobody else sees them, and they are never shown as totals. A decision that asks only questions releases nothing.';

/** What the page says under each box for a written answer (card 2683, R14): data minimisation. */
export const SURVEY_TEXT_NOTE =
	'Write only what the decider needs. Do not include personal details about yourself or anyone else that the question does not ask for.';

/** What a ruling says in place of "None of these" where the version ruled on put no options to a vote (card 2683, R18). */
export const NO_OPTIONS_PUT = 'No options were put to a vote';

/** The 409 for a release of a decision ruled on a version that put no options to a vote (card 2683, R11). */
export const NO_OPTIONS_TO_RELEASE = 'This decision put no options to a vote: there are no totals to release, and survey answers are never released';

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

// ─── Objections and requests to talk: the writes' refusals (card 2684, R3, R5) ─

/**
 * The 409 for an objection or a request to talk on a ruled decision (card 2684, R3): after the ruling, a concern about
 * it is the way to speak. A superseded or withdrawn decision is refused in `requireTransition`'s words.
 */
export const FLAGS_CLOSED = 'This decision has been ruled: objections and requests to talk are closed. You can raise a concern about the ruling instead';

/**
 * The 409 past the most objections, or requests to talk, one participant raises on one version (card 2684, R5): the
 * server's refusal and the closed form's words alike, written once.
 */
export const flagsLimitWords = (kind: 'objection' | 'talk', max: number) =>
	kind === 'objection'
		? `You have raised ${max} objections on this version of the decision: no more can be raised`
		: `You have asked to talk ${max} times on this version of the decision: no more can be asked`;

/** The 409 for a second request to talk while one has no outcome recorded (card 2684, R5). */
export const TALK_OPEN = 'You have asked to talk to the decider and no outcome is recorded yet: you can ask again once it is';

/** The 409 past the most objections and requests to talk one decision takes (card 2684, R5). */
export const flagsFullWords = (max: number) => `This decision has ${max} objections and requests to talk: no more can be raised. Speak to the decider directly`;

/** The 429 within the rest after a participant's last objection or request to talk (card 2684, R5), saying from when, in UTC. */
export const flagRestWords = (minutes: number, from: string) =>
	`Your last objection or request to talk was raised less than ${minutes} minutes ago: the next can be raised from ${from} UTC`;

/**
 * The ruling's 409 while objections have no answer (card 2684, R8), and the ruling form's note holding Rule off (R23):
 * written once, so the page says what the server would refuse.
 */
export const objectionsUnansweredWords = (count: number) =>
	count === 1 ? '1 objection has no answer: answer it before ruling' : `${count} objections have no answer: answer each before ruling`;

/** The ruling's 409 while requests to talk have no outcome recorded and the decider has not confirmed ruling with them open (card 2684, R8). */
export const talksOpenWords = (count: number) =>
	count === 1
		? '1 request to talk has no outcome recorded: confirm that you rule with it open'
		: `${count} requests to talk have no outcome recorded: confirm that you rule with them open`;

/** The ruling form's box for the same (card 2684, R23), beside the open questions' box. */
export const talksConfirmWords = (count: number) =>
	`${count === 1 ? '1 request to talk has' : `${count} requests to talk have`} no outcome recorded: I rule with ${count === 1 ? 'it' : 'them'} open`;

// ─── Objections and requests to talk: the pages (card 2684, R12, R16, R22 to R24) ─
// Every one is plain text: nothing a participant or the decider wrote is read as markdown.

/**
 * What the participant's forms say above them (card 2684, R12), `decider` the decider's name now: the role first, as
 * the decider can change, and a new one sees everything raised before (R11).
 */
export const flagWhoSees = (decider: string) =>
	`What you raise here is seen by whoever decides (now ${decider}) and DumpFire's administrators, with your name. ` +
	'Nobody else sees it, and it is never released. ' +
	'An objection must be answered before the decision is ruled on; it does not stop the decider ruling as they see fit.';

/** What the participant's forms say under each box (card 2684, R12, as card 2683 R14): data minimisation. */
export const FLAG_TEXT_NOTE = 'Write only what the decider needs. Do not include personal details about yourself or anyone else.';

/** What the results page says above the decider's reply box (card 2684, R12, S-L3), `name` the participant's. */
export const flagReplyWhoSees = (name: string) => `${name} reads this, and so does anyone holding their personal link.`;

/** What the results page says to a viewer who may not reply (card 2684, R7): an administrator, who reads them and replies to none. */
export const FLAG_REPLY_ELSEWHERE = 'Only whoever decides replies to objections and requests to talk.';

/** What the results page says of the flags with no reply on a withdrawn decision (card 2684, R7; code review C-E-L1), to the decider and an administrator alike. */
export const FLAG_REPLIES_CLOSED = 'This decision is withdrawn: objections and requests to talk can no longer be replied to.';

/**
 * The change-decider form's warning (card 2684, R24): fixed words, no number, shown wherever the form is offered,
 * whether or not anything has been raised, so it says neither how many nor whether there are any.
 */
export const FLAGS_HANDED_OVER = 'Any objections or requests to talk already raised, with names, become visible to the new decider.';

/** Each kind of flag, as the pages name it (card 2684, 3.1). */
export const FLAG_KIND_WORDS: Readonly<Record<'objection' | 'talk', string>> = { objection: 'Objection', talk: 'Request to talk' };

/** Who replied, by name; "the decider" where the viewer is given no name (the participant's own, R22). */
export const flagRepliedWords = (kind: 'objection' | 'talk', byName?: string | null) =>
	`${kind === 'objection' ? 'Answered' : 'Outcome recorded'} by ${byName ?? 'the decider'}`;

/** A flag with no reply yet. */
export const flagUnrepliedWords = (kind: 'objection' | 'talk') => (kind === 'objection' ? 'Not answered yet' : 'No outcome recorded yet');

/**
 * Why the participant's form for `kind` is not offered (card 2684, R22): their last allowed of that kind on this
 * version raised, a request to talk still without an outcome, the decision ruled (a concern instead), superseded or
 * withdrawn, or another reason (the decision's own cap, a link past its time). Worked out from the page's data.
 */
export function flagsClosedWords(kind: 'objection' | 'talk', ownOnVersion: number, max: number, talkOpen: boolean, shownStatus: string): string {
	if (shownStatus === 'ruled') return `${FLAGS_CLOSED}.`;
	if (shownStatus !== 'open' && shownStatus !== 'awaiting_ruling') return 'Objections and requests to talk on this decision are closed.';
	if (kind === 'talk' && talkOpen) return `${TALK_OPEN}.`;
	if (ownOnVersion >= max) return `${flagsLimitWords(kind, max)}.`;
	return kind === 'objection' ? 'You cannot object to this decision now.' : 'You cannot ask to talk about this decision now.';
}

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
 * decision 9), this version otherwise. Drawn only while the watch is armed,
 * which is never once the participant's seen exists (`seenRecorded`, card
 * 2736, D5): then the first action records nothing, so the note would claim a
 * seen that is not written.
 */
export const seenNoteWords = (stage: 'question' | 'ruling' | 'withdrawal') =>
	`Your first tap, click, key press or turn of the mouse wheel on this page is recorded as your having seen ${stage === 'ruling' ? 'the ruling' : 'this version'}.`;

/**
 * The personal link's note in a signed-in browser (card 2677, R8; cards 2735 and 2736):
 * what the link records beside the account, as `signedIn`, on this page and
 * no more. It claims nothing unless the page is a participant's and has a
 * stage. Then each write clause is added only where the page's own flag lets
 * the participant make that write now (`mayRespond`, `mayAsk`, `mayObject`,
 * `mayAskToTalk` (card 2684), `mayRaiseConcern`, which carry the status, the role and each per-person
 * limit), and the seen clause, in `seenNoteWords`'s words for the stage,
 * only where `seenRecorded` is false (card 2736): a seen already recorded is
 * not recorded again, so nothing of it is recorded beside the account now.
 * The clause is dropped, never turned into "was recorded", as an earlier
 * seen's account may not be this one.
 */
export function signedInNoteWords(
	name: string,
	participating: boolean,
	stage: 'question' | 'ruling' | 'withdrawal' | null,
	flags: { mayRespond: boolean; mayAsk: boolean; mayObject: boolean; mayAskToTalk: boolean; mayRaiseConcern: boolean; seenRecorded: boolean }
): string {
	const kept: string[] = [];
	if (participating && stage !== null) {
		if (flags.mayRespond) kept.push('your response');
		if (flags.mayAsk) kept.push('your questions');
		// Card 2684 (code review F5): an objection and a request to talk by link record the signed-in account too.
		if (flags.mayObject) kept.push('your objection');
		if (flags.mayAskToTalk) kept.push('your request to talk');
		if (flags.mayRaiseConcern) kept.push('your concern');
		if (!flags.seenRecorded) kept.push(`your having seen ${stage === 'ruling' ? 'the ruling' : 'this version'}`);
	}
	if (kept.length === 0) return `You are signed in as ${name}.`;
	const clauses = kept.map((what) => `with ${what}`);
	const said = clauses.length === 1 ? clauses[0] : `${clauses.slice(0, -1).join(', ')} and ${clauses[clauses.length - 1]}`;
	return `You are signed in as ${name}; this is recorded ${said}.`;
}

/**
 * The ruled banner's first line (decision 9): who ruled, and on what. No moment. Card 2683 (R18): where the version
 * ruled on put no options to a vote (`noOptions`), `NO_OPTIONS_PUT` in place of "None of these".
 */
export function rulingWords(ruling: { label: string | null; title: string | null; noneOfThese: boolean; ruledByName: string; noOptions?: true }): string {
	if (ruling.noOptions) return `Ruled by ${ruling.ruledByName}: ${NO_OPTIONS_PUT}`;
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
 * A participant's latest record mail, as their banner is told it (card 2677,
 * decision 19; card 2708): one of the five record mails, its moment, and
 * whether its own outcome says it was delivered. The ruling's has no `at` key
 * at all (card 2708, D3): its moment is the ruling's own, which no page is
 * given (card 2679, decision 26). The invitation alone carries `sentAs`
 * (card 2742, D3): the role it was written for, replayed from the record, or
 * null where the record gives none; the other mails' words do not depend on
 * the role.
 */
export type ToldMail =
	| { kind: 'invited'; at: string; delivered: boolean; sentAs: 'consulted' | 'informed' | null }
	| { kind: 'asked_again' | 'told_of_change' | 'told_withdrawn'; at: string; delivered: boolean }
	| { kind: 'told_ruling'; delivered: boolean };

/**
 * The participant page's banner (card 2677, decision 19, D8): when the
 * participant was told of the decision, from their latest record mail, and
 * "by email" only when that mail was recorded as delivered. A mail not yet
 * known to be delivered, or none, gives the neutral words, from when they were
 * included. Since card 2708 the latest may be the withdrawal's or the
 * ruling's, the ruling's named with no moment (D3, D4). Since card 2742 an
 * invitation is worded by the role it was sent for (`sentAs`), never by the
 * participant's role now, which this is no longer given; with none, it claims
 * no purpose (D4).
 */
export function toldWords(told: ToldMail | null, includedAt: string): string {
	if (told === null || !told.delivered) return `You were included in this decision on ${shownMoment(includedAt, '')}.`;
	if (told.kind === 'told_ruling') return 'You were told of the ruling on this decision by email.';
	const at = shownMoment(told.at, '');
	if (told.kind === 'told_withdrawn') return `You were told this decision was withdrawn on ${at}, by email.`;
	if (told.kind === 'asked_again') return `This decision changed, and you were asked for your view again on ${at}, by email.`;
	if (told.kind !== 'invited') return `You were told of a change to this decision on ${at}, by email.`;
	if (told.sentAs === 'informed') return `You were told of this decision on ${at}, by email, to keep you informed.`;
	if (told.sentAs === 'consulted') return `You were asked for your view on this decision on ${at}, by email.`;
	return `You were told of this decision on ${at}, by email.`;
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
	else if (response.kind === 'answered') lines.push('You answered the survey questions.');
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

/** A survey question as the words below read it (card 2683): its kind, prompt, and its choices or scale. */
type AskedQuestion = { questionId: number; kind: string; prompt: string; choices?: string[]; scale?: { max: number } };

/**
 * One answer to a survey question in words (card 2683, R14): a choice by its words, a number on a scale with its
 * top, a written answer as written (plain text, never markdown). Null for a value the question could not have been
 * given, which is then not shown.
 */
export function surveyAnswerWords(question: AskedQuestion, value: number | string | undefined): string | null {
	if (question.kind === 'text') return typeof value === 'string' && value.trim() !== '' ? value : null;
	if (typeof value !== 'number') return null;
	if (question.kind === 'choice') return question.choices?.[value] ?? null;
	if (question.kind === 'scale') return question.scale !== undefined && value >= 1 && value <= question.scale.max ? `${value} of ${question.scale.max}` : null;
	return null;
}

/**
 * Answers to survey questions as the page says them back (card 2683), one line each, "prompt: answer", in the
 * questions' order. `questions` must be those the answers were given to: the current round's, which a re-publish
 * that only told of a change cannot alter (R7, R8), never another round's. An answer to no question listed is left
 * out.
 */
export function surveyAnswerLines(answers: Record<string, number | string>, questions: AskedQuestion[]): string[] {
	return questions.flatMap((question) => {
		const words = surveyAnswerWords(question, answers[String(question.questionId)]);
		return words === null ? [] : [`${question.prompt}: ${words}`];
	});
}

/**
 * What the page says of answers given in an earlier round (card 2683): how many, not what, as that round's
 * questions may have been changed since and the page holds only the current version's (R8). Null for none.
 */
export const earlierAnswersWords = (answers: Record<string, number | string>) => {
	const count = Object.keys(answers).length;
	return count === 0 ? null : `You also answered ${count === 1 ? '1 survey question' : `${count} survey questions`} as that version asked ${count === 1 ? 'it' : 'them'}.`;
};

/**
 * The mark beside a cut-off or non-responding participant whom the round's
 * request never reached (card 2738, D4): no asking mail of the round was
 * delivered to them while consulted, nor had they opened the question. The
 * ruling form, the results page's Not responded list and the ruling's Cut off
 * line say it alike.
 */
export const NOT_REACHED_WORDS = "never reached by this round's request";

/**
 * Each kind of event on a decision's record, as the record view and a
 * person's record name it (card 2680, decision 16). A kind not named here is
 * shown by its stored name, its underscores as spaces.
 */
export const EVENT_WORDS: Readonly<Record<string, string>> = {
	created: 'Created',
	decider_changed: 'Decider changed',
	published: 'Published',
	opened: 'Opened',
	included: 'Included',
	re_included: 'Included again',
	role_changed: 'Role changed',
	removed: 'Removed',
	link_issued: 'Personal link issued',
	link_revoked: 'Personal link revoked',
	invited: 'Invited',
	asked_again: 'Asked again',
	told_of_change: 'Told of a change',
	told_withdrawn: 'Told of the withdrawal',
	told_ruling: 'Told of the ruling',
	mail_skipped: 'Mail not sent',
	mail_outcome: 'Mail outcome',
	closed: 'Closed for input',
	extended: 'Closing time extended',
	withdrawn: 'Withdrawn',
	account_attached: 'Account attached',
	account_cleared: 'Account cleared',
	address_changed: 'Address changed',
	dry_run: 'Dry run sent',
	seen: 'Seen',
	responded: 'Responded',
	ruled: 'Ruled',
	cut_off: 'Cut off by an early ruling',
	superseded: 'Superseded',
	results_released: 'Results released',
	concern_raised: 'Concern raised',
	question_asked: 'Question asked',
	question_answered: 'Question answered',
	answer_published: "Agent's answer published",
	answer_replaced: "Agent's answer replaced",
	// Card 2684 (R16): the decider's and administrators' alone.
	objection_raised: 'Objection raised',
	talk_requested: 'Asked to talk',
	objection_answered: 'Objection answered',
	talk_outcome: 'Talk outcome recorded',
	// Card 2685 (decision 11, S8): claims no delivery, as a person's own record never shows a mail outcome.
	reminded: 'A reminder was due before closing'
};

/** An event's kind in words (`EVENT_WORDS`), or its stored name with its underscores as spaces. */
export const eventWords = (kind: string) => EVENT_WORDS[kind] ?? kind.replaceAll('_', ' ');

/**
 * Each key of an event's shown detail, as the record view and a person's
 * record name it (card 2680 code review, F8): every key `RECORD_DETAIL` shows,
 * every field it names of a nested object or list, and the `id` and `title`
 * another decision is named by. tests/decision-register.test.ts holds that
 * every shown key and field has its words here.
 */
export const DETAIL_WORDS: Readonly<Record<string, string>> = {
	decider: 'Decider',
	supersedes: 'Supersedes',
	fromName: 'From',
	toName: 'To',
	asksAgain: 'Asks for views again',
	changeNote: 'Note of the change',
	closesAt: 'Closes',
	role: 'Role',
	hadAccount: 'Had an account',
	from: 'From',
	to: 'To',
	replaced: 'Replaced an earlier link',
	reason: 'Reason',
	resend: 'Sent again',
	mail: 'Mail',
	delivered: 'Delivered',
	problem: 'Problem',
	stage: 'Stage',
	signedIn: 'Signed in as',
	statement: 'Who-sees statement version',
	option: 'Option',
	early: 'Early',
	// Card 2738: on `cut_off`.
	reached: "Reached by this round's request",
	againstResponses: 'Against the responses',
	supersededOld: 'Superseded the earlier ruling',
	by: 'Superseded by',
	omitted: 'Left out of the release',
	notice: 'Notice',
	agentDrafted: 'Drafted by an agent',
	discarded: 'Discarded answer',
	name: 'Name',
	field: 'Field',
	text: 'Text',
	byName: 'By',
	at: 'At',
	id: 'Decision',
	title: 'Title'
};

/** A detail key in words (`DETAIL_WORDS`), or, for a key not named there, its stored name split into lower-case words: never camelCase. */
export const detailWords = (key: string) =>
	DETAIL_WORDS[key] ??
	key
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replaceAll('_', ' ')
		.toLowerCase()
		.replace(/^./, (first) => first.toUpperCase());

/** A participation's role, as the register and a person's record name it (code review F6). */
export const PARTICIPATION_ROLE_WORDS: Readonly<Record<'consulted' | 'informed', string>> = {
	consulted: 'Consulted',
	informed: 'Informed'
};
