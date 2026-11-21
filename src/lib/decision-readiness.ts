/**
 * decision-readiness.ts — whether a decision can be opened, and what in its
 * content a person should look at first (card 2676, decisions 11 and 12, R4
 * and R8). Pure, and importing nothing from the server, so the edit page can
 * load it.
 *
 * It has two parts:
 *
 *   - `refusalsOf(facts)`: what stops opening, in `openDecision`'s words and
 *     order. Called on the server only, by `openDecision` and by the edit
 *     page's load, from facts the server alone works out (`openFactsOf` in
 *     `src/lib/server/decision-content.ts`): the decider's access, the
 *     participants' persons and the mail settings never reach the browser,
 *     which is handed the refusals' codes and words;
 *   - `checkContent(content, audience)`: the warnings, the only part the
 *     browser runs, on the edits not yet saved. A warning does not stop
 *     opening.
 */
import { parseStamp, stamp, type Stamp } from '$lib/timestamps';
import { NO_LINK_ADDRESS } from '$lib/mail-words';

/** The kinds of survey question (card 2683, R3): pick one of its choices, a whole number on its scale, or a short written answer. */
export const SURVEY_KINDS = ['choice', 'scale', 'text'] as const;

export type SurveyKind = (typeof SURVEY_KINDS)[number];

/** A scale question's scale (card 2683, R3): a whole number from 1 to `max` (2 to 10), with words at each end. */
export type SurveyScale = { max: number; lowLabel: string; highLabel: string };

/**
 * A survey question as the working copy holds it (card 2683, R3): its row's
 * id once saved, its kind, a one-line prompt, markdown help, whether it must
 * be answered, and its `choices` (a choice question alone) or its `scale` (a
 * scale question alone). Its row (`decision_survey_questions`) holds its
 * place and the versions that published and retired it.
 */
export type SurveyQuestion = {
	questionId?: number;
	kind: SurveyKind;
	prompt: string;
	help: string;
	required: boolean;
	choices?: string[];
	scale?: SurveyScale;
};

/**
 * A decision's working copy, as the server stores it (design 4.4, card 2676
 * decision 8). `agentDrafted`, `reviewed` and `lastLabel` are the server's:
 * no body may send them. Card 2683 adds `surveyQuestions`.
 */
export type WorkingContent = {
	situation: string;
	question: string;
	ask: string;
	options: { optionId?: number; title: string; summary: string; pros: string[]; cons: string[]; commercial: string }[];
	audiences: { groupId: number | null; heading: string; body: string }[];
	stories: { title: string; body: string }[];
	unknowns: string;
	alreadyRuled: string;
	technicalDetail: string;
	/** Card 2683: the author's own questions, in their order. */
	surveyQuestions: SurveyQuestion[];
	/**
	 * The sections written through an API key and not yet marked reviewed by a
	 * person (decision 9); and, since card 2728, `title`, `participants` and
	 * `decider` (`CHOSEN_KEYS`), each chosen through a key and not yet reviewed.
	 */
	agentDrafted: Record<string, true>;
	/** Who marked each section reviewed, and when (R7). */
	reviewed: Record<string, { byUserId: number; byName: string; at: Stamp }>;
	/** The last option label issued, so that one deleted before it was published is never issued again (decision 7). */
	lastLabel: string | null;
};

/** Who marked a section reviewed, and when, as an answer gives it: the account id to an administrator alone (the code review's C3). */
export type ReviewStamp = { byName: string; at: Stamp; byUserId?: number };

/**
 * The working content as every answer gives it (the code review's C3): its
 * sections, options, audiences, stories and agent flags, each review stamp a
 * `ReviewStamp`, and no `lastLabel`, which is the server's alone.
 */
export type ContentAnswer = Omit<WorkingContent, 'reviewed' | 'lastLabel'> & { reviewed: Record<string, ReviewStamp> };

/** What the server knows of a decision that opening asks about. It never leaves the server. */
export type OpenFacts = {
	now: Stamp;
	boardExists: boolean;
	deciderUserId: number | null;
	deciderName: string | null;
	/** Whether the decider's account can edit the decision's board now; asked only with a decider and a board. */
	deciderCanEdit: boolean;
	closesAt: Stamp | null;
	liveOptionCount: number;
	/** Card 2683: each live survey question, in the working copy's order, as `surveyRefusalsOf` reads it. */
	surveyQuestions: SurveyFacts[];
	consultedCount: number;
	/** Every participant row, in id order: its name, and whether its person is still in the directory and active. */
	participants: { rowName: string; personFound: boolean; personName: string | null; personActive: boolean }[];
	/** Each pair of participants whose snapshots, taken again now, hold one account, in `openDecision`'s order. */
	sharedAccounts: { name: string; other: string }[];
	mail: { host: boolean; linkAddress: boolean };
};

/** What the audience warnings ask about: each group an audience names, and the people the decision includes now. */
export type AudienceFacts = {
	groups: Record<number, { exists: boolean; activeMemberIds: number[] }>;
	/** The person of each live participant. */
	participantPersonIds: number[];
};

/**
 * How far ahead a decision's closing time may be set, in days (card 2697,
 * Q25): a personal link lasts until the closing time plus 90 days, so a
 * closing time years out would make a link that does not end. The editor's
 * closing time and the Extend dialog say so from this number.
 */
export const CLOSES_WITHIN_DAYS = 365;

/** The 400 for a closing time past `CLOSES_WITHIN_DAYS` (card 2697, Q25). */
export const CLOSES_TOO_FAR = `closesAt must be no more than ${CLOSES_WITHIN_DAYS} days from now`;

/** What the editor and the Extend form say beside a closing time (Q25): one sentence, so the two cannot drift (the code review's part B, F5). */
export const CLOSES_HELP = `At most a year ahead (${CLOSES_WITHIN_DAYS} days), in UTC.`;

/**
 * A stored moment as a `datetime-local` field shows it, to the minute, read
 * as UTC: '' for none. No `Date` is made of it. The editor's closing time and
 * the Extend form share it (F5).
 */
export function closesField(at: Stamp | null): string {
	return at === null ? '' : `${at.slice(0, 10)}T${at.slice(11, 16)}`;
}

/**
 * Whether `closesAt` is more than `CLOSES_WITHIN_DAYS` after `now` (the code
 * review's part B, S3): opening and re-publishing refuse it, as a personal
 * link lasts until the closing time and 90 days more. Text compared, as the
 * stored form orders moments; a moment that cannot be read is not too far.
 */
export function closesTooFar(closesAt: Stamp | null, now: Stamp): boolean {
	const from = parseStamp(now);
	if (closesAt === null || from === null) return false;
	return closesAt > stamp(new Date(from.getTime() + CLOSES_WITHIN_DAYS * 24 * 60 * 60 * 1000));
}

/** The 409 for opening a decision whose closing time is too far ahead (S3). */
export const CLOSES_TOO_FAR_TO_OPEN = `This decision closes more than ${CLOSES_WITHIN_DAYS} days ahead: it cannot be opened until its closing time is nearer`;

/** The 409 for re-publishing one (S3): an open decision's closing time moves by Extend alone. */
export const CLOSES_TOO_FAR_TO_REPUBLISH = `This decision closes more than ${CLOSES_WITHIN_DAYS} days ahead: it cannot be re-published until it is extended to a nearer closing time`;

export const REFUSAL_CODES = [
	'no_decider',
	'no_board',
	'decider_cannot_edit',
	'no_closing_time',
	'closes_too_far',
	'too_few_options',
	'survey_incomplete',
	'no_consulted',
	'participant_deleted',
	'participant_left',
	'no_mail',
	'no_link_address',
	'shared_account'
] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];

export const WARNING_CODES = [
	'empty_situation',
	'empty_question',
	'empty_ask',
	'empty_audience',
	'option_no_title',
	'option_no_pros',
	'option_no_cons',
	'option_no_commercial',
	'audience_nobody_ticked',
	'audience_group_gone',
	'agent_drafted',
	'closes_too_far'
] as const;

export type WarningCode = (typeof WARNING_CODES)[number];

export type Refusal = { code: RefusalCode; words: string };
export type Warning = { code: WarningCode; key?: string; words: string };

/** What opening and re-publishing ask of a survey question (card 2683, R6): its prompt, its kind and how many choices it offers. */
export type SurveyFacts = { prompt: string; kind: SurveyKind; choiceCount: number };

/** A survey question's facts, from the working copy's entry. */
export function surveyFactsOf(question: Pick<SurveyQuestion, 'prompt' | 'kind' | 'choices'>): SurveyFacts {
	return { prompt: question.prompt, kind: question.kind, choiceCount: question.choices?.length ?? 0 };
}

/**
 * What stops a survey being published (card 2683, R6, R7): for each question,
 * by its number, an empty prompt, and a choice question with fewer than two
 * choices. Opening refuses the first as `survey_incomplete`, and re-publishing
 * with the same words, `cannot` saying which (`opened`, `re-published`).
 */
export function surveyRefusalsOf(questions: SurveyFacts[], cannot: 'opened' | 're-published'): string[] {
	const words: string[] = [];
	questions.forEach((question, index) => {
		if (blank(question.prompt)) words.push(`Survey question ${index + 1} has no prompt: this decision cannot be ${cannot}`);
		if (question.kind === 'choice' && question.choiceCount < 2) {
			words.push(`Survey question ${index + 1} offers fewer than two choices: this decision cannot be ${cannot}`);
		}
	});
	return words;
}

/**
 * Everything that stops the decision opening, in the order `openDecision`
 * meets it (decision 12): the decider, the board, the decider's access, the
 * closing time (none in the future, or one more than `CLOSES_WITHIN_DAYS`
 * ahead: the code review's part B, S3), the options (card 2683: one, or none
 * with no survey question), each survey question with no prompt or a choice
 * question with fewer than two choices, a consulted participant, then each participant
 * row in id order, deleted or left, then mail, the link address, and each
 * pair holding one account. `openDecision` answers the first. Empty: it can
 * be opened. The server alone calls this.
 */
export function refusalsOf(facts: OpenFacts): Refusal[] {
	const refusals: Refusal[] = [];
	const add = (code: RefusalCode, words: string) => refusals.push({ code, words });
	if (facts.deciderUserId === null) add('no_decider', 'This decision has no decider: it cannot be opened');
	if (!facts.boardExists) add('no_board', "This decision's board has been deleted: it cannot be opened");
	if (facts.deciderUserId !== null && facts.boardExists && !facts.deciderCanEdit) {
		add(
			'decider_cannot_edit',
			`The decider, ${facts.deciderName ?? 'who was named'}, can no longer edit this board: it cannot be opened until a decider who can is named`
		);
	}
	if (facts.closesAt === null || facts.closesAt <= facts.now) add('no_closing_time', 'This decision has no closing time in the future: it cannot be opened');
	else if (closesTooFar(facts.closesAt, facts.now)) add('closes_too_far', CLOSES_TOO_FAR_TO_OPEN);
	// Card 2683 (R6): no option at all is a survey, which opens with a survey question; one option never opens.
	if (facts.liveOptionCount === 0 && facts.surveyQuestions.length === 0) {
		add('too_few_options', 'This decision has no options and no survey questions: it cannot be opened');
	} else if (facts.liveOptionCount === 1) {
		add('too_few_options', 'This decision has fewer than two options: it cannot be opened');
	}
	for (const words of surveyRefusalsOf(facts.surveyQuestions, 'opened')) add('survey_incomplete', words);
	if (facts.consultedCount === 0) add('no_consulted', 'This decision has no consulted participant: it cannot be opened');
	for (const row of facts.participants) {
		if (!row.personFound) {
			add('participant_deleted', `${row.rowName} is no longer in the people directory: this decision cannot be opened until they are taken off it`);
		} else if (!row.personActive) {
			add('participant_left', `${row.personName ?? row.rowName} has left: this decision cannot be opened until they are taken off it`);
		}
	}
	if (!facts.mail.host) add('no_mail', 'Mail is not set up on this server: a decision cannot be opened, as its participants could not be told');
	if (!facts.mail.linkAddress) add('no_link_address', NO_LINK_ADDRESS);
	for (const pair of facts.sharedAccounts) {
		add('shared_account', `${pair.name} and ${pair.other} hold the same account: this decision cannot be opened while two of its participants do`);
	}
	return refusals;
}

/** Each section a flag may name, as its heading reads in the editor (design 4.7). */
const SECTION_NAMES: Readonly<Record<string, string>> = {
	situation: 'Situation',
	question: 'Question',
	ask: 'What is asked',
	unknowns: 'What is not yet known',
	alreadyRuled: 'Already settled',
	technicalDetail: 'Technical detail',
	audiences: 'How it affects you',
	stories: 'User stories'
};

/**
 * What a key may choose outside the content (card 2728): the title, the
 * participant list and the decider. Each is flagged in `agentDrafted` under
 * its own key when a key's write changes it, warned of by `checkContent`, and
 * cleared by a person's Mark reviewed alone, as a section's flag is. Card
 * 2683 (code review F5): and the vote mode a key changed on an opened
 * decision while it puts no option to a vote (R23), which the re-publish that
 * adds the first options then publishes them in.
 */
export const CHOSEN_KEYS = ['title', 'participants', 'decider', 'voteMode'] as const;

/** Each of `CHOSEN_KEYS`, as its warning names it (card 2728, D8). */
const CHOSEN_WORDS: Readonly<Record<(typeof CHOSEN_KEYS)[number], string>> = {
	title: 'The title was',
	participants: 'The participants were',
	decider: 'The decider was',
	voteMode: 'The vote mode was'
};

/** Text with nothing in it but spaces. */
const blank = (text: string) => text.trim() === '';

/**
 * What in the content a person should look at before opening (decision 12):
 * an empty situation, question or ask; an audience with no text; an option
 * with no title, pros, cons or commercial note; an audience whose group no
 * participant belongs to now, or whose group is gone; each section an
 * agent drafted that no person has marked reviewed; and, after them, the
 * title, participants and decider a key chose that no person has (card 2728,
 * keyed by `CHOSEN_KEYS`: a warning, as every agent flag is, so Open's
 * confirmation names it). Each names its entry by `key` where there is more
 * than one of its kind.
 *
 * With `closing`, a closing time more than `CLOSES_WITHIN_DAYS` ahead too
 * (the code review's part B, S3), which opening and re-publishing refuse. It
 * is handed where no refusal already says so: by the server for a decision
 * that has been opened, whose refusals are not worked out, and by the editor
 * besides for a draft's closing time changed and not yet saved.
 */
export function checkContent(content: ContentAnswer, audience: AudienceFacts, closing?: { closesAt: Stamp | null; now: Stamp }): Warning[] {
	const warnings: Warning[] = [];
	if (blank(content.situation)) warnings.push({ code: 'empty_situation', words: 'The situation is empty' });
	if (blank(content.question)) warnings.push({ code: 'empty_question', words: 'The question is empty' });
	if (blank(content.ask)) warnings.push({ code: 'empty_ask', words: 'What is asked is empty' });

	content.options.forEach((option, index) => {
		const key = `options[${index}]`;
		const name = blank(option.title) ? `Option ${index + 1}` : `Option ${index + 1}, "${option.title.trim()}",`;
		if (blank(option.title)) warnings.push({ code: 'option_no_title', key, words: `Option ${index + 1} has no title` });
		if (option.pros.every(blank)) warnings.push({ code: 'option_no_pros', key, words: `${name} lists no pros` });
		if (option.cons.every(blank)) warnings.push({ code: 'option_no_cons', key, words: `${name} lists no cons` });
		if (blank(option.commercial)) warnings.push({ code: 'option_no_commercial', key, words: `${name} has no commercial note` });
	});

	const included = new Set(audience.participantPersonIds);
	content.audiences.forEach((entry, index) => {
		const key = `audiences[${index}]`;
		const name = blank(entry.heading) ? `Audience ${index + 1}` : `"${entry.heading.trim()}"`;
		if (blank(entry.body)) warnings.push({ code: 'empty_audience', key, words: `${name} in How it affects you has no text` });
		if (entry.groupId === null) return;
		const group = audience.groups[entry.groupId];
		if (!group || !group.exists) {
			warnings.push({ code: 'audience_group_gone', key, words: `${name} in How it affects you is for a group that has been deleted` });
		} else if (!group.activeMemberIds.some((id) => included.has(id))) {
			warnings.push({ code: 'audience_nobody_ticked', key, words: `${name} in How it affects you is for a group none of whose members is included` });
		}
	});

	for (const key of Object.keys(content.agentDrafted)) {
		if ((CHOSEN_KEYS as readonly string[]).includes(key)) continue;
		// Card 2683 (R16): a survey question by its number and prompt, never by its key.
		const questionId = /^survey\.(\d+)$/.exec(key);
		if (questionId !== null) {
			const at = content.surveyQuestions.findIndex((question) => question.questionId === Number(questionId[1]));
			const prompt = at === -1 ? '' : content.surveyQuestions[at].prompt.trim();
			const named = at === -1 ? 'A survey question' : prompt === '' ? `Survey question ${at + 1}` : `Survey question ${at + 1}, '${prompt}',`;
			warnings.push({ code: 'agent_drafted', key, words: `${named} was drafted by an agent and not yet reviewed by a person` });
			continue;
		}
		const optionId = /^options\.(\d+)$/.exec(key);
		const index = optionId === null ? -1 : content.options.findIndex((option) => option.optionId === Number(optionId[1]));
		const section = optionId === null ? (SECTION_NAMES[key] ?? key) : index === -1 ? 'An option' : `Option ${index + 1}`;
		warnings.push({ code: 'agent_drafted', key, words: `${section} was drafted by an agent and not yet reviewed by a person` });
	}
	// Card 2728: the title, the participants and the decider a key chose, in that order, after the sections.
	for (const key of CHOSEN_KEYS) {
		if (content.agentDrafted[key] === true) warnings.push({ code: 'agent_drafted', key, words: `${CHOSEN_WORDS[key]} chosen by an agent and not yet reviewed by a person` });
	}

	if (closing !== undefined && closesTooFar(closing.closesAt, closing.now)) {
		warnings.push({
			code: 'closes_too_far',
			words: `The closing time is more than ${CLOSES_WITHIN_DAYS} days ahead: it cannot be opened or re-published so (${CLOSES_TOO_FAR})`
		});
	}
	return warnings;
}
