/**
 * Card 3004, slice S2a: this server's record of every change of where it sends (migration 0081), the rule that reads
 * it (`outboundCeiling`), the keyed digests it names addresses by (R10, R11), and the seed (R7).
 *
 * The record's ranking is card 3002's (`deciding`, made generic, R5): this server's latest row by `seq`, closed by any
 * later `backup` row; a `seed` row ranks below every `here` row of its item, whatever their `seq` (R7). Each case here
 * builds the record by hand on a database of its own, as the writers (slice S3) and the carry (tests/backups.test.ts)
 * would have.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sqlite } from '$lib/server/db';
import type { Board } from '$lib/server/db/schema';
import { inTransaction } from '$lib/server/db/transaction';
import { endAccountAccess, type SessionUser } from '$lib/server/auth';
import { saveBackupConfig, type BackupConfig } from '$lib/server/backup';
import { deleteBoard, deleteUser } from '$lib/server/deletes';
import { holdSettingsSetBy, keepHeldSetting, removeHeldSetting, removeSettingsSetBy, settingsHeldForReview } from '$lib/server/setting-setters';
import { sweepEndedKeyReveals } from '$lib/server/startup-checks';
import { sealValue, webhookUrlAad } from '$lib/server/stored-secrets';
import { WEBHOOK_EVENTS } from '$lib/server/webhooks';
import { resetAllRateLimits } from '$lib/server/rate-limit';
import { HELD_DELETED_HERE, HELD_REMOVED_HERE, HELD_REPOINTED_HERE } from '$lib/settings-held';
import { stamp } from '$lib/timestamps';
import { api } from './helpers/api';
import { effects } from './helpers/effects';
import { makeApiKeyRow, makeBoard, makeSmtp, makeUser, makeWebhook, resetDb, stepUp } from './helpers/fixtures';
import { runMigrations } from '$lib/server/db/migrate';
import { OUTBOUND_CHANGE_HELD_SQL } from '$lib/server/db/restore';
import { currentMfaKey, keyFromBytes } from '$lib/server/mfa-key';
import { NoKeyToSeal } from '$lib/server/stored-secrets';
import { mailPlaceOf, placeKey } from '$lib/server/setting-holds';
import { destinationPlace } from '$lib/server/backup-secrets';
import { allowanceState } from '$lib/server/rate-limit';
import {
	NO_OUTBOUND_KEY,
	OUTBOUND_READS,
	keyedUnder,
	outboundCeiling,
	outboundDigest,
	outboundSeeded,
	recordOutboundChange,
	recordOutboundState,
	recordSchedulesAs,
	sameDigest,
	seedOutbound,
	settingPlacesIn,
	type OutboundItem
} from '$lib/server/outbound-changes';

const REAL_MIGRATIONS = join(process.cwd(), 'drizzle');

/** No MFA key loaded, while `none` is set (card 3004's code review, F4, F5). */
const keyStub = vi.hoisted(() => ({ none: false }));
vi.mock('$lib/server/mfa-key', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/mfa-key')>();
	return { ...real, currentMfaKey: () => (keyStub.none ? null : real.currentMfaKey()) };
});

const opened: Database.Database[] = [];

/** A separate in-memory database with every migration applied, and no rows: an empty record. */
function migratedDb(): Database.Database {
	const database = new Database(':memory:');
	opened.push(database);
	runMigrations({ database, migrationsDir: REAL_MIGRATIONS });
	return database;
}

afterEach(() => {
	for (const database of opened.splice(0)) database.close();
});

/** A webhook's and a schedule's creation time, in the stored form. */
const C = '2026-02-01 09:00:00';

type Row = { kind: string; id?: number; created?: string; place?: string; address?: string; state: string; at: string; origin?: string };

/** Rows of the record, in `seq` order, as a writer, the seed or a carry would have put them. */
function record(database: Database.Database, rows: readonly Row[]): void {
	const put = database.prepare(
		'INSERT INTO outbound_changes (kind, item_id, item_created, place, address, state, changed_at, stated_changed, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
	);
	for (const r of rows) put.run(r.kind, r.id ?? 0, r.created ?? '', r.place ?? '', r.address ?? '', r.state, r.at, r.at, r.origin ?? 'here');
}

/** Webhook 1, made at `C`. */
const HOOK: OutboundItem = { kind: 'webhook', id: 1, created: C, place: '' };
const hook = (state: string, at: string, origin = 'here', created = C): Row => ({ kind: 'webhook', id: 1, created, state, at, origin });

describe('the rule, as a table (card 3004, (e))', () => {
	const ceilingOf = (rows: readonly Row[], item: OutboundItem = HOOK, asOf?: string) => {
		const database = migratedDb();
		record(database, rows);
		return outboundCeiling(database, item, asOf === undefined ? {} : { asOf })?.state ?? null;
	};

	it('[1] a clock stepped back: the later seq wins over the later moment', () => {
		expect(ceilingOf([hook('off', '2026-05-01 10:00:00'), hook('on', '2026-05-01 09:00:00')])).toBe('on');
		expect(ceilingOf([hook('on', '2026-05-01 10:00:00'), hook('off', '2026-05-01 09:00:00')])).toBe('off');
	});

	it("[2] a backup row dated after this server's latest that closes more counts", () => {
		expect(ceilingOf([hook('on', '2026-05-01 09:00:00'), hook('deleted', '2026-05-01 10:00:00', 'backup')])).toBe('deleted');
	});

	it("[3] a backup row that would open, beside this server's row, is not taken", () => {
		expect(ceilingOf([hook('off', '2026-05-01 09:00:00'), hook('on', '2026-05-01 10:00:00', 'backup')])).toBe('off');
		// Nor one dated before this server's row, whatever it says.
		expect(ceilingOf([hook('on', '2026-05-01 09:00:00'), hook('deleted', '2026-05-01 08:00:00', 'backup')])).toBe('on');
	});

	it('[4] backup rows only: the latest by (changed_at, seq)', () => {
		expect(ceilingOf([hook('deleted', '2026-05-01 10:00:00', 'backup'), hook('on', '2026-05-01 09:00:00', 'backup')])).toBe('deleted');
		expect(ceilingOf([hook('off', '2026-05-01 10:00:00', 'backup'), hook('on', '2026-05-01 10:00:00', 'backup')])).toBe('on');
	});

	it('[5] a creation time that names no moment matches by id alone, and only closes', () => {
		const other = '2026-03-01 09:00:00';
		// The live item's time does not read: every row of its id counts, the most closed taken.
		expect(ceilingOf([hook('on', '2026-05-01 09:00:00'), hook('deleted', '2026-05-01 09:00:00', 'here', other)], { ...HOOK, created: null })).toBe('deleted');
		// A row whose time named none (''), beside the live item's own: it can close, never open.
		expect(ceilingOf([hook('on', '2026-05-01 09:00:00'), hook('off', '2026-05-01 10:00:00', 'here', '')])).toBe('off');
		expect(ceilingOf([hook('off', '2026-05-01 09:00:00'), hook('on', '2026-05-01 10:00:00', 'here', '')])).toBe('off');
		// Another creation time is another webhook: its rows do not count for this one.
		expect(ceilingOf([hook('deleted', '2026-05-01 09:00:00', 'here', other)])).toBeNull();
	});

	it('[6] no row names the item: none', () => {
		expect(ceilingOf([])).toBeNull();
		expect(ceilingOf([{ kind: 'schedule', id: 1, created: C, state: 'deleted', at: '2026-05-01 09:00:00' }])).toBeNull();
	});

	it("[7] a row of this server's dated after the moment asked never opens the ceiling, and may still close it", () => {
		const asOf = '2026-11-21 09:00:00';
		expect(ceilingOf([hook('off', '2026-05-01 09:00:00'), hook('on', '2999-01-01 00:00:00')], HOOK, asOf)).toBe('off');
		expect(ceilingOf([hook('off', '2026-05-01 09:00:00'), hook('on', '2999-01-01 00:00:00')])).toBe('on');
		expect(ceilingOf([hook('on', '2026-05-01 09:00:00'), hook('deleted', '2999-01-01 00:00:00')], HOOK, asOf)).toBe('deleted');
	});

	it('[8] R7: a seed row ranks below every here row of its item, whatever their seq; alone, it decides', () => {
		expect(ceilingOf([hook('off', '2026-05-01 09:00:00'), hook('on', '2026-05-01 10:00:00', 'seed')])).toBe('off');
		expect(ceilingOf([hook('deleted', '2026-05-01 09:00:00'), hook('on', '2026-05-01 10:00:00', 'seed')])).toBe('deleted');
		expect(ceilingOf([hook('off', '2026-05-01 10:00:00', 'seed')])).toBe('off');
		// A later closing backup row closes a seed row as it does a here row.
		expect(ceilingOf([hook('on', '2026-05-01 09:00:00', 'seed'), hook('deleted', '2026-05-01 10:00:00', 'backup')])).toBe('deleted');
		// And for a place: a destination removed here, seeded set since.
		const place = placeKey(['s3', 'bucket']);
		const destination: OutboundItem = { kind: 'destination', id: 0, created: '', place };
		expect(
			ceilingOf(
				[
					{ kind: 'destination', place, state: 'removed', at: '2026-05-01 09:00:00' },
					{ kind: 'destination', place, state: 'set', at: '2026-05-01 10:00:00', origin: 'seed' }
				],
				destination
			)
		).toBe('removed');
	});
});

describe('the keyed digests (card 3004, (f2); R10, R11)', () => {
	it("carry this key's id; another key gives another value; no key throws NoKeyToSeal and writes nothing", () => {
		const key = currentMfaKey()!;
		const other = keyFromBytes(randomBytes(32));
		const address = 'https://hooks.example.test/a';
		const digest = outboundDigest(key, address);
		expect(digest).toMatch(new RegExp(`^k${key.id}:[0-9a-f]{64}$`));
		expect(digest).toBe(outboundDigest(key, address));
		expect(digest).not.toContain('hooks');
		expect(outboundDigest(other, address)).not.toBe(digest);
		expect(outboundDigest(other, address).startsWith(`k${other.id}:`)).toBe(true);
		expect(keyedUnder(digest, key.id)).toBe(true);
		expect(keyedUnder(digest, other.id)).toBe(false);
		expect(keyedUnder(digest, null)).toBe(false);
		expect(() => outboundDigest(null, address)).toThrow(NoKeyToSeal);

		// A recipient as a writer records it: by its schedule and the keyed digest of the address, never the address.
		const database = migratedDb();
		database.exec(`
			INSERT INTO users (id, username, email, password_hash) VALUES (1, 'ann', 'ann@example.test', 'x');
			INSERT INTO report_schedules (id, user_id, name, recipients, created_at) VALUES (7, 1, 'Weekly', 'a@example.test', '${C}');
		`);
		const recipient = { kind: 'recipient' as const, schedule: 7, address: 'a@example.test', state: 'added' };
		expect(() => recordOutboundChange(database, recipient, key)).toThrow(/inside the transaction/);
		database.transaction(() => expect(recordOutboundChange(database, recipient, key)).toBe(true))();
		expect(database.prepare('SELECT kind, item_id, item_created, place, address, state, origin FROM outbound_changes').all()).toEqual([
			{ kind: 'recipient', item_id: 7, item_created: C, place: outboundDigest(key, 'a@example.test'), address: '', state: 'added', origin: 'here' }
		]);
		expect(() => database.transaction(() => recordOutboundChange(database, recipient, null))()).toThrow(NoKeyToSeal);
		expect(() => seedOutbound(database, null)).toThrow(NoKeyToSeal);
		expect(database.prepare('SELECT count(*) FROM outbound_changes').pluck().get()).toBe(1);
	});
});

describe('the seed (card 3004, (f); R7)', () => {
	it('records every kind as it is, origin seed, dated at its moment, a held place held; the marker once; a second call none', () => {
		const key = currentMfaKey()!;
		const database = migratedDb();
		const destination = { name: 'Bucket', type: 's3', bucket: 'b', region: 'r', accessKeyId: 'AK', secretAccessKey: '' };
		const mail = mailPlaceOf({ host: 'smtp.example.test', port: 587, user: 'mailer', allowInsecure: false });
		database.exec(`
			INSERT INTO users (id, username, email, password_hash) VALUES (1, 'ann', 'ann@example.test', 'x');
			INSERT INTO boards (id, name, created_by) VALUES (1, 'Hooks', 1);
			INSERT INTO webhooks (id, board_id, url, events, active, created_at) VALUES
				(1, 1, 'https://hooks.example.test/on', '[]', 1, '${C}'),
				(2, 1, 'https://hooks.example.test/off', '[]', 0, '${C}'),
				(3, 1, '', '[]', 0, '${C}'),
				(4, 1, 'https://hooks.example.test/unreadable', '[]', 1, 'yesterday-ish');
			UPDATE webhooks SET held_because = 'setter access ended', held_at = '${C}' WHERE id = 3;
			INSERT INTO report_schedules (id, user_id, name, recipients, enabled, created_at) VALUES
				(5, 1, 'On', 'A@Example.test, b@example.test', 1, '${C}'),
				(6, 1, 'Off', '', 0, '${C}'),
				(7, 1, 'Unreadable', 'c@example.test', 1, 'not a moment');
			INSERT INTO settings (key, value) VALUES
				('smtp_host', 'smtp.example.test'), ('smtp_port', '587'), ('smtp_user', 'mailer'),
				('app_url', 'https://dumpfire.example.test');
		`);
		database.prepare("INSERT INTO settings (key, value) VALUES ('backup_config', ?)").run(JSON.stringify({ destinations: [destination] }));
		database.prepare("INSERT INTO setting_holds (setting, place, held_because, held_at) VALUES ('mail', ?, 'setter access ended', ?)").run(mail, C);
		const at = '2026-11-21 09:00:00';

		expect(outboundSeeded(database)).toBe(false);
		expect(seedOutbound(database, key, at)).toEqual({ seeded: true, rows: 10 });

		const rows = database.prepare('SELECT kind, item_id AS id, item_created AS created, place, address, state, changed_at AS at, stated_changed AS stated, origin FROM outbound_changes ORDER BY seq').all();
		const seed = (row: Record<string, unknown>) => ({ id: 0, created: '', place: '', address: '', at, stated: at, origin: 'seed', ...row });
		expect(rows).toEqual([
			seed({ kind: 'webhook', id: 1, created: C, address: outboundDigest(key, 'https://hooks.example.test/on'), state: 'on' }),
			seed({ kind: 'webhook', id: 2, created: C, address: outboundDigest(key, 'https://hooks.example.test/off'), state: 'off' }),
			seed({ kind: 'webhook', id: 3, created: C, state: 'held' }),
			seed({ kind: 'schedule', id: 5, created: C, state: 'on' }),
			seed({ kind: 'recipient', id: 5, created: C, place: outboundDigest(key, 'a@example.test'), state: 'added' }),
			seed({ kind: 'recipient', id: 5, created: C, place: outboundDigest(key, 'b@example.test'), state: 'added' }),
			seed({ kind: 'schedule', id: 6, created: C, state: 'off' }),
			seed({ kind: 'destination', place: placeKey(destinationPlace(destination)), state: 'set' }),
			seed({ kind: 'mail', place: mail, state: 'held' }),
			seed({ kind: 'app_url', place: placeKey(['https://dumpfire.example.test']), state: 'set' }),
			{ kind: 'seeded', id: 0, created: '', place: '', address: '', state: 'yes', at, stated: at, origin: 'here' }
		]);
		expect(outboundSeeded(database)).toBe(true);

		// Seeded once: a second call writes nothing.
		expect(seedOutbound(database, key)).toEqual({ seeded: false, rows: 0 });
		expect(database.prepare('SELECT count(*) FROM outbound_changes').pluck().get()).toBe(11);
		// The marker is read only as kind seeded and origin here: one carried in as backup is no marker.
		const fresh = migratedDb();
		record(fresh, [{ kind: 'seeded', state: 'yes', at, origin: 'backup' }]);
		expect(outboundSeeded(fresh)).toBe(false);
	});
});

describe("the reads' plans (card 3004, (v); R5)", () => {
	it('with 1,000 rows: the item and union reads on their indexes, no sort; +changed_at keeps outbound_changes_changed out', () => {
		const database = migratedDb();
		const rows: Row[] = [];
		for (let i = 0; i < 1000; i++) {
			const origin = ['here', 'seed', 'backup'][i % 3];
			rows.push({ kind: 'webhook', id: 1 + (i % 50), created: C, state: i % 2 ? 'on' : 'off', at: `2026-05-01 09:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`, origin });
		}
		record(database, rows);
		const params = { kind: 'webhook', id: 1, created: C, place: '', after: '', at: '2026-05-01 09:00:00', asOf: '2026-05-01 09:00:00', stated: C, state: 'on', address: '', before: 1000 };
		for (const analysed of [false, true]) {
			if (analysed) database.exec('ANALYZE');
			const planOf = (sql: string) =>
				(database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params) as { detail: string }[]).map((step) => step.detail).join('; ');
			const item = [
				OUTBOUND_READS.itemHere,
				OUTBOUND_READS.itemHereAsOf,
				OUTBOUND_READS.itemSeed,
				OUTBOUND_READS.itemSeedAsOf,
				OUTBOUND_READS.itemBackupAfter,
				OUTBOUND_READS.itemBackupLatestAt,
				OUTBOUND_READS.itemBackupLatest
			];
			for (const sql of item) {
				expect(planOf(sql), `${sql} (analysed ${analysed})`).toMatch(/USING (COVERING )?INDEX outbound_changes_(item|union)/);
				expect(planOf(sql), sql).not.toContain('outbound_changes_changed');
				expect(planOf(sql), sql).not.toContain('TEMP B-TREE');
			}
			expect(planOf(OUTBOUND_READS.createdOfItem)).toMatch(/USING (COVERING )?INDEX outbound_changes_/);
			expect(planOf(OUTBOUND_CHANGE_HELD_SQL)).toMatch(/USING (COVERING )?INDEX outbound_changes_union/);
		}
	});
});

// ─── Slice S3: the writers (section 5), the start pass (plan 3.10) ──────────────────────────────────────────────────

describe('recordOutboundChange (card 3004, (w))', () => {
	it('throws outside a transaction, writing nothing; inside, item_created is stamp_of of the stored time, or empty where it names no moment', () => {
		const database = migratedDb();
		database.exec(`
			INSERT INTO users (id, username, email, password_hash) VALUES (1, 'ann', 'ann@example.test', 'x');
			INSERT INTO report_schedules (id, user_id, name, recipients, created_at) VALUES
				(7, 1, 'Weekly', '', '2026-02-01T09:00:00.000Z'),
				(8, 1, 'Odd', '', 'not a moment');
		`);
		const off = (id: number) => ({ kind: 'schedule' as const, id, state: 'off' });
		expect(() => recordOutboundChange(database, off(7))).toThrow(/inside the transaction/);
		expect(() => recordSchedulesAs(database, [7], 'off')).toThrow(/inside the transaction/);
		expect(() => recordOutboundState(database, off(7), null)).toThrow(/inside the transaction/);
		expect(database.prepare('SELECT count(*) FROM outbound_changes').pluck().get()).toBe(0);

		database.transaction(() => {
			expect(recordOutboundChange(database, off(7))).toBe(true);
			expect(recordOutboundChange(database, off(8))).toBe(true);
			// One that is not there writes nothing.
			expect(recordOutboundChange(database, off(9))).toBe(false);
		})();
		expect(database.prepare('SELECT item_id AS id, item_created AS created, state, origin FROM outbound_changes ORDER BY seq').all()).toEqual([
			{ id: 7, created: '2026-02-01 09:00:00', state: 'off', origin: 'here' },
			{ id: 8, created: '', state: 'off', origin: 'here' }
		]);
	});
});

describe('the writers of the record (card 3004, section 5)', () => {
	let owner: SessionUser;
	let chief: SessionUser;
	let board: Board;
	let sent: ReturnType<typeof effects>;
	beforeEach(() => {
		resetDb();
		resetAllRateLimits();
		makeSmtp();
		owner = makeUser({ username: 'owner' });
		chief = makeUser({ username: 'chief', role: 'superadmin' });
		board = makeBoard({ owner, name: 'Hooks' }).board;
		// Every mail and delivery recorded, none sent.
		sent = effects();
	});
	afterEach(() => {
		sent.restore();
	});

	const lastSeq = () => (sqlite.prepare('SELECT coalesce(max(seq), 0) FROM outbound_changes').pluck().get() as number) ?? 0;
	/** The rows written since `seq`, as a writer wrote them. */
	const since = (seq: number) =>
		sqlite
			.prepare('SELECT kind, item_id AS id, place, address, state, origin FROM outbound_changes WHERE seq > ? ORDER BY seq')
			.all(seq) as { kind: string; id: number; place: string; address: string; state: string; origin: string }[];
	/** What `write` recorded. */
	const recordedBy = async (write: () => unknown) => {
		const from = lastSeq();
		await write();
		return since(from);
	};
	const digest = (text: string) => outboundDigest(currentMfaKey(), text);
	const hookRow = (kind: string, id: number, state: string, address = '') => ({ kind, id, place: '', address, state, origin: 'here' });

	it('(x) O1 to O4: a webhook made, switched off and on, given another address, and deleted, each recorded; events alone none; R12: off here but on in the record records off', async () => {
		const A = 'https://hooks.example.test/a';
		const B = 'https://hooks.example.test/b';
		let id = 0;
		expect(
			await recordedBy(async () => {
				const made = await api('POST', `/api/v1/boards/${board.id}/webhooks`, { user: owner, body: { url: A } });
				expect(made.status, JSON.stringify(made.body)).toBe(201);
				id = made.body.id;
			})
		).toEqual([hookRow('webhook', id, 'on', digest(A))]);
		const put = async (body: Record<string, unknown>) => {
			const res = await api('PUT', `/api/v1/webhooks/${id}`, { user: owner, body });
			expect(res.status, JSON.stringify(res.body)).toBe(200);
		};
		expect(await recordedBy(() => put({ events: [WEBHOOK_EVENTS[0]] }))).toEqual([]);
		expect(await recordedBy(() => put({ active: false }))).toEqual([hookRow('webhook', id, 'off', digest(A))]);
		expect(await recordedBy(() => put({ active: true }))).toEqual([hookRow('webhook', id, 'on', digest(A))]);
		expect(await recordedBy(() => put({ url: B }))).toEqual([hookRow('webhook', id, 'on', digest(B))]);
		// Switched off by a host edit: a change of events alone records it as it is.
		sqlite.prepare('UPDATE webhooks SET active = 0 WHERE id = ?').run(id);
		expect(await recordedBy(() => put({ events: [] }))).toEqual([hookRow('webhook', id, 'off', digest(B))]);
		expect(await recordedBy(() => put({ events: [WEBHOOK_EVENTS[0]] }))).toEqual([]);
		expect(
			await recordedBy(async () => expect((await api('DELETE', `/api/v1/webhooks/${id}`, { user: owner })).status).toBe(200))
		).toEqual([hookRow('webhook', id, 'deleted', digest(B))]);
	});

	it('(y) O7 to O9: a schedule made, switched off and on, an address added and one taken off, and deleted, each recorded; a rename none', async () => {
		const body = { name: 'Weekly', scope: 'board', scopeId: board.id, frequency: 'weekly', dayOfWeek: 4, timeOfDay: '09:00', recipients: 'A@example.test' };
		let id = 0;
		expect(
			await recordedBy(async () => {
				const made = await api('POST', '/api/report-schedules', stepUp(owner, body));
				expect(made.status, JSON.stringify(made.body)).toBe(201);
				id = made.body.id;
			})
		).toEqual([hookRow('schedule', id, 'on'), { kind: 'recipient', id, place: digest('a@example.test'), address: '', state: 'added', origin: 'here' }]);
		const change = async (change: Record<string, unknown>, asking = false) => {
			const res = await api('PUT', `/api/report-schedules/${id}`, asking ? stepUp(owner, change) : { user: owner, body: change });
			expect(res.status, JSON.stringify(res.body)).toBe(200);
		};
		const recipient = (address: string, state: string) => ({ kind: 'recipient', id, place: digest(address), address: '', state, origin: 'here' });
		expect(await recordedBy(() => change({ name: 'Renamed' }))).toEqual([]);
		expect(await recordedBy(() => change({ enabled: false }))).toEqual([hookRow('schedule', id, 'off')]);
		expect(await recordedBy(() => change({ enabled: true }, true))).toEqual([hookRow('schedule', id, 'on')]);
		expect(await recordedBy(() => change({ recipients: 'a@example.test, b@example.test' }, true))).toEqual([recipient('b@example.test', 'added')]);
		expect(await recordedBy(() => change({ recipients: 'b@example.test' }))).toEqual([recipient('a@example.test', 'removed')]);
		expect(
			await recordedBy(async () => expect((await api('DELETE', `/api/report-schedules/${id}`, { user: owner })).status).toBe(200))
		).toEqual([hookRow('schedule', id, 'deleted')]);
	});

	it('(z) O11: a save of the backup settings records a destination added, moved and removed by its place; the same places none; a Drive folder made by Connect moves it', async () => {
		const OFFSITE = { name: 'Offsite', type: 'sftp', host: 'offsite.example.test', port: 22, username: 'backup', password: '', remotePath: '/backups', hostKey: '' };
		const save = (destinations: unknown[]) => saveBackupConfig({ schedule: 'disabled', destinations } as unknown as BackupConfig);
		const placeOf = (entry: unknown) => placeKey(destinationPlace(entry));
		const destination = (entry: unknown, state: string) => ({ kind: 'destination', id: 0, place: placeOf(entry), address: '', state, origin: 'here' });
		expect(await recordedBy(() => save([OFFSITE]))).toEqual([destination(OFFSITE, 'set')]);
		expect(await recordedBy(() => save([OFFSITE]))).toEqual([]);
		expect(await recordedBy(() => save([{ ...OFFSITE, name: 'Renamed' }]))).toEqual([]);
		const moved = { ...OFFSITE, remotePath: '/elsewhere' };
		expect(await recordedBy(() => save([moved]))).toEqual([destination(OFFSITE, 'removed'), destination(moved, 'set')]);
		expect(await recordedBy(() => save([]))).toEqual([destination(moved, 'removed')]);
		// Connect makes the Drive folder and saves it (gdrive/auth): the destination's place moves with its folder.
		const drive = { type: 'gdrive', name: 'Drive', authMethod: 'oauth', clientId: 'client-id.apps.example.test', clientSecret: 'cs', refreshToken: 'rt', folderId: '' };
		expect(await recordedBy(() => save([drive]))).toEqual([destination(drive, 'set')]);
		const foldered = { ...drive, folderId: 'folder-1' };
		expect(await recordedBy(() => save([foldered]))).toEqual([destination(drive, 'removed'), destination(foldered, 'set')]);
	});

	describe('(aa) O12, the SMTP panel', () => {
		const VARIABLES = ['APP_URL', 'ORIGIN'] as const;
		let environment: Record<string, string | undefined>;
		beforeEach(() => {
			environment = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));
			delete process.env.APP_URL;
			delete process.env.ORIGIN;
		});
		afterEach(() => {
			for (const name of VARIABLES) {
				if (environment[name] === undefined) delete process.env[name];
				else process.env[name] = environment[name];
			}
		});

		it('moves the mail settings and the App URL, each recorded by its place; a From address alone records nothing', async () => {
			const PANEL = { host: 'smtp.example.test', port: 587, allowInsecure: false, user: 'mailer', pass: 'a-mail-password', fromAddress: 'board@example.test', fromName: 'Board' };
			const save = async (body: Record<string, unknown>) => {
				const res = await api('PUT', '/api/admin/smtp', stepUp(chief, body));
				expect(res.status, JSON.stringify(res.body)).toBe(200);
			};
			const place = (kind: string, at: string, state: string) => ({ kind, id: 0, place: at, address: '', state, origin: 'here' });
			const was = settingPlacesIn(sqlite).mail!;
			const mail = mailPlaceOf({ host: 'smtp.example.test', port: 587, user: 'mailer', allowInsecure: false });
			expect(await recordedBy(() => save({ ...PANEL, appUrl: 'https://kanban.example.test' }))).toEqual([
				place('mail', was, 'removed'),
				place('mail', mail, 'set'),
				place('app_url', placeKey(['https://kanban.example.test']), 'set')
			]);
			expect(await recordedBy(() => save({ ...PANEL, fromAddress: 'other@example.test', fromName: 'Other' }))).toEqual([]);
			expect(await recordedBy(() => save({ ...PANEL, appUrl: 'https://boards.example.test' }))).toEqual([
				place('app_url', placeKey(['https://kanban.example.test']), 'removed'),
				place('app_url', placeKey(['https://boards.example.test']), 'set')
			]);
		});
	});

	it('(bb) O13 to O15: removeSettingsSetBy and removeHeldSetting record what they remove; keepHeldSetting records the place kept', () => {
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const DEST = { name: 'Offsite', type: 'sftp', host: 'offsite.example.test', port: 22, username: 'backup', password: '', remotePath: '/backups', hostKey: '' };
		sqlite.prepare("INSERT INTO settings (key, value) VALUES ('app_url', 'https://kanban.example.test') ON CONFLICT (key) DO UPDATE SET value = excluded.value").run();
		sqlite.prepare("INSERT INTO settings (key, value) VALUES ('backup_config', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(JSON.stringify({ destinations: [DEST] }));
		const places = settingPlacesIn(sqlite);
		const setter = sqlite.prepare('INSERT INTO setting_setters (setting, place, user_id) VALUES (?, ?, ?)');
		setter.run('mail', places.mail, admin.id);
		setter.run('app_url', places.appUrl, admin.id);
		setter.run('backup_destination:Offsite', places.destinations[0].place, admin.id);
		const place = (kind: string, at: string | null, state: string) => ({ kind, id: 0, place: at, address: '', state, origin: 'here' });

		const from = lastSeq();
		inTransaction(() => removeSettingsSetBy(admin, 'demoted', chief));
		expect(since(from)).toEqual([place('mail', places.mail, 'removed'), place('app_url', places.appUrl, 'removed'), place('destination', places.destinations[0].place, 'removed')]);

		// Held, then kept and removed by the superadmin.
		makeSmtp();
		const mail = settingPlacesIn(sqlite).mail!;
		sqlite.prepare("INSERT INTO setting_holds (setting, place, held_because, held_at) VALUES ('mail', ?, 'setter access ended', '2026-11-21 09:00:00')").run(mail);
		const held = () => settingsHeldForReview().held.find((h) => h.kind === 'mail')!;
		const kept = lastSeq();
		inTransaction(() => keepHeldSetting(held(), chief));
		expect(since(kept)).toEqual([place('mail', mail, 'set')]);
		sqlite.prepare("INSERT INTO setting_holds (setting, place, held_because, held_at) VALUES ('mail', ?, 'setter access ended', '2026-11-21 09:00:00')").run(mail);
		const removed = lastSeq();
		inTransaction(() => removeHeldSetting(held(), chief));
		expect(since(removed)).toEqual([place('mail', mail, 'removed')]);
	});

	it('(bb2) O16, R8, R13: holdSettingsSetBy holds by HOLD_SETTINGS_SET_BY_SQL and records each place held `held`', () => {
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const mail = settingPlacesIn(sqlite).mail!;
		const setter = sqlite.prepare('INSERT INTO setting_setters (setting, place, user_id) VALUES (?, ?, ?)');
		setter.run('mail', mail, admin.id);
		setter.run('backup_destination:Gone', placeKey(['sftp', 'gone.example.test']), admin.id);
		const from = lastSeq();

		inTransaction(() => holdSettingsSetBy(admin, { log: 'a test' }));

		expect(since(from)).toEqual([
			{ kind: 'destination', id: 0, place: placeKey(['sftp', 'gone.example.test']), address: '', state: 'held', origin: 'here' },
			{ kind: 'mail', id: 0, place: mail, address: '', state: 'held', origin: 'here' }
		]);
		expect(sqlite.prepare('SELECT setting, set_by AS setBy, set_by_name AS name FROM setting_holds ORDER BY setting').all()).toEqual([
			{ setting: 'backup_destination:Gone', setBy: admin.id, name: 'admin' },
			{ setting: 'mail', setBy: admin.id, name: 'admin' }
		]);
		// The one statement, shared with the restore and the host's script (R8): no other insert of a hold there.
		const source = readFileSync(join(process.cwd(), 'src/lib/server/setting-setters.ts'), 'utf8');
		const body = source.slice(source.indexOf('export function holdSettingsSetBy('), source.indexOf('export function heldLines('));
		expect(body).toContain('sqlite.prepare(HOLD_SETTINGS_SET_BY_SQL)');
		expect(body).not.toMatch(/INSERT/i);
	});

	it('(cc) O5, O10: an ending of an account records each webhook it holds `held` and each schedule it pauses `off`; deleteUser records the webhooks it holds', () => {
		const ada = makeUser({ username: 'ada', role: 'admin' });
		const hook = makeWebhook(board, { url: 'https://hooks.example.test/ada', setBy: ada });
		const schedule = Number(sqlite.prepare("INSERT INTO report_schedules (user_id, name, scope, enabled) VALUES (?, 'Weekly', 'all', 1)").run(ada.id).lastInsertRowid);
		seedOutbound(sqlite);
		const seeded = sqlite.prepare("SELECT address FROM outbound_changes WHERE kind = 'webhook' AND item_id = ?").pluck().get(hook.id);
		expect(seeded).toBe(digest('https://hooks.example.test/ada'));
		const from = lastSeq();

		inTransaction(() => endAccountAccess(ada.id, { apiKeys: true, cause: { log: 'a test', mail: 'a test' } }));

		// The webhook's row carries the address its latest row recorded: no key is needed to write it.
		expect(since(from)).toEqual([hookRow('webhook', hook.id, 'held', seeded as string), hookRow('schedule', schedule, 'off')]);

		const bob = makeUser({ username: 'bob', disabled: true });
		const bobs = makeWebhook(board, { url: 'https://hooks.example.test/bob', setBy: bob });
		const deleted = lastSeq();
		deleteUser(bob.id, chief);
		expect(since(deleted)).toEqual([hookRow('webhook', bobs.id, 'held')]);
	});

	it('(dd) O6: a board deleted records each webhook on it and each schedule of it `deleted`, read before the delete', () => {
		const hook = makeWebhook(board, { url: 'https://hooks.example.test/board' });
		const schedule = Number(
			sqlite.prepare("INSERT INTO report_schedules (user_id, name, scope, scope_id, enabled) VALUES (?, 'Board', 'board', ?, 1)").run(owner.id, board.id).lastInsertRowid
		);
		// Another board's are not.
		const other = makeBoard({ owner, name: 'Other' }).board;
		makeWebhook(other, { url: 'https://hooks.example.test/other' });
		seedOutbound(sqlite);
		const from = lastSeq();

		deleteBoard(board.id, chief);

		const created = (table: string, id: number) => sqlite.prepare(`SELECT item_created FROM outbound_changes WHERE kind = ? AND item_id = ? AND origin = 'seed'`).pluck().get(table, id);
		expect(since(from)).toEqual([
			hookRow('webhook', hook.id, 'deleted', digest('https://hooks.example.test/board')),
			hookRow('schedule', schedule, 'deleted')
		]);
		expect(sqlite.prepare("SELECT item_created FROM outbound_changes WHERE origin = 'here' AND state = 'deleted' ORDER BY seq").pluck().all()).toEqual([
			created('webhook', hook.id),
			created('schedule', schedule)
		]);
		expect(sqlite.prepare('SELECT count(*) FROM webhooks WHERE id = ?').pluck().get(hook.id)).toBe(0);
	});

	it('(dd2) O18, R4: deleteUser records each schedule of the account `deleted` before the account goes, its creation time read', () => {
		const bob = makeUser({ username: 'bob', disabled: true });
		const ids = [1, 2].map((n) =>
			Number(sqlite.prepare("INSERT INTO report_schedules (user_id, name, scope, enabled, created_at) VALUES (?, ?, 'all', 1, '2026-03-01 09:00:00')").run(bob.id, `S${n}`).lastInsertRowid)
		);
		const from = lastSeq();

		deleteUser(bob.id, chief);

		expect(sqlite.prepare('SELECT kind, item_id AS id, item_created AS created, state FROM outbound_changes WHERE seq > ? ORDER BY seq').all(from)).toEqual(
			ids.map((id) => ({ kind: 'schedule', id, created: '2026-03-01 09:00:00', state: 'deleted' }))
		);
		expect(sqlite.prepare('SELECT count(*) FROM report_schedules WHERE user_id = ?').pluck().get(bob.id)).toBe(0);
	});
});

describe('the start and five-minute pass over the record (card 3004, plan 3.10)', () => {
	let owner: SessionUser;
	let board: Board;
	let logLevel: string | undefined;
	beforeEach(() => {
		resetDb();
		resetAllRateLimits();
		owner = makeUser({ username: 'owner' });
		board = makeBoard({ owner, name: 'Hooks' }).board;
		// The pass's lines are WARN and INFO, kept in system_logs at INFO.
		logLevel = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'INFO';
	});
	afterEach(() => {
		if (logLevel === undefined) delete process.env.LOG_LEVEL;
		else process.env.LOG_LEVEL = logLevel;
	});

	const backupWarnings = () =>
		(sqlite.prepare("SELECT message FROM system_logs WHERE context = 'BACKUP' AND level = 'WARN' ORDER BY id").pluck().all() as string[]).filter((line) =>
			line.includes("record of where it sends")
		);
	const hookOf = (id: number) => sqlite.prepare('SELECT active, secret, held_because AS heldBecause FROM webhooks WHERE id = ?').get(id);
	const recorded = (change: Parameters<typeof recordOutboundChange>[1]) => inTransaction(() => recordOutboundChange(sqlite, change));
	const DEST = { name: 'Offsite', type: 'sftp', host: 'offsite.example.test', port: 22, username: 'backup', password: '', remotePath: '/backups', hostKey: '' };

	/** Each kind above the record, as an older image's import or a host edit leaves it, and one named only by the seed. */
	const startScene = async () => {
		const made = async (url: string) => {
			const res = await api('POST', `/api/v1/boards/${board.id}/webhooks`, { user: owner, body: { url, secret: 'whsec-3004-ii' } });
			expect(res.status, JSON.stringify(res.body)).toBe(201);
			return res.body.id as number;
		};
		const deleted = await made('https://hooks.example.test/deleted');
		recorded({ kind: 'webhook', id: deleted, state: 'deleted' });
		const repointed = await made('https://hooks.example.test/mine');
		const row = sqlite.prepare('SELECT board_id AS boardId, receiver FROM webhooks WHERE id = ?').get(repointed) as { boardId: number; receiver: string };
		sqlite.prepare('UPDATE webhooks SET url = ? WHERE id = ?').run(sealValue('https://hooks.example.test/planted', webhookUrlAad(repointed, row.boardId, row.receiver), currentMfaKey()!), repointed);
		const schedule = Number(
			sqlite.prepare("INSERT INTO report_schedules (user_id, name, scope, enabled, recipients) VALUES (?, 'Weekly', 'all', 1, 'kept@example.test, gone@example.test')").run(owner.id).lastInsertRowid
		);
		recorded({ kind: 'schedule', id: schedule, state: 'off' });
		recorded({ kind: 'recipient', schedule, address: 'gone@example.test', state: 'removed' });
		sqlite.prepare("INSERT INTO settings (key, value) VALUES ('backup_config', ?)").run(JSON.stringify({ destinations: [DEST] }));
		const destination = settingPlacesIn(sqlite).destinations[0].place;
		recorded({ kind: 'destination', place: destination, state: 'removed' });
		// Only the seed names this one, and says deleted: never enough to close it.
		const seedOnly = makeWebhook(board, { url: 'https://hooks.example.test/seed-only', setBy: owner });
		seedOutbound(sqlite);
		sqlite
			.prepare("INSERT INTO outbound_changes (kind, item_id, item_created, state, changed_at, stated_changed, origin) VALUES ('webhook', ?, ?, 'deleted', ?, ?, 'seed')")
			.run(seedOnly.id, sqlite.prepare("SELECT item_created FROM outbound_changes WHERE kind = 'webhook' AND item_id = ?").pluck().get(seedOnly.id), stamp(), stamp());
		return { deleted, repointed, schedule, destination, seedOnly };
	};

	it.each([
		{ schedulers: 'off', mailed: false },
		{ schedulers: 'on', mailed: true }
	])(
		'(ii) SCHEDULERS=$schedulers: a webhook recorded deleted, one re-pointed, a schedule recorded off, an address recorded removed and a destination recorded removed are put back as the record says; one WARN; mail per setting; the count in the answer; a second run does nothing; a seed-only item untouched',
		async ({ schedulers, mailed }) => {
			const { deleted, repointed, schedule, destination, seedOnly } = await startScene();
			makeSmtp();
			const sent = effects();
			try {
				expect(sweepEndedKeyReveals(schedulers, false)).toBe(5);
				await sent.settle();
				expect(sent.emails.length > 0).toBe(mailed);
			} finally {
				sent.restore();
			}
			expect(hookOf(deleted)).toEqual({ active: 0, secret: '', heldBecause: HELD_DELETED_HERE });
			expect(hookOf(repointed)).toEqual({ active: 0, secret: '', heldBecause: HELD_REPOINTED_HERE });
			expect(hookOf(seedOnly.id)).toMatchObject({ active: 1, heldBecause: null });
			expect(sqlite.prepare('SELECT enabled, recipients FROM report_schedules WHERE id = ?').get(schedule)).toEqual({ enabled: 0, recipients: 'kept@example.test' });
			expect(sqlite.prepare('SELECT setting, place, held_because AS heldBecause, set_by AS setBy FROM setting_holds').all()).toEqual([
				{ setting: 'backup_destination:Offsite', place: destination, heldBecause: HELD_REMOVED_HERE, setBy: null }
			]);
			const said = backupWarnings();
			expect(said).toEqual([
				"Found above this server's record of where it sends (an older image's import or a host edit), and put back as the record says: 0 webhook(s) switched off, " +
					"1 report schedule(s) paused, 1 address(es) taken off report schedules, and 1 setting(s) where this server sends held for the superadmin's review under Settings held for review."
			]);
			expect(said.join('\n')).not.toMatch(/example\.test|owner|Offsite/);

			const record = sqlite.prepare('SELECT * FROM outbound_changes ORDER BY seq').all();
			expect(sweepEndedKeyReveals(schedulers, false)).toBe(0);
			expect(backupWarnings()).toHaveLength(1);
			// It writes nothing to the record: it closes to what the record says.
			expect(sqlite.prepare('SELECT * FROM outbound_changes ORDER BY seq').all()).toEqual(record);
		}
	);

	it('(jj) a row of this server dated after now naming on over a recorded off: the live webhook switched off, and the row counted in its own WARN', async () => {
		const made = await api('POST', `/api/v1/boards/${board.id}/webhooks`, { user: owner, body: { url: 'https://hooks.example.test/later' } });
		const id = made.body.id as number;
		expect((await api('PUT', `/api/v1/webhooks/${id}`, { user: owner, body: { active: false } })).status).toBe(200);
		const created = sqlite.prepare("SELECT item_created FROM outbound_changes WHERE kind = 'webhook' AND item_id = ?").pluck().get(id);
		sqlite
			.prepare("INSERT INTO outbound_changes (kind, item_id, item_created, state, changed_at, stated_changed) VALUES ('webhook', ?, ?, 'on', '2099-01-01 00:00:00', '2099-01-01 00:00:00')")
			.run(id, created);
		sqlite.prepare('UPDATE webhooks SET active = 1 WHERE id = ?').run(id);

		expect(sweepEndedKeyReveals('off', false)).toBe(1);

		expect(hookOf(id)).toMatchObject({ active: 0, heldBecause: null });
		expect(backupWarnings()).toContain("1 row(s) of this server's record of where it sends are dated after now and were not let open anything.");
	});

	it('(kk) the pass that cannot be written (R6): its own WARN with the cause, nothing of it committed, the answer null, and the key pass still commits', async () => {
		const { deleted, schedule } = await startScene();
		const key = makeApiKeyRow(owner);
		const hash = sqlite.prepare('SELECT key_hash FROM api_keys WHERE id = ?').pluck().get(key.id) as string;
		sqlite.prepare("INSERT INTO api_key_revocations (key_id, key_hash, revoked_at, revoked_because) VALUES (?, ?, '2026-11-19 09:00:00', 'revoked')").run(key.id, hash);
		const before = { hook: hookOf(deleted), holds: sqlite.prepare('SELECT count(*) FROM setting_holds').pluck().get() };
		sqlite.exec(`CREATE TEMP TRIGGER card_3004_kk BEFORE UPDATE ON report_schedules WHEN old.id = ${schedule} AND new.enabled = 0 BEGIN SELECT RAISE(ABORT, 'card 3004 kk refused'); END;`);
		try {
			expect(sweepEndedKeyReveals('off', false)).toBeNull();
		} finally {
			sqlite.exec('DROP TRIGGER IF EXISTS temp.card_3004_kk');
		}

		expect(hookOf(deleted)).toEqual(before.hook);
		expect(sqlite.prepare('SELECT enabled FROM report_schedules WHERE id = ?').pluck().get(schedule)).toBe(1);
		expect(sqlite.prepare('SELECT count(*) FROM setting_holds').pluck().get()).toBe(before.holds);
		const said = backupWarnings();
		expect(said).toHaveLength(1);
		expect(said[0]).toMatch(/^What is above this server's record of where it sends could not be held again: .*card 3004 kk refused/);
		// The key pass committed: the recorded key is gone.
		expect(sqlite.prepare('SELECT count(*) FROM api_keys WHERE id = ?').pluck().get(key.id)).toBe(0);
	});

	it('(ll) the start seeds the record once, with one INFO line; seeded, it writes nothing more', () => {
		makeWebhook(board, { url: 'https://hooks.example.test/seeded', setBy: owner });
		expect(outboundSeeded(sqlite)).toBe(false);
		sweepEndedKeyReveals('off', false);
		expect(outboundSeeded(sqlite)).toBe(true);
		const rows = sqlite.prepare('SELECT * FROM outbound_changes ORDER BY seq').all();
		expect(rows.map((row) => (row as { origin: string; kind: string }).kind)).toEqual(['webhook', 'seeded']);
		sweepEndedKeyReveals('off', false);
		expect(sqlite.prepare('SELECT * FROM outbound_changes ORDER BY seq').all()).toEqual(rows);
		const started = sqlite.prepare("SELECT message FROM system_logs WHERE message LIKE 'The record of where this server sends was started%'").pluck().all();
		expect(started).toEqual([
			"The record of where this server sends was started (once, card 3004): 1 webhook(s), report schedule(s), schedule address(es), backup destination(s), mail setting(s) and App URL(s) recorded as they are now."
		]);
	});
});

describe("card 3004's code review: no MFA key, the writers and the seed (F4, F5, F6, F14)", () => {
	let owner: SessionUser;
	let board: Board;
	let sent: ReturnType<typeof effects>;
	beforeEach(() => {
		resetDb();
		resetAllRateLimits();
		makeSmtp();
		owner = makeUser({ username: 'owner' });
		board = makeBoard({ owner, name: 'Hooks' }).board;
		sent = effects();
	});
	afterEach(() => {
		keyStub.none = false;
		sent.restore();
	});

	/** `run` with no MFA key loaded. */
	const keyless = async <T>(run: () => Promise<T>): Promise<T> => {
		keyStub.none = true;
		try {
			return await run();
		} finally {
			keyStub.none = false;
		}
	};
	const recordRows = () => sqlite.prepare('SELECT * FROM outbound_changes ORDER BY seq').all();
	const reportMailUsed = () => allowanceState(`report-mail:${owner.id}`, 100, 24 * 60 * 60 * 1000, Date.now()).used;
	const refusedNoKey = (res: { status: number; body: { message?: unknown } }) => {
		expect(res.status, JSON.stringify(res.body)).toBe(503);
		expect(res.body.message).toBe(NO_OUTBOUND_KEY);
	};
	const scheduleBody = (recipients: string) => ({ name: 'Weekly', scope: 'board', scopeId: board.id, frequency: 'weekly', dayOfWeek: 4, timeOfDay: '09:00', recipients });

	it('(cr-f4)[1] a schedule made with an address and no MFA key: 503 in the step-up guard, before the password, nothing written and none of the day’s report mail taken', async () => {
		const asked = stepUp(owner, scheduleBody('a@example.test'));
		const wrongPassword = stepUp(owner, scheduleBody('a@example.test'), 'not-the-password');
		const before = { schedules: sqlite.prepare('SELECT count(*) FROM report_schedules').pluck().get(), record: recordRows() };

		const res = await keyless(() => api('POST', '/api/report-schedules', asked));
		// Asked before the password is: a wrong one is answered the same.
		const wrong = await keyless(() => api('POST', '/api/report-schedules', wrongPassword));

		refusedNoKey(res);
		refusedNoKey(wrong);
		expect(sqlite.prepare('SELECT count(*) FROM report_schedules').pluck().get()).toBe(before.schedules);
		expect(recordRows()).toEqual(before.record);
		expect(reportMailUsed()).toBe(0);
	});

	it('(cr-f4)[2] a schedule change that adds an address, or only takes one off, with no MFA key: 503, nothing written and none of the day’s report mail taken; a rename is saved', async () => {
		const made = await api('POST', '/api/report-schedules', stepUp(owner, scheduleBody('a@example.test, b@example.test')));
		expect(made.status, JSON.stringify(made.body)).toBe(201);
		const id = made.body.id as number;
		resetAllRateLimits();
		const adding = stepUp(owner, { recipients: 'a@example.test, b@example.test, c@example.test' });
		const row = () => sqlite.prepare('SELECT name, recipients, enabled FROM report_schedules WHERE id = ?').get(id);
		const before = { row: row(), record: recordRows() };

		const added = await keyless(() => api('PUT', `/api/report-schedules/${id}`, adding));
		const removed = await keyless(() => api('PUT', `/api/report-schedules/${id}`, { user: owner, body: { recipients: 'a@example.test' } }));

		refusedNoKey(added);
		refusedNoKey(removed);
		expect(row()).toEqual(before.row);
		expect(recordRows()).toEqual(before.record);
		expect(reportMailUsed()).toBe(0);
		const renamed = await keyless(() => api('PUT', `/api/report-schedules/${id}`, { user: owner, body: { name: 'Renamed' } }));
		expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
	});

	it('(cr-f4)[3] a webhook made, or given another url, with no MFA key: 503, nothing written', async () => {
		const made = await api('POST', `/api/v1/boards/${board.id}/webhooks`, { user: owner, body: { url: 'https://hooks.example.test/a' } });
		expect(made.status, JSON.stringify(made.body)).toBe(201);
		const id = made.body.id as number;
		const hooks = () => sqlite.prepare('SELECT * FROM webhooks ORDER BY id').all();
		const before = { hooks: hooks(), record: recordRows() };

		const another = await keyless(() => api('POST', `/api/v1/boards/${board.id}/webhooks`, { user: owner, body: { url: 'https://hooks.example.test/b' } }));
		const moved = await keyless(() => api('PUT', `/api/v1/webhooks/${id}`, { user: owner, body: { url: 'https://hooks.example.test/c' } }));

		refusedNoKey(another);
		refusedNoKey(moved);
		expect(hooks()).toEqual(before.hooks);
		expect(recordRows()).toEqual(before.record);
	});

	it('(cr-f5) a webhook PUT that leaves the address as it is needs no digest: with no MFA key, events alone record nothing, and a switch-off records off with the digest the record has', async () => {
		const A = 'https://hooks.example.test/plain';
		const made = await api('POST', `/api/v1/boards/${board.id}/webhooks`, { user: owner, body: { url: A } });
		const id = made.body.id as number;
		// Its address held in plain, as before card 2928's sealing: it opens with no key.
		sqlite.prepare('UPDATE webhooks SET url = ? WHERE id = ?').run(A, id);
		const sealed = makeWebhook(board, { url: 'https://hooks.example.test/sealed', setBy: owner });
		const sealedDigest = outboundDigest(currentMfaKey(), 'https://hooks.example.test/sealed');
		inTransaction(() => recordOutboundChange(sqlite, { kind: 'webhook', id: sealed.id, state: 'on', address: 'https://hooks.example.test/sealed' }));
		const before = recordRows().length;

		const events = await keyless(() => api('PUT', `/api/v1/webhooks/${id}`, { user: owner, body: { events: [WEBHOOK_EVENTS[0]] } }));
		const sealedEvents = await keyless(() => api('PUT', `/api/v1/webhooks/${sealed.id}`, { user: owner, body: { events: [WEBHOOK_EVENTS[0]] } }));
		const off = await keyless(() => api('PUT', `/api/v1/webhooks/${sealed.id}`, { user: owner, body: { active: false } }));

		expect(events.status, JSON.stringify(events.body)).toBe(200);
		expect(sealedEvents.status, JSON.stringify(sealedEvents.body)).toBe(200);
		expect(off.status, JSON.stringify(off.body)).toBe(200);
		expect(
			(recordRows() as { kind: string; item_id: number; address: string; state: string }[]).slice(before).map(({ kind, item_id, address, state }) => ({ kind, item_id, address, state }))
		).toEqual([{ kind: 'webhook', item_id: sealed.id, address: sealedDigest, state: 'off' }]);
	});

	it('(cr-f6) sameDigest: equal texts are the same, any other differs, of whatever length', () => {
		const key = currentMfaKey()!;
		const a = outboundDigest(key, 'https://a.example.test');
		expect(sameDigest(a, outboundDigest(key, 'https://a.example.test'))).toBe(true);
		expect(sameDigest(a, outboundDigest(key, 'https://b.example.test'))).toBe(false);
		expect(sameDigest(a, a.slice(0, -1))).toBe(false);
		expect(sameDigest(a, '')).toBe(false);
		expect(sameDigest('', '')).toBe(true);
	});

	it('(cr-f14) the seed with no MFA key: where no webhook and no schedule has an address, the rows and the marker are written; else it refuses, writing nothing', () => {
		const database = migratedDb();
		database.exec(`
			INSERT INTO users (id, username, email, password_hash) VALUES (1, 'ann', 'ann@example.test', 'x');
			INSERT INTO boards (id, name, created_by) VALUES (1, 'Hooks', 1);
			INSERT INTO webhooks (id, board_id, url, events, active, created_at) VALUES (1, 1, '', '[]', 0, '${C}');
			INSERT INTO report_schedules (id, user_id, name, recipients, enabled, created_at) VALUES (5, 1, 'None yet', '', 1, '${C}');
		`);
		const at = '2026-11-21 09:00:00';

		expect(seedOutbound(database, null, at)).toEqual({ seeded: true, rows: 2 });

		expect(database.prepare('SELECT kind, item_id AS id, address, state, origin FROM outbound_changes ORDER BY seq').all()).toEqual([
			{ kind: 'webhook', id: 1, address: '', state: 'off', origin: 'seed' },
			{ kind: 'schedule', id: 5, address: '', state: 'on', origin: 'seed' },
			{ kind: 'seeded', id: 0, address: '', state: 'yes', origin: 'here' }
		]);
		const withAddress = migratedDb();
		withAddress.exec(`
			INSERT INTO users (id, username, email, password_hash) VALUES (1, 'ann', 'ann@example.test', 'x');
			INSERT INTO boards (id, name, created_by) VALUES (1, 'Hooks', 1);
			INSERT INTO webhooks (id, board_id, url, events, active, created_at) VALUES (1, 1, 'https://hooks.example.test/a', '[]', 1, '${C}');
		`);
		expect(() => seedOutbound(withAddress, null, at)).toThrow(NoKeyToSeal);
		expect(withAddress.prepare('SELECT count(*) FROM outbound_changes').pluck().get()).toBe(0);
	});
});
