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
 * response, no count and no total, whoever is asking (decision 15), until the
 * decider releases the results of a ruled decision (card 2679).
 *
 * Card 2679 adds the ruling, to everyone who may view a ruled decision, with
 * no moment, no "against" and no "early"; the released totals and comments,
 * without names, as `releasedOf` projects them; a participant's own concerns
 * and whether they may raise one; the decisions it supersedes and that
 * superseded it, each named only to a viewer who may view it; and, signed in,
 * whether the caller may read the results and supersede it. The seen stage is
 * `ruling` on a ruled decision, given to a participant alone, and once the
 * decision is ruled its closing time is given to nobody (decision 26).
 *
 * Card 2678 adds the decision's clarification questions, through the one
 * projection `questionsFor` (decision-questions.ts): every question to a
 * participant, the author, the decider and administrators, the asker named
 * only to the last three, an agent's unpublished draft only to them, and a
 * question's id only to one who may answer it now; whether the participant
 * may ask (`mayAsk`) and, signed in, whether the caller may answer
 * (`mayAnswer`). The reach test is `reachedParticipantOf`'s, which the
 * questions read asks too.
 *
 * Card 2680 adds, signed in, whether the caller may read the record
 * (`mayReadRecord`), the linked cards on boards the caller can open
 * (`linkedCards`, never by a personal link), whether they may link one
 * (`mayLinkCards`) and unlink one (`mayUnlinkCards`), and gives the board's current name to a viewer who can
 * open the board, the name it had when the decision was made to everyone
 * else (decision 33).
 *
 * Card 2736 adds, for a participant, whether their own seen of the current
 * version at the page's stage is already recorded (`seenRecorded`), by the
 * test `seenAs` makes (`seenStands`, card 2741: false where a question seen
 * exists but the write would record a new one): nobody else's, with no
 * moment or way in.
 *
 * Card 2697 adds the preview, `readPreview`, for `/decisions/[id]/preview`:
 * the working copy as a participant of the caller's choosing will see it,
 * built by the same `viewModelOf` and `groupsOf`, so that the preview cannot
 * differ from the participant page (Q4 to Q7).
 *
 * Card 2683 adds the survey questions, built by `viewModelOf` beside the
 * options: the current version's to everyone it gives the version to, a
 * consulted and an informed participant alike, each with its agent flag; and
 * in the preview the working copy's live questions, as the next version would
 * hold them. Neither gives anyone's answer but the participant's own
 * response, which already holds theirs; the preview gives none. A ruling on
 * a version that put no options says so (`noOptions`, R18).
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
import { boards, decisionVersions, decisions, peopleGroupMembers, peopleGroups, type Decision, type DecisionParticipant } from './db/schema';
import type { SessionUser } from './auth';
import { canViewBoard } from './board-access';
import { linkCountOf, linkedCardsFor, LINKS_PER_DECISION } from './decision-cards';
import { mayDo, type DecisionAccess } from './decision-access';
import { namedFor } from './decision-naming';
import { participantAnswers, versionContentAnswer, workingViewContent } from './decision-authoring';
import { listedOptionIds, liveOptionsOf, liveSurveyOf, optionChanges, parseVersionContent, parseWorkingContent, participantsOf, surveyKey } from './decision-content';
import { participantForLink } from './decision-links';
import { mayAnswerOf, mayAskOf, questionsFor, reachedParticipantOf } from './decision-questions';
import { concernsOf, currentRound, lastToldOf, ownResponses, rulingOf, seenStands, supersedingOf } from './decision-record';
import { releasedOf, versionOptionsOf } from './decision-results';
import { decisionStatus, linkUsable, TRANSITIONS } from './decision-status';
import { createLogger } from './logger';
import { checkRateLimit } from './rate-limit';
import { readQueryId } from './request-body';
import { requireDecision } from './route-guards';
import type { SurveyQuestion } from '$lib/decision-readiness';
import type { DecisionPageData, ViewAudience, ViewContent, ViewDecision, ViewOption, ViewParticipant, ViewSurveyQuestion } from '$lib/decision-view-types';
import { CONCERNS_PER_PARTICIPANT } from '$lib/decision-rules';
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
 *
 * Card 2679: `mayReadResults`, the caller's `results`, on a decision that is
 * not a draft; and `maySupersede`, exactly where `supersedeDecision` would
 * make the draft: a ruled decision whose board is there, with no superseding
 * decision that is not withdrawn, for a caller `supersede` lets in.
 */
export function readDecisionPage(user: SessionUser, decisionId: number): DecisionPageData {
	const { decision, access } = requireDecision(user, decisionId, 'view');
	// Card 2678 (F2): the reach test the questions read asks too, from one place.
	const participant = decision.status === 'draft' ? null : reachedParticipantOf(decision, access.participantId);
	const page = pageOf(decision, participant, { via: 'session', mayEdit: mayDo(access, 'edit', decision), signedInAs: null, user, access });
	// Card 2678 (decision 15, F9): the answer form where the caller may answer now, as the write asks.
	page.mayAnswer = mayAnswerOf(decision, access);
	const opened = decision.status !== 'draft';
	page.mayReadResults = opened && mayDo(access, 'results', decision);
	page.maySupersede =
		(TRANSITIONS.supersede as readonly string[]).includes(decision.status) &&
		mayDo(access, 'supersede', decision) &&
		decision.boardId !== null &&
		supersedingOf(decision.id) === null;
	// Card 2680 (decision 29): the Record link, where the record view would let the caller in; a draft's too.
	page.mayReadRecord = mayDo(access, 'record', decision);
	// Card 2680 (decisions 17 and 18): the linked cards on boards the caller can open, and whether they may link one now, as
	// `linkCard` asks, below the cap. A draft is never linked: none, and no Link.
	page.linkedCards = opened ? linkedCardsFor(user, decision) : [];
	page.mayLinkCards =
		(TRANSITIONS.linkCard as readonly string[]).includes(decision.status) && mayDo(access, 'linkCard', decision) && linkCountOf(decision.id) < LINKS_PER_DECISION;
	// Slice 3b: whether they may unlink one, as `unlinkCard` asks: at the cap and on a withdrawn decision too, where Link is not offered.
	page.mayUnlinkCards = (TRANSITIONS.unlinkCard as readonly string[]).includes(decision.status) && mayDo(access, 'unlinkCard', decision);
	return page;
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
	return pageOf(found.decision, found.participant, { via: 'link', mayEdit: false, signedInAs, user: null, access: null });
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
	/** Card 2683: the working copy's live survey questions, as the next version would hold them. No answer. */
	surveyQuestions: ViewSurveyQuestion[];
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
 * order, less those publishing would retire, each with its label. Card 2683:
 * so are the survey questions, those the working copy lists whose rows are
 * not retired (`liveSurveyOf`), in its order.
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
		{ ...content, surveyQuestions: liveSurveyOf(decision) },
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
		surveyQuestions: model.surveyQuestions,
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
 *
 * Card 2683: and `content`'s survey questions, each with its id (one with
 * none is left out), field by field, `choices` and `scale` where its kind
 * holds them, and whether its `survey.<id>` flag stands.
 */
export function viewModelOf(
	content: { options: unknown[]; audiences: unknown[]; agentDrafted?: Record<string, true>; surveyQuestions?: SurveyQuestion[] },
	options: { optionId: number; label: string }[],
	ownGroupIds: ReadonlySet<number>
): { options: ViewOption[]; surveyQuestions: ViewSurveyQuestion[]; audiences: ViewAudience[] } {
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
	const surveyQuestions = (content.surveyQuestions ?? []).flatMap((question): ViewSurveyQuestion[] =>
		question.questionId === undefined
			? []
			: [
					{
						questionId: question.questionId,
						kind: question.kind,
						prompt: question.prompt,
						help: question.help,
						required: question.required,
						...(question.choices === undefined ? {} : { choices: [...question.choices] }),
						...(question.scale === undefined ? {} : { scale: { max: question.scale.max, lowLabel: question.scale.lowLabel, highLabel: question.scale.highLabel } }),
						agentDrafted: Object.hasOwn(flags, surveyKey(question.questionId))
					}
				]
	);
	return {
		options: shownOptions,
		surveyQuestions,
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
 * Which acknowledgement a participant's page's seen post records at this
 * stored status (decision 14): the ruling on a ruled or superseded decision,
 * which the page shows (card 2679, decision 9), the withdrawal on a withdrawn
 * one, and the question otherwise.
 */
function stageOf(status: string): NonNullable<DecisionPageData['stage']> {
	if (status === 'ruled' || status === 'superseded') return 'ruling';
	if (status === 'withdrawn') return 'withdrawal';
	return 'question';
}

/** Whether the decision has been ruled on: stored `ruled` or `superseded`. */
const isRuled = (decision: Pick<Decision, 'status'>) => decision.status === 'ruled' || decision.status === 'superseded';

/** The ruling as every viewer of a ruled decision is given it (card 2679, decision 23): no moment, no "against", no "early". */
function rulingViewOf(decision: Decision): DecisionPageData['ruling'] {
	if (!isRuled(decision)) return null;
	const ruling = rulingOf(decision.id);
	if (ruling === null) return null;
	const option = ruling.optionId === null ? undefined : versionOptionsOf(decision.id, ruling.versionNumber).find((candidate) => candidate.optionId === ruling.optionId);
	return {
		label: option?.label ?? null,
		title: option?.title ?? null,
		noneOfThese: ruling.optionId === null,
		reason: ruling.reason,
		conditions: ruling.conditions,
		ruledByName: ruling.ruledByName,
		// Card 2683 (R18): the version ruled on put no options to a vote, said in place of "None of these".
		...(versionOptionsOf(decision.id, ruling.versionNumber).length === 0 ? { noOptions: true as const } : {})
	};
}

/**
 * The decision `other` as the page's viewer may be told of it (card 2679,
 * decision 5, S8): nothing to a link holder, who has no session, and
 * otherwise `namedFor`'s rule (decision-naming.ts), which the record view's
 * `recordEntryOf` asks too (card 2680 code review, S1 and F3). Private: this
 * module exports no function handed `SessionUser | null`.
 */
function namedForViewer(user: SessionUser | null, other: Decision): { id?: number; title?: string } {
	return user === null ? {} : namedFor(user, other);
}

/**
 * The supersede links of the page (card 2679, decision 5, S8), each only once
 * the later decision is ruled: while it is a draft, open or closed, neither
 * page says anything of the other, to anyone.
 */
function supersedeLinksOf(decision: Decision, user: SessionUser | null): Pick<DecisionPageData, 'supersedes' | 'laterDecision'> {
	let supersedes: DecisionPageData['supersedes'] = null;
	if (decision.supersedesId !== null && isRuled(decision)) {
		const earlier = db.select().from(decisions).where(eq(decisions.id, decision.supersedesId)).get();
		if (earlier !== undefined) supersedes = namedForViewer(user, earlier);
	}
	let laterDecision: DecisionPageData['laterDecision'] = null;
	const later = supersedingOf(decision.id);
	if (later !== null && isRuled(later)) laterDecision = { superseded: decision.status === 'superseded', ...namedForViewer(user, later) };
	return { supersedes, laterDecision };
}

/**
 * The board's name as a signed-in viewer is told it (card 2680, decision 33,
 * F3): its current name to one who can open the board now, and the name it
 * had when the decision was made to everyone else, so that a renamed board's
 * new name reaches nobody who cannot open it. The register's rule.
 */
function boardNameFor(decision: Decision, user: SessionUser | null): string {
	if (user === null || decision.boardId === null || !canViewBoard(user, decision.boardId)) return decision.boardName;
	return db.select({ name: boards.name }).from(boards).where(eq(boards.id, decision.boardId)).get()?.name ?? decision.boardName;
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

/**
 * The page itself, for either way in, for `participant` (already found
 * reachable) or none. `user` is the signed-in caller, null by a personal link:
 * it decides only whether another decision is named to them (card 2679).
 * `access` is the signed-in caller's, null by a personal link: with the
 * participant, it decides which questions they are given and how (card 2678,
 * decision 2), always as the page gives them (`source: 'ui'`).
 */
function pageOf(
	decision: Decision,
	participant: DecisionParticipant | null,
	how: { via: 'session' | 'link'; mayEdit: boolean; signedInAs: string | null; user: SessionUser | null; access: DecisionAccess | null }
): DecisionPageData {
	const now = stamp();
	const shownStatus = decisionStatus(decision, now);
	const page: DecisionPageData = {
		via: how.via,
		decision: {
			// A link holder is not given the decision's id (code review C5): the page needs none, and its writes go by the token.
			...(how.via === 'link' ? {} : { id: decision.id }),
			title: decision.title,
			shownStatus,
			voteMode: decision.voteMode === 'score' ? 'score' : 'single',
			// Card 2679 (decision 26): once ruled, the closing time beside the ruling's arrival would say whether it was early.
			closesAt: isRuled(decision) ? null : decision.closesAt,
			deciderName: decision.deciderName,
			// A link holder may have no account and no tie to the board (R3).
			boardName: how.via === 'link' ? null : boardNameFor(decision, how.user),
			withdrawnAt: decision.withdrawnAt,
			withdrawnReason: decision.withdrawnReason
		},
		draft: decision.status === 'draft',
		version: null,
		options: [],
		surveyQuestions: [],
		audiences: [],
		participant: null,
		ownResponse: null,
		earlierResponse: null,
		mayRespond: false,
		// Card 2679 (F7): a participant's alone, given below.
		stage: null,
		// Card 2736: a participant's alone, given below.
		seenRecorded: false,
		mayEdit: how.mayEdit,
		signedInAs: how.signedInAs,
		ruling: null,
		released: null,
		concerns: [],
		mayRaiseConcern: false,
		supersedes: null,
		laterDecision: null,
		// Card 2678: given below, but on a draft, which takes no question.
		questions: [],
		mayAsk: false
	};
	if (page.draft) return page;
	page.ruling = rulingViewOf(decision);
	page.released = releasedOf(decision);
	Object.assign(page, supersedeLinksOf(decision, how.user));
	// Card 2678 (decisions 2 and 15): every question the viewer reads, as the page gives them, and whether they may ask now.
	page.questions = questionsFor(decision, { access: how.access, participantId: participant?.id ?? null, source: 'ui' });
	page.mayAsk = mayAskOf(decision, participant, now);

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
	page.surveyQuestions = model.surveyQuestions;
	page.audiences = model.audiences;
	if (participant === null) return page;

	const role = participant.role === 'informed' ? 'informed' : 'consulted';
	const own = ownResponses(participant.id, currentRound(decision.id));
	page.participant = { role, includedAt: participant.includedAt, told: lastToldOf(participant) };
	page.ownResponse = own.current;
	page.earlierResponse = own.earlier;
	page.mayRespond = role === 'consulted' && shownStatus === 'open';
	const stage = stageOf(decision.status);
	page.stage = stage;
	// Card 2736: whether their seen of this version at this stage stands, by the test `seenAs` makes (`seenStands`, card
	// 2741), so that the signed-in note claims no seen the write would not record, and the page posts one the write would.
	// Their own row's fact alone.
	page.seenRecorded = seenStands(decision, participant, version.number, stage, now);
	// Card 2679 (decision 4): their own concerns, and the window, which is a personal link's own life after the ruling.
	page.concerns = concernsOf({ participantId: participant.id }).map((row) => ({ comment: row.comment ?? '', createdAt: row.createdAt }));
	// Code review F9: no form past the fifth, as the write refuses a sixth.
	page.mayRaiseConcern = decision.status === 'ruled' && linkUsable(decision, now) && page.concerns.length < CONCERNS_PER_PARTICIPANT;
	return page;
}
