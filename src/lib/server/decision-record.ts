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
 * a participant's own responses and of what they have seen and been told.
 * Card 2679 adds the ruling's insert, `appendRuling`, the one insert of a
 * ruling; the reads of every response, of the concerns, of the response ids
 * the results revision covers (`revisionResponseIdsOf`, which fails closed)
 * and of the statement version each response was given under; and the
 * allow-list of the kinds a
 * response may be counted as (`RESPONSE_KINDS`), which every read of a vote
 * asks, so that a concern, or a kind a later card adds, is never read as one.
 * Nothing anywhere updates or deletes a row of them,
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
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, gt, lt, lte, max, ne, or } from 'drizzle-orm';
import { db } from './db';
import {
	decisionEvents,
	decisionOptions,
	decisionResponses,
	decisionRulings,
	decisionVersions,
	decisions,
	people,
	peopleGroupMembers,
	peopleGroups,
	type Decision,
	type DecisionResponse,
	type DecisionRuling,
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
	'responded',
	// Card 2679: the ruling `{ optionId, early, againstResponses, supersededOld? }`; each consulted participant cut off by an early
	// ruling; superseded `{ byDecisionId }`; the release `{ upToResponseId, omitted }`; and a concern `{ responseId, notice }`.
	'ruled',
	'cut_off',
	'superseded',
	'results_released',
	'concern_raised'
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

/**
 * What a participant's response may be counted as (card 2677, decision 11;
 * moved here by card 2679, decision 18): every read of a vote, a tally and a
 * participant's own response reads these kinds alone. An allow-list, so that
 * a `concern`, and a kind a later card adds, is never read as a vote until it
 * is named here.
 */
export const RESPONSE_KINDS = ['vote', 'abstain', 'no_concerns'] as const;

/**
 * The events that are the decider's and administrators' alone (card 2679,
 * decision 26, S10): `ruled`'s `early` and `againstResponses`, the `cut_off`
 * events and `concern_raised`. A binding rule on the cards that read the
 * record: card 2680's record shows them behind `record` (`['admin',
 * 'decider']`) alone, and card 2689's webhooks never carry them.
 */
export const DECIDER_ONLY_EVENTS: readonly EventKind[] = ['ruled', 'cut_off', 'concern_raised'];

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
 * Append the decision's ruling (card 2679, decision 7), `ruled_at` stamped,
 * by `by`: the one insert into the rulings, of which a decision holds at most
 * one (its key is the decision's). Nothing updates or deletes it.
 */
export function appendRuling(
	ruling: { decisionId: number; optionId: number | null; reason: string; conditions: string | null; againstResponses: boolean; early: boolean; versionNumber: number },
	by: RecordActor
): DecisionRuling {
	return db
		.insert(decisionRulings)
		.values({
			decisionId: ruling.decisionId,
			optionId: ruling.optionId,
			reason: ruling.reason,
			conditions: ruling.conditions,
			againstResponses: ruling.againstResponses,
			early: ruling.early,
			versionNumber: ruling.versionNumber,
			ruledBy: by.userId,
			ruledByName: by.name,
			ruledAt: stamp()
		})
		.returning()
		.get();
}

/** The decision's ruling, or null before it is ruled (card 2679). */
export function rulingOf(decisionId: number): DecisionRuling | null {
	return db.select().from(decisionRulings).where(eq(decisionRulings.decisionId, decisionId)).get() ?? null;
}

/** Every response of the decision that is a vote, an abstention or no concerns (`RESPONSE_KINDS`), in id order: never a concern (card 2679, decisions 8 and 18). */
export function responsesOf(decisionId: number): DecisionResponse[] {
	return db
		.select()
		.from(decisionResponses)
		.where(and(eq(decisionResponses.decisionId, decisionId), inArray(decisionResponses.kind, [...RESPONSE_KINDS])))
		.orderBy(asc(decisionResponses.id))
		.all();
}

/**
 * The ids of every response of the decision but its concerns, in id order:
 * what the results revision covers (card 2679, decision 8; code review F1).
 * Not `RESPONSE_KINDS`, on purpose: the revision fails closed. A kind a later
 * card adds moves the revision before any tally counts it, so a ruling or a
 * release asked against a page that did not show it is refused; only a
 * concern, which is raised after the ruling and is never counted, leaves the
 * revision be. Every tally keeps the allow-list (`responsesOf`).
 */
export function revisionResponseIdsOf(decisionId: number): number[] {
	return db
		.select({ id: decisionResponses.id })
		.from(decisionResponses)
		.where(and(eq(decisionResponses.decisionId, decisionId), ne(decisionResponses.kind, 'concern')))
		.orderBy(asc(decisionResponses.id))
		.all()
		.map((row) => row.id);
}

/** The concerns raised on the decision, or by one participant, in id order (card 2679, decision 18): `kind = 'concern'` alone. */
export function concernsOf(of: { participantId: number } | { decisionId: number }): DecisionResponse[] {
	const whose = 'participantId' in of ? eq(decisionResponses.participantId, of.participantId) : eq(decisionResponses.decisionId, of.decisionId);
	return db
		.select()
		.from(decisionResponses)
		.where(and(whose, eq(decisionResponses.kind, 'concern')))
		.orderBy(asc(decisionResponses.id))
		.all();
}

/**
 * The version of the who-sees statement each response was given under, by
 * response id, from its `responded` event's `statement` (card 2679, decision
 * 25); null for a response whose event holds none, given before the version
 * was recorded. A response with no `responded` event is not in the map.
 */
export function statementsOf(decisionId: number): Map<number, number | null> {
	const statements = new Map<number, number | null>();
	for (const event of eventsOfKind(decisionId, 'responded')) {
		if (typeof event.detail.responseId !== 'number') continue;
		statements.set(event.detail.responseId, typeof event.detail.statement === 'number' ? event.detail.statement : null);
	}
	return statements;
}

/** The decision's events of `kind`, in order, each with its participant, its detail read and its actor's name (card 2679). */
export function eventsOfKind(decisionId: number, kind: EventKind): { participantId: number | null; detail: Record<string, unknown>; actorName: string; at: Stamp }[] {
	return db
		.select({ participantId: decisionEvents.participantId, detail: decisionEvents.detail, actorName: decisionEvents.actorName, at: decisionEvents.createdAt })
		.from(decisionEvents)
		.where(and(eq(decisionEvents.decisionId, decisionId), eq(decisionEvents.kind, kind)))
		.orderBy(asc(decisionEvents.id))
		.all()
		.map((event) => ({ ...event, detail: detailOf(event.detail) }));
}

/**
 * The decision that supersedes this one and is not withdrawn, the newest, or
 * null for none (card 2679, decision 5): there is at most one, in code
 * (`decisions.supersedes_id`).
 */
export function supersedingOf(decisionId: number): Decision | null {
	return (
		db
			.select()
			.from(decisions)
			.where(and(eq(decisions.supersedesId, decisionId), ne(decisions.status, 'withdrawn')))
			.orderBy(desc(decisions.id))
			.limit(1)
			.get() ?? null
	);
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

/**
 * The moments of each participant's record-bearing mail events since `since`,
 * oldest first, by participant id; one with none is not in the map (card
 * 2697, Q24: the daily cap on record mail to one participant).
 */
export function mailsSince(participantIds: number[], since: Stamp): Map<number, Stamp[]> {
	const moments = new Map<number, Stamp[]>();
	for (let from = 0; from < participantIds.length; from += IDS_AT_ONCE) {
		const ids = participantIds.slice(from, from + IDS_AT_ONCE);
		const rows = db
			.select({ participantId: decisionEvents.participantId, at: decisionEvents.createdAt })
			.from(decisionEvents)
			.where(and(inArray(decisionEvents.participantId, ids), inArray(decisionEvents.kind, [...MAIL_KINDS]), gte(decisionEvents.createdAt, since)))
			.orderBy(asc(decisionEvents.createdAt), asc(decisionEvents.id))
			.all();
		for (const row of rows) {
			if (row.participantId === null) continue;
			const list = moments.get(row.participantId) ?? [];
			list.push(row.at);
			moments.set(row.participantId, list);
		}
	}
	return moments;
}

/** What the record says of how one participant has been mailed, for the editor's delivery panel (card 2697, Q13). */
export type DeliveryFacts = {
	/** Their latest record-bearing mail, the latest by moment as `lastMailAt` reads it, and that mail's own `mail_outcome` detail (`of` its event), or null for none yet. */
	lastMail: { eventId: number; kind: EventKind; at: Stamp; resend: boolean; outcome: Record<string, unknown> | null } | null;
	/** The moment of every record-bearing mail, oldest first: the daily cap counts those of the last 24 hours. */
	mailMoments: Stamp[];
	/** Their latest `mail_skipped`: the mail and the reason, as written. */
	lastSkip: { mail: string; reason: string; at: Stamp } | null;
	/** Their latest `link_revoked`: the reason, as written. */
	lastRevoked: { reason: string; at: Stamp } | null;
};

/**
 * How each participant of the decision has been mailed, by participant id,
 * in one read of its events (card 2697, Q13): their latest record-bearing
 * mail with its outcome, the moments of all of them, their latest skip and
 * their latest link revocation. A participant with none of these is not in
 * the map. Facts as recorded: the words are the reader's to make. Nothing
 * of a response is read.
 */
export function deliveryOf(decisionId: number): Map<number, DeliveryFacts> {
	const events = db
		.select({ id: decisionEvents.id, participantId: decisionEvents.participantId, kind: decisionEvents.kind, at: decisionEvents.createdAt, detail: decisionEvents.detail })
		.from(decisionEvents)
		.where(
			and(
				eq(decisionEvents.decisionId, decisionId),
				isNotNull(decisionEvents.participantId),
				inArray(decisionEvents.kind, [...MAIL_KINDS, 'mail_outcome', 'mail_skipped', 'link_revoked'])
			)
		)
		.orderBy(asc(decisionEvents.id))
		.all();
	const facts = new Map<number, DeliveryFacts>();
	const outcomes = new Map<number, Record<string, unknown>>();
	for (const event of events) {
		if (event.participantId === null) continue;
		let mine = facts.get(event.participantId);
		if (mine === undefined) {
			mine = { lastMail: null, mailMoments: [], lastSkip: null, lastRevoked: null };
			facts.set(event.participantId, mine);
		}
		const detail = detailOf(event.detail);
		if ((MAIL_KINDS as readonly string[]).includes(event.kind)) {
			mine.mailMoments.push(event.at);
			// The latest by moment, as lastMailAt's max(created_at) reads it; the later event on a tie.
			if (mine.lastMail === null || event.at >= mine.lastMail.at) {
				mine.lastMail = { eventId: event.id, kind: event.kind as EventKind, at: event.at, resend: detail.resend === true, outcome: null };
			}
		} else if (event.kind === 'mail_outcome') {
			if (typeof detail.of === 'number') outcomes.set(detail.of, detail);
		} else if (event.kind === 'mail_skipped') {
			mine.lastSkip = { mail: typeof detail.mail === 'string' ? detail.mail : '', reason: typeof detail.reason === 'string' ? detail.reason : '', at: event.at };
		} else {
			mine.lastRevoked = { reason: typeof detail.reason === 'string' ? detail.reason : '', at: event.at };
		}
	}
	for (const mine of facts.values()) {
		mine.mailMoments.sort();
		if (mine.lastMail !== null) mine.lastMail.outcome = outcomes.get(mine.lastMail.eventId) ?? null;
	}
	return facts;
}

// ─── What one account has asked for, across decisions (card 2697) ────────────

/**
 * The moments of the account's events of `kind` since `since`, oldest first,
 * across every decision, read by `actor_user_id`
 * (`idx_decision_events_actor_user_id`). A deleted decision takes its events
 * with it, so the service also holds an allowance in memory (Q2, Q23).
 */
function actedSince(userId: number, kinds: readonly EventKind[], since: Stamp): Stamp[] {
	return db
		.select({ at: decisionEvents.createdAt })
		.from(decisionEvents)
		.where(and(eq(decisionEvents.actorUserId, userId), inArray(decisionEvents.kind, [...kinds]), gte(decisionEvents.createdAt, since)))
		.orderBy(asc(decisionEvents.createdAt), asc(decisionEvents.id))
		.all()
		.map((row) => row.at);
}

/** The moment of the account's latest dry run on any decision, or null for none (card 2697, decision 19). */
export function lastDryRunAt(userId: number): Stamp | null {
	const row = db
		.select({ at: max(decisionEvents.createdAt) })
		.from(decisionEvents)
		.where(and(eq(decisionEvents.actorUserId, userId), eq(decisionEvents.kind, 'dry_run')))
		.get();
	return row?.at ?? null;
}

/** The moments of the account's dry runs since `since`, on any decision, oldest first (card 2697, Q2). */
export function dryRunsSince(userId: number, since: Stamp): Stamp[] {
	return actedSince(userId, ['dry_run'], since);
}

/** The moments of the account's publishes since `since`, opening and re-publishing on any decision, oldest first (card 2697, Q23). */
export function publishesSince(userId: number, since: Stamp): Stamp[] {
	return actedSince(userId, ['published'], since);
}

/**
 * The moments of the record mails the account has caused since `since`, on
 * any decision, oldest first, one for each participant mailed (card 2697's
 * code review, part B, S2): the invitations, asked again and told of a
 * change, the events a mail writes as it is asked for, by the caller. A
 * withdrawal and a ruling are not counted: each is sent once, and must be.
 */
export function recordMailsSince(userId: number, since: Stamp): Stamp[] {
	return actedSince(userId, TOLD_KINDS, since);
}

/**
 * The person of the people directory whose account is `userId`, or null for
 * none (`people.user_id` is unique): the one address a dry run may go to
 * (card 2697, Q26).
 */
export function personOfAccount(userId: number): Person | null {
	return db.select().from(people).where(eq(people.userId, userId)).get() ?? null;
}

// ─── A participant's own part (card 2677) ────────────────────────────────────

/** A participant's responses that are counted as one (`RESPONSE_KINDS`, card 2679 F3): never a concern. */
const counted = (participantId: number) => and(eq(decisionResponses.participantId, participantId), inArray(decisionResponses.kind, [...RESPONSE_KINDS]));

/** The participant's latest response in `round`, or null for none: what the next one replaces (decision 11). A concern is none (card 2679, F3). */
export function latestResponse(participantId: number, round: number): DecisionResponse | null {
	return (
		db
			.select()
			.from(decisionResponses)
			.where(and(counted(participantId), eq(decisionResponses.round, round)))
			.orderBy(desc(decisionResponses.id))
			.limit(1)
			.get() ?? null
	);
}

/** How many responses the participant has given in `round`, for the write's cap (decision 11). Concerns are not counted (card 2679, F3). */
export function responsesInRound(participantId: number, round: number): number {
	const row = db
		.select({ n: count() })
		.from(decisionResponses)
		.where(and(counted(participantId), eq(decisionResponses.round, round)))
		.get();
	return row?.n ?? 0;
}

/**
 * The participant's own responses as the page shows them: the latest in
 * `round`, and, when there is none, the latest of an earlier round, which the
 * page shows as for an earlier version (design 4.7). A concern is neither
 * (card 2679, F3).
 */
export function ownResponses(participantId: number, round: number): { current: OwnResponse | null; earlier: OwnResponse | null } {
	const current = latestResponse(participantId, round);
	if (current !== null) return { current: ownResponseOf(current), earlier: null };
	const earlier = db
		.select()
		.from(decisionResponses)
		.where(and(counted(participantId), lt(decisionResponses.round, round)))
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
