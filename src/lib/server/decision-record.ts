/**
 * decision-record.ts — a decision's permanent record (card 2675, plan section
 * 4.4 and decision 27): its versions and its events, and the reads of them
 * the service and the mail make.
 *
 * `decision_versions`, `decision_responses`, `decision_rulings` and
 * `decision_events` are insert-only, in code alone (design 4.3: no trigger).
 * These are the only functions in `src` that insert into the events and the
 * versions, but one: the restore's `RECORD_DECISION_LINKS_ENDED` in
 * db/restore.ts, which records `link_revoked { reason: 'restore' }` for each
 * link a restore ends (decision 13). Cards 2677 and 2679 add their response
 * and ruling inserts here. Nothing anywhere updates or deletes a row of them,
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
import { and, asc, eq, inArray, isNotNull, isNull, gt, lte, max, or } from 'drizzle-orm';
import { db } from './db';
import {
	decisionEvents,
	decisionOptions,
	decisionVersions,
	decisions,
	people,
	peopleGroupMembers,
	peopleGroups,
	type DecisionVersion,
	type Person
} from './db/schema';
import type { SessionUser } from './auth';
import type { ActivitySource } from './logActivity';
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
	'dry_run'
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

/** The events a record-bearing mail writes for its participant (decision 31). */
const MAIL_KINDS: readonly EventKind[] = ['invited', 'asked_again', 'told_of_change', 'told_withdrawn', 'told_ruling'];

/** The events that say whether a participant's row held an account on this decision (decision 16). */
const ACCOUNT_KINDS: readonly EventKind[] = ['included', 're_included', 'account_attached', 'account_cleared'];

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
