/**
 * The people directory and its groups (card 2674): who can be consulted on or
 * told of a decision, kept by an administrator through `/api/people` and
 * `/api/people-groups`, the service `src/lib/server/people.ts`.
 *
 * Each route is called as an administrator. That every other caller is
 * refused, and asked again at the write, is the access table's
 * (`tests/access-every-route.test.ts`); each body reader's refusals are
 * `tests/request-body.test.ts`'s. Neither is repeated here.
 *
 * The cases are the plan's, `docs/planning/card-2674-people-directory.md`,
 * section 6, by number.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { SESSION_COOKIE_NAME, type SessionUser } from '$lib/server/auth';
import { updatePerson } from '$lib/server/people';
import { STEP_UP_FIELD } from '$lib/server/step-up';
import { writeAs } from '$lib/server/write-as';
import { STEP_UP_CODE_FIELD, STEP_UP_MISSING } from '$lib/step-up-words';
import { api, type ApiResult } from './helpers/api';
import {
	FIXTURE_PASSWORD,
	addBoardMember,
	makeBoard,
	makeSession,
	makeTeam,
	makeTwoStepDormant,
	makeUser,
	resetDb,
	sessionCredential,
	shareBoardWithTeam,
	sessionHashOf,
	stepUpCode,
	stepUpFactor
} from './helpers/fixtures';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';

type Row = Record<string, unknown>;
type LogRow = { level: string; context: string; message: string; meta: string | null; userId: number | null };

let admin: SessionUser;
let level: string | undefined;
let quiet: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	resetDb();
	admin = makeUser({ username: 'admin', role: 'admin' });
	// The factor the administrator's codes are made from, given before any snapshot (card 2771).
	stepUpFactor(admin);
	// The suite logs errors only; the directory's lines are INFO ones.
	level = process.env.LOG_LEVEL;
	process.env.LOG_LEVEL = 'INFO';
	quiet = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
	quiet.mockRestore();
	if (level === undefined) delete process.env.LOG_LEVEL;
	else process.env.LOG_LEVEL = level;
});

/**
 * A request as the administrator. Every write of a person may carry an
 * address or an account, which asks for the caller's own password (card 2697,
 * Q21; its code review's part B, S1, for the add, the delete and Add from
 * accounts): it is sent from a real session of theirs, made for it and ended
 * after it, with their factor's spent step put back after it too, so that the
 * rows it leaves are the handler's alone, with their password and a code
 * added (card 2771), as the access table's `call` sends them. The groups'
 * routes ask for none. The claims are unchanged.
 */
async function send(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<ApiResult> {
	const ofPerson = path === '/api/people' || path.startsWith('/api/people/');
	if (!ofPerson || (body !== undefined && (body === null || typeof body !== 'object'))) return api(method, path, { user: admin, body });
	const token = makeSession(admin);
	const code = stepUpCode(admin);
	const spent = sqlite.prepare('SELECT last_step, last_used_at FROM mfa_factors WHERE user_id = ?').get(admin.id) as { last_step: number | null; last_used_at: string | null };
	try {
		return await api(method, path, {
			user: admin,
			body: { [STEP_UP_FIELD]: FIXTURE_PASSWORD, [STEP_UP_CODE_FIELD]: code, ...(body ?? {}) },
			headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` }
		});
	} finally {
		sqlite.prepare('DELETE FROM sessions WHERE id = ?').run(sessionHashOf(token));
		sqlite.prepare('UPDATE mfa_factors SET last_step = ?, last_used_at = ? WHERE user_id = ?').run(spent.last_step, spent.last_used_at, admin.id);
	}
}

/** `fn`'s refusal, as the status and the message, or what it answered. */
function outcome<T>(fn: () => T): { status: number; message: string } | { answered: T } {
	try {
		return { answered: fn() };
	} catch (thrown) {
		if (isHttpError(thrown)) return { status: thrown.status, message: thrown.body.message };
		throw thrown;
	}
}

const personRow = (id: number) => sqlite.prepare('SELECT * FROM people WHERE id = ?').get(id) as Row | undefined;
const groupsOf = (personId: number) =>
	(sqlite.prepare('SELECT group_id AS id FROM people_group_members WHERE person_id = ? ORDER BY group_id').all(personId) as { id: number }[]).map(
		(row) => row.id
	);
const membersOf = (groupId: number) =>
	(sqlite.prepare('SELECT person_id AS id FROM people_group_members WHERE group_id = ? ORDER BY person_id').all(groupId) as { id: number }[]).map(
		(row) => row.id
	);
const peopleLines = () =>
	sqlite
		.prepare("SELECT level, context, message, meta, user_id AS userId FROM system_logs WHERE context = 'PEOPLE' ORDER BY id")
		.all() as LogRow[];

/** A group, as it is stored. */
function makeGroup(name: string): number {
	return (sqlite.prepare('INSERT INTO people_groups (name) VALUES (?) RETURNING id').get(name) as { id: number }).id;
}

/** A person, as they are stored, in the groups named. */
function makePerson(fullName: string, email: string, opts: { userId?: number; groupIds?: number[] } = {}): number {
	const { id } = sqlite
		.prepare('INSERT INTO people (full_name, email, user_id) VALUES (?, ?, ?) RETURNING id')
		.get(fullName, email, opts.userId ?? null) as { id: number };
	for (const groupId of opts.groupIds ?? []) {
		sqlite.prepare('INSERT INTO people_group_members (group_id, person_id) VALUES (?, ?)').run(groupId, id);
	}
	return id;
}

/**
 * A decision, written by hand, and open: only an opened decision's rows hold a
 * link, and the `link_revoked` events a clear writes may not name a draft's
 * participant (card 2675, decision 12 and the plan review's D3).
 */
function makeDecision(): number {
	return (
		sqlite
			.prepare("INSERT INTO decisions (board_name, title, author_name, status) VALUES ('A board', 'A decision', 'admin', 'open') RETURNING id")
			.get() as { id: number }
	).id;
}

/** Every event on the record, as stored, in order. */
const decisionEvents = () =>
	sqlite
		.prepare('SELECT decision_id AS decisionId, participant_id AS participantId, kind, detail, actor_user_id AS actorUserId, actor_name AS actorName, source FROM decision_events ORDER BY id')
		.all() as Row[];

/** The `link_revoked` event card 2675 writes for each row a clear empties, by the administrator through the UI. */
const revoked = (decisionId: number, participantIds: number[], reason: string) =>
	participantIds.map((participantId) => ({
		decisionId,
		participantId,
		kind: 'link_revoked',
		detail: JSON.stringify({ reason }),
		actorUserId: admin.id,
		actorName: 'admin',
		source: 'ui'
	}));

/** A participant row of the decision for the person, with its snapshots and a personal link. */
function makeParticipant(decisionId: number, personId: number | null, n: number, link = true): number {
	return (
		sqlite
			.prepare(
				`INSERT INTO decision_participants
					(decision_id, person_id, role, name, email, job_title, groups, included_at, user_id, link_token_hash, link_issued_at)
				 VALUES (?, ?, 'consulted', ?, ?, 'Snapshot title', '["Snapshot group"]', '2026-11-01 09:00:00', NULL, ?, ?)
				 RETURNING id`
			)
			.get(decisionId, personId, `Snapshot ${n}`, `snapshot${n}@example.test`, link ? `hash-${n}` : null, link ? '2026-11-01 09:00:00' : null) as {
			id: number;
		}
	).id;
}

const participant = (id: number) => sqlite.prepare('SELECT * FROM decision_participants WHERE id = ?').get(id) as Row;

/** The request is answered `status` with `message`, nothing in the database changed, and nothing was logged. */
async function expectRefused(request: () => Promise<ApiResult>, status: number, message: string | RegExp): Promise<void> {
	const before = snapshotDb();
	const lines = peopleLines().length;
	const res = await request();
	expect(res.status, JSON.stringify(res.body)).toBe(status);
	if (typeof message === 'string') expect(res.body).toEqual({ message });
	else expect(res.body.message).toMatch(message);
	expectUnchanged(before);
	expect(peopleLines()).toHaveLength(lines);
}

describe('POST /api/people', () => {
	it('adds a person with their address lower-cased, no job title, and two groups, and logs it with the administrator (1)', async () => {
		const finance = makeGroup('Finance');
		const legal = makeGroup('Legal');

		const res = await send('POST', '/api/people', { fullName: ' Ann Lee ', email: 'Ann.Lee@Example.test', groupIds: [finance, legal] });

		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body).toMatchObject({ fullName: 'Ann Lee', email: 'ann.lee@example.test', jobTitle: '', groupIds: [finance, legal] });
		const row = personRow(res.body.id)!;
		expect(row).toMatchObject({ full_name: 'Ann Lee', email: 'ann.lee@example.test', job_title: '', created_by: admin.id, status: 'active', user_id: null });
		expect(groupsOf(res.body.id)).toEqual([finance, legal]);
		const lines = peopleLines();
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ level: 'INFO', context: 'PEOPLE', userId: admin.id });
		expect(lines[0].message).toBe(`Person ${res.body.id} "Ann Lee" added (by admin)`);
	});

	it('refuses, 409, an address another person has in another case, and logs nothing (2)', async () => {
		makePerson('Ann Lee', 'ann.lee@example.test');

		await expectRefused(
			() => send('POST', '/api/people', { fullName: 'Another Ann', email: 'ann.lee@EXAMPLE.test' }),
			409,
			'Email already in the directory: Ann Lee'
		);
		// Code review S1: a holder linked to an account is said to be, by username, and the address is not.
		const bob = makeUser({ username: 'bob' });
		makePerson('Bob Hart', 'bob@example.test', { userId: bob.id });
		await expectRefused(
			() => send('POST', '/api/people', { fullName: 'Another Bob', email: 'BOB@example.test' }),
			409,
			'Email already in the directory: Bob Hart (linked to account bob)'
		);
	});

	it('refuses, 409, an address stored with a capital beyond A to Z, sent in its folded form (card 2890, 2)', async () => {
		// Written directly, as a restored, hand-edited backup could hold it: the application stores every address lowered.
		makePerson('Élodie Roux', 'Élodie@example.test');

		await expectRefused(
			() => send('POST', '/api/people', { fullName: 'Another', email: 'élodie@example.test' }),
			409,
			'Email already in the directory: Élodie Roux'
		);
	});

	it('refuses, 400, a group that does not exist, naming it, and adds nobody (3)', async () => {
		const finance = makeGroup('Finance');

		await expectRefused(
			() => send('POST', '/api/people', { fullName: 'Ann Lee', email: 'ann@example.test', groupIds: [finance, 999] }),
			400,
			'groupId 999 is not a group'
		);
	});
});

describe('PUT /api/people/[id]', () => {
	let finance: number;
	let legal: number;
	let ann: number;

	beforeEach(() => {
		finance = makeGroup('Finance');
		legal = makeGroup('Legal');
		ann = makePerson('Ann Lee', 'ann.lee@example.test', { groupIds: [finance] });
		sqlite.prepare("UPDATE people SET job_title = 'Clerk', updated_at = '2026-01-01 00:00:00' WHERE id = ?").run(ann);
	});

	it('saves a new name, address, job title and groups, moves updated_at, and logs the four fields and no address (4)', async () => {
		const res = await send('PUT', `/api/people/${ann}`, {
			fullName: 'Ann Leigh',
			email: 'Ann.Leigh@Example.test',
			jobTitle: 'Head of Finance',
			groupIds: [legal]
		});

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toMatchObject({ fullName: 'Ann Leigh', email: 'ann.leigh@example.test', jobTitle: 'Head of Finance', groupIds: [legal] });
		const row = personRow(ann)!;
		expect(row).toMatchObject({ full_name: 'Ann Leigh', email: 'ann.leigh@example.test', job_title: 'Head of Finance' });
		expect(row.updated_at).not.toBe('2026-01-01 00:00:00');
		expect(groupsOf(ann)).toEqual([legal]);
		const lines = peopleLines();
		expect(lines).toHaveLength(1);
		// Card 2675: a new address clears the person's decision links, none here.
		expect(lines[0].message).toBe(`Person ${ann} "Ann Leigh" changed: name, email, job title, groups; 0 decision links cleared (by admin)`);
		expect(lines[0].userId).toBe(admin.id);
		// Decision 9 (plan review R10): never an address.
		for (const text of [lines[0].message, lines[0].meta ?? '']) {
			expect(text.toLowerCase()).not.toContain('ann.lee@example.test');
			expect(text.toLowerCase()).not.toContain('ann.leigh@example.test');
		}
	});

	it('writes and logs nothing for the stored values sent back (5)', async () => {
		const before = snapshotDb();

		const res = await send('PUT', `/api/people/${ann}`, {
			fullName: 'Ann Lee',
			email: 'ann.lee@example.test',
			jobTitle: 'Clerk',
			userId: null,
			status: 'active',
			groupIds: [finance]
		});

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toMatchObject({ fullName: 'Ann Lee', groupIds: [finance] });
		expectUnchanged(before);
		expect(personRow(ann)!.updated_at).toBe('2026-01-01 00:00:00');
		expect(peopleLines()).toEqual([]);
	});

	it('stamps left_at for left, keeping the account and the groups, and clears it for active (6)', async () => {
		const account = makeUser({ username: 'ann' });
		sqlite.prepare('UPDATE people SET user_id = ? WHERE id = ?').run(account.id, ann);

		const left = await send('PUT', `/api/people/${ann}`, { status: 'left' });

		expect(left.status, JSON.stringify(left.body)).toBe(200);
		expect(personRow(ann)).toMatchObject({ status: 'left', user_id: account.id, left_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/) });
		expect(groupsOf(ann)).toEqual([finance]);
		expect(peopleLines().at(-1)!.message).toBe(`Person ${ann} "Ann Lee" marked left; 0 decision links cleared (by admin)`);

		const active = await send('PUT', `/api/people/${ann}`, { status: 'active', reviewedEmail: 'ann.lee@example.test' });

		expect(active.status, JSON.stringify(active.body)).toBe(200);
		expect(personRow(ann)).toMatchObject({ status: 'active', left_at: null, user_id: account.id });
	});

	it('links an account no person has, and unlinks it with null (7)', async () => {
		const account = makeUser({ username: 'ann' });

		const linked = await send('PUT', `/api/people/${ann}`, { userId: account.id });

		expect(linked.status, JSON.stringify(linked.body)).toBe(200);
		expect(personRow(ann)!.user_id).toBe(account.id);
		expect(peopleLines().at(-1)!.message).toBe(`Person ${ann} "Ann Lee" linked to account ${account.id} "ann"; 0 decision links cleared (by admin)`);

		const unlinked = await send('PUT', `/api/people/${ann}`, { userId: null });

		expect(unlinked.status, JSON.stringify(unlinked.body)).toBe(200);
		expect(personRow(ann)!.user_id).toBeNull();
	});

	it('refuses, 409, an account linked to another person, naming them (8)', async () => {
		const account = makeUser({ username: 'bob' });
		makePerson('Bob Hart', 'bob@example.test', { userId: account.id });

		await expectRefused(() => send('PUT', `/api/people/${ann}`, { userId: account.id }), 409, 'That account is already linked to Bob Hart');
	});

	it('refuses, 400, a userId that is no account (9)', async () => {
		await expectRefused(() => send('PUT', `/api/people/${ann}`, { userId: 999 }), 400, 'userId 999 is not an account');
	});

	// Card 3020 (R6): Mark active lets a person be mailed again, at an address a backup whose seal did not verify may have
	// chosen, so it asks for the password and a code; Mark left asks nothing. The plan's cases (ag) to (ag4).
	describe('Mark active asks for the password and a code (card 3020, R6)', () => {
		const LEFT_AT = '2026-10-01 09:00:00';
		/** The request as the administrator from a real session of theirs, with no password and no code. */
		async function unasked(body: Record<string, unknown>): Promise<ApiResult> {
			const token = makeSession(admin);
			try {
				return await api('PUT', `/api/people/${ann}`, { user: admin, body, headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } });
			} finally {
				sqlite.prepare('DELETE FROM sessions WHERE id = ?').run(sessionHashOf(token));
			}
		}
		const changes = () => sqlite.prepare("SELECT actor_user_id AS actorUserId, actor_name AS actorName, source, subject, subject_id AS subjectId, kind, before, after FROM people_changes ORDER BY id").all() as Row[];

		beforeEach(() => {
			sqlite.prepare("UPDATE people SET status = 'left', left_at = ? WHERE id = ?").run(LEFT_AT, ann);
		});

		it('(ag) Mark active with no password is 400 STEP_UP_MISSING, and the person is still left', async () => {
			const before = snapshotDb();

			const res = await unasked({ status: 'active', reviewedEmail: 'ann.lee@example.test' });

			expect(res.status, JSON.stringify(res.body)).toBe(400);
			expect(res.body).toEqual({ message: STEP_UP_MISSING, stepUp: 'missing' });
			expectUnchanged(before);
			expect(personRow(ann)).toMatchObject({ status: 'left', left_at: LEFT_AT });
			expect(peopleLines()).toEqual([]);
		});

		it('(ag2) Mark active with the password and a code makes them active, recorded in people_changes as any change is', async () => {
			const res = await send('PUT', `/api/people/${ann}`, { status: 'active', reviewedEmail: 'ann.lee@example.test' });

			expect(res.status, JSON.stringify(res.body)).toBe(200);
			expect(personRow(ann)).toMatchObject({ status: 'active', left_at: null });
			expect(changes()).toEqual([
				{
					actorUserId: admin.id,
					actorName: 'admin',
					source: 'ui',
					subject: 'person',
					subjectId: ann,
					kind: 'updated',
					before: JSON.stringify({ status: 'left', leftAt: LEFT_AT }),
					after: JSON.stringify({ status: 'active', leftAt: null })
				}
			]);
			expect(peopleLines().at(-1)!.message).toBe(`Person ${ann} "Ann Lee" marked active (by admin)`);
		});

		it("(ag3) Mark left with { status: 'left' } alone still asks nothing", async () => {
			sqlite.prepare("UPDATE people SET status = 'active', left_at = NULL WHERE id = ?").run(ann);

			const res = await unasked({ status: 'left' });

			expect(res.status, JSON.stringify(res.body)).toBe(200);
			expect(personRow(ann)).toMatchObject({ status: 'left', left_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/) });
		});

		it("(ag5) card 3020's code review, FP5: Mark active with the password and a code, but with no reviewed address, 400, or an address that is not the person's now, 409; the person is still left, and reviewedEmail is never written", async () => {
			const before = snapshotDb();

			const missing = await send('PUT', `/api/people/${ann}`, { status: 'active' });
			// The address changed after the page was read: the one shown is not the one their mail would go to.
			const moved = await send('PUT', `/api/people/${ann}`, { status: 'active', reviewedEmail: 'eve@elsewhere.test' });
			const cased = await send('PUT', `/api/people/${ann}`, { status: 'active', reviewedEmail: 'ANN.LEE@example.test' });

			expect(missing.status, JSON.stringify(missing.body)).toBe(400);
			expect(missing.body.message).toBe('reviewedEmail is required');
			for (const res of [moved, cased]) {
				expect(res.status, JSON.stringify(res.body)).toBe(409);
				expect(res.body.message).toBe(
					"This person's address has changed since the page was read: read it again and check the address before you mark them active. Nothing was changed."
				);
			}
			expectUnchanged(before);
			expect(personRow(ann)).toMatchObject({ status: 'left', left_at: LEFT_AT, email: 'ann.lee@example.test' });
			expect(peopleLines()).toEqual([]);

			// A rename with a reviewed address and no status: the key writes nothing and asks nothing.
			const renamed = await unasked({ fullName: 'Ann Leigh', reviewedEmail: 'eve@elsewhere.test' });
			expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
			expect(personRow(ann)).toMatchObject({ full_name: 'Ann Leigh', email: 'ann.lee@example.test', status: 'left' });
		});

		it('(ag4) updatePerson, left to active, with steppedUp false or not given, is refused 400 and writes nothing', () => {
			const locals: App.Locals = { user: admin, credential: sessionCredential(makeSession(admin)) };
			const before = snapshotDb();

			for (const opts of [{ source: 'ui' as const, steppedUp: false }, { source: 'ui' as const }]) {
				expect(outcome(() => writeAs(locals, (caller) => updatePerson(caller, { personId: ann }, { status: 'active' }, opts)))).toEqual({
					status: 400,
					message:
						'Marking a person active asks for your password and a code: their decision mail and personal links go to their address again. Nothing was changed.'
				});
			}
			expectUnchanged(before);
			expect(peopleLines()).toEqual([]);
		});

		it('(ag4) card 3064 (S4b, F25): while two-step sign-in is dormant, the refusal names the password alone to an administrator with no factor, and the password and a code to one that holds one', () => {
			makeTwoStepDormant();
			const plain = makeUser({ username: 'plain-admin', role: 'admin' });
			const holder = makeUser({ username: 'holder-admin', role: 'admin' });
			stepUpFactor(holder);
			const localsOf = new Map([plain, holder].map((who) => [who, { user: who, credential: sessionCredential(makeSession(who)) }]));
			const refusal = (who: SessionUser) =>
				outcome(() => writeAs(localsOf.get(who)!, (caller) => updatePerson(caller, { personId: ann }, { status: 'active' }, { source: 'ui' })));
			const before = snapshotDb();

			expect(refusal(plain)).toEqual({
				status: 400,
				message: 'Marking a person active asks for your password: their decision mail and personal links go to their address again. Nothing was changed.'
			});
			expect(refusal(holder)).toEqual({
				status: 400,
				message:
					'Marking a person active asks for your password and a code: their decision mail and personal links go to their address again. Nothing was changed.'
			});
			expectUnchanged(before);
		});
	});

	describe('and the decision links of the person (S6, S7, decision 5; card 2675 decision 12)', () => {
		let decision: number;
		let bob: number;
		let mine: number[];
		let theirs: number;

		beforeEach(() => {
			decision = makeDecision();
			bob = makePerson('Bob Hart', 'bob@example.test');
			mine = [makeParticipant(decision, ann, 1), makeParticipant(decision, ann, 2)];
			theirs = makeParticipant(decision, bob, 3);
		});

		it('empties both of their links, and nothing else, when the person is marked left, and records each; the other person’s row is untouched (10)', async () => {
			const before = [...mine, theirs].map(participant);

			const res = await send('PUT', `/api/people/${ann}`, { status: 'left' });

			expect(res.status, JSON.stringify(res.body)).toBe(200);
			mine.forEach((id, i) => expect(participant(id)).toEqual({ ...before[i], link_token_hash: null, link_issued_at: null }));
			expect(participant(theirs)).toEqual(before[2]);
			expect(peopleLines().at(-1)!.message).toBe(`Person ${ann} "Ann Lee" marked left; 2 decision links cleared (by admin)`);
			// Card 2675: each emptied row is on the record, by the administrator.
			expect(decisionEvents()).toEqual(revoked(decision, mine, 'left'));
		});

		it('empties them when the person is linked to an account, and records each (11)', async () => {
			const account = makeUser({ username: 'ann' });
			const before = [...mine, theirs].map(participant);

			const res = await send('PUT', `/api/people/${ann}`, { userId: account.id });

			expect(res.status, JSON.stringify(res.body)).toBe(200);
			mine.forEach((id, i) => expect(participant(id)).toEqual({ ...before[i], link_token_hash: null, link_issued_at: null }));
			expect(participant(theirs)).toEqual(before[2]);
			expect(decisionEvents()).toEqual(revoked(decision, mine, 'linked'));
		});

		it('changes no column of any participant row, and writes no event, for a new name and job title (12)', async () => {
			const before = [...mine, theirs].map(participant);

			const res = await send('PUT', `/api/people/${ann}`, { fullName: 'Ann Leigh', jobTitle: 'Head of Finance' });

			expect(res.status, JSON.stringify(res.body)).toBe(200);
			expect([...mine, theirs].map(participant)).toEqual(before);
			expect(decisionEvents()).toEqual([]);
			expect(peopleLines().at(-1)!.message).toBe(`Person ${ann} "Ann Leigh" changed: name, job title (by admin)`);
		});

		it('empties both of their links for a new address, and records each; then left and a new address in one change record left alone (74)', async () => {
			const before = [...mine, theirs].map(participant);

			const res = await send('PUT', `/api/people/${ann}`, { email: 'ann.leigh@example.test' });

			expect(res.status, JSON.stringify(res.body)).toBe(200);
			mine.forEach((id, i) => expect(participant(id)).toEqual({ ...before[i], link_token_hash: null, link_issued_at: null }));
			expect(participant(theirs)).toEqual(before[2]);
			expect(decisionEvents()).toEqual(revoked(decision, mine, 'address_changed'));
			expect(peopleLines().at(-1)!.message).toBe(`Person ${ann} "Ann Lee" changed: email; 2 decision links cleared (by admin)`);

			// One update that does two of the triggers clears once, with the first reason.
			const bobs = [theirs, makeParticipant(decision, bob, 4)];

			const both = await send('PUT', `/api/people/${bob}`, { status: 'left', email: 'bob.hart@example.test' });

			expect(both.status, JSON.stringify(both.body)).toBe(200);
			bobs.forEach((id) => expect(participant(id)).toMatchObject({ link_token_hash: null, link_issued_at: null }));
			expect(decisionEvents()).toEqual([...revoked(decision, mine, 'address_changed'), ...revoked(decision, bobs, 'left')]);
			expect(peopleLines().at(-1)!.message).toBe(`Person ${bob} "Bob Hart" changed: email; marked left; 2 decision links cleared (by admin)`);
		});

		it('empties their links when the person is unlinked from their account, and records each (75)', async () => {
			const account = makeUser({ username: 'ann' });
			sqlite.prepare('UPDATE people SET user_id = ? WHERE id = ?').run(account.id, ann);
			// The hashes set by hand: no link is issued to a person with an account.
			const before = [...mine, theirs].map(participant);

			const res = await send('PUT', `/api/people/${ann}`, { userId: null });

			expect(res.status, JSON.stringify(res.body)).toBe(200);
			expect(personRow(ann)!.user_id).toBeNull();
			mine.forEach((id, i) => expect(participant(id)).toEqual({ ...before[i], link_token_hash: null, link_issued_at: null }));
			expect(participant(theirs)).toEqual(before[2]);
			expect(decisionEvents()).toEqual(revoked(decision, mine, 'unlinked'));
			expect(peopleLines().at(-1)!.message).toBe(`Person ${ann} "Ann Lee" unlinked from account ${account.id}; 2 decision links cleared (by admin)`);
		});
	});
});

describe('POST /api/people/from-accounts', () => {
	let fresh: SessionUser;
	let matching: SessionUser;
	let linked: SessionUser;
	let unlinkedPerson: number;
	let link: number;

	beforeEach(() => {
		fresh = makeUser({ username: 'fresh' });
		sqlite.prepare("UPDATE users SET email = 'Fresh.One@Example.test' WHERE id = ?").run(fresh.id);
		matching = makeUser({ username: 'matching' });
		// The person's address in another case from the account's.
		unlinkedPerson = makePerson('Mat Ching', 'matching@example.test');
		sqlite.prepare("UPDATE users SET email = 'Matching@Example.test' WHERE id = ?").run(matching.id);
		link = makeParticipant(makeDecision(), unlinkedPerson, 1);
		linked = makeUser({ username: 'linked' });
		makePerson('Lin Ked', 'lin.ked@example.test', { userId: linked.id });
	});

	it('makes a person of an account with none, and skips one whose address matches a person and one already linked, linking nobody (13)', async () => {
		const res = await send('POST', '/api/people/from-accounts', { userIds: [fresh.id, matching.id, linked.id] });

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toEqual({
			created: 1,
			skipped: [
				{ userId: matching.id, reason: `address matches person ${unlinkedPerson}; link by hand` },
				{ userId: linked.id, reason: 'already linked' }
			]
		});
		const made = sqlite.prepare('SELECT * FROM people WHERE user_id = ?').get(fresh.id) as Row;
		expect(made).toMatchObject({ full_name: 'fresh', email: 'fresh.one@example.test', user_id: fresh.id, created_by: admin.id });
		// Decision 13: the person whose address matched is not linked, and keeps their link.
		expect(personRow(unlinkedPerson)!.user_id).toBeNull();
		expect(participant(link).link_token_hash).toBe('hash-1');
		expect(peopleLines().map((line) => line.message)).toEqual(['1 people added from accounts, 2 skipped (by admin)']);
	});

	it('skips an account whose address matches a person stored with a capital beyond A to Z, and makes nobody (card 2890, 3)', async () => {
		// The person written directly, unfolded; the account's address as the application stores it, lowered.
		const elodie = makePerson('Élodie Roux', 'Élodie@example.test');
		const account = makeUser({ username: 'elodie' });
		sqlite.prepare("UPDATE users SET email = 'élodie@example.test' WHERE id = ?").run(account.id);

		const res = await send('POST', '/api/people/from-accounts', { userIds: [account.id] });

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toEqual({ created: 0, skipped: [{ userId: account.id, reason: `address matches person ${elodie}; link by hand` }] });
		expect(sqlite.prepare('SELECT COUNT(*) AS n FROM people WHERE user_id = ?').get(account.id)).toEqual({ n: 0 });
	});

	it('refuses, 400, a list with one id that is no account, and makes and links nothing (14)', async () => {
		await expectRefused(
			() => send('POST', '/api/people/from-accounts', { userIds: [fresh.id, matching.id, 999] }),
			400,
			'userId 999 is not an account'
		);
	});
});

describe('POST /api/people-groups', () => {
	it('adds a group with its name trimmed (15)', async () => {
		const res = await send('POST', '/api/people-groups', { name: '  Finance ' });

		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body).toMatchObject({ name: 'Finance', description: '' });
		expect(sqlite.prepare('SELECT name FROM people_groups WHERE id = ?').get(res.body.id)).toEqual({ name: 'Finance' });
	});

	it('refuses, 409, a name another group has in another case (16)', async () => {
		makeGroup('Finance');

		await expectRefused(() => send('POST', '/api/people-groups', { name: 'finance' }), 409, 'Group name already in use: Finance');
	});

	it('refuses, 409, a name with a capital beyond A to Z in another case and typed exactly (card 2890, 1)', async () => {
		makeGroup('École');

		await expectRefused(() => send('POST', '/api/people-groups', { name: 'ÉCOLE' }), 409, 'Group name already in use: École');
		// Typed exactly: before card 2890 the check missed it and the UNIQUE index answered 500.
		await expectRefused(() => send('POST', '/api/people-groups', { name: 'École' }), 409, 'Group name already in use: École');
	});
});

describe('PUT /api/people-groups/[id]', () => {
	it('refuses, 409, a rename onto another group’s name in another case, and renames a group onto its own name in another case (27)', async () => {
		const finance = makeGroup('Finance');
		const legal = makeGroup('Legal');

		await expectRefused(() => send('PUT', `/api/people-groups/${legal}`, { name: 'FINANCE' }), 409, 'Group name already in use: Finance');

		// The group being renamed is not counted against itself (`requireUnusedGroupName`'s `except`).
		const res = await send('PUT', `/api/people-groups/${finance}`, { name: 'FINANCE' });

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toMatchObject({ id: finance, name: 'FINANCE' });
		expect(sqlite.prepare('SELECT name FROM people_groups WHERE id = ?').get(finance)).toEqual({ name: 'FINANCE' });
	});
});

describe('PUT /api/people-groups/[id]/members', () => {
	let group: number;
	let kept: number;
	let removed: number;
	let added: number;

	beforeEach(() => {
		group = makeGroup('Finance');
		kept = makePerson('Kept', 'kept@example.test', { groupIds: [group] });
		removed = makePerson('Removed', 'removed@example.test', { groupIds: [group] });
		added = makePerson('Added', 'added@example.test');
	});

	it('replaces the set: one kept, one added, one taken out (17)', async () => {
		const res = await send('PUT', `/api/people-groups/${group}/members`, { personIds: [kept, added] });

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toMatchObject({ id: group, name: 'Finance', personIds: [kept, added] });
		expect(membersOf(group)).toEqual([kept, added].sort((a, b) => a - b));
		expect(personRow(removed)).toBeDefined();
	});

	it('refuses, 400, a person that does not exist, and leaves the set as it was (18)', async () => {
		await expectRefused(() => send('PUT', `/api/people-groups/${group}/members`, { personIds: [kept, 999] }), 400, 'personId 999 is not a person');
		expect(membersOf(group)).toEqual([kept, removed]);
	});
});

describe('DELETE /api/people-groups/[id]', () => {
	it('deletes the group and its memberships, and the people stay (19)', async () => {
		const group = makeGroup('Finance');
		const other = makeGroup('Legal');
		const ann = makePerson('Ann Lee', 'ann@example.test', { groupIds: [group, other] });

		const res = await send('DELETE', `/api/people-groups/${group}`);

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toEqual({ success: true });
		expect(sqlite.prepare('SELECT id FROM people_groups ORDER BY id').all()).toEqual([{ id: other }]);
		expect(membersOf(group)).toEqual([]);
		expect(groupsOf(ann)).toEqual([other]);
		expect(personRow(ann)).toBeDefined();
	});
});

describe('DELETE /api/people/[id]', () => {
	it('empties the person’s links, records each, deletes them and their membership, keeps every snapshot, and frees the address (26)', async () => {
		const group = makeGroup('Finance');
		const ann = makePerson('Ann Lee', 'ann.lee@example.test', { groupIds: [group] });
		const bob = makePerson('Bob Hart', 'bob@example.test');
		const decision = makeDecision();
		const mine = [makeParticipant(decision, ann, 1), makeParticipant(decision, ann, 2)];
		// A third row of the person with no link: not counted (plan review R7).
		const noLink = makeParticipant(decision, ann, 3, false);
		const theirs = makeParticipant(decision, bob, 4);
		const before = [...mine, noLink, theirs].map(participant);

		const res = await send('DELETE', `/api/people/${ann}`);

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toEqual({ success: true, linksCleared: 2 });
		expect(personRow(ann)).toBeUndefined();
		expect(membersOf(group)).toEqual([]);
		mine.forEach((id, i) => expect(participant(id)).toEqual({ ...before[i], person_id: null, link_token_hash: null, link_issued_at: null }));
		expect(participant(noLink)).toEqual({ ...before[2], person_id: null });
		expect(participant(theirs)).toEqual(before[3]);
		expect(peopleLines().map((line) => line.message)).toEqual([`Person ${ann} "Ann Lee" deleted; 2 decision links cleared (by admin)`]);
		// Card 2675: on the record of the rows, which remain to carry it.
		expect(decisionEvents()).toEqual(revoked(decision, mine, 'person_deleted'));

		const again = await send('POST', '/api/people', { fullName: 'Ann Lee', email: 'ann.lee@example.test' });

		expect(again.status, JSON.stringify(again.body)).toBe(201);
	});
});

describe('GET /api/boards/[id]/share and the Product Owner', () => {
	it('gives the Product Owner to all, and the accounts that can edit the board to its owner alone, with no address (20)', async () => {
		const owner = makeUser({ username: 'owner' });
		const editor = makeUser({ username: 'editor' });
		const teamed = makeUser({ username: 'teamed' });
		const viewer = makeUser({ username: 'viewer' });
		// A direct viewer row decides over an editor team (`roleOnBoard`).
		const both = makeUser({ username: 'both' });
		// No share at all: on a public board, a reader.
		makeUser({ username: 'stranger' });
		const superadmin = makeUser({ username: 'super', role: 'superadmin' });
		const { board } = makeBoard({ owner, isPublic: true });
		addBoardMember(board, editor, 'editor');
		addBoardMember(board, viewer, 'viewer');
		addBoardMember(board, both, 'viewer');
		shareBoardWithTeam(board, makeTeam([teamed, both]), 'editor');
		sqlite.prepare('UPDATE boards SET product_owner_user_id = ? WHERE id = ?').run(editor.id, board.id);

		const asOwner = await api('GET', `/api/boards/${board.id}/share`, { user: owner });

		expect(asOwner.status, JSON.stringify(asOwner.body)).toBe(200);
		expect(asOwner.body.productOwner).toEqual({ userId: editor.id, username: 'editor', emoji: '👤' });
		expect(asOwner.body.productOwnerCandidates).toEqual(
			[admin, editor, owner, superadmin, teamed].map((account) => ({ id: account.id, username: account.username, emoji: '👤' }))
		);
		expect(JSON.stringify(asOwner.body.productOwnerCandidates)).not.toContain('@');

		const asEditor = await api('GET', `/api/boards/${board.id}/share`, { user: editor });

		expect(asEditor.status, JSON.stringify(asEditor.body)).toBe(200);
		expect(asEditor.body.productOwner).toEqual({ userId: editor.id, username: 'editor', emoji: '👤' });
		expect('productOwnerCandidates' in asEditor.body).toBe(false);
	});
});
