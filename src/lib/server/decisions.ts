/**
 * decisions.ts — a decision made, its decider named, its participants set,
 * opened, re-published, closed, extended, withdrawn and deleted; an
 * invitation sent again; and the administrator's changes to a participant's
 * account and address (card 2675, plan section 4.7).
 *
 * No route calls these yet: cards 2676 and 2677 add the routes and pages,
 * each calling a write inside its `writeAs` callback, handed `caller`.
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
import { decisionOptions, decisionParticipants, decisions, users, type Decision, type DecisionOption, type DecisionParticipant } from './db/schema';
import type { SessionUser } from './auth';
import { canEditBoard, isAdmin } from './board-access';
import { mayDo } from './decision-access';
import {
	allOptionsOf,
	changedSections,
	liveOptionsOf,
	listedOptionIds,
	nextLabel,
	openFactsOf,
	optionChanges,
	parseWorkingContent,
	participantsOf,
	readContent,
	readMultiline,
	readTitle,
	requireClosed,
	revisionOf,
	sectionKeysOf,
	type WorkingContent
} from './decision-content';
import {
	accountHistory,
	actorFor,
	appendEvent,
	appendResponse,
	appendVersion,
	currentRound,
	hasSeen,
	IDS_AT_ONCE,
	lastMailAt,
	latestResponse,
	liveOptionIds,
	ownResponseOf,
	peopleById,
	responsesInRound,
	snapshotOf,
	type RecordActor
} from './decision-record';
import { participantForLink, reachOf, revokeLinks, type Reach, type SkipReason } from './decision-links';
import { decisionLinkBase, queueRecordMails, RECORD_MAIL_MIN_MINUTES } from './decision-mail';
import { DECISION_ACTION_WORDS, decisionStatus, requireTransition } from './decision-status';
import { NO_LINK_ADDRESS } from './email';
import { emit } from './events';
import { ACTIONS, actorOf, logActivity } from './logActivity';
import {
	asObject,
	readBoolean,
	readChoice,
	readEmail,
	readId,
	readList,
	readNumber,
	readObjects,
	readText,
	readTimestamp,
	type RequestBody
} from './request-body';
import { refusalsOf } from '$lib/decision-readiness';
import type { OwnResponse } from '$lib/decision-view-types';
import { DEAD_DECISION_LINK, STALE_REVISION } from '$lib/decision-words';
import { requireBoard, requireDecision, requireUser } from './route-guards';
import { parseStamp, stamp, type Stamp } from '$lib/timestamps';
import { inWrite, type ServiceOptions } from './write-as';

/** The functions here that only read. None: every export but this list is a write, and starts with `inWrite()`. */
export const READS: readonly string[] = [];

/** A participant's part in a decision. */
const ROLES = ['consulted', 'informed'] as const;

/** The most participants one decision may be given at once. */
const MOST_PARTICIPANTS = 5000;

/** What an administrator does to a participant's account (decision 14). */
const ACCOUNT_CHANGES = ['person', 'none'] as const;

/** How a decision's options are answered: one choice, or a score for each (card 2676, decision 28). */
const VOTE_MODES = ['single', 'score'] as const;

/** What a participant may answer (card 2677, decision 11). `concern` is card 2679's, after the ruling. */
const RESPONSE_KINDS = ['vote', 'abstain', 'no_concerns'] as const;

/** The stages a participant is recorded as having seen (card 2677, decision 14). */
const SEEN_STAGES = ['question', 'ruling', 'withdrawal'] as const;

/** The most responses one participant gives in one round (decision 11). Private: a service module exports its functions alone (D5). */
const RESPONSES_PER_ROUND = 50;

/** How long a response's comment, and each comment on an option, may be (decision 11). */
const COMMENT_MAX = 4000;
const OPTION_COMMENT_MAX = 2000;

/** The 403 for a participant's write through an API key (decision 10, D19). */
const PERSONS_ACT = "Responding is a person's act: it cannot be done with an API key";
/** The 403 for a participant `reachOf` no longer reaches (decision 10, D12). */
const NO_LONGER_REACHED = 'This decision no longer reaches you as a participant: ask whoever sent it to you';

/** Why a participant cannot be sent an invitation again, in words, for each reason `reachOf` skips them (decision 16). */
const SKIP_WORDS: Readonly<Record<SkipReason, (name: string) => string>> = {
	deleted: (name) => `${name} is no longer in the people directory: they cannot be mailed about this decision`,
	left: (name) => `${name} has left: they cannot be mailed about this decision`,
	account_not_attached: (name) =>
		`${name}'s account on this decision is not the one the people directory holds for them: an administrator attaches it before they can be mailed`,
	account_removed: (name) =>
		`${name}'s account on this decision has been deleted: an administrator clears it before they can be mailed a personal link`,
	address_changed: (name) =>
		`${name}'s address on this decision is not the one the people directory holds for them: an administrator changes it before they can be mailed`
};

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
	appendEvent({ decisionId: decision.id, kind: 'created', detail: { decider: productOwner ? 'product_owner' : 'author' } }, actorFor(user, opts.source));
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
 * changes nothing.
 */
export function setDecider(caller: SessionUser | null, at: { decisionId: number }, body: RequestBody, opts: ServiceOptions): Decision {
	inWrite();
	const user = requireUser(caller);
	const { decision } = requireDecision(user, at.decisionId, 'setDecider');

	const deciderUserId = readId(body, 'deciderUserId', { required: true });
	const revision = readText(body, 'revision', { required: true });
	if (decision.status !== 'draft' && deciderUserId === user.id) error(403, 'You cannot make yourself the decider of a decision that is open');
	const account = db.select({ id: users.id, username: users.username, role: users.role }).from(users).where(eq(users.id, deciderUserId)).get();
	// The code review's C5: only an administrator is told that an id is no account; anyone else is told it cannot be the decider, at the same step.
	if (!account && isAdmin(user)) error(400, `deciderUserId ${deciderUserId} is not an account`);

	requireTransition(decision, 'setDecider');
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
		actorFor(user, opts.source)
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
 * participant mailed in the last 10 minutes (decision 31).
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
	const by = actorFor(user, opts.source);
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
 * On a draft each is saved. A changed `closesAt` must be in the future
 * (400); one equal to the stored value is saved even once it has passed, as
 * opening refuses it anyway (D5). Once opened, only `content` changes: a
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
		if (opts.source === 'api') {
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
	if (opts.source !== 'ui') error(403, "Marking text reviewed is a person's act: it cannot be done with an API key");

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
 * has left or been deleted; no mail host; no address to make a link on (the
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
 */
export function openDecision(caller: SessionUser | null, at: { decisionId: number }, body: null, opts: ServiceOptions): Decision {
	inWrite();
	const user = requireUser(caller);
	const { decision } = requireDecision(user, at.decisionId, 'open');

	const now = stamp();
	requireTransition(decision, 'open', now);
	const [refusal] = refusalsOf(openFactsOf(decision, now));
	if (refusal !== undefined) error(409, refusal.words);
	const options = liveOptionsOf(decision.id);
	const rows = participantsOf(decision.id);

	// Decision 19: the snapshots, taken again now, which decision 29 has been asked of above.
	const snapshots = rows.map((row) => ({ row, snapshot: snapshotOf(row.personId!)! }));

	const by = actorFor(user, opts.source);
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
 * would mail was mailed in the last 10 minutes (decision 31).
 *
 * An option not yet published is added in the new version; a published one
 * still live but no longer in the working content's `options` is retired in
 * it (decision 24). Writes `published`, `decision_republished` and the live
 * event.
 */
export function republishDecision(caller: SessionUser | null, at: { decisionId: number }, body: RequestBody, opts: ServiceOptions): Decision {
	inWrite();
	const user = requireUser(caller);
	const { decision } = requireDecision(user, at.decisionId, 'republish');

	const changeNote = readText(body, 'changeNote', { required: true, trim: true, min: 1, max: 2000 });
	const askAgain = readBoolean(body, 'askAgain', { required: true });

	const now = stamp();
	requireTransition(decision, 'republish', now);
	if (decision.closesAt === null || decision.closesAt <= now) {
		error(409, "This decision's closing time has passed: it cannot be re-published until it is extended");
	}
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
	requireMailRested(
		current.filter((row) => 'via' in reaches.get(row.id)!),
		now
	);

	const by = actorFor(user, opts.source);
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
	const { decision } = requireDecision(user, at.decisionId, 'close');

	const now = stamp();
	requireTransition(decision, 'close', now);
	const row = db.update(decisions).set({ status: 'closed', closedAt: now, updatedAt: now }).where(eq(decisions.id, decision.id)).returning().get();
	appendEvent({ decisionId: decision.id, kind: 'closed' }, actorFor(user, opts.source));

	if (row.boardId !== null) {
		logActivity({ action: ACTIONS.decisionClosed, ...decisionEntry(row.boardId, `"${row.title}"`, user, opts) });
		emit(row.boardId, 'decision', { decisionId: row.id, status: decisionStatus(row, now), boardId: row.boardId });
	}
	return row;
}

/**
 * Give an open or closed decision a new closing time, `closesAt`, which must
 * be in the future (400). It is open again, `closed_at` emptied; the
 * `extended { from, to }` event, `decision_extended` and the live event. No
 * mail.
 */
export function extendDecision(caller: SessionUser | null, at: { decisionId: number }, body: RequestBody, opts: ServiceOptions): Decision {
	inWrite();
	const user = requireUser(caller);
	const { decision } = requireDecision(user, at.decisionId, 'extend');

	const closesAt = readTimestamp(body, 'closesAt', { required: true, future: true });

	const now = stamp();
	requireTransition(decision, 'extend', now);
	const row = db
		.update(decisions)
		.set({ status: 'open', closesAt, closedAt: null, updatedAt: now })
		.where(eq(decisions.id, decision.id))
		.returning()
		.get();
	appendEvent({ decisionId: decision.id, kind: 'extended', detail: { from: decision.closesAt, to: closesAt } }, actorFor(user, opts.source));

	if (row.boardId !== null) {
		logActivity({ action: ACTIONS.decisionExtended, ...decisionEntry(row.boardId, `"${row.title}": closes ${closesAt.slice(0, 16)} UTC`, user, opts) });
		emit(row.boardId, 'decision', { decisionId: row.id, status: decisionStatus(row, now), boardId: row.boardId });
	}
	return row;
}

/**
 * Withdraw a draft, an open or a closed decision: `reason` (text, trimmed, 1
 * to 2,000). `withdrawn`, `withdrawn_at` and the reason saved, and the
 * `withdrawn` event. Once it has been opened, its participants are mailed
 * `told_withdrawn` with the reason, and `decision_withdrawn` (never the
 * reason) and the live event are written while its board is there. With no
 * address to make a link on the withdrawal goes ahead, each mail recorded as
 * not sent (decision 17). A draft: nobody was told, so none of those.
 */
export function withdrawDecision(caller: SessionUser | null, at: { decisionId: number }, body: RequestBody, opts: ServiceOptions): Decision {
	inWrite();
	const user = requireUser(caller);
	const { decision } = requireDecision(user, at.decisionId, 'withdraw');

	const reason = readText(body, 'reason', { required: true, trim: true, min: 1, max: 2000 });

	const now = stamp();
	requireTransition(decision, 'withdraw', now);
	const by = actorFor(user, opts.source);
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
 * Delete a draft or a withdrawn decision, and by the cascade every row of it
 * (plan 4.9); any other status is 409 (D7). Once it had been opened,
 * `decision_deleted` and the live event, while its board is there.
 */
export function deleteDecision(caller: SessionUser | null, at: { decisionId: number }, body: null, opts: ServiceOptions): void {
	inWrite();
	const user = requireUser(caller);
	const { decision } = requireDecision(user, at.decisionId, 'delete');

	const now = stamp();
	requireTransition(decision, 'delete', now);
	db.delete(decisions).where(eq(decisions.id, decision.id)).run();

	if (decision.openedAt === null || decision.boardId === null) return;
	logActivity({ action: ACTIONS.decisionDeleted, ...decisionEntry(decision.boardId, `"${decision.title}"`, user, opts) });
	emit(decision.boardId, 'decision', { decisionId: decision.id, status: decisionStatus(decision, now), boardId: decision.boardId });
}

/**
 * Send a participant their invitation again, to their snapshot address: a
 * link holder with a new link, replacing the last, and an account holder
 * with the decision's page. Writes `invited { resend: true }`. 404 for a
 * participant not on this decision. 409 for one removed; for each reason
 * `reachOf` skips one, in its words (decision 16); with no address to make a
 * link on (decision 28); and for one mailed in the last 10 minutes
 * (decision 31).
 */
export function resendInvitation(
	caller: SessionUser | null,
	at: { decisionId: number; participantId: number },
	body: null,
	opts: ServiceOptions
): DecisionParticipant {
	inWrite();
	const user = requireUser(caller);
	const { decision } = requireDecision(user, at.decisionId, 'resend');
	const participant = participantOn(decision.id, at.participantId);

	const now = stamp();
	requireTransition(decision, 'resend', now);
	if (participant.removedAt !== null) error(409, `${participant.name} has been removed from this decision: they cannot be mailed about it`);
	const reach = reachesOf(decision.id, [participant]).get(participant.id)!;
	if ('skip' in reach) error(409, SKIP_WORDS[reach.skip](participant.name));
	if (decisionLinkBase() === null) error(409, NO_LINK_ADDRESS);
	requireMailRested([participant], now);

	const after = touch(decision.id, now);
	queueRecordMails(after, 'invitation', { by: actorFor(user, opts.source), participants: [participant], resend: true });
	return participantOn(decision.id, participant.id);
}

/**
 * An administrator's change to the account a participant is reached by
 * (decision 14): `account`, `person` or `none`.
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
	const user = requireUser(caller);
	const { decision } = requireDecision(user, at.decisionId, 'participantAccount');
	const participant = participantOn(decision.id, at.participantId);

	const account = readChoice(body, 'account', { required: true, from: ACCOUNT_CHANGES });

	requireTransition(decision, 'participantAccount');
	const by = actorFor(user, opts.source);
	const now = stamp();
	if (account === 'person') {
		const person = participant.personId === null ? undefined : peopleById([participant.personId]).get(participant.personId);
		if (!person) error(409, `${participant.name} is no longer in the people directory: there is no account to attach`);
		if (person.userId === null) error(409, `${person.fullName} has no account in the people directory: there is no account to attach`);
		const accountId = person.userId;
		if (participantsOf(decision.id).some((row) => row.id !== participant.id && row.removedAt === null && row.userId === accountId)) {
			error(409, `${person.fullName} cannot be given that account: another participant of this decision holds it`);
		}
		db.update(decisionParticipants).set({ userId: accountId }).where(eq(decisionParticipants.id, participant.id)).run();
		revokeLinks({ participantId: participant.id }, 'account_attached', by);
		appendEvent({ decisionId: decision.id, kind: 'account_attached', participantId: participant.id, detail: { userId: accountId } }, by);
	} else {
		const hadAccount = accountHistory(decision.id).get(participant.id) ?? false;
		if (participant.userId === null && !hadAccount) error(409, `${participant.name} holds no account on this decision: there is nothing to clear`);
		db.update(decisionParticipants).set({ userId: null }).where(eq(decisionParticipants.id, participant.id)).run();
		appendEvent({ decisionId: decision.id, kind: 'account_cleared', participantId: participant.id, detail: { userId: participant.userId } }, by);
	}
	touch(decision.id, now);
	return participantOn(decision.id, participant.id);
}

/**
 * An administrator's change to a participant's address on the decision
 * (decision 15, S7): `email`, an address, kept lower-case. Ends their link
 * and writes `address_changed { from, to }`; sends nothing, as a re-send is
 * an act of its own. The address it has changes nothing.
 */
export function changeParticipantAddress(
	caller: SessionUser | null,
	at: { decisionId: number; participantId: number },
	body: RequestBody,
	opts: ServiceOptions
): DecisionParticipant {
	inWrite();
	const user = requireUser(caller);
	const { decision } = requireDecision(user, at.decisionId, 'participantAddress');
	const participant = participantOn(decision.id, at.participantId);

	const email = readEmail(body, 'email', { required: true }).toLowerCase();

	requireTransition(decision, 'participantAddress');
	if (email === participant.email) return participant;
	const by = actorFor(user, opts.source);
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
	if (opts.source !== 'ui') error(403, PERSONS_ACT);
	const participant = ownParticipant(decision, access.participantId);
	if (participant.role !== 'consulted') error(403, 'Someone kept informed gives no response');
	requireReachedByAccount(decision.id, participant);

	return respondAs(decision, participant, body, actorFor(user, opts.source), 'session', null);
}

/**
 * A link holder's response (card 2677, decisions 4, 9 and 10): the token
 * decides, through `participantForLink`, and any link that does not open a
 * decision is the one 404 (decision 6). Recorded `via: 'link'` with source
 * `link`, whatever `opts.source` says; a signed-in browser's account is noted
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
	if (opts.source !== 'ui') error(403, PERSONS_ACT);
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
	if (opts.source !== 'ui') error(403, "Being recorded as having seen a decision is a person's act: it cannot be done with an API key");
	if (access.participantId === null) error(403, 'Only a participant of this decision is recorded as having seen it');
	const participant = ownParticipant(decision, access.participantId);
	requireReachedByAccount(decision.id, participant);

	return seenAs(decision, participant, body, actorFor(user, opts.source), null);
}

/** Record that a link holder has seen a version (card 2677, decisions 9 and 14): as `recordSeen`, decided by the token, with the link's source. */
export function recordSeenByLink(caller: SessionUser | null, at: { token: string }, body: RequestBody, opts: ServiceOptions): { recorded: boolean } {
	inWrite();
	const { decision, participant } = requireLink(at.token);
	if (opts.source !== 'ui') error(403, "Being recorded as having seen a decision is a person's act: it cannot be done with an API key");

	return seenAs(decision, participant, body, linkActor(participant), signedInOf(caller));
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

	const now = stamp();
	requireTransition(decision, 'respond', now);
	// Decision 12: stored open is not enough once `closes_at` has passed.
	if (decisionStatus(decision, now) !== 'open') error(409, 'This decision is awaiting a ruling: responses are closed');
	if (versionNumber !== decision.currentVersion) error(409, STALE_REVISION);
	const round = currentRound(decision.id);
	const latest = latestResponse(participant.id, round);
	const answer = { kind, optionId, scores, comment: comment === '' ? null : comment, optionComments };
	// The same answer on the same version alone writes nothing: confirmed on a newer one, it is bound to that one (code review C1).
	if (
		latest !== null &&
		latest.versionNumber === versionNumber &&
		latest.kind === answer.kind &&
		latest.optionId === answer.optionId &&
		latest.scores === answer.scores &&
		latest.comment === answer.comment &&
		latest.optionComments === answer.optionComments
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
	appendEvent({ decisionId: decision.id, kind: 'responded', participantId: participant.id, versionNumber, detail: { responseId: row.id, ...signed } }, by);
	if (!hasSeen(participant.id, versionNumber, 'question')) {
		appendEvent({ decisionId: decision.id, kind: 'seen', participantId: participant.id, versionNumber, detail: { stage: 'question', ...signed } }, by);
	}
	return { response: ownResponseOf(row), unchanged: false };
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
 * `RECORD_MAIL_MIN_MINUTES` ago, saying from when, in UTC, they may be mailed
 * again (decision 31).
 */
function requireMailRested(rows: DecisionParticipant[], now: Stamp): void {
	if (rows.length === 0) return;
	const last = lastMailAt(rows.map((row) => row.id));
	for (const row of rows) {
		const at = last.get(row.id);
		const date = at === undefined ? null : parseStamp(at);
		if (date === null) continue;
		const from = stamp(new Date(date.getTime() + RECORD_MAIL_MIN_MINUTES * 60 * 1000));
		if (now < from) {
			error(409, `${row.name} was mailed about this decision less than ${RECORD_MAIL_MIN_MINUTES} minutes ago: they can be mailed again from ${from} UTC`);
		}
	}
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
 * call, as `activity-twins.test.ts` requires.
 */
function decisionEntry(boardId: number, detail: string, user: SessionUser, opts: ServiceOptions) {
	return { boardId, cardId: null, detail, source: opts.source, ...actorOf(user) };
}
