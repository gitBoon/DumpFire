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
 */
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
	liveOptionsOf,
	openFactsOf,
	parseWorkingContent,
	participantsOf,
	revisionOf,
	type WorkingContent
} from './decision-content';
import { peopleById } from './decision-record';
import { decisionStatus, TRANSITIONS, type ShownStatus } from './decision-status';
import { requireBoard, requireDecision } from './route-guards';
import { checkContent, refusalsOf, type ContentAnswer, type Refusal, type Warning } from '$lib/decision-readiness';
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
};

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

/** A decision as every answer gives it (decision 15), to an administrator (`admin`) with each reviewer's account id besides. */
export function decisionAnswer(decision: Decision, admin: boolean, now: Stamp = stamp()): DecisionAnswer {
	return {
		id: decision.id,
		boardId: decision.boardId,
		boardName: decision.boardName,
		title: decision.title,
		status: decision.status,
		shownStatus: decisionStatus(decision, now),
		voteMode: decision.voteMode,
		closesAt: decision.closesAt,
		currentVersion: decision.currentVersion,
		authorName: decision.authorName,
		deciderUserId: decision.deciderUserId,
		deciderName: decision.deciderName,
		content: contentAnswer(parseWorkingContent(decision.workingContent), admin),
		createdAt: decision.createdAt,
		updatedAt: decision.updatedAt,
		openedAt: decision.openedAt,
		closedAt: decision.closedAt,
		withdrawnAt: decision.withdrawnAt,
		withdrawnReason: decision.withdrawnReason
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
	return {
		// What stops opening asks of a draft alone: nothing else is opened.
		refusals: decision.status === 'draft' ? refusalsOf(openFactsOf(decision, now)) : [],
		warnings: checkContent(content, audienceFactsOf(content, participants))
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
			closesAt: row.closesAt,
			updatedAt: row.updatedAt,
			mayEdit: mayDo(access, 'edit', row)
		});
	}
	return { board: { id: board.id, name: board.name }, canCreate: canEditBoard, decisions: listed };
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
};

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
		deciderCandidates
	};
}
