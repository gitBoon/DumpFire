/**
 * known-browsers.ts — Browsers that have signed in here before (card 2194).
 *
 * Each browser that signs in to an account is remembered for it for a year,
 * by a cookie of its own, `dumpfire_known_<user id>`, sent only to the sign-in
 * page. A remembered browser skips all of sign-in's throttling: the account's
 * wait, the per-address limit and the one-at-a-time rule, and its check goes
 * in the first lane (passwords.ts). Everyone else is held to the free guesses
 * left at the account, and to one at a time while its waits last, so that a
 * guesser who sends many at once is slowed as one who waits for each answer
 * is; and the owner, on a browser they have used, is never kept out.
 *
 * The cookie is `<issued at>.<nonce>.<mac>`: the time of issue in seconds, 16
 * random bytes in hex, and an HMAC-SHA256 over the account's id, the time,
 * the nonce and the account's password hash as it is now, under a secret
 * kept in the `settings` table. Nothing is stored for a browser: setting the
 * password changes the hash and so ends every cookie of the account at once,
 * and a new secret ends every cookie of every account.
 *
 * Remembered until, whichever is first: a year after it was issued (it is
 * issued again at each sign-in); the account's password is set, by anyone;
 * the secret is replaced (a restore, a Reset, or its row deleted on the
 * host). Not by signing out, which remembers the browser too (the review's
 * R5): it is a browser that signed in. Five wrong passwords from one cookie,
 * within 15 minutes of each other, and it counts as not remembered until 15
 * minutes pass without one; and at most five sign-ins from it at once, past
 * which the rest are treated as from a browser not remembered (R2). So a
 * copied cookie buys five guesses a quarter of an hour, never a volley.
 *
 * While two-step sign-in is dormant (card 3064), a browser signed in on a
 * password alone is remembered under a MAC domain of its own, which counts
 * only until two-step sign-in is required (`rememberBrowser`,
 * `rememberedNonce`).
 *
 * The secret is never in a backup and never restored (`withoutSecrets` in
 * backup.ts, `rowsToRestore` in db/restore.ts), so a restore forgets every
 * browser, as it signs everybody out.
 *
 * `SIGN_IN_ONE_AT_A_TIME=off` on the host turns the one-at-a-time rule off
 * (decision 29), for an owner kept out of every browser not remembered by an
 * attack that lasts, the superadmin above all: no invite and no reset reaches
 * that account.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { db } from './db';
import { settings } from './db/schema';
import { currentSigningKeyHex, newSigningKeyText, openStored, sealStored, settingAad, signingKeysMadeLine } from './stored-secrets';
import { inTransaction } from './db/transaction';
import { httpsOnlyCookie } from './auth';
import { FREE_WRONG_SIGN_INS, wrongSignInsAt } from './rate-limit';
import { twoStepRequired } from './two-step-switch';
import { holdsFactor } from './mfa-store';
import { createLogger } from './logger';

const log = createLogger('AUTH');

/** The setting the secret is kept in. Never in a backup, never restored. */
export const KNOWN_BROWSER_SECRET_KEY = 'known_browser_secret';

/** The cookie that remembers a browser for the account `userId`. */
export const knownBrowserCookie = (userId: number): string => `dumpfire_known_${userId}`;

/** How long a cookie is good for after it is issued: a year, in seconds. */
export const KNOWN_BROWSER_SECONDS = 365 * 24 * 60 * 60;

/** How far in the future a cookie's time of issue may be, for a clock moved back. */
const FUTURE_GRACE_SECONDS = 60;

/** The cookie as it is written: digits, 32 hex, 64 hex. Anything else is no cookie. */
const COOKIE = /^(\d{1,12})\.([0-9a-f]{32})\.([0-9a-f]{64})$/;

let cachedSecret: string | null = null;

/**
 * The key the cookies are signed with: read once into memory, and made on
 * first use when `make` is true, which is only when a browser is remembered, a
 * write of its own. A check of a cookie never makes it: null when there is
 * none, and no cookie can be good then. (The request form's key was made the
 * same way from inside read-only checks, and is made at start-up and inside a
 * reset's and a restore's transaction since card 2750.)
 */
function knownBrowserSecret(make: boolean): string | null {
	if (cachedSecret) return cachedSecret;

	const aad = settingAad(KNOWN_BROWSER_SECRET_KEY);
	const existing = db.select().from(settings).where(eq(settings.key, KNOWN_BROWSER_SECRET_KEY)).get();
	if (existing) {
		// Stored sealed (card 2898), of the form `v2:` and 64 hex (card 2943). Only a key of that form is this
		// server's (its fix pass, C1): one held in plain, of an older form or that does not open is no key.
		const opened = openStored(existing.value, aad);
		if (currentSigningKeyHex(opened) !== null) {
			cachedSecret = opened.value;
			return cachedSecret;
		}
		// No cookie holds, and the next remember replaces it with a new one
		// (E16), forgetting every browser, with the key-change record.
		if (!make) return null;
		// The key check and the key in one transaction (card 2898's code review, E10).
		// Of the current form, `v2:` and 64 hex (card 2943, R8).
		const replaced = inTransaction(() =>
			db.update(settings)
				.set({ value: sealStored(newSigningKeyText(), aad) })
				.where(and(eq(settings.key, KNOWN_BROWSER_SECRET_KEY), eq(settings.value, existing.value)))
				.run().changes
		);
		// Every replacement leaves a lasting record (card 2943's fix pass, C4).
		if (replaced === 1) log.critical(signingKeysMadeLine([{ setting: KNOWN_BROWSER_SECRET_KEY, because: 'not trusted at run time' }], 'by a sign-in'));
	} else {
		if (!make) return null;
		inTransaction(() =>
			db.insert(settings)
				.values({ key: KNOWN_BROWSER_SECRET_KEY, value: sealStored(newSigningKeyText(), aad) })
				.onConflictDoNothing()
				.run()
		);
	}
	// Read back rather than trust what was written: another process may have got there first.
	const opened = openStored(db.select().from(settings).where(eq(settings.key, KNOWN_BROWSER_SECRET_KEY)).get()?.value, aad);
	if (currentSigningKeyHex(opened) === null) return null;
	cachedSecret = opened.value;
	return cachedSecret;
}

/**
 * Forget the cached key, as a fresh process would: for a Reset, which clears
 * the setting, and an import, which replaces the settings, once either is
 * committed; and for tests.
 */
export function resetKnownBrowserSecretCache(): void {
	cachedSecret = null;
}

/**
 * The MAC's domain: 2 since two-step sign-in (card 2769, decision 24). A
 * browser is remembered under it only after a second factor (a session with
 * `two_step` 1); an older image, which remembers one on a password alone,
 * signs under 1, and every cookie it signs is refused here, even where it made
 * the secret again after migration 0067 deleted it.
 */
const MAC_DOMAIN = 'known-browser:2';

/**
 * The MAC's domain of a browser remembered on a password alone, while two-step
 * sign-in is dormant (card 3064, R3, R-M9 with S-L2): a sign-in, an invite's
 * use, a password change or a sign-out of a session with `two_step` 0. Its
 * cookie gives the lenient lane exactly as the version before two-step
 * sign-in gave every browser, and only while two-step sign-in is dormant and
 * the account holds no factor: once it is required (event E3), or the account
 * sets up a factor (F24), `rememberedNonce` answers every cookie of this domain
 * as no cookie, so the lane never outlives dormancy nor a password-only account.
 */
const PASSWORD_ONLY_MAC_DOMAIN = 'known-browser:password-only';

function macOf(domain: string, secret: string, userId: number, issuedAt: number, nonce: string, passwordHash: string): string {
	return createHmac('sha256', secret)
		.update(`${domain}:${userId}:${issuedAt}:${nonce}:${passwordHash}`)
		.digest('hex');
}

/**
 * Remember the browser of this request for the account `userId`, whose
 * password hash is now `passwordHash`: a new cookie, with a new time and
 * nonce, whatever it held before. Called once the browser is signed in (a
 * sign-in, an invite's use, set-up, the holder's own password change) or
 * signs out. `url` is the request's address: the cookie is Secure by the
 * session cookie's rule, `httpsOnlyCookie(url)` (card 2850); null outside a
 * request, which leaves it to the environment.
 *
 * `twoStep` is the `two_step` of the session the browser holds or held, and
 * has no default, so that every caller says (card 3064, R3, R-M9): 1, signed
 * under `known-browser:2`; 0, a session made on a password alone while
 * two-step sign-in is dormant, signed under the password-only domain, which
 * requiring two-step sign-in retires. Anything else throws: it is a fault in
 * the caller.
 *
 * Called after the change is committed, so it never fails the request: a
 * secret that cannot be had is said at WARN, and the browser is not
 * remembered.
 */
export function rememberBrowser(
	cookies: Cookies,
	userId: number,
	passwordHash: string,
	url: URL | null,
	twoStep: 0 | 1,
	now: number = Date.now()
): void {
	if (twoStep !== 0 && twoStep !== 1) throw new Error('A browser is remembered for a session with two_step 0 or 1, said by its caller.');
	const domain = twoStep === 1 ? MAC_DOMAIN : PASSWORD_ONLY_MAC_DOMAIN;
	let secret: string | null;
	try {
		secret = knownBrowserSecret(true);
	} catch (err) {
		log.warn(`A browser could not be remembered for user ${userId}: ${(err as Error)?.message ?? err}`, undefined, {
			userId
		});
		return;
	}
	if (!secret) return;

	const issuedAt = Math.floor(now / 1000);
	const nonce = randomBytes(16).toString('hex');
	cookies.set(knownBrowserCookie(userId), `${issuedAt}.${nonce}.${macOf(domain, secret, userId, issuedAt, nonce, passwordHash)}`, {
		// Sent to the sign-in page and its form, and nowhere else.
		path: '/login',
		httpOnly: true,
		sameSite: 'strict',
		// Secure as the session cookie is: over HTTPS always (card 2850).
		secure: httpsOnlyCookie(url),
		maxAge: KNOWN_BROWSER_SECONDS
	});
}

/**
 * The nonce of this request's cookie for `user`, if the browser is remembered
 * for the account: the cookie parses, was issued no more than a year ago and
 * not in the future, its MAC matches with the account's hash as it is now
 * (compared in constant time), and fewer than five wrong passwords have come
 * from it within 15 minutes of each other. Null otherwise, which is answered
 * as no cookie at all.
 *
 * The MAC is that of `known-browser:2`, or, only while two-step sign-in is
 * dormant (`twoStepRequired`, read here at each call) and the account holds
 * no factor (`holdsFactor`, F24, as `findSession` refuses such an account's
 * sessions made on a password alone: S-M1), that of the password-only domain
 * (card 3064, R3, R-M9): once two-step sign-in is required, or the account
 * has set up a second factor, a browser remembered on a password alone is no
 * longer remembered.
 */
export function rememberedNonce(
	cookies: Pick<Cookies, 'get'>,
	user: { id: number; passwordHash: string },
	now: number = Date.now()
): string | null {
	const found = COOKIE.exec(cookies.get(knownBrowserCookie(user.id)) ?? '');
	if (!found) return null;
	const [, issued, nonce, mac] = found;

	const issuedAt = Number(issued);
	const nowSeconds = Math.floor(now / 1000);
	if (issuedAt > nowSeconds + FUTURE_GRACE_SECONDS || nowSeconds - issuedAt > KNOWN_BROWSER_SECONDS) return null;

	const secret = knownBrowserSecret(false);
	if (!secret) return null;
	const sent = Buffer.from(mac, 'hex');
	const signedUnder = (domain: string) => timingSafeEqual(Buffer.from(macOf(domain, secret, user.id, issuedAt, nonce, user.passwordHash), 'hex'), sent);
	if (!signedUnder(MAC_DOMAIN) && (twoStepRequired() || holdsFactor(user.id) || !signedUnder(PASSWORD_ONLY_MAC_DOMAIN))) return null;

	if (wrongSignInsAt(`nonce:${nonce}`) >= FREE_WRONG_SIGN_INS) return null;
	return nonce;
}

// ─── SIGN_IN_ONE_AT_A_TIME (decision 29) ────────────────────────────────────

let oneAtATime: boolean | undefined;

/**
 * Whether sign-ins from browsers not remembered are held to the free guesses
 * left, and one at a time while an account's waits last: `SIGN_IN_ONE_AT_A_TIME`,
 * read once. Unset or `on`, they are; `off`, they are not, and every browser
 * is let in after the account's wait. Anything else is one WARN, and on.
 */
export function signInsOneAtATime(): boolean {
	if (oneAtATime === undefined) {
		const value = process.env.SIGN_IN_ONE_AT_A_TIME;
		const said = value?.trim().toLowerCase();
		if (said === undefined || said === '' || said === 'on') oneAtATime = true;
		else if (said === 'off') oneAtATime = false;
		else {
			log.warn(
				`SIGN_IN_ONE_AT_A_TIME is "${value!.slice(0, 40)}", which is neither on nor off: sign-ins from browsers ` +
					'not remembered are held to one at a time'
			);
			oneAtATime = true;
		}
	}
	return oneAtATime;
}

/** Read `SIGN_IN_ONE_AT_A_TIME` again at the next ask. For tests. */
export function rereadSignInsOneAtATime(): void {
	oneAtATime = undefined;
}
