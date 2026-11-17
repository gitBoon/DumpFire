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
 * 2. **A request token**, random, carried in a link emailed to the requester.
 *    Reading the thread and replying to it need one. It replaces the
 *    requester's email address, which was the only thing checked and is not
 *    a secret. Since card 2870 a request has one per mail that carried a link
 *    and one per new link asked for, each kept only as the SHA-256 of its
 *    token, in `request_links`: the token itself is only in the mail.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { db, sqlite } from './db';
import { settings } from './db/schema';
import { inTransaction } from './db/transaction';
import { sha256Hex } from './mfa-crypto';

// ─── Request tokens ──────────────────────────────────────────────────────────

/** Where a link came from: a mail the server sent, or a new link asked for (card 2870, S1). */
export type RequestLinkSource = 'mail' | 'ask';
/**
 * How many links of each kind a request keeps: the newest (card 2870,
 * decision 3). The 21st mail ends the oldest mail link. Asked-for links are
 * capped apart and low, so that asking (anyone who knows the requester's
 * address can) never ends a link a mail carried.
 */
export const REQUEST_MAIL_LINKS_KEPT = 20;
export const REQUEST_ASK_LINKS_KEPT = 3;

/** Set to NULL whatever an older image wrote into the retired column (card 2870, decision 11). */
export const END_PLAIN_REQUEST_LINKS = 'UPDATE task_requests SET access_token = NULL WHERE access_token IS NOT NULL';

/**
 * What a requester is told when this server cannot send them a link: plain
 * words for somebody who has no account. Why is the superadmin's, and is said
 * in a WARN line alone. The new-link route's answer, and the public form's
 * for a request that must be confirmed (card 2870, S5).
 */
export const CANNOT_SEND_LINK = 'New links cannot be sent just now. Please contact the team that sent you the link.';

/** Why, when the mail settings name a user and hold no password, as a restore leaves them. */
export const NO_MAIL_PASSWORD =
	'the mail settings name a user and hold no password, so every mail would fail; a backup does not hold it, and it ' +
	'is entered again in Admin, 📧 Email / SMTP';

/** A new random token for a link: 32 bytes as 64 hex characters (decision 7). */
function newToken(): string {
	return randomBytes(32).toString('hex');
}

/** Constant-time string comparison, so a wrong guess learns nothing from timing. For form tokens. */
function safeEqual(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

/** The form a link's token is kept in: its SHA-256, hex (decision 4), of the token exactly as given. */
export function requestLinkHash(token: string): string {
	return sha256Hex(token);
}

/**
 * A new link for the request: write its hash with its source, keep only the
 * newest of that source, and return the token, which is only ever put in the
 * mail about to be sent (decision 8). Inside the caller's transaction:
 * throws if none is open, and writes nothing.
 */
export function issueRequestLink(requestId: number, source: RequestLinkSource): string {
	if (!sqlite.inTransaction) {
		throw new Error('issueRequestLink is called inside the transaction of the write its mail follows from, and none is open');
	}
	const token = newToken();
	sqlite
		.prepare('INSERT INTO request_links (token_hash, request_id, source) VALUES (?, ?, ?)')
		.run(requestLinkHash(token), requestId, source);
	sqlite
		.prepare(
			'DELETE FROM request_links WHERE request_id = ? AND source = ? AND id NOT IN ' +
				'(SELECT id FROM request_links WHERE request_id = ? AND source = ? ORDER BY id DESC LIMIT ?)'
		)
		.run(requestId, source, requestId, source, source === 'mail' ? REQUEST_MAIL_LINKS_KEPT : REQUEST_ASK_LINKS_KEPT);
	return token;
}

/**
 * `issueRequestLink` through `inTransaction`: as a savepoint of the caller's
 * transaction where one is open, in a transaction of its own where none is.
 * For the progress mail (`notifyRequesterProgress`), which a comment and a
 * subtask tick report from inside their transaction, and a move and a card
 * created complete from an effect after their commit. The new-link ask uses
 * `issueRequestLinkFor` (request-access.ts), which reads the request again
 * first (the code review's CS1).
 */
export function issueRequestLinkNow(requestId: number, source: RequestLinkSource): string {
	return inTransaction(() => issueRequestLink(requestId, source));
}

let lookupByHash: Database.Statement<[string], { request_id: number }> | null = null;

/**
 * The request a token is a live link to, or null (decision 6). Always one
 * prepared SELECT by the hash: run before the request is read, whatever the
 * id, so that the time it takes says nothing of which requests exist. A
 * token that is not a non-empty string is hashed as '' and looked up all the
 * same.
 */
export function requestIdOfLink(token: unknown): number | null {
	const given = typeof token === 'string' && token !== '' ? token : '';
	lookupByHash ??= sqlite.prepare<[string], { request_id: number }>('SELECT request_id FROM request_links WHERE token_hash = ?');
	const row = lookupByHash.get(requestLinkHash(given));
	// '' is never issued, so its hash is never stored; an empty token opens nothing even so.
	return row && given !== '' ? row.request_id : null;
}

/**
 * A request row as it may be sent to a client: everything except the retired
 * token column, which is NULL from this image (card 2870) and held a key to
 * the thread before it.
 */
export function publicRequest<T extends { retiredAccessToken?: string | null }>(
	request: T
): Omit<T, 'retiredAccessToken'> {
	const { retiredAccessToken: _token, ...rest } = request;
	return rest;
}

/** The link emailed to a requester: their thread, and a key to it. */
export function requestReplyUrl(baseUrl: string, requestId: number, token: string): string {
	return `${baseUrl}/request/${requestId}/reply?token=${encodeURIComponent(token)}`;
}

/** The link emailed to someone who has just submitted a request, to confirm it is theirs. */
export function requestConfirmUrl(baseUrl: string, requestId: number, token: string): string {
	return `${baseUrl}/request/${requestId}/confirm?token=${encodeURIComponent(token)}`;
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
