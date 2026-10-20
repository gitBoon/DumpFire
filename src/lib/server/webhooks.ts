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
 *
 * What each webhook's last delivery came to is kept in memory (card 2178),
 * never in the database, and given to the board's owner and administrators as
 * `lastDelivery` in the webhook's answer. A restart forgets it.
 *
 * A webhook is sent only while the account that set it up can open its board
 * (card 2325), as a mail is sent only to recipients who can (`whoCanOpen`).
 * `deliver` asks first, at each event, so anything that sends goes through
 * it; one whose setter cannot, or that nobody is recorded as having set up,
 * is held: nothing is sent, nothing is written but an hourly WARN, and
 * `active` is left as it is. The answer says why, as `pausedBecause`.
 */

import http from 'node:http';
import https from 'node:https';
import { error } from '@sveltejs/kit';
import { db, sqlite } from './db';
import { webhooks } from './db/schema';
import { eq, and } from 'drizzle-orm';
import { createHash, createHmac } from 'crypto';
import { createLogger } from './logger';
import { canViewBoard, getBoardRole, type Actor } from './board-access';
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
 *
 * `lastDelivery` (card 2178) goes with the address: given only with `reveal`,
 * so the people told a webhook is failing are the people who may read and
 * change where it sends. Null until a delivery since the server started, and
 * after the address changes.
 *
 * `pausedBecause` (card 2325) goes with it: why a webhook that is on is held
 * (`holdOf`), in one of two fixed sentences, or null. Null for one that is
 * off, whoever set it. Worked out here, so it is there after a restart, when
 * `lastDelivery` is null until the next event.
 */
export function presentWebhook(hook: Webhook, reveal: boolean) {
	const { secret, url, events, setBy: _setBy, ...rest } = hook;
	return {
		...rest,
		events: JSON.parse(events || '[]') as string[],
		hasSecret: secret !== '',
		...(reveal ? { url, secret, lastDelivery: deliveryResultFor(hook), pausedBecause: pausedBecause(hook) } : {})
	};
}

// ─── Held while the setter cannot open the board (card 2325) ──────────────

/** Why a webhook is held, or null to send it (card 2325). */
export type Hold = 'no setter' | 'setter cannot open';

/**
 * The account that set the webhook up must still be able to open its board,
 * as a mail's recipient must (whoCanOpen). A webhook nobody is recorded as
 * having set up is held too: nobody answers for where it sends. Asked at each
 * delivery, with the role read now, so an administrator made an ordinary user
 * is held at the next event; `cache` is the dispatch's, so one event asks once
 * per setter. It is keyed by board and setter, though every webhook of one
 * event is on one board, so that a map shared across boards can never carry
 * one board's answer to another.
 */
export function holdOf(hook: Webhook, cache: Map<string, boolean> = new Map()): Hold | null {
	if (hook.setBy === null) return 'no setter';
	const key = `${hook.boardId}:${hook.setBy}`;
	let open = cache.get(key);
	if (open === undefined) {
		const setter = sqlite.prepare('SELECT id, role FROM users WHERE id = ?').get(hook.setBy) as Actor | undefined;
		open = setter !== undefined && canViewBoard(setter, hook.boardId);
		cache.set(key, open);
	}
	return open ? null : 'setter cannot open';
}

/** What `pausedBecause` says for each hold, word for word (the plan's decision 4). */
const PAUSED_BECAUSE: Record<Hold, string> = {
	'setter cannot open':
		'The account that set this up can no longer open this board, so nothing is sent. The address was chosen by that account: ' +
		'delete the webhook unless you recognise it; to keep it, switch it off and on, which makes you its setter, and set a new ' +
		'secret and update the receiver.',
	'no setter':
		'Nobody is recorded as having set this up. Delete it unless you recognise the address; to keep it, switch it off and on, ' +
		'which makes you its setter, and set a new secret.'
};

/** Why a webhook that is on is held, for its answer; null when it is off or is sent. */
function pausedBecause(hook: Webhook): string | null {
	if (!hook.active) return null;
	const hold = holdOf(hook);
	return hold === null ? null : PAUSED_BECAUSE[hold];
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

/**
 * How long a delivery waits for the receiver's status line, counted from when
 * the request is given its connection (card 2178's review): the name's lookup
 * and the connect are counted, a wait behind the agent's 20 connections is not.
 */
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
type WarnKind = 'refused as written' | 'resolves inside' | 'redirect' | 'events not a list' | Hold;

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

// ─── The last delivery (card 2178) ─────────────────────────────────────────

/**
 * What a webhook's last delivery came to, as its answer gives it. `at` is the
 * moment the dispatch began, the body's own `timestamp`; `status` is the
 * receiver's, or null when there was none; `reason` is one of a fixed set of
 * sentences, never an address, a path, a secret or Node's own words.
 */
export type LastDelivery = {
	at: string;
	event: WebhookEvent;
	outcome: 'delivered' | 'answered' | 'no-answer' | 'not-sent';
	status: number | null;
	reason: string;
};

type Result = Pick<LastDelivery, 'outcome' | 'status' | 'reason'>;

/**
 * One dispatch of an event: its body's timestamp, for the answer, and its
 * place in the order dispatches were made, for deciding which result is the
 * newer. The place is a count, not the clock: a clock set back, or two
 * dispatches in one millisecond, would make a newer attempt look older.
 */
export type Dispatch = { at: string; order: number };

let dispatches = 0;

/**
 * The last dispatch made before the results were last forgotten: a result of
 * it, or of one before it, is not held. A restart takes its deliveries in
 * flight with it; in a test, a result that lands late must not reach the next.
 */
let forgottenUpTo = 0;

function nextDispatch(at: string): Dispatch {
	return { at, order: ++dispatches };
}

/** At most this many results are held; past it the one recorded longest ago is forgotten. */
const RESULTS_HELD = 10_000;

/**
 * Each webhook's last result, by id, with its dispatch's place and a SHA-256
 * of where the result was got: the board, the creation time and the address.
 * Never the address itself. Oldest recorded first (a result recorded again is
 * moved to the end), so the first is the one to forget.
 */
const results = new Map<number, { delivery: LastDelivery; order: number; place: string }>();

/**
 * Where a webhook sends, as a hash. A result is given only while the webhook's
 * row still hashes the same: a new address answers null until its next
 * delivery, and a row that reuses an id after a reset or a restore is not
 * given another webhook's result.
 */
function placeOf(hook: Webhook): string {
	return createHash('sha256').update(JSON.stringify([hook.boardId, hook.createdAt, hook.url])).digest('hex');
}

/**
 * Hold `result` as the webhook's last, unless a result of a later dispatch is
 * already held: of two deliveries in flight, the newer attempt's result stays,
 * whichever answers last. Writes nothing to the database: a write here would
 * land at a moment no request controls.
 */
function recordDelivery(hook: Webhook, dispatch: Dispatch, event: WebhookEvent, result: Result): void {
	const held = results.get(hook.id);
	if (held && held.order > dispatch.order) return;
	if (dispatch.order <= forgottenUpTo) return;
	results.delete(hook.id);
	while (results.size >= RESULTS_HELD) results.delete(results.keys().next().value as number);
	results.set(hook.id, { delivery: { at: dispatch.at, event, ...result }, order: dispatch.order, place: placeOf(hook) });
}

/** The webhook's last result since the server started, or null: none yet, or got from another address. */
export function deliveryResultFor(hook: Webhook): LastDelivery | null {
	const held = results.get(hook.id);
	return held && held.place === placeOf(hook) ? held.delivery : null;
}

/** Forget a webhook's result: its delete has committed. */
export function forgetDelivery(id: number): void {
	results.delete(id);
}

/** Forget every result, as a restart does. For tests: each starts as a server does. */
export function forgetDeliveries(): void {
	results.clear();
	forgottenUpTo = dispatches;
}

/** The reason given when nothing came back that tells why: see `deliveryReason`. */
const notReached = (timeoutMs: number) =>
	`The receiver could not be reached, or did not answer within ${timeoutMs / 1000} seconds`;

/**
 * The reason given for an error before the receiver's status (the plan's
 * review, R-S3). Three, and never a code: a closed port, a filtered one, a
 * reset, a receiver that does not answer in time and something that does not
 * speak HTTP all read alike, so that a board's owner cannot map which ports
 * of a host are open from the answers. Only a name that is not found, and a
 * certificate that could not be checked, are told apart, since each needs a
 * fix of its own. A TLS error that is not about the certificate (a wrong
 * version number, which is what a listener that does not speak TLS gives) is
 * read as not reached: told apart, it would say something listens there. The
 * system log keeps the error itself, for administrators.
 *
 * Nor does its timing tell them apart: `deliver` holds a not-reached result
 * until the timeout has passed from the delivery's start, so a refused port is
 * recorded no sooner than a dropped one.
 */
export function deliveryReason(err: { code?: unknown }, timeoutMs: number): string {
	const code = typeof err.code === 'string' ? err.code : '';
	if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return "The receiver's host name could not be found";
	if (
		code.startsWith('ERR_TLS_CERT_') ||
		code.startsWith('CERT_') ||
		code.startsWith('UNABLE_TO_') ||
		code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
		code === 'SELF_SIGNED_CERT_IN_CHAIN'
	) {
		return "The receiver's certificate could not be checked";
	}
	return notReached(timeoutMs);
}

/** What a webhook refused before any request is recorded as, by why it was refused. */
const NOT_SENT: Record<Refusal['kind'] | 'events' | Hold, string> = {
	'not a URL': 'Not sent: the address is not an http or https address',
	scheme: 'Not sent: the address is not an http or https address',
	credentials: 'Not sent: the address carries a user name or password',
	inside: 'Not sent: the address is inside the network',
	events: 'Not sent: its events are not a list',
	// Held (card 2325).
	'setter cannot open': 'Not sent: the account that set it up can no longer open this board',
	'no setter': 'Not sent: nobody is recorded as having set it up'
};

const notSentResult = (why: keyof typeof NOT_SENT): Result => ({ outcome: 'not-sent', status: null, reason: NOT_SENT[why] });

/** Why an address is refused as written, and which kind of refusal it is. */
type Refusal = { kind: 'not a URL' | 'scheme' | 'credentials' | 'inside'; reason: string };

function refusedAsWritten(address: string): Refusal | null {
	let url: URL;
	try {
		url = new URL(address);
	} catch {
		return { kind: 'not a URL', reason: 'its address is not a URL' };
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return { kind: 'scheme', reason: `its address is not an http or https address (${url.protocol})` };
	}
	return addressRefusal(url);
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
	return refusedAsWritten(address)?.reason ?? null;
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
 * Held first, before the address is judged, when its setter cannot open the
 * board or it has no setter (`holdOf`, card 2325): one WARN an hour, naming
 * the webhook, its board and the setter's id, never the address; a not-sent
 * result; nothing written; `active` untouched. Here, not in the dispatch, so
 * that anything that sends is held by it. A check that throws throws before
 * any request: in a dispatch, the webhook's own `try` logs it, unsent.
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
 *   - the connection closed with no status and no error (a `101`): an ERROR
 *   - an error or the timeout after it: nothing, for the webhook was delivered
 *
 * Each WARN about one webhook for one kind of reason is written at most once
 * an hour (`warnHourly`); the ERRORs are written each time.
 *
 * Each attempt records one result (card 2178), at the first of: the refusal
 * before any request, the guarded lookup's refusal, the status line, an error
 * before the status, and the request closing with none of these (a `101`
 * answer, which Node closes with no 'upgrade' listener, gives neither a
 * response nor an error). Every one of the cases above but the last. A result
 * that says the receiver was not reached is held back until `timeoutMs` has
 * passed from the delivery's start, so that how soon it comes says nothing.
 *
 * `timeoutMs` is how long the status line is waited for, counted from when the
 * request is given its connection (`'socket'`), so a delivery queued behind
 * the agent's 20 connections is not timed while it waits; the lookup and the
 * connect are counted. Tests shorten it.
 * `dispatch` is the event's (`dispatchWebhook` passes it, so that every
 * webhook of one event is recorded with the body's timestamp); called on its
 * own, a delivery is a dispatch of its own, made now. So is `holds`, the
 * dispatch's answer to whether each setter can open the board (card 2325);
 * called on its own, a delivery asks afresh.
 */
export function deliver(
	hook: Webhook,
	event: WebhookEvent,
	body: string,
	timeoutMs: number = DELIVERY_TIMEOUT_MS,
	dispatch: Dispatch = nextDispatch(new Date().toISOString()),
	holds: Map<string, boolean> = new Map()
): void {
	const which = `Webhook ${hook.id} on board ${hook.boardId}`;
	const notSent = (kind: WarnKind, reason: string) => warnHourly(hook.id, kind, `${which} not sent: ${reason}`);
	// Once for the attempt, whatever the request does after; `after` ms from
	// now, on a timer that keeps nothing running (a newer result held meanwhile
	// stays: `recordDelivery` keeps the later dispatch's).
	let recorded = false;
	const record = (result: Result, after = 0) => {
		if (recorded) return;
		recorded = true;
		if (after <= 0) {
			recordDelivery(hook, dispatch, event, result);
			return;
		}
		setTimeout(() => recordDelivery(hook, dispatch, event, result), after).unref?.();
	};

	// Held while nobody who can open the board answers for it (card 2325).
	const hold = holdOf(hook, holds);
	if (hold !== null) {
		notSent(
			hold,
			hold === 'no setter'
				? 'nobody is recorded as having set it up'
				: `the account that set it up (user ${hook.setBy}) can no longer open the board`
		);
		record(notSentResult(hold));
		return;
	}

	const refusal = refusedAsWritten(hook.url);
	if (refusal !== null) {
		notSent('refused as written', refusal.reason);
		record(notSentResult(refusal.kind));
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
	// The delivery starts when the request is given its connection: a wait in
	// the agent's queue is not the receiver's slowness.
	let started: number | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	req.once('socket', () => {
		if (req.destroyed) return;
		started = performance.now();
		timer = setTimeout(() => {
			req.destroy(Object.assign(new Error(`no answer within ${timeoutMs / 1000} s`), { code: 'ETIMEDOUT' }));
		}, timeoutMs);
		timer.unref?.();
	});
	// How long until the timeout would have ended the delivery: a not-reached
	// result is held until then, so a port that refuses at once and one that
	// never answers are recorded alike.
	const untilTimedOut = () => (started === undefined ? timeoutMs : started + timeoutMs - performance.now());
	const unreached = () => record({ outcome: 'no-answer', status: null, reason: notReached(timeoutMs) }, untilTimedOut());

	req.on('response', (res: http.IncomingMessage) => {
		answered = true;
		clearTimeout(timer);
		const status = res.statusCode ?? 0;
		if (status >= 300 && status < 400) {
			warnHourly(hook.id, 'redirect', `${which}: ${url.host} answered ${status}, a redirect, which is not followed`);
			record({ outcome: 'answered', status, reason: `The receiver answered ${status}, a redirect, which is not followed` });
		} else {
			record({ outcome: status >= 200 && status < 300 ? 'delivered' : 'answered', status, reason: `The receiver answered ${status}` });
		}
		res.on('error', () => {});
		res.destroy();
	});
	// Before `end`: a request with no 'error' listener throws its first
	// failure, which in the built server ends the server.
	req.on('error', (err: NodeJS.ErrnoException) => {
		clearTimeout(timer);
		if (answered) return;
		if (err.code === 'EWEBHOOKINSIDE') {
			notSent('resolves inside', err.message);
			record(notSentResult('inside'));
		} else {
			log.error(`${which}: delivery to ${url.host} failed: ${err.message}`, { code: err.code });
			const reason = deliveryReason(err, timeoutMs);
			if (reason === notReached(timeoutMs)) unreached();
			else record({ outcome: 'no-answer', status: null, reason });
		}
	});
	// Last of all. With nothing recorded, no status and no error came: a `101`,
	// whose connection Node closes for want of an 'upgrade' listener.
	req.on('close', () => {
		clearTimeout(timer);
		if (recorded) return;
		log.error(`${which}: delivery to ${url.host} failed: the connection closed with no status`);
		unreached();
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
 *
 * One `holds` map for the event, passed to each `deliver` (card 2325): whether
 * each setter can open the board is asked once per setter per event.
 */
export function dispatchWebhook(
	boardId: number,
	event: WebhookEvent,
	payload: Record<string, unknown>
): void {
	let hooks: Webhook[];
	let body: string;
	let dispatch: Dispatch;
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
		const timestamp = new Date().toISOString();
		body = JSON.stringify({
			event,
			timestamp,
			boardId,
			data: onTheWire(payload)
		});
		// Every webhook of this event records its result as of this moment (card 2178).
		dispatch = nextDispatch(timestamp);
	} catch (err) {
		log.error('Webhook dispatch error', err);
		return;
	}

	const holds = new Map<string, boolean>();
	for (const hook of hooks) {
		try {
			// A list, or the webhook is not sent: an empty one is every event.
			// Anything else was never what a caller could ask for: a number or
			// an object used to be sent every event, and a string matched by
			// substring.
			const events = storedEvents(hook.events);
			if (events === undefined) {
				warnHourly(hook.id, 'events not a list', `Webhook ${hook.id} on board ${hook.boardId} not sent: its events are not a list`);
				recordDelivery(hook, dispatch, event, notSentResult('events'));
				continue;
			}
			// An event it does not ask for is not an attempt: nothing is recorded.
			if (events.length > 0 && !events.includes(event)) continue;

			deliver(hook, event, body, DELIVERY_TIMEOUT_MS, dispatch, holds);
		} catch (err) {
			log.error(`Webhook ${hook.id} on board ${hook.boardId} could not be sent`, err);
		}
	}
}
