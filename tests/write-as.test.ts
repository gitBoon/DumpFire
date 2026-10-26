/**
 * Who the caller is, asked again at the write (card 2253, slice 1).
 *
 * The gate decides who is calling before the request's body is read, and a
 * body can take as long as the caller likes to arrive. A password reset, a
 * key deleted, a sign-out or a role lowered, committed meanwhile, was met by
 * nothing: the write went through as the caller the gate had read. Now a
 * handler writes through `writeAs(locals, (caller) => …)`, which asks in the
 * transaction that writes whether the key or session is still open and who
 * its account is now, and hands that account to the write; and what cannot
 * run in a transaction asks `stillCallerNow(locals)` last before it. Both are
 * in `src/lib/server/write-as.ts`, and both ask `stillAuthenticated` in
 * `src/lib/server/auth.ts`. The plan is
 * `docs/planning/cards-2250-2251-2253-security.md`.
 *
 * Here:
 *
 *   - what `stillAuthenticated` reads and answers (decisions 2 and 3);
 *   - `writeAs` and `stillCallerNow` themselves;
 *   - the four handlers that asked before this card (the report schedules and
 *     the webhooks) deciding with the account as it is now, and refusing an
 *     ended session on the delete that did not ask at all;
 *   - the cards and what is on them (slice 2253-2): one request of each shape
 *     moved, its body held through the gate while the session ends; the
 *     deletes, the restore and the upload with an ended session; and a role
 *     lowered meanwhile (every route of the slice is walked in slice 2253-8);
 *   - the boards, groupings, teams, goals and templates (slice 2253-3), the
 *     same way: one request of each shape held through the gate, the
 *     requests with no body with an ended session, and an administrator
 *     lowered meanwhile met by the guards that ask the role;
 *   - the accounts, users, requests and reports (slice 2253-4), the same
 *     way, and: the password change, which ends the session it came by;
 *     a write handed an API key revoked meanwhile; the public request
 *     routes, for a caller with no session (null) and one whose session
 *     ended (401); and an administrator lowered to a user, and the
 *     superadmin to an administrator, met by the account guards;
 *   - the superadmin's and administrators' routes (slice 2253-5), the same
 *     way, and: what leaves the process (a backup, a destination tested, a
 *     code sent to Google, a test mail) not sent; the Google Drive Connect
 *     refused at its write after Google has answered, its folder removed; and
 *     the import's one check, after the upload and before anything is
 *     written, with nothing asked after the restore;
 *   - the boards side of /api/v1 (slice 2253-6): every request with a body
 *     held through the gate while its API key is revoked, and handed an
 *     ended session; the deletes with an ended key or session; and an
 *     administrator lowered meanwhile met by the board guards; no webhook
 *     fired for a card refused;
 *   - the cards side of /api/v1 (slice 2253-7), the same way: every request
 *     with a body held through the gate while its API key is revoked, the
 *     batches refused whole; the deletes with an ended key or session; and
 *     an administrator lowered meanwhile met by the card, milestone and
 *     token guards; no webhook fired for a move, a change or a comment
 *     refused;
 *   - no credential at all (R10): refused outside the tests, and never
 *     handed on by the gate;
 *   - the report mail's second check, after its PDF is made (R1).
 *
 * The rule that every write handler goes through them is read from the source
 * in `tests/check-at-the-write.test.ts`. The window itself, a body held while
 * a reset ends the key or session, is walked through the gate in
 * `tests/atomic-accounts.test.ts` ("a create or a change whose body arrives
 * after the reset").
 */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isHttpError, json, type RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { google } from 'googleapis';
import { DRIVE_FILE_SCOPE } from '$lib/drive-scope';
import { db, sqlite } from '$lib/server/db';
import {
	apiKeys,
	boardCategories,
	boardMembers,
	boards,
	cardComments,
	cardLabels,
	cardTemplates,
	categories,
	reportSchedules,
	sessions,
	settings,
	taskRequests,
	teamMembers,
	tokenUsage,
	users,
	userXp,
	webhooks
} from '$lib/server/db/schema';
import { SUPERADMIN_ONLY } from '$lib/server/route-guards';
import { SECRET_MASK } from '$lib/server/backup-secrets';
import { hashSync } from 'bcryptjs';
import { stillAuthenticated, SESSION_COOKIE_NAME, type SessionUser } from '$lib/server/auth';
import { inTransaction } from '$lib/server/db/transaction';
import { resetAllRateLimits } from '$lib/server/rate-limit';
import { issueFormToken, newRequestToken } from '$lib/server/request-tokens';
import { cardDir } from '$lib/server/uploads';
import { inWrite, stillCallerNow, writeAs } from '$lib/server/write-as';
import { stamp } from '$lib/timestamps';
import { handle } from '../src/hooks.server';
import { api } from './helpers/api';
import { effects } from './helpers/effects';
import {
	assignCard,
	makeApiKey,
	makeAttachment,
	makeBoard,
	makeCard,
	makeComment,
	makeDependency,
	makeLabel,
	makeMilestone,
	makeSession,
	makeSmtp,
	makeSubtask,
	makeTeam,
	makeUser,
	makeWebhook,
	resetDb
} from './helpers/fixtures';
import { sendAround } from './helpers/held-body';
import { expectUnchanged, snapshotDb, type DbSnapshot } from './helpers/snapshot';

/**
 * What SvelteKit's `getRequestEvent` answers: the request a test names, or,
 * as for a handler called with no request around it (`api()`), its refusal.
 * `stillAuthenticated` asks it only to name the request in R10's log line.
 */
const sveltekit = vi.hoisted(() => ({
	event: null as null | { request: { method: string }; url: URL; route: { id: string | null } }
}));
vi.mock('$app/server', async (importOriginal) => ({
	...(await importOriginal<object>()),
	getRequestEvent: () => {
		if (!sveltekit.event) throw new Error('Can only read the current request event inside functions invoked during `handle`');
		return sveltekit.event;
	}
}));

/** Something to do once a report's PDF is made and before it is mailed: what a reset committed then would do. */
const pdf = vi.hoisted(() => ({ afterMade: null as null | (() => void) }));
vi.mock('$lib/server/reports', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/reports')>();
	return {
		...real,
		generateReportPdf: async (...args: Parameters<typeof real.generateReportPdf>) => {
			const made = await real.generateReportPdf(...args);
			pdf.afterMade?.();
			return made;
		}
	};
});

/**
 * A backup destination that keeps what it is given and reaches nowhere: the
 * names of the destinations made, each with its secret, and what was uploaded.
 */
const backupStandIn = vi.hoisted(() => ({ made: [] as string[], uploaded: [] as string[] }));
vi.mock('$lib/server/backup-destinations', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/backup-destinations')>();
	return {
		...real,
		createDestination: (config: { type: string; name: string }) => {
			backupStandIn.made.push(config.name);
			return {
				type: config.type,
				name: config.name,
				test: async () => ({ success: true, message: 'ok' }),
				upload: async (_data: Buffer, filename: string) => void backupStandIn.uploaded.push(`${config.name}/${filename}`),
				list: async () => [],
				delete: async () => {}
			};
		}
	};
});

beforeEach(() => {
	resetDb();
	sveltekit.event = null;
	pdf.afterMade = null;
	backupStandIn.made.length = 0;
	backupStandIn.uploaded.length = 0;
});

afterEach(() => {
	vi.unstubAllEnvs();
});

/** `fn`'s refusal, as the status and the message, or what it answered. */
function outcome<T>(fn: () => T): { status: number; message: string } | { answered: T } {
	try {
		return { answered: fn() };
	} catch (thrown) {
		if (isHttpError(thrown)) return { status: thrown.status, message: thrown.body.message };
		throw thrown;
	}
}

/** The locals a gate would hand on, for a session's token or an API key's row. */
const sessionLocals = (user: SessionUser, token: string): App.Locals => ({ user, credential: { kind: 'session', token } });
const keyRow = (key: string) => db.select().from(apiKeys).all().find((row) => key.startsWith(row.keyPrefix))!;
const keyLocals = (user: SessionUser, key: string): App.Locals => ({ user, credential: { kind: 'api key', id: keyRow(key).id } });

/** The ERROR lines under AUTH. */
const authErrors = () =>
	(sqlite.prepare("SELECT message FROM system_logs WHERE context = 'AUTH' AND level = 'ERROR' ORDER BY id").all() as { message: string }[]).map(
		(row) => row.message
	);

/** Gone from under the row that names it, as a deleted account leaves a session or key only with the foreign keys off. */
function deleteAccountLeavingItsRows(id: number) {
	sqlite.pragma('foreign_keys = OFF');
	try {
		db.delete(users).where(eq(users.id, id)).run();
	} finally {
		sqlite.pragma('foreign_keys = ON');
	}
}

// ─── stillAuthenticated (decisions 2 and 3) ─────────────────────────────────

describe('stillAuthenticated', () => {
	it('answers the account as it is now, read through the session, and sets locals.user to it', () => {
		const user = makeUser({ username: 'ada', role: 'admin' });
		const locals = sessionLocals(user, makeSession(user));
		db.update(users).set({ role: 'user', username: 'ada-now', emoji: '🦊' }).where(eq(users.id, user.id)).run();

		const now = inTransaction(() => stillAuthenticated(locals));

		expect(now).toEqual({ id: user.id, username: 'ada-now', email: user.email, emoji: '🦊', role: 'user' });
		expect(locals.user).toEqual(now);
	});

	it('answers the account as it is now, read through the API key, and sets locals.user to it', () => {
		const user = makeUser({ username: 'kim', role: 'admin' });
		const locals = keyLocals(user, makeApiKey(user));
		db.update(users).set({ role: 'user' }).where(eq(users.id, user.id)).run();

		const now = inTransaction(() => stillAuthenticated(locals));

		expect(now).toMatchObject({ id: user.id, username: 'kim', role: 'user' });
		expect(locals.user).toEqual(now);
	});

	it('answers locals.user unchanged when no gate ran (credential undefined), under the tests', () => {
		const user = makeUser();
		const locals: App.Locals = { user };

		expect(inTransaction(() => stillAuthenticated(locals))).toBe(user);
		expect(locals.user).toBe(user);
	});

	it('answers null when the gate let the request in with no key or session (credential null)', () => {
		const locals: App.Locals = { user: null, credential: null };

		expect(inTransaction(() => stillAuthenticated(locals))).toBeNull();
	});

	it("refuses 401, in the gate's words, a key deleted, expired, or whose account is gone", () => {
		const user = makeUser();
		const KEY = { status: 401, message: 'Invalid or expired API key' };

		const deleted = keyLocals(user, makeApiKey(user));
		db.delete(apiKeys).run();
		expect(outcome(() => inTransaction(() => stillAuthenticated(deleted)))).toEqual(KEY);

		const key = makeApiKey(user);
		const expired = keyLocals(user, key);
		db.update(apiKeys).set({ expiresAt: stamp(new Date(Date.now() - 60_000)) }).where(eq(apiKeys.id, keyRow(key).id)).run();
		expect(outcome(() => inTransaction(() => stillAuthenticated(expired)))).toEqual(KEY);

		const other = makeUser();
		const orphaned = keyLocals(other, makeApiKey(other));
		deleteAccountLeavingItsRows(other.id);
		expect(outcome(() => inTransaction(() => stillAuthenticated(orphaned)))).toEqual(KEY);
	});

	it("refuses 401, in the gate's words, a session deleted, expired, or whose account is gone", () => {
		const user = makeUser();
		const NOT = { status: 401, message: 'Not authenticated' };

		const token = makeSession(user);
		const deleted = sessionLocals(user, token);
		db.delete(sessions).where(eq(sessions.id, token)).run();
		expect(outcome(() => inTransaction(() => stillAuthenticated(deleted)))).toEqual(NOT);

		const old = makeSession(user);
		db.update(sessions).set({ expiresAt: stamp(new Date(Date.now() - 60_000)) }).where(eq(sessions.id, old)).run();
		expect(outcome(() => inTransaction(() => stillAuthenticated(sessionLocals(user, old))))).toEqual(NOT);

		const other = makeUser();
		const orphaned = sessionLocals(other, makeSession(other));
		deleteAccountLeavingItsRows(other.id);
		expect(outcome(() => inTransaction(() => stillAuthenticated(orphaned)))).toEqual(NOT);
	});

	it('leaves locals.user as the gate set it when it refuses', () => {
		const user = makeUser();
		const token = makeSession(user);
		const locals = sessionLocals(user, token);
		db.delete(sessions).run();

		expect(outcome(() => inTransaction(() => stillAuthenticated(locals)))).toMatchObject({ status: 401 });
		expect(locals.user).toBe(user);
	});

	it('throws outside a transaction, before it reads anything', () => {
		const user = makeUser();

		expect(() => stillAuthenticated(sessionLocals(user, makeSession(user)))).toThrow(
			'stillAuthenticated must be called inside the transaction that writes'
		);
	});
});

// ─── writeAs and stillCallerNow ─────────────────────────────────────────────

describe('writeAs', () => {
	it('hands the write the account as it is now, inside one transaction, and answers what the write answers', () => {
		const user = makeUser({ role: 'admin' });
		const locals = sessionLocals(user, makeSession(user));
		db.update(users).set({ role: 'user' }).where(eq(users.id, user.id)).run();

		const seen: { role: string | undefined; inTransaction: boolean }[] = [];
		const answered = writeAs(locals, (caller) => {
			seen.push({ role: caller?.role, inTransaction: sqlite.inTransaction });
			return 'written';
		});

		expect(answered).toBe('written');
		expect(seen).toEqual([{ role: 'user', inTransaction: true }]);
		expect(sqlite.inTransaction).toBe(false);
	});

	it('runs nothing of the write when the session has ended, and refuses 401', () => {
		const user = makeUser();
		const token = makeSession(user);
		const locals = sessionLocals(user, token);
		db.delete(sessions).where(eq(sessions.id, token)).run();

		const write = vi.fn(() => 'written');
		expect(outcome(() => writeAs(locals, write))).toEqual({ status: 401, message: 'Not authenticated' });
		expect(write).not.toHaveBeenCalled();
	});

	it('rolls back what the write wrote when it refuses after writing', () => {
		const user = makeUser();
		const locals = sessionLocals(user, makeSession(user));
		const before = snapshotDb();

		expect(() =>
			writeAs(locals, (caller) => {
				db.insert(reportSchedules).values({ userId: caller!.id, name: 'Rolled back', scope: 'all', frequency: 'weekly' }).run();
				throw new Error('refused after the write');
			})
		).toThrow('refused after the write');
		expectUnchanged(before);
	});

	it('refuses a write that is async, as inTransaction does', () => {
		const user = makeUser();
		const locals = sessionLocals(user, makeSession(user));

		// @ts-expect-error A transaction cannot await: the type refuses an async write.
		expect(() => writeAs(locals, async () => 'later')).toThrow('inTransaction was given a function that returns a promise');
	});

	it('is a savepoint inside another transaction, so the check commits or rolls back with what is around it', () => {
		const user = makeUser();
		const locals = sessionLocals(user, makeSession(user));

		const caller = inTransaction(() => writeAs(locals, (now) => now));

		expect(caller).toMatchObject({ id: user.id });
	});
});

describe('stillCallerNow', () => {
	it('answers the account as it is now, sets locals.user, and leaves no transaction open', () => {
		const user = makeUser({ role: 'superadmin' });
		const locals = keyLocals(user, makeApiKey(user));
		db.update(users).set({ role: 'admin' }).where(eq(users.id, user.id)).run();

		const now = stillCallerNow(locals);

		expect(now).toMatchObject({ id: user.id, role: 'admin' });
		expect(locals.user).toEqual(now);
		expect(sqlite.inTransaction).toBe(false);
	});

	it('refuses 401 a key deleted meanwhile', () => {
		const user = makeUser();
		const locals = keyLocals(user, makeApiKey(user));
		db.delete(apiKeys).run();

		expect(outcome(() => stillCallerNow(locals))).toEqual({ status: 401, message: 'Invalid or expired API key' });
	});
});

// ─── inWrite: a service writes only inside writeAs (card 2012, R4) ──────────

describe('inWrite', () => {
	const OUTSIDE = 'A service write was called outside a writeAs callback, and wrote nothing';

	it('refuses outside any transaction, and inside a bare inTransaction that writeAs did not open', () => {
		expect(() => inWrite()).toThrow(OUTSIDE);
		// A job's or a scheduler's transaction: no request, so no caller to hand a service.
		expect(() => inTransaction(() => inWrite())).toThrow(OUTSIDE);
		expect(sqlite.inTransaction).toBe(false);
	});

	it('passes inside writeAs, inside an inTransaction nested in it, and inside a writeAs nested in either', () => {
		const user = makeUser();
		const locals = sessionLocals(user, makeSession(user));

		const passed = writeAs(locals, () => {
			inWrite();
			inTransaction(() => inWrite());
			writeAs(locals, () => inWrite());
			inTransaction(() => writeAs(locals, () => inWrite()));
			inWrite();
			return 'passed';
		});

		expect(passed).toBe('passed');
	});

	it('is taken off when writeAs returns and when it throws, a nested one included, and is not set when the caller is refused', () => {
		const user = makeUser();
		const token = makeSession(user);
		const locals = sessionLocals(user, token);

		writeAs(locals, () => writeAs(locals, () => 'returned'));
		expect(() => inWrite()).toThrow(OUTSIDE);

		expect(() =>
			writeAs(locals, () => {
				writeAs(locals, () => {
					throw new Error('thrown inside');
				});
			})
		).toThrow('thrown inside');
		expect(() => inWrite()).toThrow(OUTSIDE);
		expect(() => inTransaction(() => inWrite())).toThrow(OUTSIDE);

		// Refused before the callback: the write is never run, and nothing is left set.
		db.delete(sessions).where(eq(sessions.id, token)).run();
		expect(outcome(() => writeAs(locals, () => inWrite()))).toEqual({ status: 401, message: 'Not authenticated' });
		expect(() => inTransaction(() => inWrite())).toThrow(OUTSIDE);
	});

	it('a session ended while the body arrived, naming in its body an id that is not there, is answered 401, not 404 (S2)', async () => {
		const owner = makeUser({ username: 'owner' });
		makeBoard({ owner, name: 'Owned' });
		const token = makeSession(owner);
		db.delete(sessions).where(eq(sessions.id, token)).run();
		const before = snapshotDb();

		// No column 999: a 404 would say so to a caller who is no longer signed in.
		const res = await api('POST', '/api/cards', {
			user: owner,
			credential: { kind: 'session', token },
			body: { columnId: 999, title: 'Too late' }
		});

		expect(res.status).toBe(401);
		expect(res.body).toEqual({ message: 'Not authenticated' });
		expectUnchanged(before);
		// And the same request with the session open is the 404.
		const open = await api('POST', '/api/cards', {
			user: owner,
			credential: { kind: 'session', token: makeSession(owner) },
			body: { columnId: 999, title: 'In time' }
		});
		expect(open.status).toBe(404);
		expect(open.body).toEqual({ message: 'Column not found' });
	});
});

// ─── The four handlers that asked before this card ──────────────────────────

describe('the report schedules and the webhooks decide with the account as it is now', () => {
	/**
	 * `api()` hands the handler the caller the test gives it, as the gate read
	 * it, with the session it came by. The account is changed after that and
	 * before the handler runs: what a role change committed while the body
	 * arrived does. Before this card each of them decided on the role the gate
	 * had read, and wrote.
	 */
	const lowered = (role: 'admin' | 'superadmin', to: string) => {
		const user = makeUser({ username: `was-${role}`, role });
		const token = makeSession(user);
		db.update(users).set({ role: to }).where(eq(users.id, user.id)).run();
		return { user, credential: { kind: 'session' as const, token } };
	};

	it('POST /api/report-schedules: an all-boards schedule by an administrator lowered to user is refused 403, and nothing written', async () => {
		const { user, credential } = lowered('admin', 'user');
		const before = snapshotDb();

		const res = await api('POST', '/api/report-schedules', {
			user,
			credential,
			body: { name: 'Everything', scope: 'all', frequency: 'weekly' }
		});

		expect(res.status).toBe(403);
		expect(res.body).toEqual({ message: 'Only admins can schedule all-boards reports' });
		expectUnchanged(before);
	});

	it('POST /api/v1/boards/:boardId/webhooks and PUT and DELETE /api/v1/webhooks/:webhookId: an administrator lowered to user is refused 403, and nothing written', async () => {
		const owner = makeUser({ username: 'owner' });
		const { board } = makeBoard({ owner, name: 'Owned' });
		const hook = makeWebhook(board);
		const { user, credential } = lowered('admin', 'user');
		const before = snapshotDb();
		const NO_EDIT = { message: 'No edit access to this board' };

		const made = await api('POST', `/api/v1/boards/${board.id}/webhooks`, { user, credential, body: { url: 'https://hooks.example.test/new' } });
		expect(made.status).toBe(403);
		expect(made.body).toEqual(NO_EDIT);

		const changed = await api('PUT', `/api/v1/webhooks/${hook.id}`, { user, credential, body: { active: false } });
		expect(changed.status).toBe(403);
		expect(changed.body).toEqual(NO_EDIT);

		const removed = await api('DELETE', `/api/v1/webhooks/${hook.id}`, { user, credential });
		expect(removed.status).toBe(403);
		expect(removed.body).toEqual(NO_EDIT);

		expectUnchanged(before);
	});

	it('DELETE /api/report-schedules/:id and DELETE /api/v1/webhooks/:webhookId refuse 401 a session or key that has ended, and delete nothing', async () => {
		const owner = makeUser({ username: 'owner' });
		const { board } = makeBoard({ owner, name: 'Owned' });
		const hook = makeWebhook(board);
		const scheduleId = db
			.insert(reportSchedules)
			.values({ userId: owner.id, name: 'Weekly', scope: 'board', scopeId: board.id, frequency: 'weekly' })
			.returning()
			.get().id;
		const token = makeSession(owner);
		const key = makeApiKey(owner);
		const keyCredential = { kind: 'api key' as const, id: keyRow(key).id };
		db.delete(sessions).run();
		db.delete(apiKeys).run();
		const before = snapshotDb();

		const schedule = await api('DELETE', `/api/report-schedules/${scheduleId}`, { user: owner, credential: { kind: 'session', token } });
		expect(schedule.status).toBe(401);
		expect(schedule.body).toEqual({ message: 'Not authenticated' });

		const webhook = await api('DELETE', `/api/v1/webhooks/${hook.id}`, { user: owner, credential: keyCredential });
		expect(webhook.status).toBe(401);
		expect(webhook.body).toEqual({ message: 'Invalid or expired API key' });

		expectUnchanged(before);
		expect(db.select().from(webhooks).all()).toHaveLength(1);
	});

	it('lets each through, by the account as it is now, when nothing has changed', async () => {
		const owner = makeUser({ username: 'owner' });
		const { board } = makeBoard({ owner, name: 'Owned' });
		const credential = { kind: 'session' as const, token: makeSession(owner) };

		const made = await api('POST', '/api/report-schedules', {
			user: owner,
			credential,
			body: { name: 'Weekly', scope: 'board', scopeId: board.id, frequency: 'weekly' }
		});
		expect(made.status).toBe(201);
		expect((await api('PUT', `/api/report-schedules/${made.body.id}`, { user: owner, credential, body: { enabled: false } })).status).toBe(200);
		expect((await api('DELETE', `/api/report-schedules/${made.body.id}`, { user: owner, credential })).status).toBe(200);

		const hook = await api('POST', `/api/v1/boards/${board.id}/webhooks`, { user: owner, credential, body: { url: 'https://hooks.example.test/new' } });
		expect(hook.status).toBe(201);
		expect((await api('PUT', `/api/v1/webhooks/${hook.body.id}`, { user: owner, credential, body: { active: false } })).status).toBe(200);
		expect((await api('DELETE', `/api/v1/webhooks/${hook.body.id}`, { user: owner, credential })).status).toBe(200);
	});
});

// ─── The cards and what is on them (slice 2253-2) ───────────────────────────

describe('the cards and what is on them ask at the write (slice 2253-2)', () => {
	/**
	 * A board its owner edits, with a card on it and one beside it, a subtask,
	 * a label, a comment and a category, and the owner signed in by a session.
	 */
	const scene = () => {
		const owner = makeUser({ username: 'owner' });
		const { board, cols } = makeBoard({ owner, name: 'Owned' });
		const card = makeCard(cols['To Do'], { position: 0 });
		const other = makeCard(cols['To Do'], { position: 1 });
		const subtask = makeSubtask(card);
		const label = makeLabel(board);
		const comment = makeComment(card, owner);
		const category = db.insert(categories).values({ boardId: board.id, name: 'Kind' }).returning().get();
		return { owner, board, cols, card, other, subtask, label, comment, category, session: makeSession(owner) };
	};
	type Scene = ReturnType<typeof scene>;
	type Method = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

	/**
	 * One request of each shape the slice moved that carries a JSON body, and
	 * what it answers when nothing ends meanwhile.
	 */
	const HELD: { shape: string; method: Method; path: (s: Scene) => string; body: (s: Scene) => unknown; allowed: number }[] = [
		{
			shape: 'a create that names its guarded row in the body (POST /api/cards)',
			method: 'POST',
			path: () => '/api/cards',
			body: (s) => ({ columnId: s.cols['To Do'].id, title: 'Late' }),
			allowed: 201
		},
		{
			shape: "a change and a move by the id in its path, inside the move's catch (PUT /api/cards/:id)",
			method: 'PUT',
			path: (s) => `/api/cards/${s.card.id}`,
			body: (s) => ({ title: 'Renamed late', columnId: s.cols['In Progress'].id }),
			allowed: 200
		},
		{
			shape: 'a write of many rows (PUT /api/cards/reorder)',
			method: 'PUT',
			path: () => '/api/cards/reorder',
			body: (s) => ({ updates: [{ id: s.card.id, columnId: s.cols['In Progress'].id, position: 0 }] }),
			allowed: 200
		},
		{
			shape: 'an answer that names the caller (POST /api/cards/:id/comments)',
			method: 'POST',
			path: (s) => `/api/cards/${s.card.id}/comments`,
			body: () => ({ content: 'Late' }),
			allowed: 201
		},
		{
			shape: "a write in a service's own transaction, a savepoint inside writeAs (POST /api/subtasks/:id/dependencies)",
			method: 'POST',
			path: (s) => `/api/subtasks/${s.subtask.id}/dependencies`,
			body: (s) => ({ dependsOnCardId: s.other.id }),
			allowed: 201
		},
		{
			shape: 'a delete with a body (DELETE /api/labels)',
			method: 'DELETE',
			path: () => '/api/labels',
			body: (s) => ({ id: s.label.id }),
			allowed: 200
		}
	];

	for (const c of HELD) {
		it(`refuses 401, and writes nothing, when the session ends while the body arrives: ${c.shape}`, async () => {
			const s = scene();
			let before: DbSnapshot | undefined;

			const res = await sendAround(c.method, c.path(s), { session: s.session }, c.body(s), () => {
				db.delete(sessions).where(eq(sessions.id, s.session)).run();
				before = snapshotDb();
			});

			expect(res).toEqual({ status: 401, body: { message: 'Not authenticated' } });
			expect(before).toBeDefined();
			expectUnchanged(before!);
		});

		it(`lets it through, sent the same way, when nothing ended meanwhile: ${c.shape}`, async () => {
			const s = scene();
			const res = await sendAround(c.method, c.path(s), { session: s.session }, c.body(s), () => {});
			expect(res.status).toBe(c.allowed);
		});
	}

	/** The deletes and the restore, which have no body to hold, and the upload, whose form body `sendAround` cannot hold, in an order each can run in. */
	const UNHELD = (s: Scene, archived: number, attachment: number): [Method, string][] => [
		['DELETE', `/api/cards/${s.card.id}/comments/${s.comment.id}`],
		['DELETE', `/api/cards/${s.card.id}/attachments/${attachment}`],
		['DELETE', `/api/subtasks/${s.subtask.id}`],
		['DELETE', `/api/categories/${s.category.id}`],
		['DELETE', `/api/columns/${s.cols['On Hold'].id}`],
		['POST', `/api/cards/${archived}/restore`],
		['DELETE', `/api/cards/${s.other.id}?permanent=true`],
		['DELETE', `/api/cards/${s.card.id}`]
	];
	const upload = () => {
		const form = new FormData();
		form.append('file', new File(['written late'], 'late.txt', { type: 'text/plain' }));
		return form;
	};

	it('refuses 401, and changes nothing, a delete, a restore or an upload whose session has ended', async () => {
		const s = scene();
		const archived = makeCard(s.cols['To Do'], { archivedAt: stamp() });
		const attachment = makeAttachment(s.card, { uploadedBy: s.owner });
		const credential = { kind: 'session' as const, token: s.session };
		db.delete(sessions).run();
		const before = snapshotDb();

		for (const [method, path] of UNHELD(s, archived.id, attachment.id)) {
			const res = await api(method, path, { user: s.owner, credential });
			expect({ path, status: res.status, body: res.body }).toEqual({ path, status: 401, body: { message: 'Not authenticated' } });
		}
		// The upload asks before it reads the file, as the gate read the
		// caller, and writes the file; the writeAs then refuses, and the file
		// is removed again (decision 7). Only the attachment's own is left.
		const uploaded = await api('POST', `/api/cards/${s.card.id}/attachments`, { user: s.owner, credential, body: upload() });
		expect(uploaded.status).toBe(401);
		expect(uploaded.body).toEqual({ message: 'Not authenticated' });
		expect(readdirSync(cardDir(s.card.id))).toEqual([attachment.filename]);

		expectUnchanged(before);
	});

	it('lets each of them through when the session is still open', async () => {
		const s = scene();
		const archived = makeCard(s.cols['To Do'], { archivedAt: stamp() });
		const attachment = makeAttachment(s.card, { uploadedBy: s.owner });
		const credential = { kind: 'session' as const, token: s.session };

		const uploaded = await api('POST', `/api/cards/${s.card.id}/attachments`, { user: s.owner, credential, body: upload() });
		expect(uploaded.status).toBe(200);
		for (const [method, path] of UNHELD(s, archived.id, attachment.id)) {
			const res = await api(method, path, { user: s.owner, credential });
			expect({ path, status: res.status }).toEqual({ path, status: 200 });
		}
	});

	it('decides with the account as it is now: an administrator lowered to user, on a board they are not on, is refused 403, and nothing written', async () => {
		const s = scene();
		const admin = makeUser({ username: 'was-admin', role: 'admin' });
		const credential = { kind: 'session' as const, token: makeSession(admin) };
		db.update(users).set({ role: 'user' }).where(eq(users.id, admin.id)).run();
		const before = snapshotDb();

		const changed = await api('PUT', `/api/cards/${s.card.id}`, { user: admin, credential, body: { title: 'By an administrator' } });
		expect(changed.status).toBe(403);
		expect(changed.body).toEqual({ message: 'No edit access to this board' });

		const shared = await api('POST', '/api/categories', { user: admin, credential, body: { name: 'Shared' } });
		expect(shared.status).toBe(403);
		expect(shared.body).toEqual({ message: 'Only an administrator can create a category that belongs to no board' });

		const removed = await api('DELETE', `/api/categories/${s.category.id}`, { user: admin, credential });
		expect(removed.status).toBe(403);
		expect(removed.body).toEqual({ message: 'No edit access to this board' });

		expectUnchanged(before);
	});
});

// ─── Boards, groupings, teams, goals and templates (slice 2253-3) ───────────

describe('the boards, groupings, teams, goals and templates ask at the write (slice 2253-3)', () => {
	/**
	 * A board its owner owns, filed under a grouping, with a card on it, a
	 * goal, a template shared on no board, a team the owner owns, someone the
	 * board is shared with and someone it is not, and the owner signed in by a
	 * session. Mail is set up, so that a share sends its mail.
	 */
	const scene = () => {
		const owner = makeUser({ username: 'owner' });
		const guest = makeUser({ username: 'guest' });
		const member = makeUser({ username: 'member' });
		const { board, cols } = makeBoard({ owner, name: 'Owned' });
		const grouping = db.insert(boardCategories).values({ name: 'Grouped' }).returning().get();
		db.update(boards).set({ categoryId: grouping.id }).where(eq(boards.id, board.id)).run();
		db.insert(boardMembers).values({ boardId: board.id, userId: member.id, role: 'viewer' }).run();
		const card = makeCard(cols['To Do']);
		const milestone = makeMilestone({ board, createdBy: owner });
		const template = db.insert(cardTemplates).values({ name: 'Shared', createdBy: owner.id }).returning().get();
		const team = makeTeam([member]);
		db.insert(teamMembers).values({ teamId: team.id, userId: owner.id, role: 'owner' }).run();
		makeSmtp();
		return { owner, guest, member, board, cols, grouping, card, milestone, template, team, session: makeSession(owner) };
	};
	type Scene = ReturnType<typeof scene>;
	type Method = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

	/**
	 * One request of each shape the slice moved that carries a JSON body, what
	 * it answers when nothing ends meanwhile, and the mail it then sends.
	 */
	const HELD: { shape: string; method: Method; path: (s: Scene) => string; body: (s: Scene) => unknown; allowed: number; mails?: number }[] = [
		{
			shape: 'a create whose owner is the caller (POST /api/boards)',
			method: 'POST',
			path: () => '/api/boards',
			body: () => ({ name: 'Late' }),
			allowed: 201
		},
		{
			shape: 'a change by the id in its path (PUT /api/boards/:id)',
			method: 'PUT',
			path: (s) => `/api/boards/${s.board.id}`,
			body: () => ({ name: 'Renamed late' }),
			allowed: 200
		},
		{
			shape: 'a share whose mail is queued until the commit (POST /api/boards/:id/share)',
			method: 'POST',
			path: (s) => `/api/boards/${s.board.id}/share`,
			body: (s) => ({ type: 'user', targetId: s.guest.id, role: 'editor' }),
			allowed: 200,
			mails: 1
		},
		{
			shape: 'a delete with a body (DELETE /api/boards/:id/share)',
			method: 'DELETE',
			path: (s) => `/api/boards/${s.board.id}/share`,
			body: (s) => ({ type: 'user', targetId: s.member.id }),
			allowed: 200
		},
		{
			shape: 'a create that had no transaction (POST /api/board-categories)',
			method: 'POST',
			path: () => '/api/board-categories',
			body: () => ({ name: 'Late' }),
			allowed: 201
		},
		{
			shape: 'an answer made once it has committed (POST /api/teams/:id/members/:userId)',
			method: 'POST',
			path: (s) => `/api/teams/${s.team.id}/members/${s.guest.id}`,
			body: () => ({ role: 'member' }),
			allowed: 201
		},
		{
			shape: "a service's own transaction, a savepoint inside writeAs, and the live update after (PATCH /api/milestones/:id)",
			method: 'PATCH',
			path: (s) => `/api/milestones/${s.milestone.id}`,
			body: (s) => ({ cardId: s.card.id }),
			allowed: 200
		}
	];

	for (const c of HELD) {
		it(`refuses 401, writes nothing and sends nothing, when the session ends while the body arrives: ${c.shape}`, async () => {
			const s = scene();
			const sent = effects();
			let before: DbSnapshot | undefined;

			try {
				const res = await sendAround(c.method, c.path(s), { session: s.session }, c.body(s), () => {
					db.delete(sessions).where(eq(sessions.id, s.session)).run();
					before = snapshotDb();
				});
				await sent.settle();

				expect(res).toEqual({ status: 401, body: { message: 'Not authenticated' } });
				expect(before).toBeDefined();
				expectUnchanged(before!);
				expect(sent.emails).toEqual([]);
				expect(sent.events).toEqual([]);
			} finally {
				sent.restore();
			}
		});

		it(`lets it through, sent the same way, when nothing ended meanwhile: ${c.shape}`, async () => {
			const s = scene();
			const sent = effects();
			try {
				const res = await sendAround(c.method, c.path(s), { session: s.session }, c.body(s), () => {});
				await sent.settle();
				expect(res.status).toBe(c.allowed);
				expect(sent.emails).toHaveLength(c.mails ?? 0);
			} finally {
				sent.restore();
			}
		});
	}

	/** The requests with no body, in an order each can run in: the board last. */
	const UNHELD = (s: Scene): [Method, string][] => [
		['POST', `/api/boards/${s.board.id}/favourite`],
		['DELETE', `/api/teams/${s.team.id}/members/${s.member.id}`],
		['DELETE', `/api/teams/${s.team.id}`],
		['DELETE', `/api/board-categories/${s.grouping.id}`],
		['DELETE', `/api/templates/${s.template.id}`],
		['DELETE', `/api/milestones/${s.milestone.id}`],
		['DELETE', `/api/boards/${s.board.id}`]
	];

	it('refuses 401, and changes nothing, a request with no body whose session has ended', async () => {
		const s = scene();
		const credential = { kind: 'session' as const, token: s.session };
		db.delete(sessions).run();
		const before = snapshotDb();

		for (const [method, path] of UNHELD(s)) {
			const res = await api(method, path, { user: s.owner, credential });
			expect({ path, status: res.status, body: res.body }).toEqual({ path, status: 401, body: { message: 'Not authenticated' } });
		}

		expectUnchanged(before);
	});

	it('lets each of them through when the session is still open', async () => {
		const s = scene();
		const credential = { kind: 'session' as const, token: s.session };

		for (const [method, path] of UNHELD(s)) {
			const res = await api(method, path, { user: s.owner, credential });
			expect({ path, status: res.status }).toEqual({ path, status: 200 });
		}
	});

	it('decides with the account as it is now: an administrator lowered to user, on nothing of the owner\'s, is refused as a user is, and nothing written', async () => {
		const s = scene();
		const admin = makeUser({ username: 'was-admin', role: 'admin' });
		const credential = { kind: 'session' as const, token: makeSession(admin) };
		db.update(users).set({ role: 'user' }).where(eq(users.id, admin.id)).run();
		const before = snapshotDb();
		const sent = effects();
		onTestFinished(() => sent.restore());

		const refusals: [Method, string, unknown, string][] = [
			['POST', `/api/boards/${s.board.id}/share`, { type: 'user', targetId: s.guest.id }, 'Only board owners and admins can share boards'],
			['PATCH', `/api/boards/${s.board.id}/share`, { isPublic: true }, 'Only board owners and admins can change visibility'],
			['DELETE', `/api/boards/${s.board.id}/share`, { type: 'user', targetId: s.member.id }, 'Only board owners and admins can manage sharing'],
			['POST', `/api/teams/${s.team.id}/members/${s.guest.id}`, {}, 'Forbidden'],
			['DELETE', `/api/teams/${s.team.id}/members/${s.member.id}`, undefined, 'Forbidden'],
			['PUT', `/api/board-categories/${s.grouping.id}`, { name: 'Taken over' }, 'This category groups boards you cannot edit'],
			['DELETE', `/api/board-categories/${s.grouping.id}`, undefined, 'This category groups boards you cannot edit'],
			['DELETE', `/api/templates/${s.template.id}`, undefined, 'You can only delete your own templates'],
			['DELETE', `/api/boards/${s.board.id}`, undefined, 'Only board owners and admins can delete boards']
		];
		for (const [method, path, body, message] of refusals) {
			const res = await api(method, path, { user: admin, credential, ...(body === undefined ? {} : { body }) });
			expect({ method, path, status: res.status, body: res.body }).toEqual({ method, path, status: 403, body: { message } });
		}
		await sent.settle();

		expectUnchanged(before);
		expect(sent.emails).toEqual([]);
	});
});

// ─── Accounts, users, requests and reports (slice 2253-4) ───────────────────

describe('the accounts, users, requests and reports ask at the write (slice 2253-4)', () => {
	const PASSWORD = 'the owner password';
	const NEW_PASSWORD = 'a long new password';
	const PERIOD = { periodStart: '2026-10-01', periodEnd: '2026-10-08' };

	/**
	 * An owner with a board and a password that can be checked, an
	 * administrator, the superadmin, an ordinary member and a second
	 * administrator, a request addressed to the owner and one nobody has
	 * confirmed yet, an API key of the owner's, and a session each for the
	 * owner and the administrator. Mail and the App URL are set up, so that
	 * the mails, the invite and the confirmation link can all be made.
	 */
	const scene = () => {
		resetAllRateLimits();
		const owner = makeUser({ username: 'owner' });
		db.update(users).set({ passwordHash: hashSync(PASSWORD, 4) }).where(eq(users.id, owner.id)).run();
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const chief = makeUser({ username: 'chief', role: 'superadmin' });
		const member = makeUser({ username: 'member' });
		const colleague = makeUser({ username: 'colleague', role: 'admin' });
		const { board } = makeBoard({ owner, name: 'Reported' });
		const asked = (status: string) =>
			db
				.insert(taskRequests)
				.values({
					targetType: 'user',
					targetId: owner.id,
					requesterName: 'Rita',
					requesterEmail: 'rita@example.test',
					title: 'Asked',
					status,
					accessToken: newRequestToken()
				})
				.returning()
				.get();
		const request = asked('pending');
		const unconfirmed = asked('unverified');
		const key = makeApiKey(owner);
		makeSmtp();
		db.insert(settings).values({ key: 'app_url', value: 'https://dumpfire.example.test' }).run();
		return {
			owner,
			admin,
			chief,
			member,
			colleague,
			board,
			request,
			unconfirmed,
			key,
			sessions: { owner: makeSession(owner), admin: makeSession(admin) }
		};
	};
	type Scene = ReturnType<typeof scene>;
	type Method = 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	type Who = 'owner' | 'admin';

	/**
	 * One request of each shape the slice moved that carries a JSON body, by
	 * whom, what it answers when nothing ends meanwhile, and the mail it then
	 * sends (not counted for the new link, which is mailed after the answer).
	 */
	const HELD: { shape: string; method: Method; path: (s: Scene) => string; body: (s: Scene) => unknown; who: Who; allowed: number; mails?: number }[] = [
		{
			shape: "a change to the caller's own account (PUT /api/account/emoji)",
			method: 'PUT',
			path: () => '/api/account/emoji',
			body: () => ({ emoji: '🦊' }),
			who: 'owner',
			allowed: 200,
			mails: 0
		},
		{
			shape: 'a key made with the current password, refused before the password is checked (POST /api/account/api-keys)',
			method: 'POST',
			path: () => '/api/account/api-keys',
			body: () => ({ name: 'Late', password: PASSWORD }),
			who: 'owner',
			allowed: 201,
			mails: 0
		},
		{
			shape: 'an address changed with the current password (PUT /api/account/email)',
			method: 'PUT',
			path: () => '/api/account/email',
			body: () => ({ newEmail: 'moved@example.test', password: PASSWORD }),
			who: 'owner',
			allowed: 200,
			mails: 0
		},
		{
			shape: 'an account made, its hash awaited between two checks (POST /api/users)',
			method: 'POST',
			path: () => '/api/users',
			body: () => ({ username: 'late', email: 'late@example.test', password: NEW_PASSWORD }),
			who: 'admin',
			allowed: 201,
			mails: 0
		},
		{
			shape: 'another account changed (PUT /api/users/:id)',
			method: 'PUT',
			path: (s) => `/api/users/${s.member.id}`,
			body: () => ({ emoji: '🦊' }),
			who: 'admin',
			allowed: 200,
			mails: 0
		},
		{
			shape: "another account's password set, its hash awaited between two checks (PUT /api/users/:id/password)",
			method: 'PUT',
			path: (s) => `/api/users/${s.member.id}/password`,
			body: () => ({ password: NEW_PASSWORD }),
			who: 'admin',
			allowed: 200,
			mails: 0
		},
		{
			shape: 'the public form, signed in (POST /api/requests)',
			method: 'POST',
			path: () => '/api/requests',
			body: (s) => ({ title: 'Late', targetType: 'user', targetId: s.member.id }),
			who: 'owner',
			allowed: 201,
			mails: 1
		},
		{
			shape: 'a request answered, its mail queued until the commit (PATCH /api/requests/:id)',
			method: 'PATCH',
			path: (s) => `/api/requests/${s.request.id}`,
			body: () => ({ action: 'reject' }),
			who: 'owner',
			allowed: 200,
			mails: 1
		},
		{
			shape: 'a reply from the team, which had no transaction (POST /api/requests/:id/messages)',
			method: 'POST',
			path: (s) => `/api/requests/${s.request.id}/messages`,
			body: () => ({ message: 'Late' }),
			who: 'owner',
			allowed: 200,
			mails: 1
		},
		{
			shape: 'a confirmation link followed by someone signed in, which had no transaction (POST /api/requests/:id/confirm)',
			method: 'POST',
			path: (s) => `/api/requests/${s.unconfirmed.id}/confirm`,
			body: (s) => ({ token: s.unconfirmed.accessToken }),
			who: 'owner',
			allowed: 200,
			mails: 1
		},
		{
			shape: 'a new link asked for by someone signed in, which writes nothing (POST /api/requests/:id/link)',
			method: 'POST',
			path: (s) => `/api/requests/${s.request.id}/link`,
			body: () => ({ email: 'rita@example.test' }),
			who: 'owner',
			allowed: 202
		},
		{
			shape: 'a report built after its body, which only reads (POST /api/reports)',
			method: 'POST',
			path: () => '/api/reports',
			body: (s) => ({ scope: 'board', scopeId: s.board.id, ...PERIOD }),
			who: 'owner',
			allowed: 200,
			mails: 0
		},
		{
			shape: 'a report mailed, asked after its body and again before it sends (POST /api/reports/email)',
			method: 'POST',
			path: () => '/api/reports/email',
			body: (s) => ({ scope: 'board', scopeId: s.board.id, ...PERIOD, recipients: ['a@example.test'] }),
			who: 'owner',
			allowed: 200,
			mails: 1
		}
	];

	for (const c of HELD) {
		it(`refuses 401, writes nothing and sends nothing, when the session ends while the body arrives: ${c.shape}`, { timeout: 30_000 }, async () => {
			const s = scene();
			const session = s.sessions[c.who];
			const sent = effects();
			let before: DbSnapshot | undefined;

			try {
				const res = await sendAround(c.method, c.path(s), { session }, c.body(s), () => {
					db.delete(sessions).where(eq(sessions.id, session)).run();
					before = snapshotDb();
				});
				await sent.settle();

				expect(res).toEqual({ status: 401, body: { message: 'Not authenticated' } });
				expect(before).toBeDefined();
				expectUnchanged(before!);
				expect(sent.emails).toEqual([]);
			} finally {
				sent.restore();
			}
		});

		it(`lets it through, sent the same way, when nothing ended meanwhile: ${c.shape}`, { timeout: 30_000 }, async () => {
			const s = scene();
			const sent = effects();
			try {
				const res = await sendAround(c.method, c.path(s), { session: s.sessions[c.who] }, c.body(s), () => {});
				await sent.settle();
				expect(res.status).toBe(c.allowed);
				if (c.mails !== undefined) expect(sent.emails).toHaveLength(c.mails);
			} finally {
				sent.restore();
			}
		});
	}

	/** The requests with no body, by whom, in an order each can run in: the member's account last. */
	const UNHELD = (s: Scene): [Method, string, Who][] => [
		['DELETE', `/api/account/api-keys/${keyRow(s.key).id}`, 'owner'],
		['POST', `/api/users/${s.member.id}/invite`, 'admin'],
		['DELETE', `/api/requests/${s.request.id}`, 'admin'],
		['DELETE', `/api/users/${s.member.id}`, 'admin']
	];
	const asWho = (s: Scene, who: Who) => ({ user: s[who], credential: { kind: 'session' as const, token: s.sessions[who] } });

	it('refuses 401, and changes nothing and sends nothing, a request with no body whose session has ended', async () => {
		const s = scene();
		const requests = UNHELD(s);
		db.delete(sessions).run();
		const before = snapshotDb();
		const sent = effects();
		onTestFinished(() => sent.restore());

		for (const [method, path, who] of requests) {
			const res = await api(method, path, asWho(s, who));
			expect({ path, status: res.status, body: res.body }).toEqual({ path, status: 401, body: { message: 'Not authenticated' } });
		}
		await sent.settle();

		expectUnchanged(before);
		expect(sent.emails).toEqual([]);
	});

	it('lets each of them through when the session is still open', async () => {
		const s = scene();
		const sent = effects();
		onTestFinished(() => sent.restore());

		for (const [method, path, who] of UNHELD(s)) {
			const res = await api(method, path, asWho(s, who));
			expect({ path, status: res.status }).toEqual({ path, status: 200 });
		}
		await sent.settle();
		// The invite's.
		expect(sent.emails).toHaveLength(1);
	});

	it('lets the password change through: its writes ask before the session it came by ends, and nothing in it asks after', { timeout: 30_000 }, async () => {
		const s = scene();

		const res = await sendAround('PUT', '/api/account/password', { session: s.sessions.owner }, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, () => {});

		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ success: true });
		// The session it came by has ended, and one new session replaces it.
		const left = db.select().from(sessions).where(eq(sessions.userId, s.owner.id)).all();
		expect(left.map((row) => row.id)).not.toContain(s.sessions.owner);
		expect(left).toHaveLength(1);
		// Which is why nothing may ask after the change: a writeAs with the
		// session the request came by is refused now.
		expect(outcome(() => writeAs(sessionLocals(s.owner, s.sessions.owner), (caller) => caller))).toEqual({
			status: 401,
			message: 'Not authenticated'
		});
	});

	it('refuses 401, and changes no password, when the session ends while the body of a password change arrives', { timeout: 30_000 }, async () => {
		const s = scene();
		let before: DbSnapshot | undefined;

		const res = await sendAround('PUT', '/api/account/password', { session: s.sessions.owner }, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, () => {
			db.delete(sessions).where(eq(sessions.id, s.sessions.owner)).run();
			before = snapshotDb();
		});

		expect(res).toEqual({ status: 401, body: { message: 'Not authenticated' } });
		expectUnchanged(before!);
	});

	it('refuses 401, in the words for a key, a write handed an API key revoked meanwhile, and writes nothing', async () => {
		const s = scene();
		// The internal routes are reached with a session; a key reaches the
		// handler only through api(), but writeAs reads either credential alike.
		const credential = { kind: 'api key' as const, id: keyRow(s.key).id };
		db.delete(apiKeys).run();
		const before = snapshotDb();

		const writes: [Method, string, unknown][] = [
			['PUT', '/api/account/emoji', { emoji: '🦊' }],
			['PUT', '/api/account/notifications', { email_mentions: false }],
			['POST', '/api/reports', { scope: 'board', scopeId: s.board.id, ...PERIOD }]
		];
		for (const [method, path, body] of writes) {
			const res = await api(method, path, { user: s.owner, credential, body });
			expect({ path, status: res.status, body: res.body }).toEqual({ path, status: 401, body: { message: 'Invalid or expired API key' } });
		}

		expectUnchanged(before);
	});

	/** The public request routes, by a caller with no session, each answering as for one. */
	const PUBLIC = (s: Scene): [string, Record<string, unknown>, number, Record<string, string>?][] => [
		['/api/requests', { title: 'From outside', targetType: 'user', targetId: s.owner.id, requesterEmail: 'out@example.test' }, 201, { 'x-form-token': issueFormToken() }],
		[`/api/requests/${s.unconfirmed.id}/confirm`, { token: s.unconfirmed.accessToken }, 200],
		[`/api/requests/${s.request.id}/link`, { email: 'rita@example.test' }, 202],
		[`/api/requests/${s.request.id}/messages`, { senderType: 'requester', token: s.request.accessToken, message: 'From outside' }, 200]
	];

	it('lets a caller with no session through the public request routes, handed null (decision 3)', async () => {
		const s = scene();
		const sent = effects();
		onTestFinished(() => sent.restore());

		for (const [path, body, allowed, headers] of PUBLIC(s)) {
			const res = await api('POST', path, { user: null, credential: null, body, ...(headers ? { headers } : {}) });
			expect({ path, status: res.status }).toEqual({ path, status: allowed });
		}
		await sent.settle();
	});

	it('refuses 401 on the public request routes a caller whose session ended, never taking them for anonymous (N5), and writes nothing', async () => {
		const s = scene();
		const requests = PUBLIC(s);
		db.delete(sessions).run();
		const before = snapshotDb();
		const sent = effects();
		onTestFinished(() => sent.restore());

		for (const [path, body, , headers] of requests) {
			const res = await api('POST', path, { ...asWho(s, 'owner'), body, ...(headers ? { headers } : {}) });
			expect({ path, status: res.status, body: res.body }).toEqual({ path, status: 401, body: { message: 'Not authenticated' } });
		}
		await sent.settle();

		expectUnchanged(before);
		expect(sent.emails).toEqual([]);
	});

	it("decides with the account as it is now: an administrator lowered to user is refused as a user is, and the superadmin lowered to administrator as an administrator is; nothing written, nothing sent", async () => {
		const s = scene();
		const lowered = (user: SessionUser, to: string) => {
			const credential = { kind: 'session' as const, token: makeSession(user) };
			db.update(users).set({ role: to }).where(eq(users.id, user.id)).run();
			return { user, credential };
		};
		const wasAdmin = lowered(s.admin, 'user');
		const wasChief = lowered(s.chief, 'admin');
		const before = snapshotDb();
		const sent = effects();
		onTestFinished(() => sent.restore());

		const ALL = 'Only admins can generate all-boards reports';
		const refusals: [typeof wasAdmin, Method, string, unknown, string][] = [
			[wasAdmin, 'POST', '/api/users', { username: 'made', email: 'made@example.test', password: NEW_PASSWORD }, 'Forbidden'],
			[wasAdmin, 'PUT', `/api/users/${s.member.id}`, { emoji: '🦊' }, 'Forbidden'],
			[wasAdmin, 'PUT', `/api/users/${s.member.id}/password`, { password: NEW_PASSWORD }, 'Forbidden'],
			[wasAdmin, 'POST', `/api/users/${s.member.id}/invite`, undefined, 'Forbidden'],
			[wasAdmin, 'DELETE', `/api/users/${s.member.id}`, undefined, 'Forbidden'],
			[wasAdmin, 'DELETE', `/api/requests/${s.request.id}`, undefined, 'Admin only'],
			[wasAdmin, 'POST', '/api/reports', { scope: 'all', ...PERIOD }, ALL],
			[wasAdmin, 'POST', '/api/reports/email', { scope: 'all', ...PERIOD, recipients: ['a@example.test'] }, ALL],
			[wasChief, 'POST', '/api/users', { username: 'made', email: 'made@example.test', password: NEW_PASSWORD, role: 'admin' }, 'Only superadmin can create admin users'],
			[wasChief, 'PUT', `/api/users/${s.colleague.id}`, { emoji: '🦊' }, 'Only superadmin can modify admin users'],
			[wasChief, 'PUT', `/api/users/${s.colleague.id}/password`, { password: NEW_PASSWORD }, "Only superadmin can reset an admin's password"],
			[wasChief, 'POST', `/api/users/${s.colleague.id}/invite`, undefined, "Only superadmin can reset an admin's password, which an invite does"],
			[wasChief, 'DELETE', `/api/users/${s.colleague.id}`, undefined, 'Only superadmin can delete admin users']
		];
		for (const [who, method, path, body, message] of refusals) {
			const res = await api(method, path, { ...who, ...(body === undefined ? {} : { body }) });
			expect({ who: who.user.username, method, path, status: res.status, body: res.body }).toEqual({
				who: who.user.username,
				method,
				path,
				status: 403,
				body: { message }
			});
		}
		await sent.settle();

		expectUnchanged(before);
		expect(sent.emails).toEqual([]);
	});
});

// ─── The superadmin's and administrators' routes (slice 2253-5) ─────────────

describe("the superadmin's and administrators' routes ask at the write (slice 2253-5)", () => {
	const BUCKET = { type: 's3', name: 'Bucket', region: 'eu-west-2', bucket: 'dumpfire-backups', accessKeyId: 'AKIA2253NOTSECRET', secretAccessKey: 'bucket-secret-2253', prefix: 'dumpfire/' };
	const DRIVE = { type: 'gdrive', name: 'G', authMethod: 'oauth', clientId: 'g-client.apps.example.test', clientSecret: 'g-client-secret-2253', folderId: '' };
	/** The folder Drive, stood in for, says it made. */
	const FOLDER = 'made-folder-2253';
	const files = { create: vi.fn(), delete: vi.fn(), get: vi.fn(), list: vi.fn() };
	let getToken: ReturnType<typeof vi.spyOn>;

	/** Google's code exchange, stood in for: a refresh token, after `meanwhile` has run. */
	const exchange = (meanwhile: () => unknown = () => {}) =>
		getToken.mockImplementation((async () => {
			await meanwhile();
			return { tokens: { refresh_token: 'rt-2253', scope: DRIVE_FILE_SCOPE }, res: null };
		}) as never);

	beforeEach(() => {
		for (const fn of Object.values(files)) fn.mockReset();
		files.create.mockResolvedValue({ data: { id: FOLDER } });
		files.delete.mockResolvedValue({ data: {} });
		vi.spyOn(google, 'drive').mockReturnValue({ files } as never);
		getToken = vi.spyOn(google.auth.OAuth2.prototype, 'getToken');
		exchange();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * The superadmin and an administrator, each with a session; a board of the
	 * administrator's with a card, an archived card and a category; XP; the
	 * mail set up; and the backup settings with an S3 destination and a Google
	 * Drive one not yet connected.
	 */
	const scene = () => {
		const chief = makeUser({ username: 'chief', role: 'superadmin' });
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const { board, cols } = makeBoard({ owner: admin, name: 'Cleared' });
		makeCard(cols['To Do'], { title: 'Kept' });
		makeCard(cols['To Do'], { title: 'Archived', archivedAt: '2026-10-01 00:00:00' });
		db.insert(categories).values({ boardId: board.id, name: 'Kind' }).run();
		db.insert(userXp).values({ name: 'admin', xp: 40 }).run();
		makeSmtp();
		const backup = { schedule: 'disabled', scheduleTime: '02:00', scheduleDay: 0, retention: 7, destinations: [BUCKET, DRIVE], notifyOnFailure: false, notifyEmail: '' };
		db.insert(settings).values({ key: 'backup_config', value: JSON.stringify(backup) }).run();
		return { chief, admin, board, sessions: { chief: makeSession(chief), admin: makeSession(admin) } };
	};
	type Scene = ReturnType<typeof scene>;
	type Who = 'chief' | 'admin';
	const asWho = (s: Scene, who: Who) => ({ user: s[who], credential: { kind: 'session' as const, token: s.sessions[who] } });

	/** Connect's first half, as the page asks it, in this session: the state of the consent address. */
	const begin = async (s: Scene, token = s.sessions.chief) => {
		const res = await api('GET', '/api/admin/backup/gdrive/auth?dest=G', { user: s.chief, credential: { kind: 'session', token } });
		expect(res.status).toBe(200);
		return new URL(res.body.authUrl).searchParams.get('state');
	};

	/** The lines these routes write, and the Connect's. */
	const lines = () =>
		(sqlite.prepare("SELECT level, context, message FROM system_logs WHERE context IN ('BACKUP', 'GDRIVE', 'SMTP') ORDER BY id").all() as Record<string, string>[]);
	const storedDrive = () => JSON.parse(db.select().from(settings).where(eq(settings.key, 'backup_config')).get()!.value).destinations[1];

	/** What left the process, or would have: mail, a backup sent, a destination made with its secret, a code sent to Google. */
	const sentOut = (mail: { emails: unknown[] }) => ({
		mails: mail.emails.length,
		uploads: backupStandIn.uploaded.length,
		made: backupStandIn.made.length,
		exchanged: getToken.mock.calls.length
	});
	const NOTHING_OUT = { mails: 0, uploads: 0, made: 0, exchanged: 0 };

	/**
	 * One request of each backup and mail route that carries a body (the
	 * superadmin's until card 2395, every administrator's since), what it answers
	 * when nothing ends meanwhile, and what it then sends out. A backup run
	 * makes its destination twice: to upload, and to keep to the retention.
	 */
	const HELD: { shape: string; method: 'POST' | 'PUT'; path: string; body: (s: Scene) => unknown; out: Partial<typeof NOTHING_OUT> }[] = [
		// Keep Last raised from 7: lowering it is the superadmin's alone since card 2398.
		{ shape: 'the backup settings saved, their lines after the commit (PUT /api/admin/backup)', method: 'PUT', path: '/api/admin/backup', body: () => ({ retention: 9 }), out: {} },
		{ shape: 'a backup run, which leaves the process (POST /api/admin/backup)', method: 'POST', path: '/api/admin/backup', body: () => ({ destination: 'Bucket' }), out: { uploads: 1, made: 2 } },
		{ shape: "a destination tested, its secret leaving with it (POST /api/admin/backup/test)", method: 'POST', path: '/api/admin/backup/test', body: () => BUCKET, out: { made: 1 } },
		{
			shape: 'a Google Drive Connect, its code sent to Google (POST /api/admin/backup/gdrive/auth)',
			method: 'POST',
			path: '/api/admin/backup/gdrive/auth',
			body: async (s) => ({ code: 'the-code', state: await begin(s), destName: 'G' }),
			out: { exchanged: 1 }
		},
		{ shape: 'the mail settings saved (PUT /api/admin/smtp)', method: 'PUT', path: '/api/admin/smtp', body: () => ({ fromName: 'Late' }), out: {} },
		{ shape: 'a test mail, which leaves the process (POST /api/admin/smtp)', method: 'POST', path: '/api/admin/smtp', body: () => ({ to: 'late@example.test' }), out: { mails: 1 } }
	];

	for (const c of HELD) {
		it(`refuses 401, writes nothing and sends nothing out, when the session ends while the body arrives: ${c.shape}`, { timeout: 30_000 }, async () => {
			const s = scene();
			const body = await c.body(s);
			const sent = effects();
			onTestFinished(() => sent.restore());
			let before: DbSnapshot | undefined;
			let linesBefore: unknown[] = [];

			const res = await sendAround(c.method, c.path, { session: s.sessions.chief }, body, () => {
				db.delete(sessions).where(eq(sessions.id, s.sessions.chief)).run();
				before = snapshotDb();
				linesBefore = lines();
			});
			await sent.settle();

			expect(res).toEqual({ status: 401, body: { message: 'Not authenticated' } });
			expect(before).toBeDefined();
			expectUnchanged(before!);
			expect(lines()).toEqual(linesBefore);
			expect(sentOut(sent)).toEqual(NOTHING_OUT);
		});

		it(`lets it through, sent the same way, when nothing ended meanwhile: ${c.shape}`, { timeout: 30_000 }, async () => {
			const s = scene();
			const body = await c.body(s);
			const sent = effects();
			onTestFinished(() => sent.restore());

			const res = await sendAround(c.method, c.path, { session: s.sessions.chief }, body, () => {});
			await sent.settle();

			expect(res.status, JSON.stringify(res.body)).toBe(200);
			expect(sentOut(sent)).toEqual({ ...NOTHING_OUT, ...c.out });
		});
	}

	/** The requests with no body, by whom, in an order each can run in: the reset last. */
	const UNHELD = (s: Scene): ['POST', string, Who][] => [
		['POST', `/api/admin/boards/${s.board.id}/clear-cards`, 'admin'],
		['POST', `/api/admin/boards/${s.board.id}/clear-categories`, 'admin'],
		['POST', '/api/admin/purge-archived', 'admin'],
		['POST', '/api/admin/reset-xp', 'admin'],
		['POST', '/api/admin/vacuum', 'admin'],
		['POST', '/api/admin/reset', 'chief']
	];

	it('refuses 401, and changes nothing, a request with no body whose session has ended', async () => {
		const s = scene();
		const requests = UNHELD(s);
		db.delete(sessions).run();
		const before = snapshotDb();

		for (const [method, path, who] of requests) {
			const res = await api(method, path, asWho(s, who));
			expect({ path, status: res.status, body: res.body }).toEqual({ path, status: 401, body: { message: 'Not authenticated' } });
		}

		expectUnchanged(before);
	});

	it("still writes the reset's failure line, and answers 500 with nothing cleared, when a database fault fails its first transaction (the slices 5–7 review)", async () => {
		const s = scene();
		const before = snapshotDb();
		// Every transaction does its work and then fails, as a COMMIT that cannot be written.
		const real = sqlite.transaction.bind(sqlite) as (fn: (...args: unknown[]) => unknown) => unknown;
		vi.spyOn(sqlite, 'transaction').mockImplementation(((fn: (...args: unknown[]) => unknown) =>
			real((...args: unknown[]) => {
				fn(...args);
				throw new Error('disk I/O error');
			})) as never);

		const res = await api('POST', '/api/admin/reset', asWho(s, 'chief'));
		vi.mocked(sqlite.transaction).mockRestore();

		expect({ status: res.status, body: res.body }).toEqual({ status: 500, body: { message: 'The reset failed and nothing was cleared: disk I/O error' } });
		expect(
			sqlite.prepare("SELECT message, user_id AS userId FROM system_logs WHERE context = 'ADMIN' AND level = 'ERROR' ORDER BY id").all()
		).toEqual([{ message: 'A reset by chief (ID: ' + s.chief.id + ') failed, and nothing was cleared: disk I/O error', userId: s.chief.id }]);
		expectUnchanged(before);
	});

	it('lets each of them through when the session is still open', async () => {
		const s = scene();

		for (const [method, path, who] of UNHELD(s)) {
			const res = await api(method, path, asWho(s, who));
			expect({ path, status: res.status }).toEqual({ path, status: 200 });
		}
	});

	it('decides with the account as it is now: an administrator lowered to user is refused as a user is, and the superadmin lowered to administrator as an administrator is; nothing written, nothing sent out', async () => {
		const s = scene();
		// Started while still the superadmin, in the session the Connect is then sent from.
		const state = await begin(s);
		const lowered = (who: Who, to: string) => {
			db.update(users).set({ role: to }).where(eq(users.id, s[who].id)).run();
			return asWho(s, who);
		};
		const wasAdmin = lowered('admin', 'user');
		const wasChief = lowered('chief', 'admin');
		const before = snapshotDb();
		const linesBefore = lines();
		const sent = effects();
		onTestFinished(() => sent.restore());

		const refusals: [typeof wasAdmin, 'POST' | 'PUT', string, unknown, string][] = [
			[wasAdmin, 'POST', `/api/admin/boards/${s.board.id}/clear-cards`, undefined, 'Forbidden'],
			[wasAdmin, 'POST', `/api/admin/boards/${s.board.id}/clear-categories`, undefined, 'Forbidden'],
			[wasAdmin, 'POST', '/api/admin/purge-archived', undefined, 'Forbidden'],
			[wasAdmin, 'POST', '/api/admin/reset-xp', undefined, 'Forbidden'],
			[wasAdmin, 'POST', '/api/admin/vacuum', undefined, 'Forbidden'],
			// Every administrator's since card 2395, so asked at the administrator level: the superadmin made an
			// administrator is let through them (tested below), and an administrator made a user is not.
			[wasAdmin, 'PUT', '/api/admin/backup', { retention: 5 }, 'Forbidden'],
			[wasAdmin, 'POST', '/api/admin/backup', { destination: 'Bucket' }, 'Forbidden'],
			[wasAdmin, 'POST', '/api/admin/backup/test', BUCKET, 'Forbidden'],
			[wasAdmin, 'POST', '/api/admin/backup/gdrive/auth', { code: 'the-code', state, destName: 'G' }, 'Forbidden'],
			[wasAdmin, 'PUT', '/api/admin/smtp', { fromName: 'Late' }, 'Forbidden'],
			[wasAdmin, 'POST', '/api/admin/smtp', { to: 'late@example.test' }, 'Forbidden'],
			[wasChief, 'POST', '/api/admin/reset', undefined, SUPERADMIN_ONLY]
		];
		for (const [who, method, path, body, message] of refusals) {
			const res = await api(method, path, { ...who, ...(body === undefined ? {} : { body }) });
			expect({ who: who.user.username, method, path, status: res.status, body: res.body }).toEqual({
				who: who.user.username,
				method,
				path,
				status: 403,
				body: { message }
			});
		}
		await sent.settle();

		expectUnchanged(before);
		expect(lines()).toEqual(linesBefore);
		expect(sentOut(sent)).toEqual(NOTHING_OUT);
	});

	describe('a Google Drive Connect refused at its write, after Google has answered and a folder was made', () => {
		it.each([
			['the session ends', (s: Scene) => void db.delete(sessions).where(eq(sessions.id, s.sessions.chief)).run(), 401, 'Not authenticated'],
			// An administrator's since card 2395: refused when the account is no longer one.
			['the superadmin is made an ordinary user', (s: Scene) => void db.update(users).set({ role: 'user' }).where(eq(users.id, s.chief.id)).run(), 403, 'Forbidden']
		])('removes the folder it made and saves nothing when %s while Google answers', async (_case, meanwhile, status, message) => {
			const s = scene();
			const state = await begin(s);
			exchange(() => meanwhile(s));
			const linesBefore = lines();

			const res = await api('POST', '/api/admin/backup/gdrive/auth', { ...asWho(s, 'chief'), body: { code: 'the-code', state, destName: 'G' } });

			expect({ status: res.status, body: res.body }).toEqual({ status, body: { message } });
			expect(getToken).toHaveBeenCalledTimes(1);
			expect(files.create).toHaveBeenCalledTimes(1);
			expect(files.delete).toHaveBeenCalledTimes(1);
			expect(files.delete.mock.calls[0][0]).toMatchObject({ fileId: FOLDER });
			expect(storedDrive()).toEqual(DRIVE);
			// Nor is anybody recorded as its setter (card 2397).
			expect(sqlite.prepare('SELECT * FROM setting_setters').all()).toEqual([]);
			// No line that it connected, nor that the Connect failed: it was refused.
			expect(lines()).toEqual(linesBefore);
		});

		it('saves the connection and keeps the folder when nothing ends meanwhile (the control)', async () => {
			const s = scene();
			const state = await begin(s);

			const res = await api('POST', '/api/admin/backup/gdrive/auth', { ...asWho(s, 'chief'), body: { code: 'the-code', state, destName: 'G' } });

			expect(res.status).toBe(200);
			expect(res.body.success).toBe(true);
			expect(files.delete).not.toHaveBeenCalled();
			expect(storedDrive()).toEqual({ ...DRIVE, refreshToken: 'rt-2253', grantedScope: DRIVE_FILE_SCOPE, folderId: FOLDER });
			// Bound to the connecting account's Google account, the destination is now theirs (card 2397).
			expect(sqlite.prepare('SELECT setting, user_id AS userId FROM setting_setters').all()).toEqual([{ setting: 'backup_destination:G', userId: s.chief.id }]);
		});
	});

	describe('the import asks once, after the upload and before anything is written', () => {
		/** The working directory the import writes its temporary copy and safety file in, pointed somewhere the test can look. */
		const workingDirectory = () => {
			const dir = mkdtempSync(join(tmpdir(), 'dumpfire-2253-'));
			onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
			vi.spyOn(process, 'cwd').mockReturnValue(dir);
			return dir;
		};
		const importing = (who: ReturnType<typeof asWho>, bytes: Uint8Array) =>
			api('POST', '/api/admin/import', { ...who, headers: { 'content-type': 'application/octet-stream' }, body: bytes });

		it.each([
			['its session has ended', (s: Scene) => void db.delete(sessions).run(), 401, 'Not authenticated'],
			['the superadmin has been made an administrator', (s: Scene) => void db.update(users).set({ role: 'admin' }).where(eq(users.id, s.chief.id)).run(), 403, SUPERADMIN_ONLY]
		])('refuses an import when %s, with nothing restored, no temporary copy and no safety file', async (_case, meanwhile, status, message) => {
			const s = scene();
			const bytes = sqlite.serialize();
			const dir = workingDirectory();
			meanwhile(s);
			const before = snapshotDb();

			const res = await importing(asWho(s, 'chief'), bytes);

			expect({ status: res.status, body: res.body }).toEqual({ status, body: { message } });
			expectUnchanged(before);
			expect(readdirSync(dir)).toEqual([]);
		});

		it('restores with the session open, asking nothing after the restore, whose database holds no session to ask (the control)', async () => {
			const s = scene();
			const bytes = sqlite.serialize();
			const dir = workingDirectory();

			const res = await importing(asWho(s, 'chief'), bytes);

			expect(res.status, JSON.stringify(res.body)).toBe(200);
			expect(res.body.success).toBe(true);
			// Everybody signed out, the caller included: a check after the restore would refuse.
			expect(db.select().from(sessions).all()).toEqual([]);
			expect(readdirSync(dir)).toEqual(['.pre-restore-safety.json']);
		});
	});

	// Card 2395: the mail and backup settings, Run Now, the Test and the Connect
	// are every administrator's, asked at the same places, at the administrator
	// level. The export, the import and the reset stay the superadmin's.
	describe('the mail and backup settings, opened to every administrator (card 2395)', () => {
		/** Connect's first half, asked by `who` in their own session. */
		const beginAs = async (s: Scene, who: Who) => {
			const res = await api('GET', '/api/admin/backup/gdrive/auth?dest=G', asWho(s, who));
			expect(res.status, JSON.stringify(res.body)).toBe(200);
			return new URL(res.body.authUrl).searchParams.get('state');
		};
		/** A request of HELD as the administrator sends it: the Connect's state is one their own session began. */
		const adminBody = async (c: (typeof HELD)[number], s: Scene) =>
			c.path === '/api/admin/backup/gdrive/auth' ? { code: 'the-code', state: await beginAs(s, 'admin'), destName: 'G' } : c.body(s);
		/** The superadmin's three: what an administrator is still refused. */
		const SUPERADMIN_ROUTES: { method: 'GET' | 'POST'; path: string; body?: unknown }[] = [
			{ method: 'GET', path: '/api/admin/export' },
			// Not a backup, so the superadmin's is refused for that before it is read, and nothing is replaced.
			{ method: 'POST', path: '/api/admin/import', body: { notABackup: true } },
			{ method: 'POST', path: '/api/admin/reset' }
		];

		for (const c of HELD) {
			it(`lets an administrator through, sent with its body held: ${c.shape}`, { timeout: 30_000 }, async () => {
				const s = scene();
				const body = await adminBody(c, s);
				const sent = effects();
				onTestFinished(() => sent.restore());

				const res = await sendAround(c.method, c.path, { session: s.sessions.admin }, body, () => {});
				await sent.settle();

				expect(res.status, JSON.stringify(res.body)).toBe(200);
				expect(sentOut(sent)).toEqual({ ...NOTHING_OUT, ...c.out });
			});

			it(`refuses 403, writes nothing and sends nothing out, when the administrator is made a user while the body arrives: ${c.shape}`, { timeout: 30_000 }, async () => {
				const s = scene();
				const body = await adminBody(c, s);
				const sent = effects();
				onTestFinished(() => sent.restore());
				let before: DbSnapshot | undefined;
				let linesBefore: unknown[] = [];
				// Begun by the administrator, so the Connect's GET counts as nothing sent out.
				const exchangedBefore = getToken.mock.calls.length;

				const res = await sendAround(c.method, c.path, { session: s.sessions.admin }, body, () => {
					db.update(users).set({ role: 'user' }).where(eq(users.id, s.admin.id)).run();
					before = snapshotDb();
					linesBefore = lines();
				});
				await sent.settle();

				expect(res).toEqual({ status: 403, body: { message: 'Forbidden' } });
				expect(before).toBeDefined();
				expectUnchanged(before!);
				expect(lines()).toEqual(linesBefore);
				expect(sentOut(sent)).toEqual({ ...NOTHING_OUT, exchanged: exchangedBefore });
			});
		}

		it('answers an administrator each read, and refuses an ordinary account every method of the four routes, writing nothing and sending nothing out', async () => {
			const s = scene();
			for (const path of ['/api/admin/smtp', '/api/admin/backup', '/api/admin/backup/gdrive/auth?dest=G']) {
				const res = await api('GET', path, asWho(s, 'admin'));
				expect({ path, status: res.status }).toEqual({ path, status: 200 });
			}

			const plain = makeUser({ username: 'plain' });
			const asPlain = { user: plain, credential: { kind: 'session' as const, token: makeSession(plain) } };
			const before = snapshotDb();
			const linesBefore = lines();
			const sent = effects();
			onTestFinished(() => sent.restore());
			const requests: ['GET' | 'POST' | 'PUT', string, unknown][] = [
				['GET', '/api/admin/smtp', undefined],
				['PUT', '/api/admin/smtp', { fromName: 'Plain' }],
				['POST', '/api/admin/smtp', { to: 'plain@example.test' }],
				['GET', '/api/admin/backup', undefined],
				['PUT', '/api/admin/backup', { retention: 5 }],
				['POST', '/api/admin/backup', { destination: 'Bucket' }],
				['POST', '/api/admin/backup/test', BUCKET],
				['GET', '/api/admin/backup/gdrive/auth?dest=G', undefined],
				['POST', '/api/admin/backup/gdrive/auth', { code: 'the-code', state: 'any', destName: 'G' }]
			];
			for (const [method, path, body] of requests) {
				const res = await api(method, path, { ...asPlain, ...(body === undefined ? {} : { body }) });
				expect({ method, path, status: res.status, body: res.body }).toEqual({ method, path, status: 403, body: { message: 'Forbidden' } });
			}
			await sent.settle();

			expectUnchanged(before);
			expect(lines()).toEqual(linesBefore);
			expect(sentOut(sent)).toEqual(NOTHING_OUT);
		});

		it('still refuses an administrator the export, the import and Reset Everything, and lets the superadmin through each', async () => {
			const s = scene();
			const before = snapshotDb();

			for (const { method, path, body } of SUPERADMIN_ROUTES) {
				const res = await api(method, path, { ...asWho(s, 'admin'), ...(body === undefined ? {} : { body }) });
				expect({ path, status: res.status, body: res.body }).toEqual({ path, status: 403, body: { message: SUPERADMIN_ONLY } });
			}
			expectUnchanged(before);

			const exported = await api('GET', '/api/admin/export', asWho(s, 'chief'));
			expect(exported.status).toBe(200);
			// Let past who may import, and refused for what it was sent: not a backup.
			const imported = await api('POST', '/api/admin/import', { ...asWho(s, 'chief'), body: { notABackup: true } });
			expect(imported.status).toBe(400);
			const reset = await api('POST', '/api/admin/reset', asWho(s, 'chief'));
			expect(reset.status, JSON.stringify(reset.body)).toBe(200);
		});

		it('lets the superadmin made an administrator through the mail and backup settings, and refuses them the export, the import and Reset Everything', async () => {
			const s = scene();
			db.update(users).set({ role: 'admin' }).where(eq(users.id, s.chief.id)).run();
			const asLowered = { user: { ...s.chief, role: 'admin' }, credential: { kind: 'session' as const, token: s.sessions.chief } };

			const before = snapshotDb();
			for (const { method, path, body } of SUPERADMIN_ROUTES) {
				const res = await api(method, path, { ...asLowered, ...(body === undefined ? {} : { body }) });
				expect({ path, status: res.status, body: res.body }).toEqual({ path, status: 403, body: { message: SUPERADMIN_ONLY } });
			}
			expectUnchanged(before);

			// Raised: lowering it is the superadmin's alone (card 2398), and they are an administrator now.
			expect((await api('PUT', '/api/admin/backup', { ...asLowered, body: { retention: 9 } })).status).toBe(200);
			expect((await api('PUT', '/api/admin/smtp', { ...asLowered, body: { fromName: 'Lowered' } })).status).toBe(200);
			expect((await api('GET', '/api/admin/smtp', asLowered)).body.fromName).toBe('Lowered');
		});

		it('masks every secret for an administrator as for the superadmin, and refuses an administrator a masked secret pointed elsewhere', async () => {
			const s = scene();
			db.insert(settings).values([{ key: 'smtp_user', value: 'mailer' }, { key: 'smtp_pass', value: 'mail-secret-2395' }]).run();

			for (const who of ['admin', 'chief'] as const) {
				const mail = await api('GET', '/api/admin/smtp', asWho(s, who));
				expect({ who, status: mail.status, pass: mail.body.pass }).toEqual({ who, status: 200, pass: SECRET_MASK });
				expect(JSON.stringify(mail.body)).not.toContain('mail-secret-2395');
				const backup = await api('GET', '/api/admin/backup', asWho(s, who));
				expect(backup.status).toBe(200);
				expect(backup.body.destinations.map((d: Record<string, string>) => d.secretAccessKey ?? d.clientSecret)).toEqual([SECRET_MASK, SECRET_MASK]);
				expect(JSON.stringify(backup.body)).not.toMatch(/bucket-secret-2253|g-client-secret-2253/);
			}

			const before = snapshotDb();
			const sent = effects();
			onTestFinished(() => sent.restore());
			const pointedElsewhere: ['PUT' | 'POST', string, unknown][] = [
				['PUT', '/api/admin/smtp', { host: 'smtp.elsewhere.example.test', pass: SECRET_MASK }],
				['PUT', '/api/admin/backup', { destinations: [{ ...BUCKET, bucket: 'somewhere-else', secretAccessKey: SECRET_MASK }, { ...DRIVE, clientSecret: SECRET_MASK }] }],
				['POST', '/api/admin/backup/test', { ...BUCKET, bucket: 'somewhere-else', secretAccessKey: SECRET_MASK }]
			];
			for (const [method, path, body] of pointedElsewhere) {
				const res = await api(method, path, { ...asWho(s, 'admin'), body });
				expect({ path, status: res.status }).toEqual({ path, status: 400 });
			}
			await sent.settle();
			expectUnchanged(before);
			expect(sentOut(sent)).toEqual(NOTHING_OUT);
		});

		it('removes the folder it made and saves nothing when the administrator is made a user while Google answers', async () => {
			const s = scene();
			const state = await beginAs(s, 'admin');
			exchange(() => void db.update(users).set({ role: 'user' }).where(eq(users.id, s.admin.id)).run());
			const linesBefore = lines();

			const res = await api('POST', '/api/admin/backup/gdrive/auth', { ...asWho(s, 'admin'), body: { code: 'the-code', state, destName: 'G' } });

			expect({ status: res.status, body: res.body }).toEqual({ status: 403, body: { message: 'Forbidden' } });
			expect(getToken).toHaveBeenCalledTimes(1);
			expect(files.create).toHaveBeenCalledTimes(1);
			expect(files.delete).toHaveBeenCalledTimes(1);
			expect(storedDrive()).toEqual(DRIVE);
			expect(lines()).toEqual(linesBefore);
		});
	});
});

// ─── The boards side of /api/v1 (slice 2253-6) ──────────────────────────────

describe('the boards side of /api/v1 asks at the write (slice 2253-6)', () => {
	/**
	 * A board its owner owns, filed under a grouping, with a label, a category
	 * and a webhook on it, a card category that belongs to no board, and the
	 * owner's API key and session. The gate lets only keys into /api/v1; a
	 * session reaches these handlers from the internal pages' helpers, and is
	 * handed to them here through `api()`. The rate limits are reset, as every
	 * test's key may have the same row id.
	 */
	const scene = () => {
		resetAllRateLimits();
		const owner = makeUser({ username: 'owner' });
		const { board, cols } = makeBoard({ owner, name: 'Owned' });
		const grouping = db.insert(boardCategories).values({ name: 'Grouped' }).returning().get();
		db.update(boards).set({ categoryId: grouping.id }).where(eq(boards.id, board.id)).run();
		const label = makeLabel(board);
		const category = db.insert(categories).values({ boardId: board.id, name: 'Kind' }).returning().get();
		const shared = db.insert(categories).values({ boardId: null, name: 'Shared' }).returning().get();
		makeWebhook(board);
		return { owner, board, cols, grouping, label, category, shared, key: makeApiKey(owner), session: makeSession(owner) };
	};
	type Scene = ReturnType<typeof scene>;
	type Method = 'POST' | 'PUT' | 'DELETE';

	/**
	 * Every request of the slice that carries a JSON body, what it answers
	 * when nothing ends meanwhile, and the webhook it then fires.
	 */
	const HELD: { shape: string; method: Method; path: (s: Scene) => string; body: (s: Scene) => unknown; allowed: number; fires?: string[] }[] = [
		{
			shape: 'a board made, owned by the caller (POST /api/v1/boards)',
			method: 'POST',
			path: () => '/api/v1/boards',
			body: () => ({ name: 'Late' }),
			allowed: 201
		},
		{
			shape: 'a board changed, with its activity entry (PUT /api/v1/boards/:boardId)',
			method: 'PUT',
			path: (s) => `/api/v1/boards/${s.board.id}`,
			body: () => ({ name: 'Renamed late' }),
			allowed: 200
		},
		{
			shape: 'a card made, its webhook fired once it has committed (POST /api/v1/boards/:boardId/cards)',
			method: 'POST',
			path: (s) => `/api/v1/boards/${s.board.id}/cards`,
			body: (s) => ({ columnId: s.cols['To Do'].id, title: 'Late' }),
			allowed: 201,
			fires: ['card.created']
		},
		{
			shape: 'a category made on the board in its path (POST /api/v1/boards/:boardId/categories)',
			method: 'POST',
			path: (s) => `/api/v1/boards/${s.board.id}/categories`,
			body: () => ({ name: 'Late' }),
			allowed: 201
		},
		{
			shape: 'a column made on the board in its path (POST /api/v1/boards/:boardId/columns)',
			method: 'POST',
			path: (s) => `/api/v1/boards/${s.board.id}/columns`,
			body: () => ({ title: 'Late' }),
			allowed: 201
		},
		{
			shape: 'a label made on the board in its path (POST /api/v1/boards/:boardId/labels)',
			method: 'POST',
			path: (s) => `/api/v1/boards/${s.board.id}/labels`,
			body: () => ({ name: 'Late' }),
			allowed: 201
		},
		{
			shape: 'a grouping made, which had no transaction (POST /api/v1/board-categories)',
			method: 'POST',
			path: () => '/api/v1/board-categories',
			body: () => ({ name: 'Late' }),
			allowed: 201
		},
		{
			shape: 'a grouping changed (PUT /api/v1/board-categories/:categoryId)',
			method: 'PUT',
			path: (s) => `/api/v1/board-categories/${s.grouping.id}`,
			body: () => ({ name: 'Renamed late' }),
			allowed: 200
		},
		{
			shape: 'a category changed (PUT /api/v1/categories/:categoryId)',
			method: 'PUT',
			path: (s) => `/api/v1/categories/${s.category.id}`,
			body: () => ({ name: 'Renamed late' }),
			allowed: 200
		},
		{
			shape: 'a column changed (PUT /api/v1/columns/:columnId)',
			method: 'PUT',
			path: (s) => `/api/v1/columns/${s.cols['On Hold'].id}`,
			body: () => ({ title: 'Waiting' }),
			allowed: 200
		},
		{
			shape: 'a label changed (PUT /api/v1/labels/:labelId)',
			method: 'PUT',
			path: (s) => `/api/v1/labels/${s.label.id}`,
			body: () => ({ name: 'Renamed late' }),
			allowed: 200
		}
	];

	for (const c of HELD) {
		it(`refuses 401, writes nothing and fires nothing, when the API key is revoked while the body arrives: ${c.shape}`, async () => {
			const s = scene();
			const sent = effects();
			let before: DbSnapshot | undefined;

			try {
				const res = await sendAround(c.method, c.path(s), { key: s.key }, c.body(s), () => {
					db.delete(apiKeys).where(eq(apiKeys.id, keyRow(s.key).id)).run();
					before = snapshotDb();
				});
				await sent.settle();

				expect(res).toEqual({ status: 401, body: { message: 'Invalid or expired API key' } });
				expect(before).toBeDefined();
				expectUnchanged(before!);
				expect(sent.webhooks).toEqual([]);
				expect(sent.events).toEqual([]);
			} finally {
				sent.restore();
			}
		});

		it(`lets it through, sent the same way, when nothing ended meanwhile: ${c.shape}`, async () => {
			const s = scene();
			const sent = effects();
			try {
				const res = await sendAround(c.method, c.path(s), { key: s.key }, c.body(s), () => {});
				await sent.settle();
				expect(res.status, JSON.stringify(res.body)).toBe(c.allowed);
				expect(sent.webhooks.map((w) => w.event)).toEqual(c.fires ?? []);
			} finally {
				sent.restore();
			}
		});
	}

	it('refuses 401, and writes nothing, each request with a body handed a session that has ended', async () => {
		const s = scene();
		const credential = { kind: 'session' as const, token: s.session };
		db.delete(sessions).run();
		const before = snapshotDb();
		const sent = effects();
		onTestFinished(() => sent.restore());

		for (const c of HELD) {
			const res = await api(c.method, c.path(s), { user: s.owner, credential, body: c.body(s) });
			expect({ shape: c.shape, status: res.status, body: res.body }).toEqual({ shape: c.shape, status: 401, body: { message: 'Not authenticated' } });
		}
		await sent.settle();

		expectUnchanged(before);
		expect(sent.webhooks).toEqual([]);
		expect(sent.events).toEqual([]);
	});

	/** The deletes, which have no body to hold, in an order each can run in: the board last. */
	const UNHELD = (s: Scene): string[] => [
		`/api/v1/labels/${s.label.id}`,
		`/api/v1/categories/${s.category.id}`,
		`/api/v1/columns/${s.cols['On Hold'].id}`,
		`/api/v1/board-categories/${s.grouping.id}`,
		`/api/v1/boards/${s.board.id}`
	];

	it('refuses 401, in the words for each, and changes nothing, a delete whose API key or session has ended', async () => {
		const s = scene();
		const keyCredential = { kind: 'api key' as const, id: keyRow(s.key).id };
		const sessionCredential = { kind: 'session' as const, token: s.session };
		db.delete(apiKeys).run();
		db.delete(sessions).run();
		const before = snapshotDb();
		const sent = effects();
		onTestFinished(() => sent.restore());

		for (const path of UNHELD(s)) {
			const byKey = await api('DELETE', path, { user: s.owner, credential: keyCredential });
			expect({ path, status: byKey.status, body: byKey.body }).toEqual({ path, status: 401, body: { message: 'Invalid or expired API key' } });
			const bySession = await api('DELETE', path, { user: s.owner, credential: sessionCredential });
			expect({ path, status: bySession.status, body: bySession.body }).toEqual({ path, status: 401, body: { message: 'Not authenticated' } });
		}
		await sent.settle();

		expectUnchanged(before);
		expect(sent.events).toEqual([]);
	});

	it('lets each delete through when the key is still open', async () => {
		const s = scene();
		const credential = { kind: 'api key' as const, id: keyRow(s.key).id };

		for (const path of UNHELD(s)) {
			const res = await api('DELETE', path, { user: s.owner, credential });
			expect({ path, status: res.status }).toEqual({ path, status: 200 });
		}
		expect(db.select().from(boards).all()).toEqual([]);
	});

	it("decides with the account as it is now: an administrator's key, the administrator lowered to user meanwhile, is refused as a user is, and nothing written", async () => {
		const s = scene();
		const card = makeCard(s.cols['To Do']);
		const admin = makeUser({ username: 'was-admin', role: 'admin' });
		const credential = { kind: 'api key' as const, id: keyRow(makeApiKey(admin)).id };
		db.update(users).set({ role: 'user' }).where(eq(users.id, admin.id)).run();
		const before = snapshotDb();
		const sent = effects();
		onTestFinished(() => sent.restore());
		const NO_EDIT = 'No edit access to this board';
		const NO_BOARD = 'Only an administrator can change a category that belongs to no board';
		const GROUPED = 'This category groups boards you cannot edit';

		const refusals: [Method, string, unknown, string][] = [
			['POST', '/api/v1/boards', { name: 'Under the card', parentCardId: card.id }, "No edit access to the parent card's board"],
			['PUT', `/api/v1/boards/${s.board.id}`, { name: 'Taken over' }, NO_EDIT],
			['DELETE', `/api/v1/boards/${s.board.id}`, undefined, 'Only board owners and admins can delete boards'],
			['POST', `/api/v1/boards/${s.board.id}/cards`, { columnId: s.cols['To Do'].id, title: 'By an administrator' }, NO_EDIT],
			['POST', `/api/v1/boards/${s.board.id}/categories`, { name: 'By an administrator' }, NO_EDIT],
			['POST', `/api/v1/boards/${s.board.id}/columns`, { title: 'By an administrator' }, NO_EDIT],
			['POST', `/api/v1/boards/${s.board.id}/labels`, { name: 'By an administrator' }, NO_EDIT],
			['PUT', `/api/v1/board-categories/${s.grouping.id}`, { name: 'Taken over' }, GROUPED],
			['DELETE', `/api/v1/board-categories/${s.grouping.id}`, undefined, GROUPED],
			['PUT', `/api/v1/categories/${s.category.id}`, { name: 'Taken over' }, NO_EDIT],
			['PUT', `/api/v1/categories/${s.shared.id}`, { name: 'Taken over' }, NO_BOARD],
			['DELETE', `/api/v1/categories/${s.shared.id}`, undefined, NO_BOARD],
			['PUT', `/api/v1/columns/${s.cols['On Hold'].id}`, { title: 'Taken over' }, NO_EDIT],
			['DELETE', `/api/v1/columns/${s.cols['On Hold'].id}`, undefined, NO_EDIT],
			['PUT', `/api/v1/labels/${s.label.id}`, { name: 'Taken over' }, NO_EDIT],
			['DELETE', `/api/v1/labels/${s.label.id}`, undefined, NO_EDIT]
		];
		for (const [method, path, body, message] of refusals) {
			const res = await api(method, path, { user: admin, credential, ...(body === undefined ? {} : { body }) });
			expect({ method, path, status: res.status, body: res.body }).toEqual({ method, path, status: 403, body: { message } });
		}
		await sent.settle();

		expectUnchanged(before);
		expect(sent.webhooks).toEqual([]);
		expect(sent.events).toEqual([]);
	});

	it("decides with the account as it is now, through the gate: an administrator's key, lowered while the card's body arrives, is refused 403 and fires no webhook", async () => {
		const s = scene();
		const admin = makeUser({ username: 'was-admin', role: 'admin' });
		const key = makeApiKey(admin);
		const sent = effects();
		onTestFinished(() => sent.restore());
		let before: DbSnapshot | undefined;

		const res = await sendAround('POST', `/api/v1/boards/${s.board.id}/cards`, { key }, { columnId: s.cols['To Do'].id, title: 'Late' }, () => {
			db.update(users).set({ role: 'user' }).where(eq(users.id, admin.id)).run();
			before = snapshotDb();
		});
		await sent.settle();

		expect(res).toEqual({ status: 403, body: { message: 'No edit access to this board' } });
		expectUnchanged(before!);
		expect(sent.webhooks).toEqual([]);
	});
});

// ─── The cards side of /api/v1 (slice 2253-7) ───────────────────────────────

describe('the cards side of /api/v1 asks at the write (slice 2253-7)', () => {
	/**
	 * A board its owner owns, with a webhook on it and four cards. Card A has
	 * subtask S, a label on it and another on the board for it, the owner
	 * assigned, the owner's comment, and a token entry; A waits on B, and S
	 * waits on C. A and D are in the board's milestone. The owner's API key and
	 * session. The gate lets only keys into /api/v1; a session reaches these
	 * handlers from the internal pages' helpers, and is handed to them here
	 * through `api()`. The rate limits are reset, as every test's key may have
	 * the same row id.
	 */
	const scene = () => {
		resetAllRateLimits();
		const owner = makeUser({ username: 'owner' });
		const { board, cols } = makeBoard({ owner, name: 'Owned' });
		const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((title) => makeCard(cols['To Do'], { title }));
		const subtask = makeSubtask(a, { title: 'S' });
		const onCard = makeLabel(board, 'On A');
		const offCard = makeLabel(board, 'For A');
		db.insert(cardLabels).values({ cardId: a.id, labelId: onCard.id }).run();
		assignCard(a, owner);
		const comment = makeComment(a, owner, 'First');
		const entry = db.insert(tokenUsage).values({ cardId: a.id, tokens: 500, model: 'claude-opus-5', reportedByUserId: owner.id }).returning().get();
		makeDependency({ blocked: a, blocker: b, createdBy: owner });
		makeDependency({ blocked: subtask, blocker: c, createdBy: owner });
		const milestone = makeMilestone({ board, name: 'Goal', createdBy: owner, cards: [a, d] });
		makeWebhook(board);
		return {
			owner,
			board,
			cols,
			a,
			b,
			c,
			d,
			subtask,
			onCard,
			offCard,
			comment,
			entry,
			milestone,
			key: makeApiKey(owner),
			session: makeSession(owner)
		};
	};
	type Scene = ReturnType<typeof scene>;
	type Method = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

	/**
	 * Every request of the slice that carries a JSON body, what it answers
	 * when nothing ends meanwhile, and the webhooks it then fires. The three
	 * batches carry two items each, so that a refusal is seen to write none.
	 */
	const HELD: { shape: string; method: Method; path: (s: Scene) => string; body: (s: Scene) => unknown; allowed: number; fires?: string[] }[] = [
		{
			shape: 'a card changed, its webhook fired once it has committed (PUT /api/v1/cards/:cardId)',
			method: 'PUT',
			path: (s) => `/api/v1/cards/${s.a.id}`,
			body: () => ({ title: 'Renamed late' }),
			allowed: 200,
			fires: ['card.updated']
		},
		{
			shape: 'an account assigned, its mail worked out in the transaction (POST /api/v1/cards/:cardId/assignees)',
			method: 'POST',
			path: (s) => `/api/v1/cards/${s.b.id}/assignees`,
			body: (s) => ({ userId: s.owner.id }),
			allowed: 200
		},
		{
			shape: 'an assignee taken off (DELETE /api/v1/cards/:cardId/assignees)',
			method: 'DELETE',
			path: (s) => `/api/v1/cards/${s.a.id}/assignees`,
			body: (s) => ({ userId: s.owner.id }),
			allowed: 200
		},
		{
			shape: 'a comment, answered naming the commenter as they are now (POST /api/v1/cards/:cardId/comments)',
			method: 'POST',
			path: (s) => `/api/v1/cards/${s.a.id}/comments`,
			body: () => ({ content: 'Late' }),
			allowed: 201,
			fires: ['comment.added']
		},
		{
			shape: 'a dependency recorded, the graph read in the transaction (POST /api/v1/cards/:cardId/dependencies)',
			method: 'POST',
			path: (s) => `/api/v1/cards/${s.b.id}/dependencies`,
			body: (s) => ({ dependsOnCardId: s.c.id }),
			allowed: 201
		},
		{
			shape: 'a dependency removed (DELETE /api/v1/cards/:cardId/dependencies)',
			method: 'DELETE',
			path: (s) => `/api/v1/cards/${s.a.id}/dependencies`,
			body: (s) => ({ dependsOnCardId: s.b.id }),
			allowed: 200
		},
		{
			shape: 'a label put on, answered once it has committed (POST /api/v1/cards/:cardId/labels)',
			method: 'POST',
			path: (s) => `/api/v1/cards/${s.a.id}/labels`,
			body: (s) => ({ labelId: s.offCard.id }),
			allowed: 201
		},
		{
			shape: 'a label taken off (DELETE /api/v1/cards/:cardId/labels)',
			method: 'DELETE',
			path: (s) => `/api/v1/cards/${s.a.id}/labels`,
			body: (s) => ({ labelId: s.onCard.id }),
			allowed: 200
		},
		{
			shape: 'a card moved to Complete, inside the move\'s catch, its webhooks fired once it has committed (PUT /api/v1/cards/:cardId/move)',
			method: 'PUT',
			path: (s) => `/api/v1/cards/${s.b.id}/move`,
			body: (s) => ({ columnId: s.cols.Complete.id }),
			allowed: 200,
			fires: ['card.completed']
		},
		{
			shape: 'a subtask made (POST /api/v1/cards/:cardId/subtasks)',
			method: 'POST',
			path: (s) => `/api/v1/cards/${s.a.id}/subtasks`,
			body: () => ({ title: 'Late' }),
			allowed: 201
		},
		{
			shape: "a card's tokens recorded, which had no transaction (POST /api/v1/cards/:cardId/tokens)",
			method: 'POST',
			path: (s) => `/api/v1/cards/${s.a.id}/tokens`,
			body: () => ({ tokens: 1000, model: 'claude-opus-5' }),
			allowed: 201
		},
		{
			shape: 'a comment changed (PUT /api/v1/comments/:commentId)',
			method: 'PUT',
			path: (s) => `/api/v1/comments/${s.comment.id}`,
			body: () => ({ content: 'Changed late' }),
			allowed: 200
		},
		{
			shape: 'two dependencies in a batch, written whole or not at all (POST /api/v1/dependencies/bulk)',
			method: 'POST',
			path: () => '/api/v1/dependencies/bulk',
			body: (s) => ({ links: [{ blocked: s.b.id, blocker: s.c.id }, { blocked: s.b.id, blocker: s.d.id }] }),
			allowed: 201
		},
		{
			shape: 'a milestone made on the board (POST /api/v1/milestones)',
			method: 'POST',
			path: () => '/api/v1/milestones',
			body: (s) => ({ name: 'Late', boardId: s.board.id }),
			allowed: 201
		},
		{
			shape: "a milestone changed, the service's transaction a savepoint (PATCH /api/v1/milestones/:milestoneId)",
			method: 'PATCH',
			path: (s) => `/api/v1/milestones/${s.milestone.id}`,
			body: () => ({ name: 'Renamed late' }),
			allowed: 200
		},
		{
			shape: 'a card put in the milestone, which had no transaction (POST /api/v1/milestones/:milestoneId/cards)',
			method: 'POST',
			path: (s) => `/api/v1/milestones/${s.milestone.id}/cards`,
			body: (s) => ({ cardId: s.b.id }),
			allowed: 200,
			// A card put in a goal or taken out sends its own event (card 2343).
			fires: ['milestone.card_added']
		},
		{
			shape: 'a card taken out of the milestone (DELETE /api/v1/milestones/:milestoneId/cards)',
			method: 'DELETE',
			path: (s) => `/api/v1/milestones/${s.milestone.id}/cards`,
			body: (s) => ({ cardId: s.a.id }),
			allowed: 200,
			fires: ['milestone.card_removed']
		},
		{
			shape: 'two cards put in the milestone in a batch (POST /api/v1/milestones/:milestoneId/cards/bulk)',
			method: 'POST',
			path: (s) => `/api/v1/milestones/${s.milestone.id}/cards/bulk`,
			body: (s) => ({ cardIds: [s.b.id, s.c.id] }),
			allowed: 200,
			fires: ['milestone.card_added', 'milestone.card_added']
		},
		{
			shape: 'two cards taken out of the milestone in a batch (DELETE /api/v1/milestones/:milestoneId/cards/bulk)',
			method: 'DELETE',
			path: (s) => `/api/v1/milestones/${s.milestone.id}/cards/bulk`,
			body: (s) => ({ cardIds: [s.a.id, s.d.id] }),
			allowed: 200,
			fires: ['milestone.card_removed', 'milestone.card_removed']
		},
		{
			shape: 'a subtask ticked, its notices and mail queued on the commit (PUT /api/v1/subtasks/:subtaskId)',
			method: 'PUT',
			path: (s) => `/api/v1/subtasks/${s.subtask.id}`,
			body: () => ({ completed: true }),
			allowed: 200
		},
		{
			shape: "a subtask's dependency recorded, the service's transaction a savepoint (POST /api/v1/subtasks/:subtaskId/dependencies)",
			method: 'POST',
			path: (s) => `/api/v1/subtasks/${s.subtask.id}/dependencies`,
			body: (s) => ({ dependsOnCardId: s.b.id }),
			allowed: 201
		},
		{
			shape: "a subtask's dependency removed (DELETE /api/v1/subtasks/:subtaskId/dependencies)",
			method: 'DELETE',
			path: (s) => `/api/v1/subtasks/${s.subtask.id}/dependencies`,
			body: (s) => ({ dependsOnCardId: s.c.id }),
			allowed: 200
		},
		{
			shape: "a subtask's tokens recorded, which had no transaction (POST /api/v1/subtasks/:subtaskId/tokens)",
			method: 'POST',
			path: (s) => `/api/v1/subtasks/${s.subtask.id}/tokens`,
			body: () => ({ tokens: 900, model: 'claude-sonnet-5' }),
			allowed: 201
		},
		{
			shape: 'two token entries in a batch (POST /api/v1/tokens/bulk)',
			method: 'POST',
			path: () => '/api/v1/tokens/bulk',
			body: (s) => ({ entries: [{ cardId: s.a.id, tokens: 100 }, { subtaskId: s.subtask.id, tokens: 50 }] }),
			allowed: 201
		}
	];

	for (const c of HELD) {
		it(`refuses 401, writes nothing and fires nothing, when the API key is revoked while the body arrives: ${c.shape}`, async () => {
			const s = scene();
			const sent = effects();
			let before: DbSnapshot | undefined;

			try {
				const res = await sendAround(c.method, c.path(s), { key: s.key }, c.body(s), () => {
					db.delete(apiKeys).where(eq(apiKeys.id, keyRow(s.key).id)).run();
					before = snapshotDb();
				});
				await sent.settle();

				expect(res).toEqual({ status: 401, body: { message: 'Invalid or expired API key' } });
				expect(before).toBeDefined();
				expectUnchanged(before!);
				expect(sent.webhooks).toEqual([]);
				expect(sent.events).toEqual([]);
				expect(sent.emails).toEqual([]);
			} finally {
				sent.restore();
			}
		});

		it(`lets it through, sent the same way, when nothing ended meanwhile: ${c.shape}`, async () => {
			const s = scene();
			const sent = effects();
			try {
				const res = await sendAround(c.method, c.path(s), { key: s.key }, c.body(s), () => {});
				await sent.settle();
				expect(res.status, JSON.stringify(res.body)).toBe(c.allowed);
				expect(sent.webhooks.map((w) => w.event)).toEqual(c.fires ?? []);
			} finally {
				sent.restore();
			}
		});
	}

	it('refuses 401, and writes nothing, each request with a body handed a session that has ended', async () => {
		const s = scene();
		const credential = { kind: 'session' as const, token: s.session };
		db.delete(sessions).run();
		const before = snapshotDb();
		const sent = effects();
		onTestFinished(() => sent.restore());

		for (const c of HELD) {
			const res = await api(c.method, c.path(s), { user: s.owner, credential, body: c.body(s) });
			expect({ shape: c.shape, status: res.status, body: res.body }).toEqual({ shape: c.shape, status: 401, body: { message: 'Not authenticated' } });
		}
		await sent.settle();

		expectUnchanged(before);
		expect(sent.webhooks).toEqual([]);
		expect(sent.events).toEqual([]);
	});

	/** The deletes, which have no body to hold, in an order each can run in: the archive and then the permanent delete last. */
	const UNHELD = (s: Scene): string[] => [
		// New with card 2283.
		`/api/v1/comments/${s.comment.id}`,
		`/api/v1/tokens/${s.entry.id}`,
		`/api/v1/subtasks/${s.subtask.id}`,
		`/api/v1/milestones/${s.milestone.id}`,
		`/api/v1/cards/${s.c.id}`,
		`/api/v1/cards/${s.d.id}?permanent=true`
	];

	it('refuses 401, in the words for each, and changes nothing, a delete whose API key or session has ended', async () => {
		const s = scene();
		const keyCredential = { kind: 'api key' as const, id: keyRow(s.key).id };
		const sessionCredential = { kind: 'session' as const, token: s.session };
		db.delete(apiKeys).run();
		db.delete(sessions).run();
		const before = snapshotDb();
		const sent = effects();
		onTestFinished(() => sent.restore());

		for (const path of UNHELD(s)) {
			const byKey = await api('DELETE', path, { user: s.owner, credential: keyCredential });
			expect({ path, status: byKey.status, body: byKey.body }).toEqual({ path, status: 401, body: { message: 'Invalid or expired API key' } });
			const bySession = await api('DELETE', path, { user: s.owner, credential: sessionCredential });
			expect({ path, status: bySession.status, body: bySession.body }).toEqual({ path, status: 401, body: { message: 'Not authenticated' } });
		}
		await sent.settle();

		expectUnchanged(before);
		expect(sent.webhooks).toEqual([]);
		expect(sent.events).toEqual([]);
	});

	it('lets each delete through when the key is still open, the permanent delete firing its webhook', async () => {
		const s = scene();
		const credential = { kind: 'api key' as const, id: keyRow(s.key).id };
		const sent = effects();
		onTestFinished(() => sent.restore());

		for (const path of UNHELD(s)) {
			const res = await api('DELETE', path, { user: s.owner, credential });
			expect({ path, status: res.status }).toEqual({ path, status: 200 });
		}
		await sent.settle();

		expect(db.select().from(tokenUsage).all()).toEqual([]);
		expect(db.select().from(cardComments).all()).toEqual([]);
		// The archive, of a card in To Do, is `card_abandoned` (milestone 22, ruling
		// f), which fires none, as `card_archived` does not, and a comment deleted
		// is `comment_deleted`, which fires none either (card 2283). The milestone
		// deleted releases its two cards, each `milestone.card_removed` (card 2381).
		expect(sent.webhooks.map((w) => w.event)).toEqual(['milestone.card_removed', 'milestone.card_removed', 'card.deleted']);
	});

	it("decides with the account as it is now: an administrator's key, the administrator lowered to user meanwhile, is refused as a user is, and nothing written", async () => {
		const s = scene();
		const admin = makeUser({ username: 'was-admin', role: 'admin' });
		const credential = { kind: 'api key' as const, id: keyRow(makeApiKey(admin)).id };
		db.update(users).set({ role: 'user' }).where(eq(users.id, admin.id)).run();
		const before = snapshotDb();
		const sent = effects();
		onTestFinished(() => sent.restore());
		const CARD = "No edit access to this card's board";
		const SUBTASK = "No edit access to this subtask's board";
		const MILESTONE = 'No access to this milestone';

		// Each request with a body, as HELD sends it, and the deletes, with the
		// refusal a user who is on nothing of the owner's is given.
		const bodies = new Map(HELD.map((c) => [`${c.method} ${c.path(s)}`, c.body(s)]));
		const refusals: [Method, string, number, unknown][] = [
			['PUT', `/api/v1/cards/${s.a.id}`, 403, { message: CARD }],
			['DELETE', `/api/v1/cards/${s.c.id}`, 403, { message: CARD }],
			['POST', `/api/v1/cards/${s.b.id}/assignees`, 403, { message: CARD }],
			['DELETE', `/api/v1/cards/${s.a.id}/assignees`, 403, { message: 'No edit access' }],
			['POST', `/api/v1/cards/${s.a.id}/comments`, 403, { message: 'No edit access' }],
			['POST', `/api/v1/cards/${s.b.id}/dependencies`, 403, { message: CARD }],
			['DELETE', `/api/v1/cards/${s.a.id}/dependencies`, 403, { message: "No access to this card's board" }],
			['POST', `/api/v1/cards/${s.a.id}/labels`, 403, { message: 'No edit access to this board' }],
			['DELETE', `/api/v1/cards/${s.a.id}/labels`, 403, { message: 'No edit access to this board' }],
			['PUT', `/api/v1/cards/${s.b.id}/move`, 403, { message: 'No edit access to this board' }],
			['POST', `/api/v1/cards/${s.a.id}/subtasks`, 403, { message: CARD }],
			['POST', `/api/v1/cards/${s.a.id}/tokens`, 403, { message: `No edit access to the board holding card #${s.a.id}` }],
			['PUT', `/api/v1/comments/${s.comment.id}`, 403, { message: 'No edit access to this board' }],
			// The board is asked about before whose comment it is (card 2283).
			['DELETE', `/api/v1/comments/${s.comment.id}`, 403, { message: 'No edit access to this board' }],
			['POST', '/api/v1/milestones', 403, { message: 'No edit access to that board' }],
			['PATCH', `/api/v1/milestones/${s.milestone.id}`, 403, { message: MILESTONE }],
			['DELETE', `/api/v1/milestones/${s.milestone.id}`, 403, { message: MILESTONE }],
			['POST', `/api/v1/milestones/${s.milestone.id}/cards`, 403, { message: MILESTONE }],
			['DELETE', `/api/v1/milestones/${s.milestone.id}/cards`, 403, { message: MILESTONE }],
			['POST', `/api/v1/milestones/${s.milestone.id}/cards/bulk`, 403, { message: MILESTONE }],
			['DELETE', `/api/v1/milestones/${s.milestone.id}/cards/bulk`, 403, { message: MILESTONE }],
			['PUT', `/api/v1/subtasks/${s.subtask.id}`, 403, { message: SUBTASK }],
			['DELETE', `/api/v1/subtasks/${s.subtask.id}`, 403, { message: SUBTASK }],
			['POST', `/api/v1/subtasks/${s.subtask.id}/dependencies`, 403, { message: SUBTASK }],
			// The subtask in the path need only be readable for a removal, as the card route's DELETE.
			['DELETE', `/api/v1/subtasks/${s.subtask.id}/dependencies`, 403, { message: 'No access' }],
			['POST', `/api/v1/subtasks/${s.subtask.id}/tokens`, 403, { message: `No edit access to the board holding subtask #${s.subtask.id}` }],
			['DELETE', `/api/v1/tokens/${s.entry.id}`, 403, { message: `No edit access to the board holding card #${s.a.id}` }]
		];
		for (const [method, path, status, answer] of refusals) {
			const body = bodies.get(`${method} ${path}`);
			const res = await api(method, path, { user: admin, credential, ...(body === undefined ? {} : { body }) });
			expect({ method, path, status: res.status, body: res.body }).toEqual({ method, path, status, body: answer });
		}

		// The two batches that answer every problem at once are refused whole, 409.
		const links = await api('POST', '/api/v1/dependencies/bulk', { user: admin, credential, body: bodies.get('POST /api/v1/dependencies/bulk') });
		expect(links.status).toBe(409);
		expect(links.body).toMatchObject({ message: 'Batch rejected — nothing was written', written: 0, wouldCreate: 0 });
		expect(links.body.forbidden).toHaveLength(2);
		const spent = await api('POST', '/api/v1/tokens/bulk', { user: admin, credential, body: bodies.get('POST /api/v1/tokens/bulk') });
		expect(spent.status).toBe(409);
		expect(spent.body).toMatchObject({ message: 'Batch rejected — nothing was written', written: 0 });
		expect(spent.body.problems.map((p: { index: number }) => p.index)).toEqual([0, 1]);
		await sent.settle();

		expectUnchanged(before);
		expect(sent.webhooks).toEqual([]);
		expect(sent.events).toEqual([]);
	});

	it("decides with the account as it is now, through the gate: an administrator's key, lowered while a move's body arrives, is refused 403 and fires no webhook", async () => {
		const s = scene();
		const admin = makeUser({ username: 'was-admin', role: 'admin' });
		const key = makeApiKey(admin);
		const sent = effects();
		onTestFinished(() => sent.restore());
		let before: DbSnapshot | undefined;

		const res = await sendAround('PUT', `/api/v1/cards/${s.b.id}/move`, { key }, { columnId: s.cols.Complete.id }, () => {
			db.update(users).set({ role: 'user' }).where(eq(users.id, admin.id)).run();
			before = snapshotDb();
		});
		await sent.settle();

		expect(res).toEqual({ status: 403, body: { message: 'No edit access to this board' } });
		expectUnchanged(before!);
		expect(sent.webhooks).toEqual([]);
	});
});

// ─── No credential at all (R10) ─────────────────────────────────────────────

describe('a write that reaches its handler with no credential recorded by the gate', () => {
	const SCHEDULE = { name: 'Weekly', scope: 'all', frequency: 'weekly' };

	it('is let through under the tests, as a handler called directly is (the control)', async () => {
		const admin = makeUser({ role: 'admin' });

		expect((await api('POST', '/api/report-schedules', { user: admin, body: SCHEDULE })).status).toBe(201);
	});

	it('is refused 401 outside the tests, with exactly one ERROR line naming the request, and nothing written', async () => {
		vi.stubEnv('VITEST', '');
		const admin = makeUser({ role: 'admin' });
		sveltekit.event = { request: { method: 'POST' }, url: new URL('http://localhost/api/report-schedules'), route: { id: '/api/report-schedules' } };
		const before = snapshotDb();

		const res = await api('POST', '/api/report-schedules', { user: admin, body: SCHEDULE });

		expect(res.status).toBe(401);
		expect(res.body).toEqual({ message: 'Not authenticated' });
		expect(authErrors()).toEqual([
			'A write reached its handler with no credential recorded by the gate: POST /api/report-schedules; refused 401; ' +
				'this is a fault in DumpFire, not in the request: report this line'
		]);
		// Filed under the account the handler was given, with where it was asked from.
		const row = sqlite.prepare("SELECT user_id AS userId, meta FROM system_logs WHERE context = 'AUTH' AND level = 'ERROR'").get() as {
			userId: number | null;
			meta: string;
		};
		expect(row.userId).toBe(admin.id);
		const stack = JSON.parse(row.meta).stack as string;
		expect(stack).toContain('write-as');
		expect(stack.split('\n').length).toBeLessThanOrEqual(6);
		expectUnchanged(before);
	});

	it('says so when SvelteKit cannot name the request', async () => {
		vi.stubEnv('VITEST', '');
		const admin = makeUser({ role: 'admin' });

		const res = await api('POST', '/api/report-schedules', { user: admin, body: SCHEDULE });

		expect(res.status).toBe(401);
		expect(authErrors()).toEqual([
			'A write reached its handler with no credential recorded by the gate: a request SvelteKit could not name; refused 401; ' +
				'this is a fault in DumpFire, not in the request: report this line'
		]);
	});
});

describe('the gate records a credential, or null, on every request it hands on', () => {
	/**
	 * `handle` itself, given a request as SvelteKit gives it one and a stub
	 * for what it hands on to, which records `locals.credential`. Every branch
	 * that hands a request on, for each method: none may leave it undefined,
	 * which `stillAuthenticated` refuses outside the tests.
	 */
	const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

	function eventFor(method: string, path: string, routeId: string | null, headers: Record<string, string> = {}): RequestEvent {
		const url = new URL(path, 'http://localhost');
		const jar = new Map<string, string>();
		for (const pair of (headers.cookie ?? '').split(';')) {
			const at = pair.indexOf('=');
			if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
		}
		return {
			request: new Request(url, { method, headers }),
			url,
			params: {},
			route: { id: routeId },
			locals: {},
			cookies: {
				get: (name: string) => jar.get(name),
				getAll: () => [...jar].map(([name, value]) => ({ name, value })),
				set: () => {},
				delete: () => {},
				serialize: () => ''
			},
			getClientAddress: () => '127.0.0.1',
			setHeaders: () => {},
			platform: undefined,
			isDataRequest: false,
			isSubRequest: false,
			isRemoteRequest: false
		} as unknown as RequestEvent;
	}

	/** What each request handed on carried, as `[method, credential]`, or `'not handed on'`. */
	async function handedOn(path: string, routeId: string | null, headers: Record<string, string> = {}) {
		const seen: unknown[] = [];
		for (const method of METHODS) {
			let carried: unknown = 'not handed on';
			await handle({
				event: eventFor(method, path, routeId, { accept: 'application/json', ...headers }),
				resolve: async (event) => {
					carried = 'credential' in event.locals ? event.locals.credential : 'undefined';
					return json({});
				}
			});
			seen.push([method, carried]);
		}
		return seen;
	}
	const each = (credential: unknown) => METHODS.map((method) => [method, credential]);

	it('the set-up route, before there is a user', async () => {
		expect(await handedOn('/setup', '/setup')).toEqual(each(null));
	});

	it('a file under /_app/, which passes through unasked', async () => {
		makeUser();
		expect(await handedOn('/_app/immutable/start.js', null)).toEqual(each(null));
	});

	it('the OpenAPI document', async () => {
		makeUser();
		expect(await handedOn('/api/v1/openapi.json', '/api/v1/openapi.json')).toEqual(each(null));
	});

	it('a valid API key', async () => {
		const user = makeUser();
		const key = makeApiKey(user);
		expect(await handedOn('/api/v1/me', '/api/v1/me', { authorization: `Bearer ${key}` })).toEqual(
			each({ kind: 'api key', id: keyRow(key).id })
		);
	});

	it('a public route, with no session and with one', async () => {
		const user = makeUser();
		const token = makeSession(user);
		expect(await handedOn('/api/requests', '/api/requests')).toEqual(each(null));
		expect(await handedOn('/api/requests', '/api/requests', { cookie: `${SESSION_COOKIE_NAME}=${token}` })).toEqual(
			each({ kind: 'session', token })
		);
	});

	it('a signed-in session', async () => {
		const user = makeUser();
		const token = makeSession(user);
		expect(await handedOn('/api/cards', '/api/cards', { cookie: `${SESSION_COOKIE_NAME}=${token}` })).toEqual(
			each({ kind: 'session', token })
		);
	});
});

// ─── The report mail's second check (R1) ────────────────────────────────────

describe("the report mail asks again after its PDF is made, before it sends (R1)", () => {
	/**
	 * `POST /api/reports/email` builds its PDF with an await, and only then
	 * sends: a session ended while the PDF was made must send no mail. The
	 * route asks `stillCallerNow` after its body and again before the send
	 * (slice 2253-4); this was pinned with `it.fails` until it did.
	 */
	it('sends no mail, and answers 401, when the session ends after the PDF is made', { timeout: 30_000 }, async () => {
		const owner = makeUser({ username: 'owner' });
		const { board } = makeBoard({ owner, name: 'Reported' });
		const token = makeSession(owner);
		makeSmtp();
		const sent = effects();
		pdf.afterMade = () => void db.delete(sessions).where(eq(sessions.id, token)).run();

		let res;
		try {
			res = await api('POST', '/api/reports/email', {
				user: owner,
				credential: { kind: 'session', token },
				body: { scope: 'board', scopeId: board.id, periodStart: '2026-10-01', periodEnd: '2026-10-08', recipients: ['a@example.test'] }
			});
		} finally {
			sent.restore();
		}

		expect(res.status).toBe(401);
		expect(res.body).toEqual({ message: 'Not authenticated' });
		expect(sent.emails).toEqual([]);
	});

	it('sends the mail when the session is still open after the PDF is made (the control)', { timeout: 30_000 }, async () => {
		const owner = makeUser({ username: 'owner' });
		const { board } = makeBoard({ owner, name: 'Reported' });
		const token = makeSession(owner);
		makeSmtp();
		const sent = effects();

		let res;
		try {
			res = await api('POST', '/api/reports/email', {
				user: owner,
				credential: { kind: 'session', token },
				body: { scope: 'board', scopeId: board.id, periodStart: '2026-10-01', periodEnd: '2026-10-08', recipients: ['a@example.test'] }
			});
			await sent.settle();
		} finally {
			sent.restore();
		}

		expect(res.status).toBe(200);
		expect(sent.emails).toHaveLength(1);
	});

	/**
	 * The second check decides again, on the account as it is once the PDF is
	 * made, everything the mail relies on: an all-boards report by an
	 * administrator, a board's by someone who can open it, a grouping's by
	 * someone who can open every board in it that the PDF holds. Each is
	 * taken away after the PDF is made, as a role change or a removal
	 * committed meanwhile would; then the same with nothing taken (the
	 * controls).
	 */
	const reportMail = async (opts: {
		reader: SessionUser;
		body: Record<string, unknown>;
		meanwhile?: () => void;
	}) => {
		const token = makeSession(opts.reader);
		// Mail set up once a test, whichever call comes first.
		if (!db.select().from(settings).where(eq(settings.key, 'smtp_host')).get()) makeSmtp();
		const sent = effects();
		pdf.afterMade = opts.meanwhile ?? null;
		try {
			const res = await api('POST', '/api/reports/email', {
				user: opts.reader,
				credential: { kind: 'session', token },
				body: { periodStart: '2026-10-01', periodEnd: '2026-10-08', recipients: ['a@example.test'], ...opts.body }
			});
			await sent.settle();
			return { status: res.status, body: res.body, mails: sent.emails.length };
		} finally {
			sent.restore();
		}
	};
	/** A board owned by someone else, filed under a grouping, that `reader` views as a member. */
	const viewed = (reader: SessionUser) => {
		const owner = makeUser({ username: 'owner' });
		const { board } = makeBoard({ owner, name: 'Viewed' });
		const grouping = db.insert(boardCategories).values({ name: 'Grouped' }).returning().get();
		db.update(boards).set({ categoryId: grouping.id }).where(eq(boards.id, board.id)).run();
		db.insert(boardMembers).values({ boardId: board.id, userId: reader.id, role: 'viewer' }).run();
		const takenOff = () => void db.delete(boardMembers).where(eq(boardMembers.userId, reader.id)).run();
		return { board, grouping, takenOff };
	};
	const NO_ACCESS = { message: 'Failed to generate report or no access' };

	it('sends no all-boards report, and answers 403, when the administrator is made a user after the PDF is made', { timeout: 30_000 }, async () => {
		const admin = makeUser({ username: 'admin', role: 'admin' });
		makeBoard({ owner: admin, name: 'Any' });

		const res = await reportMail({
			reader: admin,
			body: { scope: 'all' },
			meanwhile: () => void db.update(users).set({ role: 'user' }).where(eq(users.id, admin.id)).run()
		});

		expect(res).toEqual({ status: 403, body: { message: 'Only admins can generate all-boards reports' }, mails: 0 });
	});

	it("sends no board's report, and answers 403, when the reader is taken off the board after the PDF is made", { timeout: 30_000 }, async () => {
		const reader = makeUser({ username: 'reader' });
		const { board, takenOff } = viewed(reader);

		const res = await reportMail({ reader, body: { scope: 'board', scopeId: board.id }, meanwhile: takenOff });

		expect(res).toEqual({ status: 403, body: NO_ACCESS, mails: 0 });
	});

	it("sends no grouping's report, and answers 403, when the reader is taken off a board in it after the PDF is made", { timeout: 30_000 }, async () => {
		const reader = makeUser({ username: 'reader' });
		const { grouping, takenOff } = viewed(reader);
		// A second board in the grouping that the reader keeps: the PDF still
		// holds the one they lost.
		const { board: kept } = makeBoard({ owner: reader, name: 'Kept' });
		db.update(boards).set({ categoryId: grouping.id }).where(eq(boards.id, kept.id)).run();

		const res = await reportMail({ reader, body: { scope: 'category', scopeId: grouping.id }, meanwhile: takenOff });

		expect(res).toEqual({ status: 403, body: NO_ACCESS, mails: 0 });
	});

	it('sends each of them when nothing is taken away meanwhile (the controls)', { timeout: 30_000 }, async () => {
		const admin = makeUser({ username: 'admin', role: 'admin' });
		makeBoard({ owner: admin, name: 'Any' });
		const reader = makeUser({ username: 'reader' });
		const { board, grouping } = viewed(reader);

		expect(await reportMail({ reader: admin, body: { scope: 'all' } })).toMatchObject({ status: 200, mails: 1 });
		expect(await reportMail({ reader, body: { scope: 'board', scopeId: board.id } })).toMatchObject({ status: 200, mails: 1 });
		expect(await reportMail({ reader, body: { scope: 'category', scopeId: grouping.id } })).toMatchObject({ status: 200, mails: 1 });
	});
});
