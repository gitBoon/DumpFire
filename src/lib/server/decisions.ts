/**
 * decisions.ts — a decision made, its decider named, its participants set,
 * opened, re-published, closed, extended, withdrawn and deleted; an
 * invitation sent again; and the administrator's changes to a participant's
 * account and address (card 2675, plan section 4.7).
 *
 * No route calls these yet: cards 2676 and 2677 add the routes and pages,
 * each calling a write inside its `writeAs` callback, handed `caller`.
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
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from './db';
import { decisionOptions, decisionParticipants, decisions, users, type Decision, type DecisionOption, type DecisionParticipant } from './db/schema';
import type { SessionUser } from './auth';
import { canEditBoard } from './board-access';
import { accountHistory, actorFor, appendEvent, appendVersion, IDS_AT_ONCE, lastMailAt, peopleById, snapshotOf } from './decision-record';
import { reachOf, revokeLinks, type Reach, type SkipReason } from './decision-links';
import { decisionLinkBase, queueRecordMails, RECORD_MAIL_MIN_MINUTES } from './decision-mail';
import { decisionStatus, requireTransition } from './decision-status';
import { isSmtpConfigured, NO_LINK_ADDRESS } from './email';
import { emit } from './events';
import { ACTIONS, actorOf, logActivity } from './logActivity';
import { UNPRINTABLE } from './logger';
import { readBoolean, readChoice, readEmail, readId, readObjects, readText, readTimestamp, type RequestBody } from './request-body';
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

	const title = readText(body, 'title', { required: true, trim: true, min: 1, max: 200 });
	if (UNPRINTABLE.test(title)) error(400, 'title cannot hold control, direction or invisible characters');

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
 * 409 for a decision whose board is gone, and, once the decision is open,
 * 403 for the caller naming themselves (decision 6, R4). Writes
 * `decider_changed`. Naming the decider it has changes nothing.
 */
export function setDecider(caller: SessionUser | null, at: { decisionId: number }, body: RequestBody, opts: ServiceOptions): Decision {
	inWrite();
	const user = requireUser(caller);
	const { decision } = requireDecision(user, at.decisionId, 'setDecider');

	const deciderUserId = readId(body, 'deciderUserId', { required: true });
	if (decision.status !== 'draft' && deciderUserId === user.id) error(403, 'You cannot make yourself the decider of a decision that is open');
	const account = db.select({ id: users.id, username: users.username, role: users.role }).from(users).where(eq(users.id, deciderUserId)).get();
	if (!account) error(400, `deciderUserId ${deciderUserId} is not an account`);

	requireTransition(decision, 'setDecider');
	if (decision.boardId === null) error(409, "This decision's board has been deleted: its decider cannot be changed");
	if (!canEditBoard(account, decision.boardId)) {
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
 * role writes `role_changed`. A row whose person has been deleted is left as
 * it is, as the body cannot name it. Including anyone is refused, 409, with
 * no address to make a link on (decision 28), and re-including a
 * participant mailed in the last 10 minutes (decision 31).
 *
 * 409, naming the person, for a row that would hold the same account as
 * another live row of the decision (decision 29).
 */
export function setParticipants(
	caller: SessionUser | null,
	at: { decisionId: number },
	body: RequestBody,
	opts: ServiceOptions
): DecisionParticipant[] {
	inWrite();
	const user = requireUser(caller);
	const { decision } = requireDecision(user, at.decisionId, 'edit');

	const entries = readObjects(body, 'participants', { required: true, max: MOST_PARTICIPANTS });
	const wanted = entries.map((entry) => ({
		personId: readId(entry, 'personId', { required: true }),
		role: readChoice(entry, 'role', { required: true, from: ROLES })
	}));
	const seen = new Set<number>();
	for (const { personId } of wanted) {
		if (seen.has(personId)) error(400, `personId ${personId} is named twice`);
		seen.add(personId);
	}
	const persons = peopleById([...seen]);
	for (const { personId } of wanted) {
		const person = persons.get(personId);
		if (!person) error(400, `personId ${personId} is not a person`);
		if (person.status !== 'active') error(400, `${person.fullName} (person ${personId}) has left, and cannot be included`);
	}

	requireTransition(decision, 'edit');
	const by = actorFor(user, opts.source);
	const rows = participantsOf(decision.id);
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
	const removals = [...live.values()].filter((row) => !named.has(row.personId!));

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
 */
export function openDecision(caller: SessionUser | null, at: { decisionId: number }, body: null, opts: ServiceOptions): Decision {
	inWrite();
	const user = requireUser(caller);
	const { decision } = requireDecision(user, at.decisionId, 'open');

	const now = stamp();
	requireTransition(decision, 'open', now);
	if (decision.deciderUserId === null) error(409, 'This decision has no decider: it cannot be opened');
	if (decision.boardId === null) error(409, "This decision's board has been deleted: it cannot be opened");
	const decider = db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, decision.deciderUserId)).get();
	if (!decider || !canEditBoard(decider, decision.boardId)) {
		error(409, `The decider, ${decision.deciderName ?? 'who was named'}, can no longer edit this board: it cannot be opened until a decider who can is named`);
	}
	if (decision.closesAt === null || decision.closesAt <= now) error(409, 'This decision has no closing time in the future: it cannot be opened');
	const options = liveOptionsOf(decision.id);
	if (options.length < 2) error(409, 'This decision has fewer than two options: it cannot be opened');
	const rows = participantsOf(decision.id);
	if (!rows.some((row) => row.role === 'consulted')) error(409, 'This decision has no consulted participant: it cannot be opened');
	const persons = peopleById(rows.map((row) => row.personId).filter((id): id is number => id !== null));
	for (const row of rows) {
		const person = row.personId === null ? undefined : persons.get(row.personId);
		if (!person) error(409, `${row.name} is no longer in the people directory: this decision cannot be opened until they are taken off it`);
		if (person.status !== 'active') error(409, `${person.fullName} has left: this decision cannot be opened until they are taken off it`);
	}
	if (!isSmtpConfigured()) error(409, 'Mail is not set up on this server: a decision cannot be opened, as its participants could not be told');
	if (decisionLinkBase() === null) error(409, NO_LINK_ADDRESS);

	// Decision 19: the snapshots, taken again now; then decision 29 on them.
	const snapshots = rows.map((row) => ({ row, snapshot: snapshotOf(row.personId!)! }));
	const holders = new Map<number, string>();
	for (const { snapshot } of snapshots) {
		if (snapshot.userId === null) continue;
		const other = holders.get(snapshot.userId);
		if (other !== undefined) {
			error(409, `${snapshot.name} and ${other} hold the same account: this decision cannot be opened while two of its participants do`);
		}
		holders.set(snapshot.userId, snapshot.name);
	}

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

	logActivity({ action: ACTIONS.decisionOpened, ...decisionEntry(decision.boardId, `"${opened.title}"`, user, opts) });
	emit(decision.boardId, 'decision', { decisionId: opened.id, status: decisionStatus(opened, now), boardId: decision.boardId });
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
	const listed = listedOptionIds(decision);
	const live = liveOptionsOf(decision.id);
	const adding = live.filter((option) => option.addedInVersion === null);
	const retiring = live.filter((option) => option.addedInVersion !== null && listed !== null && !listed.has(option.id));
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

// ─── Inside the writes ───────────────────────────────────────────────────────

/** What a participant row copies from a person's snapshot (S7). */
function snapshotColumns(snapshot: NonNullable<ReturnType<typeof snapshotOf>>) {
	return { name: snapshot.name, email: snapshot.email, jobTitle: snapshot.jobTitle, groups: snapshot.groups, userId: snapshot.userId };
}

/** Every participant row of the decision, removed ones included, in order. */
function participantsOf(decisionId: number): DecisionParticipant[] {
	return db.select().from(decisionParticipants).where(eq(decisionParticipants.decisionId, decisionId)).orderBy(asc(decisionParticipants.id)).all();
}

/** The decision's options not retired, in their order. */
function liveOptionsOf(decisionId: number): DecisionOption[] {
	return db
		.select()
		.from(decisionOptions)
		.where(and(eq(decisionOptions.decisionId, decisionId), isNull(decisionOptions.retiredInVersion)))
		.orderBy(asc(decisionOptions.position), asc(decisionOptions.id))
		.all();
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

/** How each of the rows would be reached by a record-bearing mail now (`reachOf`, decision 16), by participant id. */
function reachesOf(decisionId: number, rows: DecisionParticipant[]): Map<number, Reach> {
	const persons = peopleById(rows.map((row) => row.personId).filter((id): id is number => id !== null));
	const history = accountHistory(decisionId);
	return new Map(
		rows.map((row) => [row.id, reachOf(row, row.personId === null ? null : (persons.get(row.personId) ?? null), history.get(row.id) ?? false)])
	);
}

/**
 * The option ids the working content lists in its `options`, or null when it
 * holds no such list, which states nothing about the options and so retires
 * none (decision 24).
 */
function listedOptionIds(decision: Decision): Set<number> | null {
	try {
		const read = JSON.parse(decision.workingContent) as { options?: unknown } | null;
		if (read === null || typeof read !== 'object' || !Array.isArray(read.options)) return null;
		return new Set(
			read.options
				.map((entry: unknown) => (entry !== null && typeof entry === 'object' ? (entry as { optionId?: unknown }).optionId : undefined))
				.filter((id): id is number => typeof id === 'number')
		);
	} catch {
		return null;
	}
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

/**
 * Version 1's content: the working content, its options those still live,
 * each with its text from the working content and its id and label.
 */
function versionContent(decision: Decision, options: DecisionOption[]): string {
	let working: Record<string, unknown> = {};
	try {
		const read = JSON.parse(decision.workingContent) as unknown;
		if (read !== null && typeof read === 'object' && !Array.isArray(read)) working = read as Record<string, unknown>;
	} catch {
		// Not JSON: the version holds the options alone.
	}
	const written = Array.isArray(working.options) ? (working.options as unknown[]) : [];
	const textOf = (optionId: number) =>
		written.find((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object' && (entry as { optionId?: unknown }).optionId === optionId);
	return JSON.stringify({ ...working, options: options.map((option) => ({ ...(textOf(option.id) ?? {}), optionId: option.id, label: option.label })) });
}

/**
 * What a decision's activity entry holds but its action (decision 21, 4.10):
 * its board, no card, the actor and the tree. The action is written at each
 * call, as `activity-twins.test.ts` requires.
 */
function decisionEntry(boardId: number, detail: string, user: SessionUser, opts: ServiceOptions) {
	return { boardId, cardId: null, detail, source: opts.source, ...actorOf(user) };
}
