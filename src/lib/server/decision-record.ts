/**
 * decision-record.ts — a decision's permanent record (card 2675, plan section
 * 4.4 and decision 27): its versions and its events, and the reads of them
 * the service and the mail make.
 *
 * `decision_versions`, `decision_responses`, `decision_rulings` and
 * `decision_events` are insert-only, in code alone (design 4.3: no trigger).
 * These are the only functions in `src` that insert into the events, the
 * versions and the responses, but one: the restore's
 * `RECORD_DECISION_LINKS_ENDED` in db/restore.ts, which records
 * `link_revoked { reason: 'restore' }` for each link a restore ends (decision
 * 13). Card 2677 adds the response insert, `appendResponse`, and the reads of
 * a participant's own responses and of what they have seen and been told;
 * card 2679 adds its ruling insert here. Nothing anywhere updates or deletes a row of them,
 * but the cascade of `deleteDecision`, a restore's wholesale replacement (plan
 * 4.8), and the writers that walk every table by name, which the scan names
 * one by one (`GENERIC_WRITERS`). tests/decision-record.test.ts holds this by
 * a scan of every file under `src`, which also allows the tables' names, as
 * text, only here, in the schema files and in the restore.
 *
 * `appendEvent` refuses an event naming a participant on a draft (comment
 * 5599): a draft's participant rows may be deleted freely only because no
 * event names them. An event's `detail` never holds a token, a hash, or a
 * mail server's words.
 *
 * Plain functions with no caller, called inside a service write's
 * transaction, or by the mail effect in a transaction of its own.
 */
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, gt, lt, lte, max, or } from 'drizzle-orm';
import { db } from './db';
import {
	decisionEvents,
	decisionOptions,
	decisionResponses,
	decisionVersions,
	decisions,
	people,
	peopleGroupMembers,
	peopleGroups,
	type DecisionResponse,
	type DecisionVersion,
	type Person
} from './db/schema';
import type { SessionUser } from './auth';
import type { ActivitySource } from './logActivity';
import type { OwnResponse } from '$lib/decision-view-types';
import { stamp, type Stamp } from '$lib/timestamps';

/** Who an entry on the record is by: an account (its id while it lasts, and its name kept), a link holder, or DumpFire. */
export type RecordActor = { userId: number | null; name: string; source: 'ui' | 'api' | 'link' | 'system' };

/** DumpFire itself: a delivery outcome, a restore. */
export const SYSTEM_ACTOR: RecordActor = { userId: null, name: 'DumpFire', source: 'system' };

/** The record's actor for a signed-in caller, through the tree the request came by. */
export function actorFor(user: SessionUser, source: ActivitySource): RecordActor {
	return { userId: user.id, name: user.username, source };
}

/** Every kind of event the record holds (plan 4.4). */
export const EVENT_KINDS = [
	'created',
	'decider_changed',
	'published',
	'opened',
	'included',
	're_included',
	'role_changed',
	'removed',
	'link_issued',
	'link_revoked',
	'invited',
	'asked_again',
	'told_of_change',
	'told_withdrawn',
	'told_ruling',
	'mail_skipped',
	'mail_outcome',
	'closed',
	'extended',
	'withdrawn',
	'account_attached',
	'account_cleared',
	'address_changed',
	'dry_run',
	// Card 2677: a participant recorded as having seen a version at a stage (decision 14), and each response given (decision 13).
	'seen',
	'responded'
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

/** The events a record-bearing mail writes for its participant (decision 31). */
const MAIL_KINDS: readonly EventKind[] = ['invited', 'asked_again', 'told_of_change', 'told_withdrawn', 'told_ruling'];

/** The events that say whether a participant's row held an account on this decision (decision 16). */
const ACCOUNT_KINDS: readonly EventKind[] = ['included', 're_included', 'account_attached', 'account_cleared'];

/** The mail events a participant's banner tells them of (card 2677, decision 19). */
const TOLD_KINDS = ['invited', 'asked_again', 'told_of_change'] as const;

/**
 * Append one event, `created_at` stamped, and answer its id. An event naming
 * a participant on a draft, or on a decision that is not there, is a fault:
 * a plain `Error`, and nothing is written.
 */
export function appendEvent(
	event: {
		decisionId: number;
		kind: EventKind;
		participantId?: number | null;
		versionNumber?: number | null;
		detail?: Record<string, unknown> | null;
	},
	by: RecordActor
): number {
	const participantId = event.participantId ?? null;
	if (participantId !== null) {
		const decision = db.select({ status: decisions.status }).from(decisions).where(eq(decisions.id, event.decisionId)).get();
		if (!decision || decision.status === 'draft') {
			throw new Error(
				`Decision ${event.decisionId}: a ${event.kind} event naming participant ${participantId} cannot be written on a draft, ` +
					'whose participants no event may name'
			);
		}
	}
	return db
		.insert(decisionEvents)
		.values({
			decisionId: event.decisionId,
			participantId,
			kind: event.kind,
			versionNumber: event.versionNumber ?? null,
			detail: event.detail == null ? null : JSON.stringify(event.detail),
			actorUserId: by.userId,
			actorName: by.name,
			source: by.source,
			createdAt: stamp()
		})
		.returning({ id: decisionEvents.id })
		.get().id;
}

/** Append one published version, `published_at` stamped, by `by`. */
export function appendVersion(
	version: { decisionId: number; number: number; content: string; changeNote: string | null; asksAgain: boolean },
	by: RecordActor
): DecisionVersion {
	return db
		.insert(decisionVersions)
		.values({
			decisionId: version.decisionId,
			number: version.number,
			content: version.content,
			changeNote: version.changeNote,
			asksAgain: version.asksAgain,
			publishedBy: by.userId,
			publishedByName: by.name,
			publishedAt: stamp()
		})
		.returning()
		.get();
}

/**
 * Append one response (card 2677, decision 11), `created_at` stamped. Its
 * `scores` and `option_comments` are JSON the write built from the live
 * option ids, never from a body's keys (R9). A change of answer is a new row,
 * `replacesId` the one before it in the same round.
 */
export function appendResponse(r: {
	decisionId: number;
	participantId: number;
	versionNumber: number;
	round: number;
	kind: string;
	optionId: number | null;
	scores: string | null;
	comment: string | null;
	optionComments: string | null;
	replacesId: number | null;
	via: 'session' | 'link';
}): DecisionResponse {
	return db
		.insert(decisionResponses)
		.values({
			decisionId: r.decisionId,
			participantId: r.participantId,
			versionNumber: r.versionNumber,
			round: r.round,
			kind: r.kind,
			optionId: r.optionId,
			scores: r.scores,
			comment: r.comment,
			optionComments: r.optionComments,
			replacesId: r.replacesId,
			via: r.via,
			createdAt: stamp()
		})
		.returning()
		.get();
}

/**
 * The one projection of a response (card 2677, D3), field by field: what the
 * page shows and every write that answers a response answers. No row id of
 * the response, its decision, its participant or the response it replaced: a
 * response's id would count others' responses between two of one's own (S4).
 * A keyed object is read tolerantly, an option id's key alone kept.
 */
export function ownResponseOf(row: DecisionResponse): OwnResponse {
	return {
		versionNumber: row.versionNumber,
		round: row.round,
		kind: row.kind as OwnResponse['kind'],
		optionId: row.optionId,
		scores: row.scores === null ? null : keyedOf(row.scores, (value): value is number => typeof value === 'number'),
		comment: row.comment,
		optionComments: row.optionComments === null ? {} : keyedOf(row.optionComments, (value): value is string => typeof value === 'string'),
		createdAt: row.createdAt
	};
}

/** A stored object keyed by option id, each value one `is` accepts; anything else is left out. */
function keyedOf<T>(json: string, is: (value: unknown) => value is T): Record<string, T> {
	const read: Record<string, T> = {};
	try {
		const parsed = JSON.parse(json) as unknown;
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return read;
		for (const [key, value] of Object.entries(parsed)) if (/^\d+$/.test(key) && is(value)) read[key] = value;
	} catch {
		// Not JSON: nothing is kept.
	}
	return read;
}

/**
 * What a participant row copies from the directory when the person is
 * included (S7, decision 19): their name, address (lower-case), job title,
 * the names of their groups as JSON in order, their account, and their
 * status, for the caller to refuse a person who has left. Null for no such
 * person.
 */
export function snapshotOf(
	personId: number
): { name: string; email: string; jobTitle: string; groups: string; userId: number | null; status: string } | null {
	const person = db.select().from(people).where(eq(people.id, personId)).get();
	if (!person) return null;
	const groups = db
		.select({ name: peopleGroups.name })
		.from(peopleGroupMembers)
		.innerJoin(peopleGroups, eq(peopleGroups.id, peopleGroupMembers.groupId))
		.where(eq(peopleGroupMembers.personId, personId))
		.orderBy(asc(peopleGroups.name))
		.all()
		.map((group) => group.name);
	return {
		name: person.fullName,
		email: person.email.toLowerCase(),
		jobTitle: person.jobTitle,
		groups: JSON.stringify(groups),
		userId: person.userId,
		status: person.status
	};
}

/** The round a response is given now: the number of the latest version that asked again, or 0 before opening. */
export function currentRound(decisionId: number): number {
	const row = db
		.select({ round: max(decisionVersions.number) })
		.from(decisionVersions)
		.where(and(eq(decisionVersions.decisionId, decisionId), eq(decisionVersions.asksAgain, true)))
		.get();
	return row?.round ?? 0;
}

/** The ids of the options live in version `versionNumber`: added by then, and not retired by then, in order. */
export function liveOptionIds(decisionId: number, versionNumber: number): number[] {
	return db
		.select({ id: decisionOptions.id })
		.from(decisionOptions)
		.where(
			and(
				eq(decisionOptions.decisionId, decisionId),
				isNotNull(decisionOptions.addedInVersion),
				lte(decisionOptions.addedInVersion, versionNumber),
				or(isNull(decisionOptions.retiredInVersion), gt(decisionOptions.retiredInVersion, versionNumber))
			)
		)
		.orderBy(asc(decisionOptions.position), asc(decisionOptions.id))
		.all()
		.map((option) => option.id);
}

/**
 * Every option label quoted in any published version of the decision, each
 * once (card 2676, decision 7): a label once published is never issued again.
 * A version whose content cannot be read quotes none.
 */
export function labelsInVersions(decisionId: number): string[] {
	const labels = new Set<string>();
	for (const { content } of db.select({ content: decisionVersions.content }).from(decisionVersions).where(eq(decisionVersions.decisionId, decisionId)).all()) {
		try {
			const read = JSON.parse(content) as { options?: unknown } | null;
			if (read === null || typeof read !== 'object' || !Array.isArray(read.options)) continue;
			for (const option of read.options as unknown[]) {
				const label = option !== null && typeof option === 'object' ? (option as { label?: unknown }).label : undefined;
				if (typeof label === 'string') labels.add(label);
			}
		} catch {
			// Not JSON: it quotes no label.
		}
	}
	return [...labels];
}

/**
 * Whether each participant's row held an account on this decision
 * (`hadAccount`, decision 16), by participant id, from the latest of its
 * `included`, `re_included` (their `hadAccount`), `account_attached` (true)
 * and `account_cleared` (false) events, in one query. A participant with
 * none of them is not in the map. A detail that cannot be read counts as
 * true, which issues no link.
 */
export function accountHistory(decisionId: number): Map<number, boolean> {
	const events = db
		.select({ participantId: decisionEvents.participantId, kind: decisionEvents.kind, detail: decisionEvents.detail })
		.from(decisionEvents)
		.where(
			and(
				eq(decisionEvents.decisionId, decisionId),
				isNotNull(decisionEvents.participantId),
				inArray(decisionEvents.kind, [...ACCOUNT_KINDS])
			)
		)
		.orderBy(asc(decisionEvents.id))
		.all();
	const history = new Map<number, boolean>();
	for (const event of events) {
		if (event.participantId === null) continue;
		history.set(event.participantId, hadAccountOf(event.kind, event.detail));
	}
	return history;
}

/** What one account event says of `hadAccount`. */
function hadAccountOf(kind: string, detail: string | null): boolean {
	if (kind === 'account_attached') return true;
	if (kind === 'account_cleared') return false;
	try {
		const read = JSON.parse(detail ?? 'null') as { hadAccount?: unknown } | null;
		return read?.hadAccount !== false;
	} catch {
		return true;
	}
}

/**
 * How many ids are asked about in one query, for every decision module (the
 * code review's F5: defined once, here, which the others import and which
 * imports none of them).
 */
export const IDS_AT_ONCE = 500;

/** The people named, by id, read in as few queries as `IDS_AT_ONCE` allows; one that is not there is not in the map. */
export function peopleById(ids: readonly number[]): Map<number, Person> {
	const unique = [...new Set(ids)];
	const found = new Map<number, Person>();
	for (let from = 0; from < unique.length; from += IDS_AT_ONCE) {
		for (const person of db.select().from(people).where(inArray(people.id, unique.slice(from, from + IDS_AT_ONCE))).all()) found.set(person.id, person);
	}
	return found;
}

/** The moment of each participant's latest record-bearing mail event, by participant id; one with none is not in the map (decision 31). */
export function lastMailAt(participantIds: number[]): Map<number, Stamp> {
	const latest = new Map<number, Stamp>();
	for (let from = 0; from < participantIds.length; from += IDS_AT_ONCE) {
		const ids = participantIds.slice(from, from + IDS_AT_ONCE);
		const rows = db
			.select({ participantId: decisionEvents.participantId, at: max(decisionEvents.createdAt) })
			.from(decisionEvents)
			.where(and(inArray(decisionEvents.participantId, ids), inArray(decisionEvents.kind, [...MAIL_KINDS])))
			.groupBy(decisionEvents.participantId)
			.all();
		for (const row of rows) if (row.participantId !== null && row.at !== null) latest.set(row.participantId, row.at);
	}
	return latest;
}

// ─── A participant's own part (card 2677) ────────────────────────────────────

/** The participant's latest response in `round`, or null for none: what the next one replaces (decision 11). */
export function latestResponse(participantId: number, round: number): DecisionResponse | null {
	return (
		db
			.select()
			.from(decisionResponses)
			.where(and(eq(decisionResponses.participantId, participantId), eq(decisionResponses.round, round)))
			.orderBy(desc(decisionResponses.id))
			.limit(1)
			.get() ?? null
	);
}

/** How many responses the participant has given in `round`, for the write's cap (decision 11). */
export function responsesInRound(participantId: number, round: number): number {
	const row = db
		.select({ n: count() })
		.from(decisionResponses)
		.where(and(eq(decisionResponses.participantId, participantId), eq(decisionResponses.round, round)))
		.get();
	return row?.n ?? 0;
}

/**
 * The participant's own responses as the page shows them: the latest in
 * `round`, and, when there is none, the latest of an earlier round, which the
 * page shows as for an earlier version (design 4.7).
 */
export function ownResponses(participantId: number, round: number): { current: OwnResponse | null; earlier: OwnResponse | null } {
	const current = latestResponse(participantId, round);
	if (current !== null) return { current: ownResponseOf(current), earlier: null };
	const earlier = db
		.select()
		.from(decisionResponses)
		.where(and(eq(decisionResponses.participantId, participantId), lt(decisionResponses.round, round)))
		.orderBy(desc(decisionResponses.id))
		.limit(1)
		.get();
	return { current: null, earlier: earlier === undefined ? null : ownResponseOf(earlier) };
}

/** Whether the participant is already recorded as having seen version `versionNumber` at `stage` (decision 14): one `seen` event for the three. */
export function hasSeen(participantId: number, versionNumber: number, stage: string): boolean {
	return db
		.select({ detail: decisionEvents.detail })
		.from(decisionEvents)
		.where(and(eq(decisionEvents.participantId, participantId), eq(decisionEvents.kind, 'seen'), eq(decisionEvents.versionNumber, versionNumber)))
		.all()
		.some((event) => detailOf(event.detail).stage === stage);
}

/**
 * The participant's latest record-bearing mail of the three a banner tells
 * of (decision 19), or null for none, every mail skipped among them; and
 * `delivered`, true only when that mail's own `mail_outcome` (`detail.of`
 * its event's id) says it was (D8). No outcome yet is not delivered.
 */
export function lastToldOf(participantId: number): { kind: (typeof TOLD_KINDS)[number]; at: Stamp; delivered: boolean } | null {
	const told = db
		.select({ id: decisionEvents.id, kind: decisionEvents.kind, at: decisionEvents.createdAt })
		.from(decisionEvents)
		.where(and(eq(decisionEvents.participantId, participantId), inArray(decisionEvents.kind, [...TOLD_KINDS])))
		.orderBy(desc(decisionEvents.id))
		.limit(1)
		.get();
	if (told === undefined) return null;
	const delivered = db
		.select({ detail: decisionEvents.detail })
		.from(decisionEvents)
		.where(and(eq(decisionEvents.participantId, participantId), eq(decisionEvents.kind, 'mail_outcome'), gt(decisionEvents.id, told.id)))
		.all()
		.some((event) => {
			const detail = detailOf(event.detail);
			return detail.of === told.id && detail.delivered === true;
		});
	return { kind: told.kind as (typeof TOLD_KINDS)[number], at: told.at, delivered };
}

/** An event's detail, read; one that cannot be read, or is no object, is empty. */
function detailOf(detail: string | null): Record<string, unknown> {
	try {
		const read = JSON.parse(detail ?? 'null') as unknown;
		return read !== null && typeof read === 'object' && !Array.isArray(read) ? (read as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}
