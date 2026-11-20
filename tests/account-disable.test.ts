/**
 * Card 2671: an account disabled, and enabled again.
 *
 * Disabling ends at once everything a password reset ends (sessions, invites,
 * pending sign-ins, set-up links, API keys, the webhooks the account set, its
 * report schedules), the links of the requests it made, and for an
 * administrator the mail settings, the App URL, the backup destinations and
 * the backup failure address that are theirs. Enabling gives back the
 * sign-in alone. Who may do either is the account routes' one rule, and an
 * account the superadmin disabled is enabled by the superadmin alone (S14).
 *
 * The gates that refuse a disabled account are proved where each gate's
 * suite is: tests/two-step-sign-in.test.ts, tests/gate.test.ts,
 * tests/live-streams.test.ts and tests/write-as.test.ts. Here: the service
 * and its two routes (cases 1 to 5), the three resets refused (case 8), and
 * an invite of a disabled account (case 19).
 *
 * A disabled account has no board, whatever its role and memberships, is
 * offered in no picker, and is mailed nothing as an account holder (slice 3):
 * board access (cases 20, 21, 22), share and team refusals (24, 25), requests
 * and pickers (29, 30, 31), mail (33, 34) and a webhook's hold (38). The rest
 * of slice 3's cases are where their suites are: the Product Owner and the
 * decider (23), People (26), decisions (27, 28, tests/decision-service.test.ts),
 * the board's users (32), requests mailed (35), the scheduler (37), the restore
 * and the superadmin's count (39 to 42, tests/backups.test.ts) and the start's
 * sweep of settings (43).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { inTransaction } from '$lib/server/db/transaction';
import {
	apiKeys,
	enrolmentLinks,
	inviteTokens,
	reportSchedules,
	sessions,
	settings,
	signInChallenges,
	teamMembers,
	users,
	webhooks
} from '$lib/server/db/schema';
import { validateSession, type SessionUser } from '$lib/server/auth';
import { editableBoardIds, getAccessibleBoardsAndTeams, getBoardRole, ownedBoardIds, roleOnBoard, type Actor } from '$lib/server/board-access';
import { notifyCardMoved, notifyDecisionQuestion, notifyWebhooksSwitchedOff } from '$lib/server/notifications';
import { readDirectory } from '$lib/server/people-directory';
import { holdOf } from '$lib/server/webhooks';
import { canEditMilestone, canViewMilestone, listMilestones, milestoneIdsOpenTo, milestonesForBoard } from '$lib/server/milestones';
import { decisionAccess } from '$lib/server/decision-access';
import { subscribeToLogs, type LogEntry } from '$lib/server/logger';
import { issueInvite, usableInvite } from '$lib/server/invites';
import { sha256Hex } from '$lib/server/mfa-crypto';
import { mailPlacesNow, recordDestinationSetter, recordMailSetters } from '$lib/server/setting-setters';
import { setAppUrl } from '$lib/server/email';
import {
	ALREADY_DISABLED,
	DELETED_HERE,
	ENABLE_FIRST,
	NOT_DISABLED,
	ONLY_SUPERADMIN_ENABLES,
	ONLY_SUPERADMIN_ENABLES_RECORDED
} from '$lib/server/account-disable';
import { stamp } from '$lib/timestamps';
import { pageLoad } from './helpers/actions';
import { api } from './helpers/api';
import { effects, type Effects } from './helpers/effects';
import {
	addBoardMember,
	assignCard,
	makeApiKey,
	makeBoard,
	makeCard,
	makeMilestone,
	makePerson,
	makeSession,
	makeSmtp,
	makeTeam,
	makeUser,
	makeWebhook,
	resetDb,
	shareBoardWithTeam,
	stepUp,
	stepUpFactor
} from './helpers/fixtures';
import { watchReads } from './helpers/reads';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';

let level: string | undefined;
let mail: Effects | null = null;
/** Every AUTH line written since the case began, at WARN and above (the suite runs at ERROR). */
let logged: LogEntry[] = [];
let stopListening: () => void = () => {};

beforeEach(() => {
	resetDb();
	level = process.env.LOG_LEVEL;
	process.env.LOG_LEVEL = 'WARN';
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	logged = [];
	stopListening = subscribeToLogs((entry) => logged.push(entry));
});

afterEach(() => {
	stopListening();
	mail?.restore();
	mail = null;
	vi.restoreAllMocks();
	if (level === undefined) delete process.env.LOG_LEVEL;
	else process.env.LOG_LEVEL = level;
});

/** Mail set up, and recorded rather than sent. */
function mailing(): Effects {
	makeSmtp();
	mail = effects();
	return mail;
}

const authWarnings = () => logged.filter((entry) => entry.context === 'AUTH' && entry.level === 'WARN').map((entry) => entry.message);

const row = (id: number) => db.select().from(users).where(eq(users.id, id)).get()!;
const countOf = (table: string, column: string, id: number) =>
	(sqlite.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE "${column}" = ?`).get(id) as { n: number }).n;

/** A request made by `requester`, with `links` links to it; returns its id. */
function requestWithLinks(requester: SessionUser | null, links: number): number {
	const id = Number(
		sqlite
			.prepare("INSERT INTO task_requests (target_type, target_id, requester_name, requester_user_id, title) VALUES ('user', 1, 'Someone', ?, 'Help')")
			.run(requester?.id ?? null).lastInsertRowid
	);
	for (let n = 0; n < links; n++) {
		sqlite.prepare("INSERT INTO request_links (token_hash, request_id, source) VALUES (?, ?, 'mail')").run(sha256Hex(`link ${id} ${n}`), id);
	}
	return id;
}

const linksTo = (requestId: number) => (sqlite.prepare('SELECT COUNT(*) AS n FROM request_links WHERE request_id = ?').get(requestId) as { n: number }).n;

/**
 * An ordinary user with everything disabling ends: two sessions, an unused
 * invite, a pending sign-in, a set-up link, an API key, a webhook they set
 * that is on, a report schedule that is on, a request they made with two
 * links; and the only owner of the team Ops. Beside them a bystander with a
 * session, a key and a request link, which nothing may touch.
 */
function scene() {
	const chief = makeUser({ username: 'chief', role: 'superadmin' });
	const admin = makeUser({ username: 'admin', role: 'admin' });
	const bob = makeUser({ username: 'bob' });
	const bystander = makeUser({ username: 'bystander' });
	for (const user of [chief, admin]) stepUpFactor(user);
	makeSession(bob);
	makeSession(bob);
	makeSession(bystander);
	const week = stamp(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
	db.insert(inviteTokens).values({ tokenHash: Buffer.alloc(32, 7), userId: bob.id, expiresAt: week }).run();
	db.insert(signInChallenges)
		.values({ tokenHash: sha256Hex('bob challenge'), shortId: 'c-bob', userId: bob.id, purpose: 'verify', lane: 'other', passwordHash: 'x', expiresAt: week })
		.run();
	db.insert(enrolmentLinks).values({ tokenHash: sha256Hex('bob link'), userId: bob.id, issuedBy: 'admin-reset', expiresAt: week }).run();
	makeApiKey(bob, 'bob key');
	makeApiKey(bystander, 'bystander key');
	const board = makeBoard({ owner: bob, name: 'Bob board' }).board;
	const hook = makeWebhook(board, { setBy: bob });
	const schedule = db.insert(reportSchedules).values({ userId: bob.id, name: 'Weekly', scope: 'all', enabled: true }).returning().get();
	const bobsRequest = requestWithLinks(bob, 2);
	const othersRequest = requestWithLinks(bystander, 1);
	const ops = makeTeam([], 'Ops');
	db.insert(teamMembers).values({ teamId: ops.id, userId: bob.id, role: 'owner' }).run();
	return { chief, admin, bob, bystander, hook, schedule, bobsRequest, othersRequest };
}

/** The address the administrator acts from in these tests: on the AUTH line, never in the notice (the code review's CS1). */
const ADMIN_IP = '203.0.113.71';
const disable = (by: SessionUser, target: { id: number }) => api('POST', `/api/users/${target.id}/disable`, { ...stepUp(by), ip: ADMIN_IP });
const enable = (by: SessionUser, target: { id: number }) => api('POST', `/api/users/${target.id}/enable`, { ...stepUp(by), ip: ADMIN_IP });
/** The AUTH WARN lines, with the address each is filed with. */
const authWarningsFrom = () => logged.filter((entry) => entry.context === 'AUTH' && entry.level === 'WARN').map((entry) => entry.ip);

// ─── 1 to 3. Disable ─────────────────────────────────────────────────────────

describe('POST /api/users/[id]/disable', () => {
	it('case 1: ends everything a reset ends, the keys, the request links; writes both columns; one WARN; the notice names who', async () => {
		const s = scene();
		const sent = mailing();

		const res = await disable(s.admin, s.bob);

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toEqual({
			disabled: true,
			disabledAt: row(s.bob.id).disabledAt,
			sessionsEnded: 2,
			invitesEnded: 1,
			apiKeysEnded: 1,
			// Card 2935 (P9): the ones it set, and those of others whose secret it could read, apart.
			webhooksSwitchedOff: 1,
			readableWebhooksHeld: 0,
			reportSchedulesPaused: 1,
			requestLinksEnded: 2,
			soleOwnerOf: ['Ops'],
			noticeSent: true
		});
		expect(row(s.bob.id)).toMatchObject({ disabledAt: expect.any(String), disabledBy: s.admin.id });
		for (const [table, column] of [
			['sessions', 'user_id'],
			['invite_tokens', 'user_id'],
			['sign_in_challenges', 'user_id'],
			['enrolment_links', 'user_id'],
			['api_keys', 'user_id']
		]) {
			expect(countOf(table, column, s.bob.id), table).toBe(0);
		}
		expect(db.select().from(webhooks).where(eq(webhooks.id, s.hook.id)).get()).toMatchObject({ active: false, heldBecause: 'setter access ended' });
		expect(db.select().from(reportSchedules).where(eq(reportSchedules.id, s.schedule.id)).get()!.enabled).toBe(false);
		expect(linksTo(s.bobsRequest)).toBe(0);
		// The team keeps them as its owner (D20); the bystander keeps everything.
		expect(countOf('team_members', 'user_id', s.bob.id)).toBe(1);
		expect(countOf('sessions', 'user_id', s.bystander.id)).toBe(1);
		expect(countOf('api_keys', 'user_id', s.bystander.id)).toBe(1);
		expect(linksTo(s.othersRequest)).toBe(1);

		expect(authWarnings()).toEqual([
			`Account of user ${s.bob.id} ("bob") disabled by "admin" (user ${s.admin.id}): ended 2 session(s), 1 invite(s), ` +
				`1 pending sign-in(s), 1 set-up link(s), 1 API key(s) and 2 request link(s), switched off 1 webhook(s) they set up ` +
				`(id ${s.hook.id}) and paused 1 report schedule(s) (id ${s.schedule.id}); the only owner of: Ops`
		]);
		const notices = sent.emails.filter((email) => email.to === s.bob.email);
		expect(notices.map((email) => email.subject)).toEqual(['Your DumpFire account was disabled']);
		expect(notices[0].html).toContain('disabled by admin on');
		// The code review's CS1: the administrator's address is on the AUTH line, and in no notice to the account.
		expect(authWarningsFrom()).toEqual([ADMIN_IP]);
		expect(notices[0].html).not.toContain(ADMIN_IP);
		expect(notices[0].html).not.toMatch(/ from \d/);

		// Card 2923 (case 9): the board's owners told once committed. Bob, its only owner, disabled by then, is left
		// out; the enabled administrator and superadmin are mailed in his place, naming the disable and who made it.
		const owners = sent.emails.filter((email) => email.subject === 'A webhook on your board was switched off');
		expect(owners.map((email) => email.to).sort()).toEqual([s.admin.email, s.chief.email].sort());
		// The kind of action and no account (card 2923's code review, S5).
		for (const email of owners) {
			// Card 2935: the kind of action without a subject; the item says whose it was.
			expect(email.html).toContain('What caused it: an account was disabled by an administrator.');
			expect(email.html).not.toContain('bob');
		}
	});

	it('case 2: the superadmin disabling an administrator removes the mail, the App URL, their destination and their failure address, names all four, and says the notice could not go', async () => {
		const s = scene();
		const ann = makeUser({ username: 'ann', role: 'admin' });
		// Ann saved the mail settings, the App URL and a destination, and is a failure address.
		const before = mailPlacesNow();
		const sent = mailing();
		setAppUrl('https://ann.example');
		recordMailSetters(before, { id: ann.id, superadmin: false }, true);
		const anns = { type: 's3', name: "Ann's", region: 'eu-west-2', bucket: 'ann-bucket', accessKeyId: 'AKIA', secretAccessKey: 'secret', prefix: '' };
		db.insert(settings)
			.values({
				key: 'backup_config',
				value: JSON.stringify({ schedule: 'daily', retention: 7, notifyOnFailure: true, notifyEmail: `ops@example.test, ${ann.email.toUpperCase()}`, destinations: [anns] })
			})
			.run();
		recordDestinationSetter(anns, ann.id);

		const res = await disable(s.chief, ann);

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toMatchObject({
			disabled: true,
			noticeSent: false,
			settingsRemoved: { mail: true, appUrl: true, destinations: ["Ann's"], failureAddress: true }
		});
		const config = JSON.parse(db.select().from(settings).where(eq(settings.key, 'backup_config')).get()!.value);
		expect({ notifyEmail: config.notifyEmail, destinations: config.destinations }).toEqual({ notifyEmail: 'ops@example.test', destinations: [] });
		expect(sqlite.prepare("SELECT key FROM settings WHERE key LIKE 'smtp\\_%' ESCAPE '\\' OR key = 'app_url'").all()).toEqual([]);
		expect(sent.emails).toEqual([]);
		expect(authWarnings()).toHaveLength(1);
		expect(authWarnings()[0]).toMatch(
			/; removed the mail settings, the App URL, the backup destination\(s\) "Ann's", their address from the backup failure address$/
		);
	});

	// The code review's CS2: any address can be typed into the failure address, so a disable takes the account's out
	// whatever its role, and the admin page says so on every row, by the one rule the removal asks (CR9).
	it('CS2: disabling a user whose address is a failure address takes it out, and the admin page said so on its row beforehand', async () => {
		const s = scene();
		mailing();
		db.insert(settings)
			.values({ key: 'backup_config', value: JSON.stringify({ schedule: 'daily', retention: 7, notifyOnFailure: true, notifyEmail: `ops@example.test;\n ${s.bob.email.toUpperCase()}` }) })
			.run();
		const page = await pageLoad('/admin', { user: s.admin });
		const listed = (page as { data: { users: { id: number; failureAddress: boolean }[] } }).data.users;
		expect(listed.map((u) => [u.id, u.failureAddress])).toEqual(listed.map((u) => [u.id, u.id === s.bob.id]));

		const res = await disable(s.admin, s.bob);

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.settingsRemoved).toEqual({ mail: false, appUrl: false, destinations: [], failureAddress: true });
		expect(JSON.parse(db.select().from(settings).where(eq(settings.key, 'backup_config')).get()!.value).notifyEmail).toBe('ops@example.test');
		expect(authWarnings()[0]).toMatch(/; removed their address from the backup failure address$/);
	});

	it.each([
		{ what: 'their own account', by: 'admin', target: 'admin', status: 403, says: 'You cannot disable your own account' },
		{ what: "the superadmin's", by: 'admin', target: 'chief', status: 403, says: 'Cannot disable superadmin account' },
		{ what: "an administrator's, by an administrator", by: 'admin', target: 'other admin', status: 403, says: 'Only superadmin can disable admin users' },
		{ what: 'an account already disabled', by: 'admin', target: 'disabled', status: 409, says: ALREADY_DISABLED }
	] as const)('case 3: refuses $what, $status, before the password, with nothing written', async ({ by, target, status, says }) => {
		const s = scene();
		const accounts: Record<string, SessionUser> = {
			admin: s.admin,
			chief: s.chief,
			'other admin': makeUser({ username: 'ada', role: 'admin' }),
			disabled: makeUser({ username: 'gone', disabled: { by: s.admin } })
		};
		const caller = accounts[by];
		const sending = stepUp(caller);
		const before = snapshotDb();

		const res = await api('POST', `/api/users/${accounts[target].id}/disable`, { ...sending, body: { ...sending.body, currentPassword: 'not the password' } });

		expect({ status: res.status, body: res.body }).toEqual({ status, body: { message: says } });
		expectUnchanged(before);
	});
});

// ─── 4 and 5. Enable ─────────────────────────────────────────────────────────

describe('POST /api/users/[id]/enable', () => {
	it('case 4: clears both columns and nothing else comes back; one WARN; the notice names who', async () => {
		const s = scene();
		const sent = mailing();
		expect((await disable(s.admin, s.bob)).status).toBe(200);
		logged = [];

		const res = await enable(s.admin, s.bob);

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toEqual({ enabled: true, noticeSent: true });
		expect(row(s.bob.id)).toMatchObject({ disabledAt: null, disabledBy: null });
		// What disabling ended stays ended (D8).
		expect(countOf('api_keys', 'user_id', s.bob.id)).toBe(0);
		expect(db.select().from(reportSchedules).where(eq(reportSchedules.id, s.schedule.id)).get()!.enabled).toBe(false);
		expect(db.select().from(webhooks).where(eq(webhooks.id, s.hook.id)).get()!.active).toBe(false);
		expect(linksTo(s.bobsRequest)).toBe(0);
		expect(authWarnings()).toEqual([
			expect.stringMatching(
				new RegExp(`^Account of user ${s.bob.id} \\("bob"\\) enabled again by "admin" \\(user ${s.admin.id}\\), disabled since .+: it may sign in;`)
			)
		]);
		expect(sent.emails.filter((email) => email.to === s.bob.email).map((email) => email.subject)).toEqual([
			'Your DumpFire account was disabled',
			'Your DumpFire account was enabled again'
		]);
		expect(sent.emails.at(-1)!.html).toContain('enabled again by admin on');
		// The code review's CS1, as for the disable.
		expect(authWarningsFrom()).toEqual([ADMIN_IP]);
		expect(sent.emails.at(-1)!.html).not.toContain(ADMIN_IP);
		expect(sent.emails.at(-1)!.html).not.toMatch(/ from \d/);
	});

	it.each([
		{ what: 'an account that is not disabled', by: 'admin', target: 'bob', status: 409, says: NOT_DISABLED },
		{ what: "an administrator's, by an administrator", by: 'admin', target: 'ada', status: 403, says: 'Only superadmin can enable admin users' },
		{ what: 'an account the superadmin disabled, by an administrator', by: 'admin', target: 'chief disabled', status: 403, says: ONLY_SUPERADMIN_ENABLES }
	])('case 5: refuses $what, $status, before the password, with nothing written', async ({ by, target, status, says }) => {
		const s = scene();
		const accounts: Record<string, SessionUser> = {
			admin: s.admin,
			bob: s.bob,
			ada: makeUser({ username: 'ada', role: 'admin', disabled: { by: s.chief } }),
			'chief disabled': makeUser({ username: 'gone', disabled: { by: s.chief } })
		};
		const sending = stepUp(accounts[by]);
		const before = snapshotDb();

		const res = await api('POST', `/api/users/${accounts[target].id}/enable`, { ...sending, body: { ...sending.body, currentPassword: 'not the password' } });

		expect({ status: res.status, body: res.body }).toEqual({ status, body: { message: says } });
		expectUnchanged(before);
	});

	it('FP15 (card 2996): an account whose disable the record of account endings ruled is the superadmin’s to enable: an administrator is refused 403 before the password; the superadmin enables it; an administrator’s own disable is still an administrator’s to undo', async () => {
		const s = scene();
		// Disabled by a backup's row of the record, as a restore leaves it; the disabler an administrator, so S14 has no say.
		const ruled = makeUser({ username: 'ruled', disabled: { by: s.admin } });
		const created = sqlite.prepare('SELECT created_at FROM users WHERE id = ?').pluck().get(ruled.id) as string;
		sqlite
			.prepare("INSERT INTO account_endings (user_id, account_created, ending, ended_at, origin) VALUES (?, ?, 'disabled', '2026-11-19 09:00:00', 'backup')")
			.run(ruled.id, created);
		const sending = stepUp(s.admin);
		const before = snapshotDb();

		const refused = await api('POST', `/api/users/${ruled.id}/enable`, { ...sending, body: { ...sending.body, currentPassword: 'not the password' } });

		expect({ status: refused.status, body: refused.body }).toEqual({ status: 403, body: { message: ONLY_SUPERADMIN_ENABLES_RECORDED } });
		expect(authWarnings()).toEqual([]);
		expectUnchanged(before);
		const enabled = await enable(s.chief, ruled);
		expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
		expect(row(ruled.id)).toMatchObject({ disabledAt: null });

		// An administrator's own disable, through the route: undone by an administrator, as before.
		expect((await disable(s.admin, s.bob)).status).toBe(200);
		expect((await enable(s.admin, s.bob)).status).toBe(200);
	});

	it('test 29 (card 2996): the disable records `disabled` at its own moment, and the enable records `enabled`, each by the account’s id and creation time', async () => {
		const s = scene();
		expect((await disable(s.admin, s.bob)).status).toBe(200);
		const disabledAt = row(s.bob.id).disabledAt;
		expect((await enable(s.admin, s.bob)).status).toBe(200);

		expect(
			sqlite.prepare('SELECT user_id AS id, account_created AS created, ending, ended_at AS at, origin FROM account_endings ORDER BY seq').all() as unknown[]
		).toEqual([
			{ id: s.bob.id, created: row(s.bob.id).createdAt, ending: 'disabled', at: disabledAt, origin: 'here' },
			{ id: s.bob.id, created: row(s.bob.id).createdAt, ending: 'enabled', at: expect.any(String), origin: 'here' }
		]);
	});

	it('test 26 (card 2996): refuses an account the record of account endings names as deleted, 409, before the password, with nothing written; one only a seed row names is enabled', async () => {
		const s = scene();
		const gone = makeUser({ username: 'gone', disabled: { by: s.admin } });
		const created = sqlite.prepare('SELECT created_at FROM users WHERE id = ?').pluck().get(gone.id) as string;
		sqlite
			.prepare("INSERT INTO account_endings (user_id, account_created, ending, ended_at) VALUES (?, ?, 'deleted', '2026-11-19 09:00:00')")
			.run(gone.id, created);
		const sending = stepUp(s.admin);
		const before = snapshotDb();

		const res = await api('POST', `/api/users/${gone.id}/enable`, { ...sending, body: { ...sending.body, currentPassword: 'not the password' } });

		expect({ status: res.status, body: res.body }).toEqual({ status: 409, body: { message: DELETED_HERE } });
		expectUnchanged(before);

		// A seed row names an id, not this account: enabling it is the superadmin's or an administrator's to do.
		const seeded = makeUser({ username: 'seeded', disabled: { by: s.admin } });
		sqlite.prepare("INSERT INTO account_endings (user_id, account_created, ending, ended_at) VALUES (?, '', 'deleted', '2026-11-19 09:00:00')").run(seeded.id);
		const enabled = await enable(s.admin, seeded);
		expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
		expect(row(seeded.id)).toMatchObject({ disabledAt: null });
	});
});

// ─── 8. The three resets ─────────────────────────────────────────────────────

describe('a disabled account is not reset (case 8, D18)', () => {
	it.each([
		{ route: 'PUT /api/users/[id]/password', method: 'PUT' as const, path: (id: number) => `/api/users/${id}/password`, body: { password: 'a long new password' } },
		{ route: 'POST /api/users/[id]/invite', method: 'POST' as const, path: (id: number) => `/api/users/${id}/invite`, body: {} },
		{ route: 'POST /api/users/[id]/mfa/reset', method: 'POST' as const, path: (id: number) => `/api/users/${id}/mfa/reset`, body: {} }
	])('$route: 409, before the password, with nothing written', async ({ method, path, body }) => {
		const s = scene();
		const gone = makeUser({ username: 'gone', disabled: { by: s.admin } });
		const sending = stepUp(s.admin, body);
		const before = snapshotDb();

		const res = await api(method, path(gone.id), sending);

		expect({ status: res.status, body: res.body }).toEqual({ status: 409, body: { message: ENABLE_FIRST } });
		expectUnchanged(before);
	});
});

// ─── 19. An invite ───────────────────────────────────────────────────────────

describe('an invite of a disabled account (case 19)', () => {
	it('is not usable, though it is unused and live', () => {
		const user = makeUser({ username: 'invited' });
		const token = inTransaction(() => issueInvite(user.id));
		expect(usableInvite(token)).toBeDefined();

		db.update(users).set({ disabledAt: stamp() }).where(eq(users.id, user.id)).run();

		expect(usableInvite(token)).toBeUndefined();
		expect(db.select().from(inviteTokens).where(eq(inviteTokens.userId, user.id)).all()).toHaveLength(1);
		expect(db.select().from(sessions).all()).toEqual([]);
		expect(db.select().from(apiKeys).all()).toEqual([]);
	});
});

// ─── 20 to 22. Board access ──────────────────────────────────────────────────

/** `run`, and how many times it read the users table. */
function usersRead<T>(run: () => T): { result: T; reads: number } {
	const reads = watchReads('users');
	try {
		return { result: run(), reads: reads.inTransaction.length };
	} finally {
		reads.restore();
	}
}

describe('a disabled account has no board (cases 20 to 22, D11, S12)', () => {
	it('case 20: roleOnBoard reads a disabled member by id, once, and answers none', () => {
		const board = makeBoard({ owner: makeUser() }).board;
		const member = makeUser({ disabled: true });
		addBoardMember(board, member, 'editor');

		expect(usersRead(() => roleOnBoard(member, board))).toEqual({ result: null, reads: 1 });
	});

	it('case 20: a disabled administrator, carried on the row its caller read, has no board, and nothing is read again', () => {
		const board = makeBoard({ owner: makeUser() }).board;
		const admin = makeUser({ role: 'admin', disabled: true });
		const row = db.select({ id: users.id, role: users.role, disabledAt: users.disabledAt }).from(users).where(eq(users.id, admin.id)).get()!;

		expect(usersRead(() => [roleOnBoard(row, board), getBoardRole(row, board.id)])).toEqual({ result: [null, null], reads: 0 });
	});

	it('case 20: an enabled session carries its account, which a board check reads no more', () => {
		const board = makeBoard({ owner: makeUser() }).board;
		const viewer = makeUser();
		addBoardMember(board, viewer, 'viewer');
		const session = validateSession(makeSession(viewer))!.user;

		expect(session.disabledAt).toBeNull();
		expect(usersRead(() => roleOnBoard(session, board))).toEqual({ result: 'viewer', reads: 0 });
	});

	it.each([
		{ helper: 'getAccessibleBoardsAndTeams', ask: (user: Actor) => getAccessibleBoardsAndTeams(user), none: { boardIds: [], teamIds: [] } },
		{ helper: 'editableBoardIds', ask: (user: Actor) => editableBoardIds(user), none: new Set() },
		{ helper: 'ownedBoardIds', ask: (user: Actor) => ownedBoardIds(user), none: new Set() }
	])('case 21: $helper answers none for a disabled account that owns a board and is in a team, an administrator included', ({ ask, none }) => {
		for (const role of ['user', 'admin'] as const) {
			const account = makeUser({ role });
			const board = makeBoard({ owner: account }).board;
			const team = makeTeam([account]);
			shareBoardWithTeam(makeBoard({ owner: makeUser() }).board, team, 'editor');
			addBoardMember(makeBoard({ owner: makeUser() }).board, account, 'owner');
			expect(board.createdBy).toBe(account.id);
			db.update(users).set({ disabledAt: stamp() }).where(eq(users.id, account.id)).run();

			expect(ask({ id: account.id, role }), role).toEqual(none);
			// Public boards too: a disabled account opens none.
			makeBoard({ owner: makeUser(), isPublic: true });
			expect(ask({ id: account.id, role }), role).toEqual(none);
		}
	});

	it('case 22: v1 refuses to assign a disabled account, 400, in the words for one who cannot open the board', async () => {
		const owner = makeUser();
		const { board, cols } = makeBoard({ owner });
		const card = makeCard(cols['To Do']);
		const gone = makeUser({ disabled: true });
		addBoardMember(board, gone, 'editor');
		const before = snapshotDb();

		const res = await api('POST', `/api/v1/cards/${card.id}/assignees`, { user: owner, body: { userId: gone.id } });

		expect({ status: res.status, body: res.body }).toEqual({ status: 400, body: { message: 'User does not have access to this board' } });
		expectUnchanged(before);
	});
});

// ─── 24 and 25. Share and team (S11) ─────────────────────────────────────────

describe('a disabled account is given no board and no team, and may be lowered or removed (cases 24 and 25, S11)', () => {
	const share = (by: SessionUser, boardId: number, targetId: number, role: string) =>
		api('POST', `/api/boards/${boardId}/share`, { user: by, body: { type: 'user', targetId, role } });

	it.each([
		{ what: 'added', stored: null, role: 'viewer', status: 400 },
		{ what: 'raised from viewer to editor', stored: 'viewer' as const, role: 'editor', status: 400 },
		{ what: 'lowered from editor to viewer', stored: 'editor' as const, role: 'viewer', status: 200 }
	])('case 24: a share of a disabled account $what: $status', async ({ stored, role, status }) => {
		const owner = makeUser();
		const board = makeBoard({ owner }).board;
		const gone = makeUser({ disabled: true });
		if (stored) addBoardMember(board, gone, stored);

		const res = await share(owner, board.id, gone.id, role);

		expect(res.status, JSON.stringify(res.body)).toBe(status);
		if (status === 400) expect(res.body).toEqual({ message: 'That account is disabled' });
		const now = sqlite.prepare('SELECT role FROM board_members WHERE board_id = ? AND user_id = ?').pluck().get(board.id, gone.id);
		expect(now).toBe(status === 200 ? role : (stored ?? undefined));
	});

	it('case 24: a share of a disabled account is removed', async () => {
		const owner = makeUser();
		const board = makeBoard({ owner }).board;
		const gone = makeUser({ disabled: true });
		addBoardMember(board, gone, 'editor');

		const res = await api('DELETE', `/api/boards/${board.id}/share`, { user: owner, body: { type: 'user', targetId: gone.id } });

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(sqlite.prepare('SELECT COUNT(*) AS n FROM board_members WHERE user_id = ?').get(gone.id)).toEqual({ n: 0 });
	});

	it('case 25: a disabled account is not added to a team, 400; an owner that is disabled is lowered to member', async () => {
		const admin = makeUser({ role: 'admin' });
		const team = makeTeam([], 'Ops');
		const gone = makeUser({ disabled: true });
		const other = makeUser();
		const before = snapshotDb();

		const added = await api('POST', `/api/teams/${team.id}/members/${gone.id}`, { user: admin, body: { role: 'member' } });
		expect({ status: added.status, body: added.body }).toEqual({ status: 400, body: { message: 'That account is disabled' } });
		expectUnchanged(before);

		db.insert(teamMembers).values([{ teamId: team.id, userId: gone.id, role: 'owner' }, { teamId: team.id, userId: other.id, role: 'owner' }]).run();
		const lowered = await api('POST', `/api/teams/${team.id}/members/${gone.id}`, { user: admin, body: { role: 'member' } });
		expect(lowered.status, JSON.stringify(lowered.body)).toBe(200);
		expect(sqlite.prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?').pluck().get(team.id, gone.id)).toBe('member');
	});
});

// ─── 29 to 31. Requests and pickers (D12) ───────────────────────────────────

describe('a disabled account is offered in no picker, and its name stays where it is shown (cases 29 to 31)', () => {
	it('case 29: a request to a disabled account is answered as one to an account that is not there, 404', async () => {
		const asker = makeUser();
		const gone = makeUser({ disabled: true });
		const before = snapshotDb();

		const res = await api('POST', '/api/requests', { user: asker, body: { title: 'Help', targetType: 'user', targetId: gone.id } });

		expect({ status: res.status, body: res.body }).toEqual({ status: 404, body: { message: 'User not found' } });
		expectUnchanged(before);
	});

	it.each([
		{ where: 'GET /api/users, to an administrator', as: 'admin' as const, ask: (user: SessionUser) => api('GET', '/api/users', { user }), ids: (body: { id: number }[]) => body.map((u) => u.id) },
		{ where: 'GET /api/users, to a user', as: 'user' as const, ask: (user: SessionUser) => api('GET', '/api/users', { user }), ids: (body: { id: number }[]) => body.map((u) => u.id) },
		{
			where: 'the request targets',
			as: 'user' as const,
			ask: (user: SessionUser) => api('GET', '/api/requests/targets', { user }),
			ids: (body: { targets: { id: number; type: string }[] }) => body.targets.filter((t) => t.type === 'user').map((t) => t.id)
		}
	])('case 30: $where leaves a disabled account out', async ({ as, ask, ids }) => {
		const caller = makeUser({ role: as });
		const gone = makeUser({ disabled: true });

		const res = await ask(caller);

		expect(res.status).toBe(200);
		const listed = ids(res.body);
		expect(listed).toContain(caller.id);
		expect(listed).not.toContain(gone.id);
	});

	it("case 30: the inbox's assignee picker leaves a disabled account out", async () => {
		const caller = makeUser();
		const gone = makeUser({ disabled: true });

		const page = await pageLoad('/inbox', { user: caller });

		expect(page.type).toBe('data');
		const listed = (page.type === 'data' ? (page.data.users as { id: number }[]) : []).map((u) => u.id);
		expect(listed).toContain(caller.id);
		expect(listed).not.toContain(gone.id);
	});

	it('case 31: the Teams page keeps a disabled account, marked, for the names; the directory leaves it out of the accounts while the person linked names it', async () => {
		const caller = makeUser();
		const gone = makeUser({ username: 'gone', disabled: true });
		makePerson({ fullName: 'Gone Away', user: gone });

		const page = await pageLoad('/teams', { user: caller });
		const listed = page.type === 'data' ? (page.data.users as { id: number; disabled?: true }[]) : [];
		expect(listed.find((u) => u.id === gone.id)).toEqual({ id: gone.id, username: 'gone', emoji: '👤', disabled: true });
		expect(listed.find((u) => u.id === caller.id)).not.toHaveProperty('disabled');

		const directory = readDirectory();
		expect(directory.accounts.map((a) => a.id)).not.toContain(gone.id);
		expect(directory.people.find((p) => p.fullName === 'Gone Away')?.account).toEqual({ id: gone.id, username: 'gone' });
	});
});

// ─── 33, 34 and 38. Mail, and a webhook's setter ─────────────────────────────

describe('a disabled account is mailed nothing as an account holder, and its webhooks are held (cases 33, 34, 38)', () => {
	it('case 33: a card moved mails its assignees who can open the board, and not one who is disabled', async () => {
		const sent = mailing();
		const owner = makeUser();
		const { board, cols } = makeBoard({ owner });
		const card = makeCard(cols['To Do']);
		const kept = makeUser({ username: 'kept' });
		const gone = makeUser({ username: 'gone', disabled: true });
		for (const user of [kept, gone]) {
			addBoardMember(board, user, 'editor');
			assignCard(card, user);
		}

		notifyCardMoved(board.id, card.id, card.title, owner.username, 'To Do', 'Complete', owner.id, 'https://kanban.example.test');
		await sent.settle();

		expect(sent.emails.map((email) => email.to)).toEqual([kept.email]);
	});

	it('case 33: a question about a decision is not mailed to a decider whose account is disabled', async () => {
		const sent = mailing();
		db.insert(settings).values({ key: 'app_url', value: 'https://kanban.example.test' }).run();
		const decider = makeUser({ username: 'decider', disabled: true });
		const control = makeUser({ username: 'control' });

		notifyDecisionQuestion(decider.id, 1, 'Which budget?', 0);
		notifyDecisionQuestion(control.id, 1, 'Which budget?', 0);
		await sent.settle();

		expect(sent.emails.map((email) => email.to)).toEqual([control.email]);
	});

	it.each([
		{ what: "a disabled owner is left out, and the board's enabled owner told", allOwnersDisabled: false },
		{ what: "a board whose owners are all disabled is told through its enabled administrators alone", allOwnersDisabled: true }
	])('case 34: the switch-off mail: $what', async ({ allOwnersDisabled }) => {
		const sent = mailing();
		const creator = makeUser({ username: 'creator', disabled: true });
		const coOwner = makeUser({ username: 'coowner', ...(allOwnersDisabled ? { disabled: true as const } : {}) });
		const admin = makeUser({ username: 'admin', role: 'admin' });
		makeUser({ username: 'goneadmin', role: 'admin', disabled: true });
		const board = makeBoard({ owner: creator }).board;
		addBoardMember(board, coOwner, 'owner');

		notifyWebhooksSwitchedOff([{ boardId: board.id, id: 1, host: 'hooks.example.test', why: 'setter access ended' }], 'a test');
		await sent.settle();

		expect(sent.emails.map((email) => email.to).sort()).toEqual(allOwnersDisabled ? [admin.email] : [coOwner.email]);
	});

	it('case 38: a webhook whose setter was disabled after it was set is held at its next event', () => {
		const setter = makeUser();
		const board = makeBoard({ owner: setter }).board;
		const hook = makeWebhook(board, { setBy: setter });
		expect(holdOf(hook)).toBeNull();

		db.update(users).set({ disabledAt: stamp() }).where(eq(users.id, setter.id)).run();

		expect(holdOf(hook)).toBe('setter cannot open');
	});
});

// Card 2671's code review, CS6: the administrator's shortcut in the goal and decision rules is asked after whether the
// account is disabled, so a disabled administrator, or a disabled maker of a goal with no card, reaches nothing.
describe('a disabled account opens no goal and holds no role on a decision, an administrator included (CS6)', () => {
	// A session never carries a disabled account (every gate refuses one), so its type says `null`; these rules are also
	// asked with rows that carry the stamp, as here.
	const disabledAs = (user: SessionUser) => ({ ...user, disabledAt: '2099-01-02 09:00:00' }) as unknown as SessionUser;

	it('canViewMilestone and canEditMilestone: a disabled administrator, and the disabled maker of a goal across boards with no card', () => {
		const admin = makeUser({ role: 'admin' });
		const maker = makeUser();
		const { board } = makeBoard({ owner: maker });
		const onBoard = makeMilestone({ board, createdBy: maker });
		const across = makeMilestone({ createdBy: maker });
		// Enabled, each opens and changes both.
		for (const goal of [onBoard, across]) {
			expect(canViewMilestone(admin, goal)).toBe(true);
			expect(canEditMilestone(admin, goal)).toBe(true);
			expect(canViewMilestone(maker, goal)).toBe(true);
			expect(canEditMilestone(maker, goal)).toBe(true);
		}

		for (const goal of [onBoard, across]) {
			expect(canViewMilestone(disabledAs(admin), goal)).toBe(false);
			expect(canEditMilestone(disabledAs(admin), goal)).toBe(false);
			expect(canViewMilestone(disabledAs(maker), goal)).toBe(false);
			expect(canEditMilestone(disabledAs(maker), goal)).toBe(false);
		}
	});

	it('the goal lists and names (goalsShownTo and milestonesOpenAmong): none for a disabled administrator', () => {
		const admin = makeUser({ role: 'admin' });
		const owner = makeUser();
		const { board, cols } = makeBoard({ owner });
		const card = makeCard(cols['To Do']);
		const goal = makeMilestone({ board, createdBy: owner, cards: [card] });
		expect(listMilestones(admin).map((m) => m.id)).toEqual([goal.id]);
		expect(milestonesForBoard(admin, board.id).map((m) => m.id)).toEqual([goal.id]);
		expect([...milestoneIdsOpenTo(admin, [goal.id])]).toEqual([goal.id]);

		expect(listMilestones(disabledAs(admin))).toEqual([]);
		expect(milestonesForBoard(disabledAs(admin), board.id)).toEqual([]);
		expect([...milestoneIdsOpenTo(disabledAs(admin), [goal.id])]).toEqual([]);
	});

	it('decisionAccess: no role at all for a disabled administrator who is also its author and decider', () => {
		const admin = makeUser({ role: 'admin' });
		const decision = { id: 1, boardId: null, authorUserId: admin.id, deciderUserId: admin.id };
		expect([...decisionAccess(admin, decision).roles].sort()).toEqual(['admin', 'author', 'decider']);

		expect(decisionAccess(disabledAs(admin), decision)).toEqual({ roles: new Set(), participantId: null, canEditBoard: false });
	});
});
