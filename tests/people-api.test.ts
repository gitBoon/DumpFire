/**
 * The people directory and its groups under API v1 (card 2681): what an
 * administrator's API key may read and change, and what it never may.
 *
 * A key cannot give a password, and every People write that sets or ends an
 * address or an account asks for one (card 2697). So through a key the
 * directory is read without addresses or account ids, a person's job title
 * and groups are changed, and groups are made, described and filled; adding,
 * deleting, names, addresses, accounts and leavers stay on the People page.
 * The service refuses those by the route's word (`source`) and by the
 * credential the write was let in with (`writingWithKey()`), either alone.
 *
 * Each case calls through `tests/helpers/api.ts` as an administrator with a
 * real API key's credential, unless it says otherwise; case 13 goes through
 * the gate (`tests/helpers/gate.ts`). The admin-only refusal of every route is
 * the access table's (`tests/access-every-route.test.ts`); each body reader's
 * refusals are `tests/request-body.test.ts`'s, and the service's refusals that
 * stood before this card are `tests/people-directory.test.ts`'s. None is
 * repeated here.
 *
 * The cases are the plan's, `docs/planning/card-2681-people-groups-api.md`,
 * section 6.1, by number; case 16, and the rows the code review added to
 * cases 3, 9, 10 and 11, are its section 14's. Every change, by the page or a
 * key, also appends a row to `people_changes` (migration 0064), which a
 * refused write never does.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isHttpError } from '@sveltejs/kit';
import { db, sqlite } from '$lib/server/db';
import { apiKeys } from '$lib/server/db/schema';
import type { Credential, SessionUser } from '$lib/server/auth';
import { addFromAccounts, createGroup, createPerson, deleteGroup, deletePerson, setGroupMembers, updateGroup, updatePerson } from '$lib/server/people';
import { resetAllRateLimits } from '$lib/server/rate-limit';
import { writeAs, type ServiceOptions } from '$lib/server/write-as';
import { api, type ApiResult } from './helpers/api';
import { makeApiKey, makeSession, makeUser, newFixtureHash, resetDb, sessionCredential, stepUp } from './helpers/fixtures';
import { gate, gateApiRoutes } from './helpers/gate';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';

type Row = Record<string, unknown>;
type LogRow = { message: string; meta: string | null };

/** The refusals the service words (people.ts; not exported, as a service exports its functions alone). */
const KEY_FIELD_WORDS = 'The name, address, account and status of a person are changed on the People page: an API key cannot change them';
const KEY_RENAME_WORDS = 'A group is renamed on the People page: an API key cannot rename one';
const PAGE_ONLY_WORDS =
	'Adding a person, deleting one and adding people from accounts are done on the People page, which asks for your password: an API key cannot';
const GROUP_DELETE_WORDS = 'A group is deleted on the People page: an API key cannot delete one';
const ADMIN = 'Admin access required';

/** What a key's PEOPLE line puts in its entry, whatever the route said (the code review's F2). */
const KEYED = { source: 'api', credential: 'api key' };

/** What every v1 people route hands its service. */
const V1: ServiceOptions = { source: 'api', says: ADMIN };

let admin: SessionUser;
let level: string | undefined;
let quiet: ReturnType<typeof vi.spyOn>;

// The first request through the gate (case 13) starts the server and loads the gate, which takes seconds while
// every other file is starting too: done here, with time to do it in, as tests/body-limits.test.ts and
// tests/backups.test.ts do (the code review's F6).
beforeAll(async () => {
	await gateApiRoutes();
	await gate('GET', '/login', { headers: { accept: 'text/html' } });
}, 120_000);

beforeEach(() => {
	resetDb();
	// The v1 limit is 60 requests a minute for a key, counted in memory (case 13).
	resetAllRateLimits();
	admin = makeUser({ username: 'admin', role: 'admin' });
	adminKey = keyCredential(admin);
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

/** The credential a gate records for a real API key of the user. */
function keyCredential(user: SessionUser): Credential {
	const key = makeApiKey(user);
	const row = db.select().from(apiKeys).all().find((k) => key.startsWith(k.keyPrefix))!;
	return { kind: 'api key', id: row.id };
}

/** The locals a gate hands on for a real API key of the user. */
const keyLocals = (user: SessionUser): App.Locals => ({ user, credential: keyCredential(user) });

/** A request under /api/v1/ as the administrator, with the credential of their real key, made before each test. */
let adminKey: Credential;
const asKey = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, body?: unknown): Promise<ApiResult> =>
	api(method, path, { user: admin, credential: adminKey, ...(body === undefined ? {} : { body }) });

/** The keys of a person and of a group as a key is answered them (the OpenAPI document's Person and PeopleGroup). */
const PERSON_KEYS = ['createdAt', 'createdBy', 'fullName', 'groupIds', 'id', 'jobTitle', 'leftAt', 'status', 'untrusted', 'updatedAt'];
const GROUP_KEYS = ['createdAt', 'description', 'id', 'name', 'personIds', 'untrusted'];
const keysOf = (item: Row) => Object.keys(item).sort();

/** A row of decision_events, of any kind. */
const eventCount = () => countOf('decision_events');

/** The locals a gate hands on for a real session of the user. */
const sessionLocals = (user: SessionUser): App.Locals => ({ user, credential: sessionCredential(makeSession(user)) });

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
const groupRow = (id: number) => sqlite.prepare('SELECT * FROM people_groups WHERE id = ?').get(id) as Row | undefined;
const groupsOf = (personId: number) =>
	(sqlite.prepare('SELECT group_id AS id FROM people_group_members WHERE person_id = ? ORDER BY group_id').all(personId) as { id: number }[]).map(
		(row) => row.id
	);
const membersOf = (groupId: number) =>
	(sqlite.prepare('SELECT person_id AS id FROM people_group_members WHERE group_id = ? ORDER BY person_id').all(groupId) as { id: number }[]).map(
		(row) => row.id
	);
const peopleLines = () => sqlite.prepare("SELECT message, meta FROM system_logs WHERE context = 'PEOPLE' ORDER BY id").all() as LogRow[];
const metaOf = (line: LogRow) => JSON.parse(line.meta ?? '{}') as Record<string, unknown>;
const countOf = (table: string) => (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/** The rows of people_changes (migration 0064, the code review's S1), in order, `before` and `after` read as JSON. */
type ChangeRow = {
	actorUserId: number | null;
	actorName: string;
	source: string;
	subject: string;
	subjectId: number;
	kind: string;
	before: Row | null;
	after: Row | null;
};
const changes = (): ChangeRow[] =>
	(
		sqlite
			.prepare(
				'SELECT actor_user_id AS actorUserId, actor_name AS actorName, source, subject, subject_id AS subjectId, kind, before, after FROM people_changes ORDER BY id'
			)
			.all() as (Omit<ChangeRow, 'before' | 'after'> & { before: string | null; after: string | null })[]
	).map((row) => ({ ...row, before: row.before === null ? null : JSON.parse(row.before), after: row.after === null ? null : JSON.parse(row.after) }));

/** A group, as it is stored. */
function makeGroup(name: string, description = ''): number {
	return (sqlite.prepare('INSERT INTO people_groups (name, description) VALUES (?, ?) RETURNING id').get(name, description) as { id: number }).id;
}

/** A person, as they are stored, in the groups named. */
function makePerson(fullName: string, email: string, opts: { userId?: number; groupIds?: number[]; jobTitle?: string; status?: string } = {}): number {
	const { id } = sqlite
		.prepare(
			"INSERT INTO people (full_name, email, user_id, job_title, status, left_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '2026-01-01 00:00:00') RETURNING id"
		)
		.get(fullName, email, opts.userId ?? null, opts.jobTitle ?? '', opts.status ?? 'active', opts.status === 'left' ? '2026-10-01 09:00:00' : null) as {
		id: number;
	};
	for (const groupId of opts.groupIds ?? []) {
		sqlite.prepare('INSERT INTO people_group_members (group_id, person_id) VALUES (?, ?)').run(groupId, id);
	}
	return id;
}

/** An open decision, written by hand, with a participant row of the person holding a live personal link. */
function aLiveLink(personId: number): number {
	const decision = (
		sqlite.prepare("INSERT INTO decisions (board_name, title, author_name, status) VALUES ('A board', 'A decision', 'admin', 'open') RETURNING id").get() as {
			id: number;
		}
	).id;
	return (
		sqlite
			.prepare(
				`INSERT INTO decision_participants
					(decision_id, person_id, role, name, email, job_title, groups, included_at, link_token_hash, link_issued_at)
				 VALUES (?, ?, 'consulted', 'Snapshot', 'snapshot@example.test', '', '[]', '2026-11-01 09:00:00', 'hash-live', '2026-11-01 09:00:00')
				 RETURNING id`
			)
			.get(decision, personId) as { id: number }
	).id;
}
const linkOf = (participantId: number) =>
	(sqlite.prepare('SELECT link_token_hash AS hash FROM decision_participants WHERE id = ?').get(participantId) as { hash: string | null }).hash;

// ─── The service, under a key (slice 1) ─────────────────────────────────────

describe('the service refuses a key what the People page alone does', () => {
	it('refuses createPerson, deletePerson, addFromAccounts and deleteGroup handed source api, inside writeAs as an administrator, and writes nothing (10)', () => {
		const account = makeUser({ username: 'sam' });
		const ann = makePerson('Ann Lee', 'ann.lee@example.test');
		const finance = makeGroup('Finance');
		sqlite.prepare('INSERT INTO people_group_members (group_id, person_id) VALUES (?, ?)').run(finance, ann);
		const live = aLiveLink(ann);
		const locals = sessionLocals(admin);
		const before = snapshotDb();

		expect(
			outcome(() =>
				writeAs(locals, (caller) => createPerson(caller, {}, { fullName: 'Bob Hart', email: 'bob@example.test', jobTitle: 'Clerk', userId: account.id }, V1))
			)
		).toEqual({ status: 403, message: PAGE_ONLY_WORDS });
		expect(outcome(() => writeAs(locals, (caller) => deletePerson(caller, { personId: ann }, null, V1)))).toEqual({ status: 403, message: PAGE_ONLY_WORDS });
		expect(outcome(() => writeAs(locals, (caller) => addFromAccounts(caller, {}, { userIds: [account.id] }, V1)))).toEqual({
			status: 403,
			message: PAGE_ONLY_WORDS
		});
		// (d) The code review's S3: a group's delete drops a set nothing else holds.
		expect(outcome(() => writeAs(locals, (caller) => deleteGroup(caller, { groupId: finance }, null, V1)))).toEqual({
			status: 403,
			message: GROUP_DELETE_WORDS
		});

		expectUnchanged(before);
		expect(countOf('people')).toBe(1);
		expect(membersOf(finance)).toEqual([ann]);
		expect(linkOf(live)).toBe('hash-live');
		expect(peopleLines()).toEqual([]);
		expect(changes()).toEqual([]);
	});

	it('refuses by the credential, though the route said ui: an address, a name, a status, an account, a group rename, an add, a delete, Add from accounts and a group delete; a session is let through (11)', () => {
		const account = makeUser({ username: 'sam' });
		const ann = makePerson('Ann Lee', 'ann.lee@example.test', { userId: account.id });
		const finance = makeGroup('Finance');
		const byKey = keyLocals(admin);
		const UI: ServiceOptions = { source: 'ui' };
		const before = snapshotDb();

		const refusals: [string, () => unknown, string][] = [
			['(a) a new address', () => writeAs(byKey, (caller) => updatePerson(caller, { personId: ann }, { email: 'ann.new@example.test' }, UI)), KEY_FIELD_WORDS],
			['(b) a new name', () => writeAs(byKey, (caller) => updatePerson(caller, { personId: ann }, { fullName: 'Y' }, UI)), KEY_FIELD_WORDS],
			['(c) a group renamed', () => writeAs(byKey, (caller) => updateGroup(caller, { groupId: finance }, { name: 'New' }, UI)), KEY_RENAME_WORDS],
			['(d) an add', () => writeAs(byKey, (caller) => createPerson(caller, {}, { fullName: 'Bob Hart', email: 'bob@example.test' }, UI)), PAGE_ONLY_WORDS],
			['(e) a delete', () => writeAs(byKey, (caller) => deletePerson(caller, { personId: ann }, null, UI)), PAGE_ONLY_WORDS],
			['(f) Add from accounts', () => writeAs(byKey, (caller) => addFromAccounts(caller, {}, { userIds: [account.id] }, UI)), PAGE_ONLY_WORDS],
			// The code review's S3 and S6: a group's delete, Mark left and an unlink.
			['(g) a group deleted', () => writeAs(byKey, (caller) => deleteGroup(caller, { groupId: finance }, null, UI)), GROUP_DELETE_WORDS],
			['(h) marked left', () => writeAs(byKey, (caller) => updatePerson(caller, { personId: ann }, { status: 'left' }, UI)), KEY_FIELD_WORDS],
			['(i) unlinked from the account', () => writeAs(byKey, (caller) => updatePerson(caller, { personId: ann }, { userId: null }, UI)), KEY_FIELD_WORDS]
		];
		for (const [what, call, message] of refusals) {
			expect({ what, ...outcome(call) }).toEqual({ what, status: 403, message });
		}
		expectUnchanged(before);
		expect(peopleLines()).toEqual([]);
		expect(changes()).toEqual([]);

		// (j) The same rename with a session, as the People page sends it.
		const bySession = sessionLocals(admin);
		const renamed = outcome(() => writeAs(bySession, (caller) => updatePerson(caller, { personId: ann }, { fullName: 'Y' }, UI)));
		expect(renamed).toMatchObject({ answered: { id: ann, fullName: 'Y', email: 'ann.lee@example.test' } });
		expect(personRow(ann)).toMatchObject({ full_name: 'Y' });
		expect(changes()).toEqual([
			{ actorUserId: admin.id, actorName: 'admin', source: 'ui', subject: 'person', subjectId: ann, kind: 'updated', before: { fullName: 'Ann Lee' }, after: { fullName: 'Y' } }
		]);
	});

	it('logs and records as the API what a key writes though the route said ui: a group made, described and filled, and a job title (11, the code review S6 and F2)', () => {
		const ann = makePerson('Ann Lee', 'ann.lee@example.test', { jobTitle: 'Clerk' });
		const bob = makePerson('Bob Hart', 'bob@example.test');
		const byKey = keyLocals(admin);
		const UI: ServiceOptions = { source: 'ui' };

		// (k) A group made: answered in the key shape, its line through the API.
		const made = outcome(() => writeAs(byKey, (caller) => createGroup(caller, {}, { name: 'Finance', description: 'Month end' }, UI)));
		expect(made).toMatchObject({ answered: { name: 'Finance', personIds: [], untrusted: true } });
		const group = (made as { answered: { id: number } }).answered.id;
		// (l) Its description changed, and (m) its people set, out of order: answered sorted (F4).
		expect(outcome(() => writeAs(byKey, (caller) => updateGroup(caller, { groupId: group }, { description: 'Quarter end' }, UI)))).toMatchObject({
			answered: { description: 'Quarter end', personIds: [], untrusted: true }
		});
		expect(outcome(() => writeAs(byKey, (caller) => setGroupMembers(caller, { groupId: group }, { personIds: [bob, ann] }, UI)))).toMatchObject({
			answered: { personIds: [ann, bob], untrusted: true }
		});
		// (n) A job title.
		expect(outcome(() => writeAs(byKey, (caller) => updatePerson(caller, { personId: ann }, { jobTitle: 'Head' }, UI)))).toMatchObject({
			answered: { jobTitle: 'Head', untrusted: true }
		});

		const lines = peopleLines();
		expect(lines.map((line) => line.message)).toEqual([
			`Group ${group} "Finance" added (by admin, through the API)`,
			`Group ${group} "Finance" changed: description (by admin, through the API)`,
			`Group ${group} "Finance" members set: 2 (by admin, through the API)`,
			`Person ${ann} "Ann Lee" changed: job title (by admin, through the API)`
		]);
		expect(lines.map(metaOf)).toEqual([
			{ groupId: group, ...KEYED },
			{ groupId: group, fields: ['description'], ...KEYED, before: { description: 'Month end' } },
			{ groupId: group, personIds: [bob, ann], ...KEYED, before: { personIds: [] } },
			expect.objectContaining({ personId: ann, ...KEYED, before: { jobTitle: 'Clerk' } })
		]);
		const by = { actorUserId: admin.id, actorName: 'admin', source: 'api' };
		expect(changes()).toEqual([
			{ ...by, subject: 'group', subjectId: group, kind: 'created', before: null, after: { name: 'Finance', description: 'Month end', personIds: [] } },
			{ ...by, subject: 'group', subjectId: group, kind: 'updated', before: { description: 'Month end' }, after: { description: 'Quarter end' } },
			{ ...by, subject: 'group', subjectId: group, kind: 'members_set', before: { personIds: [] }, after: { personIds: [ann, bob] } },
			{ ...by, subject: 'person', subjectId: ann, kind: 'updated', before: { jobTitle: 'Clerk' }, after: { jobTitle: 'Head' } }
		]);
	});

	it('asks the caller first and reads no row for a refused body: a non-administrator is told admin access is required, and an unknown person is not looked for (12)', () => {
		const user = makeUser({ username: 'user' });
		const ann = makePerson('Ann Lee', 'ann.lee@example.test');

		// (a) A key of a user who is no administrator: the route's words, not the key words.
		const byUser = keyLocals(user);
		expect(outcome(() => writeAs(byUser, (caller) => updatePerson(caller, { personId: ann }, { email: 'x@example.test' }, V1)))).toEqual({
			status: 403,
			message: ADMIN
		});

		// (b) An administrator's key, a person who is not there: the body is refused before the person is looked for.
		const byAdmin = keyLocals(admin);
		expect(outcome(() => writeAs(byAdmin, (caller) => updatePerson(caller, { personId: 999999 }, { email: 'x@example.test' }, V1)))).toEqual({
			status: 403,
			message: KEY_FIELD_WORDS
		});
		expect(personRow(ann)).toMatchObject({ email: 'ann.lee@example.test' });
	});

	it('logs every rename, on the People page, from the old name to the new; the message as before (14)', async () => {
		const finance = makeGroup('Finance');
		const ann = makePerson('Ann Lee', 'ann.lee@example.test', { groupIds: [finance] });
		const credential = sessionCredential(makeSession(admin));

		const person = await api('PUT', `/api/people/${ann}`, { user: admin, credential, body: { fullName: 'Ann Leigh' } });
		expect(person.status, JSON.stringify(person.body)).toBe(200);
		const group = await api('PUT', `/api/people-groups/${finance}`, { user: admin, credential, body: { name: 'Accounts' } });
		expect(group.status, JSON.stringify(group.body)).toBe(200);

		const [personLine, groupLine] = peopleLines();
		expect(personLine.message).toBe(`Person ${ann} "Ann Leigh" changed: name (by admin)`);
		expect(metaOf(personLine)).toMatchObject({ renamed: { from: 'Ann Lee', to: 'Ann Leigh' } });
		expect(metaOf(personLine)).not.toHaveProperty('source');
		expect(groupLine.message).toBe(`Group ${finance} "Accounts" changed: name (by admin)`);
		expect(metaOf(groupLine)).toMatchObject({ renamed: { from: 'Finance', to: 'Accounts' } });
		expect(groupRow(finance)).toMatchObject({ name: 'Accounts' });
		expect(groupsOf(ann)).toEqual([finance]);
		expect(membersOf(finance)).toEqual([ann]);
	});
});

// ─── The v1 routes (slice 2) ────────────────────────────────────────────────

describe('GET /api/v1/people and GET /api/v1/people-groups', () => {
	/** An account with an id no other row here has, so that it can be looked for in an answer's text. */
	const anAccount = () => {
		sqlite.prepare("INSERT INTO users (id, username, email, password_hash, role) VALUES (4242, 'zed', 'zed@example.test', ?, 'user')").run(newFixtureHash());
		return 4242;
	};

	it('lists every person by name, each exactly as Person, untrusted, leftAt in ISO, with no address and no account id anywhere (1)', async () => {
		const finance = makeGroup('Finance');
		const zed = makePerson('Zed Ray', 'zed.ray@example.test', { userId: anAccount(), groupIds: [finance], jobTitle: 'Clerk' });
		const ann = makePerson('Ann Lee', 'ann.lee@example.test', { status: 'left' });

		const res = await asKey('GET', '/api/v1/people');

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.map((p: Row) => p.id)).toEqual([ann, zed]);
		for (const item of res.body) {
			expect(keysOf(item)).toEqual(PERSON_KEYS);
			expect(item.untrusted).toBe(true);
		}
		expect(res.body[0]).toMatchObject({ fullName: 'Ann Lee', status: 'left', leftAt: '2026-10-01T09:00:00.000Z', groupIds: [] });
		expect(res.body[1]).toMatchObject({ fullName: 'Zed Ray', status: 'active', leftAt: null, jobTitle: 'Clerk', groupIds: [finance] });
		const text = JSON.stringify(res.body);
		for (const never of ['ann.lee@example.test', 'zed.ray@example.test', '@', '4242', 'userId', 'email']) expect(text).not.toContain(never);
	});

	it('lists every group by name, each with its people, a person who left included, its description, untrusted (2)', async () => {
		const legal = makeGroup('Legal', 'Contracts');
		const finance = makeGroup('Finance', 'Month end');
		const ann = makePerson('Ann Lee', 'ann.lee@example.test', { status: 'left', groupIds: [finance] });
		const bob = makePerson('Bob Hart', 'bob@example.test', { groupIds: [finance] });

		const res = await asKey('GET', '/api/v1/people-groups');

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toEqual([
			{ id: finance, name: 'Finance', description: 'Month end', createdAt: expect.stringMatching(/Z$/), personIds: [ann, bob], untrusted: true },
			{ id: legal, name: 'Legal', description: 'Contracts', createdAt: expect.stringMatching(/Z$/), personIds: [], untrusted: true }
		]);
		for (const item of res.body) expect(keysOf(item)).toEqual(GROUP_KEYS);
	});
});

describe('PATCH /api/v1/people/{personId}', () => {
	let finance: number;
	let legal: number;
	let ann: number;
	let live: number;

	beforeEach(() => {
		finance = makeGroup('Finance');
		legal = makeGroup('Legal');
		ann = makePerson('Ann Lee', 'ann.lee@example.test', { groupIds: [finance], jobTitle: 'Clerk' });
		live = aLiveLink(ann);
	});

	it('saves a job title and groups of a person holding a live link, answers no address or account, and logs it through the API with what it replaced (3)', async () => {
		const res = await asKey('PATCH', `/api/v1/people/${ann}`, { jobTitle: 'Head of Finance', groupIds: [legal] });

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(keysOf(res.body)).toEqual(PERSON_KEYS);
		expect(res.body).toMatchObject({ id: ann, jobTitle: 'Head of Finance', groupIds: [legal], untrusted: true });
		expect(personRow(ann)).toMatchObject({ job_title: 'Head of Finance', email: 'ann.lee@example.test' });
		expect(groupsOf(ann)).toEqual([legal]);
		const lines = peopleLines();
		expect(lines).toHaveLength(1);
		expect(lines[0].message).toBe(`Person ${ann} "Ann Lee" changed: job title, groups (by admin, through the API)`);
		expect(metaOf(lines[0])).toMatchObject({ ...KEYED, before: { jobTitle: 'Clerk', groupIds: [finance] } });
		// Kept for good beside the pruned line (the code review's S1).
		expect(changes()).toEqual([
			{
				actorUserId: admin.id,
				actorName: 'admin',
				source: 'api',
				subject: 'person',
				subjectId: ann,
				kind: 'updated',
				before: { jobTitle: 'Clerk', groupIds: [finance] },
				after: { jobTitle: 'Head of Finance', groupIds: [legal] }
			}
		]);
		expect(linkOf(live)).toBe('hash-live');
		expect(eventCount()).toBe(0);
	});

	it('refuses 403 email, userId, status and fullName whatever they hold, the whole body with them, and leaves the person and their link as they were (4)', async () => {
		const bodies: [string, Row][] = [
			['(a) the stored address', { email: 'ann.lee@example.test' }],
			['(b) no account', { userId: null }],
			['(c) the stored status', { status: 'active' }],
			['(d) the stored name', { fullName: 'Ann Lee' }],
			['(e) left', { status: 'left' }],
			['(f) a new address', { email: 'ann.new@example.test' }],
			['(g) a job title beside a name', { jobTitle: 'X', fullName: 'Y' }]
		];
		const before = snapshotDb();

		for (const [what, body] of bodies) {
			const res = await asKey('PATCH', `/api/v1/people/${ann}`, body);
			expect({ what, status: res.status, body: res.body }).toEqual({ what, status: 403, body: { message: KEY_FIELD_WORDS } });
		}

		expectUnchanged(before);
		expect(personRow(ann)).toMatchObject({ job_title: 'Clerk', updated_at: '2026-01-01 00:00:00', status: 'active' });
		expect(linkOf(live)).toBe('hash-live');
		expect(countOf("decision_events WHERE kind = 'link_revoked'")).toBe(0);
		expect(peopleLines()).toEqual([]);
	});

	it('ignores a key the body reader never reads, Email and __proto__, and saves the job title beside it (5)', async () => {
		const upper = await asKey('PATCH', `/api/v1/people/${ann}`, { Email: 'x@example.test', jobTitle: 'A' });
		expect(upper.status, JSON.stringify(upper.body)).toBe(200);
		expect(personRow(ann)).toMatchObject({ job_title: 'A', email: 'ann.lee@example.test' });

		// Sent as bytes: an object literal's __proto__ sets its prototype, and would not be sent.
		const proto = await api('PATCH', `/api/v1/people/${ann}`, {
			user: admin,
			credential: keyCredential(admin),
			body: Buffer.from('{"__proto__":{"email":"x@example.test"},"jobTitle":"B"}'),
			headers: { 'content-type': 'application/json' }
		});
		expect(proto.status, JSON.stringify(proto.body)).toBe(200);
		expect(personRow(ann)).toMatchObject({ job_title: 'B', email: 'ann.lee@example.test' });
		expect(JSON.stringify([upper.body, proto.body])).not.toContain('example.test');
	});

	it('answers a change that changes nothing, of a person and of a group, in the key shape, and logs nothing (6)', async () => {
		const group = makeGroup('Operations', 'Month end');
		sqlite.prepare('INSERT INTO people_group_members (group_id, person_id) VALUES (?, ?)').run(group, ann);
		const before = snapshotDb();

		const person = await asKey('PATCH', `/api/v1/people/${ann}`, { jobTitle: 'Clerk' });
		const described = await asKey('PATCH', `/api/v1/people-groups/${group}`, { description: 'Month end' });

		expect(person.status, JSON.stringify(person.body)).toBe(200);
		expect(keysOf(person.body)).toEqual(PERSON_KEYS);
		expect(person.body).toMatchObject({ id: ann, untrusted: true, groupIds: [finance, group] });
		expect(described.status, JSON.stringify(described.body)).toBe(200);
		expect(described.body).toEqual({ id: group, name: 'Operations', description: 'Month end', createdAt: expect.stringMatching(/Z$/), personIds: [ann], untrusted: true });
		expectUnchanged(before);
		expect(peopleLines()).toEqual([]);
	});
});

describe('the groups under v1', () => {
	it('POST /api/v1/people-groups makes a group with nobody in it, untrusted, and logs it through the API with no before (7)', async () => {
		const res = await asKey('POST', '/api/v1/people-groups', { name: ' Finance ', description: 'Month end' });

		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body).toEqual({ id: expect.any(Number), name: 'Finance', description: 'Month end', createdAt: expect.stringMatching(/Z$/), personIds: [], untrusted: true });
		const lines = peopleLines();
		expect(lines).toHaveLength(1);
		expect(lines[0].message).toBe(`Group ${res.body.id} "Finance" added (by admin, through the API)`);
		expect(metaOf(lines[0])).toMatchObject({ source: 'api' });
		expect(metaOf(lines[0])).not.toHaveProperty('before');
	});

	it('PATCH /api/v1/people-groups/{groupId} changes the description, logging the one it replaced, and refuses 403 a name, the stored one included (8)', async () => {
		const finance = makeGroup('Finance', 'Month end');
		const ann = makePerson('Ann Lee', 'ann.lee@example.test', { groupIds: [finance] });

		// (a) The description.
		const res = await asKey('PATCH', `/api/v1/people-groups/${finance}`, { description: 'Quarter end' });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toMatchObject({ id: finance, description: 'Quarter end', personIds: [ann], untrusted: true });
		const lines = peopleLines();
		expect(lines).toHaveLength(1);
		expect(lines[0].message).toBe(`Group ${finance} "Finance" changed: description (by admin, through the API)`);
		expect(metaOf(lines[0])).toMatchObject({ source: 'api', before: { description: 'Month end' } });

		// (b) The stored name and (c) a new one.
		const before = snapshotDb();
		for (const name of ['Finance', 'New']) {
			const refused = await asKey('PATCH', `/api/v1/people-groups/${finance}`, { name, description: 'Year end' });
			expect({ name, status: refused.status, body: refused.body }).toEqual({ name, status: 403, body: { message: KEY_RENAME_WORDS } });
		}
		expectUnchanged(before);
		expect(peopleLines()).toHaveLength(1);
	});

	it('PUT /api/v1/people-groups/{groupId}/members replaces the set, and logs it through the API with the set it replaced (9)', async () => {
		const ann = makePerson('Ann Lee', 'ann.lee@example.test');
		const bob = makePerson('Bob Hart', 'bob@example.test');
		const cy = makePerson('Cy Moss', 'cy@example.test');
		const finance = makeGroup('Finance');
		for (const person of [ann, bob]) sqlite.prepare('INSERT INTO people_group_members (group_id, person_id) VALUES (?, ?)').run(finance, person);

		// Sent out of order: answered smallest first, as the list answers it (the code review's F4).
		const res = await asKey('PUT', `/api/v1/people-groups/${finance}/members`, { personIds: [cy, ann] });

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toMatchObject({ id: finance, personIds: [ann, cy], untrusted: true });
		expect(keysOf(res.body)).toEqual(GROUP_KEYS);
		expect(membersOf(finance)).toEqual([ann, cy]);
		const listed = await asKey('GET', '/api/v1/people-groups');
		expect(listed.body.find((group: Row) => group.id === finance).personIds).toEqual(res.body.personIds);
		const lines = peopleLines();
		expect(lines).toHaveLength(1);
		expect(lines[0].message).toBe(`Group ${finance} "Finance" members set: 2 (by admin, through the API)`);
		expect(metaOf(lines[0])).toMatchObject({ ...KEYED, personIds: [cy, ann], before: { personIds: [ann, bob] } });
		expect(changes()).toMatchObject([{ source: 'api', subject: 'group', subjectId: finance, kind: 'members_set', before: { personIds: [ann, bob] }, after: { personIds: [ann, cy] } }]);
	});
});

describe('through the gate, with a real key', () => {
	it('answers POST /api/v1/people 405, the address of a person 403 by the credential the hook set, and a non-administrator Admin access required (13)', async () => {
		const ann = makePerson('Ann Lee', 'ann.lee@example.test');
		const bearer = (user: SessionUser) => ({ authorization: `Bearer ${makeApiKey(user)}` });
		const withKey = bearer(admin);

		// (a) No add through the API.
		const add = await gate('POST', '/api/v1/people', { headers: withKey, body: { fullName: 'Bob Hart', email: 'bob@example.test' } });
		expect(add.status).toBe(405);
		expect(add.headers.get('content-type')).toBe('application/json');
		expect(await add.json()).toEqual({ message: 'POST method not allowed' });
		expect(add.headers.get('allow')).toBe('GET, HEAD');
		expect(countOf('people')).toBe(1);

		// (b) An address, refused by the route's word and the key the hook let the write in with.
		const address = await gate('PATCH', `/api/v1/people/${ann}`, { headers: withKey, body: { email: 'ann.new@example.test' } });
		expect(address.status).toBe(403);
		expect(await address.json()).toEqual({ message: KEY_FIELD_WORDS });
		expect(personRow(ann)).toMatchObject({ email: 'ann.lee@example.test' });

		// (c) A key of a user who is no administrator.
		const listed = await gate('GET', '/api/v1/people', { headers: bearer(makeUser({ username: 'user' })) });
		expect(listed.status).toBe(403);
		expect(await listed.json()).toEqual({ message: ADMIN });
	});
});

describe('people_changes, the record every change is put back from (the code review S1)', () => {
	it('appends one row for each change of the People page, with what it was and became, never an address or an account id, and keeps it when its subject is deleted (16)', () => {
		const account = makeUser({ username: 'sam' });
		const other = makeUser({ username: 'tia' });
		const finance = makeGroup('Finance', 'Month end');
		const page = sessionLocals(admin);
		const UI: ServiceOptions = { source: 'ui' };
		const run = (write: (caller: SessionUser | null) => unknown): unknown => writeAs(page, write);

		// A person added, linked to an account and in a group.
		const added = run((caller) => createPerson(caller, {}, { fullName: 'Ann Lee', email: 'ann.lee@example.test', jobTitle: 'Clerk', userId: account.id, groupIds: [finance] }, UI)) as {
			id: number;
		};
		// Changed: renamed, re-addressed, relinked, marked left and taken out of the group.
		run((caller) => updatePerson(caller, { personId: added.id }, { fullName: 'Ann Leigh', email: 'ann.leigh@example.test', userId: other.id, status: 'left', groupIds: [] }, UI));
		// Added from an account, and the group renamed, filled and deleted.
		run((caller) => addFromAccounts(caller, {}, { userIds: [account.id] }, UI));
		const sam = (sqlite.prepare("SELECT id FROM people WHERE full_name = 'sam'").get() as { id: number }).id;
		run((caller) => updateGroup(caller, { groupId: finance }, { name: 'Accounts' }, UI));
		run((caller) => setGroupMembers(caller, { groupId: finance }, { personIds: [sam, added.id] }, UI));
		run((caller) => deleteGroup(caller, { groupId: finance }, null, UI));
		// And the person deleted.
		run((caller) => deletePerson(caller, { personId: added.id }, null, UI));

		const by = { actorUserId: admin.id, actorName: 'admin', source: 'ui' };
		const rows = changes();
		expect(rows).toEqual([
			{
				...by,
				subject: 'person',
				subjectId: added.id,
				kind: 'created',
				before: null,
				after: { fullName: 'Ann Lee', jobTitle: 'Clerk', status: 'active', leftAt: null, groupIds: [finance] }
			},
			{
				...by,
				subject: 'person',
				subjectId: added.id,
				kind: 'updated',
				before: { fullName: 'Ann Lee', status: 'active', leftAt: null, groupIds: [finance] },
				after: { fullName: 'Ann Leigh', status: 'left', leftAt: expect.any(String), groupIds: [], addressChanged: true, account: 'linked' }
			},
			{ ...by, subject: 'person', subjectId: sam, kind: 'created', before: null, after: { fullName: 'sam', jobTitle: '', status: 'active', leftAt: null, groupIds: [] } },
			{ ...by, subject: 'group', subjectId: finance, kind: 'updated', before: { name: 'Finance' }, after: { name: 'Accounts' } },
			{ ...by, subject: 'group', subjectId: finance, kind: 'members_set', before: { personIds: [] }, after: { personIds: [added.id, sam].sort((a, b) => a - b) } },
			{
				...by,
				subject: 'group',
				subjectId: finance,
				kind: 'deleted',
				before: { name: 'Accounts', description: 'Month end', personIds: [added.id, sam].sort((a, b) => a - b) },
				after: null
			},
			{
				...by,
				subject: 'person',
				subjectId: added.id,
				kind: 'deleted',
				before: { fullName: 'Ann Leigh', jobTitle: 'Clerk', status: 'left', leftAt: expect.any(String), groupIds: [] },
				after: null
			}
		]);
		// No address and no account id in any row, the subject's delete leaving its rows.
		const text = JSON.stringify(sqlite.prepare('SELECT before, after FROM people_changes').all());
		for (const never of ['@', 'email', 'userId', 'user_id']) expect(text).not.toContain(never);
		expect(personRow(added.id)).toBeUndefined();
		expect(groupRow(finance)).toBeUndefined();
		expect(rows.filter((row) => row.subjectId === added.id && row.subject === 'person')).toHaveLength(3);
	});
});

describe('the v1 routes call no People-page-only write', () => {
	it('names createPerson, deletePerson, addFromAccounts, their guards and deleteGroup in no file under src/routes/api/v1 (15)', () => {
		const root = join(process.cwd(), 'src', 'routes', 'api', 'v1');
		const files = (readdirSync(root, { recursive: true }) as string[]).filter((file) => file.endsWith('.ts'));
		const NEVER = ['createPerson', 'deletePerson', 'addFromAccounts', 'personCreateGuard', 'personDeleteGuard', 'fromAccountsGuard', 'deleteGroup'];

		const named = files.flatMap((file) => {
			const source = readFileSync(join(root, file), 'utf8');
			return NEVER.filter((name) => new RegExp(`\\b${name}\\b`).test(source)).map((name) => `${file}: ${name}`);
		});

		expect(named).toEqual([]);
		expect(files.length).toBeGreaterThan(40);
	});
});

// ─── Card 2671 (case 26, S2): a disabled account is no one to link or add ────

describe('a disabled account, on the People page (card 2671)', () => {
	it.each([
		{ route: 'POST /api/people, linked to it', path: '/api/people', body: (id: number) => ({ fullName: 'Gone Away', email: 'gone.away@example.test', userId: id }) },
		{ route: 'POST /api/people/from-accounts, naming it', path: '/api/people/from-accounts', body: (id: number) => ({ userIds: [id] }) }
	])('case 26: $route is refused 400, and nothing is written', async ({ path, body }) => {
		const gone = makeUser({ username: 'gone', disabled: true });
		const sending = stepUp(admin, body(gone.id));
		const before = snapshotDb();

		const res = await api('POST', path, sending);

		expect({ status: res.status, body: res.body }).toEqual({ status: 400, body: { message: `userId ${gone.id} is a disabled account` } });
		expectUnchanged({ ...before, sessions: snapshotDb().sessions, mfa_factors: snapshotDb().mfa_factors });
		expect(countOf('people')).toBe(0);
	});
});
