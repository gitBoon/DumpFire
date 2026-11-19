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
import { keyEnded } from './auth';
import { canViewBoard, getBoardRole, roleOnBoard, type Actor } from './board-access';
import { notifyWebhooksSwitchedOff } from './notifications';
import { onTheWire } from './v1-json';
import { addressRefusal, guardedLookup } from './webhook-address';
import { stamp } from '$lib/timestamps';

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
 */
export function presentWebhook(hook: Webhook, reveal: boolean) {
	const { secret, url, events, setBy: _setBy, heldBecause: _heldBecause, heldAt: _heldAt, setByKey: _setByKey, setWithKey: _setWithKey, ...rest } = hook;
	return {
		...rest,
		events: JSON.parse(events || '[]') as string[],
		hasSecret: secret !== '',
		...(reveal ? { url, secret, lastDelivery: deliveryResultFor(hook), pausedBecause: pausedBecause(hook) } : {})
	};
}

// ─── Held while the setter cannot open the board (card 2325) ──────────────

/** Why a webhook is held, or null to send it (card 2325; `'key ended'`, card 2893). */
export type Hold = 'no setter' | 'setter cannot open' | 'key ended';

/** An API key as the hold rule reads it: which, whose it is, and when it ends. */
type KeyRow = { id: number; userId: number; expiresAt: string | null; deadlineAt: string | null };

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
 *     it has ended (`keyEnded`, the gate's rule: its expiry or its deadline),
 *     or it is not the setter's (S12)
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
				.prepare('SELECT user_id AS userId, expires_at AS expiresAt, deadline_at AS deadlineAt FROM api_keys WHERE id = ?')
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
			`SELECT id, user_id AS userId, expires_at AS expiresAt, deadline_at AS deadlineAt FROM api_keys
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
 * Account page's key list, which says it before the revoke.
 */
export function webhooksStoppedByRevoke(userId: number): Map<number, number> {
	const counts = new Map<number, number>();
	const recorded = sqlite
		.prepare('SELECT set_by_key AS keyId, COUNT(*) AS n FROM webhooks WHERE active = 1 AND set_by_key IS NOT NULL AND set_by = ? GROUP BY set_by_key')
		.all(userId) as { keyId: number; n: number }[];
	for (const { keyId, n } of recorded) counts.set(keyId, n);
	const now = stamp();
	const live = keysBeforeRecorded(userId).filter((key) => !keyEnded(key, now));
	if (live.length === 1) {
		const cache = new Map<string, boolean>();
		const before = db
			.select()
			.from(webhooks)
			.where(and(eq(webhooks.active, true), eq(webhooks.setBy, userId), isNull(webhooks.setWithKey)))
			.all()
			.filter((hook) => holdOf(hook, cache) === null).length;
		if (before > 0) counts.set(live[0].id, (counts.get(live[0].id) ?? 0) + before);
	}
	return counts;
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
export type HeldBecause = Hold | 'setter access ended';

/**
 * The reasons whose switch-on gives the webhook a new secret: a known account held the old one (D3, S4; CS4).
 * Every reason since card 2923's code review (S1): one held for want of a setter may have had its secret set,
 * by a `PUT`, by an account whose access has ended since, which its hold does not record.
 */
export const NEW_SECRET_REASONS: readonly string[] = ['setter cannot open', 'no setter', 'setter access ended', 'key ended'];

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
	'setter access ended':
		'This was switched off because the account that set it up had its password or its two-step sign-in reset, ended its API keys ' +
		'when changing its own password, used an invite, was disabled, or was deleted; one already switched off then, or found ' +
		'switched off with its setter disabled or not recorded, is held the same way. The address ' +
		'was chosen by that account: delete the webhook unless you recognise it; to keep it, switch it on with your own key, which ' +
		"makes you its setter and gives it a new secret, given in that answer and readable by the board's owner or an administrator, " +
		'and update the receiver.',
	'key ended':
		"This was switched off because the API key that set it up ended: it expired, passed its deadline, was deleted or is not the setter's; " +
		'or, for a webhook set up before keys were recorded, the account that set it up has no working key from then. To keep it, ' +
		'switch it on with your own key, which makes you its setter and gives it a new secret, given in that answer and readable by ' +
		"the board's owner or an administrator, and update the receiver."
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

/** The host of a webhook's address, for a mail: never the path, the query or anything before the host. */
export function hostOf(address: string): string {
	try {
		return new URL(address).host || 'an address with no host';
	} catch {
		return 'an address that is not a URL';
	}
}

/**
 * The receiver an address sends to, as the create's refusal compares it (the
 * code review's CS2): its origin, the scheme, the host (in lower case, a name
 * in punycode) and the port, a default port dropped, as `URL` reads it. Null
 * for an address that is not an http or https URL. Another path, a query, a
 * fragment, the case of the host or `:443` written out reach the same receiver.
 */
export function receiverOf(address: string): string | null {
	try {
		const url = new URL(address);
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
	} catch {
		return null;
	}
}

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
	url: string;
	hold: HeldBecause;
	/** Held by a pass that found it off with no hold (`holdUnheldOfGoneSetters`), not by an ending of its setter's access. */
	found?: boolean;
};

/** A webhook row and its hold, as `SwitchedOff` names them. */
function switchedOff(hook: Webhook, hold: Hold): SwitchedOff {
	return { id: hook.id, boardId: hook.boardId, setBy: hook.setBy, setByKey: hook.setByKey, setWithKey: hook.setWithKey, url: hook.url, hold };
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
	options: { telling?: Telling; told?: 'after commit' | 'by the caller' } = {}
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
		afterCommit(() => tellSwitchedOff(done, cause, telling));
	}
	return done;
}

/**
 * Why, in a WARN line: the hold in words, with the setter's id, and for a key
 * that ended the key's id (card 2893, 4.3), never its prefix or its hash. A
 * key deleted, or a credential that was not a key, leaves no id to name.
 */
const HOLD_IN_WORDS: Record<HeldBecause, (hook: SwitchedOff) => string> = {
	'setter cannot open': (hook) => `the account that set it up (user ${hook.setBy}) can no longer open the board`,
	'no setter': () => 'nobody is recorded as having set it up',
	// Card 2923: ending an account's access, the start-up pass and a restore; `set_by` NULL for one found with no setter.
	'setter access ended': (hook) =>
		hook.setBy === null
			? 'nobody is recorded as having set it up'
			: hook.found
				? `it was found switched off with no hold, as it may have been when the access of the account that set it up (user ${hook.setBy}) ended`
				: `the account that set it up (user ${hook.setBy}) had its access ended`,
	'key ended': (hook) =>
		hook.setWithKey === null
			? `the account that set it up (user ${hook.setBy}) has no working API key from before keys were recorded`
			: `the API key that set it up (${hook.setByKey === null ? 'no key recorded' : `key ${hook.setByKey}`}, user ${hook.setBy}) has ended`
};

/** Why, in the owners' mail: the hold in words, naming nobody. */
const HOLD_IN_MAIL: Record<HeldBecause, (hook: SwitchedOff) => string> = {
	'setter cannot open': () => 'the account that set it up can no longer open the board',
	'no setter': () => 'nobody is recorded as having set it up',
	'setter access ended': (hook) =>
		hook.setBy === null
			? 'nobody is recorded as having set it up'
			: hook.found
				? 'it was found switched off with no hold, as it may have been when the access of the account that set it up ended'
				: 'the account that set it up had its access ended',
	'key ended': (hook) =>
		hook.setWithKey === null
			? 'it was set up before keys were recorded, and the account that set it up has no working API key from then'
			: 'the API key that set it up ended'
};

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
	mailCause: string = cause
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
				host: hostOf(hook.url),
				why: HOLD_IN_MAIL[hook.hold](hook),
				...(hook.hold === 'key ended' && hook.setBy !== null ? { setter: hook.setBy } : {})
			})),
			mailCause,
			// Never a setter's mail for a held one (S1).
			held.map((hook) => ({ boardId: hook.boardId, id: hook.id, host: hostOf(hook.url), why: HOLD_IN_MAIL[hook.hold](hook) }))
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
type HeldRow = { id: number; boardId: number; url: string; setBy: number | null; setByKey: number | null; setWithKey: number | null };

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
export type EndingCause = { log: string; mail: string };

/** The owners' mail's words for each ending of an account's access (card 2923's code review, S5): its kind, naming nobody. */
export const ENDING_IN_MAIL = {
	ownChange: 'the account that set it up ended its own API keys when changing its password',
	passwordReset: 'the account that set it up had its password reset by an administrator',
	invite: 'the account that set it up set its password with an invite',
	twoStepReset: 'the account that set it up had its two-step sign-in reset by an administrator',
	disabled: 'the account that set it up was disabled by an administrator',
	deleted: 'the account that set it up was deleted by an administrator'
} as const;

/**
 * Switch off, for good, every webhook `userId` set that is on, and hold every
 * one it set that was already switched off without a hold (card 2923), both
 * as `'setter access ended'`, `active` off, `held_at` now: one statement,
 * after a read of those already off so the two are told apart. One held for
 * another reason keeps it. Inside the caller's transaction (it throws outside
 * one); once committed, both groups are told with `cause` (`tellSwitchedOff`:
 * a WARN each, and one mail to each owner of their boards). The one writer
 * for an ending of an account's access on the server (card 2923's code
 * review, E4): `endAccountAccess` and `deleteUser` call it; the host's
 * scripts/mfa-reset.mjs keeps a copy in its own SQL.
 */
export function holdWebhooksOfSetter(userId: number, cause: EndingCause): { switchedOff: SwitchedOff[]; held: SwitchedOff[] } {
	if (!sqlite.inTransaction) throw new Error('holdWebhooksOfSetter holds inside the transaction that ends the access, and none is open');
	const alreadyOff = new Set(
		sqlite.prepare('SELECT id FROM webhooks WHERE set_by = ? AND active = 0 AND held_because IS NULL').pluck().all(userId) as number[]
	);
	const rows = sqlite
		.prepare(
			"UPDATE webhooks SET active = 0, held_because = 'setter access ended', held_at = ? WHERE set_by = ? AND (active = 1 OR held_because IS NULL) " +
				'RETURNING id, board_id AS boardId, url, set_by AS setBy, set_by_key AS setByKey, set_with_key AS setWithKey'
		)
		.all(stamp(), userId) as HeldRow[];
	const switchedOff: SwitchedOff[] = [];
	const held: SwitchedOff[] = [];
	for (const hook of heldAsSwitchedOff(rows, false)) (alreadyOff.has(hook.id) ? held : switchedOff).push(hook);
	if (rows.length > 0) afterCommit(() => tellSwitchedOff(switchedOff, cause.log, { mail: true }, held, cause.mail));
	return { switchedOff, held };
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
				'RETURNING id, board_id AS boardId, url, set_by AS setBy, set_by_key AS setByKey, set_with_key AS setWithKey'
		)
		.all(stamp(), every ? 1 : 0) as HeldRow[];
	return heldAsSwitchedOff(rows, true);
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
