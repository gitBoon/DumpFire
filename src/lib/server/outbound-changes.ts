/**
 * outbound-changes.ts — this server's record of every change of where it sends (card 3004, migration 0081): its
 * webhooks, its report schedules and the addresses on them, its backup destinations, its mail settings and its App URL,
 * and the one rule that reads it.
 *
 * A row of `outbound_changes` says that, after a change, the item of its `kind` is in its `state`. A webhook and a
 * schedule are named by their id and their creation time in the stored form; an address on a schedule by its schedule
 * and a keyed digest of the address (`place`); a destination, the mail settings and the App URL by the digest of their
 * place, as `setting_holds` names them (`placeKey`, `mailPlaceOf`, `appUrlPlaceOf`). A webhook's row carries a keyed
 * digest of its address (`address`). `origin` is `here` for a row this server's writers wrote, `seed` for one the seed
 * wrote, and `backup` for one a restore brought; `seq` is the order of writing. A restore never clears the record and
 * adds a sealed backup's rows to it; Reset Everything keeps it; no write deletes, changes or replaces a row of it.
 *
 * **Keyed digests** (R10, R11). A webhook's address and an address on a schedule are never kept as text, nor as a plain
 * SHA-256, which a short list of likely addresses would reverse: each is an HMAC-SHA256 under `MfaKey.outboundKey`, a
 * subkey of the MFA key, written `k<key id>:<64 hex>`. Where no key is loaded a writer that must digest refuses
 * (`NoKeyToDigest`, a `NoKeyToSeal`): failing closed.
 *
 * **The rule** (`outboundCeiling`, plan 3.4). An item is looked up by its kind, id, creation time and place. This
 * server's rows rank by `seq` alone: its latest `here` row sets the ceiling, closed further by any `backup` row of the
 * item dated after it with a more closed state. A `seed` row ranks below every `here` row of the item, whatever its
 * `seq` (R7): it is read only where the item has no `here` row. Where it has neither, its latest `backup` row by
 * `(changed_at, seq)` decides. States are ordered open to closed (`OUTBOUND_STATES`), so the ceiling is the most closed
 * of those it takes. Ranked by the record of access changes' own `deciding`, made generic (R5).
 *
 * **The seed** (`seedOutbound`, R7): once per database, by the server, every item as it is, `origin` `seed`, dated at
 * its moment, and one marker row, `kind` `seeded`, `origin` `here`, read only as such.
 */
import type Database from 'better-sqlite3';
import { error } from '@sveltejs/kit';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { stamp } from '$lib/timestamps';
import { reportRecipients } from '$lib/report-recipients';
import { HELD_DELETED_HERE, HELD_NOT_RECORDED, HELD_REPOINTED_HERE } from '$lib/settings-held';
import { registerStampFunctions } from './db/timestamps';
import { deciding, type DecidingReads } from './access-changes';
import { currentMfaKey, type MfaKey } from './mfa-key';
import { NoKeyToSeal, addressToBind, receiverColumn } from './stored-secrets';
import { destinationPlace, settingOf } from './backup-secrets';
import { appUrlAsRead } from './email';
import { APP_URL_SETTING, DESTINATION_SETTING, MAIL_SETTING, SETTER_ACCESS_ENDED, appUrlPlaceOf, mailPlaceOf, placeKey } from './setting-holds';

/** The table, by its name: a restore and Reset Everything keep it. */
export const OUTBOUND_RECORD = 'outbound_changes';

/** What a row is about. */
export type OutboundKind = 'webhook' | 'schedule' | 'recipient' | 'destination' | 'mail' | 'app_url' | 'seeded';
/** The kinds that name an item: every kind but the seed's marker. */
export type OutboundItemKind = Exclude<OutboundKind, 'seeded'>;

/**
 * Said, 503, to a save that would add or take off an address on a report schedule, or give a webhook an address, with
 * no MFA key loaded (card 3004's code review, NF-S4d): the record names an address only by a keyed digest, so nothing is
 * saved. Asked before the password and again before anything is written or taken from the day's report mail.
 */
export const NO_OUTBOUND_KEY =
	'No MFA key is loaded, so this server cannot record report addresses or webhook addresses right now. Nothing was saved. Ask an administrator to load the MFA key (MFA_KEY_FILE).';

/** Refused 503 `NO_OUTBOUND_KEY` where no MFA key is loaded (as `mayStartAdding` refuses `NO_MFA_KEY`). */
export function requireOutboundKey(): void {
	if (currentMfaKey() === null) error(503, NO_OUTBOUND_KEY);
}

/**
 * The states each kind's row may hold, open to closed (plan 3.2's kinds table). `held` is a hold by an ending: a
 * webhook switched off for good, and a destination, the mail settings or the App URL held for review (R13).
 */
export const OUTBOUND_STATES: Readonly<Record<OutboundKind, readonly string[]>> = {
	webhook: ['on', 'off', 'held', 'deleted'],
	schedule: ['on', 'off', 'deleted'],
	recipient: ['added', 'removed'],
	destination: ['set', 'held', 'removed'],
	mail: ['set', 'held', 'removed'],
	app_url: ['set', 'held', 'removed'],
	seeded: ['yes']
};

/** The kinds named by a place alone: item id 0, creation time ''. */
export const PLACE_KINDS: readonly OutboundItemKind[] = ['destination', 'mail', 'app_url'];

/** The rank of a state of `kind`, open to closed; a word the kind does not have ranks as its most closed (fail closed). */
export function outboundRank(kind: OutboundItemKind, state: unknown): number {
	const words = OUTBOUND_STATES[kind];
	const at = typeof state === 'string' ? words.indexOf(state) : -1;
	return at >= 0 ? at : words.length - 1;
}

/** The columns of the record this build reads and writes. */
const OUTBOUND_COLUMNS = ['seq', 'kind', 'item_id', 'item_created', 'place', 'address', 'state', 'changed_at', 'stated_changed', 'origin'] as const;

/** Whether `database` has the record, with every column this build reads: a database from before 0081 has not. */
export function hasOutboundRecord(database: Database.Database): boolean {
	const columns = database.prepare('SELECT name FROM pragma_table_info(?)').pluck().all(OUTBOUND_RECORD) as string[];
	return OUTBOUND_COLUMNS.every((c) => columns.includes(c));
}

// ─── Keyed digests (R10, R11) ───────────────────────────────────────────────

/** What a writer that must digest an address throws where no MFA key is loaded: a `NoKeyToSeal`, failing closed. */
export class NoKeyToDigest extends NoKeyToSeal {
	constructor() {
		super();
		this.message = "No MFA key is loaded, so this server's record of where it sends cannot name an address. Nothing was written.";
		this.name = 'NoKeyToDigest';
	}
}

/** A keyed digest, as a row holds it: `k`, the key's id, `:` and the HMAC's 64 hex. */
const KEYED_DIGEST = /^k([0-9a-f]{16}):[0-9a-f]{64}$/;

/** A place's digest, as `placeKey` makes it. */
export const PLACE_DIGEST = /^[0-9a-f]{64}$/;

/**
 * The keyed digest of `text` (R10, R11): HMAC-SHA256 under `key`'s outbound subkey, tagged with the key's id. A
 * webhook's address as opened, an address on a schedule as `reportRecipients` reads it. Throws `NoKeyToDigest` where
 * `key` is null.
 */
export function outboundDigest(key: MfaKey | null, text: string): string {
	if (key === null) throw new NoKeyToDigest();
	return `k${key.id}:${createHmac('sha256', key.outboundKey).update(text, 'utf8').digest('hex')}`;
}

/** Whether `value` is a keyed digest made under the key whose id is `keyId`: never where no key is loaded. */
export function keyedUnder(value: unknown, keyId: string | null): boolean {
	if (keyId === null || typeof value !== 'string') return false;
	const m = KEYED_DIGEST.exec(value);
	return m !== null && m[1] === keyId;
}

/** Whether `value` is a keyed digest made under a key other than the one whose id is `keyId` (any key where none is loaded). */
export function keyedUnderAnother(value: unknown, keyId: string | null): boolean {
	return typeof value === 'string' && KEYED_DIGEST.test(value) && !keyedUnder(value, keyId);
}

/**
 * Whether two digests are the same, compared in constant time (card 3004's code review, F6): never by `===`, so that how
 * long a comparison takes says nothing of how much of a digest a caller guessed. Texts of different lengths differ.
 */
export function sameDigest(a: string, b: string): boolean {
	const [x, y] = [Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')];
	return x.length === y.length && timingSafeEqual(x, y);
}

/** Whether `value` reads as a digest of an address at all, keyed under any key or a plain SHA-256 (R11). */
export function looksLikeDigest(value: unknown): boolean {
	return typeof value === 'string' && (KEYED_DIGEST.test(value) || PLACE_DIGEST.test(value));
}

// ─── Places ─────────────────────────────────────────────────────────────────

/** Where a server's settings that reach outside are, in the places `setting_holds` names them by (card 3009, R4). */
export type SettingPlaces = { mail: string | null; appUrl: string | null; destinations: { name: string; place: string }[] };

/**
 * Where the settings that reach outside are in `database` (card 3009, R4), as the readers that hold them ask: the
 * mail settings' place as a mail reads them (`mailConnectionAsRead`, `mailHeldAt`; none without a host), the App URL's
 * as a link reads it (`appUrlAsRead`, `appUrlHeldAt`), and each named destination's (`destinationPlace`,
 * `destinationHeldAt`). A value that is not text is read as none (R15). Moved here from restore.ts for the seed (card
 * 3004), which names the same places. Reads.
 */
export function settingPlacesIn(database: Database.Database): SettingPlaces {
	// backup-secrets' one read of a setting (card 3009's code review, FP15); a value that is not text is read as none.
	const textSettingOf = (key: string) => {
		const value = settingOf(database, key) as unknown;
		return typeof value === 'string' ? value : null;
	};
	const host = textSettingOf('smtp_host') ?? '';
	const mail =
		host === ''
			? null
			: mailPlaceOf({
					host,
					port: Number(textSettingOf('smtp_port') || '587'),
					user: textSettingOf('smtp_user') || '',
					allowInsecure: textSettingOf('smtp_allow_insecure') === 'true'
				});
	const appUrl = appUrlPlaceOf(appUrlAsRead(textSettingOf('app_url') ?? ''));
	const destinations: SettingPlaces['destinations'] = [];
	let config: unknown = null;
	try {
		config = JSON.parse(textSettingOf('backup_config') ?? 'null');
	} catch {
		// Not JSON: no destination in it.
	}
	const listed =
		config !== null && typeof config === 'object' && Array.isArray((config as { destinations?: unknown }).destinations)
			? (config as { destinations: unknown[] }).destinations
			: [];
	for (const entry of listed) {
		const name = entry !== null && typeof entry === 'object' ? (entry as { name?: unknown }).name : undefined;
		if (typeof name === 'string') destinations.push({ name, place: placeKey(destinationPlace(entry)) });
	}
	return { mail, appUrl, destinations };
}

// ─── The rule ───────────────────────────────────────────────────────────────

/** An item as the rule asks about it: its kind, its id and creation time (null where it names no moment), and its place. */
export type OutboundItem = { kind: OutboundItemKind; id: number; created: string | null; place: string };

/** The row that decides, as a reader takes it. */
export type OutboundRow = { seq: number; state: string; changedAt: string; address: string; origin: string };

const COLUMNS = 'seq, state, changed_at AS changedAt, address, origin';
const ITEM = 'kind = @kind AND item_id = @id AND item_created = @created AND place = @place';

/**
 * The reads, by name, so that tests/outbound-changes.test.ts can ask SQLite's plan of each (case (v)): each on
 * `outbound_changes_item` in `seq` order, never a sort. A read of an item's rows by their moment writes `+changed_at`
 * (card 3033's hint, R5), so that SQLite never takes `outbound_changes_changed` over the item's own index.
 */
export const OUTBOUND_READS = {
	itemHere: `SELECT ${COLUMNS} FROM outbound_changes WHERE ${ITEM} AND origin = 'here' ORDER BY seq DESC LIMIT 1`,
	itemHereAsOf: `SELECT ${COLUMNS} FROM outbound_changes WHERE ${ITEM} AND origin = 'here' AND +changed_at <= @asOf ORDER BY seq DESC LIMIT 1`,
	itemSeed: `SELECT ${COLUMNS} FROM outbound_changes WHERE ${ITEM} AND origin = 'seed' ORDER BY seq DESC LIMIT 1`,
	itemSeedAsOf: `SELECT ${COLUMNS} FROM outbound_changes WHERE ${ITEM} AND origin = 'seed' AND +changed_at <= @asOf ORDER BY seq DESC LIMIT 1`,
	itemBackupAfter: `SELECT ${COLUMNS} FROM outbound_changes WHERE ${ITEM} AND origin = 'backup' AND +changed_at > @after`,
	itemBackupLatestAt: `SELECT max(+changed_at) FROM outbound_changes WHERE ${ITEM} AND origin = 'backup'`,
	itemBackupLatest: `SELECT ${COLUMNS} FROM outbound_changes WHERE ${ITEM} AND origin = 'backup' AND +changed_at = @at ORDER BY seq DESC LIMIT 1`,
	createdOfItem: 'SELECT DISTINCT item_created FROM outbound_changes WHERE kind = @kind AND item_id = @id AND place = @place',
	// The seed's marker, read only so (R16 Q5).
	seeded: "SELECT 1 FROM outbound_changes WHERE kind = 'seeded' AND origin = 'here' LIMIT 1",
	// The start pass's one read of this server's rows dated after now (plan 3.10), on `outbound_changes_changed`; the
	// seed's marker is never one.
	futureHere: "SELECT 1 FROM outbound_changes WHERE changed_at > @asOf AND origin = 'here' AND kind <> 'seeded' LIMIT 1",
	// The start pass's one read of the items it may act on (card 3004's code review, F11): by kind and id, or by kind and
	// place for a place, every group with a row of this server's own, and whether any row of it, of any origin, holds a
	// state other than its kind's most open (a word the kind does not have included, as it ranks most closed).
	candidates:
		"SELECT kind, item_id AS id, CASE WHEN kind IN ('destination', 'mail', 'app_url') THEN place ELSE '' END AS place, " +
		"max(state <> CASE kind WHEN 'recipient' THEN 'added' WHEN 'destination' THEN 'set' WHEN 'mail' THEN 'set' WHEN 'app_url' THEN 'set' ELSE 'on' END) AS closing " +
		"FROM outbound_changes WHERE kind <> 'seeded' GROUP BY 1, 2, 3 HAVING max(origin = 'here') = 1",
	// A restored schedule's addresses taken off under a key other than this one (card 3004's code review, F1).
	recipientRemovedElsewhere:
		"SELECT 1 FROM outbound_changes WHERE kind = 'recipient' AND item_id = @id AND (@created IS NULL OR item_created IN (@created, '')) AND state = 'removed' " +
		'AND (@prefix IS NULL OR substr(place, 1, 18) <> @prefix) LIMIT 1'
} as const;

type Reads = { [K in keyof typeof OUTBOUND_READS]: Database.Statement };

/** Each connection's prepared reads, made once. */
const prepared = new WeakMap<Database.Database, Reads>();

function readsOf(database: Database.Database): Reads {
	let reads = prepared.get(database);
	if (!reads) {
		reads = Object.fromEntries(Object.entries(OUTBOUND_READS).map(([name, sql]) => [name, database.prepare(sql)])) as Reads;
		prepared.set(database, reads);
	}
	return reads;
}

/** One key the record is read by: an item with one creation time. */
type Key = { kind: OutboundItemKind; id: number; created: string; place: string };

/**
 * The record's three reads for `deciding` (R5, R7): this server's latest row is its latest `here` row by `seq`, or,
 * where it has none, its latest `seed` row, so that a seed row ranks below every `here` row whatever their `seq`.
 */
const outboundDeciding = (reads: Reads): DecidingReads<Key, OutboundRow> => ({
	hereLatest: (key, asOf) => {
		const read = (here: Database.Statement, hereAsOf: Database.Statement) =>
			(asOf === undefined ? here.get(key) : hereAsOf.get({ ...key, asOf })) as OutboundRow | undefined;
		return read(reads.itemHere, reads.itemHereAsOf) ?? read(reads.itemSeed, reads.itemSeedAsOf);
	},
	backupAfter: (key, after) => reads.itemBackupAfter.all({ ...key, after }) as OutboundRow[],
	backupLatest: (key) => {
		const at = reads.itemBackupLatestAt.pluck().get(key) as string | null;
		return at === null ? undefined : (reads.itemBackupLatest.get({ ...key, at }) as OutboundRow | undefined);
	}
});

/** The ceiling the record sets: the most closed state it lets the item hold, its rank, and the deciding row's address digest. */
export type OutboundCeiling = { state: string; rank: number; address: string };

/** The more closed of two ceilings, either of which may be none. */
function closer(a: OutboundCeiling | null, b: OutboundCeiling | null): OutboundCeiling | null {
	if (a === null) return b;
	if (b === null) return a;
	return b.rank > a.rank ? b : a;
}

/** One key's ceiling: this server's latest row (a seed's below every `here` row), closed by every later `backup` row; else the latest `backup` row. */
function keyCeiling(reads: Reads, key: Key, asOf?: string): OutboundCeiling | null {
	const found = deciding(outboundDeciding(reads), [key], asOf);
	const decided = found.here ?? found.backup;
	if (decided === undefined) return null;
	const rank = Math.max(outboundRank(key.kind, decided[0].state), ...found.later.map(([row]) => outboundRank(key.kind, row.state)));
	return { state: OUTBOUND_STATES[key.kind][rank], rank, address: decided[0].address };
}

/**
 * The most closed state the record lets `item` hold, or null where no row names it (plan 3.4, rule 2).
 *
 * - Where the item's creation time names no moment (`created` null), every row of its kind, id and place counts, the
 *   most closed taken; where it does, its rows and those of its id whose time named none (`''`), which can only close.
 * - With `asOf` (the restore's or the pass's moment), a `here` row dated after it never opens the ceiling: the more
 *   closed of the ceiling with and without such rows is taken.
 */
export function outboundCeiling(database: Database.Database, item: OutboundItem, options: { asOf?: string } = {}): OutboundCeiling | null {
	const reads = readsOf(database);
	let ceiling: OutboundCeiling | null = null;
	for (const created of createdsOf(reads, item)) {
		const key: Key = { kind: item.kind, id: item.id, created, place: item.place };
		const one = options.asOf === undefined ? keyCeiling(reads, key) : closer(keyCeiling(reads, key), keyCeiling(reads, key, options.asOf));
		ceiling = closer(ceiling, one);
	}
	return ceiling;
}

/**
 * Whether any row of this server's own (`origin` `here`, never the seed's nor a backup's) names `item`, by its creation
 * time and those that name none, or by its id alone where its own names none: what the start pass asks before it
 * closes an item (plan 3.10). Reads.
 */
export function outboundRecordedHere(database: Database.Database, item: OutboundItem): boolean {
	const reads = readsOf(database);
	return createdsOf(reads, item).some((created) => reads.itemHere.get({ kind: item.kind, id: item.id, created, place: item.place }) !== undefined);
}

/**
 * The creation times the record is read by for `item` (plan 3.4's matching), shared by every read of an item: where its
 * own names no moment, every one its kind, id and place have rows under; else its own and `''`, which can only close.
 */
function createdsOf(reads: Reads, item: OutboundItem): string[] {
	return item.created === null
		? (reads.createdOfItem.pluck().all({ kind: item.kind, id: item.id, place: item.place }) as string[])
		: [...new Set([item.created, ''])];
}

/**
 * Card 3004's code review (F1): whether the record holds an address taken off schedule `item` (by its id and creation
 * time, as `outboundCeiling` matches) under a key other than `key` (any, where none is loaded), which this server cannot
 * now name: such a schedule's addresses cannot all be compared with what was taken off it. Reads.
 */
export function recipientRemovedUnderAnotherKey(database: Database.Database, item: { id: number; created: string | null }, key: MfaKey | null): boolean {
	const prefix = key === null ? null : `k${key.id}:`;
	return readsOf(database).recipientRemovedElsewhere.get({ id: item.id, created: item.created, prefix }) !== undefined;
}

/**
 * Why a webhook's address is held `re-pointed here` (R10; card 3004's code review, F2): `differs`, it was compared and
 * is not the one this server holds or recorded; `uncompared`, it could not be compared (no MFA key loaded, this
 * server's own address does not open, or the record names it under another key) and is held failing closed.
 */
export type Repointed = 'differs' | 'uncompared';

/**
 * Whether a webhook's address is re-pointed (R10, F2), shared by the restore and the start pass (F10).
 *
 * - `address`: whether the row has one (`has`, a non-empty text) and the address as it opens with `key` (`opened`, null
 *   where it does not open). One with none, or one that does not open with a key loaded, sends nowhere: never re-pointed.
 * - `ceilingAddress`: the deciding row's address digest, `''` for none.
 * - `here`: this server's own copy of the same webhook before a restore's clear (rule 1), its address as opened (null
 *   where it does not open) and whether its identity is exact (id and creation time, both moments); null in the start
 *   pass, which reads the webhook itself.
 * - `failClosed`: a restore's (true): with no key loaded, any webhook this server held or the record names an address
 *   for is `uncompared`; under another key it is not re-pointed only where this server holds the same webhook by its
 *   exact identity at the very address restored. The start pass (false) compares only under the current key.
 *
 * The record's digest is compared in constant time (F6).
 */
export function webhookRepointed(input: {
	address: { has: boolean; opened: string | null };
	key: MfaKey | null;
	ceilingAddress: string;
	here: { address: string | null; exact: boolean } | null;
	failClosed: boolean;
}): Repointed | null {
	const { address, key, ceilingAddress, here, failClosed } = input;
	if (!address.has) return null;
	if (key === null) return failClosed && (here !== null || ceilingAddress !== '') ? 'uncompared' : null;
	if (address.opened === null) return null;
	if (here !== null) {
		if (here.address === null) return 'uncompared';
		if (here.address !== address.opened) return 'differs';
	}
	if (ceilingAddress === '') return null;
	if (keyedUnder(ceilingAddress, key.id)) return sameDigest(outboundDigest(key, address.opened), ceilingAddress) ? null : 'differs';
	if (!failClosed) return null;
	return here !== null && here.exact && here.address === address.opened ? null : 'uncompared';
}

/** Why a webhook is held by the rule, by the first that holds (plan 3.4; S2b's reason precedence). */
export type WebhookHeldWhy = 'deleted' | 'notRecorded' | Repointed | 'heldHere' | 'held';

/** The rule's verdict on one webhook: held (with its reason, its `held_at` and whether its secret goes), switched off, or neither. */
export type WebhookVerdict =
	| { held: { because: string; heldAt: string | null; why: WebhookHeldWhy; discard: boolean }; off: false }
	| { held: null; off: boolean };

/**
 * The rule's verdict on one webhook (plan 3.4), shared by the restore and the start pass (F10), by the first that holds:
 * `deleted` by the ceiling (held `deleted here`); `guess` (a sealed restore's, of one no row names that this server did
 * not hold: `not in this server's record`); `repointed` (`re-pointed here`); held here (`here.heldBecause`, its own
 * `held_at`); the ceiling's `held` (`setter access ended`). The first three discard its secret and reveals. Else switched
 * off where the ceiling says `off` or it is off here. `heldAt` null is the caller's moment.
 */
export function webhookVerdict(input: {
	ceiling: OutboundCeiling | null;
	repointed: Repointed | null;
	guess: boolean;
	here: { heldBecause: string | null; heldAt: string | null; active: boolean } | null;
}): WebhookVerdict {
	const { ceiling, repointed, guess, here } = input;
	const hold = (because: string, why: WebhookHeldWhy, discard: boolean, heldAt: string | null = null): WebhookVerdict => ({
		held: { because, heldAt, why, discard },
		off: false
	});
	if (ceiling?.state === 'deleted') return hold(HELD_DELETED_HERE, 'deleted', true);
	if (guess && ceiling === null) return hold(HELD_NOT_RECORDED, 'notRecorded', true);
	if (repointed !== null) return hold(HELD_REPOINTED_HERE, repointed, true);
	if (here !== null && here.heldBecause !== null) return hold(here.heldBecause, 'heldHere', false, here.heldAt);
	if (ceiling?.state === 'held') return hold(SETTER_ACCESS_ENDED, 'held', false);
	return { held: null, off: ceiling?.state === 'off' || (here !== null && !here.active) };
}

/**
 * The addresses of a schedule left on it (plan 3.4), shared by the restore and the start pass (F10): one not on this
 * server's own list of the same schedule (`here`, rule 1; null where there is none) comes off; with an MFA key loaded,
 * one whose keyed digest the record's latest state says `removed` (`removed`, asked by digest) comes off; never guessed.
 */
export function recipientsLeft(addresses: readonly string[], input: { key: MfaKey | null; here: readonly string[] | null; removed: (place: string) => boolean }): string[] {
	const { key, here, removed } = input;
	return addresses.filter((address) => {
		if (here !== null && !here.includes(address)) return false;
		return key === null || !removed(outboundDigest(key, address));
	});
}

/** Whether the record has been seeded: its marker row, `kind` `seeded` and `origin` `here`, read only so. */
export function outboundSeeded(database: Database.Database): boolean {
	return readsOf(database).seeded.get() !== undefined;
}

// ─── The writers ────────────────────────────────────────────────────────────

/** The columns every writer's row names; `origin` is `here` by its default. */
const RECORD_INTO = 'INSERT INTO outbound_changes (kind, item_id, item_created, place, address, state, changed_at, stated_changed) ';

/**
 * The statements that record a change of an item, by the table its id is in (card 2702's rule: each table by its name
 * in its own statement): its creation time read on the connection as `stamp_of`, `''` where it names none; nothing
 * where the item is not there. Each with its creation time's read, for `recordedAs`.
 */
const RECORD_ITEM_SQL = {
	webhook: {
		record: RECORD_INTO + "SELECT @kind, s.id, coalesce(stamp_of(s.created_at), ''), @place, @address, @state, @at, @at FROM webhooks AS s WHERE s.id = @id",
		created: "SELECT coalesce(stamp_of(created_at), '') FROM webhooks WHERE id = ?"
	},
	schedule: {
		record: RECORD_INTO + "SELECT @kind, s.id, coalesce(stamp_of(s.created_at), ''), @place, @address, @state, @at, @at FROM report_schedules AS s WHERE s.id = @id",
		created: "SELECT coalesce(stamp_of(created_at), '') FROM report_schedules WHERE id = ?"
	}
} as const;

/** The one statement that records a change of a place. */
const RECORD_PLACE_SQL = RECORD_INTO + "VALUES (@kind, 0, '', @place, '', @state, @at, @at)";

/** Each connection's prepared writes and reads of the writers, by their text, made once (as `readsOf`). */
const preparedWrites = new WeakMap<Database.Database, Map<string, Database.Statement>>();

/** `sql` prepared on `database`, once. A statement naming `stamp_of` needs `registerStampFunctions` first. */
function statementOf(database: Database.Database, sql: string): Database.Statement {
	let statements = preparedWrites.get(database);
	if (!statements) {
		statements = new Map();
		preparedWrites.set(database, statements);
	}
	let statement = statements.get(sql);
	if (!statement) {
		statement = database.prepare(sql);
		statements.set(sql, statement);
	}
	return statement;
}

/**
 * A change as a writer records it. A webhook's `address` is its address as opened (none, null or '', for one with
 * none); an address on a schedule as the list holds it. Each is digested here, never stored.
 */
export type OutboundChange =
	| { kind: 'webhook'; id: number; state: string; address?: string | null }
	| { kind: 'schedule'; id: number; state: string }
	| { kind: 'recipient'; schedule: number; address: string; state: string }
	| { kind: 'destination' | 'mail' | 'app_url'; place: string; state: string };

/**
 * Record one change of where this server sends (plan section 5), in the transaction of the change, on `database`:
 * one row, `changed_at` and `stated_changed` now in the stored form, `origin` `here`. Throws, writing nothing, where no
 * transaction is open (a change recorded apart from its write could be kept without it), for a state its kind does not
 * have, for a place that is not a digest, and (`NoKeyToDigest`) for an address with no MFA key loaded. Returns whether a
 * row was written: none for a webhook or schedule that is not there.
 */
export function recordOutboundChange(database: Database.Database, change: OutboundChange, key: MfaKey | null = currentMfaKey()): boolean {
	if (!database.inTransaction) {
		throw new Error('recordOutboundChange records inside the transaction of the change, and none is open on the connection it was given');
	}
	if (!OUTBOUND_STATES[change.kind].includes(change.state)) throw new Error(`A ${change.kind} is never recorded as ${JSON.stringify(change.state)}`);
	const at = stamp();
	if (change.kind === 'destination' || change.kind === 'mail' || change.kind === 'app_url') {
		if (!PLACE_DIGEST.test(change.place)) throw new Error(`A ${change.kind} is recorded by the digest of its place`);
		return statementOf(database, RECORD_PLACE_SQL).run({ kind: change.kind, place: change.place, state: change.state, at }).changes > 0;
	}
	registerStampFunctions(database);
	let params: { id: number; place: string; address: string };
	if (change.kind === 'webhook') params = { id: change.id, place: '', address: change.address ? outboundDigest(key, change.address) : '' };
	else if (change.kind === 'schedule') params = { id: change.id, place: '', address: '' };
	else {
		const recipient = change as Extract<OutboundChange, { kind: 'recipient' }>;
		params = { id: recipient.schedule, place: outboundDigest(key, recipient.address), address: '' };
	}
	return statementOf(database, RECORD_ITEM_SQL[change.kind === 'webhook' ? 'webhook' : 'schedule'].record).run({ kind: change.kind, state: change.state, at, ...params }).changes > 0;
}

/**
 * Whether this server's latest row of the item `change` names (its latest `here` row, else its latest `seed` row: R7)
 * says exactly `change`'s state and, for a webhook, the keyed digest of its address (3002-R12), compared in constant
 * time (F6). Asked only of a change whose address is the one the item had: with no MFA key loaded, a webhook's address
 * is taken as the record has it and only its state is compared (card 3004's code review, F5), so that a change of its
 * events alone needs no digest. True for a webhook or a schedule that is not there, of which nothing would be written.
 * Reads.
 */
function recordedAs(database: Database.Database, change: OutboundChange, key: MfaKey | null): boolean {
	let item: Key;
	let address: string | null = '';
	if (change.kind === 'destination' || change.kind === 'mail' || change.kind === 'app_url') {
		item = { kind: change.kind, id: 0, created: '', place: change.place };
	} else {
		registerStampFunctions(database);
		const named = change as Exclude<OutboundChange, { kind: PlaceKind }>;
		const id = named.kind === 'recipient' ? named.schedule : named.id;
		const created = statementOf(database, RECORD_ITEM_SQL[named.kind === 'webhook' ? 'webhook' : 'schedule'].created).pluck().get(id) as string | undefined;
		if (created === undefined) return true;
		item = { kind: named.kind, id, created, place: named.kind === 'recipient' ? outboundDigest(key, named.address) : '' };
		if (named.kind === 'webhook') address = key === null ? null : named.address ? outboundDigest(key, named.address) : '';
	}
	const reads = readsOf(database);
	const latest = (reads.itemHere.get(item) ?? reads.itemSeed.get(item)) as OutboundRow | undefined;
	return latest !== undefined && latest.state === change.state && (address === null || sameDigest(latest.address, address));
}

/**
 * Record `change` (as `recordOutboundChange`) unless nothing changed (3002-R12): where `before`, the item as the
 * writer read it before its write (null where it was not there), has the same state and, for a webhook, the same
 * address, and this server's latest row of it says the same. A write that leaves an item as it was but not as the
 * record says it is (switched off by a host edit, say, and then written off) records it. Throws where no transaction
 * is open. Returns whether a row was written.
 */
export function recordOutboundState(
	database: Database.Database,
	change: OutboundChange,
	before: { state: string; address?: string | null } | null,
	key: MfaKey | null = currentMfaKey()
): boolean {
	if (!database.inTransaction) {
		throw new Error('recordOutboundState records inside the transaction of the change, and none is open on the connection it was given');
	}
	const sameAddress = before !== null && (change.kind !== 'webhook' || (before.address || '') === (change.address || ''));
	const same = sameAddress && before.state === change.state;
	if (same && recordedAs(database, change, key)) return false;
	// A webhook's address unchanged, with no MFA key loaded (F5): recorded with the digest this server's latest row has,
	// as the batch writers record, so that a switch-off alone needs no key.
	if (change.kind === 'webhook' && sameAddress && key === null) {
		return recordBatch(database, webhooksRecordedAs(change.state as WebhookState), { ids: JSON.stringify([change.id]) }) > 0;
	}
	return recordOutboundChange(database, change, key);
}

// ─── The batch writers' statements (R8) ─────────────────────────────────────

/** A state a webhook's row may hold. */
type WebhookState = 'on' | 'off' | 'held' | 'deleted';

/**
 * A webhook's row as the batch writers name it, with the keyed digest of its address carried from this server's latest
 * row of it (its latest `here` row, else its latest `seed` row), so that no key is needed to write it: `''` where none.
 */
const webhooksRecordedAs = (state: WebhookState) =>
	RECORD_INTO +
	`SELECT 'webhook', w.id, coalesce(stamp_of(w.created_at), ''), '', ` +
	"coalesce((SELECT o.address FROM outbound_changes AS o WHERE o.kind = 'webhook' AND o.item_id = w.id " +
	"AND o.item_created = coalesce(stamp_of(w.created_at), '') AND o.place = '' AND o.origin IN ('here', 'seed') " +
	"ORDER BY o.origin = 'here' DESC, o.seq DESC LIMIT 1), ''), " +
	`'${state}', @at, @at FROM webhooks AS w WHERE w.id IN (SELECT value FROM json_each(@ids)) ORDER BY w.id`;

/** A schedule's row as the batch writers name it. */
const schedulesRecordedAs = (state: 'off' | 'deleted') =>
	RECORD_INTO +
	`SELECT 'schedule', s.id, coalesce(stamp_of(s.created_at), ''), '', '', '${state}', @at, @at ` +
	'FROM report_schedules AS s WHERE s.id IN (SELECT value FROM json_each(@ids)) ORDER BY s.id';

/**
 * O5 and O17 (R8): each webhook of `@ids` recorded `held`, for `@at`, by an ending of an account's access. Run whether
 * or not an id is given, so that a pinned write sequence is fixed. scripts/mfa-reset.mjs holds it word for word.
 */
export const RECORD_WEBHOOKS_HELD_SQL = webhooksRecordedAs('held');

/** O4 and O6: each webhook of `@ids` recorded `deleted`, before its delete, while it can be read. */
export const RECORD_WEBHOOKS_DELETED_SQL = webhooksRecordedAs('deleted');

/**
 * O10 and O17 (R8): each schedule of `@ids` recorded `off`, paused by an ending of its account's access. Run whether or
 * not an id is given. scripts/mfa-reset.mjs holds it word for word.
 */
export const RECORD_SCHEDULES_OFF_SQL = schedulesRecordedAs('off');

/** O6 and O18: each schedule of `@ids` recorded `deleted`, before its delete, its board's or its account's. */
export const RECORD_SCHEDULES_DELETED_SQL = schedulesRecordedAs('deleted');

/**
 * O16 and O17 (R13, R8): each place the setter rows of account `@id` name recorded `held`, once per kind and place, as
 * `HOLD_SETTINGS_SET_BY_SQL` holds them: the mail settings, the App URL and each destination. scripts/mfa-reset.mjs
 * holds it word for word.
 */
export const RECORD_SETTINGS_HELD_SQL =
	RECORD_INTO +
	"SELECT DISTINCT CASE WHEN setting = 'mail' THEN 'mail' WHEN setting = 'app_url' THEN 'app_url' ELSE 'destination' END AS kind, " +
	"0, '', place, '', 'held', @at, @at FROM setting_setters " +
	"WHERE user_id = @id AND (setting IN ('mail', 'app_url') OR substr(setting, 1, 19) = 'backup_destination:') ORDER BY kind, place";

/** Run one batch statement in the caller's transaction, now; throws where none is open. Returns the rows written. */
function recordBatch(database: Database.Database, sql: string, params: Record<string, unknown>): number {
	if (!database.inTransaction) throw new Error('The record of where this server sends is written inside the transaction of the change, and none is open');
	registerStampFunctions(database);
	// Prepared at each call, not cached: the pinned write sequences of the accounts' and deletes' writers read each
	// statement as it is prepared.
	return database.prepare(sql).run({ at: stamp(), ...params }).changes;
}

/** O4, O5, O6: each webhook of `ids` recorded `held` or `deleted`, in one statement that always runs. */
export function recordWebhooksAs(database: Database.Database, ids: readonly number[], state: 'held' | 'deleted'): number {
	return recordBatch(database, state === 'held' ? RECORD_WEBHOOKS_HELD_SQL : RECORD_WEBHOOKS_DELETED_SQL, { ids: JSON.stringify(ids) });
}

/** O6, O10, O18: each schedule of `ids` recorded `off` or `deleted`, in one statement that always runs. */
export function recordSchedulesAs(database: Database.Database, ids: readonly number[], state: 'off' | 'deleted'): number {
	return recordBatch(database, state === 'off' ? RECORD_SCHEDULES_OFF_SQL : RECORD_SCHEDULES_DELETED_SQL, { ids: JSON.stringify(ids) });
}

/** O16 (R13): each place account `userId`'s setter rows name recorded `held`, in one statement. */
export function recordSettingsHeldBy(database: Database.Database, userId: number): number {
	return recordBatch(database, RECORD_SETTINGS_HELD_SQL, { id: userId });
}

// ─── The writers of settings and schedules ──────────────────────────────────

/** The kinds of place a save or a removal of settings moves. */
export type PlaceKind = 'destination' | 'mail' | 'app_url';

/** The places of `kind` in `places`, as `settingPlacesIn` read them. */
function placesOf(places: SettingPlaces, kind: PlaceKind): Set<string> {
	if (kind === 'destination') return new Set(places.destinations.map((d) => d.place));
	const place = kind === 'mail' ? places.mail : places.appUrl;
	return new Set(place === null ? [] : [place]);
}

/**
 * O11 to O14: after a write of settings, each place of `kinds` the write moved recorded, `before` and `after` read by
 * `settingPlacesIn` on either side of it: one gone `removed`, one new `set`. A place on both sides writes nothing (a
 * From address alone, a destination renamed, a schedule's time), nor one that was never there. In the caller's
 * transaction. Returns the rows written.
 */
export function recordPlacesMoved(database: Database.Database, before: SettingPlaces, after: SettingPlaces, kinds: readonly PlaceKind[]): number {
	if (!database.inTransaction) throw new Error('recordPlacesMoved records inside the transaction of the change, and none is open');
	let written = 0;
	for (const kind of kinds) {
		const [was, now] = [placesOf(before, kind), placesOf(after, kind)];
		for (const place of was) if (!now.has(place) && recordOutboundChange(database, { kind, place, state: 'removed' })) written++;
		for (const place of now) if (!was.has(place) && recordOutboundChange(database, { kind, place, state: 'set' })) written++;
	}
	return written;
}

/** A schedule as its writers read and write it: its id, whether it is on, and its addresses as stored. */
export type ScheduleWritten = { id: number; enabled: unknown; recipients: unknown };

/** The addresses on a schedule, as `reportRecipients` reads them; none where the list is not text. */
const addressesOn = (recipients: unknown) => (typeof recipients === 'string' ? reportRecipients(recipients).addresses : []);

/**
 * O7, O8: a schedule written, `before` as the writer read it (null for one just made) and `after` as written. Its state
 * recorded `on` or `off` (`recordOutboundState`, 3002-R12), and each address on one side and not the other `added` or
 * `removed`. In the caller's transaction. Throws `NoKeyToDigest` where an address changed and no MFA key is loaded.
 */
export function recordScheduleWritten(database: Database.Database, before: ScheduleWritten | null, after: ScheduleWritten): void {
	const state = (row: ScheduleWritten) => (row.enabled === true || row.enabled === 1 ? 'on' : 'off');
	recordOutboundState(database, { kind: 'schedule', id: after.id, state: state(after) }, before === null ? null : { state: state(before) });
	const [was, now] = [addressesOn(before?.recipients), addressesOn(after.recipients)];
	for (const address of was) if (!now.includes(address)) recordOutboundChange(database, { kind: 'recipient', schedule: after.id, address, state: 'removed' });
	for (const address of now) if (!was.includes(address)) recordOutboundChange(database, { kind: 'recipient', schedule: after.id, address, state: 'added' });
}

/** The state a webhook's row is recorded in, from the row: `held` where it is held, else `on` or `off`. */
export function webhookStateOf(row: { active: unknown; heldBecause: unknown }): 'on' | 'off' | 'held' {
	if (row.heldBecause !== null && row.heldBecause !== undefined) return 'held';
	return row.active === true || row.active === 1 ? 'on' : 'off';
}

// ─── The seed (R7) ──────────────────────────────────────────────────────────

/** A row of the seed: `origin` `seed`, dated at the seed's moment. */
const SEED_ROW_SQL =
	'INSERT INTO outbound_changes (kind, item_id, item_created, place, address, state, changed_at, stated_changed, origin) ' +
	"VALUES (@kind, @id, @created, @place, @address, @state, @at, @at, 'seed')";

/** The seed's marker: the one INSERT of `seeded` there is (R16 Q5), `origin` `here`. */
const SEED_MARKER_SQL =
	'INSERT INTO outbound_changes (kind, item_id, item_created, place, address, state, changed_at, stated_changed, origin) ' +
	"VALUES ('seeded', 0, '', '', '', 'yes', @at, @at, 'here')";

/**
 * Seed the record once (plan 3.3, R7): every item as it is now, `origin` `seed`, dated `at`, then the marker. In the
 * caller's transaction where one is open, else in one of its own:
 *
 * - every webhook whose creation time reads: `held` where `held_because` is set, else `on` or `off` by `active`, with
 *   the keyed digest of its address as opened (`''` where it has none or it does not open with `key`);
 * - every schedule whose creation time reads, `on` or `off` by `enabled`, and each address on it, `added`;
 * - each destination's, the mail settings' and the App URL's place (`settingPlacesIn`), `held` where `setting_holds`
 *   holds that place, else `set`.
 *
 * Nothing where the database has no record or is seeded already. Where `key` is null, seeded only where no webhook and
 * no schedule has an address (F14: the rows that need no digest, and the marker); else throws `NoKeyToDigest`, writing
 * nothing, and the next start seeds once a key is loaded. Returns whether it seeded and how many item rows it wrote.
 */
export function seedOutbound(database: Database.Database, key: MfaKey | null = currentMfaKey(), at: string = stamp()): { seeded: boolean; rows: number } {
	if (!hasOutboundRecord(database) || outboundSeeded(database)) return { seeded: false, rows: 0 };
	// With no MFA key, seeded only where no address would need a digest (card 3004's code review, F14): no webhook with
	// an address and no schedule with one; else refused, and the next start seeds once a key is loaded.
	if (key === null && needsDigestToSeed(database)) throw new NoKeyToDigest();
	registerStampFunctions(database);
	const seed = () => {
		const put = database.prepare(SEED_ROW_SQL);
		let rows = 0;
		const write = (row: { kind: OutboundItemKind; id?: number; created?: string; place?: string; address?: string; state: string }) => {
			rows += put.run({ id: 0, created: '', place: '', address: '', ...row, at }).changes;
		};
		// The record is 0081's, so the tables it reads (0005, 0004, 0074) are there.
		const hooks = database
			.prepare(
				`SELECT id, board_id AS boardId, url, ${receiverColumn(database)} AS receiver, active, held_because AS heldBecause, stamp_of(created_at) AS created FROM webhooks ORDER BY id`
			)
			.all() as { id: number; boardId: number; url: string; receiver: string; active: unknown; heldBecause: unknown; created: string | null }[];
		for (const hook of hooks) {
			if (hook.created === null) continue;
			const opened = key !== null && typeof hook.url === 'string' ? addressToBind(hook, [key]) : null;
			const state = hook.heldBecause !== null ? 'held' : hook.active === 1 ? 'on' : 'off';
			write({ kind: 'webhook', id: hook.id, created: hook.created, address: opened === null ? '' : outboundDigest(key, opened), state });
		}
		const schedules = database.prepare('SELECT id, enabled, recipients, stamp_of(created_at) AS created FROM report_schedules ORDER BY id').all() as {
			id: number;
			enabled: unknown;
			recipients: unknown;
			created: string | null;
		}[];
		for (const schedule of schedules) {
			if (schedule.created === null) continue;
			write({ kind: 'schedule', id: schedule.id, created: schedule.created, state: schedule.enabled === 1 ? 'on' : 'off' });
			const addresses = typeof schedule.recipients === 'string' ? reportRecipients(schedule.recipients).addresses : [];
			for (const address of addresses) write({ kind: 'recipient', id: schedule.id, created: schedule.created, place: outboundDigest(key, address), state: 'added' });
		}
		const holds = database.prepare('SELECT 1 FROM setting_holds WHERE setting = ? AND place = ? LIMIT 1');
		const stateOf = (setting: string, place: string) => (holds.get(setting, place) !== undefined ? 'held' : 'set');
		const places = settingPlacesIn(database);
		for (const { name, place } of places.destinations) write({ kind: 'destination', place, state: stateOf(DESTINATION_SETTING + name, place) });
		if (places.mail !== null) write({ kind: 'mail', place: places.mail, state: stateOf(MAIL_SETTING, places.mail) });
		if (places.appUrl !== null) write({ kind: 'app_url', place: places.appUrl, state: stateOf(APP_URL_SETTING, places.appUrl) });
		database.prepare(SEED_MARKER_SQL).run({ at });
		return { seeded: true, rows };
	};
	// Inside the caller's transaction where one is open (a restore's, the start pass's): a failure rolls back with it.
	return database.inTransaction ? seed() : database.transaction(seed)();
}

/** Whether seeding `database` would digest an address: a webhook with one, or a schedule with one on it (F14). Reads. */
function needsDigestToSeed(database: Database.Database): boolean {
	if (database.prepare("SELECT 1 FROM webhooks WHERE typeof(url) <> 'text' OR url <> '' LIMIT 1").get() !== undefined) return true;
	const lists = database.prepare('SELECT recipients FROM report_schedules').pluck().all() as unknown[];
	return lists.some((recipients) => typeof recipients === 'string' && reportRecipients(recipients).addresses.length > 0);
}
