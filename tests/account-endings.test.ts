/**
 * Card 2996: a restore never brings back an account deleted, disabled or demoted on this server.
 *
 * `account_endings` (migration 0077) records every ending of an account here by its row id and its creation time:
 * deleted (with a fingerprint of its password hash, never the hash), disabled, enabled, and its role. One rule
 * (`accountRulings` in src/lib/server/account-endings.ts) says what the record says of an account; `deletedHere`,
 * which the gates and the enable ask, is built on the same matcher (R3).
 *
 * The restore's cases are in tests/backups.test.ts, the migration's in tests/migrations.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import Database from 'better-sqlite3';
import { allowOtherTimestampForms } from './helpers/timestamps';
import { stamp } from '$lib/timestamps';
import { createHash } from 'node:crypto';
import { db, sqlite } from '$lib/server/db';
import { settings, type Board } from '$lib/server/db/schema';
import { inTransaction } from '$lib/server/db/transaction';
import { AccountDisabled, createSession, type SessionUser } from '$lib/server/auth';
import {
	CARRY_ACCOUNT_ENDING_SQL,
	CREDENTIAL_ROWS_SQL,
	DELETED_HERE_SQL,
	EXACT_ROWS_SQL,
	SEED_ROWS_SQL,
	WATERMARK_SQL,
	accountRulings,
	credentialOf,
	deletedHere,
	recordAccountEnding,
	type AccountToRule
} from '$lib/server/account-endings';
import { DELETED_HERE } from '$lib/server/account-disable';
import { deleteUser } from '$lib/server/deletes';
import { generateBackupData } from '$lib/server/backup';
import { restoreFromBackup } from '$lib/server/db/restore';
import { sweepEndedKeyReveals } from '$lib/server/startup-checks';
import { mailPlacesNow, recordDestinationSetter, recordMailSetters } from '$lib/server/setting-setters';
import { setAppUrl } from '$lib/server/email';
import { sha256Hex } from '$lib/server/mfa-crypto';
import { DUMMY_HASH } from '$lib/server/passwords';
import { resetAllRateLimits } from '$lib/server/rate-limit';
import { api } from './helpers/api';
import { action } from './helpers/actions';
import { effects } from './helpers/effects';
import { gate } from './helpers/gate';
import {
	FIXTURE_PASSWORD_HASH,
	makeApiKeyRow,
	makeBoard,
	makeSession,
	makeSmtp,
	makeUser,
	makeWebhook,
	resetDb,
	startedSinceAlreadyOffHeld,
	stepUp,
	stepUpFactor
} from './helpers/fixtures';

/** A bcrypt string of its own for each `n`, as no two accounts hold the same (the fixtures' accounts all share one). */
const hashLike = (n: number) => `$2b$04$${String(n).padStart(53, 'A')}`;

/** A row of the record, by hand: slice 2 has no writer (R8). */
const row = (
	userId: number,
	created: string,
	ending: string,
	opts: { role?: string; credential?: string; at?: string; origin?: 'here' | 'backup' } = {}
) =>
	sqlite
		.prepare('INSERT INTO account_endings (user_id, account_created, ending, role, credential, ended_at, origin) VALUES (?, ?, ?, ?, ?, ?, ?)')
		.run(userId, created, ending, opts.role ?? '', opts.credential ?? '', opts.at ?? '2026-11-20 09:00:00', opts.origin ?? 'here');

const MADE = '2026-01-01 09:00:00';
/** An account to ask about: id 7, made at MADE, a user, a hash of its own. */
const account = (over: Partial<AccountToRule> = {}): AccountToRule => ({ id: 7, createdAt: MADE, role: 'user', passwordHash: hashLike(7), ...over });
const ruled = (asked: AccountToRule, options: Parameters<typeof accountRulings>[2] = {}) => accountRulings(sqlite, [asked], options)[0] ?? null;

let level: string | undefined;
beforeEach(() => {
	resetDb();
	resetAllRateLimits();
	level = process.env.LOG_LEVEL;
});
afterEach(() => {
	if (level === undefined) delete process.env.LOG_LEVEL;
	else process.env.LOG_LEVEL = level;
	vi.restoreAllMocks();
});

describe('the fingerprint of a deleted account’s password hash (R17)', () => {
	it('is the SHA-256 of the fixed label, a NUL and the hash, for a well-formed bcrypt string alone; never for DUMMY_HASH', () => {
		const hash = hashLike(1);
		expect(credentialOf(hash)).toBe(createHash('sha256').update(`dumpfire account credential v1\u0000${hash}`).digest('hex'));
		expect(credentialOf(hash)).not.toBe(createHash('sha256').update(hash).digest('hex'));
		for (const form of ['$2a$', '$2y$']) expect(credentialOf(hash.replace('$2b$', form))).toMatch(/^[0-9a-f]{64}$/);
		for (const other of [DUMMY_HASH, '', 'x', '$2x$04$' + 'A'.repeat(53), hash + 'A', null, 7]) expect(credentialOf(other)).toBe('');
	});
});

describe('test 27: accountRulings, the one rule, without a restore', () => {
	it('rule 1: an exact deleted row rules it deleted; a row of another creation time does not', () => {
		row(7, MADE, 'deleted');
		expect(ruled(account())).toMatchObject({ ended: 'deleted', exactDeleted: true });
		expect(ruled(account({ createdAt: '2026-01-02 09:00:00' }))).toBeNull();
		// The same moment in another form is the same account.
		expect(ruled(account({ createdAt: '2026-01-01T09:00:00Z' }))).toMatchObject({ ended: 'deleted' });
	});

	it('rule 1: a deleted row carrying its fingerprint rules it deleted under any id and time, never a superadmin, never by DUMMY_HASH', () => {
		row(3, '2025-05-05 09:00:00', 'deleted', { credential: credentialOf(hashLike(7)) });
		expect(ruled(account())).toMatchObject({ ended: 'deleted', exactDeleted: false });
		expect(ruled(account({ role: 'superadmin' }))).toBeNull();
		expect(ruled(account({ passwordHash: DUMMY_HASH }))).toBeNull();
		expect(ruled(account({ passwordHash: hashLike(8) }))).toBeNull();
	});

	it('rule 1 (test 16): a creation time that names no moment, with a deleted row on its id, is deleted; the same id with no row is not', () => {
		row(7, '', 'deleted');
		expect(ruled(account({ createdAt: 'zzz' }))).toMatchObject({ ended: 'deleted', exactDeleted: false });
		expect(ruled(account({ id: 8, createdAt: 'zzz' }))).toBeNull();
	});

	it('(b): the watermark row names no account: W 7 and account 7 with no other row is as it was, with a readable time or with zzz', () => {
		row(7, '', 'watermark');
		expect(ruled(account())).toBeNull();
		expect(ruled(account({ createdAt: 'zzz' }))).toBeNull();
	});

	it('rule 2: a seed row of its id at or below W, the account made no later than it, is before record; above W, made after, with a here row, or the superadmin, not', () => {
		row(7, '', 'watermark', { at: '2026-11-20 09:00:00' });
		row(7, '', 'deleted', { at: '2026-11-20 09:00:00' });
		expect(ruled(account())).toMatchObject({ ended: 'before record' });
		// Made after the record began: not the account the seed names.
		expect(ruled(account({ createdAt: '2026-11-21 09:00:00' }))).toBeNull();
		expect(ruled(account({ role: 'superadmin' }))).toBeNull();
		// Above W.
		row(9, '', 'deleted', { at: '2026-11-20 09:00:00' });
		expect(ruled(account({ id: 9 }))).toBeNull();
		// An exact here row: from then on its exact rows govern (a role row, as every account made here has, R2).
		row(7, MADE, 'role', { role: 'user' });
		expect(ruled(account())).toBeNull();
	});

	it('rule 2: with no watermark, every seed row names its id (fail closed)', () => {
		row(90, '', 'deleted', { at: '2026-11-20 09:00:00' });
		expect(ruled(account({ id: 90 }))).toMatchObject({ ended: 'before record' });
	});

	it('rule 2: an id this server held just before with a later creation time is before record; the same or an earlier, not; never the superadmin', () => {
		row(9, '', 'watermark');
		expect(ruled(account(), { heldHere: new Map([[7, '2026-06-01 09:00:00']]) })).toMatchObject({ ended: 'before record' });
		expect(ruled(account(), { heldHere: new Map([[7, MADE]]) })).toBeNull();
		expect(ruled(account(), { heldHere: new Map([[7, '2025-06-01 09:00:00']]) })).toBeNull();
		expect(ruled(account({ role: 'superadmin' }), { heldHere: new Map([[7, '2026-06-01 09:00:00']]) })).toBeNull();
	});

	it.each([
		{ rows: [['disabled', 'here', '09:00:00']], ended: 'disabled', case: 'a disable here' },
		{ rows: [['disabled', 'here', '09:00:00'], ['enabled', 'here', '10:00:00']], ended: null, case: 'disabled then enabled here' },
		{ rows: [['disabled', 'here', '09:00:00'], ['enabled', 'backup', '10:00:00']], ended: 'disabled', case: 'a backup’s later enable never lifts a disable here' },
		{ rows: [['disabled', 'backup', '09:00:00'], ['enabled', 'backup', '10:00:00']], ended: null, case: 'only backup rows, disabled then enabled' },
		{ rows: [['enabled', 'here', '09:00:00'], ['disabled', 'backup', '10:00:00']], ended: 'disabled', case: 'a backup’s later disable over an enable here' },
		// Two in one second: the later write wins (decision 16).
		{ rows: [['enabled', 'here', '09:00:00'], ['disabled', 'here', '09:00:00']], ended: 'disabled', case: 'an enable then a disable in one second' }
	])('rule 3 (test 11): $case', ({ rows, ended }) => {
		for (const [ending, origin, time] of rows) row(7, MADE, ending, { origin: origin as 'here' | 'backup', at: `2026-11-20 ${time}` });
		expect(ruled(account())?.ended ?? null).toBe(ended);
		if (ended === 'disabled') expect(ruled(account())?.disabledAt).toMatch(/^2026-11-20 /);
	});

	it.each([
		{ role: 'admin', rows: [['user', 'here', '09:00:00']], lowerTo: 'user', case: 'a lowering here' },
		// Test 9, folded (R23): a cap only lowers, and a later raise here undoes an earlier lowering.
		{ role: 'admin', rows: [['user', 'here', '09:00:00'], ['admin', 'here', '10:00:00']], lowerTo: null, case: 'lowered then raised here, the backup an admin' },
		{ role: 'user', rows: [['user', 'here', '09:00:00'], ['admin', 'here', '10:00:00']], lowerTo: null, case: 'raised here, the backup a user: stays a user' },
		{ role: 'admin', rows: [['user', 'here', '09:00:00'], ['admin', 'backup', '10:00:00']], lowerTo: 'user', case: 'a backup’s later raise never lifts a lowering here' },
		{ role: 'admin', rows: [['user', 'backup', '09:00:00']], lowerTo: 'user', case: 'a backup’s lowering, no row here' },
		{ role: 'superadmin', rows: [['user', 'backup', '09:00:00']], lowerTo: null, case: 'a backup’s row never lowers the superadmin (R1)' },
		// Card 2996's code review (FP1): no role row lowers a superadmin, this server's own neither: the application writes
		// none for one, and a host promotion leaves the account's older rows behind.
		{ role: 'superadmin', rows: [['user', 'here', '09:00:00']], lowerTo: null, case: 'this server’s own role row never lowers the superadmin (FP1)' }
	])('rule 4: $case', ({ role, rows, lowerTo }) => {
		for (const [to, origin, time] of rows) row(7, MADE, 'role', { role: to, origin: origin as 'here' | 'backup', at: `2026-11-20 ${time}` });
		expect(ruled(account({ role }))?.lowerTo ?? null).toBe(lowerTo);
	});

	it('rule 5: the superadmin is ended only by this server’s own exact rows: a backup’s deleted row, a seed row and a fingerprint never', () => {
		row(7, MADE, 'deleted', { origin: 'backup' });
		row(7, '', 'deleted');
		row(3, MADE, 'deleted', { credential: credentialOf(hashLike(7)) });
		expect(ruled(account({ role: 'superadmin' }))).toBeNull();
		row(7, MADE, 'deleted');
		expect(ruled(account({ role: 'superadmin' }))).toMatchObject({ ended: 'deleted' });
	});

	it('says nothing of an account the record does not name, and nothing on a database without the record', () => {
		expect(accountRulings(sqlite, [account(), account({ id: 8 })])).toEqual([]);
		// FP9: the second half asked too, of a database with no such table, where it would throw were it asked.
		const bare = new Database(':memory:');
		try {
			expect(accountRulings(bare, [account()])).toEqual([]);
			expect(deletedHere(bare, account())).toBe(false);
		} finally {
			bare.close();
		}
	});
});

describe('(g): no statement of the rule scans the record (R11)', () => {
	it('with 1,000 seed rows: the exact, seed, fingerprint and watermark statements, and deletedHere’s, each search an index', () => {
		const put = sqlite.prepare("INSERT INTO account_endings (user_id, account_created, ending, ended_at) VALUES (?, '', 'deleted', '2026-11-20 09:00:00')");
		for (let id = 1; id <= 1000; id++) put.run(id);
		row(1000, '', 'watermark');
		sqlite.exec('ANALYZE');
		try {
			const plans: [string, unknown[]][] = [
				[EXACT_ROWS_SQL, [7]],
				[SEED_ROWS_SQL, [7]],
				[CREDENTIAL_ROWS_SQL, ['a'.repeat(64)]],
				[WATERMARK_SQL, []],
				[DELETED_HERE_SQL, [{ id: 7, created: '2026-01-01 09:00:00', super: 0, credential: 'a'.repeat(64) }]],
				// The restore's union (FP3): its NOT EXISTS a search on the account's index, never a scan.
				[
					CARRY_ACCOUNT_ENDING_SQL,
					[{ id: 7, created: '2026-01-01 09:00:00', ending: 'disabled', role: '', credential: '', endedAt: '2026-11-19 09:00:00', stated: '2026-11-19 09:00:00', before: 1000 }]
				]
			];
			for (const [sql, args] of plans) {
				const plan = (sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]).map((r) => r.detail).join('\n');
				expect(plan, sql).not.toMatch(/SCAN account_endings/);
				expect(plan, sql).toMatch(/SEARCH account_endings USING (COVERING )?INDEX account_endings_/);
			}
			// The dedupe searches the account's index on its id, creation time and ending (FP3).
			const carry = (sqlite.prepare(`EXPLAIN QUERY PLAN ${CARRY_ACCOUNT_ENDING_SQL}`).all(plans[5][1][0]) as { detail: string }[]).map((r) => r.detail).join('\n');
			expect(carry).toMatch(/SEARCH account_endings USING INDEX account_endings_account \(user_id=\? AND account_created=\? AND ending=\?/);
		} finally {
			sqlite.exec('DELETE FROM sqlite_stat1');
		}
	});
});

describe('(m): the gates refuse an account the record names as deleted (R16)', () => {
	it('createSession and keyHolder refuse one a host edit enabled again with a real hash; another account is let in', async () => {
		const ann = makeUser({ username: 'ann' });
		const bob = makeUser({ username: 'bob' });
		sqlite.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashLike(1), ann.id);
		sqlite.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashLike(2), bob.id);
		const annKey = makeApiKeyRow(ann);
		const bobKey = makeApiKeyRow(bob);
		const v1 = async (key: string) => (await gate('GET', '/api/v1/me', { headers: { authorization: `Bearer ${key}` } })).status;
		const created = sqlite.prepare('SELECT created_at FROM users WHERE id = ?').pluck().get(ann.id) as string;
		row(ann.id, created, 'deleted');

		expect(deletedHere(sqlite, { id: ann.id, createdAt: created, role: 'user', passwordHash: hashLike(1) })).toBe(true);
		expect(() => createSession(ann.id)).toThrow(AccountDisabled);
		expect(await v1(annKey.key)).toBe(401);
		expect(() => createSession(bob.id)).not.toThrow();
		expect(await v1(bobKey.key)).toBe(200);

		// By its fingerprint alone, under another id and time.
		sqlite.prepare("INSERT INTO account_endings (user_id, account_created, ending, credential, ended_at) VALUES (900, '2025-01-01 09:00:00', 'deleted', ?, '2026-11-20 09:00:00')").run(credentialOf(hashLike(2)));
		expect(() => createSession(bob.id)).toThrow(AccountDisabled);
		expect(await v1(bobKey.key)).toBe(401);
	});
});

// ─── Slice 3: the writers, and the start's pass ──────────────────────────────

/** The record, by account, creation time, ending, role, fingerprint and origin, in the order written. */
const recordOf = () =>
	sqlite.prepare('SELECT user_id AS id, account_created AS created, ending, role, credential, origin FROM account_endings ORDER BY seq').all() as {
		id: number;
		created: string;
		ending: string;
		role: string;
		credential: string;
		origin: string;
	}[];
const createdOf = (id: number) => sqlite.prepare('SELECT created_at FROM users WHERE id = ?').pluck().get(id) as string;
const userOf = (id: number) =>
	sqlite.prepare('SELECT role, disabled_at AS disabledAt, disabled_by AS disabledBy, password_hash AS passwordHash FROM users WHERE id = ?').get(id) as {
		role: string;
		disabledAt: string | null;
		disabledBy: number | null;
		passwordHash: string;
	};
const withHash = (account: SessionUser, n: number) => {
	sqlite.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashLike(n), account.id);
	return account;
};
/** The AUTH WARN lines the log kept, in order. */
const authWarnings = () => sqlite.prepare("SELECT message FROM system_logs WHERE context = 'AUTH' AND level = 'WARN' ORDER BY id").pluck().all() as string[];
const secondStepsOf = (id: number) =>
	(sqlite.prepare('SELECT (SELECT COUNT(*) FROM mfa_factors WHERE user_id = @id) + (SELECT COUNT(*) FROM mfa_recovery_codes WHERE user_id = @id) AS n').get({ id }) as { n: number }).n;
const backupNow = () => new Database(generateBackupData());

describe('the writers record every ending (card 2996, slice 3)', () => {
	beforeEach(() => {
		process.env.LOG_LEVEL = 'INFO';
	});

	it('test 28: deleteUser records the delete, with the fingerprint of the hash it held, before the row goes; this server’s backup from before brings it back inert', () => {
		const chief = withHash(makeUser({ username: 'chief', role: 'superadmin' }), 1);
		const x = withHash(makeUser({ username: 'xavier', disabled: { by: chief } }), 3);
		const created = createdOf(x.id);
		const backup = backupNow();

		deleteUser(x.id, chief);

		expect(recordOf()).toEqual([{ id: x.id, created, ending: 'deleted', role: '', credential: credentialOf(hashLike(3)), origin: 'here' }]);
		const result = restoreFromBackup(sqlite, backup);
		expect(result.errors).toEqual([]);
		expect(result.accountsKept).toMatchObject({ deleted: 1 });
		expect(userOf(x.id)).toMatchObject({ passwordHash: DUMMY_HASH, disabledBy: chief.id });
		expect(() => createSession(x.id)).toThrow(AccountDisabled);
	});

	it('test 30: a role change through PUT /api/users/{id} records the role after, a raise and a lowering; a username, an emoji or the role it has records nothing', async () => {
		const chief = makeUser({ username: 'chief', role: 'superadmin' });
		const ann = makeUser({ username: 'ann' });
		const put = (body: Record<string, unknown>) => api('PUT', `/api/users/${ann.id}`, stepUp(chief, body));

		expect((await put({ role: 'admin' })).status).toBe(200);
		expect((await put({ role: 'user' })).status).toBe(200);
		expect((await put({ role: 'user' })).status).toBe(200);
		expect((await api('PUT', `/api/users/${ann.id}`, { user: chief, body: { username: 'anne', emoji: '🦊' } })).status).toBe(200);

		expect(recordOf()).toEqual([
			{ id: ann.id, created: createdOf(ann.id), ending: 'role', role: 'admin', credential: '', origin: 'here' },
			{ id: ann.id, created: createdOf(ann.id), ending: 'role', role: 'user', credential: '', origin: 'here' }
		]);
	});

	it('test 31: recordAccountEnding outside a transaction on its connection throws and writes nothing; for the superadmin it throws', () => {
		const chief = makeUser({ username: 'chief', role: 'superadmin' });
		const ann = makeUser({ username: 'ann' });

		expect(() => recordAccountEnding(sqlite, ann.id, 'disabled')).toThrow(/none is open/);
		expect(() => inTransaction(() => recordAccountEnding(sqlite, chief.id, 'disabled'))).toThrow(/No ending of the superadmin is recorded/);
		expect(recordOf()).toEqual([]);
	});

	it('test 32 (card test F3, end to end): an administrator demoted through PUT /api/users/{id} stays a user when this server’s backup from before is restored', async () => {
		const chief = makeUser({ username: 'chief', role: 'superadmin' });
		const ada = makeUser({ username: 'ada', role: 'admin' });
		const backup = backupNow();
		expect((await api('PUT', `/api/users/${ada.id}`, stepUp(chief, { role: 'user' }))).status).toBe(200);

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([]);
		expect(result.accountsKept).toMatchObject({ lowered: 1 });
		expect(userOf(ada.id).role).toBe('user');
	});

	it('(a): endings in one second are all kept, in the order written: X disabled, enabled and disabled, Y made an administrator and a user again; this server’s earlier backup restored keeps X disabled and Y a user', async () => {
		// One second held, a day after the real clock, so that the accounts' creation (the database's own clock) is before it.
		const held = new Date(Math.floor(Date.now() / 1000) * 1000 + 24 * 60 * 60 * 1000);
		vi.useFakeTimers({ toFake: ['Date'], now: held });
		try {
			const chief = makeUser({ username: 'chief', role: 'superadmin' });
			const x = makeUser({ username: 'xavier' });
			const y = makeUser({ username: 'yolanda' });
			const post = (path: string) => api('POST', path, stepUp(chief));
			expect((await post(`/api/users/${x.id}/disable`)).status).toBe(200);
			expect((await post(`/api/users/${x.id}/enable`)).status).toBe(200);
			expect((await api('PUT', `/api/users/${y.id}`, stepUp(chief, { role: 'admin' }))).status).toBe(200);
			// The backup taken mid-way (FP9), X enabled and Y an administrator in it, so that each restored account ends
			// otherwise than the backup holds it: Y's two role rows share their second, and only their order decides.
			const backup = backupNow();
			expect((await post(`/api/users/${x.id}/disable`)).status).toBe(200);
			expect((await api('PUT', `/api/users/${y.id}`, stepUp(chief, { role: 'user' }))).status).toBe(200);

			const rows = sqlite.prepare('SELECT seq, user_id AS id, ending, role, ended_at AS at FROM account_endings ORDER BY seq').all() as {
				seq: number;
				id: number;
				ending: string;
				role: string;
				at: string;
			}[];
			expect(rows.filter((row) => row.id === x.id).map((row) => row.ending)).toEqual(['disabled', 'enabled', 'disabled']);
			expect(rows.filter((row) => row.id === y.id).map((row) => row.role)).toEqual(['admin', 'user']);
			expect(new Set(rows.map((row) => row.at))).toEqual(new Set([stamp(held)]));

			const result = restoreFromBackup(sqlite, backup);
			expect(result.errors).toEqual([]);
			// The backup had X enabled and Y an administrator: the later row of each second governs.
			expect(result.accountsKept).toMatchObject({ lowered: 1 });
			expect(userOf(x.id).disabledAt).not.toBeNull();
			expect(userOf(y.id).role).toBe('user');
			expect(accountRulings(sqlite, [{ id: x.id, createdAt: createdOf(x.id), role: 'user', passwordHash: '' }])[0]).toMatchObject({ ended: 'disabled' });
		} finally {
			vi.useRealTimers();
		}
	});

	it('(l) (R2): an account made through POST /api/users, and one made with an invite and completed by it, each have a here role row; a seed row of its id does not disable it', async () => {
		const chief = makeUser({ username: 'chief', role: 'superadmin' });
		makeSmtp();
		const sent = effects();
		let token: string;
		try {
			const withPassword = await api('POST', '/api/users', stepUp(chief, { username: 'lee', email: 'lee@example.test', password: 'a long enough password', role: 'user' }));
			expect(withPassword.status, JSON.stringify(withPassword.body)).toBe(201);
			const invited = await api('POST', '/api/users', stepUp(chief, { username: 'ivy', email: 'ivy@example.test', role: 'admin' }));
			expect(invited.status, JSON.stringify(invited.body)).toBe(201);
			await sent.settle();
			token = (sent.emails.at(-1)!.html.match(/\/invite\/([\w-]+)/) as RegExpMatchArray)[1];
		} finally {
			sent.restore();
		}
		const lee = sqlite.prepare("SELECT id FROM users WHERE username = 'lee'").pluck().get() as number;
		const ivy = sqlite.prepare("SELECT id FROM users WHERE username = 'ivy'").pluck().get() as number;
		expect(await action(`/invite/${token}`, { form: { password: 'a long enough password', confirmPassword: 'a long enough password' } })).toMatchObject({ type: 'redirect' });

		expect(recordOf()).toEqual([
			{ id: lee, created: createdOf(lee), ending: 'role', role: 'user', credential: '', origin: 'here' },
			{ id: ivy, created: createdOf(ivy), ending: 'role', role: 'admin', credential: '', origin: 'here' }
		]);
		// A foreign or crafted seed row on their ids, within the watermark: their own row governs, and neither is disabled.
		const at = '2099-01-01 09:00:00';
		sqlite.prepare("INSERT INTO account_endings (user_id, account_created, ending, ended_at) VALUES (?, '', 'watermark', ?)").run(ivy + 1, at);
		for (const id of [lee, ivy]) sqlite.prepare("INSERT INTO account_endings (user_id, account_created, ending, ended_at) VALUES (?, '', 'deleted', ?)").run(id, at);
		sweepEndedKeyReveals();
		expect([userOf(lee).disabledAt, userOf(ivy).disabledAt]).toEqual([null, null]);
	});
});

describe('the start’s and the five-minute pass of the record of account endings (card 2996, section 3.6)', () => {
	let chief: SessionUser;
	let board: Board;

	beforeEach(() => {
		process.env.LOG_LEVEL = 'INFO';
		chief = withHash(makeUser({ username: 'chief', role: 'superadmin' }), 1);
		board = makeBoard({ owner: withHash(makeUser({ username: 'olga' }), 2) }).board;
	});

	it('test 35: a present account an exact deleted row names, enabled with a real hash: disabled by the superadmin, DUMMY_HASH, its key recorded and deleted, its webhook held, one WARN of counts naming nobody; a second run does nothing', () => {
		const x = withHash(makeUser({ username: 'xavier', role: 'admin' }), 3);
		const key = makeApiKeyRow(x);
		const hook = makeWebhook(board, { setBy: x, secret: 'whsec-35' }).id;
		sqlite.prepare("INSERT INTO account_endings (user_id, account_created, ending, ended_at) VALUES (?, ?, 'deleted', '2026-11-19 09:00:00')").run(x.id, createdOf(x.id));

		sweepEndedKeyReveals();

		expect(userOf(x.id)).toMatchObject({ disabledAt: expect.any(String), disabledBy: chief.id, passwordHash: DUMMY_HASH });
		expect(sqlite.prepare('SELECT COUNT(*) FROM api_keys WHERE user_id = ?').pluck().get(x.id)).toBe(0);
		expect(sqlite.prepare('SELECT revoked_because FROM api_key_revocations WHERE key_id = ?').pluck().get(key.id)).toBe('access ended');
		expect(sqlite.prepare('SELECT active, held_because AS heldBecause FROM webhooks WHERE id = ?').get(hook)).toEqual({ active: 0, heldBecause: 'setter access ended' });
		const said = authWarnings().filter((line) => line.includes('record of account endings'));
		expect(said).toEqual([
			'1 account(s) that the record of account endings on this server names were found enabled, with a working password, or above their role here ' +
				'(an older image’s import or a host edit), and were ended again as the record says: 1 kept deleted, 0 kept disabled as accounts this server had before it recorded endings, 0 disabled and 0 given back their lower role.'
		]);
		for (const line of authWarnings()) expect(line).not.toContain('xavier');

		const record = recordOf();
		const lines = authWarnings().length;
		sweepEndedKeyReveals();
		expect(recordOf()).toEqual(record);
		expect(authWarnings()).toHaveLength(lines);
	});

	it('test 36: a record-disabled account enabled here is disabled; an administrator above its ceiling lowered, its sessions ended; a superadmin the record names untouched, with a WARN of its own', () => {
		const bob = makeUser({ username: 'bob' });
		const ada = makeUser({ username: 'ada', role: 'admin' });
		makeSession(ada);
		sqlite.prepare("INSERT INTO account_endings (user_id, account_created, ending, ended_at) VALUES (?, ?, 'disabled', '2026-11-19 09:00:00')").run(bob.id, createdOf(bob.id));
		sqlite.prepare("INSERT INTO account_endings (user_id, account_created, ending, role, ended_at) VALUES (?, ?, 'role', 'user', '2026-11-19 09:00:00')").run(ada.id, createdOf(ada.id));
		sqlite.prepare("INSERT INTO account_endings (user_id, account_created, ending, ended_at) VALUES (?, ?, 'deleted', '2026-11-19 09:00:00')").run(chief.id, createdOf(chief.id));

		sweepEndedKeyReveals();

		expect(userOf(bob.id)).toMatchObject({ disabledAt: expect.any(String), disabledBy: chief.id, passwordHash: FIXTURE_PASSWORD_HASH });
		expect(userOf(ada.id)).toMatchObject({ role: 'user', disabledAt: null });
		expect(sqlite.prepare('SELECT COUNT(*) FROM sessions WHERE user_id = ?').pluck().get(ada.id)).toBe(0);
		expect(userOf(chief.id)).toMatchObject({ role: 'superadmin', disabledAt: null, passwordHash: hashLike(1) });
		const said = authWarnings().filter((line) => line.includes('record of account endings'));
		expect(said).toHaveLength(2);
		expect(said[0]).toMatch(/^2 account\(s\) .* 0 kept deleted, 0 kept disabled .*, 1 disabled and 1 given back their lower role\.$/);
		expect(said[1]).toMatch(/^The record of account endings on this server names the superadmin, whom it never ends or lowers/);
	});

	it('test 37 (R13): a pass that cannot be written rolls back alone, with a WARN of its own, and the key pass after it still commits', () => {
		const ada = makeUser({ username: 'ada', role: 'admin' });
		sqlite.prepare("INSERT INTO account_endings (user_id, account_created, ending, role, ended_at) VALUES (?, ?, 'role', 'user', '2026-11-19 09:00:00')").run(ada.id, createdOf(ada.id));
		const owner = makeUser({ username: 'owen' });
		const key = makeApiKeyRow(owner);
		const hash = sqlite.prepare('SELECT key_hash FROM api_keys WHERE id = ?').pluck().get(key.id) as string;
		sqlite.prepare("INSERT INTO api_key_revocations (key_id, key_hash, revoked_at, revoked_because) VALUES (?, ?, '2026-11-19 09:00:00', 'revoked')").run(key.id, hash);
		const record = recordOf();
		sqlite.exec("CREATE TEMP TRIGGER refuse_2996 BEFORE UPDATE ON users WHEN NEW.role IS NOT OLD.role BEGIN SELECT RAISE(ABORT, 'refused by test 37'); END");
		try {
			expect(sweepEndedKeyReveals()).toBeNull();
		} finally {
			sqlite.exec('DROP TRIGGER IF EXISTS temp.refuse_2996');
		}

		expect(userOf(ada.id).role).toBe('admin');
		expect(recordOf()).toEqual(record);
		expect(authWarnings().filter((line) => line.startsWith('The accounts that the record of account endings on this server ends or lowers could not be ended again: '))).toHaveLength(1);
		expect(authWarnings().join('\n')).toContain('refused by test 37');
		// The key pass committed: the recorded key is gone.
		expect(sqlite.prepare('SELECT COUNT(*) FROM api_keys WHERE id = ?').pluck().get(key.id)).toBe(0);
	});

	it('(c): accounts ruled deleted by their fingerprint and by a creation time that names no moment stay inert: exact rows written here, the enable refused 409, the start changes nothing, and a second restore rules both deleted by those rows', async () => {
		// A creation time that names no moment, on purpose.
		allowOtherTimestampForms();
		const pat = withHash(makeUser({ username: 'pat' }), 3);
		const quinn = withHash(makeUser({ username: 'quinn' }), 4);
		const backup = backupNow();
		backup.prepare("UPDATE users SET created_at = 'zzz' WHERE id = ?").run(quinn.id);
		const bytes = Buffer.from(backup.serialize());
		const patCreated = createdOf(pat.id);
		sqlite.pragma('foreign_keys = OFF');
		sqlite.prepare('DELETE FROM users WHERE id IN (?, ?)').run(pat.id, quinn.id);
		sqlite.pragma('foreign_keys = ON');
		sqlite.prepare("INSERT INTO account_endings (user_id, account_created, ending, credential, ended_at) VALUES (900, '2025-01-01 09:00:00', 'deleted', ?, '2026-11-19 09:00:00')").run(credentialOf(hashLike(3)));
		sqlite.prepare("INSERT INTO account_endings (user_id, account_created, ending, ended_at) VALUES (?, '', 'deleted', '2026-11-19 09:00:00')").run(quinn.id);

		const first = restoreFromBackup(sqlite, new Database(bytes));

		expect(first.accountsKept).toMatchObject({ deleted: 2 });
		// After the rows they were matched on (quinn's seed row first), an exact deleted row of each, a belt (R3, FP2).
		expect(recordOf().filter((row) => row.id === pat.id || row.id === quinn.id)).toEqual([
			{ id: quinn.id, created: '', ending: 'deleted', role: '', credential: '', origin: 'here' },
			{ id: pat.id, created: patCreated, ending: 'deleted', role: '', credential: credentialOf(hashLike(3)), origin: 'belt' },
			{ id: quinn.id, created: 'zzz', ending: 'deleted', role: '', credential: credentialOf(hashLike(4)), origin: 'belt' }
		]);
		for (const id of [pat.id, quinn.id]) {
			const res = await api('POST', `/api/users/${id}/enable`, stepUp(chief));
			expect({ status: res.status, body: res.body }, `user ${id}`).toEqual({ status: 409, body: { message: DELETED_HERE } });
		}
		const record = recordOf();
		const users = sqlite.prepare('SELECT * FROM users ORDER BY id').all();
		sweepEndedKeyReveals();
		expect(recordOf()).toEqual(record);
		expect(sqlite.prepare('SELECT * FROM users ORDER BY id').all()).toEqual(users);

		// The rows they were first matched on taken away: the rows the restore wrote rule them alone.
		sqlite.prepare("DELETE FROM account_endings WHERE user_id = 900 OR (user_id = ? AND account_created = '')").run(quinn.id);
		const second = restoreFromBackup(sqlite, new Database(bytes));
		expect(second.accountsKept).toMatchObject({ deleted: 2 });
	});

	it('(d): the start applies the seed rule: an account a seed row names, put in by hand before the seed, enabled with a real hash, is disabled with DUMMY_HASH; the same id with a here pair of disabled then enabled is left alone', () => {
		const seededAt = '2026-11-19 09:00:00';
		sqlite.prepare("INSERT INTO account_endings (user_id, account_created, ending, ended_at) VALUES (2001, '', 'watermark', ?), (2000, '', 'deleted', ?), (2001, '', 'deleted', ?)").run(seededAt, seededAt, seededAt);
		const put = sqlite.prepare("INSERT INTO users (id, username, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, 'user', '2026-11-01 09:00:00')");
		put.run(2000, 'by-hand', 'by-hand@example.test', hashLike(5));
		put.run(2001, 'paired', 'paired@example.test', hashLike(6));
		sqlite
			.prepare("INSERT INTO account_endings (user_id, account_created, ending, ended_at) VALUES (2001, '2026-11-01 09:00:00', 'disabled', '2026-11-19 10:00:00'), (2001, '2026-11-01 09:00:00', 'enabled', '2026-11-19 11:00:00')")
			.run();

		sweepEndedKeyReveals();

		expect(userOf(2000)).toMatchObject({ disabledAt: expect.any(String), disabledBy: chief.id, passwordHash: DUMMY_HASH });
		expect(userOf(2001)).toMatchObject({ disabledAt: null, passwordHash: hashLike(6) });
	});

	it('(e): the five-minute pass lowers a role completely, with no restart: the role, the sessions, invites and pending sign-ins, the settings set, the readable webhooks held, one WARN of counts naming nobody', async () => {
		const before = mailPlacesNow();
		makeSmtp();
		const sent = effects();
		onTestFinished(() => sent.restore());
		const x = makeUser({ username: 'xavier', role: 'admin' });
		makeSession(x);
		const week = '2099-01-01 00:00:00';
		sqlite.prepare('INSERT INTO invite_tokens (token, user_id, expires_at) VALUES (?, ?, ?)').run(Buffer.alloc(32, 9), x.id, week);
		sqlite
			.prepare("INSERT INTO sign_in_challenges (token_hash, short_id, user_id, purpose, lane, password_hash, expires_at) VALUES (?, 'c-x', ?, 'verify', 'other', 'x', ?)")
			.run(sha256Hex('x challenge'), x.id, week);
		setAppUrl('https://xavier.example');
		recordMailSetters(before, { id: x.id, superadmin: false }, true);
		const dest = { type: 's3', name: "Xavier's", region: 'eu-west-2', bucket: 'x-bucket', accessKeyId: 'AKIA', secretAccessKey: 'secret', prefix: '' };
		db.insert(settings).values({ key: 'backup_config', value: JSON.stringify({ schedule: 'daily', retention: 7, destinations: [dest] }) }).run();
		recordDestinationSetter(dest, x.id);
		const readable = makeWebhook(board, { setBy: null, secret: 'whsec-e-2996' }).id;
		stepUpFactor(x);
		sqlite.prepare("UPDATE users SET last_sign_in_at = '2026-11-19 08:00:00' WHERE id = ?").run(x.id);
		sqlite.prepare("INSERT INTO account_endings (user_id, account_created, ending, role, ended_at) VALUES (?, ?, 'role', 'user', '2026-11-19 09:00:00')").run(x.id, createdOf(x.id));

		sweepEndedKeyReveals();
		await sent.settle();

		expect(userOf(x.id).role).toBe('user');
		for (const table of ['sessions', 'sign_in_challenges']) expect(sqlite.prepare(`SELECT COUNT(*) FROM ${table} WHERE user_id = ?`).pluck().get(x.id), table).toBe(0);
		expect(sqlite.prepare('SELECT COUNT(*) FROM invite_tokens WHERE user_id = ? AND used = 0').pluck().get(x.id)).toBe(0);
		expect(sqlite.prepare("SELECT key FROM settings WHERE key LIKE 'smtp\\_%' ESCAPE '\\' OR key = 'app_url'").all()).toEqual([]);
		expect(JSON.parse(sqlite.prepare("SELECT value FROM settings WHERE key = 'backup_config'").pluck().get() as string).destinations).toEqual([]);
		expect(sqlite.prepare('SELECT active, held_because AS heldBecause FROM webhooks WHERE id = ?').get(readable)).toEqual({ active: 0, heldBecause: 'setter access ended' });
		const said = authWarnings().filter((line) => line.includes('record of account endings'));
		expect(said).toHaveLength(1);
		expect(said[0]).toMatch(/^1 account\(s\) .* 0 disabled and 1 given back their lower role\.$/);
		for (const line of authWarnings()) expect(line).not.toContain('xavier');
	});

	it('(j) (R6): the start finds an inert account still holding second factors and recovery codes, and deletes them; a second run does nothing', () => {
		const x = makeUser({ username: 'xavier', disabled: { by: chief } });
		stepUpFactor(x);
		sqlite.prepare("INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES (?, 'code-of-xavier')").run(x.id);
		sqlite.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(DUMMY_HASH, x.id);
		sqlite.prepare("INSERT INTO account_endings (user_id, account_created, ending, ended_at) VALUES (?, ?, 'deleted', '2026-11-19 09:00:00')").run(x.id, createdOf(x.id));
		expect(secondStepsOf(x.id)).toBe(2);

		sweepEndedKeyReveals();

		expect(secondStepsOf(x.id)).toBe(0);
		expect(authWarnings().filter((line) => line.includes('record of account endings'))).toHaveLength(1);
		const record = recordOf();
		sweepEndedKeyReveals();
		expect(recordOf()).toEqual(record);
		expect(authWarnings().filter((line) => line.includes('record of account endings'))).toHaveLength(1);
	});
});

describe('the code review’s fix pass (card 2996, FP1, FP5, FP6, FP16)', () => {
	beforeEach(() => {
		process.env.LOG_LEVEL = 'INFO';
	});

	it('FP1: an account promoted to superadmin by docs/deployment.md’s command keeps its role through a restore of this server’s own backup, and the start says nothing of it', () => {
		startedSinceAlreadyOffHeld();
		const chief = withHash(makeUser({ username: 'chief', role: 'superadmin' }), 1);
		const greg = withHash(makeUser({ username: 'greg', role: 'admin' }), 2);
		// As POST /api/users records an account it makes (R2), and an earlier disable and enable of it.
		inTransaction(() => recordAccountEnding(sqlite, greg.id, 'role'));
		inTransaction(() => recordAccountEnding(sqlite, greg.id, 'disabled'));
		// The documented recovery, word for word in its UPDATE: greg made the superadmin and enabled; the old one an administrator.
		const promote = sqlite.prepare('UPDATE users SET role = ?, disabled_at = NULL, disabled_by = NULL WHERE id = ?');
		promote.run('superadmin', greg.id);
		promote.run('admin', chief.id);
		const lines = authWarnings().length;

		sweepEndedKeyReveals();

		expect(authWarnings()).toHaveLength(lines);
		expect(userOf(greg.id)).toMatchObject({ role: 'superadmin', disabledAt: null });
		const result = restoreFromBackup(sqlite, backupNow());
		expect(result.errors).toEqual([]);
		expect(result.accountsKept).toEqual({ deleted: 0, beforeRecord: 0, disabled: 0, lowered: 0 });
		expect(userOf(greg.id)).toMatchObject({ role: 'superadmin', disabledAt: null });
	});

	it('FP5: the same backup imported again an hour later, once its future-dated disable is past, adds no row and leaves an account enabled here since enabled', () => {
		vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-20T10:00:00Z') });
		try {
			makeUser({ username: 'chief', role: 'superadmin' });
			const ann = makeUser({ username: 'ann' });
			const copy = backupNow();
			// The backup's clock ran an hour fast: its disable of Ann is dated 11:00.
			copy
				.prepare("INSERT INTO account_endings (user_id, account_created, ending, ended_at, stated_ended, origin) VALUES (?, ?, 'disabled', '2026-11-20 11:00:00', '2026-11-20 11:00:00', 'here')")
				.run(ann.id, createdOf(ann.id));
			const bytes = Buffer.from(copy.serialize());

			expect(restoreFromBackup(sqlite, new Database(bytes)).errors).toEqual([]);
			expect(userOf(ann.id).disabledAt).not.toBeNull();
			// Enabled here at 10:30, as the route records it.
			vi.setSystemTime(new Date('2026-11-20T10:30:00Z'));
			sqlite.prepare('UPDATE users SET disabled_at = NULL, disabled_by = NULL WHERE id = ?').run(ann.id);
			inTransaction(() => recordAccountEnding(sqlite, ann.id, 'enabled'));
			const rows = recordOf().length;

			// The same file, an hour after its disable's moment has passed.
			vi.setSystemTime(new Date('2026-11-20T12:00:00Z'));
			expect(restoreFromBackup(sqlite, new Database(bytes)).errors).toEqual([]);

			expect(recordOf()).toHaveLength(rows);
			expect(userOf(ann.id).disabledAt).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		{ schedulers: 'off', mailed: false },
		{ schedulers: 'on', mailed: true }
	])('FP6: the start’s pass mails the boards’ owners only where the schedulers run: SCHEDULERS=$schedulers', async ({ schedulers, mailed }) => {
		makeUser({ username: 'chief', role: 'superadmin' });
		const owner = makeUser({ username: 'olga' });
		const x = withHash(makeUser({ username: 'xavier', role: 'admin' }), 3);
		makeWebhook(makeBoard({ owner }).board, { setBy: x, secret: 'whsec-fp6' });
		makeSmtp();
		sqlite.prepare("INSERT INTO account_endings (user_id, account_created, ending, ended_at) VALUES (?, ?, 'deleted', '2026-11-19 09:00:00')").run(x.id, createdOf(x.id));
		const sent = effects();
		try {
			sweepEndedKeyReveals(schedulers, false);
			await sent.settle();
			expect(userOf(x.id).passwordHash).toBe(DUMMY_HASH);
			expect(sent.emails.length > 0).toBe(mailed);
		} finally {
			sent.restore();
		}
	});

	it('FP16: no line the start’s pass or a restore’s ruled holds write names an account, by name or by number', async () => {
		startedSinceAlreadyOffHeld();
		const chief = withHash(makeUser({ username: 'chief', role: 'superadmin' }), 1);
		const owner = makeUser({ username: 'olga' });
		const board = makeBoard({ owner }).board;
		const before = mailPlacesNow();
		makeSmtp();
		const sent = effects();
		onTestFinished(() => sent.restore());
		// Xavier, an administrator the record lowers, has set the mail and a webhook; Yves, whom it ends, has set a webhook.
		const xavier = withHash(makeUser({ username: 'xavier', role: 'admin' }), 3);
		recordMailSetters(before, { id: xavier.id, superadmin: false }, true);
		const yves = withHash(makeUser({ username: 'yves', role: 'admin' }), 4);
		makeWebhook(board, { setBy: xavier, secret: 'whsec-x-fp16' });
		makeWebhook(board, { setBy: yves, secret: 'whsec-y-fp16' });
		makeWebhook(board, { setBy: owner, secret: 'whsec-o-fp16' });
		stepUpFactor(xavier);
		sqlite.prepare("UPDATE users SET last_sign_in_at = '2026-11-19 08:00:00' WHERE id IN (?, ?)").run(xavier.id, yves.id);
		const backup = backupNow();
		const put = sqlite.prepare("INSERT INTO account_endings (user_id, account_created, ending, role, ended_at) VALUES (?, ?, ?, ?, '2026-11-19 09:00:00')");
		put.run(xavier.id, createdOf(xavier.id), 'role', 'user');
		put.run(yves.id, createdOf(yves.id), 'deleted', '');
		const mark = sqlite.prepare('SELECT coalesce(max(id), 0) FROM system_logs').pluck().get() as number;

		sweepEndedKeyReveals();
		// And a restore of the backup from before, whose ruled holds are told with its sweep.
		restoreFromBackup(sqlite, backup, { by: 'chief' });
		await sent.settle();

		const written = sqlite.prepare('SELECT message, meta FROM system_logs WHERE id > ? AND message NOT LIKE ? ').all(mark, '%restored%') as { message: string; meta: string | null }[];
		expect(written.length).toBeGreaterThan(0);
		for (const { message, meta } of written.filter((line) => !line.message.includes('found after a restore by chief'))) {
			for (const said of ['xavier', 'yves', `user ${xavier.id}`, `user ${yves.id}`]) expect(message, message).not.toContain(said);
			expect(meta ?? '', message).not.toMatch(new RegExp(`"(setter|userId|targetUserId)":(${xavier.id}|${yves.id})\\b`));
		}
		void chief;
	});
});
