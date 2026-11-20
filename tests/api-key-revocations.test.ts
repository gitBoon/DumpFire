/**
 * Card 2995: a restore never brings back an API key ended on this server.
 *
 * `api_key_revocations` (migration 0076) records every key ended here by its row id and its SHA-256, never the key.
 * One rule (`keyRecordedSelect` in src/lib/server/key-revocations.ts) says whether the record names a key: a row of
 * its hash, or a seed row of its id where that id is at most the watermark W (the plan review's R1). The gate,
 * `stillAuthenticated`, every list of live keys and the webhooks' hold rule ask it through `keyEnded` (R7); the
 * restore's leave-out shares it (R6). Every ender records through `endApiKeys` (R14), and the start and the
 * five-minute sweep end any present key the record names, as a revoke ends it (R7).
 *
 * The restore's cases are in tests/backups.test.ts, the gate's in tests/gate.test.ts, the migration's in
 * tests/migrations.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { db, sqlite } from '$lib/server/db';
import { inTransaction } from '$lib/server/db/transaction';
import { users } from '$lib/server/db/schema';
import { SESSION_COOKIE_NAME, endAccountAccess, type SessionUser } from '$lib/server/auth';
import { disableAccount } from '$lib/server/account-disable';
import { deleteUser } from '$lib/server/deletes';
import { KEY_RECORDED_SQL, endApiKeys, keyRecorded, raiseKeyCounterOverRecord, watermarkOf } from '$lib/server/key-revocations';
import { sweepEndedKeyReveals } from '$lib/server/startup-checks';
import { resetAllRateLimits } from '$lib/server/rate-limit';
import { api } from './helpers/api';
import { FROM_THE_PAGE, gate } from './helpers/gate';
import { addBoardMember, makeApiKeyRow, makeBoard, makeSession, makeUser, makeWebhook, resetDb, startedSinceAlreadyOffHeld, stepUp } from './helpers/fixtures';

const record = (id: number, hash: string, because = 'revoked') =>
	sqlite
		.prepare("INSERT INTO api_key_revocations (key_id, key_hash, revoked_at, revoked_because) VALUES (?, ?, '2026-11-19 09:00:00', ?)")
		.run(id, hash, because);
const counter = () => sqlite.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'api_keys'").pluck().get() as number | undefined;
/** The record, by id, hash and word, without its moments. */
const recordOf = () =>
	sqlite.prepare('SELECT key_id AS id, key_hash AS hash, revoked_because AS because FROM api_key_revocations ORDER BY key_id, key_hash').all() as {
		id: number;
		hash: string;
		because: string;
	}[];
const hashOf = (id: number) => sqlite.prepare('SELECT key_hash FROM api_keys WHERE id = ?').pluck().get(id) as string | undefined;
const rowOf = (id: number) => sqlite.prepare('SELECT active, held_because AS heldBecause, set_by_key AS setByKey FROM webhooks WHERE id = ?').get(id);
const v1 = async (key: string) => (await gate('GET', '/api/v1/me', { headers: { authorization: `Bearer ${key}` } })).status;

let level: string | undefined;
beforeEach(() => {
	resetDb();
	resetAllRateLimits();
	// The lines a start writes are WARN and INFO, which the tests' LOG_LEVEL drops.
	level = process.env.LOG_LEVEL;
	process.env.LOG_LEVEL = 'INFO';
});
afterEach(() => {
	if (level === undefined) delete process.env.LOG_LEVEL;
	else process.env.LOG_LEVEL = level;
	vi.restoreAllMocks();
});

describe('the one rule of the record (card 2995, R1, R9)', () => {
	it('(e): the gate’s statement searches the record’s key and never scans it', () => {
		const plan = (sqlite.prepare(`EXPLAIN QUERY PLAN ${KEY_RECORDED_SQL}`).all({ id: 1, hash: 'a'.repeat(64) }) as { detail: string }[]).map((row) => row.detail);

		expect(plan.join('\n')).not.toMatch(/SCAN/);
		// Each of the three reads is a search on the primary key (key_hash, key_id), the only index the table has.
		expect(plan.filter((detail) => /^SEARCH kr_[hsw] USING COVERING INDEX sqlite_autoindex_api_key_revocations_1 /.test(detail))).toHaveLength(3);
		expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'api_key_revocations'").pluck().all()).toEqual([
			'sqlite_autoindex_api_key_revocations_1'
		]);
	});

	it('names a key by its hash, or by a seed row of its id at or below the watermark; never by a hashed row’s id; with no watermark, by any seed row', () => {
		const key = { id: 7, keyHash: 'b'.repeat(64) };
		expect(keyRecorded(sqlite, key)).toBe(false);

		record(7, 'c'.repeat(64));
		expect(keyRecorded(sqlite, key)).toBe(false);

		record(7, '', 'before record');
		expect(keyRecorded(sqlite, key)).toBe(true);
		record(6, 'watermark', 'before record');
		expect(watermarkOf(sqlite)).toBe(6);
		expect(keyRecorded(sqlite, key)).toBe(false);
		record(9, 'watermark', 'before record');
		expect(watermarkOf(sqlite)).toBe(9);
		expect(keyRecorded(sqlite, key)).toBe(true);

		record(99, 'b'.repeat(64));
		expect(keyRecorded(sqlite, { id: 1000, keyHash: 'b'.repeat(64) })).toBe(true);
	});

	it('raises the key counter over every id the record names, seed, hashed and the watermark alike, writing its row where there is none, and never lowers it (FP1)', () => {
		const owner = makeUser();
		makeApiKeyRow(owner);
		const made = counter() as number;
		record(made + 20, '', 'before record');
		raiseKeyCounterOverRecord(sqlite);
		expect(counter()).toBe(made + 20);
		record(made + 40, 'd'.repeat(64));
		raiseKeyCounterOverRecord(sqlite);
		expect(counter()).toBe(made + 40);
		record(made + 60, 'watermark', 'before record');
		raiseKeyCounterOverRecord(sqlite);
		expect(counter()).toBe(made + 60);
		record(3, '', 'before record');
		raiseKeyCounterOverRecord(sqlite);
		expect(counter()).toBe(made + 60);

		sqlite.prepare("DELETE FROM sqlite_sequence WHERE name = 'api_keys'").run();
		raiseKeyCounterOverRecord(sqlite);
		expect(counter()).toBe(made + 60);
		// A record of the watermark 0 alone writes no counter row.
		sqlite.prepare('DELETE FROM api_key_revocations').run();
		sqlite.prepare("DELETE FROM sqlite_sequence WHERE name = 'api_keys'").run();
		record(0, 'watermark', 'before record');
		raiseKeyCounterOverRecord(sqlite);
		expect(counter()).toBeUndefined();
	});
});

describe('every ender records the keys it ends, in its own transaction (card 2995)', () => {
	let chief: SessionUser;
	let ann: SessionUser;

	beforeEach(() => {
		chief = makeUser({ username: 'chief', role: 'superadmin' });
		ann = makeUser({ username: 'ann' });
	});

	it('(f): endApiKeys on a connection with no open transaction throws and writes nothing, whatever the server’s connection has open (R14)', () => {
		const K = makeApiKeyRow(ann);
		const other = new Database(':memory:');
		try {
			expect(() => endApiKeys(sqlite, { keyId: K.id }, 'revoked')).toThrow(/none is open on the connection it was given/);
			// The server's connection in a transaction does not stand for the one it was given.
			expect(() => inTransaction(() => endApiKeys(other, { keyId: K.id }, 'revoked'))).toThrow(/none is open on the connection it was given/);
		} finally {
			other.close();
		}
		expect(recordOf()).toEqual([]);
		expect(hashOf(K.id)).toBeDefined();
	});

	it('test 17: the revoke records the key’s id and hash, revoked, in its transaction', async () => {
		const K = makeApiKeyRow(ann);
		const hash = hashOf(K.id)!;

		const res = await api('DELETE', `/api/account/api-keys/${K.id}`, { user: ann });

		expect(res.status).toBe(200);
		expect(recordOf()).toEqual([{ id: K.id, hash, because: 'revoked' }]);
		expect(await v1(K.key)).toBe(401);
	});

	it('test 17: a revoke whose record cannot be written is 500: the key is still there and still works, and its webhooks are as they were', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const board = makeBoard({ owner: ann }).board;
		const K = makeApiKeyRow(ann);
		const hook = makeWebhook(board, { setBy: ann, secret: 'whsec-17', setWithKey: true, setByKey: K.id }).id;
		const before = rowOf(hook);
		sqlite.exec("CREATE TEMP TRIGGER refuse_17 BEFORE INSERT ON api_key_revocations BEGIN SELECT RAISE(ABORT, 'refused by test 17'); END");
		try {
			// Through the gate, as the Account page sends it, so that the failure is answered as one is.
			const res = await gate('DELETE', `/api/account/api-keys/${K.id}`, {
				headers: { cookie: `${SESSION_COOKIE_NAME}=${makeSession(ann)}`, 'content-type': 'application/json', ...FROM_THE_PAGE },
				body: '{}'
			});
			expect(res.status).toBe(500);
		} finally {
			sqlite.exec('DROP TRIGGER IF EXISTS temp.refuse_17');
		}

		expect(hashOf(K.id)).toBeDefined();
		expect(recordOf()).toEqual([]);
		expect(rowOf(hook)).toEqual(before);
		expect(await v1(K.key)).toBe(200);
	});

	it.each([
		{ apiKeys: true, recorded: true },
		{ apiKeys: false, recorded: false }
	])('test 18: endAccountAccess with apiKeys $apiKeys records every key of the account, access ended: $recorded', ({ apiKeys, recorded }) => {
		const first = makeApiKeyRow(ann);
		const second = makeApiKeyRow(ann);
		const theirs = makeApiKeyRow(chief);

		inTransaction(() => endAccountAccess(ann.id, { apiKeys, cause: { log: 'a test', mail: 'a test' } }));

		expect(recordOf()).toEqual(
			recorded
				? [
						{ id: first.id, hash: expect.stringMatching(/^[0-9a-f]{64}$/), because: 'access ended' },
						{ id: second.id, hash: expect.stringMatching(/^[0-9a-f]{64}$/), because: 'access ended' }
					]
				: []
		);
		expect(hashOf(theirs.id)).toBeDefined();
	});

	it.each([
		{ kept: 'none', recordFirst: false },
		{ kept: 'the first key, by id, hash and owner', recordFirst: true }
	])('(d2) card 3013 (R8): endApiKeys with recordOnly naming $kept deletes both of the account’s keys and records only the one it names', ({ recordFirst }) => {
		const first = makeApiKeyRow(ann);
		const second = makeApiKeyRow(ann);
		const theirs = makeApiKeyRow(chief);
		const hash = hashOf(first.id)!;
		const recordOnly = recordFirst ? [[first.id, hash, ann.id] as const] : [];

		const ended = inTransaction(() => endApiKeys(sqlite, { userId: ann.id }, 'access ended', { recordOnly }));

		expect(ended).toEqual([first.id, second.id]);
		expect(hashOf(first.id)).toBeUndefined();
		expect(hashOf(second.id)).toBeUndefined();
		expect(recordOf()).toEqual(recordFirst ? [{ id: first.id, hash, because: 'access ended' }] : []);
		expect(hashOf(theirs.id)).toBeDefined();
	});

	it('test 19: deleteUser of a disabled account still holding a key records it, account deleted, before the user row goes', () => {
		inTransaction(() => disableAccount(db.select().from(users).all().find((u) => u.id === ann.id)!, chief));
		// As a restore from before card 2671's carry, or a host edit, leaves one.
		const K = makeApiKeyRow(ann);
		const hash = hashOf(K.id)!;

		const removed = deleteUser(ann.id, chief);

		expect(removed).not.toBeNull();
		expect(recordOf()).toContainEqual({ id: K.id, hash, because: 'account deleted' });
		expect(hashOf(K.id)).toBeUndefined();
	});
});

describe('a present key the record names is ended at start and by the five-minute sweep (card 2995, R7)', () => {
	const authWarnings = () =>
		sqlite.prepare("SELECT message, meta FROM system_logs WHERE context = 'AUTH' AND level = 'WARN' ORDER BY id").all() as { message: string; meta: string | null }[];
	const lines = () => (sqlite.prepare('SELECT COUNT(*) AS n FROM system_logs').get() as { n: number }).n;

	it('(i): the key is deleted, what it set held key ended and what it was given held, one WARN naming it by id alone; a second start does nothing', () => {
		startedSinceAlreadyOffHeld();
		makeUser({ username: 'chief', role: 'superadmin' });
		const owner = makeUser({ username: 'olga' });
		const eve = makeUser({ username: 'eve' });
		const board = makeBoard({ owner }).board;
		addBoardMember(board, eve, 'editor');
		const K = makeApiKeyRow(owner);
		const V = makeWebhook(board, { setBy: owner, secret: 'whsec-v-i', setWithKey: true, setByKey: K.id }).id;
		const W = makeWebhook(board, { setBy: eve, secret: 'whsec-w-i' }).id;
		sqlite.prepare("INSERT INTO webhook_reveals (webhook_id, key_id, revealed_at) VALUES (?, ?, '2026-11-19 09:00:00')").run(W, K.id);
		// The record names it, the key present as an older image's import would leave it.
		const hash = hashOf(K.id)!;
		record(K.id, hash);

		const done = sweepEndedKeyReveals('off', false);

		expect(done).toBe(2);
		expect(hashOf(K.id)).toBeUndefined();
		expect(rowOf(V)).toEqual({ active: 0, heldBecause: 'key ended', setByKey: null });
		expect(rowOf(W)).toEqual({ active: 0, heldBecause: 'setter access ended', setByKey: null });
		const warned = authWarnings();
		expect(warned).toHaveLength(1);
		expect(warned[0].message).toMatch(/^1 API key\(s\) that the record of keys ended on this server names were present/);
		expect(JSON.parse(warned[0].meta!)).toEqual({ keyIds: [K.id] });
		// Neither an account, nor the key, nor its hash, in the line or its details (card 2995's code review, FP8).
		for (const said of ['olga', 'eve', hash, K.key]) expect(`${warned[0].message} ${warned[0].meta}`).not.toContain(said);
		const after = lines();

		expect(sweepEndedKeyReveals('off', false)).toBe(0);
		expect(lines()).toBe(after);
		expect(authWarnings()).toHaveLength(1);
	});

	// Card 2995's code review (FP4): the record's pass and card 2947's hold are two transactions, each with its own WARN.
	it.each([
		{ failing: 'the record’s pass', trigger: 'recorded' as const },
		{ failing: 'card 2947’s hold of what an ended key was given', trigger: 'expired' as const }
	])('a failure of $failing rolls back that pass alone, says so, and the other commits', ({ trigger }) => {
		startedSinceAlreadyOffHeld();
		makeUser({ username: 'chief', role: 'superadmin' });
		const owner = makeUser({ username: 'olga' });
		const board = makeBoard({ owner }).board;
		// A present key the record names, for the record's pass.
		const recorded = makeApiKeyRow(owner);
		record(recorded.id, hashOf(recorded.id)!);
		// An expired key given W's secret, for card 2947's hold.
		const expired = makeApiKeyRow(owner, { expiresAt: '2026-01-01 00:00:00' });
		const W = makeWebhook(board, { setBy: owner, secret: 'whsec-fp4' }).id;
		sqlite.prepare("INSERT INTO webhook_reveals (webhook_id, key_id, revealed_at) VALUES (?, ?, '2026-11-19 09:00:00')").run(W, expired.id);
		const webhookWarnings = () => sqlite.prepare("SELECT message FROM system_logs WHERE context = 'Webhooks' AND level = 'WARN' ORDER BY id").pluck().all() as string[];
		sqlite.exec(
			trigger === 'recorded'
				? `CREATE TEMP TRIGGER refuse_fp4 BEFORE DELETE ON api_keys WHEN OLD.id = ${recorded.id} BEGIN SELECT RAISE(ABORT, 'refused by FP4'); END`
				: `CREATE TEMP TRIGGER refuse_fp4 BEFORE DELETE ON webhook_reveals WHEN OLD.key_id = ${expired.id} BEGIN SELECT RAISE(ABORT, 'refused by FP4'); END`
		);
		let answer: number | null;
		try {
			answer = sweepEndedKeyReveals('off', false);
		} finally {
			sqlite.exec('DROP TRIGGER IF EXISTS temp.refuse_fp4');
		}

		expect(answer).toBeNull();
		if (trigger === 'recorded') {
			// The record's pass rolled back, and said so; the hold committed.
			expect(hashOf(recorded.id)).toBeDefined();
			expect(authWarnings().map((row) => row.message)).toEqual([expect.stringMatching(/^The API keys that the record of keys ended on this server names could not be ended: refused by FP4\./)]);
			expect(rowOf(W)).toEqual({ active: 0, heldBecause: 'setter access ended', setByKey: null });
		} else {
			// The hold rolled back, and said so; the record's pass committed.
			expect(hashOf(recorded.id)).toBeUndefined();
			expect(authWarnings().map((row) => row.message)).toEqual([expect.stringMatching(/^1 API key\(s\) that the record of keys ended on this server names were present/)]);
			expect(rowOf(W)).toEqual({ active: 1, heldBecause: null, setByKey: null });
			expect(webhookWarnings()).toContainEqual(expect.stringMatching(/^The webhooks whose secret an ended API key was given could not be held: refused by FP4\./));
		}
	});
});

describe('the Account page lists no key the record names (card 2995’s code review, FP3)', () => {
	it('GET /api/account/api-keys leaves out a recorded key, never answers a hash, and the limit of ten does not count it', async () => {
		const ann = makeUser({ username: 'ann' });
		const keys = Array.from({ length: 10 }, () => makeApiKeyRow(ann));
		record(keys[0].id, hashOf(keys[0].id)!);

		const listed = await api('GET', '/api/account/api-keys', { user: ann });

		expect(listed.status).toBe(200);
		expect((listed.body as { id: number }[]).map((key) => key.id)).toEqual(keys.slice(1).map((key) => key.id));
		expect(JSON.stringify(listed.body)).not.toMatch(/keyHash|[0-9a-f]{64}/);
		// Nine live keys: room for a tenth, the recorded one not counted.
		const made = await api('POST', '/api/account/api-keys', stepUp(ann, { name: 'The tenth' }));
		expect(made.status, JSON.stringify(made.body)).toBe(201);
	});
});
