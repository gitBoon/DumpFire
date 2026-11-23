/**
 * The register, each person's record and the record view (card 2680, slice
 * 1): `registerQueryOf`, `readRegister`, `visibleDecisionIdsOf`,
 * `readPersonRecord`, `readRecord` and `recordEntryOf` in
 * `src/lib/server/decision-register.ts`; `shownStatusSql` and `listedStatusOf`
 * in `decision-status.ts`; `RECORD_DETAIL` and `OWN_RECORD_EVENTS` in
 * `decision-record.ts`; and what the decision page and the editor gain
 * (`mayReadRecord`, the board's current name, the 404 for a path that is not
 * an id).
 *
 * Every read is called as a page load calls it, with the signed-in account.
 * The cases are the plan's, `docs/planning/card-2680-register-records-links.md`,
 * section 7.1, by number; 74 and 75 are slice 3a's, with the pages.
 */
import { isHttpError } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import type { SessionUser } from '$lib/server/auth';
import { boards, decisions, decisionSurveyQuestions, people, users, type Board, type Decision, type DecisionParticipant, type Person } from '$lib/server/db/schema';
import { decisionAccess, mayDo } from '$lib/server/decision-access';
import { readEditPage } from '$lib/server/decision-authoring';
import { reachedParticipantOf } from '$lib/server/decision-questions';
import {
	appendEvent,
	countedInRound,
	DECIDER_ONLY_EVENTS,
	EVENT_KINDS,
	FLAG_EVENTS,
	KEY_HIDDEN_EVENTS,
	OWN_RECORD_EVENTS,
	RECORD_DETAIL,
	recordEventsOf,
	SYSTEM_ACTOR,
	type EventKind
} from '$lib/server/decision-record';
import {
	readPersonRecord,
	readRecord,
	readRegister,
	RECORD_READ_MAX,
	recordEntryOf,
	registerQueryOf,
	visibleDecisionIdsOf
} from '$lib/server/decision-register';
import { decisionStatus, listedStatusOf, shownStatusSql, STORED_STATUSES } from '$lib/server/decision-status';
import { readResults } from '$lib/server/decision-results';
import { readDecisionPage } from '$lib/server/decision-view';
import { requireDecision } from '$lib/server/route-guards';
import type { Participation, PersonRecord, RecordEntry, RegisterPage, RegisterRow } from '$lib/decision-register-types';
import type { ShownStatus } from '$lib/decision-view-types';
import { DETAIL_WORDS, detailWords } from '$lib/decision-words';
import { stamp } from '$lib/timestamps';
import { pageLoad } from './helpers/actions';
import {
	addBoardMember,
	makeBoard,
	makeDecision,
	makeOption,
	makeParticipant,
	makePerson,
	makeQuestion,
	makeResponse,
	makeRuling,
	makeTeam,
	makeUser,
	makeVersion,
	resetDb,
	shareBoardWithTeam
} from './helpers/fixtures';

const UI = { source: 'ui' } as const;
const FUTURE = '2099-01-01 12:00:00';
const PAST = '2026-01-02 09:00:00';
const OPENED = '2026-01-01 09:00:00';

beforeEach(resetDb);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** What a call was answered with: 'passed', or the refusal's status and words. */
function outcome(run: () => unknown): 'passed' | { status: number; message: string } {
	try {
		run();
		return 'passed';
	} catch (err) {
		if (isHttpError(err)) return { status: err.status, message: err.body.message };
		throw err;
	}
}

/**
 * A decision as its service leaves one: a draft never opened, and any other
 * status opened at `OPENED`; an open one closing in the future unless told
 * otherwise.
 */
function decisionOn(
	board: Board | null,
	opts: { status?: string; author?: SessionUser | null; decider?: SessionUser | null; closesAt?: string | null; title?: string } = {}
): Decision {
	const status = opts.status ?? 'open';
	return makeDecision({
		board,
		author: opts.author ?? null,
		decider: opts.decider ?? null,
		status,
		closesAt: opts.closesAt !== undefined ? opts.closesAt : status === 'open' ? FUTURE : null,
		openedAt: status === 'draft' ? null : OPENED,
		...(opts.title === undefined ? {} : { title: opts.title })
	});
}

/** A person of the directory whose account is `user`, named for it unless told otherwise. */
const personOf = (user: SessionUser, fullName?: string): Person => makePerson({ user, fullName: fullName ?? `${user.username} person` });

/** The person's participant row on the decision, with its `included` event once the decision is not a draft. */
const join = (decision: Decision, person: Person | null, row: Partial<DecisionParticipant> = {}): DecisionParticipant =>
	makeParticipant(decision, { person, ...(decision.status === 'draft' ? {} : { hadAccount: person?.userId != null }), ...row });

const query = (search = '') => registerQueryOf(new URLSearchParams(search), 'page');
const register = (user: SessionUser, search = ''): RegisterPage => readRegister(user, query(search), UI);
const idsOf = (page: RegisterPage) => page.rows.map((row) => row.id);
const rowOf = (page: RegisterPage, id: number): RegisterRow => page.rows.find((row) => row.id === id)!;
/** Every id the All tab lists, page by page. */
function allIds(user: SessionUser): number[] {
	const ids: number[] = [];
	let before: number | null = null;
	for (;;) {
		const page = register(user, `tab=all${before === null ? '' : `&before=${before}`}`);
		ids.push(...idsOf(page));
		if (page.next === null) return ids;
		before = page.next;
	}
}
const sorted = (ids: Iterable<number>) => [...ids].sort((a, b) => a - b);
const renameBoard = (board: Board, name: string) => db.update(boards).set({ name }).where(eq(boards.id, board.id)).run();
const deleteBoard = (board: Board) => sqlite.prepare('DELETE FROM boards WHERE id = ?').run(board.id);
const decisionRow = (id: number) => db.select().from(decisions).where(eq(decisions.id, id)).get()!;

const personRecord = (user: SessionUser, personId: number, before: number | null = null) => readPersonRecord(user, personId, { before }, UI);
const record = (user: SessionUser, id: number, q: { participant?: number; after?: number } = {}, limit = 500) =>
	readRecord(user, id, { participant: q.participant ?? null, after: q.after ?? null }, { source: 'ui', limit });

/** An administrator's or a decider's person record's participations, each with the record's entries. */
function privileged(read: PersonRecord): Participation<RecordEntry>[] {
	if (read.audience === 'self') throw new Error('an administrator’s or a decider’s record was expected');
	return read.participations;
}

/** Card 2684: an objection or a request to talk, well formed, as the writes leave one, replied to where `reply` is given. */
function plantFlag(
	participant: DecisionParticipant,
	row: { kind: 'objection' | 'talk'; reason: string; via?: string; reply?: string; repliedByName?: string; repliedAt?: string }
): void {
	sqlite
		.prepare(
			'INSERT INTO decision_flags (decision_id, participant_id, kind, reason, version_number, via, raised_at, reply, replied_by_name, replied_at) ' +
				"VALUES (?, ?, ?, ?, 1, ?, '2026-11-02 09:00:00', ?, ?, ?)"
		)
		.run(participant.decisionId, participant.id, row.kind, row.reason, row.via ?? 'session', row.reply ?? null, row.reply === undefined ? null : (row.repliedByName ?? 'dana'), row.repliedAt ?? null);
}

/** Every key at every depth of a value. */
function keysDeep(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap(keysDeep);
	if (value === null || typeof value !== 'object') return [];
	return Object.entries(value).flatMap(([key, inner]) => [key, ...keysDeep(inner)]);
}

// ─── Visibility ──────────────────────────────────────────────────────────────

describe('who sees which decisions', () => {
	it('lists a draft to its author, its decider, the board’s creator and a direct owner member, and not to a board editor or a team share (1)', () => {
		const creator = makeUser();
		const board = makeBoard({ owner: creator }).board;
		const [author, decider, member, editor, teamOwner] = [makeUser(), makeUser(), makeUser(), makeUser(), makeUser()];
		addBoardMember(board, author, 'editor');
		addBoardMember(board, member, 'owner');
		addBoardMember(board, editor, 'editor');
		shareBoardWithTeam(board, makeTeam([teamOwner]), 'editor');
		const draft = decisionOn(board, { status: 'draft', author, decider });

		for (const user of [author, decider, creator, member]) expect(allIds(user), user.username).toEqual([draft.id]);
		for (const user of [editor, teamOwner]) expect(allIds(user), user.username).toEqual([]);
	});

	it('lists to a participant with no board access the decision they hold one live row on; a removed row, and two live rows on one account, show nothing (2)', () => {
		const board = makeBoard({ owner: makeUser() }).board;
		const [one, removed, twice] = [makeUser(), makeUser(), makeUser()];
		const held = decisionOn(board);
		join(held, personOf(one));
		const left = decisionOn(board);
		join(left, personOf(removed), { removedAt: OPENED });
		const doubled = decisionOn(board);
		const twicePerson = personOf(twice);
		join(doubled, twicePerson);
		join(doubled, null, { userId: twice.id });

		expect(allIds(one)).toEqual([held.id]);
		expect(allIds(removed)).toEqual([]);
		expect(allIds(twice)).toEqual([]);
	});

	it('lists exactly the decisions requireDecision(…, view) lets through, over the whole access cast (3)', () => {
		const owner = makeUser({ username: 'cast-owner' });
		const A = makeBoard({ owner, name: 'A' }).board;
		const B = makeBoard({ owner: makeUser(), name: 'B' }).board;
		const P = makeBoard({ owner: makeUser(), name: 'P', isPublic: true }).board;
		const gone = makeBoard({ owner: makeUser(), name: 'Gone' }).board;
		const cast = {
			owner,
			directOwner: makeUser({ username: 'cast-direct-owner' }),
			editor: makeUser({ username: 'cast-editor' }),
			viewer: makeUser({ username: 'cast-viewer' }),
			guest: makeUser({ username: 'cast-guest' }),
			outsider: makeUser({ username: 'cast-outsider' }),
			both: makeUser({ username: 'cast-both' }),
			admin: makeUser({ username: 'cast-admin', role: 'admin' }),
			participant: makeUser({ username: 'cast-participant' }),
			doubled: makeUser({ username: 'cast-doubled' }),
			author: makeUser({ username: 'cast-author' }),
			decider: makeUser({ username: 'cast-decider' })
		};
		addBoardMember(A, cast.directOwner, 'owner');
		addBoardMember(A, cast.editor, 'editor');
		addBoardMember(A, cast.viewer, 'viewer');
		addBoardMember(A, cast.both, 'editor');
		shareBoardWithTeam(A, makeTeam([cast.guest]), 'viewer');
		addBoardMember(B, cast.author, 'editor');
		const participantPerson = personOf(cast.participant);
		const bothPerson = personOf(cast.both);
		const doubledPerson = personOf(cast.doubled);

		for (const board of [A, B, P, gone]) {
			for (const status of STORED_STATUSES) {
				const decision = decisionOn(board, { status, author: cast.author, decider: cast.decider });
				join(decision, participantPerson);
				if (board.id === B.id) join(decision, bothPerson);
				join(decision, doubledPerson);
				join(decision, null, { userId: cast.doubled.id });
			}
		}
		deleteBoard(gone);
		const every = db.select({ id: decisions.id }).from(decisions).all().map((row) => row.id);

		for (const [name, user] of Object.entries(cast)) {
			const passed = every.filter((id) => outcome(() => requireDecision(user, id, 'view')) === 'passed');
			expect(sorted(allIds(user)), name).toEqual(sorted(passed));
			expect(sorted(visibleDecisionIdsOf(user, every)), name).toEqual(sorted(passed));
		}
	});

	it('answers visibleDecisionIdsOf with exactly the visible ids among those asked, past 500 ids (4)', () => {
		const viewer = makeUser();
		const A = makeBoard({ owner: makeUser() }).board;
		const B = makeBoard({ owner: makeUser() }).board;
		addBoardMember(A, viewer, 'viewer');
		const seen: number[] = [];
		const asked: number[] = [];
		for (let i = 0; i < 600; i++) {
			const decision = decisionOn(i % 2 === 0 ? A : B);
			asked.push(decision.id);
			if (i % 2 === 0) seen.push(decision.id);
		}
		asked.push(999_999);

		expect(sorted(visibleDecisionIdsOf(viewer, asked))).toEqual(sorted(seen));
	});

	it('answers visibleDecisionIdsOf the empty set for a disabled account, an administrator’s included, and 401 for none (card 2687 T13, S-L1)', () => {
		const admin = makeUser({ role: 'admin' });
		const author = makeUser();
		const A = makeBoard({ owner: makeUser() }).board;
		addBoardMember(A, author, 'editor');
		const ids = [decisionOn(A, { author }).id, decisionOn(A, { status: 'draft', author }).id, decisionOn(null).id];
		expect(visibleDecisionIdsOf(admin, ids).size).toBe(3);
		expect(visibleDecisionIdsOf(author, ids).size).toBe(2);

		db.update(users).set({ disabledAt: '2026-11-01 09:00:00' }).run();
		for (const [name, user] of Object.entries({ admin, author })) {
			// Read by id, as a plan's viewer is when it carries no disabledAt, and as the account carries it.
			expect(visibleDecisionIdsOf({ id: user.id, role: user.role }, ids), name).toEqual(new Set());
			expect(visibleDecisionIdsOf({ ...user, disabledAt: '2026-11-01 09:00:00' }, ids), name).toEqual(new Set());
		}
		expect(outcome(() => visibleDecisionIdsOf(null, ids))).toEqual({ status: 401, message: 'Not authenticated' });
	});
});

// ─── Rows ────────────────────────────────────────────────────────────────────

describe('what a row of the register shows', () => {
	it('has exactly the RegisterRow keys, and no participant’s name, count, ruledAt or updatedAt (5)', () => {
		const viewer = makeUser();
		const board = makeBoard({ owner: makeUser(), name: 'The board' }).board;
		addBoardMember(board, viewer, 'viewer');
		const decision = decisionOn(board, { decider: makeUser({ username: 'the-decider' }) });
		join(decision, makePerson({ fullName: 'Secret Participant' }));
		makeVersion(decision);

		const page = register(viewer, 'tab=all');
		expect(Object.keys(rowOf(page, decision.id)).sort()).toEqual(
			['authorName', 'board', 'closesAt', 'deciderName', 'id', 'openedAt', 'role', 'shownStatus', 'title'].sort()
		);
		const text = JSON.stringify(page.rows);
		for (const word of ['Secret Participant', 'ruledAt', 'updatedAt', 'count', 'participant']) expect(text).not.toContain(word);
	});

	it('gives authorName null on a row whose only role is participant, and to a board reader (6)', () => {
		const board = makeBoard({ owner: makeUser() }).board;
		const [participant, reader] = [makeUser(), makeUser()];
		addBoardMember(board, reader, 'viewer');
		const decision = decisionOn(board, { author: makeUser({ username: 'the-author' }) });
		join(decision, personOf(participant));

		expect(rowOf(register(participant, 'tab=all'), decision.id).authorName).toBeNull();
		expect(rowOf(register(reader, 'tab=all'), decision.id).authorName).toBe('the-author');
	});

	it('gives a board the caller can open by its id and current name after a rename (7)', () => {
		const reader = makeUser();
		const board = makeBoard({ owner: makeUser(), name: 'Old name' }).board;
		addBoardMember(board, reader, 'viewer');
		const decision = decisionOn(board);
		renameBoard(board, 'New name');

		expect(rowOf(register(reader, 'tab=all'), decision.id).board).toEqual({ id: board.id, name: 'New name', gone: false });
	});

	it('gives a board the caller cannot open by the name kept and no id, not its new name after a rename (8)', () => {
		const participant = makeUser();
		const board = makeBoard({ owner: makeUser(), name: 'Old name' }).board;
		const decision = decisionOn(board);
		join(decision, personOf(participant));
		renameBoard(board, 'New name');

		const page = register(participant, 'tab=all');
		expect(rowOf(page, decision.id).board).toEqual({ id: null, name: 'Old name', gone: false });
		expect(JSON.stringify(page)).not.toContain('New name');
	});

	it('gives a deleted board’s row the name kept and gone (9)', () => {
		const author = makeUser();
		const board = makeBoard({ owner: makeUser(), name: 'Kept name' }).board;
		const decision = decisionOn(board, { author });
		deleteBoard(board);

		expect(rowOf(register(author, 'tab=all'), decision.id).board).toEqual({ id: null, name: 'Kept name', gone: true });
	});

	it('gives waiting only where a waiting tab would list the row (10)', () => {
		const dana = makeUser({ username: 'dana' });
		const board = makeBoard({ owner: makeUser() }).board;
		addBoardMember(board, dana, 'editor');
		const owed = decisionOn(board);
		join(owed, personOf(dana));
		const toRule = decisionOn(board, { status: 'closed', decider: dana });
		const neither = decisionOn(board);

		const page = register(dana, 'tab=all');
		expect(rowOf(page, owed.id).waiting).toBe('response');
		expect(rowOf(page, toRule.id).waiting).toBe('ruling');
		expect(rowOf(page, neither.id)).not.toHaveProperty('waiting');
		expect(idsOf(register(dana, 'tab=waiting-response'))).toEqual([owed.id]);
		expect(idsOf(register(dana, 'tab=waiting-ruling'))).toEqual([toRule.id]);
	});
});

// ─── Tabs ────────────────────────────────────────────────────────────────────

describe('the tabs', () => {
	it('holds shownStatusSql to decisionStatus for each stored status, with no, a past and a future closing time (11)', () => {
		const now = stamp();
		for (const status of STORED_STATUSES) for (const closesAt of [null, PAST, FUTURE]) decisionOn(null, { status, closesAt });
		const rows = db.select().from(decisions).all();
		const shown: ShownStatus[] = ['draft', 'open', 'awaiting_ruling', 'ruled', 'superseded', 'withdrawn'];

		for (const status of shown) {
			const matched = db.select({ id: decisions.id }).from(decisions).where(shownStatusSql(status, now)).all().map((row) => row.id);
			expect(sorted(matched), status).toEqual(sorted(rows.filter((row) => decisionStatus(row, now) === status).map((row) => row.id)));
		}
	});

	it('gives listedStatusOf decisionStatus’s status, and closesAt null once ruled or superseded (12)', () => {
		const now = stamp();
		for (const status of STORED_STATUSES) {
			for (const closesAt of [null, PAST, FUTURE]) {
				const row = { status, closesAt };
				expect(listedStatusOf(row, now)).toEqual({
					shownStatus: decisionStatus(row, now),
					closesAt: status === 'ruled' || status === 'superseded' ? null : closesAt
				});
			}
		}
	});

	describe('Waiting for my response', () => {
		let pat: SessionUser;
		let person: Person;
		let board: Board;
		beforeEach(() => {
			pat = makeUser({ username: 'pat' });
			person = personOf(pat, 'Pat Page');
			board = makeBoard({ owner: makeUser() }).board;
		});
		const owedIds = () => idsOf(register(pat, 'tab=waiting-response'));

		it('holds a consulted, reached, open decision with no response this round (13)', () => {
			const decision = decisionOn(board);
			makeVersion(decision);
			join(decision, person);

			const page = register(pat, 'tab=waiting-response');
			expect(idsOf(page)).toEqual([decision.id]);
			expect(page.rows[0].waiting).toBe('response');
			expect(page.counts.waitingResponse).toBe(1);
		});

		it('…not one responded to in the current round (14)', () => {
			const decision = decisionOn(board);
			makeVersion(decision);
			makeResponse(join(decision, person), { round: 1 });

			expect(owedIds()).toEqual([]);
		});

		it('…not a survey answered in the current round: answered counts as responded (T51, card 2683)', () => {
			const decision = decisionOn(board);
			const question = db.insert(decisionSurveyQuestions).values({ decisionId: decision.id, position: 0, addedInVersion: 1 }).returning().get();
			makeVersion(decision, { surveyQuestions: [{ questionId: question.id, kind: 'text', prompt: 'Where from?', help: '', required: true }] });
			const participant = join(decision, person);
			expect(owedIds(), 'before the answer').toEqual([decision.id]);

			makeResponse(participant, { round: 1, kind: 'answered', answers: JSON.stringify({ [question.id]: 'Leeds.' }) });

			expect(owedIds()).toEqual([]);
			expect(register(pat, 'tab=waiting-response').counts.waitingResponse).toBe(0);
		});

		it('…one whose participant only objected and asked to talk, which is no response: nor does the reminder count it one (T48, card 2684)', () => {
			const decision = decisionOn(board);
			makeVersion(decision);
			const participant = join(decision, person);
			plantFlag(participant, { kind: 'objection', reason: 'I cannot live with this.' });
			plantFlag(participant, { kind: 'talk', reason: '' });

			expect(owedIds()).toEqual([decision.id]);
			expect(register(pat, 'tab=waiting-response').counts.waitingResponse).toBe(1);
			// R20: the closing-date reminder passes over only those `countedInRound` counts (card 2685), and it counts no flag.
			expect(countedInRound([{ participantId: participant.id, round: 1 }]).has(participant.id)).toBe(false);
		});

		it('…one answered only in an earlier round after an asks-again re-publish (15)', () => {
			const decision = decisionOn(board);
			makeVersion(decision);
			const participant = join(decision, person);
			makeResponse(participant, { round: 1 });
			makeVersion(decision, {}, { asksAgain: true });

			expect(owedIds()).toEqual([decision.id]);
		});

		it('…not an informed participation (16)', () => {
			join(decisionOn(board), person, { role: 'informed' });

			expect(owedIds()).toEqual([]);
		});

		it('…not one past its closing time (17)', () => {
			join(decisionOn(board, { closesAt: PAST }), person);

			expect(owedIds()).toEqual([]);
		});

		it('…not one the account no longer reaches (18)', () => {
			join(decisionOn(board), person);
			db.update(people).set({ status: 'left' }).where(eq(people.id, person.id)).run();

			expect(owedIds()).toEqual([]);
		});
	});

	it('holds the account-reach join to reachedParticipantOf for each of reachOf’s account branches (19)', () => {
		const board = makeBoard({ owner: makeUser() }).board;
		const branches = ['deleted', 'left', 'account not attached', 'address changed', 'reached'] as const;
		for (const branch of branches) {
			const account = makeUser();
			const person = personOf(account);
			const decision = decisionOn(board);
			const participant = join(decision, person);
			if (branch === 'deleted') sqlite.prepare('DELETE FROM people WHERE id = ?').run(person.id);
			if (branch === 'left') db.update(people).set({ status: 'left' }).where(eq(people.id, person.id)).run();
			if (branch === 'account not attached') db.update(people).set({ userId: null }).where(eq(people.id, person.id)).run();
			if (branch === 'address changed') db.update(people).set({ email: `moved-${person.email}` }).where(eq(people.id, person.id)).run();

			const listed = idsOf(register(account, 'tab=waiting-response')).includes(decision.id);
			expect(listed, branch).toBe(reachedParticipantOf(decision, participant.id) !== null);
			expect(listed, branch).toBe(branch === 'reached');
		}
	});

	describe('Waiting on me', () => {
		let dana: SessionUser;
		let board: Board;
		beforeEach(() => {
			dana = makeUser({ username: 'dana' });
			board = makeBoard({ owner: makeUser() }).board;
			addBoardMember(board, dana, 'editor');
		});

		it('holds the caller’s decisions stored closed and open past their time, oldest closing first; not one still open (20)', () => {
			const closed = decisionOn(board, { status: 'closed', decider: dana, closesAt: '2026-01-01 08:00:00' });
			const past = decisionOn(board, { decider: dana, closesAt: PAST });
			decisionOn(board, { decider: dana });

			const page = register(dana, 'tab=waiting-ruling');
			expect(idsOf(page)).toEqual([closed.id, past.id]);
			expect(page.counts.waitingRuling).toBe(2);
			expect(page.rows.every((row) => row.waiting === 'ruling')).toBe(true);
		});

		it('…not one whose board the decider can no longer edit (21)', () => {
			const elsewhere = makeBoard({ owner: makeUser() }).board;
			addBoardMember(elsewhere, dana, 'viewer');
			const lost = decisionOn(elsewhere, { status: 'closed', decider: dana });

			expect(idsOf(register(dana, 'tab=waiting-ruling'))).toEqual([]);
			expect(allIds(dana)).toEqual([lost.id]);
		});

		it('…one whose board is deleted (22)', () => {
			const gone = makeBoard({ owner: makeUser() }).board;
			const decision = decisionOn(gone, { status: 'closed', decider: dana });
			deleteBoard(gone);

			expect(idsOf(register(dana, 'tab=waiting-ruling'))).toEqual([decision.id]);
		});
	});

	describe('Open, Ruled and All', () => {
		let reader: SessionUser;
		let byStatus: Record<string, Decision>;
		beforeEach(() => {
			reader = makeUser();
			const board = makeBoard({ owner: reader }).board;
			byStatus = {
				draft: decisionOn(board, { status: 'draft' }),
				open: decisionOn(board),
				past: decisionOn(board, { closesAt: PAST }),
				closed: decisionOn(board, { status: 'closed' }),
				ruled: decisionOn(board, { status: 'ruled' }),
				superseded: decisionOn(board, { status: 'superseded' }),
				withdrawn: decisionOn(board, { status: 'withdrawn' })
			};
		});
		const idsFor = (...names: string[]) => sorted(names.map((name) => byStatus[name].id));

		it('Open selects open and awaiting_ruling (23)', () => {
			expect(sorted(idsOf(register(reader, 'tab=open')))).toEqual(idsFor('open', 'past', 'closed'));
		});

		it('Ruled selects ruled and superseded (24)', () => {
			expect(sorted(idsOf(register(reader, 'tab=ruled')))).toEqual(idsFor('ruled', 'superseded'));
		});

		it('All selects every status, and status narrows it (25)', () => {
			expect(sorted(idsOf(register(reader, 'tab=all')))).toEqual(sorted(Object.values(byStatus).map((d) => d.id)));
			expect(sorted(idsOf(register(reader, 'tab=all&status=awaiting_ruling')))).toEqual(idsFor('past', 'closed'));
			expect(sorted(idsOf(register(reader, 'tab=all&status=withdrawn')))).toEqual(idsFor('withdrawn'));
		});

		it('ignores status on every tab but All (26)', () => {
			expect(sorted(idsOf(register(reader, 'tab=open&status=ruled')))).toEqual(idsFor('open', 'past', 'closed'));
			expect(sorted(idsOf(register(reader, 'tab=ruled&status=withdrawn')))).toEqual(idsFor('ruled', 'superseded'));
		});
	});

	it('opens on Waiting for my response with a count above 0, else on Open (27)', () => {
		const board = makeBoard({ owner: makeUser() }).board;
		const [owing, free] = [makeUser(), makeUser()];
		addBoardMember(board, free, 'viewer');
		const decision = decisionOn(board);
		join(decision, personOf(owing));

		expect(register(owing).tab).toBe('waiting-response');
		expect(idsOf(register(owing))).toEqual([decision.id]);
		expect(register(free).tab).toBe('open');
		expect(idsOf(register(free))).toEqual([decision.id]);
	});
});

// ─── Filters, pages, limits ──────────────────────────────────────────────────

describe('the person filter', () => {
	let dana: SessionUser;
	let pat: SessionUser;
	let patPerson: Person;
	let A: Board;
	let B: Board;
	let C: Board;
	let d: Record<'mine' | 'other' | 'lost' | 'byLink' | 'draft', Decision>;
	beforeEach(() => {
		dana = makeUser({ username: 'dana' });
		pat = makeUser({ username: 'pat' });
		patPerson = personOf(pat, 'Pat Page');
		const olly = makeUser({ username: 'olly' });
		A = makeBoard({ owner: makeUser(), name: 'A' }).board;
		B = makeBoard({ owner: olly, name: 'B' }).board;
		C = makeBoard({ owner: makeUser(), name: 'C' }).board;
		addBoardMember(A, dana, 'editor');
		addBoardMember(B, dana, 'viewer');
		addBoardMember(C, dana, 'viewer');
		addBoardMember(A, pat, 'viewer');
		d = {
			mine: decisionOn(A, { decider: dana }),
			other: decisionOn(B, { decider: olly }),
			lost: decisionOn(C, { decider: dana }),
			byLink: decisionOn(A, { decider: dana }),
			draft: decisionOn(A, { status: 'draft', decider: dana })
		};
		join(d.mine, patPerson);
		join(d.other, patPerson);
		join(d.lost, patPerson);
		join(d.byLink, patPerson, { userId: null });
		join(d.draft, patPerson);
	});
	const filtered = (user: SessionUser, personId = patPerson.id) => sorted(idsOf(register(user, `tab=all&person=${personId}`)));

	it('administrator: every participation of the person (28)', () => {
		const admin = makeUser({ role: 'admin' });
		expect(filtered(admin)).toEqual(sorted([d.mine.id, d.other.id, d.lost.id, d.byLink.id]));
	});

	it('…decider: only decisions they decide with board edit, held to mayDo(…, record) (29)', () => {
		expect(filtered(dana)).toEqual(sorted([d.mine.id, d.byLink.id]));
		const recordable = allIds(dana)
			.map(decisionRow)
			.filter((row) => row.status !== 'draft' && mayDo(decisionAccess(dana, row), 'record', row))
			.map((row) => row.id);
		expect(filtered(dana)).toEqual(sorted(recordable));
	});

	it('…the person: only rows with person_id theirs and user_id the caller (30)', () => {
		// Their own rows, on any decision they may view; not the one given by personal link, nor the draft.
		expect(filtered(pat)).toEqual(sorted([d.mine.id, d.other.id, d.lost.id]));
		expect(allIds(pat)).toContain(d.byLink.id);
	});

	it('…anyone else, and a person who is not there: nothing, the same answer (31)', () => {
		const rae = makeUser({ username: 'rae' });
		addBoardMember(A, rae, 'viewer');
		addBoardMember(B, rae, 'viewer');
		expect(allIds(rae).length).toBeGreaterThan(0);

		expect(register(rae, `tab=all&person=${patPerson.id}`).rows).toEqual([]);
		expect(register(rae, 'tab=all&person=999999').rows).toEqual([]);
		expect(register(dana, 'tab=all&person=999999').rows).toEqual([]);
	});

	it('never matches a draft (32)', () => {
		const admin = makeUser({ role: 'admin' });
		expect(allIds(admin)).toContain(d.draft.id);
		expect(filtered(admin)).not.toContain(d.draft.id);
		expect(filtered(dana)).not.toContain(d.draft.id);
	});
});

describe('the board filter and select', () => {
	let rae: SessionUser;
	let A: Board;
	let B: Board;
	let onA: Decision;
	let onB: Decision;
	beforeEach(() => {
		rae = makeUser({ username: 'rae' });
		A = makeBoard({ owner: makeUser(), name: 'Alpha' }).board;
		B = makeBoard({ owner: makeUser(), name: 'Bravo' }).board;
		addBoardMember(A, rae, 'viewer');
		onA = decisionOn(A);
		onB = decisionOn(B);
		join(onB, personOf(rae));
	});

	it('narrows to one accessible board (33)', () => {
		expect(sorted(allIds(rae))).toEqual(sorted([onA.id, onB.id]));
		expect(idsOf(register(rae, `tab=all&board=${A.id}`))).toEqual([onA.id]);
	});

	it('matches nothing for a board the caller cannot open, as for an id of no board (34)', () => {
		const inaccessible = register(rae, `tab=all&board=${B.id}`);
		const none = register(rae, 'tab=all&board=999999');
		expect(inaccessible.rows).toEqual([]);
		expect(none.rows).toEqual([]);
		expect({ ...inaccessible, query: null }).toEqual({ ...none, query: null });
	});

	it('lists in the board select the accessible boards holding a visible decision, by current name, and no other (35)', () => {
		makeBoard({ owner: makeUser(), name: 'Public, empty', isPublic: true });
		const own = makeBoard({ owner: makeUser(), name: 'Draft only' }).board;
		addBoardMember(own, rae, 'editor');
		decisionOn(own, { status: 'draft' });
		renameBoard(A, 'Aardvark');

		const page = register(rae, 'tab=all');
		expect(page.boards).toEqual([{ id: A.id, name: 'Aardvark' }]);
		// The decision on B is listed, by the name kept and with no id, and B is not offered.
		expect(rowOf(page, onB.id).board).toEqual({ id: null, name: 'Bravo', gone: false });
	});
});

describe('the person select', () => {
	it('administrator: who answers at most 25 matching people; no who, no list (36)', () => {
		const admin = makeUser({ role: 'admin' });
		for (let i = 0; i < 30; i++) makePerson({ fullName: `Match ${String(i).padStart(2, '0')}` });
		makePerson({ fullName: 'Other' });

		const found = register(admin, 'who=match').people;
		expect(found).toHaveLength(25);
		expect(found.every((person) => person.name.startsWith('Match'))).toBe(true);
		expect(found.map((person) => person.name)).toEqual([...found.map((person) => person.name)].sort());
		expect(register(admin).people).toEqual([]);
		const other = db.select().from(people).where(eq(people.fullName, 'Other')).get()!;
		expect(register(admin, `person=${other.id}`).people).toEqual([{ id: other.id, name: 'Other' }]);
	});

	it('…decider: only people of their in-scope decisions match (37)', () => {
		const dana = makeUser({ username: 'dana' });
		const board = makeBoard({ owner: makeUser() }).board;
		addBoardMember(board, dana, 'editor');
		const pat = makePerson({ fullName: 'Pat Page' });
		const sam = makePerson({ fullName: 'Sam Same' });
		join(decisionOn(board, { decider: dana }), pat);
		join(decisionOn(board, { decider: makeUser() }), sam);
		join(decisionOn(board, { status: 'draft', decider: dana }), sam);

		expect(register(dana, 'who=a').people).toEqual([{ id: pat.id, name: 'Pat Page' }]);
		expect(register(dana, `person=${sam.id}`).people).toEqual([]);
	});

	it('…anyone else: only themselves (38)', () => {
		const rae = makeUser({ username: 'rae' });
		const own = personOf(rae, 'Rae Viewer');
		makePerson({ fullName: 'Ray Other' });

		expect(register(rae, 'who=ra').people).toEqual([{ id: own.id, name: 'Rae Viewer' }]);
		expect(register(rae, 'who=other').people).toEqual([]);
	});

	it('…decider: names and searches each person by the newest participation in scope, so a directory rename is not visible (code review S2)', () => {
		const dana = makeUser({ username: 'dana' });
		const board = makeBoard({ owner: makeUser() }).board;
		addBoardMember(board, dana, 'editor');
		const pat = makePerson({ fullName: 'Pat Page' });
		join(decisionOn(board, { decider: dana }), pat, { name: 'Pat Older' });
		join(decisionOn(board, { decider: dana }), pat, { name: 'Pat Page' });
		// A newer participation outside Dana's scope is not hers to be told of.
		join(decisionOn(board, { decider: makeUser() }), pat, { name: 'Pat Elsewhere' });
		db.update(people).set({ fullName: 'Patricia Renamed' }).where(eq(people.id, pat.id)).run();

		expect(register(dana, 'who=pat').people).toEqual([{ id: pat.id, name: 'Pat Page' }]);
		expect(register(dana, 'who=renamed').people).toEqual([]);
		expect(register(dana, 'who=elsewhere').people).toEqual([]);
		expect(register(dana, `person=${pat.id}`).people).toEqual([{ id: pat.id, name: 'Pat Page' }]);
		expect(JSON.stringify(register(dana, 'who=pat'))).not.toContain('Patricia');
		// The administrator is given the directory's name.
		expect(register(makeUser({ role: 'admin' }), 'who=renamed').people).toEqual([{ id: pat.id, name: 'Patricia Renamed' }]);
	});

	// Card 2843: SQLite's lower() folds A to Z alone, so a name beginning Ł was never found by its lower case.
	it.each(['administrator', 'decider'] as const)('…%s: who finds a name in any case of any letter (card 2843)', (branch) => {
		const caller = makeUser({ username: 'caller', ...(branch === 'administrator' ? { role: 'admin' as const } : {}) });
		const lukasz = makePerson({ fullName: 'Łukasz Øster' });
		if (branch === 'decider') {
			const board = makeBoard({ owner: makeUser() }).board;
			addBoardMember(board, caller, 'editor');
			join(decisionOn(board, { decider: caller }), lukasz);
		}

		expect(register(caller, `who=${encodeURIComponent('łukasz')}`).people).toEqual([{ id: lukasz.id, name: 'Łukasz Øster' }]);
	});

	it('gives the caller’s own person id for My record, and nobody else’s; null with no person (code review F1)', () => {
		const pat = makeUser({ username: 'pat' });
		const own = personOf(pat, 'Pat Page');
		makePerson({ fullName: 'Someone Else' });
		expect(register(pat).myPersonId).toBe(own.id);
		expect(register(makeUser()).myPersonId).toBeNull();
		expect(register(makeUser({ role: 'admin' })).myPersonId).toBeNull();
		// The link opens: their own record lets them in as themselves.
		expect(readPersonRecord(pat, own.id, { before: null }, UI).audience).toBe('self');
	});
});

describe('the title filter, the query and the pages', () => {
	it('matches the title case-insensitively, and %, _ and \' as text (39)', () => {
		const reader = makeUser();
		const board = makeBoard({ owner: reader }).board;
		const titled = Object.fromEntries(
			['Budget 50% cut', 'Budget 50 x', 'snake_case', 'snakeXcase', "Dana's call", 'Danas call', 'UPPER Case'].map((title) => [title, decisionOn(board, { title }).id])
		);
		const found = (q: string) => sorted(idsOf(register(reader, `tab=all&q=${encodeURIComponent(q)}`)));

		expect(found('50%')).toEqual([titled['Budget 50% cut']]);
		expect(found('_')).toEqual([titled['snake_case']]);
		expect(found("'")).toEqual([titled["Dana's call"]]);
		expect(found('upper case')).toEqual([titled['UPPER Case']]);
		expect(found('  budget  ')).toEqual(sorted([titled['Budget 50% cut'], titled['Budget 50 x']]));
	});

	// Card 2843: the title was lowered by SQLite (A to Z alone) and the text by JavaScript, so École was never found.
	it('matches a title in any case of any letter (card 2843)', () => {
		const reader = makeUser();
		const board = makeBoard({ owner: reader }).board;
		const ecole = decisionOn(board, { title: "École d'été" }).id;
		decisionOn(board, { title: "Ecole d'ete" });
		const found = (q: string) => idsOf(register(reader, `tab=all&q=${encodeURIComponent(q)}`));

		expect(found('école')).toEqual([ecole]);
		expect(found('ÉCOLE')).toEqual([ecole]);
	});

	it('fold_case: NULL is NULL and a number is unchanged (card 2843)', () => {
		expect(sqlite.prepare('SELECT fold_case(NULL) AS folded').get()).toEqual({ folded: null });
		expect(sqlite.prepare('SELECT fold_case(42) AS folded').get()).toEqual({ folded: 42 });
	});

	it('drops a malformed tab, status, board, person or before in page mode (40)', () => {
		const sent = new URLSearchParams({ tab: 'mine', status: 'closed', board: 'abc', person: '-1', before: '1.5', q: 'x'.repeat(201), who: ' ' });
		expect(registerQueryOf(sent, 'page')).toEqual({ tab: null, status: null, board: null, person: null, who: null, q: null, before: null });
		expect(registerQueryOf(new URLSearchParams('tab=ruled&status=ruled&board=2&person=3&before=4&q=%20a%20&who=b'), 'page')).toEqual({
			tab: 'ruled',
			status: 'ruled',
			board: 2,
			person: 3,
			who: 'b',
			q: 'a',
			before: 4
		});
	});

	it('…in API mode answers each with a 400 (41)', () => {
		for (const sent of ['tab=mine', 'status=closed', 'board=abc', 'person=-1', 'before=1.5', `q=${'x'.repeat(201)}`, `who=${'x'.repeat(101)}`]) {
			const refused = outcome(() => registerQueryOf(new URLSearchParams(sent), 'api'));
			expect(refused, sent).toMatchObject({ status: 400 });
		}
	});

	it('pages by 50 with before, newest first, no row twice, next null on the last (42)', () => {
		const reader = makeUser();
		const board = makeBoard({ owner: reader }).board;
		const made = Array.from({ length: 120 }, () => decisionOn(board).id);

		const first = register(reader, 'tab=all');
		expect(first.rows).toHaveLength(50);
		expect(idsOf(first)).toEqual([...made].reverse().slice(0, 50));
		expect(first.next).toBe(made[70]);
		const second = register(reader, `tab=all&before=${first.next}`);
		const third = register(reader, `tab=all&before=${second.next}`);
		expect(third.rows).toHaveLength(20);
		expect(third.next).toBeNull();
		expect(sorted([...idsOf(first), ...idsOf(second), ...idsOf(third)])).toEqual(sorted(made));
	});

	it('stops the waiting tabs at 200 and says so (43)', () => {
		const pat = makeUser({ username: 'pat' });
		const person = personOf(pat);
		for (let i = 0; i < 201; i++) {
			join(decisionOn(null), person);
			decisionOn(null, { status: 'closed', decider: pat });
		}

		const owed = register(pat, 'tab=waiting-response');
		expect(owed.rows).toHaveLength(200);
		expect(owed.capped).toBe(true);
		expect(owed.counts).toEqual({ waitingResponse: 201, waitingRuling: 201 });
		expect(owed.next).toBeNull();
		const ruling = register(pat, 'tab=waiting-ruling');
		expect(ruling.rows).toHaveLength(200);
		expect(ruling.capped).toBe(true);
	});
});

// ─── The person record ───────────────────────────────────────────────────────

describe('the person record', () => {
	let admin: SessionUser;
	let dana: SessionUser;
	let pat: SessionUser;
	let patPerson: Person;
	let board: Board;
	beforeEach(() => {
		admin = makeUser({ username: 'admin', role: 'admin' });
		dana = makeUser({ username: 'dana' });
		pat = makeUser({ username: 'pat' });
		patPerson = makePerson({ user: pat, fullName: 'Pat Page', jobTitle: 'Analyst', email: 'pat@example.test' });
		board = makeBoard({ owner: makeUser(), name: 'The board' }).board;
		addBoardMember(board, dana, 'editor');
		addBoardMember(board, pat, 'viewer');
	});

	/** A decision Dana decides, with Pat's participation: two responses (one replacing the other), a concern, an agent's draft answer and the events. */
	function fullParticipation(decision = decisionOn(board, { decider: dana })) {
		makeVersion(decision);
		const option = makeOption(decision, { label: 'A', addedInVersion: 1 });
		const participant = join(decision, patPerson, { jobTitle: 'Analyst then' });
		const first = makeResponse(participant, { kind: 'abstain' });
		makeResponse(participant, { kind: 'vote', optionId: option.id, replacesId: first.id, comment: 'A it is.' });
		makeResponse(participant, { kind: 'concern', comment: 'A worry.' });
		makeQuestion(decision, participant, { question: 'Why A?', answer: 'An agent’s draft.', agentDrafted: true });
		appendEvent({ decisionId: decision.id, kind: 'seen', participantId: participant.id, versionNumber: 1, detail: { stage: 'question', signedIn: { userId: pat.id, name: 'pat' } } }, SYSTEM_ACTOR);
		appendEvent({ decisionId: decision.id, kind: 'mail_outcome', participantId: participant.id, detail: { of: 1, mail: 'invited', delivered: true } }, SYSTEM_ACTOR);
		appendEvent({ decisionId: decision.id, kind: 'cut_off', participantId: participant.id }, SYSTEM_ACTOR);
		appendEvent({ decisionId: decision.id, kind: 'question_asked', participantId: participant.id, detail: { questionId: 1, notices: [] } }, SYSTEM_ACTOR);
		return { decision, participant, option };
	}

	/**
	 * Card 2683: a survey Dana decides, version 1 asking a choice, a scale and a written answer, and Pat's answers to
	 * it; then version 2 asking again, the choice question reworded and its choices reordered, and Pat's answer to that.
	 */
	function surveyedParticipation(decision = decisionOn(board, { decider: dana })) {
		const [choice, scale, text] = [0, 1, 2].map((position) => db.insert(decisionSurveyQuestions).values({ decisionId: decision.id, position, addedInVersion: 1 }).returning().get());
		const asked = [
			{ questionId: choice.id, kind: 'choice', prompt: 'Which depot?', help: '', required: false, choices: ['Leeds', 'York', 'Hull'] },
			{ questionId: scale.id, kind: 'scale', prompt: 'How urgent?', help: '', required: false, scale: { max: 5, lowLabel: 'Low', highLabel: 'High' } },
			{ questionId: text.id, kind: 'text', prompt: 'Anything else?', help: '', required: false }
		];
		makeVersion(decision, { surveyQuestions: asked }, { number: 1 });
		const participant = join(decision, patPerson);
		makeResponse(participant, { kind: 'answered', answers: JSON.stringify({ [text.id]: 'Tuesdays only.', [choice.id]: 0, [scale.id]: 4 }) });
		makeVersion(decision, { surveyQuestions: [{ ...asked[0], prompt: 'Which depot ships it now?', choices: ['Hull', 'Leeds', 'York'] }] }, { number: 2, asksAgain: true });
		makeResponse(participant, { kind: 'answered', round: 2, versionNumber: 2, answers: JSON.stringify({ [choice.id]: 0 }), createdAt: '2026-11-02 10:00:00' });
		return { decision, participant };
	}
	/** What a person record shows of `surveyedParticipation`'s two responses: each answer by its prompt as that version asked it. */
	const SURVEY_SHOWN = [
		[
			1,
			[
				{ prompt: 'Which depot?', kind: 'choice', choice: 'Leeds' },
				{ prompt: 'How urgent?', kind: 'scale', value: 4, max: 5 },
				{ prompt: 'Anything else?', kind: 'text', text: 'Tuesdays only.' }
			]
		],
		[2, [{ prompt: 'Which depot ships it now?', kind: 'choice', choice: 'Hull' }]]
	];

	it('T50 (card 2683). gives the person their own answers, each by its prompt as published in the version they answered', () => {
		surveyedParticipation();

		const read = personRecord(pat, patPerson.id);

		expect(read.audience).toBe('self');
		expect(read.participations[0].responses.map((response) => [response.versionNumber, response.answers])).toEqual(SURVEY_SHOWN);
	});

	it('T66 (card 2683). gives the decider and an administrator the answers in the person record', () => {
		surveyedParticipation();

		for (const [who, reader] of [['the decider', dana], ['an administrator', admin]] as const) {
			const [only] = privileged(personRecord(reader, patPerson.id));
			expect(only.responses.map((response) => [response.versionNumber, response.answers]), who).toEqual(SURVEY_SHOWN);
		}
	});

	it('T66 (card 2683). gives an author who is not the decider no answer: no person record, no results, and none on the page', () => {
		const author = makeUser({ username: 'author' });
		addBoardMember(board, author, 'editor');
		const { decision } = surveyedParticipation(decisionOn(board, { author, decider: dana }));

		expect(outcome(() => personRecord(author, patPerson.id))).toEqual({ status: 404, message: 'Person not found' });
		expect(outcome(() => readResults(author, decision.id, UI))).toEqual({ status: 403, message: 'You cannot read the results of this decision' });
		const page = JSON.stringify(readDecisionPage(author, decision.id));
		for (const answer of ['Tuesdays only.', '"answers"']) expect(page, answer).not.toContain(answer);
	});

	it('T47 (card 2684). shows the flags with their replies to the person, the decider of that decision and an administrator, not to a decider of another, and of a removed participation only the replies given up to the removal', () => {
		const decision = decisionOn(board, { decider: dana });
		makeVersion(decision);
		const participant = join(decision, patPerson);
		plantFlag(participant, { kind: 'objection', reason: 'Too dear.', via: 'link', reply: 'Covered.', repliedAt: '2026-11-02 11:00:00' });
		plantFlag(participant, { kind: 'talk', reason: '' });
		const own = [
			{ kind: 'objection', reason: 'Too dear.', raisedAt: '2026-11-02 09:00:00', versionNumber: 1, reply: 'Covered.', repliedAt: '2026-11-02 11:00:00' },
			{ kind: 'talk', reason: '', raisedAt: '2026-11-02 09:00:00', versionNumber: 1, reply: null, repliedAt: null }
		];

		// The person: their own, with the replies, and no replier.
		const [mine] = personRecord(pat, patPerson.id).participations;
		expect(mine.flags).toEqual(own);
		// The decider of the decision and an administrator: how each was raised, and who replied by name alone.
		for (const [who, reader] of [
			['the decider', dana],
			['an administrator', admin]
		] as const) {
			const [only] = privileged(personRecord(reader, patPerson.id));
			expect(only.flags, who).toEqual([
				{ ...own[0], via: 'link', repliedByName: 'dana' },
				{ ...own[1], via: 'session', repliedByName: null }
			]);
		}
		// A decider of another decision of the person's: that one alone, and none of these flags.
		const other = makeUser({ username: 'other' });
		addBoardMember(board, other, 'editor');
		const theirs = decisionOn(board, { decider: other });
		join(theirs, patPerson);
		const read = privileged(personRecord(other, patPerson.id));
		expect(read.map((p) => p.decision.id)).toEqual([theirs.id]);
		expect(read[0].flags).toEqual([]);
		expect(JSON.stringify(read)).not.toContain('Too dear.');

		// Removed from a decision they may no longer view: a reply given before the removal, and not one given after (S-M2).
		const sam = makeUser({ username: 'sam' });
		const samPerson = personOf(sam, 'Sam Same');
		const B = makeBoard({ owner: makeUser(), name: 'Board B' }).board;
		// Published, as a decision that takes flags is: the reader keeps only a flag on a version the decision has (C-S-L3).
		const goneDecision = decisionOn(B, { decider: dana });
		makeVersion(goneDecision);
		const gone = join(goneDecision, samPerson, { removedAt: '2026-11-02 10:30:00' });
		plantFlag(gone, { kind: 'objection', reason: 'Before?', reply: 'In time.', repliedAt: '2026-11-02 10:15:00' });
		plantFlag(gone, { kind: 'talk', reason: 'After?', reply: 'Too late.', repliedAt: '2026-11-02 11:00:00' });
		const [removed] = personRecord(sam, samPerson.id).participations;
		expect(removed.kind).toBe('removed');
		expect(removed.flags.map((flag) => [flag.reason, flag.reply, flag.repliedAt])).toEqual([
			['Before?', 'In time.', '2026-11-02 10:15:00'],
			['After?', null, null]
		]);
		expect(JSON.stringify(removed)).not.toContain('Too late.');
		// Removed from one they may still view, as a board reader: the same rule (R11).
		sqlite.prepare("UPDATE decision_participants SET removed_at = '2026-11-02 10:30:00' WHERE id = ?").run(participant.id);
		const still = personRecord(pat, patPerson.id).participations.find((p) => p.kind === 'full' && p.decision.id === decision.id)!;
		expect(still.flags.map((flag) => flag.reply)).toEqual([null, null]);
	});

	it('gives an administrator every opened participation: every response with replaced ones, privileged questions with an agent’s draft, concerns, every event kind, and the address (44)', () => {
		const { decision } = fullParticipation();
		const other = decisionOn(makeBoard({ owner: makeUser() }).board);
		join(other, patPerson);

		const read = personRecord(admin, patPerson.id);
		expect(read.audience).toBe('admin');
		expect(read.person).toEqual({ name: 'Pat Page', jobTitle: 'Analyst', groups: [], email: 'pat@example.test', status: 'active' });
		expect(read.participations.map((p) => p.kind === 'full' && p.decision.id)).toEqual([other.id, decision.id]);
		const mine = privileged(read)[1];
		expect(mine.responses.map((r) => ({ kind: r.kind, option: r.option, current: r.current, via: r.via }))).toEqual([
			{ kind: 'abstain', option: null, current: false, via: 'session' },
			{ kind: 'vote', option: 'A', current: true, via: 'session' }
		]);
		expect(mine.questions).toHaveLength(1);
		expect(mine.questions[0]).toMatchObject({ question: 'Why A?', askerName: 'Pat Page', draft: { text: 'An agent’s draft.' }, answer: null });
		expect(mine.concerns).toEqual([{ comment: 'A worry.', createdAt: expect.any(String) }]);
		expect(mine.events.map((e) => e.kind)).toEqual(['included', 'seen', 'mail_outcome', 'cut_off', 'question_asked']);
		expect(mine.events[1].detail).toEqual({ stage: 'question', signedIn: { name: 'pat' } });
		expect(mine.jobTitle).toBe('Analyst then');
	});

	it('gives a decider only participations on decisions they decide with record; no address; the header from the snapshot (45)', () => {
		const { decision } = fullParticipation();
		join(decisionOn(board, { decider: makeUser() }), patPerson);
		const elsewhere = makeBoard({ owner: makeUser() }).board;
		addBoardMember(elsewhere, dana, 'viewer');
		join(decisionOn(elsewhere, { decider: dana }), patPerson);

		const read = personRecord(dana, patPerson.id);
		expect(read.audience).toBe('decider');
		expect(read.person).toEqual({ name: 'Pat Page', jobTitle: 'Analyst then', status: 'active' });
		expect(read.participations.map((p) => p.kind === 'full' && p.decision.id)).toEqual([decision.id]);
		expect(JSON.stringify(read)).not.toContain('pat@example.test');
		const [only] = privileged(read);
		expect(only.events.find((e) => e.kind === 'seen')!.detail).toEqual({ stage: 'question' });
	});

	describe('the person themselves', () => {
		it('is given their own questions from the rows, one whose question_asked event is decider-only among them (46)', () => {
			const decision = decisionOn(board, { decider: dana });
			const participant = join(decision, patPerson);
			makeQuestion(decision, participant, { question: 'Mine?', answer: 'Yes.', by: dana });
			appendEvent({ decisionId: decision.id, kind: 'question_asked', participantId: participant.id, detail: { questionId: 1, notices: [] } }, SYSTEM_ACTOR);

			const read = personRecord(pat, patPerson.id);
			expect(read.audience).toBe('self');
			const [mine] = read.participations;
			expect(mine.questions).toEqual([
				{
					question: 'Mine?',
					askedInVersion: 1,
					own: true,
					askedAt: '2026-11-02 10:00:00',
					answer: { text: 'Yes.', answererName: 'dana', answererRole: 'decider', answeredAt: '2026-11-02 11:00:00', agentDrafted: false },
					closedUnanswered: null
				}
			]);
			expect(mine.events.map((e) => e.kind)).not.toContain('question_asked');
		});

		it('is not shown an unpublished agent draft (47)', () => {
			const decision = decisionOn(board, { decider: dana });
			makeQuestion(decision, join(decision, patPerson), { answer: 'A draft.', agentDrafted: true });

			const [mine] = personRecord(pat, patPerson.id).participations;
			expect(mine.questions).toHaveLength(1);
			expect(mine.questions[0].answer).toBeNull();
			expect(JSON.stringify(mine)).not.toContain('A draft.');
		});

		it('is given only OWN_RECORD_EVENTS, with no actor’s name and no cut_off (48)', () => {
			fullParticipation();

			const [mine] = personRecord(pat, patPerson.id).participations;
			expect(mine.events).toEqual([
				{ kind: 'included', at: expect.any(String), versionNumber: null },
				{ kind: 'seen', at: expect.any(String), versionNumber: 1, stage: 'question' }
			]);
			expect(JSON.stringify(mine)).not.toContain('DumpFire');
			expect(mine.responses.every((r) => !('via' in r))).toBe(true);
		});

		it('is given closesAt null once ruled (49)', () => {
			const decision = decisionOn(board, { decider: dana, closesAt: PAST });
			join(decision, patPerson);
			makeRuling(decision);

			const [mine] = personRecord(pat, patPerson.id).participations;
			expect(mine.kind === 'full' && mine.decision).toMatchObject({ shownStatus: 'ruled', closesAt: null });
		});

		it('is not shown a row with user_id theirs and another person_id, nor a row of their person with another user_id (50)', () => {
			const decision = decisionOn(board);
			const mine = decisionOn(board);
			join(mine, patPerson);
			join(decision, makePerson({ fullName: 'Someone Else' }), { userId: pat.id });
			join(decisionOn(board), patPerson, { userId: dana.id });

			expect(personRecord(pat, patPerson.id).participations.map((p) => p.kind === 'full' && p.decision.id)).toEqual([mine.id]);
		});

		it('is not shown a participation by personal link after their person is linked to an account; the administrator is (51)', () => {
			const lin = makePerson({ fullName: 'Lin Link' });
			const decision = decisionOn(board);
			join(decision, lin);
			const linAccount = makeUser({ username: 'lin' });
			db.update(people).set({ userId: linAccount.id }).where(eq(people.id, lin.id)).run();

			expect(personRecord(linAccount, lin.id)).toMatchObject({ audience: 'self', participations: [] });
			expect(personRecord(admin, lin.id).participations).toHaveLength(1);
		});

		it('is given, of a removed participation they may no longer view, its moments, own responses and concerns, and answers given up to the removal; no id, title, status, board or closing time (52)', () => {
			const sam = makeUser({ username: 'sam' });
			const samPerson = personOf(sam, 'Sam Same');
			const B = makeBoard({ owner: makeUser(), name: 'Board B' }).board;
			const decision = decisionOn(B, { title: 'A secret title' });
			const participant = join(decision, samPerson, { removedAt: '2026-11-02 10:30:00' });
			appendEvent({ decisionId: decision.id, kind: 'seen', participantId: participant.id, versionNumber: 1, detail: { stage: 'question' } }, SYSTEM_ACTOR);
			appendEvent({ decisionId: decision.id, kind: 'removed', participantId: participant.id }, SYSTEM_ACTOR);
			makeResponse(participant, { kind: 'abstain', comment: 'My own words.' });
			makeQuestion(decision, participant, { question: 'Before?', answer: 'In time.', answeredAt: '2026-11-02 10:15:00' });
			makeQuestion(decision, participant, { question: 'After?', answer: 'Too late.', answeredAt: '2026-11-02 11:00:00' });
			db.update(decisions).set({ status: 'withdrawn' }).where(eq(decisions.id, decision.id)).run();

			const read = personRecord(sam, samPerson.id);
			expect(read.participations).toHaveLength(1);
			const [removed] = read.participations;
			expect(removed.kind).toBe('removed');
			// Card 2684 (R11): and their own flags.
			expect(Object.keys(removed).sort()).toEqual(['concerns', 'events', 'flags', 'includedAt', 'kind', 'questions', 'removedAt', 'responses']);
			expect(removed.events.map((e) => e.kind)).toEqual(['included', 'removed']);
			expect(removed.responses.map((r) => r.comment)).toEqual(['My own words.']);
			expect(removed.questions.map((q) => [q.question, q.answer?.text ?? null, q.closedUnanswered])).toEqual([
				['Before?', 'In time.', null],
				['After?', null, null]
			]);
			const text = JSON.stringify(read);
			for (const word of ['A secret title', 'Board B', 'withdrawn', 'Too late.']) expect(text).not.toContain(word);
		});

		it('is given a live participation they may not open in the limited shape, with removedAt null, never as removed (code review F4)', () => {
			const B = makeBoard({ owner: makeUser(), name: 'Board B' }).board;
			const decision = decisionOn(B, { title: 'Two rows on one account' });
			const participant = join(decision, patPerson);
			// A second live row on Pat's account: the participant role needs exactly one, so Pat may not view it.
			join(decision, null, { userId: pat.id });
			makeResponse(participant, { kind: 'abstain', comment: 'Said before.' });

			const [limited] = personRecord(pat, patPerson.id).participations;
			expect(limited).toMatchObject({ kind: 'removed', removedAt: null });
			expect(Object.keys(limited).sort()).toEqual(['concerns', 'events', 'flags', 'includedAt', 'kind', 'questions', 'removedAt', 'responses']);
			expect(limited.responses.map((r) => r.comment)).toEqual(['Said before.']);
			const text = JSON.stringify(limited);
			for (const word of ['Two rows on one account', 'Board B']) expect(text).not.toContain(word);
		});

		it('is given in full a removed participation they may still view, as a board reader (53)', () => {
			const decision = decisionOn(board, { title: 'Still readable' });
			join(decision, patPerson, { removedAt: '2026-11-02 10:30:00' });

			const [removed] = personRecord(pat, patPerson.id).participations;
			expect(removed).toMatchObject({ kind: 'full', decision: { id: decision.id, title: 'Still readable' }, removedAt: '2026-11-02 10:30:00' });
		});
	});

	it('answers 404 Person not found, the same answer, for a person who is not there, a deleted person, and a caller with no audience (54)', () => {
		const gone = makePerson({ fullName: 'Gone Person' });
		const goneId = gone.id;
		join(decisionOn(board, { decider: dana }), gone);
		sqlite.prepare('DELETE FROM people WHERE id = ?').run(goneId);
		const rae = makeUser({ username: 'rae' });
		addBoardMember(board, rae, 'viewer');
		join(decisionOn(board), patPerson);
		const notFound = { status: 404, message: 'Person not found' };

		expect(outcome(() => personRecord(admin, 999_999))).toEqual(notFound);
		expect(outcome(() => personRecord(admin, goneId))).toEqual(notFound);
		expect(outcome(() => personRecord(dana, goneId))).toEqual(notFound);
		expect(outcome(() => personRecord(rae, patPerson.id))).toEqual(notFound);
		expect(outcome(() => personRecord(rae, 999_999))).toEqual(notFound);
		expect(outcome(() => personRecord(rae, 0))).toEqual(notFound);
		expect(outcome(() => personRecord(rae, 1.5))).toEqual(notFound);
	});

	it('answers 404 to a decider whose only participation of the person is on a draft (55)', () => {
		join(decisionOn(board, { status: 'draft', decider: dana }), patPerson);

		expect(outcome(() => personRecord(dana, patPerson.id))).toEqual({ status: 404, message: 'Person not found' });
	});

	it('puts a draft’s participation in nobody’s person record, the administrator’s included (56)', () => {
		join(decisionOn(board, { status: 'draft', decider: dana }), patPerson);
		// A draft withdrawn before it was ever opened holds no record either.
		join(makeDecision({ board, status: 'withdrawn', decider: dana }), patPerson);

		expect(personRecord(admin, patPerson.id).participations).toEqual([]);
		expect(personRecord(pat, patPerson.id).participations).toEqual([]);
	});

	it('pages by 25 with before; gives 200 events a participation, then says more are in the record (57)', () => {
		const made = Array.from({ length: 30 }, () => join(decisionOn(board, { decider: dana }), patPerson));
		const busy = made[29];
		for (let i = 0; i < 200; i++) appendEvent({ decisionId: busy.decisionId, kind: 'seen', participantId: busy.id, versionNumber: 1, detail: { stage: 'question' } }, SYSTEM_ACTOR);

		const first = personRecord(admin, patPerson.id);
		expect(first.participations).toHaveLength(25);
		expect(first.next).toBe(made[5].id);
		const [top, below] = privileged(first);
		expect(top.events).toHaveLength(200);
		expect(top.moreEvents).toBe(true);
		expect(below.moreEvents).toBe(false);
		const second = personRecord(admin, patPerson.id, first.next);
		expect(second.participations).toHaveLength(5);
		expect(second.next).toBeNull();
		expect(personRecord(pat, patPerson.id).participations[0]).toMatchObject({ kind: 'full', moreEvents: false });
	});

	it('reads a page in as many queries for eight participations as for two, for each audience (code review F2)', () => {
		/** Pat's participations on `n` decisions Dana decides, each with a response, a concern, a question, an answer and events; one Pat may not view. */
		function participations(n: number) {
			resetDb();
			admin = makeUser({ username: 'admin', role: 'admin' });
			dana = makeUser({ username: 'dana' });
			pat = makeUser({ username: 'pat' });
			patPerson = makePerson({ user: pat, fullName: 'Pat Page' });
			board = makeBoard({ owner: makeUser() }).board;
			addBoardMember(board, dana, 'editor');
			addBoardMember(board, pat, 'viewer');
			const hidden = makeBoard({ owner: makeUser() }).board;
			addBoardMember(hidden, dana, 'editor');
			for (let i = 0; i < n; i++) {
				const decision = decisionOn(i === 0 ? hidden : board, { decider: dana });
				makeVersion(decision);
				const option = makeOption(decision, { label: 'A', addedInVersion: 1 });
				const participant = join(decision, patPerson, i === 0 ? { removedAt: '2026-11-02 10:30:00' } : {});
				makeResponse(participant, { kind: 'vote', optionId: option.id });
				makeResponse(participant, { kind: 'concern', comment: 'A worry.' });
				makeQuestion(decision, participant, { question: `Why ${i}?`, answer: 'Because.', by: dana });
				appendEvent({ decisionId: decision.id, kind: 'seen', participantId: participant.id, versionNumber: 1, detail: { stage: 'question' } }, SYSTEM_ACTOR);
			}
		}
		const queriesOf = (read: () => PersonRecord): { queries: number; shown: number } => {
			const prepare = vi.spyOn(sqlite, 'prepare');
			try {
				const shown = read().participations.length;
				return { queries: prepare.mock.calls.length, shown };
			} finally {
				prepare.mockRestore();
			}
		};
		const counts = (n: number) => {
			participations(n);
			return [admin, dana, pat].map((reader) => queriesOf(() => personRecord(reader, patPerson.id)));
		};

		const two = counts(2);
		const eight = counts(8);
		expect(two.map((c) => c.shown)).toEqual([2, 2, 2]);
		expect(eight.map((c) => c.shown)).toEqual([8, 8, 8]);
		expect(eight.map((c) => c.queries)).toEqual(two.map((c) => c.queries));
	});
});

// ─── The record view ─────────────────────────────────────────────────────────

describe('the record view', () => {
	let admin: SessionUser;
	let dana: SessionUser;
	let board: Board;
	beforeEach(() => {
		admin = makeUser({ username: 'admin', role: 'admin' });
		dana = makeUser({ username: 'dana' });
		board = makeBoard({ owner: makeUser() }).board;
		addBoardMember(board, dana, 'editor');
	});

	it('gives an administrator and the decider every event oldest first, the decider-only kinds included (58)', () => {
		const decision = decisionOn(board, { decider: dana });
		const participant = join(decision, makePerson({ fullName: 'Pat Page' }));
		for (const kind of DECIDER_ONLY_EVENTS) appendEvent({ decisionId: decision.id, kind, ...(kind === 'cut_off' ? { participantId: participant.id } : {}) }, SYSTEM_ACTOR);

		for (const reader of [admin, dana]) {
			const read = record(reader, decision.id);
			expect(read.entries.map((e) => e.kind)).toEqual(['included', ...DECIDER_ONLY_EVENTS]);
			expect(read.entries[0]).toEqual({
				kind: 'included',
				at: expect.any(String),
				versionNumber: null,
				participant: 'Pat Page',
				actor: { name: 'DumpFire', source: 'system' },
				detail: { role: 'consulted', hadAccount: false }
			});
			expect(read.participants).toEqual([{ id: participant.id, name: 'Pat Page', personId: participant.personId }]);
			expect(read.next).toBeNull();
		}
	});

	it('gives each participant’s person id, for a link to their record, to the record’s readers, who may open it; none on a draft, none for one by address alone (code review F1)', () => {
		const decision = decisionOn(board, { decider: dana });
		const pat = makePerson({ fullName: 'Pat Page' });
		const patRow = join(decision, pat);
		const byAddress = join(decision, null, { name: 'Ann Address' });

		for (const reader of [admin, dana]) {
			const read = record(reader, decision.id);
			expect(read.participants).toEqual([
				{ id: byAddress.id, name: 'Ann Address' },
				{ id: patRow.id, name: 'Pat Page', personId: pat.id }
			]);
			// The link it gives opens: the reader's person record of Pat lets them in.
			expect(outcome(() => readPersonRecord(reader, pat.id, { before: null }, UI))).toBe('passed');
		}

		const draft = decisionOn(board, { status: 'draft', decider: dana });
		join(draft, pat);
		expect(record(dana, draft.id).participants.every((p) => !('personId' in p))).toBe(true);
		// A draft withdrawn before it was opened gives none either: no person record holds it.
		const neverOpened = makeDecision({ board, status: 'withdrawn', decider: dana });
		join(neverOpened, makePerson({ fullName: 'Lin Late' }));
		expect(record(dana, neverOpened.id).participants.every((p) => !('personId' in p))).toBe(true);
	});

	it('narrows to one participant; a participant of another decision is 404 (59)', () => {
		const decision = decisionOn(board, { decider: dana });
		const pat = join(decision, makePerson({ fullName: 'Pat Page' }));
		join(decision, makePerson({ fullName: 'Lin Link' }));
		const elsewhere = join(decisionOn(board), makePerson());

		const read = record(dana, decision.id, { participant: pat.id });
		expect(read.entries.map((e) => e.participant)).toEqual(['Pat Page']);
		expect(read.participant).toBe(pat.id);
		expect(read.participants.map((p) => p.name)).toEqual(['Lin Link', 'Pat Page']);
		expect(outcome(() => record(dana, decision.id, { participant: elsewhere.id }))).toEqual({ status: 404, message: 'Participant not found' });
	});

	it('pages by 500 with after (60)', () => {
		const decision = decisionOn(board, { decider: dana });
		for (let i = 0; i < 501; i++) appendEvent({ decisionId: decision.id, kind: 'closed' }, SYSTEM_ACTOR);

		const first = record(dana, decision.id);
		expect(first.entries).toHaveLength(500);
		const second = record(dana, decision.id, { after: first.next! });
		expect(second.entries).toHaveLength(1);
		expect(second.next).toBeNull();
		expect(first.next).toBe(recordEventsOf(decision.id, { limit: 500 })[499].id);
	});

	it('requires readRecord’s limit, capped at RECORD_READ_MAX: 0 or past the cap throws (61)', () => {
		const decision = decisionOn(board, { decider: dana });
		for (const limit of [0, -1, 1.5, RECORD_READ_MAX + 1, Number.NaN]) expect(() => record(dana, decision.id, {}, limit), String(limit)).toThrow(/limit/);
		expect(record(dana, decision.id, {}, RECORD_READ_MAX).entries).toEqual([]);
		expect(record(dana, decision.id, {}, 1).entries).toEqual([]);
	});

	it('gives address_changed’s from and to to the administrator alone (62)', () => {
		const decision = decisionOn(board, { decider: dana });
		const participant = join(decision, makePerson());
		appendEvent({ decisionId: decision.id, kind: 'address_changed', participantId: participant.id, detail: { from: 'old@example.test', to: 'new@example.test' } }, SYSTEM_ACTOR);

		expect(record(admin, decision.id).entries.at(-1)!.detail).toEqual({ from: 'old@example.test', to: 'new@example.test' });
		expect(record(dana, decision.id).entries.at(-1)!.detail).toEqual({});
	});

	describe('each kind’s detail', () => {
		/** Every writer's full detail shape (the plan's section 4.3 table), the ids it holds among it. */
		function storedDetails(other: Decision, optionId: number): Record<EventKind, Record<string, unknown> | null> {
			const signedIn = { userId: 3, name: 'Pat' };
			return {
				created: { decider: 'Dana', supersedes: other.id },
				decider_changed: { fromUserId: 1, fromName: 'Ann', toUserId: 2, toName: 'Bob' },
				published: { asksAgain: true, changeNote: 'A change' },
				opened: { closesAt: FUTURE },
				included: { role: 'consulted', hadAccount: true },
				re_included: { role: 'informed', hadAccount: false },
				role_changed: { from: 'consulted', to: 'informed' },
				removed: null,
				link_issued: { replaced: true },
				link_revoked: { reason: 'restore' },
				invited: { resend: true },
				asked_again: { resend: true },
				told_of_change: null,
				told_withdrawn: { resend: true },
				told_ruling: null,
				mail_skipped: { mail: 'invited', reason: 'left' },
				mail_outcome: { of: 12, mail: 'invited', delivered: false, problem: 'refused' },
				closed: null,
				extended: { from: PAST, to: FUTURE },
				withdrawn: { reason: 'No longer needed' },
				account_attached: { userId: 5 },
				account_cleared: { userId: 5 },
				address_changed: { from: 'old@example.test', to: 'new@example.test' },
				dry_run: {},
				seen: { stage: 'question', signedIn },
				responded: { responseId: 9, statement: 2, signedIn },
				ruled: { optionId, early: true, againstResponses: true, productOwnerUserId: 4, supersededOld: false },
				// Card 2738: whether the round's request ever reached them.
				cut_off: { reached: false },
				superseded: { byDecisionId: other.id },
				results_released: { upToResponseId: 9, omitted: [{ responseId: 9, field: 'comment' }, 'not an object'] },
				concern_raised: { responseId: 9, notice: 'sent', signedIn },
				question_asked: { questionId: 1, notices: [{ userId: 2, outcome: 'sent' }], signedIn },
				question_answered: { questionId: 1, role: 'decider', agentDrafted: false, notice: 'asked' },
				answer_published: { questionId: 1, notice: 'asked' },
				answer_replaced: { questionId: 1, role: 'author', discarded: { text: 'The draft', byName: 'Agent', at: PAST, userId: 6 }, notice: 'asked' },
				// Card 2685: no detail is written.
				reminded: null,
				// Card 2684 (R6, R7): a raise names its flag and the notice's outcome, a link holder's signed-in browser too; a reply its flag and notice.
				objection_raised: { flagId: 1, notice: 'asked', signedIn },
				talk_requested: { flagId: 2, notice: 'held', signedIn },
				objection_answered: { flagId: 1, notice: 'sent' },
				talk_outcome: { flagId: 2, notice: 'not_reached' }
			};
		}

		it('shows, for every kind with its writer’s full detail and a planted nested object at each value key, no key ending in Id at any depth, only the keys the table names, and no planted object (63)', () => {
			const decision = decisionOn(board, { decider: dana });
			const other = decisionOn(board);
			const option = makeOption(decision, { label: 'B' });
			const details = storedDetails(other, option.id);
			for (const kind of EVENT_KINDS) {
				appendEvent({ decisionId: decision.id, kind, detail: details[kind] }, SYSTEM_ACTOR);
				const planted = Object.fromEntries(
					Object.entries(RECORD_DETAIL[kind])
						.filter(([, rule]) => rule === 'value' || rule === 'admin')
						.map(([key]) => [key, { planted: { deepUserId: 1 } }])
				);
				appendEvent({ decisionId: decision.id, kind, detail: { ...(details[kind] ?? {}), ...planted } }, SYSTEM_ACTOR);
			}

			const entries = record(admin, decision.id).entries;
			expect(entries).toHaveLength(EVENT_KINDS.length * 2);
			for (const [i, entry] of entries.entries()) {
				const kind = entry.kind as EventKind;
				expect(keysDeep(entry).filter((key) => /Id$/.test(key)), kind).toEqual([]);
				expect(Object.keys(entry.detail).every((key) => Object.hasOwn(RECORD_DETAIL[kind], key)), kind).toBe(true);
				if (i % 2 === 1) expect(JSON.stringify(entry.detail), kind).not.toContain('planted');
			}
			const shown = (kind: EventKind) => entries.find((entry) => entry.kind === kind)!.detail;
			expect(shown('ruled')).toEqual({ option: 'B', early: true, againstResponses: true, supersededOld: false });
			expect(shown('cut_off')).toEqual({ reached: false });
			expect(shown('results_released')).toEqual({ omitted: [{ field: 'comment' }] });
			expect(shown('question_asked')).toEqual({ signedIn: { name: 'Pat' } });
			expect(shown('mail_outcome')).toEqual({ mail: 'invited', delivered: false, problem: 'refused' });
			expect(shown('decider_changed')).toEqual({ fromName: 'Ann', toName: 'Bob' });
			expect(shown('answer_replaced')).toEqual({ role: 'author', discarded: { text: 'The draft', byName: 'Agent', at: PAST } });
			expect(shown('account_attached')).toEqual({});
			expect(shown('created')).toEqual({ decider: 'Dana', supersedes: { id: other.id, title: other.title } });
			expect(shown('superseded')).toEqual({ by: { id: other.id, title: other.title } });
			// Card 2684 (R16): a flag's id is never shown.
			expect(shown('objection_raised')).toEqual({ notice: 'asked', signedIn: { name: 'Pat' } });
			expect(shown('talk_outcome')).toEqual({ notice: 'not_reached' });
		});

		it('gives cut_off’s reached to the decider and the administrator alike, and nothing for one recorded before card 2738 (card 2738)', () => {
			const decision = decisionOn(board, { decider: dana });
			const participant = join(decision, makePerson());
			appendEvent({ decisionId: decision.id, kind: 'cut_off', participantId: participant.id, detail: { reached: false } }, SYSTEM_ACTOR);
			appendEvent({ decisionId: decision.id, kind: 'cut_off', participantId: participant.id }, SYSTEM_ACTOR);

			for (const reader of [dana, admin]) {
				expect(record(reader, decision.id).entries.slice(-2).map((e) => e.detail), reader.username).toEqual([{ reached: false }, {}]);
			}
		});

		it('gives signedIn to the administrator, and not to the decider (64)', () => {
			const decision = decisionOn(board, { decider: dana });
			const participant = join(decision, makePerson());
			appendEvent({ decisionId: decision.id, kind: 'responded', participantId: participant.id, detail: { responseId: 1, statement: 2, signedIn: { userId: 9, name: 'Signed In' } } }, SYSTEM_ACTOR);

			expect(record(admin, decision.id).entries.at(-1)!.detail).toEqual({ statement: 2, signedIn: { name: 'Signed In' } });
			expect(record(dana, decision.id).entries.at(-1)!.detail).toEqual({ statement: 2 });
		});

		it('names the other decision of created.supersedes and superseded.by to a viewer who may view it, and nothing to one who may not (65)', () => {
			const decision = decisionOn(board, { decider: dana });
			const hidden = decisionOn(makeBoard({ owner: makeUser() }).board, { title: 'Hidden decision' });
			appendEvent({ decisionId: decision.id, kind: 'created', detail: { decider: 'dana', supersedes: hidden.id } }, SYSTEM_ACTOR);
			appendEvent({ decisionId: decision.id, kind: 'superseded', detail: { byDecisionId: hidden.id } }, SYSTEM_ACTOR);

			expect(record(admin, decision.id).entries.map((e) => e.detail)).toEqual([
				{ decider: 'dana', supersedes: { id: hidden.id, title: 'Hidden decision' } },
				{ by: { id: hidden.id, title: 'Hidden decision' } }
			]);
			const forDana = record(dana, decision.id);
			expect(forDana.entries.map((e) => e.detail)).toEqual([{ decider: 'dana', supersedes: {} }, { by: {} }]);
			expect(JSON.stringify(forDana)).not.toContain('Hidden decision');
		});

		it('has a RECORD_DETAIL entry for every kind and names no key ending in Id; OWN_RECORD_EVENTS shares none with DECIDER_ONLY_EVENTS (66)', () => {
			expect(Object.keys(RECORD_DETAIL).sort()).toEqual([...EVENT_KINDS].sort());
			for (const [kind, spec] of Object.entries(RECORD_DETAIL)) {
				const named = Object.entries(spec).flatMap(([key, rule]) => [
					key,
					...(typeof rule === 'object' && 'fields' in rule ? rule.fields : []),
					...(typeof rule === 'object' && 'each' in rule ? rule.each : [])
				]);
				expect(named.filter((key) => /Id$/.test(key)), kind).toEqual([]);
			}
			expect(OWN_RECORD_EVENTS.filter((kind) => DECIDER_ONLY_EVENTS.includes(kind))).toEqual([]);
			expect(OWN_RECORD_EVENTS.every((kind) => (EVENT_KINDS as readonly string[]).includes(kind))).toBe(true);
			// Card 2684 (T27, R16): the four flag events are the decider's and administrators' alone, never on a person's own record.
			expect(FLAG_EVENTS).toEqual(['objection_raised', 'talk_requested', 'objection_answered', 'talk_outcome']);
			expect(FLAG_EVENTS.filter((kind) => !DECIDER_ONLY_EVENTS.includes(kind))).toEqual([]);
			expect(FLAG_EVENTS.filter((kind) => OWN_RECORD_EVENTS.includes(kind))).toEqual([]);
		});

		// Card 2684 (T51, R13; its plan review's E-M2): one list of the events never given to an API key, the question
		// events and the flag events, and recordEntryOf throws for each handed to it under any source but the page's.
		it.each([...KEY_HIDDEN_EVENTS])('throws in recordEntryOf for %s under source api, and shows it on the page (T51)', (kind) => {
			expect(KEY_HIDDEN_EVENTS).toEqual(['question_asked', 'question_answered', 'answer_published', 'answer_replaced', ...FLAG_EVENTS]);
			const row = { id: 1, kind, participantId: null, versionNumber: 1, detail: {}, actorName: 'Someone', source: 'link', at: '2026-11-01 09:00:00' };
			const ctx = { user: admin, labels: new Map<number, string>(), participants: new Map<number, string>() };
			expect(() => recordEntryOf(row, { ...ctx, source: 'api' })).toThrow(/never given to an API key/);
			expect(recordEntryOf(row, { ...ctx, source: 'ui' })).toMatchObject({ kind, actor: { name: 'Someone', source: 'link' } });
		});

		it('has words in DETAIL_WORDS for every key and field RECORD_DETAIL shows, and the other decision’s id and title; no key is shown in camelCase (code review F8)', () => {
			const shown = new Set<string>(['id', 'title']);
			for (const spec of Object.values(RECORD_DETAIL)) {
				for (const [key, rule] of Object.entries(spec)) {
					shown.add(key);
					if (typeof rule === 'object' && 'fields' in rule) for (const field of rule.fields) shown.add(field);
					if (typeof rule === 'object' && 'each' in rule) for (const field of rule.each) shown.add(field);
				}
			}
			expect([...shown].filter((key) => !Object.hasOwn(DETAIL_WORDS, key))).toEqual([]);
			for (const key of shown) expect(DETAIL_WORDS[key], key).not.toMatch(/[a-z][A-Z]/);
			// A key a later card adds before its words: split into words, never shown as stored.
			expect(detailWords('someNewKey')).toBe('Some new key');
			expect(detailWords('againstResponses')).toBe('Against the responses');
		});
	});

	describe('who reads it', () => {
		it('answers 403 to the author, a board owner, a board reader and a participant (67)', () => {
			const [author, owner, reader, participant] = [makeUser(), makeUser(), makeUser(), makeUser()];
			addBoardMember(board, author, 'editor');
			addBoardMember(board, owner, 'owner');
			addBoardMember(board, reader, 'viewer');
			const decision = decisionOn(board, { author, decider: dana });
			join(decision, personOf(participant));
			const refused = { status: 403, message: 'You cannot read the record of this decision' };

			for (const user of [author, owner, reader, participant]) expect(outcome(() => record(user, decision.id)), user.username).toEqual(refused);
		});

		it('answers 404 to an outsider (68)', () => {
			const decision = decisionOn(board, { decider: dana });
			expect(outcome(() => record(makeUser(), decision.id))).toEqual({ status: 404, message: 'Decision not found' });
		});

		it('answers 403 to a decider who lost board edit (69)', () => {
			const decision = decisionOn(board, { decider: dana });
			sqlite.prepare("UPDATE board_members SET role = 'viewer' WHERE user_id = ?").run(dana.id);
			expect(outcome(() => record(dana, decision.id))).toEqual({ status: 403, message: 'You cannot read the record of this decision' });
		});

		it('lets in the decider of a decision whose board is deleted (70)', () => {
			const decision = decisionOn(board, { decider: dana });
			deleteBoard(board);
			expect(outcome(() => record(dana, decision.id))).toBe('passed');
		});
	});
});

// ─── The decision page ───────────────────────────────────────────────────────

describe('what the decision page and the editor gain', () => {
	it('gives mayReadRecord true to the decider, a draft’s too, and false to a decider who lost board edit, on the decision page and the edit page (71)', () => {
		const dana = makeUser({ username: 'dana' });
		const author = makeUser({ username: 'author' });
		const board = makeBoard({ owner: makeUser() }).board;
		addBoardMember(board, dana, 'editor');
		addBoardMember(board, author, 'editor');
		const draft = decisionOn(board, { status: 'draft', author, decider: dana });
		const open = decisionOn(board, { author, decider: dana });

		for (const decision of [draft, open]) {
			expect(readDecisionPage(dana, decision.id).mayReadRecord, decision.status).toBe(true);
			expect(readEditPage(dana, decision.id).mayReadRecord, decision.status).toBe(true);
			// The author may edit it and reads no record.
			expect(readEditPage(author, decision.id).mayReadRecord, decision.status).toBe(false);
		}
		sqlite.prepare("UPDATE board_members SET role = 'viewer' WHERE user_id = ?").run(dana.id);
		expect(readDecisionPage(dana, open.id).mayReadRecord).toBe(false);
		// A decider who lost board edit cannot open the edit page at all: 403 there, as `edit` asks.
		expect(outcome(() => readEditPage(dana, open.id))).toMatchObject({ status: 403 });
	});

	it('gives a renamed board’s current name to a viewer who can open it, and the name kept to a participant who cannot (72)', () => {
		const [reader, participant] = [makeUser(), makeUser()];
		const board = makeBoard({ owner: makeUser(), name: 'Old name' }).board;
		addBoardMember(board, reader, 'viewer');
		const decision = decisionOn(board);
		makeVersion(decision);
		join(decision, personOf(participant));
		renameBoard(board, 'New name');

		expect(readDecisionPage(reader, decision.id).decision.boardName).toBe('New name');
		expect(readDecisionPage(participant, decision.id).decision.boardName).toBe('Old name');
	});

	it('answers 404 from /decisions/[id]’s load for 1.5, abc and people (73)', async () => {
		const admin = makeUser({ role: 'admin' });
		for (const path of ['/decisions/1.5', '/decisions/abc', '/decisions/people', '/decisions/0']) {
			const loaded = await pageLoad(path, { user: admin });
			expect(loaded, path).toEqual({ type: 'error', status: 404, body: { message: 'Decision not found' } });
		}
		const decision = decisionOn(null, { author: admin });
		expect((await pageLoad(`/decisions/${decision.id}`, { user: admin })).type).toBe('data');
	});
});

// ─── The page loads (slice 3a) ───────────────────────────────────────────────

describe('the page loads', () => {
	it('answers 404 Person not found from /decisions/people/[personId]’s load for a path that is not an id (74)', async () => {
		const admin = makeUser({ role: 'admin' });
		for (const path of ['/decisions/people/1.5', '/decisions/people/abc', '/decisions/people/0', '/decisions/people/-1']) {
			expect(await pageLoad(path, { user: admin }), path).toEqual({ type: 'error', status: 404, body: { message: 'Person not found' } });
		}
		const person = makePerson();
		const loaded = await pageLoad(`/decisions/people/${person.id}`, { user: admin });
		expect(loaded.type).toBe('data');
	});

	it('answers 404 from /decisions/[id]/record’s load for a path that is not an id (75)', async () => {
		const admin = makeUser({ role: 'admin' });
		for (const path of ['/decisions/1.5/record', '/decisions/abc/record', '/decisions/0/record']) {
			expect(await pageLoad(path, { user: admin }), path).toEqual({ type: 'error', status: 404, body: { message: 'Decision not found' } });
		}
		const decision = decisionOn(null, { author: admin });
		expect((await pageLoad(`/decisions/${decision.id}/record`, { user: admin })).type).toBe('data');
	});
});
