/**
 * The decision service (card 2675, slices 2a and 2b): a draft made with its
 * default decider, the decider named, the participants set before and after
 * opening, and opening; re-publishing, closing, extending, withdrawing and
 * deleting; re-sending, and the administrator's participant actions; with
 * the mails that carry the record, the ruling mail among them, and what is
 * recorded of each (`src/lib/server/decisions.ts` and
 * `src/lib/server/decision-mail.ts`).
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
import { actorFor, liveOptionIds } from '$lib/server/decision-record';
import { decisionAccess } from '$lib/server/decision-access';
import { participantForLink } from '$lib/server/decision-links';
import { queueRecordMails, RECORD_MAIL_MIN_MINUTES } from '$lib/server/decision-mail';
import {
	changeParticipantAddress,
	closeDecision,
	createDecision,
	deleteDecision,
	extendDecision,
	openDecision,
	republishDecision,
	resendInvitation,
	setDecider,
	setParticipantAccount,
	setParticipants,
	withdrawDecision
} from '$lib/server/decisions';
import { deleteUser } from '$lib/server/deletes';
import { mailStatus, NO_LINK_ADDRESS } from '$lib/server/email';
import { subscribe } from '$lib/server/events';
import { updatePerson } from '$lib/server/people';
import { requireDecision } from '$lib/server/route-guards';
import { parseStamp, stamp } from '$lib/timestamps';
import { writeAs } from '$lib/server/write-as';
import type { ServiceOptions } from '$lib/server/write-as';
import { OPEN_FAULTS, readyDraft as readyDraftOn, revisionNow } from './helpers/decision-faults';
import { effects, type Effects, type OfferedMail } from './helpers/effects';
import { readBudget } from './helpers/reads';
import {
	addBoardMember,
	ageRecordMail,
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
const FUTURE = '2099-01-01 12:00:00';

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

// ─── Opening (cases 34 to 46) ────────────────────────────────────────────────

/** A draft that opens, on `board` (`tests/helpers/decision-faults.ts`, moved there by card 2676). */
const readyDraft = (title = 'Ready') => readyDraftOn({ board }, title);

const open = (user: SessionUser, decision: Decision, opts: ServiceOptions = UI) => as(user, (caller) => openDecision(caller, { decisionId: decision.id }, null, opts));

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

const republish = (user: SessionUser, id: number, body: Record<string, unknown>) => as(user, (caller) => republishDecision(caller, { decisionId: id }, body, UI));
const resend = (user: SessionUser, id: number, participantId: number) =>
	as(user, (caller) => resendInvitation(caller, { decisionId: id, participantId }, null, UI));
const withdraw = (user: SessionUser, id: number, reason = 'No longer needed.') => as(user, (caller) => withdrawDecision(caller, { decisionId: id }, { reason }, UI));
const remove = (user: SessionUser, id: number) => as(user, (caller) => deleteDecision(caller, { decisionId: id }, null, UI));
const setAccount = (user: SessionUser, id: number, participantId: number, account: string) =>
	as(user, (caller) => setParticipantAccount(caller, { decisionId: id, participantId }, { account }, UI));
const setAddress = (user: SessionUser, id: number, participantId: number, email: string) =>
	as(user, (caller) => changeParticipantAddress(caller, { decisionId: id, participantId }, { email }, UI));
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
	it('asks everyone again: version 2, asked_again with a fresh link for the link holder, decision_republished and a live event (48)', async () => {
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
			['asked_again', r.linked.id, 2, null]
		]);
		await waitForOutcomes(r.id, 4);
		expect(sent.emails.map((mail) => [mail.to, mail.subject])).toEqual([
			[r.holderPerson.email, 'Changed, and your view is asked again: Ready'],
			['linky@example.test', 'Changed, and your view is asked again: Ready']
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

		const row = as(r.decider, (caller) => extendDecision(caller, { decisionId: r.id }, { closesAt: '2099-06-01T09:30:00Z' }, UI));

		expect(row).toMatchObject({ status: 'open', closesAt: '2099-06-01 09:30:00', closedAt: null });
		expect(eventsOf(r.id).slice(before)).toEqual([
			expect.objectContaining({ kind: 'extended', detail: { from: FUTURE, to: '2099-06-01 09:30:00' }, actorName: 'decider' })
		]);
		expect(activityRows().at(-1)).toEqual({
			boardId: board.id,
			cardId: null,
			action: 'decision_extended',
			detail: '"Ready": closes 2099-06-01 09:30 UTC',
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

describe('withdrawDecision', () => {
	it('withdraws an open decision, tells everyone with the reason on links that still work, and keeps the reason out of activity (57)', async () => {
		const r = await openedDecision();
		const before = eventsOf(r.id).length;

		const row = withdraw(r.author, r.id, 'The budget was cut.');

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
		withdraw(owner, boardless.id);
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
		withdraw(r.author, r.id);
		await waitForOutcomes(r.id, 4);
		sent.clear();

		remove(r.author, r.id);

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
		refusal = () => {
			if (mailEvents.length === 0) {
				mailEvents = eventsOf(second.id)
					.filter((event) => event.kind === 'told_withdrawn')
					.map((event) => event.id);
				remove(owner, second.id);
			}
			return undefined;
		};
		const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'WARN';
		try {
			withdraw(owner, second.id);
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
	});

	it('refuses deleting a ruled decision, 409, with nothing removed (61)', () => {
		const ruled = openByHand({ status: 'ruled', ruledAt: '2026-11-02 09:00:00' });

		expect(outcome(() => remove(owner, ruled.id))).toEqual({ status: 409, message: 'This decision is ruled: it cannot be deleted' });
		expect(decisionRow(ruled.id)).toBeDefined();
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
		setAddress(makeUser({ role: 'admin' }), r.id, r.linked.id, 'linky.new@example.test');
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

	it('changes the address, lower-cased, ends the link, writes address_changed { from, to }, and sends nothing (68)', async () => {
		const decision = openByHand();
		const row = makeParticipant(decision, { person: makePerson({ email: 'old@example.test' }), token: 'a-live-token', hadAccount: false });
		const before = eventsOf(decision.id).length;

		const after = setAddress(admin, decision.id, row.id, 'New.Address@Example.Test');

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
	it('skips an account holder whose account was deleted: marked left, until an administrator marks them active and clears it (70)', async () => {
		const r = await openedDecision();
		const eventsBefore = eventsOf(r.id).length;
		const admin = makeUser({ role: 'admin' });

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

		// Marked active again, as a deliberate act: the row's history still holds the account.
		as(admin, (caller) => updatePerson(caller, { personId: r.holderPerson.id }, { status: 'active' }, UI));
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
		const third = makeParticipant(decision, { person: makePerson({ fullName: 'Third', email: 'third@example.test' }), hadAccount: false });
		// While the first mail is out, the second's account is cleared and the third's address changed, which ends its link.
		refusal = (mail) => {
			if (mail.to === 'first@example.test') {
				setAccount(admin, decision.id, holder.id, 'none');
				setAddress(admin, decision.id, third.id, 'third.new@example.test');
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
			withdraw(r.author, r.id);
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
