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
 * Card 2678 adds `decision_questions`, which is not insert-only, and is
 * settled once instead (migration 0061's header is wrong to call it
 * insert-only): the answer, its author, its agent flag and its review are
 * columns of the question row. A question is inserted once
 * (`appendQuestion`), and its answer settled once by one of three guarded
 * updates, each of which changes the row only from the state its `WHERE`
 * names and answers whether it did: a person's or an agent's answer to an
 * unanswered question (`recordAnswer`), and an agent's unreviewed draft
 * published (`recordDraftPublished`) or replaced by a person's answer
 * (`recordDraftReplaced`). Either leaves the row outside both guards. These
 * are the only writes of the table in `src` but the restore and the cascade;
 * the same scan pins each update's `.set` keys and `WHERE` guard.
 *
 * `appendEvent` refuses an event naming a participant on a draft (comment
 * 5599): a draft's participant rows may be deleted freely only because no
 * event names them. An event's `detail` never holds a token, a hash, or a
 * mail server's words.
 *
 * Card 2680 adds the reads of the register, the person record and the record
 * view, each a read alone: a decision's events page by page
 * (`recordEventsOf`), each participant's events (`eventsOfParticipants`,
 * bounded in SQL), responses, concerns and questions, a page's participants
 * at once (`responsesOfParticipants`, `concernsOfParticipants`,
 * `questionsByParticipants`, its code review's F2), the events of some kinds
 * on many decisions (`eventsOfKindsOn`), and the rounds and counted responses
 * of many decisions at once (`roundsOf`, `countedInRound`); and the two
 * allow-lists of what is shown of an event: `OWN_RECORD_EVENTS`, what a person
 * is shown of their own participation, and `RECORD_DETAIL`, the shown keys of
 * each kind's detail, exhaustive by kind.
 *
 * Card 2685 adds the closing-date reminder's kind, `reminded`, written by
 * decision-reminders.ts through `appendEvent` alone (no new insert), and its
 * reads: the reminders of a round (`remindedIn`, `reminderOf`), each
 * participant's asking mail of the round (`askingMailsOf`) and whether their
 * role, address, account or inclusion changed since (`changedSinceAsked`,
 * `CHANGE_KINDS`; the code review's S1 added `removed` and `re_included`). A reminder
 * starts the 10-minute rest (`REST_KINDS`: `lastMailAt` and `deliveryOf`'s
 * `lastRestAt`), and is not counted toward the per-participant daily cap,
 * which reads `MAIL_KINDS` alone. Migration 0063's partial unique index holds one
 * `reminded` per participant per round.
 *
 * Card 2738 adds `reachedInRound`, whom the current round's request reached,
 * which an early ruling writes on each `cut_off` (`{ reached }`).
 *
 * Plain functions with no caller, called inside a service write's
 * transaction, or by the mail effect in a transaction of its own.
 */
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, gt, lt, lte, max, ne, notInArray, or, sql } from 'drizzle-orm';
import { db } from './db';
import {
	decisionEvents,
	decisionOptions,
	decisionQuestions,
	decisionResponses,
	decisionRulings,
	decisionVersions,
	decisions,
	people,
	peopleGroupMembers,
	peopleGroups,
	type Decision,
	type DecisionQuestion,
	type DecisionResponse,
	type DecisionRuling,
	type DecisionVersion,
	type Person
} from './db/schema';
import type { SessionUser } from './auth';
import type { ActivitySource } from './logActivity';
import type { OwnResponse } from '$lib/decision-view-types';
import type { ToldMail } from '$lib/decision-words';
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
	'concern_raised',
	// Card 2678 (decision 14): a question `{ questionId, notices, signedIn? }` naming the participant; its answer `{ questionId,
	// role, agentDrafted, notice }`; an agent's draft published `{ questionId, notice }`; and one replaced by a person's answer
	// `{ questionId, role, discarded: { text, byName, at }, notice }`. None of the last three names a participant.
	'question_asked',
	'question_answered',
	'answer_published',
	'answer_replaced',
	// Card 2685 (decision 11): the one closing-date reminder of a round, naming the participant, `version_number` the round,
	// `detail` null, by DumpFire; its `mail_outcome { of, mail: 'reminder', delivered, problem? }` follows. Held to one per
	// participant per round by migration 0063's partial unique index.
	'reminded'
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
 * events and `concern_raised`; and card 2678's four question events (decision
 * 2), whose detail holds whom each notice went to and its outcome, the asker
 * (`question_asked` names the participant) and a discarded draft. A binding
 * rule on the cards that read the record: card 2680's record shows them
 * behind `record` (`['admin', 'decider']`) alone, and card 2689's webhooks
 * never carry them. A participant's own questions are shown them from the
 * question rows, never from these events.
 */
export const DECIDER_ONLY_EVENTS: readonly EventKind[] = [
	'ruled',
	'cut_off',
	'concern_raised',
	'question_asked',
	'question_answered',
	'answer_published',
	'answer_replaced'
];

/**
 * Card 2678's four question events (card 2682, D31): an API key reading the
 * record is given each with no participant, no actor's name and no moment,
 * which together could name who asked; and a key's page filtered by a
 * participant leaves them out, as `question_asked` names its asker.
 */
export const QUESTION_EVENTS: readonly EventKind[] = ['question_asked', 'question_answered', 'answer_published', 'answer_replaced'];

/**
 * The events a person is shown of their own participation on their own
 * record (card 2680, decision 13): each as its kind, moment and version, and
 * `seen` with its stage, and nothing else of it. An allow-list, so that a
 * kind a later card adds is shown to nobody on their own record until it is
 * named here. Never `cut_off`, a question event, a mail outcome or skip, or an
 * account or address event; disjoint from `DECIDER_ONLY_EVENTS`
 * (tests/decision-register.test.ts, case 66).
 */
export const OWN_RECORD_EVENTS: readonly EventKind[] = [
	'included',
	're_included',
	'role_changed',
	'removed',
	'invited',
	'asked_again',
	'told_of_change',
	'told_withdrawn',
	'told_ruling',
	'seen',
	'responded',
	// Card 2685 (decision 11, S8): shown as its kind, moment and round, as `invited` is. Its words claim no delivery, as the
	// own record never shows a mail outcome.
	'reminded'
];

/**
 * How one key of an event's stored detail is shown on the record (card 2680,
 * decision 16, S3):
 *
 *   - `'value'`: a string, number, boolean or null, as stored; an object or
 *     an array found there is dropped;
 *   - `'admin'`: as `'value'`, to an administrator alone;
 *   - `{ decision }`: the id of another decision, stored under that key, shown
 *     under this one through `namedFor` (its id and title to a viewer who may
 *     view it, nothing to anyone else);
 *   - `'option'`: the stored `optionId`, shown as the option's label, or null;
 *   - `{ fields, admin? }`: a nested object, only these primitive fields of
 *     it, and with `admin` to an administrator alone;
 *   - `{ each }`: an array of objects, each with only these primitive fields.
 */
export type DetailRule =
	| 'value'
	| 'admin'
	| { decision: string }
	| 'option'
	| { fields: readonly string[]; admin?: true }
	| { each: readonly string[] };

/** What is shown of one kind's detail: every shown key and its rule. A key not named is dropped. */
export type DetailSpec = Readonly<Record<string, DetailRule>>;

/** The signed-in account a link holder's browser was signed in as: its name, to an administrator alone (card 2680, S3). */
const SIGNED_IN: DetailRule = { fields: ['name'], admin: true };

/**
 * What the record view shows of each kind's detail (card 2680, decision 16,
 * S3), read from every writer of each kind: exhaustive, so that a kind added
 * to `EVENT_KINDS` with no entry here fails `npm run check`. No shown key,
 * and no field named, ends in `Id`: the ids the details hold (`fromUserId`,
 * `toUserId`, `userId`, `of`, `questionId`, `responseId`, `upToResponseId`,
 * `optionId`, `productOwnerUserId`, `byDecisionId`, `supersedes`, and those
 * nested in `notices[]`, `omitted[]` and `signedIn`) are never shown as they
 * are stored: another decision is named through `namedFor`, an option by its
 * label, and the rest dropped. `recordEntryOf` (decision-register.ts) builds
 * a new object from this alone.
 */
export const RECORD_DETAIL: Readonly<Record<EventKind, DetailSpec>> = {
	created: { decider: 'value', supersedes: { decision: 'supersedes' } },
	decider_changed: { fromName: 'value', toName: 'value' },
	published: { asksAgain: 'value', changeNote: 'value' },
	opened: { closesAt: 'value' },
	included: { role: 'value', hadAccount: 'value' },
	re_included: { role: 'value', hadAccount: 'value' },
	role_changed: { from: 'value', to: 'value' },
	removed: {},
	link_issued: { replaced: 'value' },
	link_revoked: { reason: 'value' },
	invited: { resend: 'value' },
	asked_again: { resend: 'value' },
	told_of_change: { resend: 'value' },
	told_withdrawn: { resend: 'value' },
	told_ruling: { resend: 'value' },
	mail_skipped: { mail: 'value', reason: 'value' },
	mail_outcome: { mail: 'value', delivered: 'value', problem: 'value' },
	closed: {},
	extended: { from: 'value', to: 'value' },
	withdrawn: { reason: 'value' },
	account_attached: {},
	account_cleared: {},
	// Addresses are administrators' everywhere else (card 2680, section 8: not the decider's, as 2675 had it).
	address_changed: { from: 'admin', to: 'admin' },
	dry_run: {},
	seen: { stage: 'value', signedIn: SIGNED_IN },
	responded: { statement: 'value', signedIn: SIGNED_IN },
	ruled: { option: 'option', early: 'value', againstResponses: 'value', supersededOld: 'value' },
	// Card 2738 (D2): whether the round's request ever reached them; none on a cut-off recorded before it.
	cut_off: { reached: 'value' },
	superseded: { by: { decision: 'byDecisionId' } },
	results_released: { omitted: { each: ['field'] } },
	concern_raised: { notice: 'value', signedIn: SIGNED_IN },
	// Whom each notice went to, and its outcome, are dropped (`notices`).
	question_asked: { signedIn: SIGNED_IN },
	question_answered: { role: 'value', agentDrafted: 'value' },
	answer_published: {},
	answer_replaced: { role: 'value', discarded: { fields: ['text', 'byName', 'at'] } },
	// Card 2685: no detail is written; the round is the event's version.
	reminded: {}
};

/**
 * The events a record-bearing mail writes for its participant (decision 31),
 * and since card 2708 (D1) the mails a participant's banner tells them of.
 * The type check holds `MAIL_KINDS` and `ToldMail['kind']` to the same set,
 * both ways: the `satisfies` here makes every entry an `EventKind` and a
 * `ToldMail` kind, and `TOLD_KINDS_ARE_MAILS` below makes every `ToldMail`
 * kind an entry here. Neither can gain or lose a kind alone.
 */
const MAIL_KINDS = ['invited', 'asked_again', 'told_of_change', 'told_withdrawn', 'told_ruling'] as const satisfies readonly (EventKind & ToldMail['kind'])[];

/**
 * The check back from `ToldMail` to `MAIL_KINDS` (card 2708's code review): a
 * record keyed by every `ToldMail` kind, exhaustive (a kind missing, or one
 * `ToldMail` does not have, fails the type check), whose value for each must
 * be an entry of `MAIL_KINDS` (a `ToldMail` kind that is not one has the type
 * `never` here, which no value meets). Compile time alone: read nowhere.
 */
const TOLD_KINDS_ARE_MAILS: { readonly [K in ToldMail['kind']]: K & (typeof MAIL_KINDS)[number] } = {
	invited: 'invited',
	asked_again: 'asked_again',
	told_of_change: 'told_of_change',
	told_withdrawn: 'told_withdrawn',
	told_ruling: 'told_ruling'
};
void TOLD_KINDS_ARE_MAILS;

/**
 * The events that start the 10-minute rest before a participant's next
 * record mail (card 2685, decision 7, S6): the record-bearing mails and the
 * closing-date reminder. Only the rest reads these: the daily cap
 * (`mailsSince`, `deliveryOf`'s `mailMoments`) and the delivery panel's last
 * mail read `MAIL_KINDS` alone, so a reminder takes none of an editor's
 * Resends.
 */
const REST_KINDS: readonly EventKind[] = [...MAIL_KINDS, 'reminded'];

/**
 * The events that change who a participant is, how they are reached, or
 * whether they are one at all (card 2685, decision 4 clause 8; code review
 * S1 added the last two): a reminder reminds only of a mail sent to the same
 * person, in the same role, by the same route, in the same inclusion. A
 * removal or a re-inclusion after the asking mail passes them over, read at
 * the write and again at the send; a re-inclusion's own invitation, written
 * after it, is the next asking mail.
 */
const CHANGE_KINDS: readonly EventKind[] = ['role_changed', 'address_changed', 'account_attached', 'account_cleared', 're_included', 'removed'];

/** The events that say whether a participant's row held an account on this decision (decision 16). */
const ACCOUNT_KINDS: readonly EventKind[] = ['included', 're_included', 'account_attached', 'account_cleared'];

/**
 * The record mails counted against the caller's daily cap (`recordMailsSince`,
 * card 2697's code review, part B, S2): never the withdrawal or the ruling,
 * each sent once, and must be. Until card 2708 (F1) the banner read these too;
 * it reads `MAIL_KINDS` now, so widening its mails cannot widen the cap.
 */
const CALLER_CAPPED_KINDS: readonly EventKind[] = ['invited', 'asked_again', 'told_of_change'];

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

// ─── Clarification questions, settled once (card 2678, decision 7) ───────────

/**
 * Append one question (card 2678), `asked_at` stamped, with no answer: the
 * one insert into the questions. `askerName` is the participant row's
 * snapshot name; `via` the way it was asked.
 */
export function appendQuestion(q: {
	decisionId: number;
	participantId: number;
	askerName: string;
	question: string;
	askedInVersion: number;
	via: 'session' | 'link' | 'api';
}): DecisionQuestion {
	return db
		.insert(decisionQuestions)
		.values({
			decisionId: q.decisionId,
			participantId: q.participantId,
			askerName: q.askerName,
			question: q.question,
			askedInVersion: q.askedInVersion,
			via: q.via,
			askedAt: stamp()
		})
		.returning()
		.get();
}

/**
 * Answer a question not yet answered, by `by`, `answered_at` stamped, and
 * flagged as an agent's draft when `agentDrafted` (decision 8): whether it
 * changed the row. An answered question, a draft among them, is left as it is.
 */
export function recordAnswer(questionId: number, answer: string, by: RecordActor, agentDrafted: boolean): boolean {
	return (
		db
			.update(decisionQuestions)
			.set({ answer, answeredBy: by.userId, answeredByName: by.name, answeredAt: stamp(), answerAgentDrafted: agentDrafted })
			.where(and(eq(decisionQuestions.id, questionId), isNull(decisionQuestions.answer)))
			.run().changes === 1
	);
}

/**
 * Publish an agent's draft answer not yet reviewed, by `by`, `answer_reviewed_at`
 * stamped (decision 8): whether it changed the row. A person's answer, one
 * published already and a question unanswered are left as they are.
 */
export function recordDraftPublished(questionId: number, by: RecordActor): boolean {
	return (
		db
			.update(decisionQuestions)
			.set({ answerReviewedBy: by.userId, answerReviewedAt: stamp() })
			.where(
				and(
					eq(decisionQuestions.id, questionId),
					isNotNull(decisionQuestions.answer),
					eq(decisionQuestions.answerAgentDrafted, true),
					isNull(decisionQuestions.answerReviewedAt)
				)
			)
			.run().changes === 1
	);
}

/**
 * Replace an agent's draft answer not yet reviewed with a person's, by `by`,
 * `answered_at` stamped and the agent flag cleared (decision 8, S1): whether
 * it changed the row. The service copies the draft into the record first. A
 * person's answer and a published draft are left as they are.
 */
export function recordDraftReplaced(questionId: number, answer: string, by: RecordActor): boolean {
	return (
		db
			.update(decisionQuestions)
			.set({ answer, answeredBy: by.userId, answeredByName: by.name, answeredAt: stamp(), answerAgentDrafted: false })
			.where(and(eq(decisionQuestions.id, questionId), eq(decisionQuestions.answerAgentDrafted, true), isNull(decisionQuestions.answerReviewedAt)))
			.run().changes === 1
	);
}

/** The decision's questions, oldest first (card 2678). */
export function questionsOf(decisionId: number): DecisionQuestion[] {
	return db.select().from(decisionQuestions).where(eq(decisionQuestions.decisionId, decisionId)).orderBy(asc(decisionQuestions.id)).all();
}

/** The question `questionId` if it is one of this decision's, or null (card 2678). */
export function questionOn(decisionId: number, questionId: number): DecisionQuestion | null {
	return (
		db
			.select()
			.from(decisionQuestions)
			.where(and(eq(decisionQuestions.id, questionId), eq(decisionQuestions.decisionId, decisionId)))
			.get() ?? null
	);
}

/** The questions one participant has asked, oldest first (card 2678): the per-participant cap and rest read them. */
export function questionsBy(participantId: number): DecisionQuestion[] {
	return db.select().from(decisionQuestions).where(eq(decisionQuestions.participantId, participantId)).orderBy(asc(decisionQuestions.id)).all();
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

// ─── What the register, the person record and the record view read (card 2680) ─

/** One event of the record as it is read for showing: its detail parsed, nothing projected yet. */
export type RecordEventRow = {
	id: number;
	kind: string;
	participantId: number | null;
	versionNumber: number | null;
	detail: Record<string, unknown>;
	actorName: string;
	source: string;
	at: Stamp;
};

const recordEventColumns = {
	id: decisionEvents.id,
	kind: decisionEvents.kind,
	participantId: decisionEvents.participantId,
	versionNumber: decisionEvents.versionNumber,
	detail: decisionEvents.detail,
	actorName: decisionEvents.actorName,
	source: decisionEvents.source,
	at: decisionEvents.createdAt
};

/**
 * The decision's events in id order, oldest first (card 2680, decision 16):
 * those naming `participantId` alone when it is given, those after `afterId`
 * when it is given, none of the kinds `withoutKinds` names (card 2682, D31:
 * in the query, so that `limit` and the page's `next` stay exact), and at
 * most `limit`. Read by `idx_decision_events_decision_id_created_at`, or
 * `_participant_id`.
 */
export function recordEventsOf(
	decisionId: number,
	opts: { participantId?: number; afterId?: number; withoutKinds?: readonly EventKind[]; limit: number }
): RecordEventRow[] {
	return db
		.select(recordEventColumns)
		.from(decisionEvents)
		.where(
			and(
				eq(decisionEvents.decisionId, decisionId),
				opts.participantId === undefined ? undefined : eq(decisionEvents.participantId, opts.participantId),
				opts.afterId === undefined ? undefined : gt(decisionEvents.id, opts.afterId),
				opts.withoutKinds === undefined || opts.withoutKinds.length === 0 ? undefined : notInArray(decisionEvents.kind, [...opts.withoutKinds])
			)
		)
		.orderBy(asc(decisionEvents.id))
		.limit(opts.limit)
		.all()
		.map((event) => ({ ...event, detail: detailOf(event.detail) }));
}

/** Rows grouped by a key, each group in the order the rows came. */
function groupedBy<T>(rows: readonly T[], keyOf: (row: T) => number | null): Map<number, T[]> {
	const found = new Map<number, T[]>();
	for (const row of rows) {
		const key = keyOf(row);
		if (key === null) continue;
		const list = found.get(key) ?? [];
		list.push(row);
		found.set(key, list);
	}
	return found;
}

/**
 * The first `opts.perParticipant` events naming each participant, oldest
 * first, by participant id, of `opts.kinds` alone when they are given (card
 * 2680, decisions 9, 13 and 15). Bounded in SQL, by each participant's
 * `row_number()` (code review F2): a participant named by tens of thousands of
 * events costs no more than the bound, and the page asks one more than it
 * shows to know there are more. Read in as few queries as `IDS_AT_ONCE`
 * allows. A participant named by none is not in the map.
 */
export function eventsOfParticipants(
	participantIds: readonly number[],
	opts: { kinds?: readonly EventKind[]; perParticipant: number }
): Map<number, RecordEventRow[]> {
	if (!Number.isSafeInteger(opts.perParticipant) || opts.perParticipant < 1) {
		throw new Error(`eventsOfParticipants: perParticipant must be a whole number above 0, and it is ${opts.perParticipant}`);
	}
	const found = new Map<number, RecordEventRow[]>();
	if (opts.kinds !== undefined && opts.kinds.length === 0) return found;
	const unique = [...new Set(participantIds)];
	for (let from = 0; from < unique.length; from += IDS_AT_ONCE) {
		const ranked = db
			.select({
				...recordEventColumns,
				rank: sql<number>`row_number() over (partition by ${decisionEvents.participantId} order by ${decisionEvents.id})`.as('rank')
			})
			.from(decisionEvents)
			.where(
				and(
					inArray(decisionEvents.participantId, unique.slice(from, from + IDS_AT_ONCE)),
					opts.kinds === undefined ? undefined : inArray(decisionEvents.kind, [...opts.kinds])
				)
			)
			.as('ranked');
		const rows = db
			.select({
				id: ranked.id,
				kind: ranked.kind,
				participantId: ranked.participantId,
				versionNumber: ranked.versionNumber,
				detail: ranked.detail,
				actorName: ranked.actorName,
				source: ranked.source,
				at: ranked.at
			})
			.from(ranked)
			.where(lte(ranked.rank, opts.perParticipant))
			.orderBy(asc(ranked.id))
			.all();
		for (const [participantId, list] of groupedBy(rows, (row) => row.participantId)) {
			found.set(
				participantId,
				list.map((row) => ({ ...row, detail: detailOf(row.detail) }))
			);
		}
	}
	return found;
}

/**
 * Every response of each participant that is counted as one
 * (`RESPONSE_KINDS`), replaced ones too, in id order, by participant id (card
 * 2680, decision 9; batched by code review F2): never a concern, which
 * `concernsOfParticipants` reads. One with none is not in the map.
 */
export function responsesOfParticipants(participantIds: readonly number[]): Map<number, DecisionResponse[]> {
	const unique = [...new Set(participantIds)];
	const rows: DecisionResponse[] = [];
	for (let from = 0; from < unique.length; from += IDS_AT_ONCE) {
		rows.push(
			...db
				.select()
				.from(decisionResponses)
				.where(and(inArray(decisionResponses.participantId, unique.slice(from, from + IDS_AT_ONCE)), inArray(decisionResponses.kind, [...RESPONSE_KINDS])))
				.orderBy(asc(decisionResponses.id))
				.all()
		);
	}
	return groupedBy(rows, (row) => row.participantId);
}

/** The concerns each participant raised, in id order, by participant id (`concernsOf` for many, code review F2). One with none is not in the map. */
export function concernsOfParticipants(participantIds: readonly number[]): Map<number, DecisionResponse[]> {
	const unique = [...new Set(participantIds)];
	const rows: DecisionResponse[] = [];
	for (let from = 0; from < unique.length; from += IDS_AT_ONCE) {
		rows.push(
			...db
				.select()
				.from(decisionResponses)
				.where(and(inArray(decisionResponses.participantId, unique.slice(from, from + IDS_AT_ONCE)), eq(decisionResponses.kind, 'concern')))
				.orderBy(asc(decisionResponses.id))
				.all()
		);
	}
	return groupedBy(rows, (row) => row.participantId);
}

/** The questions each participant asked, oldest first, by participant id (`questionsBy` for many, code review F2). One with none is not in the map. */
export function questionsByParticipants(participantIds: readonly number[]): Map<number, DecisionQuestion[]> {
	const unique = [...new Set(participantIds)];
	const rows: DecisionQuestion[] = [];
	for (let from = 0; from < unique.length; from += IDS_AT_ONCE) {
		rows.push(
			...db
				.select()
				.from(decisionQuestions)
				.where(inArray(decisionQuestions.participantId, unique.slice(from, from + IDS_AT_ONCE)))
				.orderBy(asc(decisionQuestions.id))
				.all()
		);
	}
	return groupedBy(rows, (row) => row.participantId);
}

/**
 * The events of `kinds` on each of the decisions, in id order, each with its
 * kind and its detail read (`eventsOfKind` for many decisions and kinds, code
 * review F2), in as few queries as `IDS_AT_ONCE` allows.
 */
export function eventsOfKindsOn(decisionIds: readonly number[], kinds: readonly EventKind[]): { decisionId: number; kind: string; detail: Record<string, unknown> }[] {
	const unique = [...new Set(decisionIds)];
	const found: { decisionId: number; kind: string; detail: Record<string, unknown> }[] = [];
	if (kinds.length === 0) return found;
	for (let from = 0; from < unique.length; from += IDS_AT_ONCE) {
		const rows = db
			.select({ decisionId: decisionEvents.decisionId, kind: decisionEvents.kind, detail: decisionEvents.detail })
			.from(decisionEvents)
			.where(and(inArray(decisionEvents.decisionId, unique.slice(from, from + IDS_AT_ONCE)), inArray(decisionEvents.kind, [...kinds])))
			.orderBy(asc(decisionEvents.id))
			.all();
		for (const row of rows) found.push({ ...row, detail: detailOf(row.detail) });
	}
	return found;
}

/**
 * The round a response is given now on each decision, by decision id: the
 * number of its latest version that asked again, or 0 (card 2680, decision
 * 3). `currentRound` for many decisions, in one grouped read per
 * `IDS_AT_ONCE`.
 */
export function roundsOf(decisionIds: readonly number[]): Map<number, number> {
	const unique = [...new Set(decisionIds)];
	const rounds = new Map<number, number>(unique.map((id) => [id, 0]));
	for (let from = 0; from < unique.length; from += IDS_AT_ONCE) {
		const rows = db
			.select({ decisionId: decisionVersions.decisionId, round: max(decisionVersions.number) })
			.from(decisionVersions)
			.where(and(inArray(decisionVersions.decisionId, unique.slice(from, from + IDS_AT_ONCE)), eq(decisionVersions.asksAgain, true)))
			.groupBy(decisionVersions.decisionId)
			.all();
		for (const row of rows) rounds.set(row.decisionId, row.round ?? 0);
	}
	return rounds;
}

/**
 * The participants among `pairs` who have given a counted response
 * (`RESPONSE_KINDS`) in their pair's round (card 2680, decision 3): what
 * `latestResponse(participantId, round) !== null` says of one, for many, in
 * one grouped read per `IDS_AT_ONCE`. A concern is none.
 */
export function countedInRound(pairs: readonly { participantId: number; round: number }[]): Set<number> {
	const roundOf = new Map(pairs.map((pair) => [pair.participantId, pair.round]));
	const ids = [...roundOf.keys()];
	const answered = new Set<number>();
	for (let from = 0; from < ids.length; from += IDS_AT_ONCE) {
		const rows = db
			.select({ participantId: decisionResponses.participantId, round: decisionResponses.round })
			.from(decisionResponses)
			.where(and(inArray(decisionResponses.participantId, ids.slice(from, from + IDS_AT_ONCE)), inArray(decisionResponses.kind, [...RESPONSE_KINDS])))
			.groupBy(decisionResponses.participantId, decisionResponses.round)
			.all();
		for (const row of rows) if (roundOf.get(row.participantId) === row.round) answered.add(row.participantId);
	}
	return answered;
}

/**
 * The moment of each participant's latest record-bearing mail event or
 * closing-date reminder, by participant id; one with none is not in the map
 * (decision 31). The reminder is read too (card 2685, decision 7, S6), so
 * that no re-send, re-publish or re-inclusion mails a participant within 10
 * minutes of one: this is the rest's read alone, and the daily cap's,
 * `mailsSince`, does not count it.
 */
export function lastMailAt(participantIds: number[]): Map<number, Stamp> {
	const latest = new Map<number, Stamp>();
	for (let from = 0; from < participantIds.length; from += IDS_AT_ONCE) {
		const ids = participantIds.slice(from, from + IDS_AT_ONCE);
		const rows = db
			.select({ participantId: decisionEvents.participantId, at: max(decisionEvents.createdAt) })
			.from(decisionEvents)
			.where(and(inArray(decisionEvents.participantId, ids), inArray(decisionEvents.kind, [...REST_KINDS])))
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
	/**
	 * The moment of their latest record-bearing mail or closing-date reminder
	 * (card 2685, decision 7, S6), or null for neither: what the 10-minute rest
	 * runs from, as `lastMailAt` reads it, so that the panel and the write agree.
	 */
	lastRestAt: Stamp | null;
	/** Their latest `mail_skipped`: the mail and the reason, as written, and its event (the panel shows it only where it is newer than `lastMail`, card 2740's code review). */
	lastSkip: { eventId: number; mail: string; reason: string; at: Stamp } | null;
	/** Their latest `link_revoked`: the reason, as written. */
	lastRevoked: { reason: string; at: Stamp } | null;
};

/**
 * How each participant of the decision has been mailed, by participant id,
 * in one read of its events (card 2697, Q13): their latest record-bearing
 * mail with its outcome, the moments of all of them, the moment the rest runs
 * from (`lastRestAt`, a closing-date reminder's included, card 2685), their
 * latest skip and their latest link revocation. A participant with none of these is not in
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
				inArray(decisionEvents.kind, [...REST_KINDS, 'mail_outcome', 'mail_skipped', 'link_revoked'])
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
			mine = { lastMail: null, mailMoments: [], lastRestAt: null, lastSkip: null, lastRevoked: null };
			facts.set(event.participantId, mine);
		}
		const detail = detailOf(event.detail);
		if ((REST_KINDS as readonly string[]).includes(event.kind) && (mine.lastRestAt === null || event.at > mine.lastRestAt)) mine.lastRestAt = event.at;
		if (event.kind === 'reminded') {
			// Card 2685: the rest's moment alone (above); a reminder is no record mail, so not the panel's last mail nor the cap's.
			continue;
		}
		if ((MAIL_KINDS as readonly string[]).includes(event.kind)) {
			mine.mailMoments.push(event.at);
			// The latest by moment, as lastMailAt's max(created_at) reads it; the later event on a tie.
			if (mine.lastMail === null || event.at >= mine.lastMail.at) {
				mine.lastMail = { eventId: event.id, kind: event.kind as EventKind, at: event.at, resend: detail.resend === true, outcome: null };
			}
		} else if (event.kind === 'mail_outcome') {
			if (typeof detail.of === 'number') outcomes.set(detail.of, detail);
		} else if (event.kind === 'mail_skipped') {
			mine.lastSkip = { eventId: event.id, mail: typeof detail.mail === 'string' ? detail.mail : '', reason: typeof detail.reason === 'string' ? detail.reason : '', at: event.at };
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

// ─── What the closing-date reminder reads (card 2685) ────────────────────────

/**
 * Each participant's `reminded` event ids in round `round`, ascending, by
 * participant id; one with none is not in the map (card 2685, decisions 3
 * and 9): empty for a participant who is due, and its first the one a
 * reminder must be to be sent.
 */
export function remindedIn(participantIds: readonly number[], round: number): Map<number, number[]> {
	const found = new Map<number, number[]>();
	for (let from = 0; from < participantIds.length; from += IDS_AT_ONCE) {
		const rows = db
			.select({ id: decisionEvents.id, participantId: decisionEvents.participantId })
			.from(decisionEvents)
			.where(
				and(
					inArray(decisionEvents.participantId, participantIds.slice(from, from + IDS_AT_ONCE)),
					eq(decisionEvents.kind, 'reminded'),
					eq(decisionEvents.versionNumber, round)
				)
			)
			.orderBy(asc(decisionEvents.id))
			.all();
		for (const row of rows) {
			if (row.participantId === null) continue;
			const list = found.get(row.participantId) ?? [];
			list.push(row.id);
			found.set(row.participantId, list);
		}
	}
	return found;
}

/** One `reminded` event, or null for none (card 2685, decision 9): what the reminder is for, read again just before it is sent. */
export function reminderOf(eventId: number): { decisionId: number; participantId: number; round: number } | null {
	const row = db
		.select({ decisionId: decisionEvents.decisionId, participantId: decisionEvents.participantId, round: decisionEvents.versionNumber })
		.from(decisionEvents)
		.where(and(eq(decisionEvents.id, eventId), eq(decisionEvents.kind, 'reminded')))
		.get();
	if (row === undefined || row.participantId === null || row.round === null) return null;
	return { decisionId: row.decisionId, participantId: row.participantId, round: row.round };
}

/**
 * Each participant's asking mail of round `round` on the decision (card
 * 2685, decision 4 clause 7), by participant id: their latest `invited` or
 * `asked_again`, by id, at or after the round's version's `published_at` (an
 * `invited` has no version, so it is read by moment), with whether its own
 * `mail_outcome` says it was delivered, null while none is written. One with
 * none, or a round with no version, is not in the map.
 */
export function askingMailsOf(
	decisionId: number,
	round: number,
	participantIds: readonly number[]
): Map<number, { eventId: number; at: Stamp; delivered: boolean | null }> {
	const found = new Map<number, { eventId: number; at: Stamp; delivered: boolean | null }>();
	const version = db
		.select({ publishedAt: decisionVersions.publishedAt })
		.from(decisionVersions)
		.where(and(eq(decisionVersions.decisionId, decisionId), eq(decisionVersions.number, round)))
		.get();
	if (version === undefined) return found;
	const delivered = new Map<number, boolean>();
	for (let from = 0; from < participantIds.length; from += IDS_AT_ONCE) {
		const ids = participantIds.slice(from, from + IDS_AT_ONCE);
		const rows = db
			.select({ id: decisionEvents.id, participantId: decisionEvents.participantId, kind: decisionEvents.kind, at: decisionEvents.createdAt, detail: decisionEvents.detail })
			.from(decisionEvents)
			.where(
				and(
					eq(decisionEvents.decisionId, decisionId),
					inArray(decisionEvents.participantId, ids),
					or(
						and(inArray(decisionEvents.kind, ['invited', 'asked_again']), gte(decisionEvents.createdAt, version.publishedAt)),
						eq(decisionEvents.kind, 'mail_outcome')
					)
				)
			)
			.orderBy(asc(decisionEvents.id))
			.all();
		for (const row of rows) {
			if (row.participantId === null) continue;
			if (row.kind === 'mail_outcome') {
				const detail = detailOf(row.detail);
				if (typeof detail.of === 'number') delivered.set(detail.of, detail.delivered === true);
			} else {
				found.set(row.participantId, { eventId: row.id, at: row.at, delivered: null });
			}
		}
	}
	for (const asking of found.values()) asking.delivered = delivered.get(asking.eventId) ?? null;
	return found;
}

/** The events that set a participant's role on a decision (card 2738): `included` and `re_included` by `role`, `role_changed` by `to`. */
const ROLE_KINDS: readonly EventKind[] = ['included', 're_included', 'role_changed'];

/**
 * The participants of `participants` whom round `round`'s request reached
 * (card 2738, D1), read from the record alone, never from an address or a
 * person's status now: one with, while their role was `consulted`, either
 *
 *   - an `invited` or `asked_again` whose own `mail_outcome` says
 *     `delivered: true`: any such mail, not only the latest (`askingMailsOf`
 *     keeps the latest), and an outcome not yet written is not delivered (as
 *     `mailedLinkOf`); or
 *   - a `seen { stage: 'question' }` of a version of the round
 *     (`version_number` at or above it): they opened the question, which is
 *     how an account holder is reached by account when no mail got through;
 *
 * and only one written while the decision was open for input in the round
 * (code review 2026-11-05, R1 and R2; `openForInputIn`): after the round's
 * own `published` event by id, never by moment, so that a mail of the round
 * before written in the same second is not counted; in a window no `closed`
 * has shut since; and before the closing time then in force. A mail sent to
 * one added after an early close, or a question seen after it, asked nothing
 * that could still be answered.
 *
 * The role at each event is replayed from `included`, `re_included` and
 * `role_changed` in id order; before the first of them, the first
 * `role_changed`'s `from`, or with none the row's role now. An invitation
 * delivered while informed asked nothing. A `removed` resets reach (R3,
 * refining D5): only what follows the latest re-inclusion counts. A round
 * with no `published` event reaches nobody. A read alone, in batches of
 * `IDS_AT_ONCE`.
 *
 * A known residual (R5): `seen` is written once per version and stage, so
 * one who saw the question while informed and was then made consulted has no
 * `seen` while consulted. Since card 2740 the role change sends them the
 * invitation (`setParticipants`), and once that is delivered they are
 * reached; only one whose invitation was held back, skipped or not delivered
 * still reads as not reached. It errs on that side.
 *
 * R6 (re-review 2026-11-05, separate card): for the same reason, a question
 * seen while the window was shut (after an early close) hides a later view
 * made once an extend reopened it, so that view records nothing and reads as
 * not reached. It errs on the "not reached" side.
 *
 * R7 (re-review 2026-11-05, accepted): an `invited` queued while the window
 * was open but delivered seconds after a close counts as reached, as the
 * mail is judged at its `invited` event and `stillToSend` does not check for
 * a close. The gap is seconds wide.
 */
export function reachedInRound(decisionId: number, round: number, participants: readonly { id: number; role: string }[]): Set<number> {
	const reached = new Set<number>();
	if (participants.length === 0) return reached;
	const openFor = openForInputIn(decisionId, round);
	if (openFor === null) return reached;
	const roleNow = new Map(participants.map((row) => [row.id, row.role]));
	type Row = { id: number; participantId: number | null; kind: string; at: Stamp; versionNumber: number | null; detail: Record<string, unknown> };
	const rows: Row[] = [];
	const ids = [...roleNow.keys()];
	const byParticipant = new Map<number, Row[]>(ids.map((id) => [id, []]));
	for (let from = 0; from < ids.length; from += IDS_AT_ONCE) {
		const batch = db
			.select({
				id: decisionEvents.id,
				participantId: decisionEvents.participantId,
				kind: decisionEvents.kind,
				at: decisionEvents.createdAt,
				versionNumber: decisionEvents.versionNumber,
				detail: decisionEvents.detail
			})
			.from(decisionEvents)
			.where(
				and(
					eq(decisionEvents.decisionId, decisionId),
					inArray(decisionEvents.participantId, ids.slice(from, from + IDS_AT_ONCE)),
					inArray(decisionEvents.kind, [...ROLE_KINDS, 'removed', 'invited', 'asked_again', 'mail_outcome', 'seen'])
				)
			)
			.orderBy(asc(decisionEvents.id))
			.all();
		for (const row of batch) {
			const read = { ...row, detail: detailOf(row.detail) };
			rows.push(read);
			if (row.participantId !== null) byParticipant.get(row.participantId)?.push(read);
		}
	}
	// Each batch is in id order and holds its own participants', so each participant's list is too.

	const delivered = new Set<number>();
	for (const row of rows) if (row.kind === 'mail_outcome' && typeof row.detail.of === 'number' && row.detail.delivered === true) delivered.add(row.detail.of);
	const roleOf = (row: Row): string | null => {
		const role = row.kind === 'role_changed' ? row.detail.to : row.detail.role;
		return typeof role === 'string' ? role : null;
	};

	for (const id of ids) {
		const mine = byParticipant.get(id) ?? [];
		// The role before any role event: the first role_changed's `from`, an inclusion's own role, or with neither the row's role now.
		const first = mine.find((row) => (ROLE_KINDS as readonly string[]).includes(row.kind));
		let role: string | null;
		if (first === undefined) role = roleNow.get(id) ?? null;
		else if (first.kind === 'role_changed') role = typeof first.detail.from === 'string' ? first.detail.from : null;
		else role = roleOf(first);
		let isReached = false;
		for (const row of mine) {
			// R3: a removal resets reach, and nothing counts until a re-inclusion gives a role again.
			if (row.kind === 'removed') {
				isReached = false;
				role = null;
				continue;
			}
			if ((ROLE_KINDS as readonly string[]).includes(row.kind)) {
				role = roleOf(row) ?? role;
				continue;
			}
			if (isReached || role !== 'consulted' || !openFor(row.id, row.at)) continue;
			const asked = (row.kind === 'invited' || row.kind === 'asked_again') && delivered.has(row.id);
			const saw = row.kind === 'seen' && row.detail.stage === 'question' && row.versionNumber !== null && row.versionNumber >= round;
			if (asked || saw) isReached = true;
		}
		if (isReached) reached.add(id);
	}
	return reached;
}

/** The decision-level events that open and close a decision for input (card 2738, code review R1), replayed in id order. */
const WINDOW_KINDS: readonly EventKind[] = ['published', 'closed', 'extended', 'ruled', 'withdrawn'];

/**
 * Whether an event of round `round`, by its id and moment, was written while
 * the decision was open for input (card 2738, code review 2026-11-05, R1 and
 * R2), or null where the round has no `published` event. Replayed from the
 * record: the round's own `published` (asking again) opens it; `closed`,
 * `ruled` and `withdrawn` shut it; `extended` opens it again; a later
 * `published` changes nothing, since in the current round (the only round
 * either caller reads, `currentRound`) it only tells: one that asked again
 * would be a later round's start (re-review 2026-11-05).
 * An event counts only after the round's `published` by id (never by
 * moment), in a window open at its id, and before the closing time in force
 * then: the `to` of the latest `extended` before it, else the `from` of the
 * first after it, else the decision's `closes_at` now (a decision's closing
 * time changes after opening by `extended` alone). Stamps are of one format,
 * so the text compares as the time.
 */
function openForInputIn(decisionId: number, round: number): ((id: number, at: Stamp) => boolean) | null {
	const events = db
		.select({ id: decisionEvents.id, kind: decisionEvents.kind, versionNumber: decisionEvents.versionNumber, detail: decisionEvents.detail })
		.from(decisionEvents)
		.where(and(eq(decisionEvents.decisionId, decisionId), inArray(decisionEvents.kind, [...WINDOW_KINDS])))
		.orderBy(asc(decisionEvents.id))
		.all()
		.map((row) => ({ ...row, detail: detailOf(row.detail) }));
	const start = events.find((event) => event.kind === 'published' && event.versionNumber === round);
	if (start === undefined) return null;

	// Each window from an event's id on: open or shut. A `published` after the start only tells: one that asked again would start a later round.
	const windows: { from: number; open: boolean }[] = [{ from: start.id, open: true }];
	for (const event of events) {
		if (event.id <= start.id || event.kind === 'published') continue;
		windows.push({ from: event.id, open: event.kind === 'extended' });
	}
	const extensions = events.filter((event) => event.kind === 'extended');
	const closesNow = db.select({ closesAt: decisions.closesAt }).from(decisions).where(eq(decisions.id, decisionId)).get()?.closesAt ?? null;
	const stampOf = (value: unknown): Stamp | null => (typeof value === 'string' ? value : null);
	const closesAtFor = (id: number): Stamp | null => {
		const before = extensions.filter((event) => event.id < id).at(-1);
		if (before !== undefined) return stampOf(before.detail.to);
		const after = extensions.find((event) => event.id > id);
		return after !== undefined ? stampOf(after.detail.from) : closesNow;
	};

	return (id, at) => {
		// Every window starts at or after the round's `published`, so an event at or before it by id finds none.
		const window = windows.filter((each) => each.from < id).at(-1);
		if (window === undefined || !window.open) return false;
		const closesAt = closesAtFor(id);
		return closesAt === null || at < closesAt;
	};
}

/**
 * The participants with a `role_changed`, `address_changed`,
 * `account_attached`, `account_cleared`, `re_included` or `removed` event
 * (`CHANGE_KINDS`) above the event id `after` gives for them (card 2685,
 * decision 4 clause 8): ids only grow, and moments tie to the second, so the
 * two are compared by id.
 */
export function changedSinceAsked(after: ReadonlyMap<number, number>): Set<number> {
	const ids = [...after.keys()];
	const changed = new Set<number>();
	for (let from = 0; from < ids.length; from += IDS_AT_ONCE) {
		const rows = db
			.select({ participantId: decisionEvents.participantId, latest: max(decisionEvents.id) })
			.from(decisionEvents)
			.where(and(inArray(decisionEvents.participantId, ids.slice(from, from + IDS_AT_ONCE)), inArray(decisionEvents.kind, [...CHANGE_KINDS])))
			.groupBy(decisionEvents.participantId)
			.all();
		for (const row of rows) {
			if (row.participantId === null || row.latest === null) continue;
			if (row.latest > (after.get(row.participantId) ?? Number.MAX_SAFE_INTEGER)) changed.add(row.participantId);
		}
	}
	return changed;
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
	return actedSince(userId, CALLER_CAPPED_KINDS, since);
}

/**
 * The moments of the questions the account has asked since `since`, signed in
 * or through an API key, on any decision, oldest first (card 2678, decision
 * 4): the per-caller daily cap's count. A link holder's are by no account.
 */
export function questionsAskedSince(userId: number, since: Stamp): Stamp[] {
	return actedSince(userId, ['question_asked'], since);
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
 * The participant's latest record-bearing mail (decision 19), of the five
 * since card 2708 (D1): the withdrawal's and the ruling's count, the
 * closing-date reminder does not. Null for none, a skipped mail writing none
 * of them. `delivered` is true only when that mail's own `mail_outcome`
 * (`detail.of` its event's id) says it was (D8); no outcome yet is not
 * delivered, and an earlier mail is never named in its place (D2). The
 * ruling's has no `at` (D3): its moment is the ruling's, which no page is
 * given (card 2679, decision 26). The participant's own events alone are read.
 */
export function lastToldOf(participantId: number): ToldMail | null {
	const told = db
		.select({ id: decisionEvents.id, kind: decisionEvents.kind, at: decisionEvents.createdAt })
		.from(decisionEvents)
		.where(and(eq(decisionEvents.participantId, participantId), inArray(decisionEvents.kind, [...MAIL_KINDS])))
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
	const kind = told.kind as ToldMail['kind'];
	return kind === 'told_ruling' ? { kind, delivered } : { kind, at: told.at, delivered };
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
