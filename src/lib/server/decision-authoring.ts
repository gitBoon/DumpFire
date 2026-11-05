/**
 * decision-authoring.ts — what the pages that draft a decision read, and the
 * one shape every answer about a decision is given in (card 2676, decisions
 * 14 to 17, R4).
 *
 * Plain reads that take the signed-in account, `user: SessionUser`, and no
 * `caller`: a page load calls them, and a service's read may not be called
 * from a page load (tests/check-at-the-write.test.ts), as `people-directory.ts`
 * is called. Each guards itself first, with `requireBoard` or
 * `requireDecision`, and writes nothing.
 *
 * Every answer about a decision, a page load's and each route's, is shaped
 * here (decision 15, R4): an allowlist written out field by field, never a
 * row spread, so that a column added later is given to nobody until it is
 * named. To a caller who is not an administrator no participant's account,
 * address, `includedBy`, `removedBy` or `linkIssuedAt` is given, and nobody is
 * given `linkTokenHash`. The working content is given without `lastLabel`,
 * and a review stamp's account id only to an administrator (the code
 * review's C3). The people picker gives active people alone, by name, job
 * title and groups, and an address only to an administrator; the people and
 * the groups' members only to a caller who may save the participants, and
 * the decider candidates only to one who may change the decider (C4). The routes
 * call the projection inside their writeAs callback, on the rows the write
 * answered.
 *
 * Card 2697 adds the delivery panel's rows (`delivery`, Q13): how each
 * participant has been mailed, in words made here from the record, and
 * whether Resend would reach them, by the write's own rules. No address,
 * response or total is in them. And the lifecycle controls (`actions`, Q14):
 * what the caller may do now, by `TRANSITIONS` and `mayDo` as each write asks
 * them, whether the withdrawal and the delete ask for the password, and what
 * a re-publish would do to the options (`republishSummary`).
 *
 * Card 2679 (decisions 22 and 26): the one projection gains the decision a
 * ruling supersedes and when its results were released, and gives the
 * closing time of a ruled or superseded decision to an administrator alone,
 * as the board's list gives it to nobody: beside `updatedAt`, the ruling's
 * moment, it would say whether the ruling was early. The editor says whether
 * the caller may read the results (`mayReadResults`).
 *
 * Card 2682 (D9 to D11) adds what an API key is given: `keyDecisionAnswer`
 * and `keyParticipantAnswers`, the shapes a caller who is no administrator is
 * given, to every key, an administrator's included, each marked `untrusted`;
 * and `readDecisionForKey`, the editors' read for v1, with what a key may do
 * now and the picker with no address, and no delivery or directory facts.
 */
import { isHttpError } from '@sveltejs/kit';
import { asc, desc, eq } from 'drizzle-orm';
import { db } from './db';
import {
	boards,
	decisions,
	people,
	peopleGroupMembers,
	peopleGroups,
	type Decision,
	type DecisionOption,
	type DecisionParticipant
} from './db/schema';
import type { SessionUser } from './auth';
import { editorsOf, isAdmin, roleOnBoard } from './board-access';
import { mayDo, type DecisionAccess, type DecisionRole } from './decision-access';
import {
	allOptionsOf,
	audienceFactsOf,
	listedOptionIds,
	liveOptionsOf,
	openFactsOf,
	optionChanges,
	parseWorkingContent,
	participantsOf,
	revisionOf,
	type VersionContent,
	type WorkingContent
} from './decision-content';
import { accountHistory, deliveryOf, peopleById, type DeliveryFacts } from './decision-record';
import {
	addressRefusal,
	attachRefusal,
	clearRefusal,
	CLOSED_ASK_WORDS,
	reachOf,
	REMOVED_WORDS,
	REVOKE_WORDS,
	SKIP_WORDS,
	type RevokeReason,
	type SkipReason
} from './decision-links';
import { DAY_MS, decisionLinkBase, HELD_WORDS, MAIL_EVENT, mailRestOf, type HoldReason, type RecordMail } from './decision-mail';
import { decisionStatus, requireTransition, TRANSITIONS, type ShownStatus } from './decision-status';
import { MAIL_PROBLEM_WORDS, NO_LINK_ADDRESS, type MailProblem } from './email';
import { requireBoard, requireDecision } from './route-guards';
import { checkContent, refusalsOf, type ContentAnswer, type Refusal, type Warning } from '$lib/decision-readiness';
import type { ViewContent } from '$lib/decision-view-types';
import { openForInput } from '$lib/decision-rules';
import { stamp, type Stamp } from '$lib/timestamps';

// ─── The one projection (decision 15, R4) ────────────────────────────────────

/** A decision as every answer gives it: its working content projected, and no account id but the decider's (and, to an administrator, each reviewer's). */
export type DecisionAnswer = {
	id: number;
	boardId: number | null;
	boardName: string;
	title: string;
	status: string;
	shownStatus: ShownStatus;
	voteMode: string;
	closesAt: Stamp | null;
	currentVersion: number;
	authorName: string;
	deciderUserId: number | null;
	deciderName: string | null;
	content: ContentAnswer;
	createdAt: Stamp;
	updatedAt: Stamp;
	openedAt: Stamp | null;
	closedAt: Stamp | null;
	withdrawnAt: Stamp | null;
	withdrawnReason: string | null;
	/** Card 2679 (decision 22): the decision this one supersedes, by id, or null. */
	supersedesId: number | null;
	/** Card 2679 (decision 22): when its results were released, or null. No `ruledAt`: beside `closesAt` it would say whether the ruling was early. */
	resultsReleasedAt: Stamp | null;
};

/** Whether a decision is ruled on: stored `ruled` or `superseded` (card 2679). */
const isRuled = (decision: Pick<Decision, 'status'>) => decision.status === 'ruled' || decision.status === 'superseded';

/** An option row as every answer gives it. Its text is in the content. */
export type OptionAnswer = { id: number; label: string; position: number; addedInVersion: number | null; retiredInVersion: number | null };

/**
 * A participant as everyone who may edit the decision is given it: no
 * account, no address and no one's account id. `reach` is how they would be
 * told, from the account their snapshot holds. `hasLeft` and `notInDirectory`
 * are their person now (decision 29).
 */
export type ParticipantAnswer = {
	id: number;
	personId: number | null;
	role: string;
	name: string;
	jobTitle: string;
	groups: string[];
	includedAt: Stamp;
	includedByName: string | null;
	removedAt: Stamp | null;
	reach: 'account' | 'link';
	hasLeft: boolean;
	notInDirectory: boolean;
};

/** What an administrator is given of a participant besides. Never `linkTokenHash`. */
export type AdminParticipantAnswer = ParticipantAnswer & {
	email: string;
	userId: number | null;
	includedBy: number | null;
	removedBy: number | null;
	linkIssuedAt: Stamp | null;
};

/**
 * The working content as every answer gives it (the code review's C3), field
 * by field: never `lastLabel`, and each review stamp as `{ byName, at }`, with
 * `byUserId` besides to an administrator (`admin`) alone.
 */
export function contentAnswer(content: WorkingContent, admin: boolean): ContentAnswer {
	const reviewed: ContentAnswer['reviewed'] = {};
	for (const [key, stamped] of Object.entries(content.reviewed)) {
		reviewed[key] = admin ? { byName: stamped.byName, at: stamped.at, byUserId: stamped.byUserId } : { byName: stamped.byName, at: stamped.at };
	}
	return {
		situation: content.situation,
		question: content.question,
		ask: content.ask,
		options: content.options.map((option) => ({
			...(option.optionId === undefined ? {} : { optionId: option.optionId }),
			title: option.title,
			summary: option.summary,
			pros: option.pros,
			cons: option.cons,
			commercial: option.commercial
		})),
		audiences: content.audiences.map((audience) => ({ groupId: audience.groupId, heading: audience.heading, body: audience.body })),
		stories: content.stories.map((story) => ({ title: story.title, body: story.body })),
		unknowns: content.unknowns,
		alreadyRuled: content.alreadyRuled,
		technicalDetail: content.technicalDetail,
		agentDrafted: { ...content.agentDrafted },
		reviewed
	};
}

/**
 * A published version's content as the participant page gives it (card 2677,
 * decision 16, R3), field by field from `parseVersionContent`: its text
 * sections, its stories and its agent flags, and nothing else. A signed-in
 * caller (`via: 'session'`) is also given `reviewed`, a yes for each reviewed
 * section, with no reviewer's name and no moment; a link holder is not, as an
 * agent flag already says a section is not yet reviewed. The options and the
 * audiences are given once, by `viewModelOf` in decision-view.ts, so neither is
 * here, and no group id or reviewer's name reaches the page.
 */
export function versionContentAnswer(content: VersionContent, via: 'session' | 'link'): ViewContent {
	const answer: ViewContent = {
		situation: content.situation,
		question: content.question,
		ask: content.ask,
		unknowns: content.unknowns,
		alreadyRuled: content.alreadyRuled,
		technicalDetail: content.technicalDetail,
		stories: content.stories.map((story) => ({ title: story.title, body: story.body })),
		agentDrafted: { ...content.agentDrafted }
	};
	if (via === 'session') {
		const reviewed: Record<string, true> = {};
		for (const key of Object.keys(content.reviewed)) reviewed[key] = true;
		answer.reviewed = reviewed;
	}
	return answer;
}

/**
 * The working copy as the preview gives it (card 2697, Q4), field by field,
 * as `versionContentAnswer` gives a version to a signed-in caller: its text
 * sections, its stories, its agent flags, and `reviewed` as a yes for each
 * reviewed section, with no reviewer's name, account or moment, and no
 * `lastLabel`. The options and the audiences are `viewModelOf`'s, in
 * decision-view.ts, so neither is here, and no group id reaches the page.
 */
export function workingViewContent(content: WorkingContent): ViewContent {
	const reviewed: Record<string, true> = {};
	for (const key of Object.keys(content.reviewed)) reviewed[key] = true;
	return {
		situation: content.situation,
		question: content.question,
		ask: content.ask,
		unknowns: content.unknowns,
		alreadyRuled: content.alreadyRuled,
		technicalDetail: content.technicalDetail,
		stories: content.stories.map((story) => ({ title: story.title, body: story.body })),
		agentDrafted: { ...content.agentDrafted },
		reviewed
	};
}

/**
 * A decision as every answer gives it (decision 15), to an administrator
 * (`admin`) with each reviewer's account id besides. Once it is ruled or
 * superseded its closing time, and the moment it was closed for input (card
 * 2682, code review S5), are given to an administrator alone: beside
 * `updatedAt`, the ruling's moment, either would tell anyone else whether the
 * ruling was early (card 2679, decision 26).
 */
export function decisionAnswer(decision: Decision, admin: boolean, now: Stamp = stamp()): DecisionAnswer {
	return {
		id: decision.id,
		boardId: decision.boardId,
		boardName: decision.boardName,
		title: decision.title,
		status: decision.status,
		shownStatus: decisionStatus(decision, now),
		voteMode: decision.voteMode,
		closesAt: isRuled(decision) && !admin ? null : decision.closesAt,
		currentVersion: decision.currentVersion,
		authorName: decision.authorName,
		deciderUserId: decision.deciderUserId,
		deciderName: decision.deciderName,
		content: contentAnswer(parseWorkingContent(decision.workingContent), admin),
		createdAt: decision.createdAt,
		updatedAt: decision.updatedAt,
		openedAt: decision.openedAt,
		// Card 2682, code review S5: as closesAt, for the same reason: beside the ruling's moment it says whether the ruling was early.
		closedAt: isRuled(decision) && !admin ? null : decision.closedAt,
		withdrawnAt: decision.withdrawnAt,
		withdrawnReason: decision.withdrawnReason,
		supersedesId: decision.supersedesId,
		resultsReleasedAt: decision.resultsReleasedAt
	};
}

/** Option rows as every answer gives them (decision 15). */
export function optionAnswers(options: DecisionOption[]): OptionAnswer[] {
	return options.map((option) => ({
		id: option.id,
		label: option.label,
		position: option.position,
		addedInVersion: option.addedInVersion,
		retiredInVersion: option.retiredInVersion
	}));
}

/** The group names a participant's snapshot holds, read tolerantly. */
function groupNamesOf(json: string): string[] {
	try {
		const read = JSON.parse(json) as unknown;
		return Array.isArray(read) ? read.filter((name): name is string => typeof name === 'string') : [];
	} catch {
		return [];
	}
}

/**
 * Participant rows as every answer gives them (decision 15): to an
 * administrator (`admin`) with their address, account, who included and
 * removed them, and when their link was issued; to anyone else without.
 * Their persons are read once, for `hasLeft` and `notInDirectory`.
 */
export function participantAnswers(rows: DecisionParticipant[], admin: boolean): (ParticipantAnswer | AdminParticipantAnswer)[] {
	const persons = peopleById(rows.map((row) => row.personId).filter((id): id is number => id !== null));
	return rows.map((row) => {
		const person = row.personId === null ? undefined : persons.get(row.personId);
		const shown: ParticipantAnswer = {
			id: row.id,
			personId: row.personId,
			role: row.role,
			name: row.name,
			jobTitle: row.jobTitle,
			groups: groupNamesOf(row.groups),
			includedAt: row.includedAt,
			includedByName: row.includedByName,
			removedAt: row.removedAt,
			reach: row.userId === null ? 'link' : 'account',
			hasLeft: person !== undefined && person.status !== 'active',
			notInDirectory: person === undefined
		};
		if (!admin) return shown;
		const extra: AdminParticipantAnswer = {
			...shown,
			email: row.email,
			userId: row.userId,
			includedBy: row.includedBy,
			removedBy: row.removedBy,
			linkIssuedAt: row.linkIssuedAt
		};
		return extra;
	});
}

// ─── What a page and a save are answered besides ─────────────────────────────

/**
 * The decision's revision as it is now (decision 10), from its row and every
 * option and participant row: what the next authoring write must send.
 */
export function revisionFor(decisionId: number): string {
	const decision = db.select().from(decisions).where(eq(decisions.id, decisionId)).get();
	if (!decision) return '';
	return revisionOf(decision, allOptionsOf(decisionId), participantsOf(decisionId));
}

/** The readability check: the refusals and the warnings, as the page is handed them. */
export type Readiness = { refusals: Refusal[]; warnings: Warning[] };

/** `readinessOf`, with the participant rows already read. */
function readiness(decision: Decision, participants: DecisionParticipant[], now: Stamp): Readiness {
	const content = parseWorkingContent(decision.workingContent);
	const draft = decision.status === 'draft';
	return {
		// What stops opening asks of a draft alone: nothing else is opened.
		refusals: draft ? refusalsOf(openFactsOf(decision, now)) : [],
		// Once opened, a closing time too far ahead is a warning, as re-publishing refuses it (the code review's part B, S3).
		warnings: checkContent(content, audienceFactsOf(content, participants), draft ? undefined : { closesAt: decision.closesAt, now })
	};
}

/**
 * The readability check worked out on the server (decisions 11 and 12): a
 * draft's refusals, in `openDecision`'s words and order, from facts that never
 * leave the server, and the content's warnings. The page is handed the codes
 * and the words.
 */
export function readinessOf(decision: Decision, now: Stamp = stamp()): Readiness {
	return readiness(decision, participantsOf(decision.id), now);
}

// ─── The board's decision list (decision 14) ─────────────────────────────────

/** A row of the board's decision list. `mayEdit` is `mayDo(…, 'edit')`'s answer: the title links to the editor only where it holds. */
export type BoardDecisionRow = {
	id: number;
	title: string;
	status: string;
	shownStatus: ShownStatus;
	authorName: string;
	deciderName: string | null;
	closesAt: Stamp | null;
	updatedAt: Stamp;
	mayEdit: boolean;
};

/**
 * The decisions on a board the caller can view (decision 14), newest first:
 * every one that is not a draft, and a draft only to its author, its decider,
 * the board's owners and administrators (`DRAFT_VIEWERS`). One query, with the
 * caller's role on the board read once: each row's access is made from it and
 * the row's author and decider, and asked of `mayDo` itself, so that the list
 * and the rule cannot disagree. The participant role is not asked: a caller
 * who can view the board sees every decision that is not a draft by their
 * board role, and a participant sees no draft. `canCreate`: the caller can
 * edit the board, as `createDecision` asks.
 */
export function readBoardDecisions(
	user: SessionUser,
	boardId: number
): { board: { id: number; name: string }; canCreate: boolean; decisions: BoardDecisionRow[] } {
	const board = requireBoard(user, boardId, 'view');
	const role = roleOnBoard(user, board);
	const canEditBoard = role === 'admin' || role === 'owner' || role === 'editor';
	const boardRole: DecisionRole | null = role === 'owner' ? 'boardOwner' : role === 'editor' ? 'boardEditor' : role === 'viewer' ? 'boardReader' : null;

	const rows = db
		.select({
			id: decisions.id,
			boardId: decisions.boardId,
			title: decisions.title,
			status: decisions.status,
			closesAt: decisions.closesAt,
			authorUserId: decisions.authorUserId,
			authorName: decisions.authorName,
			deciderUserId: decisions.deciderUserId,
			deciderName: decisions.deciderName,
			updatedAt: decisions.updatedAt
		})
		.from(decisions)
		.where(eq(decisions.boardId, board.id))
		.orderBy(desc(decisions.createdAt), desc(decisions.id))
		.all();

	const now = stamp();
	const listed: BoardDecisionRow[] = [];
	for (const row of rows) {
		const roles = new Set<DecisionRole>();
		if (isAdmin(user)) roles.add('admin');
		if (row.authorUserId !== null && row.authorUserId === user.id) roles.add('author');
		if (row.deciderUserId !== null && row.deciderUserId === user.id) roles.add('decider');
		if (boardRole !== null) roles.add(boardRole);
		const access: DecisionAccess = { roles, participantId: null, canEditBoard };
		if (!mayDo(access, 'view', row)) continue;
		listed.push({
			id: row.id,
			title: row.title,
			status: row.status,
			shownStatus: decisionStatus(row, now),
			authorName: row.authorName,
			deciderName: row.deciderName,
			// Card 2679 (decision 26): once ruled, beside `updatedAt` it would say whether the ruling was early.
			closesAt: isRuled(row) ? null : row.closesAt,
			updatedAt: row.updatedAt,
			mayEdit: mayDo(access, 'edit', row)
		});
	}
	return { board: { id: board.id, name: board.name }, canCreate: canEditBoard, decisions: listed };
}

// ─── Delivery (card 2697, decision 21, Q13) ──────────────────────────────────

/** How a participant's latest record mail went: handed to the mail server, refused, not sent as a later write ended it, not sent for no link address, or not known yet. */
export type DeliveryOutcome = 'sent' | 'failed' | 'superseded' | 'no_link_address' | 'pending';

/**
 * How one participant has been mailed, and whether Resend would reach them
 * now, as the editor's delivery panel is given it: the words made here, from
 * the record. No address, no response and no total.
 */
export type DeliveryRow = {
	participantId: number;
	/** Their latest record mail: which, when, whether it was a re-send, and its outcome; `problem` the failure's words alone. */
	lastMail: { mail: RecordMail; at: Stamp; resend: boolean; outcome: DeliveryOutcome; problem: string | null } | null;
	/** Their latest skip, in `SKIP_WORDS`' or `HELD_WORDS`' words; null where a record mail has gone since (`skipAfter`). */
	lastSkip: { mail: string; at: Stamp; words: string } | null;
	/** Their link's latest ending, in `REVOKE_WORDS`' words. */
	lastRevoked: { at: Stamp; words: string } | null;
	/** Why a record mail would skip them now, in `SKIP_WORDS`' words; null for one it would reach, and for one removed. */
	reachNow: string | null;
	/** Whether `resendInvitation` would send them their invitation again now. */
	resendable: boolean;
	/** Where the rest or the daily cap holds them back: the moment, in UTC, from which Resend may. */
	resendFrom: Stamp | null;
	/** Where they cannot be sent it again, the words `resendInvitation` would refuse with. */
	refusal: string | null;
};

/** The mail each record event is: decision-mail.ts's `MAIL_EVENT`, inverted, so the two cannot drift (the code review's part B, F5). */
const MAIL_OF_EVENT: Readonly<Record<string, RecordMail>> = Object.fromEntries(
	(Object.entries(MAIL_EVENT) as [RecordMail, string][]).map(([mail, kind]) => [kind, mail])
);

/** A `mail_outcome` detail as the panel's outcome and the failure's words. */
function outcomeOf(detail: Record<string, unknown> | null): { outcome: DeliveryOutcome; problem: string | null } {
	if (detail === null) return { outcome: 'pending', problem: null };
	if (detail.delivered === true) return { outcome: 'sent', problem: null };
	if (detail.problem === 'superseded') return { outcome: 'superseded', problem: null };
	if (detail.problem === 'no_link_address') return { outcome: 'no_link_address', problem: null };
	const problem = typeof detail.problem === 'string' && Object.hasOwn(MAIL_PROBLEM_WORDS, detail.problem) ? (detail.problem as MailProblem) : 'failed';
	return { outcome: 'failed', problem: MAIL_PROBLEM_WORDS[problem] };
}

/**
 * A `mail_skipped` reason in the panel's words: a participant who could not
 * be mailed at all (`SKIP_WORDS`), or one made consulted whose asking mail
 * a rest or a cap held back (`HELD_WORDS`, card 2740, D3); any other reason
 * as plain "They were not mailed".
 */
function skipWordsOf(reason: string | undefined, name: string): string {
	if (reason !== undefined && Object.hasOwn(SKIP_WORDS, reason)) return SKIP_WORDS[reason as SkipReason](name);
	if (reason !== undefined && Object.hasOwn(HELD_WORDS, reason)) return HELD_WORDS[reason as HoldReason](name);
	return 'They were not mailed';
}

/**
 * The participant's latest skip where it is newer than their latest record
 * mail, else null (card 2740's code review, 2026-11-05): a mail held back and
 * then sent by Resend, or by any later write, is no longer "not sent". Newer
 * by moment, as `lastMail` is chosen; on the same moment, the later event.
 */
function skipAfter(skip: DeliveryFacts['lastSkip'], mail: DeliveryFacts['lastMail']): DeliveryFacts['lastSkip'] {
	if (skip === null || mail === null) return skip;
	return skip.at > mail.at || (skip.at === mail.at && skip.eventId > mail.eventId) ? skip : null;
}

/**
 * The words a 409 for the decision's status would carry, or null where it
 * allows `resend`: `requireTransition` itself is asked, so that the panel's
 * words cannot drift from the write's.
 */
function transitionRefusal(decision: Decision, now: Stamp): string | null {
	try {
		requireTransition(decision, 'resend', now);
		return null;
	} catch (err) {
		if (isHttpError(err)) return err.body.message;
		throw err;
	}
}

/**
 * Each participant's delivery (card 2697, Q13), in row order, from
 * `deliveryOf`'s one read of the record. `resendable`, `resendFrom` and
 * `refusal` follow `resendInvitation`'s own order: the status, removed,
 * consulted while not shown open (card 2743), `reachOf`, the link address, and the rest and the daily cap
 * (`mailRestOf`, which the write asks too), so the panel offers Resend
 * exactly where the write would send.
 */
function deliveryRows(decision: Decision, rows: DecisionParticipant[], now: Stamp): DeliveryRow[] {
	const facts = deliveryOf(decision.id);
	const persons = peopleById(rows.map((row) => row.personId).filter((id): id is number => id !== null));
	const history = accountHistory(decision.id);
	const statusRefusal = transitionRefusal(decision, now);
	// Card 2743 (D4): as `resendInvitation` asks it, after removed.
	const askable = openForInput(decisionStatus(decision, now));
	const linkAddress = decisionLinkBase() !== null;
	const since = stamp(new Date(Date.now() - DAY_MS));
	const empty: DeliveryFacts = { lastMail: null, mailMoments: [], lastRestAt: null, lastSkip: null, lastRevoked: null };

	return rows.map((row) => {
		const known = facts.get(row.id) ?? empty;
		const person = row.personId === null ? null : (persons.get(row.personId) ?? null);
		const reach = row.removedAt === null ? reachOf(row, person, history.get(row.id) ?? false) : null;
		const reachNow = reach !== null && 'skip' in reach ? SKIP_WORDS[reach.skip](row.name) : null;

		let refusal: string | null = statusRefusal;
		let resendFrom: Stamp | null = null;
		if (refusal === null && row.removedAt !== null) refusal = REMOVED_WORDS(row.name);
		if (refusal === null && row.role === 'consulted' && !askable) refusal = CLOSED_ASK_WORDS(row.name);
		if (refusal === null && reachNow !== null) refusal = reachNow;
		if (refusal === null && !linkAddress) refusal = NO_LINK_ADDRESS;
		if (refusal === null) {
			// The rest runs from the latest record mail or closing-date reminder (card 2685, S6), as `lastMailAt` reads it for the
			// write; the cap counts record mails alone.
			const held = mailRestOf(row.name, known.lastRestAt ?? undefined, known.mailMoments.filter((at) => at >= since), now);
			if (held !== null) {
				refusal = held.words;
				resendFrom = held.from;
			}
		}

		const last = known.lastMail;
		const skip = skipAfter(known.lastSkip, last);
		const revokeReason = known.lastRevoked?.reason;
		return {
			participantId: row.id,
			lastMail: last === null ? null : { mail: MAIL_OF_EVENT[last.kind] ?? 'invitation', at: last.at, resend: last.resend, ...outcomeOf(last.outcome) },
			lastSkip:
				skip === null
					? null
					: {
							mail: skip.mail,
							at: skip.at,
							words: skipWordsOf(skip.reason, row.name)
						},
			lastRevoked:
				known.lastRevoked === null
					? null
					: {
							at: known.lastRevoked.at,
							words: revokeReason !== undefined && Object.hasOwn(REVOKE_WORDS, revokeReason) ? REVOKE_WORDS[revokeReason as RevokeReason] : 'Their link was ended'
						},
			reachNow,
			resendable: refusal === null,
			resendFrom,
			refusal
		};
	});
}

/**
 * Which of the administrator's Attach account, Clear account and Use the
 * directory's address the delivery panel offers on each participant (card
 * 2697, B2b, Q22), decided here by the rules the writes' guards ask
 * (`attachRefusal`, `clearRefusal`, `addressRefusal` in decision-links.ts; the
 * code review's part B, F2), so the panel copies none of them. Nothing is
 * offered on a removed row, though the writes would take it: what is
 * offered is never more than the writes allow. `directoryAddress` is the
 * address the copy would take, named in its confirmation, and null where it
 * is not offered. An administrator's alone, beside `delivery`, which holds no
 * address.
 */
export type DirectoryFact = { participantId: number; canAttach: boolean; canClear: boolean; canUseDirectoryAddress: boolean; directoryAddress: string | null };

/** `DirectoryFact` for each row, in row order, from one read of the persons and of the account history. */
function directoryFacts(decision: Decision, rows: DecisionParticipant[]): DirectoryFact[] {
	const persons = peopleById(rows.map((row) => row.personId).filter((id): id is number => id !== null));
	const history = accountHistory(decision.id);
	return rows.map((row) => {
		const person = row.personId === null ? undefined : persons.get(row.personId);
		const live = row.removedAt === null;
		const address = live ? addressRefusal(row, person) : null;
		return {
			participantId: row.id,
			canAttach: live && !('refusal' in attachRefusal(row, person, rows)),
			canClear: live && clearRefusal(row, history.get(row.id) ?? false) === null,
			canUseDirectoryAddress: address !== null && 'email' in address,
			directoryAddress: address !== null && 'email' in address ? address.email : null
		};
	});
}

// ─── The edit page (decisions 15 to 17) ──────────────────────────────────────

/** A person the picker offers: active, and with no address unless the caller is an administrator. */
export type PickerPerson = { id: number; fullName: string; jobTitle: string; groupIds: number[] } | { id: number; fullName: string; jobTitle: string; groupIds: number[]; email: string };

/**
 * A group the picker offers: no description, and the ids of its active
 * members only to a caller who may save the participants (C4). The audience
 * select is handed the names alone.
 */
export type PickerGroup = { id: number; name: string; activeMemberIds?: number[] };

/** An account the decider select offers: one that can edit the board. */
export type DeciderCandidate = { id: number; username: string; emoji: string };

export type EditPage = {
	decision: DecisionAnswer;
	/** The live options, in their order. */
	options: OptionAnswer[];
	/** Every participant row, removed ones included, in order. */
	participants: (ParticipantAnswer | AdminParticipantAnswer)[];
	revision: string;
	readiness: Readiness;
	/** Whether the decision's status lets it be edited (`TRANSITIONS.edit`): draft, open or closed. */
	editable: boolean;
	/** Whether the caller may change the decider now: `setDecider`, on a status that allows it. */
	canSetDecider: boolean;
	/** Whether the caller may mark agent-drafted text reviewed now: `review`, on a status that allows it. */
	canReview: boolean;
	/** Whether the caller may save the participants now: `edit` on a draft, and `include` besides once opened (R3). */
	canSetParticipants: boolean;
	/** The board's Product Owner, whom the decider select marks; null with no board or none set. */
	productOwnerUserId: number | null;
	/** The picker's people: empty unless the caller may save the participants (decision 15, C4). */
	people: PickerPerson[];
	/** Every group by name, for the audience select; empty where the decision cannot be edited, and with no members unless the caller may save the participants (C4). */
	groups: PickerGroup[];
	/** Empty where the caller may not change the decider; the caller left out once the decision is open (decision 17). */
	deciderCandidates: DeciderCandidate[];
	/**
	 * How each participant has been mailed, and whether Resend would reach
	 * them (card 2697, Q13): only on a decision that has been opened, and
	 * only to a caller who may send an invitation again (`resend`: its
	 * author, its decider, an administrator); null otherwise.
	 */
	delivery: DeliveryRow[] | null;
	/**
	 * Which of the administrator's account and address actions each
	 * participant is offered (card 2697, B2b), by the writes' own rules (the
	 * code review's part B, F2): only to an administrator, beside `delivery`,
	 * and only where the status allows those actions (open or closed); null
	 * otherwise.
	 */
	directory: DirectoryFact[] | null;
	/**
	 * What the caller may do to the decision now (card 2697, Q14): each flag
	 * `TRANSITIONS` holding the stored status and `mayDo`, exactly as each
	 * write asks them, so the controls cannot offer what the server refuses.
	 * `withdrawAsks` and `deleteAsks`: whether that action asks for the
	 * caller's password, as the decision was ever opened (Q9, Q29).
	 */
	actions: LifecycleActions;
	/**
	 * What re-publishing the working copy would do to the options, by label
	 * (card 2697, decision 20): `changesOptions` where an option would be added
	 * or retired, which Tell them only refuses. Null where the caller may not
	 * re-publish now.
	 */
	republishSummary: RepublishSummary | null;
	/** Card 2679: whether the caller may read the results and rule from them (`results`: the decider and administrators). */
	mayReadResults: boolean;
	/** Card 2680 (decision 29): whether the caller may read the record view (`record`: the decider with board edit, and administrators), a draft's too. */
	mayReadRecord: boolean;
};

/** The lifecycle controls the editor offers (card 2697, Q14). */
export const LIFECYCLE_ACTIONS = [
	'open',
	'republish',
	'close',
	'extend',
	'withdraw',
	'delete',
	'dryRun',
	'resend',
	'participantAccount',
	'participantAddress'
] as const;

/** Each lifecycle control, and whether withdraw and delete ask for the password. */
export type LifecycleActions = Record<(typeof LIFECYCLE_ACTIONS)[number], boolean> & { withdrawAsks: boolean; deleteAsks: boolean };

/** What a re-publish would add and retire, by label (card 2697, decision 20). */
export type RepublishSummary = { changesOptions: boolean; adding: string[]; retiring: string[] };

/** `actions` for a caller of `access` (Q14): `TRANSITIONS` and `mayDo`, as each write asks them. */
function lifecycleActions(decision: Decision, access: DecisionAccess): LifecycleActions {
	const flags = Object.fromEntries(
		LIFECYCLE_ACTIONS.map((action) => [action, (TRANSITIONS[action] as readonly string[]).includes(decision.status) && mayDo(access, action, decision)])
	) as Record<(typeof LIFECYCLE_ACTIONS)[number], boolean>;
	const opened = decision.openedAt !== null;
	return { ...flags, withdrawAsks: opened, deleteAsks: opened };
}

/** `republishSummary`: `optionChanges` on the working copy, as `republishDecision` works it out. */
function republishSummaryOf(decision: Decision): RepublishSummary {
	const { adding, retiring } = optionChanges(liveOptionsOf(decision.id), listedOptionIds(decision.workingContent));
	return { changesOptions: adding.length + retiring.length > 0, adding: adding.map((option) => option.label), retiring: retiring.map((option) => option.label) };
}

/**
 * Every group, by name; and, with `members`, every active person, by name,
 * with their groups, and each group's active members. Without `members` no
 * person is read and the groups are names alone.
 */
function pickerOf(admin: boolean, members: boolean): { people: PickerPerson[]; groups: PickerGroup[] } {
	const groupRows = db.select({ id: peopleGroups.id, name: peopleGroups.name }).from(peopleGroups).orderBy(asc(peopleGroups.name)).all();
	if (!members) return { people: [], groups: groupRows.map((group) => ({ id: group.id, name: group.name })) };
	const persons = db
		.select({ id: people.id, fullName: people.fullName, jobTitle: people.jobTitle, email: people.email })
		.from(people)
		.where(eq(people.status, 'active'))
		.orderBy(asc(people.fullName), asc(people.id))
		.all();
	const active = new Set(persons.map((person) => person.id));
	const memberships = db
		.select({ groupId: peopleGroupMembers.groupId, personId: peopleGroupMembers.personId })
		.from(peopleGroupMembers)
		.all()
		.filter((membership) => active.has(membership.personId));
	const ids = (list: number[]) => list.sort((a, b) => a - b);
	return {
		people: persons.map((person) => {
			const shown = {
				id: person.id,
				fullName: person.fullName,
				jobTitle: person.jobTitle,
				groupIds: ids(memberships.filter((m) => m.personId === person.id).map((m) => m.groupId))
			};
			return admin ? { ...shown, email: person.email } : shown;
		}),
		groups: groupRows.map((group) => ({
			id: group.id,
			name: group.name,
			activeMemberIds: ids(memberships.filter((m) => m.groupId === group.id).map((m) => m.personId))
		}))
	};
}

/**
 * Everything the editor of a decision is handed (decisions 15 to 17), for a
 * caller who may edit it (`requireDecision(…, 'edit')`): 404 for one who
 * cannot view it, a board editor and a draft not theirs among them (decision
 * 16), and 403 for one who can view it and cannot edit it.
 *
 * The decision, its live options and every participant row, through the one
 * projection; the revision; the readability check, the refusals worked out
 * here; what the caller may do; and the picker's data. The people, groups and
 * decider candidates are left out wherever the status refuses `edit`, as
 * nothing can be saved there. The people and the groups' members are left out
 * also wherever the caller may not save the participants, the groups' names
 * kept for the audience select; and the candidates wherever the caller may
 * not change the decider: a decider who is not the author sees the decider
 * read-only (decision 17, C4). On an open decision the caller is not offered
 * as decider, as `setDecider` refuses it.
 */
export function readEditPage(user: SessionUser, decisionId: number): EditPage {
	const { decision, access } = requireDecision(user, decisionId, 'edit');
	const admin = isAdmin(user);
	const now = stamp();
	const participants = participantsOf(decision.id);

	const allows = (action: keyof typeof TRANSITIONS) => (TRANSITIONS[action] as readonly string[]).includes(decision.status);
	const editable = allows('edit');
	const canSetDecider = allows('setDecider') && mayDo(access, 'setDecider', decision);
	const canReview = allows('review') && mayDo(access, 'review', decision);
	const canSetParticipants = editable && (decision.status === 'draft' || mayDo(access, 'include', decision));

	const delivery = decision.openedAt !== null && mayDo(access, 'resend', decision) ? deliveryRows(decision, participants, now) : null;
	const actions = lifecycleActions(decision, access);

	const board = decision.boardId === null ? undefined : db.select().from(boards).where(eq(boards.id, decision.boardId)).get();
	const picker = editable ? pickerOf(admin, canSetParticipants) : { people: [], groups: [] };
	const deciderCandidates =
		canSetDecider && board ? editorsOf(board).filter((account) => decision.status === 'draft' || account.id !== user.id) : [];

	return {
		decision: decisionAnswer(decision, admin, now),
		options: optionAnswers(liveOptionsOf(decision.id)),
		participants: participantAnswers(participants, admin),
		revision: revisionOf(decision, allOptionsOf(decision.id), participants),
		readiness: readiness(decision, participants, now),
		editable,
		canSetDecider,
		canReview,
		canSetParticipants,
		productOwnerUserId: board?.productOwnerUserId ?? null,
		people: picker.people,
		groups: picker.groups,
		deciderCandidates,
		delivery,
		directory:
			delivery !== null && allows('participantAccount') && mayDo(access, 'participantAccount', decision) && mayDo(access, 'participantAddress', decision)
				? directoryFacts(decision, participants)
				: null,
		actions,
		republishSummary: actions.republish ? republishSummaryOf(decision) : null,
		mayReadResults: decision.status !== 'draft' && mayDo(access, 'results', decision),
		mayReadRecord: mayDo(access, 'record', decision)
	};
}

// ─── What an API key is given (card 2682, D9 to D11) ─────────────────────────

/** A decision as an API key is given it (card 2682, D9, D10): the shape a caller who is no administrator is given, its text marked as data. */
export type KeyDecisionAnswer = DecisionAnswer & { untrusted: true };

/** A participant as an API key is given it (card 2682, D9, D10): never an address, an account or who included or removed them. */
export type KeyParticipantAnswer = ParticipantAnswer & { untrusted: true };

/**
 * A decision as every API key is given it, an administrator's included (card
 * 2682, D9): `decisionAnswer(…, false)`, so no reviewer's account id and no
 * closing time once ruled, with `untrusted: true`, as its title, content and
 * reasons are people's and agents' words (D10).
 */
export function keyDecisionAnswer(decision: Decision, now: Stamp = stamp()): KeyDecisionAnswer {
	return { ...decisionAnswer(decision, false, now), untrusted: true };
}

/** What a v1 write on a decision answers (card 2682, code review F9): the OpenAPI document's `DecisionSaved`, the decision in the key's shape and the revision the next write must send. */
export type KeyDecisionSaved = { decision: KeyDecisionAnswer; revision: string };

/**
 * `DecisionSaved` for the five v1 routes that answer it (create, decider,
 * extend, withdraw, supersede: card 2682, code review F9), so that its shape
 * is written once. Called inside the route's `writeAs`, after the write.
 */
export function keyDecisionSaved(decision: Decision): KeyDecisionSaved {
	return { decision: keyDecisionAnswer(decision), revision: revisionFor(decision.id) };
}

/** Participant rows as every API key is given them (card 2682, D9, D10): `participantAnswers(…, false)`, each marked `untrusted`. */
export function keyParticipantAnswers(rows: DecisionParticipant[]): KeyParticipantAnswer[] {
	return participantAnswers(rows, false).map((participant) => ({ ...participant, untrusted: true as const }));
}

/**
 * What an API key may do to the decision now (card 2682, D11), by the rules
 * the writes ask of a key: the status (`TRANSITIONS`), `mayDo`, and, for the
 * participants, the decider, the withdrawal and the delete, a decision never
 * opened (D4, D5), and for Extend an open one (code review S2). Nothing a key
 * is refused is here: no open, re-publish, dry run, Resend, close or
 * administrator's action.
 */
export type KeyActions = {
	edit: boolean;
	setDecider: boolean;
	setParticipants: boolean;
	extend: boolean;
	withdraw: boolean;
	delete: boolean;
	supersede: boolean;
};

/** A person the key's picker offers (card 2682, D11): the page's picker fields, never an address, marked as data. */
export type KeyPickerPerson = { id: number; fullName: string; jobTitle: string; groupIds: number[]; untrusted: true };

/** A group the key's picker offers: its members only where the key may save the participants (`SOMETIMES_ABSENT`). */
export type KeyPickerGroup = { id: number; name: string; activeMemberIds?: number[]; untrusted: true };

/** An account the key may name as decider. */
export type KeyDeciderCandidate = DeciderCandidate & { untrusted: true };

/** The editors' read of a decision through an API key (card 2682, D11). */
export type KeyDecisionView = {
	decision: KeyDecisionAnswer;
	options: OptionAnswer[];
	participants: KeyParticipantAnswer[];
	revision: string;
	readiness: Readiness;
	actions: KeyActions;
	/** Empty unless `actions.setParticipants`. */
	people: KeyPickerPerson[];
	/** Every group by name where the decision can be edited; members only with `actions.setParticipants`. */
	groups: KeyPickerGroup[];
	/** Empty unless `actions.setDecider`. */
	deciderCandidates: KeyDeciderCandidate[];
	untrusted: true;
};

/**
 * The editors' read of a decision for `GET /api/v1/decisions/{decisionId}`
 * (card 2682, D11): for a caller who may edit it (`requireDecision(…,
 * 'edit')`: 404, then 403, as the edit page). The decision, its live options
 * and every participant row in the shape every key is given (D9), the
 * revision the next write must send (D28), the readability check, what a key
 * may do now, and the picker: the page's narrower picker fields, not
 * `keyPerson`'s, and never an address, an administrator's key included (the
 * picker is `pickerOf(false, …)`). No `delivery`, `directory` or
 * `republishSummary`: a key can send nothing and change no address. Every
 * object holding people's or agents' words is marked `untrusted` (D10).
 */
export function readDecisionForKey(user: SessionUser, decisionId: number, opts: { source: 'api' }): KeyDecisionView {
	const { decision, access } = requireDecision(user, decisionId, 'edit');
	const now = stamp();
	const participants = participantsOf(decision.id);

	const allows = (action: keyof typeof TRANSITIONS) => (TRANSITIONS[action] as readonly string[]).includes(decision.status);
	const neverOpened = decision.openedAt === null;
	const editable = allows('edit');
	const actions: KeyActions = {
		edit: editable && mayDo(access, 'edit', decision),
		setDecider: neverOpened && allows('setDecider') && mayDo(access, 'setDecider', decision),
		setParticipants: neverOpened && editable,
		// Code review S2: a key extends an open decision alone; reopening a closed one is the page's.
		extend: decision.status === 'open' && allows('extend') && mayDo(access, 'extend', decision),
		withdraw: neverOpened && allows('withdraw') && mayDo(access, 'withdraw', decision),
		delete: neverOpened && allows('delete') && mayDo(access, 'delete', decision),
		supersede: allows('supersede') && mayDo(access, 'supersede', decision)
	};

	const board = decision.boardId === null ? undefined : db.select().from(boards).where(eq(boards.id, decision.boardId)).get();
	const picker = editable ? pickerOf(false, actions.setParticipants) : { people: [], groups: [] };
	const candidates = actions.setDecider && board ? editorsOf(board) : [];

	return {
		decision: keyDecisionAnswer(decision, now),
		options: optionAnswers(liveOptionsOf(decision.id)),
		participants: keyParticipantAnswers(participants),
		revision: revisionOf(decision, allOptionsOf(decision.id), participants),
		readiness: readiness(decision, participants, now),
		actions,
		people: picker.people.map((person) => ({ id: person.id, fullName: person.fullName, jobTitle: person.jobTitle, groupIds: person.groupIds, untrusted: true as const })),
		groups: picker.groups.map((group) => ({
			id: group.id,
			name: group.name,
			...(group.activeMemberIds === undefined ? {} : { activeMemberIds: group.activeMemberIds }),
			untrusted: true as const
		})),
		deciderCandidates: candidates.map((account) => ({ id: account.id, username: account.username, emoji: account.emoji, untrusted: true as const })),
		untrusted: true
	};
}
