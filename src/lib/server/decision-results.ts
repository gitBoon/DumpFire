/**
 * decision-results.ts — a decision's results, and what a release of them
 * shows (card 2679, decisions 1, 8, 10, 11, 13, 16 and 27).
 *
 * The results, with every response by name, are the decider's and
 * administrators' alone (`readResults`, behind `requireDecision(…,
 * 'results')`): the current round's tally, earlier rounds apart, who has not
 * responded, the removed, the open questions, the concerns and the ruling
 * with its "against", "early" and cut-off names. A release shows everyone who
 * may view the decision the totals and comments without names
 * (`releasedOf`), and the decider sees exactly that first (`previewOf`, with a
 * key for each comment they may leave out).
 *
 * What a release shows is frozen at it: the ruling round alone, the latest
 * response of each live consulted participant up to the highest response id
 * the release recorded (`upToResponseId`), never a concern, and no figure per
 * group, ever: `releaseRowsOf` hands the projection rows with no group in
 * them (S4, S9). A figure that could single someone out is withheld, and the
 * number who responded with it; a mean whose scores, counted as cells, would
 * have one withheld (code review S2); and, beside another release in the
 * supersede chain, the number who responded always and never one cell alone
 * (code review S4). A release is refused under three responses,
 * while any of them was given under the who-sees statement that promised no
 * totals (decision 25), and when another release in the supersede chain was
 * made from almost the same people (decision 27).
 *
 * A plain read module, not a service: it takes the signed-in account,
 * `user: SessionUser`, never `caller`, and writes nothing, so that a page load
 * may call it (tests/check-at-the-write.test.ts, rule 4). The service in
 * decisions.ts asks its refusals (`rulingRefusals`, `releaseRefusals`) inside
 * its writes; card 2684 adds to `rulingRefusals`.
 */
import { createHmac } from 'node:crypto';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from './db';
import { decisionQuestions, decisionVersions, decisions, type Decision, type DecisionParticipant, type DecisionResponse } from './db/schema';
import type { SessionUser } from './auth';
import { mayDo } from './decision-access';
import { allOptionsOf, parseVersionContent, participantsOf, resultsRevisionOf } from './decision-content';
import { concernsOf, currentRound, eventsOfKind, ownResponseOf, responsesOf, revisionResponseIdsOf, rulingOf, statementsOf } from './decision-record';
import { decisionStatus, TRANSITIONS } from './decision-status';
import { purposeKey } from './request-tokens';
import { requireDecision } from './route-guards';
import { mostChosenOf } from '$lib/decision-rules';
import { STALE_REVISION, WHO_SEES_STATEMENT_VERSION } from '$lib/decision-words';
import type {
	PreviewComment,
	ReleasedFigure,
	ReleasedResults,
	ReleasePreview,
	ResultRow,
	ResultsData,
	RoundTally,
	RulingRecord
} from '$lib/decision-view-types';
import { stamp } from '$lib/timestamps';

/** The fewest live consulted participants who must have responded in the ruling round for a release (decision 10): D9's smallest group. */
export const RELEASE_MIN_RESPONSES = 3;

type VoteMode = 'single' | 'score';

/** A decision's vote mode, read as one of the two. */
const voteModeOf = (decision: Pick<Decision, 'voteMode'>): VoteMode => (decision.voteMode === 'score' ? 'score' : 'single');

/** A mean to one decimal. */
const oneDecimal = (value: number) => Math.round(value * 10) / 10;

// ─── Tallies (decisions 11 and 16) ───────────────────────────────────────────

/** What a tally counts of a response. */
type Counted = { kind: string; optionId: number | null; scores: Record<string, number> | null };

/**
 * The tally of `rows` over the options `optionIds`: how many responded, voted,
 * abstained and had no concerns, and each option's votes in single mode, or
 * its total score and mean in score mode (the other list empty).
 */
export function tallyOf(rows: readonly Counted[], optionIds: readonly number[], voteMode: VoteMode): Omit<RoundTally, 'round' | 'rows'> {
	const votes = rows.filter((row) => row.kind === 'vote');
	return {
		responded: rows.length,
		voted: votes.length,
		votes: voteMode === 'single' ? optionIds.map((optionId) => ({ optionId, count: votes.filter((vote) => vote.optionId === optionId).length })) : [],
		scores:
			voteMode === 'score'
				? optionIds.map((optionId) => {
						const given = votes.map((vote) => vote.scores?.[`${optionId}`]).filter((score): score is number => typeof score === 'number');
						const total = given.reduce((sum, score) => sum + score, 0);
						return { optionId, total, mean: given.length === 0 ? null : oneDecimal(total / given.length) };
					})
				: [],
		abstained: rows.filter((row) => row.kind === 'abstain').length,
		noConcerns: rows.filter((row) => row.kind === 'no_concerns').length
	};
}

// "Most chosen" and "against" (decision 11) are `$lib/decision-rules.ts`'s, which the ruling form shares (code review F8).

/** The options of version `number` of the decision, by id, label and title, as the version holds them; none for a version not there. */
export function versionOptionsOf(decisionId: number, number: number): { optionId: number; label: string; title: string }[] {
	const version = db
		.select({ content: decisionVersions.content })
		.from(decisionVersions)
		.where(and(eq(decisionVersions.decisionId, decisionId), eq(decisionVersions.number, number)))
		.get();
	if (version === undefined) return [];
	return parseVersionContent(version.content).options.map((option) => ({ optionId: option.optionId, label: option.label, title: option.title }));
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

/** A response as the results give it, with how many earlier rows its participant gave in the round. No response id. */
function resultRowOf(participant: DecisionParticipant, row: DecisionResponse, changes: number): ResultRow {
	const own = ownResponseOf(row);
	return {
		participantId: participant.id,
		name: participant.name,
		role: participant.role,
		groups: groupNamesOf(participant.groups),
		kind: own.kind,
		optionId: own.optionId,
		scores: own.scores,
		comment: own.comment,
		optionComments: own.optionComments,
		versionNumber: own.versionNumber,
		createdAt: own.createdAt,
		via: row.via,
		changes
	};
}

/** Each participant's latest response in `round`, by participant id, with how many they gave there before it. `responses` in id order. */
function latestInRound(responses: readonly DecisionResponse[], round: number): Map<number, { row: DecisionResponse; changes: number }> {
	const latest = new Map<number, { row: DecisionResponse; changes: number }>();
	for (const row of responses) {
		if (row.round !== round) continue;
		const before = latest.get(row.participantId);
		latest.set(row.participantId, { row, changes: before === undefined ? 0 : before.changes + 1 });
	}
	return latest;
}

/** The live consulted participants: whose responses a tally and a release count. */
const liveConsulted = (participants: readonly DecisionParticipant[]) => participants.filter((row) => row.removedAt === null && row.role === 'consulted');

/** The tally of `round`, over its version's options, of each live consulted participant's latest response there. */
function roundTally(decision: Decision, participants: readonly DecisionParticipant[], responses: readonly DecisionResponse[], round: number): RoundTally {
	const latest = latestInRound(responses, round);
	const rows: ResultRow[] = [];
	for (const participant of liveConsulted(participants)) {
		const found = latest.get(participant.id);
		if (found !== undefined) rows.push(resultRowOf(participant, found.row, found.changes));
	}
	const optionIds = versionOptionsOf(decision.id, round === 0 ? decision.currentVersion : round).map((option) => option.optionId);
	return { round, ...tallyOf(rows, optionIds, voteModeOf(decision)), rows };
}

/**
 * The current round's tally, and the live consulted participants with no
 * response in it: what `ruleDecision` works "against" and the cut-off from
 * (decisions 11 and 12), and what the results page shows.
 */
export function currentResultsOf(decision: Decision): { tally: RoundTally; notResponded: DecisionParticipant[] } {
	const participants = participantsOf(decision.id);
	const tally = roundTally(decision, participants, responsesOf(decision.id), currentRound(decision.id));
	const answered = new Set(tally.rows.map((row) => row.participantId));
	return { tally, notResponded: liveConsulted(participants).filter((row) => !answered.has(row.id)) };
}

// ─── The open questions and the results revision (decisions 8 and 13) ───────

/** The decision's questions not yet answered, oldest first (decision 13). Card 2678 writes them. */
export function openQuestionsOf(decisionId: number): { askerName: string; question: string; askedAt: string }[] {
	return db
		.select({ askerName: decisionQuestions.askerName, question: decisionQuestions.question, askedAt: decisionQuestions.askedAt })
		.from(decisionQuestions)
		.where(and(eq(decisionQuestions.decisionId, decisionId), isNull(decisionQuestions.answer)))
		.orderBy(asc(decisionQuestions.id))
		.all();
}

/**
 * The decision's results revision as it is now (decision 8); '' for a
 * decision not there. It covers every response but a concern
 * (`revisionResponseIdsOf`), a kind no tally counts yet among them, so that it
 * fails closed (code review F1).
 */
export function resultsRevisionFor(decisionId: number): string {
	const decision = db.select().from(decisions).where(eq(decisions.id, decisionId)).get();
	if (!decision) return '';
	return resultsRevisionOf({
		decision,
		options: allOptionsOf(decisionId),
		participants: participantsOf(decisionId),
		responseIds: revisionResponseIdsOf(decisionId),
		questions: db
			.select({ id: decisionQuestions.id, answeredAt: decisionQuestions.answeredAt })
			.from(decisionQuestions)
			.where(eq(decisionQuestions.decisionId, decisionId))
			.all()
	});
}

/**
 * The 409s a ruling meets after its status, in order, each in its words
 * (decision 13): a results revision that is not the decision's as it is now,
 * and questions still open that the decider has not confirmed ruling with.
 * The first is answered. Card 2684 adds an unanswered objection here.
 */
export function rulingRefusals(decision: Decision, input: { revision: string; openQuestionsConfirmed: boolean }): string[] {
	const refusals: string[] = [];
	if (resultsRevisionFor(decision.id) !== input.revision) refusals.push(STALE_REVISION);
	const open = openQuestionsOf(decision.id).length;
	if (open > 0 && !input.openQuestionsConfirmed) {
		refusals.push(open === 1 ? '1 question is still open: confirm that you rule with it open' : `${open} questions are still open: confirm that you rule with them open`);
	}
	return refusals;
}

// ─── What a release shows (decision 10) ──────────────────────────────────────

/** A response as a release counts it: what it answered, and its ids for the keys and the chain. No name, no group (S4). */
export type ReleaseRow = {
	responseId: number;
	participantId: number;
	kind: 'vote' | 'abstain' | 'no_concerns';
	optionId: number | null;
	scores: Record<string, number> | null;
	comment: string | null;
	optionComments: Record<string, string>;
};

/**
 * What a release of the decision counts (decision 10, S9): the latest
 * response of each live consulted participant in the ruling round, the
 * current one, of those up to `upToResponseId` (all of them for null, as a
 * preview counts them), never a concern. After a ruling nobody can be
 * included or removed, so the participants live now are those live at the
 * release. Each row holds no group: 2686's group figures can never reach a
 * release (S4).
 */
export function releaseRowsOf(decision: Decision, upToResponseId: number | null): ReleaseRow[] {
	const responses = responsesOf(decision.id).filter((row) => upToResponseId === null || row.id <= upToResponseId);
	const latest = latestInRound(responses, currentRound(decision.id));
	const rows: ReleaseRow[] = [];
	for (const participant of liveConsulted(participantsOf(decision.id))) {
		const found = latest.get(participant.id);
		if (found === undefined) continue;
		const own = ownResponseOf(found.row);
		rows.push({
			responseId: found.row.id,
			participantId: participant.id,
			kind: own.kind,
			optionId: own.optionId,
			scores: own.scores,
			comment: own.comment,
			optionComments: own.optionComments
		});
	}
	return rows;
}

/** What the comment keys are derived for (`purposeKey`): no other value is made with it. */
const COMMENT_KEY_PURPOSE = 'decision-comment-key';

/**
 * The key a preview gives one comment (decision 10, S4): HMAC-SHA256, in hex,
 * over the decision's id, the response's id and the field (`comment`, or
 * `option:<id>`), keyed with `purposeKey('decision-comment-key')`. It is not
 * the response id and cannot be turned back into one, and the same response
 * on another decision would get another.
 */
export function commentKeyOf(decisionId: number, responseId: number, field: string): string {
	return createHmac('sha256', purposeKey(COMMENT_KEY_PURPOSE)).update(JSON.stringify([decisionId, responseId, field])).digest('hex');
}

/** A comment of a release, with what names it: its response and its field. */
type CommentEntry = { text: string; responseId: number; field: string; key: string };

/**
 * Which figures a release shows (decision 10, S4), `cells` of `n` who
 * responded: with one cell holding every response, none, as the zeros beside
 * it would say who answered what; otherwise 0, and a cell of 3 or more that
 * is 3 or more short of `n`. Every other cell, a cell of 1 or 2 among them,
 * is withheld (null).
 */
function shownCells(cells: readonly number[], n: number): ReleasedFigure[] {
	if (n > 0 && cells.some((cell) => cell === n)) return cells.map(() => null);
	return cells.map((cell) => (cell === 0 || (cell >= RELEASE_MIN_RESPONSES && n - cell >= RELEASE_MIN_RESPONSES) ? cell : null));
}

/**
 * The cells of a release beside another release in its supersede chain (code
 * review S4): never one alone withheld. With one cell withheld, the smallest
 * other cell that is not 0 (the first of equals) is withheld with it, and with
 * none, every cell: so that what one release shows, beside what the other
 * shows of almost the same people, cannot be subtracted back to the one
 * figure withheld.
 */
function withheldInTwos(shown: readonly ReleasedFigure[], cells: readonly number[]): ReleasedFigure[] {
	if (shown.filter((figure) => figure === null).length !== 1) return [...shown];
	let pick = -1;
	shown.forEach((figure, index) => {
		if (figure !== null && cells[index] !== 0 && (pick === -1 || cells[index] < cells[pick])) pick = index;
	});
	if (pick === -1) return shown.map(() => null);
	return shown.map((figure, index) => (index === pick ? null : figure));
}

/**
 * An option's mean score in a release (decision 10; code review S2), to one
 * decimal: the scores it was given (0 to 5) counted as cells, one for each
 * score, through `shownCells`, and the mean shown only when no cell of them
 * would be withheld. So {5, 5, 4} gives no mean, as its cells of 2 and 1
 * would each single someone out, and a spread of 3 or more at each score
 * given, beside everyone not giving it, does.
 */
function meanOf(given: readonly number[]): ReleasedFigure {
	if (given.length < RELEASE_MIN_RESPONSES) return null;
	const cells = [0, 1, 2, 3, 4, 5].map((score) => given.filter((value) => value === score).length);
	if (shownCells(cells, given.length).some((figure) => figure === null)) return null;
	return oneDecimal(given.reduce((sum, score) => sum + score, 0) / given.length);
}

/** Whether another decision in the supersede chain has released its results (decision 27; code review S4). */
function chainReleased(decision: Decision): boolean {
	return chainOf(decision.id).some((id) => (db.select({ at: decisions.resultsReleasedAt }).from(decisions).where(eq(decisions.id, id)).get()?.at ?? null) !== null);
}

/**
 * The release's projection of `rows` (decision 10), each comment as
 * `comment` makes it, those of `omitted` (`<responseId>|<field>`) left out:
 * the figures, withheld where they could single someone out, and whenever any
 * is withheld the number who responded too; in score mode each option's mean
 * to one decimal, only where no score given it would be withheld as a cell
 * (`meanOf`); and the comments, the overall ones and each option's, sorted by
 * their text. Nothing beside a comment.
 *
 * Beside another release in its supersede chain (`chained`, code review S4),
 * the number who responded is always withheld, and either no cell is
 * withheld or at least two are (`withheldInTwos`). A release made before the
 * other is read with it from then on: it withholds more, never less.
 */
function projectionOf(decision: Decision, rows: readonly ReleaseRow[], omitted: ReadonlySet<string>, chained: boolean): ReleasePreview {
	const voteMode = voteModeOf(decision);
	const options = versionOptionsOf(decision.id, decision.currentVersion);
	const tally = tallyOf(rows, options.map((option) => option.optionId), voteMode);
	const n = tally.responded;
	const optionCells = voteMode === 'single' ? tally.votes.map((vote) => vote.count) : [];
	const cells = [...optionCells, ...(voteMode === 'score' ? [tally.voted] : []), tally.abstained, tally.noConcerns];
	const shown = chained ? withheldInTwos(shownCells(cells, n), cells) : shownCells(cells, n);
	const anyWithheld = chained || shown.some((figure) => figure === null);
	const after = optionCells.length + (voteMode === 'score' ? 1 : 0);

	const entries: CommentEntry[] = [];
	for (const row of rows) {
		if (row.comment !== null && row.comment !== '') entries.push({ text: row.comment, responseId: row.responseId, field: 'comment', key: '' });
		for (const [optionId, text] of Object.entries(row.optionComments)) {
			if (text !== '') entries.push({ text, responseId: row.responseId, field: `option:${optionId}`, key: '' });
		}
	}
	const kept = entries
		.filter((entry) => !omitted.has(`${entry.responseId}|${entry.field}`))
		.map((entry) => ({ ...entry, key: commentKeyOf(decision.id, entry.responseId, entry.field) }))
		.sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	const commentsOn = (field: string): PreviewComment[] => kept.filter((entry) => entry.field === field).map((entry) => ({ text: entry.text, key: entry.key }));

	return {
		voteMode,
		responded: anyWithheld ? null : n,
		voted: voteMode === 'score' ? shown[0] : null,
		abstained: shown[after],
		noConcerns: shown[after + 1],
		options: options.map((option, index) => {
			const mean: ReleasedFigure =
				voteMode === 'score'
					? meanOf(rows.filter((row) => row.kind === 'vote').map((row) => row.scores?.[`${option.optionId}`]).filter((s): s is number => typeof s === 'number'))
					: null;
			return {
				optionId: option.optionId,
				label: option.label,
				title: option.title,
				votes: voteMode === 'single' ? shown[index] : null,
				mean,
				comments: commentsOn(`option:${option.optionId}`)
			};
		}),
		comments: commentsOn('comment')
	};
}

/** A preview without its keys: what everyone is shown. */
function withoutKeys(preview: ReleasePreview): ReleasedResults {
	return {
		voteMode: preview.voteMode,
		responded: preview.responded,
		voted: preview.voted,
		abstained: preview.abstained,
		noConcerns: preview.noConcerns,
		options: preview.options.map((option) => ({ ...option, comments: option.comments.map((comment) => comment.text) })),
		comments: preview.comments.map((comment) => comment.text)
	};
}

/** What the decision's release recorded (`results_released`): the highest response id it counted, the comments left out, and who released it; null for none. */
export function releaseRecordOf(decisionId: number): { upToResponseId: number; omitted: { responseId: number; field: string }[]; byName: string } | null {
	const event = eventsOfKind(decisionId, 'results_released').at(-1);
	if (event === undefined || typeof event.detail.upToResponseId !== 'number') return null;
	const omitted = Array.isArray(event.detail.omitted)
		? event.detail.omitted.filter(
				(entry): entry is { responseId: number; field: string } =>
					entry !== null && typeof entry === 'object' && typeof (entry as { responseId?: unknown }).responseId === 'number' && typeof (entry as { field?: unknown }).field === 'string'
			)
		: [];
	return { upToResponseId: event.detail.upToResponseId, omitted: omitted.map((entry) => ({ responseId: entry.responseId, field: entry.field })), byName: event.actorName };
}

/**
 * What a released decision shows everyone who may view it (decision 10), or
 * null before a release: the projection of the rows frozen at it, less the
 * comments the decider left out, with no keys. A release whose record cannot
 * be read shows nothing: fail closed.
 */
export function releasedOf(decision: Decision): ReleasedResults | null {
	if (decision.resultsReleasedAt === null) return null;
	const record = releaseRecordOf(decision.id);
	if (record === null) return null;
	const omitted = new Set(record.omitted.map((entry) => `${entry.responseId}|${entry.field}`));
	return withoutKeys(projectionOf(decision, releaseRowsOf(decision, record.upToResponseId), omitted, chainReleased(decision)));
}

/** What a release now would show, exactly, with each comment's key (decision 10): the decider's preview. */
export function previewOf(decision: Decision): ReleasePreview {
	return projectionOf(decision, releaseRowsOf(decision, null), new Set(), chainReleased(decision));
}

/** Each comment a release now would show, by its key: what a release's `omit` may name, and the response and field it is. */
export function commentKeysOf(decision: Decision): Map<string, { responseId: number; field: string }> {
	const keys = new Map<string, { responseId: number; field: string }>();
	for (const row of releaseRowsOf(decision, null)) {
		if (row.comment !== null && row.comment !== '') keys.set(commentKeyOf(decision.id, row.responseId, 'comment'), { responseId: row.responseId, field: 'comment' });
		for (const [optionId, text] of Object.entries(row.optionComments)) {
			if (text !== '') keys.set(commentKeyOf(decision.id, row.responseId, `option:${optionId}`), { responseId: row.responseId, field: `option:${optionId}` });
		}
	}
	return keys;
}

// ─── The supersede chain (decision 27) ───────────────────────────────────────

/**
 * Every other decision joined to this one through `supersedes_id`, walked
 * both ways: up through each `supersedes_id`, and down through each decision
 * that supersedes it. A visited set stops the walk on any cycle.
 */
export function chainOf(decisionId: number): number[] {
	const seen = new Set<number>([decisionId]);
	const queue = [decisionId];
	const chain: number[] = [];
	while (queue.length > 0) {
		const id = queue.shift()!;
		const up = db.select({ supersedesId: decisions.supersedesId }).from(decisions).where(eq(decisions.id, id)).get()?.supersedesId ?? null;
		const down = db.select({ id: decisions.id }).from(decisions).where(eq(decisions.supersedesId, id)).all().map((row) => row.id);
		for (const next of [...(up === null ? [] : [up]), ...down]) {
			if (seen.has(next)) continue;
			seen.add(next);
			chain.push(next);
			queue.push(next);
		}
	}
	return chain;
}

/** The people `rows` are of, by person id; a participant whose person was deleted matches nobody (decision 27). */
function peopleOf(decision: Decision, rows: readonly ReleaseRow[]): Set<string> {
	const personOf = new Map(participantsOf(decision.id).map((row) => [row.id, row.personId]));
	return new Set(
		rows.map((row) => {
			const personId = personOf.get(row.participantId) ?? null;
			return personId === null ? `none:${decision.id}:${row.participantId}` : `person:${personId}`;
		})
	);
}

/**
 * Whether another release in the decision's supersede chain was made from
 * people 1 or 2 apart from those of `rows` (decision 27): either set holding
 * 1 or 2 the other does not. The same people, and 3 or more apart either way,
 * are allowed.
 */
function chainTooClose(decision: Decision, rows: readonly ReleaseRow[]): boolean {
	const these = peopleOf(decision, rows);
	for (const id of chainOf(decision.id)) {
		const other = db.select().from(decisions).where(eq(decisions.id, id)).get();
		if (other === undefined || other.resultsReleasedAt === null) continue;
		const record = releaseRecordOf(other.id);
		const those = peopleOf(other, releaseRowsOf(other, record?.upToResponseId ?? null));
		const onlyHere = [...these].filter((person) => !those.has(person)).length;
		const onlyThere = [...those].filter((person) => !these.has(person)).length;
		if ((onlyHere >= 1 && onlyHere <= 2) || (onlyThere >= 1 && onlyThere <= 2)) return true;
	}
	return false;
}

/** The 409 of a release from too few responses (decision 10). */
export const TOO_FEW_TO_RELEASE = `Fewer than ${RELEASE_MIN_RESPONSES} people responded: releasing their comments could show who said what`;

/** The 409 of a second release. */
export const ALREADY_RELEASED = "This decision's results have already been released";

/** The 409 of a release in a chain of near-identical releases (decision 27). */
export const CHAIN_TOO_CLOSE =
	'A decision this one supersedes, or that supersedes it, released results from almost the same people: releasing these could show who said what';

/**
 * The 409s a release meets after its status, in order, each in its words
 * (decisions 10, 25 and 27): already released; fewer than 3 responses in the
 * ruling round; any of them given before the page said the results could be
 * released; and another release in the supersede chain from people 1 or 2
 * apart. The first is answered; the results page says it beside the control.
 */
export function releaseRefusals(decision: Decision): string[] {
	const refusals: string[] = [];
	if (decision.resultsReleasedAt !== null) refusals.push(ALREADY_RELEASED);
	const rows = releaseRowsOf(decision, null);
	if (rows.length < RELEASE_MIN_RESPONSES) refusals.push(TOO_FEW_TO_RELEASE);
	const statements = statementsOf(decision.id);
	const old = rows.filter((row) => statements.get(row.responseId) !== WHO_SEES_STATEMENT_VERSION).length;
	if (old > 0) refusals.push(`${old} of these responses were given before the page said the results could be released: they cannot be released`);
	if (chainTooClose(decision, rows)) refusals.push(CHAIN_TOO_CLOSE);
	return refusals;
}

// ─── The results page (decision 16) ──────────────────────────────────────────

/**
 * The results of a decision (decision 16), for its decider and
 * administrators (`results`): 404 for a caller who may not view it, 403 for
 * one who may and is neither. The current round's tally and each latest
 * response by name, earlier rounds apart, who has not responded, the removed,
 * the open questions, the concerns, the ruling with "against", "early" and
 * the cut-off names, the release and its preview, and what the caller may do.
 */
export function readResults(user: SessionUser, decisionId: number): ResultsData {
	const { decision, access } = requireDecision(user, decisionId, 'results');
	const voteMode = voteModeOf(decision);
	const participants = participantsOf(decision.id);
	const responses = responsesOf(decision.id);
	const round = currentRound(decision.id);
	const current = roundTally(decision, participants, responses, round);
	const answered = new Set(current.rows.map((row) => row.participantId));
	const latest = latestInRound(responses, round);
	const earlier = [...new Set(responses.map((row) => row.round))].filter((r) => r < round).sort((a, b) => b - a);

	const record = rulingOf(decision.id);
	let ruling: RulingRecord | null = null;
	if (record !== null) {
		const option = versionOptionsOf(decision.id, record.versionNumber).find((candidate) => candidate.optionId === record.optionId);
		const nameOf = new Map(participants.map((row) => [row.id, row.name]));
		const ruled = eventsOfKind(decision.id, 'ruled').at(-1);
		ruling = {
			optionId: record.optionId,
			label: option?.label ?? null,
			title: option?.title ?? null,
			reason: record.reason,
			conditions: record.conditions,
			early: record.early,
			againstResponses: record.againstResponses,
			cutOff: eventsOfKind(decision.id, 'cut_off').map((event) => (event.participantId === null ? '' : (nameOf.get(event.participantId) ?? ''))),
			supersededOld: typeof ruled?.detail.supersededOld === 'boolean' ? ruled.detail.supersededOld : null,
			byName: record.ruledByName,
			at: record.ruledAt
		};
	}

	const released = decision.resultsReleasedAt === null ? null : releaseRecordOf(decision.id);
	const releasable = decision.status === 'ruled';
	const releaseRefusal = releasable ? (releaseRefusals(decision)[0] ?? null) : null;
	const nameOfParticipant = new Map(participants.map((row) => [row.id, row.name]));

	return {
		decision: {
			id: decision.id,
			title: decision.title,
			shownStatus: decisionStatus(decision, stamp()),
			voteMode,
			closesAt: decision.closesAt,
			deciderName: decision.deciderName,
			boardId: decision.boardId,
			boardName: decision.boardName,
			currentVersion: decision.currentVersion
		},
		revision: resultsRevisionFor(decision.id),
		round,
		options: versionOptionsOf(decision.id, decision.currentVersion),
		current,
		earlierRounds: earlier.map((r) => roundTally(decision, participants, responses, r)),
		notResponded: liveConsulted(participants)
			.filter((row) => !answered.has(row.id))
			.map((row) => ({ participantId: row.id, name: row.name, groups: groupNamesOf(row.groups) })),
		removed: participants
			.filter((row) => row.removedAt !== null)
			.map((row) => {
				const found = latest.get(row.id);
				return { participantId: row.id, name: row.name, role: row.role, latest: found === undefined ? null : resultRowOf(row, found.row, found.changes) };
			}),
		openQuestions: openQuestionsOf(decision.id),
		concerns: concernsOf({ decisionId: decision.id }).map((row) => ({
			name: nameOfParticipant.get(row.participantId) ?? '',
			comment: row.comment ?? '',
			createdAt: row.createdAt,
			via: row.via
		})),
		ruling,
		released:
			decision.resultsReleasedAt === null ? null : { at: decision.resultsReleasedAt, byName: released?.byName ?? '', omitted: released?.omitted.length ?? 0 },
		releasePreview: releasable && decision.resultsReleasedAt === null ? previewOf(decision) : null,
		mayRule: (TRANSITIONS.rule as readonly string[]).includes(decision.status) && mayDo(access, 'rule', decision),
		mayRelease: releasable && mayDo(access, 'release', decision) && releaseRefusal === null,
		releaseRefusal,
		mostChosen: mostChosenOf(current, voteMode)
	};
}
