import { createHash } from 'node:crypto';
import { fail, redirect, type ActionFailure, type Cookies } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { getUserByUsername, getUserByEmail, createSession, setSessionCookie } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import {
	FIRST_LANE_CHECKS_PER_ACCOUNT,
	FREE_WRONG_SIGN_INS,
	countSignInAttempt,
	countWrongSignIn,
	enterSignIn,
	firstLaneChecksAt,
	firstSignInRefusal,
	forgetWrongSignIns,
	keepSignInAttemptCounted,
	leaveSignIn,
	refundSignInAttempts,
	signInWait,
	wrongSignInsAt
} from '$lib/server/rate-limit';
import { rememberBrowser, rememberedNonce, signInsOneAtATime } from '$lib/server/known-browsers';
import { createLogger } from '$lib/server/logger';
import { addressOf, addressToCount } from '$lib/server/client-address';
import { CheckNotMade, DUMMY_HASH, callerHasGone, checkPassword } from '$lib/server/passwords';

const log = createLogger('AUTH');

/**
 * The answer when the password could not be checked (card 2191): about thirty
 * seconds of checks were already waiting, or the caller had gone.
 */
const BUSY =
	'Sign-in is very busy right now. Wait a minute and try again, or sign in from a browser you have used here before.';

/**
 * The answer to a browser not remembered for the account when as many
 * sign-ins at it are already in flight as it allows (card 2194). The same for
 * a name that is no account, so that it tells nothing about which names are.
 */
const ALREADY_UNDER_WAY =
	'A sign-in with this name is already under way from another browser. Wait a few seconds and try again, or sign in ' +
	'from a browser you have used here before.';

/**
 * A copy of the first `max` characters of `text`, sharing no memory with it.
 * A slice of a long string can keep the whole of it alive, and a sign-in that
 * waits must not keep the form it came in (up to the gate's 512 KB).
 */
function detached(text: string, max: number): string {
	return Buffer.from(text.slice(0, max), 'utf16le').toString('utf16le');
}

/** What a sign-in holds while it waits: a refusal to answer at once, or the little it needs. */
type SignIn =
	| { answer: ActionFailure<{ error: string; identity: string }> }
	| {
			/** The account found by the name typed, or null for a name that is no account. */
			userId: number | null;
			/** What its wrong passwords are counted under: `user:<id>`, or `name:<sha-256>`. */
			key: string;
			/** At most 256 characters: bcrypt reads only the first 72 bytes, which these always hold. */
			password: string;
			/** The name as typed, at most 320 characters, for the answer. */
			identity: string;
			/** How many characters the name typed was, whole and trimmed: all the log says of a name that is no account. */
			typedLength: number;
			/** The caller's address as received, at most 100 characters, for the log; null where there is none. */
			address: string | null;
			/** What the address is counted as (`addressKey`, card 2195): an IPv6 address by its /64. */
			countedAs: string;
			/**
			 * The nonce of the cookie that remembers this browser for the
			 * account (card 2194), or null for a browser not remembered: one
			 * with no good cookie, five wrong from its cookie, or five sign-ins
			 * from it in flight already.
			 */
			remembered: string | null;
			/** The keys whose places this sign-in holds until it is answered (`leaveSignIn`). */
			entered: string[];
	  };

/**
 * Everything a sign-in does before its wait, in one synchronous stretch, so
 * the form it is handed is let go of when this returns: read the form, look
 * the name up, and check the per-address limit.
 *
 * The name is looked up first (card 2226), so that the address's count can
 * note the account each attempt was at, and a sign-in that succeeds give back
 * only its own account's attempts. An attempt the per-address limit refuses
 * is still answered at once, never waits, and is not counted at the account
 * (decision 12). The account (decision 10): found, its wrong passwords are
 * counted under its id, so a username and its email share one count; not
 * found, under a hash of
 * the name exactly as the lookup read it (trimmed; an email lower-cased, a
 * username in the case typed), so a name that is no account waits exactly as
 * a real one would and the count holds 64 characters whatever was typed. It
 * was lower-cased either way, while a username is looked up exactly: five at
 * `ALICE` then one at `alice` waited only when `alice` was no account (the
 * review's M1).
 *
 * Then the browser (card 2194). One remembered for the account takes a place
 * at its own cookie's nonce, at most five in flight (the review's R2), and one
 * at the account's checks in the first lane, at most five in flight with its
 * sessions' current passwords (the review's L1), and goes no further here: it is neither counted at the address nor held to one
 * at a time. Any other is counted at the address, and then takes a place at
 * the account's key: no more in flight there than the free guesses left, and
 * never fewer than one, so five free guesses an idle window however they are
 * sent, then one at a time while the waits last. Past that it is refused at
 * once, counted at the address as every attempt is, and not at the account,
 * since no password was checked. All in this one synchronous stretch, so that
 * attempts sent together take places in the order they arrived.
 */
function beginSignIn(data: FormData, getClientAddress: () => string, cookies: Pick<Cookies, 'get'>): SignIn {
	const typed = data.get('identity');
	const typedPassword = data.get('password');
	const identity = typeof typed === 'string' ? typed.trim() : '';
	const password = typeof typedPassword === 'string' ? typedPassword : '';
	const echo = detached(identity, 320);

	if (!identity) {
		return { answer: fail(400, { error: 'Please enter your username or email', identity: echo }) };
	}

	if (!password) {
		return { answer: fail(400, { error: 'Please enter your password', identity: echo }) };
	}

	// Look up by username or email, and count under the name as looked up.
	const lookedUp = identity.includes('@') ? identity.toLowerCase() : identity;
	const found = identity.includes('@') ? getUserByEmail(lookedUp) : getUserByUsername(lookedUp);
	const key = found
		? `user:${found.id}`
		: `name:${createHash('sha256').update(lookedUp).digest('hex')}`;

	const address = addressOf({ getClientAddress })?.slice(0, 100) ?? null;
	const countedAs = addressToCount({ getClientAddress });
	const signIn = {
		userId: found?.id ?? null,
		key,
		password: detached(password, 256),
		identity: echo,
		typedLength: identity.length,
		address,
		countedAs
	};

	// A browser remembered for the account, while fewer than five sign-ins
	// from its cookie are in flight, less the wrong ones it has sent.
	const nonce = found ? rememberedNonce(cookies, found) : null;
	if (nonce !== null && found) {
		const at = `nonce:${nonce}`;
		if (enterSignIn(at, FREE_WRONG_SIGN_INS - wrongSignInsAt(at))) {
			// And while fewer than five of the account's checks in the first
			// lane are in flight, its sessions' current passwords included (the
			// review's L1): every right password makes a new cookie, so its own
			// five do not hold whoever has the password. Past that it is refused
			// in the words a browser not remembered is, with nothing counted:
			// no password was checked.
			const account = firstLaneChecksAt(found.id);
			if (!enterSignIn(account, FIRST_LANE_CHECKS_PER_ACCOUNT)) {
				leaveSignIn(at);
				return { answer: fail(429, { error: ALREADY_UNDER_WAY, identity: echo }) };
			}
			return { ...signIn, remembered: nonce, entered: [at, account] };
		}
	}

	// Rate limit by address — 10 attempts per 15 minutes, an IPv6 address by
	// its /64 (card 2195). An address that cannot be read is counted as
	// 'unknown', with every other such request: asked unguarded, it was a 500
	// for everybody signing in that way. The log has the address as received.
	const { limited, retryAfterSecs } = countSignInAttempt(countedAs, key);
	if (limited) {
		const from = address === null || address === countedAs ? countedAs : `${address}, counted as ${countedAs}`;
		log.warn(`Rate limit hit for IP ${from} (login attempts)`, undefined, { ip: address });
		return {
			answer: fail(429, {
				error: `Too many login attempts. Please try again in ${Math.ceil(retryAfterSecs / 60)} minute(s).`,
				identity: echo
			})
		};
	}

	// No more in flight at the account than the free guesses left, and never
	// fewer than one, unless the host has turned the rule off (decision 29).
	if (!signInsOneAtATime()) return { ...signIn, remembered: null, entered: [] };
	if (!enterSignIn(key, Math.max(1, FREE_WRONG_SIGN_INS - wrongSignInsAt(key)))) {
		// Counted at the address, and not given back by a success at the account.
		keepSignInAttemptCounted(countedAs, key);
		if (firstSignInRefusal(key)) {
			const at = found ? `"${found.username.slice(0, 100)}" (user ${found.id})` : 'a name that is no account';
			log.warn(`Sign-ins at ${at} from browsers not known here are being let in one at a time`, undefined, {
				userId: found?.id ?? null
			});
		}
		return { answer: fail(429, { error: ALREADY_UNDER_WAY, identity: echo }) };
	}
	return { ...signIn, remembered: null, entered: [key] };
}

export const load: PageServerLoad = async ({ locals }) => {
	if (locals.user) {
		throw redirect(303, '/');
	}
	return {};
};

export const actions: Actions = {
	default: async ({ request, cookies, getClientAddress, platform }) => {
		const signIn = beginSignIn(await request.formData(), getClientAddress, cookies);
		if ('answer' in signIn) return signIn.answer;
		try {
			return await checkSignIn(signIn, cookies, platform);
		} finally {
			// The places it took, given back however it was answered.
			for (const at of signIn.entered) leaveSignIn(at);
		}
	}
};

/**
 * The rest of a sign-in let in by `beginSignIn`: the account's wait, the
 * check, and the answer. A browser remembered for the account (card 2194)
 * does not wait, is checked in the first lane, and its wrong passwords are
 * counted at its cookie's nonce and not at the account; a right one leaves
 * the account's count as it is, since an attack is not over because the
 * owner signed in, and gives the address nothing back, since nothing was
 * counted there.
 */
async function checkSignIn(
	{ userId, key, password, identity, typedLength, address, countedAs, remembered }: Extract<SignIn, { key: string }>,
	cookies: Cookies,
	platform: App.Platform | undefined
): Promise<ActionFailure<{ error: string; identity: string }>> {
	const fromIp = address ?? 'unknown';

	// Wrong passwords at one account (card 2177): after five within 15
	// minutes of each other, every sign-in at it from a browser not
	// remembered waits 1, 2, then 4 seconds before its password is checked,
	// the right one included, and is then answered as it would have been. An
	// awaited timer, holding no transaction and nothing of the form, so every
	// other request is answered meanwhile. Read when the attempt arrives, so
	// attempts sent together wait alike.
	const wait = remembered === null ? signInWait(key) : 0;
	if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));

	/**
	 * Count a wrong attempt: at the remembered browser's nonce, or at the
	 * account, saying once when its waits begin: naming the account, with it
	 * as the line's user, when it is one (`username` is null for a name that
	 * is no account, or an account deleted during the wait).
	 */
	const wrong = (username: string | null) => {
		if (remembered !== null) {
			countWrongSignIn(`nonce:${remembered}`);
			return;
		}
		if (countWrongSignIn(key) === FREE_WRONG_SIGN_INS) {
			const at = userId === null ? 'a name that is no account' : username === null ? `user ${userId}` : `"${username}" (user ${userId})`;
			log.warn(
				`Sign-ins at ${at} are being slowed: ${FREE_WRONG_SIGN_INS} wrong passwords within 15 minutes of each other`,
				undefined,
				{ userId: username === null ? null : userId }
			);
		}
	};

	// Read again after the wait, so the password is checked as it is now.
	const user = userId === null ? undefined : db.select().from(users).where(eq(users.id, userId)).get();

	// On a worker thread (card 2191): the server's own thread answers
	// everybody else meanwhile. In the first lane for a remembered browser,
	// the second for any other. Not made when too many are already waiting,
	// or once the caller has gone: answered busy, and counted nowhere but the
	// address, since no password was checked. A name that is no account (or
	// an account deleted during the wait) is checked too, against a hash
	// nothing matches (card 2192), and its answer ignored: the one check is
	// what a wrong password at an account costs, so the time taken does not
	// tell which names are accounts.
	let matches: boolean;
	try {
		({ matches } = await checkPassword(password, user?.passwordHash ?? DUMMY_HASH, remembered === null ? 'other' : 'known', {
			gone: callerHasGone(platform)
		}));
	} catch (err) {
		if (err instanceof CheckNotMade) {
			if (remembered === null) keepSignInAttemptCounted(countedAs, key);
			return fail(503, { error: BUSY, identity });
		}
		throw err;
	}

	// The failed lines hold nothing that was typed (card 2193): a name that
	// is no account by its length, which may be a password typed into the
	// wrong box; an account by its own username and id, never the email
	// typed. Each with the address as received, as the line's too.
	if (!user) {
		wrong(null);
		log.warn(`Failed login attempt for a name that is no account (${typedLength} characters) from IP ${fromIp}`, undefined, {
			ip: address
		});
		return fail(400, { error: 'Invalid username/email or password', identity });
	}

	if (!matches) {
		wrong(user.username);
		log.warn(
			`Failed login attempt at "${user.username.slice(0, 100)}" (user ${user.id}) from IP ${fromIp} (bad password)`,
			undefined,
			{ userId: user.id, ip: address }
		);
		return fail(400, { error: 'Invalid username/email or password', identity });
	}

	// Successful login from a browser not remembered: the account's waits
	// forgotten, and the address's attempts at this account given back, and
	// only those (card 2226).
	if (remembered === null) {
		forgetWrongSignIns(key);
		refundSignInAttempts(countedAs, key);
	}

	// The line's address is null where there is none, as the gate writes it;
	// 'unknown' is the rate limit's name for that, not an address.
	log.info(`User "${user.username}" logged in`, {
		identityType: identity.includes('@') ? 'email' : 'username'
	}, { userId: user.id, ip: address });

	// Create session and set cookie, and remember the browser for the
	// account, with a new cookie, for a year from now (card 2194).
	const token = createSession(user.id);
	setSessionCookie(cookies, token);
	rememberBrowser(cookies, user.id, user.passwordHash);

	throw redirect(303, '/');
}
