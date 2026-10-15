import { createHash } from 'node:crypto';
import { fail, redirect, type ActionFailure } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { getUserByUsername, getUserByEmail, verifyPassword, createSession, setSessionCookie } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import {
	checkRateLimit,
	countWrongSignIn,
	forgetWrongSignIns,
	resetRateLimit,
	signInWait
} from '$lib/server/rate-limit';
import { createLogger } from '$lib/server/logger';
import { addressOf, addressToCount } from '$lib/server/client-address';

const log = createLogger('AUTH');

/** The wrong passwords at which an account's sign-ins begin to wait (card 2177). */
const WAITS_BEGIN_AT = 5;

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
			/** The name as typed, at most 320 characters, for the answer and the log. */
			identity: string;
			clientIp: string;
	  };

/**
 * Everything a sign-in does before its wait, in one synchronous stretch, so
 * the form it is handed is let go of when this returns: read the form, check
 * the per-address limit, and look the name up.
 *
 * The per-address limit comes first (decision 12): an attempt it refuses is
 * answered at once, never waits, and is not counted at the account. Then the
 * account (decision 10): found, its wrong passwords are counted under its id,
 * so a username and its email share one count; not found, under a hash of
 * the name exactly as the lookup read it (trimmed; an email lower-cased, a
 * username in the case typed), so a name that is no account waits exactly as
 * a real one would and the count holds 64 characters whatever was typed. It
 * was lower-cased either way, while a username is looked up exactly: five at
 * `ALICE` then one at `alice` waited only when `alice` was no account (the
 * review's M1).
 */
function beginSignIn(data: FormData, getClientAddress: () => string): SignIn {
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

	// Rate limit by IP address — 10 attempts per 15 minutes. An address that
	// cannot be read is counted as 'unknown', with every other such request:
	// asked unguarded, it was a 500 for everybody signing in that way.
	const clientIp = addressToCount({ getClientAddress });
	const { limited, retryAfterSecs } = checkRateLimit(`login:${clientIp}`, 10, 15 * 60 * 1000);
	if (limited) {
		log.warn(`Rate limit hit for IP ${clientIp} (login attempts)`);
		return {
			answer: fail(429, {
				error: `Too many login attempts. Please try again in ${Math.ceil(retryAfterSecs / 60)} minute(s).`,
				identity: echo
			})
		};
	}

	// Look up by username or email, and count under the name as looked up.
	const lookedUp = identity.includes('@') ? identity.toLowerCase() : identity;
	const found = identity.includes('@') ? getUserByEmail(lookedUp) : getUserByUsername(lookedUp);
	const key = found
		? `user:${found.id}`
		: `name:${createHash('sha256').update(lookedUp).digest('hex')}`;

	return { userId: found?.id ?? null, key, password: detached(password, 256), identity: echo, clientIp };
}

export const load: PageServerLoad = async ({ locals }) => {
	if (locals.user) {
		throw redirect(303, '/');
	}
	return {};
};

export const actions: Actions = {
	default: async ({ request, cookies, getClientAddress }) => {
		const signIn = beginSignIn(await request.formData(), getClientAddress);
		if ('answer' in signIn) return signIn.answer;
		const { userId, key, password, identity, clientIp } = signIn;

		// Wrong passwords at one account (card 2177): after five within 15
		// minutes of each other, every sign-in at it waits 1, 2, then 4 seconds
		// before its password is checked, the right one included, and is then
		// answered as it would have been. Never refused. An awaited timer,
		// holding no transaction and nothing of the form, so every other
		// request is answered meanwhile. Read when the attempt arrives, so
		// attempts sent together wait alike.
		const wait = signInWait(key);
		if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));

		/**
		 * Count a wrong attempt at the account, and say once when its waits
		 * begin: naming the account, with it as the line's user, when it is
		 * one (`username` is null for a name that is no account, or an
		 * account deleted during the wait).
		 */
		const wrong = (username: string | null) => {
			if (countWrongSignIn(key) === WAITS_BEGIN_AT) {
				const at = userId === null ? 'a name that is no account' : username === null ? `user ${userId}` : `"${username}" (user ${userId})`;
				log.warn(
					`Sign-ins at ${at} are being slowed: ${WAITS_BEGIN_AT} wrong passwords within 15 minutes of each other`,
					undefined,
					{ userId: username === null ? null : userId }
				);
			}
		};

		// Read again after the wait, so the password is checked as it is now.
		const user = userId === null ? undefined : db.select().from(users).where(eq(users.id, userId)).get();

		if (!user) {
			wrong(null);
			log.warn(`Failed login attempt for "${identity}" from IP ${clientIp}`);
			return fail(400, { error: 'Invalid username/email or password', identity });
		}

		if (!verifyPassword(password, user.passwordHash)) {
			wrong(user.username);
			log.warn(`Failed login attempt for "${identity}" from IP ${clientIp} (bad password)`);
			return fail(400, { error: 'Invalid username/email or password', identity });
		}

		// Successful login — reset rate limit for this IP, and the account's waits
		forgetWrongSignIns(key);
		resetRateLimit(`login:${clientIp}`);

		// The line's address is null where there is none, as the gate writes it;
		// 'unknown' is the rate limit's name for that, not an address.
		log.info(`User "${user.username}" logged in`, {
			identityType: identity.includes('@') ? 'email' : 'username'
		}, { userId: user.id, ip: addressOf({ getClientAddress }) });

		// Create session and set cookie
		const token = createSession(user.id);
		setSessionCookie(cookies, token);

		throw redirect(303, '/');
	}
};
