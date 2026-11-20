/**
 * The decision service (card 2675, slices 2a and 2b): a draft made with its
 * default decider, the decider named, the participants set before and after
 * opening, and opening; re-publishing, closing, extending, withdrawing and
 * deleting; re-sending, and the administrator's participant actions; with
 * the mails that carry the record, the ruling mail among them, and what is
 * recorded of each (`src/lib/server/decision-authoring-writes.ts`,
 * `src/lib/server/decision-lifecycle-writes.ts`, `src/lib/server/decision-participant-writes.ts`
 * and `src/lib/server/decision-mail.ts`).
 *
 * Each write is called as a route will call it, inside `writeAs` and handed
 * its `caller`, with `effects()` installed so that no mail leaves, mail set
 * up (`makeSmtp`) and an App URL saved. Every mail case checks that nothing
 * started inside a transaction. A reader's own refusals are
 * `request-body.test.ts`'s and `getBoardRole`'s branches the board access
 * tests'; neither is repeated. The cases are the plan's,
 * `docs/planning/card-2675-decision-service.md`, section 6, by number.
 */
import { isHttpError } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import type { SessionUser } from '$lib/server/auth';
import {
	boards,
	decisionOptions,
	decisionParticipants,
	decisions,
	people,
	peopleGroupMembers,
	peopleGroups,
	settings,
	users,
	type Board,
	type Decision
} from '$lib/server/db/schema';
import { actorFor, appendEvent, lastToldOf, liveOptionIds, SYSTEM_ACTOR } from '$lib/server/decision-record';
import { decisionAccess } from '$lib/server/decision-access';
import { readEditPage } from '$lib/server/decision-authoring';
import { CLOSED_ASK_WORDS, participantForLink } from '$lib/server/decision-links';
import { CALLER_MAIL_DAILY_CAP, DAY_MS, HELD_WORDS, queueRecordMails, RECORD_MAIL_DAILY_CAP, RECORD_MAIL_MIN_MINUTES } from '$lib/server/decision-mail';
import { toldWords } from '$lib/decision-words';
import { mailedOnSave, openForInput } from '$lib/decision-rules';
import { createDecision, setDecider } from '$lib/server/decision-authoring-writes';
import { closeDecision, deleteDecision, extendDecision, openDecision, republishDecision, withdrawDecision } from '$lib/server/decision-lifecycle-writes';
import { changeParticipantAddress, resendInvitation, setParticipantAccount, setParticipants } from '$lib/server/decision-participant-writes';
import { deleteUser } from '$lib/server/deletes';
import { mailStatus, NO_LINK_ADDRESS } from '$lib/server/email';
import { subscribe } from '$lib/server/events';
import { updatePerson } from '$lib/server/people';
import { resetAllRateLimits, takeAllowance } from '$lib/server/rate-limit';
import { requireDecision } from '$lib/server/route-guards';
import { parseStamp, stamp } from '$lib/timestamps';
import { writeAs } from '$lib/server/write-as';
import { STEP_UP_MISSING } from '$lib/step-up-words';
import type { ServiceOptions } from '$lib/server/write-as';
import { FUTURE as SHARED_FUTURE, OPEN_FAULTS, readyDraft as readyDraftOn, revisionNow } from './helpers/decision-faults';
import { effects, type Effects, type OfferedMail } from './helpers/effects';
import { readBudget } from './helpers/reads';
import {
	addBoardMember,
	ageRecordMail,
	holdingPassword,
	linkHashOf,
	makeBoard,
	makeDecision,
	makeOption,
	makeParticipant,
	makePerson,
	makeSmtp,
	makeUser,
	resetDb
} from './helpers/fixtures';

const APP = 'https://kanban.example.test';
const UI: ServiceOptions = { source: 'ui' };
/** The shared helper's closing time, within the year opening and re-publishing allow (card 2697's code review, part B, S3). */
const FUTURE = SHARED_FUTURE;

/** An error as nodemailer throws one. */
const refused = (code: string, message: string, more: Record<string, unknown> = {}) => Object.assign(new Error(message), { code }, more);

/** The personal link in a mail, and its token. */
const linkIn = (html: string) => html.match(/https:\/\/kanban\.example\.test\/decision-link\/[A-Za-z0-9_-]+/)?.[0] ?? null;
const tokenOf = (link: string) => link.slice(link.lastIndexOf('/') + 1);

let sent: Effects;
/** What the recorded mail server answers each mail with: an error to refuse it, undefined to take it. */
let refusal: (mail: OfferedMail) => Error | undefined;

let owner: SessionUser;
let board: Board;

beforeEach(() => {
	resetDb();
	// Card 2697 (Q32): the publish limit's allowance is in memory, and ids repeat after resetDb.
	resetAllRateLimits();
	makeSmtp();
	db.insert(settings).values({ key: 'app_url', value: APP }).run();
	owner = makeUser({ username: 'owner' });
	board = makeBoard({ owner, name: 'The board' }).board;
	refusal = () => undefined;
	sent = effects({ mailRefusal: (mail) => refusal(mail) });
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

/** A refusal's status and whole body, its `stepUp` code with it (card 2726); anything else is thrown on. */
function refusalOf(run: () => unknown): { status: number; body: App.Error } | 'passed' {
	try {
		run();
		return 'passed';
	} catch (err) {
		if (isHttpError(err)) return { status: err.status, body: err.body };
		throw err;
	}
}

type EventRow = { id: number; kind: string; participantId: number | null; versionNumber: number | null; detail: any; actorName: string; source: string };

/** The decision's events, in order, their detail read. */
function eventsOf(decisionId: number): EventRow[] {
	return (
		sqlite
			.prepare(
				'SELECT id, kind, participant_id AS participantId, version_number AS versionNumber, detail, actor_name AS actorName, source FROM decision_events WHERE decision_id = ? ORDER BY id'
			)
			.all(decisionId) as (Omit<EventRow, 'detail'> & { detail: string | null })[]
	).map((row) => ({ ...row, detail: row.detail === null ? null : JSON.parse(row.detail) }));
}

const kindsOf = (decisionId: number) => eventsOf(decisionId).map((event) => event.kind);
const count = (table: string) => (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const decisionRow = (id: number) => db.select().from(decisions).where(eq(decisions.id, id)).get()!;
const participantRow = (id: number) => db.select().from(decisionParticipants).where(eq(decisionParticipants.id, id)).get()!;
const participantRows = (decisionId: number) =>
	db.select().from(decisionParticipants).where(eq(decisionParticipants.decisionId, decisionId)).orderBy(decisionParticipants.id).all();
const activityRows = () =>
	sqlite.prepare('SELECT board_id AS boardId, card_id AS cardId, action, detail, user_id AS userId FROM activity_log ORDER BY id').all() as {
		boardId: number;
		cardId: number | null;
		action: string;
		detail: string;
		userId: number | null;
	}[];

/** Wait until the decision has `n` delivery outcomes recorded. */
const outcomesOf = (decisionId: number) => eventsOf(decisionId).filter((event) => event.kind === 'mail_outcome');
const waitForOutcomes = (decisionId: number, n: number) => vi.waitFor(() => expect(outcomesOf(decisionId)).toHaveLength(n));

// ─── Creating a draft (cases 21, 22, 47) ────────────────────────────────────

describe('createDecision', () => {
	it("makes a draft with the board's and author's names and the Product Owner as decider, and one created event (21)", async () => {
		const editor = makeUser({ username: 'editor' });
		addBoardMember(board, editor, 'editor');
		const productOwner = makeUser({ username: 'po' });
		addBoardMember(board, productOwner, 'editor');
		db.update(boards).set({ productOwnerUserId: productOwner.id }).where(eq(boards.id, board.id)).run();

		const decision = as(editor, (caller) => createDecision(caller, { boardId: board.id }, { title: '  Which budget?  ' }, UI));

		expect(decision).toMatchObject({
			boardId: board.id,
			boardName: 'The board',
			title: 'Which budget?',
			status: 'draft',
			authorUserId: editor.id,
			authorName: 'editor',
			deciderUserId: productOwner.id,
			deciderName: 'po',
			currentVersion: 0
		});
		expect(eventsOf(decision.id)).toEqual([
			{ id: expect.any(Number), kind: 'created', participantId: null, versionNumber: null, detail: { decider: 'product_owner' }, actorName: 'editor', source: 'ui' }
		]);
		await sent.settle();
		expect(activityRows()).toEqual([]);
		expect(sent.all).toEqual([]);
	});

	it('falls back to the author for a Product Owner who can no longer edit, and on a board with none (22)', () => {
		const author = makeUser({ username: 'author' });
		addBoardMember(board, author, 'editor');
		const lapsed = makeUser({ username: 'lapsed' });
		addBoardMember(board, lapsed, 'viewer');
		db.update(boards).set({ productOwnerUserId: lapsed.id }).where(eq(boards.id, board.id)).run();

		const first = as(author, (caller) => createDecision(caller, { boardId: board.id }, { title: 'First' }, UI));
		expect(first).toMatchObject({ deciderUserId: author.id, deciderName: 'author' });
		expect(eventsOf(first.id).map((event) => event.detail)).toEqual([{ decider: 'author' }]);

		db.update(boards).set({ productOwnerUserId: null }).where(eq(boards.id, board.id)).run();
		const second = as(author, (caller) => createDecision(caller, { boardId: board.id }, { title: 'Second' }, UI));
		expect(second).toMatchObject({ deciderUserId: author.id, deciderName: 'author' });
		expect(eventsOf(second.id).map((event) => event.detail)).toEqual([{ decider: 'author' }]);
	});

	// Card 2671 (case 23): a disabled account can edit no board, so is decider by no default.
	it('falls back to the author for a Product Owner whose account is disabled', () => {
		const author = makeUser({ username: 'author' });
		addBoardMember(board, author, 'editor');
		const gone = makeUser({ username: 'gone', disabled: true });
		addBoardMember(board, gone, 'editor');
		db.update(boards).set({ productOwnerUserId: gone.id }).where(eq(boards.id, board.id)).run();

		const decision = as(author, (caller) => createDecision(caller, { boardId: board.id }, { title: 'First' }, UI));

		expect(decision).toMatchObject({ deciderUserId: author.id, deciderName: 'author' });
		expect(eventsOf(decision.id).map((event) => event.detail)).toEqual([{ decider: 'author' }]);
	});

	it('refuses a title holding a control, direction or invisible character, and saves & and < as sent (47)', () => {
		// S6: every other format character too, \p{Cf}: a word joiner, a soft hyphen, an Arabic letter mark, a tag character.
		for (const title of ['Word\u{2060}joiner', 'Soft\u{ad}hyphen', 'Mark\u{61c}ed', 'Tag \u{e0041}', 'Budget ‮evil', 'Budget \u0007 bell', 'Bud​get']) {
			expect(outcome(() => as(owner, (caller) => createDecision(caller, { boardId: board.id }, { title }, UI)))).toEqual({
				status: 400,
				message: 'title cannot hold control, direction or invisible characters'
			});
		}
		expect(count('decisions')).toBe(0);
		expect(count('decision_events')).toBe(0);

		const saved = as(owner, (caller) => createDecision(caller, { boardId: board.id }, { title: 'Budget & <Q3>' }, UI));
		expect(decisionRow(saved.id).title).toBe('Budget & <Q3>');
	});
});

// ─── The decider (cases 23 to 25) ────────────────────────────────────────────

describe('setDecider', () => {
	it("saves a board editor as decider, and decider_changed names both (23)", () => {
		const editor = makeUser({ username: 'ed' });
		addBoardMember(board, editor, 'editor');
		const draft = makeDecision({ board, author: owner, decider: owner });

		const row = as(owner, (caller) => setDecider(caller, { decisionId: draft.id }, { deciderUserId: editor.id, revision: revisionNow(draft.id) }, UI));

		expect(row).toMatchObject({ deciderUserId: editor.id, deciderName: 'ed' });
		expect(decisionRow(draft.id)).toMatchObject({ deciderUserId: editor.id, deciderName: 'ed' });
		expect(eventsOf(draft.id)).toEqual([
			expect.objectContaining({
				kind: 'decider_changed',
				participantId: null,
				detail: { fromUserId: owner.id, fromName: 'owner', toUserId: editor.id, toName: 'ed' },
				actorName: 'owner'
			})
		]);
	});

	it('refuses an account that can only view, 400, and a decision with no board, 409 (24)', () => {
		const reader = makeUser();
		addBoardMember(board, reader, 'viewer');
		const draft = makeDecision({ board, author: owner, decider: owner });

		expect(outcome(() => as(owner, (caller) => setDecider(caller, { decisionId: draft.id }, { deciderUserId: reader.id, revision: revisionNow(draft.id) }, UI)))).toEqual({
			status: 400,
			message: `deciderUserId ${reader.id} cannot edit this board: a decision's decider must be an account that can edit its board`
		});
		expect(decisionRow(draft.id).deciderUserId).toBe(owner.id);
		expect(eventsOf(draft.id)).toEqual([]);

		const boardless = makeDecision({ board: null, author: owner, decider: owner });
		expect(
			outcome(() => as(owner, (caller) => setDecider(caller, { decisionId: boardless.id }, { deciderUserId: reader.id, revision: revisionNow(boardless.id) }, UI)))
		).toEqual({
			status: 409,
			message: "This decision's board has been deleted: its decider cannot be changed"
		});
		expect(decisionRow(boardless.id).deciderUserId).toBe(owner.id);
	});

	it('refuses the author and an administrator naming themselves once open, 403, and lets the author name themselves in a draft (25)', () => {
		const author = makeUser({ username: 'author' });
		addBoardMember(board, author, 'editor');
		const decider = makeUser({ username: 'decider' });
		addBoardMember(board, decider, 'editor');
		const admin = makeUser({ role: 'admin' });
		const open = makeDecision({ board, author, decider, status: 'open', closesAt: FUTURE });

		for (const who of [author, admin]) {
			expect(outcome(() => as(who, (caller) => setDecider(caller, { decisionId: open.id }, { deciderUserId: who.id, revision: revisionNow(open.id) }, UI)))).toEqual({
				status: 403,
				message: 'You cannot make yourself the decider of a decision that is open'
			});
		}
		expect(decisionRow(open.id).deciderUserId).toBe(decider.id);
		expect(eventsOf(open.id)).toEqual([]);

		const draft = makeDecision({ board, author, decider });
		as(author, (caller) => setDecider(caller, { decisionId: draft.id }, { deciderUserId: author.id, revision: revisionNow(draft.id) }, UI));
		expect(decisionRow(draft.id)).toMatchObject({ deciderUserId: author.id, deciderName: 'author' });
	});
});

// ─── Participants (cases 26 to 33) ───────────────────────────────────────────

describe('setParticipants on a draft', () => {
	it('gives each person a row with their snapshots, and writes no participant event, link or mail (26, 27)', async () => {
		const account = makeUser({ username: 'ana' });
		const ana = makePerson({ fullName: 'Ana', user: account, jobTitle: 'Engineer' });
		db.update(people).set({ email: 'Ana.Mixed@Example.Test' }).where(eq(people.id, ana.id)).run();
		const zeta = db.insert(peopleGroups).values({ name: 'Zeta' }).returning().get();
		const alpha = db.insert(peopleGroups).values({ name: 'Alpha' }).returning().get();
		db.insert(peopleGroupMembers).values([{ groupId: zeta.id, personId: ana.id }, { groupId: alpha.id, personId: ana.id }]).run();
		const bo = makePerson({ fullName: 'Bo', email: 'bo@example.test' });
		const draft = makeDecision({ board, author: owner, decider: owner });

		const rows = as(owner, (caller) =>
			setParticipants(
				caller,
				{ decisionId: draft.id },
				{ participants: [{ personId: ana.id, role: 'consulted' }, { personId: bo.id, role: 'informed' }], revision: revisionNow(draft.id) },
				UI
			)
		);

		expect(rows).toEqual([
			expect.objectContaining({
				personId: ana.id,
				role: 'consulted',
				name: 'Ana',
				email: 'ana.mixed@example.test',
				jobTitle: 'Engineer',
				groups: '["Alpha","Zeta"]',
				userId: account.id,
				includedBy: owner.id,
				includedByName: 'owner',
				removedAt: null,
				linkTokenHash: null
			}),
			expect.objectContaining({ personId: bo.id, role: 'informed', name: 'Bo', email: 'bo@example.test', groups: '[]', userId: null, linkTokenHash: null })
		]);
		expect(participantRows(draft.id)).toEqual(rows);

		// (27) Set again: Ana left out, Bo now consulted.
		const again = as(owner, (caller) =>
			setParticipants(caller, { decisionId: draft.id }, { participants: [{ personId: bo.id, role: 'consulted' }], revision: revisionNow(draft.id) }, UI)
		);
		expect(again).toEqual([expect.objectContaining({ id: rows[1].id, personId: bo.id, role: 'consulted' })]);
		expect(participantRows(draft.id)).toHaveLength(1);

		expect(eventsOf(draft.id)).toEqual([]);
		await sent.settle();
		expect(sent.all).toEqual([]);
	});

	// Card 2676, R6: the board owner calling is no administrator, so neither refusal names whoever the id belongs to.
	it('refuses a person who has left, 400 naming only the id, with nothing written (28)', () => {
		const gone = makePerson({ fullName: 'Gone', status: 'left' });
		const draft = makeDecision({ board, author: owner, decider: owner });

		expect(
			outcome(() =>
				as(owner, (caller) =>
					setParticipants(caller, { decisionId: draft.id }, { participants: [{ personId: gone.id, role: 'consulted' }], revision: revisionNow(draft.id) }, UI)
				)
			)
		).toEqual({
			status: 400,
			message: `personId ${gone.id} cannot be included`
		});
		expect(count('decision_participants')).toBe(0);
	});

	it('refuses an id that is no person, 400 naming it (29)', () => {
		const draft = makeDecision({ board, author: owner, decider: owner });

		expect(
			outcome(() =>
				as(owner, (caller) =>
					setParticipants(caller, { decisionId: draft.id }, { participants: [{ personId: 9999, role: 'consulted' }], revision: revisionNow(draft.id) }, UI)
				)
			)
		).toEqual({
			status: 400,
			message: 'personId 9999 cannot be included'
		});
		expect(count('decision_participants')).toBe(0);
	});
});

describe('setParticipants on an open decision', () => {
	const set = (decision: Decision, participants: { personId: number; role: string }[]) =>
		as(owner, (caller) => setParticipants(caller, { decisionId: decision.id }, { participants, revision: revisionNow(decision.id) }, UI));

	it('includes a person added, issues their link and invites them; leaves out one marked removed; brings them back on the same row (30, 31, 32)', async () => {
		const decision = makeDecision({ board, author: owner, decider: owner, status: 'open', closesAt: FUTURE, currentVersion: 1 });
		const cy = makePerson({ fullName: 'Cy', email: 'cy@example.test' });

		// (30) Added.
		const [row] = set(decision, [{ personId: cy.id, role: 'consulted' }]);
		expect(eventsOf(decision.id)).toEqual([
			expect.objectContaining({ kind: 'included', participantId: row.id, detail: { role: 'consulted', hadAccount: false }, actorName: 'owner', source: 'ui' }),
			expect.objectContaining({ kind: 'link_issued', participantId: row.id, detail: { replaced: false } }),
			expect.objectContaining({ kind: 'invited', participantId: row.id, detail: null })
		]);
		await waitForOutcomes(decision.id, 1);
		expect(sent.emails.map((mail) => mail.to)).toEqual(['cy@example.test']);
		const link = linkIn(sent.emails[0].html)!;
		expect(link).not.toBeNull();
		expect(participantRow(row.id).linkTokenHash).toBe(linkHashOf(tokenOf(link)));
		expect(sent.duringTransaction).toEqual([]);

		// (31) Left out: marked removed, its link ended, the row and a response it gave kept.
		sqlite
			.prepare("INSERT INTO decision_responses (decision_id, participant_id, version_number, round, kind, via) VALUES (?, ?, 1, 1, 'no_concerns', 'link')")
			.run(decision.id, row.id);
		const before = eventsOf(decision.id).length;
		set(decision, []);
		expect(participantRow(row.id)).toMatchObject({ removedBy: owner.id, linkTokenHash: null, linkIssuedAt: null });
		expect(participantRow(row.id).removedAt).not.toBeNull();
		expect(eventsOf(decision.id).slice(before)).toEqual([
			expect.objectContaining({ kind: 'removed', participantId: row.id, detail: null }),
			expect.objectContaining({ kind: 'link_revoked', participantId: row.id, detail: { reason: 'removed' } })
		]);
		expect(count('decision_responses')).toBe(1);

		// (32) Added again, past the throttle: the same row, a new link, an invitation.
		ageRecordMail(decision.id);
		sent.clear();
		const back = eventsOf(decision.id).length;
		const [again] = set(decision, [{ personId: cy.id, role: 'consulted' }]);
		expect(again.id).toBe(row.id);
		expect(again.removedAt).toBeNull();
		expect(eventsOf(decision.id).slice(back).map((event) => [event.kind, event.detail])).toEqual([
			['re_included', { role: 'consulted', hadAccount: false }],
			['link_issued', { replaced: false }],
			['invited', null]
		]);
		await waitForOutcomes(decision.id, 2);
		const second = linkIn(sent.emails[0].html)!;
		expect(second).not.toBe(link);
		expect(participantRow(row.id).linkTokenHash).toBe(linkHashOf(tokenOf(second)));
		expect(sent.duringTransaction).toEqual([]);
	});

	it('saves a changed role and writes role_changed (33)', async () => {
		const decision = makeDecision({ board, author: owner, decider: owner, status: 'open', closesAt: FUTURE });
		const dee = makePerson();
		const row = makeParticipant(decision, { person: dee, role: 'consulted', hadAccount: false });
		const before = eventsOf(decision.id).length;

		set(decision, [{ personId: dee.id, role: 'informed' }]);

		expect(participantRow(row.id).role).toBe('informed');
		expect(eventsOf(decision.id).slice(before)).toEqual([
			expect.objectContaining({ kind: 'role_changed', participantId: row.id, detail: { from: 'consulted', to: 'informed' } })
		]);
		await sent.settle();
		expect(sent.emails).toEqual([]);
	});

	it("marks removed a live row whose person was deleted, which no body can name, and its account loses the participant role (card 2676's C1)", async () => {
		const decision = makeDecision({ board, author: owner, decider: owner, status: 'open', closesAt: FUTURE, currentVersion: 1 });
		const account = makeUser({ username: 'deleted-person' });
		const gone = makePerson({ fullName: 'Gone Person', user: account });
		const staying = makePerson({ fullName: 'Staying' });
		const row = makeParticipant(decision, { person: gone, role: 'consulted', hadAccount: true, token: 'a-link-of-the-gone' });
		const kept = makeParticipant(decision, { person: staying, role: 'informed', hadAccount: false });
		expect(participantRow(row.id).userId).toBe(account.id);
		expect(decisionAccess(account, decisionRow(decision.id))).toMatchObject({ participantId: row.id });
		db.delete(people).where(eq(people.id, gone.id)).run();
		expect(participantRow(row.id)).toMatchObject({ personId: null, removedAt: null, userId: account.id });
		const before = eventsOf(decision.id).length;

		set(decision, [{ personId: staying.id, role: 'informed' }]);

		expect(participantRow(row.id)).toMatchObject({ removedBy: owner.id, linkTokenHash: null, linkIssuedAt: null });
		expect(participantRow(row.id).removedAt).not.toBeNull();
		expect(participantRow(kept.id).removedAt).toBeNull();
		expect(eventsOf(decision.id).slice(before)).toEqual([
			expect.objectContaining({ kind: 'removed', participantId: row.id, detail: null }),
			expect.objectContaining({ kind: 'link_revoked', participantId: row.id, detail: { reason: 'removed' } })
		]);
		const access = decisionAccess(account, decisionRow(decision.id));
		expect(access.roles.has('participant')).toBe(false);
		expect(access.participantId).toBeNull();
		await sent.settle();
		expect(sent.emails).toEqual([]);
	});
});

// ─── Card 2740: one made consulted while the decision is open is asked for their view ──

describe('card 2740: setParticipants asks one made consulted on an open decision for their view', () => {
	const set = (decision: Decision, participants: { personId: number; role: string }[]) =>
		as(owner, (caller) => setParticipants(caller, { decisionId: decision.id }, { participants, revision: revisionNow(decision.id) }, UI));
	const openOne = (row: { status?: string; closesAt?: string; closedAt?: string } = {}) =>
		makeDecision({ board, author: owner, decider: owner, status: 'open', closesAt: FUTURE, currentVersion: 1, openedAt: '2026-11-01 09:00:00', ...row });
	/** An informed participant reached through their account. */
	const informedHolder = (decision: Decision, fullName: string, email: string) => {
		const person = makePerson({ fullName, email, user: makeUser({ username: email.split('@')[0] }) });
		return { person, row: makeParticipant(decision, { person, role: 'informed', hadAccount: true }) };
	};
	const since = (decisionId: number, before: number) => eventsOf(decisionId).slice(before).map((event) => [event.kind, event.participantId, event.detail]);
	const panelRow = (decisionId: number, participantId: number) => readEditPage(owner, decisionId).delivery!.find((row) => row.participantId === participantId)!;
	/** A record mail of the participant, written now: it starts their rest and counts toward their daily cap. */
	const mailedNow = (decisionId: number, participantId: number) => appendEvent({ decisionId, kind: 'invited', participantId }, SYSTEM_ACTOR);

	it('sends an account holder made consulted the invitation, asking for their view, and their banner says they were asked (2740-1)', async () => {
		const decision = openOne();
		const { person, row } = informedHolder(decision, 'Ivy Informed', 'ivy@example.test');
		const before = eventsOf(decision.id).length;

		set(decision, [{ personId: person.id, role: 'consulted' }]);

		expect(participantRow(row.id).role).toBe('consulted');
		expect(since(decision.id, before)).toEqual([
			['role_changed', row.id, { from: 'informed', to: 'consulted' }],
			['invited', row.id, null]
		]);
		await waitForOutcomes(decision.id, 1);
		expect(sent.emails.map((mail) => [mail.to, mail.subject])).toEqual([['ivy@example.test', `Your view is asked: ${decision.title}`]]);
		expect(sent.emails[0].html).toContain(`${APP}/decisions/${decision.id}`);
		expect(sent.emails[0].html).not.toContain('Nothing is asked of you');
		expect(sent.duringTransaction).toEqual([]);
		expect(outcomesOf(decision.id).map((event) => event.detail)).toEqual([{ of: expect.any(Number), mail: 'invitation', delivered: true }]);
		// Card 2708's told line reads the invitation in the role it was sent for (card 2742): consulted, so asked, not told for their information.
		expect(lastToldOf(participantRow(row.id))).toMatchObject({ kind: 'invited', delivered: true, sentAs: 'consulted' });
		expect(toldWords(lastToldOf(participantRow(row.id)), row.includedAt)).toMatch(/^You were asked for your view on this decision on .+, by email\.$/);
	});

	it('sends a link holder made consulted a fresh link through the normal path, replacing the last (2740-2)', async () => {
		const decision = openOne();
		const lee = makePerson({ fullName: 'Lee Link', email: 'lee@example.test' });
		const row = makeParticipant(decision, { person: lee, role: 'informed', hadAccount: false, token: 'the-informed-link' });
		const before = eventsOf(decision.id).length;

		set(decision, [{ personId: lee.id, role: 'consulted' }]);

		expect(since(decision.id, before)).toEqual([
			['role_changed', row.id, { from: 'informed', to: 'consulted' }],
			['link_issued', row.id, { replaced: true }],
			['invited', row.id, null]
		]);
		await waitForOutcomes(decision.id, 1);
		expect(sent.emails.map((mail) => [mail.to, mail.subject])).toEqual([['lee@example.test', `Your view is asked: ${decision.title}`]]);
		const link = linkIn(sent.emails[0].html)!;
		expect(link).not.toBeNull();
		expect(participantRow(row.id).linkTokenHash).toBe(linkHashOf(tokenOf(link)));
		expect(participantRow(row.id).linkTokenHash).not.toBe(linkHashOf('the-informed-link'));
		expect(participantForLink('the-informed-link')).toEqual({ refused: 'unknown' });
		expect(participantForLink(tokenOf(link))).toMatchObject({ participant: { id: row.id, role: 'consulted' } });
		expect(sent.duringTransaction).toEqual([]);
	});

	it('sends nothing to one made informed, nor to one made consulted on a decision closed or past its closing time (2740-3)', async () => {
		const open = openOne();
		const cy = makePerson();
		const asked = makeParticipant(open, { person: cy, role: 'consulted', hadAccount: false });
		const closed = openOne({ status: 'closed', closedAt: '2026-11-02 09:00:00' });
		const lapsed = openOne({ closesAt: '2026-11-02 09:00:00' });
		const dee = makePerson();
		const eve = makePerson();
		const shut = makeParticipant(closed, { person: dee, role: 'informed', hadAccount: false });
		const passed = makeParticipant(lapsed, { person: eve, role: 'informed', hadAccount: false });
		const counts = [open, closed, lapsed].map((decision) => eventsOf(decision.id).length);

		set(open, [{ personId: cy.id, role: 'informed' }]);
		set(closed, [{ personId: dee.id, role: 'consulted' }]);
		set(lapsed, [{ personId: eve.id, role: 'consulted' }]);

		expect(since(open.id, counts[0])).toEqual([['role_changed', asked.id, { from: 'consulted', to: 'informed' }]]);
		expect(since(closed.id, counts[1])).toEqual([['role_changed', shut.id, { from: 'informed', to: 'consulted' }]]);
		expect(since(lapsed.id, counts[2])).toEqual([['role_changed', passed.id, { from: 'informed', to: 'consulted' }]]);
		expect(participantRow(shut.id).role).toBe('consulted');
		await sent.settle();
		expect(sent.emails).toEqual([]);
	});

	it('changes the role and holds the mail back where the rest, the daily cap or the caller holds it: mail_skipped with the reason, said in the delivery panel (2740-4)', async () => {
		const decision = openOne();
		const rested = informedHolder(decision, 'Rae Rested', 'rae@example.test');
		const capped = informedHolder(decision, 'Cap Ped', 'cap@example.test');
		// Five record mails in the last day, none in the last 10 minutes.
		for (let i = 0; i < RECORD_MAIL_DAILY_CAP; i++) mailedNow(decision.id, capped.row.id);
		ageRecordMail(decision.id, RECORD_MAIL_MIN_MINUTES + 1);
		mailedNow(decision.id, rested.row.id);
		const before = eventsOf(decision.id).length;

		set(decision, [
			{ personId: rested.person.id, role: 'consulted' },
			{ personId: capped.person.id, role: 'consulted' }
		]);

		expect(participantRow(rested.row.id).role).toBe('consulted');
		expect(participantRow(capped.row.id).role).toBe('consulted');
		expect(since(decision.id, before)).toEqual([
			['role_changed', rested.row.id, { from: 'informed', to: 'consulted' }],
			['mail_skipped', rested.row.id, { mail: 'invitation', reason: 'resting' }],
			['role_changed', capped.row.id, { from: 'informed', to: 'consulted' }],
			['mail_skipped', capped.row.id, { mail: 'invitation', reason: 'daily_cap' }]
		]);
		await sent.settle();
		expect(sent.emails).toEqual([]);
		expect(panelRow(decision.id, rested.row.id)).toMatchObject({
			lastSkip: { mail: 'invitation', words: HELD_WORDS.resting('Rae Rested') },
			resendable: false,
			resendFrom: expect.any(String)
		});
		expect(panelRow(decision.id, capped.row.id)).toMatchObject({ lastSkip: { mail: 'invitation', words: HELD_WORDS.daily_cap('Cap Ped') }, resendable: false });

		// The caller's own daily cap, spent: the role is changed, and the mail held as caller_cap.
		const other = openOne();
		const quin = informedHolder(other, 'Quin Quota', 'quin@example.test');
		takeAllowance(`decision-record-mail:${owner.id}`, CALLER_MAIL_DAILY_CAP, CALLER_MAIL_DAILY_CAP, DAY_MS);
		const at = eventsOf(other.id).length;
		set(other, [{ personId: quin.person.id, role: 'consulted' }]);
		expect(since(other.id, at)).toEqual([
			['role_changed', quin.row.id, { from: 'informed', to: 'consulted' }],
			['mail_skipped', quin.row.id, { mail: 'invitation', reason: 'caller_cap' }]
		]);
		expect(panelRow(other.id, quin.row.id).lastSkip).toMatchObject({ mail: 'invitation', words: HELD_WORDS.caller_cap('Quin Quota') });
		await sent.settle();
		expect(sent.emails).toEqual([]);
	});

	it("records one whom reachOf skips with its own reason, as every record mail does, and sends nothing (2740-5)", async () => {
		const decision = openOne();
		const { person, row } = informedHolder(decision, 'Mo Moved', 'mo@example.test');
		// Also resting (mailed a moment ago): reachOf is asked first, so the address is the reason, not the rest.
		const restless = informedHolder(decision, 'Ro Restless', 'ro@example.test');
		mailedNow(decision.id, restless.row.id);
		db.update(people).set({ email: 'mo-elsewhere@example.test' }).where(eq(people.id, person.id)).run();
		db.update(people).set({ email: 'ro-elsewhere@example.test' }).where(eq(people.id, restless.person.id)).run();
		const before = eventsOf(decision.id).length;

		set(decision, [
			{ personId: person.id, role: 'consulted' },
			{ personId: restless.person.id, role: 'consulted' }
		]);

		const written = since(decision.id, before);
		expect(written.filter(([kind]) => kind === 'role_changed')).toEqual([
			['role_changed', row.id, { from: 'informed', to: 'consulted' }],
			['role_changed', restless.row.id, { from: 'informed', to: 'consulted' }]
		]);
		expect(written.filter(([kind]) => kind === 'mail_skipped')).toEqual([
			['mail_skipped', row.id, { mail: 'invitation', reason: 'address_changed' }],
			['mail_skipped', restless.row.id, { mail: 'invitation', reason: 'address_changed' }]
		]);
		expect(written).toHaveLength(4);
		await sent.settle();
		expect(sent.emails).toEqual([]);
	});

	it("counts the write's own invitations toward the caller's cap before the asks: past it, each one made consulted is held as caller_cap and those included are invited (2740-7)", async () => {
		const decision = openOne();
		const asked = [informedHolder(decision, 'Ada Asked', 'ada@example.test'), informedHolder(decision, 'Bo Asked', 'bo@example.test')];
		const newcomers = [makePerson({ fullName: 'Nia New', email: 'nia@example.test' }), makePerson({ fullName: 'Ned New', email: 'ned@example.test' })];
		// The caller's capped mail of the last day, elsewhere: the cap less the two this write includes, so that those two fit
		// exactly and the two asks do not. Were the write's own invitations not counted (`pending` 0), the asks would fit too.
		const elsewhere = openOne();
		const hourAgo = stamp(new Date(Date.now() - 60 * 60 * 1000));
		const insert = sqlite.prepare(
			"INSERT INTO decision_events (decision_id, participant_id, kind, version_number, detail, actor_user_id, actor_name, source, created_at) VALUES (?, NULL, 'invited', NULL, NULL, ?, 'owner', 'ui', ?)"
		);
		sqlite.transaction(() => {
			for (let i = 0; i < CALLER_MAIL_DAILY_CAP - newcomers.length; i++) insert.run(elsewhere.id, owner.id, hourAgo);
		})();
		expect(asked.length).toBeLessThanOrEqual(newcomers.length);
		const before = eventsOf(decision.id).length;

		set(decision, [
			...asked.map(({ person }) => ({ personId: person.id, role: 'consulted' })),
			...newcomers.map((person) => ({ personId: person.id, role: 'informed' }))
		]);

		const written = since(decision.id, before);
		expect(asked.map(({ row }) => participantRow(row.id).role)).toEqual(['consulted', 'consulted']);
		expect(written.filter(([kind]) => kind === 'mail_skipped')).toEqual(asked.map(({ row }) => ['mail_skipped', row.id, { mail: 'invitation', reason: 'caller_cap' }]));
		const invitedIds = written.filter(([kind]) => kind === 'invited').map(([, participantId]) => participantId);
		expect(invitedIds).toHaveLength(newcomers.length);
		for (const { row } of asked) expect(invitedIds).not.toContain(row.id);
		await waitForOutcomes(decision.id, newcomers.length);
		expect(sent.emails.map((mail) => mail.to).sort()).toEqual(['ned@example.test', 'nia@example.test']);
	});

	it('drops the held line from the delivery panel once a later Resend sends the invitation (2740-8)', async () => {
		const decision = openOne();
		const rested = informedHolder(decision, 'Rae Rested', 'rae@example.test');
		mailedNow(decision.id, rested.row.id);
		set(decision, [{ personId: rested.person.id, role: 'consulted' }]);
		expect(panelRow(decision.id, rested.row.id).lastSkip).toMatchObject({ mail: 'invitation', words: HELD_WORDS.resting('Rae Rested') });

		// The rest over (the earlier mail aged past it; the skip stays where it was written), Resend sends the invitation.
		ageRecordMail(decision.id, RECORD_MAIL_MIN_MINUTES + 1);
		as(owner, (caller) => resendInvitation(caller, { decisionId: decision.id, participantId: rested.row.id }, null, UI));
		await waitForOutcomes(decision.id, 1);

		expect(sent.emails.map((mail) => [mail.to, mail.subject])).toEqual([['rae@example.test', `Your view is asked: ${decision.title}`]]);
		expect(panelRow(decision.id, rested.row.id)).toMatchObject({ lastMail: { mail: 'invitation', resend: true, outcome: 'sent' }, lastSkip: null });
	});

	// Card 2742: the told line words an invitation by the role it was sent for, replayed from the record, not by the role now.
	describe('card 2742: the told line describes the invitation as it was sent', () => {
		/** An invitation of the participant, written now, and its outcome saying it was delivered. */
		const invitedAndDelivered = (decisionId: number, participantId: number) => {
			const of = mailedNow(decisionId, participantId);
			appendEvent({ decisionId, kind: 'mail_outcome', participantId, detail: { of, mail: 'invitation', delivered: true } }, SYSTEM_ACTOR);
			return of;
		};
		const toldLine = (participantId: number) => {
			const row = participantRow(participantId);
			return toldWords(lastToldOf(row), row.includedAt);
		};

		it('says one invited while informed, then made consulted with the ask held back, was told to keep them informed, not asked (2742-1)', () => {
			const decision = openOne();
			const { person, row } = informedHolder(decision, 'Ivy Informed', 'ivy@example.test');
			invitedAndDelivered(decision.id, row.id);
			const before = eventsOf(decision.id).length;

			// Made consulted a moment after the invitation: the rest holds the asking invitation back, so the informed one stays the latest mail.
			set(decision, [{ personId: person.id, role: 'consulted' }]);

			expect(since(decision.id, before)).toEqual([
				['role_changed', row.id, { from: 'informed', to: 'consulted' }],
				['mail_skipped', row.id, { mail: 'invitation', reason: 'resting' }]
			]);
			expect(participantRow(row.id).role).toBe('consulted');
			expect(lastToldOf(participantRow(row.id))).toEqual({ kind: 'invited', at: expect.any(String), delivered: true, sentAs: 'informed' });
			expect(toldLine(row.id)).toMatch(/^You were told of this decision on .+, by email, to keep you informed\.$/);
		});

		it('says one invited while consulted, then made informed, was asked for their view (2742-2)', async () => {
			const decision = openOne();
			const person = makePerson({ fullName: 'Cal Consulted', email: 'cal@example.test', user: makeUser({ username: 'cal' }) });
			const row = makeParticipant(decision, { person, role: 'consulted', hadAccount: true });
			invitedAndDelivered(decision.id, row.id);
			const before = eventsOf(decision.id).length;

			set(decision, [{ personId: person.id, role: 'informed' }]);

			// One made informed is sent nothing, so the invitation that asked stays the latest mail.
			expect(since(decision.id, before)).toEqual([['role_changed', row.id, { from: 'consulted', to: 'informed' }]]);
			await sent.settle();
			expect(sent.emails).toEqual([]);
			expect(lastToldOf(participantRow(row.id))).toEqual({ kind: 'invited', at: expect.any(String), delivered: true, sentAs: 'consulted' });
			expect(toldLine(row.id)).toMatch(/^You were asked for your view on this decision on .+, by email\.$/);
		});

		it('replays a record with no inclusion event from the first role change, and claims no purpose where the record gives no role (2742-3)', () => {
			// (a) No `included` (the fixture writes none without `hadAccount`): the role before the change is its `from`.
			const decision = openOne();
			const person = makePerson({ fullName: 'Old Record', email: 'old@example.test', user: makeUser({ username: 'old' }) });
			const row = makeParticipant(decision, { person, role: 'informed' });
			invitedAndDelivered(decision.id, row.id);
			set(decision, [{ personId: person.id, role: 'consulted' }]);
			expect(lastToldOf(participantRow(row.id))).toMatchObject({ kind: 'invited', sentAs: 'informed' });
			expect(toldLine(row.id)).toMatch(/to keep you informed\.$/);

			// (b) An invitation after a removal with no re-inclusion: the record gives no role there, so neither purpose is claimed.
			const other = openOne();
			const odd = makeParticipant(other, { role: 'consulted', hadAccount: true });
			appendEvent({ decisionId: other.id, kind: 'removed', participantId: odd.id }, SYSTEM_ACTOR);
			invitedAndDelivered(other.id, odd.id);
			expect(lastToldOf(participantRow(odd.id))).toMatchObject({ kind: 'invited', sentAs: null });
			expect(toldLine(odd.id)).toMatch(/^You were told of this decision on .+, by email\.$/);

			// (c) The same participant re-included as informed after that invitation: the re-inclusion is later, so the role at it stays none.
			appendEvent({ decisionId: other.id, kind: 're_included', participantId: odd.id, detail: { role: 'informed', hadAccount: true } }, SYSTEM_ACTOR);
			expect(lastToldOf(participantRow(odd.id))).toMatchObject({ kind: 'invited', sentAs: null });
		});
	});
});

// ─── Card 2743: one added while the decision is closed for input is not asked for a view they cannot give ──

describe('card 2743: setParticipants on a decision closed or past its closing time asks no one added as consulted', () => {
	const set = (decision: Decision, participants: { personId: number; role: string }[]) =>
		as(owner, (caller) => setParticipants(caller, { decisionId: decision.id }, { participants, revision: revisionNow(decision.id) }, UI));
	const decisionWith = (row: { status?: string; closesAt?: string; closedAt?: string } = {}) =>
		makeDecision({ board, author: owner, decider: owner, status: 'open', closesAt: FUTURE, currentVersion: 1, openedAt: '2026-11-01 09:00:00', ...row });
	/** Closed early: closed before its closing time, which is still ahead. */
	const closedEarly = () => decisionWith({ status: 'closed', closedAt: '2026-11-02 09:00:00' });
	/** Stored open, its closing time past. */
	const lapsed = () => decisionWith({ closesAt: '2026-11-02 09:00:00' });
	const holder = (fullName: string, email: string) => makePerson({ fullName, email, user: makeUser({ username: email.split('@')[0] }) });
	const since = (decisionId: number, before: number) => eventsOf(decisionId).slice(before).map((event) => [event.kind, event.participantId, event.detail]);
	const panelRow = (decisionId: number, participantId: number) => readEditPage(owner, decisionId).delivery!.find((row) => row.participantId === participantId)!;
	const idOf = (decision: Decision, personId: number) => participantRows(decision.id).find((row) => row.personId === personId)!.id;

	it('includes an account holder and a link holder as consulted on a decision closed early, and sends neither anything: no mail, no link, no skip (2743-1)', async () => {
		const decision = closedEarly();
		const ada = holder('Ada Account', 'ada@example.test');
		const lee = makePerson({ fullName: 'Lee Link', email: 'lee@example.test' });
		const before = eventsOf(decision.id).length;

		set(decision, [
			{ personId: ada.id, role: 'consulted' },
			{ personId: lee.id, role: 'consulted' }
		]);

		const adaRow = idOf(decision, ada.id);
		const leeRow = idOf(decision, lee.id);
		expect(since(decision.id, before)).toEqual([
			['included', adaRow, { role: 'consulted', hadAccount: true }],
			['included', leeRow, { role: 'consulted', hadAccount: false }]
		]);
		expect(participantRow(leeRow)).toMatchObject({ role: 'consulted', linkTokenHash: null, linkIssuedAt: null });
		await sent.settle();
		expect(sent.emails).toEqual([]);
		// Card 2708's told line: included, which is true, never "asked".
		expect(toldWords(lastToldOf(participantRow(adaRow)), participantRow(adaRow).includedAt)).toMatch(/^You were included in this decision on /);
		// The delivery panel: not mailed yet, and Resend waits for a reopening (D4).
		expect(panelRow(decision.id, leeRow)).toMatchObject({ lastMail: null, lastSkip: null, resendable: false, refusal: CLOSED_ASK_WORDS('Lee Link') });
	});

	it('includes one as consulted on a decision stored open past its closing time and sends nothing (2743-2)', async () => {
		const decision = lapsed();
		const cy = makePerson({ fullName: 'Cy Lapsed', email: 'cy@example.test' });
		const before = eventsOf(decision.id).length;

		set(decision, [{ personId: cy.id, role: 'consulted' }]);

		expect(since(decision.id, before)).toEqual([['included', idOf(decision, cy.id), { role: 'consulted', hadAccount: false }]]);
		await sent.settle();
		expect(sent.emails).toEqual([]);
		expect(panelRow(decision.id, idOf(decision, cy.id))).toMatchObject({ resendable: false, refusal: CLOSED_ASK_WORDS('Cy Lapsed') });
	});

	it('brings back a removed participant as consulted on a closed decision without mail, so the rest does not hold them; as informed, invites them and the rest does (2743-3)', async () => {
		const decision = closedEarly();
		const rae = makePerson({ fullName: 'Rae Return', email: 'rae@example.test' });
		const raeRow = makeParticipant(decision, { person: rae, role: 'consulted', hadAccount: false, removedAt: '2026-11-02 10:00:00' });
		// Mailed a moment ago: were the write to mail them, decision 31 would refuse it.
		appendEvent({ decisionId: decision.id, kind: 'invited', participantId: raeRow.id }, SYSTEM_ACTOR);
		const before = eventsOf(decision.id).length;

		set(decision, [{ personId: rae.id, role: 'consulted' }]);

		expect(participantRow(raeRow.id).removedAt).toBeNull();
		expect(since(decision.id, before)).toEqual([['re_included', raeRow.id, { role: 'consulted', hadAccount: false }]]);
		await sent.settle();
		expect(sent.emails).toEqual([]);

		// Brought back as informed, on a second closed decision: the invitation is sent, and so the rest holds them first.
		const other = closedEarly();
		const ivy = makePerson({ fullName: 'Ivy Back', email: 'ivy@example.test' });
		const ivyRow = makeParticipant(other, { person: ivy, role: 'informed', hadAccount: false, removedAt: '2026-11-02 10:00:00' });
		appendEvent({ decisionId: other.id, kind: 'invited', participantId: ivyRow.id }, SYSTEM_ACTOR);
		expect(outcome(() => set(other, [{ personId: ivy.id, role: 'informed' }]))).toMatchObject({ status: 409 });
		expect(participantRow(ivyRow.id).removedAt).not.toBeNull();

		ageRecordMail(other.id);
		const at = eventsOf(other.id).length;
		set(other, [{ personId: ivy.id, role: 'informed' }]);
		expect(since(other.id, at)).toEqual([
			['re_included', ivyRow.id, { role: 'informed', hadAccount: false }],
			['link_issued', ivyRow.id, { replaced: false }],
			['invited', ivyRow.id, null]
		]);
		await waitForOutcomes(other.id, 1);
		expect(sent.emails.map((mail) => [mail.to, mail.subject])).toEqual([['ivy@example.test', `For your information: ${other.title}`]]);
	});

	it('still sends one added as informed to a closed decision their invitation, which asks nothing (2743-4)', async () => {
		const decision = closedEarly();
		const ina = holder('Ina Informed', 'ina@example.test');
		const before = eventsOf(decision.id).length;

		set(decision, [{ personId: ina.id, role: 'informed' }]);

		const inaRow = idOf(decision, ina.id);
		expect(since(decision.id, before)).toEqual([
			['included', inaRow, { role: 'informed', hadAccount: true }],
			['invited', inaRow, null]
		]);
		await waitForOutcomes(decision.id, 1);
		expect(sent.emails.map((mail) => [mail.to, mail.subject])).toEqual([['ina@example.test', `For your information: ${decision.title}`]]);
		expect(sent.emails[0].html).toContain('Nothing is asked of you');
		expect(sent.emails[0].html).not.toContain('Your view is asked by');
		expect(sent.duringTransaction).toEqual([]);
	});

	// Card 2743's code review: one included and not mailed now is mailed at the ruling or the withdrawal, which ask no cap, so the
	// caller's cap counts every inclusion; only the participant's own rest follows the mail (2743-3).
	it("counts one added as consulted to a closed decision against the caller's cap, as the ruling will mail them (2743-5)", async () => {
		const decision = closedEarly();
		// One record mail left in the caller's day, held in memory.
		expect(takeAllowance(`decision-record-mail:${owner.id}`, CALLER_MAIL_DAILY_CAP - 1, CALLER_MAIL_DAILY_CAP, DAY_MS)).toEqual({ taken: true });
		const cas = makePerson({ fullName: 'Cas Consulted' });
		const ian = makePerson({ fullName: 'Ian Informed' });

		expect(outcome(() => set(decision, [{ personId: cas.id, role: 'consulted' }]))).toBe('passed');
		// The one left was taken by the consulted addition, though it sent nothing.
		const before = eventsOf(decision.id).length;
		expect(
			outcome(() =>
				set(decision, [
					{ personId: cas.id, role: 'consulted' },
					{ personId: ian.id, role: 'informed' }
				])
			)
		).toMatchObject({ status: 429 });
		expect(eventsOf(decision.id)).toHaveLength(before);
		await sent.settle();
		expect(sent.emails).toEqual([]);
	});

	it("refuses, 429, including more people as consulted to a closed decision than the caller's cap allows, and writes nothing (2743-8)", async () => {
		const decision = closedEarly();
		const many = Array.from({ length: CALLER_MAIL_DAILY_CAP + 1 }, (_, i) => makePerson({ fullName: `Many ${i}` }));
		const before = eventsOf(decision.id).length;

		expect(outcome(() => set(decision, many.map((person) => ({ personId: person.id, role: 'consulted' }))))).toMatchObject({ status: 429 });
		expect(eventsOf(decision.id)).toHaveLength(before);
		expect(participantRows(decision.id)).toEqual([]);
		await sent.settle();
		expect(sent.emails).toEqual([]);
	});

	it('refuses Resend, 409, to one consulted on a decision stored open past its closing time, and writes nothing (2743-9)', async () => {
		const decision = lapsed();
		const col = holder('Col Lapsed', 'col@example.test');
		const colRow = makeParticipant(decision, { person: col, role: 'consulted', hadAccount: true });
		const before = eventsOf(decision.id).length;

		expect(outcome(() => as(owner, (caller) => resendInvitation(caller, { decisionId: decision.id, participantId: colRow.id }, null, UI)))).toEqual({
			status: 409,
			message: CLOSED_ASK_WORDS('Col Lapsed')
		});
		expect(eventsOf(decision.id)).toHaveLength(before);
		await sent.settle();
		expect(sent.emails).toEqual([]);
	});

	it('decides who a save mails by the one rule the picker shares, read at the shown status (2743-10)', () => {
		expect(openForInput('open')).toBe(true);
		expect(openForInput('awaiting_ruling')).toBe(false);
		expect(mailedOnSave('included', 'consulted', 'open')).toBe(true);
		expect(mailedOnSave('included', 'informed', 'open')).toBe(true);
		expect(mailedOnSave('included', 'consulted', 'awaiting_ruling')).toBe(false);
		expect(mailedOnSave('included', 'informed', 'awaiting_ruling')).toBe(true);
		expect(mailedOnSave('role_changed', 'consulted', 'open')).toBe(true);
		expect(mailedOnSave('role_changed', 'informed', 'open')).toBe(false);
		expect(mailedOnSave('role_changed', 'consulted', 'awaiting_ruling')).toBe(false);
		expect(mailedOnSave('role_changed', 'informed', 'awaiting_ruling')).toBe(false);
	});

	it('refuses Resend to one consulted while the decision is not open, as the panel says; sends an informed one theirs; and once an Extend reopens it, asks them there and offers Resend after their rest (2743-6, card 2744)', async () => {
		const decision = closedEarly();
		const cal = holder('Cal Consulted', 'cal@example.test');
		const ike = holder('Ike Informed', 'ike@example.test');
		const calRow = makeParticipant(decision, { person: cal, role: 'consulted', hadAccount: true });
		const ikeRow = makeParticipant(decision, { person: ike, role: 'informed', hadAccount: true });
		const resendTo = (participantId: number) => as(owner, (caller) => resendInvitation(caller, { decisionId: decision.id, participantId }, null, UI));
		const before = eventsOf(decision.id).length;

		expect(outcome(() => resendTo(calRow.id))).toEqual({ status: 409, message: CLOSED_ASK_WORDS('Cal Consulted') });
		expect(eventsOf(decision.id)).toHaveLength(before);
		expect(panelRow(decision.id, calRow.id)).toMatchObject({ resendable: false, resendFrom: null, refusal: CLOSED_ASK_WORDS('Cal Consulted') });

		expect(panelRow(decision.id, ikeRow.id)).toMatchObject({ resendable: true, refusal: null });
		resendTo(ikeRow.id);
		await waitForOutcomes(decision.id, 1);
		expect(sent.emails.map((mail) => [mail.to, mail.subject])).toEqual([['ike@example.test', `For your information: ${decision.title}`]]);

		// Reopened: card 2744 asks them at the Extend, so Resend then waits for their rest.
		sent.clear();
		const later = stamp(new Date(Date.now() + 120 * 24 * 60 * 60 * 1000));
		as(owner, (caller) => extendDecision(caller, { decisionId: decision.id }, { closesAt: `${later.replace(' ', 'T')}Z` }, UI));
		await waitForOutcomes(decision.id, 2);
		expect(sent.emails.map((mail) => [mail.to, mail.subject])).toEqual([['cal@example.test', `Your view is asked: ${decision.title}`]]);
		expect(panelRow(decision.id, calRow.id)).toMatchObject({ resendable: false, refusal: expect.stringContaining('less than 10 minutes ago') });
		// The rest over, Resend is offered again.
		ageRecordMail(decision.id, RECORD_MAIL_MIN_MINUTES + 1);
		expect(panelRow(decision.id, calRow.id)).toMatchObject({ resendable: true, refusal: null });
	});
});

// ─── Opening (cases 34 to 46) ────────────────────────────────────────────────

/** A draft that opens, on `board` (`tests/helpers/decision-faults.ts`, moved there by card 2676). */
const readyDraft = (title = 'Ready') => readyDraftOn({ board }, title);

// Card 2697 (Q1): opening sends the revision, as the page holds it.
const open = (user: SessionUser, decision: Decision, opts: ServiceOptions = UI) =>
	as(user, (caller) => openDecision(caller, { decisionId: decision.id }, { revision: revisionNow(decision.id) }, opts));

describe('openDecision', () => {
	it('publishes version 1, retakes the snapshots, records each step, invites each participant and tells the board (34)', async () => {
		const ready = readyDraft('Budget & <Q3>');
		db.update(people).set({ jobTitle: 'New title' }).where(eq(people.id, ready.holderPerson.id)).run();
		// F3: the board's own stream, which is handed the payload as emitted, boardId and all.
		const onBoard: { event: string; data: unknown }[] = [];
		const unsubscribe = subscribe(board.id, (event, data) => onBoard.push({ event, data }));
		const reads = readBudget(100_000);

		let opened: Decision;
		try {
			opened = open(ready.author, ready.draft);
		} finally {
			reads.restore();
			unsubscribe();
		}
		// F1: the decision's account history is read once for the open, not once more for each link issued.
		expect(reads.sources.filter((source) => /from "decision_events" where .*"participant_id" is not null/.test(source))).toHaveLength(1);

		const row = decisionRow(ready.draft.id);
		expect(row).toMatchObject({ status: 'open', currentVersion: 1 });
		expect(row.openedAt).not.toBeNull();
		expect(opened).toEqual(row);
		const versions = sqlite.prepare('SELECT * FROM decision_versions WHERE decision_id = ?').all(row.id) as any[];
		expect(versions).toHaveLength(1);
		expect(versions[0]).toMatchObject({ number: 1, asks_again: 1, change_note: null, published_by: ready.author.id, published_by_name: 'author' });
		expect(JSON.parse(versions[0].content)).toEqual({
			...ready.working,
			options: [
				{ ...ready.working.options[0], optionId: ready.lean.id, label: 'A' },
				{ ...ready.working.options[1], optionId: ready.full.id, label: 'B' }
			]
		});
		expect(db.select().from(decisionOptions).where(eq(decisionOptions.decisionId, row.id)).all().map((o) => o.addedInVersion)).toEqual([1, 1]);
		expect(participantRow(ready.holder.id)).toMatchObject({ jobTitle: 'New title', includedAt: row.openedAt });
		expect(participantRow(ready.linked.id).includedAt).toBe(row.openedAt);

		const events = eventsOf(row.id);
		expect(events.map((event) => [event.kind, event.participantId])).toEqual([
			['published', null],
			['opened', null],
			['included', ready.holder.id],
			['included', ready.linked.id],
			['invited', ready.holder.id],
			['link_issued', ready.linked.id],
			['invited', ready.linked.id]
		]);
		expect(events[0]).toMatchObject({ versionNumber: 1, detail: { asksAgain: true, changeNote: null }, actorName: 'author', source: 'ui' });
		expect(events[1].detail).toEqual({ closesAt: FUTURE });
		expect(events[2].detail).toEqual({ role: 'consulted', hadAccount: true });
		expect(events[3].detail).toEqual({ role: 'informed', hadAccount: false });

		await waitForOutcomes(row.id, 2);
		const toHolder = sent.emails.find((mail) => mail.to === ready.holderPerson.email)!;
		const toLinky = sent.emails.find((mail) => mail.to === 'linky@example.test')!;
		expect(toHolder.subject).toBe('Your view is asked: Budget & <Q3>');
		expect(toLinky.subject).toBe('For your information: Budget & <Q3>');
		expect(toHolder.html).toContain(`href="${APP}/decisions/${row.id}"`);
		expect(linkIn(toHolder.html)).toBeNull();
		const link = linkIn(toLinky.html)!;
		expect(participantRow(ready.linked.id).linkTokenHash).toBe(linkHashOf(tokenOf(link)));
		expect(participantRow(ready.holder.id).linkTokenHash).toBeNull();
		for (const mail of [toHolder, toLinky]) {
			expect(mail.html).toContain('Budget &amp; &lt;Q3&gt;');
			expect(mail.html).not.toContain('<Q3>');
		}

		expect(activityRows()).toEqual([{ boardId: board.id, cardId: null, action: 'decision_opened', detail: '"Budget & <Q3>"', userId: ready.author.id }]);
		expect(sent.events).toEqual([expect.objectContaining({ event: 'decision', boardId: board.id, data: { decisionId: row.id, status: 'open' } })]);
		expect(onBoard).toEqual([{ event: 'decision', data: { decisionId: row.id, status: 'open', boardId: board.id } }]);
		expect(sent.duringTransaction).toEqual([]);
	});

	/**
	 * Each refusal of decision 20: what makes the draft refuse, and the words; the table is
	 * `OPEN_FAULTS` in tests/helpers/decision-faults.ts, shared with card 2676's drift guard,
	 * which added (j) and (k).
	 */
	it.each(OPEN_FAULTS)('refuses, 409 with nothing written or sent: %s (35-43)', async (_case, make, words) => {
		const ready = readyDraft();
		make(ready);
		const env = { ORIGIN: process.env.ORIGIN, APP_URL: process.env.APP_URL };
		delete process.env.ORIGIN;
		delete process.env.APP_URL;
		const participantsBefore = participantRows(ready.draft.id);
		const optionsBefore = db.select().from(decisionOptions).all();
		try {
			expect(outcome(() => open(ready.author, ready.draft, { source: 'ui', baseUrl: 'http://evil.example' }))).toEqual({
				status: 409,
				message: words
			});
		} finally {
			for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
		}
		expect(decisionRow(ready.draft.id)).toMatchObject({ status: 'draft', currentVersion: 0, openedAt: null });
		expect(participantRows(ready.draft.id)).toEqual(participantsBefore);
		expect(db.select().from(decisionOptions).all()).toEqual(optionsBefore);
		expect(count('decision_events')).toBe(0);
		expect(count('decision_versions')).toBe(0);
		expect(activityRows()).toEqual([]);
		await sent.settle();
		expect(sent.all).toEqual([]);
	});

	it('records each delivery after the commit, one mail at a time, and keeps the token out of every log (44)', async () => {
		const ready = readyDraft();
		const outcomesWhenAsked: number[] = [];
		/**
		 * The link as a mail server's reply might quote it (S1): as sent, URL-encoded, as HTML entities, in capitals,
		 * split across two reply lines inside the token, and split inside the path; and the recipient's address (S7).
		 */
		const quoted = (link: string, to: string) => {
			const token = tokenOf(link);
			return [
				`listed URL ${link}`,
				`encoded ${link.replace(/\//g, '%2F').replace('%2Fdecision', '%2fdecision')}`,
				`entities ${link.replace(/\//g, '&#x2F;').replace('&#x2F;decision', '&#47;decision')}`,
				`capitals ${APP}/DECISION-LINK/${token}`,
				`split ${APP}/decision-link/${token.slice(0, 8)}\r\n250-${token.slice(8)}`,
				`path split ${APP}/decision-\r\n250-link/${token}`,
				`to <${to}>`
			].join(' | ');
		};
		refusal = (mail) => {
			outcomesWhenAsked.push(outcomesOf(ready.draft.id).length);
			const link = linkIn(mail.html);
			return link === null ? undefined : refused('EMESSAGE', `Message failed: 554 5.7.1 rejected, ${quoted(link, mail.to)}`, { responseCode: 554, command: 'DATA' });
		};
		const quiet = (['log', 'info', 'warn', 'error'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
		try {
			open(ready.author, ready.draft);
			await waitForOutcomes(ready.draft.id, 2);
		} finally {
			for (const spy of quiet) spy.mockRestore();
		}

		// One at a time: the second mail was offered only once the first's outcome was written.
		expect(outcomesWhenAsked).toEqual([0, 1]);
		const mails = eventsOf(ready.draft.id).filter((event) => event.kind === 'invited');
		const outcomes = outcomesOf(ready.draft.id);
		expect(outcomes).toEqual([
			expect.objectContaining({ participantId: ready.holder.id, detail: { of: mails[0].id, mail: 'invitation', delivered: true }, actorName: 'DumpFire', source: 'system' }),
			expect.objectContaining({
				participantId: ready.linked.id,
				detail: { of: mails[1].id, mail: 'invitation', delivered: false, problem: 'refused' },
				actorName: 'DumpFire',
				source: 'system'
			})
		]);

		const token = tokenOf(linkIn(sent.refusedMail[0].html)!);
		const path = `${APP}/decision-link/[token]`;
		const recipient = `participant ${ready.linked.id} of decision ${ready.draft.id}`;
		const masked =
			`Message failed: 554 5.7.1 rejected, listed URL ${path} | encoded ${path} | entities ${path} | capitals ${path} | ` +
			`split ${path}\r\n[token] | path split ${APP}/decision-\r\n250-link/[token] | to <[${recipient}]>`;
		const errors = sqlite.prepare("SELECT message, meta FROM system_logs WHERE level = 'ERROR'").all() as { message: string; meta: string }[];
		expect(errors).toHaveLength(1);
		expect(JSON.parse(errors[0].meta).detail).toBe(masked);
		expect(mailStatus().lastFailure!.detail).toBe(masked);
		// S7: the line names the participant and the decision, never the address.
		expect(errors[0].message).toBe(`Failed to send email to ${recipient}: For your information: Ready`);
		expect(`${errors[0].message} ${errors[0].meta}`).not.toContain('linky@example.test');
		const everywhere = [
			...(sqlite.prepare('SELECT detail FROM decision_events').all() as { detail: string | null }[]).map((row) => row.detail ?? ''),
			...(sqlite.prepare('SELECT detail FROM activity_log').all() as { detail: string }[]).map((row) => row.detail),
			...(sqlite.prepare('SELECT message, meta FROM system_logs').all() as { message: string; meta: string | null }[]).map((row) => `${row.message} ${row.meta ?? ''}`)
		].join('\n');
		expect(everywhere).not.toContain(token);
		expect(everywhere).not.toContain(token.slice(8));
		expect(everywhere).not.toContain('linky@example.test');
		expect(sent.duringTransaction).toEqual([]);
	});

	it('invites an account holder whose every preference is off, the master switch included (45)', async () => {
		const ready = readyDraft();
		db.update(users)
			.set({ notificationPrefs: JSON.stringify({ email_all: false, email_assigned: false, email_comments: false, email_mentions: false }) })
			.where(eq(users.id, ready.holderAccount.id))
			.run();

		open(ready.author, ready.draft);
		await waitForOutcomes(ready.draft.id, 2);

		expect(sent.emails.map((mail) => mail.to).sort()).toEqual([ready.holderPerson.email, 'linky@example.test'].sort());
		expect(sent.duringTransaction).toEqual([]);
	});
});

// ─── Who a record-bearing mail goes to (case 46) ─────────────────────────────

describe('reachOf, through queueRecordMails', () => {
	it('mails the account holder still linked and the link holder at their address, and skips each other with its reason (46)', async () => {
		const decision = makeDecision({ board, author: owner, decider: owner, status: 'open', closesAt: FUTURE, currentVersion: 1 });
		const account = (name: string) => makeUser({ username: name });

		// (1) An account holder still linked to that account.
		const a = account('a');
		const p1 = makeParticipant(decision, { person: makePerson({ fullName: 'One', user: a }), hadAccount: true });
		// (2) A link holder whose person has no account and the same address.
		const p2 = makeParticipant(decision, { person: makePerson({ fullName: 'Two', email: 'two@example.test' }), hadAccount: false });
		// (3) The person deleted.
		const deleted = makePerson({ fullName: 'Three' });
		const p3 = makeParticipant(decision, { person: deleted, hadAccount: false });
		db.delete(people).where(eq(people.id, deleted.id)).run();
		// (4) The person left, with an account.
		const b = account('b');
		const p4 = makeParticipant(decision, { person: makePerson({ fullName: 'Four', user: b, status: 'left' }), hadAccount: true });
		// (5) The row's account, the person since unlinked.
		const c = account('c');
		const p5 = makeParticipant(decision, { person: makePerson({ fullName: 'Five' }), userId: c.id, hadAccount: true });
		// (6) No account on the row, the person since linked.
		const d = account('d');
		const p6 = makeParticipant(decision, { person: makePerson({ fullName: 'Six', user: d }), userId: null, hadAccount: false });
		// (7) No account on the row, but it had one on this decision.
		const p7 = makeParticipant(decision, { person: makePerson({ fullName: 'Seven' }), hadAccount: true });
		// (8) The directory address changed since the snapshot.
		const eight = makePerson({ fullName: 'Eight', email: 'eight@example.test' });
		const p8 = makeParticipant(decision, { person: eight, hadAccount: false });
		db.update(people).set({ email: 'eight.new@example.test' }).where(eq(people.id, eight.id)).run();
		// (9) An account holder still linked, the directory address changed since the snapshot: on the account route too (S2).
		const nine = makePerson({ fullName: 'Nine', user: account('e') });
		const p9 = makeParticipant(decision, { person: nine, hadAccount: true });
		db.update(people).set({ email: 'nine.new@example.test' }).where(eq(people.id, nine.id)).run();
		const before = eventsOf(decision.id).length;

		as(owner, () => queueRecordMails(decisionRow(decision.id), 'told_of_change', { by: actorFor(owner, 'ui'), changeNote: 'The dates moved.' }));

		const events = eventsOf(decision.id).slice(before);
		expect(events.map((event) => [event.kind, event.participantId, event.detail])).toEqual([
			['told_of_change', p1.id, null],
			['link_issued', p2.id, { replaced: false }],
			['told_of_change', p2.id, null],
			['mail_skipped', p3.id, { mail: 'told_of_change', reason: 'deleted' }],
			['mail_skipped', p4.id, { mail: 'told_of_change', reason: 'left' }],
			['mail_skipped', p5.id, { mail: 'told_of_change', reason: 'account_not_attached' }],
			['mail_skipped', p6.id, { mail: 'told_of_change', reason: 'account_not_attached' }],
			['mail_skipped', p7.id, { mail: 'told_of_change', reason: 'account_removed' }],
			['mail_skipped', p8.id, { mail: 'told_of_change', reason: 'address_changed' }],
			['mail_skipped', p9.id, { mail: 'told_of_change', reason: 'address_changed' }]
		]);
		expect(events.filter((event) => event.kind === 'told_of_change').every((event) => event.versionNumber === 1)).toBe(true);
		for (const p of [p3, p4, p5, p6, p7, p8, p9]) expect(participantRow(p.id).linkTokenHash).toBeNull();

		await waitForOutcomes(decision.id, 2);
		expect(sent.emails.map((mail) => mail.to)).toEqual([p1.email, 'two@example.test']);
		expect(sent.emails.every((mail) => mail.subject === `Changed: ${decision.title}`)).toBe(true);
		expect(sent.emails[0].html).toContain(`${APP}/decisions/${decision.id}`);
		expect(sent.emails[0].html).toContain('The dates moved.');
		expect(linkIn(sent.emails[0].html)).toBeNull();
		expect(participantRow(p2.id).linkTokenHash).toBe(linkHashOf(tokenOf(linkIn(sent.emails[1].html)!)));
		expect(sent.duringTransaction).toEqual([]);
	});
});

// ─── Slice 2b: after opening (cases 48 to 73) ────────────────────────────────

/**
 * A draft from `readyDraft`, opened by its author, its invitations delivered
 * and recorded, then aged past the throttle and forgotten by `sent`.
 */
async function openedDecision(title = 'Ready', age = true) {
	const ready = readyDraft(title);
	open(ready.author, ready.draft);
	await waitForOutcomes(ready.draft.id, 2);
	if (age) ageRecordMail(ready.draft.id);
	sent.clear();
	return { ...ready, id: ready.draft.id };
}

/** An open decision made by hand, version 1, on `board` unless told otherwise, by `owner`. */
const openByHand = (row: Partial<Parameters<typeof makeDecision>[0]> = {}) =>
	makeDecision({ board, author: owner, decider: owner, status: 'open', closesAt: FUTURE, currentVersion: 1, openedAt: '2026-11-01 09:00:00', ...row });

// Card 2697 (Q1): re-publishing sends the revision, as the page holds it.
const republish = (user: SessionUser, id: number, body: Record<string, unknown>) =>
	as(user, (caller) => republishDecision(caller, { decisionId: id }, { ...body, revision: revisionNow(id) }, UI));
const resend = (user: SessionUser, id: number, participantId: number) =>
	as(user, (caller) => resendInvitation(caller, { decisionId: id, participantId }, null, UI));
const withdraw = (user: SessionUser, id: number, reason = 'No longer needed.') => as(user, (caller) => withdrawDecision(caller, { decisionId: id }, { reason }, UI));
const remove = (user: SessionUser, id: number) => as(user, (caller) => deleteDecision(caller, { decisionId: id }, null, UI));
// Card 2726: an opened decision is withdrawn or deleted only with the caller's password held, as its route holds it.
const withdrawHeld = (user: SessionUser, id: number, reason?: string) => holdingPassword(user, () => withdraw(user, id, reason));
const removeHeld = (user: SessionUser, id: number) => holdingPassword(user, () => remove(user, id));
const setAccount = (user: SessionUser, id: number, participantId: number, account: string) =>
	as(user, (caller) => setParticipantAccount(caller, { decisionId: id, participantId }, { account }, UI));
// Card 2697 (Q22): "Use the directory's address" sends no address; the write copies the directory's.
const setAddress = (user: SessionUser, id: number, participantId: number) =>
	as(user, (caller) => changeParticipantAddress(caller, { decisionId: id, participantId }, null, UI));
const versionsOf = (id: number) => sqlite.prepare('SELECT * FROM decision_versions WHERE decision_id = ? ORDER BY number').all(id) as any[];

/** Run `body` with neither an App URL saved nor `ORIGIN` or `APP_URL` set, and put them back. */
async function withNoLinkAddress(body: () => Promise<void> | void) {
	db.delete(settings).where(eq(settings.key, 'app_url')).run();
	const env = { ORIGIN: process.env.ORIGIN, APP_URL: process.env.APP_URL };
	delete process.env.ORIGIN;
	delete process.env.APP_URL;
	try {
		await body();
	} finally {
		for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
	}
}

describe('republishDecision', () => {
	it('asks everyone again: version 2, asked_again for the consulted holder, told_of_change with a fresh link for the informed link holder (card 2739), decision_republished and a live event (48)', async () => {
		const r = await openedDecision();
		const oldHash = participantRow(r.linked.id).linkTokenHash;
		const before = eventsOf(r.id).length;

		const row = republish(r.author, r.id, { changeNote: 'The dates moved.', askAgain: true });

		expect(row).toMatchObject({ status: 'open', currentVersion: 2 });
		expect(versionsOf(r.id).map((v) => [v.number, v.asks_again, v.change_note])).toEqual([
			[1, 1, null],
			[2, 1, 'The dates moved.']
		]);
		expect(eventsOf(r.id).slice(before).map((event) => [event.kind, event.participantId, event.versionNumber, event.detail])).toEqual([
			['published', null, 2, { asksAgain: true, changeNote: 'The dates moved.' }],
			['asked_again', r.holder.id, 2, null],
			['link_issued', r.linked.id, null, { replaced: true }],
			['told_of_change', r.linked.id, 2, null]
		]);
		await waitForOutcomes(r.id, 4);
		expect(sent.emails.map((mail) => [mail.to, mail.subject])).toEqual([
			[r.holderPerson.email, 'Changed, and your view is asked again: Ready'],
			['linky@example.test', 'Changed: Ready']
		]);
		const newHash = participantRow(r.linked.id).linkTokenHash;
		expect(newHash).not.toBe(oldHash);
		expect(newHash).toBe(linkHashOf(tokenOf(linkIn(sent.emails[1].html)!)));
		expect(activityRows().at(-1)).toEqual({ boardId: board.id, cardId: null, action: 'decision_republished', detail: '"Ready": version 2, everyone asked again', userId: r.author.id });
		expect(sent.events).toEqual([expect.objectContaining({ event: 'decision', boardId: board.id, data: { decisionId: r.id, status: 'open' } })]);
		expect(sent.duringTransaction).toEqual([]);
	});

	it('opens a closed decision again when it asks again (49)', async () => {
		const r = await openedDecision();
		as(r.author, (caller) => closeDecision(caller, { decisionId: r.id }, null, UI));
		expect(decisionRow(r.id).closedAt).not.toBeNull();

		republish(r.author, r.id, { changeNote: 'Reopened for views.', askAgain: true });

		expect(decisionRow(r.id)).toMatchObject({ status: 'open', closedAt: null, currentVersion: 2 });
	});

	it('tells only: version 2 without asks_again, and told_of_change mails carrying the change note (50)', async () => {
		const r = await openedDecision();
		const before = eventsOf(r.id).length;

		republish(r.author, r.id, { changeNote: 'A typo fixed.', askAgain: false });

		expect(versionsOf(r.id).map((v) => [v.number, v.asks_again, v.change_note])).toEqual([
			[1, 1, null],
			[2, 0, 'A typo fixed.']
		]);
		expect(
			eventsOf(r.id)
				.slice(before)
				.filter((event) => event.kind === 'told_of_change')
				.map((event) => event.participantId)
		).toEqual([r.holder.id, r.linked.id]);
		await waitForOutcomes(r.id, 4);
		expect(sent.emails).toHaveLength(2);
		for (const mail of sent.emails) {
			expect(mail.subject).toBe('Changed: Ready');
			expect(mail.html).toContain('A typo fixed.');
		}
		expect(activityRows().at(-1)?.detail).toBe('"Ready": version 2, told of a change');
		expect(sent.duringTransaction).toEqual([]);
	});

	it('refuses telling only when an option was added, and when a published one was dropped, 409 with nothing written (51)', async () => {
		const r = await openedDecision();
		const tell = () => outcome(() => republish(r.author, r.id, { changeNote: 'Only telling.', askAgain: false }));
		const words = { status: 409, message: 'Telling of a change cannot add or retire an option: publish a change to the options by asking everyone again' };
		const before = eventsOf(r.id).length;

		const added = makeOption(decisionRow(r.id), { label: 'C' });
		expect(tell()).toEqual(words);
		db.delete(decisionOptions).where(eq(decisionOptions.id, added.id)).run();

		db.update(decisions)
			.set({ workingContent: JSON.stringify({ ...r.working, options: [r.working.options[0]] }) })
			.where(eq(decisions.id, r.id))
			.run();
		expect(tell()).toEqual(words);

		expect(decisionRow(r.id).currentVersion).toBe(1);
		expect(versionsOf(r.id)).toHaveLength(1);
		expect(eventsOf(r.id)).toHaveLength(before);
		expect(db.select().from(decisionOptions).where(eq(decisionOptions.decisionId, r.id)).all().map((o) => [o.addedInVersion, o.retiredInVersion])).toEqual([
			[1, null],
			[1, null]
		]);
		await sent.settle();
		expect(sent.emails).toEqual([]);
	});

	it('retires a published option dropped from the working content and adds a new one, asking again (52)', async () => {
		const r = await openedDecision();
		const added = makeOption(decisionRow(r.id), { label: 'C' });
		const working = { ...r.working, options: [r.working.options[0], { optionId: added.id, title: 'Middle', summary: '', pros: [], cons: [], commercial: '' }] };
		db.update(decisions).set({ workingContent: JSON.stringify(working) }).where(eq(decisions.id, r.id)).run();

		republish(r.author, r.id, { changeNote: 'Full is out, Middle is in.', askAgain: true });

		const option = (id: number) => db.select().from(decisionOptions).where(eq(decisionOptions.id, id)).get()!;
		expect(option(r.lean.id)).toMatchObject({ addedInVersion: 1, retiredInVersion: null });
		expect(option(r.full.id)).toMatchObject({ addedInVersion: 1, retiredInVersion: 2 });
		expect(option(added.id)).toMatchObject({ addedInVersion: 2, retiredInVersion: null });
		const listed = JSON.parse(versionsOf(r.id)[1].content).options.map((o: { optionId: number; label: string; title: string }) => [o.optionId, o.label, o.title]);
		expect(listed).toEqual([
			[r.lean.id, 'A', 'Lean'],
			[added.id, 'C', 'Middle']
		]);
		expect(liveOptionIds(r.id, 2)).toEqual([r.lean.id, added.id]);
		expect(liveOptionIds(r.id, 1)).toEqual([r.lean.id, r.full.id]);

		// F4: one that would leave a single live option is refused, 409, as opening is (decision 20), before the throttle is asked.
		db.update(decisions).set({ workingContent: JSON.stringify({ ...working, options: [working.options[0]] }) }).where(eq(decisions.id, r.id)).run();
		expect(outcome(() => republish(r.author, r.id, { changeNote: 'Only Lean.', askAgain: true }))).toEqual({
			status: 409,
			message: 'This decision would have fewer than two options: it cannot be re-published'
		});
		expect(versionsOf(r.id)).toHaveLength(2);
		expect(option(added.id).retiredInVersion).toBeNull();
	});

	it('refuses re-publishing once closes_at has passed, 409 (53)', async () => {
		const r = await openedDecision();
		db.update(decisions).set({ closesAt: '2020-01-01 00:00:00' }).where(eq(decisions.id, r.id)).run();

		expect(outcome(() => republish(r.author, r.id, { changeNote: 'Late.', askAgain: true }))).toEqual({
			status: 409,
			message: "This decision's closing time has passed: it cannot be re-published until it is extended"
		});
		expect(versionsOf(r.id)).toHaveLength(1);
	});
});

describe('closeDecision and extendDecision', () => {
	it('closes an open decision: closed, closed_at, the closed event, decision_closed and a live event, and no mail (54)', async () => {
		const r = await openedDecision();
		const before = eventsOf(r.id).length;

		const row = as(r.author, (caller) => closeDecision(caller, { decisionId: r.id }, null, UI));

		expect(row.status).toBe('closed');
		expect(row.closedAt).not.toBeNull();
		expect(eventsOf(r.id).slice(before)).toEqual([expect.objectContaining({ kind: 'closed', participantId: null, detail: null, actorName: 'author' })]);
		expect(activityRows().at(-1)).toEqual({ boardId: board.id, cardId: null, action: 'decision_closed', detail: '"Ready"', userId: r.author.id });
		await sent.settle();
		expect(sent.events).toEqual([expect.objectContaining({ event: 'decision', boardId: board.id, data: { decisionId: r.id, status: 'awaiting_ruling' } })]);
		expect(sent.emails).toEqual([]);
		expect(sent.duringTransaction).toEqual([]);
	});

	it('extends a closed decision by its decider: open, closes_at moved, extended { from, to }, decision_extended and a live event (55)', async () => {
		const r = await openedDecision();
		as(r.author, (caller) => closeDecision(caller, { decisionId: r.id }, null, UI));
		sent.clear();
		const before = eventsOf(r.id).length;

		// Card 2697 (Q25): a new closing time is at most a year ahead; card 2682 (D30): and later than the current one,
		// `FUTURE`, 90 days ahead, so 120 days ahead is sent.
		const soon = stamp(new Date(Date.now() + 120 * 24 * 60 * 60 * 1000));
		const row = as(r.decider, (caller) => extendDecision(caller, { decisionId: r.id }, { closesAt: `${soon.replace(' ', 'T')}Z` }, UI));

		expect(row).toMatchObject({ status: 'open', closesAt: soon, closedAt: null });
		expect(eventsOf(r.id).slice(before)).toEqual([expect.objectContaining({ kind: 'extended', detail: { from: FUTURE, to: soon }, actorName: 'decider' })]);
		expect(activityRows().at(-1)).toEqual({
			boardId: board.id,
			cardId: null,
			action: 'decision_extended',
			detail: `"Ready": closes ${soon.slice(0, 16)} UTC`,
			userId: r.decider.id
		});
		await sent.settle();
		expect(sent.events).toEqual([expect.objectContaining({ event: 'decision', data: { decisionId: r.id, status: 'open' } })]);
		expect(sent.emails).toEqual([]);
	});

	it('refuses extending to a moment already past, 400 (56)', async () => {
		const r = await openedDecision();

		expect(outcome(() => as(r.decider, (caller) => extendDecision(caller, { decisionId: r.id }, { closesAt: '2020-01-01T00:00:00Z' }, UI)))).toEqual({
			status: 400,
			message: 'closesAt must be in the future'
		});
		expect(decisionRow(r.id)).toMatchObject({ status: 'open', closesAt: FUTURE });
	});
});

// ─── Card 2744: a reopening asks whom the round never reached ────────────────

describe('card 2744: an Extend or a re-publish that reopens a decision asks whom the round never reached', () => {
	const closeIt = (user: SessionUser, id: number) => as(user, (caller) => closeDecision(caller, { decisionId: id }, null, UI));
	/** Extend to 120 days ahead, later than `FUTURE` (90 days). */
	const extendIt = (user: SessionUser, id: number) => {
		const later = stamp(new Date(Date.now() + 120 * DAY_MS));
		return as(user, (caller) => extendDecision(caller, { decisionId: id }, { closesAt: `${later.replace(' ', 'T')}Z` }, UI));
	};
	const set = (user: SessionUser, id: number, participants: { personId: number; role: string }[]) =>
		as(user, (caller) => setParticipants(caller, { decisionId: id }, { participants, revision: revisionNow(id) }, UI));
	const since = (id: number, before: number) => eventsOf(id).slice(before).map((event) => [event.kind, event.participantId, event.detail]);
	const panelRow = (user: SessionUser, id: number, participantId: number) => readEditPage(user, id).delivery!.find((row) => row.participantId === participantId)!;
	const rowOf = (id: number, personId: number) => participantRows(id).find((row) => row.personId === personId)!;
	const byTo = (a: string[], b: string[]) => a[0].localeCompare(b[0]);

	it('sends one made consulted while the decision was closed the invitation at the Extend, through the normal path; the one asked while it was open is sent nothing (2744-1)', async () => {
		const r = await openedDecision();
		closeIt(r.author, r.id);
		set(r.author, r.id, [
			{ personId: r.holderPerson.id, role: 'consulted' },
			{ personId: r.linkPerson.id, role: 'consulted' }
		]);
		await sent.settle();
		expect(sent.emails).toEqual([]);
		const before = eventsOf(r.id).length;

		const row = extendIt(r.decider, r.id);

		expect(row).toMatchObject({ status: 'open', closedAt: null });
		expect(since(r.id, before)).toEqual([
			['extended', null, { from: FUTURE, to: row.closesAt }],
			['link_issued', r.linked.id, { replaced: true }],
			['invited', r.linked.id, null]
		]);
		await waitForOutcomes(r.id, 3);
		expect(sent.emails.map((mail) => [mail.to, mail.subject])).toEqual([['linky@example.test', 'Your view is asked: Ready']]);
		expect(sent.emails[0].html).not.toContain('Nothing is asked of you');
		const link = linkIn(sent.emails[0].html)!;
		expect(participantForLink(tokenOf(link))).toMatchObject({ participant: { id: r.linked.id, role: 'consulted' } });
		expect(sent.duringTransaction).toEqual([]);
	});

	it('asks one included as consulted while closed, and one whose invitation the mail server refused, at the Extend (2744-2)', async () => {
		// The holder's opening invitation is refused: the round never reached them.
		refusal = (mail) => (mail.to === 'linky@example.test' ? undefined : refused('EENVELOPE', 'No such mailbox', { responseCode: 550 }));
		const r = await openedDecision();
		refusal = () => undefined;
		closeIt(r.author, r.id);
		const nia = makePerson({ fullName: 'Nia New', email: 'nia@example.test' });
		set(r.author, r.id, [
			{ personId: r.holderPerson.id, role: 'consulted' },
			{ personId: r.linkPerson.id, role: 'informed' },
			{ personId: nia.id, role: 'consulted' }
		]);
		await sent.settle();
		expect(sent.emails).toEqual([]);
		const niaRow = rowOf(r.id, nia.id);
		const before = eventsOf(r.id).length;

		extendIt(r.decider, r.id);

		expect(
			eventsOf(r.id)
				.slice(before)
				.filter((event) => event.kind === 'invited')
				.map((event) => event.participantId)
		).toEqual([r.holder.id, niaRow.id]);
		await waitForOutcomes(r.id, 4);
		expect(sent.emails.map((mail) => [mail.to, mail.subject]).sort(byTo)).toEqual(
			[
				[r.holderPerson.email, 'Your view is asked: Ready'],
				['nia@example.test', 'Your view is asked: Ready']
			].sort(byTo)
		);
	});

	it("reopens all the same where the participant's rest or the caller's cap holds the ask: mail_skipped with the reason, in the panel's words (2744-3)", async () => {
		const r = await openedDecision();
		closeIt(r.author, r.id);
		set(r.author, r.id, [
			{ personId: r.holderPerson.id, role: 'consulted' },
			{ personId: r.linkPerson.id, role: 'consulted' }
		]);
		// Mailed a moment ago: their rest holds the ask.
		appendEvent({ decisionId: r.id, kind: 'invited', participantId: r.linked.id }, SYSTEM_ACTOR);
		const before = eventsOf(r.id).length;

		expect(extendIt(r.decider, r.id)).toMatchObject({ status: 'open', closedAt: null });

		expect(since(r.id, before).slice(1)).toEqual([['mail_skipped', r.linked.id, { mail: 'invitation', reason: 'resting' }]]);
		expect(panelRow(r.author, r.id, r.linked.id).lastSkip).toMatchObject({ mail: 'invitation', words: HELD_WORDS.resting('Linky') });
		await sent.settle();
		expect(sent.emails).toEqual([]);

		// The caller's daily cap spent: the Extend is taken, and the ask held as caller_cap.
		const other = openByHand({ status: 'closed', closedAt: '2026-11-02 09:00:00' });
		const quin = makePerson({ fullName: 'Quin Quota', email: 'quin@example.test', user: makeUser({ username: 'quin' }) });
		const quinRow = makeParticipant(other, { person: quin, role: 'consulted', hadAccount: true });
		takeAllowance(`decision-record-mail:${owner.id}`, CALLER_MAIL_DAILY_CAP, CALLER_MAIL_DAILY_CAP, DAY_MS);
		const at = eventsOf(other.id).length;

		expect(extendIt(owner, other.id)).toMatchObject({ status: 'open', closedAt: null });

		expect(since(other.id, at).slice(1)).toEqual([['mail_skipped', quinRow.id, { mail: 'invitation', reason: 'caller_cap' }]]);
		expect(panelRow(owner, other.id, quinRow.id).lastSkip).toMatchObject({ mail: 'invitation', words: HELD_WORDS.caller_cap('Quin Quota') });
		await sent.settle();
		expect(sent.emails).toEqual([]);
	});

	it('sends nothing at an Extend of a decision open for input; asks one included after it lapsed at an Extend of a decision past its closing time (2744-4)', async () => {
		const open = openByHand();
		const hal = makePerson({ fullName: 'Hal Held', email: 'hal@example.test', user: makeUser({ username: 'hal' }) });
		// Consulted, and never reached (no asking mail on the record), but the decision is open for input: Resend asks them.
		makeParticipant(open, { person: hal, role: 'consulted', hadAccount: true });
		const before = eventsOf(open.id).length;
		extendIt(owner, open.id);
		expect(kindsOf(open.id).slice(before)).toEqual(['extended']);

		const lapsed = openByHand({ closesAt: '2026-11-02 09:00:00' });
		const cy = makePerson({ fullName: 'Cy Lapsed', email: 'cy@example.test' });
		set(owner, lapsed.id, [{ personId: cy.id, role: 'consulted' }]);
		const cyRow = rowOf(lapsed.id, cy.id);
		const at = eventsOf(lapsed.id).length;

		extendIt(owner, lapsed.id);

		expect(since(lapsed.id, at).map(([kind, participantId]) => [kind, participantId])).toEqual([
			['extended', null],
			['link_issued', cyRow.id],
			['invited', cyRow.id]
		]);
		await waitForOutcomes(lapsed.id, 1);
		expect(sent.emails.map((mail) => [mail.to, mail.subject])).toEqual([['cy@example.test', `Your view is asked: ${lapsed.title}`]]);
	});

	it('re-publishing to ask again on a closed decision sends one made consulted while it was closed the invitation, and the one asked before asked_again (2744-5)', async () => {
		const r = await openedDecision();
		closeIt(r.author, r.id);
		set(r.author, r.id, [
			{ personId: r.holderPerson.id, role: 'consulted' },
			{ personId: r.linkPerson.id, role: 'consulted' }
		]);
		const before = eventsOf(r.id).length;

		republish(r.author, r.id, { changeNote: 'Reopened for views.', askAgain: true });

		expect(decisionRow(r.id)).toMatchObject({ status: 'open', closedAt: null, currentVersion: 2 });
		expect(since(r.id, before)).toEqual([
			['published', null, { asksAgain: true, changeNote: 'Reopened for views.' }],
			['link_issued', r.linked.id, { replaced: true }],
			['invited', r.linked.id, null],
			['asked_again', r.holder.id, null]
		]);
		await waitForOutcomes(r.id, 4);
		expect(sent.emails.map((mail) => [mail.to, mail.subject]).sort(byTo)).toEqual(
			[
				['linky@example.test', 'Your view is asked: Ready'],
				[r.holderPerson.email, 'Changed, and your view is asked again: Ready']
			].sort(byTo)
		);
	});

	it('re-publishing to tell only on a closed decision sends one made consulted while it was closed nothing, and does not hold the write to their rest (2744-6)', async () => {
		const r = await openedDecision();
		closeIt(r.author, r.id);
		const nia = makePerson({ fullName: 'Nia New', email: 'nia@example.test' });
		set(r.author, r.id, [
			{ personId: r.holderPerson.id, role: 'consulted' },
			{ personId: r.linkPerson.id, role: 'informed' },
			{ personId: nia.id, role: 'consulted' }
		]);
		const niaRow = rowOf(r.id, nia.id);
		// Mailed a moment ago: were the re-publish to mail them, decision 31 would refuse it whole. Its outcome is written,
		// so it is not in flight, which would hold even a tell-only re-publish (card 2739's code review, 2026-11-05).
		const of = appendEvent({ decisionId: r.id, kind: 'invited', participantId: niaRow.id }, SYSTEM_ACTOR);
		appendEvent({ decisionId: r.id, kind: 'mail_outcome', participantId: niaRow.id, detail: { of, mail: 'invitation', delivered: false, problem: 'refused' } }, SYSTEM_ACTOR);
		const before = eventsOf(r.id).length;

		republish(r.author, r.id, { changeNote: 'A typo fixed.', askAgain: false });

		expect(decisionRow(r.id)).toMatchObject({ status: 'closed', currentVersion: 2 });
		const written = since(r.id, before);
		expect(written.filter(([kind]) => kind === 'told_of_change').map(([, participantId]) => participantId)).toEqual([r.holder.id, r.linked.id]);
		expect(written.filter(([, participantId]) => participantId === niaRow.id)).toEqual([]);
		// The opening's two, Nia's set by hand above, and the two told_of_change.
		await waitForOutcomes(r.id, 5);
		expect(sent.emails.map((mail) => [mail.to, mail.subject]).sort(byTo)).toEqual(
			[
				[r.holderPerson.email, 'Changed: Ready'],
				['linky@example.test', 'Changed: Ready']
			].sort(byTo)
		);
	});

	it('re-publishing to ask again on a decision open for input sends one the round never reached the invitation, and the informed one told_of_change (2744-10, as card 2739 changed it)', async () => {
		// The holder's opening invitation is refused: the round never reached them, and the decision stays open for input.
		refusal = (mail) => (mail.to === 'linky@example.test' ? undefined : refused('EENVELOPE', 'No such mailbox', { responseCode: 550 }));
		const r = await openedDecision();
		refusal = () => undefined;
		const before = eventsOf(r.id).length;

		republish(r.author, r.id, { changeNote: 'Asked again.', askAgain: true });

		const mailing = eventsOf(r.id)
			.slice(before)
			.filter((event) => event.kind === 'invited' || event.kind === 'asked_again' || event.kind === 'told_of_change')
			.map((event) => [event.kind, event.participantId]);
		expect(mailing).toEqual([
			['invited', r.holder.id],
			['told_of_change', r.linked.id]
		]);
		await waitForOutcomes(r.id, 4);
		expect(sent.emails.map((mail) => [mail.to, mail.subject]).sort(byTo)).toEqual(
			[
				[r.holderPerson.email, 'Your view is asked: Ready'],
				['linky@example.test', 'Changed: Ready']
			].sort(byTo)
		);
	});
});

// ─── Card 2739: a re-publish sends each participant words true of them ───────

describe('card 2739: a re-publish asks again only the consulted it reached, tells the informed, and invites or skips whom the round never reached', () => {
	const closeIt = (user: SessionUser, id: number) => as(user, (caller) => closeDecision(caller, { decisionId: id }, null, UI));
	const mailsSince = (id: number, before: number) =>
		eventsOf(id)
			.slice(before)
			.filter((event) => ['invited', 'asked_again', 'told_of_change'].includes(event.kind))
			.map((event) => [event.kind, event.participantId, event.versionNumber]);
	const panelRow = (user: SessionUser, id: number, participantId: number) => readEditPage(user, id).delivery!.find((row) => row.participantId === participantId)!;
	const mailTo = (to: string) => sent.emails.find((mail) => mail.to === to)!;
	/** The holder's opening invitation refused: the round never reached them; the informed link holder's delivered. */
	const refuseHolder = () => (mail: OfferedMail) => (mail.to === 'linky@example.test' ? undefined : refused('EENVELOPE', 'No such mailbox', { responseCode: 550 }));

	it('asking again on a decision open for input asks the reached consulted holder again and tells the informed one of the change, in words that ask nothing; the panel and the told line say so (2739-1)', async () => {
		const r = await openedDecision();
		const before = eventsOf(r.id).length;

		republish(r.author, r.id, { changeNote: 'The dates moved.', askAgain: true });

		expect(mailsSince(r.id, before)).toEqual([
			['asked_again', r.holder.id, 2],
			['told_of_change', r.linked.id, 2]
		]);
		await waitForOutcomes(r.id, 4);
		const told = mailTo('linky@example.test');
		expect(told.subject).toBe('Changed: Ready');
		expect(told.html).toContain('The dates moved.');
		expect(told.html).not.toContain('Your view is asked');
		expect(told.html).not.toContain('asked again');
		expect(mailTo(r.holderPerson.email).subject).toBe('Changed, and your view is asked again: Ready');
		expect(panelRow(r.author, r.id, r.linked.id).lastMail).toMatchObject({ mail: 'told_of_change', outcome: 'sent' });
		expect(panelRow(r.author, r.id, r.holder.id).lastMail).toMatchObject({ mail: 'asked_again', outcome: 'sent' });
		expect(toldWords(lastToldOf(participantRow(r.linked.id)), participantRow(r.linked.id).includedAt)).toMatch(/^You were told of a change to this decision on .+, by email\.$/);
	});

	it('asking again on a closed decision reopens it and tells the informed one of the change, never asked_again (2739-2)', async () => {
		const r = await openedDecision();
		closeIt(r.author, r.id);
		const before = eventsOf(r.id).length;

		republish(r.author, r.id, { changeNote: 'Reopened for views.', askAgain: true });

		expect(decisionRow(r.id)).toMatchObject({ status: 'open', closedAt: null, currentVersion: 2 });
		expect(mailsSince(r.id, before)).toEqual([
			['asked_again', r.holder.id, 2],
			['told_of_change', r.linked.id, 2]
		]);
		await waitForOutcomes(r.id, 4);
		expect(mailTo('linky@example.test').subject).toBe('Changed: Ready');
	});

	it('telling only on a decision open for input is held by the rest of one the round never reached whose invitation is still in flight: 409, nothing written (2739-3, as the code review of 2026-11-05 changed it)', async () => {
		refusal = refuseHolder();
		const r = await openedDecision();
		refusal = () => undefined;
		// An invitation queued a moment ago, its outcome not yet written: a new version would overtake the version it quotes.
		appendEvent({ decisionId: r.id, kind: 'invited', participantId: r.holder.id }, SYSTEM_ACTOR);
		const before = eventsOf(r.id).length;

		const held = outcome(() => republish(r.author, r.id, { changeNote: 'A typo fixed.', askAgain: false }));

		expect(held).toMatchObject({ status: 409, message: expect.stringMatching(/was mailed about this decision less than 10 minutes ago/) });
		expect(eventsOf(r.id)).toHaveLength(before);
		expect(decisionRow(r.id)).toMatchObject({ status: 'open', currentVersion: 1 });
		await sent.settle();
		expect(sent.emails).toEqual([]);
	});

	it('telling only on a decision open for input sends one the round never reached nothing, and does not hold the write to their rest once their invitation has its outcome; the informed one is told (2739-6)', async () => {
		refusal = refuseHolder();
		const r = await openedDecision();
		refusal = () => undefined;
		// The holder's refused invitation went out a moment ago: were the re-publish to mail them, decision 31 would refuse it whole.
		const before = eventsOf(r.id).length;

		republish(r.author, r.id, { changeNote: 'A typo fixed.', askAgain: false });

		expect(decisionRow(r.id)).toMatchObject({ status: 'open', currentVersion: 2 });
		expect(mailsSince(r.id, before)).toEqual([['told_of_change', r.linked.id, 2]]);
		expect(
			eventsOf(r.id)
				.slice(before)
				.filter((event) => event.participantId === r.holder.id)
		).toEqual([]);
		// The opening's two, and the informed one's told_of_change.
		await waitForOutcomes(r.id, 3);
		expect(sent.emails.map((mail) => [mail.to, mail.subject])).toEqual([['linky@example.test', 'Changed: Ready']]);
	});

	it("the caller's daily cap counts the informed one's told_of_change and the unreached one's invitation: one short, 429 and nothing written (2739-4)", async () => {
		refusal = refuseHolder();
		const r = await openedDecision();
		refusal = () => undefined;
		// One mail left of the caller's allowance; the re-publish would send two (an invitation and a told_of_change).
		resetAllRateLimits();
		takeAllowance(`decision-record-mail:${r.author.id}`, CALLER_MAIL_DAILY_CAP - 1, CALLER_MAIL_DAILY_CAP, DAY_MS);
		const before = eventsOf(r.id).length;

		const refusedWith = outcome(() => republish(r.author, r.id, { changeNote: 'Asked again.', askAgain: true }));

		expect(refusedWith).toMatchObject({ status: 429, message: expect.stringContaining(`past ${CALLER_MAIL_DAILY_CAP} in the last 24 hours`) });
		expect(eventsOf(r.id)).toHaveLength(before);
		expect(decisionRow(r.id).currentVersion).toBe(1);
		await sent.settle();
		expect(sent.emails).toEqual([]);
	});
});

describe('withdrawDecision', () => {
	it('withdraws an open decision, tells everyone with the reason on links that still work, and keeps the reason out of activity (57)', async () => {
		const r = await openedDecision();
		const before = eventsOf(r.id).length;

		const row = await withdrawHeld(r.author, r.id, 'The budget was cut.');

		expect(row).toMatchObject({ status: 'withdrawn', withdrawnReason: 'The budget was cut.' });
		expect(row.withdrawnAt).not.toBeNull();
		expect(eventsOf(r.id).slice(before).map((event) => [event.kind, event.participantId, event.detail])).toEqual([
			['withdrawn', null, { reason: 'The budget was cut.' }],
			['told_withdrawn', r.holder.id, null],
			['link_issued', r.linked.id, { replaced: true }],
			['told_withdrawn', r.linked.id, null]
		]);
		await waitForOutcomes(r.id, 4);
		expect(sent.emails.map((mail) => mail.subject)).toEqual(['Withdrawn: Ready', 'Withdrawn: Ready']);
		for (const mail of sent.emails) expect(mail.html).toContain('The budget was cut.');
		const resolved = participantForLink(tokenOf(linkIn(sent.emails[1].html)!));
		expect(resolved).toMatchObject({ participant: { id: r.linked.id }, decision: { id: r.id, status: 'withdrawn' } });
		const entry = activityRows().at(-1)!;
		expect(entry).toEqual({ boardId: board.id, cardId: null, action: 'decision_withdrawn', detail: '"Ready"', userId: r.author.id });
		expect(sent.events).toEqual([expect.objectContaining({ event: 'decision', boardId: board.id, data: { decisionId: r.id, status: 'withdrawn' } })]);
		expect(sent.duringTransaction).toEqual([]);

		// A second, opened, whose board is gone: no activity entry and no live event.
		const boardless = openByHand({ board: null });
		makeParticipant(boardless, { person: makePerson(), hadAccount: false });
		const entries = activityRows().length;
		sent.clear();
		await withdrawHeld(owner, boardless.id);
		await waitForOutcomes(boardless.id, 1);
		expect(activityRows()).toHaveLength(entries);
		expect(sent.events).toEqual([]);
	});

	it('withdraws a draft: the withdrawn event, and no mail, activity entry or live event (58)', async () => {
		const draft = makeDecision({ board, author: owner, decider: owner, closesAt: FUTURE });
		makeParticipant(draft, { person: makePerson() });

		withdraw(owner, draft.id);

		expect(decisionRow(draft.id).status).toBe('withdrawn');
		expect(kindsOf(draft.id)).toEqual(['withdrawn']);
		await sent.settle();
		expect(sent.all).toEqual([]);
		expect(activityRows()).toEqual([]);
	});

	it('refuses an opened decision 400 STEP_UP_MISSING without the password held, whatever calls it: nothing written or mailed (card 2726)', async () => {
		const opened = openByHand();
		makeParticipant(opened, { person: makePerson(), hadAccount: false });
		const before = kindsOf(opened.id);

		expect(refusalOf(() => withdraw(owner, opened.id))).toEqual({ status: 400, body: { message: STEP_UP_MISSING, stepUp: 'missing' } });

		expect(decisionRow(opened.id)).toMatchObject({ status: 'open', withdrawnAt: null });
		expect(kindsOf(opened.id)).toEqual(before);
		await sent.settle();
		expect(sent.all).toEqual([]);
		expect(activityRows()).toEqual([]);
	});
});

describe('deleteDecision', () => {
	it('deletes a draft with its participants and options, with no activity entry or live event (59)', async () => {
		const draft = makeDecision({ board, author: owner, decider: owner });
		makeOption(draft);
		makeOption(draft);
		makeParticipant(draft, { person: makePerson() });
		makeParticipant(draft, { person: makePerson() });

		remove(owner, draft.id);

		for (const table of ['decisions', 'decision_options', 'decision_participants', 'decision_events']) expect(count(table)).toBe(0);
		await sent.settle();
		expect(sent.all).toEqual([]);
		expect(activityRows()).toEqual([]);
	});

	it('deletes a withdrawn decision that was opened through the NO ACTION keys; and an outcome left with nowhere to go, and a mail not sent as its decision is gone, are WARN lines (60)', async () => {
		const r = await openedDecision();
		sqlite
			.prepare("INSERT INTO decision_responses (decision_id, participant_id, version_number, round, kind, via) VALUES (?, ?, 1, 1, 'no_concerns', 'link')")
			.run(r.id, r.linked.id);
		await withdrawHeld(r.author, r.id);
		await waitForOutcomes(r.id, 4);
		sent.clear();

		await removeHeld(r.author, r.id);

		for (const table of ['decisions', 'decision_options', 'decision_participants', 'decision_versions', 'decision_responses', 'decision_events']) {
			expect(count(table)).toBe(0);
		}
		expect(activityRows().at(-1)).toEqual({ boardId: board.id, cardId: null, action: 'decision_deleted', detail: '"Ready"', userId: r.author.id });
		await sent.settle();
		expect(sent.events).toEqual([expect.objectContaining({ event: 'decision', boardId: board.id, data: { decisionId: r.id, status: 'withdrawn' } })]);

		// A second is deleted while its told_withdrawn batch is out.
		const second = openByHand();
		makeParticipant(second, { person: makePerson({ email: 'first@example.test' }), hadAccount: false });
		makeParticipant(second, { person: makePerson({ email: 'second@example.test' }), hadAccount: false });
		let mailEvents: number[] = [];
		// The delete's promise is kept, marked handled at once and awaited once the assertions are made: a refusal
		// fails this case there, rather than escaping as an unhandled rejection (card 2726's code review).
		let removed: Promise<unknown> | undefined;
		refusal = () => {
			if (mailEvents.length === 0) {
				mailEvents = eventsOf(second.id)
					.filter((event) => event.kind === 'told_withdrawn')
					.map((event) => event.id);
				removed = removeHeld(owner, second.id);
				removed.catch(() => {});
			}
			return undefined;
		};
		const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'WARN';
		try {
			await withdrawHeld(owner, second.id);
			await vi.waitFor(() => expect(sqlite.prepare("SELECT COUNT(*) AS n FROM system_logs WHERE level = 'WARN'").get()).toEqual({ n: 2 }));
		} finally {
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
			quiet.mockRestore();
		}
		// F2: the mail out when it went is recorded as lost; the next, asked again before its send, is not sent.
		expect(sent.emails.map((mail) => mail.to)).toEqual(['first@example.test']);
		const warnings = sqlite.prepare("SELECT message, meta FROM system_logs WHERE level = 'WARN' ORDER BY id").all() as { message: string; meta: string }[];
		expect(warnings.map((w) => [w.message, JSON.parse(w.meta)])).toEqual([
			[`Decision ${second.id}: the outcome of mail event ${mailEvents[0]} could not be recorded`, { decisionId: second.id, eventId: mailEvents[0] }],
			[`Decision ${second.id}: mail event ${mailEvents[1]} was not sent, as the decision is gone`, { decisionId: second.id, eventId: mailEvents[1] }]
		]);
		expect(warnings.map((w) => `${w.message} ${w.meta}`).join('\n')).not.toMatch(/example\.test/);
		expect(count('decisions')).toBe(0);
		expect(removed).toBeDefined();
		await removed;
	});

	it('refuses deleting a ruled decision, 409, with nothing removed (61)', () => {
		const ruled = openByHand({ status: 'ruled', ruledAt: '2026-11-02 09:00:00' });

		expect(outcome(() => remove(owner, ruled.id))).toEqual({ status: 409, message: 'This decision is ruled: it cannot be deleted' });
		expect(decisionRow(ruled.id)).toBeDefined();
	});

	it('refuses a withdrawn decision that was opened 400 STEP_UP_MISSING without the password held, whatever calls it: nothing removed (card 2726)', () => {
		const withdrawn = openByHand({ status: 'withdrawn' });

		expect(refusalOf(() => remove(owner, withdrawn.id))).toEqual({ status: 400, body: { message: STEP_UP_MISSING, stepUp: 'missing' } });

		expect(decisionRow(withdrawn.id)).toMatchObject({ status: 'withdrawn' });
		expect(activityRows()).toEqual([]);
	});
});

describe('resendInvitation', () => {
	it('sends a link holder a new link at the snapshot address, and at the new one once an administrator changes it (62)', async () => {
		const r = await openedDecision();
		const oldHash = participantRow(r.linked.id).linkTokenHash;
		const before = eventsOf(r.id).length;

		resend(r.author, r.id, r.linked.id);

		expect(eventsOf(r.id).slice(before).map((event) => [event.kind, event.participantId, event.detail])).toEqual([
			['link_issued', r.linked.id, { replaced: true }],
			['invited', r.linked.id, { resend: true }]
		]);
		await waitForOutcomes(r.id, 3);
		expect(sent.emails.map((mail) => mail.to)).toEqual(['linky@example.test']);
		const hash = participantRow(r.linked.id).linkTokenHash;
		expect(hash).not.toBe(oldHash);
		expect(hash).toBe(linkHashOf(tokenOf(linkIn(sent.emails[0].html)!)));

		// The directory address changes, and an administrator moves the snapshot to it.
		db.update(people).set({ email: 'linky.new@example.test' }).where(eq(people.id, r.linkPerson.id)).run();
		setAddress(makeUser({ role: 'admin' }), r.id, r.linked.id);
		ageRecordMail(r.id);
		sent.clear();
		resend(r.author, r.id, r.linked.id);
		await waitForOutcomes(r.id, 4);
		expect(sent.emails.map((mail) => mail.to)).toEqual(['linky.new@example.test']);
		expect(participantRow(r.linked.id).linkTokenHash).toBe(linkHashOf(tokenOf(linkIn(sent.emails[0].html)!)));
		expect(sent.duringTransaction).toEqual([]);
	});

	it("sends an account holder the decision's page, and issues no link (63)", async () => {
		const r = await openedDecision();
		const before = eventsOf(r.id).length;

		resend(r.author, r.id, r.holder.id);

		expect(eventsOf(r.id).slice(before).map((event) => [event.kind, event.participantId, event.detail])).toEqual([['invited', r.holder.id, { resend: true }]]);
		await waitForOutcomes(r.id, 3);
		expect(sent.emails.map((mail) => mail.to)).toEqual([r.holderPerson.email]);
		expect(sent.emails[0].html).toContain(`href="${APP}/decisions/${r.id}"`);
		expect(linkIn(sent.emails[0].html)).toBeNull();
		expect(participantRow(r.holder.id).linkTokenHash).toBeNull();
	});

	it('refuses a removed participant and one of each skip reason, 409 in its words, with nothing written or sent (64)', async () => {
		const decision = openByHand();
		const removed = makeParticipant(decision, { person: makePerson({ fullName: 'Gone Off' }), hadAccount: false, removedAt: '2026-11-01 10:00:00' });
		const deletedPerson = makePerson({ fullName: 'Deleted' });
		const deleted = makeParticipant(decision, { person: deletedPerson, hadAccount: false });
		db.delete(people).where(eq(people.id, deletedPerson.id)).run();
		const left = makeParticipant(decision, { person: makePerson({ fullName: 'Lefty', user: makeUser(), status: 'left' }), hadAccount: true });
		const unlinked = makeParticipant(decision, { person: makePerson({ fullName: 'Unlinked' }), userId: makeUser().id, hadAccount: true });
		const removedAccount = makeParticipant(decision, { person: makePerson({ fullName: 'Removed Account' }), hadAccount: true });
		const movedPerson = makePerson({ fullName: 'Moved', email: 'moved@example.test' });
		const moved = makeParticipant(decision, { person: movedPerson, hadAccount: false });
		db.update(people).set({ email: 'moved.new@example.test' }).where(eq(people.id, movedPerson.id)).run();
		const before = eventsOf(decision.id).length;

		const refusalsOf: [number, string][] = [
			[removed.id, 'Gone Off has been removed from this decision: they cannot be mailed about it'],
			[deleted.id, 'Deleted is no longer in the people directory: they cannot be mailed about this decision'],
			[left.id, 'Lefty has left: they cannot be mailed about this decision'],
			[
				unlinked.id,
				"Unlinked's account on this decision is not the one the people directory holds for them: an administrator attaches it before they can be mailed"
			],
			[removedAccount.id, "Removed Account's account on this decision has been deleted: an administrator clears it before they can be mailed a personal link"],
			[moved.id, "Moved's address on this decision is not the one the people directory holds for them: an administrator changes it before they can be mailed"]
		];
		for (const [participantId, message] of refusalsOf) {
			expect(outcome(() => resend(owner, decision.id, participantId))).toEqual({ status: 409, message });
		}
		expect(eventsOf(decision.id)).toHaveLength(before);
		for (const [participantId] of refusalsOf) expect(participantRow(participantId).linkTokenHash).toBeNull();
		await sent.settle();
		expect(sent.all).toEqual([]);
	});
});

describe("the administrator's participant actions", () => {
	let admin: SessionUser;
	beforeEach(() => {
		admin = makeUser({ role: 'admin' });
	});

	it("attaches the person's account: user_id set, the link ended, link_revoked { account_attached } and account_attached (65)", () => {
		const decision = openByHand();
		const person = makePerson({ fullName: 'Late Joiner' });
		const row = makeParticipant(decision, { person, token: 'a-live-token', hadAccount: false });
		const account = makeUser();
		db.update(people).set({ userId: account.id }).where(eq(people.id, person.id)).run();
		const before = eventsOf(decision.id).length;

		const after = setAccount(admin, decision.id, row.id, 'person');

		expect(after).toMatchObject({ userId: account.id, linkTokenHash: null, linkIssuedAt: null });
		expect(eventsOf(decision.id).slice(before).map((event) => [event.kind, event.participantId, event.detail])).toEqual([
			['link_revoked', row.id, { reason: 'account_attached' }],
			['account_attached', row.id, { userId: account.id }]
		]);
	});

	it('refuses attaching for a person with no account, 409 (66)', () => {
		const decision = openByHand();
		const row = makeParticipant(decision, { person: makePerson({ fullName: 'No Account' }), hadAccount: false });
		const before = eventsOf(decision.id).length;

		expect(outcome(() => setAccount(admin, decision.id, row.id, 'person'))).toEqual({
			status: 409,
			message: 'No Account has no account in the people directory: there is no account to attach'
		});
		expect(eventsOf(decision.id)).toHaveLength(before);
	});

	it("clears the row's account: user_id null and account_cleared { userId }; again, 409 with nothing to clear (67)", () => {
		const decision = openByHand();
		const account = makeUser();
		const row = makeParticipant(decision, { person: makePerson({ fullName: 'Holding', user: account }), hadAccount: true });
		const before = eventsOf(decision.id).length;

		expect(setAccount(admin, decision.id, row.id, 'none').userId).toBeNull();
		expect(eventsOf(decision.id).slice(before).map((event) => [event.kind, event.participantId, event.detail])).toEqual([
			['account_cleared', row.id, { userId: account.id }]
		]);

		expect(outcome(() => setAccount(admin, decision.id, row.id, 'none'))).toEqual({
			status: 409,
			message: 'Holding holds no account on this decision: there is nothing to clear'
		});
		expect(eventsOf(decision.id)).toHaveLength(before + 1);
	});

	it("changes the address to the directory's, lower-cased, ends the link, writes address_changed { from, to }, and sends nothing (68)", async () => {
		const decision = openByHand();
		const person = makePerson({ email: 'old@example.test' });
		const row = makeParticipant(decision, { person, token: 'a-live-token', hadAccount: false });
		const before = eventsOf(decision.id).length;
		// Card 2697 (Q22): the directory's address moves first; the write copies it.
		db.update(people).set({ email: 'New.Address@Example.Test' }).where(eq(people.id, person.id)).run();

		const after = setAddress(admin, decision.id, row.id);

		expect(after).toMatchObject({ email: 'new.address@example.test', linkTokenHash: null, linkIssuedAt: null });
		expect(eventsOf(decision.id).slice(before).map((event) => [event.kind, event.participantId, event.detail])).toEqual([
			['link_revoked', row.id, { reason: 'participant_address' }],
			['address_changed', row.id, { from: 'old@example.test', to: 'new.address@example.test' }]
		]);
		await sent.settle();
		expect(sent.all).toEqual([]);
	});
});

describe('the ruling mail', () => {
	it('tells every reachable participant the option, the reason and the conditions, and no figure; told_ruling; a fresh link (69)', async () => {
		const r = await openedDecision();
		const before = eventsOf(r.id).length;
		const ruling = { optionLabel: 'A', optionTitle: 'Lean', reason: 'It is what we can afford.', conditions: 'Looked at again in March.' };

		as(owner, () => queueRecordMails(decisionRow(r.id), 'ruling', { by: actorFor(r.decider, 'ui'), ruling }));

		expect(eventsOf(r.id).slice(before).map((event) => [event.kind, event.participantId, event.detail])).toEqual([
			['told_ruling', r.holder.id, null],
			['link_issued', r.linked.id, { replaced: true }],
			['told_ruling', r.linked.id, null]
		]);
		await waitForOutcomes(r.id, 4);
		expect(sent.emails.map((mail) => [mail.to, mail.subject])).toEqual([
			[r.holderPerson.email, 'Ruled: Ready'],
			['linky@example.test', 'Ruled: Ready']
		]);
		for (const mail of sent.emails) {
			expect(mail.html).toContain('A: Lean');
			expect(mail.html).toContain('It is what we can afford.');
			expect(mail.html).toContain('Looked at again in March.');
			expect(mail.html).not.toMatch(/respon|vote|against|cut-off|\b\d+ of \d+\b/i);
		}
		expect(participantRow(r.linked.id).linkTokenHash).toBe(linkHashOf(tokenOf(linkIn(sent.emails[1].html)!)));
		expect(sent.duringTransaction).toEqual([]);
	});
});

describe('the rules that hold after opening', () => {
	/** The account disabled, as `disableAccount` writes it, by the owner: only a disabled account is deleted (card 2671). */
	const disabledByOwner = (id: number) =>
		sqlite.prepare("UPDATE users SET disabled_at = '2099-01-01 09:00:00', disabled_by = ? WHERE id = ?").run(owner.id, id);

	it('skips an account holder whose account was deleted: marked left, until an administrator marks them active and clears it (70)', async () => {
		const r = await openedDecision();
		const eventsBefore = eventsOf(r.id).length;
		const admin = makeUser({ role: 'admin' });

		// Disabled first, as an account is before it is deleted (card 2671).
		disabledByOwner(r.holderAccount.id);
		deleteUser(r.holderAccount.id, { id: owner.id, username: owner.username });

		expect(participantRow(r.holder.id).userId).toBeNull();
		// S4: the person is unlinked by the key and marked left by the delete.
		expect(db.select().from(people).where(eq(people.id, r.holderPerson.id)).get()).toMatchObject({ userId: null, status: 'left', leftAt: expect.any(String) });
		expect(eventsOf(r.id)).toHaveLength(eventsBefore);

		republish(r.author, r.id, { changeNote: 'A word changed.', askAgain: false });
		const told = eventsOf(r.id).slice(eventsBefore);
		expect(told.filter((event) => event.participantId === r.holder.id).map((event) => [event.kind, event.detail])).toEqual([
			['mail_skipped', { mail: 'told_of_change', reason: 'left' }]
		]);
		await waitForOutcomes(r.id, 3);
		expect(sent.emails.map((mail) => mail.to)).toEqual(['linky@example.test']);
		expect(outcome(() => resend(r.author, r.id, r.holder.id))).toEqual({ status: 409, message: 'Holder has left: they cannot be mailed about this decision' });

		// Marked active again, as a deliberate act: the row's history still holds the account. Card 3020 (R6): the route
		// passes `steppedUp` once the password and a code are confirmed, which this service-level call stands for.
		as(admin, (caller) => updatePerson(caller, { personId: r.holderPerson.id }, { status: 'active', reviewedEmail: r.holderPerson.email }, { ...UI, steppedUp: true }));
		expect(outcome(() => resend(r.author, r.id, r.holder.id))).toEqual({
			status: 409,
			message: "Holder's account on this decision has been deleted: an administrator clears it before they can be mailed a personal link"
		});

		setAccount(admin, r.id, r.holder.id, 'none');
		expect(eventsOf(r.id).at(-1)).toMatchObject({ kind: 'account_cleared', participantId: r.holder.id, detail: { userId: null } });
		ageRecordMail(r.id);
		sent.clear();
		const before = eventsOf(r.id).length;
		resend(r.author, r.id, r.holder.id);
		expect(eventsOf(r.id).slice(before).map((event) => [event.kind, event.detail])).toEqual([
			['link_issued', { replaced: false }],
			['invited', { resend: true }]
		]);
		await waitForOutcomes(r.id, 4);
		expect(sent.emails.map((mail) => mail.to)).toEqual([r.holderPerson.email]);
		expect(participantRow(r.holder.id).linkTokenHash).toBe(linkHashOf(tokenOf(linkIn(sent.emails[0].html)!)));
	});

	it("marks the account's person left as the account is deleted, ends their links with link_revoked { left }, and logs no address (S4)", () => {
		const decision = openByHand();
		const draft = makeDecision({ board, author: owner, decider: owner });
		const account = makeUser({ username: 'going' });
		const person = makePerson({ fullName: 'Going Away', email: 'going@example.test', user: account });
		// A link the person holds all the same, as a row written before they were linked would; and a draft's row, with none.
		const row = makeParticipant(decision, { person, userId: null, token: 'a-link-held-before-the-account', hadAccount: false });
		makeParticipant(draft, { person });
		const other = makeParticipant(decision, { person: makePerson({ fullName: 'Staying' }), token: 'a-link-that-stays', hadAccount: false });
		const before = eventsOf(decision.id).length;

		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'INFO';
		const quiet = vi.spyOn(console, 'log').mockImplementation(() => {});
		// Disabled first, as an account is before it is deleted (card 2671).
		disabledByOwner(account.id);
		try {
			deleteUser(account.id, { id: owner.id, username: owner.username });
		} finally {
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
			quiet.mockRestore();
		}

		expect(db.select().from(people).where(eq(people.id, person.id)).get()).toMatchObject({ userId: null, status: 'left', leftAt: expect.any(String) });
		expect(participantRow(row.id)).toMatchObject({ linkTokenHash: null, linkIssuedAt: null });
		expect(participantRow(other.id).linkTokenHash).toBe(linkHashOf('a-link-that-stays'));
		expect(eventsOf(decision.id).slice(before)).toEqual([
			expect.objectContaining({ kind: 'link_revoked', participantId: row.id, detail: { reason: 'left' }, actorName: 'owner', source: 'ui' })
		]);
		expect(eventsOf(draft.id)).toEqual([]);
		const lines = sqlite.prepare("SELECT message, meta, user_id AS userId FROM system_logs WHERE context = 'PEOPLE'").all() as { message: string; meta: string; userId: number }[];
		expect(lines.map((line) => [line.message, JSON.parse(line.meta), line.userId])).toEqual([
			[
				`Person ${person.id} "Going Away" marked left: their account ${account.id} was deleted; 1 decision links cleared (by owner)`,
				{ personId: person.id, userId: account.id, participantIds: [row.id] },
				owner.id
			]
		]);
		expect(lines.map((line) => `${line.message} ${line.meta}`).join('\n')).not.toContain('going@example.test');
	});

	it('asks each mail again just before it is sent, and records one no longer standing as superseded, sending nothing (F2)', async () => {
		const admin = makeUser({ role: 'admin' });
		const decision = openByHand();
		const first = makeParticipant(decision, { person: makePerson({ fullName: 'First', email: 'first@example.test' }), hadAccount: false });
		const holder = makeParticipant(decision, { person: makePerson({ fullName: 'Holder', user: makeUser() }), hadAccount: true });
		const thirdPerson = makePerson({ fullName: 'Third', email: 'third@example.test' });
		const third = makeParticipant(decision, { person: thirdPerson, hadAccount: false });
		// While the first mail is out, the second's account is cleared and the third's address changed, which ends its link.
		refusal = (mail) => {
			if (mail.to === 'first@example.test') {
				setAccount(admin, decision.id, holder.id, 'none');
				// Card 2697 (Q22): the directory's address moves, and the row is made to agree with it.
				db.update(people).set({ email: 'third.new@example.test' }).where(eq(people.id, thirdPerson.id)).run();
				setAddress(admin, decision.id, third.id);
			}
			return undefined;
		};

		as(owner, () => queueRecordMails(decisionRow(decision.id), 'told_of_change', { by: actorFor(owner, 'ui'), changeNote: 'Moved.' }));
		await waitForOutcomes(decision.id, 3);

		const told = eventsOf(decision.id).filter((event) => event.kind === 'told_of_change');
		expect(outcomesOf(decision.id).map((event) => [event.participantId, event.detail])).toEqual([
			[first.id, { of: told[0].id, mail: 'told_of_change', delivered: true }],
			[holder.id, { of: told[1].id, mail: 'told_of_change', delivered: false, problem: 'superseded' }],
			[third.id, { of: told[2].id, mail: 'told_of_change', delivered: false, problem: 'superseded' }]
		]);
		expect(sent.emails.map((mail) => mail.to)).toEqual(['first@example.test']);
		expect(sent.refusedMail).toEqual([]);
		expect(sent.duringTransaction).toEqual([]);
	});

	it('records a mail built before the decision was published again as superseded, sending nothing (card 2739, code review 2026-11-05)', async () => {
		const decision = openByHand();
		const first = makeParticipant(decision, { person: makePerson({ fullName: 'First', email: 'first@example.test' }), hadAccount: false });
		const second = makeParticipant(decision, { person: makePerson({ fullName: 'Second', email: 'second@example.test' }), hadAccount: false });
		// While the first mail is out, a new version is published: the second mail quotes one no longer current.
		refusal = (mail) => {
			if (mail.to === 'first@example.test') db.update(decisions).set({ currentVersion: 2 }).where(eq(decisions.id, decision.id)).run();
			return undefined;
		};

		as(owner, () => queueRecordMails(decisionRow(decision.id), 'invitation', { by: actorFor(owner, 'ui') }));
		await waitForOutcomes(decision.id, 2);

		const invited = eventsOf(decision.id).filter((event) => event.kind === 'invited');
		expect(outcomesOf(decision.id).map((event) => [event.participantId, event.detail])).toEqual([
			[first.id, { of: invited[0].id, mail: 'invitation', delivered: true }],
			[second.id, { of: invited[1].id, mail: 'invitation', delivered: false, problem: 'superseded' }]
		]);
		expect(sent.emails.map((mail) => mail.to)).toEqual(['first@example.test']);
	});

	it('holds one live participant row per account (71)', () => {
		const admin = makeUser({ role: 'admin' });
		const x = makeUser({ username: 'x' });
		const decision = openByHand();
		// (i) A stale live row, kept, holds X; the person now linked to X is added. (A row whose person was
		// deleted is taken off by the save, card 2676's C1, so the stale row here is a person still named.)
		const old = makePerson({ fullName: 'Old X' });
		makeParticipant(decision, { person: old, name: 'Stale', userId: x.id, hadAccount: true });
		const now = makePerson({ fullName: 'Now X', user: x });
		const before = { events: eventsOf(decision.id).length, rows: participantRows(decision.id).length };
		expect(
			outcome(() =>
				as(owner, (caller) =>
					setParticipants(
						caller,
						{ decisionId: decision.id },
						{
							participants: [
								{ personId: old.id, role: 'consulted' },
								{ personId: now.id, role: 'consulted' }
							],
							revision: revisionNow(decision.id)
						},
						UI
					)
				)
			)
		).toEqual({
			status: 409,
			message: 'Now X cannot be included: another participant of this decision holds the same account'
		});
		expect(eventsOf(decision.id)).toHaveLength(before.events);
		expect(participantRows(decision.id)).toHaveLength(before.rows);

		// (ii) Attaching X to another row.
		const other = makeParticipant(decision, { person: now, userId: null, hadAccount: false });
		expect(outcome(() => setAccount(admin, decision.id, other.id, 'person'))).toEqual({
			status: 409,
			message: 'Now X cannot be given that account: another participant of this decision holds it'
		});
		expect(participantRow(other.id).userId).toBeNull();

		// (iii) A draft with two rows for one person: refused once the snapshots are retaken.
		const ready = readyDraft();
		makeParticipant(ready.draft, { person: ready.holderPerson });
		expect(outcome(() => open(ready.author, ready.draft))).toEqual({
			status: 409,
			message: 'Holder and Holder hold the same account: this decision cannot be opened while two of its participants do'
		});
		expect(decisionRow(ready.draft.id).status).toBe('draft');
		expect(eventsOf(ready.draft.id)).toEqual([]);

		// (iv) Two live rows hold the caller's account: no participant role, a 404, and one WARN line.
		makeParticipant(decision, { person: null, name: 'Stale Too', email: 'stale.too@example.test', userId: x.id, hadAccount: true });
		const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'WARN';
		try {
			const access = decisionAccess(x, decision);
			expect(access.roles.has('participant')).toBe(false);
			expect(access.participantId).toBeNull();
			const warnings = sqlite.prepare("SELECT message, meta FROM system_logs WHERE level = 'WARN'").all() as { message: string; meta: string }[];
			expect(warnings.map((w) => [w.message, JSON.parse(w.meta)])).toEqual([
				[`Decision ${decision.id}: 2 live participant rows hold the caller's account; participant access refused`, { decisionId: decision.id, rows: 2 }]
			]);
			expect(`${warnings[0].message} ${warnings[0].meta}`).not.toMatch(/Stale|example\.test/);
			expect(outcome(() => requireDecision(x, decision.id, 'view'))).toEqual({ status: 404, message: 'Decision not found' });
		} finally {
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
			quiet.mockRestore();
		}
	});

	it('holds each participant to one record-bearing mail in 10 minutes: re-send, re-publish and re-inclusion (72)', async () => {
		expect(RECORD_MAIL_MIN_MINUTES).toBe(10);
		const r = await openedDecision('Ready', false);
		const invitedAt = (sqlite.prepare("SELECT created_at AS at FROM decision_events WHERE participant_id = ? AND kind = 'invited'").get(r.linked.id) as { at: string }).at;
		const from = stamp(new Date(parseStamp(invitedAt)!.getTime() + 10 * 60 * 1000));
		const throttled = { status: 409, message: `Linky was mailed about this decision less than 10 minutes ago: they can be mailed again from ${from} UTC` };
		const set = (participants: { personId: number; role: string }[]) =>
			as(r.author, (caller) => setParticipants(caller, { decisionId: r.id }, { participants, revision: revisionNow(r.id) }, UI));

		expect(outcome(() => resend(r.author, r.id, r.linked.id))).toEqual(throttled);

		ageRecordMail(r.id, 11);
		expect(outcome(() => resend(r.author, r.id, r.linked.id))).toBe('passed');
		const again = outcome(() => republish(r.author, r.id, { changeNote: 'Straight after.', askAgain: true }));
		expect(again).toMatchObject({ status: 409, message: expect.stringMatching(/^Linky was mailed about this decision less than 10 minutes ago: they can be mailed again from .+ UTC$/) });

		set([{ personId: r.holderPerson.id, role: 'consulted' }]);
		expect(participantRow(r.linked.id).removedAt).not.toBeNull();
		expect(outcome(() => set([{ personId: r.holderPerson.id, role: 'consulted' }, { personId: r.linkPerson.id, role: 'informed' }]))).toMatchObject({
			status: 409,
			message: expect.stringMatching(/^Linky was mailed about this decision less than 10 minutes ago/)
		});

		ageRecordMail(r.id, 11);
		expect(outcome(() => republish(r.author, r.id, { changeNote: 'Later on.', askAgain: true }))).toBe('passed');
		expect(outcome(() => set([{ personId: r.holderPerson.id, role: 'consulted' }, { personId: r.linkPerson.id, role: 'informed' }]))).toBe('passed');
		expect(participantRow(r.linked.id).removedAt).toBeNull();
		await sent.settle();
	});

	it('withdraws with no link address, recording each mail as not sent; refuses the writes whose point is the mail, 409 (73)', async () => {
		const r = await openedDecision();
		const second = openByHand();
		// Its two live options, as opening leaves them, so that a re-publish is refused for the address alone (F4).
		for (const label of ['A', 'B']) makeOption(second, { label, addedInVersion: 1 });
		const holder = makeParticipant(second, { person: makePerson({ fullName: 'Holding On' }), hadAccount: false });
		const newcomer = makePerson({ fullName: 'Newcomer' });

		await withNoLinkAddress(async () => {
			const before = eventsOf(r.id).length;
			await withdrawHeld(r.author, r.id);
			const written = eventsOf(r.id).slice(before);
			const mails = written.filter((event) => event.kind === 'told_withdrawn');
			expect(written.map((event) => [event.kind, event.participantId])).toEqual([
				['withdrawn', null],
				['told_withdrawn', r.holder.id],
				['mail_outcome', r.holder.id],
				['told_withdrawn', r.linked.id],
				['mail_outcome', r.linked.id]
			]);
			expect(written.filter((event) => event.kind === 'mail_outcome')).toEqual(
				mails.map((mail) =>
					expect.objectContaining({ detail: { of: mail.id, mail: 'withdrawn', delivered: false, problem: 'no_link_address' }, actorName: 'DumpFire', source: 'system' })
				)
			);
			expect(decisionRow(r.id).status).toBe('withdrawn');

			const secondBefore = { events: eventsOf(second.id).length, rows: participantRows(second.id) };
			const refused = { status: 409, message: NO_LINK_ADDRESS };
			expect(outcome(() => republish(owner, second.id, { changeNote: 'Nobody to tell.', askAgain: true }))).toEqual(refused);
			expect(outcome(() => resend(owner, second.id, holder.id))).toEqual(refused);
			expect(
				outcome(() =>
					as(owner, (caller) =>
						setParticipants(
							caller,
							{ decisionId: second.id },
							{ participants: [{ personId: holder.personId!, role: 'consulted' }, { personId: newcomer.id, role: 'consulted' }], revision: revisionNow(second.id) },
							UI
						)
					)
				)
			).toEqual(refused);
			expect(eventsOf(second.id)).toHaveLength(secondBefore.events);
			expect(participantRows(second.id)).toEqual(secondBefore.rows);
			expect(decisionRow(second.id).currentVersion).toBe(1);
		});
		await sent.settle();
		expect(sent.emails).toEqual([]);
		expect(sent.duringTransaction).toEqual([]);
	});
});

// ─── Card 2671: a disabled account on a decision (cases 27 and 28, S2) ──────

describe('an account that is disabled, on a decision (card 2671)', () => {
	/** The account disabled, as `disableAccount` writes it. */
	const disable = (id: number) => sqlite.prepare("UPDATE users SET disabled_at = '2099-01-01 09:00:00' WHERE id = ?").run(id);
	const include = (user: SessionUser, id: number, participants: { personId: number; role: string }[]) =>
		as(user, (caller) => setParticipants(caller, { decisionId: id }, { participants, revision: revisionNow(id) }, UI));
	/** A person linked to an account that is disabled. */
	const goneAway = () => {
		const account = makeUser({ username: 'gone' });
		const person = makePerson({ fullName: 'Gone Away', user: account });
		disable(account.id);
		return person;
	};
	const REFUSED = { status: 409, message: 'Gone Away cannot be included: their account is disabled' };

	it('case 27: refuses to include a person whose account is disabled in a draft (setParticipants), with nothing written', () => {
		const ready = readyDraft();
		const gone = goneAway();
		const before = participantRows(ready.draft.id);

		expect(
			outcome(() =>
				include(ready.author, ready.draft.id, [
					{ personId: ready.holderPerson.id, role: 'consulted' },
					{ personId: ready.linkPerson.id, role: 'informed' },
					{ personId: gone.id, role: 'informed' }
				])
			)
		).toEqual(REFUSED);
		expect(participantRows(ready.draft.id)).toEqual(before);
	});

	it('case 27: refuses to include one in a decision that is open (the inclusion save), with nothing written', async () => {
		const r = await openedDecision();
		const gone = goneAway();
		const before = { events: eventsOf(r.id).length, rows: participantRows(r.id) };

		expect(
			outcome(() =>
				include(r.author, r.id, [
					{ personId: r.holderPerson.id, role: 'consulted' },
					{ personId: r.linkPerson.id, role: 'informed' },
					{ personId: gone.id, role: 'informed' }
				])
			)
		).toEqual(REFUSED);
		expect({ events: eventsOf(r.id).length, rows: participantRows(r.id) }).toEqual(before);
		await sent.settle();
		expect(sent.emails).toEqual([]);
	});

	it('case 27: refuses Attach account where the account the directory holds for them is disabled (attachRefusal)', async () => {
		const r = await openedDecision();
		const admin = makeUser({ role: 'admin' });
		const account = makeUser({ username: 'linky' });
		db.update(people).set({ userId: account.id }).where(eq(people.id, r.linkPerson.id)).run();
		disable(account.id);

		expect(outcome(() => setAccount(admin, r.id, r.linked.id, 'person'))).toEqual({
			status: 409,
			message: "Linky's account is disabled: it cannot be attached until it is enabled again"
		});
		expect(participantRow(r.linked.id).userId).toBeNull();
	});

	it("case 28: skips a participant whose account is disabled (reachOf: account_disabled), and Resend is refused in its words", async () => {
		const r = await openedDecision();
		disable(r.holderAccount.id);

		expect(outcome(() => resend(r.author, r.id, r.holder.id))).toEqual({
			status: 409,
			message: "Holder's account is disabled: they cannot be mailed about this decision"
		});
		await sent.settle();
		expect(sent.emails).toEqual([]);
	});
});
