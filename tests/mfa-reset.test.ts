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
	sessions,
	settings,
	signInChallenges,
	users
} from '$lib/server/db/schema';
import { inTransaction } from '$lib/server/db/transaction';
import { MAIL_PROBLEM_WORDS, NO_LINK_ADDRESS } from '$lib/server/email';
import { sha256Hex } from '$lib/server/mfa-crypto';
import { ENROLMENT_LINK_LIFETIME_MS, addTotpFactor, issueEnrolmentLink, storeRecoveryCodes } from '$lib/server/mfa-store';
import { newRecoveryCodes } from '$lib/server/recovery-codes';
import { newTotpSecret } from '$lib/server/totp';
import { parseStamp, stamp } from '$lib/timestamps';
import { api } from './helpers/api';
import { action, pageLoad } from './helpers/actions';
import { effects, type Effects } from './helpers/effects';
import { FIXTURE_PASSWORD_HASH, makeApiKey, makeSession, makeSmtp, makeUser, resetDb, stepUp } from './helpers/fixtures';
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

/** An invite of the account that has not been used, good for a week. */
function giveInvite(userId: number, token = `invite-${userId}-${randomBytes(4).toString('hex')}`): string {
	db.insert(inviteTokens).values({ token, userId, expiresAt: stamp(new Date(Date.now() + ENROLMENT_LINK_LIFETIME_MS)) }).run();
	return token;
}

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
	it("T1: resets every part of decision 11, keeps the rest, issues one link it shows once, and logs one CRITICAL line with no token", async () => {
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
			invitesEnded: 1
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
		// Kept: the password, the keys, the banner and the failed codes since the last sign-in.
		expect(after.passwordHash).toBe(FIXTURE_PASSWORD_HASH);
		expect(after.securityBanner).toBe('codes-failed');
		expect(after.failedCodesSinceSignIn).toBe(5);
		expect(db.select().from(apiKeys).where(eq(apiKeys.userId, holder.id)).all()).toHaveLength(1);

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
				'ended 2 session(s), 1 pending sign-in(s) and 1 invite(s); an enrolment link was issued'
		);
		expect(JSON.parse(lines[0].meta)).toMatchObject({ targetUserId: holder.id, resetBy: admin.id, factorsRemoved: 1 });
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
		// Nothing changed but the caller's session clearing the check it counted
		// while the password was compared (card 2701).
		expect(diffSnapshots(before!, snapshotDb())).toEqual(['sessions: row 1 changed (wrong_password_count: 1 became 0)']);
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
		expect(db.select().from(inviteTokens).where(eq(inviteTokens.token, token)).get()!.used).toBe(false);
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
