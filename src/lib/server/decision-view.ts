/**
 * decision-view.ts — what the participant page reads (card 2677, plan 4.4
 * and decisions 3, 6, 8, 15, 16 and 18 to 20).
 *
 * One page, two ways in. `/decisions/[id]` is read by `readDecisionPage`, for
 * a signed-in account that may view the decision; `/decision-link/[token]` by
 * `readLinkPage`, for the holder of a personal link, with no session. Both
 * give `DecisionPageData`, an allowlist written out field by field: the
 * decider by name, no account id, no participant's address or account, no
 * link hash, no group id, no reviewer's name, and no row id of the
 * participant or of a response. A link holder is given no board's name and
 * no decision id.
 *
 * The page reads the caller's own participant row and that row's own
 * responses, and nothing of anyone else's: no other participant, no other
 * response, no count and no total, whoever is asking (decision 15).
 *
 * Card 2697 adds the preview, `readPreview`, for `/decisions/[id]/preview`:
 * the working copy as a participant of the caller's choosing will see it,
 * built by the same `viewModelOf` and `groupsOf`, so that the preview cannot
 * differ from the participant page (Q4 to Q7).
 *
 * Plain reads that take the signed-in account, `user: SessionUser`, or a
 * token and a name, never `caller`, and write nothing, so that a page load may
 * call them (tests/check-at-the-write.test.ts, rule 4). `refuseWrongLink`
 * counts a wrong link in memory, by address, for the link's page and its two
 * routes alike (decision 8).
 */
import { error } from '@sveltejs/kit';
import { and, asc, eq } from 'drizzle-orm';
import { db } from './db';
import { decisionParticipants, decisionVersions, people, peopleGroupMembers, peopleGroups, type Decision, type DecisionParticipant } from './db/schema';
import type { SessionUser } from './auth';
import { mayDo } from './decision-access';
import { participantAnswers, versionContentAnswer, workingViewContent } from './decision-authoring';
import { listedOptionIds, liveOptionsOf, optionChanges, parseVersionContent, parseWorkingContent, participantsOf } from './decision-content';
import { participantForLink, reachOf } from './decision-links';
import { accountHistory, currentRound, lastToldOf, ownResponses } from './decision-record';
import { decisionStatus } from './decision-status';
import { createLogger } from './logger';
import { checkRateLimit } from './rate-limit';
import { readQueryId } from './request-body';
import { requireDecision } from './route-guards';
import type { DecisionPageData, ViewAudience, ViewContent, ViewDecision, ViewOption, ViewParticipant } from '$lib/decision-view-types';
import { stamp } from '$lib/timestamps';

const log = createLogger('DECISIONS');

/** How many wrong links an address may try in a window before it is refused (decision 8, S11). */
const WRONG_LINKS_PER_WINDOW = 20;
const WRONG_LINK_WINDOW_MS = 15 * 60 * 1000;

/**
 * The page of a decision for a signed-in account that may view it (decision
 * 20): 404 for one who may not, as `requireDecision` answers. A participant
 * whom `reachOf` still reaches through their account is given their part:
 * the banner's facts, their own responses and whether they may respond. Any
 * other caller who may view, a participant no longer reached among them
 * (D12), is given the published version and its status alone. A draft gives
 * nothing but whether the caller may edit it.
 */
export function readDecisionPage(user: SessionUser, decisionId: number): DecisionPageData {
	const { decision, access } = requireDecision(user, decisionId, 'view');
	let participant: DecisionParticipant | null = null;
	if (access.participantId !== null && decision.status !== 'draft') {
		const row = db.select().from(decisionParticipants).where(eq(decisionParticipants.id, access.participantId)).get();
		if (row !== undefined) {
			const person = row.personId === null ? null : (db.select().from(people).where(eq(people.id, row.personId)).get() ?? null);
			const reach = reachOf(row, person, accountHistory(decision.id).get(row.id) ?? false);
			if ('via' in reach && reach.via === 'account') participant = row;
		}
	}
	return pageOf(decision, participant, { via: 'session', mayEdit: mayDo(access, 'edit', decision), signedInAs: null });
}

/**
 * The page of a decision for the holder of a personal link, or null for any
 * link that opens none (decision 6): `participantForLink` decides, and its
 * refusals are not told apart. `signedInAs` is the name of the account a
 * browser is signed in as, or null: it is shown, never acted on (decision 9).
 */
export function readLinkPage(token: string, signedInAs: string | null): DecisionPageData | null {
	const found = participantForLink(token);
	if ('refused' in found || found.decision.status === 'draft') return null;
	return pageOf(found.decision, found.participant, { via: 'link', mayEdit: false, signedInAs });
}

/** Who the preview shows the decision to: one live participant, or a generic one of a role, in a group or none. */
export type Previewing =
	| { kind: 'participant'; participantId: number; name: string; role: 'consulted' | 'informed'; groupNames: string[] }
	| { kind: 'generic'; role: 'consulted' | 'informed'; groupId: number | null; groupName: string | null };

/**
 * What the preview's load gives (card 2697, decision 18, Q4 to Q7): the
 * working copy as `DecisionView` draws it, who it is shown as, and what the
 * "Preview as" bar offers. No address and no account of anyone, to an
 * administrator too (Q5), no response, question, version or event, and no
 * group id but the groups the bar offers by name.
 */
export type PreviewData = {
	decision: ViewDecision & { id: number; boardId: number | null; boardName: string | null };
	content: ViewContent;
	options: ViewOption[];
	audiences: ViewAudience[];
	participant: ViewParticipant;
	previewing: Previewing;
	/** The live participants, by name, role and the group names their row was given, through the one projection. */
	participants: { id: number; name: string; role: string; groups: string[] }[];
	/** Every group by name, for a generic participant. */
	groups: { id: number; name: string }[];
};

/** The roles a generic participant may be previewed as. */
const PREVIEW_ROLES = ['consulted', 'informed'] as const;

/**
 * The preview of a decision as a participant (card 2697, decision 18, Q4 to
 * Q7), for a caller who may edit it: `requireDecision(…, 'edit')`, so 404 for
 * one who cannot view it (a board editor and a draft not theirs among them)
 * and 403 for one who can view it and cannot edit it. It reads the working
 * copy, never a version, and writes nothing: no event, no link, no seen.
 *
 * `query` is the page's: `as=<participantId>`, a live participant of this
 * decision (any other, or a removed one, 404), shown with their role and the
 * groups their person is in now, as the participant page reads them; or
 * `role=consulted|informed` (else 400) with `group=<id>`, a group (else 400),
 * a generic participant with that group's audience first; or none of them, a
 * generic consulted participant, every audience open. `as` with `role` or
 * `group` is 400: the preview shows one participant.
 *
 * The options are the next version's (Q6): the live options in position
 * order, less those publishing would retire, each with its label.
 */
export function readPreview(user: SessionUser, decisionId: number, query: URLSearchParams): PreviewData {
	const { decision } = requireDecision(user, decisionId, 'edit');
	const rows = participantsOf(decision.id);
	const live = rows.filter((row) => row.removedAt === null);

	const asId = readQueryId(query.get('as'), 'participant');
	const sentRole = query.get('role');
	const groupId = readQueryId(query.get('group'), 'group') ?? null;
	if (asId !== undefined && (sentRole !== null || groupId !== null)) error(400, 'as cannot be sent with role or group: a preview shows one participant');

	const groupRows = db.select({ id: peopleGroups.id, name: peopleGroups.name }).from(peopleGroups).orderBy(asc(peopleGroups.name), asc(peopleGroups.id)).all();
	const nameOf = new Map(groupRows.map((group) => [group.id, group.name]));

	let previewing: Previewing;
	let ownGroupIds: Set<number>;
	if (asId !== undefined) {
		const row = live.find((candidate) => candidate.id === asId);
		if (row === undefined) error(404, 'Participant not found');
		ownGroupIds = groupsOf(row.personId);
		const role = row.role === 'informed' ? 'informed' : 'consulted';
		const groupNames = groupRows.filter((group) => ownGroupIds.has(group.id)).map((group) => group.name);
		previewing = { kind: 'participant', participantId: row.id, name: row.name, role, groupNames };
	} else {
		if (sentRole !== null && !(PREVIEW_ROLES as readonly string[]).includes(sentRole)) error(400, 'role must be "consulted" or "informed"');
		if (groupId !== null && !nameOf.has(groupId)) error(400, `group ${groupId} is not a group`);
		ownGroupIds = groupId === null ? new Set() : new Set([groupId]);
		const role = sentRole === 'informed' ? 'informed' : 'consulted';
		previewing = { kind: 'generic', role, groupId, groupName: groupId === null ? null : nameOf.get(groupId)! };
	}

	const content = parseWorkingContent(decision.workingContent);
	const liveOptions = liveOptionsOf(decision.id);
	const retiring = new Set(optionChanges(liveOptions, listedOptionIds(decision.workingContent)).retiring.map((option) => option.id));
	const model = viewModelOf(
		content,
		liveOptions.filter((option) => !retiring.has(option.id)).map((option) => ({ optionId: option.id, label: option.label })),
		ownGroupIds
	);
	const shownStatus = decisionStatus(decision, stamp());

	return {
		decision: {
			id: decision.id,
			boardId: decision.boardId,
			boardName: decision.boardName,
			title: decision.title,
			// A draft is previewed as its participants will first see it: open.
			shownStatus: shownStatus === 'draft' ? 'open' : shownStatus,
			voteMode: decision.voteMode === 'score' ? 'score' : 'single',
			closesAt: decision.closesAt,
			deciderName: decision.deciderName
		},
		content: workingViewContent(content),
		options: model.options,
		audiences: model.audiences,
		participant: { role: previewing.role },
		previewing,
		participants: participantAnswers(live, false).map((row) => ({ id: row.id, name: row.name, role: row.role, groups: row.groups })),
		groups: groupRows
	};
}

/**
 * A version's options and audiences as the view shows them (decisions 16, 18
 * and 21), from a version's content or the working content alike, so that a
 * preview builds them the same way. `options` are the options to show, in
 * order, each with its label; their text is read from `content`, tolerantly.
 * Each audience whose group is one of `ownGroupIds` comes first, open, in its
 * stored order, and the rest follow, closed; with none of them the caller's,
 * every audience is open. No group id is given.
 */
export function viewModelOf(
	content: { options: unknown[]; audiences: unknown[]; agentDrafted?: Record<string, true> },
	options: { optionId: number; label: string }[],
	ownGroupIds: ReadonlySet<number>
): { options: ViewOption[]; audiences: ViewAudience[] } {
	const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
	const text = (value: unknown) => (typeof value === 'string' ? value : '');
	const texts = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
	const flags = content.agentDrafted ?? {};
	const written = content.options.filter(isRecord);

	const shownOptions = options.map((option): ViewOption => {
		const entry = written.find((candidate) => candidate.optionId === option.optionId) ?? {};
		return {
			optionId: option.optionId,
			label: option.label,
			title: text(entry.title),
			summary: text(entry.summary),
			pros: texts(entry.pros),
			cons: texts(entry.cons),
			commercial: text(entry.commercial),
			agentDrafted: Object.hasOwn(flags, `options.${option.optionId}`)
		};
	});

	const audiences = content.audiences.filter(isRecord).map((entry) => {
		const groupId = typeof entry.groupId === 'number' ? entry.groupId : null;
		return { heading: text(entry.heading), body: text(entry.body), own: groupId !== null && ownGroupIds.has(groupId) };
	});
	const anyOwn = audiences.some((audience) => audience.own);
	const inOrder = [...audiences.filter((audience) => audience.own), ...audiences.filter((audience) => !audience.own)];
	return {
		options: shownOptions,
		audiences: inOrder.map((audience) => ({ heading: audience.heading, body: audience.body, own: audience.own, open: !anyOwn || audience.own }))
	};
}

/**
 * Count a link that opened no decision against `address` (decision 8, S11),
 * for the link's page and its two routes alike, and say whether the address
 * is over its limit: 20 in 15 minutes, in a fixed window. Only a wrong link
 * is counted, so a link that works is never refused, whatever the address has
 * tried. One WARN line the first time an address is over in a window, naming
 * its key and no token. In memory: it reads no row and writes none.
 */
export function refuseWrongLink(address: string): { limited: boolean; retryAfterSecs: number } {
	const key = `decision-link:${address}`;
	const { limited, retryAfterSecs, attempts } = checkRateLimit(key, WRONG_LINKS_PER_WINDOW, WRONG_LINK_WINDOW_MS);
	if (limited && attempts === WRONG_LINKS_PER_WINDOW + 1) {
		log.warn(`More than ${WRONG_LINKS_PER_WINDOW} personal links that open no decision were tried from ${key}: refused for ${retryAfterSecs} seconds`, { key });
	}
	return { limited, retryAfterSecs };
}

// ─── Inside the reads ────────────────────────────────────────────────────────

/**
 * Which acknowledgement the page's seen post records at this stored status
 * (decision 14), or null for none. A ruled or superseded decision posts none:
 * this page shows no ruling, and card 2679 adds the `ruling` stage when it
 * shows one (code review C8).
 */
function stageOf(status: string): DecisionPageData['stage'] {
	if (status === 'ruled' || status === 'superseded') return null;
	if (status === 'withdrawn') return 'withdrawal';
	return 'question';
}

/** The ids of the groups the person is a member of now, of the groups that are still there (decision 18). */
function groupsOf(personId: number | null): Set<number> {
	if (personId === null) return new Set();
	const rows = db
		.select({ groupId: peopleGroupMembers.groupId })
		.from(peopleGroupMembers)
		.innerJoin(peopleGroups, eq(peopleGroups.id, peopleGroupMembers.groupId))
		.where(eq(peopleGroupMembers.personId, personId))
		.all();
	return new Set(rows.map((row) => row.groupId));
}

/** The page itself, for either way in, for `participant` (already found reachable) or none. */
function pageOf(
	decision: Decision,
	participant: DecisionParticipant | null,
	how: { via: 'session' | 'link'; mayEdit: boolean; signedInAs: string | null }
): DecisionPageData {
	const shownStatus = decisionStatus(decision, stamp());
	const page: DecisionPageData = {
		via: how.via,
		decision: {
			// A link holder is not given the decision's id (code review C5): the page needs none, and its writes go by the token.
			...(how.via === 'link' ? {} : { id: decision.id }),
			title: decision.title,
			shownStatus,
			voteMode: decision.voteMode === 'score' ? 'score' : 'single',
			closesAt: decision.closesAt,
			deciderName: decision.deciderName,
			// A link holder may have no account and no tie to the board (R3).
			boardName: how.via === 'link' ? null : decision.boardName,
			withdrawnAt: decision.withdrawnAt,
			withdrawnReason: decision.withdrawnReason
		},
		draft: decision.status === 'draft',
		version: null,
		options: [],
		audiences: [],
		participant: null,
		ownResponse: null,
		earlierResponse: null,
		mayRespond: false,
		stage: stageOf(decision.status),
		mayEdit: how.mayEdit,
		signedInAs: how.signedInAs
	};
	if (page.draft) return page;

	const version = db
		.select()
		.from(decisionVersions)
		.where(and(eq(decisionVersions.decisionId, decision.id), eq(decisionVersions.number, decision.currentVersion)))
		.get();
	if (version === undefined) return page;
	const content = parseVersionContent(version.content);
	const model = viewModelOf(
		content,
		content.options.map((option) => ({ optionId: option.optionId, label: option.label })),
		participant === null ? new Set() : groupsOf(participant.personId)
	);
	page.version = { number: version.number, publishedAt: version.publishedAt, content: versionContentAnswer(content, how.via) };
	page.options = model.options;
	page.audiences = model.audiences;
	if (participant === null) return page;

	const role = participant.role === 'informed' ? 'informed' : 'consulted';
	const own = ownResponses(participant.id, currentRound(decision.id));
	page.participant = { role, includedAt: participant.includedAt, told: lastToldOf(participant.id) };
	page.ownResponse = own.current;
	page.earlierResponse = own.earlier;
	page.mayRespond = role === 'consulted' && shownStatus === 'open';
	return page;
}
