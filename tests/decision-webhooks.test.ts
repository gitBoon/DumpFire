/**
 * Decision webhooks (card 2689): a decision opened, ruled, withdrawn or
 * superseded sends `decision.opened`, `decision.ruled`, `decision.withdrawn`
 * or `decision.superseded` to the webhooks of its own board that name the
 * event (`NAMED_ONLY_EVENTS`, src/lib/server/webhooks.ts), with `data` built
 * from the entry's decision projection alone (`decisionWebhookOf`,
 * src/lib/server/decision-write-shared.ts; `logActivity`), and only while the
 * webhook's setter may view the decision (`deliver`'s check).
 *
 * Each write is called as a route calls it, inside `writeAs` and handed its
 * `caller`, with `effects()` installed so that nothing leaves, mail set up
 * (`makeSmtp`) and an App URL saved. Which action maps to which event, the
 * payload's allowlist and the empty-list rule on their own are
 * tests/webhooks.test.ts's (W1, L1 to L4). The cases are the plan's,
 * `docs/planning/card-2689-decision-webhooks.md`, section 9, by id.
 *
 * `$lib/server/decision-visibility` (where `visibleDecisionIdsOf` lives since
 * this card, re-exported by decision-register.ts) is mocked keeping every
 * real export, with `visibleDecisionIdsOf` wrapped in a spy that calls the
 * real one (A25): no data today lets a setter who can open a board not view a
 * decision on it, so D7 refuses the view through the spy, never through a
 * switch in the code.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import type { SessionUser } from '$lib/server/auth';
import {
	boardMembers,
	boards,
	decisionCardLinks,
	decisionSurveyQuestions,
	decisions,
	peopleGroupMembers,
	peopleGroups,
	settings,
	webhooks,
	type Board,
	type Decision
} from '$lib/server/db/schema';
import { decisionAccess, mayDo } from '$lib/server/decision-access';
import { visibleDecisionIdsOf } from '$lib/server/decision-visibility';
import { resultsRevisionFor } from '$lib/server/decision-results';
import { openDecision, withdrawDecision } from '$lib/server/decision-lifecycle-writes';
import { ruleDecision } from '$lib/server/decision-ruling-writes';
import { deliveryResultFor, dispatchWebhook, forgetDeliveries, forgetWebhookWarnings } from '$lib/server/webhooks';
import { ACTIONS, logActivity } from '$lib/server/logActivity';
import { resetAllRateLimits } from '$lib/server/rate-limit';
import { writeAs, type ServiceOptions } from '$lib/server/write-as';
import { api } from './helpers/api';
import { FUTURE, revisionNow } from './helpers/decision-faults';
import { effects, type Effects } from './helpers/effects';
import {
	addBoardMember,
	holdingPassword,
	makeApiKeyRow,
	makeBoard,
	makeCard,
	makeDecision,
	makeOption,
	makeParticipant,
	makePerson,
	makeResponse,
	makeRuling,
	makeSmtp,
	makeUser,
	makeVersion,
	makeWebhook,
	resetDb
} from './helpers/fixtures';

/**
 * The accounts whose view of every decision the spy refuses (D7), and those for whom it throws, as a check that
 * cannot be told does (the code review's E-L4); each empty otherwise.
 */
const view = vi.hoisted(() => ({ refused: new Set<number>(), thrown: new Set<number>() }));

vi.mock('$lib/server/decision-visibility', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/decision-visibility')>();
	return {
		...real,
		visibleDecisionIdsOf: vi.fn((user: Parameters<typeof real.visibleDecisionIdsOf>[0], ids: readonly number[]) => {
			if (user && view.thrown.has(user.id)) throw new Error('VIEWFAULTMARK');
			return user && view.refused.has(user.id) ? new Set<number>() : real.visibleDecisionIdsOf(user, ids);
		})
	};
});

const APP = 'https://kanban.example.test';
const UI: ServiceOptions = { source: 'ui' };
const NAMED = ['decision.opened', 'decision.ruled', 'decision.withdrawn', 'decision.superseded'];
const TITLE = 'Budget for Q3';

let sent: Effects;
let owner: SessionUser;
let board: Board;
let cols: ReturnType<typeof makeBoard>['cols'];
let seq = 0;

beforeEach(() => {
	resetDb();
	resetAllRateLimits();
	forgetDeliveries();
	forgetWebhookWarnings();
	view.refused.clear();
	view.thrown.clear();
	makeSmtp();
	db.insert(settings).values({ key: 'app_url', value: APP }).run();
	owner = makeUser({ username: 'OWNERNAMEMARK' });
	({ board, cols } = makeBoard({ owner, name: 'BOARDNAMEMARK' }));
	sent = effects();
});

afterEach(() => {
	sent.restore();
});

/** Call a write as `user`, as a route calls it inside its writeAs callback. */
const as = <T>(user: SessionUser, write: (caller: SessionUser | null) => T): T => writeAs({ user } as App.Locals, write as never) as T;

const decisionRow = (id: number) => db.select().from(decisions).where(eq(decisions.id, id)).get()!;
const activityCount = () => (sqlite.prepare('SELECT COUNT(*) AS n FROM activity_log').get() as { n: number }).n;
const hookRow = (id: number) => db.select().from(webhooks).where(eq(webhooks.id, id)).get()!;

/** An editor of `on`, by name. */
function editor(username: string, on: Board = board): SessionUser {
	const user = makeUser({ username: `${username}${++seq}` });
	addBoardMember(on, user, 'editor');
	return user;
}

/** A flag row as `raiseFlag` and `replyToFlag` leave one. */
function plantFlag(decisionId: number, participantId: number, row: { kind: 'objection' | 'talk'; reason: string; reply?: string }): void {
	sqlite
		.prepare(
			'INSERT INTO decision_flags (decision_id, participant_id, kind, reason, version_number, via, raised_at, reply, replied_by_name, replied_at) ' +
				"VALUES (?, ?, ?, ?, 1, 'session', '2026-11-02 09:30:00', ?, ?, ?)"
		)
		.run(decisionId, participantId, row.kind, row.reason, row.reply ?? null, row.reply === undefined ? null : 'REPLIERNAMEMARK', row.reply === undefined ? null : '2026-11-02 10:30:00');
}

/**
 * What no decision event may carry, planted on `decision` (D1, the binding notes): a consulted participant with an
 * account, in two groups; a survey question answered in words; a vote with a comment; an objection with its reason and
 * a reply; and a request to talk. The question's prompt is in the working content of a draft, which opening publishes.
 */
function plant(decision: Decision, option: number) {
	const one = db.insert(peopleGroups).values({ name: `GROUPONEMARK${++seq}` }).returning().get();
	const two = db.insert(peopleGroups).values({ name: `GROUPTWOMARK${++seq}` }).returning().get();
	const account = makeUser({ username: `PARTICIPANTACCOUNTMARK${++seq}` });
	const person = makePerson({ fullName: 'PARTICIPANTNAMEMARK', email: `participantmark${++seq}@example.test`, user: account, jobTitle: 'JOBTITLEMARK' });
	db.insert(peopleGroupMembers).values([{ groupId: one.id, personId: person.id }, { groupId: two.id, personId: person.id }]).run();
	const participant = makeParticipant(decision, { person, role: 'consulted', groups: JSON.stringify([one.name, two.name]) });
	const question = db
		.insert(decisionSurveyQuestions)
		.values({ decisionId: decision.id, position: 0, addedInVersion: decision.status === 'draft' ? null : 1 })
		.returning()
		.get();
	makeResponse(participant, { kind: 'vote', optionId: option, comment: 'COMMENTMARK', answers: JSON.stringify({ [question.id]: 'SURVEYANSWERMARK' }) });
	plantFlag(decision.id, participant.id, { kind: 'objection', reason: 'OBJECTIONMARK', reply: 'REPLYMARK' });
	plantFlag(decision.id, participant.id, { kind: 'talk', reason: 'TALKMARK' });
	return { question };
}

/** The options' published words, each a marker. */
const optionContent = (a: number, b: number) => [
	{ optionId: a, label: 'A', title: 'OPTIONONEMARK', summary: 'SUMMARYMARK', pros: [], cons: [], commercial: '' },
	{ optionId: b, label: 'B', title: 'OPTIONTWOMARK', summary: '', pros: [], cons: [], commercial: '' }
];

/** A draft of an editor's on the board that opens, decided by another, with everything `plant` plants. */
function readyDraft() {
	const author = editor('AUTHORNAMEMARK');
	const decider = editor('DECIDERNAMEMARK');
	const draft = makeDecision({ board, author, decider, title: TITLE, closesAt: FUTURE });
	const a = makeOption(draft, { label: 'A' });
	const b = makeOption(draft, { label: 'B' });
	const { question } = plant(draft, a.id);
	const working = {
		situation: 'SITUATIONMARK',
		question: 'Which budget?',
		ask: 'Pick one.',
		options: optionContent(a.id, b.id),
		surveyQuestions: [{ questionId: question.id, kind: 'text', prompt: 'PROMPTMARK', help: '', required: false }]
	};
	db.update(decisions).set({ workingContent: JSON.stringify(working) }).where(eq(decisions.id, draft.id)).run();
	return { author, decider, decision: decisionRow(draft.id), a, b };
}

/** An open decision on `on`, version 1 published with two options, by an editor and decided by another, with everything `plant` plants. */
function openOn(on: Board = board, opts: { title?: string; supersedesId?: number | null; decider?: SessionUser } = {}) {
	const author = editor('AUTHORNAMEMARK', on);
	const decider = opts.decider ?? editor('DECIDERNAMEMARK', on);
	const made = makeDecision({
		board: on,
		author,
		decider,
		title: opts.title ?? TITLE,
		status: 'open',
		closesAt: FUTURE,
		openedAt: '2026-11-01 09:00:00',
		currentVersion: 0,
		voteMode: 'single',
		supersedesId: opts.supersedesId ?? null
	});
	const a = makeOption(made, { label: 'A', position: 0, addedInVersion: 1 });
	const b = makeOption(made, { label: 'B', position: 1, addedInVersion: 1 });
	const { question } = plant(made, a.id);
	makeVersion(
		made,
		{
			situation: 'SITUATIONMARK',
			question: 'Which budget?',
			options: optionContent(a.id, b.id),
			surveyQuestions: [{ questionId: question.id, kind: 'text', prompt: 'PROMPTMARK', help: '', required: false }]
		},
		{ number: 1 }
	);
	return { author, decider, decision: decisionRow(made.id), a, b };
}

const open = (user: SessionUser, decision: Decision) => as(user, (caller) => openDecision(caller, { decisionId: decision.id }, { revision: revisionNow(decision.id) }, UI));
const rule = (user: SessionUser, decision: Decision, optionId: number | null) =>
	as(user, (caller) =>
		ruleDecision(
			caller,
			{ decisionId: decision.id },
			{ optionId, reason: 'REASONMARK', conditions: 'CONDITIONMARK', revision: resultsRevisionFor(decision.id), openTalksConfirmed: true },
			UI
		)
	);
const withdraw = (user: SessionUser, decision: Decision) =>
	holdingPassword(user, () => as(user, (caller) => withdrawDecision(caller, { decisionId: decision.id }, { reason: 'WITHDRAWREASONMARK' }, UI)));

/** Each act of the three call sites: what it is done to, how, the event it sends and the status the event says. */
type Act = { name: string; event: string; action: string; status: string; make: (on?: Board) => { decision: Decision; act: () => Promise<unknown> } };
const ACTS: Act[] = [
	{
		name: 'opening',
		event: 'decision.opened',
		action: 'decision_opened',
		status: 'open',
		make: () => {
			const r = readyDraft();
			return { decision: r.decision, act: async () => open(r.author, r.decision) };
		}
	},
	{
		name: 'ruling',
		event: 'decision.ruled',
		action: 'decision_ruled',
		status: 'ruled',
		make: (on) => {
			const r = openOn(on);
			return { decision: r.decision, act: async () => rule(r.decider, r.decision, r.a.id) };
		}
	},
	{
		name: 'withdrawing',
		event: 'decision.withdrawn',
		action: 'decision_withdrawn',
		status: 'withdrawn',
		make: (on) => {
			const r = openOn(on);
			return { decision: r.decision, act: () => withdraw(r.author, r.decision) };
		}
	}
];

/** What a delivery must never hold (the card; the binding notes of cards 2683, 2684 and 2686; R8). */
const NEVER = [
	'OWNERNAMEMARK',
	'AUTHORNAMEMARK',
	'DECIDERNAMEMARK',
	'PARTICIPANTACCOUNTMARK',
	'PARTICIPANTNAMEMARK',
	'participantmark',
	'JOBTITLEMARK',
	'REPLIERNAMEMARK',
	'BOARDNAMEMARK',
	'OPTIONONEMARK',
	'OPTIONTWOMARK',
	'SUMMARYMARK',
	'SITUATIONMARK',
	'PROMPTMARK',
	'REASONMARK',
	'CONDITIONMARK',
	'WITHDRAWREASONMARK',
	'SURVEYANSWERMARK',
	'COMMENTMARK',
	'OBJECTIONMARK',
	'REPLYMARK',
	'TALKMARK',
	'GROUPONEMARK',
	'GROUPTWOMARK',
	FUTURE,
	FUTURE.replace(' ', 'T'),
	FUTURE.slice(0, 16),
	'closes',
	'early',
	'against'
];

/** A webhook naming the four, made by the board's owner through the API with a key: by POST, or made with none and then named by PUT (E-L1). */
const SETTINGS: [string, () => Promise<number>][] = [
	[
		'POST naming the four',
		async () => {
			const credential = { kind: 'api key' as const, id: makeApiKeyRow(owner).id };
			const made = await api('POST', `/api/v1/boards/${board.id}/webhooks`, { user: owner, credential, body: { url: 'https://hooks.example.test/decisions', events: NAMED } });
			expect(made.status).toBe(201);
			return made.body.id as number;
		}
	],
	[
		'POST with events [] and then PUT naming the four',
		async () => {
			const credential = { kind: 'api key' as const, id: makeApiKeyRow(owner).id };
			const made = await api('POST', `/api/v1/boards/${board.id}/webhooks`, { user: owner, credential, body: { url: 'https://hooks.example.test/decisions', events: [] } });
			expect(made.status).toBe(201);
			const put = await api('PUT', `/api/v1/webhooks/${made.body.id}`, { user: owner, credential, body: { events: NAMED } });
			expect(put.status).toBe(200);
			expect(put.body.events).toEqual(NAMED);
			return made.body.id as number;
		}
	]
];

describe('a decision event, end to end (D1)', () => {
	const cases = SETTINGS.flatMap(([how, set]) => ACTS.map((act) => [`${how}: ${act.name}`, set, act] as const));

	it.each(cases)('%s sends its one event, saying only the decision, the act and its status, and none of what is planted', async (_name, set, act) => {
		await set();
		const { decision, act: run } = act.make();
		sent.clear();

		await run();
		await sent.settle();

		expect(sent.webhooks.map((d) => d.event)).toEqual([act.event]);
		const [delivery] = sent.webhooks;
		expect(delivery.url).toBe('https://hooks.example.test/decisions');
		expect(delivery.body).toMatchObject({ event: act.event, boardId: board.id });
		expect(delivery.body.data).toEqual({ decisionId: decision.id, action: act.action, source: 'ui', title: TITLE, status: act.status });
		expect(sent.duringTransaction).toEqual([]);
		const text = JSON.stringify([delivery.body, delivery.headers]);
		for (const never of NEVER) expect(text, never).not.toContain(never);
	});
});

describe('a ruling that supersedes an earlier one (D2)', () => {
	it('sends decision.ruled for the new one and decision.superseded for the old, naming the new; in no order promised', async () => {
		makeWebhook(board, { events: NAMED });
		const old = openOn(board, { title: 'The old one' });
		makeRuling(old.decision);
		const next = openOn(board, { title: 'The new one', supersedesId: old.decision.id, decider: old.decider });
		sent.clear();

		rule(old.decider, decisionRow(next.decision.id), next.a.id);
		await sent.settle();

		// A set: each POST is sent on its own, so either may arrive first (R2).
		const heard = sent.webhooks.map((d) => ({ event: d.event, data: d.body.data }));
		expect(heard).toHaveLength(2);
		expect(heard).toEqual(
			expect.arrayContaining([
				{ event: 'decision.ruled', data: { decisionId: next.decision.id, action: 'decision_ruled', source: 'ui', title: 'The new one', status: 'ruled' } },
				{
					event: 'decision.superseded',
					data: { decisionId: old.decision.id, action: 'decision_superseded', source: 'ui', title: 'The old one', status: 'superseded', supersededByDecisionId: next.decision.id }
				}
			])
		);
	});

	it('sends decision.ruled alone when the ruler may not supersede the old one', async () => {
		makeWebhook(board, { events: NAMED });
		const old = openOn(board, { title: 'The old one' });
		makeRuling(old.decision);
		const next = openOn(board, { title: 'The new one', supersedesId: old.decision.id });
		sent.clear();

		rule(next.decider, decisionRow(next.decision.id), next.a.id);
		await sent.settle();

		expect(decisionRow(old.decision.id).status).toBe('ruled');
		expect(sent.webhooks.map((d) => [d.event, d.body.data.decisionId])).toEqual([['decision.ruled', next.decision.id]]);
	});
});

describe('nothing for a draft, nor for a decision whose board is gone (D3)', () => {
	it.each([
		[
			'a draft withdrawn',
			async () => {
				const author = editor('author');
				const draft = makeDecision({ board, author, decider: author, title: TITLE, closesAt: FUTURE });
				await withdraw(author, draft);
			}
		],
		[
			'an opened decision withdrawn by an administrator after its board was deleted',
			async () => {
				const admin = makeUser({ username: 'admin', role: 'admin' });
				// Another board of the same owner, whose webhook names the four: nothing may reach it either.
				const other = makeBoard({ owner }).board;
				makeWebhook(other, { events: NAMED });
				const { decision } = openOn(board);
				db.delete(boards).where(eq(boards.id, board.id)).run();
				expect(decisionRow(decision.id).boardId).toBeNull();
				await withdraw(admin, decisionRow(decision.id));
			}
		]
	])('%s sends nothing and writes no entry', async (_name, run) => {
		makeWebhook(board, { events: NAMED });
		sent.clear();
		const entries = activityCount();

		await run();
		await sent.settle();

		expect(sent.webhooks).toEqual([]);
		expect(activityCount()).toBe(entries);
	});
});

describe("never to a linked card's board (D4)", () => {
	it.each(ACTS.map((act) => [act.name, act] as const))('%s: a webhook naming the four on the board of a linked card hears nothing', async (_name, act) => {
		const cardBoard = makeBoard({ owner, name: 'CARDBOARDMARK' });
		const card = makeCard(cardBoard.cols['To Do'], { title: 'Linked' });
		makeWebhook(board, { url: 'https://hooks.example.test/home', events: NAMED });
		makeWebhook(cardBoard.board, { url: 'https://hooks.example.test/linked', events: NAMED });
		const { decision, act: run } = act.make();
		db.insert(decisionCardLinks).values({ decisionId: decision.id, cardId: card.id, relation: 'waits', createdBy: owner.id }).run();
		sent.clear();

		await run();
		await sent.settle();

		// The home board hears it, the linked card's board nothing.
		expect(sent.webhooks.map((d) => [d.url.split('/').pop(), d.event])).toEqual([['home', act.event]]);
		expect(JSON.stringify(sent.webhooks.map((d) => d.body))).not.toContain('CARDBOARDMARK');
	});
});

describe("the setter's view of the decision, asked at sending (R7)", () => {
	it('D6: a webhook whose setter can only read the board is sent the decision event, as that setter may view the decision', async () => {
		const setter = editor('setter');
		const hook = makeWebhook(board, { events: ['decision.ruled'], setBy: setter });
		db.update(boardMembers).set({ role: 'viewer' }).where(eq(boardMembers.userId, setter.id)).run();
		const { decision, decider, a } = openOn(board);
		expect(mayDo(decisionAccess(setter, decision), 'view', decision)).toBe(true);
		sent.clear();

		rule(decider, decision, a.id);
		await sent.settle();

		expect(sent.webhooks.map((d) => [d.event, d.body.data.decisionId])).toEqual([['decision.ruled', decision.id]]);
		expect(deliveryResultFor(hookRow(hook.id))).toMatchObject({ event: 'decision.ruled', outcome: 'delivered' });
	});

	it("D7: with view refused while the board stays open, neither webhook is sent the decision event, the setter is asked once, and both are still sent a card's event", async () => {
		const setter = editor('setter');
		const first = makeWebhook(board, { url: 'https://hooks.example.test/first', events: ['decision.ruled', 'card.created'], setBy: setter });
		const second = makeWebhook(board, { url: 'https://hooks.example.test/second', events: ['decision.ruled', 'card.created'], setBy: setter });
		const { decision, decider, a } = openOn(board);
		view.refused.add(setter.id);
		const spy = vi.mocked(visibleDecisionIdsOf);
		spy.mockClear();
		sent.clear();

		rule(decider, decision, a.id);
		await sent.settle();

		expect(sent.webhooks).toEqual([]);
		for (const hook of [first, second]) {
			expect(deliveryResultFor(hookRow(hook.id)), `${hook.id}`).toMatchObject({
				event: 'decision.ruled',
				outcome: 'not-sent',
				reason: 'Not sent: its setter may not view this decision'
			});
			expect(hookRow(hook.id), `${hook.id}`).toMatchObject({ active: true, heldBecause: null });
		}
		// Once for the dispatch, for both webhooks of the one setter.
		expect(spy.mock.calls.filter(([user]) => user?.id === setter.id)).toEqual([[expect.objectContaining({ id: setter.id }), [decision.id]]]);

		const card = makeCard(cols['To Do'], { title: 'New' });
		logActivity({ boardId: board.id, cardId: card.id, action: ACTIONS.cardCreated, detail: '"New"' });
		await sent.settle();
		expect(sent.webhooks.map((d) => [d.url.split('/').pop(), d.event])).toEqual([
			['first', 'card.created'],
			['second', 'card.created']
		]);
	});
});

// ─── The code review's cases (card 2689) ───────────────────────────────────

describe("the code review's cases (card 2689)", () => {
	const REFUSED = 'Not sent: its setter may not view this decision';
	const LOST = 'Not sent: the account that set it up can no longer open this board';
	const spy = vi.mocked(visibleDecisionIdsOf);

	/** The lines the webhooks wrote at `level`, oldest first. */
	const lines = (level: 'WARN' | 'ERROR') =>
		(sqlite.prepare("SELECT message FROM system_logs WHERE context = 'Webhooks' AND level = ? ORDER BY id").all(level) as { message: string }[]).map((row) => row.message);

	/** A decision event as `logActivity` builds it, dispatched to `boardId` by hand. */
	const ruled = (boardId: number, decision: Decision) =>
		dispatchWebhook(boardId, 'decision.ruled', { decisionId: decision.id, action: 'decision_ruled', source: 'ui', title: decision.title, status: 'ruled' });

	// WARN lines are written only from INFO; kept off the console.
	let level: string | undefined;
	let quiet: { mockRestore(): void }[] = [];
	beforeEach(() => {
		level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'INFO';
		quiet = [vi.spyOn(console, 'warn').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {})];
		sqlite.prepare("DELETE FROM system_logs WHERE context = 'Webhooks'").run();
	});
	afterEach(() => {
		if (level === undefined) delete process.env.LOG_LEVEL;
		else process.env.LOG_LEVEL = level;
		for (const one of quiet) one.mockRestore();
	});

	it("S-L1: a decision event dispatched to a linked card's board, whose webhook's setter is the decision's decider, is not sent", async () => {
		const { decision, decider } = openOn(board);
		const cardBoard = makeBoard({ owner, name: 'CARDBOARDMARK' }).board;
		addBoardMember(cardBoard, decider, 'editor');
		const linked = makeWebhook(cardBoard, { events: NAMED, setBy: decider });
		// The decider may view the decision: only the board refuses it.
		expect(mayDo(decisionAccess(decider, decision), 'view', decision)).toBe(true);
		sent.clear();

		ruled(cardBoard.id, decision);
		await sent.settle();

		expect(sent.webhooks).toEqual([]);
		expect(deliveryResultFor(hookRow(linked.id))).toMatchObject({ event: 'decision.ruled', outcome: 'not-sent', reason: REFUSED });
		expect(hookRow(linked.id)).toMatchObject({ active: true, heldBecause: null });
	});

	it('S-L2: decision.superseded names what replaced it only when that decision is on the same board', async () => {
		makeWebhook(board, { url: 'https://hooks.example.test/home', events: NAMED });
		const other = makeBoard({ owner }).board;
		makeWebhook(other, { url: 'https://hooks.example.test/other', events: NAMED });
		const old = openOn(board, { title: 'The old one' });
		makeRuling(old.decision);
		const next = openOn(board, { title: 'The new one', supersedesId: old.decision.id, decider: old.decider });
		// No route moves a decision to another board: a direct change, so that the payload's own rule is what is tested.
		addBoardMember(other, old.decider, 'editor');
		db.update(decisions).set({ boardId: other.id }).where(eq(decisions.id, next.decision.id)).run();
		sent.clear();

		rule(old.decider, decisionRow(next.decision.id), next.a.id);
		await sent.settle();

		expect(decisionRow(old.decision.id).status).toBe('superseded');
		const heard = Object.fromEntries(sent.webhooks.map((d) => [d.url.split('/').pop(), { event: d.event, data: d.body.data }]));
		expect(heard).toEqual({
			home: { event: 'decision.superseded', data: { decisionId: old.decision.id, action: 'decision_superseded', source: 'ui', title: 'The old one', status: 'superseded' } },
			other: { event: 'decision.ruled', data: { decisionId: next.decision.id, action: 'decision_ruled', source: 'ui', title: 'The new one', status: 'ruled' } }
		});
	});

	it("E-L3: a webhook naming only decision events whose setter lost the board is switched off by decision.ruled with the hold's sentence and the owners' mail, the view never asked", async () => {
		const setter = editor('setter');
		const hook = makeWebhook(board, { events: NAMED, setBy: setter });
		const { decision, decider, a } = openOn(board);
		// A path no sweep runs: the member row deleted from the host.
		sqlite.prepare('DELETE FROM board_members WHERE board_id = ? AND user_id = ?').run(board.id, setter.id);
		spy.mockClear();
		sent.clear();

		rule(decider, decision, a.id);
		await sent.settle();

		expect(sent.webhooks).toEqual([]);
		expect(deliveryResultFor(hookRow(hook.id))).toMatchObject({ event: 'decision.ruled', outcome: 'not-sent', reason: LOST });
		expect(hookRow(hook.id)).toMatchObject({ active: false, heldBecause: 'setter cannot open' });
		expect(sent.emails.filter((mail) => / switched off$/.test(mail.subject)).map((mail) => mail.to)).toEqual([owner.email]);
		expect(spy.mock.calls.filter(([user]) => user?.id === setter.id)).toEqual([]);
	});

	it('E-L4, E-L9: a view check that throws: not sent with the decision sentence, one ERROR an hour, asked once for two webhooks of one setter, and card events still sent', async () => {
		const setter = editor('setter');
		const first = makeWebhook(board, { url: 'https://hooks.example.test/first', events: ['decision.ruled', 'card.created'], setBy: setter });
		const second = makeWebhook(board, { url: 'https://hooks.example.test/second', events: ['decision.ruled', 'card.created'], setBy: setter });
		const { decision, decider, a } = openOn(board);
		view.thrown.add(setter.id);
		spy.mockClear();
		sent.clear();

		rule(decider, decision, a.id);
		await sent.settle();

		expect(sent.webhooks).toEqual([]);
		for (const hook of [first, second]) {
			expect(deliveryResultFor(hookRow(hook.id)), `${hook.id}`).toMatchObject({ event: 'decision.ruled', outcome: 'not-sent', reason: REFUSED });
			expect(hookRow(hook.id), `${hook.id}`).toMatchObject({ active: true, heldBecause: null });
		}
		const error = `Webhook ${first.id} on board ${board.id}: whether its setter may view decision ${decision.id} could not be told, so it was not sent: VIEWFAULTMARK`;
		expect(lines('ERROR')).toEqual([error]);
		// Once for the dispatch, for both webhooks of the one setter.
		expect(spy.mock.calls.filter(([user]) => user?.id === setter.id)).toHaveLength(1);

		// E-L9: a second event within the hour asks again and fails again, and writes no second ERROR.
		ruled(board.id, decisionRow(decision.id));
		await sent.settle();
		expect(spy.mock.calls.filter(([user]) => user?.id === setter.id)).toHaveLength(2);
		expect(sent.webhooks).toEqual([]);
		expect(lines('ERROR')).toEqual([error]);

		const card = makeCard(cols['To Do'], { title: 'New' });
		logActivity({ boardId: board.id, cardId: card.id, action: ACTIONS.cardCreated, detail: '"New"' });
		await sent.settle();
		expect(sent.webhooks.map((d) => [d.url.split('/').pop(), d.event])).toEqual([
			['first', 'card.created'],
			['second', 'card.created']
		]);
	});

	it('E-L4: a decision event with no decision id is not sent', async () => {
		const hook = makeWebhook(board, { events: ['decision.ruled'] });
		sent.clear();

		dispatchWebhook(board.id, 'decision.ruled', {});
		await sent.settle();

		expect(sent.webhooks).toEqual([]);
		expect(deliveryResultFor(hookRow(hook.id))).toMatchObject({ event: 'decision.ruled', outcome: 'not-sent', reason: REFUSED });
	});

	it('E-L4: a refusal writes one WARN naming the webhook, its board and the decision, and a second within the hour writes none', async () => {
		const setter = editor('setter');
		const hook = makeWebhook(board, { events: ['decision.ruled'], setBy: setter });
		const { decision } = openOn(board);
		view.refused.add(setter.id);
		sent.clear();

		ruled(board.id, decision);
		ruled(board.id, decision);
		await sent.settle();

		expect(sent.webhooks).toEqual([]);
		expect(deliveryResultFor(hookRow(hook.id))).toMatchObject({ outcome: 'not-sent', reason: REFUSED });
		expect(lines('WARN')).toEqual([`Webhook ${hook.id} on board ${board.id} not sent: its setter may not view decision ${decision.id}`]);
	});

	it('E-L5: no runtime import reachable from decision-visibility.ts is logActivity.ts, webhooks.ts or route-guards.ts', () => {
		const ROOT = process.cwd();
		/** A module's file, from the importing file and its specifier; undefined for a package. */
		const resolve = (from: string, spec: string): string | undefined => {
			const base = spec.startsWith('$lib/') ? join(ROOT, 'src/lib', spec.slice(5)) : spec.startsWith('.') ? join(dirname(from), spec) : undefined;
			if (base === undefined) return undefined;
			const candidates = [`${base}.ts`, `${base}.js`, join(base, 'index.ts')];
			if (/\.(ts|js)$/.test(base)) candidates.unshift(base);
			const found = candidates.find((file) => existsSync(file));
			expect(found, `${spec} from ${relative(ROOT, from)}`).toBeDefined();
			return found;
		};
		/** The specifiers a file imports or re-exports at run time: never `import type`, nor an import of types alone. */
		const runtimeImports = (file: string): string[] => {
			const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false);
			const specs: string[] = [];
			for (const statement of source.statements) {
				if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
					const clause = statement.importClause;
					const typesAlone =
						clause !== undefined &&
						(clause.isTypeOnly ||
							(clause.name === undefined &&
								clause.namedBindings !== undefined &&
								ts.isNamedImports(clause.namedBindings) &&
								clause.namedBindings.elements.length > 0 &&
								clause.namedBindings.elements.every((element) => element.isTypeOnly)));
					if (!typesAlone) specs.push(statement.moduleSpecifier.text);
				} else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) && !statement.isTypeOnly) {
					specs.push(statement.moduleSpecifier.text);
				}
			}
			return specs;
		};

		const start = join(ROOT, 'src/lib/server/decision-visibility.ts');
		const seen = new Set<string>([start]);
		const queue = [start];
		while (queue.length > 0) {
			const file = queue.shift()!;
			for (const spec of runtimeImports(file)) {
				const next = resolve(file, spec);
				if (next !== undefined && !seen.has(next)) {
					seen.add(next);
					queue.push(next);
				}
			}
		}
		const reached = [...seen].map((file) => relative(ROOT, file).replaceAll('\\', '/'));
		// The walk is real: it reaches what decision-visibility.ts is built on.
		expect(reached).toEqual(expect.arrayContaining(['src/lib/server/board-access.ts', 'src/lib/server/db/index.ts', 'src/lib/server/decision-record.ts']));
		for (const never of ['src/lib/server/logActivity.ts', 'src/lib/server/webhooks.ts', 'src/lib/server/route-guards.ts']) expect(reached, never).not.toContain(never);
	});
});
