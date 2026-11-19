/**
 * An administrator's reset of another account's two-step sign-in (card 2773):
 * POST /api/users/[id]/mfa/reset, `resetTwoStep` and `issueEnrolmentLink`,
 * the notice it mails and the checks before its link is shown, the invite
 * refused for an account that holds a second factor, and the admin load's
 * `twoStep`.
 *
 * The file is a built server's (`dev: false`), so a link has an address only
 * where a case sets the App URL. Passwords are hashed and checked on the
 * test's own thread (`PASSWORD_THREADS=0`), with the bcryptjs mocked below,
 * which counts what is hashed and lets a case act after a check or during a
 * hash, as another request would. The key is the process's own, written
 * nowhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ dev: false, building: false, browser: false, version: 'test' }));

const bcrypt = vi.hoisted(() => ({
	/** How many passwords were hashed. */
	hashed: 0,
	/** Called as a password is hashed, for a case to act while it is. */
	duringHash: undefined as (() => void) | undefined,
	/** Called after each check of a password, for a case to act between the check and the write. */
	afterCompare: undefined as (() => void) | undefined
}));

vi.mock('bcryptjs', async (importOriginal) => {
	const real = await importOriginal<typeof import('bcryptjs')>();
	return {
		...real,
		hashSync: (password: string) => {
			bcrypt.hashed++;
			bcrypt.duringHash?.();
			return real.hashSync(password, 4);
		},
		compareSync: (password: string, hash: string) => {
			const result = real.compareSync(password, hash);
			bcrypt.afterCompare?.();
			return result;
		}
	};
});

import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import {
	apiKeys,
	enrolmentLinks,
	inviteTokens,
	mfaFactors,
	mfaRecoveryCodes,
	reportSchedules,
	sessions,
	settings,
	signInChallenges,
	users,
	webhooks
} from '$lib/server/db/schema';
import { inTransaction } from '$lib/server/db/transaction';
import { MAIL_PROBLEM_WORDS, NO_LINK_ADDRESS } from '$lib/server/email';
import { sha256Hex } from '$lib/server/mfa-crypto';
import { ENROLMENT_LINK_LIFETIME_MS, addTotpFactor, issueEnrolmentLink, storeRecoveryCodes } from '$lib/server/mfa-store';
import { newRecoveryCodes } from '$lib/server/recovery-codes';
import { mailPlacesNow, recordDestinationSetter, recordMailSetters, settingsHeldBy } from '$lib/server/setting-setters';
import { newTotpSecret } from '$lib/server/totp';
import { isStamp, parseStamp, stamp } from '$lib/timestamps';
import { api } from './helpers/api';
import { action, pageLoad } from './helpers/actions';
import { effects, type Effects } from './helpers/effects';
import {
	FIXTURE_PASSWORD_HASH,
	inviteHashOf,
	makeApiKey,
	makeApiKeyRow,
	makeBoard,
	makeSession,
	makeSmtp,
	makeUser,
	makeWebhook,
	resetDb,
	stepUp
} from './helpers/fixtures';
import { diffSnapshots, expectUnchanged, snapshotDb } from './helpers/snapshot';

const BASE = 'https://dumpfire.example.test';
const setAppUrl = () => db.insert(settings).values({ key: 'app_url', value: BASE }).run();

const reset = (by: Parameters<typeof stepUp>[0], accountId: number) =>
	api('POST', `/api/users/${accountId}/mfa/reset`, stepUp(by));

const factorsOf = (userId: number) => db.select().from(mfaFactors).where(eq(mfaFactors.userId, userId)).all();
const linksOf = (userId: number) => db.select().from(enrolmentLinks).where(eq(enrolmentLinks.userId, userId)).all();
const userRow = (userId: number) => db.select().from(users).where(eq(users.id, userId)).get()!;

/** A factor of the account, sealed under the process's key. */
const giveFactor = (userId: number) => addTotpFactor(userId, 'Phone', newTotpSecret());

/** A pending sign-in of the account, as card 2769 will write one. */
function giveChallenge(userId: number): void {
	db.insert(signInChallenges)
		.values({
			tokenHash: sha256Hex(`challenge-${userId}-${randomBytes(4).toString('hex')}`),
			shortId: `c${userId}`,
			userId,
			purpose: 'sign-in',
			lane: 'other',
			passwordHash: '$2b$04$notareal.hash',
			expiresAt: stamp(new Date(Date.now() + 10 * 60 * 1000))
		})
		.run();
}

/** An invite of the account that has not been used, good for a week: stored as its hash, the token returned (card 2849). */
function giveInvite(userId: number, token = `invite-${userId}-${randomBytes(4).toString('hex')}`): string {
	db.insert(inviteTokens).values({ tokenHash: inviteHashOf(token), userId, expiresAt: stamp(new Date(Date.now() + ENROLMENT_LINK_LIFETIME_MS)) }).run();
	return token;
}

/** When a report schedule was last changed before the reset: a day before the case runs. */
const EARLIER = stamp(new Date(Date.now() - 24 * 60 * 60 * 1000));

/** A report schedule of the account, on unless told, last changed `EARLIER` (card 2894). */
const giveSchedule = (userId: number, enabled = true) =>
	db.insert(reportSchedules).values({ userId, name: 'Weekly', scope: 'all', enabled, updatedAt: EARLIER }).returning().get().id;

/** A report schedule's switch and when it was last changed, as stored. */
const scheduleOf = (id: number) =>
	db.select({ enabled: reportSchedules.enabled, updatedAt: reportSchedules.updatedAt }).from(reportSchedules).where(eq(reportSchedules.id, id)).get()!;

/**
 * A live API key, Deploy, and a webhook the account set on its board Sales,
 * whose address holds a secret in its query (card 2894, S14): with when each
 * was made, as stored.
 */
function giveKeyAndWebhook(holder: Parameters<typeof makeApiKey>[0]): { keyMade: string; hookMade: string; hookId: number } {
	makeApiKey(holder, 'Deploy');
	const hook = makeWebhook(makeBoard({ owner: holder, name: 'Sales' }).board, { url: 'https://hooks.example.test/x?secret=s', setBy: holder });
	const key = db.select({ createdAt: apiKeys.createdAt }).from(apiKeys).where(eq(apiKeys.userId, holder.id)).get()!;
	return { keyMade: key.createdAt, hookMade: hook.createdAt, hookId: hook.id };
}

/** A webhook's switch and hold, as stored (card 2915). */
const hookOf = (id: number) =>
	db.select({ active: webhooks.active, heldBecause: webhooks.heldBecause, heldAt: webhooks.heldAt }).from(webhooks).where(eq(webhooks.id, id)).get()!;

/** The holder's own notice of the reset, by its subject (card 2923, E2): the board's owners' mail may go beside it. */
const HOLDER_NOTICE = 'Your DumpFire two-step sign-in was reset';

let sent: Effects;

beforeEach(() => {
	resetDb();
	bcrypt.hashed = 0;
	bcrypt.duringHash = undefined;
	bcrypt.afterCompare = undefined;
	// The CRITICAL line of a reset is printed as well as kept.
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	if (sent) sent.restore();
	sent = undefined as unknown as Effects;
	vi.restoreAllMocks();
});

describe('POST /api/users/[id]/mfa/reset', () => {
	it("T1: resets every part of decision 11, ends the account's keys (card 2915), keeps the rest, issues one link it shows once, and logs one CRITICAL line with no token", async () => {
		setAppUrl();
		sent = effects();
		const admin = makeUser({ role: 'admin', username: 'ada' });
		const holder = makeUser({ username: 'holder' });
		giveFactor(holder.id);
		storeRecoveryCodes(holder.id, newRecoveryCodes());
		makeSession(holder);
		makeSession(holder);
		giveChallenge(holder.id);
		db.insert(enrolmentLinks)
			.values({ tokenHash: sha256Hex('an older link'), userId: holder.id, issuedBy: 'admin-reset', expiresAt: stamp(new Date(Date.now() + 60_000)) })
			.run();
		giveInvite(holder.id);
		makeApiKey(holder);
		const later = stamp(new Date(Date.now() + 60 * 60 * 1000));
		db.update(users)
			.set({
				mfaKnownWrong: 2,
				mfaOtherWrong: 3,
				mfaRecoveryWrong: 4,
				mfaKnownResumesAt: later,
				mfaOtherResumesAt: later,
				mfaRecoveryResumesAt: later,
				failedCodesSinceSignIn: 5,
				securityBanner: 'codes-failed',
				securityBannerAt: stamp(),
				// As the release migration leaves an account with no factor and no
				// link (card 2769): the reset must close password-only set-up.
				mfaPasswordEnrol: 1
			})
			.where(eq(users.id, holder.id))
			.run();
		const before = userRow(holder.id);
		const keyIds = db.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.userId, holder.id)).all().map((key) => key.id);

		const res = await reset(admin, holder.id);

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(res.body).toMatchObject({
			success: true,
			mailSent: false,
			factorsRemoved: 1,
			recoveryCodesRemoved: 10,
			sessionsEnded: 2,
			challengesEnded: 1,
			invitesEnded: 1,
			// Card 2915: the key ended; the account set no webhook.
			apiKeysEnded: 1,
			webhooksSwitchedOff: 0,
			// Card 2894 (E21): none was on.
			reportSchedulesPaused: 0
		});
		expect(res.body).not.toHaveProperty('mailProblem');
		const url: string = res.body.enrolmentUrl;
		expect(url.startsWith(`${BASE}/enrol/`)).toBe(true);
		const token = url.slice(`${BASE}/enrol/`.length);
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

		// Decision 11's deletes and zeroes.
		expect(factorsOf(holder.id)).toEqual([]);
		expect(db.select().from(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, holder.id)).all()).toEqual([]);
		expect(db.select().from(sessions).where(eq(sessions.userId, holder.id)).all()).toEqual([]);
		expect(db.select().from(signInChallenges).where(eq(signInChallenges.userId, holder.id)).all()).toEqual([]);
		expect(db.select().from(inviteTokens).where(eq(inviteTokens.userId, holder.id)).all()).toEqual([]);
		const after = userRow(holder.id);
		expect(after).toEqual({
			...before,
			mfaKnownWrong: 0,
			mfaOtherWrong: 0,
			mfaRecoveryWrong: 0,
			mfaKnownResumesAt: null,
			mfaOtherResumesAt: null,
			mfaRecoveryResumesAt: null,
			mfaPasswordEnrol: 0
		});
		// Kept: the password, the banner and the failed codes since the last sign-in. Ended: the key (card 2915).
		expect(after.passwordHash).toBe(FIXTURE_PASSWORD_HASH);
		expect(after.securityBanner).toBe('codes-failed');
		expect(after.failedCodesSinceSignIn).toBe(5);
		expect(db.select().from(apiKeys).where(eq(apiKeys.userId, holder.id)).all()).toEqual([]);

		// One link, the one shown: its hash stored, issued by the reset, for seven days.
		const links = linksOf(holder.id);
		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({ tokenHash: sha256Hex(token), issuedBy: 'admin-reset' });
		const expires = parseStamp(links[0].expiresAt)!.getTime();
		expect(Math.abs(expires - (Date.now() + ENROLMENT_LINK_LIFETIME_MS))).toBeLessThan(60_000);

		// One CRITICAL line naming both accounts, and no token anywhere in the log.
		const lines = sqlite.prepare("SELECT level, context, message, meta, user_id AS userId FROM system_logs WHERE level = 'CRITICAL'").all() as {
			level: string;
			context: string;
			message: string;
			meta: string;
			userId: number;
		}[];
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ context: 'AUTH', userId: admin.id });
		expect(lines[0].message).toBe(
			`Two-step sign-in reset for user ${holder.id} ("holder") by "ada": removed 1 factor(s) and 10 recovery code(s), ` +
				'ended 2 session(s), 1 pending sign-in(s), 1 invite(s) and 1 API key(s), switched off 0 webhook(s) they set up, ' +
				'and paused 0 report schedule(s); an enrolment link was issued'
		);
		expect(JSON.parse(lines[0].meta)).toMatchObject({
			targetUserId: holder.id,
			resetBy: admin.id,
			factorsRemoved: 1,
			// Card 2915: the fields of what ended, and of what the host's --keep-api-keys would keep; the key by
			// its id alone (the code review's CS2).
			apiKeysEnded: 1,
			apiKeyIds: keyIds,
			webhooksSwitchedOff: 0,
			webhookIds: [],
			apiKeysKept: false,
			liveApiKeysKept: 0,
			webhooksKept: 0,
			keptWebhookIds: []
		});
		expect(JSON.stringify(sqlite.prepare('SELECT message, meta FROM system_logs').all())).not.toContain(token);
		expect(sent.duringTransaction).toEqual([]);
	});

	it.each([
		{ case: 'T2', who: 'own account', status: 403, says: /Account page/ },
		{ case: 'T3', who: 'the superadmin', status: 403, says: /scripts\/mfa-reset\.mjs/ },
		{ case: 'T4', who: 'an admin, by an admin', status: 403, says: /Only superadmin can reset an admin's two-step sign-in/ }
	])('$case: refuses $who, and changes nothing', async ({ who, status, says }) => {
		setAppUrl();
		const admin = makeUser({ role: 'admin' });
		const chief = makeUser({ role: 'superadmin' });
		const other = makeUser({ role: 'admin' });
		const account = who === 'own account' ? admin : who === 'the superadmin' ? chief : other;
		giveFactor(account.id);
		const request = stepUp(admin);
		const before = snapshotDb();

		const res = await api('POST', `/api/users/${account.id}/mfa/reset`, request);

		expect(res.status).toBe(status);
		expect(res.body.message).toMatch(says);
		expectUnchanged(before);
	});

	it('T5: with no address to make the link from, answers 503 and changes nothing', async () => {
		const admin = makeUser({ role: 'admin' });
		const holder = makeUser();
		giveFactor(holder.id);
		const request = stepUp(admin);
		const before = snapshotDb();

		const res = await api('POST', `/api/users/${holder.id}/mfa/reset`, request);

		expect(res.status).toBe(503);
		expect(res.body.message).toBe(NO_LINK_ADDRESS);
		expectUnchanged(before);
	});

	it("T6: with mail set up, sends one notice to the account's address naming the admin, holding no token and no link", async () => {
		setAppUrl();
		makeSmtp();
		sent = effects();
		const admin = makeUser({ role: 'admin', username: 'ada' });
		const holder = makeUser({ username: 'holder' });
		giveFactor(holder.id);

		const res = await reset(admin, holder.id);

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.mailSent).toBe(true);
		const token = (res.body.enrolmentUrl as string).split('/enrol/')[1];
		expect(sent.emails).toHaveLength(1);
		const [mail] = sent.emails;
		expect(mail.to).toBe(holder.email);
		expect(mail.html).toContain('ada');
		// The account had a factor, so the notice says what stopped working (card 2773's review).
		expect(mail.html).toContain('Your authenticator and your recovery codes no longer work');
		expect(mail.html).not.toContain('had no authenticator');
		expect(mail.html).toContain('Use only a link an administrator hands you directly.');
		expect(mail.html).not.toContain(token);
		expect(mail.html).not.toContain('/enrol/');
		expect(mail.subject).not.toContain(token);
		expect(sent.duringTransaction).toEqual([]);
	});

	it('T7: with mail not set up, attempts no send and says the mail was not sent', async () => {
		setAppUrl();
		sent = effects();
		const admin = makeUser({ role: 'admin' });
		const holder = makeUser();
		giveFactor(holder.id);

		const res = await reset(admin, holder.id);

		expect(res.status).toBe(200);
		expect(res.body.mailSent).toBe(false);
		// Mail that is not set up is no problem to report: the page adds no "not sent" words (card 2773's review).
		expect(res.body).not.toHaveProperty('mailProblem');
		expect(sent.all).toEqual([]);
		expect(sent.refusedMail).toEqual([]);
	});

	// The second row is the branch of a mail set up with its password missing, as a restore leaves it
	// (card 2169): no send is attempted, and the problem names the password (slice 2's amendment).
	it.each([
		{ fault: 'the notice fails', passwordMissing: false, refused: 1, problem: undefined },
		{ fault: "mail's password is missing", passwordMissing: true, refused: 0, problem: MAIL_PROBLEM_WORDS['no-password'] }
	])('T8: when $fault, the reset stands and the link is shown, with the problem in words', async ({ passwordMissing, refused, problem }) => {
		setAppUrl();
		makeSmtp();
		if (passwordMissing) db.insert(settings).values({ key: 'smtp_user', value: 'dumpfire' }).run();
		const admin = makeUser({ role: 'admin' });
		const holder = makeUser();
		giveFactor(holder.id);
		sent = effects({ refuseMailTo: [holder.email] });

		const res = await reset(admin, holder.id);

		expect(res.status).toBe(200);
		expect(res.body.mailSent).toBe(false);
		expect(typeof res.body.mailProblem).toBe('string');
		if (problem !== undefined) {
			expect(res.body.mailProblem).toBe(problem);
			expect(res.body.mailProblem).toMatch(/mail password/);
		}
		expect(res.body.enrolmentUrl).toMatch(new RegExp(`^${BASE}/enrol/[A-Za-z0-9_-]{43}$`));
		expect(sent.refusedMail).toHaveLength(refused);
		expect(sent.emails).toEqual([]);
		expect(factorsOf(holder.id)).toEqual([]);
		expect(linksOf(holder.id)).toHaveLength(1);
	});

	it('T9: resets an account with no factor, issuing a link, and its notice says it had none', async () => {
		setAppUrl();
		makeSmtp();
		sent = effects();
		const admin = makeUser({ role: 'admin' });
		const holder = makeUser();

		const res = await reset(admin, holder.id);

		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ success: true, factorsRemoved: 0, mailSent: true });
		expect(res.body.enrolmentUrl).toMatch(new RegExp(`^${BASE}/enrol/`));
		expect(linksOf(holder.id)).toHaveLength(1);
		// Nothing stopped working, so the notice does not say it did (card 2773's review).
		expect(sent.emails).toHaveLength(1);
		const [mail] = sent.emails;
		expect(mail.html).toContain('Your account had no authenticator set up: its two-step sign-in was reset and a new set-up link issued');
		expect(mail.html).not.toContain('no longer work');
	});

	it('T11: refuses inside the transaction when the account was made an administrator after the password was checked', async () => {
		setAppUrl();
		const admin = makeUser({ role: 'admin' });
		const holder = makeUser();
		giveFactor(holder.id);
		const request = stepUp(admin);
		let before: ReturnType<typeof snapshotDb> | undefined;
		bcrypt.afterCompare = () => {
			bcrypt.afterCompare = undefined;
			db.update(users).set({ role: 'admin' }).where(eq(users.id, holder.id)).run();
			before = snapshotDb();
		};

		const res = await api('POST', `/api/users/${holder.id}/mfa/reset`, request);

		expect(res.status).toBe(403);
		expect(res.body.message).toBe("Only superadmin can reset an admin's two-step sign-in");
		expect(before).toBeDefined();
		// Nothing changed but the caller's code spent and the session clearing the
		// check it counted while the password was compared (cards 2701 and 2771):
		// a refusal after the check leaves the code spent (S4).
		expect(diffSnapshots(before!, snapshotDb())).toEqual([
			expect.stringMatching(/^mfa_factors: row \d+ changed \(last_step: null became \d+; last_used_at: null became /),
			'sessions: row 1 changed (wrong_password_count: 1 became 0)'
		]);
		expect(factorsOf(holder.id)).toHaveLength(1);
		expect(linksOf(holder.id)).toEqual([]);
	});

	// Each of decision 15's three checks failing while the notice is sent (card 2773's review): the change is
	// made as the mail is handed to the transport, as another request would make it meanwhile.
	it.each<{ check: 'session' | 'rule' | 'link'; meanwhile: string; change: (adminId: number, holderId: number) => void }>([
		{
			check: 'session',
			meanwhile: "the caller's session ends",
			change: (adminId) => {
				db.delete(sessions).where(eq(sessions.userId, adminId)).run();
			}
		},
		{
			check: 'rule',
			meanwhile: "the account is made an administrator, beyond the caller's reach",
			change: (_adminId, holderId) => {
				db.update(users).set({ role: 'admin' }).where(eq(users.id, holderId)).run();
			}
		},
		{
			check: 'link',
			meanwhile: 'a newer reset of the account issues another link',
			change: (_adminId, holderId) => {
				inTransaction(() => issueEnrolmentLink(holderId, 'admin-reset'));
			}
		}
	])('T12 ($check): when $meanwhile while the notice is sent, the reset stands and the link is withheld', async ({ check, change }) => {
		setAppUrl();
		makeSmtp();
		const admin = makeUser({ role: 'admin' });
		const holder = makeUser();
		giveFactor(holder.id);
		sent = effects({
			mailRefusal: () => {
				change(admin.id, holder.id);
				return undefined;
			}
		});

		// The withheld link's WARN line is kept only where LOG_LEVEL lets a WARN line through.
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'INFO';
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'info').mockImplementation(() => {});
		let res: Awaited<ReturnType<typeof reset>>;
		try {
			res = await reset(admin, holder.id);
		} finally {
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		}

		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(res.body).toMatchObject({ success: true, mailSent: true, enrolmentUrl: null });
		expect(res.body.message).toMatch(/Run the reset again/);
		expect(factorsOf(holder.id)).toEqual([]);
		expect(linksOf(holder.id)).toHaveLength(1);
		const withheld = sqlite
			.prepare("SELECT meta FROM system_logs WHERE level = 'WARN' AND message LIKE '%was not given to them%'")
			.all() as { meta: string }[];
		expect(withheld).toHaveLength(1);
		expect(JSON.parse(withheld[0].meta)).toMatchObject({ accountId: holder.id, check });
	});

	// Card 2894 (case 2, D2, S14, E24): both branches of the message, the link shown and withheld (a newer link
	// issued while the notice is sent, as T12's third row). Card 2915 (case 2, E9, S5): the keys ended and the
	// webhook switched off with its hold, another account's left, and the answer, the message and the mail agree.
	it.each([
		{ branch: 'the link shown', withheld: false },
		{ branch: 'the link withheld', withheld: true }
	])(
		"T17 (card 2894, card 2915, $branch): pauses the holder's report schedules that are on, ends their keys, switches off their webhooks, and says how many, with the day each was made where the link is shown, naming none",
		async ({ withheld }) => {
			setAppUrl();
			makeSmtp();
			const admin = makeUser({ role: 'admin', username: 'ada' });
			const holder = makeUser({ username: 'holder' });
			const other = makeUser();
			giveFactor(holder.id);
			const on = [giveSchedule(holder.id), giveSchedule(holder.id)];
			const off = giveSchedule(holder.id, false);
			const theirs = giveSchedule(other.id);
			const ended = giveKeyAndWebhook(holder);
			// Another account's key and webhook, which nothing may touch.
			makeApiKey(other, 'Theirs');
			const othersHook = makeWebhook(makeBoard({ owner: other, name: 'Elsewhere' }).board, { url: 'https://other.example.test/in', setBy: other });
			const othersKeys = db.select().from(apiKeys).where(eq(apiKeys.userId, other.id)).all();
			sent = effects(
				withheld
					? {
							mailRefusal: () => {
								inTransaction(() => issueEnrolmentLink(holder.id, 'admin-reset'));
								return undefined;
							}
						}
					: {}
			);
			vi.spyOn(console, 'warn').mockImplementation(() => {});

			const res = await reset(admin, holder.id);

			expect(res.status, JSON.stringify(res.body)).toBe(200);
			expect(res.body.reportSchedulesPaused).toBe(2);
			expect(res.body.enrolmentUrl === null).toBe(withheld);
			// Card 2915 (E9): what ended, in both branches.
			expect(res.body).toMatchObject({ apiKeysEnded: 1, webhooksSwitchedOff: 1 });
			// What ended, by count and the day each was made, where the link is given; by count alone where it is
			// withheld (the code review's CS2).
			expect(res.body.message).toBe(
				withheld
					? "holder's two-step sign-in was reset, but its link cannot be shown to you now. Run the reset again to issue a new one." +
							' Their 2 report schedules were paused. Their 1 API key was ended and the 1 webhook they set up switched off.' +
							' holder was sent a notice that holds no link.'
					: "holder's two-step sign-in was reset. Give them the link yourself: it is shown once, and works for seven days." +
							` Their 2 report schedules were paused. Their 1 API key (made ${ended.keyMade.slice(0, 10)}) was ended and the 1 webhook ` +
							`they set up (made ${ended.hookMade.slice(0, 10)}) switched off; the lists are in the notice mailed to them.` +
							' holder was sent a notice that holds no link.'
			);
			// Never a key's name, a board's name or a host: the caller may not open the board (CS2).
			for (const text of ['Deploy', 'Sales', 'hooks.example.test', 'secret=s']) expect(res.body.message).not.toContain(text);

			// The holder's key deleted and webhook switched off with its hold; another account's as they were.
			expect(db.select().from(apiKeys).where(eq(apiKeys.userId, holder.id)).all()).toEqual([]);
			const hook = hookOf(ended.hookId);
			expect(hook).toMatchObject({ active: false, heldBecause: 'setter access ended' });
			expect(isStamp(hook.heldAt)).toBe(true);
			expect(db.select().from(apiKeys).where(eq(apiKeys.userId, other.id)).all()).toEqual(othersKeys);
			expect(hookOf(othersHook.id)).toEqual({ active: true, heldBecause: null, heldAt: null });
			// S5: the count the message says, the answer's and the mail's list of webhooks are the one switch-off's.
			// Card 2923 (E2): the holder's notice selected by its subject; beside it, the board's owners' mail, one: since
			// card 2935's code review (C11d) not to the holder, the board's only owner, whose access the reset ended, but to
			// its administrator.
			const [mail] = sent.emails.filter((email) => email.subject === HOLDER_NOTICE);
			expect(sent.emails.filter((email) => email.subject !== HOLDER_NOTICE).map((email) => [email.to, email.subject])).toEqual([
				[admin.email, 'A webhook on your board was switched off']
			]);
			// The kind of action and no account (card 2923's code review, S5): neither the holder nor the administrator is named.
			const owners = sent.emails.find((email) => email.subject !== HOLDER_NOTICE)!.html;
			// Card 2935: the kind of action without a subject; the item says whose it was.
			expect(owners).toContain('What caused it: an account had its two-step sign-in reset by an administrator.');
			for (const name of [/\bholder\b/, /\bada\b/]) expect(owners).not.toMatch(name);
			const listed = mail.html.match(/<li>[^<]*, to [^<]*: made [^<]*<\/li>/g) ?? [];
			expect(listed).toEqual([`<li>Sales, to hooks.example.test: made ${ended.hookMade} UTC</li>`]);
			expect(Number(/the (\d+) webhook/.exec(res.body.message)?.[1])).toBe(res.body.webhooksSwitchedOff);
			expect(listed).toHaveLength(res.body.webhooksSwitchedOff);

			// The holder's two that were on paused and stamped; the one already off, and another account's, as they were.
			for (const id of on) {
				const row = scheduleOf(id);
				expect(row.enabled).toBe(false);
				expect(row.updatedAt).not.toBe(EARLIER);
				expect(isStamp(row.updatedAt)).toBe(true);
			}
			expect(scheduleOf(off)).toEqual({ enabled: false, updatedAt: EARLIER });
			expect(scheduleOf(theirs)).toEqual({ enabled: true, updatedAt: EARLIER });

			const lines = sqlite.prepare("SELECT message, meta FROM system_logs WHERE level = 'CRITICAL'").all() as { message: string; meta: string }[];
			expect(lines).toHaveLength(1);
			expect(lines[0].message).toContain(
				`and 1 API key(s), switched off 1 webhook(s) they set up (id ${ended.hookId}), and paused 2 report schedule(s) ` +
					`(ids ${on[0]}, ${on[1]}); an enrolment link was issued`
			);
			expect(JSON.parse(lines[0].meta)).toMatchObject({ reportSchedulesPaused: 2, reportScheduleIds: on });
		}
	);

	// Card 2894 (case 5, E24, S14): the mail says the count above nought, in the singular for one; the message says the
	// same count, one row per wording (the code review's CR1 and CS2). Card 2915 (case 3, E5): each row pins the whole
	// message, what ended said by count and the day each was made, and the mail names each key and webhook ended, or
	// nothing of keys where none did. `D` in a row's words is the day the keys and the webhooks were made, all today.
	// The code review's CR2: the withheld branch for a key alone, a webhook alone and neither, the notice not sent with
	// one list, and two webhooks.
	it.each<{
		row: string;
		paused: number;
		keys: number;
		endedKey?: boolean;
		hooks: number;
		refused?: boolean;
		withheld?: boolean;
		says: string | null;
		message: string;
	}>([
		{
			row: 'none paused',
			paused: 0,
			keys: 1,
			hooks: 1,
			says: null,
			message: ' Their 1 API key (made D) was ended and the 1 webhook they set up (made D) switched off; the lists are in the notice mailed to them.'
		},
		{
			row: 'one paused',
			paused: 1,
			keys: 1,
			hooks: 1,
			says: 'Your 1 report schedule was paused',
			message:
				' Their 1 report schedule was paused. Their 1 API key (made D) was ended and the 1 webhook they set up (made D) switched off; ' +
				'the lists are in the notice mailed to them.'
		},
		{
			row: 'two paused',
			paused: 2,
			keys: 1,
			hooks: 1,
			says: 'Your 2 report schedules were paused',
			message:
				' Their 2 report schedules were paused. Their 1 API key (made D) was ended and the 1 webhook they set up (made D) switched off; ' +
				'the lists are in the notice mailed to them.'
		},
		{ row: 'neither a key nor a webhook', paused: 0, keys: 0, hooks: 0, says: null, message: ' They had no API key and no webhook they set up.' },
		{
			row: 'a key and no webhook',
			paused: 0,
			keys: 1,
			hooks: 0,
			says: null,
			message: ' Their 1 API key (made D) was ended, and they had no webhook they set up; the list is in the notice mailed to them.'
		},
		{
			row: 'a webhook and no key',
			paused: 0,
			keys: 0,
			hooks: 1,
			says: null,
			message: ' They had no API key, and the 1 webhook they set up (made D) was switched off; the list is in the notice mailed to them.'
		},
		{
			row: 'two keys',
			paused: 0,
			keys: 2,
			hooks: 0,
			says: null,
			message: ' Their 2 API keys (made D and D) were ended, and they had no webhook they set up; the list is in the notice mailed to them.'
		},
		{
			row: 'two webhooks',
			paused: 0,
			keys: 0,
			hooks: 2,
			says: null,
			message: ' They had no API key, and the 2 webhooks they set up (made D and D) were switched off; the list is in the notice mailed to them.'
		},
		{
			row: 'the notice not sent',
			paused: 0,
			keys: 1,
			hooks: 1,
			refused: true,
			says: null,
			message:
				' Their 1 API key (made D) was ended and the 1 webhook they set up (made D) switched off; the notice with the lists was not sent: ' +
				'tell them how many ended and the day each was made.'
		},
		{
			row: 'the notice not sent, one list',
			paused: 0,
			keys: 1,
			hooks: 0,
			refused: true,
			says: null,
			message:
				' Their 1 API key (made D) was ended, and they had no webhook they set up; the notice with the list was not sent: ' +
				'tell them how many ended and the day each was made.'
		},
		{ row: 'the link withheld, a key alone', paused: 0, keys: 1, hooks: 0, withheld: true, says: null, message: ' Their 1 API key was ended.' },
		{ row: 'the link withheld, a webhook alone', paused: 0, keys: 0, hooks: 1, withheld: true, says: null, message: ' The 1 webhook they set up was switched off.' },
		{ row: 'the link withheld, neither', paused: 0, keys: 0, hooks: 0, withheld: true, says: null, message: '' },
		// Card 2915 (case 3, row 9): a key that had already ended is deleted and counted in the answer, and is not said or named.
		{
			row: 'a key that had already ended beside a live one',
			paused: 0,
			keys: 1,
			endedKey: true,
			hooks: 0,
			says: null,
			message: ' Their 1 API key (made D) was ended, and they had no webhook they set up; the list is in the notice mailed to them.'
		}
	])(
		"T18 (card 2894, card 2915, $row): the reset's mail and message say how many schedules were paused and what ended",
		async ({ paused, keys, endedKey, hooks, refused, withheld, says, message }) => {
			setAppUrl();
			makeSmtp();
			const admin = makeUser({ role: 'admin' });
			const holder = makeUser({ username: 'holder' });
			sent = effects(
				refused
					? { refuseMailTo: [holder.email] }
					: withheld
						? {
								// A newer link issued while the notice is sent, as T12's third row: the link is withheld.
								mailRefusal: () => {
									inTransaction(() => issueEnrolmentLink(holder.id, 'admin-reset'));
									return undefined;
								}
							}
						: {}
			);
			vi.spyOn(console, 'warn').mockImplementation(() => {});
			giveFactor(holder.id);
			for (let i = 0; i < paused; i++) giveSchedule(holder.id);
			for (let i = 0; i < keys; i++) makeApiKey(holder, `Deploy ${i + 1}`);
			const keysMade = db.select({ createdAt: apiKeys.createdAt }).from(apiKeys).where(eq(apiKeys.userId, holder.id)).all().map((key) => key.createdAt);
			const old = endedKey ? makeApiKeyRow(holder, { expiresAt: stamp(new Date(Date.now() - 24 * 60 * 60 * 1000)) }) : null;
			const oldName = old === null ? null : db.select({ name: apiKeys.name }).from(apiKeys).where(eq(apiKeys.id, old.id)).get()!.name;
			const board = hooks === 0 ? null : makeBoard({ owner: holder, name: 'Sales' }).board;
			const made: string[] = [];
			for (let i = 0; i < hooks; i++) made.push(makeWebhook(board!, { url: `https://hooks.example.test/x${i}?secret=s`, setBy: holder }).createdAt);
			const day = (keysMade[0] ?? made[0] ?? '').slice(0, 10);
			for (const at of [...keysMade, ...made]) expect(at.slice(0, 10)).toBe(day);

			const res = await reset(admin, holder.id);

			expect(res.status).toBe(200);
			expect(res.body.reportSchedulesPaused).toBe(paused);
			expect(res.body.enrolmentUrl === null).toBe(withheld === true);
			// Every row ended, the one that had already ended among them (F3).
			expect(res.body).toMatchObject({ apiKeysEnded: keys + (endedKey ? 1 : 0), webhooksSwitchedOff: hooks });
			expect(res.body.message).toBe(
				(withheld
					? "holder's two-step sign-in was reset, but its link cannot be shown to you now. Run the reset again to issue a new one."
					: "holder's two-step sign-in was reset. Give them the link yourself: it is shown once, and works for seven days.") +
					message.replaceAll('D', day) +
					(refused ? '' : ' holder was sent a notice that holds no link.')
			);
			if (says === null) expect(res.body.message).not.toContain('report schedule');
			for (const text of ['Deploy', 'Sales', 'hooks.example.test', ...(oldName === null ? [] : [oldName])]) expect(res.body.message).not.toContain(text);
			if (refused) {
				// The holder's notice refused; the owners' mail goes to the administrator (card 2935's code review, C11d).
				expect(sent.emails.map((email) => email.to)).toEqual(hooks === 0 ? [] : [admin.email]);
				return;
			}
			// Card 2923 (E2): the holder's notice by its subject, and beside it, where a webhook was switched off, the
			// board's owners' mail: since card 2935's code review (C11d) not to the holder, its only owner, whose
			// access the reset ended, but to the administrator.
			expect(sent.emails.filter((email) => email.subject === HOLDER_NOTICE)).toHaveLength(1);
			expect(sent.emails.filter((email) => email.subject !== HOLDER_NOTICE).map((email) => email.to)).toEqual(hooks === 0 ? [] : [admin.email]);
			const [mail] = sent.emails.filter((email) => email.subject === HOLDER_NOTICE);
			if (says === null) {
				expect(mail.html).not.toContain('report schedule');
			} else {
				expect(mail.html).toContain(says);
				expect(mail.html).toContain('Turn on the ones you recognise on the Reports page');
			}
			// The mail names each that ended, with when it was made (S14), and what to do; nothing of keys where none ended.
			if (keys === 0 && hooks === 0) {
				expect(mail.html).not.toContain('API key');
				expect(mail.html).not.toContain('webhook');
			} else {
				expect(mail.html).toContain('The reset also ended your API keys and switched off the webhooks you set up:');
				expect(mail.html).toContain('Make new keys for the scripts you recognise once your new authenticator is set up.');
			}
			for (let i = 0; i < keys; i++) expect(mail.html).toContain(`Deploy ${i + 1}: made ${keysMade[i]} UTC, never used`);
			expect(mail.html.match(/<li>Sales, to hooks\.example\.test: made [^<]* UTC<\/li>/g) ?? []).toEqual(
				made.map((at) => `<li>Sales, to hooks.example.test: made ${at} UTC</li>`)
			);
			if (oldName !== null) expect(mail.html).not.toContain(oldName);
			expect(mail.html).not.toContain('secret=s');
		}
	);

	// Card 2915 (case 4, S1): the settings the account set, said where the link is given, never a destination's name.
	// The code review's CR2: two destinations in the plural, and nothing of settings where the link is withheld.
	it.each([
		{ row: 'one destination', destinations: 1, withheld: false, says: ' They set the mail settings, 1 backup destination and the App URL: review them on the admin page.' },
		{ row: 'two destinations', destinations: 2, withheld: false, says: ' They set the mail settings, 2 backup destinations and the App URL: review them on the admin page.' },
		{ row: 'the link withheld', destinations: 1, withheld: true, says: null }
	])('T19 (card 2915, $row): the superadmin resetting an administrator recorded as setter of settings is told to review them', async ({ destinations, withheld, says }) => {
		const chief = makeUser({ role: 'superadmin', username: 'chief' });
		const admin = makeUser({ role: 'admin', username: 'ada' });
		giveFactor(admin.id);
		// Ada recorded as setter of the mail settings, the App URL and the destinations, as their saves record them.
		const before = mailPlacesNow();
		setAppUrl();
		makeSmtp();
		sent = effects(
			withheld
				? {
						mailRefusal: () => {
							inTransaction(() => issueEnrolmentLink(admin.id, 'admin-reset'));
							return undefined;
						}
					}
				: {}
		);
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		recordMailSetters(before, { id: admin.id, superadmin: false }, true);
		const names = ['Offsite copies', 'Second copies'].slice(0, destinations);
		const list = names.map((name, i) => ({ type: 's3', name, region: 'eu-west-2', bucket: `ada-bucket-${i}`, accessKeyId: 'AKIA', secretAccessKey: 'secret', prefix: '' }));
		db.insert(settings).values({ key: 'backup_config', value: JSON.stringify({ destinations: list }) }).run();
		for (const destination of list) recordDestinationSetter(destination, admin.id);
		expect(settingsHeldBy(admin.id).get(admin.id)).toEqual({ mail: true, appUrl: true, destinations: names });

		const res = await reset(chief, admin.id);

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.enrolmentUrl === null).toBe(withheld);
		if (says === null) expect(res.body.message).not.toContain('They set');
		else expect(res.body.message).toContain(says);
		for (const name of names) expect(res.body.message).not.toContain(name);
	});
});

describe('issueEnrolmentLink', () => {
	it('T10: keeps only the second of two links, and throws outside a transaction', () => {
		const holder = makeUser();
		const first = inTransaction(() => issueEnrolmentLink(holder.id, 'admin-reset'));
		const second = inTransaction(() => issueEnrolmentLink(holder.id, 'admin-reset'));

		expect(second).not.toBe(first);
		expect(linksOf(holder.id).map((link) => link.tokenHash)).toEqual([sha256Hex(second)]);
		expect(() => issueEnrolmentLink(holder.id, 'admin-reset')).toThrow(/inside the transaction/);
		expect(linksOf(holder.id)).toHaveLength(1);
	});
});

describe('an invite, for an account that holds a second factor', () => {
	const DEAD = /This invite link no longer works/;

	it('T13: POST /api/users/[id]/invite answers 409 and writes no invite', async () => {
		// Everything an invite needs but this: mail and an address for its link.
		setAppUrl();
		makeSmtp();
		sent = effects();
		const admin = makeUser({ role: 'admin' });
		const holder = makeUser();
		giveFactor(holder.id);

		const res = await api('POST', `/api/users/${holder.id}/invite`, stepUp(admin));

		expect(res.status).toBe(409);
		expect(res.body.message).toBe('This account uses two-step sign-in. Reset it first, then send the invite.');
		expect(db.select().from(inviteTokens).all()).toEqual([]);
		expect(sent.all).toEqual([]);
	});

	it('T14: an unused invite of an account that then gets a factor: the page shows the dead link, and its form refuses before hashing', async () => {
		const holder = makeUser();
		const token = giveInvite(holder.id);
		giveFactor(holder.id);

		const page = await pageLoad(`/invite/${token}`);
		expect(page).toMatchObject({ type: 'data', data: { valid: false } });

		const res = await action(`/invite/${token}`, { form: { password: 'a long new password', confirmPassword: 'a long new password' } });
		expect(res).toMatchObject({ type: 'failure', status: 400 });
		expect((res as { data: { error: string } }).data.error).toMatch(DEAD);
		expect(bcrypt.hashed).toBe(0);
		expect(userRow(holder.id).passwordHash).toBe(FIXTURE_PASSWORD_HASH);
	});

	it("T15: a factor added between the form's first look and its transaction: refused in the transaction, the password unchanged", async () => {
		const holder = makeUser();
		const token = giveInvite(holder.id);
		bcrypt.duringHash = () => {
			bcrypt.duringHash = undefined;
			giveFactor(holder.id);
		};

		const res = await action(`/invite/${token}`, { form: { password: 'a long new password', confirmPassword: 'a long new password' } });

		expect(bcrypt.hashed).toBe(1);
		expect(res).toMatchObject({ type: 'failure', status: 400 });
		expect((res as { data: { error: string } }).data.error).toMatch(DEAD);
		expect(userRow(holder.id).passwordHash).toBe(FIXTURE_PASSWORD_HASH);
		expect(db.select().from(inviteTokens).where(eq(inviteTokens.tokenHash, inviteHashOf(token))).get()!.used).toBe(false);
	});
});

describe('the admin load', () => {
	it('T16: says twoStep true for an account with a factor, and false for one without', async () => {
		const admin = makeUser({ role: 'admin' });
		const enrolled = makeUser();
		const plain = makeUser();
		giveFactor(enrolled.id);

		const page = await pageLoad('/admin', { user: admin });

		expect(page.type).toBe('data');
		const listed = (page as { data: { users: { id: number; twoStep: boolean | null }[] } }).data.users;
		expect(listed.find((user) => user.id === enrolled.id)!.twoStep).toBe(true);
		expect(listed.find((user) => user.id === plain.id)!.twoStep).toBe(false);
	});
});
