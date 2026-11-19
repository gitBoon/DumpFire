/**
 * Card 2935: ending an owner's or administrator's access, or lowering its role,
 * holds every webhook whose secret it could read, whoever set it.
 *
 * Who could read is the reveal rule (`canSeeWebhookSecret`): an administrator
 * or the superadmin on every board, a board's creator, an exact `owner` member
 * row; never a team. A webhook with no secret, and one already held, are left.
 * An account that provably read nothing is left out (P1): never signed in, no
 * API key, no invite used but the one being used, made after two-step sign-in
 * was released here; an unknown release moment fails closed. A demotion from
 * administrator and an owner row lowered or removed hold what the account can
 * no longer read (P2). The setter's own counts stay its own (P9). The start
 * pass covers owners and administrators disabled before it, and webhooks made
 * before setters were recorded, keeping a moment (P3, P4); a disable moves the
 * moment past itself. The two `GET` routes that give a secret ask the key again
 * (P5). The delete holds them only while the account holds a key or the pass
 * never ran (P6). The count shown before is the hold's own (P11). The
 * administrators' fallback never mails the account whose access changed (P14).
 * The restore's own run of the pass is in backups.test.ts; the host command's
 * in mfa-reset-script.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { inReadTransaction, inTransaction } from '$lib/server/db/transaction';
import { registerStampFunctions } from '$lib/server/db/timestamps';
import { apiKeys, inviteTokens, settings, users, webhooks } from '$lib/server/db/schema';
import { endAccountAccess, type SessionUser } from '$lib/server/auth';
import { disableAccount } from '$lib/server/account-disable';
import { deleteUser } from '$lib/server/deletes';
import { heldOfOthersWords } from '$lib/api';
import {
	ENDING_IN_MAIL,
	WEBHOOKS_READABLE_COVERED,
	forgetReadablePassDone,
	markReadablePassDone,
	readableCoveredAt,
	webhooksReadableBy
} from '$lib/server/webhooks';
import { ADDRESS_TOKEN_SENTENCE } from '$lib/server/notifications';
import { holdReadableWebhooksAtStart } from '$lib/server/startup-checks';
import { stamp } from '$lib/timestamps';
import { load as loadAdminPage } from '../src/routes/admin/+page.server';
import { api } from './helpers/api';
import { allowOtherTimestampForms } from './helpers/timestamps';
import { effects, type Effects } from './helpers/effects';
import {
	addBoardMember,
	inviteHashOf,
	makeApiKeyRow,
	makeBoard,
	makeSmtp,
	makeTeam,
	makeUser,
	makeWebhook,
	resetDb,
	shareBoardWithTeam,
	stepUp
} from './helpers/fixtures';

beforeEach(resetDb);
// Each case as a process whose start pass has not run, unless it runs it (card 2935's code review, C2a).
beforeEach(forgetReadablePassDone);

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
	if (level === undefined) delete process.env.LOG_LEVEL;
	else process.env.LOG_LEVEL = level;
	for (const spy of quiet) spy.mockRestore();
});

const CAUSE = { log: 'a password reset in a test', mail: ENDING_IN_MAIL.passwordReset };
const DAY = 24 * 60 * 60 * 1000;

/** A webhook's hold as stored. */
const holdOf = (id: number) =>
	sqlite.prepare('SELECT active, held_because AS heldBecause FROM webhooks WHERE id = ?').get(id) as { active: number; heldBecause: string | null };
const HELD = { active: 0, heldBecause: 'setter access ended' };
const ON = { active: 1, heldBecause: null };

/** The release of two-step sign-in recorded as `ago` ms before now. */
const releasedAgo = (ago: number) =>
	db.insert(settings).values({ key: 'two_step_released_at', value: stamp(new Date(Date.now() - ago)) }).onConflictDoUpdate({ target: settings.key, set: { value: stamp(new Date(Date.now() - ago)) } }).run();

/** End the account's access with its keys, as an administrator's password set does. */
const endWithKeys = (user: Pick<SessionUser, 'id'>, exceptInvite?: Buffer) =>
	inTransaction(() => endAccountAccess(user.id, { apiKeys: true, cause: CAUSE, ...(exceptInvite ? { exceptInvite } : {}) }));

/** The Webhooks WARN lines, oldest first. */
const warnLines = () =>
	(sqlite.prepare("SELECT message FROM system_logs WHERE context = 'Webhooks' AND level = 'WARN' ORDER BY id").pluck().all() as string[]);

describe('ending an owner’s or administrator’s access holds the webhooks whose secret it could read (card 2935)', () => {
	it('1. a board’s creator: an editor’s webhook with a secret is held, and counted apart from the setter’s own (P9)', () => {
		const owner = makeUser();
		const editor = makeUser();
		const { board } = makeBoard({ owner });
		const theirs = makeWebhook(board, { secret: 'their-secret', setBy: editor });

		const ended = endWithKeys(owner);

		expect(holdOf(theirs.id)).toEqual(HELD);
		expect([ended.webhooks, ended.webhookIds, ended.readableWebhooks]).toEqual([0, [], 1]);
	});

	it.each([
		{ row: "an exact 'owner' member row", give: (board: ReturnType<typeof makeBoard>['board'], user: SessionUser) => addBoardMember(board, user, 'owner'), held: true },
		{ row: "an 'editor' member row", give: (board: ReturnType<typeof makeBoard>['board'], user: SessionUser) => addBoardMember(board, user, 'editor'), held: false },
		{
			row: 'a team shared as editor',
			give: (board: ReturnType<typeof makeBoard>['board'], user: SessionUser) => shareBoardWithTeam(board, makeTeam([user]), 'editor'),
			held: false
		},
		{
			row: "a member row stored as 'Owner', another text",
			give: (board: ReturnType<typeof makeBoard>['board'], user: SessionUser) =>
				sqlite.prepare('INSERT INTO board_members (board_id, user_id, role) VALUES (?, ?, ?)').run(board.id, user.id, 'Owner'),
			held: false
		}
	])('2. $row', ({ give, held }) => {
		const account = makeUser();
		const { board } = makeBoard({ owner: makeUser() });
		give(board, account);
		const hook = makeWebhook(board, { secret: 's', setBy: board.createdBy === null ? null : { id: board.createdBy } as SessionUser });

		endWithKeys(account);

		expect(holdOf(hook.id)).toEqual(held ? HELD : ON);
	});

	it('3. an administrator: every webhook with a secret on boards it never joined, on or off; none with no secret; one held keeps its reason', () => {
		const admin = makeUser({ role: 'admin' });
		const other = makeUser();
		const a = makeBoard({ owner: other }).board;
		const b = makeBoard({ owner: other }).board;
		const on = makeWebhook(a, { secret: 's1', setBy: other });
		const off = makeWebhook(b, { secret: 's2', setBy: other, active: false });
		const bare = makeWebhook(b, { setBy: other });
		const keyEnded = makeWebhook(a, { secret: 's3', setBy: other, heldBecause: 'key ended' });

		const ended = endWithKeys(admin);

		expect([holdOf(on.id), holdOf(off.id), holdOf(bare.id), holdOf(keyEnded.id)]).toEqual([HELD, HELD, ON, { active: 0, heldBecause: 'key ended' }]);
		expect(ended.readableWebhooks).toBe(2);
	});

	it('4. an editor’s ending holds only what it set (the reader branch never fires for it)', () => {
		const editor = makeUser();
		const { board } = makeBoard({ owner: makeUser() });
		addBoardMember(board, editor, 'editor');
		const others = makeWebhook(board, { secret: 's' });

		endWithKeys(editor);

		expect(holdOf(others.id)).toEqual(ON);
	});

	it('5. told after the commit: the reader’s words in the WARN, the item’s in the mail, the cause naming nobody, the token sentence', async () => {
		makeSmtp();
		const owner = makeUser({ username: 'olive' });
		const boardOwner = makeUser({ username: 'bert' });
		const { board } = makeBoard({ owner: boardOwner, name: 'Shared board' });
		addBoardMember(board, owner, 'owner');
		const hook = makeWebhook(board, { url: 'https://a.example.test/path?token=never', secret: 's', setBy: boardOwner });

		endWithKeys(owner);
		await sent.settle();

		expect(warnLines()).toEqual([
			`Webhook ${hook.id} on board ${board.id} switched off: an account that could read its secret as an owner of the board or an administrator (user ${owner.id}) lost that access (${CAUSE.log}). ` +
				'It stays off until an owner of the board or an administrator switches it on.'
		]);
		const mail = sent.emails.find((each) => each.to === boardOwner.email)!;
		expect(mail.html).toContain(`What caused it: ${ENDING_IN_MAIL.passwordReset}.`);
		expect(mail.html).toContain('switched off because an owner of the board or an administrator who could read its secret lost that access.');
		expect(mail.html).toContain(ADDRESS_TOKEN_SENTENCE);
		expect(mail.html).toContain('It sends nothing, and stays off until an owner of the board or an administrator switches it on.');
		for (const never of ['olive', 'bert', 'never', 'path']) expect(mail.html).not.toContain(never);
	});

	it('6. the mail’s closing sentence says "given the board back" only for a webhook switched off because its setter lost the board (P13, L3)', async () => {
		makeSmtp();
		const owner = makeUser();
		const editor = makeUser();
		const { board } = makeBoard({ owner });
		addBoardMember(board, editor, 'editor');
		makeWebhook(board, { secret: 's', setBy: editor });

		// The editor taken off the board: its webhook switched off for a lost setter (card 2752).
		expect((await api('DELETE', `/api/boards/${board.id}/share`, { user: owner, body: { type: 'user', targetId: editor.id } })).status).toBe(200);
		await sent.settle();

		expect(sent.emails.map((mail) => mail.html)).toEqual([
			expect.stringContaining(
				'It sends nothing, and stays off until an owner of the board or an administrator switches it on, even if the account that set it up is given the board back.'
			)
		]);
	});

	it('7. the administrators’ fallback never mails the account whose access ended (P14)', async () => {
		makeSmtp();
		const ended = makeUser({ role: 'admin', username: 'endedadmin' });
		const other = makeUser({ role: 'admin', username: 'otheradmin' });
		// A board whose only owner is disabled: its mail goes to the administrators.
		const gone = makeUser({ disabled: true });
		const { board } = makeBoard({ owner: gone });
		makeWebhook(board, { secret: 's', setBy: gone });

		endWithKeys(ended);
		await sent.settle();

		expect(sent.emails.map((mail) => mail.to)).toEqual([other.email]);
	});

	it('8. the count shown before equals what the ending holds, a webhook with no setter among them (P11)', () => {
		const owner = makeUser();
		const { board } = makeBoard({ owner });
		makeWebhook(board, { secret: 's1', setBy: makeUser() });
		makeWebhook(board, { secret: 's2', setBy: null });
		makeWebhook(board, { secret: 's3', setBy: owner });
		makeWebhook(board, { setBy: null });

		const before = webhooksReadableBy(owner.id);
		const ended = endWithKeys(owner);

		expect(before).toBe(2);
		expect(ended.readableWebhooks).toBe(before);
	});
});

describe('an account that provably read nothing is left out (card 2935, P1)', () => {
	const scene = (opts: { role?: 'admin' | 'superadmin' } = {}) => {
		const account = makeUser({ role: opts.role ?? 'admin' });
		const other = makeUser();
		const hook = makeWebhook(makeBoard({ owner: other }).board, { secret: 's', setBy: other });
		return { account, hook };
	};
	const usedInvite = (user: SessionUser, token: string) => {
		db.insert(inviteTokens).values({ tokenHash: inviteHashOf(token), userId: user.id, expiresAt: stamp(new Date(Date.now() + DAY)), used: true }).run();
		return inviteHashOf(token);
	};

	it('9. a fresh administrator’s first invite holds nothing and mails nobody', async () => {
		makeSmtp();
		releasedAgo(DAY);
		const { account, hook } = scene();
		// What the invite page counts before the invite is used: nothing (one predicate, P1).
		expect(webhooksReadableBy(account.id)).toBe(0);
		const current = usedInvite(account, 'the first');

		const ended = endWithKeys(account, current);
		await sent.settle();

		expect(holdOf(hook.id)).toEqual(ON);
		expect(ended.readableWebhooks).toBe(0);
		expect(sent.emails).toEqual([]);
	});

	it.each([
		{ row: 'signed in once', mark: (user: SessionUser) => db.update(users).set({ lastSignInAt: stamp() }).where(eq(users.id, user.id)).run() },
		{ row: 'holding an API key', mark: (user: SessionUser) => void makeApiKeyRow(user) },
		{ row: 'with an earlier invite used', mark: (user: SessionUser) => void usedInvite(user, 'an earlier one') },
		{ row: 'made before the release', mark: (user: SessionUser) => db.update(users).set({ createdAt: stamp(new Date(Date.now() - 2 * DAY)) }).where(eq(users.id, user.id)).run() }
	])('10. an administrator $row is held server-wide', ({ mark }) => {
		releasedAgo(DAY);
		const { account, hook } = scene();
		mark(account);
		const current = usedInvite(account, 'the current');

		endWithKeys(account, current);

		expect(holdOf(hook.id)).toEqual(HELD);
	});

	it('11. an unknown release moment fails closed: the fresh administrator is held', () => {
		const { account, hook } = scene();

		endWithKeys(account);

		expect(holdOf(hook.id)).toEqual(HELD);
	});

	it('12. a moment that names no moment fails closed too', () => {
		db.insert(settings).values({ key: 'two_step_released_at', value: 'not a moment' }).run();
		const { account, hook } = scene();

		endWithKeys(account);

		expect(holdOf(hook.id)).toEqual(HELD);
	});
});

describe('a lowered role holds what the account can no longer read (card 2935, P2)', () => {
	it('13. an administrator made a user: every webhook with a secret but those on boards it still owns; keys kept', async () => {
		const superadmin = makeUser({ role: 'superadmin' });
		const admin = makeUser({ role: 'admin' });
		const key = makeApiKeyRow(admin);
		const other = makeUser();
		const owned = makeBoard({ owner: admin }).board;
		const elsewhere = makeBoard({ owner: other }).board;
		const onOwned = makeWebhook(owned, { secret: 's1', setBy: other });
		const onElsewhere = makeWebhook(elsewhere, { secret: 's2', setBy: other });
		const bare = makeWebhook(elsewhere, { setBy: other });

		const res = await api('PUT', `/api/users/${admin.id}`, stepUp(superadmin, { role: 'user' }));

		expect(res.status).toBe(200);
		expect([holdOf(onOwned.id), holdOf(onElsewhere.id), holdOf(bare.id)]).toEqual([ON, HELD, ON]);
		expect(db.select().from(apiKeys).where(eq(apiKeys.id, key.id)).get()).toBeDefined();
	});

	it('14. an owner row lowered to editor, and one removed, hold that board’s webhooks of others; the creator lowered keeps them', async () => {
		const creator = makeUser();
		const { board } = makeBoard({ owner: creator });
		const lowered = makeUser();
		const removed = makeUser();
		addBoardMember(board, lowered, 'owner');
		addBoardMember(board, removed, 'owner');
		addBoardMember(board, creator, 'owner');
		const first = makeWebhook(board, { secret: 's1', setBy: creator });

		expect((await api('POST', `/api/boards/${board.id}/share`, { user: creator, body: { type: 'user', targetId: lowered.id, role: 'editor' } })).status).toBe(200);
		expect(holdOf(first.id)).toEqual(HELD);

		// Switched on again (a new secret), then the second owner taken off.
		db.update(webhooks).set({ active: true, heldBecause: null, heldAt: null }).where(eq(webhooks.id, first.id)).run();
		expect((await api('DELETE', `/api/boards/${board.id}/share`, { user: creator, body: { type: 'user', targetId: removed.id } })).status).toBe(200);
		expect(holdOf(first.id)).toEqual(HELD);

		// The creator's own row lowered: still its creator, so it can read them, and nothing is held.
		db.update(webhooks).set({ active: true, heldBecause: null, heldAt: null }).where(eq(webhooks.id, first.id)).run();
		const second = makeWebhook(board, { secret: 's2', setBy: makeUser() });
		expect((await api('POST', `/api/boards/${board.id}/share`, { user: creator, body: { type: 'user', targetId: creator.id, role: 'viewer' } })).status).toBe(200);
		expect([holdOf(first.id), holdOf(second.id)]).toEqual([ON, ON]);
	});

	it('15. demote, then disable: the demotion holds the rest, and the disable what it still owned', async () => {
		const superadmin = makeUser({ role: 'superadmin' });
		const admin = makeUser({ role: 'admin' });
		const other = makeUser();
		const owned = makeBoard({ owner: admin }).board;
		const elsewhere = makeBoard({ owner: other }).board;
		const onOwned = makeWebhook(owned, { secret: 's1', setBy: other });
		const onElsewhere = makeWebhook(elsewhere, { secret: 's2', setBy: other });

		expect((await api('PUT', `/api/users/${admin.id}`, stepUp(superadmin, { role: 'user' }))).status).toBe(200);
		expect([holdOf(onOwned.id), holdOf(onElsewhere.id)]).toEqual([ON, HELD]);
		// Switched on again with a new secret, which the demoted account could never read.
		db.update(webhooks).set({ active: true, heldBecause: null, heldAt: null }).where(eq(webhooks.id, onElsewhere.id)).run();

		inTransaction(() => disableAccount(db.select().from(users).where(eq(users.id, admin.id)).get()!, superadmin));

		expect([holdOf(onOwned.id), holdOf(onElsewhere.id)]).toEqual([HELD, ON]);
	});
});

describe('the delete, the GET routes and the start pass (card 2935, P3 to P6)', () => {
	const disabledOwnerScene = () => {
		const admin = makeUser({ role: 'admin' });
		const owner = makeUser({ disabled: { by: admin } });
		const { board } = makeBoard({ owner });
		const hook = makeWebhook(board, { secret: 's', setBy: makeUser() });
		return { admin, owner, hook };
	};

	it.each([
		{ row: 'still holding a key, the pass run', key: true, flag: 'now', held: true },
		{ row: 'holding no key, the pass never run', key: false, flag: null, held: true },
		{ row: 'holding no key, the pass run', key: false, flag: 'now', held: false },
		// Card 2935's code review (C2c): a disable the stored moment does not cover.
		{ row: 'holding no key, disabled after the stored moment', key: false, flag: 'earlier', held: true },
		{ row: 'holding no key, disabled at a moment that cannot be read', key: false, flag: 'now', unreadable: true, held: true }
	])('16. the delete of a disabled owner $row (P6, C2c)', ({ key, flag, unreadable, held }) => {
		const { admin, owner, hook } = disabledOwnerScene();
		if (key) makeApiKeyRow(owner);
		if (flag !== null) {
			db.insert(settings).values({ key: WEBHOOKS_READABLE_COVERED, value: flag === 'now' ? stamp() : stamp(new Date(Date.now() - DAY)) }).run();
		}
		if (unreadable) db.update(users).set({ disabledAt: 'not a moment' }).where(eq(users.id, owner.id)).run();

		deleteUser(owner.id, admin);

		expect(holdOf(hook.id)).toEqual(held ? HELD : ON);
	});

	it.each([
		{ row: 'one', path: (hook: { id: number }) => `/api/v1/webhooks/${hook.id}` },
		{ row: 'the board’s list', path: (hook: { boardId: number }) => `/api/v1/boards/${hook.boardId}/webhooks` }
	])('17. the GET of $row asks the key again, and gives no secret once it has ended (P5)', async ({ path }) => {
		const owner = makeUser();
		const { board } = makeBoard({ owner });
		const hook = makeWebhook(board, { secret: 'the-secret', setBy: owner });
		const key = makeApiKeyRow(owner);
		const credential = { kind: 'api key' as const, id: key.id };
		const ok = await api('GET', path(hook), { user: owner, credential });
		expect(ok.status).toBe(200);
		expect(JSON.stringify(ok.body)).toContain('the-secret');

		// The gate let the request in with the key; it ends before the handler reads.
		db.delete(apiKeys).where(eq(apiKeys.id, key.id)).run();
		const refused = await api('GET', path(hook), { user: owner, credential });

		expect(refused.status).toBe(401);
		expect(JSON.stringify(refused.body)).not.toContain('the-secret');
	});

	/** Setters recorded long before any webhook of a case (P3 left out of it), for `body`. */
	const settersLongRecorded = (body: () => void) => {
		sqlite.prepare("UPDATE __drizzle_migrations SET created_at = '2000-01-01 00:00:00' WHERE hash = '0056_add_webhook_set_by.sql'").run();
		try {
			body();
		} finally {
			restoreMigrationMoment();
		}
	};

	// Card 2935's code review (C15): each clause of the start pass on its own.
	it('18a. the start pass holds a disabled administrator’s webhook made before its disable, and none with no secret; the moment written; a second start holds nothing (P3, P4)', () => {
		const admin = makeUser({ role: 'admin' });
		db.update(users).set({ disabledAt: stamp(new Date(Date.now() - DAY)) }).where(eq(users.id, admin.id)).run();
		const other = makeUser();
		const { board } = makeBoard({ owner: other });
		const before = makeWebhook(board, { secret: 's1', setBy: other });
		const bare = makeWebhook(board, { setBy: other });
		sqlite.prepare('UPDATE webhooks SET created_at = ? WHERE id IN (?, ?)').run(stamp(new Date(Date.now() - 2 * DAY)), before.id, bare.id);
		settersLongRecorded(() => {
			expect(holdReadableWebhooksAtStart('off', false)).toBe(1);
			expect([holdOf(before.id), holdOf(bare.id)]).toEqual([HELD, ON]);
			expect(readableCoveredAt()).not.toBeNull();
			expect(holdReadableWebhooksAtStart('off', false)).toBe(0);
		});
	});

	it('18b. the start pass leaves a webhook made after the disable', () => {
		const admin = makeUser({ role: 'admin' });
		db.update(users).set({ disabledAt: stamp(new Date(Date.now() - DAY)) }).where(eq(users.id, admin.id)).run();
		const other = makeUser();
		const after = makeWebhook(makeBoard({ owner: other }).board, { secret: 's2', setBy: other });
		settersLongRecorded(() => {
			expect(holdReadableWebhooksAtStart('off', false)).toBe(0);
			expect(holdOf(after.id)).toEqual(ON);
		});
	});

	it('18c. the start pass holds nothing for an enabled administrator', () => {
		makeUser({ role: 'admin' });
		const other = makeUser();
		const hook = makeWebhook(makeBoard({ owner: other }).board, { secret: 's1', setBy: other });
		sqlite.prepare('UPDATE webhooks SET created_at = ? WHERE id = ?').run(stamp(new Date(Date.now() - 2 * DAY)), hook.id);
		settersLongRecorded(() => {
			expect(holdReadableWebhooksAtStart('off', false)).toBe(0);
			expect(holdOf(hook.id)).toEqual(ON);
		});
	});

	it('18d. a later start with nobody disabled since the moment writes nothing at all (C9)', () => {
		const moment = stamp(new Date(Date.now() - DAY));
		db.insert(settings).values({ key: WEBHOOKS_READABLE_COVERED, value: moment }).run();
		const admin = makeUser({ role: 'admin' });
		db.update(users).set({ disabledAt: stamp(new Date(Date.now() - 2 * DAY)) }).where(eq(users.id, admin.id)).run();
		const before = sqlite.prepare('SELECT total_changes() AS n').pluck().get();

		expect(holdReadableWebhooksAtStart('off', false)).toBe(0);

		expect(sqlite.prepare('SELECT total_changes() AS n').pluck().get()).toBe(before);
		expect(readableCoveredAt()).toBe(moment);
	});

	it('19. the first pass holds every webhook with a secret made before setters were recorded (P3)', () => {
		const other = makeUser();
		const { board } = makeBoard({ owner: other });
		const old = makeWebhook(board, { secret: 's1', setBy: other });
		const newer = makeWebhook(board, { secret: 's2', setBy: other });
		sqlite.prepare("UPDATE __drizzle_migrations SET created_at = '2026-01-01 00:00:00' WHERE hash = '0056_add_webhook_set_by.sql'").run();
		sqlite.prepare("UPDATE webhooks SET created_at = '2025-06-01 00:00:00' WHERE id = ?").run(old.id);
		try {
			expect(holdReadableWebhooksAtStart('off', false)).toBe(1);
			expect([holdOf(old.id), holdOf(newer.id)]).toEqual([HELD, ON]);
		} finally {
			restoreMigrationMoment();
		}
	});

	it('20. an unknown moment for setters fails closed: the first pass holds every webhook with a secret (P3)', () => {
		const other = makeUser();
		const hook = makeWebhook(makeBoard({ owner: other }).board, { secret: 's', setBy: other });
		sqlite.prepare("UPDATE __drizzle_migrations SET created_at = 'not a moment' WHERE hash = '0056_add_webhook_set_by.sql'").run();
		try {
			expect(holdReadableWebhooksAtStart('off', false)).toBe(1);
			expect(holdOf(hook.id)).toEqual(HELD);
		} finally {
			restoreMigrationMoment();
		}
	});

	it('21. an account disabled after the stored moment (an older image) is covered at the next start; one this image disabled is not held again (P4)', () => {
		const superadmin = makeUser({ role: 'superadmin' });
		const covered = stamp(new Date(Date.now() - 2 * DAY));
		db.insert(settings).values({ key: WEBHOOKS_READABLE_COVERED, value: covered }).run();
		const other = makeUser();
		const { board } = makeBoard({ owner: other });
		const hook = makeWebhook(board, { secret: 's', setBy: other });
		sqlite.prepare('UPDATE webhooks SET created_at = ? WHERE id = ?').run(stamp(new Date(Date.now() - 3 * DAY)), hook.id);
		// Disabled on an older image after the moment: no ending held anything.
		const older = makeUser({ role: 'admin' });
		db.update(users).set({ disabledAt: stamp(new Date(Date.now() - DAY)) }).where(eq(users.id, older.id)).run();

		expect(holdReadableWebhooksAtStart('off', false)).toBe(1);
		expect(holdOf(hook.id)).toEqual(HELD);

		// Switched on again; an administrator disabled on this image holds it at its disable and moves the moment past
		// itself, so the next start holds nothing of what is switched on after.
		db.update(webhooks).set({ active: true, heldBecause: null, heldAt: null }).where(eq(webhooks.id, hook.id)).run();
		const here = makeUser({ role: 'admin' });
		inTransaction(() => disableAccount(db.select().from(users).where(eq(users.id, here.id)).get()!, superadmin));
		expect(holdOf(hook.id)).toEqual(HELD);
		db.update(webhooks).set({ active: true, heldBecause: null, heldAt: null }).where(eq(webhooks.id, hook.id)).run();
		expect(holdReadableWebhooksAtStart('off', false)).toBe(0);
		expect(holdOf(hook.id)).toEqual(ON);
	});
});

describe('the counts before and the answers after (card 2935, P8, P9, P11)', () => {
	it('22. an administrator’s password set on a board owner: the answer counts its own webhooks and those of others apart (P9)', async () => {
		const superadmin = makeUser({ role: 'superadmin' });
		const owner = makeUser();
		const { board } = makeBoard({ owner });
		makeWebhook(board, { secret: 's1', setBy: owner });
		makeWebhook(board, { secret: 's2', setBy: makeUser() });

		const res = await api('PUT', `/api/users/${owner.id}/password`, stepUp(superadmin, { password: 'a new password 1' }));

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toMatchObject({ webhooksSwitchedOff: 1, readableWebhooksHeld: 1 });
	});

	it('23. the admin page counts, in its one query, what an ending would hold: the same as the hold’s own count, and none for an account the caller may not reset (P11)', async () => {
		const superadmin = makeUser({ role: 'superadmin' });
		const admin = makeUser({ role: 'admin' });
		const owner = makeUser();
		const { board } = makeBoard({ owner });
		makeWebhook(board, { secret: 's1', setBy: makeUser() });
		makeWebhook(board, { secret: 's2', setBy: null });
		makeWebhook(board, { setBy: null });

		const data = (await loadAdminPage({ locals: { user: superadmin } } as unknown as Parameters<typeof loadAdminPage>[0])) as {
			users: { id: number; webhooksReadable: number | null }[];
		};
		const row = (id: number) => data.users.find((user) => user.id === id)!.webhooksReadable;

		expect([row(owner.id), row(admin.id), row(superadmin.id)]).toEqual([webhooksReadableBy(owner.id), webhooksReadableBy(admin.id), null]);
		expect([row(owner.id), row(admin.id)]).toEqual([2, 2]);
	});
});

describe('the code review’s fix pass (card 2935, C1 to C11)', () => {
	/** The start pass run (the moment written as now) and its commit marked, as a server's first start does. */
	const started = () => {
		db.insert(settings).values({ key: WEBHOOKS_READABLE_COVERED, value: stamp(new Date(Date.now() - 1000)) }).onConflictDoNothing().run();
		markReadablePassDone();
	};
	const switchOn = (id: number) => db.update(webhooks).set({ active: true, heldBecause: null, heldAt: null }).where(eq(webhooks.id, id)).run();

	/**
	 * An account with an owner row on board B (an administrator, or an ordinary user), disabled here with its disable
	 * covered or not; another's webhook on B, and one elsewhere, switched on again since.
	 */
	const coveredScene = (covered: boolean, role: 'admin' | 'user' = 'admin') => {
		makeSmtp();
		const superadmin = makeUser({ role: 'superadmin' });
		const admin = makeUser({ role });
		const creator = makeUser();
		const { board } = makeBoard({ owner: creator });
		addBoardMember(board, admin, 'owner');
		const onB = makeWebhook(board, { secret: 's1', setBy: creator });
		const elsewhere = makeWebhook(makeBoard({ owner: creator }).board, { secret: 's2', setBy: creator });
		if (covered) started();
		inTransaction(() => disableAccount(db.select().from(users).where(eq(users.id, admin.id)).get()!, superadmin));
		expect([holdOf(onB.id), holdOf(elsewhere.id)]).toEqual([HELD, role === 'admin' ? HELD : ON]);
		switchOn(onB.id);
		switchOn(elsewhere.id);
		return { superadmin, admin, creator, board, onB, elsewhere };
	};

	it.each([
		{
			row: 'an administrator made a user (users PUT)',
			role: 'admin' as const,
			lower: async (s: ReturnType<typeof coveredScene>) => api('PUT', `/api/users/${s.admin.id}`, stepUp(s.superadmin, { role: 'user' }))
		},
		{
			row: 'an owner’s row lowered (share POST)',
			role: 'user' as const,
			lower: async (s: ReturnType<typeof coveredScene>) =>
				api('POST', `/api/boards/${s.board.id}/share`, { user: s.creator, body: { type: 'user', targetId: s.admin.id, role: 'editor' } })
		},
		{
			row: 'an owner taken off the board (share DELETE)',
			role: 'user' as const,
			lower: async (s: ReturnType<typeof coveredScene>) => api('DELETE', `/api/boards/${s.board.id}/share`, { user: s.creator, body: { type: 'user', targetId: s.admin.id } })
		}
	])('C1. a disabled account whose disable is covered, $row: nothing more is held, nobody mailed', async ({ lower, role }) => {
		const s = coveredScene(true, role);
		await sent.settle();
		sent.clear();

		const res = await lower(s);
		await sent.settle();

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect([holdOf(s.onB.id), holdOf(s.elsewhere.id)]).toEqual([ON, ON]);
		expect(sent.emails.filter((mail) => mail.subject.includes('webhook'))).toEqual([]);
	});

	it('C1. a disable not yet covered (no moment stored): the demotion still holds', async () => {
		const s = coveredScene(false);

		const res = await api('PUT', `/api/users/${s.admin.id}`, stepUp(s.superadmin, { role: 'user' }));

		expect(res.status).toBe(200);
		// B is still its own (an owner row), so only the webhook elsewhere goes.
		expect([holdOf(s.onB.id), holdOf(s.elsewhere.id)]).toEqual([ON, HELD]);
	});

	it('C2a. a disable before this process’s start pass has committed leaves the stored moment where it is', () => {
		const moment = stamp(new Date(Date.now() - DAY));
		db.insert(settings).values({ key: WEBHOOKS_READABLE_COVERED, value: moment }).run();
		const superadmin = makeUser({ role: 'superadmin' });
		const admin = makeUser({ role: 'admin' });

		inTransaction(() => disableAccount(db.select().from(users).where(eq(users.id, admin.id)).get()!, superadmin));

		expect(readableCoveredAt()).toBe(moment);
	});

	it.each([
		{ row: 'another account disabled since the moment', other: () => stamp(new Date(Date.now() - 1000)) },
		{ row: 'another account disabled at a moment that cannot be read', other: () => 'not a moment' }
	])('C2b. a disable leaves the moment where it is with $row', ({ other }) => {
		allowOtherTimestampForms();
		const moment = stamp(new Date(Date.now() - DAY));
		db.insert(settings).values({ key: WEBHOOKS_READABLE_COVERED, value: moment }).run();
		markReadablePassDone();
		const superadmin = makeUser({ role: 'superadmin' });
		const elsewhere = makeUser({ role: 'admin' });
		db.update(users).set({ disabledAt: other() }).where(eq(users.id, elsewhere.id)).run();
		const admin = makeUser({ role: 'admin' });

		inTransaction(() => disableAccount(db.select().from(users).where(eq(users.id, admin.id)).get()!, superadmin));

		expect(readableCoveredAt()).toBe(moment);
	});

	it('C2b. with nobody else disabled since, a disable moves the moment to itself', () => {
		db.insert(settings).values({ key: WEBHOOKS_READABLE_COVERED, value: stamp(new Date(Date.now() - DAY)) }).run();
		markReadablePassDone();
		const superadmin = makeUser({ role: 'superadmin' });
		const admin = makeUser({ role: 'admin' });

		inTransaction(() => disableAccount(db.select().from(users).where(eq(users.id, admin.id)).get()!, superadmin));

		expect(readableCoveredAt()).toBe(db.select({ at: users.disabledAt }).from(users).where(eq(users.id, admin.id)).get()!.at);
	});

	it('C4. the two-step reset’s message names the webhooks of others it held, and its answer counts them', async () => {
		const superadmin = makeUser({ role: 'superadmin' });
		const owner = makeUser();
		makeWebhook(makeBoard({ owner }).board, { secret: 's', setBy: makeUser() });

		const res = await api('POST', `/api/users/${owner.id}/mfa/reset`, stepUp(superadmin));

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.readableWebhooksHeld).toBe(1);
		expect(res.body.message).toContain(` ${heldOfOthersWords(1)}.`);
		// And in the branch that withholds the link, said the same way.
		const route = readFileSync(join(process.cwd(), 'src/routes/api/users/[id]/mfa/reset/+server.ts'), 'utf8');
		expect(route).toContain('const withheldSaid = `${pausedSaid}${endedWords(ended, mailSent, false)}${readableSaid}`;');
		expect(route).toContain('const shownSaid = `${pausedSaid}${endedWords(ended, mailSent, true)}${readableSaid}${settingsWords(set)}`;');
	});

	it('C6. a read transaction takes no write lock: another connection may begin a write meanwhile; and a write inside it is refused', () => {
		const folder = mkdtempSync(join(tmpdir(), 'dumpfire-read-lock-'));
		const file = join(folder, 'lock.sqlite');
		const reader = new Database(file);
		const writer = new Database(file);
		try {
			reader.exec('CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (1);');
			writer.pragma('busy_timeout = 0');
			const seen = inReadTransaction(() => {
				const v = reader.prepare('SELECT v FROM t').pluck().get();
				// With BEGIN IMMEDIATE on the reader this would be SQLITE_BUSY at once.
				writer.exec('BEGIN IMMEDIATE');
				writer.exec('ROLLBACK');
				return v;
			}, reader);
			expect(seen).toBe(1);
			expect(() => inReadTransaction(() => reader.prepare('INSERT INTO t VALUES (2)').run(), reader)).toThrow(/for reads alone/);
			expect(reader.prepare('SELECT COUNT(*) FROM t').pluck().get()).toBe(1);
		} finally {
			reader.close();
			writer.close();
			rmSync(folder, { recursive: true, force: true });
		}
		// Card 2947 (R14): `revealAs`, which gives a webhook's secret, records the key it was given in the same
		// transaction, so takes the write lock (`inTransaction`, BEGIN IMMEDIATE), the key asked for first; `readAs` went.
		const writeAs = readFileSync(join(process.cwd(), 'src/lib/server/write-as.ts'), 'utf8');
		expect(writeAs).toContain('return inTransaction<T>(() => reveal(stillAuthenticated(locals)));');
		expect(writeAs).not.toContain('export function readAs');
		for (const route of ['src/routes/api/v1/webhooks/[webhookId]/+server.ts', 'src/routes/api/v1/boards/[boardId]/webhooks/+server.ts']) {
			const source = readFileSync(join(process.cwd(), route), 'utf8');
			expect(source, route).toContain('revealAs(locals, ');
			expect(source, route).not.toContain('readAs(');
		}
	});

	it('C8. a second registration of the stamp functions on a connection defines nothing again', () => {
		const database = new Database(':memory:');
		try {
			const defined = vi.spyOn(database, 'function');
			registerStampFunctions(database);
			registerStampFunctions(database);
			expect(defined).toHaveBeenCalledTimes(2);
			const held = database.prepare('SELECT stamp_of(?) AS v');
			registerStampFunctions(database);
			expect(held.get('2026-11-19 10:00:00')).toEqual({ v: '2026-11-19 10:00:00' });
		} finally {
			database.close();
		}
	});

	it('C11d. the account whose access ended is not mailed as the board’s owner: its other owner is', async () => {
		makeSmtp();
		const ended = makeUser({ username: 'endedowner' });
		const other = makeUser({ username: 'otherowner' });
		const { board } = makeBoard({ owner: ended });
		addBoardMember(board, other, 'owner');
		makeWebhook(board, { secret: 's', setBy: makeUser() });

		endWithKeys(ended);
		await sent.settle();

		expect(sent.emails.map((mail) => mail.to)).toEqual([other.email]);
	});
});

/** The migration record's moment for 0056, as the suite's start wrote it. */
let migrationMoment: string | null = null;
beforeEach(() => {
	migrationMoment = sqlite.prepare("SELECT created_at FROM __drizzle_migrations WHERE hash = '0056_add_webhook_set_by.sql'").pluck().get() as string | null;
});
function restoreMigrationMoment(): void {
	sqlite.prepare("UPDATE __drizzle_migrations SET created_at = ? WHERE hash = '0056_add_webhook_set_by.sql'").run(migrationMoment);
}
