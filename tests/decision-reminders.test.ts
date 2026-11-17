/**
 * The closing-date reminder (card 2685): who is due and when, one a round,
 * recorded then sent one participant at a time, asked again just before each
 * send on a fresh clock, the rest it starts and the cap it does not count
 * toward, its mail, its record, and its timers.
 *
 * Every case runs at SCHEDULERS=off with `Date` faked (case 42 alone fakes
 * the timers too) and calls `runDecisionReminders(now)` directly, with mail
 * set up (`makeSmtp`) and an App URL unless the case says otherwise. Mail is
 * recorded by `effects()`, and nothing leaves. Each decision is opened
 * through the service, so its invitation, the invitation's `mail_outcome` and
 * its round are the real ones. The cases are the plan's,
 * `docs/planning/card-2685-decision-reminder.md`, section 7.1, by number.
 *
 * `$lib/server/decision-record` is passed through, with `remindedIn`,
 * `askingMailsOf` and `appendEvent` wrapped: case 26 makes the first miss a
 * reminder, case 48 makes the second throw for one decision, case 27 makes
 * the third throw once, and cases 31 to 33 change the rows the moment a
 * participant's reminder is recorded, before it is sent (the plan's section
 * 12.1). `$lib/server/email` is passed through, with `trySendEmail` able to be
 * held (cases 22, 44) or to throw (case 23), and `isSmtpConfigured` counted,
 * which every run asks first (case 42), and able to throw (case 49).
 */
import { isHttpError } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stub = vi.hoisted(() => ({
	/** While set, every `remindedIn` leaves this participant's reminders out (case 26): the pre-filter's read and the record step's alike. */
	missRemindedOf: null as number | null,
	/** How many reads of `remindedIn` left them out. */
	missedReminded: 0,
	/** While set, `askingMailsOf` throws for this decision: its record step fails (case 48). */
	askingThrowsOn: null as number | null,
	/** Set: the next `isSmtpConfigured` throws, once: the run fails before any decision (case 49). */
	smtpThrows: false,
	/** Set: the next `reminded` written on this decision throws SQLITE_BUSY, once (case 27). */
	busyOn: null as number | null,
	/** Set: run once, inside the record step, right after this participant's `reminded` is written (cases 31 to 33). */
	afterReminded: undefined as { participantId: number; run: () => void } | undefined,
	/** While set, every send waits for it (cases 22, 44). */
	holdSend: undefined as Promise<void> | undefined,
	/** Set: the next send throws, once (case 23). */
	sendThrows: false,
	/** How many times `isSmtpConfigured` was asked (case 42). */
	smtpAsked: 0
}));

vi.mock('$lib/server/decision-record', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/decision-record')>();
	return {
		...real,
		remindedIn: vi.fn((...args: Parameters<typeof real.remindedIn>) => {
			const found = real.remindedIn(...args);
			if (stub.missRemindedOf !== null && found.delete(stub.missRemindedOf)) stub.missedReminded++;
			return found;
		}),
		askingMailsOf: vi.fn((...args: Parameters<typeof real.askingMailsOf>) => {
			// The words hold an address, so the case can show the run's ERROR line never repeats them.
			if (stub.askingThrowsOn === args[0]) throw new Error('A fault reading the asking mail of link-fault@example.test');
			return real.askingMailsOf(...args);
		}),
		appendEvent: vi.fn((...args: Parameters<typeof real.appendEvent>) => {
			const [event] = args;
			if (event.kind === 'reminded' && stub.busyOn === event.decisionId) {
				stub.busyOn = null;
				throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
			}
			const id = real.appendEvent(...args);
			const after = stub.afterReminded;
			if (event.kind === 'reminded' && after !== undefined && event.participantId === after.participantId) {
				stub.afterReminded = undefined;
				after.run();
			}
			return id;
		})
	};
});

vi.mock('$lib/server/email', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/email')>();
	return {
		...real,
		isSmtpConfigured: () => {
			stub.smtpAsked++;
			if (stub.smtpThrows) {
				stub.smtpThrows = false;
				throw new Error('The mail settings could not be read');
			}
			return real.isSmtpConfigured();
		},
		trySendEmail: async (...args: Parameters<typeof real.trySendEmail>) => {
			if (stub.sendThrows) {
				stub.sendThrows = false;
				throw new Error('The mail server hook threw');
			}
			await stub.holdSend;
			return real.trySendEmail(...args);
		}
	};
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import type { SessionUser } from '$lib/server/auth';
import {
	decisionOptions,
	decisionParticipants,
	decisions,
	people,
	settings,
	users,
	type Board,
	type Decision,
	type DecisionParticipant
} from '$lib/server/db/schema';
import { appendEvent, deliveryOf, mailsSince, SYSTEM_ACTOR } from '$lib/server/decision-record';
import { readEditPage } from '$lib/server/decision-authoring';
import { resultsRevisionOf } from '$lib/server/decision-content';
import { readPersonRecord, readRecord } from '$lib/server/decision-register';
import {
	initDecisionReminders,
	runDecisionReminders,
	runDecisionRemindersOnce,
	stillStands
} from '$lib/server/decision-reminders';
import { openDecision, republishDecision } from '$lib/server/decision-lifecycle-writes';
import { resendInvitation } from '$lib/server/decision-participant-writes';
import { subscribeToLogs, type LogEntry } from '$lib/server/logger';
import { resetAllRateLimits } from '$lib/server/rate-limit';
import { writeAs, type ServiceOptions } from '$lib/server/write-as';
import { eventWords, LATEST_LINK_LINE } from '$lib/decision-words';
import { parseStamp, stamp } from '$lib/timestamps';
import { revisionNow } from './helpers/decision-faults';
import { effects, type Effects, type OfferedMail } from './helpers/effects';
import { addBoardMember, makeBoard, makePerson, makeResponse, makeSmtp, makeUser, makeVersion, resetDb } from './helpers/fixtures';

const APP = 'https://kanban.example.test';
const UI: ServiceOptions = { source: 'ui' };
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
/** Where every case starts, and when each decision is opened unless said. */
const T0 = new Date('2026-11-10T09:00:00Z');
const INDEX = 'idx_decision_events_participant_id_version_number_reminded';

let sent: Effects;
let author: SessionUser;
let decider: SessionUser;
let board: Board;
let logs: LogEntry[];
let unsubscribe: () => void;
let made = 0;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(T0);
	resetDb();
	resetAllRateLimits();
	Object.assign(stub, {
		missRemindedOf: null,
		missedReminded: 0,
		askingThrowsOn: null,
		smtpThrows: false,
		busyOn: null,
		afterReminded: undefined,
		holdSend: undefined,
		sendThrows: false,
		smtpAsked: 0
	});
	makeSmtp();
	db.insert(settings).values({ key: 'app_url', value: APP }).run();
	const owner = makeUser({ username: 'owner' });
	board = makeBoard({ owner, name: 'The board' }).board;
	author = makeUser({ username: 'author' });
	addBoardMember(board, author, 'editor');
	decider = makeUser({ username: 'decider' });
	addBoardMember(board, decider, 'editor');
	sent = effects({ mailRefusal: (mail) => onMail?.(mail) });
	onMail = undefined;
	logs = [];
	unsubscribe = subscribeToLogs((entry) => logs.push(entry));
	process.env.LOG_LEVEL = 'WARN';
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	sent.restore();
	unsubscribe();
	process.env.LOG_LEVEL = 'ERROR';
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/** Asked of every mail as the transport is handed it: an error refuses it; it may change the rows, as another request would. */
let onMail: ((mail: OfferedMail) => Error | undefined) | undefined;

/** A refusal as the mail server gives one for an address. */
const refused = () => Object.assign(new Error('550 Mailbox unavailable'), { code: 'EENVELOPE' });

/** Call a write as `user`, as a route calls it inside its writeAs callback. */
const as = <T>(user: SessionUser, write: (caller: SessionUser | null) => T): T => writeAs({ user } as App.Locals, write as never) as T;

/** `ms` after T0. */
const at = (ms: number) => new Date(T0.getTime() + ms);

/** Move the clock to `when`, and run the reminders there. */
const runAt = (when: Date, opts?: { limit?: number; budgetMs?: number }) => {
	vi.setSystemTime(when);
	return runDecisionReminders(new Date(), opts);
};

const decisionRow = (id: number) => db.select().from(decisions).where(eq(decisions.id, id)).get()!;
const participantRow = (id: number) => db.select().from(decisionParticipants).where(eq(decisionParticipants.id, id)).get()!;

type EventRow = { id: number; kind: string; participantId: number | null; versionNumber: number | null; detail: any; actorUserId: number | null; actorName: string; source: string; createdAt: string };

/** The decision's events, in order, their detail read. */
function eventsOf(decisionId: number): EventRow[] {
	return (
		sqlite
			.prepare(
				'SELECT id, kind, participant_id AS participantId, version_number AS versionNumber, detail, actor_user_id AS actorUserId, actor_name AS actorName, source, created_at AS createdAt FROM decision_events WHERE decision_id = ? ORDER BY id'
			)
			.all(decisionId) as (Omit<EventRow, 'detail'> & { detail: string | null })[]
	).map((row) => ({ ...row, detail: row.detail === null ? null : JSON.parse(row.detail) }));
}

/** The decision's `reminded` events, for one participant when given. */
const remindersOf = (decisionId: number, participantId?: number) =>
	eventsOf(decisionId).filter((e) => e.kind === 'reminded' && (participantId === undefined || e.participantId === participantId));

/** The `mail_outcome` of event `of`, its detail, or undefined for none. */
const outcomeOf = (decisionId: number, of: number) => eventsOf(decisionId).find((e) => e.kind === 'mail_outcome' && e.detail?.of === of)?.detail;

/** The addresses mailed, in order. */
const mailedTo = () => sent.emails.map((mail) => mail.to);

/** The lines logged at `level` since the case began. */
const logged = (level: 'WARN' | 'ERROR') => logs.filter((entry) => entry.level === level).map((entry) => entry.message);

type Spec = { via: 'account' | 'link'; role?: 'consulted' | 'informed' };

/** One participant of a decision as a case uses them: the row, and the account for an account holder. */
type Made = { p: DecisionParticipant; user: SessionUser | null };

/**
 * A decision opened now through the service, on the board, by the author and
 * decided by the decider, closing `closesIn` from now (49 hours unless said:
 * its window opens 25 hours after its invitation), with a participant for
 * each spec, consulted unless said. The invitations are sent, and their
 * outcomes written, before it is answered; the mail is then forgotten.
 */
async function opened(specs: Spec[] = [{ via: 'account' }], opts: { closesIn?: number; title?: string } = {}) {
	const closesAt = stamp(new Date(Date.now() + (opts.closesIn ?? 49 * HOUR)));
	const draft = db
		.insert(decisions)
		.values({
			title: opts.title ?? `Decision ${++made}`,
			boardId: board.id,
			boardName: board.name,
			authorUserId: author.id,
			authorName: author.username,
			deciderUserId: decider.id,
			deciderName: decider.username,
			status: 'draft',
			closesAt
		})
		.returning()
		.get();
	const lean = db.insert(decisionOptions).values({ decisionId: draft.id, label: 'A', position: 0 }).returning().get();
	const full = db.insert(decisionOptions).values({ decisionId: draft.id, label: 'B', position: 1 }).returning().get();
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
	const ids: { id: number; user: SessionUser | null }[] = [];
	for (const spec of specs) {
		const n = ++made;
		const user = spec.via === 'account' ? makeUser({ username: `holder${n}` }) : null;
		const person = makePerson({ fullName: `Person ${n}`, email: user?.email ?? `link${n}@example.test`, user });
		const row = db
			.insert(decisionParticipants)
			.values({
				decisionId: draft.id,
				personId: person.id,
				role: spec.role ?? 'consulted',
				name: person.fullName,
				email: person.email,
				jobTitle: '',
				groups: '[]',
				includedAt: stamp(),
				userId: person.userId
			})
			.returning()
			.get();
		ids.push({ id: row.id, user });
	}
	as(author, (caller) => openDecision(caller, { decisionId: draft.id }, { revision: revisionNow(draft.id) }, UI));
	await sent.settle();
	sent.clear();
	const participants: Made[] = ids.map(({ id, user }) => ({ p: participantRow(id), user }));
	return { decision: decisionRow(draft.id), participants, closesAt };
}

/** A stored moment moved on by `ms`. */
const plus = (moment: string, ms: number) => stamp(new Date(parseStamp(moment)!.getTime() + ms));

/** Re-publish the decision as the author, asking again or telling only, and let its mail go. */
async function republish(decisionId: number, askAgain: boolean) {
	as(author, (caller) => republishDecision(caller, { decisionId }, { changeNote: 'Changed.', askAgain, revision: revisionNow(decisionId) }, UI));
	await sent.settle();
}

/** Switch a preference of the account off. */
const switchOff = (user: SessionUser, key: 'email_decisions' | 'email_all') =>
	db.update(users).set({ notificationPrefs: JSON.stringify({ [key]: false }) }).where(eq(users.id, user.id)).run();

// ─── Sent, and recorded (cases 1, 2) ─────────────────────────────────────────

describe('a reminder sent and recorded', () => {
	it('reminds a consulted account holder at exactly closes_at − 24 h, recorded as DumpFire for the round, then mailed to their address with a link to the page, then its outcome (1)', async () => {
		const { decision, participants, closesAt } = await opened();
		const { p } = participants[0];

		const result = await runAt(new Date(`${plus(closesAt, -24 * HOUR).replace(' ', 'T')}Z`));

		expect(result).toEqual({ recorded: 1, sent: 1 });
		const reminders = remindersOf(decision.id);
		expect(reminders.map(({ participantId, versionNumber, detail, actorUserId, actorName, source }) => ({ participantId, versionNumber, detail, actorUserId, actorName, source }))).toEqual([
			{ participantId: p.id, versionNumber: 1, detail: null, actorUserId: null, actorName: 'DumpFire', source: 'system' }
		]);
		expect(mailedTo()).toEqual([p.email]);
		expect(sent.emails[0].html).toContain(`${APP}/decisions/${decision.id}`);
		expect(outcomeOf(decision.id, reminders[0].id)).toEqual({ of: reminders[0].id, mail: 'reminder', delivered: true });
		// The outcome follows the reminder, and the mail went after the commit.
		const kinds = eventsOf(decision.id).map((e) => e.kind);
		expect(kinds.slice(-2)).toEqual(['reminded', 'mail_outcome']);
		expect(sent.duringTransaction).toEqual([]);
	});

	it('reminds a link holder at the snapshot address with no link and no token, telling them to use their latest email’s link, and leaves their link as it was (2)', async () => {
		const { decision, participants } = await opened([{ via: 'link' }]);
		const { p } = participants[0];
		const before = participantRow(p.id);
		const kindsBefore = eventsOf(decision.id).filter((e) => e.kind === 'link_issued' || e.kind === 'link_revoked').length;

		await runAt(at(25 * HOUR));

		expect(mailedTo()).toEqual([p.email]);
		const html = sent.emails[0].html;
		expect(html).not.toContain('/decision-link/');
		expect(html).not.toMatch(/[A-Za-z0-9_-]{43}/);
		expect(html).toContain(LATEST_LINK_LINE);
		expect(html).not.toContain('Open the decision</a>');
		const after = participantRow(p.id);
		expect({ hash: after.linkTokenHash, issued: after.linkIssuedAt }).toEqual({ hash: before.linkTokenHash, issued: before.linkIssuedAt });
		expect(after.linkTokenHash).not.toBeNull();
		expect(eventsOf(decision.id).filter((e) => e.kind === 'link_issued' || e.kind === 'link_revoked')).toHaveLength(kindsBefore);
	});
});

// ─── The window and the timing (decision 1: cases 3 to 5) ────────────────────

describe('the window and the timing', () => {
	it.each([
		['one second before the window opens', -24 * HOUR - SECOND],
		['at the start of the excluded last hour', -HOUR]
	])('sends nothing %s (3)', async (_name, fromClose) => {
		const { decision, closesAt } = await opened();

		await runAt(new Date(`${plus(closesAt, fromClose).replace(' ', 'T')}Z`));

		expect(remindersOf(decision.id)).toEqual([]);
		expect(sent.emails).toEqual([]);
	});

	it('passes over an invitation 23 h 59 m old, and reminds the same participant at the next run past 24 hours, before the last hour (4)', async () => {
		const { decision, participants } = await opened([{ via: 'account' }], { closesIn: 25 * HOUR + 30 * MINUTE });

		await runAt(at(23 * HOUR + 59 * MINUTE));
		expect(remindersOf(decision.id)).toEqual([]);
		expect(sent.emails).toEqual([]);

		await runAt(at(24 * HOUR + 5 * MINUTE));
		expect(remindersOf(decision.id).map((e) => e.participantId)).toEqual([participants[0].p.id]);
		expect(mailedTo()).toEqual([participants[0].p.email]);
	});

	it('sends no reminder for a decision opened 24 h 30 m before closing, at either boundary (5)', async () => {
		const { decision, closesAt } = await opened([{ via: 'account' }], { closesIn: 24 * HOUR + 30 * MINUTE });

		// The last moment before the last hour: the invitation is 23 h 29 m 59 s old.
		await runAt(new Date(`${plus(closesAt, -HOUR - SECOND).replace(' ', 'T')}Z`));
		// Inside the last hour.
		await runAt(new Date(`${plus(closesAt, -30 * MINUTE).replace(' ', 'T')}Z`));

		expect(remindersOf(decision.id)).toEqual([]);
		expect(sent.emails).toEqual([]);
	});
});

// ─── Who is due (decision 4: cases 6 to 13) ──────────────────────────────────

describe('who is due', () => {
	/** An event naming the participant, written as DumpFire an hour after the invitation. */
	const changeEvent = (
		decision: Decision,
		p: DecisionParticipant,
		kind: 'role_changed' | 'address_changed' | 'account_attached' | 'account_cleared' | 'removed' | 're_included',
		detail: Record<string, unknown> | null
	) => {
		vi.setSystemTime(at(HOUR));
		appendEvent({ decisionId: decision.id, kind, participantId: p.id, detail }, SYSTEM_ACTOR);
	};

	it.each([
		['informed', (_d: Decision, p: DecisionParticipant) => void db.update(decisionParticipants).set({ role: 'informed' }).where(eq(decisionParticipants.id, p.id)).run()],
		['removed', (_d: Decision, p: DecisionParticipant) => void db.update(decisionParticipants).set({ removedAt: stamp(at(HOUR)) }).where(eq(decisionParticipants.id, p.id)).run()],
		['whose role changed (informed to consulted) after their invitation', (d: Decision, p: DecisionParticipant) => changeEvent(d, p, 'role_changed', { from: 'informed', to: 'consulted' })],
		['whose address changed after it', (d: Decision, p: DecisionParticipant) => changeEvent(d, p, 'address_changed', { from: 'old@example.test', to: p.email })],
		['whose account was attached after it', (d: Decision, p: DecisionParticipant) => changeEvent(d, p, 'account_attached', { userId: p.userId })],
		['whose account was cleared after it', (d: Decision, p: DecisionParticipant) => changeEvent(d, p, 'account_cleared', { userId: p.userId })],
		// The code review's S1: an inclusion that ended or began again since the asking mail. The row is left live, so the event alone holds them.
		['whose removal was recorded after it', (d: Decision, p: DecisionParticipant) => changeEvent(d, p, 'removed', null)],
		['who was re-included after it', (d: Decision, p: DecisionParticipant) => changeEvent(d, p, 're_included', { role: 'consulted', hadAccount: true })]
	])('passes over a participant %s, writing nothing for them (6)', async (_name, change) => {
		const { decision, participants } = await opened([{ via: 'account' }, { via: 'account' }]);
		const [target, control] = participants;
		change(decision, target.p);

		await runAt(at(25 * HOUR));

		expect(eventsOf(decision.id).filter((e) => e.participantId === target.p.id && ['reminded', 'mail_outcome', 'mail_skipped'].includes(e.kind) && e.createdAt > stamp(at(HOUR)))).toEqual([]);
		expect(mailedTo()).toEqual([control.p.email]);
	});

	it('passes over a consulted participant who has responded in the current round (7)', async () => {
		const { decision, participants } = await opened([{ via: 'account' }, { via: 'account' }]);
		makeResponse(participants[0].p, { round: 1, versionNumber: 1, kind: 'abstain' });

		await runAt(at(25 * HOUR));

		expect(remindersOf(decision.id).map((e) => e.participantId)).toEqual([participants[1].p.id]);
		expect(mailedTo()).toEqual([participants[1].p.email]);
	});

	it('passes over a person marked left, and writes no mail_skipped (8)', async () => {
		const { decision, participants } = await opened([{ via: 'link' }, { via: 'account' }]);
		db.update(people).set({ status: 'left', leftAt: stamp() }).where(eq(people.id, participants[0].p.personId!)).run();
		const skipsBefore = eventsOf(decision.id).filter((e) => e.kind === 'mail_skipped').length;

		await runAt(at(25 * HOUR));

		expect(remindersOf(decision.id, participants[0].p.id)).toEqual([]);
		expect(eventsOf(decision.id).filter((e) => e.kind === 'mail_skipped')).toHaveLength(skipsBefore);
		expect(mailedTo()).toEqual([participants[1].p.email]);
	});

	it.each([
		['was not delivered', 'refused'],
		['has no outcome yet, its mail in flight', 'none']
	] as const)('passes over an account holder whose invitation %s (9)', async (_name, how) => {
		// The account holder's invitation, and theirs alone, refused at opening: an account holder's address begins `holder`, a link
		// holder's `link`. An account holder (the code review's F1): a link holder's invitation is their latest record mail too, so
		// clause 4 would pass them over first, and clause 7, the asking mail's delivery, would go untested.
		onMail = (mail) => (how === 'refused' && mail.to.startsWith('holder') ? refused() : undefined);
		const { decision, participants } = await opened([{ via: 'account' }, { via: 'link' }]);
		onMail = undefined;
		const [target, control] = participants;
		const invitation = eventsOf(decision.id).find((e) => e.kind === 'invited' && e.participantId === target.p.id)!;
		if (how === 'none') sqlite.prepare("DELETE FROM decision_events WHERE kind = 'mail_outcome' AND participant_id = ?").run(target.p.id);
		expect(outcomeOf(decision.id, invitation.id)).toEqual(how === 'refused' ? expect.objectContaining({ delivered: false }) : undefined);
		expect(outcomeOf(decision.id, eventsOf(decision.id).find((e) => e.kind === 'invited' && e.participantId === control.p.id)!.id)).toMatchObject({ delivered: true });

		await runAt(at(25 * HOUR));

		expect(remindersOf(decision.id, target.p.id)).toEqual([]);
		expect(mailedTo()).toEqual([control.p.email]);
	});

	it('passes over a link holder whose link was revoked (10)', async () => {
		const { decision, participants } = await opened([{ via: 'link' }, { via: 'account' }]);
		db.update(decisionParticipants).set({ linkTokenHash: null, linkIssuedAt: null }).where(eq(decisionParticipants.id, participants[0].p.id)).run();

		await runAt(at(25 * HOUR));

		expect(remindersOf(decision.id, participants[0].p.id)).toEqual([]);
		expect(mailedTo()).toEqual([participants[1].p.email]);
	});

	it.each([['email_decisions'], ['email_all']] as const)('passes over an account holder with %s off (11)', async (key) => {
		const { decision, participants } = await opened([{ via: 'account' }, { via: 'account' }]);
		switchOff(participants[0].user!, key);

		await runAt(at(25 * HOUR));

		expect(remindersOf(decision.id, participants[0].p.id)).toEqual([]);
		expect(mailedTo()).toEqual([participants[1].p.email]);
	});

	it('reminds a link holder on the same decision as an account holder with Decisions off: no preference governs them (12)', async () => {
		const { decision, participants } = await opened([{ via: 'account' }, { via: 'link' }]);
		switchOff(participants[0].user!, 'email_decisions');

		await runAt(at(25 * HOUR));

		expect(remindersOf(decision.id).map((e) => e.participantId)).toEqual([participants[1].p.id]);
		expect(mailedTo()).toEqual([participants[1].p.email]);
	});

	it('passes over a link holder whose later tell-only mail, which replaced their link, was refused, and reminds the account holder (13)', async () => {
		const { decision, participants } = await opened([{ via: 'link' }, { via: 'account' }]);
		const [link, account] = participants;
		vi.setSystemTime(at(2 * HOUR));
		onMail = (mail) => (mail.to === link.p.email ? refused() : undefined);
		await republish(decision.id, false);
		onMail = undefined;
		const told = eventsOf(decision.id).find((e) => e.kind === 'told_of_change' && e.participantId === link.p.id)!;
		expect(outcomeOf(decision.id, told.id)).toMatchObject({ delivered: false });
		sent.clear();

		await runAt(at(25 * HOUR));

		expect(remindersOf(decision.id).map((e) => e.participantId)).toEqual([account.p.id]);
		expect(mailedTo()).toEqual([account.p.email]);
	});

	it('passes over an account holder whose preferences cannot be read, warning once for each over three runs, and reminds the rest (50)', async () => {
		// The code review's S6: read as off for this mail, where the other mails
		// read them as every switch on; card 2724 made them off for every mail,
		// with this one WARN line per account, now written by shouldNotifyUser.
		const { decision, participants } = await opened([{ via: 'account' }, { via: 'account' }, { via: 'account' }]);
		const [notJson, notObject, control] = participants;
		db.update(users).set({ notificationPrefs: '{not json' }).where(eq(users.id, notJson.user!.id)).run();
		db.update(users).set({ notificationPrefs: '[false]' }).where(eq(users.id, notObject.user!.id)).run();

		for (const minutes of [0, 5, 10]) await runAt(at(25 * HOUR + minutes * MINUTE));

		expect(remindersOf(decision.id).map((e) => e.participantId)).toEqual([control.p.id]);
		expect(mailedTo()).toEqual([control.p.email]);
		expect(logged('WARN')).toEqual(
			[notJson, notObject].map(
				({ user }) =>
					`The notification preferences of user ${user!.id} could not be read, so they are sent no mail they can switch off ` +
					'until they are saved again: notification_prefs is not a JSON object'
			)
		);
	});
});

// ─── The rest and the cap (decision 7: cases 14 to 17) ───────────────────────

describe('the rest and the cap', () => {
	it('passes over a participant mailed told_of_change 5 minutes before the run (14)', async () => {
		const { decision } = await opened();
		vi.setSystemTime(at(24 * HOUR + 55 * MINUTE));
		await republish(decision.id, false);
		sent.clear();

		await runAt(at(25 * HOUR));

		expect(remindersOf(decision.id)).toEqual([]);
		expect(sent.emails).toEqual([]);
	});

	it('reminds the same participant at the first run once the 10-minute rest has ended (15)', async () => {
		const { decision, participants } = await opened();
		vi.setSystemTime(at(24 * HOUR + 55 * MINUTE));
		await republish(decision.id, false);
		const told = eventsOf(decision.id).find((e) => e.kind === 'told_of_change')!;
		sent.clear();

		await runAt(new Date(`${plus(told.createdAt, 10 * MINUTE).replace(' ', 'T')}Z`));

		expect(remindersOf(decision.id).map((e) => e.participantId)).toEqual([participants[0].p.id]);
		expect(mailedTo()).toEqual([participants[0].p.email]);
	});

	it('counts no reminder toward the daily cap: mailsSince and mailMoments hold the invitation alone, and the panel’s last mail is still it (16)', async () => {
		const { decision, participants } = await opened();
		const { p } = participants[0];
		const invitation = eventsOf(decision.id).find((e) => e.kind === 'invited')!;
		await runAt(at(25 * HOUR));
		const reminder = remindersOf(decision.id)[0];

		expect(mailsSince([p.id], stamp(at(-HOUR))).get(p.id)).toEqual([invitation.createdAt]);
		const facts = deliveryOf(decision.id).get(p.id)!;
		expect(facts.mailMoments).toEqual([invitation.createdAt]);
		expect(facts.lastMail).toMatchObject({ eventId: invitation.id, kind: 'invited' });
		expect(facts.lastRestAt).toBe(reminder.createdAt);
		expect(readEditPage(author, decision.id).delivery!.find((row) => row.participantId === p.id)!.lastMail).toMatchObject({ mail: 'invitation', at: invitation.createdAt });
	});

	it('refuses a Resend 5 minutes after a reminder, 409 in the rest’s words, and the panel offers none from the same moment (17)', async () => {
		const { decision, participants } = await opened();
		const { p } = participants[0];
		await runAt(at(25 * HOUR));
		const reminder = remindersOf(decision.id)[0];
		vi.setSystemTime(at(25 * HOUR + 5 * MINUTE));
		const from = plus(reminder.createdAt, 10 * MINUTE);

		let refusal: { status: number; message: string } | null = null;
		try {
			as(author, (caller) => resendInvitation(caller, { decisionId: decision.id, participantId: p.id }, null, UI));
		} catch (err) {
			if (!isHttpError(err)) throw err;
			refusal = { status: err.status, message: err.body.message };
		}

		expect(refusal).toEqual({ status: 409, message: `${p.name} was mailed about this decision less than 10 minutes ago: they can be mailed again from ${from} UTC` });
		const row = readEditPage(author, decision.id).delivery!.find((r) => r.participantId === p.id)!;
		expect({ resendable: row.resendable, resendFrom: row.resendFrom }).toEqual({ resendable: false, resendFrom: from });
	});
});

// ─── One only (decision 2: cases 18 to 21) ───────────────────────────────────

describe('one a round', () => {
	it('sends no second reminder at the next run (18)', async () => {
		const { decision } = await opened();
		await runAt(at(25 * HOUR));
		await runAt(at(25 * HOUR + 5 * MINUTE));

		expect(remindersOf(decision.id)).toHaveLength(1);
		expect(sent.emails).toHaveLength(1);
		// Held by a read of the record (the pre-filter's), not by the index refusing a second insert, which would warn (the code review's F2).
		expect(logged('WARN')).toEqual([]);
	});

	it('sends no second reminder after the closing time is extended, still inside the window (19)', async () => {
		const { decision } = await opened();
		await runAt(at(25 * HOUR));
		db.update(decisions).set({ closesAt: stamp(at(50 * HOUR)) }).where(eq(decisions.id, decision.id)).run();

		await runAt(at(30 * HOUR));

		expect(remindersOf(decision.id)).toHaveLength(1);
		expect(sent.emails).toHaveLength(1);
	});

	it('reminds again in the new round after a re-publish that asks again, 24 hours after its delivered asked_again (20)', async () => {
		const { decision, participants } = await opened();
		await runAt(at(25 * HOUR));
		db.update(decisions).set({ closesAt: stamp(at(80 * HOUR)) }).where(eq(decisions.id, decision.id)).run();
		vi.setSystemTime(at(26 * HOUR));
		await republish(decision.id, true);
		sent.clear();

		await runAt(at(56 * HOUR));

		expect(remindersOf(decision.id).map((e) => ({ participantId: e.participantId, versionNumber: e.versionNumber }))).toEqual([
			{ participantId: participants[0].p.id, versionNumber: 1 },
			{ participantId: participants[0].p.id, versionNumber: 2 }
		]);
		expect(mailedTo()).toEqual([participants[0].p.email]);
	});

	it('does not remind again after a tell-only re-publish: the round did not move (21)', async () => {
		const { decision } = await opened();
		await runAt(at(25 * HOUR));
		db.update(decisions).set({ closesAt: stamp(at(80 * HOUR)) }).where(eq(decisions.id, decision.id)).run();
		vi.setSystemTime(at(26 * HOUR));
		await republish(decision.id, false);
		sent.clear();

		await runAt(at(56 * HOUR));

		expect(remindersOf(decision.id)).toHaveLength(1);
		expect(sent.emails).toEqual([]);
	});
});

// ─── Concurrency and restarts (decision 3: cases 22 to 27) ───────────────────

describe('concurrency and restarts', () => {
	it('skips a tick while the last run is out: the second call answers false, the first true, one reminder in all (22)', async () => {
		const { decision } = await opened();
		let release!: () => void;
		stub.holdSend = new Promise<void>((resolve) => (release = resolve));
		vi.setSystemTime(at(25 * HOUR));

		const first = runDecisionRemindersOnce(new Date());
		const second = await runDecisionRemindersOnce(new Date());
		release();

		expect(second).toBe(false);
		expect(await first).toBe(true);
		expect(remindersOf(decision.id)).toHaveLength(1);
		expect(sent.emails).toHaveLength(1);
	});

	it('holds a send that throws to its decision: one ERROR with ids alone, the next decision reminded, and the reminder left with no outcome is never sent (23)', async () => {
		const soon = await opened([{ via: 'account' }], { closesIn: 48 * HOUR });
		const later = await opened([{ via: 'account' }], { closesIn: 49 * HOUR });
		const { p } = soon.participants[0];
		stub.sendThrows = true;
		vi.setSystemTime(at(25 * HOUR));

		// The code review's S2: the fault is the decision's, and the run goes on and answers.
		expect(await runDecisionRemindersOnce(new Date())).toBe(true);

		expect(logged('ERROR')).toEqual([`Decision ${soon.decision.id}: its reminders were left to the next run, as a step failed at participant ${p.id}`]);
		expect(logs.some((entry) => `${entry.message} ${entry.meta ?? ''}`.includes('The mail server hook threw') || `${entry.meta ?? ''}`.includes(p.email))).toBe(false);
		expect(mailedTo()).toEqual([later.participants[0].p.email]);
		// The code review's F7: recorded before the send threw, it keeps no outcome, and the following run does not send it.
		const reminder = remindersOf(soon.decision.id)[0];
		expect(outcomeOf(soon.decision.id, reminder.id)).toBeUndefined();
		vi.setSystemTime(at(25 * HOUR + 5 * MINUTE));
		expect(await runDecisionRemindersOnce(new Date())).toBe(true);
		expect(remindersOf(soon.decision.id)).toHaveLength(1);
		expect(outcomeOf(soon.decision.id, reminder.id)).toBeUndefined();
		expect(mailedTo()).toEqual([later.participants[0].p.email]);
	});

	it('never sends a reminder recorded with no outcome, as a restart after the commit leaves it: at most once (24)', async () => {
		const { decision, participants } = await opened();
		vi.setSystemTime(at(25 * HOUR));
		appendEvent({ decisionId: decision.id, kind: 'reminded', participantId: participants[0].p.id, versionNumber: 1 }, SYSTEM_ACTOR);

		await runAt(at(26 * HOUR));

		expect(remindersOf(decision.id)).toHaveLength(1);
		expect(sent.emails).toEqual([]);
		// Held by a read of the record, not by the index refusing a second insert, which would warn (the code review's F2).
		expect(logged('WARN')).toEqual([]);
	});

	it('writes no second reminder for a participant reminded while the run was sending another’s, and sends them nothing (25)', async () => {
		const { decision, participants } = await opened([{ via: 'account' }, { via: 'account' }]);
		const [first, second] = participants;
		onMail = () => {
			onMail = undefined;
			// Dated 20 minutes back, so that the 10-minute rest it starts (clause 10) does not hold them first: only the read of
			// `reminded` in the round does.
			const now = Date.now();
			vi.setSystemTime(now - 20 * MINUTE);
			appendEvent({ decisionId: decision.id, kind: 'reminded', participantId: second.p.id, versionNumber: 1 }, SYSTEM_ACTOR);
			vi.setSystemTime(now);
			return undefined;
		};

		await runAt(at(25 * HOUR));

		expect(remindersOf(decision.id, second.p.id)).toHaveLength(1);
		expect(mailedTo()).toEqual([first.p.email]);
		// Written after the pre-filter read, it is held by the record step's own read inside its transaction (clause 6), not by
		// the index refusing a second insert, which would warn (the code review's F2).
		expect(logged('WARN')).toEqual([]);
	});

	it('rolls back one participant’s step when the index refuses a second reminder, warns once, sends them nothing, and reminds the next (26)', async () => {
		const { decision, participants } = await opened([{ via: 'account' }, { via: 'account' }]);
		const [first, second] = participants;
		switchOff(second.user!, 'email_decisions');
		await runAt(at(25 * HOUR));
		expect(remindersOf(decision.id).map((e) => e.participantId)).toEqual([first.p.id]);
		db.update(users).set({ notificationPrefs: null }).where(eq(users.id, second.user!.id)).run();
		sent.clear();
		stub.missRemindedOf = first.p.id;

		await runAt(at(26 * HOUR));
		stub.missRemindedOf = null;

		// Both reads that would have seen it missed it: the pre-filter's and the record step's.
		expect(stub.missedReminded).toBe(2);
		expect(remindersOf(decision.id, first.p.id)).toHaveLength(1);
		expect(logged('WARN')).toEqual([`Decision ${decision.id}: participant ${first.p.id} was already reminded in round 1`]);
		expect(mailedTo()).toEqual([second.p.email]);
		expect(remindersOf(decision.id, second.p.id)).toHaveLength(1);
	});

	it('leaves a decision whose record step finds the database busy to the next run, and goes on with the next decision (27)', async () => {
		const soon = await opened([{ via: 'account' }, { via: 'account' }], { closesIn: 48 * HOUR });
		const later = await opened([{ via: 'account' }], { closesIn: 49 * HOUR });
		stub.busyOn = soon.decision.id;

		await runAt(at(25 * HOUR));

		expect(logged('WARN')).toEqual([expect.stringMatching(new RegExp(`^Decision ${soon.decision.id}: its reminders were left to the next run, as the database was busy \\(SQLITE_BUSY\\)$`))]);
		expect(remindersOf(soon.decision.id)).toEqual([]);
		expect(mailedTo()).toEqual([later.participants[0].p.email]);

		await runAt(at(25 * HOUR + 5 * MINUTE));
		expect(remindersOf(soon.decision.id).map((e) => e.participantId)).toEqual(soon.participants.map((m) => m.p.id));
	});

	it('holds a decision whose record step throws to that decision: one ERROR with ids alone, and a later decision is reminded (48)', async () => {
		const soon = await opened([{ via: 'account' }], { closesIn: 48 * HOUR });
		const later = await opened([{ via: 'account' }], { closesIn: 49 * HOUR });
		stub.askingThrowsOn = soon.decision.id;

		const result = await runAt(at(25 * HOUR));

		// The code review's S2.
		expect(result).toEqual({ recorded: 1, sent: 1 });
		expect(logged('ERROR')).toEqual([
			`Decision ${soon.decision.id}: its reminders were left to the next run, as a step failed at participant ${soon.participants[0].p.id}`
		]);
		expect(logs.some((entry) => `${entry.message} ${entry.meta ?? ''}`.includes('link-fault@example.test'))).toBe(false);
		expect(remindersOf(soon.decision.id)).toEqual([]);
		expect(mailedTo()).toEqual([later.participants[0].p.email]);

		stub.askingThrowsOn = null;
		await runAt(at(25 * HOUR + 5 * MINUTE));
		expect(remindersOf(soon.decision.id).map((e) => e.participantId)).toEqual([soon.participants[0].p.id]);
	});

	it('clears the in-flight flag when a run throws before any decision, so the next run runs (49)', async () => {
		await opened();
		stub.smtpThrows = true;
		vi.setSystemTime(at(25 * HOUR));

		await expect(runDecisionRemindersOnce(new Date())).rejects.toThrow('The mail settings could not be read');

		expect(await runDecisionRemindersOnce(new Date())).toBe(true);
		expect(sent.emails).toHaveLength(1);
	});
});

// ─── Mail failures (decision 8: cases 28 to 30) ──────────────────────────────

describe('when mail cannot go', () => {
	it.each([
		['no mail host', 'smtp_host'],
		['no App URL and no ORIGIN', 'app_url']
	] as const)('with %s and a participant due, records and sends nothing, warns once over three runs, and reminds once it is set up (28)', async (_name, key) => {
		const { decision, participants } = await opened();
		const kept = { ORIGIN: process.env.ORIGIN, APP_URL: process.env.APP_URL };
		delete process.env.ORIGIN;
		delete process.env.APP_URL;
		try {
			db.delete(settings).where(eq(settings.key, key)).run();

			for (const minutes of [0, 5, 10]) await runAt(at(25 * HOUR + minutes * MINUTE));

			expect(remindersOf(decision.id)).toEqual([]);
			expect(sent.emails).toEqual([]);
			expect(logged('WARN').filter((line) => line.startsWith('Decision reminders are due and cannot be sent'))).toHaveLength(1);

			db.insert(settings).values({ key, value: key === 'app_url' ? APP : 'smtp.example.test' }).run();
			await runAt(at(25 * HOUR + 15 * MINUTE));
			expect(mailedTo()).toEqual([participants[0].p.email]);
		} finally {
			for (const [name, value] of Object.entries(kept)) if (value !== undefined) process.env[name] = value;
		}
	});

	it('says nothing with no mail host when no decision is in the window (29)', async () => {
		await opened();
		db.delete(settings).where(eq(settings.key, 'smtp_host')).run();

		for (const minutes of [0, 5, 10]) await runAt(at(HOUR + minutes * MINUTE));

		expect(logged('WARN')).toEqual([]);
	});

	it('records a refused reminder as not delivered with its problem code, logs no address, and does not retry it (30)', async () => {
		const { decision, participants } = await opened();
		const { p } = participants[0];
		onMail = (mail) => (mail.to === p.email ? refused() : undefined);

		await runAt(at(25 * HOUR));

		const reminder = remindersOf(decision.id)[0];
		expect(outcomeOf(decision.id, reminder.id)).toEqual({ of: reminder.id, mail: 'reminder', delivered: false, problem: 'refused' });
		const errors = logs.filter((entry) => entry.level === 'ERROR');
		expect(errors.map((entry) => entry.message)).toContainEqual(expect.stringContaining(`participant ${p.id} of decision ${decision.id} reminder`));
		expect(errors.some((entry) => `${entry.message} ${entry.meta ?? ''}`.includes(p.email))).toBe(false);
		expect(sent.refusedMail).toHaveLength(1);

		await runAt(at(26 * HOUR));
		expect(remindersOf(decision.id)).toHaveLength(1);
		expect(sent.refusedMail).toHaveLength(1);
	});
});

// ─── Just before the send (decision 9: cases 31 to 35) ───────────────────────

describe('just before the send', () => {
	type Ctx = { decision: Decision; p: DecisionParticipant; user: SessionUser | null };
	const set = (decision: Decision, row: Partial<Decision>) => void db.update(decisions).set(row).where(eq(decisions.id, decision.id)).run();
	const setP = (p: DecisionParticipant, row: Partial<DecisionParticipant>) => void db.update(decisionParticipants).set(row).where(eq(decisionParticipants.id, p.id)).run();
	const setPerson = (p: DecisionParticipant, row: Partial<typeof people.$inferSelect>) => void db.update(people).set(row).where(eq(people.id, p.personId!)).run();
	/** An event naming the participant, as DumpFire. */
	const event = (decision: Decision, p: DecisionParticipant, kind: Parameters<typeof appendEvent>[0]['kind'], detail: Record<string, unknown> | null = null, versionNumber: number | null = null) =>
		appendEvent({ decisionId: decision.id, kind, participantId: p.id, detail, versionNumber }, SYSTEM_ACTOR);
	/** What changes meanwhile, the second participant's route, and the change. */
	const meanwhile: [string, 'account' | 'link', (ctx: Ctx) => void][] = [
		['the decision withdrawn', 'account', ({ decision }: Ctx) => set(decision, { status: 'withdrawn', withdrawnAt: stamp() })],
		['the decision ruled', 'account', ({ decision }: Ctx) => set(decision, { status: 'ruled', ruledAt: stamp() })],
		['the decision closed for input', 'account', ({ decision }: Ctx) => set(decision, { status: 'closed', closedAt: stamp() })],
		['the participant removed', 'account', ({ p }: Ctx) => setP(p, { removedAt: stamp() })],
		// The code review's S4: the rows the review found missing.
		['their role changed to informed', 'account', ({ p }: Ctx) => setP(p, { role: 'informed' })],
		[
			'their account cleared, so that they would be reached by link',
			'account',
			({ decision, p }: Ctx) => {
				setP(p, { userId: null });
				setPerson(p, { userId: null });
				event(decision, p, 'account_cleared');
			}
		],
		['their person marked left', 'account', ({ p }: Ctx) => setPerson(p, { status: 'left', leftAt: stamp() })],
		['their link revoked', 'link', ({ p }: Ctx) => setP(p, { linkTokenHash: null, linkIssuedAt: null })],
		['their link replaced by another', 'link', ({ p }: Ctx) => setP(p, { linkTokenHash: 'a'.repeat(64) })],
		[
			'their latest record mail another, delivered, with the same link',
			'link',
			({ decision, p }: Ctx) => {
				const of = event(decision, p, 'told_of_change', null, 1);
				event(decision, p, 'mail_outcome', { of, mail: 'told_of_change', delivered: true });
			}
		],
		['their address changed on the row alone', 'account', ({ p }: Ctx) => setP(p, { email: 'new@example.test' })],
		// The person's address too, so that `reachOf` still reaches them: only the address the reminder was built for differs.
		[
			'their address changed on the row and the person alike',
			'account',
			({ p }: Ctx) => {
				setP(p, { email: 'new@example.test' });
				setPerson(p, { email: 'new@example.test' });
			}
		],
		// The row left as it was: the event alone holds them (decision 4 clause 8; the code review's S1 for the last two).
		['an address_changed event', 'account', ({ decision, p }: Ctx) => void event(decision, p, 'address_changed', { from: 'old@example.test', to: p.email })],
		['a removed event', 'account', ({ decision, p }: Ctx) => void event(decision, p, 'removed')],
		['a re_included event', 'account', ({ decision, p }: Ctx) => void event(decision, p, 're_included', { role: 'consulted', hadAccount: true })],
		['their response given', 'account', ({ p }: Ctx) => void makeResponse(p, { round: 1, versionNumber: 1, kind: 'abstain' })],
		['their Decisions switch off', 'account', ({ user }: Ctx) => switchOff(user!, 'email_decisions')],
		['their master switch off', 'account', ({ user }: Ctx) => switchOff(user!, 'email_all')],
		['their preferences made unreadable', 'account', ({ user }: Ctx) => void db.update(users).set({ notificationPrefs: '{not json' }).where(eq(users.id, user!.id)).run()],
		['the closing time extended out of the window', 'account', ({ decision }: Ctx) => set(decision, { closesAt: stamp(at(5 * 24 * HOUR)) })],
		['a re-publish that asks again', 'account', ({ decision }: Ctx) => void makeVersion(decision, {}, { asksAgain: true, publishedAt: stamp() })]
	];

	it.each(meanwhile)('does not send a recorded reminder with %s meanwhile, and records it superseded (31)', async (_name, via, change) => {
		const { decision, participants } = await opened([{ via: 'account' }, { via }]);
		const [first, second] = participants;
		stub.afterReminded = { participantId: second.p.id, run: () => change({ decision: decisionRow(decision.id), p: participantRow(second.p.id), user: second.user }) };

		await runAt(at(25 * HOUR));

		expect(stub.afterReminded).toBeUndefined();
		expect(mailedTo()).toEqual([first.p.email]);
		const reminder = remindersOf(decision.id, second.p.id)[0];
		expect(outcomeOf(decision.id, reminder.id)).toEqual({ of: reminder.id, mail: 'reminder', delivered: false, problem: 'superseded' });
	});

	it('sends nothing for a decision deleted meanwhile, warns once, and records nothing (32)', async () => {
		const { decision, participants } = await opened([{ via: 'account' }, { via: 'account' }]);
		const [first, second] = participants;
		stub.afterReminded = { participantId: second.p.id, run: () => void db.delete(decisions).where(eq(decisions.id, decision.id)).run() };

		await runAt(at(25 * HOUR));

		expect(mailedTo()).toEqual([first.p.email]);
		expect(eventsOf(decision.id)).toEqual([]);
		expect(logged('WARN')).toEqual([expect.stringMatching(new RegExp(`^Decision ${decision.id}: reminder event \\d+ was not sent, as the decision is gone$`))]);
	});

	it('does not send a reminder recorded before the clock passed closes_at − 1 h: the fresh clock (33)', async () => {
		const { decision, participants, closesAt } = await opened([{ via: 'account' }, { via: 'account' }]);
		const [first, second] = participants;
		stub.afterReminded = { participantId: second.p.id, run: () => vi.setSystemTime(new Date(`${plus(closesAt, -HOUR).replace(' ', 'T')}Z`)) };

		await runAt(at(25 * HOUR));

		expect(mailedTo()).toEqual([first.p.email]);
		const reminder = remindersOf(decision.id, second.p.id)[0];
		expect(outcomeOf(decision.id, reminder.id)).toMatchObject({ delivered: false, problem: 'superseded' });
	});

	it('answers superseded for the later of two reminders of a round and send for the earlier, with the index dropped (34)', async () => {
		const { decision, participants } = await opened();
		const { p } = participants[0];
		vi.setSystemTime(at(25 * HOUR));
		sqlite.exec(`DROP INDEX ${INDEX}`);
		try {
			const earlier = appendEvent({ decisionId: decision.id, kind: 'reminded', participantId: p.id, versionNumber: 1 }, SYSTEM_ACTOR);
			const later = appendEvent({ decisionId: decision.id, kind: 'reminded', participantId: p.id, versionNumber: 1 }, SYSTEM_ACTOR);

			expect(stillStands(later, new Date())).toBe('superseded');
			expect(stillStands(earlier, new Date())).toBe('send');
		} finally {
			sqlite.prepare("DELETE FROM decision_events WHERE kind = 'reminded'").run();
			sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS \`${INDEX}\` ON \`decision_events\` (\`participant_id\`,\`version_number\`) WHERE kind = 'reminded'`);
		}
	});

	it('writes nothing for a decision stored closed with its closing time still in the window (35)', async () => {
		const { decision } = await opened();
		db.update(decisions).set({ status: 'closed', closedAt: stamp(at(HOUR)) }).where(eq(decisions.id, decision.id)).run();

		await runAt(at(25 * HOUR));

		expect(remindersOf(decision.id)).toEqual([]);
		expect(sent.emails).toEqual([]);
	});
});

// ─── A run's size and time (decision 15: cases 36, 37) ───────────────────────

describe('a run’s size and time', () => {
	it('records at most the limit in a run, soonest closing first, and the rest at the next (36)', async () => {
		const later = await opened([{ via: 'account' }, { via: 'account' }], { closesIn: 49 * HOUR });
		const soon = await opened([{ via: 'account' }], { closesIn: 48 * HOUR });

		const result = await runAt(at(25 * HOUR), { limit: 2 });

		expect(result.recorded).toBe(2);
		expect(mailedTo()).toEqual([soon.participants[0].p.email, later.participants[0].p.email]);
		await runAt(at(25 * HOUR + 5 * MINUTE), { limit: 2 });
		expect(mailedTo()).toEqual([soon.participants[0].p.email, later.participants[0].p.email, later.participants[1].p.email]);
	});

	it('starts no participant once the time budget has passed, leaves nothing recorded and unsent, and reminds them at the next run (37)', async () => {
		const { decision, participants } = await opened([{ via: 'account' }, { via: 'account' }]);
		const [first, second] = participants;
		onMail = () => {
			onMail = undefined;
			vi.setSystemTime(new Date(Date.now() + 2 * MINUTE));
			return undefined;
		};

		await runAt(at(25 * HOUR), { budgetMs: MINUTE });

		expect(remindersOf(decision.id).map((e) => e.participantId)).toEqual([first.p.id]);
		expect(remindersOf(decision.id).every((e) => outcomeOf(decision.id, e.id) !== undefined)).toBe(true);
		await runAt(at(25 * HOUR + 5 * MINUTE), { budgetMs: MINUTE });
		expect(mailedTo()).toEqual([first.p.email, second.p.email]);
	});
});

// ─── Content, revision, time zone, the record (cases 38 to 41) ───────────────

describe('what it says and what it changes', () => {
	it('escapes the title, the decider’s name and the App URL, keeps the title as written in the subject, and quotes nothing else (38)', async () => {
		const title = 'Pick <b>x</b> a"b';
		const app = 'https://kanban.example.test/a"b<i>';
		const { decision, participants, closesAt } = await opened([{ via: 'account' }, { via: 'account' }]);
		db.update(decisions).set({ title, deciderName: 'Dee <b>Cider</b> "q"' }).where(eq(decisions.id, decision.id)).run();
		db.update(settings).set({ value: app }).where(eq(settings.key, 'app_url')).run();

		await runAt(at(25 * HOUR));

		const mail = sent.emails.find((m) => m.to === participants[0].p.email)!;
		expect(mail.subject).toBe(`Reminder: your view is asked by ${closesAt} UTC: ${title}`);
		expect(mail.html).toContain('Pick &lt;b&gt;x&lt;/b&gt; a&quot;b');
		expect(mail.html).toContain('Dee &lt;b&gt;Cider&lt;/b&gt; &quot;q&quot;');
		// Since card 2847's code review (CS1) the App URL setting is used as the address it parses to: `"`, `<` and `>`
		// are percent-encoded in its path before the href is escaped.
		expect(mail.html).toContain(`href="https://kanban.example.test/a%22b%3Ci%3E/decisions/${decision.id}"`);
		expect(mail.html).not.toContain('<b>');
		expect(mail.html).not.toContain('<i>');
		expect(mail.html).not.toContain(participants[1].p.name);
		expect(mail.html).not.toContain('Which budget?');
		expect(mail.html).not.toContain('Pick the one you can live with.');
		expect(mail.html).not.toMatch(/\b\d+ of \d+\b/);
	});

	it('changes neither revision nor the decision’s updated_at (39)', async () => {
		const { decision } = await opened();
		const resultsRevision = () =>
			resultsRevisionOf({
				decision: decisionRow(decision.id),
				options: db.select().from(decisionOptions).where(eq(decisionOptions.decisionId, decision.id)).all(),
				participants: db.select().from(decisionParticipants).where(eq(decisionParticipants.decisionId, decision.id)).all(),
				responseIds: [],
				questions: []
			});
		const before = { draft: revisionNow(decision.id), results: resultsRevision(), updatedAt: decisionRow(decision.id).updatedAt };

		await runAt(at(25 * HOUR));

		expect(remindersOf(decision.id)).toHaveLength(1);
		expect(outcomeOf(decision.id, remindersOf(decision.id)[0].id)).toBeDefined();
		expect({ draft: revisionNow(decision.id), results: resultsRevision(), updatedAt: decisionRow(decision.id).updatedAt }).toEqual(before);
	});

	it('gives the closing time as stored, in UTC, and reads the window from stamps, at a closing time a far zone would put on another day (40)', async () => {
		// Opened 2026-11-10 09:00:00 UTC, closing 2026-11-12 23:30:00 UTC: the window opens at 2026-11-11 23:30:00 UTC.
		const { decision } = await opened([{ via: 'account' }], { closesIn: 62 * HOUR + 30 * MINUTE });
		expect(decision.closesAt).toBe('2026-11-12 23:30:00');

		await runAt(new Date('2026-11-11T23:29:59Z'));
		expect(sent.emails).toEqual([]);
		await runAt(new Date('2026-11-11T23:30:00Z'));

		expect(sent.emails).toHaveLength(1);
		expect(sent.emails[0].subject).toContain('2026-11-12 23:30:00 UTC');
		expect(sent.emails[0].html).toContain('asked by 2026-11-12 23:30:00 UTC');
	});

	it('shows the reminder on the record view in its words with its round and outcome, and on the person’s own record with no actor and no outcome (41)', async () => {
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const { decision, participants } = await opened();
		const { p, user } = participants[0];
		await runAt(at(25 * HOUR));

		const entries = readRecord(admin, decision.id, { participant: null, after: null }, { source: 'ui', limit: 500 }).entries;
		const reminder = entries.find((entry) => entry.kind === 'reminded')!;
		expect(reminder).toMatchObject({ versionNumber: 1, participant: p.name, actor: { name: 'DumpFire', source: 'system' }, detail: {} });
		expect(eventWords(reminder.kind)).toBe('A reminder was due before closing');
		expect(entries.at(-1)).toMatchObject({ kind: 'mail_outcome', detail: { mail: 'reminder', delivered: true } });

		const own = readPersonRecord(user!, p.personId!, { before: null }, { source: 'ui' });
		expect(own.audience).toBe('self');
		const participation = own.participations[0];
		expect(participation.kind).toBe('full');
		const events = participation.events as { kind: string }[];
		expect(events.filter((event) => event.kind === 'reminded')).toEqual([{ kind: 'reminded', at: remindersOf(decision.id)[0].createdAt, versionNumber: 1 }]);
		expect(events.some((event) => event.kind === 'mail_outcome')).toBe(false);
	});
});

// ─── Gating and timers (decision 14: cases 42 to 44) ─────────────────────────

describe('its timers and its place', () => {
	// The reminder starts its timers once in the life of a process and has
	// nothing to stop them, and a test file is one process: so this is the
	// file's only start.
	it('runs first 5 minutes after it is started and then every 5 minutes, from one timer that keeps nothing alive; a second start starts nothing (42)', async () => {
		vi.useRealTimers();
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
		const timers: { hasRef(): boolean }[] = [];
		const fakeTimeout = globalThis.setTimeout;
		const fakeInterval = globalThis.setInterval;
		const timeouts = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((...args: Parameters<typeof setTimeout>) => {
			const timer = fakeTimeout(...args);
			timers.push(timer as unknown as { hasRef(): boolean });
			return timer;
		}) as typeof setTimeout);
		const intervals = vi.spyOn(globalThis, 'setInterval').mockImplementation(((...args: Parameters<typeof setInterval>) => {
			const timer = fakeInterval(...args);
			timers.push(timer as unknown as { hasRef(): boolean });
			return timer;
		}) as typeof setInterval);
		try {
			stub.smtpAsked = 0;
			initDecisionReminders();
			initDecisionReminders();
			expect(vi.getTimerCount()).toBe(1);
			expect(stub.smtpAsked).toBe(0);

			await vi.advanceTimersByTimeAsync(5 * MINUTE - 1);
			expect(stub.smtpAsked).toBe(0);
			await vi.advanceTimersByTimeAsync(1);
			expect(stub.smtpAsked).toBe(1);
			// The first run does not come round again: the 5-minute one alone is waiting.
			expect(vi.getTimerCount()).toBe(1);
			await vi.advanceTimersByTimeAsync(5 * MINUTE);
			expect(stub.smtpAsked).toBe(2);
			await vi.advanceTimersByTimeAsync(5 * MINUTE);
			expect(stub.smtpAsked).toBe(3);

			expect(timers).toHaveLength(2);
			expect(timers.map((timer) => timer.hasRef())).toEqual([false, false]);
		} finally {
			timeouts.mockRestore();
			intervals.mockRestore();
		}
	});

	it('imports no write wrapper, exports nothing handed a caller, names no record table and holds no onConflict (43)', () => {
		const source = readFileSync(join(process.cwd(), 'src/lib/server/decision-reminders.ts'), 'utf-8');

		expect(source).not.toMatch(/\binWrite\b/);
		expect(source).not.toMatch(/write-as/);
		expect(source).not.toMatch(/onConflict/);
		expect(source).not.toMatch(/\bdecision_(?:versions|responses|rulings|events|questions)\b/);
		const exported = [...source.matchAll(/export (?:async )?function (\w+)\(([^)]*)\)/g)].map(([, name, params]) => ({ name, params }));
		expect(exported.map((fn) => fn.name).sort()).toEqual(['initDecisionReminders', 'runDecisionReminders', 'runDecisionRemindersOnce', 'stillStands']);
		for (const fn of exported) expect(fn.params, fn.name).not.toMatch(/caller|SessionUser/);
	});

	it('awaits its own sends: unresolved while a send is out, and every outcome written the moment it resolves, with nothing queued (44)', async () => {
		const { decision } = await opened([{ via: 'account' }, { via: 'link' }]);
		let release!: () => void;
		stub.holdSend = new Promise<void>((resolve) => (release = resolve));
		vi.setSystemTime(at(25 * HOUR));
		let done = false;

		const running = runDecisionReminders(new Date()).then((result) => {
			done = true;
			return result;
		});
		for (let turn = 0; turn < 3; turn++) await new Promise((resolve) => setImmediate(resolve));
		expect(done).toBe(false);
		expect(sent.emails).toEqual([]);
		release();
		const result = await running;

		expect(result).toEqual({ recorded: 2, sent: 2 });
		const reminders = remindersOf(decision.id);
		expect(reminders).toHaveLength(2);
		expect(reminders.map((e) => outcomeOf(decision.id, e.id))).toEqual(reminders.map((e) => ({ of: e.id, mail: 'reminder', delivered: true })));
		expect(sent.emails).toHaveLength(2);
		const written = eventsOf(decision.id).length;
		await sent.settle();
		expect(eventsOf(decision.id)).toHaveLength(written);
		expect(sent.emails).toHaveLength(2);
	});
});
