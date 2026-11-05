/**
 * decisions.ts — a decision made, its decider named, its participants set,
 * opened, re-published, closed, extended, withdrawn and deleted; an
 * invitation sent again; and the administrator's changes to a participant's
 * account and address (card 2675, plan section 4.7).
 *
 * Cards 2676, 2677 and 2697 add the routes and pages, each calling a write
 * inside its `writeAs` callback, handed `caller`.
 *
 * Card 2697 adds the dry run (`dryRunDecision`), requires the revision on
 * opening and re-publishing, and limits the mail these writes send: per
 * caller, the dry runs, the publishes and (its code review's part B, S2) the
 * record mails caused, across decisions, in 24 hours; per participant, the
 * record mails in 24 hours; and a closing time at most a year ahead. Its
 * guards (`READS`) make every refusal of the writes whose routes ask for the
 * caller's password, so that none costs a check: the administrator's
 * participant account and address, and the delete and the withdrawal of a
 * decision that was ever opened (Q9, Q10, Q29).
 *
 * Card 2679 adds the ruling (`ruleDecision`), the release of results
 * (`releaseResults`) and superseding a ruled decision with a draft
 * (`supersedeDecision`). The ruling and the release are a person's acts alone
 * (`source: 'ui'`), and their guards (`decisionRuleGuard`,
 * `resultsReleaseGuard`, on `READS`) make every refusal, so that their routes
 * can ask for the caller's password after them. A response records the
 * version of the who-sees statement it was given under (decision 25), and
 * `RESPONSE_KINDS` is decision-record.ts's, so that every read of a vote
 * skips a concern. A participant's concern about the ruling
 * (`raiseConcern`, `raiseConcernByLink`, sharing `concernAs`) is a response
 * row of its own kind, a person's act alone, which tells the decider by a
 * notice that names nobody, at most once a day for each participant
 * (decisions 3 and 4).
 *
 * Card 2678 adds a participant's clarification questions and their answers:
 * a question (`askQuestion`, signed in or through an API key, and
 * `askQuestionByLink`, a person's act alone, sharing `questionAs`), and the
 * author's or decider's answer (`answerQuestion`), which through an API key is
 * an agent's draft that a person publishes (`publishAnswer`) or replaces with
 * their own (`answerQuestion` with `replacesDraft`), each a person's act
 * alone. A question tells whoever may answer it now, and an answer a person
 * stands behind tells the asker, by notices that name nobody and quote
 * nothing, sent after the commit (`questionNoticesOf`, `answerNoticeOf`). Each
 * settling of an answer is a guarded update that a 409 ends when it changes
 * nothing. No activity entry, live event or webhook (design S3).
 *
 * Card 2680 adds linking a card to a decision and unlinking it (`linkCard`,
 * `unlinkCard`), by an editor of the decision's board who can edit the card's;
 * each writes its activity entry on the card's board, naming the card and no
 * decision, and touches no decision row, so that no revision moves. Deleting
 * a linked decision leaves an entry on each linked card's board.
 *
 * Card 2677 adds a participant's own writes: a response
 * (`respondToDecision`, `respondByLink`) and being recorded as having seen a
 * version (`recordSeen`, `recordSeenByLink`), signed in or by a personal
 * link. Both ways in share `respondAs` and `seenAs`, so they cannot drift. A
 * link write decides by its token, through `participantForLink`, and is
 * handed `caller` only to note a signed-in browser's account beside the link
 * holder (decision 9); its source is `link` whatever the route says. Each is
 * a person's act alone (`source: 'ui'`), for a participant `reachOf` still
 * reaches, and none writes an activity entry, a live event, a webhook or a
 * mail (design S3).
 *
 * Card 2682 adds the API v1 routes (`src/routes/api/v1/decisions`), which
 * call `createDecision`, `updateDraft`, `setDecider`, `setParticipants`,
 * `extendDecision`, `withdrawDecision`, `deleteDecision`,
 * `supersedeDecision`, `askQuestion`, `answerQuestion`, `linkCard` and
 * `unlinkCard` with `source: 'api'`. A write is an API key's by the route's
 * word or by the credential it was let in with (`sourceOf`, D7), either
 * alone, so that a later route handing `'ui'` by mistake opens nothing. A key
 * is refused what mails people (opening, re-publishing, a dry run, Resend:
 * D3), closing (D29), a participant's account and address (D6), participants
 * and the decider of a decision ever opened (D4), and withdrawing or deleting
 * one (D5), and reopening a closed one by Extend (code review S2): each is a
 * person's act on the decision's page. Extend never brings a closing time
 * earlier, for anyone (D30).
 *
 * Each write has the one shape of a service (`ServiceOptions` in
 * `write-as.ts`): `inWrite()` first, then the guard (`requireDecision`, or
 * `requireBoard` for a new draft: 401, 404, 403), every field read from the
 * body (400), the status and the other checks (409), and the writes, with
 * `updated_at` stamped. Then the record's events, the activity entry, the
 * live event and the mails. Refusals are kit `error()`s. Who may do what is
 * `DECISION_RULES` in decision-access.ts: a grant resting on authorship or
 * board ownership also needs edit access to the board now (decision 6).
 *
 * What the record holds is written through decision-record.ts alone, links
 * through decision-links.ts, and mail through decision-mail.ts, whose links
 * are made on the App URL or `ORIGIN` and never on `opts.baseUrl` (decision
 * 28). A draft is nobody's business but its author's, its decider's, the
 * board's owners' and administrators': it writes no activity entry, no live
 * event and no event naming a participant (decisions 5 and 21, comment
 * 5599). Each lifecycle step of a decision that has been opened and whose
 * board is there writes its activity entry, its action written out at its
 * call as `activity-twins.test.ts` requires, and the `decision` live event
 * (decisions 21 and 23).
 */
import { error } from '@sveltejs/kit';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from './db';
import {
	boards,
	cards,
	columns,
	decisionCardLinks,
	decisionOptions,
	decisionParticipants,
	decisionVersions,
	decisions,
	users,
	type Decision,
	type DecisionOption,
	type DecisionParticipant,
	type DecisionQuestion
} from './db/schema';
import { requirePasswordHeld, type SessionUser } from './auth';
import { canEditBoard, isAdmin } from './board-access';
import { decisionAccess, mayDo, type DecisionAccess } from './decision-access';
import {
	allOptionsOf,
	changedSections,
	liveOptionsOf,
	listedOptionIds,
	nextLabel,
	openFactsOf,
	optionChanges,
	parseVersionContent,
	parseWorkingContent,
	participantsOf,
	readContent,
	readMultiline,
	readTitle,
	requireClosed,
	revisionOf,
	sectionKeysOf,
	workingFromVersion,
	CONTENT_LIMITS,
	type WorkingContent
} from './decision-content';
import {
	accountHistory,
	actorFor,
	appendEvent,
	appendQuestion,
	appendResponse,
	appendRuling,
	appendVersion,
	concernsOf,
	currentRound,
	dryRunsSince,
	eventsOfKind,
	hasSeen,
	IDS_AT_ONCE,
	lastDryRunAt,
	lastMailAt,
	latestResponse,
	liveOptionIds,
	mailsSince,
	ownResponseOf,
	peopleById,
	personOfAccount,
	publishesSince,
	questionOn,
	questionsAskedSince,
	questionsBy,
	questionsOf,
	recordAnswer,
	recordDraftPublished,
	recordDraftReplaced,
	recordMailsSince,
	RESPONSE_KINDS,
	responsesInRound,
	responsesOf,
	snapshotOf,
	statementsOf,
	supersedingOf,
	type RecordActor
} from './decision-record';
import { answererRoleOf, pendingDraft, questionsFor } from './decision-questions';
import { commentKeysOf, currentResultsOf, releaseRefusals, resultsRevisionFor, rulingRefusals, versionOptionsOf } from './decision-results';
import {
	addressRefusal,
	attachRefusal,
	clearRefusal,
	mailedLinkOf,
	participantForLink,
	reachOf,
	REMOVED_WORDS,
	revokeLinks,
	SKIP_WORDS,
	type Reach
} from './decision-links';
import {
	CALLER_MAIL_DAILY_CAP,
	DAY_MS,
	dailyCapFrom,
	decisionLinkBase,
	DRY_RUN_DAILY_CAP,
	DRY_RUN_MIN_MINUTES,
	later,
	mailRestOf,
	PUBLISH_DAILY_CAP,
	queueDryRun,
	queueRecordMails,
	RECORD_MAIL_MIN_MINUTES
} from './decision-mail';
import { DECISION_ACTION_WORDS, decisionStatus, linkUsable, requireTransition } from './decision-status';
import { isSmtpConfigured, NO_LINK_ADDRESS } from './email';
import { emit } from './events';
import { ACTIONS, actorOf, logActivity, type ActivitySource } from './logActivity';
import { notifyDecisionConcern, notifyDecisionQuestion, notifyQuestionAnswered, shouldNotifyUser } from './notifications';
import { takeAllowance } from './rate-limit';
import {
	asObject,
	readBoolean,
	readChoice,
	readId,
	readList,
	readNumber,
	readObjects,
	readText,
	readTimestamp,
	type RequestBody
} from './request-body';
import { CLOSES_TOO_FAR, CLOSES_TOO_FAR_TO_REPUBLISH, closesTooFar, refusalsOf } from '$lib/decision-readiness';
import { againstOf, CONCERNS_PER_PARTICIPANT, DECISION_TEXT_MAX, mostChosenOf, QUESTION_TEXT_MAX, QUESTIONS_PER_PARTICIPANT } from '$lib/decision-rules';
import type { OwnConcern, OwnQuestion, OwnResponse, QuestionView } from '$lib/decision-view-types';
import {
	ALREADY_PUBLISHED,
	ANSWERED,
	CONCERN_SUPERSEDED,
	CONCERN_WINDOW_ENDED,
	DEAD_DECISION_LINK,
	DRAFT_PENDING,
	NO_DRAFT,
	NO_LONGER_REACHED,
	NOTHING_TO_PUBLISH,
	PERSON_ANSWERED,
	QUESTIONS_CLOSED,
	questionsLimitWords,
	STALE_REVISION,
	WHO_SEES_STATEMENT_VERSION
} from '$lib/decision-words';
import { CARD_LINK_RELATIONS, cardLinkCountOf, LINKS_PER_CARD, LINKS_PER_DECISION, linkCountOf, type CardLinkRelation } from './decision-cards';
import type { LinkOutcome } from '$lib/decision-register-types';
import { requireBoard, requireCard, requireDecision, requireUser } from './route-guards';
import { parseStamp, stamp, type Stamp } from '$lib/timestamps';
import { inWrite, writingWithKey, type ServiceOptions } from './write-as';

/**
 * The functions here that only read: the guards of the administrator's two
 * participant writes, and of the delete and the withdrawal, which their
 * routes ask before the caller's password (card 2697, Q10, Q29); and the
 * guards of the ruling and the release, which theirs will (card 2679,
 * decision 2). Every other export is a write, and starts with `inWrite()`.
 */
export const READS: readonly string[] = [
	'participantAccountGuard',
	'participantAddressGuard',
	'decisionDeleteGuard',
	'decisionWithdrawGuard',
	'decisionRuleGuard',
	'resultsReleaseGuard'
];

/** A participant's part in a decision. */
const ROLES = ['consulted', 'informed'] as const;

/** The most participants one decision may be given at once. */
const MOST_PARTICIPANTS = 5000;

/** What an administrator does to a participant's account (decision 14). */
const ACCOUNT_CHANGES = ['person', 'none'] as const;

/** How a decision's options are answered: one choice, or a score for each (card 2676, decision 28). */
const VOTE_MODES = ['single', 'score'] as const;

/** The stages a participant is recorded as having seen (card 2677, decision 14). */
const SEEN_STAGES = ['question', 'ruling', 'withdrawal'] as const;

/** The most responses one participant gives in one round (decision 11). Private: a service module exports its functions alone (D5). */
const RESPONSES_PER_ROUND = 50;

/** How long a response's comment, and each comment on an option, may be (decision 11): the comment's is the shared `DECISION_TEXT_MAX`. */
const COMMENT_MAX = DECISION_TEXT_MAX;
const OPTION_COMMENT_MAX = 2000;

/** The 403 for a participant's write through an API key (decision 10, D19). */
const PERSONS_ACT = "Responding is a person's act: it cannot be done with an API key";
// The 403 for a participant `reachOf` no longer reaches (decision 10, D12) is `$lib/decision-words.ts`'s `NO_LONGER_REACHED`, which
// card 2678's questions read says too.
/** The 409 for naming the decider of a decision that supersedes another (card 2679, code review S1). */
const SUPERSEDING_DECIDER_FIXED =
	"This decision supersedes a ruled one: its decider was set when it was made and cannot be changed. Withdraw it and supersede the ruling again for another decider";

// ─── What an API key may not do (card 2682, D3 to D6, D29, D30) ──────────────
// Module constants, not exported (D20): a service module exports its functions alone.

/** The 403 for opening, re-publishing, a dry run and Resend through an API key (card 2682, D3): each mails people. */
const MAIL_ACT =
	"Opening, re-publishing, a dry run and sending an invitation again mail people: a person does them on the decision's page. An API key cannot";

/** The 403 for a participant's account or address through an API key (card 2682, D6): both ask the password on the page. */
const STEP_UP_ACT = "Changing a participant's account or address asks for your password on the decision's page. An API key cannot";

/** The 403 for participants or the decider of a decision ever opened, through an API key (card 2682, D4). */
const OPENED_PEOPLE =
	"This decision has been opened: who is included in it, and who decides it, are changed on the decision's page. An API key cannot";

/** The 403 for withdrawing or deleting a decision ever opened, through an API key (card 2682, D5): the page asks the password. */
const OPENED_ACT = "This decision has been opened: withdrawing or deleting it asks for your password on the decision's page. An API key cannot";

/** The 403 for closing a decision through an API key (card 2682, D29): an early close makes a later ruling early. */
const CLOSE_ACT =
	"Closing a decision for input before its closing time is done on the decision's page: it makes a later ruling early. An API key cannot";

/**
 * The 403 for extending a closed decision through an API key (card 2682, code review S2): Extend on a closed decision
 * reopens it, undoing a person's close, so a key extends only an open one.
 */
const REOPEN_ACT = "This decision is closed for input: reopening it by Extend is done on the decision's page. An API key cannot";

/** The 400 for an Extend that would not move the closing time later, for every source (card 2682, D30). */
const EXTENDS_EARLIER = "closesAt must be later than the decision's current closing time: Extend never brings it earlier";

/**
 * The source a write is recorded and judged by (card 2682, D7): `'api'` when
 * the route said so, or when the write was let in with an API key, whatever
 * the route said (`writingWithKey()`). The one place this module reads the
 * route's word, so that a later route handing `'ui'` by mistake opens no
 * person's act to a key and records no agent's write as a person's
 * (`tests/decisions-api.test.ts` case 3).
 */
function sourceOf(opts: ServiceOptions): ActivitySource {
	return opts.source !== 'ui' || writingWithKey() ? 'api' : 'ui';
}

/** Whether the write is an API key's, by the route's word or by the credential (card 2682, D7). */
function keyed(opts: ServiceOptions): boolean {
	return sourceOf(opts) === 'api';
}

/**
 * Make a draft on a board the caller can edit. `title` text, trimmed, 1 to 200
 * characters, holding no control, direction or invisible character (decision
 * 30). The decider is the board's Product Owner, if that account can edit the
 * board now, and the author otherwise (decision 7). Writes `created`; no
 * activity entry, live event or mail.
 */
export function createDecision(caller: SessionUser | null, at: { boardId: number }, body: RequestBody, opts: ServiceOptions): Decision {
	inWrite();
	const user = requireUser(caller);
	const board = requireBoard(user, at.boardId, 'edit');

	const title = readTitle(body);

	// Decision 7: the Product Owner, asked again now (comment 5616 (2)), or the author.
	const owner =
		board.productOwnerUserId === null
			? undefined
			: db.select({ id: users.id, username: users.username, role: users.role }).from(users).where(eq(users.id, board.productOwnerUserId)).get();
	const productOwner = owner && canEditBoard(owner, board.id) ? owner : null;

	const now = stamp();
	const decision = db
		.insert(decisions)
		.values({
			boardId: board.id,
			boardName: board.name,
			title,
			authorUserId: user.id,
			authorName: user.username,
			deciderUserId: productOwner?.id ?? user.id,
			deciderName: productOwner?.username ?? user.username,
			createdAt: now,
			updatedAt: now
		})
		.returning()
		.get();
	appendEvent({ decisionId: decision.id, kind: 'created', detail: { decider: productOwner ? 'product_owner' : 'author' } }, actorFor(user, sourceOf(opts)));
	return decision;
}

/**
 * Name the decider (`deciderUserId`, an account that can edit the decision's
 * board now). 400 for an account that is not there or cannot edit the board,
 * in the same words and at the same step for both to a caller who is not an
 * administrator, so that the refusal does not say which ids are accounts (the
 * code review's C5); 409 for a decision whose board is gone, and, once the decision is open,
 * 403 for the caller naming themselves (decision 6, R4). `revision`, the
 * decision's as the caller read it, is required (card 2676, decision 10): a
 * different one is a 409. Writes `decider_changed`. Naming the decider it has
 * changes nothing. Card 2679 (code review S1): 409 for a decision that
 * supersedes another, at any status, after the status's own refusal.
 */
export function setDecider(caller: SessionUser | null, at: { decisionId: number }, body: RequestBody, opts: ServiceOptions): Decision {
	inWrite();
	const user = requireUser(caller);
	const { decision } = requireDecision(user, at.decisionId, 'setDecider');
	// Card 2682, D4: choosing the decider of a decision ever opened is a person's act on the page.
	if (decision.openedAt !== null && keyed(opts)) error(403, OPENED_PEOPLE);

	const deciderUserId = readId(body, 'deciderUserId', { required: true });
	const revision = readText(body, 'revision', { required: true });
	if (decision.status !== 'draft' && deciderUserId === user.id) error(403, 'You cannot make yourself the decider of a decision that is open');
	const account = db.select({ id: users.id, username: users.username, role: users.role }).from(users).where(eq(users.id, deciderUserId)).get();
	// The code review's C5: only an administrator is told that an id is no account; anyone else is told it cannot be the decider, at the same step.
	if (!account && isAdmin(user)) error(400, `deciderUserId ${deciderUserId} is not an account`);

	requireTransition(decision, 'setDecider');
	// Card 2679 (code review S1): a decision that supersedes a ruling keeps the decider `supersedeDecision` chose, never one
	// the caller names, so that a ruling cannot be overturned through a draft whose decider was swapped.
	if (decision.supersedesId !== null) error(409, SUPERSEDING_DECIDER_FIXED);
	requireRevision(decision, revision);
	if (decision.boardId === null) error(409, "This decision's board has been deleted: its decider cannot be changed");
	if (!account || !canEditBoard(account, decision.boardId)) {
		error(400, `deciderUserId ${deciderUserId} cannot edit this board: a decision's decider must be an account that can edit its board`);
	}
	if (account.id === decision.deciderUserId) return decision;

	const row = db
		.update(decisions)
		.set({ deciderUserId: account.id, deciderName: account.username, updatedAt: stamp() })
		.where(eq(decisions.id, decision.id))
		.returning()
		.get();
	appendEvent(
		{
			decisionId: decision.id,
			kind: 'decider_changed',
			detail: { fromUserId: decision.deciderUserId, fromName: decision.deciderName, toUserId: account.id, toName: account.username }
		},
		actorFor(user, sourceOf(opts))
	);
	return row;
}

/**
 * Set who is consulted on the decision and who is told of it: `participants`,
 * up to 5,000 objects `{ personId, role }`, each person once, each one who is
 * in the directory and has not left (400 naming them otherwise). Answers
 * every participant row of the decision, in order.
 *
 * On a draft the set replaces the rows: a new person gets a row with their
 * snapshots (decision 19), a role is changed, and a row not named is
 * deleted. No event names a participant (comment 5599).
 *
 * Once open, nothing the record can name is deleted (decision 25). A new
 * person is included (`included`), a removed one comes back on the same row
 * (`re_included`), and each is invited, with a link if they have no account.
 * One left out is marked removed (`removed`) and their link ended. A changed
 * role writes `role_changed`. A live row whose person has been deleted is
 * marked removed in the same way, as the body cannot name it, so its account
 * no longer holds the participant role (card 2676, the code review's C1,
 * superseding decision 29's "left as it is"). Including anyone is refused, 409, with
 * no address to make a link on (decision 28), and re-including a
 * participant mailed in the last 10 minutes (decision 31); and 429 where
 * inviting them would take the caller past their record mail limit (the code
 * review's part B, S2).
 *
 * 409, naming the person, for a row that would hold the same account as
 * another live row of the decision (decision 29).
 *
 * Card 2676: on a decision that is not a draft, including people is the
 * author's and the decider's alone (`include`, R3), 403 for anyone else.
 * `revision` is required, and a different one is a 409 (decision 10). A
 * caller who is not an administrator, naming someone who has left or an id
 * that is no person, is told only that the id cannot be included, as their
 * picker holds neither (R6); a participant of this decision who has since
 * left is named to every editor, as their name is already on it (D6).
 */
export function setParticipants(
	caller: SessionUser | null,
	at: { decisionId: number },
	body: RequestBody,
	opts: ServiceOptions
): DecisionParticipant[] {
	inWrite();
	const user = requireUser(caller);
	const { decision, access } = requireDecision(user, at.decisionId, 'edit');
	if (decision.status !== 'draft' && !mayDo(access, 'include', decision)) error(403, `You cannot ${DECISION_ACTION_WORDS.include.verb} this decision`);
	// Card 2682, D4: once ever opened, saving the set mails whoever it includes; before the body is read.
	if (decision.openedAt !== null && keyed(opts)) error(403, OPENED_PEOPLE);

	const entries = readObjects(body, 'participants', { required: true, max: MOST_PARTICIPANTS });
	const wanted = entries.map((entry) => ({
		personId: readId(entry, 'personId', { required: true }),
		role: readChoice(entry, 'role', { required: true, from: ROLES })
	}));
	const revision = readText(body, 'revision', { required: true });
	const seen = new Set<number>();
	for (const { personId } of wanted) {
		if (seen.has(personId)) error(400, `personId ${personId} is named twice`);
		seen.add(personId);
	}
	const persons = peopleById([...seen]);
	const rows = participantsOf(decision.id);
	const admin = isAdmin(user);
	for (const { personId } of wanted) {
		const person = persons.get(personId);
		if (!person) error(400, admin ? `personId ${personId} is not a person` : `personId ${personId} cannot be included`);
		if (person.status !== 'active') {
			const own = rows.find((row) => row.personId === personId);
			if (own) error(400, `participants: ${own.name} has left: remove before saving`);
			error(400, admin ? `${person.fullName} (person ${personId}) has left, and cannot be included` : `personId ${personId} cannot be included`);
		}
	}

	requireTransition(decision, 'edit');
	requireRevision(decision, revision);
	const by = actorFor(user, sourceOf(opts));
	const now = stamp();

	if (decision.status === 'draft') {
		const named = new Map(wanted.map((w) => [w.personId, w.role]));
		const kept = rows.filter((row) => row.personId !== null && named.has(row.personId));
		const held = new Set(kept.map((row) => row.personId));
		const inserts = wanted.filter((w) => !held.has(w.personId)).map((w) => ({ ...w, snapshot: snapshotOf(w.personId)! }));
		requireOneRowPerAccount(
			inserts.map((i) => ({ name: i.snapshot.name, userId: i.snapshot.userId })),
			kept.map((row) => row.userId)
		);

		const gone = rows.filter((row) => row.personId === null || !named.has(row.personId)).map((row) => row.id);
		for (let from = 0; from < gone.length; from += IDS_AT_ONCE) {
			db.delete(decisionParticipants).where(inArray(decisionParticipants.id, gone.slice(from, from + IDS_AT_ONCE))).run();
		}
		for (const row of kept) {
			const role = named.get(row.personId!)!;
			if (role !== row.role) db.update(decisionParticipants).set({ role }).where(eq(decisionParticipants.id, row.id)).run();
		}
		for (const insert of inserts) {
			db.insert(decisionParticipants)
				.values({ decisionId: decision.id, personId: insert.personId, role: insert.role, ...snapshotColumns(insert.snapshot), includedAt: now, includedBy: user.id, includedByName: user.username })
				.run();
		}
		touch(decision.id, now);
		return participantsOf(decision.id);
	}

	// Open or closed: rows are added, brought back, re-roled and marked removed, never deleted.
	const live = new Map<number, DecisionParticipant>();
	const removed = new Map<number, DecisionParticipant>();
	for (const row of rows) {
		if (row.personId === null) continue;
		if (row.removedAt === null) live.set(row.personId, row);
		else removed.set(row.personId, row); // The latest, as rows are read in order.
	}
	const named = new Set(wanted.map((w) => w.personId));
	const additions = wanted.filter((w) => !live.has(w.personId) && !removed.has(w.personId)).map((w) => ({ ...w, snapshot: snapshotOf(w.personId)! }));
	const returns = wanted.filter((w) => !live.has(w.personId) && removed.has(w.personId)).map((w) => ({ ...w, row: removed.get(w.personId)! }));
	const roleChanges = wanted.filter((w) => live.has(w.personId) && live.get(w.personId)!.role !== w.role).map((w) => ({ ...w, row: live.get(w.personId)! }));
	// The code review's C1: a live row whose person has been deleted cannot be named by any body, so it is removed like one left out.
	const removals = rows.filter((row) => row.removedAt === null && (row.personId === null || !named.has(row.personId)));

	if (additions.length + returns.length > 0) {
		if (decisionLinkBase() === null) error(409, NO_LINK_ADDRESS);
		requireMailRested(
			returns.map((r) => r.row),
			now
		);
		const staying = rows.filter((row) => row.removedAt === null && !removals.includes(row));
		requireOneRowPerAccount(
			[...additions.map((a) => ({ name: a.snapshot.name, userId: a.snapshot.userId })), ...returns.map((r) => ({ name: r.row.name, userId: r.row.userId }))],
			staying.map((row) => row.userId)
		);
		// The code review's part B (S2): each one included or brought back is invited, by the caller.
		requireRecordMailAllowed(user, additions.length + returns.length, now);
	}

	for (const row of removals) {
		db.update(decisionParticipants).set({ removedAt: now, removedBy: user.id }).where(eq(decisionParticipants.id, row.id)).run();
		appendEvent({ decisionId: decision.id, kind: 'removed', participantId: row.id }, by);
		revokeLinks({ participantId: row.id }, 'removed', by);
	}
	for (const change of roleChanges) {
		db.update(decisionParticipants).set({ role: change.role }).where(eq(decisionParticipants.id, change.row.id)).run();
		appendEvent({ decisionId: decision.id, kind: 'role_changed', participantId: change.row.id, detail: { from: change.row.role, to: change.role } }, by);
	}
	const invited: number[] = [];
	const history = returns.length > 0 ? accountHistory(decision.id) : new Map<number, boolean>();
	for (const back of returns) {
		db.update(decisionParticipants).set({ role: back.role, removedAt: null, removedBy: null }).where(eq(decisionParticipants.id, back.row.id)).run();
		// Once a row held an account on this decision it is never read as one that did not: bringing it back cannot undo R1.
		const hadAccount = back.row.userId !== null || history.get(back.row.id) === true;
		appendEvent({ decisionId: decision.id, kind: 're_included', participantId: back.row.id, detail: { role: back.role, hadAccount } }, by);
		invited.push(back.row.id);
	}
	for (const addition of additions) {
		const row = db
			.insert(decisionParticipants)
			.values({
				decisionId: decision.id,
				personId: addition.personId,
				role: addition.role,
				...snapshotColumns(addition.snapshot),
				includedAt: now,
				includedBy: user.id,
				includedByName: user.username
			})
			.returning()
			.get();
		appendEvent({ decisionId: decision.id, kind: 'included', participantId: row.id, detail: { role: addition.role, hadAccount: row.userId !== null } }, by);
		invited.push(row.id);
	}
	const after = touch(decision.id, now);
	if (invited.length > 0) {
		queueRecordMails(after, 'invitation', { by, participants: participantsOf(decision.id).filter((row) => invited.includes(row.id)) });
	}
	return participantsOf(decision.id);
}

/**
 * Save the working copy (card 2676, decisions 6 to 10, plan 4.4):
 * `revision`, required, and any of `title`, `closesAt` (a timestamp or
 * null), `voteMode` (`single` or `score`) and `content` (decision 8's shape,
 * closed at every level). Answers the decision and its live options.
 *
 * On a draft each is saved. A changed `closesAt` must be in the future, and
 * no more than `CLOSES_WITHIN_DAYS` ahead (400, card 2697 Q25); one equal to
 * the stored value is saved even once it has passed, as opening refuses it
 * anyway (D5). Once opened, only `content` changes: a
 * `title`, `closesAt` or `voteMode` equal to the stored value changes
 * nothing, and a changed one is a 409. A revision that is not the
 * decision's as it is now is a 409, asked after the status.
 *
 * The option rows are kept in step with `content.options` (decision 7): an
 * entry with no `optionId` is given a row and a label never used on this
 * decision, which its `optionId` then names; each entry's position is its
 * index; an entry's `optionId` must be a live option of this decision (400);
 * and a row left out is deleted if it was never published, and otherwise
 * stays live, to be retired at the next publish. The last label issued is
 * kept in the content's `lastLabel`.
 *
 * Through an API key each section the save changed is flagged as drafted by
 * an agent, and its reviewed stamp removed; only Mark reviewed clears a flag
 * (decision 9). No event, activity entry, live event or mail.
 */
export function updateDraft(
	caller: SessionUser | null,
	at: { decisionId: number },
	body: RequestBody,
	opts: ServiceOptions
): { decision: Decision; options: DecisionOption[] } {
	inWrite();
	const user = requireUser(caller);
	const { decision } = requireDecision(user, at.decisionId, 'edit');

	const revision = readText(body, 'revision', { required: true });
	const title = readTitle(body, { required: false });
	const closesAt = readTimestamp(body, 'closesAt', { nullable: true });
	const voteMode = readChoice(body, 'voteMode', { from: VOTE_MODES });
	const stored = parseWorkingContent(decision.workingContent);
	const content = Object.hasOwn(body, 'content') ? readContent(body, stored) : undefined;
	const now = stamp();
	if (closesAt !== undefined && closesAt !== null && closesAt !== decision.closesAt && closesAt <= now) error(400, 'closesAt must be in the future');
	// Card 2697, Q25: as the future rule, asked of a changed value alone (D5).
	if (closesAt !== undefined && closesAt !== null && closesAt !== decision.closesAt && closesTooFar(closesAt, now)) error(400, CLOSES_TOO_FAR);
	const live = liveOptionsOf(decision.id);
	if (content) {
		const liveIds = new Set(live.map((option) => option.id));
		content.options.forEach((option, index) => {
			if (option.optionId !== undefined && !liveIds.has(option.optionId)) {
				error(400, `options[${index}].optionId ${option.optionId} is not a live option of this decision`);
			}
		});
	}

	requireTransition(decision, 'edit');
	requireRevision(decision, revision);
	const draft = decision.status === 'draft';
	if (!draft) {
		if (title !== undefined && title !== decision.title) error(409, 'This decision has been opened: its title cannot be changed');
		if (closesAt !== undefined && closesAt !== decision.closesAt) error(409, 'This decision has been opened: the closing time of an open decision changes by Extend');
		if (voteMode !== undefined && voteMode !== decision.voteMode) error(409, 'This decision has been opened: its vote mode cannot be changed');
	}

	let working: WorkingContent | undefined;
	if (content) {
		// Decision 7: rows for new entries, each with a label never used, every entry at its index.
		let lastLabel = stored.lastLabel;
		const listed = content.options.map((option, index) => {
			if (option.optionId !== undefined) {
				const row = live.find((one) => one.id === option.optionId)!;
				if (row.position !== index) db.update(decisionOptions).set({ position: index }).where(eq(decisionOptions.id, row.id)).run();
				return option;
			}
			const label = nextLabel(decision.id, { ...stored, lastLabel });
			lastLabel = label;
			const row = db.insert(decisionOptions).values({ decisionId: decision.id, label, position: index }).returning().get();
			return { ...option, optionId: row.id };
		});
		const kept = new Set(listed.map((option) => option.optionId));
		const unpublished = live.filter((option) => !kept.has(option.id) && option.addedInVersion === null).map((option) => option.id);
		if (unpublished.length > 0) db.delete(decisionOptions).where(inArray(decisionOptions.id, unpublished)).run();

		// Decision 9: the flags are the server's; through an API key each changed section is flagged again.
		const after = { ...content, options: listed };
		const agentDrafted = { ...stored.agentDrafted };
		const reviewed = { ...stored.reviewed };
		if (keyed(opts)) {
			for (const key of changedSections(stored, after)) {
				agentDrafted[key] = true;
				delete reviewed[key];
			}
		}
		for (const key of Object.keys(agentDrafted)) {
			const optionId = /^options\.(\d+)$/.exec(key);
			if (optionId !== null && !kept.has(Number(optionId[1]))) delete agentDrafted[key];
		}
		working = { ...after, agentDrafted, reviewed, lastLabel };
	}

	const row = db
		.update(decisions)
		.set({
			...(draft && title !== undefined ? { title } : {}),
			...(draft && closesAt !== undefined ? { closesAt } : {}),
			...(draft && voteMode !== undefined ? { voteMode } : {}),
			...(working ? { workingContent: JSON.stringify(working) } : {}),
			updatedAt: now
		})
		.where(eq(decisions.id, decision.id))
		.returning()
		.get();
	return { decision: row, options: liveOptionsOf(decision.id) };
}

/**
 * Mark sections drafted by an agent reviewed (card 2676, decision 9, R7):
 * `sections`, a list of section keys or `'all'`, and `revision`, required.
 * A person's act alone: refused, 403, unless the write came through the web
 * application (`source: 'ui'`), so that an API key can never clear the label
 * it set. A key that is no section of this decision is a 400. Each flagged
 * key named loses its flag and is stamped `reviewed[key] = { byUserId,
 * byName, at }`, which the next version carries, as `{ byName, at }`, as the
 * record of who reviewed what. No event (comment 5599), activity entry, live
 * event or mail.
 */
export function markReviewed(caller: SessionUser | null, at: { decisionId: number }, body: RequestBody, opts: ServiceOptions): Decision {
	inWrite();
	const user = requireUser(caller);
	const { decision } = requireDecision(user, at.decisionId, 'review');
	if (keyed(opts)) error(403, "Marking text reviewed is a person's act: it cannot be done with an API key");

	const working = parseWorkingContent(decision.workingContent);
	const known = new Set(sectionKeysOf(working));
	let sections: string[];
	if (body.sections === 'all') {
		sections = Object.keys(working.agentDrafted);
	} else {
		const listed = readList(body, 'sections', { required: true, max: known.size });
		sections = listed.map((key, index) => {
			if (typeof key !== 'string' || !known.has(key)) error(400, `sections[${index}] is not a section of this decision`);
			return key;
		});
	}
	const revision = readText(body, 'revision', { required: true });

	requireTransition(decision, 'review');
	requireRevision(decision, revision);
	const now = stamp();
	const agentDrafted = { ...working.agentDrafted };
	const reviewed = { ...working.reviewed };
	for (const key of sections) {
		if (agentDrafted[key] !== true) continue;
		delete agentDrafted[key];
		reviewed[key] = { byUserId: user.id, byName: user.username, at: now };
	}
	return db
		.update(decisions)
		.set({ workingContent: JSON.stringify({ ...working, agentDrafted, reviewed }), updatedAt: now })
		.where(eq(decisions.id, decision.id))
		.returning()
		.get();
}

/**
 * Open a draft: the one moment its participants are told. Refused, 409 with
 * nothing written or sent (decision 20), for no decider; a board that is gone;
 * a decider who can no longer edit it; no `closes_at` in the future; fewer
 * than two live options; no consulted participant; a participant whose person
 * has left or been deleted; a closing time more than `CLOSES_WITHIN_DAYS`
 * ahead (the code review's part B, S3); no mail host; no address to make a link on (the
 * App URL or `ORIGIN`, decision 28); and two participants whose snapshots,
 * taken again now, hold the same account (decision 29).
 *
 * Then the snapshots are taken again, `included_at` now (decision 19); the
 * decision is `open`, version 1, its live options added in it; version 1 is
 * the working content with the live options' text, asking for views; the
 * events `published`, `opened` and `included { role, hadAccount }` for each
 * participant; the invitations, through `reachOf`; `decision_opened`; and the
 * `decision` live event.
 *
 * The refusals are `refusalsOf` in `$lib/decision-readiness`, from the facts
 * `openFactsOf` reads, and the first is answered (card 2676, decision 11):
 * the readability check on the edit page is the same list, so it cannot say
 * a draft opens when this refuses it.
 *
 * Card 2697: `revision` is required (Q1): opening mails everyone the working
 * copy, so a presser who has not seen a change made since they read it must
 * not send it. A different one is a 409, asked after the status and before
 * every other 409. Then the caller's record mail limit (the code review's
 * part B, S2): 429 where inviting every participant would take them past
 * `CALLER_MAIL_DAILY_CAP` in 24 hours. Last of all, the caller's publish
 * limit (Q23): 429 once they have opened or re-published `PUBLISH_DAILY_CAP`
 * decisions in 24 hours.
 */
export function openDecision(caller: SessionUser | null, at: { decisionId: number }, body: RequestBody, opts: ServiceOptions): Decision {
	inWrite();
	const user = requireUser(caller);
	// Card 2682, D3: before any row is read, so the refusal says nothing about which ids exist.
	if (keyed(opts)) error(403, MAIL_ACT);
	const { decision } = requireDecision(user, at.decisionId, 'open');

	const revision = readText(body, 'revision', { required: true });

	const now = stamp();
	requireTransition(decision, 'open', now);
	requireRevision(decision, revision);
	const [refusal] = refusalsOf(openFactsOf(decision, now));
	if (refusal !== undefined) error(409, refusal.words);
	const options = liveOptionsOf(decision.id);
	const rows = participantsOf(decision.id);
	// The code review's part B (S2): every participant counted, as each may be invited.
	requireRecordMailAllowed(user, rows.length, now);
	requirePublishAllowed(user, now);

	// Decision 19: the snapshots, taken again now, which decision 29 has been asked of above.
	const snapshots = rows.map((row) => ({ row, snapshot: snapshotOf(row.personId!)! }));

	const by = actorFor(user, sourceOf(opts));
	for (const { row, snapshot } of snapshots) {
		db.update(decisionParticipants)
			.set({ ...snapshotColumns(snapshot), includedAt: now })
			.where(eq(decisionParticipants.id, row.id))
			.run();
	}
	const opened = db
		.update(decisions)
		.set({ status: 'open', openedAt: now, currentVersion: 1, updatedAt: now })
		.where(eq(decisions.id, decision.id))
		.returning()
		.get();
	db.update(decisionOptions)
		.set({ addedInVersion: 1 })
		.where(and(eq(decisionOptions.decisionId, decision.id), isNull(decisionOptions.retiredInVersion)))
		.run();
	appendVersion({ decisionId: decision.id, number: 1, content: versionContent(decision, options), changeNote: null, asksAgain: true }, by);

	appendEvent({ decisionId: decision.id, kind: 'published', versionNumber: 1, detail: { asksAgain: true, changeNote: null } }, by);
	appendEvent({ decisionId: decision.id, kind: 'opened', detail: { closesAt: opened.closesAt } }, by);
	for (const { row, snapshot } of snapshots) {
		appendEvent({ decisionId: decision.id, kind: 'included', participantId: row.id, detail: { role: row.role, hadAccount: snapshot.userId !== null } }, by);
	}
	queueRecordMails(opened, 'invitation', { by });

	// `refusalsOf` refused a decision whose board is gone (`no_board`), so it is there.
	const boardId = decision.boardId!;
	logActivity({ action: ACTIONS.decisionOpened, ...decisionEntry(boardId, `"${opened.title}"`, user, opts) });
	emit(boardId, 'decision', { decisionId: opened.id, status: decisionStatus(opened, now), boardId });
	return opened;
}

/**
 * Publish the working content again as version N+1: `changeNote` (text,
 * trimmed, 1 to 2,000) and `askAgain` (true or false). Asking again mails
 * `asked_again`, and opens a closed decision again; telling only mails
 * `told_of_change`. Refused 409 once `closes_at` has passed (E10); for telling
 * only when an option would be added or retired (E2, decision 24); when the
 * new version would hold fewer than two live options (decision 20); with no
 * address to make a link on (decision 28); and while any participant it
 * would mail was mailed in the last 10 minutes (decision 31); and, the code
 * review's part B (S3), a closing time more than `CLOSES_WITHIN_DAYS` ahead.
 *
 * An option not yet published is added in the new version; a published one
 * still live but no longer in the working content's `options` is retired in
 * it (decision 24). Writes `published`, `decision_republished` and the live
 * event.
 *
 * Card 2697: `revision` is required, as on opening (Q1), and asked after the
 * status and before every other 409; a participant mailed
 * `RECORD_MAIL_DAILY_CAP` times in 24 hours is refused as one mailed in the
 * last 10 minutes is (Q24); and, last of all, the caller's publish limit
 * (Q23).
 */
export function republishDecision(caller: SessionUser | null, at: { decisionId: number }, body: RequestBody, opts: ServiceOptions): Decision {
	inWrite();
	const user = requireUser(caller);
	if (keyed(opts)) error(403, MAIL_ACT);
	const { decision } = requireDecision(user, at.decisionId, 'republish');

	const changeNote = readText(body, 'changeNote', { required: true, trim: true, min: 1, max: 2000 });
	const askAgain = readBoolean(body, 'askAgain', { required: true });
	const revision = readText(body, 'revision', { required: true });

	const now = stamp();
	requireTransition(decision, 'republish', now);
	requireRevision(decision, revision);
	if (decision.closesAt === null || decision.closesAt <= now) {
		error(409, "This decision's closing time has passed: it cannot be re-published until it is extended");
	}
	// The code review's part B (S3): as opening refuses it, a personal link must not outlast a year and 90 days.
	if (closesTooFar(decision.closesAt, now)) error(409, CLOSES_TOO_FAR_TO_REPUBLISH);
	const number = decision.currentVersion + 1;
	const live = liveOptionsOf(decision.id);
	const { adding, retiring } = optionChanges(live, listedOptionIds(decision.workingContent));
	if (!askAgain && adding.length + retiring.length > 0) {
		error(409, 'Telling of a change cannot add or retire an option: publish a change to the options by asking everyone again');
	}
	// Decision 20, as opening holds it: the new version keeps two live options (the code review's F4).
	if (live.length - retiring.length < 2) error(409, 'This decision would have fewer than two options: it cannot be re-published');
	if (decisionLinkBase() === null) error(409, NO_LINK_ADDRESS);
	const current = participantsOf(decision.id).filter((row) => row.removedAt === null);
	const reaches = reachesOf(decision.id, current);
	const mailed = current.filter((row) => 'via' in reaches.get(row.id)!);
	requireMailRested(mailed, now);
	requireRecordMailAllowed(user, mailed.length, now);
	requirePublishAllowed(user, now);

	const by = actorFor(user, sourceOf(opts));
	for (const option of adding) db.update(decisionOptions).set({ addedInVersion: number }).where(eq(decisionOptions.id, option.id)).run();
	for (const option of retiring) db.update(decisionOptions).set({ retiredInVersion: number }).where(eq(decisionOptions.id, option.id)).run();
	const reopens = askAgain && decision.status === 'closed';
	const row = db
		.update(decisions)
		.set({ currentVersion: number, updatedAt: now, ...(reopens ? { status: 'open', closedAt: null } : {}) })
		.where(eq(decisions.id, decision.id))
		.returning()
		.get();
	appendVersion({ decisionId: decision.id, number, content: versionContent(decision, liveOptionsOf(decision.id)), changeNote, asksAgain: askAgain }, by);
	appendEvent({ decisionId: decision.id, kind: 'published', versionNumber: number, detail: { asksAgain: askAgain, changeNote } }, by);
	queueRecordMails(row, askAgain ? 'asked_again' : 'told_of_change', { by, changeNote });

	if (row.boardId !== null) {
		const told = askAgain ? 'everyone asked again' : 'told of a change';
		logActivity({ action: ACTIONS.decisionRepublished, ...decisionEntry(row.boardId, `"${row.title}": version ${number}, ${told}`, user, opts) });
		emit(row.boardId, 'decision', { decisionId: row.id, status: decisionStatus(row, now), boardId: row.boardId });
	}
	return row;
}

/** Close an open decision for input: `closed`, `closed_at`; the `closed` event, `decision_closed` and the live event. No mail. */
export function closeDecision(caller: SessionUser | null, at: { decisionId: number }, body: null, opts: ServiceOptions): Decision {
	inWrite();
	const user = requireUser(caller);
	// Card 2682, D29: a close before the closing time makes a later ruling early; before any row is read.
	if (keyed(opts)) error(403, CLOSE_ACT);
	const { decision } = requireDecision(user, at.decisionId, 'close');

	const now = stamp();
	requireTransition(decision, 'close', now);
	const row = db.update(decisions).set({ status: 'closed', closedAt: now, updatedAt: now }).where(eq(decisions.id, decision.id)).returning().get();
	appendEvent({ decisionId: decision.id, kind: 'closed' }, actorFor(user, sourceOf(opts)));

	if (row.boardId !== null) {
		logActivity({ action: ACTIONS.decisionClosed, ...decisionEntry(row.boardId, `"${row.title}"`, user, opts) });
		emit(row.boardId, 'decision', { decisionId: row.id, status: decisionStatus(row, now), boardId: row.boardId });
	}
	return row;
}

/**
 * Give an open or closed decision a new closing time, `closesAt`, which must
 * be in the future and no more than `CLOSES_WITHIN_DAYS` ahead (400, card
 * 2697 Q25), and later than the decision's current closing time, for every
 * source (400, card 2682 D30): an Extend that brought it earlier would be a
 * close by another name. It is open again, `closed_at` emptied; the
 * `extended { from, to }` event, `decision_extended` and the live event. No
 * mail. Through an API key only a decision whose stored status is open is
 * extended (403 otherwise, code review S2): reopening a closed one undoes a
 * person's close, and is done on the decision's page.
 */
export function extendDecision(caller: SessionUser | null, at: { decisionId: number }, body: RequestBody, opts: ServiceOptions): Decision {
	inWrite();
	const user = requireUser(caller);
	const { decision } = requireDecision(user, at.decisionId, 'extend');
	// Card 2682, code review S2: a key extends an open decision alone; before the body is read.
	if (keyed(opts) && decision.status === 'closed') error(403, REOPEN_ACT);

	const closesAt = readTimestamp(body, 'closesAt', { required: true, future: true });
	if (closesTooFar(closesAt, stamp())) error(400, CLOSES_TOO_FAR);
	// Card 2682, D30: never earlier, for every source; both are stamps in one format, so the text compares as the time.
	if (decision.closesAt !== null && closesAt <= decision.closesAt) error(400, EXTENDS_EARLIER);

	const now = stamp();
	requireTransition(decision, 'extend', now);
	const row = db
		.update(decisions)
		.set({ status: 'open', closesAt, closedAt: null, updatedAt: now })
		.where(eq(decisions.id, decision.id))
		.returning()
		.get();
	appendEvent({ decisionId: decision.id, kind: 'extended', detail: { from: decision.closesAt, to: closesAt } }, actorFor(user, sourceOf(opts)));

	if (row.boardId !== null) {
		logActivity({ action: ACTIONS.decisionExtended, ...decisionEntry(row.boardId, `"${row.title}": closes ${closesAt.slice(0, 16)} UTC`, user, opts) });
		emit(row.boardId, 'decision', { decisionId: row.id, status: decisionStatus(row, now), boardId: row.boardId });
	}
	return row;
}

/**
 * Every refusal of `withdrawDecision`, in its order, read only (card 2697,
 * Q10, Q29): the decision looked for and the caller checked (`withdraw`: 401,
 * 404, 403), `reason` (400), and the status (409). Answers whether the
 * decision was ever opened (`openedAt` set: open or closed now), the one
 * thing that decides whether the withdraw route asks for the caller's
 * password: an opened decision's withdrawal is for good and mails every
 * participant the caller's words, while a draft's tells nobody.
 */
export function decisionWithdrawGuard(
	caller: SessionUser | null,
	at: { decisionId: number },
	body: RequestBody
): { user: SessionUser; decision: Decision; reason: string; wasOpened: boolean } {
	const user = requireUser(caller);
	const { decision } = requireDecision(user, at.decisionId, 'withdraw');

	const reason = readText(body, 'reason', { required: true, trim: true, min: 1, max: 2000 });

	requireTransition(decision, 'withdraw');
	return { user, decision, reason, wasOpened: decision.openedAt !== null };
}

/**
 * Withdraw a draft, an open or a closed decision: `reason` (text, trimmed, 1
 * to 2,000). `withdrawn`, `withdrawn_at` and the reason saved, and the
 * `withdrawn` event. Once it has been opened, its participants are mailed
 * `told_withdrawn` with the reason, and `decision_withdrawn` (never the
 * reason) and the live event are written while its board is there. With no
 * address to make a link on the withdrawal goes ahead, each mail recorded as
 * not sent (decision 17). A draft: nobody was told, so none of those.
 *
 * Every refusal is `decisionWithdrawGuard`'s, asked first; its internal route
 * asks for the caller's password between the two once the decision has been
 * opened (card 2697, Q29). Once opened, the service itself refuses 400
 * `STEP_UP_MISSING` unless it runs inside `whilePasswordHolds` for the
 * caller's own account (`requirePasswordHeld`, card 2726), whatever route
 * calls it; a key is refused before that, as it always was.
 */
export function withdrawDecision(caller: SessionUser | null, at: { decisionId: number }, body: RequestBody, opts: ServiceOptions): Decision {
	inWrite();
	const { user, decision, reason, wasOpened } = decisionWithdrawGuard(caller, at, body);
	// Card 2682, D5: where the page would ask the password, after every refusal the guard makes; no password is read.
	if (wasOpened && keyed(opts)) error(403, OPENED_ACT);
	// Card 2726: the password's proof, asked by the service, not left to the route.
	if (wasOpened) requirePasswordHeld(user.id);

	const now = stamp();
	const by = actorFor(user, sourceOf(opts));
	const row = db
		.update(decisions)
		.set({ status: 'withdrawn', withdrawnAt: now, withdrawnReason: reason, updatedAt: now })
		.where(eq(decisions.id, decision.id))
		.returning()
		.get();
	appendEvent({ decisionId: decision.id, kind: 'withdrawn', detail: { reason } }, by);
	if (decision.status === 'draft') return row;

	queueRecordMails(row, 'withdrawn', { by, reason });
	if (row.boardId !== null) {
		logActivity({ action: ACTIONS.decisionWithdrawn, ...decisionEntry(row.boardId, `"${row.title}"`, user, opts) });
		emit(row.boardId, 'decision', { decisionId: row.id, status: decisionStatus(row, now), boardId: row.boardId });
	}
	return row;
}

/**
 * Every refusal of `deleteDecision`, in its order, read only (card 2697, Q9,
 * Q10): the decision looked for and the caller checked (`delete`: 401, 404,
 * 403) and the status (409). Answers whether the decision holds a record
 * (`openedAt` set: it was opened, and then withdrawn), the one thing that
 * decides whether the delete route asks for the caller's password: the
 * cascade destroys its versions, responses and events for good. A draft never
 * opened holds none.
 */
export function decisionDeleteGuard(caller: SessionUser | null, at: { decisionId: number }): { user: SessionUser; decision: Decision; holdsRecord: boolean } {
	const user = requireUser(caller);
	const { decision } = requireDecision(user, at.decisionId, 'delete');

	requireTransition(decision, 'delete');
	return { user, decision, holdsRecord: decision.openedAt !== null };
}

/**
 * Delete a draft or a withdrawn decision, and by the cascade every row of it
 * (plan 4.9); any other status is 409 (D7). Once it had been opened,
 * `decision_deleted` and the live event, while its board is there.
 *
 * Every refusal is `decisionDeleteGuard`'s, asked first; its internal route
 * asks for the caller's password between the two where the decision holds a
 * record (card 2697, Q9). Where it holds one, the service itself refuses 400
 * `STEP_UP_MISSING` unless it runs inside `whilePasswordHolds` for the
 * caller's own account (`requirePasswordHeld`, card 2726), as the withdrawal.
 */
export function deleteDecision(caller: SessionUser | null, at: { decisionId: number }, body: null, opts: ServiceOptions): void {
	inWrite();
	const { user, decision, holdsRecord } = decisionDeleteGuard(caller, at);
	// Card 2682, D5: as the withdrawal.
	if (holdsRecord && keyed(opts)) error(403, OPENED_ACT);
	// Card 2726: as the withdrawal.
	if (holdsRecord) requirePasswordHeld(user.id);

	const now = stamp();
	// Card 2680 (decision 19, S7): each linked card keeps a trace on its own board, written before the delete cascades the
	// links away and before the early return below; "a linked decision was deleted", naming no decision.
	const links = db
		.select({ cardId: decisionCardLinks.cardId, boardId: columns.boardId })
		.from(decisionCardLinks)
		.innerJoin(cards, eq(cards.id, decisionCardLinks.cardId))
		.innerJoin(columns, eq(columns.id, cards.columnId))
		.where(eq(decisionCardLinks.decisionId, decision.id))
		.all();
	for (const link of links) {
		logActivity({ action: ACTIONS.decisionCardLinkDeleted, ...decisionEntry(link.boardId, 'a linked decision was deleted', user, opts, link.cardId) });
	}
	db.delete(decisions).where(eq(decisions.id, decision.id)).run();

	if (decision.openedAt === null || decision.boardId === null) return;
	logActivity({ action: ACTIONS.decisionDeleted, ...decisionEntry(decision.boardId, `"${decision.title}"`, user, opts) });
	emit(decision.boardId, 'decision', { decisionId: decision.id, status: decisionStatus(decision, now), boardId: decision.boardId });
}

/**
 * Link a card to the decision (card 2680, decisions 17, 20 to 22). The order
 * of refusals (D11): the decision (`linkCard`: 404, 403), the card
 * (`requireCard(…, 'edit')`: 404, 403), the status (409), the card archived
 * (409, before the link already there is looked for, so that linking an
 * archived card again is refused, not answered as nothing to do), the link
 * already there (the same relation: `unchanged`, nothing written; another:
 * the relation changed, `relation_changed`, the caps not asked), the caps
 * (409, a new link alone), then the link.
 *
 * Neither the link nor the change touches the decision's row, so neither of
 * its revisions moves (decision 20), and neither is on the decision's record.
 * One `decision_card_linked` on the **card's** board with its card, detail "a
 * decision" (S7): no id and no title, which the card's board's readers may
 * not view. No live event, no mail, no webhook.
 */
export function linkCard(
	caller: SessionUser | null,
	at: { decisionId: number; cardId: number; relation: CardLinkRelation },
	body: null,
	opts: ServiceOptions
): { outcome: LinkOutcome } {
	inWrite();
	const user = requireUser(caller);
	const { decision } = requireDecision(user, at.decisionId, 'linkCard');
	const { card, boardId } = requireCard(user, at.cardId, 'edit');

	const now = stamp();
	requireTransition(decision, 'linkCard', now);
	if (card.archivedAt !== null) error(409, 'This card is archived: it cannot be linked to a decision');
	if (!(CARD_LINK_RELATIONS as readonly string[]).includes(at.relation)) error(400, `relation must be one of: ${CARD_LINK_RELATIONS.join(', ')}`);

	const where = and(eq(decisionCardLinks.decisionId, decision.id), eq(decisionCardLinks.cardId, card.id));
	const existing = db.select({ relation: decisionCardLinks.relation }).from(decisionCardLinks).where(where).get();
	if (existing !== undefined) {
		if (existing.relation === at.relation) return { outcome: 'unchanged' };
		db.update(decisionCardLinks).set({ relation: at.relation }).where(where).run();
		logActivity({ action: ACTIONS.decisionCardLinked, ...decisionEntry(boardId, 'a decision', user, opts, card.id) });
		return { outcome: 'relation_changed' };
	}

	// S8: the decision's cap says a count, to an editor of the decision's board alone, and only at the cap.
	if (linkCountOf(decision.id) >= LINKS_PER_DECISION) error(409, `This decision is linked to ${LINKS_PER_DECISION} cards, the most it may be`);
	// Code review S3: the card's cap says no count. The card's links may be to decisions the caller cannot view, and a
	// count would tell them how many there are.
	if (cardLinkCountOf(card.id) >= LINKS_PER_CARD) error(409, 'This card has reached its limit of linked decisions');

	db.insert(decisionCardLinks).values({ decisionId: decision.id, cardId: card.id, relation: at.relation, createdBy: user.id, createdAt: now }).run();
	logActivity({ action: ACTIONS.decisionCardLinked, ...decisionEntry(boardId, 'a decision', user, opts, card.id) });
	return { outcome: 'linked' };
}

/**
 * Unlink a card from the decision (card 2680, decisions 17 and 20): the
 * decision (`unlinkCard`: 404, 403), the card (`requireCard(…, 'edit')`: 404,
 * 403), the status (409: every status but a draft, which holds none), and a
 * link that is not there (404). An archived card may be unlinked. One
 * `decision_card_unlinked` on the card's board with its card, detail "a
 * decision". The decision's row is not touched.
 */
export function unlinkCard(caller: SessionUser | null, at: { decisionId: number; cardId: number }, body: null, opts: ServiceOptions): void {
	inWrite();
	const user = requireUser(caller);
	const { decision } = requireDecision(user, at.decisionId, 'unlinkCard');
	const { card, boardId } = requireCard(user, at.cardId, 'edit');

	requireTransition(decision, 'unlinkCard', stamp());
	const removed = db
		.delete(decisionCardLinks)
		.where(and(eq(decisionCardLinks.decisionId, decision.id), eq(decisionCardLinks.cardId, card.id)))
		.run();
	if (removed.changes === 0) error(404, 'Link not found');
	logActivity({ action: ACTIONS.decisionCardUnlinked, ...decisionEntry(boardId, 'a decision', user, opts, card.id) });
}

/**
 * Mail the caller a dry run of the decision (card 2697, decision 19, Q1 to
 * Q3, Q8, Q20, Q26): the invitation as a consulted participant would get it,
 * quoting the working copy, never a version, to the address the people
 * directory holds for the caller's account, and to nobody else. `revision`
 * is required (Q1).
 *
 * Refused with nothing written, sent or counted: 409 for a stale revision,
 * after the status; 409 with no mail host, and with no address to make the
 * preview's link on; 409 when no person of the directory holds the caller's
 * account, or the one who does holds another address than the account's, as
 * an account's address is set by its holder and confirmed by nobody (Q26);
 * 429 within `DRY_RUN_MIN_MINUTES` of the caller's last dry run on any
 * decision, and once they have sent `DRY_RUN_DAILY_CAP` in 24 hours, read
 * from the record; and, last of all, 429 once the allowance held in memory
 * is spent, which a deletion of the decisions, and their events with them,
 * does not give back (Q2).
 *
 * Writes one `dry_run` event, with no participant and the detail `{}`, by the
 * caller; no `mail_*` event, link, activity entry or live event. The send
 * goes after the commit; a refused send gives nothing back.
 */
export function dryRunDecision(caller: SessionUser | null, at: { decisionId: number }, body: RequestBody, opts: ServiceOptions): void {
	inWrite();
	const user = requireUser(caller);
	if (keyed(opts)) error(403, MAIL_ACT);
	const { decision } = requireDecision(user, at.decisionId, 'dryRun');

	const revision = readText(body, 'revision', { required: true });

	const now = stamp();
	requireTransition(decision, 'dryRun', now);
	requireRevision(decision, revision);
	if (!isSmtpConfigured()) error(409, 'Mail is not set up on this server: a dry run cannot be sent');
	if (decisionLinkBase() === null) error(409, NO_LINK_ADDRESS);
	const person = personOfAccount(user.id);
	const asks = 'A dry run is sent only to the address the people directory holds for you';
	if (person === null) error(409, `${asks}, and it holds none for your account: an administrator can add you in People`);
	if (person.email.toLowerCase() !== user.email.toLowerCase()) {
		error(409, `${asks}, and it is not your account's address: an administrator can make them agree`);
	}

	// The rest and the cap read their ends as `mailRestOf` does, `later` and `now < from` (the code review's part B, F5, F7).
	const last = lastDryRunAt(user.id);
	const rested = last === null ? null : later(last, DRY_RUN_MIN_MINUTES * 60 * 1000);
	if (rested !== null && now < rested) error(429, `Your last dry run was less than ${DRY_RUN_MIN_MINUTES} minutes ago: the next can be sent from ${rested} UTC`);
	const capped = (from: Stamp) => `You have sent ${DRY_RUN_DAILY_CAP} dry runs in the last 24 hours: the next can be sent from ${from} UTC`;
	const fromEvents = dailyCapFrom(dryRunsSince(user.id, dayBefore()), DRY_RUN_DAILY_CAP);
	if (fromEvents !== null && now < fromEvents) error(429, capped(fromEvents));
	const took = takeAllowance(`decision-dry-run:${user.id}`, 1, DRY_RUN_DAILY_CAP, DAY_MS);
	if (!took.taken) error(429, capped(stamp(new Date(Date.now() + took.retryAfterSecs * 1000))));

	appendEvent({ decisionId: decision.id, kind: 'dry_run', detail: {} }, actorFor(user, sourceOf(opts)));
	const content = parseWorkingContent(decision.workingContent);
	queueDryRun(decision, { id: user.id, username: user.username, email: person.email }, { question: content.question, ask: content.ask });
}

/**
 * Send a participant their invitation again, to their snapshot address: a
 * link holder with a new link, replacing the last, and an account holder
 * with the decision's page. Writes `invited { resend: true }`. 404 for a
 * participant not on this decision. 409 for one removed; for each reason
 * `reachOf` skips one, in its words (decision 16); with no address to make a
 * link on (decision 28); and for one mailed in the last 10 minutes
 * (decision 31). 429 past the caller's record mail limit (the code review's
 * part B, S2).
 */
export function resendInvitation(
	caller: SessionUser | null,
	at: { decisionId: number; participantId: number },
	body: null,
	opts: ServiceOptions
): DecisionParticipant {
	inWrite();
	const user = requireUser(caller);
	if (keyed(opts)) error(403, MAIL_ACT);
	const { decision } = requireDecision(user, at.decisionId, 'resend');
	const participant = participantOn(decision.id, at.participantId);

	const now = stamp();
	requireTransition(decision, 'resend', now);
	if (participant.removedAt !== null) error(409, REMOVED_WORDS(participant.name));
	const reach = reachesOf(decision.id, [participant]).get(participant.id)!;
	if ('skip' in reach) error(409, SKIP_WORDS[reach.skip](participant.name));
	if (decisionLinkBase() === null) error(409, NO_LINK_ADDRESS);
	requireMailRested([participant], now);
	requireRecordMailAllowed(user, 1, now);

	const after = touch(decision.id, now);
	queueRecordMails(after, 'invitation', { by: actorFor(user, sourceOf(opts)), participants: [participant], resend: true });
	return participantOn(decision.id, participant.id);
}

/**
 * Every refusal of `setParticipantAccount`, in its order, read only (card
 * 2697, Q10): the decision looked for and the caller checked
 * (`participantAccount`: an administrator; 401, 404, 403), the participant on
 * it (404), `account` (400), the status (409), and then, for `person`, a
 * person who is gone or has no account, whose account the row already holds
 * (its code review's part B, F2), or whose account another live row holds
 * (409), and for `none`, a row that holds no account and is not read as
 * having held one (409). The account route asks it before the password, so
 * that none of these costs a check; the write asks it first, so the rules
 * are one. Answers what the write needs: the account to copy for `person`.
 */
export function participantAccountGuard(
	caller: SessionUser | null,
	at: { decisionId: number; participantId: number },
	body: RequestBody
): { user: SessionUser; decision: Decision; participant: DecisionParticipant; change: { account: 'person'; accountId: number } | { account: 'none' } } {
	const user = requireUser(caller);
	const { decision } = requireDecision(user, at.decisionId, 'participantAccount');
	const participant = participantOn(decision.id, at.participantId);

	const account = readChoice(body, 'account', { required: true, from: ACCOUNT_CHANGES });

	requireTransition(decision, 'participantAccount');
	// The rules are decision-links.ts's, which the delivery panel's offers ask too (the code review's part B, F2).
	if (account === 'person') {
		const person = participant.personId === null ? undefined : peopleById([participant.personId]).get(participant.personId);
		const attach = attachRefusal(participant, person, participantsOf(decision.id));
		if ('refusal' in attach) error(409, attach.refusal);
		return { user, decision, participant, change: { account, accountId: attach.accountId } };
	}
	const cleared = clearRefusal(participant, accountHistory(decision.id).get(participant.id) ?? false);
	if (cleared !== null) error(409, cleared);
	return { user, decision, participant, change: { account } };
}

/**
 * An administrator's change to the account a participant is reached by
 * (decision 14): `account`, `person` or `none`. Every refusal is
 * `participantAccountGuard`'s, asked first; its internal route asks for the
 * caller's password between the two (card 2697, Q9).
 *
 * `person` copies the person's account onto the row, ends their link, and
 * writes `account_attached { userId }`. 409 for a person who is gone or has
 * no account, or whose account another live row of the decision holds
 * (decision 29).
 *
 * `none` empties the row's account and writes `account_cleared { userId }`,
 * after which the row is read as never having held one (decision 16). 409
 * when the row holds none and is not read as having held one: there is
 * nothing to clear.
 */
export function setParticipantAccount(
	caller: SessionUser | null,
	at: { decisionId: number; participantId: number },
	body: RequestBody,
	opts: ServiceOptions
): DecisionParticipant {
	inWrite();
	requireUser(caller);
	// Card 2682, D6: the page asks the password for it; before any row is read.
	if (keyed(opts)) error(403, STEP_UP_ACT);
	const { user, decision, participant, change } = participantAccountGuard(caller, at, body);

	const by = actorFor(user, sourceOf(opts));
	const now = stamp();
	if (change.account === 'person') {
		db.update(decisionParticipants).set({ userId: change.accountId }).where(eq(decisionParticipants.id, participant.id)).run();
		revokeLinks({ participantId: participant.id }, 'account_attached', by);
		appendEvent({ decisionId: decision.id, kind: 'account_attached', participantId: participant.id, detail: { userId: change.accountId } }, by);
	} else {
		db.update(decisionParticipants).set({ userId: null }).where(eq(decisionParticipants.id, participant.id)).run();
		appendEvent({ decisionId: decision.id, kind: 'account_cleared', participantId: participant.id, detail: { userId: participant.userId } }, by);
	}
	touch(decision.id, now);
	return participantOn(decision.id, participant.id);
}

/**
 * Every refusal of `changeParticipantAddress`, in its order, read only (card
 * 2697, Q10, Q22): the decision looked for and the caller checked
 * (`participantAddress`: an administrator; 401, 404, 403), the participant on
 * it (404), the status (409), and then three 409s, each in plain words: the
 * person is no longer in the people directory, has left, or the row already
 * holds the address the directory holds. It reads no body: the address is
 * the directory's, never one sent. The address route asks it before the
 * password; the write asks it first. Answers the address to copy.
 */
export function participantAddressGuard(
	caller: SessionUser | null,
	at: { decisionId: number; participantId: number }
): { user: SessionUser; decision: Decision; participant: DecisionParticipant; email: string } {
	const user = requireUser(caller);
	const { decision } = requireDecision(user, at.decisionId, 'participantAddress');
	const participant = participantOn(decision.id, at.participantId);

	requireTransition(decision, 'participantAddress');
	const person = participant.personId === null ? undefined : peopleById([participant.personId]).get(participant.personId);
	const address = addressRefusal(participant, person);
	if ('refusal' in address) error(409, address.refusal);
	return { user, decision, participant, email: address.email };
}

/**
 * An administrator's "Use the directory's address" (card 2697, Q22; decision
 * 15, S7): the participant's address on the decision becomes the one the
 * people directory holds for their person now, as attaching an account copies
 * the person's account. No address is sent: one the directory does not hold
 * would make `reachOf` skip the participant for good. Ends their link and
 * writes `address_changed { from, to }`; sends nothing, as a re-send is an act
 * of its own. Every refusal is `participantAddressGuard`'s, asked first; its
 * internal route asks for the caller's password between the two (Q9).
 */
export function changeParticipantAddress(
	caller: SessionUser | null,
	at: { decisionId: number; participantId: number },
	body: null,
	opts: ServiceOptions
): DecisionParticipant {
	inWrite();
	requireUser(caller);
	if (keyed(opts)) error(403, STEP_UP_ACT);
	const { user, decision, participant, email } = participantAddressGuard(caller, at);

	const by = actorFor(user, sourceOf(opts));
	db.update(decisionParticipants).set({ email }).where(eq(decisionParticipants.id, participant.id)).run();
	revokeLinks({ participantId: participant.id }, 'participant_address', by);
	appendEvent({ decisionId: decision.id, kind: 'address_changed', participantId: participant.id, detail: { from: participant.email, to: email } }, by);
	touch(decision.id, stamp());
	return participantOn(decision.id, participant.id);
}

/**
 * A signed-in participant's response (card 2677, decisions 10 to 13): the
 * body of `respondAs`. 403 through an API key (D19), for an informed
 * participant, and for one `reachOf` no longer reaches through their account
 * (D12). Answers the response as `OwnResponse`, never the row, and whether it
 * was the same as the last, which writes nothing.
 */
export function respondToDecision(
	caller: SessionUser | null,
	at: { decisionId: number },
	body: RequestBody,
	opts: ServiceOptions
): { response: OwnResponse; unchanged: boolean } {
	inWrite();
	const user = requireUser(caller);
	const { decision, access } = requireDecision(user, at.decisionId, 'respond');
	if (keyed(opts)) error(403, PERSONS_ACT);
	const participant = ownParticipant(decision, access.participantId);
	if (participant.role !== 'consulted') error(403, 'Someone kept informed gives no response');
	requireReachedByAccount(decision.id, participant);

	return respondAs(decision, participant, body, actorFor(user, sourceOf(opts)), 'session', null);
}

/**
 * A link holder's response (card 2677, decisions 4, 9 and 10): the token
 * decides, through `participantForLink`, and any link that does not open a
 * decision is the one 404 (decision 6). Recorded `via: 'link'` with source
 * `link`, whatever source the route gives; a signed-in browser's account is noted
 * in the event's detail as `signedIn`, never as the actor (R8). Otherwise as
 * `respondToDecision`.
 */
export function respondByLink(
	caller: SessionUser | null,
	at: { token: string },
	body: RequestBody,
	opts: ServiceOptions
): { response: OwnResponse; unchanged: boolean } {
	inWrite();
	const { decision, participant } = requireLink(at.token);
	if (keyed(opts)) error(403, PERSONS_ACT);
	if (participant.role !== 'consulted') error(403, 'Someone kept informed gives no response');

	return respondAs(decision, participant, body, linkActor(participant), 'link', signedInOf(caller));
}

/**
 * Record that a signed-in participant has seen a version (card 2677,
 * decision 14): the body of `seenAs`. 403 through an API key, for a caller who
 * may view the decision and is no participant of it, and for one `reachOf`
 * no longer reaches through their account (D12).
 */
export function recordSeen(caller: SessionUser | null, at: { decisionId: number }, body: RequestBody, opts: ServiceOptions): { recorded: boolean } {
	inWrite();
	const user = requireUser(caller);
	const { decision, access } = requireDecision(user, at.decisionId, 'view');
	if (keyed(opts)) error(403, "Being recorded as having seen a decision is a person's act: it cannot be done with an API key");
	if (access.participantId === null) error(403, 'Only a participant of this decision is recorded as having seen it');
	const participant = ownParticipant(decision, access.participantId);
	requireReachedByAccount(decision.id, participant);

	return seenAs(decision, participant, body, actorFor(user, sourceOf(opts)), null);
}

/** Record that a link holder has seen a version (card 2677, decisions 9 and 14): as `recordSeen`, decided by the token, with the link's source. */
export function recordSeenByLink(caller: SessionUser | null, at: { token: string }, body: RequestBody, opts: ServiceOptions): { recorded: boolean } {
	inWrite();
	const { decision, participant } = requireLink(at.token);
	if (keyed(opts)) error(403, "Being recorded as having seen a decision is a person's act: it cannot be done with an API key");

	return seenAs(decision, participant, body, linkActor(participant), signedInOf(caller));
}

// ─── The ruling, the release and superseding (card 2679) ─────────────────────

/** How long a ruling's reason and its conditions may be (S7): the shared limit the ruling form shows (code review F8). */
const RULING_TEXT_MAX = DECISION_TEXT_MAX;

/** The most comment keys a release's `omit` may name: one for each comment the most participants could give. */
const MOST_OMITTED = MOST_PARTICIPANTS * (CONTENT_LIMITS.options + 1);

/**
 * Every refusal of `ruleDecision`, in its order, read only (card 2679,
 * decisions 2, 13 and 14): the decision looked for and the caller checked
 * (`rule`: its decider, who can edit its board while it exists; 401, 404,
 * 403), 403 through an API key, the body (400): `optionId`, one of the
 * current version's options or null for none of these, `reason`, 1 to 4,000
 * characters, `conditions`, up to 4,000, `revision`, and
 * `openQuestionsConfirmed`; the status (409: open or closed); and then
 * `rulingRefusals`' 409s, a results revision that is not the decision's as it
 * is now and questions still open unconfirmed. The rule route will ask it
 * before the caller's password, so that none of these costs a check; the
 * write asks it first, so the rules are one.
 */
export function decisionRuleGuard(
	caller: SessionUser | null,
	at: { decisionId: number },
	body: RequestBody,
	opts: ServiceOptions
): { user: SessionUser; decision: Decision; ruling: { optionId: number | null; reason: string; conditions: string | null } } {
	const user = requireUser(caller);
	const { decision } = requireDecision(user, at.decisionId, 'rule');
	if (keyed(opts)) error(403, "Ruling is a person's act: it cannot be done with an API key");

	const optionId = readId(body, 'optionId', { required: true, nullable: true });
	if (optionId !== null && !liveOptionIds(decision.id, decision.currentVersion).includes(optionId)) {
		error(400, `optionId ${optionId} is not an option of this decision's current version`);
	}
	const reason = readMultiline(body.reason, 'reason', RULING_TEXT_MAX, { trim: true });
	if (reason === '') error(400, 'reason is required');
	const conditions = readMultiline(body.conditions, 'conditions', RULING_TEXT_MAX, { trim: true });
	const revision = readText(body, 'revision', { required: true });
	const openQuestionsConfirmed = readBoolean(body, 'openQuestionsConfirmed', {}) ?? false;

	requireTransition(decision, 'rule');
	const [refusal] = rulingRefusals(decision, { revision, openQuestionsConfirmed });
	if (refusal !== undefined) error(409, refusal);
	return { user, decision, ruling: { optionId, reason, conditions: conditions === '' ? null : conditions } };
}

/**
 * Rule on an open or closed decision (card 2679, decisions 3, 5, 7, 11 and
 * 12): the option chosen, or none of these, the reason and the conditions.
 * Every refusal is `decisionRuleGuard`'s, asked first.
 *
 * The ruling row, `early` when the decision is shown open now and `against`
 * when there were votes and the choice is not among the most chosen; the
 * decision `ruled`, with `ruled_at`; `ruled { optionId, early,
 * againstResponses, productOwnerUserId }`, the last the board's Product Owner
 * now, or null, which is the one `productOwner` who may supersede this ruling
 * from then on (code review S1); on an early ruling `cut_off` for each live consulted
 * participant with no response in the round; and the ruling mail to every
 * live participant, which is held to no rest or cap and counted against
 * none, and with no link address goes ahead recorded as not sent. While its
 * board is there, `decision_ruled` (the title alone) and the live event.
 *
 * A decision that supersedes another still ruled (decision 5, S2): when the
 * caller may supersede that one now (its decider, its board's Product Owner or
 * an administrator, with the board-edit rule), it becomes `superseded`, with
 * `superseded { byDecisionId }`, `decision_superseded` on its board and the
 * live event; otherwise it stays ruled and nothing is written on it. The
 * ruling's event says which, `supersededOld`.
 */
export function ruleDecision(caller: SessionUser | null, at: { decisionId: number }, body: RequestBody, opts: ServiceOptions): Decision {
	inWrite();
	const { user, decision, ruling } = decisionRuleGuard(caller, at, body, opts);

	const now = stamp();
	const by = actorFor(user, sourceOf(opts));
	const voteMode = decision.voteMode === 'score' ? 'score' : 'single';
	const { tally, notResponded } = currentResultsOf(decision);
	const early = decisionStatus(decision, now) === 'open';
	const againstResponses = againstOf(ruling.optionId, tally.voted, mostChosenOf(tally, voteMode));
	// Code review S1: who may supersede this ruling is frozen at it, the board's Product Owner as it names one now.
	const productOwnerUserId =
		decision.boardId === null ? null : (db.select({ id: boards.productOwnerUserId }).from(boards).where(eq(boards.id, decision.boardId)).get()?.id ?? null);

	// Decision 5 (S2): the old decision is superseded only by a ruler who may supersede it now, its Product Owner as its ruling recorded them (S1).
	const old = decision.supersedesId === null ? null : (db.select().from(decisions).where(eq(decisions.id, decision.supersedesId)).get() ?? null);
	const supersedesOld = old !== null && old.status === 'ruled' && mayDo(decisionAccess(user, old), 'supersede', old);

	const record = appendRuling({ decisionId: decision.id, versionNumber: decision.currentVersion, ...ruling, againstResponses, early }, by);
	const row = db
		.update(decisions)
		.set({ status: 'ruled', ruledAt: record.ruledAt, updatedAt: now })
		.where(eq(decisions.id, decision.id))
		.returning()
		.get();
	appendEvent(
		{
			decisionId: decision.id,
			kind: 'ruled',
			versionNumber: decision.currentVersion,
			detail: {
				optionId: ruling.optionId,
				early,
				againstResponses,
				productOwnerUserId,
				...(decision.supersedesId === null ? {} : { supersededOld: supersedesOld })
			}
		},
		by
	);
	if (early) for (const participant of notResponded) appendEvent({ decisionId: decision.id, kind: 'cut_off', participantId: participant.id }, by);

	const chosen = ruling.optionId === null ? undefined : versionOptionsOf(decision.id, decision.currentVersion).find((option) => option.optionId === ruling.optionId);
	const label = ruling.optionId === null ? null : (chosen?.label ?? allOptionsOf(decision.id).find((option) => option.id === ruling.optionId)?.label ?? null);
	queueRecordMails(row, 'ruling', {
		by,
		ruling: { optionLabel: label, optionTitle: chosen?.title || null, reason: ruling.reason, conditions: ruling.conditions }
	});

	if (row.boardId !== null) {
		logActivity({ action: ACTIONS.decisionRuled, ...decisionEntry(row.boardId, `"${row.title}"`, user, opts) });
		emit(row.boardId, 'decision', { decisionId: row.id, status: decisionStatus(row, now), boardId: row.boardId });
	}

	if (old !== null && supersedesOld) {
		const superseded = db.update(decisions).set({ status: 'superseded', updatedAt: now }).where(eq(decisions.id, old.id)).returning().get();
		appendEvent({ decisionId: old.id, kind: 'superseded', detail: { byDecisionId: decision.id } }, by);
		if (superseded.boardId !== null) {
			logActivity({ action: ACTIONS.decisionSuperseded, ...decisionEntry(superseded.boardId, `"${superseded.title}"`, user, opts) });
			emit(superseded.boardId, 'decision', { decisionId: superseded.id, status: decisionStatus(superseded, now), boardId: superseded.boardId });
		}
	}
	return row;
}

/**
 * Every refusal of `releaseResults`, in its order, read only (card 2679,
 * decisions 2, 10, 14, 20, 25 and 27): the decision looked for and the caller
 * checked (`release`: its decider alone; 401, 404, 403), 403 through an API
 * key, the body (400): `revision`, required, and `omit`, an optional list of
 * the preview's comment keys; the status (409: stored `ruled` alone); then
 * `releaseRefusals`' 409s, already released, fewer than 3 responses, a
 * response given before the who-sees statement said the results could be
 * released, and a release in the supersede chain from people 1 or 2 apart; a
 * results revision that is not the decision's as it is now (409); and, last,
 * an `omit` key that is no comment the release would show (400). Answers the
 * comments left out, each as its response and field.
 */
export function resultsReleaseGuard(
	caller: SessionUser | null,
	at: { decisionId: number },
	body: RequestBody,
	opts: ServiceOptions
): { user: SessionUser; decision: Decision; omitted: { responseId: number; field: string }[] } {
	const user = requireUser(caller);
	const { decision } = requireDecision(user, at.decisionId, 'release');
	if (keyed(opts)) error(403, "Releasing results is a person's act: it cannot be done with an API key");

	const revision = readText(body, 'revision', { required: true });
	const omit = readList(body, 'omit', { max: MOST_OMITTED }) ?? [];
	const keys = omit.map((key, index) => {
		if (typeof key !== 'string') error(400, `omit[${index}] must be text`);
		return key;
	});

	requireTransition(decision, 'release');
	const [refusal] = releaseRefusals(decision);
	if (refusal !== undefined) error(409, refusal);
	if (resultsRevisionFor(decision.id) !== revision) error(409, STALE_REVISION);
	const shown = commentKeysOf(decision);
	const omitted = new Map<string, { responseId: number; field: string }>();
	keys.forEach((key, index) => {
		const comment = shown.get(key);
		if (comment === undefined) error(400, `omit[${index}] is not a comment this release would show`);
		omitted.set(key, comment);
	});
	return { user, decision, omitted: [...omitted.values()] };
}

/**
 * Release a ruled decision's totals and comments, without names, to everyone
 * who may view it (card 2679, decision 10): for good. Every refusal is
 * `resultsReleaseGuard`'s, asked first. `results_released_at` and `_by`;
 * `results_released { upToResponseId, omitted }`, the highest response id
 * counted, which freezes what is shown, and each comment left out; and, while
 * its board is there, `decision_results_released` (the title alone) and the
 * live event. It mails nobody.
 */
export function releaseResults(caller: SessionUser | null, at: { decisionId: number }, body: RequestBody, opts: ServiceOptions): Decision {
	inWrite();
	const { user, decision, omitted } = resultsReleaseGuard(caller, at, body, opts);

	const now = stamp();
	const upToResponseId = responsesOf(decision.id).at(-1)?.id ?? 0;
	const row = db
		.update(decisions)
		.set({ resultsReleasedAt: now, resultsReleasedBy: user.id, updatedAt: now })
		.where(eq(decisions.id, decision.id))
		.returning()
		.get();
	appendEvent({ decisionId: decision.id, kind: 'results_released', detail: { upToResponseId, omitted } }, actorFor(user, sourceOf(opts)));

	if (row.boardId !== null) {
		logActivity({ action: ACTIONS.decisionResultsReleased, ...decisionEntry(row.boardId, `"${row.title}"`, user, opts) });
		emit(row.boardId, 'decision', { decisionId: row.id, status: decisionStatus(row, now), boardId: row.boardId });
	}
	return row;
}

/**
 * Make a draft that supersedes a ruled decision (card 2679, decision 5, S2):
 * its decider's, its board's Product Owner's or an administrator's, each who
 * can edit the board now (`supersede`; 401, 404, 403). `title`, optional, the
 * old title when not sent (as `readTitle`, 400). 409 unless the decision is
 * stored `ruled`; when its board is gone, as a draft with no board could never
 * be opened; and while another decision superseding it is not withdrawn.
 *
 * The draft is on the same board, its name as now, the caller its author,
 * `vote_mode` copied, no closing time and no participants, `supersedes_id`
 * this decision. Its decider is the old decision's, while that account can
 * edit the board now, and otherwise the caller: never anyone the caller
 * named, so that a ruling cannot be overturned through a draft whose decider
 * they chose. Its working content is the version ruled on, through
 * `workingFromVersion`, each option a new row labelled from A in order. Writes
 * `created { decider, supersedes }` on the draft alone; no activity entry, no
 * live event and no mail (a draft).
 */
export function supersedeDecision(caller: SessionUser | null, at: { decisionId: number }, body: RequestBody, opts: ServiceOptions): Decision {
	inWrite();
	const user = requireUser(caller);
	const { decision } = requireDecision(user, at.decisionId, 'supersede');

	const title = readTitle(body, { required: false }) ?? decision.title;

	requireTransition(decision, 'supersede');
	const board = decision.boardId === null ? undefined : db.select().from(boards).where(eq(boards.id, decision.boardId)).get();
	if (board === undefined) error(409, "This decision's board has been deleted: a decision superseding it could never be opened");
	if (supersedingOf(decision.id) !== null) error(409, 'A later decision that supersedes this one already exists');

	const previous =
		decision.deciderUserId === null
			? undefined
			: db.select({ id: users.id, username: users.username, role: users.role }).from(users).where(eq(users.id, decision.deciderUserId)).get();
	const decider = previous !== undefined && canEditBoard(previous, board.id) ? previous : null;
	const version = db
		.select({ content: decisionVersions.content })
		.from(decisionVersions)
		.where(and(eq(decisionVersions.decisionId, decision.id), eq(decisionVersions.number, decision.currentVersion)))
		.get();
	const content = parseVersionContent(version?.content ?? '{}');

	const now = stamp();
	const draft = db
		.insert(decisions)
		.values({
			boardId: board.id,
			boardName: board.name,
			title,
			voteMode: decision.voteMode,
			authorUserId: user.id,
			authorName: user.username,
			deciderUserId: decider?.id ?? user.id,
			deciderName: decider?.username ?? user.username,
			closesAt: null,
			supersedesId: decision.id,
			createdAt: now,
			updatedAt: now
		})
		.returning()
		.get();
	const optionIds = new Map<number, number>();
	content.options.forEach((option, index) => {
		const made = db.insert(decisionOptions).values({ decisionId: draft.id, label: String.fromCharCode(65 + index), position: index }).returning().get();
		optionIds.set(option.optionId, made.id);
	});
	const row = db
		.update(decisions)
		.set({ workingContent: JSON.stringify(workingFromVersion(content, optionIds)) })
		.where(eq(decisions.id, draft.id))
		.returning()
		.get();
	appendEvent(
		{ decisionId: draft.id, kind: 'created', detail: { decider: decider !== null ? 'previous_decider' : 'author', supersedes: decision.id } },
		actorFor(user, sourceOf(opts))
	);
	return row;
}

// ─── A participant's concern about the ruling (card 2679, decisions 3 and 4) ─

// The most concerns one participant raises about one ruling (decision 4) is `$lib/decision-rules.ts`'s
// `CONCERNS_PER_PARTICIPANT`, which the page asks too, so that it offers no form past it (code review F9).

/** The 403 for a concern through an API key (decision 14, D19). */
const CONCERN_ACT = "Raising a concern is a person's act: it cannot be done with an API key";

/**
 * A signed-in participant's concern about the ruling (card 2679, decision 4):
 * the body of `concernAs`. 403 through an API key (D19), and for one `reachOf`
 * no longer reaches through their account (D12). A participant kept informed
 * may raise one: the ruling affects them too, and a concern is not a vote.
 * Answers the concern as `OwnConcern`, with no id.
 */
export function raiseConcern(caller: SessionUser | null, at: { decisionId: number }, body: RequestBody, opts: ServiceOptions): { concern: OwnConcern } {
	inWrite();
	const user = requireUser(caller);
	const { decision, access } = requireDecision(user, at.decisionId, 'concern');
	if (keyed(opts)) error(403, CONCERN_ACT);
	if (access.participantId === null) error(403, `You cannot ${DECISION_ACTION_WORDS.concern.verb} this decision`);
	const participant = participantOn(decision.id, access.participantId);
	requireReachedByAccount(decision.id, participant);

	return concernAs(decision, participant, body, actorFor(user, sourceOf(opts)), 'session', null);
}

/**
 * A link holder's concern about the ruling (card 2679, decision 4): the token
 * decides, through `participantForLink`, and any link that opens no decision
 * is the one 404, a link past its 90 days after the ruling among them
 * (`linkUsable`). Recorded `via: 'link'` with source `link`, whatever
 * source the route gives; a signed-in browser's account is noted as `signedIn`.
 * Otherwise as `raiseConcern`.
 */
export function raiseConcernByLink(caller: SessionUser | null, at: { token: string }, body: RequestBody, opts: ServiceOptions): { concern: OwnConcern } {
	inWrite();
	const { decision, participant } = requireLink(at.token);
	if (keyed(opts)) error(403, CONCERN_ACT);

	return concernAs(decision, participant, body, linkActor(participant), 'link', signedInOf(caller));
}

// ─── Clarification questions and their answers (card 2678) ───────────────────

// The most questions one participant asks on one decision (decision 4) is `$lib/decision-rules.ts`'s `QUESTIONS_PER_PARTICIPANT`, which
// the page asks too, so that it offers no form past it.

/** The most questions one decision takes, from everyone (decision 4): the page draws every one. */
const QUESTIONS_PER_DECISION = 200;

/** The most questions one account asks, signed in or through an API key, across every decision, in 24 hours (decision 4, S10). */
const QUESTIONS_PER_CALLER_DAILY = 30;

/** The 403 for a question by a personal link through an API key (S5): a personal link is no API credential. */
const LINK_QUESTION_ACT = "Asking by a personal link is a person's act: it cannot be done with an API key";

/** The 403 for publishing an agent's draft through an API key (decision 8): publishing is the review. */
const PUBLISH_ACT = "Publishing an agent's answer is a person's act: it cannot be done with an API key";

/** The 403 for replacing an agent's draft through an API key (decision 8). */
const REPLACE_ACT = "Replacing an agent's answer is a person's act: it cannot be done with an API key";

/**
 * A participant's clarification question, signed in or through an API key
 * (card 2678, decisions 1 and 17): the body of `questionAs`. 403 for a caller
 * who is no participant, and for one `reachOf` no longer reaches through their
 * account (D12). A participant kept informed may ask. Through an API key the
 * question is the key's own account's, recorded `via: 'api'`. Answers the
 * question as `OwnQuestion`, with no id.
 */
export function askQuestion(caller: SessionUser | null, at: { decisionId: number }, body: RequestBody, opts: ServiceOptions): { question: OwnQuestion } {
	inWrite();
	const user = requireUser(caller);
	const { decision, access } = requireDecision(user, at.decisionId, 'ask');
	if (access.participantId === null) error(403, `You cannot ${DECISION_ACTION_WORDS.ask.verb} this decision`);
	const participant = participantOn(decision.id, access.participantId);
	requireReachedByAccount(decision.id, participant);

	// Fail closed (code review S3): only the page's own source is recorded as a session.
	return questionAs(decision, participant, body, actorFor(user, sourceOf(opts)), keyed(opts) ? 'api' : 'session', null, user, sourceOf(opts));
}

/**
 * A link holder's clarification question (card 2678, decisions 13 and 17):
 * the token decides, through `participantForLink`, and any link that opens no
 * decision is the one 404. A person's act alone (S5): 403 unless `source:
 * 'ui'`. Recorded `via: 'link'` with source `link`; a signed-in browser's
 * account is noted as `signedIn`, never as the asker. No per-caller cap: a
 * link holder has no account, and the per-participant cap holds them.
 */
export function askQuestionByLink(caller: SessionUser | null, at: { token: string }, body: RequestBody, opts: ServiceOptions): { question: OwnQuestion } {
	inWrite();
	const { decision, participant } = requireLink(at.token);
	if (keyed(opts)) error(403, LINK_QUESTION_ACT);

	return questionAs(decision, participant, body, linkActor(participant), 'link', signedInOf(caller), null, sourceOf(opts));
}

/**
 * The author's or the decider's answer to a question of the decision (card
 * 2678, decisions 7, 8, 17 and 19), or, with `replacesDraft: true`, a
 * person's answer in place of an agent's draft. The body: `answer`, required,
 * trimmed, 1 to 4,000 characters, with no control character (400); and
 * `replacesDraft`, true or false. In decision 17's order: the guard (404,
 * 403), 403 for `replacesDraft` through an API key, 404 for a question not on
 * this decision, the body's 400, the status's 409 (open or closed), and the
 * state's 409: answered, a draft waiting without `replacesDraft`
 * (`DRAFT_PENDING`), or `replacesDraft` with none (`NO_DRAFT`).
 *
 * Through an API key the answer is an agent's draft, which only the author,
 * the decider and administrators see and the asker is not told of
 * (`awaiting_review`). A replacement copies the draft into the record's
 * `answer_replaced` before it is overwritten. The row is settled by a guarded
 * update, and one that changes nothing is a 409 that rolls the write back.
 * The answerer's role is fixed now, on the event. Answers the question as the
 * caller is given it.
 */
export function answerQuestion(
	caller: SessionUser | null,
	at: { decisionId: number; questionId: number },
	body: RequestBody,
	opts: ServiceOptions
): { question: QuestionView } {
	inWrite();
	const user = requireUser(caller);
	const { decision, access } = requireDecision(user, at.decisionId, 'answer');
	// A key may only draft (decision 8): putting a person's answer in place of an agent's is a person's act.
	if (keyed(opts) && body.replacesDraft !== undefined && body.replacesDraft !== false) error(403, REPLACE_ACT);
	const row = requireQuestion(decision, at.questionId);
	const answer = readMultiline(body.answer, 'answer', DECISION_TEXT_MAX, { trim: true });
	if (answer === '') error(400, 'answer is required');
	const replacesDraft = readBoolean(body, 'replacesDraft', {}) ?? false;

	requireTransition(decision, 'answer', stamp());
	const drafted = pendingDraft(row);
	if (replacesDraft && !drafted) error(409, NO_DRAFT);
	if (!replacesDraft && row.answer !== null) error(409, drafted ? DRAFT_PENDING : ANSWERED);

	const by = actorFor(user, sourceOf(opts));
	const role = answererRoleOf(access);
	if (replacesDraft) {
		const discarded = { text: row.answer, byName: row.answeredByName, at: row.answeredAt };
		if (!recordDraftReplaced(row.id, answer, by)) error(409, NO_DRAFT);
		const notice = answerNoticeOf(decision, row);
		appendEvent({ decisionId: decision.id, kind: 'answer_replaced', detail: { questionId: row.id, role, discarded, notice: notice.outcome } }, by);
		const replaced = answererViewOf(decision, access, row.id, sourceOf(opts));
		if (notice.outcome === 'asked') notifyQuestionAnswered(notice.to, decision.id, decision.title);
		return { question: replaced };
	}

	// Fail closed (code review S3): any source but the page's drafts, and a person must stand behind it.
	const agentDrafted = keyed(opts);
	if (!recordAnswer(row.id, answer, by, agentDrafted)) error(409, ANSWERED);
	// Decision 8: an agent's draft is not mailed until a person stands behind it.
	const notice = agentDrafted ? { outcome: 'awaiting_review' as const } : answerNoticeOf(decision, row);
	appendEvent({ decisionId: decision.id, kind: 'question_answered', detail: { questionId: row.id, role, agentDrafted, notice: notice.outcome } }, by);
	const answered = answererViewOf(decision, access, row.id, sourceOf(opts));
	if (notice.outcome === 'asked') notifyQuestionAnswered(notice.to, decision.id, decision.title);
	return { question: answered };
}

/**
 * Publish an agent's draft answer (card 2678, decisions 8 and 17): the
 * review, by the author or the decider, signed in alone (403 through an API
 * key). The text cannot change in it. 404 for a question not on this
 * decision; the status's 409; and 409 for a question with no answer, one a
 * person answered (a replaced draft among them) and a draft published
 * already. The row is settled by a guarded update (a 409 when it changes
 * nothing), `answer_published` recorded, and the asker told. It takes no body.
 */
export function publishAnswer(
	caller: SessionUser | null,
	at: { decisionId: number; questionId: number },
	body: null,
	opts: ServiceOptions
): { question: QuestionView } {
	inWrite();
	const user = requireUser(caller);
	const { decision, access } = requireDecision(user, at.decisionId, 'answer');
	if (keyed(opts)) error(403, PUBLISH_ACT);
	const row = requireQuestion(decision, at.questionId);

	requireTransition(decision, 'answer', stamp());
	if (row.answer === null) error(409, NOTHING_TO_PUBLISH);
	if (!row.answerAgentDrafted) error(409, PERSON_ANSWERED);
	if (row.answerReviewedAt !== null) error(409, ALREADY_PUBLISHED);

	const by = actorFor(user, sourceOf(opts));
	if (!recordDraftPublished(row.id, by)) error(409, ALREADY_PUBLISHED);
	const notice = answerNoticeOf(decision, row);
	appendEvent({ decisionId: decision.id, kind: 'answer_published', detail: { questionId: row.id, notice: notice.outcome } }, by);
	const published = answererViewOf(decision, access, row.id, sourceOf(opts));
	if (notice.outcome === 'asked') notifyQuestionAnswered(notice.to, decision.id, decision.title);
	return { question: published };
}

// ─── Inside the writes ───────────────────────────────────────────────────────

/** What a participant row copies from a person's snapshot (S7). */
function snapshotColumns(snapshot: NonNullable<ReturnType<typeof snapshotOf>>) {
	return { name: snapshot.name, email: snapshot.email, jobTitle: snapshot.jobTitle, groups: snapshot.groups, userId: snapshot.userId };
}

/** The participant row of this decision, or 404 for one that is not on it. */
function participantOn(decisionId: number, participantId: number): DecisionParticipant {
	const row = db
		.select()
		.from(decisionParticipants)
		.where(and(eq(decisionParticipants.id, participantId), eq(decisionParticipants.decisionId, decisionId)))
		.get();
	if (!row) error(404, 'Participant not found');
	return row;
}

/** The caller's own live participant row, which the guard found (`access.participantId`); 403 for none. */
function ownParticipant(decision: Decision, participantId: number | null): DecisionParticipant {
	if (participantId === null) error(403, `You cannot ${DECISION_ACTION_WORDS.respond.verb} this decision`);
	return participantOn(decision.id, participantId);
}

/** A 403 unless `reachOf` still reaches the participant through their account (card 2677, D12): one who has left, or lost the account or the address, is not. */
function requireReachedByAccount(decisionId: number, participant: DecisionParticipant): void {
	const reach = reachesOf(decisionId, [participant]).get(participant.id)!;
	if (!('via' in reach) || reach.via !== 'account') error(403, NO_LONGER_REACHED);
}

/** The participant and decision a personal link is for, or the one 404 for any link that opens none (card 2677, decision 6). */
function requireLink(token: string): { decision: Decision; participant: DecisionParticipant } {
	const found = participantForLink(token);
	if ('refused' in found) error(404, DEAD_DECISION_LINK);
	return found;
}

/** The record's actor for a link holder: no account, the participant's snapshot name, and the link's own source (decision 10). */
function linkActor(participant: DecisionParticipant): RecordActor {
	return { userId: null, name: participant.name, source: 'link' };
}

/** The signed-in account beside a link holder's act, noted in its event's detail (decision 9, R8), or null with no session. */
function signedInOf(caller: SessionUser | null): { userId: number; name: string } | null {
	return caller ? { userId: caller.id, name: caller.username } : null;
}

/**
 * A response, from either way in (card 2677, decisions 11 to 13). The body:
 * `versionNumber` and `kind` (`vote`, `abstain`, `no_concerns`), required; a
 * vote's `optionId`, one of the current version's live options, in single
 * mode, or its `scores`, a whole number 0 to 5 for every live option and no
 * other, in score mode; neither for the others; `comment`, trimmed, up to
 * 4,000; `optionComments`, keyed by live option ids, each trimmed, up to
 * 2,000, the empty ones dropped. The keyed objects are stored as built from
 * the live ids, never from the body's keys (R9). Then 409 unless the decision
 * is stored and shown open (decision 12), for a version that is not the
 * current one, and past `RESPONSES_PER_ROUND` in the round. A response the
 * same as the participant's latest in the round, for the same version,
 * writes nothing; the same answer for a newer version is a new row bound to
 * it. Otherwise the
 * row (`replaces_id` that latest), `responded { responseId }`, and
 * `seen { stage: 'question' }` for the version where there is none.
 *
 * Card 2679 (decision 25): `statement`, optional, a whole number, the version
 * of the who-sees statement the page showed. The current one is recorded on
 * `responded { responseId, statement }`; any other is a 409 (the page is out
 * of date); none sent records none. The same answer sent with the current
 * statement, where the latest was recorded under none, is a new row, so that
 * a participant can bring an answer under the statement that says the results
 * may be released.
 */
function respondAs(
	decision: Decision,
	participant: DecisionParticipant,
	body: RequestBody,
	by: RecordActor,
	via: 'session' | 'link',
	signedIn: { userId: number; name: string } | null
): { response: OwnResponse; unchanged: boolean } {
	const versionNumber = readNumber(body, 'versionNumber', { required: true, whole: true, min: 1 });
	const kind = readChoice(body, 'kind', { required: true, from: RESPONSE_KINDS });
	const live = liveOptionIds(decision.id, decision.currentVersion);
	const keys = live.map((id) => `${id}`);
	let optionId: number | null = null;
	let scores: string | null = null;
	if (kind === 'vote' && decision.voteMode === 'score') {
		if (Object.hasOwn(body, 'optionId')) error(400, 'optionId cannot be sent: this decision asks for a score for each option');
		scores = readScores(body, keys);
	} else {
		if (Object.hasOwn(body, 'scores')) error(400, kind === 'vote' ? 'scores cannot be sent: this decision asks for one choice' : `scores cannot be sent with ${kind}`);
		if (kind === 'vote') {
			optionId = readId(body, 'optionId', { required: true });
			if (!live.includes(optionId)) error(400, `optionId ${optionId} is not an option of this decision's current version`);
		} else if (Object.hasOwn(body, 'optionId')) {
			error(400, `optionId cannot be sent with ${kind}`);
		}
	}
	const comment = readMultiline(body.comment, 'comment', COMMENT_MAX, { trim: true });
	const optionComments = readOptionComments(body, keys);
	// Card 2679 (decision 25): the version of the who-sees statement the page showed.
	const statement = readNumber(body, 'statement', { whole: true });

	const now = stamp();
	requireTransition(decision, 'respond', now);
	// Decision 12: stored open is not enough once `closes_at` has passed.
	if (decisionStatus(decision, now) !== 'open') error(409, 'This decision is awaiting a ruling: responses are closed');
	if (versionNumber !== decision.currentVersion) error(409, STALE_REVISION);
	// A page that showed another statement is out of date: it must be reloaded (card 2679, decision 25).
	if (statement !== undefined && statement !== WHO_SEES_STATEMENT_VERSION) error(409, STALE_REVISION);
	const round = currentRound(decision.id);
	const latest = latestResponse(participant.id, round);
	const answer = { kind, optionId, scores, comment: comment === '' ? null : comment, optionComments };
	// The same answer on the same version alone writes nothing: confirmed on a newer one, it is bound to that one (code review C1);
	// sent under the current statement where the last was given under none, it is recorded anew under it (card 2679, decision 25).
	if (
		latest !== null &&
		latest.versionNumber === versionNumber &&
		latest.kind === answer.kind &&
		latest.optionId === answer.optionId &&
		latest.scores === answer.scores &&
		latest.comment === answer.comment &&
		latest.optionComments === answer.optionComments &&
		(statement === undefined || statementsOf(decision.id).get(latest.id) === WHO_SEES_STATEMENT_VERSION)
	) {
		return { response: ownResponseOf(latest), unchanged: true };
	}
	if (responsesInRound(participant.id, round) >= RESPONSES_PER_ROUND) {
		error(409, 'You have changed your response too many times in this round: ask the decider');
	}

	const row = appendResponse({
		decisionId: decision.id,
		participantId: participant.id,
		versionNumber,
		round,
		...answer,
		replacesId: latest?.id ?? null,
		via
	});
	const signed = signedIn === null ? {} : { signedIn };
	appendEvent(
		{
			decisionId: decision.id,
			kind: 'responded',
			participantId: participant.id,
			versionNumber,
			detail: { responseId: row.id, ...(statement === undefined ? {} : { statement }), ...signed }
		},
		by
	);
	if (!hasSeen(participant.id, versionNumber, 'question')) {
		appendEvent({ decisionId: decision.id, kind: 'seen', participantId: participant.id, versionNumber, detail: { stage: 'question', ...signed } }, by);
	}
	return { response: ownResponseOf(row), unchanged: false };
}

/**
 * A concern about the ruling, from either way in (card 2679, decisions 3 and
 * 4). The body: `comment`, required, trimmed, 1 to 4,000 characters, with no
 * control character (400). Then 409 for a superseded ruling
 * (`CONCERN_SUPERSEDED`), for any status but stored `ruled`, past 90 days
 * after the ruling (`CONCERN_WINDOW_ENDED`; a link is refused before this by
 * `participantForLink`), and for a sixth concern; and 429 within 10 minutes
 * of the participant's last, saying from when, in UTC.
 *
 * Writes the row (`kind 'concern'`, the current round and version, no option,
 * via the way in), `concern_raised { responseId, notice }` naming the
 * participant, `seen { stage: 'ruling' }` for the version where there is none,
 * and, for `notice: 'asked'`, the decider's notice after the commit. No
 * activity entry, no live event (design S3). The notice's outcome is
 * `noticeOf`'s, and mail never refuses a concern.
 */
function concernAs(
	decision: Decision,
	participant: DecisionParticipant,
	body: RequestBody,
	by: RecordActor,
	via: 'session' | 'link',
	signedIn: { userId: number; name: string } | null
): { concern: OwnConcern } {
	const comment = readMultiline(body.comment, 'comment', COMMENT_MAX, { trim: true });
	if (comment === '') error(400, 'comment is required');

	const now = stamp();
	if (decision.status === 'superseded') error(409, CONCERN_SUPERSEDED);
	requireTransition(decision, 'concern', now);
	if (!linkUsable(decision, now)) error(409, CONCERN_WINDOW_ENDED);
	const earlier = concernsOf({ participantId: participant.id });
	if (earlier.length >= CONCERNS_PER_PARTICIPANT) {
		error(409, `You have raised ${CONCERNS_PER_PARTICIPANT} concerns about this ruling: no more can be raised`);
	}
	const last = earlier.at(-1);
	const rested = last === undefined ? null : later(last.createdAt, RECORD_MAIL_MIN_MINUTES * 60 * 1000);
	if (rested !== null && now < rested) {
		error(429, `Your last concern was raised less than ${RECORD_MAIL_MIN_MINUTES} minutes ago: the next can be raised from ${rested} UTC`);
	}

	const row = appendResponse({
		decisionId: decision.id,
		participantId: participant.id,
		versionNumber: decision.currentVersion,
		round: currentRound(decision.id),
		kind: 'concern',
		optionId: null,
		scores: null,
		comment,
		optionComments: null,
		replacesId: null,
		via
	});
	const notice = noticeOf(decision, participant.id, now);
	const signed = signedIn === null ? {} : { signedIn };
	appendEvent(
		{
			decisionId: decision.id,
			kind: 'concern_raised',
			participantId: participant.id,
			versionNumber: decision.currentVersion,
			detail: { responseId: row.id, notice: notice.outcome, ...signed }
		},
		by
	);
	if (!hasSeen(participant.id, decision.currentVersion, 'ruling')) {
		appendEvent(
			{ decisionId: decision.id, kind: 'seen', participantId: participant.id, versionNumber: decision.currentVersion, detail: { stage: 'ruling', ...signed } },
			by
		);
	}
	if (notice.outcome === 'asked') notifyDecisionConcern(notice.deciderUserId, decision.id, decision.title, notice.heldBefore);
	return { concern: { comment, createdAt: row.createdAt } };
}

/**
 * Whether a concern from `participantId` notifies the decider (card 2679,
 * decision 3, S3), decided inside the write: `no_decider` with no decider
 * account; `no_link_address` with no App URL or `ORIGIN`; `prefs_off` when the
 * decider's `email_decisions` or every mail is switched off; `no_mail_host`
 * when no mail host is set up (code review F2); `held` within 24 hours of the
 * last notice about this participant; and `asked` otherwise, carrying how
 * many of theirs were held since that notice. Per participant: a
 * participant's first concern always notifies, and nobody else's holds it
 * back. Only `asked` holds the next one back, as only it sent anything; none
 * of the others is counted as held.
 */
function noticeOf(
	decision: Decision,
	participantId: number,
	now: Stamp
): { outcome: 'no_decider' | 'no_link_address' | 'prefs_off' | 'no_mail_host' | 'held' } | { outcome: 'asked'; deciderUserId: number; heldBefore: number } {
	const decider =
		decision.deciderUserId === null ? undefined : db.select({ id: users.id }).from(users).where(eq(users.id, decision.deciderUserId)).get();
	if (decider === undefined) return { outcome: 'no_decider' };
	if (decisionLinkBase() === null) return { outcome: 'no_link_address' };
	if (!shouldNotifyUser(decider.id, 'email_decisions')) return { outcome: 'prefs_off' };
	// Code review F2, S5: with no mail host nothing would be sent, so nothing is recorded as asked to hold the next one back.
	if (!isSmtpConfigured()) return { outcome: 'no_mail_host' };

	const theirs = eventsOfKind(decision.id, 'concern_raised').filter((event) => event.participantId === participantId);
	const lastAsked = theirs.findLastIndex((event) => event.detail.notice === 'asked');
	if (lastAsked !== -1) {
		const rested = later(theirs[lastAsked].at, DAY_MS);
		if (rested === null || now < rested) return { outcome: 'held' };
	}
	const heldBefore = theirs.slice(lastAsked + 1).filter((event) => event.detail.notice === 'held').length;
	return { outcome: 'asked', deciderUserId: decider.id, heldBefore };
}

/**
 * A clarification question, from either way in (card 2678, decisions 3, 4,
 * 10 and 17). The body: `question`, required, trimmed, 1 to 2,000
 * characters, with no control, direction or invisible character (400). Then
 * 409 on a ruled decision (`QUESTIONS_CLOSED`, pointing to a concern), and for
 * any status but open and closed in `requireTransition`'s words; 409 for the
 * participant's 11th question and the decision's 201st; 429 within 10 minutes
 * of the participant's last, saying from when, in UTC; and, for an account
 * (`account`, signed in or a key's), 429 for its 31st in 24 hours across
 * decisions: counted from the record, then from an allowance held in memory,
 * taken last so that a refused question never spends it, and which deleting a
 * decision does not give back (S10).
 *
 * Writes the row (the participant's snapshot name, the current version, via
 * the way in), `question_asked { questionId, notices }` naming the
 * participant, and, last, a notice after the commit for each who may answer
 * now and was `asked`. No activity entry, no live event (design S3). Mail
 * never refuses a question.
 */
function questionAs(
	decision: Decision,
	participant: DecisionParticipant,
	body: RequestBody,
	by: RecordActor,
	via: 'session' | 'link' | 'api',
	signedIn: { userId: number; name: string } | null,
	account: SessionUser | null,
	source: ServiceOptions['source']
): { question: OwnQuestion } {
	const question = readMultiline(body.question, 'question', QUESTION_TEXT_MAX, { trim: true });
	if (question === '') error(400, 'question is required');

	const now = stamp();
	// S9: a ruled decision's own words, pointing to a concern; a superseded or withdrawn one in the status's, which point to none.
	if (decision.status === 'ruled') error(409, QUESTIONS_CLOSED);
	requireTransition(decision, 'ask', now);
	const theirs = questionsBy(participant.id);
	if (theirs.length >= QUESTIONS_PER_PARTICIPANT) error(409, questionsLimitWords(QUESTIONS_PER_PARTICIPANT));
	if (questionsOf(decision.id).length >= QUESTIONS_PER_DECISION) {
		error(409, `This decision has ${QUESTIONS_PER_DECISION} questions: no more can be asked. Ask the decider directly`);
	}
	const last = theirs.at(-1);
	const rested = last === undefined ? null : later(last.askedAt, RECORD_MAIL_MIN_MINUTES * 60 * 1000);
	if (rested !== null && now < rested) {
		error(429, `Your last question was asked less than ${RECORD_MAIL_MIN_MINUTES} minutes ago: the next can be asked from ${rested} UTC`);
	}
	if (account !== null) requireQuestionAllowed(account, now);

	const row = appendQuestion({
		decisionId: decision.id,
		participantId: participant.id,
		askerName: participant.name,
		question,
		askedInVersion: decision.currentVersion,
		via
	});
	const notices = questionNoticesOf(decision, participant, account, now);
	appendEvent(
		{
			decisionId: decision.id,
			kind: 'question_asked',
			participantId: participant.id,
			versionNumber: decision.currentVersion,
			detail: {
				questionId: row.id,
				notices: notices.map((notice) => ({ userId: notice.userId, outcome: notice.outcome })),
				...(signedIn === null ? {} : { signedIn })
			}
		},
		by
	);
	for (const notice of notices) if (notice.outcome === 'asked') notifyDecisionQuestion(notice.userId, decision.id, decision.title, notice.heldBefore);
	// Code review S2: through any source but the page's, no moment, and the text marked as a participant's words.
	if (source !== 'ui') return { question: { question: row.question, askedInVersion: row.askedInVersion, untrusted: true } };
	return { question: { question: row.question, askedInVersion: row.askedInVersion, askedAt: row.askedAt } };
}

/**
 * A 429 once the account has asked `QUESTIONS_PER_CALLER_DAILY` questions in
 * the last 24 hours, on any decision (card 2678, decision 4, S10): read from
 * its `question_asked` events, and then, last of all, from an allowance held
 * in memory, which a deletion of the decisions, and their events with them,
 * does not give back. As the dry run's cap.
 */
function requireQuestionAllowed(user: SessionUser, now: Stamp): void {
	const words = (from: Stamp) => `You have asked ${QUESTIONS_PER_CALLER_DAILY} questions in the last 24 hours: the next can be asked from ${from} UTC`;
	const fromEvents = dailyCapFrom(questionsAskedSince(user.id, dayBefore()), QUESTIONS_PER_CALLER_DAILY);
	if (fromEvents !== null && now < fromEvents) error(429, words(fromEvents));
	const took = takeAllowance(`decision-question:${user.id}`, 1, QUESTIONS_PER_CALLER_DAILY, DAY_MS);
	if (!took.taken) error(429, words(stamp(new Date(Date.now() + took.retryAfterSecs * 1000))));
}

/** A new question's notice to one who may answer it, as decided inside the write: `asked` carries how many were held before it. */
type QuestionNotice = { userId: number; outcome: 'no_link_address' | 'prefs_off' | 'no_mail_host' | 'held' | 'asked'; heldBefore: number };

/**
 * Whom a new question from `participant` tells, and how (card 2678, decision
 * 5, S6), decided inside the write: the decider and the author, once each for
 * one account, each only while the account is there and `answer` lets it in
 * now (board edit), and never the asker's own account (`account`, or the
 * participant's). For each, in order: `no_link_address` with no App URL or
 * `ORIGIN`; `prefs_off` when their `email_decisions` or every mail is
 * switched off; `no_mail_host` with no mail host; `held` within 24 hours of
 * the last notice about this participant to them; and `asked` otherwise,
 * carrying how many of this participant's were held for them since. Only
 * `asked` holds the next one back. Per participant, so another's question
 * never holds back a first notice. Empty: nobody may answer now.
 */
function questionNoticesOf(decision: Decision, participant: DecisionParticipant, account: SessionUser | null, now: Stamp): QuestionNotice[] {
	const askers = new Set([participant.userId, account?.id ?? null].filter((id): id is number => id !== null));
	const recipients = [...new Set([decision.deciderUserId, decision.authorUserId].filter((id): id is number => id !== null))];
	const earlier = eventsOfKind(decision.id, 'question_asked').filter((event) => event.participantId === participant.id);
	const notices: QuestionNotice[] = [];
	for (const userId of recipients) {
		if (askers.has(userId)) continue;
		const recipient = db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, userId)).get();
		if (recipient === undefined || !mayDo(decisionAccess(recipient, decision), 'answer', decision)) continue;
		notices.push({ userId, ...questionNoticeFor(userId, earlier, now) });
	}
	return notices;
}

/** One recipient's outcome of a new question's notice, from the participant's earlier `question_asked` events (`questionNoticesOf`). */
function questionNoticeFor(userId: number, earlier: { detail: Record<string, unknown>; at: Stamp }[], now: Stamp): Omit<QuestionNotice, 'userId'> {
	if (decisionLinkBase() === null) return { outcome: 'no_link_address', heldBefore: 0 };
	if (!shouldNotifyUser(userId, 'email_decisions')) return { outcome: 'prefs_off', heldBefore: 0 };
	// As the concern's notice (2679's code review F2): with no mail host nothing would be sent, so nothing holds the next one back.
	if (!isSmtpConfigured()) return { outcome: 'no_mail_host', heldBefore: 0 };
	const outcomes = earlier.map((event) => {
		const sent = Array.isArray(event.detail.notices) ? (event.detail.notices as unknown[]) : [];
		const mine = sent.find((entry) => entry !== null && typeof entry === 'object' && (entry as { userId?: unknown }).userId === userId);
		return mine === undefined ? null : (mine as { outcome?: unknown }).outcome;
	});
	const lastAsked = outcomes.lastIndexOf('asked');
	if (lastAsked !== -1) {
		const rested = later(earlier[lastAsked].at, DAY_MS);
		if (rested === null || now < rested) return { outcome: 'held', heldBefore: 0 };
	}
	return { outcome: 'asked', heldBefore: outcomes.slice(lastAsked + 1).filter((outcome) => outcome === 'held').length };
}

/**
 * Whether an answer a person now stands behind tells the asker (card 2678,
 * decision 5), decided inside the write: `not_reached` for a participant
 * removed, or one `reachOf` skips; an account holder `no_link_address`,
 * `prefs_off`, `no_mail_host`, or `asked` to their account; a link holder
 * `no_mail_host`, or `asked` to the participant's snapshot address, which no
 * preference governs, and never to an account a browser beside their link
 * was signed in as. No rest: each question is answered once.
 *
 * A link holder's notice issues no link (card 2721, D1). `latestLink` is
 * whether it may tell them to use the one in their latest email:
 * `mailedLinkOf`, the closing-date reminder's rule, on the write's clock (D2,
 * D4). Otherwise it tells them to ask for a new one (D3).
 */
function answerNoticeOf(
	decision: Decision,
	row: DecisionQuestion
):
	| { outcome: 'not_reached' | 'no_link_address' | 'prefs_off' | 'no_mail_host' }
	| { outcome: 'asked'; to: { userId: number } | { address: string; latestLink: boolean } } {
	if (row.participantId === null) return { outcome: 'not_reached' };
	const participant = db
		.select()
		.from(decisionParticipants)
		.where(and(eq(decisionParticipants.id, row.participantId), eq(decisionParticipants.decisionId, decision.id)))
		.get();
	if (participant === undefined || participant.removedAt !== null) return { outcome: 'not_reached' };
	const reach = reachesOf(decision.id, [participant]).get(participant.id)!;
	if (!('via' in reach)) return { outcome: 'not_reached' };
	if (reach.via === 'account' && participant.userId !== null) {
		if (decisionLinkBase() === null) return { outcome: 'no_link_address' };
		if (!shouldNotifyUser(participant.userId, 'email_decisions')) return { outcome: 'prefs_off' };
		if (!isSmtpConfigured()) return { outcome: 'no_mail_host' };
		return { outcome: 'asked', to: { userId: participant.userId } };
	}
	if (!isSmtpConfigured()) return { outcome: 'no_mail_host' };
	return { outcome: 'asked', to: { address: participant.email, latestLink: mailedLinkOf(decision, participant, stamp()) !== null } };
}

/** The question of this decision, or 404 for one that is not on it (card 2678, decision 17). */
function requireQuestion(decision: Decision, questionId: number): DecisionQuestion {
	const row = questionOn(decision.id, questionId);
	if (row === null) error(404, 'Question not found');
	return row;
}

/** The question as the answerer is given it now, after their write: through the one projection (decision 2). */
function answererViewOf(decision: Decision, access: DecisionAccess, questionId: number, source: ServiceOptions['source']): QuestionView {
	const view = questionsFor(decision, { access, participantId: access.participantId, source }).find((question) => question.id === questionId);
	if (view === undefined) error(500, 'The answered question could not be read back');
	return view;
}

/**
 * A score-mode vote's `scores` (decision 11, R9): an object holding a whole
 * number 0 to 5 for each of `keys`, the live option ids, and no other key,
 * which `requireClosed` refuses before any is read. Stored as JSON built by
 * walking `keys`.
 */
function readScores(body: RequestBody, keys: string[]): string {
	const sent = asObject(body.scores);
	if (sent === undefined) error(400, body.scores === undefined ? 'scores is required' : 'scores must be an object');
	requireClosed(sent, keys, 'scores', "this decision's current options");
	const scores: Record<string, number> = {};
	for (const key of keys) {
		if (!Object.hasOwn(sent, key)) error(400, `scores must hold a score for every option: option ${key} has none`);
		scores[key] = readNumber(sent, key, { required: true, whole: true, min: 0, max: 5, says: `scores.${key} must be a whole number from 0 to 5` });
	}
	return JSON.stringify(scores);
}

/**
 * A response's `optionComments` (decision 11, R9): an object keyed by `keys`,
 * the live option ids, and by no other, each comment read as a response's
 * comment is, up to 2,000. Stored as JSON built by walking `keys`, the empty
 * ones dropped; null when none is left.
 */
function readOptionComments(body: RequestBody, keys: string[]): string | null {
	if (body.optionComments === undefined) return null;
	const sent = asObject(body.optionComments);
	if (sent === undefined) error(400, 'optionComments must be an object');
	requireClosed(sent, keys, 'optionComments', "this decision's current options");
	const kept: [string, string][] = [];
	for (const key of keys) {
		if (!Object.hasOwn(sent, key)) continue;
		const path = `optionComments.${key}`;
		const text = readMultiline(readText(sent, key, { says: `${path} must be text` }), path, OPTION_COMMENT_MAX, { trim: true });
		if (text !== '') kept.push([key, text]);
	}
	return kept.length === 0 ? null : JSON.stringify(Object.fromEntries(kept));
}

/**
 * Being recorded as having seen a version, from either way in (card 2677,
 * decision 14). The body: `versionNumber`, the current version (400
 * otherwise, an earlier one included), and `stage`,
 * `question`, `ruling` or `withdrawal` (400 otherwise). 409 for `ruling` on a
 * decision not ruled or superseded, and for `withdrawal` on one not
 * withdrawn. One `seen { stage }` event per participant, version and stage:
 * a second writes nothing and answers `{ recorded: false }`.
 */
function seenAs(
	decision: Decision,
	participant: DecisionParticipant,
	body: RequestBody,
	by: RecordActor,
	signedIn: { userId: number; name: string } | null
): { recorded: boolean } {
	const versionNumber = readNumber(body, 'versionNumber', { required: true, whole: true, min: 1 });
	const stage = readChoice(body, 'stage', { required: true, from: SEEN_STAGES });
	// The version shown now alone (code review C4): an earlier one is not what the page shows.
	if (versionNumber !== decision.currentVersion) error(400, `versionNumber ${versionNumber} is not the current version of this decision`);

	if (stage === 'ruling' && decision.status !== 'ruled' && decision.status !== 'superseded') {
		error(409, 'This decision has not been ruled on: there is no ruling to have seen');
	}
	if (stage === 'withdrawal' && decision.status !== 'withdrawn') error(409, 'This decision has not been withdrawn: there is no withdrawal to have seen');
	if (hasSeen(participant.id, versionNumber, stage)) return { recorded: false };
	appendEvent(
		{ decisionId: decision.id, kind: 'seen', participantId: participant.id, versionNumber, detail: { stage, ...(signedIn === null ? {} : { signedIn }) } },
		by
	);
	return { recorded: true };
}

/** How each of the rows would be reached by a record-bearing mail now (`reachOf`, decision 16), by participant id. */
function reachesOf(decisionId: number, rows: DecisionParticipant[]): Map<number, Reach> {
	const persons = peopleById(rows.map((row) => row.personId).filter((id): id is number => id !== null));
	const history = accountHistory(decisionId);
	return new Map(
		rows.map((row) => [row.id, reachOf(row, row.personId === null ? null : (persons.get(row.personId) ?? null), history.get(row.id) ?? false)])
	);
}

/**
 * A 409 unless `sent` is the decision's revision as it is now (card 2676,
 * decision 10): someone changed it since the caller read it.
 */
function requireRevision(decision: Decision, sent: string): void {
	if (revisionOf(decision, allOptionsOf(decision.id), participantsOf(decision.id)) !== sent) error(409, STALE_REVISION);
}

/** Stamp the decision's `updated_at`, and answer the row as it now is. */
function touch(decisionId: number, now: Stamp): Decision {
	return db.update(decisions).set({ updatedAt: now }).where(eq(decisions.id, decisionId)).returning().get();
}

/**
 * A 409, naming the person, when a row coming onto the decision would hold an
 * account another live row holds, or that another one coming on holds
 * (decision 29). `staying` is the accounts of the live rows that stay.
 */
function requireOneRowPerAccount(coming: { name: string; userId: number | null }[], staying: (number | null)[]): void {
	const held = new Set(staying.filter((id): id is number => id !== null));
	for (const row of coming) {
		if (row.userId === null) continue;
		if (held.has(row.userId)) error(409, `${row.name} cannot be included: another participant of this decision holds the same account`);
		held.add(row.userId);
	}
}

/**
 * A 409 for a participant mailed by the record less than
 * `RECORD_MAIL_MIN_MINUTES` ago, or `RECORD_MAIL_DAILY_CAP` times in the last
 * 24 hours (card 2697, Q24), saying from when, in UTC, they may be mailed
 * again (decision 31): `mailRestOf`, the rule the editor's delivery panel
 * asks too. Read from the record alone: a participant's events go only with
 * their decision, whose rows can then no longer be mailed.
 */
function requireMailRested(rows: DecisionParticipant[], now: Stamp): void {
	if (rows.length === 0) return;
	const ids = rows.map((row) => row.id);
	const last = lastMailAt(ids);
	const recent = mailsSince(ids, dayBefore());
	for (const row of rows) {
		const held = mailRestOf(row.name, last.get(row.id), recent.get(row.id) ?? [], now);
		if (held !== null) error(409, held.words);
	}
}

/**
 * A 429 once the caller has opened or re-published `PUBLISH_DAILY_CAP`
 * decisions in the last 24 hours (card 2697, Q23), each of which mails every
 * participant: read from their `published` events across decisions, and
 * then, last of all, from an allowance held in memory, which a deletion of
 * the decisions, and their events with them, does not give back. Asked after
 * every other refusal, so a refused publish takes nothing.
 */
function requirePublishAllowed(user: SessionUser, now: Stamp): void {
	const words = (from: Stamp) =>
		`You have opened or re-published ${PUBLISH_DAILY_CAP} decisions in the last 24 hours: the next can be sent from ${from} UTC`;
	const fromEvents = dailyCapFrom(publishesSince(user.id, dayBefore()), PUBLISH_DAILY_CAP);
	// As `mailRestOf` compares (the code review's part B, F7): from that moment on, it may.
	if (fromEvents !== null && now < fromEvents) error(429, words(fromEvents));
	const took = takeAllowance(`decision-publish:${user.id}`, 1, PUBLISH_DAILY_CAP, DAY_MS);
	if (!took.taken) error(429, words(stamp(new Date(Date.now() + took.retryAfterSecs * 1000))));
}

/**
 * A 429 when `coming` more record mails would take the caller past
 * `CALLER_MAIL_DAILY_CAP` in the last 24 hours, across every decision (card
 * 2697's code review, part B, S2), saying from when, in UTC, they would fit:
 * read from the mail events the caller's writes have recorded, and then from
 * an allowance held in memory, which a deletion of the decisions, and their
 * events with them, does not give back. `coming` is the participants the
 * write would mail. Asked after the write's other refusals, so that a write
 * they refuse takes nothing; on opening and re-publishing, before the publish
 * limit, which stays the last thing asked. A publish that limit then refuses
 * has taken from this allowance: it errs towards less mail.
 */
function requireRecordMailAllowed(user: SessionUser, coming: number, now: Stamp): void {
	if (coming === 0) return;
	if (coming > CALLER_MAIL_DAILY_CAP) {
		error(429, `This would mail ${coming} participants: one account may cause at most ${CALLER_MAIL_DAILY_CAP} decision mails in 24 hours`);
	}
	const words = (from: Stamp) =>
		`This would take your decision mail past ${CALLER_MAIL_DAILY_CAP} in the last 24 hours: it can be sent from ${from} UTC`;
	const fromEvents = dailyCapFrom(recordMailsSince(user.id, dayBefore()), CALLER_MAIL_DAILY_CAP, coming);
	if (fromEvents !== null && now < fromEvents) error(429, words(fromEvents));
	const took = takeAllowance(`decision-record-mail:${user.id}`, coming, CALLER_MAIL_DAILY_CAP, DAY_MS);
	if (!took.taken) error(429, words(stamp(new Date(Date.now() + took.retryAfterSecs * 1000))));
}

/** The moment 24 hours ago, from which the daily caps count. */
function dayBefore(): Stamp {
	return stamp(new Date(Date.now() - DAY_MS));
}

/** What a version copies of the working content (the code review's C3): these keys, as the content holds them. */
const VERSION_TEXT_KEYS = ['situation', 'question', 'ask', 'unknowns', 'alreadyRuled', 'technicalDetail'] as const;
/** What a version copies of each option's entry, besides the id and label it is given. */
const VERSION_OPTION_KEYS = ['title', 'summary', 'pros', 'cons', 'commercial'] as const;
const VERSION_AUDIENCE_KEYS = ['groupId', 'heading', 'body'] as const;
const VERSION_STORY_KEYS = ['title', 'body'] as const;

/**
 * A version's content: of the working content an allowlist alone (the code
 * review's C3), each key copied only where the content holds it. Its text
 * sections; its audiences and stories, each entry by its own keys; its
 * options those still live, each with its text from the working content and
 * its id and label; its agent flags; and each review stamp as `{ byName, at }`,
 * the record of who reviewed what (R7). Never `lastLabel`, nor a reviewer's
 * account id, nor a key the content may hold that is none of these.
 */
function versionContent(decision: Decision, options: DecisionOption[]): string {
	const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
	let working: Record<string, unknown> = {};
	try {
		const read = JSON.parse(decision.workingContent) as unknown;
		if (isRecord(read)) working = read;
	} catch {
		// Not JSON: the version holds the options alone.
	}
	const pick = (entry: Record<string, unknown>, keys: readonly string[]) =>
		Object.fromEntries(keys.filter((key) => Object.hasOwn(entry, key)).map((key) => [key, entry[key]]));
	const version: Record<string, unknown> = pick(working, VERSION_TEXT_KEYS);
	if (Array.isArray(working.audiences)) version.audiences = working.audiences.filter(isRecord).map((entry) => pick(entry, VERSION_AUDIENCE_KEYS));
	if (Array.isArray(working.stories)) version.stories = working.stories.filter(isRecord).map((entry) => pick(entry, VERSION_STORY_KEYS));
	const written = Array.isArray(working.options) ? working.options.filter(isRecord) : [];
	version.options = options.map((option) => ({
		...pick(written.find((entry) => entry.optionId === option.id) ?? {}, VERSION_OPTION_KEYS),
		optionId: option.id,
		label: option.label
	}));
	if (isRecord(working.agentDrafted)) version.agentDrafted = Object.fromEntries(Object.entries(working.agentDrafted).filter(([, flag]) => flag === true));
	if (isRecord(working.reviewed)) {
		version.reviewed = Object.fromEntries(
			Object.entries(working.reviewed)
				.filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
				.map(([key, stamped]) => [key, { byName: stamped.byName, at: stamped.at }])
		);
	}
	return JSON.stringify(version);
}

/**
 * What a decision's activity entry holds but its action (decision 21, 4.10):
 * its board, no card, the actor and the tree. The action is written at each
 * call, as `activity-twins.test.ts` requires. Card 2680 (decision 22): a
 * link's entry names its card, on the card's board.
 */
function decisionEntry(boardId: number, detail: string, user: SessionUser, opts: ServiceOptions, cardId: number | null = null) {
	return { boardId, cardId, detail, source: sourceOf(opts), ...actorOf(user) };
}
