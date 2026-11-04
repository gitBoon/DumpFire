/**
 * Previewing, a dry run, opening and the lifecycle controls (card 2697):
 * slice B1, the dry run (`dryRunDecision`), the revision required on opening
 * and re-publishing, the volume limits (dry runs and publishes per caller,
 * record mail per participant), the closing time held to a year ahead, and
 * the six lifecycle routes through the gate; slice B2a, the editor's
 * delivery panel (`delivery` in `readEditPage`) and the Resend route; slice
 * B2b, the password asked on the administrator's account and address routes
 * (case 40); slice B3, the preview (`readPreview`, case 44); slice B4, the
 * lifecycle flags and re-publish summary of `readEditPage` (cases 48, 49),
 * and the password asked on deleting and withdrawing a decision that was ever
 * opened (cases 50, 62). The code review's part B (2026-11-04): a closing
 * time more than a year ahead refused on opening and re-publishing (S3), the
 * record mail one caller causes capped across decisions (S2), each cap's end
 * read as `mailRestOf` reads it (F7), and the administrator's offers decided
 * by the writes' own rules (F2).
 *
 * Each write is called as a route will call it, inside `writeAs` and handed
 * its `caller`, with `effects()` installed so that no mail leaves, mail set
 * up (`makeSmtp`), an App URL saved and the in-memory limits emptied
 * (`resetAllRateLimits`) before each case. A reader's own refusals are
 * `request-body.test.ts`'s and role refusals the access table's; neither is
 * repeated. The cases are the plan's, `docs/planning/card-2676-decision-
 * authoring.md`, section 6 part B, by number.
 */
import { isHttpError } from '@sveltejs/kit';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const stub = vi.hoisted(() => ({
	/** Passwords compared since the case began. */
	compared: 0,
	/** While set, each compare waits for it: a check held in flight (case 40's hash moved meanwhile). */
	hold: undefined as Promise<void> | undefined,
	/**
	 * Run once, right after a route's delete or withdraw guard answers, and
	 * then cleared: what happens between the guard's own transaction and the
	 * one with no password (cases 50 and 62's race).
	 */
	afterGuard: undefined as (() => void) | undefined
}));

vi.mock('$lib/server/decisions', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/decisions')>();
	const then = <T>(answer: T): T => {
		const run = stub.afterGuard;
		stub.afterGuard = undefined;
		run?.();
		return answer;
	};
	return {
		...real,
		decisionDeleteGuard: (...args: Parameters<typeof real.decisionDeleteGuard>) => then(real.decisionDeleteGuard(...args)),
		decisionWithdrawGuard: (...args: Parameters<typeof real.decisionWithdrawGuard>) => then(real.decisionWithdrawGuard(...args))
	};
});

vi.mock('$lib/server/passwords', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/passwords')>();
	return {
		...real,
		checkPassword: async (...args: Parameters<typeof real.checkPassword>) => {
			stub.compared++;
			await stub.hold;
			return real.checkPassword(...args);
		}
	};
});

import { hashSync } from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { SESSION_COOKIE_NAME, type SessionUser } from '$lib/server/auth';
import {
	decisionOptions as decisionOptionsTable,
	decisionParticipants,
	decisions,
	people,
	sessions,
	settings,
	users,
	type Board,
	type Decision,
	type DecisionParticipant
} from '$lib/server/db/schema';
import { readPreview } from '$lib/server/decision-view';
import { PASSWORD_CHANGED_MEANWHILE, STEP_UP_MISSING, STEP_UP_WRONG } from '$lib/server/step-up';
import { decisionAnswer, LIFECYCLE_ACTIONS, participantAnswers, readEditPage, revisionFor } from '$lib/server/decision-authoring';
import { decisionAccess, mayDo } from '$lib/server/decision-access';
import { STORED_STATUSES, TRANSITIONS } from '$lib/server/decision-status';
import { appendEvent, SYSTEM_ACTOR } from '$lib/server/decision-record';
import { REVOKE_WORDS, SKIP_WORDS } from '$lib/server/decision-links';
import { CALLER_MAIL_DAILY_CAP, DRY_RUN_DAILY_CAP, PUBLISH_DAILY_CAP, RECORD_MAIL_DAILY_CAP } from '$lib/server/decision-mail';
import {
	dryRunDecision,
	extendDecision,
	openDecision,
	participantAccountGuard,
	participantAddressGuard,
	republishDecision,
	resendInvitation,
	setParticipants,
	updateDraft,
	withdrawDecision
} from '$lib/server/decisions';
import { MAIL_PROBLEM_WORDS, NO_LINK_ADDRESS } from '$lib/server/email';
import { resetAllRateLimits, takeAllowance } from '$lib/server/rate-limit';
import { writeAs, type ServiceOptions } from '$lib/server/write-as';
import { CLOSES_TOO_FAR, CLOSES_TOO_FAR_TO_OPEN, CLOSES_TOO_FAR_TO_REPUBLISH } from '$lib/decision-readiness';
import { STALE_REVISION } from '$lib/decision-words';
import { parseStamp, stamp } from '$lib/timestamps';
import { api } from './helpers/api';
import { FUTURE, readyDraft, revisionNow, type Ready } from './helpers/decision-faults';
import { effects, type Effects } from './helpers/effects';
import {
	FIXTURE_PASSWORD,
	addBoardMember,
	ageRecordMail,
	makeBoard,
	makeDecision,
	makeOption,
	makeParticipant,
	makePerson,
	makeResponse,
	makeSession,
	makeSmtp,
	makeUser,
	makeVersion,
	resetDb,
	stepUp
} from './helpers/fixtures';
import { gate, gateRoutes } from './helpers/gate';

const APP = 'https://kanban.example.test';
const UI: ServiceOptions = { source: 'ui' };
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

let sent: Effects;
let owner: SessionUser;
let board: Board;

beforeEach(() => {
	resetDb();
	resetAllRateLimits();
	stub.compared = 0;
	stub.hold = undefined;
	stub.afterGuard = undefined;
	makeSmtp();
	db.insert(settings).values({ key: 'app_url', value: APP }).run();
	owner = makeUser({ username: 'owner' });
	board = makeBoard({ owner, name: 'The board' }).board;
	sent = effects();
});

afterEach(() => {
	sent.restore();
});

/** Call a write as `user`, as a route calls it inside its writeAs callback. */
const as = <T>(user: SessionUser, write: (caller: SessionUser | null) => T): T => writeAs({ user } as App.Locals, write as never) as T;

/** What a write was answered with: 'passed', or the refusal's status and words. */
function outcome(run: () => unknown): 'passed' | { status: number; message: string } {
	try {
		run();
		return 'passed';
	} catch (err) {
		if (isHttpError(err)) return { status: err.status, message: err.body.message };
		throw err;
	}
}

type EventRow = { id: number; kind: string; participantId: number | null; detail: any; actorUserId: number | null; source: string; createdAt: string };

/** The decision's events, in order, their detail read. */
function eventsOf(decisionId: number): EventRow[] {
	return (
		sqlite
			.prepare(
				'SELECT id, kind, participant_id AS participantId, detail, actor_user_id AS actorUserId, source, created_at AS createdAt FROM decision_events WHERE decision_id = ? ORDER BY id'
			)
			.all(decisionId) as (Omit<EventRow, 'detail'> & { detail: string | null })[]
	).map((row) => ({ ...row, detail: row.detail === null ? null : JSON.parse(row.detail) }));
}

const count = (table: string) => (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const decisionRow = (id: number) => db.select().from(decisions).where(eq(decisions.id, id)).get()!;
/** Every row the record and the decisions hold: what a refused write must leave as it was. */
const written = () => ({
	decisions: sqlite.prepare('SELECT * FROM decisions ORDER BY id').all(),
	participants: sqlite.prepare('SELECT * FROM decision_participants ORDER BY id').all(),
	options: sqlite.prepare('SELECT * FROM decision_options ORDER BY id').all(),
	versions: count('decision_versions'),
	events: count('decision_events'),
	activity: count('activity_log')
});

/** A moment `ms` from now, in the stored form. */
const fromNow = (ms: number) => stamp(new Date(Date.now() + ms));
/** A stored moment moved on by `ms`. */
const plus = (at: string, ms: number) => stamp(new Date(parseStamp(at)!.getTime() + ms));
/** A stored moment as a body sends it. */
const sentAs = (at: string) => `${at.replace(' ', 'T')}Z`;
/** A stamp in a refusal's words. */
const STAMP = '\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}';

/** An event written straight into the record, at `at`: what a case sets up that no write of this card makes. */
function insertEvent(e: { decisionId: number; kind: string; at: string; participantId?: number | null; actorUserId?: number | null; detail?: unknown }): void {
	sqlite
		.prepare(
			'INSERT INTO decision_events (decision_id, participant_id, kind, version_number, detail, actor_user_id, actor_name, source, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)'
		)
		.run(e.decisionId, e.participantId ?? null, e.kind, e.detail === undefined ? null : JSON.stringify(e.detail), e.actorUserId ?? null, 'someone', 'ui', e.at);
}

/** The account's person in the people directory, at the account's own address: the one address a dry run may go to (Q26). */
const inDirectory = (user: SessionUser, fullName = `${user.username} in People`) => makePerson({ fullName, email: user.email, user });

/** A dry run by `user`, sending the revision as the page holds it. */
const dryRun = (user: SessionUser, decisionId: number, body: Record<string, unknown> = { revision: revisionNow(decisionId) }) =>
	as(user, (caller) => dryRunDecision(caller, { decisionId }, body, UI));

/** The dry-run events by `userId`, across decisions. */
const dryRunsBy = (userId: number) => (sqlite.prepare("SELECT COUNT(*) AS n FROM decision_events WHERE kind = 'dry_run' AND actor_user_id = ?").get(userId) as { n: number }).n;

/** Open `decision` as `user`, with the revision. */
const open = (user: SessionUser, decisionId: number) => as(user, (caller) => openDecision(caller, { decisionId }, { revision: revisionNow(decisionId) }, UI));

/** An open decision made by hand, version 1, two options published in it, by `author` and decided by `decider`. */
function openByHand(author: SessionUser, decider: SessionUser = author, title = 'Open by hand'): Decision {
	const decision = makeDecision({ board, author, decider, title, status: 'open', closesAt: FUTURE, currentVersion: 1, openedAt: '2026-11-01 09:00:00' });
	makeOption(decision, { label: 'A', position: 0, addedInVersion: 1 });
	makeOption(decision, { label: 'B', position: 1, addedInVersion: 1 });
	return decisionRow(decision.id);
}

/** A board editor, by name. */
function editorNamed(username: string): SessionUser {
	const user = makeUser({ username });
	addBoardMember(board, user, 'editor');
	return user;
}

/** A draft of `author`'s that opens: a closing time ahead, two options and one consulted participant reached by a link. */
function readyOf(author: SessionUser, decider: SessionUser = author, title = 'Ready'): Decision {
	const decision = makeDecision({ board, author, decider, title, closesAt: FUTURE });
	makeOption(decision, { label: 'A', position: 0 });
	makeOption(decision, { label: 'B', position: 1 });
	makeParticipant(decision, { person: makePerson({ fullName: `Asked of ${title}` }), role: 'consulted' });
	return decisionRow(decision.id);
}

// ─── The dry run (cases 32 to 34, 55) ────────────────────────────────────────

describe('dryRunDecision', () => {
	it('(a) mails the author alone the invitation from the working copy, escaped, and records one dry_run event and nothing else (32)', async () => {
		const r = readyDraft({ board });
		inDirectory(r.author);
		db.update(decisions)
			.set({ title: 'Pick <b>one</b>', workingContent: JSON.stringify({ ...r.working, question: 'Which <b>budget</b>?', ask: 'Pick <b>one</b> you can live with.' }) })
			.where(eq(decisions.id, r.draft.id))
			.run();
		db.update(users).set({ username: 'Ann <b>Author</b>' }).where(eq(users.id, r.author.id)).run();
		// The account as a session hands it now.
		const author = { ...r.author, username: 'Ann <b>Author</b>' };
		const activity = count('activity_log');

		dryRun(author, r.draft.id);
		await sent.settle();

		expect(sent.emails.map((mail) => [mail.to, mail.subject])).toEqual([[r.author.email, 'Dry run: Your view is asked: Pick <b>one</b>']]);
		const html = sent.emails[0].html;
		expect(html).toContain('Which &lt;b&gt;budget&lt;/b&gt;?');
		expect(html).toContain('Pick &lt;b&gt;one&lt;/b&gt; you can live with.');
		expect(html).toContain(`${FUTURE} UTC`);
		expect(html).toContain('Who decides:</strong> decider');
		expect(html).toContain('This dry run was sent at the request of Ann &lt;b&gt;Author&lt;/b&gt;.');
		expect(html).toContain(`${APP}/decisions/${r.draft.id}/preview`);
		expect(html).not.toContain('<b>');
		expect(sent.duringTransaction).toEqual([]);

		expect(eventsOf(r.draft.id).map(({ kind, participantId, detail, actorUserId, source }) => ({ kind, participantId, detail, actorUserId, source }))).toEqual([
			{ kind: 'dry_run', participantId: null, detail: {}, actorUserId: r.author.id, source: 'ui' }
		]);
		const rows = sqlite.prepare('SELECT link_token_hash AS hash FROM decision_participants WHERE decision_id = ?').all(r.draft.id) as { hash: string | null }[];
		expect(rows.every((row) => row.hash === null)).toBe(true);
		expect(count('activity_log')).toBe(activity);
		expect(sent.events).toEqual([]);
	});

	it('(b) quotes the working copy as edited after version 1, not the version, to the decider (32)', async () => {
		const r = readyDraft({ board });
		open(r.author, r.draft.id);
		await sent.settle();
		inDirectory(r.decider);
		db.update(decisions)
			.set({ workingContent: JSON.stringify({ ...r.working, question: 'Which budget, now that the dates moved?' }) })
			.where(eq(decisions.id, r.draft.id))
			.run();
		sent.clear();

		dryRun(r.decider, r.draft.id);
		await sent.settle();

		expect(sent.emails.map((mail) => mail.to)).toEqual([r.decider.email]);
		expect(sent.emails[0].html).toContain('Which budget, now that the dates moved?');
		expect(sent.emails[0].html).not.toContain('Which budget?');
	});

	it("(c) carries no personal link and neither participant's address, on an open decision with a link holder and an account holder (32)", async () => {
		const r = readyDraft({ board });
		open(r.author, r.draft.id);
		await sent.settle();
		// Opening gave the link holder a link and mailed the account holder.
		expect(sent.emails.map((mail) => mail.to).sort()).toEqual([r.holderPerson.email, r.linkPerson.email].sort());
		inDirectory(r.author);
		sent.clear();

		dryRun(r.author, r.draft.id);
		await sent.settle();

		expect(sent.emails).toHaveLength(1);
		const html = sent.emails[0].html;
		expect(html).not.toContain('/decision-link/');
		expect(html).not.toContain(r.holderPerson.email);
		expect(html).not.toContain(r.linkPerson.email);
	});

	describe('the throttle (33)', () => {
		it('(a) refuses the same caller again within 10 minutes, on another decision, 429 saying from when', async () => {
			const r = readyDraft({ board });
			inDirectory(r.author);
			const second = makeDecision({ board, author: r.author, decider: r.decider, title: 'Second' });
			dryRun(r.author, r.draft.id);
			const at = eventsOf(r.draft.id)[0].createdAt;
			const before = written();
			await sent.settle();
			sent.clear();

			expect(outcome(() => dryRun(r.author, second.id))).toEqual({
				status: 429,
				message: `Your last dry run was less than 10 minutes ago: the next can be sent from ${plus(at, 10 * MINUTE)} UTC`
			});
			expect(written()).toEqual(before);
			await sent.settle();
			expect(sent.emails).toEqual([]);
		});

		it("(b) does not hold the decider's first by the author's", async () => {
			const r = readyDraft({ board });
			inDirectory(r.author);
			inDirectory(r.decider);
			dryRun(r.author, r.draft.id);

			expect(outcome(() => dryRun(r.decider, r.draft.id))).toBe('passed');
			await sent.settle();
			expect(sent.emails.map((mail) => mail.to)).toEqual([r.author.email, r.decider.email]);
		});

		it('(c) refuses a 21st in 24 hours, read from the record, 429 from the earliest plus 24 hours', async () => {
			const r = readyDraft({ board });
			inDirectory(r.author);
			const moments = Array.from({ length: DRY_RUN_DAILY_CAP }, (_, n) => fromNow(-(23 * 60 - n * 60) * MINUTE));
			for (const at of moments) insertEvent({ decisionId: r.draft.id, kind: 'dry_run', at, actorUserId: r.author.id, detail: {} });
			const before = written();

			expect(outcome(() => dryRun(r.author, r.draft.id))).toEqual({
				status: 429,
				message: `You have sent 20 dry runs in the last 24 hours: the next can be sent from ${plus(moments[0], DAY)} UTC`
			});
			expect(written()).toEqual(before);
			await sent.settle();
			expect(sent.emails).toEqual([]);
		});

		it('(d) refuses a 21st from the allowance in memory once the decisions, and their events with them, are deleted', async () => {
			const r = readyDraft({ board });
			inDirectory(r.author);
			for (let n = 0; n < DRY_RUN_DAILY_CAP; n++) {
				expect(outcome(() => dryRun(r.author, r.draft.id)), `dry run ${n + 1}`).toBe('passed');
				// The clock moved past the 10 minutes between each.
				sqlite.prepare("UPDATE decision_events SET created_at = strftime('%Y-%m-%d %H:%M:%S', created_at, '-11 minutes') WHERE kind = 'dry_run'").run();
			}
			await sent.settle();
			expect(sent.emails).toHaveLength(DRY_RUN_DAILY_CAP);
			db.delete(decisions).where(eq(decisions.authorUserId, r.author.id)).run();
			expect(dryRunsBy(r.author.id)).toBe(0);
			const another = makeDecision({ board, author: r.author, decider: r.decider, title: 'Another' });
			const before = written();
			sent.clear();

			const refused = outcome(() => dryRun(r.author, another.id));
			expect(refused).toMatchObject({ status: 429 });
			expect((refused as { message: string }).message).toMatch(new RegExp(`^You have sent 20 dry runs in the last 24 hours: the next can be sent from ${STAMP} UTC$`));
			expect(written()).toEqual(before);
			await sent.settle();
			expect(sent.emails).toEqual([]);
		});
	});

	describe('refusals that take no allowance (34)', () => {
		const rows: [name: string, unmake: (r: Ready) => (() => void) | void, body: (r: Ready) => Record<string, unknown>, status: number, message: string][] = [
			[
				'no mail host',
				() => {
					db.delete(settings).where(eq(settings.key, 'smtp_host')).run();
					return () => db.insert(settings).values({ key: 'smtp_host', value: 'smtp.example.test' }).run();
				},
				(r) => ({ revision: revisionNow(r.draft.id) }),
				409,
				'Mail is not set up on this server: a dry run cannot be sent'
			],
			[
				'no link address',
				() => {
					db.delete(settings).where(eq(settings.key, 'app_url')).run();
					const env = { ORIGIN: process.env.ORIGIN, APP_URL: process.env.APP_URL };
					delete process.env.ORIGIN;
					delete process.env.APP_URL;
					return () => {
						for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
						db.insert(settings).values({ key: 'app_url', value: APP }).run();
					};
				},
				(r) => ({ revision: revisionNow(r.draft.id) }),
				409,
				NO_LINK_ADDRESS
			],
			['no revision', () => {}, () => ({}), 400, 'revision is required'],
			['a stale revision', () => {}, () => ({ revision: 'stale' }), 409, STALE_REVISION]
		];

		it.each(rows)('%s: refused with nothing written, and a dry run with everything right then goes', async (_name, unmake, body, status, message) => {
			const r = readyDraft({ board });
			inDirectory(r.author);
			// Nineteen of the twenty taken already: a refusal that took one would leave none for the dry run after it.
			expect(takeAllowance(`decision-dry-run:${r.author.id}`, DRY_RUN_DAILY_CAP - 1, DRY_RUN_DAILY_CAP, DAY)).toEqual({ taken: true });
			const put = unmake(r);
			const before = written();

			expect(outcome(() => dryRun(r.author, r.draft.id, body(r)))).toEqual({ status, message });
			expect(written()).toEqual(before);
			await sent.settle();
			expect(sent.emails).toEqual([]);

			put?.();
			expect(outcome(() => dryRun(r.author, r.draft.id))).toBe('passed');
			await sent.settle();
			expect(sent.emails.map((mail) => mail.to)).toEqual([r.author.email]);
		});
	});

	describe("the directory's address (55)", () => {
		const asks = 'A dry run is sent only to the address the people directory holds for you';
		it.each([
			[
				'a caller whom no person of the directory holds',
				(_r: Ready) => {},
				`${asks}, and it holds none for your account: an administrator can add you in People`,
				(r: Ready) => inDirectory(r.author)
			],
			[
				"a caller whose person holds another address than the account's",
				(r: Ready) => makePerson({ fullName: 'Ann Author', email: 'ann.elsewhere@example.test', user: r.author }),
				`${asks}, and it is not your account's address: an administrator can make them agree`,
				(r: Ready) => db.update(people).set({ email: r.author.email }).where(eq(people.userId, r.author.id)).run()
			]
		])('%s: 409, nothing written or sent, and allowed once the directory holds the address', async (_name, make, message, mend) => {
			const r = readyDraft({ board });
			make(r);
			expect(takeAllowance(`decision-dry-run:${r.author.id}`, DRY_RUN_DAILY_CAP - 1, DRY_RUN_DAILY_CAP, DAY)).toEqual({ taken: true });
			const before = written();

			expect(outcome(() => dryRun(r.author, r.draft.id))).toEqual({ status: 409, message });
			expect(written()).toEqual(before);
			await sent.settle();
			expect(sent.emails).toEqual([]);

			mend(r);
			expect(outcome(() => dryRun(r.author, r.draft.id))).toBe('passed');
			await sent.settle();
			expect(sent.emails.map((mail) => mail.to)).toEqual([r.author.email]);
		});
	});
});

// ─── The revision on opening and re-publishing (case 35) ─────────────────────

describe('the revision on opening and re-publishing (35)', () => {
	/** An opened decision, its invitations sent and aged past the rest. */
	async function opened(): Promise<Ready> {
		const r = readyDraft({ board });
		open(r.author, r.draft.id);
		await sent.settle();
		ageRecordMail(r.draft.id);
		sent.clear();
		return r;
	}

	it.each([
		['openDecision with no revision', false, {}, 400, 'revision is required'],
		['openDecision with a stale revision', false, { revision: 'stale' }, 409, STALE_REVISION],
		['republishDecision with no revision', true, { changeNote: 'The dates moved.', askAgain: true }, 400, 'revision is required'],
		['republishDecision with a stale revision', true, { changeNote: 'The dates moved.', askAgain: true, revision: 'stale' }, 409, STALE_REVISION]
	] as const)('%s: refused, nothing written and nothing mailed', async (_name, republishing, body, status, message) => {
		const r = republishing ? await opened() : readyDraft({ board });
		const before = written();

		const write = republishing ? republishDecision : openDecision;
		expect(outcome(() => as(r.author, (caller) => write(caller, { decisionId: r.draft.id }, { ...body }, UI)))).toEqual({ status, message });
		expect(written()).toEqual(before);
		await sent.settle();
		expect(sent.all).toEqual([]);
	});
});

// ─── The six lifecycle routes, through the gate (case 36) ────────────────────

describe('the lifecycle routes, through the gate (36)', () => {
	beforeAll(async () => {
		await gateRoutes();
	}, 30_000);

	/** A request as the editor's page sends it: signed in, same origin, and saying it is JSON, with a body or none. */
	const send = (user: SessionUser, path: string, body?: Record<string, unknown>) =>
		gate('POST', path, {
			headers: {
				cookie: `${SESSION_COOKIE_NAME}=${makeSession(user)}`,
				accept: '*/*',
				'sec-fetch-site': 'same-origin',
				'content-type': 'application/json'
			},
			...(body === undefined ? {} : { body })
		});

	const rows: [route: string, make: (editor: SessionUser) => Decision, body: (id: number) => Record<string, unknown> | undefined][] = [
		['open', (editor) => readyOf(editor), (id) => ({ revision: revisionNow(id) })],
		['republish', (editor) => openByHand(editor), (id) => ({ changeNote: 'The dates moved.', askAgain: true, revision: revisionNow(id) })],
		['close', (editor) => openByHand(editor), () => undefined],
		// Card 2682 (D30): later than `FUTURE`, 90 days ahead, as Extend never brings the closing time earlier.
		['extend', (editor) => openByHand(editor), () => ({ closesAt: sentAs(fromNow(120 * DAY)) })],
		// An opened decision's withdrawal asks for the password (B4, Q29): the page sends it.
		['withdraw', (editor) => openByHand(editor), () => ({ reason: 'No longer needed.', currentPassword: FIXTURE_PASSWORD })]
	];

	it.each(rows)('POST …/%s answers { decision, revision } through the one projection', async (route, make, body) => {
		const editor = editorNamed('editor');
		const decision = make(editor);

		const res = await send(editor, `/api/decisions/${decision.id}/${route}`, body(decision.id));
		const answer = await res.json();

		expect(res.status, JSON.stringify(answer)).toBe(200);
		expect(Object.keys(answer).sort()).toEqual(['decision', 'revision']);
		expect(answer.decision).toEqual(decisionAnswer(decisionRow(decision.id), false));
		expect(Object.keys(answer.decision).sort()).toEqual(Object.keys(decisionAnswer(decisionRow(decision.id), false)).sort());
		expect(answer.revision).toBe(revisionFor(decision.id));
		await sent.settle();
	});

	it('POST …/dry-run answers { sent: true }, and no address', async () => {
		const editor = editorNamed('editor');
		inDirectory(editor);
		const decision = readyOf(editor);

		const res = await send(editor, `/api/decisions/${decision.id}/dry-run`, { revision: revisionNow(decision.id) });

		expect({ status: res.status, body: await res.json() }).toEqual({ status: 200, body: { sent: true } });
		await sent.settle();
		expect(sent.emails.map((mail) => mail.to)).toEqual([editor.email]);
	});
});

// ─── The publish limit (case 56) ─────────────────────────────────────────────

describe('the publish limit (56)', () => {
	it('(a) refuses opening once ten publishes by the caller are on the record in 24 hours, 429 from the earliest plus 24 hours', async () => {
		const r = readyDraft({ board });
		const elsewhere = [openByHand(r.author, r.author, 'First'), openByHand(r.author, r.author, 'Second')];
		const moments = Array.from({ length: PUBLISH_DAILY_CAP }, (_, n) => fromNow(-(20 * 60 - n * 60) * MINUTE));
		moments.forEach((at, n) => insertEvent({ decisionId: elsewhere[n % 2].id, kind: 'published', at, actorUserId: r.author.id, detail: {} }));
		const before = written();

		expect(outcome(() => open(r.author, r.draft.id))).toEqual({
			status: 429,
			message: `You have opened or re-published 10 decisions in the last 24 hours: the next can be sent from ${plus(moments[0], DAY)} UTC`
		});
		expect(written()).toEqual(before);
		await sent.settle();
		expect(sent.all).toEqual([]);
	});

	it('(b) refuses re-publishing from the allowance in memory once the ten decisions published, and their events, are deleted', async () => {
		const author = editorNamed('author');
		for (let n = 0; n < PUBLISH_DAILY_CAP; n++) {
			const draft = readyOf(author, author, `Draft ${n}`);
			expect(outcome(() => open(author, draft.id)), `opening ${n + 1}`).toBe('passed');
		}
		await sent.settle();
		db.delete(decisions).where(eq(decisions.authorUserId, author.id)).run();
		expect(count('decision_events')).toBe(0);
		const another = openByHand(author, author, 'Another');
		const before = written();
		sent.clear();

		const refused = outcome(() =>
			as(author, (caller) => republishDecision(caller, { decisionId: another.id }, { changeNote: 'Changed.', askAgain: true, revision: revisionNow(another.id) }, UI))
		);
		expect(refused).toMatchObject({ status: 429 });
		expect((refused as { message: string }).message).toMatch(
			new RegExp(`^You have opened or re-published 10 decisions in the last 24 hours: the next can be sent from ${STAMP} UTC$`)
		);
		expect(written()).toEqual(before);
		await sent.settle();
		expect(sent.all).toEqual([]);
	});
});

// ─── The daily cap on record mail to one participant (case 57) ───────────────

describe('the daily cap on record mail to one participant (57)', () => {
	/** An open decision whose link holder was mailed five times in the last 24 hours, each more than 10 minutes apart. */
	function mailedFiveTimes() {
		const author = editorNamed('author');
		const decision = openByHand(author);
		const participant = makeParticipant(decision, { person: makePerson({ fullName: 'Pat Doe' }), role: 'consulted' });
		const moments = Array.from({ length: RECORD_MAIL_DAILY_CAP }, (_, n) => fromNow(-(5 - n) * 60 * MINUTE));
		for (const at of moments) insertEvent({ decisionId: decision.id, participantId: participant.id, kind: 'told_of_change', at });
		const words = `Pat Doe has been mailed about this decision 5 times in the last 24 hours: they can be mailed again from ${plus(moments[0], DAY)} UTC`;
		return { author, decision, participant, words };
	}

	it('(a) refuses Resend, 409 in its words, nothing written or sent', async () => {
		const { author, decision, participant, words } = mailedFiveTimes();
		const before = written();

		expect(outcome(() => as(author, (caller) => resendInvitation(caller, { decisionId: decision.id, participantId: participant.id }, null, UI)))).toEqual({
			status: 409,
			message: words
		});
		expect(written()).toEqual(before);
		await sent.settle();
		expect(sent.all).toEqual([]);
	});

	it('(b) refuses re-publishing, 409 naming them, nothing written or sent', async () => {
		const { author, decision, words } = mailedFiveTimes();
		const before = written();

		expect(
			outcome(() =>
				as(author, (caller) => republishDecision(caller, { decisionId: decision.id }, { changeNote: 'Changed.', askAgain: true, revision: revisionNow(decision.id) }, UI))
			)
		).toEqual({ status: 409, message: words });
		expect(written()).toEqual(before);
		await sent.settle();
		expect(sent.all).toEqual([]);
	});

	it('(c) still mails them the withdrawal', async () => {
		const { author, decision, participant } = mailedFiveTimes();

		as(author, (caller) => withdrawDecision(caller, { decisionId: decision.id }, { reason: 'No longer needed.' }, UI));
		await sent.settle();

		expect(eventsOf(decision.id).filter((event) => event.kind === 'told_withdrawn').map((event) => event.participantId)).toEqual([participant.id]);
		expect(sent.emails.map((mail) => [mail.to, mail.subject])).toEqual([[participant.email, 'Withdrawn: Open by hand']]);
	});

	// Card 2697's code review, part B (S2): bringing a removed participant back invites them, so the same cap holds it.
	it('(d) refuses re-including them, 409 naming them, nothing written or sent', async () => {
		const { author, decision, participant, words } = mailedFiveTimes();
		db.update(decisionParticipants).set({ removedAt: fromNow(-MINUTE), removedBy: author.id }).where(eq(decisionParticipants.id, participant.id)).run();
		const before = written();

		expect(
			outcome(() =>
				as(author, (caller) =>
					setParticipants(caller, { decisionId: decision.id }, { participants: [{ personId: participant.personId!, role: 'consulted' }], revision: revisionNow(decision.id) }, UI)
				)
			)
		).toEqual({ status: 409, message: words });
		expect(written()).toEqual(before);
		await sent.settle();
		expect(sent.all).toEqual([]);
	});
});

// ─── The daily cap on record mail one caller causes (the code review's part B, S2) ─

describe('the daily cap on record mail one caller causes, across decisions (S2)', () => {
	/**
	 * `author`, with `recorded` invitations of theirs on the record in the last
	 * 24 hours, oldest first, spread over two other decisions: what the cap
	 * counts, whoever the participants were.
	 */
	function mailedElsewhere(recorded: number) {
		const author = editorNamed('author');
		const elsewhere = [openByHand(author, author, 'First'), openByHand(author, author, 'Second')];
		const moments = Array.from({ length: recorded }, (_, n) => fromNow(-(20 * 60 * MINUTE) + n * 1000));
		const insert = sqlite.transaction(() => moments.forEach((at, n) => insertEvent({ decisionId: elsewhere[n % 2].id, kind: 'invited', at, actorUserId: author.id })));
		insert();
		const words = `This would take your decision mail past ${CALLER_MAIL_DAILY_CAP} in the last 24 hours: it can be sent from ${plus(moments[0], DAY)} UTC`;
		return { author, moments, words };
	}

	it('(a) refuses a Resend on a third decision once the caller has caused 500 in 24 hours, 429 from the earliest plus 24 hours, nothing written or sent', async () => {
		const { author, words } = mailedElsewhere(CALLER_MAIL_DAILY_CAP);
		const third = openByHand(author, author, 'Third');
		const participant = makeParticipant(third, { person: makePerson({ fullName: 'Pat Doe' }), role: 'consulted' });
		const before = written();

		expect(outcome(() => as(author, (caller) => resendInvitation(caller, { decisionId: third.id, participantId: participant.id }, null, UI)))).toEqual({
			status: 429,
			message: words
		});
		expect(written()).toEqual(before);
		await sent.settle();
		expect(sent.all).toEqual([]);
	});

	it('(b) refuses opening a draft whose participants would take the caller past it, and opens one that fits', async () => {
		const { author, words } = mailedElsewhere(CALLER_MAIL_DAILY_CAP - 1);
		const two = readyOf(author, author, 'Two asked');
		makeParticipant(two, { person: makePerson({ fullName: 'Second asked' }), role: 'informed' });
		const before = written();

		// 499 and 2 is 501: the oldest must age out first.
		expect(outcome(() => open(author, two.id))).toEqual({ status: 429, message: words });
		expect(written()).toEqual(before);

		const one = readyOf(author, author, 'One asked');
		expect(outcome(() => open(author, one.id))).toBe('passed');
		await sent.settle();
		expect(sent.emails).toHaveLength(1);
	});

	it('(c) refuses including someone new on an open decision, 429, nothing written or sent', async () => {
		const { author, words } = mailedElsewhere(CALLER_MAIL_DAILY_CAP);
		const third = openByHand(author, author, 'Third');
		const newcomer = makePerson({ fullName: 'New Comer' });
		const before = written();

		expect(
			outcome(() =>
				as(author, (caller) =>
					setParticipants(caller, { decisionId: third.id }, { participants: [{ personId: newcomer.id, role: 'consulted' }], revision: revisionNow(third.id) }, UI)
				)
			)
		).toEqual({ status: 429, message: words });
		expect(written()).toEqual(before);
		await sent.settle();
		expect(sent.all).toEqual([]);
	});

	it('(d) does not hold another caller, and refuses from the allowance in memory once the record no longer shows the mail', async () => {
		const author = editorNamed('author');
		const decider = editorNamed('decider');
		const decision = openByHand(author, decider);
		const participant = makeParticipant(decision, { person: makePerson({ fullName: 'Pat Doe' }), role: 'consulted' });
		// The author's allowance spent, as a deletion of the decisions it was spent on would leave it.
		expect(takeAllowance(`decision-record-mail:${author.id}`, CALLER_MAIL_DAILY_CAP, CALLER_MAIL_DAILY_CAP, DAY)).toEqual({ taken: true });

		const refused = outcome(() => as(author, (caller) => resendInvitation(caller, { decisionId: decision.id, participantId: participant.id }, null, UI)));
		expect(refused).toMatchObject({ status: 429 });
		expect((refused as { message: string }).message).toMatch(
			new RegExp(`^This would take your decision mail past ${CALLER_MAIL_DAILY_CAP} in the last 24 hours: it can be sent from ${STAMP} UTC$`)
		);
		expect(outcome(() => as(decider, (caller) => resendInvitation(caller, { decisionId: decision.id, participantId: participant.id }, null, UI)))).toBe('passed');
	});
});

// ─── The caps' ends (the code review's part B, F7) ───────────────────────────

describe("each cap's end is read as mailRestOf reads it, now < from (F7)", () => {
	/** The clock held at a whole second, so that a moment exactly a day old is one. */
	function holdTheClock(): number {
		const now = Math.floor(Date.now() / 1000) * 1000;
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(now);
		return now;
	}
	afterEach(() => vi.useRealTimers());

	it('lets the eleventh publish through once the oldest of ten is exactly 24 hours old, and refuses it a second sooner', async () => {
		const now = holdTheClock();
		const r = readyDraft({ board });
		const elsewhere = openByHand(r.author, r.author, 'Elsewhere');
		const record = (oldest: number) => {
			sqlite.prepare("DELETE FROM decision_events WHERE kind = 'published'").run();
			for (let n = 0; n < PUBLISH_DAILY_CAP; n++) {
				insertEvent({ decisionId: elsewhere.id, kind: 'published', at: stamp(new Date(n === 0 ? oldest : now - 60 * MINUTE)), actorUserId: r.author.id, detail: {} });
			}
		};

		record(now - DAY + 1000);
		expect(outcome(() => open(r.author, r.draft.id))).toEqual({
			status: 429,
			message: `You have opened or re-published 10 decisions in the last 24 hours: the next can be sent from ${stamp(new Date(now + 1000))} UTC`
		});
		record(now - DAY);
		expect(outcome(() => open(r.author, r.draft.id))).toBe('passed');
		await sent.settle();
	});

	it('lets the 21st dry run through once the oldest of twenty is exactly 24 hours old, and the next once the last is exactly 10 minutes old', async () => {
		const now = holdTheClock();
		const r = readyDraft({ board });
		inDirectory(r.author);
		for (let n = 0; n < DRY_RUN_DAILY_CAP; n++) {
			insertEvent({ decisionId: r.draft.id, kind: 'dry_run', at: stamp(new Date(n === 0 ? now - DAY : now - 10 * MINUTE)), actorUserId: r.author.id, detail: {} });
		}

		expect(outcome(() => dryRun(r.author, r.draft.id))).toBe('passed');
		await sent.settle();
		expect(sent.emails.map((mail) => mail.to)).toEqual([r.author.email]);
	});
});

// ─── A closing time at most a year ahead (cases 58, 59) ──────────────────────

describe('a closing time at most a year ahead', () => {
	it.each([
		['366 days ahead', 366 * DAY, { status: 400, message: CLOSES_TOO_FAR }],
		['365 days ahead less a minute', 365 * DAY - MINUTE, 'passed']
	] as const)('extendDecision with closesAt %s (58)', (_name, ahead, expected) => {
		const decider = editorNamed('decider');
		const decision = openByHand(owner, decider);
		const closesAt = fromNow(ahead);
		const before = written();

		expect(outcome(() => as(decider, (caller) => extendDecision(caller, { decisionId: decision.id }, { closesAt: sentAs(closesAt) }, UI)))).toEqual(expected);
		if (expected === 'passed') expect(decisionRow(decision.id).closesAt).toBe(closesAt);
		else expect(written()).toEqual(before);
	});

	it.each([
		['366 days ahead', 366 * DAY, { status: 400, message: CLOSES_TOO_FAR }],
		['365 days ahead less a minute', 365 * DAY - MINUTE, 'passed']
	] as const)("updateDraft with a changed closesAt %s on a draft (59)", (_name, ahead, expected) => {
		const author = editorNamed('author');
		const draft = makeDecision({ board, author, decider: author, closesAt: FUTURE });
		const closesAt = fromNow(ahead);
		const before = written();

		expect(
			outcome(() => as(author, (caller) => updateDraft(caller, { decisionId: draft.id }, { revision: revisionNow(draft.id), closesAt: sentAs(closesAt) }, UI)))
		).toEqual(expected);
		if (expected === 'passed') expect(decisionRow(draft.id).closesAt).toBe(closesAt);
		else expect(written()).toEqual(before);
	});

	// Card 2697's code review, part B (S3): a stored closing time further out, as one set before the limit, or by hand.
	it('refuses opening a draft that closes more than 365 days ahead, 409 closes_too_far, nothing written or sent, and the readability check says so', async () => {
		const author = editorNamed('author');
		const draft = readyOf(author);
		db.update(decisions).set({ closesAt: fromNow(366 * DAY) }).where(eq(decisions.id, draft.id)).run();
		const before = written();

		expect(outcome(() => open(author, draft.id))).toEqual({ status: 409, message: CLOSES_TOO_FAR_TO_OPEN });
		expect(written()).toEqual(before);
		expect(readEditPage(author, draft.id).readiness.refusals).toEqual([{ code: 'closes_too_far', words: CLOSES_TOO_FAR_TO_OPEN }]);
		await sent.settle();
		expect(sent.all).toEqual([]);
	});

	it('refuses re-publishing an open decision that closes more than 365 days ahead, 409, nothing written or sent, and the readability check warns of it', async () => {
		const author = editorNamed('author');
		const decision = openByHand(author);
		makeParticipant(decision, { person: makePerson({ fullName: 'Pat Doe' }), role: 'consulted' });
		db.update(decisions).set({ closesAt: fromNow(366 * DAY) }).where(eq(decisions.id, decision.id)).run();
		const before = written();

		expect(
			outcome(() =>
				as(author, (caller) => republishDecision(caller, { decisionId: decision.id }, { changeNote: 'Changed.', askAgain: true, revision: revisionNow(decision.id) }, UI))
			)
		).toEqual({ status: 409, message: CLOSES_TOO_FAR_TO_REPUBLISH });
		expect(written()).toEqual(before);
		expect(readEditPage(author, decision.id).readiness.warnings.map((warning) => warning.code)).toContain('closes_too_far');
		await sent.settle();
		expect(sent.all).toEqual([]);
	});
});

// ─── Delivery (cases 37 to 39) ───────────────────────────────────────────────

describe('delivery in readEditPage', () => {
	/** An open decision of `author`'s, with an administrator. */
	function world() {
		const author = editorNamed('author');
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const decision = openByHand(author);
		return { author, admin, decision };
	}
	/** A participant reached by a link, by name. */
	const linkHolder = (decision: Decision, fullName: string) => makeParticipant(decision, { person: makePerson({ fullName }), role: 'consulted' });
	/** A record mail to them, and its outcome, if any, as the mail effect writes it. */
	function mailed(decision: Decision, p: DecisionParticipant, outcome: Record<string, unknown> | null) {
		const of = appendEvent({ decisionId: decision.id, kind: 'invited', participantId: p.id }, SYSTEM_ACTOR);
		if (outcome !== null) appendEvent({ decisionId: decision.id, kind: 'mail_outcome', participantId: p.id, detail: { of, mail: 'invitation', ...outcome } }, SYSTEM_ACTOR);
	}
	const rowOf = (user: SessionUser, decision: Decision, participantId: number) => readEditPage(user, decision.id).delivery!.find((row) => row.participantId === participantId)!;

	it.each([
		['sent', { delivered: true }, { outcome: 'sent', problem: null }],
		['failed, with its problem in words', { delivered: false, problem: 'refused' }, { outcome: 'failed', problem: MAIL_PROBLEM_WORDS.refused }],
		['superseded', { delivered: false, problem: 'superseded' }, { outcome: 'superseded', problem: null }],
		['not sent for no link address', { delivered: false, problem: 'no_link_address' }, { outcome: 'no_link_address', problem: null }],
		['pending, with no outcome yet', null, { outcome: 'pending', problem: null }]
	] as const)('gives the latest mail %s (37)', (_name, said, expected) => {
		const { author, decision } = world();
		const p = linkHolder(decision, 'Pat Doe');
		mailed(decision, p, said);

		expect(rowOf(author, decision, p.id).lastMail).toEqual({ mail: 'invitation', at: expect.stringMatching(new RegExp(`^${STAMP}$`)), resend: false, ...expected });
	});

	it("gives the latest skip in SKIP_WORDS' words (37)", () => {
		const { author, decision } = world();
		const p = linkHolder(decision, 'Pat Doe');
		appendEvent({ decisionId: decision.id, kind: 'mail_skipped', participantId: p.id, detail: { mail: 'told_of_change', reason: 'address_changed' } }, SYSTEM_ACTOR);
		appendEvent({ decisionId: decision.id, kind: 'mail_skipped', participantId: p.id, detail: { mail: 'invitation', reason: 'left' } }, SYSTEM_ACTOR);

		expect(rowOf(author, decision, p.id).lastSkip).toEqual({ mail: 'invitation', at: expect.any(String), words: SKIP_WORDS.left('Pat Doe') });
	});

	it("gives the link's latest ending in REVOKE_WORDS' words (37)", () => {
		const { author, decision } = world();
		const p = linkHolder(decision, 'Pat Doe');
		appendEvent({ decisionId: decision.id, kind: 'link_revoked', participantId: p.id, detail: { reason: 'restore' } }, SYSTEM_ACTOR);
		appendEvent({ decisionId: decision.id, kind: 'link_revoked', participantId: p.id, detail: { reason: 'participant_address' } }, SYSTEM_ACTOR);

		expect(rowOf(author, decision, p.id).lastRevoked).toEqual({ at: expect.any(String), words: REVOKE_WORDS.participant_address });
	});

	it('gives no address, as the author and as an administrator, and nothing of a response (37)', () => {
		const { author, admin, decision } = world();
		const p = linkHolder(decision, 'Pat Doe');
		mailed(decision, p, { delivered: true });
		makeResponse(p, { kind: 'vote', comment: 'A view nobody but the record holds' });

		for (const user of [author, admin]) {
			const shown = JSON.stringify(readEditPage(user, decision.id).delivery);
			expect(shown, user.username).not.toContain('@example.test');
			expect(shown, user.username).not.toContain('A view nobody but the record holds');
			expect(shown, user.username).not.toMatch(/response|vote|total/i);
		}
	});

	it.each([
		['a board owner who is not its author, its decider or an administrator', false],
		['a draft that was never opened', true]
	])('is null for %s (38)', (_name, draft) => {
		const author = editorNamed('author');
		const decision = draft ? readyOf(author) : openByHand(author);

		expect(readEditPage(draft ? author : owner, decision.id).delivery).toBeNull();
	});

	describe('resendable agrees with resendInvitation (39)', () => {
		const rows: [name: string, make: (decision: Decision) => DecisionParticipant, from: boolean][] = [
			[
				'a removed participant',
				(decision) => makeParticipant(decision, { person: makePerson({ fullName: 'Rem Oved' }), removedAt: '2026-11-02 09:00:00' }),
				false
			],
			['one reachOf skips, who has left', (decision) => makeParticipant(decision, { person: makePerson({ fullName: 'Lef Tearly', status: 'left' }) }), false],
			[
				'one mailed less than 10 minutes ago',
				(decision) => {
					const p = linkHolder(decision, 'Just Mailed');
					appendEvent({ decisionId: decision.id, kind: 'invited', participantId: p.id }, SYSTEM_ACTOR);
					return p;
				},
				true
			],
			['one ready', (decision) => linkHolder(decision, 'Rea Dy'), false]
		];

		it.each(rows)('%s', async (_name, make, from) => {
			const { author, decision } = world();
			const p = make(decision);
			const row = rowOf(author, decision, p.id);

			const result = outcome(() => as(author, (caller) => resendInvitation(caller, { decisionId: decision.id, participantId: p.id }, null, UI)));
			expect(row.resendable).toBe(result === 'passed');
			expect(row.refusal).toBe(result === 'passed' ? null : result.message);
			const last = eventsOf(decision.id).find((event) => event.kind === 'invited' && event.participantId === p.id);
			expect(row.resendFrom).toBe(from ? plus(last!.createdAt, 10 * MINUTE) : null);
			await sent.settle();
		});
	});
});

// ─── The Resend route (case 41) ──────────────────────────────────────────────

describe('POST …/resend (41)', () => {
	it.each([
		['the author, with no address', false],
		['an administrator, with the snapshot address', true]
	])('answers %s, and never linkTokenHash', async (_name, asAdmin) => {
		const author = editorNamed('author');
		const user = asAdmin ? makeUser({ username: 'admin', role: 'admin' }) : author;
		const decision = openByHand(author);
		const p = makeParticipant(decision, { person: makePerson({ fullName: 'Pat Doe', email: 'pat.doe@example.test' }), role: 'consulted' });

		const res = await api('POST', `/api/decisions/${decision.id}/participants/${p.id}/resend`, { user });
		const answer = res.body as any;

		expect(res.status, JSON.stringify(answer)).toBe(200);
		expect(Object.keys(answer).sort()).toEqual(['participant', 'revision']);
		const row = sqlite.prepare('SELECT * FROM decision_participants WHERE id = ?').get(p.id) as Record<string, unknown>;
		expect(row.link_token_hash).not.toBeNull();
		const now = db.select().from(decisionParticipants).where(eq(decisionParticipants.id, p.id)).get()!;
		expect(answer.participant).toEqual(participantAnswers([now], asAdmin)[0]);
		expect(answer.revision).toBe(revisionFor(decision.id));
		const text = JSON.stringify(answer);
		expect(text).not.toContain('linkTokenHash');
		expect(text).not.toContain(row.link_token_hash as string);
		if (asAdmin) expect(answer.participant.email).toBe('pat.doe@example.test');
		else expect(text).not.toContain('@example.test');
		await sent.settle();
		expect(sent.emails.map((mail) => mail.to)).toEqual(['pat.doe@example.test']);
	});
});

// ─── The preview (case 44) ───────────────────────────────────────────────────

describe('readPreview (44)', () => {
	/** A group of the people directory, with the people named in it. */
	function makeGroup(name: string, members: number[] = []): number {
		const { id } = sqlite.prepare('INSERT INTO people_groups (name) VALUES (?) RETURNING id').get(name) as { id: number };
		for (const personId of members) sqlite.prepare('INSERT INTO people_group_members (group_id, person_id) VALUES (?, ?)').run(id, personId);
		return id;
	}

	/**
	 * An open decision of `author`'s, version 1 publishing A and B, whose working
	 * copy has since dropped B, added C and changed its question; two audiences,
	 * Finance's and Operations'. Pat is consulted and in Finance, with a response
	 * and a question on the record; Lin holds a personal link; Rem was removed.
	 */
	function world() {
		const author = editorNamed('author');
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const decision = openByHand(author);
		const [a, b] = db.select().from(decisionOptionsTable).where(eq(decisionOptionsTable.decisionId, decision.id)).all();
		const c = makeOption(decision, { label: 'C', position: 2 });
		const patPerson = makePerson({ fullName: 'Pat Doe', email: 'pat.preview@example.test' });
		const finance = makeGroup('Finance', [patPerson.id]);
		const ops = makeGroup('Operations');
		makeVersion(decision, { question: 'The question of version 1' }, { number: 1 });
		const working = {
			situation: 'Money is short.',
			question: 'The question as edited since',
			ask: 'Pick one.',
			options: [
				{ optionId: a.id, title: 'Lean', summary: '', pros: [], cons: [], commercial: '' },
				{ optionId: c.id, title: 'Middle', summary: '', pros: [], cons: [], commercial: '' }
			],
			audiences: [
				{ groupId: ops, heading: 'For Operations', body: 'Ops text.' },
				{ groupId: finance, heading: 'For Finance', body: 'Finance text.' }
			],
			stories: [],
			reviewed: { situation: { byUserId: author.id, byName: 'author', at: '2026-11-02 09:00:00' } }
		};
		db.update(decisions).set({ workingContent: JSON.stringify(working) }).where(eq(decisions.id, decision.id)).run();
		const pat = makeParticipant(decision, { person: patPerson, role: 'consulted', groups: JSON.stringify(['Finance']) });
		makeResponse(pat, { comment: 'A view nobody but the record holds' });
		sqlite
			.prepare("INSERT INTO decision_questions (decision_id, participant_id, asker_name, question, asked_in_version, via, asked_at) VALUES (?, ?, 'Pat Doe', ?, 1, 'session', '2026-11-02 10:00:00')")
			.run(decision.id, pat.id, 'A question nobody but the record holds');
		const lin = makeParticipant(decision, { person: makePerson({ fullName: 'Lin Holder', email: 'lin.preview@example.test' }), role: 'informed', token: 'lin-live-link' });
		const rem = makeParticipant(decision, { person: makePerson({ fullName: 'Rem Oved' }), removedAt: '2026-11-02 09:00:00' });
		return { author, admin, decision: decisionRow(decision.id), a, b, c, pat, lin, rem, finance, ops };
	}
	type World = ReturnType<typeof world>;

	const preview = (user: SessionUser, w: World, query = '') => readPreview(user, w.decision.id, new URLSearchParams(query));

	it("(a) as a consulted participant: their role and their groups now, their group's audience first and open, no address or account, nothing of a response or a question", () => {
		const w = world();
		for (const user of [w.author, w.admin]) {
			const page = preview(user, w, `as=${w.pat.id}`);

			expect(page.previewing).toEqual({ kind: 'participant', participantId: w.pat.id, name: 'Pat Doe', role: 'consulted', groupNames: ['Finance'] });
			expect(page.participant).toEqual({ role: 'consulted' });
			expect(page.audiences.map((audience) => [audience.heading, audience.own, audience.open])).toEqual([
				['For Finance', true, true],
				['For Operations', false, false]
			]);
			const shown = JSON.stringify(page);
			expect(shown, user.username).not.toMatch(/@example\.test/);
			expect(shown, user.username).not.toMatch(/userId|linkTokenHash|"email"/);
			expect(shown, user.username).not.toContain('A view nobody but the record holds');
			expect(shown, user.username).not.toContain('A question nobody but the record holds');
			// A reviewed section is a yes, with no reviewer's name.
			expect(page.content.reviewed).toEqual({ situation: true });
		}
	});

	it('(b) on an open decision, shows the working copy as edited, not version 1', () => {
		const w = world();

		expect(preview(w.author, w).content.question).toBe('The question as edited since');
	});

	it("(c) shows the next version's options: a published option left out is not shown, and one not yet published is", () => {
		const w = world();

		expect(preview(w.author, w).options.map((option) => [option.label, option.title])).toEqual([
			['A', 'Lean'],
			['C', 'Middle']
		]);
	});

	it.each([
		["(d) another decision's participant", (w: World) => makeParticipant(openByHand(w.author, w.author, 'Another'), { person: makePerson({ fullName: 'Else' }) }).id],
		['(e) a removed participant', (w: World) => w.rem.id]
	])('is 404 for ?as= of %s', (_name, idOf) => {
		const w = world();

		expect(outcome(() => preview(w.author, w, `as=${idOf(w)}`))).toEqual({ status: 404, message: 'Participant not found' });
	});

	it("(f) ?role=informed&group=: a generic informed participant, that group's audience first", () => {
		const w = world();
		const page = preview(w.author, w, `role=informed&group=${w.ops}`);

		expect(page.previewing).toEqual({ kind: 'generic', role: 'informed', groupId: w.ops, groupName: 'Operations' });
		expect(page.participant).toEqual({ role: 'informed' });
		expect(page.audiences.map((audience) => [audience.heading, audience.open])).toEqual([
			['For Operations', true],
			['For Finance', false]
		]);
	});

	it.each([
		['(g) ?role=other', () => 'role=other', 'role must be "consulted" or "informed"'],
		['(h) a group that is no group', (w: World) => `role=consulted&group=${w.ops + 100}`, `group`]
	])('is 400 for %s', (_name, query, words) => {
		const w = world();
		const refused = outcome(() => preview(w.author, w, query(w)));

		expect(refused).toMatchObject({ status: 400 });
		expect((refused as { message: string }).message).toContain(words);
	});

	it('(i) with no query: a generic consulted participant, every audience open', () => {
		const w = world();
		const page = preview(w.author, w);

		expect(page.previewing).toEqual({ kind: 'generic', role: 'consulted', groupId: null, groupName: null });
		expect(page.audiences.every((audience) => audience.open)).toBe(true);
		// The bar offers the live participants, by name, role and groups, and no one removed.
		expect(page.participants.map((p) => [p.name, p.role, p.groups])).toEqual([
			['Pat Doe', 'consulted', ['Finance']],
			['Lin Holder', 'informed', []]
		]);
	});

	it('(j) is 403 for a board viewer of an open decision', () => {
		const w = world();
		const viewer = makeUser({ username: 'viewer' });
		addBoardMember(board, viewer, 'viewer');

		expect(outcome(() => preview(viewer, w))).toEqual({ status: 403, message: 'You cannot edit this decision' });
	});

	it('(k) is 404 for a board editor who is not the author, on a draft', () => {
		const author = editorNamed('author');
		const other = editorNamed('other');
		const draft = readyOf(author);

		expect(outcome(() => readPreview(other, draft.id, new URLSearchParams()))).toEqual({ status: 404, message: 'Decision not found' });
	});

	it('(l) as a participant holding a personal link, writes no event and issues no link (Q30)', () => {
		const w = world();
		const before = written();
		const row = () => sqlite.prepare('SELECT link_token_hash AS hash, link_issued_at AS issued FROM decision_participants WHERE id = ?').get(w.lin.id);
		const link = row();

		const page = preview(w.author, w, `as=${w.lin.id}`);

		expect(page.previewing).toMatchObject({ kind: 'participant', name: 'Lin Holder', role: 'informed' });
		expect(written()).toEqual(before);
		expect(row()).toEqual(link);
		expect(JSON.stringify(page)).not.toContain('lin-live-link');
	});
});

// ─── The password on the administrator's participant actions (case 40) ──────

describe("the administrator's account and address actions ask for the password (40)", () => {
	/** Not the fixture's password. */
	const WRONG = 'not the password';

	/** The session's count of wrong current passwords. */
	const countOf = (token: string) => db.select({ count: sessions.wrongPasswordCount }).from(sessions).where(eq(sessions.id, token)).get()?.count;
	/** The session a request made by `stepUp` carries. */
	const tokenOf = (made: { headers: Record<string, string> }) => made.headers.cookie.slice(`${SESSION_COOKIE_NAME}=`.length);
	const participantRow = (id: number) => db.select().from(decisionParticipants).where(eq(decisionParticipants.id, id)).get()!;

	/**
	 * An open decision of `author`'s with an administrator; and Pat, consulted by
	 * a live personal link at the address they had, whose person in the people
	 * directory now holds an account and another address.
	 */
	function world() {
		const author = editorNamed('author');
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const decision = openByHand(author);
		const person = makePerson({ fullName: 'Pat Doe', email: 'pat.old@example.test' });
		const row = makeParticipant(decision, { person, token: 'a-live-link-of-pat', hadAccount: false });
		const account = makeUser({ username: 'pat-account' });
		db.update(people).set({ userId: account.id, email: 'pat.new@example.test' }).where(eq(people.id, person.id)).run();
		return { author, admin, decision, person, row, account };
	}
	type World = ReturnType<typeof world>;

	const routes = {
		account: { path: (w: World) => `/api/decisions/${w.decision.id}/participants/${w.row.id}/account`, body: { account: 'person' } },
		address: { path: (w: World) => `/api/decisions/${w.decision.id}/participants/${w.row.id}/address`, body: {} }
	} as const;
	type Route = keyof typeof routes;

	/** What the right password did, for each route. */
	const done: Record<Route, (w: World, answer: any) => void> = {
		account: (w, answer) => {
			expect(participantRow(w.row.id)).toMatchObject({ userId: w.account.id, linkTokenHash: null });
			expect(eventsOf(w.decision.id).slice(-2).map((event) => [event.kind, event.detail])).toEqual([
				['link_revoked', { reason: 'account_attached' }],
				['account_attached', { userId: w.account.id }]
			]);
			expect(answer.participant).toEqual(participantAnswers([participantRow(w.row.id)], true)[0]);
		},
		address: (w, answer) => {
			expect(participantRow(w.row.id)).toMatchObject({ email: 'pat.new@example.test', linkTokenHash: null });
			expect(eventsOf(w.decision.id).slice(-2).map((event) => [event.kind, event.detail])).toEqual([
				['link_revoked', { reason: 'participant_address' }],
				['address_changed', { from: 'pat.old@example.test', to: 'pat.new@example.test' }]
			]);
			expect(answer.participant).toEqual(participantAnswers([participantRow(w.row.id)], true)[0]);
		}
	};

	describe.each(['account', 'address'] as const)('PUT …/%s', (route) => {
		it('with no password is 400, nothing changed and nothing counted', async () => {
			const w = world();
			const confirmed = stepUp(w.admin, routes[route].body);
			const before = written();

			const res = await api('PUT', routes[route].path(w), { ...confirmed, body: routes[route].body });

			expect({ status: res.status, body: res.body }).toEqual({ status: 400, body: { message: STEP_UP_MISSING, stepUp: 'missing' } });
			expect(written()).toEqual(before);
			expect(stub.compared).toBe(0);
			expect(countOf(tokenOf(confirmed))).toBe(0);
		});

		it('with a wrong password is 403, counted, nothing changed', async () => {
			const w = world();
			const wrong = stepUp(w.admin, routes[route].body, WRONG);
			const before = written();

			const res = await api('PUT', routes[route].path(w), wrong);

			expect({ status: res.status, body: res.body }).toEqual({ status: 403, body: { message: STEP_UP_WRONG, stepUp: 'wrong' } });
			expect(written()).toEqual(before);
			expect(countOf(tokenOf(wrong))).toBe(1);
		});

		it('with the right password makes the change, the link ended, nothing sent, and answers { participant, revision }', async () => {
			const w = world();

			const res = await api('PUT', routes[route].path(w), stepUp(w.admin, routes[route].body));

			expect(res.status, JSON.stringify(res.body)).toBe(200);
			expect(Object.keys(res.body).sort()).toEqual(['participant', 'revision']);
			expect(res.body.revision).toBe(revisionFor(w.decision.id));
			expect(JSON.stringify(res.body)).not.toContain('linkTokenHash');
			done[route](w, res.body);
			await sent.settle();
			expect(sent.all).toEqual([]);
		});

		it('as a board owner who is no administrator, with a wrong password, is 403 by role, the count unchanged (Q30)', async () => {
			const w = world();
			const wrong = stepUp(owner, routes[route].body, WRONG);
			const before = written();

			const res = await api('PUT', routes[route].path(w), wrong);

			expect(res.status, JSON.stringify(res.body)).toBe(403);
			expect(res.body.stepUp).toBeUndefined();
			expect(written()).toEqual(before);
			expect(stub.compared).toBe(0);
			expect(countOf(tokenOf(wrong))).toBe(0);
		});

		it('refuses 409 when the stored hash moved between the check and the write, nothing changed (Q30)', async () => {
			const w = world();
			const confirmed = stepUp(w.admin, routes[route].body);
			let release!: () => void;
			stub.hold = new Promise<void>((resolve) => (release = resolve));
			const before = written();

			const pending = api('PUT', routes[route].path(w), confirmed);
			await vi.waitFor(() => expect(stub.compared).toBe(1));
			// The same password, hashed again, as a change to it would leave it.
			db.update(users).set({ passwordHash: hashSync(FIXTURE_PASSWORD, 4) }).where(eq(users.id, w.admin.id)).run();
			stub.hold = undefined;
			release();
			const res = await pending;

			expect({ status: res.status, body: res.body }).toEqual({ status: 409, body: { message: PASSWORD_CHANGED_MEANWHILE, stepUp: 'changed' } });
			expect(written()).toEqual(before);
		});
	});

	/** A refusal the guard makes before any password, a wrong one sent: nothing written, nothing compared or counted. */
	async function refusedFirst(w: World, route: Route, message: string) {
		const wrong = stepUp(w.admin, routes[route].body, WRONG);
		const before = written();

		const res = await api('PUT', routes[route].path(w), wrong);

		expect({ status: res.status, body: res.body }).toEqual({ status: 409, body: { message } });
		expect(written()).toEqual(before);
		expect(stub.compared).toBe(0);
		expect(countOf(tokenOf(wrong))).toBe(0);
	}

	it('refuses attaching for a person with no account 409, before any password', async () => {
		const w = world();
		db.update(people).set({ userId: null }).where(eq(people.id, w.person.id)).run();

		await refusedFirst(w, 'account', 'Pat Doe has no account in the people directory: there is no account to attach');
	});

	it.each([
		[
			'a person deleted from the people directory',
			(w: World) => void db.delete(people).where(eq(people.id, w.person.id)).run(),
			'Pat Doe is no longer in the people directory: there is no address to use'
		],
		[
			'a person who has left',
			(w: World) => void db.update(people).set({ status: 'left', leftAt: '2026-11-02 09:00:00' }).where(eq(people.id, w.person.id)).run(),
			'Pat Doe has left: their address in the people directory is not used'
		],
		[
			"a row that already holds the directory's address",
			(w: World) => void db.update(people).set({ email: 'pat.old@example.test' }).where(eq(people.id, w.person.id)).run(),
			"Pat Doe's address on this decision is already the one the people directory holds: there is nothing to change"
		]
	])("refuses Use the directory's address for %s 409, before any password (Q22)", async (_name, make, message) => {
		const w = world();
		make(w);

		await refusedFirst(w, 'address', message);
	});
});

// ─── B4: the lifecycle flags (case 48) ───────────────────────────────────────

// ─── The administrator's offers, decided by the writes' rules (the code review's part B, F2) ─

describe("readEditPage's administrator offers agree with the writes' guards (F2)", () => {
	const rows: [name: string, make: (decision: Decision) => DecisionParticipant][] = [
		[
			'a row whose account was deleted: no account now, one held before',
			(decision) => makeParticipant(decision, { person: makePerson({ fullName: 'Pat Doe' }), hadAccount: true })
		],
		[
			'a link holder whose person was since given an account and a new address',
			(decision) => {
				const person = makePerson({ fullName: 'Pat Doe', email: 'pat.old@example.test' });
				const row = makeParticipant(decision, { person, hadAccount: false });
				db.update(people).set({ userId: makeUser({ username: 'pat-account' }).id, email: 'pat.new@example.test' }).where(eq(people.id, person.id)).run();
				return row;
			}
		],
		[
			'a row holding its person’s account and address',
			(decision) => {
				const account = makeUser({ username: 'pat-account' });
				return makeParticipant(decision, { person: makePerson({ fullName: 'Pat Doe', email: account.email, user: account }), hadAccount: true });
			}
		],
		[
			'a row whose person has left, with a new address',
			(decision) => {
				const person = makePerson({ fullName: 'Pat Doe', email: 'pat.old@example.test' });
				const row = makeParticipant(decision, { person, hadAccount: false });
				db.update(people).set({ status: 'left', email: 'pat.new@example.test' }).where(eq(people.id, person.id)).run();
				return row;
			}
		],
		[
			'a row whose person was deleted',
			(decision) => {
				const person = makePerson({ fullName: 'Pat Doe' });
				const row = makeParticipant(decision, { person, hadAccount: false });
				db.delete(people).where(eq(people.id, person.id)).run();
				return participantRows(decision.id).find((one) => one.id === row.id)!;
			}
		]
	];
	const participantRows = (decisionId: number) => db.select().from(decisionParticipants).where(eq(decisionParticipants.decisionId, decisionId)).all();

	it.each(rows)('%s: each action offered exactly where its guard would take it', (_name, make) => {
		const author = editorNamed('author');
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const decision = openByHand(author);
		const row = make(decision);
		const at = { decisionId: decision.id, participantId: row.id };
		const takes = (guard: (caller: SessionUser | null) => unknown) => outcome(() => as(admin, guard)) === 'passed';

		const fact = readEditPage(admin, decision.id).directory!.find((one) => one.participantId === row.id)!;

		expect(fact.canAttach).toBe(takes((caller) => participantAccountGuard(caller, at, { account: 'person' })));
		expect(fact.canClear).toBe(takes((caller) => participantAccountGuard(caller, at, { account: 'none' })));
		expect(fact.canUseDirectoryAddress).toBe(takes((caller) => participantAddressGuard(caller, at)));
		expect(fact.directoryAddress).toBe(fact.canUseDirectoryAddress ? 'pat.new@example.test' : null);
	});

	it('offers Clear account on a row whose account was deleted (account_removed), which the panel could not see from the row', () => {
		const author = editorNamed('author');
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const decision = openByHand(author);
		const row = rows[0][1](decision);
		const page = readEditPage(admin, decision.id);

		expect(page.participants.find((one) => one.id === row.id)).toMatchObject({ userId: null });
		expect(page.delivery!.find((one) => one.participantId === row.id)!.reachNow).toBe(SKIP_WORDS.account_removed('Pat Doe'));
		expect(page.directory!.find((one) => one.participantId === row.id)).toEqual({
			participantId: row.id,
			canAttach: false,
			canClear: true,
			canUseDirectoryAddress: false,
			directoryAddress: null
		});
	});

	it('offers nothing on a removed row', () => {
		const author = editorNamed('author');
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const decision = openByHand(author);
		const row = rows[1][1](decision);
		db.update(decisionParticipants).set({ removedAt: fromNow(-MINUTE), removedBy: author.id }).where(eq(decisionParticipants.id, row.id)).run();

		expect(readEditPage(admin, decision.id).directory!.find((one) => one.participantId === row.id)).toEqual({
			participantId: row.id,
			canAttach: false,
			canClear: false,
			canUseDirectoryAddress: false,
			directoryAddress: null
		});
	});
});

describe("readEditPage's actions (48)", () => {
	it('gives every flag exactly as TRANSITIONS holds the status and mayDo lets the caller, for each caller and each stored status', () => {
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const author = editorNamed('author');
		const decider = editorNamed('decider');
		const editor = editorNamed('editor');
		const checked: string[] = [];
		const refused: string[] = [];

		for (const status of STORED_STATUSES) {
			const opened = status === 'draft' ? null : '2026-11-01 09:00:00';
			const own = makeDecision({ board, author, decider: author, status, closesAt: FUTURE, openedAt: opened, currentVersion: opened ? 1 : 0 });
			const decided = makeDecision({ board, author, decider, status, closesAt: FUTURE, openedAt: opened, currentVersion: opened ? 1 : 0 });
			const callers: [string, SessionUser, Decision][] = [
				['an administrator', admin, own],
				['the author who is decider', author, own],
				['a decider who is not the author', decider, decided],
				['a board owner', owner, own],
				['a board editor', editor, own]
			];
			for (const [who, user, decision] of callers) {
				let actions: Record<string, boolean>;
				try {
					actions = readEditPage(user, decision.id).actions;
				} catch (err) {
					if (!isHttpError(err)) throw err;
					// The editor is the edit page's: a caller it refuses is given no flags at all.
					expect(mayDo(decisionAccess(user, decision), 'edit', decision), `${who}, ${status}`).toBe(false);
					refused.push(`${who}, ${status}`);
					continue;
				}
				const access = decisionAccess(user, decision);
				const expected = Object.fromEntries(
					LIFECYCLE_ACTIONS.map((action) => [action, (TRANSITIONS[action] as readonly string[]).includes(status) && mayDo(access, action, decision)])
				);
				expect(actions, `${who}, ${status}`).toEqual({ ...expected, withdrawAsks: opened !== null, deleteAsks: opened !== null });
				checked.push(`${who}, ${status}`);
			}
		}

		// It looked: every caller who may edit, on every status; the board editor, who may not, on none.
		expect(checked).toHaveLength(4 * STORED_STATUSES.length);
		expect(refused).toEqual(STORED_STATUSES.map((status) => `a board editor, ${status}`));
	});
});

// ─── B4: the re-publish summary agrees with the write (case 49) ──────────────

describe("readEditPage's republishSummary against republishDecision telling only (49)", () => {
	/** An opened decision of `author`'s, A and B published in version 1, and the working copy listing `listed`. */
	function opened(listed: (ids: { a: number; b: number; c: number | null }) => number[], extra: 'unpublished' | 'published' | null) {
		const author = editorNamed('author');
		const decision = makeDecision({ board, author, decider: author, status: 'open', closesAt: FUTURE, currentVersion: 1, openedAt: '2026-11-01 09:00:00' });
		const a = makeOption(decision, { label: 'A', position: 0, addedInVersion: 1 });
		const b = makeOption(decision, { label: 'B', position: 1, addedInVersion: 1 });
		const c = extra === null ? null : makeOption(decision, { label: 'C', position: 2, addedInVersion: extra === 'published' ? 1 : null });
		const option = (optionId: number) => ({ optionId, title: 'An option', summary: '', pros: [], cons: [], commercial: '' });
		db.update(decisions)
			.set({ workingContent: JSON.stringify({ question: 'Which one, now?', options: listed({ a: a.id, b: b.id, c: c?.id ?? null }).map(option) }) })
			.where(eq(decisions.id, decision.id))
			.run();
		makeVersion(decisionRow(decision.id), { question: 'Which one?' }, { number: 1 });
		return { author, decision: decisionRow(decision.id) };
	}

	const tellOnly = (author: SessionUser, decisionId: number) =>
		outcome(() => as(author, (caller) => republishDecision(caller, { decisionId }, { changeNote: 'A change.', askAgain: false, revision: revisionNow(decisionId) }, UI)));
	const TELL_ONLY_REFUSED = {
		status: 409,
		message: 'Telling of a change cannot add or retire an option: publish a change to the options by asking everyone again'
	};

	it('(a) an option added since the version: changesOptions, its label named, and the write refuses', () => {
		const { author, decision } = opened(({ a, b, c }) => [a, b, c!], 'unpublished');

		expect(readEditPage(author, decision.id).republishSummary).toEqual({ changesOptions: true, adding: ['C'], retiring: [] });
		expect(tellOnly(author, decision.id)).toEqual(TELL_ONLY_REFUSED);
	});

	it('(b) a published option left out of the working copy: changesOptions, and the write refuses', () => {
		const { author, decision } = opened(({ a, b }) => [a, b], 'published');

		expect(readEditPage(author, decision.id).republishSummary).toEqual({ changesOptions: true, adding: [], retiring: ['C'] });
		expect(tellOnly(author, decision.id)).toEqual(TELL_ONLY_REFUSED);
	});

	it('(c) the text alone changed: no change to the options, and the write tells of it', async () => {
		const { author, decision } = opened(({ a, b }) => [a, b], null);

		expect(readEditPage(author, decision.id).republishSummary).toEqual({ changesOptions: false, adding: [], retiring: [] });
		expect(tellOnly(author, decision.id)).toBe('passed');
		expect(decisionRow(decision.id).currentVersion).toBe(2);
		await sent.settle();
	});
});

// ─── B4: the password on deleting and withdrawing (cases 50 and 62) ──────────

describe('deleting and withdrawing a decision that was ever opened ask for the password (50, 62)', () => {
	const WRONG = 'not the password';
	/** The session's count of wrong current passwords. */
	const countOf = (token: string) => db.select({ count: sessions.wrongPasswordCount }).from(sessions).where(eq(sessions.id, token)).get()?.count;
	/** The session a request made by `stepUp` carries. */
	const tokenOf = (made: { headers: Record<string, string> }) => made.headers.cookie.slice(`${SESSION_COOKIE_NAME}=`.length);
	/** A request as `user` with no password: their session, and `body` alone. */
	const unasked = (user: SessionUser, body: Record<string, unknown>) => ({ ...stepUp(user), body });
	const exists = (id: number) => db.select().from(decisions).where(eq(decisions.id, id)).get() !== undefined;
	const recordOf = (id: number) => ({
		versions: (sqlite.prepare('SELECT COUNT(*) AS n FROM decision_versions WHERE decision_id = ?').get(id) as { n: number }).n,
		events: (sqlite.prepare('SELECT COUNT(*) AS n FROM decision_events WHERE decision_id = ?').get(id) as { n: number }).n
	});

	/** The same password, hashed again, as a change to it would leave it, made while the check is held in flight. */
	async function hashMovedDuring(user: SessionUser, request: () => Promise<{ status: number; body: any }>) {
		let release!: () => void;
		stub.hold = new Promise<void>((resolve) => (release = resolve));
		const pending = request();
		await vi.waitFor(() => expect(stub.compared).toBe(1));
		db.update(users).set({ passwordHash: hashSync(FIXTURE_PASSWORD, 4) }).where(eq(users.id, user.id)).run();
		stub.hold = undefined;
		release();
		return pending;
	}

	describe('DELETE /api/decisions/[id] (50)', () => {
		/** A decision of `author`'s that was opened, then withdrawn: it holds a record, a version and an event. */
		function withdrawnOnceOpened(author: SessionUser) {
			const decision = openByHand(author, author, 'Once opened');
			makeVersion(decision, { question: 'Which one?' }, { number: 1 });
			insertEvent({ decisionId: decision.id, kind: 'published', at: '2026-11-01 09:00:00', actorUserId: author.id });
			db.update(decisions).set({ status: 'withdrawn', withdrawnAt: '2026-11-02 09:00:00', withdrawnReason: 'Not needed.' }).where(eq(decisions.id, decision.id)).run();
			return decisionRow(decision.id);
		}
		const path = (id: number) => `/api/decisions/${id}`;

		it('deletes a draft never opened with {} and no password, nothing compared', async () => {
			const author = editorNamed('author');
			const draft = makeDecision({ board, author, decider: author, title: 'Never opened' });

			const res = await api('DELETE', path(draft.id), unasked(author, {}));

			expect({ status: res.status, body: res.body }).toEqual({ status: 200, body: { success: true } });
			expect(exists(draft.id)).toBe(false);
			expect(stub.compared).toBe(0);
		});

		it('refuses a withdrawn decision once opened with no password 400, nothing deleted and nothing counted', async () => {
			const author = editorNamed('author');
			const decision = withdrawnOnceOpened(author);
			const request = unasked(author, {});
			const before = written();

			const res = await api('DELETE', path(decision.id), request);

			expect({ status: res.status, body: res.body }).toEqual({ status: 400, body: { message: STEP_UP_MISSING, stepUp: 'missing' } });
			expect(written()).toEqual(before);
			expect(stub.compared).toBe(0);
			expect(countOf(tokenOf(request))).toBe(0);
		});

		it('refuses a wrong password 403, counted, nothing deleted', async () => {
			const author = editorNamed('author');
			const decision = withdrawnOnceOpened(author);
			const wrong = stepUp(author, {}, WRONG);
			const before = written();

			const res = await api('DELETE', path(decision.id), wrong);

			expect({ status: res.status, body: res.body }).toEqual({ status: 403, body: { message: STEP_UP_WRONG, stepUp: 'wrong' } });
			expect(written()).toEqual(before);
			expect(countOf(tokenOf(wrong))).toBe(1);
		});

		it('deletes it with the right password, its record with it', async () => {
			const author = editorNamed('author');
			const decision = withdrawnOnceOpened(author);
			expect(recordOf(decision.id)).toEqual({ versions: 1, events: 1 });

			const res = await api('DELETE', path(decision.id), stepUp(author));

			expect({ status: res.status, body: res.body }).toEqual({ status: 200, body: { success: true } });
			expect(exists(decision.id)).toBe(false);
			expect(recordOf(decision.id)).toEqual({ versions: 0, events: 0 });
		});

		it.each([
			['an open decision', (author: SessionUser) => ({ id: openByHand(author).id, by: author }), 409, 'This decision is open: it cannot be deleted'],
			['a caller who is not the author', (author: SessionUser) => ({ id: withdrawnOnceOpened(author).id, by: owner }), 403, 'You cannot delete this decision']
		])('refuses %s before any password is compared', async (_name, make, status, message) => {
			const author = editorNamed('author');
			const { id, by } = make(author);
			const wrong = stepUp(by, {}, WRONG);
			const before = written();

			const res = await api('DELETE', path(id), wrong);

			expect({ status: res.status, body: res.body }).toEqual({ status, body: { message } });
			expect(written()).toEqual(before);
			expect(stub.compared).toBe(0);
			expect(countOf(tokenOf(wrong))).toBe(0);
		});

		it('refuses 409 when the stored hash moved between the check and the write, nothing deleted (Q30)', async () => {
			const author = editorNamed('author');
			const decision = withdrawnOnceOpened(author);
			const confirmed = stepUp(author);
			const before = written();

			const res = await hashMovedDuring(author, () => api('DELETE', path(decision.id), confirmed));

			expect({ status: res.status, body: res.body }).toEqual({ status: 409, body: { message: PASSWORD_CHANGED_MEANWHILE, stepUp: 'changed' } });
			expect(written()).toEqual(before);
			expect(exists(decision.id)).toBe(true);
		});

		it('refuses 400 a draft opened and withdrawn after the guard answered, before the transaction with no password (Q30)', async () => {
			const author = editorNamed('author');
			const draft = makeDecision({ board, author, decider: author, title: 'Opened meanwhile' });
			stub.afterGuard = () =>
				void db
					.update(decisions)
					.set({ status: 'withdrawn', openedAt: '2026-11-04 09:00:00', currentVersion: 1, withdrawnAt: '2026-11-04 09:05:00', withdrawnReason: 'Meanwhile.' })
					.where(eq(decisions.id, draft.id))
					.run();

			const res = await api('DELETE', path(draft.id), unasked(author, {}));

			expect({ status: res.status, body: res.body }).toEqual({ status: 400, body: { message: STEP_UP_MISSING, stepUp: 'missing' } });
			expect(decisionRow(draft.id)).toMatchObject({ status: 'withdrawn', openedAt: '2026-11-04 09:00:00' });
			expect(stub.compared).toBe(0);
		});
	});

	describe('POST /api/decisions/[id]/withdraw (62)', () => {
		/** An opened decision of `author`'s, with Pat consulted by a personal link: whom a withdrawal tells. */
		function openWithPat(author: SessionUser) {
			const decision = openByHand(author);
			const participant = makeParticipant(decision, { person: makePerson({ fullName: 'Pat Doe' }), role: 'consulted', token: 'a-live-link-of-pat' });
			return { decision, participant };
		}
		const path = (id: number) => `/api/decisions/${id}/withdraw`;
		const REASON = { reason: 'No longer needed.' };

		it('(a) refuses an open decision with { reason } and no password 400, nothing changed, nobody mailed, nothing counted', async () => {
			const author = editorNamed('author');
			const { decision } = openWithPat(author);
			const request = unasked(author, REASON);
			const before = written();

			const res = await api('POST', path(decision.id), request);

			expect({ status: res.status, body: res.body }).toEqual({ status: 400, body: { message: STEP_UP_MISSING, stepUp: 'missing' } });
			expect(written()).toEqual(before);
			expect(stub.compared).toBe(0);
			expect(countOf(tokenOf(request))).toBe(0);
			await sent.settle();
			expect(sent.all).toEqual([]);
		});

		it('(b) refuses a wrong password 403, counted, nothing changed', async () => {
			const author = editorNamed('author');
			const { decision } = openWithPat(author);
			const wrong = stepUp(author, REASON, WRONG);
			const before = written();

			const res = await api('POST', path(decision.id), wrong);

			expect({ status: res.status, body: res.body }).toEqual({ status: 403, body: { message: STEP_UP_WRONG, stepUp: 'wrong' } });
			expect(written()).toEqual(before);
			expect(countOf(tokenOf(wrong))).toBe(1);
			await sent.settle();
			expect(sent.all).toEqual([]);
		});

		it('(c) withdraws it with the right password, and tells Pat, answering { decision, revision }', async () => {
			const author = editorNamed('author');
			const { decision, participant } = openWithPat(author);

			const res = await api('POST', path(decision.id), stepUp(author, REASON));
			await sent.settle();

			expect(res.status, JSON.stringify(res.body)).toBe(200);
			expect(res.body).toEqual({ decision: decisionAnswer(decisionRow(decision.id), false), revision: revisionFor(decision.id) });
			expect(decisionRow(decision.id)).toMatchObject({ status: 'withdrawn', withdrawnReason: 'No longer needed.' });
			expect(eventsOf(decision.id).filter((event) => event.kind === 'told_withdrawn').map((event) => event.participantId)).toEqual([participant.id]);
			expect(sent.emails.map((mail) => mail.to)).toEqual([participant.email]);
		});

		it('(d) refuses a closed decision with no password 400 too', async () => {
			const author = editorNamed('author');
			const { decision } = openWithPat(author);
			db.update(decisions).set({ status: 'closed', closedAt: '2026-11-03 09:00:00' }).where(eq(decisions.id, decision.id)).run();
			const before = written();

			const res = await api('POST', path(decision.id), unasked(author, REASON));

			expect({ status: res.status, body: res.body }).toEqual({ status: 400, body: { message: STEP_UP_MISSING, stepUp: 'missing' } });
			expect(written()).toEqual(before);
		});

		it('(e) withdraws a draft never opened with { reason } alone: no password asked, nobody mailed', async () => {
			const author = editorNamed('author');
			const draft = makeDecision({ board, author, decider: author, title: 'Never opened' });
			makeParticipant(draft, { person: makePerson({ fullName: 'Not told' }), role: 'consulted' });

			const res = await api('POST', path(draft.id), unasked(author, REASON));
			await sent.settle();

			expect(res.status, JSON.stringify(res.body)).toBe(200);
			expect(decisionRow(draft.id).status).toBe('withdrawn');
			expect(stub.compared).toBe(0);
			expect(sent.all).toEqual([]);
		});

		it('(f) refuses 409 when the stored hash moved between the check and the write, nothing changed (Q30)', async () => {
			const author = editorNamed('author');
			const { decision } = openWithPat(author);
			const confirmed = stepUp(author, REASON);
			const before = written();

			const res = await hashMovedDuring(author, () => api('POST', path(decision.id), confirmed));

			expect({ status: res.status, body: res.body }).toEqual({ status: 409, body: { message: PASSWORD_CHANGED_MEANWHILE, stepUp: 'changed' } });
			expect(written()).toEqual(before);
			await sent.settle();
			expect(sent.all).toEqual([]);
		});

		it('(g) refuses 400 a draft opened after the guard answered, before the transaction with no password, nothing withdrawn (Q30)', async () => {
			const author = editorNamed('author');
			const draft = makeDecision({ board, author, decider: author, title: 'Opened meanwhile', closesAt: FUTURE });
			stub.afterGuard = () =>
				void db.update(decisions).set({ status: 'open', openedAt: '2026-11-04 09:00:00', currentVersion: 1 }).where(eq(decisions.id, draft.id)).run();

			const res = await api('POST', path(draft.id), unasked(author, REASON));

			expect({ status: res.status, body: res.body }).toEqual({ status: 400, body: { message: STEP_UP_MISSING, stepUp: 'missing' } });
			expect(decisionRow(draft.id)).toMatchObject({ status: 'open', withdrawnAt: null });
			expect(stub.compared).toBe(0);
		});
	});
});
