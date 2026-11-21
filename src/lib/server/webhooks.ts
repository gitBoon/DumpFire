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
 * One whose setter cannot, or that nobody is recorded as having set up, is
 * switched off for good (card 2752): `active` off, with why and when in
 * `held_because` and `held_at`, by `switchOffHeld` (a password or two-step
 * reset, an invite used and an account disabled or deleted record theirs too,
 * the code review's CS4; card 2915; and since card 2923 they hold the account's
 * webhooks already switched off without a hold too, as do the first start of
 * the release and a restore for one whose setter is disabled or not recorded,
 * `holdUnheldOfGoneSetters`, and the boards' owners are mailed of both
 * groups). It stays off
 * when the setter is given the board back, and only the board's owner or an
 * administrator switches it on, with a key. It is switched off at the write
 * that takes the setter's access away (`switchOffLostWebhooks`, called by the
 * six writes that can), at every start and after every restore (the scope
 * `'all'`), and at delivery as the backstop: `deliver` asks first, at each
 * event, so anything that sends goes through it. Each switch-off writes one
 * WARN and mails the board's owners (`notifyWebhooksSwitchedOff`), after the
 * commit. The answer says why, as `pausedBecause`.
 *
 * Nor is one sent once the API key that last set its address or secret, or
 * switched it on, has ended (card 2893): each webhook records that key
 * (`set_by_key`) and whether one was used (`set_with_key`), and is switched
 * off for good, `'key ended'`, when the key expires, passes its deadline, is
 * deleted or is not its setter's. Revoking a key on the Account page sweeps
 * its account's webhooks in the same write; the start, a restore and a
 * delivery find the rest. A webhook made before keys were recorded is held
 * once its setter has no working key made before then
 * (`webhook_keys_recorded_at`, migration 0071). The setter is mailed too,
 * when they can still open the board.
 */

import http from 'node:http';
import https from 'node:https';
import { error } from '@sveltejs/kit';
import { db, sqlite } from './db';
import { afterCommit } from './db/transaction';
import { boardTeams, teamMembers, webhooks, type Board } from './db/schema';
import { eq, and, asc, inArray, isNull } from 'drizzle-orm';
import { createHash, createHmac } from 'crypto';
import { createLogger } from './logger';
import { deadlinePassed, keyEnded, keyExpired } from './auth';
import { canViewBoard, getBoardRole, roleOnBoard, type Actor } from './board-access';
import { notifyWebhooksSwitchedOff } from './notifications';
import { onTheWire } from './v1-json';
import { addressRefusal, guardedLookup, hostOf, receiverOf } from './webhook-address';
import { stamp, toStamp } from '$lib/timestamps';
import { registerStampFunctions } from './db/timestamps';
import { recordWebhooksAs } from './outbound-changes';
import { openStored, openedUrl, webhookSecretAad, type Opened } from './stored-secrets';
import { HELD_DELETED_HERE, HELD_FROM_UNSEALED_BACKUP, HELD_NOT_RECORDED, HELD_REPOINTED_HERE } from '$lib/settings-held';

const log = createLogger('Webhooks');

/** The module's log, for the start's lines about webhooks under the same label (card 2893, D6). */
export { log as webhooksLog };

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
 * something a caller needs. So are `heldBecause` and `heldAt` (card 2752),
 * which `pausedBecause` says in words, and card 2893's `setByKey` and
 * `setWithKey`.
 *
 * `lastDelivery` (card 2178) goes with the address: given only with `reveal`,
 * so the people told a webhook is failing are the people who may read and
 * change where it sends. Null until a delivery since the server started, and
 * after the address changes.
 *
 * `pausedBecause` (card 2325) goes with it: for a webhook switched off by a
 * hold, why it was, as history (card 2752, E14); for one that is on and held
 * now (`holdOf`), that nothing is sent; null otherwise, for one switched off
 * by a `PUT` included, until its setter's access ends (card 2923). Worked out here, so it is there
 * after a restart, when `lastDelivery` is null until the next event.
 *
 * Built from an allowlist of fields, never a spread of the row (card 2928,
 * R1): a column added to the table is in no answer until it is named here.
 * `receiver` (card 2928) is in none. The address is given opened, '' for one
 * a backup left out or that does not open, never as it is stored.
 *
 * With `secret` false (card 2947, R9), a caller shown the address is not given
 * the secret: a `PUT` that did not set or replace it. Every route answers
 * through `answerWebhooks`, which records the key a secret was given to; this
 * builds the answer alone, and writes nothing.
 */
function presentWebhook(hook: Webhook, reveal: boolean, { secret = true }: { secret?: boolean } = {}) {
	// Opened once for the answer (card 2928's code review, C12), only for a caller shown it; never kept.
	const address = reveal ? openedUrl(hook) : null;
	return {
		id: hook.id,
		boardId: hook.boardId,
		events: JSON.parse(hook.events || '[]') as string[],
		active: hook.active,
		createdAt: hook.createdAt,
		// Stored sealed (card 2898): one that does not open still has a secret,
		// and is given as '' (S4, E16), never as it is stored.
		hasSecret: hook.secret !== '',
		...(address !== null
			? {
					url: address.value,
					...(secret ? { secret: openedSecret(hook, address).value } : {}),
					lastDelivery: deliveryResultFor(hook, address),
					pausedBecause: pausedBecause(hook)
				}
			: {})
	};
}

/** A webhook as an answer gives it (`presentWebhook`). */
export type WebhookAnswer = ReturnType<typeof presentWebhook>;

/** Said by `answerWebhooks` to a secret that would go to anything but an API key (card 2947, R5): a fault, a 500. */
const SECRET_ONLY_TO_A_KEY =
	"A webhook's secret is given only to an API key, which is recorded as given it (card 2947), and this request came in with none: nothing was given.";

/**
 * The webhooks as an answer gives them (`presentWebhook`), recording, in the caller's transaction, the API key every
 * non-empty secret in them is given to (card 2947): one `INSERT … SELECT … FROM json_each(?) … ON CONFLICT DO NOTHING`
 * for the answer (R14), so a key given the same secret again keeps the first time. Every route that answers a webhook
 * answers through here. It throws outside a transaction, and for a secret that would go to a credential that is not an
 * API key (a session), or to none at all (R5); the tests' own requests, which carry no credential (`undefined`, which
 * `stillAuthenticated` lets through only under the tests), are answered and record nothing. A secret is given only
 * under /api/v1/, which only a key enters, so neither is reached in the running server. An answer with no secret in it
 * records nothing, whoever asked.
 */
export function answerWebhooks(
	hooks: readonly Webhook[],
	reveal: boolean,
	credential: App.Locals['credential'],
	{ secret = true }: { secret?: boolean } = {}
): WebhookAnswer[] {
	if (!sqlite.inTransaction) throw new Error('answerWebhooks records the key a secret is given to inside the transaction that gives it, and none is open');
	const answers = hooks.map((hook) => presentWebhook(hook, reveal, { secret }));
	const given = hooks.filter((_, i) => typeof answers[i].secret === 'string' && answers[i].secret !== '').map((hook) => hook.id);
	if (given.length === 0) return answers;
	if (credential === undefined) {
		if (process.env.VITEST) return answers;
		throw new Error(SECRET_ONLY_TO_A_KEY);
	}
	if (credential === null || credential.kind !== 'api key') throw new Error(SECRET_ONLY_TO_A_KEY);
	recordRevealOn(sqlite).run(credential.id, stamp(), JSON.stringify(given));
	return answers;
}

/** The reveal's one statement (card 2947, R14), prepared once per connection when first needed (its code review, FP11). */
const RECORD_REVEAL = 'INSERT INTO webhook_reveals (webhook_id, key_id, revealed_at) SELECT value, ?, ? FROM json_each(?) WHERE true ON CONFLICT DO NOTHING';
type RecordReveal = { run(keyId: number, at: string, ids: string): unknown };
const recordReveals = new WeakMap<typeof sqlite, RecordReveal>();
/** `RECORD_REVEAL` prepared on `database`, once. */
function recordRevealOn(database: typeof sqlite): RecordReveal {
	let statement = recordReveals.get(database);
	if (statement === undefined) {
		statement = database.prepare(RECORD_REVEAL);
		recordReveals.set(database, statement);
	}
	return statement;
}

/** `answerWebhooks` for one webhook. */
export function answerWebhook(hook: Webhook, reveal: boolean, credential: App.Locals['credential'], options: { secret?: boolean } = {}): WebhookAnswer {
	return answerWebhooks([hook], reveal, credential, options)[0];
}

/**
 * Forget who was given a webhook's secret (card 2947), in the transaction of the `PUT` that writes a new one (a
 * secret sent, '' to clear it, or a switch-on's new one): every row says "was given the secret it has now", so a
 * change of secret leaves none of them true. The `PUT`'s own answer then records its caller's key. Throws outside a
 * transaction.
 */
export function forgetReveals(webhookId: number): void {
	if (!sqlite.inTransaction) throw new Error('forgetReveals runs inside the transaction of the change of secret, and none is open');
	sqlite.prepare('DELETE FROM webhook_reveals WHERE webhook_id = ?').run(webhookId);
}

/**
 * The webhook's secret opened (card 2898), bound to its id, board and address
 * as opened (card 2928): '' for none and for one that does not open. A secret
 * beside an address that is '' or does not open is read as not opening,
 * whatever it holds (R5): it is bound to nothing that can be checked.
 */
export function openedSecret(hook: Pick<Webhook, 'id' | 'boardId' | 'url' | 'receiver' | 'secret'>, address: Opened = openedUrl(hook)): Opened {
	if (hook.secret === '') return { kind: 'empty', value: '' };
	// The address as the caller opened it (card 2928's code review, C12): opened once, never again here.
	if (address.kind !== 'opened' && address.kind !== 'plain') return { kind: 'unopenable', value: '' };
	return openStored(hook.secret, webhookSecretAad(hook.id, hook.boardId, address.value));
}

// ─── Held while the setter cannot open the board (card 2325) ──────────────

/** Why a webhook is held, or null to send it (card 2325; `'key ended'`, card 2893). */
export type Hold = 'no setter' | 'setter cannot open' | 'key ended';

/** An API key as the hold rule reads it: which, whose it is, its hash (the record of ended keys, card 2995), and when it ends. */
type KeyRow = { id: number; userId: number; keyHash: string; expiresAt: string | null; deadlineAt: string | null };

/**
 * The account that set the webhook up must still be able to open its board,
 * as a mail's recipient must (whoCanOpen). A webhook nobody is recorded as
 * having set up is held too: nobody answers for where it sends. Asked at each
 * delivery, with the role read now, so an administrator made an ordinary user
 * is held at the next event; `cache` is the dispatch's, so one event asks once
 * per setter. It is keyed by board and setter, though every webhook of one
 * event is on one board, so that a map shared across boards can never carry
 * one board's answer to another.
 *
 * Then the key that set it up (card 2893, D2), asked only of a setter who can
 * open the board:
 *
 *   - `set_with_key` 1 and a key recorded: held when the key's row is gone,
 *     it has ended (`keyEnded`, the gate's rule: its expiry, its deadline, or
 *     the record of keys ended here, card 2995), or it is not the setter's (S12)
 *   - `set_with_key` 1 and no key: held, always: its key was deleted, or it
 *     was set with a credential that is not a key (S11)
 *   - `set_with_key` NULL, a webhook set before keys were recorded: held when
 *     the setter has no key made before `webhook_keys_recorded_at` that has
 *     not ended (S9); with no such setting, none counts
 *   - `set_with_key` 0, written only with no credential at all (tests): never
 *     by this rule
 *
 * Cached as `key:<id>:<setter>` and `keys-before:<setter>`, in the same map.
 */
export function holdOf(hook: Webhook, cache: Map<string, boolean> = new Map()): Hold | null {
	if (hook.setBy === null) return 'no setter';
	const key = `${hook.boardId}:${hook.setBy}`;
	let open = cache.get(key);
	if (open === undefined) {
		// With `disabledAt` (card 2671): a disabled setter can open no board, read in this one row.
		const setter = sqlite.prepare('SELECT id, role, disabled_at AS disabledAt FROM users WHERE id = ?').get(hook.setBy) as Actor | undefined;
		open = setter !== undefined && canViewBoard(setter, hook.boardId);
		cache.set(key, open);
	}
	if (!open) return 'setter cannot open';
	return keyEndedFor(hook, hook.setBy, cache) ? 'key ended' : null;
}

/** Whether the key that set the webhook up has ended, by `holdOf`'s rule for the key (card 2893, D2). */
function keyEndedFor(hook: Webhook, setBy: number, cache: Map<string, boolean>): boolean {
	if (hook.setWithKey === false) return false;
	const now = stamp();
	if (hook.setWithKey === true) {
		if (hook.setByKey === null) return true;
		const key = `key:${hook.setByKey}:${setBy}`;
		let ended = cache.get(key);
		if (ended === undefined) {
			const row = sqlite
				.prepare('SELECT id, user_id AS userId, key_hash AS keyHash, expires_at AS expiresAt, deadline_at AS deadlineAt FROM api_keys WHERE id = ?')
				.get(hook.setByKey) as KeyRow | undefined;
			ended = row === undefined || row.userId !== setBy || keyEnded(row, now);
			cache.set(key, ended);
		}
		return ended;
	}
	const key = `keys-before:${setBy}`;
	let ended = cache.get(key);
	if (ended === undefined) {
		ended = !keysBeforeRecorded(setBy).some((row) => !keyEnded(row, now));
		cache.set(key, ended);
	}
	return ended;
}

/**
 * The setter's keys made before keys were recorded (card 2893, S9): before
 * `webhook_keys_recorded_at`, which migration 0071 wrote and a restore keeps.
 * None where the setting is missing: a key made after the release cannot
 * have set a webhook that records none.
 */
export function keysBeforeRecorded(setBy: number): KeyRow[] {
	return sqlite
		.prepare(
			`SELECT id, user_id AS userId, key_hash AS keyHash, expires_at AS expiresAt, deadline_at AS deadlineAt FROM api_keys
			 WHERE user_id = ? AND created_at < (SELECT value FROM settings WHERE key = 'webhook_keys_recorded_at')`
		)
		.all(setBy) as KeyRow[];
}

/**
 * How many webhooks revoking each of an account's keys would switch off now
 * (card 2893, D5; the code review's CS4), by key id: those that are on and
 * record it, and, for the account's last working key made before keys were
 * recorded, also every webhook the account set before then (`set_with_key`
 * NULL) that is on and sent now, which loses its last key with it. For the
 * Account page's key list, which says it before the revoke. By id since card
 * 2947's code review (FP8), so that `webhooksRevealedTo` leaves exactly these out.
 */
export function webhooksStoppedByRevoke(userId: number): Map<number, Set<number>> {
	const stopped = new Map<number, Set<number>>();
	const add = (keyId: number, hookId: number) => stopped.set(keyId, (stopped.get(keyId) ?? new Set<number>()).add(hookId));
	const recorded = sqlite
		.prepare('SELECT set_by_key AS keyId, id FROM webhooks WHERE active = 1 AND set_by_key IS NOT NULL AND set_by = ? ORDER BY id')
		.all(userId) as { keyId: number; id: number }[];
	for (const { keyId, id } of recorded) add(keyId, id);
	const now = stamp();
	const live = keysBeforeRecorded(userId).filter((key) => !keyEnded(key, now));
	if (live.length === 1) {
		const cache = new Map<string, boolean>();
		db.select()
			.from(webhooks)
			.where(and(eq(webhooks.active, true), eq(webhooks.setBy, userId), isNull(webhooks.setWithKey)))
			.all()
			.filter((hook) => holdOf(hook, cache) === null)
			.forEach((hook) => add(live[0].id, hook.id));
	}
	return stopped;
}

/**
 * What a write that makes its caller a webhook's setter records of the key
 * they came in with (card 2893, S11, E16), for both v1 writers: an API key, its
 * row id and `set_with_key` 1; any other credential (a session), no key and
 * `set_with_key` 1, which `holdOf` holds, so a webhook set without a key is
 * never sent; none at all, `set_with_key` 0, which only a test's call has
 * (`locals.credential` undefined: `stillAuthenticated` refuses it outside the
 * tests).
 */
export function keyOfWrite(credential: App.Locals['credential']): { setByKey: number | null; setWithKey: boolean } {
	if (credential === undefined) return { setByKey: null, setWithKey: false };
	return credential?.kind === 'api key' ? { setByKey: credential.id, setWithKey: true } : { setByKey: null, setWithKey: true };
}

/**
 * Why a webhook was switched off for good, as `held_because` stores it (card
 * 2752): a hold (`Hold`), or `'setter access ended'`, written by a password
 * reset, a reset of the two-step sign-in (`resetTwoStep`, and
 * scripts/mfa-reset.mjs in raw SQL, card 2915), an invite used, the holder's
 * own change that ends their keys, the account disabled (card 2671) or deleted
 * (`endAccountAccess`, `deleteUser`; the code review's CS4), so that switching it on gives it a new
 * secret as a lost setter's does. Since card 2923 each of those holds the
 * account's webhooks already switched off without a hold too, active left
 * off, and so do the first start of the release and a restore for one whose
 * setter is disabled or not recorded (`holdUnheldOfGoneSetters`). `'key
 * ended'` is card 2893's hold.
 */
export type HeldBecause =
	| Hold
	| 'setter access ended'
	| typeof HELD_FROM_UNSEALED_BACKUP
	| typeof HELD_DELETED_HERE
	| typeof HELD_NOT_RECORDED
	| typeof HELD_REPOINTED_HERE;

/**
 * The reasons whose switch-on gives the webhook a new secret: a known account held the old one (D3, S4; CS4).
 * Every reason since card 2923's code review (S1): one held for want of a setter may have had its secret set,
 * by a `PUT`, by an account whose access has ended since, which its hold does not record. Card 3004: and the three a
 * restore holds by this server's record of where it sends, whose secret it discarded.
 */
export const NEW_SECRET_REASONS: readonly string[] = [
	'setter cannot open',
	'no setter',
	'setter access ended',
	'key ended',
	HELD_FROM_UNSEALED_BACKUP,
	HELD_DELETED_HERE,
	HELD_NOT_RECORDED,
	HELD_REPOINTED_HERE
];

/** How the switch-off words of a webhook a restore held without trusting where it sends go on (card 3012; card 3004). */
const KEEP_IT_WITH_YOUR_KEY =
	'Delete it unless you recognise the address; to keep it, switch it on with your own key, which makes you its setter and gives it a new secret, ' +
	"given in that answer and readable by the board's owner or an administrator, and update the receiver.";

/**
 * What `pausedBecause` says of a webhook switched off for each reason, word
 * for word (card 2752, 4.3): as history, since it stays off whatever happens
 * to its setter's access. The new secret is given in the switch-on's answer,
 * and stays readable by the board's owner or an administrator (CS6).
 */
export const SWITCHED_OFF_BECAUSE: Record<HeldBecause, string> = {
	'setter cannot open':
		'This was switched off because the account that set it up could no longer open this board. It stays off if that account ' +
		'is given the board back. The address was chosen by that account: delete the webhook unless you recognise it; to keep it, ' +
		'switch it on with your own key, which makes you its setter and gives it a new secret, given in that answer and readable by ' +
		"the board's owner or an administrator, and update the receiver.",
	'no setter':
		'This was switched off because nobody is recorded as having set it up. Delete it unless you recognise the address; to keep ' +
		"it, switch it on with your own key, which makes you its setter and gives it a new secret, given in that answer and readable by the board's owner or an administrator, and update the receiver.",
	// Card 2935: an account that could read its secret, as the board's owner or an administrator, too. Card 2947: an
	// API key that was given it, and the old secret treated as exposed now (R6).
	'setter access ended':
		'This was switched off because the account that set it up, or an account that could read its secret as the board\'s owner or an ' +
		'administrator, had its password or its two-step sign-in reset, ended its API keys when changing its own password, used an ' +
		'invite, was disabled, or was deleted, or, for one that could read it, lost that role; or because an API key that was given its ' +
		'secret was revoked, expired or passed its deadline; one already switched off then, or found ' +
		'switched off with its setter disabled or not recorded, is held the same way. Treat its old secret as exposed: change it at the ' +
		'receiver now, whether or not the webhook is switched on again, since until then the receiver trusts anything signed with it. Delete the webhook unless you recognise its ' +
		'address; to keep it, switch it on with your own key, which makes you its setter and gives it a new secret, given in that answer ' +
		"and readable by the board's owner or an administrator, and update the receiver.",
	'key ended':
		"This was switched off because the API key that set it up ended: it expired, passed its deadline, was deleted or is not the setter's; " +
		'or, for a webhook set up before keys were recorded, the account that set it up has no working key from then. To keep it, ' +
		'switch it on with your own key, which makes you its setter and gives it a new secret, given in that answer and readable by ' +
		"the board's owner or an administrator, and update the receiver.",
	// Card 3012 (R1): every webhook with an address that a restore of a backup whose seal did not verify brought in.
	[HELD_FROM_UNSEALED_BACKUP]:
		'This was switched off because it came in with a backup whose seal did not verify, so its address, its secret and who ' +
		"set it up are only the file's word, and its secret was discarded. Delete it unless you recognise the address; to keep " +
		'it, switch it on with your own key, which makes you its setter and gives it a new secret, given in that answer and ' +
		"readable by the board's owner or an administrator, and update the receiver.",
	// Card 3004 (plan 3.11): the three a restore holds by this server's record of where it sends, each secret discarded.
	[HELD_DELETED_HERE]: `This was switched off because it was deleted on this server after the backup it came back from was made. ${KEEP_IT_WITH_YOUR_KEY}`,
	[HELD_NOT_RECORDED]:
		"This was switched off because it was not in this server's record of where it sends when a backup of it was restored. " + KEEP_IT_WITH_YOUR_KEY,
	[HELD_REPOINTED_HERE]: `This was switched off because it was pointed elsewhere on this server after the backup it came back from was made. ${KEEP_IT_WITH_YOUR_KEY}`
};

/**
 * What `pausedBecause` says of a webhook that is on and held now: a window only
 * a change outside the six writes that switch off can open (the member row
 * deleted from the host, say), closed at its next event.
 */
const HELD_NOW: Record<Hold, string> = {
	'setter cannot open':
		'Nothing is sent: the account that set this up can no longer open this board. It is switched off at its next event, and ' +
		"stays off until the board's owner or an administrator switches it on.",
	'no setter':
		"Nothing is sent: nobody is recorded as having set this up. It is switched off at its next event, and stays off until the board's " +
		'owner or an administrator switches it on.',
	'key ended':
		'Nothing is sent: the API key that set this up has ended. It is switched off at its next event, and stays off until the ' +
		"board's owner or an administrator switches it on."
};

/** A reason as stored in `held_because`, or null for one this build does not know (a later build's, after going back). */
function storedHold(heldBecause: string): HeldBecause | null {
	return Object.hasOwn(SWITCHED_OFF_BECAUSE, heldBecause) ? (heldBecause as HeldBecause) : null;
}

/**
 * Why a webhook is not sent, for its answer (card 2752, E14): one switched off
 * by a hold says why, the reason kept as stored; one on and held now says that
 * nothing is sent; null for one that is sent, and for one switched off any
 * other way.
 */
function pausedBecause(hook: Webhook): string | null {
	if (!hook.active) {
		if (hook.heldBecause === null) return null;
		const hold = storedHold(hook.heldBecause);
		return hold === null
			? `This was switched off (${hook.heldBecause}). It stays off until the board's owner or an administrator switches it on.`
			: SWITCHED_OFF_BECAUSE[hold];
	}
	const hold = holdOf(hook);
	return hold === null ? null : HELD_NOW[hold];
}

// ─── Switched off for good (card 2752) ────────────────────────────────────

// `hostOf` and `receiverOf` live in webhook-address.ts since card 2928 (stored-secrets.ts reads them).
export { hostOf, receiverOf };

/** The host a line, a mail or a list names for a webhook (card 2928): from its stored `receiver`, never from its address. */
export const hostOfHook = (hook: { receiver: string }) => hostOf(hook.receiver);

/**
 * A webhook this process switched off, or held where it was already off (card
 * 2923), as its WARN and its mail name it: with the key it recorded and
 * whether one was used (card 2893), for a key ended. `'setter access ended'`
 * is `endAccountAccess`'s, `deleteUser`'s and `holdUnheldOfGoneSetters`'s.
 */
export type SwitchedOff = {
	id: number;
	boardId: number;
	setBy: number | null;
	setByKey: number | null;
	setWithKey: boolean | null;
	/** Its stored receiver (card 2928), whose host a line or a mail names: never its address. */
	receiver: string;
	hold: HeldBecause;
	/** Held by a pass that found it off with no hold (`holdUnheldOfGoneSetters`), not by an ending of its setter's access. */
	found?: boolean;
	/**
	 * Held because an account other than its setter could read its secret (card 2935): that account's id, where its
	 * access ended or its role was lowered; `'found'` where the start pass or a restore found it readable by an account
	 * disabled, or made before setters were recorded (P3, P4). Absent for the setter's own.
	 */
	reader?: number | 'found';
	/**
	 * Held because an API key that was given its secret ended (card 2947): the key's id, its account's (null where the
	 * key is gone), and `before` for a row the once-only seed wrote (a key used before reads were recorded).
	 */
	revealedBy?: RevealedBy;
	/**
	 * Its secret was given to an API key (card 2947's code review, FP4), whichever hold took it: the owners' mail says
	 * to treat the old secret as exposed and change it at the receiver now.
	 */
	exposed?: boolean;
	/** Told with no account named in its line (card 2996, FP16): a hold of the record of account endings' passes. */
	unnamed?: boolean;
};

/** The API key a hold names as given a webhook's secret (card 2947). */
export type RevealedBy = { key: number; user: number | null; before: boolean };

/** The words for a key a hold names (card 2947): its id, and its account's where known, unless the item is `unnamed` (card 2996). */
const keyNamed = (by: RevealedBy, unnamed = false) => (by.user === null || unnamed ? `key ${by.key}` : `key ${by.key}, user ${by.user}`);

/** ` (user N)` in a hold's words, or nothing for an item told `unnamed` (card 2996, FP16: the record's passes name no account). */
const userWord = (hook: SwitchedOff, id: number | null) => (hook.unnamed ? '' : ` (user ${id})`);

/** `items` marked `unnamed` where `unnamed` is set, so that their lines name no account (card 2996, FP16). */
export function unnamedWhere<T extends SwitchedOff>(items: readonly T[], unnamed: boolean | undefined): T[] {
	return unnamed ? items.map((item) => ({ ...item, unnamed: true })) : [...items];
}

/** A webhook row and its hold, as `SwitchedOff` names them. */
function switchedOff(hook: Webhook, hold: Hold): SwitchedOff {
	return { id: hook.id, boardId: hook.boardId, setBy: hook.setBy, setByKey: hook.setByKey, setWithKey: hook.setWithKey, receiver: hook.receiver, hold };
}

/**
 * Switch one held webhook off for good (D1), and say whether this call did:
 * `active` off, `held_because` the hold, `held_at` now, only while it is on and
 * its setter is the one it was judged on (S8). A webhook switched on again, or
 * given a new setter, between the read and the write is left alone, and two
 * callers switch it off once: only the caller whose write changed the row
 * logs and mails. The one writer of a hold for lost access ('setter access
 * ended' is `endAccountAccess`'s and `deleteUser`'s, which hold one already
 * off too, and `holdUnheldOfGoneSetters`'s, card 2923); switching on clears it
 * (`PUT /api/v1/webhooks/{id}`).
 */
export function switchOffHeld(hook: Pick<Webhook, 'id' | 'setBy'>, hold: Hold): boolean {
	return (
		sqlite
			.prepare('UPDATE webhooks SET active = 0, held_because = ?, held_at = ? WHERE id = ? AND active = 1 AND set_by IS ?')
			.run(hold, stamp(), hook.id, hook.setBy).changes === 1
	);
}

/**
 * The webhook as a change to it must see it (card 2893's code review, CS3):
 * one that is on and held now (`holdOf`: a key ended, or access lost, where no
 * sweep has seen it yet) is switched off for good first, in the caller's
 * transaction, and read again, so that the change is judged against the hold:
 * an editor may not delete it, a create at its receiver is refused, and
 * switching it on gives it a new secret. Told after the commit, with `cause`,
 * or not at all where `cause` is null: a delete, whose commit leaves no webhook
 * to tell of. A change refused afterwards rolls the hold back with it, and it is
 * recorded at the next event instead. Throws outside a transaction.
 */
export function withHoldRecorded(hook: Webhook, cause: string | null): Webhook {
	if (!sqlite.inTransaction) throw new Error('withHoldRecorded records a hold inside the transaction of the change, and none is open');
	if (!hook.active) return hook;
	const hold = holdOf(hook);
	if (hold === null || !switchOffHeld(hook, hold)) return hook;
	if (cause !== null) {
		const done = switchedOff(hook, hold);
		afterCommit(() => tellSwitchedOff([done], cause, { mail: true }));
	}
	return db.select().from(webhooks).where(eq(webhooks.id, hook.id)).get() ?? hook;
}

/**
 * Which webhooks a sweep reads (S10): those on these boards (a share removed,
 * a board made private), those these accounts set, on any board (taken out of
 * a team, a team deleted, a role changed), or every one (a start, a restore).
 * Only those that are on are read. A delivery, the backstop, switches off its
 * one webhook with `switchOffHeld` itself (the code review's CR3: the plan's
 * `{ ids }` had no caller, and went).
 */
export type SweepScope = { boardIds: number[] } | { setters: number[] } | 'all';

/** How a sweep's switch-offs are told: mailed to the boards' owners, or not, with why (S2). */
export type Telling = { mail: true } | { mail: false; because: string };

/**
 * Switch off, for good, every webhook within `scope` that is on and held now
 * (`holdOf`, one cache for the sweep), and return those this call switched off
 * (D2). Inside the transaction of the write that took the access away, so a
 * write that fails leaves the webhooks as they were: it throws outside one.
 *
 * `cause` is a fixed sentence naming the write and who made it (S6), which
 * each WARN and the owners' mail carry. Told after the commit (`afterCommit`),
 * mailed unless `telling` says not; the restore, whose transaction is its
 * own, passes `told: 'by the caller'` and tells after its commit
 * (`tellSwitchedOff`).
 */
export function switchOffLostWebhooks(
	scope: SweepScope,
	cause: string,
	options: { telling?: Telling; told?: 'after commit' | 'by the caller'; unnamed?: boolean } = {}
): SwitchedOff[] {
	if (!sqlite.inTransaction) {
		throw new Error('switchOffLostWebhooks switches off inside the transaction of the write that took the access away, and none is open');
	}
	const on = eq(webhooks.active, true);
	const where =
		scope === 'all'
			? on
			: 'boardIds' in scope
				? and(on, inArray(webhooks.boardId, scope.boardIds))
				: and(on, inArray(webhooks.setBy, scope.setters));
	const cache = new Map<string, boolean>();
	const done: SwitchedOff[] = [];
	for (const hook of db.select().from(webhooks).where(where).orderBy(asc(webhooks.id)).all()) {
		const hold = holdOf(hook, cache);
		if (hold !== null && switchOffHeld(hook, hold)) done.push(switchedOff(hook, hold));
	}
	if (done.length > 0 && options.told !== 'by the caller') {
		const telling = options.telling ?? { mail: true };
		const told = unnamedWhere(done, options.unnamed);
		afterCommit(() => tellSwitchedOff(told, cause, telling));
	}
	return done;
}

/**
 * Why, in a WARN line: the hold in words, with the setter's id, and for a key
 * that ended the key's id (card 2893, 4.3), never its prefix or its hash. A
 * key deleted, or a credential that was not a key, leaves no id to name.
 */
const HOLD_IN_WORDS: Record<HeldBecause, (hook: SwitchedOff) => string> = {
	'setter cannot open': (hook) => `the account that set it up${userWord(hook, hook.setBy)} can no longer open the board`,
	'no setter': () => 'nobody is recorded as having set it up',
	// Card 2923: ending an account's access, the start-up pass and a restore; `set_by` NULL for one found with no setter.
	// Card 2935 (P13, L2): a reader's hold first, then no setter, then one found. Card 2947: a key it was given, first.
	'setter access ended': (hook) =>
		hook.revealedBy !== undefined
			? hook.revealedBy.before
				? `an API key that may have been given its secret before such reads were recorded (${keyNamed(hook.revealedBy, hook.unnamed)}) ended`
				: `an API key that was given its secret (${keyNamed(hook.revealedBy, hook.unnamed)}) ended`
			: typeof hook.reader === 'number'
			? `an account that could read its secret as an owner of the board or an administrator${userWord(hook, hook.reader)} lost that access`
			: hook.reader === 'found'
				? READER_FOUND
				: hook.setBy === null
					? 'nobody is recorded as having set it up'
					: hook.found
						? `it was found switched off with no hold, as it may have been when the access of the account that set it up${userWord(hook, hook.setBy)} ended`
						: `the account that set it up${userWord(hook, hook.setBy)} had its access ended`,
	'key ended': (hook) =>
		hook.setWithKey === null
			? `the account that set it up${userWord(hook, hook.setBy)} has no working API key from before keys were recorded`
			: `the API key that set it up (${hook.setByKey === null ? 'no key recorded' : `key ${hook.setByKey}`}${hook.unnamed ? '' : `, user ${hook.setBy}`}) has ended`,
	// Card 3012 (R16): the restore that holds it tells nobody of it, but the type asks for the words.
	[HELD_FROM_UNSEALED_BACKUP]: () => 'it came in with a backup whose seal did not verify',
	// Card 3004: the restore that holds these tells nobody of them, but the type asks for the words.
	[HELD_DELETED_HERE]: () => 'it was deleted on this server after the backup it came back from was made',
	[HELD_NOT_RECORDED]: () => "it was not in this server's record of where it sends",
	[HELD_REPOINTED_HERE]: () => 'it was pointed elsewhere on this server after the backup it came back from was made'
};

/** Why, in the owners' mail: the hold in words, naming nobody. */
const HOLD_IN_MAIL: Record<HeldBecause, (hook: SwitchedOff) => string> = {
	'setter cannot open': () => 'the account that set it up can no longer open the board',
	'no setter': () => 'nobody is recorded as having set it up',
	'setter access ended': (hook) =>
		hook.revealedBy !== undefined
			? hook.revealedBy.before
				? 'an API key that may have been given its secret before such reads were recorded ended'
				: 'an API key that was given its secret ended'
			: typeof hook.reader === 'number'
			? 'an owner of the board or an administrator who could read its secret lost that access'
			: hook.reader === 'found'
				? READER_FOUND
				: hook.setBy === null
					? 'nobody is recorded as having set it up'
					: hook.found
						? 'it was found switched off with no hold, as it may have been when the access of the account that set it up ended'
						: 'the account that set it up had its access ended',
	'key ended': (hook) =>
		hook.setWithKey === null
			? 'it was set up before keys were recorded, and the account that set it up has no working API key from then'
			: 'the API key that set it up ended',
	[HELD_FROM_UNSEALED_BACKUP]: () => 'it came in with a backup whose seal did not verify',
	[HELD_DELETED_HERE]: () => 'it was deleted on this server after the backup it came back from was made',
	[HELD_NOT_RECORDED]: () => "it was not in this server's record of where it sends",
	[HELD_REPOINTED_HERE]: () => 'it was pointed elsewhere on this server after the backup it came back from was made'
};

/**
 * Why a webhook the start pass or a restore held for a reader is held (card 2935, P3, P4), in the WARN and the mail
 * alike: it names nobody.
 */
const READER_FOUND =
	'its secret may have been read by an owner of the board or an administrator who is disabled now, or before setters were recorded';

/** How many webhooks one WARN of `tellSwitchedOff` names; the rest are counted (card 2899's code review, F1). */
export const SWITCHED_OFF_NAMED = 20;

/**
 * Say what was switched off, once its write has committed: one WARN, naming
 * each webhook, its board, its setter's id and why, never the address (4.3),
 * and the cause; the first 20 named and the rest counted, as `reportBoardLoops`
 * names boards (card 2899's code review, F1: a restore of a backup with many
 * webhooks wrote a line for each, and the log keeps a count of lines, not of
 * days). Then the boards' owners mailed (D4), one mail to each, and for a key
 * that ended its setter too, where they can still open the board (card 2893,
 * S13); or, where `telling` says not, one WARN that they were not, and why (S2).
 *
 * `held` (card 2923, S1): webhooks that were already switched off without a
 * hold and are now held, by an ending of their setter's access, the start-up
 * pass or a restore. One WARN of their own, in the same way, saying that
 * switched on again each is given a new secret; and listed apart in the same
 * mail to each owner, one mail per recipient for both groups. A held webhook
 * never mails its setter.
 *
 * `mailCause` (card 2923's code review, S5): what the owners' mail says caused
 * it, where that differs from the log's `cause`: an ending of an account's
 * access names its kind and no account in the mail, and names both accounts in
 * the log, which administrators read.
 */
export function tellSwitchedOff(
	done: readonly SwitchedOff[],
	cause: string,
	telling: Telling,
	held: readonly SwitchedOff[] = [],
	mailCause: string = cause,
	/** The account whose access ended or was lowered (card 2935, P14; its code review, C11d): never mailed of its own change, as an owner or an administrator. */
	notMailed: number | null = null
): void {
	if (done.length === 0 && held.length === 0) return;
	const named = (hooks: readonly SwitchedOff[]) =>
		hooks
			.slice(0, SWITCHED_OFF_NAMED)
			.map((hook) => `webhook ${hook.id} on board ${hook.boardId}: ${HOLD_IN_WORDS[hook.hold](hook)}`)
			.join('; ') + (hooks.length > SWITCHED_OFF_NAMED ? `; and ${hooks.length - SWITCHED_OFF_NAMED} more` : '');
	if (done.length === 1) {
		const [hook] = done;
		log.warn(
			`Webhook ${hook.id} on board ${hook.boardId} switched off: ${HOLD_IN_WORDS[hook.hold](hook)} (${cause}). ` +
				'It stays off until an owner of the board or an administrator switches it on.'
		);
	} else if (done.length > 1) {
		log.warn(
			`${done.length} webhooks switched off (${cause}): ${named(done)}. ` +
				'Each stays off until an owner of its board or an administrator switches it on.'
		);
	}
	if (held.length === 1) {
		const [hook] = held;
		log.warn(
			`Webhook ${hook.id} on board ${hook.boardId}, already switched off, is now held: ${HOLD_IN_WORDS[hook.hold](hook)} (${cause}). ` +
				'Switched on again by an owner of the board or an administrator, it is given a new secret.'
		);
	} else if (held.length > 1) {
		log.warn(
			`${held.length} webhooks already switched off are now held (${cause}): ${named(held)}. ` +
				'Each, switched on again by an owner of its board or an administrator, is given a new secret.'
		);
	}
	if (telling.mail) {
		notifyWebhooksSwitchedOff(
			done.map((hook) => ({
				boardId: hook.boardId,
				id: hook.id,
				host: hostOfHook(hook),
				why: HOLD_IN_MAIL[hook.hold](hook),
				...(hook.hold === 'setter cannot open' ? { boardBack: true } : {}),
				...(hook.hold === 'key ended' && hook.setBy !== null ? { setter: hook.setBy } : {}),
				// Card 2947 (R6; its code review, FP4): a secret an API key was given, to be treated as exposed now.
				...(hook.exposed ? { exposed: true } : {})
			})),
			mailCause,
			// Never a setter's mail for a held one (S1).
			held.map((hook) => ({
				boardId: hook.boardId,
				id: hook.id,
				host: hostOfHook(hook),
				why: HOLD_IN_MAIL[hook.hold](hook),
				...(hook.exposed ? { exposed: true } : {})
			})),
			notMailed
		);
	} else {
		const all = done.length + held.length;
		const tail = done.length > 0 && held.length > 0 ? 'The lines above name them.' : all === 1 ? 'The line above names it.' : 'The line above names them.';
		log.warn(
			`The owners of the boards of the ${all} webhook(s) ${held.length === 0 ? 'switched off' : 'switched off or held'} above were not mailed, ` +
				`as ${telling.because}. ${tail}`
		);
	}
}

/**
 * The `settings` key that says every webhook already switched off with no hold
 * was held once, whoever set it (card 2923, S3; its code review, S2): written
 * by the first start of the release (`holdAlreadyOffWebhooksAtStart`) and by a
 * restore that held them (`restoreInOneSnapshot`), in the transaction that
 * holds them.
 */
export const WEBHOOKS_ALREADY_OFF_HELD = 'webhooks_already_off_held';

/** A webhook row as the hold statements return it, `set_with_key` as SQLite stores it (0, 1 or NULL). */
type HeldRow = { id: number; boardId: number; receiver: string; setBy: number | null; setByKey: number | null; setWithKey: number | null };

/**
 * The rows a hold statement returned, as `SwitchedOff`, held `'setter access
 * ended'`, by id: the one mapping of `set_with_key` to a boolean, NULL kept
 * (E10; card 2923's code review, E4). `found` marks a webhook a pass found off
 * with no hold, not one an ending of its setter's access held.
 */
function heldAsSwitchedOff(rows: readonly HeldRow[], found: boolean): SwitchedOff[] {
	return rows
		.map((row) => ({
			...row,
			setWithKey: row.setWithKey === null ? null : row.setWithKey !== 0,
			hold: 'setter access ended' as const,
			...(found ? { found: true } : {})
		}))
		.sort((a, b) => a.id - b.id);
}

/**
 * What ended an account's access, for the two places it is told (card 2923's
 * code review, S5): `log`, naming the accounts, for the WARN lines that
 * administrators read; `mail`, the kind of action and no account, for the
 * boards' owners.
 */
export type EndingCause = {
	log: string;
	mail: string;
	/** Whether the owners are mailed (card 2996, FP6): the start's pass mails only where the schedulers run. Mailed by default. */
	telling?: Telling;
	/** Lines that name no account (card 2996, FP16): the record of account endings' passes. */
	unnamed?: boolean;
};

/**
 * The owners' mail's words for each ending of an account's access (card 2923's code review, S5): its kind, naming
 * nobody. Since card 2935 without a subject: each webhook in the mail says whether the account set it up or could
 * read its secret. `demoted` and `ownerLowered` are the lowered roles of card 2935 (P2).
 */
export const ENDING_IN_MAIL = {
	ownChange: 'an account ended its own API keys when changing its password',
	passwordReset: 'an account had its password reset by an administrator',
	invite: 'an account set its password with an invite',
	twoStepReset: 'an account had its two-step sign-in reset by an administrator',
	disabled: 'an account was disabled by an administrator',
	deleted: 'an account was deleted by an administrator',
	demoted: 'an administrator was made an ordinary user',
	ownerLowered: 'an owner of the board was made an editor or a viewer, or taken off the board',
	/** Card 2997 (R4): the start's pass, for an account found holding a password this server had replaced. */
	passwordReplaced: 'an account was found holding a password that had been replaced on this server, and was signed out'
} as const;

/** `two_step_released_at` (`TWO_STEP_RELEASED_AT` in mfa-store.ts, written by migration 0066), named here so that this module imports nothing of mfa-store. */
const TWO_STEP_RELEASED = 'two_step_released_at';

/**
 * SQL that is true where the account `id`, whose role is `role` (both SQL expressions), can be given the secret of a
 * webhook on board `board` (card 2935, A2): an administrator or the superadmin on every board; the board's creator;
 * an exact `owner` member row. Never through a team, which gives at most `editor` (board-access.ts). The one rule
 * for the hold, the counts and the start pass (P11): the admin page passes its row's columns, a correlated subquery.
 */
export function readableBy(id: string, role: string, board = 'board_id'): string {
	return (
		`(${role} IN ('admin', 'superadmin') OR ${board} IN (SELECT rb_b.id FROM boards AS rb_b WHERE rb_b.created_by = ${id}) ` +
		`OR ${board} IN (SELECT rb_m.board_id FROM board_members AS rb_m WHERE rb_m.user_id = ${id} AND rb_m.role = 'owner'))`
	);
}

/**
 * SQL that is true unless the account `id` (an SQL expression) provably read no secret (card 2935, P1): it has
 * never signed in (`last_sign_in_at` NULL), holds no API key, has used no invite but `except` (the hash of the one
 * being used now, an SQL expression), and was made after two-step sign-in was released here. Since that release
 * every session is made by `finishSignIn`, which writes `last_sign_in_at`, and a key needs a session. A release
 * moment that is missing or cannot be read fails closed: the account may have read. Needs `stamp_of` on the
 * connection (`registerStampFunctions`). Every table aliased, so that `id` may name an outer row.
 */
export function mayHaveRead(id: string, except = 'NULL'): string {
	return (
		`NOT ((SELECT mh_u.last_sign_in_at FROM users AS mh_u WHERE mh_u.id = ${id}) IS NULL ` +
		`AND NOT EXISTS (SELECT 1 FROM api_keys AS mh_k WHERE mh_k.user_id = ${id}) ` +
		`AND NOT EXISTS (SELECT 1 FROM invite_tokens AS mh_i WHERE mh_i.user_id = ${id} AND mh_i.used = 1 AND mh_i.token IS NOT ${except}) ` +
		`AND coalesce(stamp_of((SELECT mh_c.created_at FROM users AS mh_c WHERE mh_c.id = ${id})) > ` +
		`stamp_of((SELECT mh_s.value FROM settings AS mh_s WHERE mh_s.key = '${TWO_STEP_RELEASED}')), 0))`
	);
}

/**
 * SQL for how many webhooks the account `id` (role `role`) could read the secret of and did not set, that have a
 * secret and are not held, as the hold would take them (card 2935, P11): `set_by IS NOT`, so a webhook with no
 * setter counts. 0 for an account that provably read nothing (P1). For a count shown before an action.
 */
export function readableCountSql(id: string, role: string): string {
	// `mayHaveRead` asked once for the account, not once a webhook (card 2935's code review, C10).
	return (
		`(CASE WHEN ${mayHaveRead(id)} THEN (SELECT COUNT(*) FROM webhooks AS rc_w WHERE (rc_w.active = 1 OR rc_w.held_because IS NULL) ` +
		`AND rc_w.set_by IS NOT ${id} AND rc_w.secret <> '' AND ${readableBy(id, role, 'rc_w.board_id')}) ELSE 0 END)`
	);
}

/** The account's role, in SQL, as the hold statements read it for `@id`. */
const ROLE_OF_ID = '(SELECT role FROM users WHERE id = @id)';

/**
 * The scope of an ending's hold (card 2935; the code review's C7), over a `webhooks` row, for `@id`, `@readable` and
 * `@revealed`: what the account set, and, with `@readable` 1, every webhook with a secret it could read; and every
 * webhook with a secret its keys were given (card 2947, R10), `@revealed` a JSON list of ids read before the keys go.
 * scripts/mfa-reset.mjs builds the same text, which tests/mfa-reset-script.test.ts compares.
 *
 * `withSecret` (card 3004, R9 L3) is SQL that is true of a webhook with a secret, `secret <> ''` unless given: a
 * restore's reset counts too each webhook a backup left without its secret (`holdResetSettersIn`).
 */
export function endingScope(withSecret = "secret <> ''"): string {
	return `(set_by = @id OR (@readable = 1 AND ${withSecret} AND ${readableBy('@id', ROLE_OF_ID)}) OR (${withSecret} AND id IN (SELECT value FROM json_each(@revealed))))`;
}

/**
 * The scope of the host's `--hold-readable` (card 2935, P7; the code review's C7), for `@id`: every webhook with a
 * secret the account did not set and can read now, unless it provably read nothing. The server holds this scope at
 * no write of its own; the script builds the same text, which tests/mfa-reset-script.test.ts compares.
 */
export function readableNowScope(): string {
	return `set_by IS NOT @id AND secret <> '' AND ${readableBy('@id', ROLE_OF_ID)} AND ${mayHaveRead('@id')}`;
}

/** Give the server's connection `stamp_of`, which `readableCountSql` needs, for a query that embeds it (the admin page's). */
export function readyReadableCounts(): void {
	registerStampFunctions(sqlite);
}

/** Whether the account may have read a webhook's secret (P1), asked of the database as it is now. */
export function accountMayHaveRead(userId: number, exceptInvite: Buffer | null = null, database: typeof sqlite = sqlite): boolean {
	registerStampFunctions(database);
	return (database.prepare(`SELECT ${mayHaveRead('@id', '@except')} AS v`).get({ id: userId, except: exceptInvite }) as { v: number }).v === 1;
}

/** How many webhooks of others the account could read the secret of now (P11): `readableCountSql` for one account. */
export function webhooksReadableBy(userId: number): number {
	registerStampFunctions(sqlite);
	return (sqlite.prepare(`SELECT ${readableCountSql('@id', '(SELECT role FROM users WHERE id = @id)')} AS n`).get({ id: userId }) as { n: number }).n;
}

/**
 * The one statement that holds for an ending, a lowered role and the start pass (card 2935; card 2923's code review,
 * E4): a read of the webhooks in `scope` already off with no hold, then one `UPDATE` of those on or off with no hold
 * in `scope`, `'setter access ended'`, `held_at` now; told apart by the read. `scope` is SQL over the `webhooks` row
 * with the named `params`; `mark` gives each row its marker: its reader (card 2935), or the API key that was given its
 * secret (card 2947), or none. Neither opens a transaction nor tells.
 */
function holdInScope(
	database: typeof sqlite,
	scope: string,
	params: Record<string, unknown>,
	mark: (row: SwitchedOff) => Pick<SwitchedOff, 'reader' | 'revealedBy' | 'exposed' | 'unnamed'>
): { switchedOff: SwitchedOff[]; held: SwitchedOff[] } {
	registerStampFunctions(database);
	// Read in the scope, then written by id in a statement of literals alone, so that the writer inventory reads it
	// as switching off only (card 2702): the same rows, in the same transaction.
	const found = database
		.prepare(`SELECT id, active FROM webhooks WHERE (active = 1 OR held_because IS NULL) AND ${scope}`)
		.all(params) as { id: number; active: number }[];
	// The write runs whether or not a row was found, as every ending's statements do (the pinned write sequences).
	const alreadyOff = new Set(found.filter((row) => row.active === 0).map((row) => row.id));
	const rows = database
		.prepare(
			"UPDATE webhooks SET active = 0, held_because = 'setter access ended', held_at = ? " +
				'WHERE id IN (SELECT value FROM json_each(?)) AND (active = 1 OR held_because IS NULL) ' +
				'RETURNING id, board_id AS boardId, receiver, set_by AS setBy, set_by_key AS setByKey, set_with_key AS setWithKey'
		)
		.all(stamp(), JSON.stringify(found.map((row) => row.id))) as HeldRow[];
	const switchedOff: SwitchedOff[] = [];
	const held: SwitchedOff[] = [];
	for (const hook of heldAsSwitchedOff(rows, false)) {
		const told = { ...hook, ...mark(hook) };
		(alreadyOff.has(hook.id) ? held : switchedOff).push(told);
	}
	return { switchedOff, held };
}

/**
 * Switch off, for good, every webhook `userId` set that is on, and hold every
 * one it set that was already switched off without a hold (card 2923), both
 * as `'setter access ended'`, `active` off, `held_at` now: one statement,
 * after a read of those already off so the two are told apart. One held for
 * another reason keeps it. Inside the caller's transaction (it throws outside
 * one); once committed, both groups are told with `cause` (`tellSwitchedOff`:
 * a WARN each, and one mail to each owner of their boards). The one place
 * an ending of an account's access holds on the server (card 2923's code
 * review, E4), through `holdInScope`: `endAccountAccess` and `deleteUser` call
 * it; the host's scripts/mfa-reset.mjs keeps a copy in its own SQL.
 *
 * With `readable` (card 2935), the same statement takes too every webhook whose secret the account could read
 * (`readableBy`, its role and owner rows as stored now, read in SQL, so a disable that wrote `disabled_at` first
 * still finds them) that has a secret, whoever set it: each marked `reader`. The caller decides `readable`: an
 * ending with the keys, of an account that may have read (`accountMayHaveRead`, P1), asked before the keys go.
 * `readable` counts those, not set by the account. The account itself is never mailed through the administrators'
 * fallback (P14).
 *
 * With `revealed` (card 2947, R10): every webhook with a secret the account's keys were given, read by the caller
 * before the keys are deleted (`revealedToAccount`), whoever set it and whatever the account can read now; marked
 * `reader` as the readable ones are, and counted with them.
 */
export function holdWebhooksOfSetter(
	userId: number,
	cause: EndingCause,
	{ readable, revealed = [] }: { readable: boolean; revealed?: readonly number[] }
): { switchedOff: SwitchedOff[]; held: SwitchedOff[]; readable: number } {
	if (!sqlite.inTransaction) throw new Error('holdWebhooksOfSetter holds inside the transaction that ends the access, and none is open');
	const scope = endingScope();
	// Bound as 1 or 0 (P13, L6).
	const params = { id: userId, readable: readable ? 1 : 0, revealed: JSON.stringify(revealed) };
	// Every one its keys were given marked exposed (card 2947's code review, FP4), the setter's own and a reader's alike.
	const given = new Set(revealed);
	const { switchedOff, held } = holdInScope(sqlite, scope, params, (hook) => ({
		...(hook.setBy === userId ? {} : { reader: userId }),
		...(given.has(hook.id) ? { exposed: true } : {})
	}));
	// Each recorded `held` in this server's record of where it sends (card 3004, O5), in one statement that always runs.
	recordWebhooksAs(sqlite, [...switchedOff, ...held].map((hook) => hook.id), 'held');
	if (switchedOff.length + held.length > 0) {
		const [toldOff, toldHeld] = [unnamedWhere(switchedOff, cause.unnamed), unnamedWhere(held, cause.unnamed)];
		afterCommit(() => tellSwitchedOff(toldOff, cause.log, cause.telling ?? { mail: true }, toldHeld, cause.mail, userId));
	}
	return { switchedOff, held, readable: [...switchedOff, ...held].filter((hook) => hook.reader !== undefined).length };
}

/**
 * Hold the webhooks whose secret `userId` could read before a lowered role and cannot now (card 2935, P2): an
 * administrator made an ordinary user (`boardIds` 'all'), or an `owner` member row lowered or removed (that board).
 * Called after the change is written, in its transaction: what it can still read (a board it made, another owner
 * row, an administrator's role) is left, as is what it set and what has no secret; nothing for an account that
 * provably read nothing (P1). Same reason and mail as an ending; its keys and sessions are the caller's. Returns how
 * many it took.
 */
export function holdNoLongerReadable(userId: number, boardIds: readonly number[] | 'all', cause: EndingCause): number {
	if (!sqlite.inTransaction) throw new Error('holdNoLongerReadable holds inside the transaction that lowers the role, and none is open');
	// A disabled account whose disable is covered read nothing since (card 2935's code review, C1): its disable, or
	// the start pass, held what it could read, and what owners switched on since has a secret it never saw.
	if (disableCovered(userId)) return 0;
	const boards = boardIds === 'all' ? '1' : 'board_id IN (SELECT value FROM json_each(@boards))';
	const scope = noLongerReadableScope("secret <> ''", boards, `${readableBy('@id', ROLE_OF_ID)} OR NOT ${mayHaveRead('@id')}`);
	const params: Record<string, unknown> = { id: userId, ...(boardIds === 'all' ? {} : { boards: JSON.stringify(boardIds) }) };
	const { switchedOff, held } = holdInScope(sqlite, scope, params, () => ({ reader: userId }));
	if (switchedOff.length + held.length > 0) {
		const [toldOff, toldHeld] = [unnamedWhere(switchedOff, cause.unnamed), unnamedWhere(held, cause.unnamed)];
		afterCommit(() => tellSwitchedOff(toldOff, cause.log, cause.telling ?? { mail: true }, toldHeld, cause.mail, userId));
	}
	return switchedOff.length + held.length;
}

/**
 * The scope a lowered role's hold takes, over a `webhooks` row, for `@id` (card 2935, P2; card 2996, R7): what `@id`
 * did not set, with a secret by `withSecret`, on the boards `boardFilter` keeps (every board, the boards named, or the
 * boards the account could read with the role it was restored with), that it cannot read by `stillReadable` now. One
 * text for `holdNoLongerReadable` and `holdNoLongerReadableIn`.
 */
function noLongerReadableScope(withSecret: string, boardFilter: string, stillReadable: string): string {
	return `set_by IS NOT @id AND ${withSecret} AND ${boardFilter} AND NOT (${stillReadable})`;
}

/**
 * An account a restore ended or lowered by the record of account endings (card 2996, R7), for `holdNoLongerReadableIn`;
 * or an owner the record of access changes lowered or removed, or a creator it cleared, with `boards`, those boards
 * (card 3002, decision 10).
 */
export type RuledReader = { id: number; was: string; ended: boolean; boards?: readonly number[] };

/**
 * `holdNoLongerReadable` on the restore's connection, for every account the record of account endings ruled on in it
 * (card 2996, R7): each webhook with a secret it did not set that it could read with the role it was restored with
 * (`was`), and that it cannot read now: its role lowered, or, `ended`, any at all, the account being disabled or
 * inert. Each is taken as one that may have read: the restored data cannot show otherwise. `listed`, the webhooks the
 * backup left without their secret, count as having one, as the restore's readable pass counts them. Each marked
 * `reader`, the account's id. Run after the fill, beside `holdRevealedIn`. Opens no transaction; throws outside one;
 * tells nobody: the restore tells them with its sweep.
 *
 * An account with `boards` (card 3002, decision 10: an owner the record of access changes lowered or removed) is held
 * on those boards alone, in place of those it could read with `was`; what it can still read now is left.
 */
export function holdNoLongerReadableIn(
	live: typeof sqlite,
	accounts: readonly RuledReader[],
	listed: readonly number[] = []
): { switchedOff: SwitchedOff[]; held: SwitchedOff[] } {
	if (!live.inTransaction) throw new Error("holdNoLongerReadableIn holds inside the restore's transaction, and none is open");
	const scopeOf = (boards: boolean) =>
		noLongerReadableScope(
			"(secret <> '' OR id IN (SELECT value FROM json_each(@listed)))",
			boards ? 'board_id IN (SELECT value FROM json_each(@boards))' : readableBy('@id', '@was'),
			`@ended = 0 AND ${readableBy('@id', ROLE_OF_ID)}`
		);
	const switchedOff: SwitchedOff[] = [];
	const held: SwitchedOff[] = [];
	for (const account of accounts) {
		const byBoard = account.boards !== undefined;
		const params = { id: account.id, was: account.was, ended: account.ended ? 1 : 0, listed: JSON.stringify(listed), ...(byBoard ? { boards: JSON.stringify(account.boards) } : {}) };
		// Each told with no account named (card 2996, FP16): the restore's lines count, and name nobody the record ended.
		const found = holdInScope(live, scopeOf(byBoard), params, () => ({
			reader: account.id,
			unnamed: true
		}));
		switchedOff.push(...found.switchedOff);
		held.push(...found.held);
	}
	return { switchedOff, held };
}

/**
 * Card 3004 (comment 3, R9 L3): what a restore's password reset holds, as a real reset does (`holdWebhooksOfSetter`
 * with `readable`), for every account it reset (`resetOne` in restore.ts): through the ending's own scope
 * (`endingScope`, `@readable` 1, nothing revealed, as the restore holds what keys were given apart), every webhook the
 * account set, with or without a key, and every one with a secret it could read as an owner of the board or an
 * administrator, whoever set it. `listed`, the webhooks the backup left without their secret, count as having one, as
 * `holdNoLongerReadableIn` counts them. Each `setter access ended`, marked `reader` where the account did not set it,
 * and told with no account named. Run after the fill and before the sweep, so that the reason is the account's ending
 * and not a key ended. Opens no transaction; throws outside one; tells nobody: the restore tells them with its sweep.
 */
export function holdResetSettersIn(
	live: typeof sqlite,
	accounts: readonly number[],
	listed: readonly number[] = []
): { switchedOff: SwitchedOff[]; held: SwitchedOff[] } {
	if (!live.inTransaction) throw new Error("holdResetSettersIn holds inside the restore's transaction, and none is open");
	const scope = endingScope("(secret <> '' OR id IN (SELECT value FROM json_each(@listed)))");
	const switchedOff: SwitchedOff[] = [];
	const held: SwitchedOff[] = [];
	for (const id of [...new Set(accounts)]) {
		const found = holdInScope(live, scope, { id, readable: 1, revealed: '[]', listed: JSON.stringify(listed) }, (hook) => ({
			...(hook.setBy === id ? {} : { reader: id }),
			unnamed: true
		}));
		switchedOff.push(...found.switchedOff);
		held.push(...found.held);
	}
	return { switchedOff, held };
}

/**
 * The `settings` key that holds the moment up to which the start pass has covered the webhooks readable by
 * disabled owners and administrators (card 2935, P4): written by the pass and a restore that ran it, and advanced by
 * every disable on this image (`advanceReadableCovered`), whose own ending held what it could read.
 */
export const WEBHOOKS_READABLE_COVERED = 'webhooks_readable_by_disabled_held';

/** The moment `database`'s flag names, in the stored form, or null: absent, or a moment it cannot read (fail closed: the pass runs in full). */
export function readableCoveredAt(database: typeof sqlite = sqlite): string | null {
	const row = database.prepare('SELECT value FROM settings WHERE key = ?').get(WEBHOOKS_READABLE_COVERED) as { value: string | null } | undefined;
	return row ? toStamp(row.value) : null;
}

/**
 * Whether the account is disabled and its disable is covered (card 2935's code review, C1, C2): its `disabled_at`
 * names a moment, a moment is stored, and the disable is at or before it. Then what it could read was held when it
 * was disabled, or by the pass, and it has read nothing since. False for an enabled account, and wherever the answer
 * is not known (fail closed: hold).
 */
export function disableCovered(userId: number, database: typeof sqlite = sqlite): boolean {
	const moment = readableCoveredAt(database);
	if (moment === null) return false;
	registerStampFunctions(database);
	const row = database.prepare('SELECT stamp_of(disabled_at) AS at FROM users WHERE id = ?').get(userId) as { at: string | null } | undefined;
	return row !== undefined && row.at !== null && row.at <= moment;
}

/**
 * Whether this process's start pass has run to its commit (card 2935's code review, C2a): only then may a disable
 * move the stored moment past itself, since only then are the disables before it known to be covered.
 */
let readablePassDone = false;

/** Say that this process's start pass, or a restore's, has committed (C2a). */
export function markReadablePassDone(): void {
	readablePassDone = true;
}

/** For tests: this process as one whose start pass has not run. */
export function forgetReadablePassDone(): void {
	readablePassDone = false;
}

/**
 * Advance the flag's moment to `at`, the `disabled_at` of the account `userId` whose disable has just held what it
 * could read (P4), where it names an earlier one; and only (card 2935's code review, C2) once this process's start
 * pass has committed, and where no other account was disabled between the moment and `at`, or at a moment that
 * cannot be read: such a disable was not covered, and the moment stays before it for the next start.
 */
export function advanceReadableCovered(at: string, userId: number): void {
	if (!readablePassDone) return;
	registerStampFunctions(sqlite);
	sqlite
		.prepare(
			'UPDATE settings SET value = @at WHERE key = @key AND stamp_of(value) < stamp_of(@at) AND NOT EXISTS (' +
				'SELECT 1 FROM users AS o WHERE o.id <> @id AND o.disabled_at IS NOT NULL AND (stamp_of(o.disabled_at) IS NULL OR ' +
				'(stamp_of(o.disabled_at) > stamp_of(settings.value) AND stamp_of(o.disabled_at) <= stamp_of(@at))))'
		)
		.run({ at, key: WEBHOOKS_READABLE_COVERED, id: userId });
}

/**
 * When migration 0056 (the setters, card 2168) was applied here, from the runner's own record
 * (`__drizzle_migrations.created_at`), or null: no row, no such column, or a value that names no moment.
 */
export function setterRecordedSince(database: typeof sqlite = sqlite): string | null {
	try {
		const row = database.prepare("SELECT created_at AS at FROM __drizzle_migrations WHERE hash = '0056_add_webhook_set_by.sql'").get() as
			| { at: unknown }
			| undefined;
		return row ? toStamp(row.at) : null;
	} catch {
		return null;
	}
}

/**
 * The start pass and a restore's (card 2935, P3, P4, P12): hold every webhook with a secret, not held, that an
 * owner or administrator disabled after `since` could read and did not set (its own are the setter rules', card
 * 2752's sweep), and that was made on or before that disable (a moment
 * it cannot read counts as before); and, where `since` is null (the first run), every one made before migration
 * 0056 was applied here, or, where that is not known, every one (fail closed). `listed` are webhooks a backup left
 * without their secret, counted as having one. Each marked `reader: 'found'`. Then the flag is written as now.
 * Inside the caller's transaction; tells nobody.
 */
export function coverReadable(database: typeof sqlite, { since, listed = [] }: { since: string | null; listed?: readonly number[] }): { switchedOff: SwitchedOff[]; held: SwitchedOff[] } {
	registerStampFunctions(database);
	// The steady state (card 2935's code review, C9): a moment stored, so nothing before setters were recorded is
	// pending, and no account disabled after it or at a moment that cannot be read. Nothing to hold, and the moment
	// is left as it is: writing it again changes nothing that is read, since no disable lies between.
	if (
		since !== null &&
		!database
			.prepare('SELECT 1 FROM users WHERE disabled_at IS NOT NULL AND (stamp_of(disabled_at) IS NULL OR stamp_of(disabled_at) > ?) LIMIT 1')
			.get(since)
	) {
		return { switchedOff: [], held: [] };
	}
	const scope =
		"(secret <> '' OR id IN (SELECT value FROM json_each(@listed))) AND (" +
		'EXISTS (SELECT 1 FROM users AS d WHERE d.disabled_at IS NOT NULL AND webhooks.set_by IS NOT d.id AND (@since IS NULL OR stamp_of(d.disabled_at) > @since) ' +
		'AND (stamp_of(webhooks.created_at) IS NULL OR stamp_of(d.disabled_at) IS NULL OR stamp_of(webhooks.created_at) <= stamp_of(d.disabled_at)) ' +
		`AND ${readableBy('d.id', 'd.role', 'webhooks.board_id')} AND ${mayHaveRead('d.id')}) ` +
		'OR (@since IS NULL AND (@before IS NULL OR stamp_of(webhooks.created_at) IS NULL OR stamp_of(webhooks.created_at) < @before)))';
	const found = holdInScope(database, scope, { since, before: since === null ? setterRecordedSince(database) : null, listed: JSON.stringify(listed) }, () => ({ reader: 'found' }));
	database
		.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
		.run(WEBHOOKS_READABLE_COVERED, stamp());
	return found;
}

/**
 * Hold, for good, webhooks already switched off without a hold (card 2923, S3,
 * decisions 19 to 21; its code review, S2, E3): `held_because` 'setter access
 * ended', `held_at` now, `active` left off, so that switching one on gives it
 * a new secret. By default those whose setter is disabled or not recorded,
 * which every start and every restore asks; with `every`, all of them,
 * whoever set them, which the first start of the release and a restore of a
 * database without `webhooks_already_off_held` ask once, since an ending of
 * access before the release held none of them. One statement on `database`,
 * inside the caller's transaction; it neither opens one nor tells: its
 * callers, `holdAlreadyOffWebhooksAtStart` (startup-checks.ts) and
 * `restoreInOneSnapshot`, do both. Returns those it held, by id, each marked
 * `found`.
 */
export function holdUnheldOfGoneSetters(database: typeof sqlite = sqlite, { every = false }: { every?: boolean } = {}): SwitchedOff[] {
	const rows = database
		.prepare(
			"UPDATE webhooks SET active = 0, held_because = 'setter access ended', held_at = ? " +
				'WHERE active = 0 AND held_because IS NULL AND (? = 1 OR set_by IS NULL OR set_by IN (SELECT id FROM users WHERE disabled_at IS NOT NULL)) ' +
				'RETURNING id, board_id AS boardId, receiver, set_by AS setBy, set_by_key AS setByKey, set_with_key AS setWithKey'
		)
		.all(stamp(), every ? 1 : 0) as HeldRow[];
	return heldAsSwitchedOff(rows, true);
}

// ─── Which API key was given which secret (card 2947) ─────────────────────

/**
 * A row of `webhook_reveals` (migration 0075) as the holds read it: the webhook, the key, the key's account (null
 * where the key's row is gone) and whether the once-only seed wrote it (`revealed_at` NULL).
 */
export type Reveal = { webhookId: number; keyId: number; userId: number | null; before: boolean };

/**
 * What these keys were given (card 2947): every row of theirs, by webhook then key. Read before a key is deleted,
 * since the foreign key takes its rows with it (R3).
 */
export function revealsOfKeys(keyIds: readonly number[], database: typeof sqlite = sqlite): Reveal[] {
	const rows = database
		.prepare(
			'SELECT r.webhook_id AS webhookId, r.key_id AS keyId, k.user_id AS userId, r.revealed_at IS NULL AS before ' +
				'FROM webhook_reveals AS r LEFT JOIN api_keys AS k ON k.id = r.key_id ' +
				'WHERE r.key_id IN (SELECT value FROM json_each(?)) ORDER BY r.webhook_id, r.key_id'
		)
		.all(JSON.stringify(keyIds)) as { webhookId: number; keyId: number; userId: number | null; before: number }[];
	return rows.map((row) => ({ ...row, before: row.before === 1 }));
}

/**
 * Hold, `'setter access ended'`, every webhook with a secret that these reveals name and that is not already held
 * (card 2947, R3): one on is switched off, one off with no hold is held, left off; one held for any reason keeps it,
 * a webhook the setters' sweep has just switched off among them. Each marked with the key that was given it (the
 * lowest key id where several were). Inside the caller's transaction (it throws outside one); tells nobody: the
 * caller tells once, after its commit, with everything else its action switched off (R4).
 */
export function holdRevealed(reveals: readonly Reveal[]): { switchedOff: SwitchedOff[]; held: SwitchedOff[] } {
	if (!sqlite.inTransaction) throw new Error('holdRevealed holds inside the transaction of the write that ended the key, and none is open');
	return holdRevealedRows(sqlite, reveals);
}

/**
 * `holdRevealed` on any connection (card 2947's code review, FP1): the restore's, a working copy's included, whose
 * webhooks it holds before switching every one off, telling nobody. Opens no transaction; throws outside one.
 */
export function holdRevealedIn(live: typeof sqlite, reveals: readonly Reveal[]): { switchedOff: SwitchedOff[]; held: SwitchedOff[] } {
	if (!live.inTransaction) throw new Error("holdRevealedIn holds inside the restore's transaction, and none is open");
	return holdRevealedRows(live, reveals);
}

/** The one statement of `holdRevealed`, `holdRevealedIn` and the sweep (card 2947). Neither opens a transaction nor tells. */
function holdRevealedRows(database: typeof sqlite, reveals: readonly Reveal[]): { switchedOff: SwitchedOff[]; held: SwitchedOff[] } {
	const first = new Map<number, Reveal>();
	for (const reveal of reveals) if (!first.has(reveal.webhookId)) first.set(reveal.webhookId, reveal);
	return holdInScope(database, "secret <> '' AND id IN (SELECT value FROM json_each(@ids))", { ids: JSON.stringify([...first.keys()]) }, (hook) => {
		const by = first.get(hook.id)!;
		return { revealedBy: { key: by.keyId, user: by.userId, before: by.before }, exposed: true };
	});
}

/**
 * Mark as exposed every item whose webhook was given to a key (card 2947's code review, FP4), whichever hold took it
 * (`key ended` by the setters' sweep, a reader's at an ending), so that the owners' mail says to change its secret at
 * the receiver now. Returns new items; the others are kept as they are.
 */
export function markExposed(items: readonly SwitchedOff[], revealed: Iterable<number>): SwitchedOff[] {
	const ids = new Set(revealed);
	return items.map((item) => (ids.has(item.id) ? { ...item, exposed: true } : item));
}

/** An API key with rows that has ended (card 2947), and how: its row gone, its account gone or disabled, its expiry or its deadline passed. */
export type EndedKey = { id: number; userId: number | null; how: 'gone' | 'disabled' | 'expired' | 'deadline' };

/**
 * The keys with rows in `webhook_reveals` that have ended at `now` (card 2947), by the gate's own rule (`keyHolder` in
 * auth.ts): one whose row is gone (only a write with the foreign keys off can leave that), one whose account is gone
 * or disabled (its code review, FP3), one whose expiry is at or before now or names no moment, one whose deadline has
 * passed or names no moment. In key order.
 */
export function endedKeysWithReveals(database: typeof sqlite = sqlite, now: string = stamp()): EndedKey[] {
	const rows = database
		.prepare(
			'SELECT DISTINCT r.key_id AS id, k.id IS NULL AS gone, k.user_id AS userId, k.expires_at AS expiresAt, k.deadline_at AS deadlineAt, ' +
				'(u.id IS NULL OR u.disabled_at IS NOT NULL) AS accountEnded ' +
				'FROM webhook_reveals AS r LEFT JOIN api_keys AS k ON k.id = r.key_id LEFT JOIN users AS u ON u.id = k.user_id ORDER BY r.key_id'
		)
		.all() as { id: number; gone: number; userId: number | null; expiresAt: string | null; deadlineAt: string | null; accountEnded: number }[];
	const ended: EndedKey[] = [];
	for (const row of rows) {
		if (row.gone === 1) ended.push({ id: row.id, userId: null, how: 'gone' });
		else if (row.accountEnded === 1) ended.push({ id: row.id, userId: row.userId, how: 'disabled' });
		else if (keyExpired(row, now)) ended.push({ id: row.id, userId: row.userId, how: 'expired' });
		else if (deadlinePassed(row, now)) ended.push({ id: row.id, userId: row.userId, how: 'deadline' });
	}
	return ended;
}

/** What the sweep says caused it (card 2947): the keys by id in the log, which administrators read; none in the mail. */
export function endedKeysCause(ended: readonly EndedKey[]): EndingCause {
	const said = ended.map((key) => {
		const whose = key.userId === null ? '' : ` of user ${key.userId}`;
		return key.how === 'gone'
			? `API key #${key.id} is gone`
			: key.how === 'disabled'
				? `API key #${key.id}${whose} belongs to an account that is disabled or gone`
				: key.how === 'expired'
					? `API key #${key.id}${whose} expired`
					: `API key #${key.id}${whose} passed its deadline`;
	});
	return { log: said.join('; '), mail: 'an API key that had been given webhook secrets expired, passed its deadline or was removed' };
}

/**
 * The sweep of ended keys (card 2947), at every start and every five minutes (startup-checks.ts), and in the server's
 * own restore (R1): for every key with rows that has ended (`endedKeysWithReveals`), first its account's webhooks
 * swept as a revoke sweeps them (`switchOffLostWebhooks`, `'key ended'` for those the key set), then every webhook
 * with a secret the key was given held (`holdRevealed`), then the key's rows deleted, so that each key's hold is made
 * once (an ended key is never revived). Inside the caller's transaction, on the server's connection, which the
 * setters' sweep reads; tells nobody: the caller tells once after its commit, with `endedKeysCause(ended)`.
 */
export function holdRevealsOfEndedKeys(): { switchedOff: SwitchedOff[]; held: SwitchedOff[]; ended: EndedKey[]; seeded: number | null } {
	if (!sqlite.inTransaction) throw new Error('holdRevealsOfEndedKeys holds inside a transaction, and none is open');
	// The once-only seed first, in the same transaction (R7): a failure of either rolls both back, and no flag is written.
	const seeded = seedRevealsOnce(sqlite);
	const ended = endedKeysWithReveals(sqlite);
	if (ended.length === 0) return { switchedOff: [], held: [], ended, seeded };
	const keyIds = ended.map((key) => key.id);
	const reveals = revealsOfKeys(keyIds);
	const setters = [...new Set(ended.map((key) => key.userId).filter((id): id is number => id !== null))];
	const swept = setters.length > 0 ? switchOffLostWebhooks({ setters }, '', { told: 'by the caller' }) : [];
	const fromReveals = holdRevealedRows(sqlite, reveals);
	sqlite.prepare('DELETE FROM webhook_reveals WHERE key_id IN (SELECT value FROM json_each(?))').run(JSON.stringify(keyIds));
	// What a key set and was given, switched off as its key ended, is exposed too (FP4).
	const given = reveals.map((reveal) => reveal.webhookId);
	return { switchedOff: markExposed([...swept, ...fromReveals.switchedOff], given), held: markExposed(fromReveals.held, given), ended, seeded };
}

/** The `settings` key that says the reads before reads were recorded were seeded (card 2947, R7): the moment it ran. */
export const WEBHOOK_REVEALS_SEEDED = 'webhook_reveals_seeded';

/**
 * The SQL of the once-only seed (card 2947, decision 11, R7): every API key ever used through the API
 * (`last_used_at`, which only the v1 gate writes) counts as given the secret of every webhook with a secret, not
 * held, that its account can read now (`readableBy`) or set, made at or before the key's last use; a moment that
 * cannot be read counts (fail closed). `revealed_at` NULL marks a seeded row. Exported for the release notes'
 * preview query, which counts the same rows.
 */
export const SEED_REVEALS_SELECT =
	'SELECT w.id AS webhookId, k.id AS keyId FROM api_keys AS k JOIN users AS u ON u.id = k.user_id JOIN webhooks AS w ' +
	"ON w.secret <> '' AND (w.active = 1 OR w.held_because IS NULL) " +
	`AND (w.set_by = k.user_id OR ${readableBy('k.user_id', 'u.role', 'w.board_id')}) ` +
	'WHERE k.last_used_at IS NOT NULL ' +
	'AND (stamp_of(w.created_at) IS NULL OR stamp_of(k.last_used_at) IS NULL OR stamp_of(w.created_at) <= stamp_of(k.last_used_at))';

/**
 * Seed the reads made before they were recorded, once (card 2947, R7): while `webhook_reveals_seeded` is absent, the
 * rows of `SEED_REVEALS_SELECT` written with `revealed_at` NULL (`INSERT OR IGNORE`: a row recorded since is kept)
 * and the flag written as now. Returns how many it wrote, or null where the flag was there. Opens no transaction:
 * the sweep's, or the restore's, holds it, so a failure leaves no flag.
 */
export function seedRevealsOnce(database: typeof sqlite = sqlite): number | null {
	if (database.prepare('SELECT 1 FROM settings WHERE key = ?').get(WEBHOOK_REVEALS_SEEDED)) return null;
	registerStampFunctions(database);
	const seeded = database
		.prepare(`INSERT OR IGNORE INTO webhook_reveals (webhook_id, key_id, revealed_at) SELECT webhookId, keyId, NULL FROM (${SEED_REVEALS_SELECT})`)
		.run().changes;
	database.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(WEBHOOK_REVEALS_SEEDED, stamp());
	return seeded;
}

/**
 * How many webhooks revoking each of the account's keys would hold for what the key was given (card 2947), by key
 * id, for the Account page's key list beside `webhooksStoppedByRevoke`: those with a secret, not held, that the key
 * was given, less exactly the ids `stopped` names for that key (its code review, FP8), which the revoke's setters'
 * sweep switches off first, so the confirm says what the revoke's answer will. A key that ends by its expiry or its
 * deadline holds the same.
 */
export function webhooksRevealedTo(userId: number, stopped: ReadonlyMap<number, ReadonlySet<number>>): Map<number, number> {
	const rows = sqlite
		.prepare(
			'SELECT DISTINCT r.key_id AS keyId, w.id AS id FROM webhook_reveals AS r JOIN api_keys AS k ON k.id = r.key_id JOIN webhooks AS w ON w.id = r.webhook_id ' +
				"WHERE k.user_id = ? AND w.secret <> '' AND (w.active = 1 OR w.held_because IS NULL)"
		)
		.all(userId) as { keyId: number; id: number }[];
	const counts = new Map<number, number>();
	for (const { keyId, id } of rows) {
		if (stopped.get(keyId)?.has(id)) continue;
		counts.set(keyId, (counts.get(keyId) ?? 0) + 1);
	}
	return counts;
}

/**
 * The SQL of the webhooks an account's keys were given (card 2947, R10), `@id` the account: `revealedToAccount`'s,
 * and scripts/mfa-reset.mjs's copy word for word (its code review, FP11; tests/mfa-reset-script.test.ts compares them).
 */
export const REVEALED_TO_ACCOUNT_SQL =
	'SELECT DISTINCT r.webhook_id FROM webhook_reveals AS r JOIN api_keys AS k ON k.id = r.key_id WHERE k.user_id = @id ORDER BY r.webhook_id';

/**
 * The webhooks the account's keys were given (card 2947, R10), read before its keys are deleted, for an ending's
 * hold (`endingScope`'s `@revealed`). The once-only seed first (its code review, FP2), so that an ending never acts on
 * reads not yet recorded: one read of its flag once it has run.
 */
export function revealedToAccount(userId: number): number[] {
	seedRevealsOnce(sqlite);
	return sqlite.prepare(REVEALED_TO_ACCOUNT_SQL).pluck().all({ id: userId }) as number[];
}

/** What the Share window says of a board's webhooks (card 2329). */
export type WebhookShareNotes = {
	/**
	 * Webhooks that send nothing for a hold: switched off by one, for whatever
	 * reason (card 2752, E18), and those on and held now (`holdOf`).
	 */
	held: number;
	/** For each member, by user id: the webhooks sent now that their removal would hold. */
	byMember: Map<number, number>;
	/** For each team the board is shared with, by team id: the same. */
	byTeam: Map<number, number>;
	/** On a public board, the webhooks sent now that making it private would hold (card 2385); 0 on a private one. */
	privateStops: number;
};

/**
 * What the Share window tells a board's owner of its webhooks (card 2329),
 * from the hold rule itself: how many are held now, and how many that are
 * sent now each share's removal would hold. A setter's removal holds their
 * webhook only if no other way in is left (their own share as a member, for
 * a team's removal, another team, the board being public, having made it,
 * an administrator's role), which `roleOnBoard` reads with
 * the share left out. A board has at most 10 webhooks.
 *
 * Each setter is worked out once, however many of the webhooks they set
 * (the review): their row is read once, and of the teams the board is
 * shared with only those they are in are asked of, since taking away a team
 * they are not in leaves their way in as it is (they can open the board, or
 * the webhook would be held).
 *
 * The switch to private is asked the same way (card 2385): `roleOnBoard`
 * reads `isPublic` from the board it is handed, so the board handed in as
 * private is the board without its public way in, every other as it is.
 *
 * Since card 2752 a removal switches the webhooks it stops off for good, and
 * `held` counts those switched off by a hold too, whatever the hold (E18).
 */
export function webhookShareNotes(board: Pick<Board, 'id' | 'createdBy' | 'isPublic'>): WebhookShareNotes {
	const notes: WebhookShareNotes = { held: 0, byMember: new Map(), byTeam: new Map(), privateStops: 0 };
	const all = db.select().from(webhooks).where(eq(webhooks.boardId, board.id)).all();
	notes.held = all.filter((hook) => !hook.active && hook.heldBecause !== null).length;
	const hooks = all.filter((hook) => hook.active);
	if (hooks.length === 0) return notes;
	const sharedTeams = db.select({ teamId: boardTeams.teamId }).from(boardTeams).where(eq(boardTeams.boardId, board.id)).all();
	const add = (counts: Map<number, number>, id: number) => counts.set(id, (counts.get(id) ?? 0) + 1);
	const cache = new Map<string, boolean>();
	/** For each setter: whether their member row's removal holds their webhooks, which shared teams' do, and whether making the board private does. */
	const stopsBy = new Map<number, { member: boolean; teams: number[]; private: boolean }>();
	for (const hook of hooks) {
		if (holdOf(hook, cache) !== null) {
			notes.held++;
			continue;
		}
		// Sent, so it has a setter who can open the board.
		const setterId = hook.setBy as number;
		let stops = stopsBy.get(setterId);
		if (!stops) {
			const setter = sqlite.prepare('SELECT id, role, disabled_at AS disabledAt FROM users WHERE id = ?').get(setterId) as Actor;
			const theirTeams = new Set(
				db.select({ teamId: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.userId, setterId)).all().map((t) => t.teamId)
			);
			stops = {
				member: roleOnBoard(setter, board, { userId: setterId }) === null,
				teams: sharedTeams
					.filter(({ teamId }) => theirTeams.has(teamId) && roleOnBoard(setter, board, { teamId }) === null)
					.map(({ teamId }) => teamId),
				private: !!board.isPublic && roleOnBoard(setter, { ...board, isPublic: false }) === null
			};
			stopsBy.set(setterId, stops);
		}
		if (stops.member) add(notes.byMember, setterId);
		for (const teamId of stops.teams) add(notes.byTeam, teamId);
		if (stops.private) notes.privateStops++;
	}
	return notes;
}

/**
 * Supported webhook event types. The two `milestone.*` are a card put in a
 * goal and one taken out (card 2343), sent to the card's board.
 * `card.committed` is a card moved out of an upstream column into a committed
 * one, across the commitment point (milestone 22, card 2460).
 * `card.discarded` is an option dropped: a card archived or deleted from an
 * upstream column (milestone 22, card 2461).
 */
export type WebhookEvent =
	| 'card.created'
	| 'card.updated'
	| 'card.moved'
	| 'card.completed'
	| 'card.deleted'
	| 'comment.added'
	| 'milestone.card_added'
	| 'milestone.card_removed'
	| 'card.committed'
	| 'card.discarded';

/**
 * Every event a webhook can ask for, as the two routes that save one read
 * `events`. A new one goes at the end. A webhook with an empty list is sent
 * every event, so a new event reaches those unasked: announce it.
 */
export const WEBHOOK_EVENTS: readonly WebhookEvent[] = [
	'card.created',
	'card.updated',
	'card.moved',
	'card.completed',
	'card.deleted',
	'comment.added',
	'milestone.card_added',
	'milestone.card_removed',
	'card.committed',
	'card.discarded'
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
	unopenableSaid.clear();
}

/**
 * The webhooks whose secret was said at ERROR not to open (card 2898), by id,
 * and whose address was (card 2928), by the id negated: once each, for the life
 * of the process.
 */
const unopenableSaid = new Set<number>();

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
function placeOf(hook: Webhook, address: Opened = openedUrl(hook)): string {
	// The address as opened (card 2928): the same address sealed again (a key
	// change, the start's sweep, a restore) is the same place, and keeps its
	// result; one that does not open is hashed as stored, and matches nothing.
	// Given by a caller that opened it already (its code review, C12).
	const text = address.kind === 'opened' || address.kind === 'plain' ? address.value : hook.url;
	return createHash('sha256').update(JSON.stringify([hook.boardId, hook.createdAt, text])).digest('hex');
}

/**
 * Hold `result` as the webhook's last, unless a result of a later dispatch is
 * already held: of two deliveries in flight, the newer attempt's result stays,
 * whichever answers last. Writes nothing to the database: a write here would
 * land at a moment no request controls.
 */
function recordDelivery(hook: Webhook, dispatch: Dispatch, event: WebhookEvent, result: Result, address?: Opened): void {
	const held = results.get(hook.id);
	if (held && held.order > dispatch.order) return;
	if (dispatch.order <= forgottenUpTo) return;
	results.delete(hook.id);
	while (results.size >= RESULTS_HELD) results.delete(results.keys().next().value as number);
	results.set(hook.id, { delivery: { at: dispatch.at, event, ...result }, order: dispatch.order, place: placeOf(hook, address) });
}

/** The webhook's last result since the server started, or null: none yet, or got from another address. `address` as the caller opened it. */
export function deliveryResultFor(hook: Webhook, address?: Opened): LastDelivery | null {
	const held = results.get(hook.id);
	return held && held.place === placeOf(hook, address) ? held.delivery : null;
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
const NOT_SENT: Record<Refusal['kind'] | 'events' | Hold | 'secret' | 'address' | 'no address', string> = {
	// Card 2898 (S4): a stored secret that does not open with this server's key.
	secret: 'Not sent: its signing secret cannot be opened',
	// Card 2928: a stored address that does not open, and one a backup left out.
	address: 'Not sent: its address cannot be opened',
	'no address': 'Not sent: it has no address; set one with PUT /api/v1/webhooks/{id}',
	'not a URL': 'Not sent: the address is not an http or https address',
	scheme: 'Not sent: the address is not an http or https address',
	credentials: 'Not sent: the address carries a user name or password',
	inside: 'Not sent: the address is inside the network',
	events: 'Not sent: its events are not a list',
	// Held (card 2325).
	'setter cannot open': 'Not sent: the account that set it up can no longer open this board',
	'no setter': 'Not sent: nobody is recorded as having set it up',
	// Card 2893.
	'key ended': 'Not sent: the API key that set it up has ended'
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
	const rows = sqlite.prepare('SELECT id, board_id AS boardId, url, receiver FROM webhooks WHERE active = 1 ORDER BY id').all() as {
		id: number;
		boardId: number;
		url: string;
		receiver: string;
	}[];
	return rows.flatMap((row) => {
		// Opened (card 2928): one that does not open, or has none, is not sent either.
		const address = openedUrl(row);
		const reason =
			address.kind === 'unopenable' ? ADDRESS_UNOPENABLE : address.kind === 'empty' ? NO_ADDRESS : refusalAsWritten(address.value);
		return reason === null ? [] : [{ id: row.id, boardId: row.boardId, reason }];
	});
}

/** Why a webhook whose address does not open is not sent (card 2928), for the start's line: names nothing of it. */
const ADDRESS_UNOPENABLE = "its address cannot be opened with this server's MFA key";

/** Why a webhook with no address is not sent (card 2928): a backup left it out, and a restore could not fill it. */
const NO_ADDRESS = 'it has no address';

/**
 * Send one webhook its event, or say in the system log why it was not sent.
 *
 * Held first, before the address is judged, when its setter cannot open the
 * board, it has no setter (`holdOf`, card 2325), or the key that set it up has
 * ended (card 2893): a not-sent result, and,
 * as the backstop of the writes that switch it off (card 2752, D2), switched
 * off for good (`switchOffHeld`, the scope of one webhook). Only the delivery
 * whose write changed the row writes the WARN and mails the owners, so a
 * stale row delivered twice is switched off, said and mailed once. A write
 * that fails is an ERROR, and the delivery is still not sent (S8). Here, not
 * in the dispatch, so that anything that sends is held by it. A check that
 * throws throws before any request: in a dispatch, the webhook's own `try`
 * logs it, unsent.
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
	// Its address, opened once for the delivery (card 2928; its code review, C12), and handed to what needs it.
	const address = openedUrl(hook);
	// Once for the attempt, whatever the request does after; `after` ms from
	// now, on a timer that keeps nothing running (a newer result held meanwhile
	// stays: `recordDelivery` keeps the later dispatch's).
	let recorded = false;
	const record = (result: Result, after = 0) => {
		if (recorded) return;
		recorded = true;
		if (after <= 0) {
			recordDelivery(hook, dispatch, event, result, address);
			return;
		}
		setTimeout(() => recordDelivery(hook, dispatch, event, result, address), after).unref?.();
	};

	// Held while nobody who can open the board answers for it (card 2325), and
	// switched off for good (card 2752): not sent whatever the write does.
	const hold = holdOf(hook, holds);
	if (hold !== null) {
		record(notSentResult(hold));
		let switched = false;
		try {
			switched = switchOffHeld(hook, hold);
		} catch (err) {
			log.error(`${which} could not be switched off, and was not sent: ${(err as Error)?.message ?? err}`);
		}
		if (switched) {
			tellSwitchedOff([switchedOff(hook, hold)], 'found when an event was sent', { mail: true });
		}
		return;
	}

	// Its address (card 2928). One that does not open, or that a backup left
	// out, is not sent at all: never to anything else. Named by the webhook's
	// id alone, never by what it holds.
	if (address.kind === 'unopenable') {
		record(notSentResult('address'));
		if (!unopenableSaid.has(-hook.id)) {
			unopenableSaid.add(-hook.id);
			log.error(
				`${which} not sent: its address cannot be opened with this server's MFA key. Nothing is sent until the ` +
					"board's owner or an administrator sets its address with PUT /api/v1/webhooks/{id}."
			);
		}
		return;
	}
	if (address.kind === 'empty') {
		record(notSentResult('no address'));
		return;
	}
	const refusal = refusedAsWritten(address.value);
	if (refusal !== null) {
		notSent('refused as written', refusal.reason);
		record(notSentResult(refusal.kind));
		return;
	}
	// Its secret, opened (card 2898). One that does not open is not sent at all,
	// before the test of whether it has one (S4): never sent unsigned.
	const secret = openedSecret(hook, address);
	if (secret.kind === 'unopenable') {
		record(notSentResult('secret'));
		if (!unopenableSaid.has(hook.id)) {
			unopenableSaid.add(hook.id);
			log.error(
				`${which} not sent: its signing secret cannot be opened with this server's MFA key. Nothing is sent until the ` +
					"board's owner or an administrator sets a new secret with PUT /api/v1/webhooks/{id}."
			);
		}
		return;
	}

	const url = new URL(address.value);
	const protocol = url.protocol as 'http:' | 'https:';

	const signature = secret.value
		? createHmac('sha256', secret.value).update(body).digest('hex')
		: '';

	// Through the module object, so that a test can stand in for it.
	const request = protocol === 'https:' ? https.request : http.request;
	// The text as opened: `http.request` reads it with the same parser.
	const req = request(address.value, {
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
