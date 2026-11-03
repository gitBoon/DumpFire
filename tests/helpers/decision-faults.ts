/**
 * A draft that opens, and each way of making it refuse to (card 2675's
 * `openDecision` cases 35 to 43, moved here by card 2676, D10, so that the
 * readability check's drift guard loops over the same table).
 *
 * `readyDraft` is handed the world it is made in, the board, and answers
 * what each fault needs. Each row of `OPEN_FAULTS` is what makes the draft
 * refuse, the words `openDecision` refuses with, and the code `refusalsOf`
 * gives the same fault (`src/lib/decision-readiness.ts`).
 *
 * `revisionNow` is the revision the authoring writes require, as a page that
 * has just read the decision holds it (card 2676, decision 10).
 */
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { boardMembers, boards, decisionOptions, decisionParticipants, decisions, people, settings, type Board } from '$lib/server/db/schema';
import { revisionOf } from '$lib/server/decision-content';
import type { RefusalCode } from '$lib/decision-readiness';
import { addBoardMember, makeDecision, makeOption, makeParticipant, makePerson, makeUser } from './fixtures';

/** A closing time ahead of every test. */
export const FUTURE = '2099-01-01 12:00:00';

const decisionRow = (id: number) => db.select().from(decisions).where(eq(decisions.id, id)).get()!;

/** A draft that opens, on `world.board`: a decider who can edit, a closing time ahead, two options, and two participants. */
export function readyDraft(world: { board: Board }, title = 'Ready') {
	const { board } = world;
	const author = makeUser({ username: 'author' });
	addBoardMember(board, author, 'editor');
	const decider = makeUser({ username: 'decider' });
	addBoardMember(board, decider, 'editor');
	const draft = makeDecision({ board, author, decider, title, closesAt: FUTURE });
	const lean = makeOption(draft, { label: 'A' });
	const full = makeOption(draft, { label: 'B' });
	const working = {
		situation: 'Money is short.',
		question: 'Which budget?',
		ask: 'Pick the one you can live with.',
		options: [
			{ optionId: lean.id, title: 'Lean', summary: '', pros: [], cons: [], commercial: '' },
			{ optionId: full.id, title: 'Full', summary: '', pros: [], cons: [], commercial: '' }
		]
	};
	db.update(decisions).set({ workingContent: JSON.stringify(working) }).where(eq(decisions.id, draft.id)).run();
	const holderAccount = makeUser({ username: 'holder' });
	const holderPerson = makePerson({ fullName: 'Holder', user: holderAccount, jobTitle: 'Old title' });
	const linkPerson = makePerson({ fullName: 'Linky', email: 'linky@example.test' });
	const holder = makeParticipant(draft, { person: holderPerson, role: 'consulted' });
	const linked = makeParticipant(draft, { person: linkPerson, role: 'informed' });
	return { board, author, decider, draft: decisionRow(draft.id), lean, full, working, holderAccount, holderPerson, linkPerson, holder, linked };
}

export type Ready = ReturnType<typeof readyDraft>;

/**
 * Each refusal of opening (card 2675, decision 20; card 2676, decision 12):
 * what makes a ready draft refuse, the words, and the readability code. A
 * fault whose words need an App URL and ORIGIN both missing, (h), is run with
 * neither in the environment.
 */
export const OPEN_FAULTS: [name: string, make: (ready: Ready) => void, words: string, code: RefusalCode][] = [
	[
		'(a) no decider',
		(r) => db.update(decisions).set({ deciderUserId: null, deciderName: null }).where(eq(decisions.id, r.draft.id)).run(),
		'This decision has no decider: it cannot be opened',
		'no_decider'
	],
	[
		'(b) a decider who can no longer edit',
		(r) => db.delete(boardMembers).where(eq(boardMembers.userId, r.decider.id)).run(),
		'The decider, decider, can no longer edit this board: it cannot be opened until a decider who can is named',
		'decider_cannot_edit'
	],
	[
		'(c) closes_at not in the future',
		(r) => db.update(decisions).set({ closesAt: '2020-01-01 00:00:00' }).where(eq(decisions.id, r.draft.id)).run(),
		'This decision has no closing time in the future: it cannot be opened',
		'no_closing_time'
	],
	[
		'(d) one live option',
		(r) => db.delete(decisionOptions).where(eq(decisionOptions.id, r.full.id)).run(),
		'This decision has fewer than two options: it cannot be opened',
		'too_few_options'
	],
	[
		'(e) no consulted participant',
		(r) => db.update(decisionParticipants).set({ role: 'informed' }).where(eq(decisionParticipants.decisionId, r.draft.id)).run(),
		'This decision has no consulted participant: it cannot be opened',
		'no_consulted'
	],
	[
		'(f) a participant whose person has left',
		(r) => db.update(people).set({ status: 'left', leftAt: '2026-11-02 09:00:00' }).where(eq(people.id, r.holderPerson.id)).run(),
		'Holder has left: this decision cannot be opened until they are taken off it',
		'participant_left'
	],
	[
		'(g) no mail host',
		() => db.delete(settings).where(eq(settings.key, 'smtp_host')).run(),
		'Mail is not set up on this server: a decision cannot be opened, as its participants could not be told',
		'no_mail'
	],
	[
		'(h) no App URL and no ORIGIN, with a base URL handed in',
		() => db.delete(settings).where(eq(settings.key, 'app_url')).run(),
		'This server has no address configured to make the link from, so nothing was sent and nothing was saved. ' +
			'An administrator sets it as the App URL on the admin page, under Application Settings; or the server is ' +
			'started with ORIGIN set to its public address',
		'no_link_address'
	],
	['(i) the board deleted', (r) => db.delete(boards).where(eq(boards.id, r.board.id)).run(), "This decision's board has been deleted: it cannot be opened", 'no_board'],
	[
		'(j) a participant whose person has been deleted',
		(r) => db.delete(people).where(eq(people.id, r.linkPerson.id)).run(),
		'Linky is no longer in the people directory: this decision cannot be opened until they are taken off it',
		'participant_deleted'
	],
	[
		'(k) two participants holding one account',
		(r) => {
			makeParticipant(r.draft, { person: r.holderPerson, role: 'informed' });
		},
		'Holder and Holder hold the same account: this decision cannot be opened while two of its participants do',
		'shared_account'
	]
];

/** The decision's revision as it is now: what a page that has just read it holds. */
export function revisionNow(decisionId: number): string {
	return revisionOf(
		decisionRow(decisionId),
		db.select().from(decisionOptions).where(eq(decisionOptions.decisionId, decisionId)).all(),
		db.select().from(decisionParticipants).where(eq(decisionParticipants.decisionId, decisionId)).all()
	);
}
