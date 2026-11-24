/**
 * Card 2947: revoking or expiring an API key holds the webhooks whose secret that key was given.
 *
 * `webhook_reveals` (migration 0075) records which key was given which webhook's secret. A revoke reads what the key
 * was given, deletes the key, sweeps its account's webhooks as before (card 2893), then holds every webhook with a
 * secret it was given that is not already held, as setter access ended (R3), and tells it all once after the commit
 * (R4), the mail naming no account (R12) and saying the old secret is exposed (R6). A sweep at every start and every
 * five minutes does the same for keys that expired, passed their deadline or are gone, and deletes their rows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import ts from 'typescript';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { inTransaction } from '$lib/server/db/transaction';
import { users } from '$lib/server/db/schema';
import { endAccountAccess, sessionTokenHash } from '$lib/server/auth';
import { disableAccount } from '$lib/server/account-disable';
import { deleteUser } from '$lib/server/deletes';
import { resetTwoStep } from '$lib/server/mfa-store';
import {
	ENDING_IN_MAIL,
	SWITCHED_OFF_BECAUSE,
	WEBHOOK_REVEALS_SEEDED,
	answerWebhook,
	holdRevealsOfEndedKeys
} from '$lib/server/webhooks';
import { EXPOSED_SECRET_SENTENCE } from '$lib/server/notifications';
import { REVEAL_SWEEP_EVERY_MS, startEndedKeyRevealSweep, stopEndedKeyRevealSweep, sweepEndedKeyReveals } from '$lib/server/startup-checks';
import { stamp } from '$lib/timestamps';
import { api } from './helpers/api';
import { effects, type Effects } from './helpers/effects';
import { allowOtherTimestampForms } from './helpers/timestamps';
import { addBoardMember, forgetFirstRunFlags, makeApiKeyRow, makeBoard, makeSession, makeSmtp, makeUser, makeWebhook, resetDb, startedSinceAlreadyOffHeld } from './helpers/fixtures';
import Database from 'better-sqlite3';
import { generateBackupData } from '$lib/server/backup';
import { restoreFromBackup } from '$lib/server/db/restore';
import { sealPlainSecrets } from '$lib/server/stored-secrets';

beforeEach(resetDb);
// Each first-run pass in full, as before migration 0084 seeded their flags (card 3064, R23).
beforeEach(() => forgetFirstRunFlags());

let sent: Effects;
let level: string | undefined;
let quiet: { mockRestore(): void }[] = [];
beforeEach(() => {
	sent = effects();
	level = process.env.LOG_LEVEL;
	process.env.LOG_LEVEL = 'INFO';
	quiet = [vi.spyOn(console, 'warn').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {})];
});
afterEach(() => {
	sent.restore();
	vi.useRealTimers();
	if (level === undefined) delete process.env.LOG_LEVEL;
	else process.env.LOG_LEVEL = level;
	for (const spy of quiet) spy.mockRestore();
});

/** A webhook's hold as stored. */
const holdOf = (id: number) =>
	sqlite.prepare('SELECT active, held_because AS heldBecause FROM webhooks WHERE id = ?').get(id) as { active: number; heldBecause: string | null };
const HELD = { active: 0, heldBecause: 'setter access ended' };
const ON = { active: 1, heldBecause: null };

/** Record that key `keyId` was given webhook `hookId`'s secret, as an answer does (the writer is slice 3's). */
const reveal = (hookId: number, keyId: number, at: string | null = stamp()) =>
	sqlite.prepare('INSERT INTO webhook_reveals (webhook_id, key_id, revealed_at) VALUES (?, ?, ?)').run(hookId, keyId, at);
/** The rows, as [webhook, key] pairs in order. */
const rows = () =>
	(sqlite.prepare('SELECT webhook_id AS w, key_id AS k FROM webhook_reveals ORDER BY webhook_id, key_id').all() as { w: number; k: number }[]).map(
		(row) => [row.w, row.k]
	);

/** The Webhooks WARN lines, oldest first. */
const warnLines = () => sqlite.prepare("SELECT message FROM system_logs WHERE context = 'Webhooks' AND level = 'WARN' ORDER BY id").pluck().all() as string[];

const revoke = (user: Parameters<typeof makeApiKeyRow>[0], keyId: number) => api('DELETE', `/api/account/api-keys/${keyId}`, { user });

/** The owner's board, an editor on it, and a key of the owner's. */
function scene() {
	const owner = makeUser({ username: 'olive' });
	const editor = makeUser({ username: 'eddie' });
	const { board } = makeBoard({ owner, name: 'Shared board' });
	addBoardMember(board, editor, 'editor');
	const k = makeApiKeyRow(owner);
	return { owner, editor, board, k };
}

describe('a revoke holds what the key was given (card 2947, R3)', () => {
	it('9. on: switched off; already off: held; held for another reason: kept; no secret: left; the answer counts them; the rows go', async () => {
		const s = scene();
		const on = makeWebhook(s.board, { secret: 'a', setBy: s.editor });
		const off = makeWebhook(s.board, { secret: 'b', setBy: s.editor, active: false });
		const keyEnded = makeWebhook(s.board, { secret: 'c', setBy: s.editor, heldBecause: 'key ended' });
		const bare = makeWebhook(s.board, { setBy: s.editor });
		const notGiven = makeWebhook(s.board, { secret: 'd', setBy: s.editor });
		for (const hook of [on, off, keyEnded, bare]) reveal(hook.id, s.k.id);
		const other = makeApiKeyRow(s.owner);
		reveal(notGiven.id, other.id);

		const res = await revoke(s.owner, s.k.id);

		expect(res.status).toBe(200);
		expect(res.body).toEqual({ success: true, webhooksSwitchedOff: 0, revealedWebhooksHeld: 2 });
		expect([holdOf(on.id), holdOf(off.id), holdOf(keyEnded.id), holdOf(bare.id), holdOf(notGiven.id)]).toEqual([
			HELD,
			HELD,
			{ active: 0, heldBecause: 'key ended' },
			ON,
			ON
		]);
		// The key's rows went with it; another key's stay.
		expect(rows()).toEqual([[notGiven.id, other.id]]);
		// Switched on again by the owner with another key: a new secret, and its sentence before then says why.
		const read = await api('GET', `/api/v1/webhooks/${on.id}`, { user: s.owner });
		expect(read.body.pausedBecause).toBe(SWITCHED_OFF_BECAUSE['setter access ended']);
	});

	it('10. one the key set, on, is switched off as its key ended, not by the reveal hold; a revoke whose reveal hold fails, after the delete and the sweep, leaves everything as it was', async () => {
		const s = scene();
		const set = makeWebhook(s.board, { secret: 's', setBy: s.owner, setWithKey: true, setByKey: s.k.id });
		const given = makeWebhook(s.board, { secret: 'g', setBy: s.editor });
		reveal(set.id, s.k.id);
		reveal(given.id, s.k.id);
		// Fires only at the reveal hold, after the key's delete and the setters' sweep have written (its code review, FP7).
		sqlite.exec(
			"CREATE TRIGGER refuse_reveal_hold BEFORE UPDATE ON webhooks WHEN NEW.held_because = 'setter access ended' BEGIN SELECT RAISE(ABORT, 'refused in a test'); END;"
		);
		try {
			await expect(revoke(s.owner, s.k.id)).rejects.toThrow(/refused in a test/);
		} finally {
			sqlite.exec('DROP TRIGGER refuse_reveal_hold');
		}
		expect(sqlite.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE id = ?').get(s.k.id)).toEqual({ n: 1 });
		expect(sqlite.prepare('SELECT set_by_key AS k FROM webhooks WHERE id = ?').get(set.id)).toEqual({ k: s.k.id });
		expect([holdOf(set.id), holdOf(given.id)]).toEqual([ON, ON]);
		expect(rows()).toEqual([
			[set.id, s.k.id],
			[given.id, s.k.id]
		]);

		const res = await revoke(s.owner, s.k.id);

		expect(res.body).toEqual({ success: true, webhooksSwitchedOff: 1, revealedWebhooksHeld: 1 });
		expect([holdOf(set.id), holdOf(given.id)]).toEqual([{ active: 0, heldBecause: 'key ended' }, HELD]);
		expect(rows()).toEqual([]);
	});

	it('11. told once after the commit (R4): one WARN per group naming the key, one mail per owner over both holds, naming no account (R12), saying the old secret is exposed (R6)', async () => {
		makeSmtp();
		const s = scene();
		const set = makeWebhook(s.board, { url: 'https://a.example.test/never', secret: 's', setBy: s.owner, setWithKey: true, setByKey: s.k.id });
		const given = makeWebhook(s.board, { url: 'https://b.example.test/path', secret: 't', setBy: s.editor });
		const givenOff = makeWebhook(s.board, { url: 'https://c.example.test/x', secret: 'u', setBy: s.editor, active: false });
		for (const hook of [set, given, givenOff]) reveal(hook.id, s.k.id);
		sent.clear();

		expect((await revoke(s.owner, s.k.id)).status).toBe(200);
		await sent.settle();

		const cause = `API key #${s.k.id} was revoked by olive`;
		expect(warnLines()).toEqual([
			`2 webhooks switched off (${cause}): webhook ${set.id} on board ${s.board.id}: the API key that set it up (no key recorded, user ${s.owner.id}) has ended; ` +
				`webhook ${given.id} on board ${s.board.id}: an API key that was given its secret (key ${s.k.id}, user ${s.owner.id}) ended. ` +
				'Each stays off until an owner of its board or an administrator switches it on.',
			`Webhook ${givenOff.id} on board ${s.board.id}, already switched off, is now held: an API key that was given its secret (key ${s.k.id}, user ${s.owner.id}) ended (${cause}). ` +
				'Switched on again by an owner of the board or an administrator, it is given a new secret.'
		]);
		// The owner, who is also the setter of the one its key set: one mail.
		expect(sent.emails.map((mail) => mail.to)).toEqual([s.owner.email]);
		const [mail] = sent.emails;
		expect(mail.html).toContain('What caused it: an API key was revoked by its holder.');
		expect(mail.html).toContain(`webhook ${given.id} to <strong>b.example.test</strong>, switched off because an API key that was given its secret ended.`);
		expect(mail.html).toContain(EXPOSED_SECRET_SENTENCE);
		for (const never of ['olive', 'eddie', 'never', 'path']) expect(mail.html).not.toContain(never);
	});

	it('11b. a webhook the key made with a secret, and so was given, is switched off as its key ended and told as exposed (FP4); one it set with no secret is not', async () => {
		makeSmtp();
		const s = scene();
		const made = await api('POST', `/api/v1/boards/${s.board.id}/webhooks`, {
			user: s.owner,
			credential: byKey(s.k.id),
			body: { url: 'https://made.example.test/in', secret: 'chosen-11b' }
		});
		expect(made.status).toBe(201);
		expect(rows()).toEqual([[made.body.id, s.k.id]]);
		sent.clear();

		expect((await revoke(s.owner, s.k.id)).body).toEqual({ success: true, webhooksSwitchedOff: 1, revealedWebhooksHeld: 0 });
		await sent.settle();

		expect(holdOf(made.body.id)).toEqual({ active: 0, heldBecause: 'key ended' });
		expect(sent.emails).toHaveLength(1);
		expect(sent.emails[0].html).toContain(EXPOSED_SECRET_SENTENCE);

		// A key that set a webhook with no secret was given nothing: no sentence.
		const other = makeApiKeyRow(s.owner);
		makeWebhook(s.board, { setBy: s.owner, setWithKey: true, setByKey: other.id });
		sent.clear();
		await revoke(s.owner, other.id);
		await sent.settle();
		expect(sent.emails).toHaveLength(1);
		expect(sent.emails[0].html).not.toContain(EXPOSED_SECRET_SENTENCE);
	});
});

describe('the sweep of ended keys (card 2947)', () => {
	const past = '2026-01-01 00:00:00';

	it.each([
		{ row: 'an expiry passed', end: (id: number) => sqlite.prepare('UPDATE api_keys SET expires_at = ? WHERE id = ?').run(past, id), how: 'expired' },
		{ row: 'a deadline passed', end: (id: number) => sqlite.prepare('UPDATE api_keys SET deadline_at = ? WHERE id = ?').run(past, id), how: 'passed its deadline' },
		{
			row: 'an expiry that names no moment',
			end: (id: number) => {
				allowOtherTimestampForms();
				sqlite.prepare("UPDATE api_keys SET expires_at = 'soon' WHERE id = ?").run(id);
			},
			how: 'expired'
		}
	])('12. $row: what it was given held, its rows deleted, its row kept; a live key’s left; a second run holds nothing', ({ end, how }) => {
		const s = scene();
		const live = makeApiKeyRow(s.owner);
		const given = makeWebhook(s.board, { secret: 'a', setBy: s.editor });
		const toLive = makeWebhook(s.board, { secret: 'b', setBy: s.editor });
		reveal(given.id, s.k.id);
		reveal(toLive.id, live.id);
		end(s.k.id);

		expect(sweepEndedKeyReveals('off', false)).toBe(1);

		expect([holdOf(given.id), holdOf(toLive.id)]).toEqual([HELD, ON]);
		expect(rows()).toEqual([[toLive.id, live.id]]);
		expect(sqlite.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE id = ?').get(s.k.id)).toEqual({ n: 1 });
		expect(warnLines()[0]).toContain(`(API key #${s.k.id} of user ${s.owner.id} ${how})`);
		expect(sweepEndedKeyReveals('off', false)).toBe(0);
	});

	it('13. a row whose key row is gone (written with the foreign keys off): its webhook held, the row deleted', () => {
		const s = scene();
		const given = makeWebhook(s.board, { secret: 'a', setBy: s.editor });
		sqlite.pragma('foreign_keys = OFF');
		try {
			reveal(given.id, 999999);
		} finally {
			sqlite.pragma('foreign_keys = ON');
		}

		expect(sweepEndedKeyReveals('off', false)).toBe(1);

		expect(holdOf(given.id)).toEqual(HELD);
		expect(rows()).toEqual([]);
		expect(warnLines()[0]).toContain('an API key that was given its secret (key 999999) ended (API key #999999 is gone)');
	});

	it('13b. the key’s own webhook, on, is switched off as its key ended, before the reveal hold', () => {
		const s = scene();
		const set = makeWebhook(s.board, { secret: 's', setBy: s.owner, setWithKey: true, setByKey: s.k.id });
		reveal(set.id, s.k.id);
		sqlite.prepare('UPDATE api_keys SET expires_at = ? WHERE id = ?').run(past, s.k.id);

		expect(sweepEndedKeyReveals('off', false)).toBe(1);

		expect(holdOf(set.id)).toEqual({ active: 0, heldBecause: 'key ended' });
	});

	it('13c. an expiry where the key both set and was given W: W ends `key ended`, not by the reveal hold, and the mail says its secret is exposed (FP10 c, FP4)', async () => {
		makeSmtp();
		const s = scene();
		const w = makeWebhook(s.board, { secret: 's', setBy: s.owner, setWithKey: true, setByKey: s.k.id });
		reveal(w.id, s.k.id);
		sqlite.prepare('UPDATE api_keys SET expires_at = ? WHERE id = ?').run(past, s.k.id);
		sent.clear();

		expect(sweepEndedKeyReveals('on', false)).toBe(1);
		await sent.settle();

		expect(holdOf(w.id)).toEqual({ active: 0, heldBecause: 'key ended' });
		expect(warnLines()[0]).toContain('the API key that set it up');
		expect(sent.emails.map((mail) => mail.to)).toEqual([s.owner.email]);
		expect(sent.emails[0].html).toContain(EXPOSED_SECRET_SENTENCE);
	});

	it.each([
		{ row: 'disabled', end: (userId: number) => sqlite.prepare("UPDATE users SET disabled_at = '2026-11-19 09:00:00' WHERE id = ?").run(userId) },
		{
			row: 'gone',
			end: (userId: number) => {
				sqlite.pragma('foreign_keys = OFF');
				try {
					sqlite.prepare('DELETE FROM users WHERE id = ?').run(userId);
				} finally {
					sqlite.pragma('foreign_keys = ON');
				}
			}
		}
	])('13d. a key whose account is $row has ended, as the gate reads it (FP3): what it was given held, its rows deleted', ({ end }) => {
		const s = scene();
		const holder = makeUser({ username: 'kim' });
		const key = makeApiKeyRow(holder);
		const given = makeWebhook(s.board, { secret: 'a', setBy: s.editor });
		reveal(given.id, key.id);
		end(holder.id);

		expect(sweepEndedKeyReveals('off', false)).toBe(1);

		expect(holdOf(given.id)).toEqual(HELD);
		expect(rows()).toEqual([]);
		expect(warnLines()[0]).toContain(`(API key #${key.id} of user ${holder.id} belongs to an account that is disabled or gone)`);
	});

	it('14. told where the schedulers run: the owners mailed once; where they do not, one WARN that they were not', async () => {
		makeSmtp();
		const s = scene();
		const given = makeWebhook(s.board, { secret: 'a', setBy: s.editor });
		reveal(given.id, s.k.id);
		sqlite.prepare('UPDATE api_keys SET expires_at = ? WHERE id = ?').run(past, s.k.id);
		sent.clear();

		expect(sweepEndedKeyReveals('on', false)).toBe(1);
		await sent.settle();

		expect(sent.emails.map((mail) => mail.to)).toEqual([s.owner.email]);
		expect(sent.emails[0].html).toContain('What caused it: an API key that had been given webhook secrets expired, passed its deadline or was removed.');
		expect(sent.emails[0].html).toContain(EXPOSED_SECRET_SENTENCE);

		const second = makeWebhook(s.board, { secret: 'b', setBy: s.editor });
		const k2 = makeApiKeyRow(s.owner);
		reveal(second.id, k2.id);
		sqlite.prepare('UPDATE api_keys SET deadline_at = ? WHERE id = ?').run(past, k2.id);
		sent.clear();

		expect(sweepEndedKeyReveals('off', false)).toBe(1);
		await sent.settle();

		expect(sent.emails).toEqual([]);
		expect(warnLines().at(-1)).toBe(
			'The owners of the boards of the 1 webhook(s) switched off above were not mailed, as the schedulers are off (SCHEDULERS=off). The line above names it.'
		);
	});

	it('14b. a sweep whose hold fails says so, commits nothing and holds at the next run; the timer runs it every five minutes, once', () => {
		vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
		const s = scene();
		const given = makeWebhook(s.board, { secret: 'a', setBy: s.editor });
		reveal(given.id, s.k.id);
		sqlite.prepare('UPDATE api_keys SET expires_at = ? WHERE id = ?').run(past, s.k.id);
		sqlite.exec("CREATE TRIGGER refuse_hold BEFORE UPDATE ON webhooks BEGIN SELECT RAISE(ABORT, 'refused in a test'); END;");
		try {
			expect(sweepEndedKeyReveals('off', false)).toBeNull();
		} finally {
			sqlite.exec('DROP TRIGGER refuse_hold');
		}
		expect(warnLines()).toEqual([
			'The webhooks whose secret an ended API key was given could not be held: refused in a test. The next sweep, within five minutes, tries again.'
		]);
		expect(holdOf(given.id)).toEqual(ON);
		expect(rows()).toEqual([[given.id, s.k.id]]);
		// The seed's flag rolled back with the hold (its code review, FP7).
		expect(sqlite.prepare('SELECT COUNT(*) AS n FROM settings WHERE key = ?').get(WEBHOOK_REVEALS_SEEDED)).toEqual({ n: 0 });

		stopEndedKeyRevealSweep();
		startEndedKeyRevealSweep('off', false);
		expect(startEndedKeyRevealSweep('off', false)).toBeNull();
		try {
			vi.advanceTimersByTime(REVEAL_SWEEP_EVERY_MS - 1);
			expect(holdOf(given.id)).toEqual(ON);
			vi.advanceTimersByTime(1);
			expect(holdOf(given.id)).toEqual(HELD);
			expect(rows()).toEqual([]);
			// One timer: a second tick finds nothing, and writes no second line.
			const lines = warnLines().length;
			vi.advanceTimersByTime(REVEAL_SWEEP_EVERY_MS);
			expect(warnLines()).toHaveLength(lines);
		} finally {
			stopEndedKeyRevealSweep();
		}
	});

	it('14c. holdRevealsOfEndedKeys throws outside a transaction, and holds nothing with no ended key', () => {
		const s = scene();
		const given = makeWebhook(s.board, { secret: 'a', setBy: s.editor });
		reveal(given.id, s.k.id);

		expect(() => holdRevealsOfEndedKeys()).toThrow(/none is open/);
		// The seed's flag is written by the first run (R7), with nothing to seed: no key has been used.
		expect(inTransaction(() => holdRevealsOfEndedKeys())).toEqual({ switchedOff: [], held: [], ended: [], seeded: 0 });
		expect(inTransaction(() => holdRevealsOfEndedKeys())).toEqual({ switchedOff: [], held: [], ended: [], seeded: null });
		expect(rows()).toEqual([[given.id, s.k.id]]);
	});

	it('14d. the five-minute timer does not keep the process alive (FP14)', () => {
		stopEndedKeyRevealSweep();
		const timer = startEndedKeyRevealSweep('off', false);
		try {
			expect(timer).not.toBeNull();
			expect(timer!.hasRef()).toBe(false);
		} finally {
			stopEndedKeyRevealSweep();
		}
	});
});

/** The credential the gate records for a request made with this key's row. */
const byKey = (id: number) => ({ kind: 'api key' as const, id });
/** When key `keyId` was recorded as given webhook `hookId`'s secret, or undefined for no row. */
const revealedAt = (hookId: number, keyId: number) =>
	(sqlite.prepare('SELECT revealed_at AS at FROM webhook_reveals WHERE webhook_id = ? AND key_id = ?').get(hookId, keyId) as { at: string | null } | undefined)?.at;

describe('every answer that gives a secret records the key it was given to (card 2947)', () => {
	it('1. GET one by the owner’s key: a row with the time; a second GET keeps the first time; kept in no cache (R11)', async () => {
		const s = scene();
		const hook = makeWebhook(s.board, { secret: 'a-secret', setBy: s.editor });

		const first = await api('GET', `/api/v1/webhooks/${hook.id}`, { user: s.owner, credential: byKey(s.k.id) });

		expect(first.status).toBe(200);
		expect(first.body.secret).toBe('a-secret');
		expect(first.headers.get('cache-control')).toBe('no-store');
		const at = revealedAt(hook.id, s.k.id);
		expect(at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
		sqlite.prepare("UPDATE webhook_reveals SET revealed_at = '2026-11-01 09:00:00'").run();
		await api('GET', `/api/v1/webhooks/${hook.id}`, { user: s.owner, credential: byKey(s.k.id) });
		expect(revealedAt(hook.id, s.k.id)).toBe('2026-11-01 09:00:00');
		expect(rows()).toEqual([[hook.id, s.k.id]]);
	});

	it('2. GET the list: a row for each webhook given a secret, in one write; none with no secret or one that does not open; none for an editor’s key', async () => {
		const s = scene();
		const admin = makeUser({ role: 'admin' });
		const adminKey = makeApiKeyRow(admin);
		const editorKey = makeApiKeyRow(s.editor);
		const a = makeWebhook(s.board, { secret: 'a', setBy: s.editor });
		const b = makeWebhook(s.board, { secret: 'b', setBy: s.editor });
		makeWebhook(s.board, { setBy: s.editor });
		makeWebhook(s.board, { secret: 'dfsealed:not-a-real-envelope', setBy: s.editor });

		const listed = await api('GET', `/api/v1/boards/${s.board.id}/webhooks`, { user: admin, credential: byKey(adminKey.id) });
		const editors = await api('GET', `/api/v1/boards/${s.board.id}/webhooks`, { user: s.editor, credential: byKey(editorKey.id) });

		expect(listed.status).toBe(200);
		expect(listed.headers.get('cache-control')).toBe('no-store');
		expect(editors.body.every((hook: Record<string, unknown>) => !('secret' in hook))).toBe(true);
		expect(rows()).toEqual([
			[a.id, adminKey.id],
			[b.id, adminKey.id]
		]);
	});

	it('3. a PUT that changes only events answers without the secret (R9), records nothing new, and keeps who was given it', async () => {
		const s = scene();
		const m = makeApiKeyRow(s.owner);
		const hook = makeWebhook(s.board, { secret: 'kept', setBy: s.editor });
		reveal(hook.id, s.k.id);

		const changed = await api('PUT', `/api/v1/webhooks/${hook.id}`, { user: s.owner, credential: byKey(m.id), body: { events: ['card.created'] } });

		expect(changed.status).toBe(200);
		expect(changed.headers.get('cache-control')).toBe('no-store');
		expect(changed.body).toMatchObject({ hasSecret: true, url: hook.address });
		expect(changed.body).not.toHaveProperty('secret');
		expect(rows()).toEqual([[hook.id, s.k.id]]);
	});

	it.each([
		{ row: 'a new secret: every key given the old one forgotten, the caller’s recorded, the secret answered', body: { secret: 'brand-new' }, after: 'mine', answered: 'brand-new' },
		{ row: "'' clearing it: every row forgotten, none written", body: { secret: '' }, after: 'none', answered: '' },
		{ row: 'a new address keeping the secret: the rows kept, no secret answered', body: { url: 'https://moved.example.test/in' }, after: 'kept', answered: undefined },
		{ row: 'the same secret sent back: no change, the rows kept, no secret answered', body: { secret: 'old' }, after: 'kept', answered: undefined }
	])('4. a PUT by the owner with key M, $row', async ({ body, after, answered }) => {
		const s = scene();
		const m = makeApiKeyRow(s.owner);
		const hook = makeWebhook(s.board, { secret: 'old', setBy: s.editor });
		reveal(hook.id, s.k.id);

		const changed = await api('PUT', `/api/v1/webhooks/${hook.id}`, { user: s.owner, credential: byKey(m.id), body });

		expect(changed.status).toBe(200);
		if (answered === undefined) expect(changed.body).not.toHaveProperty('secret');
		else expect(changed.body.secret).toBe(answered);
		expect(rows()).toEqual(after === 'mine' ? [[hook.id, m.id]] : after === 'none' ? [] : [[hook.id, s.k.id]]);
	});

	it('5. switched on out of a hold: a new secret, given to the switching key alone', async () => {
		const s = scene();
		const m = makeApiKeyRow(s.owner);
		const hook = makeWebhook(s.board, { secret: 'old', setBy: s.editor, heldBecause: 'setter access ended' });
		reveal(hook.id, s.k.id);

		const on = await api('PUT', `/api/v1/webhooks/${hook.id}`, { user: s.owner, credential: byKey(m.id), body: { active: true } });

		expect(on.status).toBe(200);
		expect(on.body.secret).toMatch(/^[0-9a-f]{64}$/);
		expect(rows()).toEqual([[hook.id, m.id]]);
	});

	it('6. a POST with a secret records the creating key; one with none records nothing; kept in no cache', async () => {
		const s = scene();
		const e = makeApiKeyRow(s.editor);

		const signed = await api('POST', `/api/v1/boards/${s.board.id}/webhooks`, { user: s.editor, credential: byKey(e.id), body: { url: 'https://a.example.test/in', secret: 'chosen' } });
		const bare = await api('POST', `/api/v1/boards/${s.board.id}/webhooks`, { user: s.editor, credential: byKey(e.id), body: { url: 'https://b.example.test/in' } });

		expect([signed.status, bare.status]).toEqual([201, 201]);
		expect(signed.headers.get('cache-control')).toBe('no-store');
		expect(rows()).toEqual([[signed.body.id, e.id]]);
	});

	it('7. a record that cannot be written gives no secret; a key ended before the read is 401 and records nothing', async () => {
		const s = scene();
		const hook = makeWebhook(s.board, { secret: 'a', setBy: s.editor });
		sqlite.exec("CREATE TRIGGER refuse_reveal BEFORE INSERT ON webhook_reveals BEGIN SELECT RAISE(ABORT, 'refused in a test'); END;");
		try {
			await expect(api('GET', `/api/v1/webhooks/${hook.id}`, { user: s.owner, credential: byKey(s.k.id) })).rejects.toThrow(/refused in a test/);
		} finally {
			sqlite.exec('DROP TRIGGER refuse_reveal');
		}
		expect(rows()).toEqual([]);

		sqlite.prepare('DELETE FROM api_keys WHERE id = ?').run(s.k.id);
		const ended = await api('GET', `/api/v1/webhooks/${hook.id}`, { user: s.owner, credential: byKey(s.k.id) });

		expect(ended.status).toBe(401);
		expect(rows()).toEqual([]);
	});

	it('8. answerWebhook gives a secret to an API key alone (R5), and only inside a transaction; no route builds an answer itself', () => {
		const s = scene();
		const signed = makeWebhook(s.board, { secret: 'a', setBy: s.editor });
		const bare = makeWebhook(s.board, { setBy: s.editor });
		const session = { kind: 'session' as const, hash: sessionTokenHash(makeSession(s.owner)) };

		expect(() => answerWebhook(signed, true, byKey(s.k.id))).toThrow(/none is open/);
		inTransaction(() => {
			expect(() => answerWebhook(signed, true, session)).toThrow(/given only to an API key/);
			expect(() => answerWebhook(signed, true, null)).toThrow(/given only to an API key/);
			// The tests' own requests carry no credential at all, which the running server never lets through.
			expect(answerWebhook(signed, true, undefined).secret).toBe('a');
			// No secret in the answer: answered to anyone, recording nothing.
			expect(answerWebhook(bare, true, session)).not.toHaveProperty('secret', 'a');
			expect(answerWebhook(signed, false, session)).not.toHaveProperty('secret');
		});
		expect(rows()).toEqual([]);

		const routes = join(process.cwd(), 'src', 'routes');
		const files = (readdirSync(routes, { recursive: true }) as string[]).map((file) => join(routes, file)).filter((file) => /\.(ts|svelte)$/.test(file) && statSync(file).isFile());
		expect(files.filter((file) => readFileSync(file, 'utf8').includes('presentWebhook'))).toEqual([]);
	});

	it('8b. every answerWebhook(s) call under src/routes passes the request’s own credential, locals.credential (FP13)', () => {
		const routes = join(process.cwd(), 'src', 'routes');
		const files = (readdirSync(routes, { recursive: true }) as string[]).map((file) => join(routes, file)).filter((file) => /\.ts$/.test(file) && statSync(file).isFile());
		const calls: { file: string; credential: string }[] = [];
		for (const file of files) {
			const source = readFileSync(file, 'utf8');
			if (!/\banswerWebhooks?\b/.test(source)) continue;
			const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
			const visit = (node: ts.Node): void => {
				if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && /^answerWebhooks?$/.test(node.expression.text)) {
					calls.push({ file, credential: node.arguments[2]?.getText(tree) ?? '(none)' });
				}
				ts.forEachChild(node, visit);
			};
			visit(tree);
		}
		// The two GETs, the PUT and the POST.
		expect(calls).toHaveLength(4);
		expect(calls.filter((call) => call.credential !== 'locals.credential')).toEqual([]);
	});
});

describe('an ending holds what the account’s keys were given (card 2947, R10)', () => {
	const CAUSE = { log: 'a password reset in a test', mail: ENDING_IN_MAIL.passwordReset };

	it('15. an ordinary account’s key given a webhook it cannot read now: the ending holds it, its rows go; another key’s stay', () => {
		const s = scene();
		const editorKey = makeApiKeyRow(s.editor);
		const given = makeWebhook(s.board, { secret: 'a', setBy: s.owner });
		const other = makeWebhook(s.board, { secret: 'b', setBy: s.owner });
		reveal(given.id, editorKey.id);
		reveal(other.id, s.k.id);

		const ended = inTransaction(() => endAccountAccess(s.editor.id, { apiKeys: true, cause: CAUSE }));

		expect([holdOf(given.id), holdOf(other.id)]).toEqual([HELD, ON]);
		expect(ended.readableWebhooks).toBe(1);
		expect(rows()).toEqual([[other.id, s.k.id]]);
	});

	it('15b. an owner’s ending: what its key was given and what it could read, each once', () => {
		const s = scene();
		const given = makeWebhook(s.board, { secret: 'a', setBy: s.editor });
		const readable = makeWebhook(s.board, { secret: 'b', setBy: s.editor });
		reveal(given.id, s.k.id);

		const ended = inTransaction(() => endAccountAccess(s.owner.id, { apiKeys: true, cause: CAUSE }));

		expect([holdOf(given.id), holdOf(readable.id)]).toEqual([HELD, HELD]);
		expect(ended.readableWebhooks).toBe(2);
	});

	it('15c. a two-step reset holds it the same way; an ending that keeps the keys holds nothing and keeps the rows', () => {
		const s = scene();
		const editorKey = makeApiKeyRow(s.editor);
		const given = makeWebhook(s.board, { secret: 'a', setBy: s.owner });
		reveal(given.id, editorKey.id);

		inTransaction(() => endAccountAccess(s.editor.id, { apiKeys: false, cause: CAUSE }));
		expect(holdOf(given.id)).toEqual(ON);
		expect(rows()).toEqual([[given.id, editorKey.id]]);

		inTransaction(() => resetTwoStep(s.editor.id, 'host-reset', { cause: CAUSE }));
		expect(holdOf(given.id)).toEqual(HELD);
		expect(rows()).toEqual([]);
	});

	it('15d. a delete of a disabled account that still holds a key holds what that key was given', () => {
		const s = scene();
		const chief = makeUser({ role: 'superadmin' });
		inTransaction(() => disableAccount(db.select().from(users).where(eq(users.id, s.editor.id)).get()!, chief));
		// A key left by a host edit, as card 2935's P6 has it.
		const left = makeApiKeyRow(s.editor);
		const given = makeWebhook(s.board, { secret: 'a', setBy: s.owner });
		reveal(given.id, left.id);

		deleteUser(s.editor.id, chief);

		expect(holdOf(given.id)).toEqual(HELD);
		expect(rows()).toEqual([]);
	});

	it('15e. an ending’s mail says the secret of every webhook its keys were given is exposed, a reveal-only one included (FP4)', async () => {
		makeSmtp();
		const s = scene();
		const editorKey = makeApiKeyRow(s.editor);
		const given = makeWebhook(s.board, { secret: 'a', setBy: s.owner });
		reveal(given.id, editorKey.id);
		sent.clear();

		inTransaction(() => endAccountAccess(s.editor.id, { apiKeys: true, cause: CAUSE }));
		await sent.settle();

		expect(holdOf(given.id)).toEqual(HELD);
		expect(sent.emails.map((mail) => mail.to)).toEqual([s.owner.email]);
		expect(sent.emails[0].html).toContain(EXPOSED_SECRET_SENTENCE);
	});
});

describe('the Account page’s key list says what a revoke or an end would hold (card 2947, R15)', () => {
	it('22. webhooksRevealed: what the key was given that has a secret and is not held, less what it set that is on; and the revoke holds that many', async () => {
		const s = scene();
		const other = makeApiKeyRow(s.owner);
		const given = makeWebhook(s.board, { secret: 'a', setBy: s.editor });
		const givenOff = makeWebhook(s.board, { secret: 'b', setBy: s.editor, active: false });
		const givenHeld = makeWebhook(s.board, { secret: 'c', setBy: s.editor, heldBecause: 'key ended' });
		const givenBare = makeWebhook(s.board, { setBy: s.editor });
		const ownOn = makeWebhook(s.board, { secret: 'd', setBy: s.owner, setWithKey: true, setByKey: s.k.id });
		for (const hook of [given, givenOff, givenHeld, givenBare, ownOn]) reveal(hook.id, s.k.id);
		reveal(given.id, other.id);

		const listed = await api('GET', '/api/account/api-keys', { user: s.owner });

		const counts = Object.fromEntries(listed.body.map((key: { id: number; webhooks: number; webhooksRevealed: number }) => [key.id, [key.webhooks, key.webhooksRevealed]]));
		expect(counts).toEqual({ [s.k.id]: [1, 2], [other.id]: [0, 1] });
		expect((await revoke(s.owner, s.k.id)).body).toEqual({ success: true, webhooksSwitchedOff: 1, revealedWebhooksHeld: 2 });
	});

	it('22b. a webhook set before keys were recorded by the account’s last old key K0, and seeded as given to K0, is counted once, as the revoke switches it off (FP8)', async () => {
		const s = scene();
		sqlite.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('webhook_keys_recorded_at', '2026-06-01 00:00:00')").run();
		const k0 = makeApiKeyRow(s.editor);
		sqlite.prepare("UPDATE api_keys SET created_at = '2026-01-01 00:00:00' WHERE id = ?").run(k0.id);
		const legacy = makeWebhook(s.board, { secret: 'old', setBy: s.editor, setWithKey: null });
		// As the seed writes it for a key used before reads were recorded.
		reveal(legacy.id, k0.id, null);

		const listed = await api('GET', '/api/account/api-keys', { user: s.editor });

		const counts = Object.fromEntries(listed.body.map((key: { id: number; webhooks: number; webhooksRevealed: number }) => [key.id, [key.webhooks, key.webhooksRevealed]]));
		expect(counts).toEqual({ [k0.id]: [1, 0] });
		expect((await revoke(s.editor, k0.id)).body).toEqual({ success: true, webhooksSwitchedOff: 1, revealedWebhooksHeld: 0 });
		expect(holdOf(legacy.id)).toEqual({ active: 0, heldBecause: 'key ended' });
	});
});

describe('the once-only seed is never left to the sweep (card 2947’s code review, FP2)', () => {
	it('S1. a revoke on a database no sweep has seeded seeds first, and holds what the key may have read before', async () => {
		const s = scene();
		const hook = makeWebhook(s.board, { secret: 'a', setBy: s.editor });
		sqlite.prepare("UPDATE webhooks SET created_at = '2026-10-01 09:00:00' WHERE id = ?").run(hook.id);
		sqlite.prepare("UPDATE api_keys SET last_used_at = '2026-11-01 09:00:00' WHERE id = ?").run(s.k.id);

		const res = await revoke(s.owner, s.k.id);

		expect(res.body).toEqual({ success: true, webhooksSwitchedOff: 0, revealedWebhooksHeld: 1 });
		expect(holdOf(hook.id)).toEqual(HELD);
		expect(sqlite.prepare('SELECT COUNT(*) AS n FROM settings WHERE key = ?').get(WEBHOOK_REVEALS_SEEDED)).toEqual({ n: 1 });
		expect(warnLines()[0]).toContain(`an API key that may have been given its secret before such reads were recorded (key ${s.k.id}, user ${s.owner.id}) ended`);
	});

	it('S2. an ending on an unseeded database seeds first, writing the flag, and tells what the used key may have read, its own webhook included, as exposed (FP4)', async () => {
		makeSmtp();
		const s = scene();
		const editorKey = makeApiKeyRow(s.editor);
		// The editor set it, so its key counts as given it; its account reads nothing else.
		const hook = makeWebhook(s.board, { secret: 'a', setBy: s.editor });
		sqlite.prepare("UPDATE webhooks SET created_at = '2026-10-01 09:00:00' WHERE id = ?").run(hook.id);
		sqlite.prepare("UPDATE api_keys SET last_used_at = '2026-11-01 09:00:00' WHERE id = ?").run(editorKey.id);
		sent.clear();

		inTransaction(() => endAccountAccess(s.editor.id, { apiKeys: true, cause: { log: 'a reset in a test', mail: ENDING_IN_MAIL.passwordReset } }));
		await sent.settle();

		expect(holdOf(hook.id)).toEqual(HELD);
		expect(sqlite.prepare('SELECT COUNT(*) AS n FROM settings WHERE key = ?').get(WEBHOOK_REVEALS_SEEDED)).toEqual({ n: 1 });
		expect(sent.emails.map((mail) => mail.to)).toEqual([s.owner.email]);
		expect(sent.emails[0].html).toContain(EXPOSED_SECRET_SENTENCE);
	});
});

describe('the restore tells what it held for a lost key with its sweep (card 2947, R1)', () => {
	it('R1e: one WARN naming the key, the boards’ owners mailed once, the old secret said to be exposed', async () => {
		makeSmtp();
		startedSinceAlreadyOffHeld();
		makeUser({ username: 'chief', role: 'superadmin' });
		const s = scene();
		const hook = makeWebhook(s.board, { secret: 'whsec-r1e', setBy: s.editor });
		sealPlainSecrets(sqlite);
		const backup = new Database(generateBackupData());
		const later = makeApiKeyRow(s.owner);
		reveal(hook.id, later.id);
		sent.clear();
		// As a built server's restore: the schedulers run, so the owners are mailed.
		const schedulers = process.env.SCHEDULERS;
		process.env.SCHEDULERS = 'on';
		try {
			const result = restoreFromBackup(sqlite, backup, { by: 'chief' });
			expect(result.errors).toEqual([]);
		} finally {
			backup.close();
			if (schedulers === undefined) delete process.env.SCHEDULERS;
			else process.env.SCHEDULERS = schedulers;
		}
		await sent.settle();

		expect(holdOf(hook.id)).toEqual(HELD);
		// The log names who restored; the owners' mail nobody (its code review, FP5).
		expect(warnLines()).toContain(
			`Webhook ${hook.id} on board ${s.board.id} switched off: an API key that was given its secret (key ${later.id}, user ${s.owner.id}) ended (found after a restore by chief). ` +
				'It stays off until an owner of the board or an administrator switches it on.'
		);
		expect(sent.emails.filter((mail) => mail.html.includes(EXPOSED_SECRET_SENTENCE)).map((mail) => mail.to)).toEqual([s.owner.email]);
		for (const mail of sent.emails) {
			expect(mail.html).toContain('What caused it: found after a restore.');
			expect(mail.html).not.toContain('chief');
		}
	});
});

describe('the once-only seed of reads made before they were recorded (card 2947, R7)', () => {
	const at = (id: number, column: 'last_used_at', value: string | null) => sqlite.prepare(`UPDATE api_keys SET ${column} = ? WHERE id = ?`).run(value, id);
	const madeAt = (id: number, value: string) => sqlite.prepare('UPDATE webhooks SET created_at = ? WHERE id = ?').run(value, id);
	const seededRows = () =>
		(sqlite.prepare('SELECT webhook_id AS w, key_id AS k, revealed_at AS at FROM webhook_reveals ORDER BY webhook_id, key_id').all() as { w: number; k: number; at: string | null }[]).map(
			(row) => [row.w, row.k, row.at]
		);

	it('17. a used key counts as given what its account can read or set, made before its last use; an unused key, a later webhook, one with no secret and another board count for nothing; once', () => {
		const s = scene();
		const unused = makeApiKeyRow(s.owner);
		const editorKey = makeApiKeyRow(s.editor);
		const admin = makeUser({ role: 'admin' });
		const adminKey = makeApiKeyRow(admin);
		const elsewhere = makeBoard({ owner: makeUser() }).board;
		const early = makeWebhook(s.board, { secret: 'a', setBy: s.editor });
		const late = makeWebhook(s.board, { secret: 'b', setBy: s.editor });
		const bare = makeWebhook(s.board, { setBy: s.editor });
		const ownersOther = makeWebhook(s.board, { secret: 'c', setBy: s.owner });
		const theirs = makeWebhook(elsewhere, { secret: 'd' });
		for (const id of [early.id, bare.id, ownersOther.id, theirs.id]) madeAt(id, '2026-10-01 09:00:00');
		madeAt(late.id, '2026-11-15 09:00:00');
		at(s.k.id, 'last_used_at', '2026-11-01 09:00:00');
		at(editorKey.id, 'last_used_at', '2026-11-18 09:00:00');
		at(adminKey.id, 'last_used_at', '2026-11-01 09:00:00');

		const done = inTransaction(() => holdRevealsOfEndedKeys());

		expect(done.seeded).toBe(7);
		// The owner's key: its board's two with a secret made before its last use, not the later one nor another
		// board's. The editor's: the two it set with a secret, the later one too, made before its own last use. The
		// administrator's: every one with a secret made before its last use, on any board. The unused key: none.
		expect(seededRows()).toEqual([
			[early.id, s.k.id, null],
			[early.id, editorKey.id, null],
			[early.id, adminKey.id, null],
			[late.id, editorKey.id, null],
			[ownersOther.id, s.k.id, null],
			[ownersOther.id, adminKey.id, null],
			[theirs.id, adminKey.id, null]
		]);
		expect(seededRows().some((row) => row[1] === unused.id || row[0] === bare.id)).toBe(false);
		expect(sqlite.prepare('SELECT COUNT(*) AS n FROM settings WHERE key = ?').get(WEBHOOK_REVEALS_SEEDED)).toEqual({ n: 1 });
		expect(inTransaction(() => holdRevealsOfEndedKeys()).seeded).toBeNull();
	});

	it('17b. a used key already past its deadline: what it may have read is held at the first sweep, in the seed’s words', () => {
		const s = scene();
		const hook = makeWebhook(s.board, { secret: 'a', setBy: s.editor });
		madeAt(hook.id, '2026-10-01 09:00:00');
		at(s.k.id, 'last_used_at', '2026-11-01 09:00:00');
		sqlite.prepare("UPDATE api_keys SET deadline_at = '2026-11-02 09:00:00' WHERE id = ?").run(s.k.id);

		expect(sweepEndedKeyReveals('off', false)).toBe(1);

		expect(holdOf(hook.id)).toEqual(HELD);
		expect(rows()).toEqual([]);
		expect(warnLines()[0]).toContain(
			`an API key that may have been given its secret before such reads were recorded (key ${s.k.id}, user ${s.owner.id}) ended (API key #${s.k.id} of user ${s.owner.id} passed its deadline)`
		);
	});

	it('17c. a seed that fails rolls back with the hold: no row, no flag, and the next sweep seeds', () => {
		const s = scene();
		const hook = makeWebhook(s.board, { secret: 'a', setBy: s.editor });
		madeAt(hook.id, '2026-10-01 09:00:00');
		at(s.k.id, 'last_used_at', '2026-11-01 09:00:00');
		sqlite.exec(`CREATE TRIGGER refuse_flag BEFORE INSERT ON settings WHEN NEW.key = '${WEBHOOK_REVEALS_SEEDED}' BEGIN SELECT RAISE(ABORT, 'refused in a test'); END;`);
		try {
			expect(sweepEndedKeyReveals('off', false)).toBeNull();
		} finally {
			sqlite.exec('DROP TRIGGER refuse_flag');
		}
		expect(rows()).toEqual([]);
		expect(sqlite.prepare('SELECT COUNT(*) AS n FROM settings WHERE key = ?').get(WEBHOOK_REVEALS_SEEDED)).toEqual({ n: 0 });

		expect(sweepEndedKeyReveals('off', false)).toBe(0);
		expect(rows()).toEqual([[hook.id, s.k.id]]);
	});

	it('17d. a hold that fails with seed rows pending rolls the seed back too: no flag and no seeded row (FP7)', () => {
		const s = scene();
		const hook = makeWebhook(s.board, { secret: 'a', setBy: s.editor });
		madeAt(hook.id, '2026-10-01 09:00:00');
		at(s.k.id, 'last_used_at', '2026-11-01 09:00:00');
		sqlite.prepare("UPDATE api_keys SET expires_at = '2026-11-02 09:00:00' WHERE id = ?").run(s.k.id);
		sqlite.exec("CREATE TRIGGER refuse_seeded_hold BEFORE UPDATE ON webhooks BEGIN SELECT RAISE(ABORT, 'refused in a test'); END;");
		try {
			expect(sweepEndedKeyReveals('off', false)).toBeNull();
		} finally {
			sqlite.exec('DROP TRIGGER refuse_seeded_hold');
		}
		expect(rows()).toEqual([]);
		expect(sqlite.prepare('SELECT COUNT(*) AS n FROM settings WHERE key = ?').get(WEBHOOK_REVEALS_SEEDED)).toEqual({ n: 0 });
		expect(holdOf(hook.id)).toEqual(ON);
	});
});
