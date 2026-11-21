/**
 * decision-authoring-writes.ts — a decision drafted: made (`createDecision`)
 * and its decider named (`setDecider`) (card 2675, plan section 4.7); its
 * working copy saved (`updateDraft`) and agent-drafted text marked reviewed
 * (`markReviewed`) (card 2676); and a dry run of it mailed to the caller
 * alone (`dryRunDecision`) (card 2697). Card 2713 moved them here from the
 * former decision service, unchanged (D1).
 *
 * Cards 2676, 2677 and 2697 add the routes and pages, each calling a write
 * inside its `writeAs` callback, handed `caller`.
 *
 * Card 2697 adds the dry run (`dryRunDecision`), and limits the mail it
 * sends: per caller, the dry runs, across decisions, in 24 hours. Card 2728
 * flags what an API key chose (a title, a decider) until a person marks it
 * reviewed.
 *
 * Card 2682 adds the API v1 routes, which call `createDecision`,
 * `updateDraft` and `setDecider` with `source: 'api'`. A key is refused a
 * dry run (D3), as it mails people, and the decider of a decision ever opened
 * (D4).
 *
 * Each write has the one shape of a service, and the record, the activity
 * entry, the live event and the mail are written as decision-write-shared.ts's
 * header says.
 */
import { error } from '@sveltejs/kit';
import { eq, inArray } from 'drizzle-orm';
import { db, sqlite } from './db';
import { decisionOptions, decisionSurveyQuestions, decisions, users, type Decision, type DecisionOption, type DecisionSurveyQuestion } from './db/schema';
import type { SessionUser } from './auth';
import { canEditBoard, isAdmin } from './board-access';
import {
	changedSections,
	liveOptionsOf,
	liveSurveyQuestionsOf,
	nextLabel,
	parseWorkingContent,
	publishedSurveyOf,
	readContent,
	readTitle,
	sectionKeysOf,
	sendsSurveyQuestions,
	withChosenFlag,
	type WorkingContent
} from './decision-content';
import { actorFor, appendEvent, dryRunsSince, lastDryRunAt, liveOptionIds, personOfAccount } from './decision-record';
import { DAY_MS, dailyCapFrom, decisionLinkBase, DRY_RUN_DAILY_CAP, DRY_RUN_MIN_MINUTES, later, queueDryRun } from './decision-mail';
import { requireTransition } from './decision-status';
import { isSmtpConfigured, NO_LINK_ADDRESS } from './email';
import { takeAllowance } from './rate-limit';
import { readChoice, readId, readList, readText, readTimestamp, type RequestBody } from './request-body';
import { CLOSES_TOO_FAR, closesTooFar } from '$lib/decision-readiness';
import { requireBoard, requireDecision, requireUser } from './route-guards';
import { stamp, type Stamp } from '$lib/timestamps';
import { inWrite, type ServiceOptions } from './write-as';
import { dayBefore, keyed, MAIL_ACT, OPENED_PEOPLE, requireDeciderRecordable, requireRevision, sourceOf } from './decision-write-shared';
import { ACCESS_KIND, accessAsRecorded, recordAccessChange } from './access-changes';

/** None of the drafting writes has a guard of its own: every export here is a write, and starts with `inWrite()`. */
export const READS: readonly string[] = [];

/** How a decision's options are answered: one choice, or a score for each (card 2676, decision 28). */
const VOTE_MODES = ['single', 'score'] as const;

/** The 409 for naming the decider of a decision that supersedes another (card 2679, code review S1). */
const SUPERSEDING_DECIDER_FIXED =
	"This decision supersedes a ruled one: its decider was set when it was made and cannot be changed. Withdraw it and supersede the ruling again for another decider";

/**
 * Make a draft on a board the caller can edit. `title` text, trimmed, 1 to 200
 * characters, holding no control, direction or invisible character (decision
 * 30). The decider is the board's Product Owner, if that account can edit the
 * board now, and the author otherwise (decision 7). Writes `created`; no
 * activity entry, live event or mail. Through an API key the title is the
 * key's choice, flagged `agentDrafted.title` until a person marks it
 * reviewed (card 2728, D2); the decider is the server's, and flagged nowhere.
 * Card 3033 (D1): `decision tracked` and `decision_decider yes` recorded after
 * the insert; R14: 409 first where the decider's account's creation time
 * names no moment.
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
			: db
					.select({ id: users.id, username: users.username, role: users.role, disabledAt: users.disabledAt })
					.from(users)
					.where(eq(users.id, board.productOwnerUserId))
					.get();
	const productOwner = owner && canEditBoard(owner, board.id) ? owner : null;
	requireDeciderRecordable(productOwner ?? user);

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
			...(keyed(opts) ? { workingContent: withChosenFlag('{}', 'title') } : {}),
			createdAt: now,
			updatedAt: now
		})
		.returning()
		.get();
	recordAccessChange(sqlite, { kind: ACCESS_KIND.decision, subject: decision.id, access: 'tracked' });
	recordAccessChange(sqlite, { kind: ACCESS_KIND.decisionDecider, subject: decision.id, holder: decision.deciderUserId, access: 'yes' });
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
 * supersedes another, at any status, after the status's own refusal. Card
 * 2728 (D2): a key's change of decider is flagged `agentDrafted.decider`, its
 * review stamp removed, until a person marks it reviewed; a person's change
 * keeps the flag (D3).
 *
 * Card 3033 (D2): `decision_decider yes` recorded after the write. R14: 409
 * for an account whose creation time names no moment, asked last of the
 * refusals, after the account and its board edit (code review, FP13), and
 * before the decider it has is compared or anything is written. R15: naming
 * the decider it has records the decider where the record names another or
 * none (`accessAsRecorded`), with no other write.
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
	const account = db
		.select({ id: users.id, username: users.username, role: users.role, disabledAt: users.disabledAt })
		.from(users)
		.where(eq(users.id, deciderUserId))
		.get();
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
	requireDeciderRecordable(account);
	const recorded = { kind: ACCESS_KIND.decisionDecider, subject: decision.id, holder: account.id, access: 'yes' };
	if (account.id === decision.deciderUserId) {
		if (!accessAsRecorded(sqlite, recorded)) recordAccessChange(sqlite, recorded);
		return decision;
	}

	const row = db
		.update(decisions)
		.set({
			deciderUserId: account.id,
			deciderName: account.username,
			...(keyed(opts) ? { workingContent: withChosenFlag(decision.workingContent, 'decider') } : {}),
			updatedAt: stamp()
		})
		.where(eq(decisions.id, decision.id))
		.returning()
		.get();
	recordAccessChange(sqlite, recorded);
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
 * (decision 9). So is a draft's title the save changed, as
 * `agentDrafted.title` (card 2728, D2), with or without `content`. No event,
 * activity entry, live event or mail.
 *
 * Card 2683: the survey question rows are kept in step with
 * `content.surveyQuestions` as option rows are (R5), with no label: a new
 * entry is given a row, whose id its `questionId` then names; an entry's
 * `questionId` must be a live survey question of this decision (400); one
 * left out is deleted if never published, and otherwise stays live, to be
 * retired at the next publish. Content that does not send `surveyQuestions`
 * keeps the stored ones (R15). A published question's kind is fixed (R8,
 * 400); its other words may change here, and a re-publish carrying such a
 * change asks everyone again. Its agent flag is `survey.<questionId>` (R16).
 * The vote mode may change on an opened decision while its current version
 * has no live option (R23), so that a survey becomes a vote in either mode;
 * a key's change of it there is flagged `agentDrafted.voteMode` (code review
 * F5), as a key's change of a draft's title is. Answers the survey question
 * rows besides.
 */
export function updateDraft(
	caller: SessionUser | null,
	at: { decisionId: number },
	body: RequestBody,
	opts: ServiceOptions
): { decision: Decision; options: DecisionOption[]; surveyQuestions: DecisionSurveyQuestion[] } {
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
	const liveQuestions = liveSurveyQuestionsOf(decision.id);
	if (content) {
		const liveIds = new Set(live.map((option) => option.id));
		content.options.forEach((option, index) => {
			if (option.optionId !== undefined && !liveIds.has(option.optionId)) {
				error(400, `options[${index}].optionId ${option.optionId} is not a live option of this decision`);
			}
		});
		const liveQuestionIds = new Set(liveQuestions.map((row) => row.id));
		// R15: not sent, the stored questions stand as they are, but any whose row is no longer live.
		if (!sendsSurveyQuestions(body)) {
			content.surveyQuestions = content.surveyQuestions.filter((question) => question.questionId !== undefined && liveQuestionIds.has(question.questionId));
		}
		// R8: the kind of a published question is fixed, as published in the current version (or, failing that, as saved).
		const published = publishedSurveyOf(decision.id, decision.currentVersion);
		content.surveyQuestions.forEach((question, index) => {
			if (question.questionId === undefined) return;
			if (!liveQuestionIds.has(question.questionId)) {
				error(400, `surveyQuestions[${index}].questionId ${question.questionId} is not a live survey question of this decision`);
			}
			const row = liveQuestions.find((one) => one.id === question.questionId)!;
			if (row.addedInVersion === null) return;
			const was =
				published.find((one) => one.questionId === question.questionId) ?? stored.surveyQuestions.find((one) => one.questionId === question.questionId);
			if (was !== undefined && was.kind !== question.kind) {
				error(400, `Survey question ${index + 1} has been published: its kind is fixed. Remove it and add a new question`);
			}
		});
	}

	requireTransition(decision, 'edit');
	requireRevision(decision, revision);
	const draft = decision.status === 'draft';
	// Card 2683 (R23): while the current version puts no option, the vote mode is unused and may change, opened or not.
	const modeFree = draft || liveOptionIds(decision.id, decision.currentVersion).length === 0;
	if (!draft) {
		if (title !== undefined && title !== decision.title) error(409, 'This decision has been opened: its title cannot be changed');
		if (closesAt !== undefined && closesAt !== decision.closesAt) error(409, 'This decision has been opened: the closing time of an open decision changes by Extend');
		if (!modeFree && voteMode !== undefined && voteMode !== decision.voteMode) error(409, 'This decision has been opened: its vote mode cannot be changed');
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

		// Card 2683 (R5): the survey question rows as the option rows, with no label.
		const asked = content.surveyQuestions.map((question, index) => {
			if (question.questionId !== undefined) {
				const row = liveQuestions.find((one) => one.id === question.questionId)!;
				if (row.position !== index) db.update(decisionSurveyQuestions).set({ position: index }).where(eq(decisionSurveyQuestions.id, row.id)).run();
				return question;
			}
			const row = db.insert(decisionSurveyQuestions).values({ decisionId: decision.id, position: index }).returning().get();
			return { ...question, questionId: row.id };
		});
		const keptQuestions = new Set(asked.map((question) => question.questionId));
		const unasked = liveQuestions.filter((row) => !keptQuestions.has(row.id) && row.addedInVersion === null).map((row) => row.id);
		if (unasked.length > 0) db.delete(decisionSurveyQuestions).where(inArray(decisionSurveyQuestions.id, unasked)).run();

		// Decision 9: the flags are the server's; through an API key each changed section is flagged again.
		const after = { ...content, options: listed, surveyQuestions: asked };
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
			// Card 2683 (R16): a survey question's flag goes with it.
			const questionId = /^survey\.(\d+)$/.exec(key);
			if (questionId !== null && !keptQuestions.has(Number(questionId[1]))) delete agentDrafted[key];
		}
		working = { ...after, agentDrafted, reviewed, lastLabel };
	}

	// Card 2728 (D2): a key's change of a draft's title is the key's choice of every invitation's subject.
	const keyTitle = keyed(opts) && draft && title !== undefined && title !== decision.title;
	// Card 2683 (R23, code review F5): a key's change of an opened survey's vote mode is the key's choice of how the
	// options a re-publish puts are voted on, flagged as card 2728 flags the title.
	const keyMode = keyed(opts) && !draft && modeFree && voteMode !== undefined && voteMode !== decision.voteMode;
	const chosen = [...(keyTitle ? (['title'] as const) : []), ...(keyMode ? (['voteMode'] as const) : [])];
	let workingContent: string | undefined;
	if (working) {
		for (const key of chosen) {
			working.agentDrafted[key] = true;
			delete working.reviewed[key];
		}
		workingContent = JSON.stringify(working);
	} else {
		for (const key of chosen) workingContent = withChosenFlag(workingContent ?? decision.workingContent, key);
	}

	const row = db
		.update(decisions)
		.set({
			...(draft && title !== undefined ? { title } : {}),
			...(draft && closesAt !== undefined ? { closesAt } : {}),
			...(modeFree && voteMode !== undefined ? { voteMode } : {}),
			...(workingContent !== undefined ? { workingContent } : {}),
			updatedAt: now
		})
		.where(eq(decisions.id, decision.id))
		.returning()
		.get();
	return { decision: row, options: liveOptionsOf(decision.id), surveyQuestions: liveSurveyQuestionsOf(decision.id) };
}

/**
 * Mark sections drafted by an agent reviewed (card 2676, decision 9, R7):
 * `sections`, a list of section keys or `'all'`, and `revision`, required.
 * Since card 2728 a key may also be `title`, `participants` or `decider`,
 * each chosen through an API key (`sectionKeysOf`), and `'all'` clears them too.
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
