/**
 * Two-step sign-in for tests (card 2769, decision 17).
 *
 *     const factor = giveFactor(user);
 *     const signedIn = await signInFully(user, factor);
 *     signedIn.session;   // the session cookie's value
 *
 * `giveFactor` writes an account an authenticator and ten recovery codes as
 * the store writes them, under the test process's own MFA key; `codeFor`
 * gives the code its authenticator shows at a moment; `signInFully` signs in
 * through both form actions, the password and then the code.
 * `giveAuthenticator` gives an account a second or third authenticator, and
 * `wrongCodeFor` a code wrong for every secret it is given (card 2772).
 *
 * `openReleaseWindow` records the release as having run now, so that an
 * account marked `mfa_password_enrol = 1` is inside its 14 days of setting up
 * on its password alone (decision 25): `resetDb` empties `settings`, and with
 * no such row the window is over.
 */
import { sessionCookieName, type SessionUser } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { settings } from '$lib/server/db/schema';
import { addTotpFactor, storeRecoveryCodes } from '$lib/server/mfa-store';
import { stamp } from '$lib/timestamps';
import { newRecoveryCodes } from '$lib/server/recovery-codes';
import { CHALLENGE_COOKIE } from '$lib/server/sign-in-challenges';
import { hotp, newTotpSecret, stepAt } from '$lib/server/totp';
import { action, type ActionResult } from './actions';
import { FIXTURE_PASSWORD, codeFor } from './fixtures';

/** What `giveFactor` wrote: the factor's row id, its secret, and the recovery codes as the owner holds them. */
export type GivenFactor = { factorId: number; secret: Buffer; recoveryCodes: string[] };

/** Give the account an authenticator, labelled as enrolment labels one, and ten recovery codes. */
export function giveFactor(user: Pick<SessionUser, 'id'>): GivenFactor {
	const secret = newTotpSecret();
	const { id } = addTotpFactor(user.id, 'Authenticator', secret);
	const recoveryCodes = newRecoveryCodes();
	storeRecoveryCodes(user.id, recoveryCodes);
	return { factorId: id, secret, recoveryCodes };
}

/**
 * Give the account one more authenticator, as an Account page add writes one
 * (card 2772): the factor alone, its recovery codes left as they are.
 */
export function giveAuthenticator(user: Pick<SessionUser, 'id'>, label = 'Spare phone'): Pick<GivenFactor, 'factorId' | 'secret'> {
	const secret = newTotpSecret();
	const { id } = addTotpFactor(user.id, label, secret);
	return { factorId: id, secret };
}

/**
 * Record the release that turned on two-step sign-in as having run at `at` (now by default): the 14 days start then.
 * Since card 3064 that is the superadmin's requiring it (event E3), which writes the switch beside the moment; the
 * switch is already there, as `resetDb` writes it back (R23, F19), and a restore keeps both as this server's (R1).
 */
export function openReleaseWindow(at: Date = new Date()): void {
	db.insert(settings)
		.values({ key: 'two_step_released_at', value: stamp(at) })
		.onConflictDoUpdate({ target: settings.key, set: { value: stamp(at) } })
		.run();
}

/**
 * The code the authenticator with this secret shows at `at` (now by default).
 * Defined in ./fixtures.ts, whose `stepUpCode` makes a step-up's code with it
 * (card 2771), so that neither file imports the other back.
 */
export { codeFor };

/**
 * A six-digit code that is neither the current step's nor the one before, nor
 * the next, of any of `secrets`: wrong whenever it is sent within the step.
 * Pass every secret of an account with several authenticators, so that the
 * code is not another one's right code (card 2772, E25).
 */
export function wrongCodeFor(secrets: Buffer | Buffer[], at: number = Date.now()): string {
	const near = [secrets].flat().flatMap((secret) => [hotp(secret, stepAt(at)), hotp(secret, stepAt(at) - 1), hotp(secret, stepAt(at) + 1)]);
	for (let n = 0; ; n++) {
		const code = String(n).padStart(6, '0');
		if (!near.includes(code)) return code;
	}
}

/** The right password at `/login`, from `ip`, with any cookies the browser holds: the action's answer and the challenge token it set. */
export async function passwordStep(
	user: Pick<SessionUser, 'username'>,
	opts: { ip?: string; cookies?: Record<string, string>; password?: string } = {}
): Promise<{ res: ActionResult; challenge: string | undefined }> {
	const res = await action('/login', {
		form: { identity: user.username, password: opts.password ?? FIXTURE_PASSWORD },
		ip: opts.ip,
		cookies: opts.cookies
	});
	return { res, challenge: res.cookies[CHALLENGE_COOKIE]?.value };
}

/** The address `verify` sends the second step to: the session cookie it sets is named for it (card 2775). */
export const VERIFY_AT = new URL('http://localhost/login/verify');

/** A code, or a recovery code, at `/login/verify` against the challenge `token`. */
export function verify(token: string | undefined, form: Record<string, string>, opts: { ip?: string } = {}): Promise<ActionResult> {
	return action(VERIFY_AT.href, { form, ip: opts.ip, cookies: token === undefined ? {} : { [CHALLENGE_COOKIE]: token } });
}

/**
 * Sign in through both steps, from `ip`: the password, then the current code.
 * Answers the session cookie's value and every cookie the code's answer set.
 */
export async function signInFully(
	user: Pick<SessionUser, 'username'>,
	factor: Pick<GivenFactor, 'secret'>,
	opts: { ip?: string; cookies?: Record<string, string> } = {}
): Promise<{ session: string; res: ActionResult }> {
	const { res: password, challenge } = await passwordStep(user, opts);
	if (password.type !== 'redirect' || challenge === undefined) throw new Error(`The password step answered ${JSON.stringify(password)}`);
	const res = await verify(challenge, { code: codeFor(factor.secret) }, opts);
	// By the name in force for the action's address, as the action sets it (card 2775).
	const session = res.cookies[sessionCookieName(VERIFY_AT)]?.value;
	if (session === undefined) throw new Error(`The code was not accepted: ${JSON.stringify(res)}`);
	return { session, res };
}
