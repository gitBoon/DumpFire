/**
 * access-changes.ts — this server's record of every change of who may open a board, who is in a team and which account
 * a person is linked to (card 3002, migration 0079), and the one rule that reads it.
 *
 * A row of `access_changes` says that, after a change, the item of its `kind` gives its `access`. What is opened, the
 * subject, is a board, a team or a person by its id and its creation time in the stored form; who gets it, the holder,
 * is an account, or a team for a share, the same way, or 0 with '' for none. `origin` is `here` for a row this server
 * wrote and `backup` for one a restore brought; `seq` is the order of writing. The record is this server's, as the
 * record of account endings is: a restore never clears it and adds a sealed backup's rows to it, Reset Everything keeps
 * it, and no write deletes, changes or replaces a row of it.
 *
 * **The rule** (`accessCeiling`, plan 3.3). An item is looked up by its kind, subject and holder, each creation time read
 * once as `toStamp`. This server's rows rank by `seq` alone (R1): its latest `here` row sets the ceiling, lowered further
 * by any `backup` row of the item dated after that row's `changed_at` with a lower word: a backup can add a narrowing and
 * never lift one. Where the item has no `here` row, its latest `backup` row by `(changed_at, seq)` does. A team's
 * `deleted` row is a `none` row, at its own place, for each of the team's members and shares (R2). No read takes every
 * row of an item to find its latest (R11): each is an indexed read in `seq` order, or a `max` and one row.
 *
 * - An ordinal kind (a member, a share, a team member, a board's visibility) is capped at the ceiling's word. A restored
 *   creation time that names no moment matches by id alone: every row of that id counts, and more rows can only lower.
 * - An identity kind (a board's creator, its Product Owner, a person's link) keeps its value only where the latest
 *   counted row names that holder by id and creation time; a creation time that names no moment never matches (R8).
 * - The guess, at a restore only (`guess`): an item with no row, on a tracked subject, is `none`, unless this server held
 *   it before the restore's clear (`heldBefore`, R4). The start pass never guesses (R2).
 *
 * **The writers** (slice 3, plan section 5) call `recordAccessChange` in the transaction of each change, after it.
 *
 * This module imports only the database's types, the stored form of a moment and the two SQL functions that read one:
 * the restore, the start pass and the writers all read it.
 */
import type Database from 'better-sqlite3';
import { isStamp, stamp, toStamp } from '$lib/timestamps';
import { registerStampFunctions } from './db/timestamps';

/** The table, by its name: a restore and Reset Everything keep it. */
export const ACCESS_RECORD = 'access_changes';

/** What a row is about. */
export const ACCESS_KIND = {
	board: 'board',
	boardPublic: 'board_public',
	productOwner: 'product_owner',
	boardMember: 'board_member',
	boardTeam: 'board_team',
	team: 'team',
	teamMember: 'team_member',
	personLink: 'person_link'
} as const;
export type AccessKind = (typeof ACCESS_KIND)[keyof typeof ACCESS_KIND];

/** Who wrote a row: this server, or a restore that brought it from a sealed backup. */
export const ACCESS_ORIGIN = { here: 'here', backup: 'backup' } as const;

/**
 * The words each kind's `access` may hold, low to high for the ordinal kinds (plan 3.2's kinds table). Index 0 is
 * `none` for every kind a restore can cap but the board's visibility, whose lowest is `private`.
 */
export const ACCESS_WORDS: Readonly<Record<AccessKind, readonly string[]>> = {
	board: ['tracked'],
	board_public: ['private', 'public'],
	product_owner: ['none', 'yes'],
	board_member: ['none', 'viewer', 'editor', 'owner'],
	board_team: ['none', 'viewer', 'editor'],
	team: ['tracked', 'deleted'],
	team_member: ['none', 'member', 'owner'],
	person_link: ['none', 'linked']
};

/** The kinds whose word is a rank: the lower of the restored value and the ceiling is kept. */
export const ORDINAL_KINDS: readonly AccessKind[] = ['board_public', 'board_member', 'board_team', 'team_member'];

/** The kinds that name one holder of the subject: kept only where the record names that holder. */
export const IDENTITY_KINDS: readonly AccessKind[] = ['board', 'product_owner', 'person_link'];

/** What a subject's marker row is: a board's, a team's, or any person link. */
const MARKER_OF: Readonly<Record<AccessKind, AccessKind | null>> = {
	board: 'board',
	board_public: 'board',
	product_owner: 'board',
	board_member: 'board',
	board_team: 'board',
	team: 'team',
	team_member: 'team',
	person_link: 'person_link'
};

/**
 * The rank of a word of an ordinal kind (A3): its place among the kind's words; a role that is not one of them ranks
 * as the role it reads as, the lowest grant (a member as `viewer`, a share as `viewer`, a team member as `member`). A
 * team's `deleted` ranks as `none` for the pairs it ends (R2).
 */
export function accessRank(kind: AccessKind, word: unknown): number {
	if (kind === ACCESS_KIND.team) return word === 'deleted' ? 0 : 1;
	const at = typeof word === 'string' ? ACCESS_WORDS[kind].indexOf(word) : -1;
	if (at >= 0) return at;
	return kind === ACCESS_KIND.boardPublic ? 0 : 1;
}

/**
 * Whether a row's holder is as the kinds table says (R13, R15): an account or team, id at least 1 with a creation time
 * in the stored form, where the kind always names one; 0 and '' where it never does; and, for the creator, Product
 * Owner and person link, either, by the word. No row has a real holder with ''.
 */
export function wellFormedHolder(kind: AccessKind, access: string, holderId: unknown, holderCreated: unknown): boolean {
	const real = typeof holderId === 'number' && Number.isSafeInteger(holderId) && holderId >= 1 && isStamp(holderCreated);
	const none = holderId === 0 && holderCreated === '';
	switch (kind) {
		case 'board':
			return real || none;
		case 'board_public':
		case 'team':
			return none;
		case 'product_owner':
			return access === 'yes' ? real : none;
		case 'person_link':
			return access === 'linked' ? real : none;
		default:
			return real;
	}
}

/** Whether `database` has the record, with every column this build reads: a database from before 0079 has not. */
export function hasAccessRecord(database: Database.Database): boolean {
	const columns = (database.prepare('SELECT name FROM pragma_table_info(?)').pluck().all(ACCESS_RECORD) as string[]);
	return ['seq', 'kind', 'subject_id', 'subject_created', 'holder_id', 'holder_created', 'access', 'changed_at', 'stated_changed', 'origin'].every((c) =>
		columns.includes(c)
	);
}

/** One side of an item: its id, and its creation time in the stored form, or null where it names no moment. */
export type AccessSide = { id: number; created: string | null };

/** An item as the rule asks about it: its kind, its subject, and its holder (`{ id: 0, created: '' }` for none). */
export type AccessItem = { kind: AccessKind; subject: AccessSide; holder: AccessSide };

/** The row that decides, as a reader takes it. */
export type AccessRow = { seq: number; access: string; changedAt: string; holderId: number; holderCreated: string };

const COLUMNS = 'seq, access, changed_at AS changedAt, holder_id AS holderId, holder_created AS holderCreated';
const PAIR = 'subject_id = @subject AND kind = @kind AND subject_created = @subjectCreated AND holder_id = @holder AND holder_created = @holderCreated';
const SUBJECT = "subject_id = @subject AND kind = @kind AND subject_created = @subjectCreated AND (@deleted = 0 OR access = 'deleted')";

/**
 * The reads, by name, so that tests/access-changes.test.ts can ask SQLite's plan of each (case (v)): the latest `here`
 * row in `seq` order on `access_changes_pair` or `access_changes_subject`, the `backup` rows after a moment, and the
 * latest `backup` row as a `max` and then one row. None reads every row of an item to find its latest (R11).
 */
export const ACCESS_READS = {
	pairHere: `SELECT ${COLUMNS} FROM access_changes WHERE ${PAIR} AND origin = 'here' ORDER BY seq DESC LIMIT 1`,
	pairBackupAfter: `SELECT ${COLUMNS} FROM access_changes WHERE ${PAIR} AND origin = 'backup' AND changed_at > @after`,
	pairBackupLatestAt: `SELECT max(changed_at) FROM access_changes WHERE ${PAIR} AND origin = 'backup'`,
	pairBackupLatest: `SELECT ${COLUMNS} FROM access_changes WHERE ${PAIR} AND origin = 'backup' AND changed_at = @at ORDER BY seq DESC LIMIT 1`,
	subjectHere: `SELECT ${COLUMNS} FROM access_changes WHERE ${SUBJECT} AND origin = 'here' ORDER BY seq DESC LIMIT 1`,
	subjectBackupAfter: `SELECT ${COLUMNS} FROM access_changes WHERE ${SUBJECT} AND origin = 'backup' AND changed_at > @after`,
	subjectBackupLatestAt: `SELECT max(changed_at) FROM access_changes WHERE ${SUBJECT} AND origin = 'backup'`,
	subjectBackupLatest: `SELECT ${COLUMNS} FROM access_changes WHERE ${SUBJECT} AND origin = 'backup' AND changed_at = @at ORDER BY seq DESC LIMIT 1`,
	// The start pass's (R1): this server's latest row dated no later than its moment, so that a row dated after now never raises a ceiling.
	pairHereAsOf: `SELECT ${COLUMNS} FROM access_changes WHERE ${PAIR} AND origin = 'here' AND changed_at <= @asOf ORDER BY seq DESC LIMIT 1`,
	subjectHereAsOf: `SELECT ${COLUMNS} FROM access_changes WHERE ${SUBJECT} AND origin = 'here' AND changed_at <= @asOf ORDER BY seq DESC LIMIT 1`,
	tracked: 'SELECT 1 FROM access_changes WHERE subject_id = @subject AND kind = @kind AND subject_created = @subjectCreated LIMIT 1',
	trackedById: 'SELECT 1 FROM access_changes WHERE subject_id = @subject AND kind = @kind LIMIT 1',
	createdOfSubject: 'SELECT DISTINCT subject_created FROM access_changes WHERE subject_id = @subject AND kind = @kind',
	createdOfHolder: 'SELECT DISTINCT holder_created FROM access_changes WHERE subject_id = @subject AND kind = @kind AND subject_created = @subjectCreated AND holder_id = @holder'
} as const;

type Reads = { [K in keyof typeof ACCESS_READS]: Database.Statement };

/** Each connection's prepared reads, made once. */
const prepared = new WeakMap<Database.Database, Reads>();

function readsOf(database: Database.Database): Reads {
	let reads = prepared.get(database);
	if (!reads) {
		reads = Object.fromEntries(Object.entries(ACCESS_READS).map(([name, sql]) => [name, database.prepare(sql)])) as Reads;
		prepared.set(database, reads);
	}
	return reads;
}

/** One key the record is read by: a pair (`holder` given), or a subject's rows of a kind (its team's deletions alone, `deleted`). */
type Key = { kind: AccessKind; subject: number; subjectCreated: string; holder?: { id: number; created: string }; deleted?: boolean };

function paramsOf(key: Key): Record<string, unknown> {
	const params: Record<string, unknown> = { subject: key.subject, kind: key.kind, subjectCreated: key.subjectCreated };
	if (key.holder !== undefined) return { ...params, holder: key.holder.id, holderCreated: key.holder.created };
	return { ...params, deleted: key.deleted ? 1 : 0 };
}

/** The key's latest `here` row, by `seq` alone (R1): one indexed read; with `asOf`, the latest dated no later than it. */
function hereLatest(reads: Reads, key: Key, asOf?: string): AccessRow | undefined {
	if (asOf !== undefined) return (key.holder !== undefined ? reads.pairHereAsOf : reads.subjectHereAsOf).get({ ...paramsOf(key), asOf }) as AccessRow | undefined;
	return (key.holder !== undefined ? reads.pairHere : reads.subjectHere).get(paramsOf(key)) as AccessRow | undefined;
}

/** The key's `backup` rows dated after `after`: a sealed carry holds at most 100 of a pair (R11). */
function backupAfter(reads: Reads, key: Key, after: string): AccessRow[] {
	return (key.holder !== undefined ? reads.pairBackupAfter : reads.subjectBackupAfter).all({ ...paramsOf(key), after }) as AccessRow[];
}

/** The key's latest `backup` row by `(changed_at, seq)`: its latest moment, then the last row of that moment. */
function backupLatest(reads: Reads, key: Key): AccessRow | undefined {
	const params = paramsOf(key);
	const at = (key.holder !== undefined ? reads.pairBackupLatestAt : reads.subjectBackupLatestAt).pluck().get(params) as string | null;
	if (at === null) return undefined;
	return (key.holder !== undefined ? reads.pairBackupLatest : reads.subjectBackupLatest).get({ ...params, at }) as AccessRow | undefined;
}

/**
 * The rows that decide among `keys`, ranked by R1: the latest `here` row among them by `seq` and every `backup` row of
 * any of them dated after it; or, where none has a `here` row, the latest `backup` row by `(changed_at, seq)`. Each row
 * with the index of its key.
 */
function deciding(reads: Reads, keys: readonly Key[], asOf?: string): { here?: [AccessRow, number]; later: [AccessRow, number][]; backup?: [AccessRow, number] } {
	let here: [AccessRow, number] | undefined;
	keys.forEach((key, i) => {
		const row = hereLatest(reads, key, asOf);
		if (row !== undefined && (here === undefined || row.seq > here[0].seq)) here = [row, i];
	});
	if (here !== undefined) {
		const after = here[0].changedAt;
		return { here, later: keys.flatMap((key, i) => backupAfter(reads, key, after).map((row) => [row, i] as [AccessRow, number])) };
	}
	let backup: [AccessRow, number] | undefined;
	keys.forEach((key, i) => {
		const row = backupLatest(reads, key);
		if (row === undefined) return;
		if (backup === undefined || row.changedAt > backup[0].changedAt || (row.changedAt === backup[0].changedAt && row.seq > backup[0].seq)) backup = [row, i];
	});
	return { later: [], backup };
}

/** Whether a subject is tracked: its marker row is held, by id and creation time, or by id alone where its time names no moment. */
export function accessTracked(database: Database.Database, kind: AccessKind, subject: AccessSide): boolean {
	const reads = readsOf(database);
	const marker = MARKER_OF[kind] as AccessKind;
	return subject.created === null
		? reads.trackedById.get({ subject: subject.id, kind: marker }) !== undefined
		: reads.tracked.get({ subject: subject.id, kind: marker, subjectCreated: subject.created }) !== undefined;
}

/**
 * The ceiling of one exact ordinal pair, its team's deletions counted as `none` rows at their own place (R2) unless
 * `start` says not, or null where no row names it.
 */
function pairCeiling(
	reads: Reads,
	kind: AccessKind,
	subject: { id: number; created: string },
	holder: { id: number; created: string },
	start: StartOptions = {}
): number | null {
	const keys: Key[] = [{ kind, subject: subject.id, subjectCreated: subject.created, holder }];
	// A team's deletion ends its members (the team is the subject) and its shares (the team is the holder): at a restore
	// and at a writer's comparison, never at the start pass (R2).
	if (start.teamDeletions !== false) {
		if (kind === ACCESS_KIND.teamMember) keys.push({ kind: 'team', subject: subject.id, subjectCreated: subject.created, deleted: true });
		if (kind === ACCESS_KIND.boardTeam) keys.push({ kind: 'team', subject: holder.id, subjectCreated: holder.created, deleted: true });
	}
	const rank = ([row, i]: [AccessRow, number]) => (i === 0 ? accessRank(kind, row.access) : 0);
	const found = deciding(reads, keys, start.asOf);
	if (found.here !== undefined) return Math.min(rank(found.here), ...found.later.map(rank));
	return found.backup === undefined ? null : rank(found.backup);
}

/**
 * The holder the record names for an identity kind's subject: the account (by id and creation time), `none`, or null
 * where no row names the subject. This server's latest row by `seq`, made `none` by any `backup` row after it naming
 * another holder; else the latest `backup` row by `(changed_at, seq)`.
 */
function namedHolder(reads: Reads, kind: AccessKind, subject: { id: number; created: string }, asOf?: string): { id: number; created: string } | 'none' | null {
	const found = deciding(reads, [{ kind, subject: subject.id, subjectCreated: subject.created }], asOf);
	const holderOf = (row: AccessRow) => (row.holderId === 0 || row.access === 'none' ? ('none' as const) : { id: row.holderId, created: row.holderCreated });
	if (found.here !== undefined) {
		const named = holderOf(found.here[0]);
		if (named === 'none') return 'none';
		// A backup can add a narrowing, never a holder (R1): one after this server's latest naming another makes it none.
		const other = found.later.some(([row]) => holderOf(row) === 'none' || row.holderId !== named.id || row.holderCreated !== named.created);
		return other ? 'none' : named;
	}
	return found.backup === undefined ? null : holderOf(found.backup[0]);
}

/**
 * The start pass's options (R1, R2): `asOf`, the pass's moment, past which no row of this server's is read (a restore
 * passes its own moment too, code review FP12); and `teamDeletions: false`, so that a team's deletion ends none of its
 * members or shares there.
 */
export type StartOptions = { asOf?: string; teamDeletions?: boolean };

/** The rule's options: `guess` at a restore alone, with `heldBefore`, whether this server held the item before its clear (R4). */
export type CeilingOptions = StartOptions & { guess?: boolean; heldBefore?: boolean };

/**
 * The highest rank the record lets `item` hold, or null where it sets none and the item is left as it is.
 *
 * - An ordinal kind: the ceiling's rank among the kind's words (`accessRank`). Where a side's creation time names no
 *   moment, every row of that id counts, the lowest ceiling taken (fail closed).
 * - An identity kind: 1 where the record names `item.holder` (by id and creation time), 0 where it names another or
 *   none, or where a creation time names no moment and the subject has any row (R8).
 * - With `guess`: an item no row names, on a tracked subject, that this server did not hold before the clear, is 0;
 *   for an identity kind, only the Product Owner (a board's creator and a person's link are tracked by their own rows).
 */
export function accessCeiling(database: Database.Database, item: AccessItem, options: CeilingOptions = {}): number | null {
	const reads = readsOf(database);
	const { kind, subject, holder } = item;
	let ceiling: number | null;
	if (IDENTITY_KINDS.includes(kind)) {
		if (subject.created === null || holder.created === null) {
			// Never matched (R8): cleared where the subject has any row of the kind, by id alone where its time names none.
			const any =
				subject.created === null
					? reads.trackedById.get({ subject: subject.id, kind }) !== undefined
					: reads.tracked.get({ subject: subject.id, kind, subjectCreated: subject.created }) !== undefined;
			ceiling = any ? 0 : null;
		} else {
			const named = namedHolder(reads, kind, { id: subject.id, created: subject.created }, options.asOf);
			ceiling = named === null ? null : named !== 'none' && named.id === holder.id && named.created === holder.created ? 1 : 0;
		}
	} else if (subject.created === null || holder.created === null) {
		// By id alone: every creation time the record holds for the unknown side, the lowest ceiling.
		const subjects = subject.created === null ? (reads.createdOfSubject.pluck().all({ subject: subject.id, kind }) as string[]) : [subject.created];
		if (kind === ACCESS_KIND.teamMember && subject.created === null && options.teamDeletions !== false) {
			subjects.push(...(reads.createdOfSubject.pluck().all({ subject: subject.id, kind: 'team' }) as string[]));
		}
		ceiling = null;
		for (const subjectCreated of new Set(subjects)) {
			const holders =
				holder.created !== null
					? [holder.created]
					: (reads.createdOfHolder.pluck().all({ subject: subject.id, kind, subjectCreated, holder: holder.id }) as string[]);
			if (kind === ACCESS_KIND.boardTeam && holder.created === null && options.teamDeletions !== false) {
				holders.push(...(reads.createdOfSubject.pluck().all({ subject: holder.id, kind: 'team' }) as string[]));
			}
			for (const holderCreated of new Set(holders)) {
				const one = pairCeiling(reads, kind, { id: subject.id, created: subjectCreated }, { id: holder.id, created: holderCreated }, options);
				if (one !== null) ceiling = ceiling === null ? one : Math.min(ceiling, one);
			}
		}
	} else {
		ceiling = pairCeiling(reads, kind, { id: subject.id, created: subject.created }, { id: holder.id, created: holder.created }, options);
	}
	if (ceiling !== null || !options.guess || options.heldBefore) return ceiling;
	// The guess (rule 2, R4): no row, on a tracked subject, not held here before the clear.
	if (kind === ACCESS_KIND.board || kind === ACCESS_KIND.personLink) return null;
	return accessTracked(database, kind, subject) ? 0 : null;
}

/**
 * Whether the record's deciding row for a team is its deletion (R2): for the count of teams a restore brought back
 * without what they had. With `asOf`, as the rule reads it at that moment (code review, FP12).
 */
export function accessTeamDeleted(database: Database.Database, team: AccessSide, asOf?: string): boolean {
	if (team.created === null) return false;
	const found = deciding(readsOf(database), [{ kind: 'team', subject: team.id, subjectCreated: team.created }], asOf);
	const row = found.here?.[0] ?? found.backup?.[0];
	return row?.access === 'deleted' || found.later.some(([later]) => later.access === 'deleted');
}

/** The table each kind's subject is in. */
const SUBJECT_TABLE: Readonly<Record<AccessKind, 'boards' | 'teams' | 'people'>> = {
	board: 'boards',
	board_public: 'boards',
	product_owner: 'boards',
	board_member: 'boards',
	board_team: 'boards',
	team: 'teams',
	team_member: 'teams',
	person_link: 'people'
};

/** The table each kind's holder is in: an account, a team for a share, or none. */
const HOLDER_TABLE: Readonly<Record<AccessKind, 'users' | 'teams' | null>> = {
	board: 'users',
	board_public: null,
	product_owner: 'users',
	board_member: 'users',
	board_team: 'teams',
	team: null,
	team_member: 'users',
	person_link: 'users'
};

/**
 * The one statement that records a change of `kind` (plan 3.1, 3.2): a plain `INSERT … SELECT` that reads the subject's
 * and the holder's creation times on the connection, in SQL, as `stamp_of` (one reading of a creation time, R13). A
 * subject whose creation time names no moment is not tracked, and nothing is written. A pair whose holder's time names
 * none is not written; a creator, Product Owner or link whose account is not there, or whose time names none, is
 * written as holder 0 and `''`, with `none` (the creator `tracked`), as the seed writes it. `origin` is `here`.
 */
function accessRecordSql(kind: AccessKind): string {
	const subject = SUBJECT_TABLE[kind];
	const holder = HOLDER_TABLE[kind];
	const into =
		'INSERT INTO access_changes (kind, subject_id, subject_created, holder_id, holder_created, access, changed_at, stated_changed) ';
	const where = 'WHERE s.id = @subject AND stamp_of(s.created_at) IS NOT NULL';
	if (holder === null) return into + `SELECT @kind, s.id, stamp_of(s.created_at), 0, '', @access, @at, @at FROM ${subject} AS s ${where}`;
	if (IDENTITY_KINDS.includes(kind)) {
		return (
			into +
			'SELECT @kind, s.id, stamp_of(s.created_at), CASE WHEN stamp_of(h.created_at) IS NULL THEN 0 ELSE h.id END, ' +
			"coalesce(stamp_of(h.created_at), ''), CASE WHEN stamp_of(h.created_at) IS NULL THEN @none ELSE @access END, @at, @at " +
			`FROM ${subject} AS s LEFT JOIN ${holder} AS h ON h.id = @holder ${where}`
		);
	}
	return (
		into +
		`SELECT @kind, s.id, stamp_of(s.created_at), h.id, stamp_of(h.created_at), @access, @at, @at FROM ${subject} AS s JOIN ${holder} AS h ON h.id = @holder ` +
		`${where} AND stamp_of(h.created_at) IS NOT NULL`
	);
}

/**
 * A change as a writer records it: its kind, the subject's id, the holder's id (an account, or a team for a share;
 * null or left out for none), and the access after the change. For a creator, Product Owner or person link, `access`
 * is the word naming a holder (`tracked`, `yes`, `linked`), and the row says `none` where the holder is null.
 */
export type AccessChange = { kind: AccessKind; subject: number; holder?: number | null; access: string };

/** The word a change is recorded with: an ordinal kind's role as the role it reads as (A3), as the seed maps it. */
function recordedWord(kind: AccessKind, access: string): string {
	return ORDINAL_KINDS.includes(kind) ? ACCESS_WORDS[kind][accessRank(kind, access)] : access;
}

/**
 * Record one change of access here (plan 3.1, section 5), in the transaction of the change, after it, on `database`:
 * one row by `accessRecordSql`, `changed_at` and `stated_changed` now in the stored form. Throws, writing nothing,
 * where no transaction is open on `database`: a change recorded apart from its write could be kept without it, or
 * lost with it. Returns whether a row was written (none for a subject or holder whose creation time names no moment).
 */
export function recordAccessChange(database: Database.Database, change: AccessChange): boolean {
	if (!database.inTransaction) {
		throw new Error('recordAccessChange records inside the transaction of the change, and none is open on the connection it was given');
	}
	registerStampFunctions(database);
	const none = change.kind === ACCESS_KIND.board ? 'tracked' : 'none';
	const at = stamp();
	return (
		database.prepare(accessRecordSql(change.kind)).run({
			kind: change.kind,
			subject: change.subject,
			holder: change.holder ?? null,
			access: recordedWord(change.kind, change.access),
			none,
			at
		}).changes > 0
	);
}

/**
 * Whether the record already gives exactly `change` (R12), as the rule reads it (R1: this server's latest row by `seq`,
 * a team's deletion as `none`, a backup's later narrowing): the share and team-member writers record a role the same
 * as the live row only where the record says otherwise, so that a grant an older image or a host edit made is recorded
 * when it is sent again. True for a subject or holder that is not there, or whose creation time names no moment:
 * nothing would be recorded; and for a subject the record does not track where no row names the pair (FP1). Ordinal
 * kinds only.
 */
export function accessAsRecorded(database: Database.Database, change: AccessChange): boolean {
	const createdOf = (table: string, id: number | null | undefined) =>
		id === null || id === undefined ? undefined : (database.prepare(`SELECT created_at FROM ${table} WHERE id = ?`).pluck().get(id) as unknown);
	const subject = toStamp(createdOf(SUBJECT_TABLE[change.kind], change.subject));
	const table = HOLDER_TABLE[change.kind];
	const holder = table === null ? '' : toStamp(createdOf(table, change.holder));
	if (subject === null || holder === null) return true;
	const ceiling = accessCeiling(database, { kind: change.kind, subject: { id: change.subject, created: subject }, holder: { id: table === null ? 0 : change.holder!, created: holder } });
	// A subject the record does not track (a fixture, or one made on an older image), where no row names the pair: the
	// record says nothing of it, and a restore takes it as the backup has it, so a role sent again unchanged writes nothing
	// (card 2378's rule). Where a row does name the pair, it is compared as on a tracked subject (code review, FP1): a
	// grant a host edit or an older image made is recorded when it is sent again, so that no later pass lowers it.
	if (ceiling === null && !accessTracked(database, change.kind, { id: change.subject, created: subject })) return true;
	return ceiling === accessRank(change.kind, change.access);
}
