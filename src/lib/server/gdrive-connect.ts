/**
 * The Google Drive Connects under way: who started each, and the secret that
 * finishes it (card 2251).
 *
 * Connect is two requests with a person between them. The `GET` builds
 * Google's consent address; the administrator approves in Google's window and
 * pastes back the address Google's page leads to, which holds a code; the
 * `POST` exchanges the code for a refresh token. The `POST` used to take any
 * code at all, so a code from somebody else's consent, pasted by a superadmin
 * who was led to, connected that person's Google account, and every later
 * backup went to it.
 *
 * Each `GET` now starts a pending Connect here, and the `POST` takes it:
 *
 *   - a `state` of 32 random bytes, in the consent address, which Google hands
 *     back in the address it leads to. It is bound to the session that asked
 *     (the SHA-256 of its token, so no token is held here), the account and
 *     the destination; a `POST` from anything else is refused. The state and
 *     the challenge both sit in the consent address, so whoever holds that
 *     address can finish this Connect: an address somebody else sends cannot
 *     connect their account unless they also had the consent address this
 *     session's Connect opened.
 *   - a PKCE `code_verifier`, which never leaves the server: the consent
 *     address carries its SHA-256 as `code_challenge` (S256), and the
 *     exchange sends the verifier with the code. Google refuses a code issued
 *     for another challenge.
 *
 * A state is taken once, the first time a `POST` presents it, whatever comes
 * of it; it lives `CONNECT_LIFETIME_MS`, about as long as Google's codes. One
 * pending Connect per session and destination (a new `GET` replaces the older),
 * at most `MOST_PENDING` in all (the oldest dropped), and the expired swept at
 * every Connect started and every state presented.
 *
 * In memory, on purpose: the verifier never reaches the disk or a backup, and
 * a restart ends every Connect under way (press Connect again).
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Credential } from './auth';

/** How long a Connect waits for its `POST`: ten minutes. */
export const CONNECT_LIFETIME_MS = 10 * 60 * 1000;

/** The most Connects held at once. */
export const MOST_PENDING = 20;

/** Who a Connect is for: the account, and what the gate let the request in with. */
export type ConnectCaller = { userId: number; credential: Credential | null | undefined };

type Pending = {
	verifier: string;
	/** The session or key the `GET` came with, hashed; `account` for a request with neither. */
	holder: string;
	userId: number;
	destName: string;
	expiresAt: number;
};

/** By state, oldest first (a `Map` keeps the order things were set in). */
const pending = new Map<string, Pending>();

const random = () => randomBytes(32).toString('base64url');

/**
 * The session or key a request came with, as it is held here: a session by
 * the SHA-256 of its token. A request with neither, one no gate let in, is
 * bound to its account alone, as `stillAuthenticated` treats it.
 */
function holderOf(credential: Credential | null | undefined): string {
	if (credential?.kind === 'session') return `session ${createHash('sha256').update(credential.token).digest('hex')}`;
	if (credential?.kind === 'api key') return `api key ${credential.id}`;
	return 'account';
}

/** Drop every Connect past its time. */
function sweep(now: number): void {
	for (const [state, connect] of pending) {
		if (connect.expiresAt <= now) pending.delete(state);
	}
}

/**
 * Start a Connect of `destName` for `caller`: the state to put in the consent
 * address, and the `code_challenge` (S256) of the verifier kept here.
 */
export function startConnect(caller: ConnectCaller, destName: string): { state: string; codeChallenge: string } {
	const now = Date.now();
	sweep(now);
	const holder = holderOf(caller.credential);
	// One per session and destination: the older is no longer the one under way.
	for (const [state, connect] of pending) {
		if (connect.holder === holder && connect.userId === caller.userId && connect.destName === destName) pending.delete(state);
	}
	while (pending.size >= MOST_PENDING) pending.delete(pending.keys().next().value!);

	const state = random();
	const verifier = random();
	pending.set(state, { verifier, holder, userId: caller.userId, destName, expiresAt: now + CONNECT_LIFETIME_MS });
	return { state, codeChallenge: createHash('sha256').update(verifier).digest('base64url') };
}

/**
 * Take the Connect `state` names, once: it is removed whatever follows. Its
 * verifier, when it is under way, in time, and was started by this session,
 * this account and for this destination; otherwise null, never saying which.
 */
export function takeConnect(state: string, caller: ConnectCaller, destName: string): { verifier: string } | null {
	const now = Date.now();
	sweep(now);
	const connect = pending.get(state);
	if (!connect) return null;
	pending.delete(state);
	const same = connect.holder === holderOf(caller.credential) && connect.userId === caller.userId && connect.destName === destName;
	return same && connect.expiresAt > now ? { verifier: connect.verifier } : null;
}

/** Forget every Connect under way, as a restart does: for the tests, between one and the next. */
export function forgetConnects(): void {
	pending.clear();
}
