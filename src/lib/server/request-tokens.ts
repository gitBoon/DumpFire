/**
 * request-tokens.ts — the two secrets the public request form runs on.
 *
 * The request form is the one part of DumpFire that someone without an account
 * can reach. Two things stand in for the sign-in they do not have:
 *
 * 1. **A form token**, issued when the form page is rendered and good for a
 *    couple of hours. Listing who a request can be sent to, and submitting one,
 *    both need it. It does not identify anybody; it shows the caller loaded the
 *    form recently, which is enough to stop the two endpoints being called cold
 *    by a script and lets a token be refused once it is old.
 *
 * 2. **A request token**, one per request, random, carried in the link emailed
 *    to the requester. Reading the thread and replying to it need this. It
 *    replaces the requester's email address, which was the only thing checked
 *    and is not a secret.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { db, sqlite } from './db';
import { settings, type TaskRequest } from './db/schema';

// ─── Request tokens ──────────────────────────────────────────────────────────

/** A new random token for a request's link. */
export function newRequestToken(): string {
	return randomBytes(32).toString('hex');
}

/** Constant-time string comparison, so a wrong guess learns nothing from timing. */
function safeEqual(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

/** True if `token` is this request's own token. */
export function requestTokenMatches(
	request: Pick<TaskRequest, 'accessToken'>,
	token: string | null | undefined
): boolean {
	if (!token || !request.accessToken) return false;
	return safeEqual(request.accessToken, token);
}

/**
 * A request row as it may be sent to a client: everything except the token.
 *
 * The token is the requester's key to the thread. A member of staff handling
 * the request has no use for it, and holding it would let them post as the
 * requester.
 */
export function publicRequest<T extends { accessToken?: string | null }>(
	request: T
): Omit<T, 'accessToken'> {
	const { accessToken: _token, ...rest } = request;
	return rest;
}

/** The link emailed to a requester: their thread, and the key to it. */
export function requestReplyUrl(baseUrl: string, request: Pick<TaskRequest, 'id' | 'accessToken'>): string {
	return `${baseUrl}/request/${request.id}/reply?token=${encodeURIComponent(request.accessToken ?? '')}`;
}

/** The link emailed to someone who has just submitted a request, to confirm it is theirs. */
export function requestConfirmUrl(baseUrl: string, request: Pick<TaskRequest, 'id' | 'accessToken'>): string {
	return `${baseUrl}/request/${request.id}/confirm?token=${encodeURIComponent(request.accessToken ?? '')}`;
}

// ─── Form tokens ─────────────────────────────────────────────────────────────

/** How long a rendered form stays usable. Long enough to write a careful request. */
const FORM_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
/**
 * The setting the form's key is kept in. Never in a backup, and never brought
 * in by a restore (card 2158): `withoutSecrets` in backup.ts, `rowsToRestore`
 * in db/restore.ts. A restored server makes a new one at first use.
 */
export const REQUEST_FORM_SECRET_KEY = 'request_form_secret';

let cachedSecret: string | null = null;

/** The stored key, or undefined where there is none. A read, and nothing else. */
function storedSecret(): string | undefined {
	return db.select().from(settings).where(eq(settings.key, REQUEST_FORM_SECRET_KEY)).get()?.value;
}

/**
 * Write a new form key where there is none (card 2750): the one place it is
 * written. At start-up (`ensureFormSecret`), and inside the transaction of a
 * reset and of a restore, each of which clears it, so that neither commits
 * without one and a write that fails rolls either back. The caller forgets
 * the key held in memory once its transaction commits
 * (`resetFormSecretCache`), and the next use reads the new one.
 *
 * It was made at first use, from inside `formSecret`, which every function
 * that signs reaches, the read guards among them (`decisionRuleGuard`,
 * `resultsReleaseGuard`, `requireRevision`, through `revisionOf` and
 * `purposeKey`): a check meant to be read-only, run before a write, could
 * insert a settings row once.
 *
 * Two at once agree. The insert does nothing where a key is there, and the
 * key used is the one read from the table, never the one written here, so
 * whichever process wrote first is the one every process uses.
 */
export function writeFormSecret(database: Database.Database = sqlite): void {
	database
		.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING')
		.run(REQUEST_FORM_SECRET_KEY, randomBytes(32).toString('hex'));
}

/**
 * At start-up, after the migrations (hooks.server.ts): make the form's key
 * where there is none, and forget any held. Thrown where it cannot: the
 * server stops before it listens.
 */
export function ensureFormSecret(): void {
	cachedSecret = null;
	writeFormSecret();
	if (storedSecret() === undefined) throw new Error('The form signing key could not be made: no row was there to read back');
}

/**
 * The key form tokens are signed with, kept in the settings table, so tokens
 * survive a restart and every instance sharing the database agrees on them.
 *
 * Read, never written (card 2750). Where there is none, nothing is signed
 * and nothing verified: it throws, and the request fails (fail closed).
 * `ensureFormSecret` makes it at every start and after a reset or a restore,
 * so a missing key is a fault, never the first use.
 */
function formSecret(): string {
	if (cachedSecret) return cachedSecret;
	const existing = storedSecret();
	if (existing === undefined) {
		throw new Error('The form signing key is missing; it is made at start-up and after a reset or a restore (ensureFormSecret)');
	}
	cachedSecret = existing;
	return cachedSecret;
}

function sign(payload: string): string {
	return createHmac('sha256', formSecret()).update(payload).digest('hex');
}

/**
 * A key of this server's own for one other purpose, derived from the form's
 * key and never stored: HMAC-SHA256(the form's key, `purpose`). A purpose is
 * fixed text naming its use (card 2676, the code review's C2: a decision's
 * revision), so that no key derived here is the form's, or another
 * purpose's. It changes with the form's key: after a Reset or an import
 * every value made with it is new.
 */
export function purposeKey(purpose: string): Buffer {
	return createHmac('sha256', formSecret()).update(purpose).digest();
}

/** A token for a form rendered now. `<expiry>.<nonce>.<signature>`. */
export function issueFormToken(now: number = Date.now()): string {
	const payload = `${now + FORM_TOKEN_TTL_MS}.${randomBytes(8).toString('hex')}`;
	return `${payload}.${sign(payload)}`;
}

/** True if `token` was issued by this server and has not expired. */
export function verifyFormToken(token: string | null | undefined, now: number = Date.now()): boolean {
	if (!token) return false;
	const parts = token.split('.');
	if (parts.length !== 3) return false;

	const [expiry, nonce, signature] = parts;
	if (!safeEqual(signature, sign(`${expiry}.${nonce}`))) return false;

	const expiresAt = Number(expiry);
	return Number.isFinite(expiresAt) && now < expiresAt;
}

/**
 * Forget the cached signing key, as a fresh process would. For a reset, which
 * clears the setting it is a copy of, and for an import, which replaces it,
 * once either is committed (each has written the new one in its transaction,
 * `writeFormSecret`, card 2750); and for tests.
 */
export function resetFormSecretCache(): void {
	cachedSecret = null;
}
