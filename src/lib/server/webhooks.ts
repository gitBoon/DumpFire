/**
 * webhooks.ts — Webhook dispatch engine.
 *
 * Fires HTTP POST requests to registered webhook URLs when board events occur.
 * Includes HMAC-SHA256 signature for verification. Fire-and-forget.
 *
 * A delivery is made with `node:http` and `node:https` through agents of the
 * webhooks' own, whose lookup refuses an address inside the network at the
 * moment of connection (card 2161, webhook-address.ts). Redirects are not
 * followed.
 */

import http from 'node:http';
import https from 'node:https';
import { error } from '@sveltejs/kit';
import { db, sqlite } from './db';
import { webhooks } from './db/schema';
import { eq, and } from 'drizzle-orm';
import { createHmac } from 'crypto';
import { createLogger } from './logger';
import { getBoardRole, type Actor } from './board-access';
import { onTheWire } from './v1-json';
import { addressRefusal, guardedLookup } from './webhook-address';

const log = createLogger('Webhooks');

type Webhook = typeof webhooks.$inferSelect;

/**
 * True if the caller may be shown a webhook's signing secret and its address:
 * the board's owner or an administrator.
 *
 * The secret is what lets a receiver trust that a delivery came from here, so
 * anyone holding it can forge one. Viewing the board is not a reason to hold it.
 * The address goes with it (card 2133): it can name a server inside the
 * network, or carry credentials before the host.
 */
export function canSeeWebhookSecret(user: Actor, boardId: number): boolean {
	const role = getBoardRole(user, boardId);
	return role === 'owner' || role === 'admin';
}

/**
 * A webhook as an API response.
 *
 * The secret and the address are left out, with no key, unless `reveal` is
 * set; `hasSecret` says whether a secret exists, which is all most callers
 * need to know. The address was given to every viewer of the board, and to an
 * editor in the answer to their own change (card 2133). Every route returning
 * a webhook goes through here so that none of them can return the raw row.
 *
 * `setBy`, the account that last set the address or the secret (card 2168),
 * is left out for every caller: it is what a password reset reads, not
 * something a caller needs.
 */
export function presentWebhook(hook: Webhook, reveal: boolean) {
	const { secret, url, events, setBy: _setBy, ...rest } = hook;
	return {
		...rest,
		events: JSON.parse(events || '[]') as string[],
		hasSecret: secret !== '',
		...(reveal ? { url, secret } : {})
	};
}

/** Supported webhook event types. */
export type WebhookEvent =
	| 'card.created'
	| 'card.updated'
	| 'card.moved'
	| 'card.completed'
	| 'card.deleted'
	| 'comment.added';

/** Every event a webhook can ask for, as the two routes that save one read `events`. */
export const WEBHOOK_EVENTS: readonly WebhookEvent[] = [
	'card.created',
	'card.updated',
	'card.moved',
	'card.completed',
	'card.deleted',
	'comment.added'
];

/**
 * A webhook's stored `events` as a list, for an update to compare what it is
 * sent with, and for a dispatch to read. Undefined when what is stored is not
 * a list: then nothing sent is the same as it, and the webhook is not sent
 * (card 2145).
 */
export function storedEvents(events: string): unknown[] | undefined {
	try {
		const parsed: unknown = JSON.parse(events);
		return Array.isArray(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The most webhooks a board may have (card 2201), switched off ones counted:
 * one is a single update away from being sent. Every event of a board is sent
 * to each of its webhooks, each a connection of its own held up to 10 s, so
 * this bounds what one event sends. A constant, not a setting: a large value
 * would remove the protection, and nothing about the installation decides it.
 */
export const MAX_WEBHOOKS_PER_BOARD = 10;

/**
 * Refuse 409 a new webhook on a board that already has the most it may
 * (decision 23), saying how many to delete. Called by the create inside its
 * transaction, after every other check and immediately before the insert: a
 * transaction cannot await, so two creates sent together cannot both take the
 * last place. A board already over the cap (decision 24) is told its own
 * count.
 */
export function refuseWebhookOverCap(boardId: number): void {
	const { n } = sqlite.prepare('SELECT COUNT(*) AS n FROM webhooks WHERE board_id = ?').get(boardId) as { n: number };
	if (n < MAX_WEBHOOKS_PER_BOARD) return;
	throw error(
		409,
		`This board has ${n} webhooks, and a board may have at most ${MAX_WEBHOOKS_PER_BOARD}: ` +
			`delete ${n - MAX_WEBHOOKS_PER_BOARD + 1} before adding another.`
	);
}

/**
 * Every board with more webhooks than it may have, by id, with its count: the
 * ones made before the cap, kept and still sent (decision 24). For the
 * start-up line, which names them by id and count, never an address.
 */
export function boardsOverWebhookCap(): { boardId: number; webhooks: number }[] {
	return sqlite
		.prepare(
			'SELECT board_id AS boardId, COUNT(*) AS webhooks FROM webhooks GROUP BY board_id HAVING COUNT(*) > ? ORDER BY board_id'
		)
		.all(MAX_WEBHOOKS_PER_BOARD) as { boardId: number; webhooks: number }[];
}

/** How long a delivery waits for the receiver's status line. */
export const DELIVERY_TIMEOUT_MS = 10_000;

/**
 * The webhooks' own agents. Each delivery is a new connection (`keepAlive:
 * false`) made through `guardedLookup`: a connection kept alive from an
 * earlier delivery would be used without a lookup, so an address refused now
 * would be sent to all the same. Never given `proxyEnv`: through a proxy the
 * lookup would judge the proxy's address, not the receiver's.
 *
 * At most 20 connections to one host and port at once, each agent (the
 * review, O12): a burst of events to a receiver that holds every connection
 * its 10 s waits its turn, rather than opening one socket for each.
 */
const agents = {
	'http:': new http.Agent({ keepAlive: false, lookup: guardedLookup, maxSockets: 20 }),
	'https:': new https.Agent({ keepAlive: false, lookup: guardedLookup, maxSockets: 20 })
};

/** How long a WARN about one webhook, for one kind of reason, is not written again. */
const WARN_AGAIN_AFTER_MS = 60 * 60 * 1000;

/** At most this many webhook and kind pairs are remembered; past it the oldest is forgotten. */
export const WARNINGS_REMEMBERED = 10_000;

/** The kinds of WARN about one webhook, each held to its own hour. */
type WarnKind = 'refused as written' | 'resolves inside' | 'redirect' | 'events not a list';

/**
 * Each webhook and kind of WARN written, with when and how many like it were
 * not written since; oldest written first (an entry written again is moved to
 * the end), so the first is the one to forget.
 */
const warned = new Map<string, { at: number; notLogged: number }>();

/**
 * Write a WARN about one webhook at most once an hour for the same kind of
 * reason (the review, O2): the first at once, then none for an hour, each
 * counted, and the next after the hour, in its own words then, says how many
 * were not written in between. Kept by webhook id and kind, not by the words:
 * a name resolving to a different address each time, or a receiver answering
 * a different redirect status, is still the one line an hour. In memory, so a
 * restart writes the next one at once; at most `WARNINGS_REMEMBERED` pairs, the
 * oldest forgotten past that, so nothing grows without limit within the hour.
 *
 * Every event of a board is a delivery to each of its webhooks, and a
 * refused one wrote a line each time: a busy board with a stopped receiver
 * filled the system log, which keeps 50,000 rows, and pushed out what else
 * it held.
 */
function warnHourly(hookId: number, kind: WarnKind, line: string): void {
	const now = Date.now();
	const key = `${hookId} ${kind}`;
	const last = warned.get(key);
	if (last && now - last.at < WARN_AGAIN_AFTER_MS) {
		last.notLogged++;
		return;
	}
	warned.delete(key);
	while (warned.size >= WARNINGS_REMEMBERED) warned.delete(warned.keys().next().value as string);
	warned.set(key, { at: now, notLogged: 0 });
	const missed = last?.notLogged ?? 0;
	log.warn(missed > 0 ? `${line} (${missed} more like this since the last such line were not logged)` : line);
}

/** Forget every WARN written, as a restart does. For tests: each starts as a server does. */
export function forgetWebhookWarnings(): void {
	warned.clear();
}

/**
 * Why a webhook's address is not sent to, judged as written, with no name
 * looked up: it is not a URL, not `http` or `https` (`http.request` throws for
 * one, where `fetch` once took a `data:` address), carries a user name or
 * password, or is inside the network as written (`addressRefusal`). Null when
 * it may be sent, and is then judged again by what its name resolves to.
 *
 * Names the host, never the path or the query, which can carry a token.
 */
export function refusalAsWritten(address: string): string | null {
	let url: URL;
	try {
		url = new URL(address);
	} catch {
		return 'its address is not a URL';
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return `its address is not an http or https address (${url.protocol})`;
	}
	return addressRefusal(url)?.reason ?? null;
}

/**
 * Every webhook that is on and is refused as written (`refusalAsWritten`),
 * by id and board, with why: for the start-up line. Reads the addresses as
 * stored, and looks no name up.
 */
export function activeWebhooksRefused(): { id: number; boardId: number; reason: string }[] {
	const rows = sqlite.prepare('SELECT id, board_id AS boardId, url FROM webhooks WHERE active = 1 ORDER BY id').all() as {
		id: number;
		boardId: number;
		url: string;
	}[];
	return rows.flatMap(({ id, boardId, url }) => {
		const reason = refusalAsWritten(url);
		return reason === null ? [] : [{ id, boardId, reason }];
	});
}

/**
 * Send one webhook its event, or say in the system log why it was not sent.
 *
 * Refused before any request, with a WARN, when `refusalAsWritten` refuses
 * its address. Then the request is made
 * and ended here, at once, with no `await` before it, as `fetch` was: a test's
 * recorder sees it in the order it was started.
 *
 * What is logged names the webhook, its board and its host, never the path or
 * the query, which can carry a token (a Slack address's path is its secret):
 *
 *   - the guarded lookup's refusal (`EWEBHOOKINSIDE`): a WARN, no connection
 *   - a status from 300 to 399: a WARN, the redirect not followed
 *   - any other status: nothing; the answer is destroyed unread
 *   - an error or the timeout before the status: an ERROR
 *   - an error or the timeout after it: nothing, for the webhook was delivered
 *
 * Each WARN about one webhook for one kind of reason is written at most once
 * an hour (`warnHourly`); the ERRORs are written each time.
 *
 * `timeoutMs` is how long the status line is waited for; tests shorten it.
 */
export function deliver(hook: Webhook, event: WebhookEvent, body: string, timeoutMs: number = DELIVERY_TIMEOUT_MS): void {
	const which = `Webhook ${hook.id} on board ${hook.boardId}`;
	const notSent = (kind: WarnKind, reason: string) => warnHourly(hook.id, kind, `${which} not sent: ${reason}`);

	const refusal = refusalAsWritten(hook.url);
	if (refusal !== null) {
		notSent('refused as written', refusal);
		return;
	}
	const url = new URL(hook.url);
	const protocol = url.protocol as 'http:' | 'https:';

	const signature = hook.secret
		? createHmac('sha256', hook.secret).update(body).digest('hex')
		: '';

	// Through the module object, so that a test can stand in for it.
	const request = protocol === 'https:' ? https.request : http.request;
	// The text as stored: `http.request` reads it with the same parser.
	const req = request(hook.url, {
		method: 'POST',
		agent: agents[protocol],
		headers: {
			'Content-Type': 'application/json',
			// With `end(body)` and this, the body is sent with its length and
			// not chunked, as `fetch` sent it: a receiver may not take chunks.
			'Content-Length': String(Buffer.byteLength(body)),
			Accept: '*/*',
			// Said, as it was before the agents were given `maxSockets`: with a
			// limit, Node asks for the connection to be kept, and a request
			// queued behind it could be given the socket with no lookup.
			Connection: 'close',
			'X-DumpFire-Event': event,
			'X-DumpFire-Signature': signature ? `sha256=${signature}` : '',
			'User-Agent': 'DumpFire-Webhook/1.0'
		}
	});

	let answered = false;
	const timer = setTimeout(() => {
		req.destroy(Object.assign(new Error(`no answer within ${timeoutMs / 1000} s`), { code: 'ETIMEDOUT' }));
	}, timeoutMs);
	timer.unref?.();

	req.on('response', (res: http.IncomingMessage) => {
		answered = true;
		clearTimeout(timer);
		const status = res.statusCode ?? 0;
		if (status >= 300 && status < 400) {
			warnHourly(hook.id, 'redirect', `${which}: ${url.host} answered ${status}, a redirect, which is not followed`);
		}
		res.on('error', () => {});
		res.destroy();
	});
	// Before `end`: a request with no 'error' listener throws its first
	// failure, which in the built server ends the server.
	req.on('error', (err: NodeJS.ErrnoException) => {
		clearTimeout(timer);
		if (answered) return;
		if (err.code === 'EWEBHOOKINSIDE') notSent('resolves inside', err.message);
		else log.error(`${which}: delivery to ${url.host} failed: ${err.message}`, { code: err.code });
	});
	req.end(body);
}

/**
 * Dispatch a webhook event to all active webhooks for a board.
 * Fire-and-forget — errors are logged but never propagate.
 *
 * The board's webhooks are read once, and the body is built once, so every
 * webhook of one event is sent the same body and timestamp; it is signed for
 * each. Then each webhook is handled in its own `try` (card 2145): nothing one
 * row holds or does stops another. A row whose `events` is not a list is not
 * sent, and a WARN names it. Before, one `try` held the whole loop, and a row
 * holding `null` (which `PUT … events: null` once stored) ended it, so every
 * webhook after it on the board was sent nothing.
 */
export function dispatchWebhook(
	boardId: number,
	event: WebhookEvent,
	payload: Record<string, unknown>
): void {
	let hooks: Webhook[];
	let body: string;
	try {
		hooks = db.select()
			.from(webhooks)
			.where(and(
				eq(webhooks.boardId, boardId),
				eq(webhooks.active, true)
			))
			.all();
		if (hooks.length === 0) return;

		// The card data's stored timestamps go out as ISO 8601 with `Z`, as the
		// v1 API answers them and as `timestamp` is (card 2095, plan R1): the
		// stored form names no zone.
		body = JSON.stringify({
			event,
			timestamp: new Date().toISOString(),
			boardId,
			data: onTheWire(payload)
		});
	} catch (err) {
		log.error('Webhook dispatch error', err);
		return;
	}

	for (const hook of hooks) {
		try {
			// A list, or the webhook is not sent: an empty one is every event.
			// Anything else was never what a caller could ask for: a number or
			// an object used to be sent every event, and a string matched by
			// substring.
			const events = storedEvents(hook.events);
			if (events === undefined) {
				warnHourly(hook.id, 'events not a list', `Webhook ${hook.id} on board ${hook.boardId} not sent: its events are not a list`);
				continue;
			}
			if (events.length > 0 && !events.includes(event)) continue;

			deliver(hook, event, body);
		} catch (err) {
			log.error(`Webhook ${hook.id} on board ${hook.boardId} could not be sent`, err);
		}
	}
}
