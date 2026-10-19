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
import { readdirSync } from 'node:fs';
import { isHttpError, json, type RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import {
	apiKeys,
	boardCategories,
	boardMembers,
	boards,
	cardTemplates,
	categories,
	reportSchedules,
	sessions,
	settings,
	taskRequests,
	teamMembers,
	users,
	webhooks
} from '$lib/server/db/schema';
import { hashSync } from 'bcryptjs';
import { stillAuthenticated, SESSION_COOKIE_NAME, type SessionUser } from '$lib/server/auth';
import { inTransaction } from '$lib/server/db/transaction';
import { resetAllRateLimits } from '$lib/server/rate-limit';
import { issueFormToken, newRequestToken } from '$lib/server/request-tokens';
import { cardDir } from '$lib/server/uploads';
import { stillCallerNow, writeAs } from '$lib/server/write-as';
import { stamp } from '$lib/timestamps';
import { handle } from '../src/hooks.server';
import { api } from './helpers/api';
import { effects } from './helpers/effects';
import {
	makeApiKey,
	makeAttachment,
	makeBoard,
	makeCard,
	makeComment,
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

beforeEach(() => {
	resetDb();
	sveltekit.event = null;
	pdf.afterMade = null;
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
