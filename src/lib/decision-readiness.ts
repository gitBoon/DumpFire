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
import type { Stamp } from '$lib/timestamps';
import { NO_LINK_ADDRESS } from '$lib/mail-words';

/**
 * A decision's working copy, as the server stores it (design 4.4, card 2676
 * decision 8). `agentDrafted`, `reviewed` and `lastLabel` are the server's:
 * no body may send them.
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
	/** The sections written through an API key and not yet marked reviewed by a person (decision 9). */
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

export const REFUSAL_CODES = [
	'no_decider',
	'no_board',
	'decider_cannot_edit',
	'no_closing_time',
	'too_few_options',
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
	'agent_drafted'
] as const;

export type WarningCode = (typeof WARNING_CODES)[number];

export type Refusal = { code: RefusalCode; words: string };
export type Warning = { code: WarningCode; key?: string; words: string };

/**
 * Everything that stops the decision opening, in the order `openDecision`
 * meets it (decision 12): the decider, the board, the decider's access, the
 * closing time, the options, a consulted participant, then each participant
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
	if (facts.liveOptionCount < 2) add('too_few_options', 'This decision has fewer than two options: it cannot be opened');
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

/** Text with nothing in it but spaces. */
const blank = (text: string) => text.trim() === '';

/**
 * What in the content a person should look at before opening (decision 12):
 * an empty situation, question or ask; an audience with no text; an option
 * with no title, pros, cons or commercial note; an audience whose group no
 * participant belongs to now, or whose group is gone; and each section an
 * agent drafted that no person has marked reviewed. Each names its entry by
 * `key` where there is more than one of its kind.
 */
export function checkContent(content: ContentAnswer, audience: AudienceFacts): Warning[] {
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
		const optionId = /^options\.(\d+)$/.exec(key);
		const index = optionId === null ? -1 : content.options.findIndex((option) => option.optionId === Number(optionId[1]));
		const section = optionId === null ? (SECTION_NAMES[key] ?? key) : index === -1 ? 'An option' : `Option ${index + 1}`;
		warnings.push({ code: 'agent_drafted', key, words: `${section} was drafted by an agent and not yet reviewed by a person` });
	}
	return warnings;
}
