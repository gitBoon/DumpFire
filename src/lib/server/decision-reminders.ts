/**
 * decision-reminders.ts — the closing-date reminder (card 2685): one short
 * mail, about a day before a decision's closing time, to each consulted
 * participant who has not yet responded in the current round.
 *
 * When: a participant is reminded at the first run on or after 24 hours
 * before `closes_at`, and never in its last hour: `closes_at` in
 * `(now + 1 h, now + 24 h]`. Their asking mail of the round (the `invited` or
 * `asked_again` at or after the round's version was published) must have been
 * delivered and be at least 24 hours old, so a decision opened less than 25
 * hours before it closes sends none: its invitation is the reminder.
 *
 * Who (`dueOf`, decision 4): a decision stored `open`; a consulted
 * participant, not removed, whom `reachOf` reaches; a link holder only while
 * they hold a live link and their latest record mail, the one that carried
 * it, was delivered; no counted response in the round; no reminder in the
 * round yet; no role, address, account or inclusion change since the asking
 * mail; an account holder only with `email_decisions` and the master switch
 * on, preferences that cannot be read counting as off; and `mailRestOf`
 * letting them be mailed now. Anyone else is passed over and nothing is
 * written, so a run every 5 minutes leaves no trail of skips. The clauses
 * asked at both the write and the send are one function, `standsAt`.
 *
 * Record, then send, one participant at a time (decision 3): a pre-filter
 * outside any transaction, two batched reads once per decision, leaves out
 * those already answered or reminded in the round; then for each one left,
 * one `inTransaction` (`BEGIN IMMEDIATE`) re-reads the decision and the
 * participant on a fresh clock, asks the whole of `dueOf`, and writes
 * `reminded` through `appendEvent`; after the commit the reminder is asked
 * again with the rows and the clock as they are then (`stillStands`,
 * decision 9), sent and awaited, and its `mail_outcome { of, mail:
 * 'reminder', delivered, problem? }` written; then the next participant. A
 * restart mid-run leaves at most the one reminder in hand recorded with no
 * outcome, and it is never sent again: at most once. Three guards hold the
 * once: the write lock, the in-flight flag (`runDecisionRemindersOnce`), and
 * migration 0063's partial unique index, one `reminded` per participant per
 * round, whose refusal is caught for that participant alone. Any other fault
 * is caught for its decision alone: one line with ids only, and the run goes
 * on with the next decision.
 *
 * A link holder is minted no link (decision 5): the mail tells them to use
 * the one in their latest record mail. An account holder's mail links to the
 * decision's page, behind a sign-in. No column of `decisions` or of a
 * participant is written, so neither revision moves (decision 12).
 *
 * At most `REMINDERS_PER_RUN` are recorded in a run, and no new participant
 * is started once `REMINDER_RUN_BUDGET_MS` has passed (decision 15). With no
 * mail host or no link address nothing is recorded, and one WARN line per
 * process says so, only when a reminder is due and cannot go (decision 8).
 *
 * Started only by `startSchedulers`, with the other schedulers: off under
 * the dev server unless SCHEDULERS=on, off in tests and in a rehearsal
 * (decision 14). Not a service: it imports no write wrapper and no function
 * here is handed a caller. It writes as DumpFire, with `inTransaction`, as a
 * job does.
 */
import { and, asc, eq, gt, isNull, lte } from 'drizzle-orm';
import { db } from './db';
import { decisionParticipants, decisions, people, users, type Decision, type DecisionParticipant } from './db/schema';
import { inTransaction } from './db/transaction';
import {
	accountHistory,
	appendEvent,
	askingMailsOf,
	changedSinceAsked,
	countedInRound,
	currentRound,
	lastMailAt,
	mailsSince,
	remindedIn,
	reminderOf,
	SYSTEM_ACTOR
} from './decision-record';
import { mailedLinkOf, reachOf } from './decision-links';
import { DAY_MS, decisionLinkBase, mailRestOf, reminderMail } from './decision-mail';
import { isSmtpConfigured, trySendEmail } from './email';
import { createLogger } from './logger';
import { shouldNotifyUser } from './notifications';
import type { NotificationPref } from '$lib/notification-prefs';
import { stamp } from '$lib/timestamps';

const log = createLogger('DECISIONS');

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** How long before the closing time the window opens: the first run on or after it reminds. */
export const REMINDER_WINDOW_MS = 24 * HOUR_MS;

/** The last stretch before the closing time in which no reminder is sent: it would tell someone to do what they soon cannot. */
export const REMINDER_LAST_MS = HOUR_MS;

/** How old the round's asking mail must be before a reminder of it is sent. */
export const REMINDER_AFTER_ASKED_MS = 24 * HOUR_MS;

/** The most reminders recorded in one run (decision 15). */
export const REMINDERS_PER_RUN = 200;

/** No new participant is started once a run has taken this long (decision 15, S3). */
export const REMINDER_RUN_BUDGET_MS = 4 * MINUTE_MS;

/** The first run, after the server starts: nothing at start, so a wrongly started copy can be stopped first. */
export const FIRST_RUN_MS = 5 * MINUTE_MS;

/** A run every 5 minutes after the first. */
export const RUN_EVERY_MS = 5 * MINUTE_MS;

/** How a participant stands on the clauses asked at both the write and the send (`standsAt`). */
type Standing = {
	via: 'account' | 'link';
	/** The link the row holds, for a link holder; null for an account holder. */
	linkHash: string | null;
	/** Their latest record mail, for a link holder: the one that carried that link. */
	lastMailEventId: number | null;
};

/** A participant, as the reminder found them at the write: what the send asks again. */
type Built = Standing & {
	decisionId: number;
	participantId: number;
	round: number;
	to: string;
	/** The round's asking mail. */
	askedEventId: number;
};

/** What a send needs, once the reminder is recorded. */
type Recorded = Built & { eventId: number };

/** A second `reminded` for one participant and round, refused by migration 0063's index. */
class AlreadyReminded extends Error {
	constructor(readonly round: number) {
		super('already reminded');
	}
}

/** A SQLite error's code, or '' for none. */
function codeOf(err: unknown): string {
	const code = err !== null && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
	return typeof code === 'string' ? code : '';
}

/**
 * The window at `t`, as stored text (decision 13): a closing time `c` is in
 * it when `after < c <= until`, which is `(t + 1 h, t + 24 h]`. The one
 * reckoning of it, for the run's selection and every check alike.
 */
function windowBounds(t: Date): { after: string; until: string } {
	return { after: stamp(new Date(t.getTime() + REMINDER_LAST_MS)), until: stamp(new Date(t.getTime() + REMINDER_WINDOW_MS)) };
}

/** Whether `closesAt` is in the window at `t` (`windowBounds`). */
function inWindow(closesAt: string | null, t: Date): boolean {
	if (closesAt === null) return false;
	const { after, until } = windowBounds(t);
	return closesAt > after && closesAt <= until;
}

/** The open decisions whose closing time is in the window at `now`, soonest closing first. */
function dueDecisions(now: Date): number[] {
	const { after, until } = windowBounds(now);
	return db
		.select({ id: decisions.id })
		.from(decisions)
		.where(and(eq(decisions.status, 'open'), gt(decisions.closesAt, after), lte(decisions.closesAt, until)))
		.orderBy(asc(decisions.closesAt), asc(decisions.id))
		.all()
		.map((row) => row.id);
}

/** The decision's consulted participants who are not removed, in row order. */
function consultedOf(decisionId: number): number[] {
	return db
		.select({ id: decisionParticipants.id })
		.from(decisionParticipants)
		.where(and(eq(decisionParticipants.decisionId, decisionId), eq(decisionParticipants.role, 'consulted'), isNull(decisionParticipants.removedAt)))
		.orderBy(asc(decisionParticipants.id))
		.all()
		.map((row) => row.id);
}

/**
 * The decision's consulted participants who are not removed, in row order,
 * less those the record already shows answered or reminded in the current
 * round (code review F3, S3): two batched reads, outside any transaction,
 * once per decision, so that the write lock is taken only for a participant
 * who may be due, and not once per participant per run for a decision most
 * of whose participants have answered. A pre-filter alone: each one it
 * leaves is asked the whole of `dueOf` again inside its record step, so a
 * response or a reminder written after it is still seen.
 */
function candidatesOf(decisionId: number): number[] {
	const ids = consultedOf(decisionId);
	const round = currentRound(decisionId);
	if (ids.length === 0 || round < 1) return [];
	const answered = countedInRound(ids.map((participantId) => ({ participantId, round })));
	const reminded = remindedIn(ids, round);
	return ids.filter((id) => !answered.has(id) && !reminded.has(id));
}

/** The participant's person, or null for none. */
function personOf(p: DecisionParticipant) {
	return p.personId === null ? null : (db.select().from(people).where(eq(people.id, p.personId)).get() ?? null);
}

/** The preference the reminder follows, with the master switch (decision 6): a key of the one list, so one nobody can save is refused. */
const REMINDER_PREF: NotificationPref = 'email_decisions';

/**
 * Whether the account's preferences let it be sent the reminder (decision 6,
 * code review S6): the master switch first, then `email_decisions`; none
 * saved is every switch on. An account that is not there is off for this
 * mail: an unattended job sends nothing it cannot show was wanted.
 * Preferences that cannot be read are off, as they are now for every mail:
 * `shouldNotifyUser` took that rule from here, with its one WARN line per
 * account per process (card 2724).
 */
function prefsAllow(userId: number): boolean {
	const row = db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get();
	if (row === undefined) return false;
	return shouldNotifyUser(userId, REMINDER_PREF);
}

/**
 * The clauses asked both at the write and just before the send (decisions 4
 * and 9; code review F4), on the clock `t`, for round `round` and its asking
 * mail `askedEventId`: the decision stored open and closing in the window;
 * the participant consulted, not removed, and of this decision; reached by
 * `reachOf`; a link holder holding a live link whose latest record mail, the
 * one that carried it, was delivered (S1); no counted response in the round;
 * no change of role, address, account or inclusion since the asking mail;
 * and an account holder's switches on (`prefsAllow`). How they stand if so,
 * else null. `dueOf` adds the clauses asked only at the write, and
 * `stillStands` those asked only at the send.
 */
function standsAt(decision: Decision, p: DecisionParticipant, round: number, askedEventId: number, t: Date): Standing | null {
	// Stored open, and closing in the window on `t`.
	if (decision.status !== 'open' || !inWindow(decision.closesAt, t)) return null;
	// Consulted, not removed, and this decision's.
	if (p.role !== 'consulted' || p.removedAt !== null || p.decisionId !== decision.id) return null;
	// Reached.
	const reach = reachOf(p, personOf(p), accountHistory(decision.id).get(p.id) ?? false);
	if (!('via' in reach)) return null;
	// A link holder holds a live link, and the latest record mail, which carried it, was delivered.
	let linkHash: string | null = null;
	let lastMailEventId: number | null = null;
	if (reach.via === 'link') {
		// The one rule, shared with the answer notice (card 2721, D2).
		const held = mailedLinkOf(decision, p, stamp(t));
		if (held === null) return null;
		linkHash = held.linkHash;
		lastMailEventId = held.lastMailEventId;
	}
	// No counted response in the round.
	if (countedInRound([{ participantId: p.id, round }]).has(p.id)) return null;
	// No role, address, account or inclusion change since the asking mail.
	if (changedSinceAsked(new Map([[p.id, askedEventId]])).has(p.id)) return null;
	// An account holder's switches, the master switch first.
	if (reach.via === 'account' && (p.userId === null || !prefsAllow(p.userId))) return null;
	return { via: reach.via, linkHash, lastMailEventId };
}

/**
 * Whether the participant is due a reminder at `t` (decision 4): what the
 * send needs if so, else null. The clauses asked only at the write (a
 * round, no reminder in it yet, the asking mail delivered and a day old, and
 * the rest), then `standsAt`. A read alone: the record step asks it inside
 * its transaction, and the no-mail warning without one.
 */
function dueOf(decision: Decision, p: DecisionParticipant, t: Date): Built | null {
	// 6. A round, and no reminder in it yet.
	const round = currentRound(decision.id);
	if (round < 1) return null;
	if ((remindedIn([p.id], round).get(p.id) ?? []).length > 0) return null;
	// 7. The round's asking mail delivered, and a day old.
	const asked = askingMailsOf(decision.id, round, [p.id]).get(p.id);
	if (asked === undefined || asked.delivered !== true || asked.at > stamp(new Date(t.getTime() - REMINDER_AFTER_ASKED_MS))) return null;
	// 1 to 5, 8 and 9, as the send asks them again.
	const standing = standsAt(decision, p, round, asked.eventId, t);
	if (standing === null) return null;
	// 10. The rest and the daily cap (decision 7).
	const rest = mailRestOf(p.name, lastMailAt([p.id]).get(p.id), mailsSince([p.id], stamp(new Date(t.getTime() - DAY_MS))).get(p.id) ?? [], stamp(t));
	if (rest !== null) return null;
	return { ...standing, decisionId: decision.id, participantId: p.id, round, to: p.email, askedEventId: asked.eventId };
}

/** The decision and the participant as they are now, or null for either not there. */
function rowsOf(decisionId: number, participantId: number): { decision: Decision; p: DecisionParticipant } | null {
	const decision = db.select().from(decisions).where(eq(decisions.id, decisionId)).get();
	const p = db.select().from(decisionParticipants).where(eq(decisionParticipants.id, participantId)).get();
	return decision && p ? { decision, p } : null;
}

/**
 * The record step (decision 3): in one transaction, the rows read again,
 * `dueOf` asked on `t`, and `reminded` written. Answers what the send needs,
 * or null when they are not due. A second reminder for the round, refused
 * by the index, rolls the step back and is thrown as `AlreadyReminded`.
 */
function recordOne(decisionId: number, participantId: number, t: Date): Recorded | null {
	return inTransaction(() => {
		const rows = rowsOf(decisionId, participantId);
		if (rows === null) return null;
		const built = dueOf(rows.decision, rows.p, t);
		if (built === null) return null;
		let eventId: number;
		try {
			eventId = appendEvent({ decisionId, kind: 'reminded', participantId, versionNumber: built.round }, SYSTEM_ACTOR);
		} catch (err) {
			if (codeOf(err) === 'SQLITE_CONSTRAINT_UNIQUE') throw new AlreadyReminded(built.round);
			throw err;
		}
		return { ...built, eventId };
	});
}

/**
 * Whether a recorded reminder is still to go (decision 9), asked just before
 * it is sent, on the clock `at`, with its own event left out of every read
 * that would count it: `decision_gone` when the decision, and so the
 * reminder, is gone; `superseded` when the round has moved on, it is not the
 * round's first reminder for the participant, `standsAt` no longer holds on
 * `at` (no longer open and closing in the window, no longer consulted or
 * reached, a link holder's link or its mail gone, a response given, a
 * change since the asking mail, an account holder's switches off), or they
 * are no longer at the address, by the route, with the link and the latest
 * mail the write found; `send` otherwise. `built` is what the write found; a
 * caller with none (a test of the record alone) is compared with the rows as
 * they are.
 */
export function stillStands(reminderEventId: number, at: Date, built: Built | null = null): 'send' | 'superseded' | 'decision_gone' {
	const reminder = reminderOf(reminderEventId);
	if (reminder === null) return 'decision_gone';
	// 1. The decision is there: its events go only with it, so the reminder's being there says so too.
	const rows = rowsOf(reminder.decisionId, reminder.participantId);
	if (rows === null) return 'superseded';
	const { decision, p } = rows;
	// 3. The round is the reminder's; 4. and it is the round's first reminder for them.
	if (currentRound(decision.id) !== reminder.round) return 'superseded';
	if ((remindedIn([p.id], reminder.round).get(p.id) ?? [])[0] !== reminderEventId) return 'superseded';
	// The asking mail the write found; for a caller with none, the round's as it is.
	const askedEventId = built?.askedEventId ?? askingMailsOf(decision.id, reminder.round, [p.id]).get(p.id)?.eventId;
	if (askedEventId === undefined) return 'superseded';
	// 2 and 5 to 9: as the write asked them, on the fresh clock.
	const standing = standsAt(decision, p, reminder.round, askedEventId, at);
	if (standing === null) return 'superseded';
	// Asked only at the send: the address, the route, the link and the latest mail are the ones the write found.
	if (
		built !== null &&
		(p.email !== built.to || standing.via !== built.via || standing.linkHash !== built.linkHash || standing.lastMailEventId !== built.lastMailEventId)
	) {
		return 'superseded';
	}
	return 'send';
}

/**
 * Send one recorded reminder, awaited by the run itself (decision 8), and
 * record its outcome in a transaction of its own. Answers whether it was
 * delivered. Never retried.
 */
async function sendOne(r: Recorded, base: string): Promise<boolean> {
	const at = new Date();
	const still = stillStands(r.eventId, at, r);
	if (still === 'decision_gone') {
		log.warn(`Decision ${r.decisionId}: reminder event ${r.eventId} was not sent, as the decision is gone`, { decisionId: r.decisionId, eventId: r.eventId });
		return false;
	}
	let result: { delivered: boolean; problem?: string };
	if (still === 'send') {
		const decision = db.select().from(decisions).where(eq(decisions.id, r.decisionId)).get()!;
		const { subject, html } = reminderMail(decision, r.via, base);
		const outcome = await trySendEmail(r.to, subject, html, { recipient: `participant ${r.participantId} of decision ${r.decisionId} reminder` });
		result = outcome.sent ? { delivered: true } : { delivered: false, problem: outcome.problem };
	} else {
		result = { delivered: false, problem: 'superseded' };
	}
	try {
		inTransaction(() =>
			appendEvent(
				{ decisionId: r.decisionId, kind: 'mail_outcome', participantId: r.participantId, detail: { of: r.eventId, mail: 'reminder', ...result } },
				SYSTEM_ACTOR
			)
		);
	} catch {
		// The decision deleted meanwhile, for one: the run goes on with the next participant.
		log.warn(`Decision ${r.decisionId}: the outcome of reminder event ${r.eventId} could not be recorded`, { decisionId: r.decisionId, eventId: r.eventId });
	}
	return result.delivered;
}

/** Whether this process has said that a due reminder cannot go for want of mail; cleared once a run finds mail set up. */
let warnedNoMail = false;

/** Whether any participant of the due decisions is due at `now`: read without writing, for the no-mail warning (D9), through the run's pre-filter. */
function someoneDue(decisionIds: readonly number[], now: Date): boolean {
	for (const decisionId of decisionIds) {
		for (const participantId of candidatesOf(decisionId)) {
			const rows = rowsOf(decisionId, participantId);
			if (rows !== null && dueOf(rows.decision, rows.p, now) !== null) return true;
		}
	}
	return false;
}

/**
 * One run (decision 3): every participant due at `now`, soonest closing
 * first, recorded then sent one at a time, until `opts.limit` are recorded or
 * `opts.budgetMs` has passed since `now`. Answers how many were recorded and
 * how many delivered. Tests call it directly; the timer calls it through
 * `runDecisionRemindersOnce`.
 *
 * A fault is held to the narrowest part it can be (code review S2): a
 * second reminder refused by the index, to that participant (a WARN line); a
 * busy or locked database, to that decision (a WARN line, the rest of it
 * left to the next run); and any other error, in the pre-filter, a record
 * step, a mail built or a send, to that decision too: one ERROR line with
 * the decision's and the participant's ids alone, as an error's own words may
 * hold an address, and the run goes on with the next decision. A reminder
 * recorded before such a fault keeps no outcome and is never sent again.
 */
export async function runDecisionReminders(now: Date, opts: { limit?: number; budgetMs?: number } = {}): Promise<{ recorded: number; sent: number }> {
	const limit = opts.limit ?? REMINDERS_PER_RUN;
	const budgetMs = opts.budgetMs ?? REMINDER_RUN_BUDGET_MS;
	const base = decisionLinkBase();
	const due = dueDecisions(now);

	if (!isSmtpConfigured() || base === null) {
		if (!warnedNoMail && due.length > 0 && someoneDue(due, now)) {
			warnedNoMail = true;
			log.warn(
				`Decision reminders are due and cannot be sent: ${base === null ? 'this server has no App URL and no ORIGIN to make links on' : 'mail is not set up on this server'}. ` +
					'Nothing is recorded, and each is sent once mail is set up, while it is still due'
			);
		}
		return { recorded: 0, sent: 0 };
	}
	warnedNoMail = false;

	let recorded = 0;
	let sent = 0;
	const spent = () => recorded >= limit || new Date().getTime() - now.getTime() >= budgetMs;
	run: for (const decisionId of due) {
		if (spent()) break;
		let inHand: number | null = null;
		try {
			for (const participantId of candidatesOf(decisionId)) {
				if (spent()) break run;
				inHand = participantId;
				let r: Recorded | null;
				try {
					r = recordOne(decisionId, participantId, new Date());
				} catch (err) {
					if (!(err instanceof AlreadyReminded)) throw err;
					log.warn(`Decision ${decisionId}: participant ${participantId} was already reminded in round ${err.round}`, { decisionId, participantId });
					continue;
				}
				if (r === null) continue;
				recorded++;
				if (await sendOne(r, base)) sent++;
			}
		} catch (err) {
			const code = codeOf(err);
			if (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')) {
				log.warn(`Decision ${decisionId}: its reminders were left to the next run, as the database was busy (${code})`, { decisionId });
				continue;
			}
			log.error(
				`Decision ${decisionId}: its reminders were left to the next run, as a step failed${inHand === null ? '' : ` at participant ${inHand}`}`,
				{ decisionId, participantId: inHand }
			);
		}
	}
	return { recorded, sent };
}

/** True while a run of `runDecisionRemindersOnce` is going. */
let runInFlight = false;

/**
 * One tick of the timer: `runDecisionReminders(now)`, unless the last tick's
 * run is still going. Answers false when it skipped the tick. The `finally`
 * clears the flag when a run throws, so one failure does not stop the job.
 */
export async function runDecisionRemindersOnce(now: Date): Promise<boolean> {
	if (runInFlight) return false;
	runInFlight = true;
	try {
		await runDecisionReminders(now);
		return true;
	} finally {
		runInFlight = false;
	}
}

let reminderTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Run 5 minutes from now and then every 5 minutes (idempotent). Called by
 * `startSchedulers` alone, only where the schedulers run. Neither timer keeps
 * the process alive, a second call starts nothing, and a run's error is
 * logged at ERROR, never left to reject unhandled.
 */
export function initDecisionReminders(): void {
	if (reminderTimer) return;
	const tick = () => {
		runDecisionRemindersOnce(new Date()).catch((err) => log.error('The decision reminder run stopped', err));
	};
	reminderTimer = setTimeout(() => {
		tick();
		reminderTimer = setInterval(tick, RUN_EVERY_MS);
		reminderTimer.unref();
	}, FIRST_RUN_MS);
	reminderTimer.unref();
	log.info('Decision reminders initialised: first run in 5 minutes, then every 5 minutes');
}
