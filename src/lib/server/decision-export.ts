/**
 * decision-export.ts — what a decision's PDF holds (card 2688, R3, R4): the
 * two projections `decision-report.ts` draws, each worked out from who is
 * exporting and never holding more than they can see on screen.
 *
 *   - `readFullExport`, the full private record, for the decider (with board
 *     edit while the board exists) and administrators (`record`, then each
 *     read's own guard): the decision, the ruling with "early", "against" and
 *     who was cut off, the release and what it disclosed, the current version
 *     in full, every version listed, the current round's responses by name,
 *     earlier rounds as their totals alone (no response by name, R3.7), the
 *     objections and requests to talk with the replies, the concerns, the
 *     questions with who asked (no agent's unpublished draft), and the record's
 *     entries as a reader who is no administrator is shown them
 *     (`adminDetail: false`, S-M2), at most `RECORD_READ_MAX`.
 *   - `readShareableExport`, the shareable copy, for anyone `view` lets in:
 *     built field by field from the page every viewer has (`readDecisionPage`),
 *     never by spreading it, with the board's name as the decision stored it
 *     (S-L2) and the options, survey questions and audiences built again from
 *     the version's stored content with no group of the exporter's
 *     (`viewModelOf(content, options, new Set())`, S-M1), so that every
 *     exporter's copy is the same document but for their name. Never a closing
 *     time (S-L1), the ruling's moment, anyone's name or response, anything of
 *     the exporter's own participation (A4), or the title of the decision it
 *     supersedes or that superseded it, only that one exists (card 2688's code
 *     review, S-L2).
 *
 * Either copy of a draft is a 409 (`DRAFT_NOT_EXPORTED`). `requireExportable`
 * asks the same of a copy before the route takes the one drawing place, so a
 * caller who is refused never holds it (card 2688's code review, S-M1). The export is dated
 * by its UTC day alone (`exporter.date`, S-L1), which the footer, the file
 * name and the file's creation date all use.
 *
 * A plain read module, not a service: each read takes the signed-in account,
 * `user: SessionUser`, never `caller`, imports no `inWrite` and writes nothing
 * (tests/check-at-the-write.test.ts, rule 4). The full record's entry on the
 * decision's record is written by `recordExport` (decision-export-writes.ts)
 * once the PDF is drawn, handed `drawn`.
 */
import { error } from '@sveltejs/kit';
import { and, asc, eq } from 'drizzle-orm';
import { db } from './db';
import { decisionVersions, decisions, type Decision } from './db/schema';
import type { SessionUser } from './auth';
import { versionContentAnswer } from './decision-authoring';
import { parseVersionContent, publishedSurveyOf, type VersionContent } from './decision-content';
import { namedFor } from './decision-naming';
import { readQuestions } from './decision-questions';
import { supersedingOf } from './decision-record';
import { readRecord, RECORD_READ_MAX } from './decision-register';
import { readResults, releasedOf } from './decision-results';
import { decisionStatus } from './decision-status';
import { readDecisionPage, viewModelOf } from './decision-view';
import { requireDecision } from './route-guards';
import type { RecordEntry } from '$lib/decision-register-types';
import type {
	GroupTally,
	PublishedSurveyQuestion,
	QuestionView,
	ReleasedResults,
	ResultFlag,
	ResultRow,
	RoundTally,
	RulingRecord,
	RulingView,
	ShownStatus,
	ViewContent,
	ViewOption,
	ViewSurveyQuestion
} from '$lib/decision-view-types';
import { DRAFT_NOT_EXPORTED } from '$lib/decision-words';
import { stamp, type Stamp } from '$lib/timestamps';

/** A version's content as either copy prints it: its text sections and stories, and which sections an agent drafted and no person reviewed. */
export type ExportContent = Pick<ViewContent, 'situation' | 'question' | 'ask' | 'unknowns' | 'alreadyRuled' | 'technicalDetail' | 'stories' | 'agentDrafted'>;

/** An audience as either copy prints it: in stored order, every one (S-M1). */
export type ExportAudience = { heading: string; body: string };

/** One version as the full record lists it (row 4, A18): no content. */
export type VersionListed = { number: number; publishedAt: Stamp; publishedByName: string; asksAgain: boolean; changeNote: string | null };

/** Who took the copy, and the UTC day they took it (S-L1): `YYYY-MM-DD`. */
export type Exporter = { name: string; date: string };

/** Another decision as the exporter may be told of it (`namedFor`): its title only where they may view it. */
export type NamedDecision = { title?: string };

/** A round's figures without a response by name (R3.7): an earlier round in the full record. */
export type RoundTotals = Omit<RoundTally, 'rows'>;

/** The shareable copy (R4): what every viewer of the decision sees, the same for every exporter but their name. */
export type ShareableExport = {
	copy: 'shareable';
	decision: {
		id: number;
		title: string;
		/** As the decision stored it, for every exporter (S-L2). */
		boardName: string;
		shownStatus: ShownStatus;
		voteMode: 'single' | 'score';
		deciderName: string | null;
		withdrawnAt: Stamp | null;
		withdrawnReason: string | null;
	};
	version: { number: number; publishedAt: Stamp; content: ExportContent } | null;
	options: ViewOption[];
	surveyQuestions: ViewSurveyQuestion[];
	audiences: ExportAudience[];
	ruling: RulingView | null;
	released: ReleasedResults | null;
	/**
	 * Only that such a decision exists, never its title, whoever exports (card 2688's code review, S-L2): the words
	 * every viewer who may not view it is given, so that every exporter's copy is the same.
	 */
	supersedes: Record<string, never> | null;
	laterDecision: { superseded: boolean } | null;
	exporter: Exporter;
};

/** The full private record (R3): what the decider and administrators see on screen, but administrator-only detail. */
export type FullExport = {
	copy: 'full';
	decision: {
		id: number;
		title: string;
		boardName: string;
		status: string;
		shownStatus: ShownStatus;
		voteMode: 'single' | 'score';
		deciderName: string | null;
		authorName: string;
		openedAt: Stamp | null;
		closesAt: Stamp | null;
		closedAt: Stamp | null;
		withdrawnAt: Stamp | null;
		withdrawnReason: string | null;
	};
	/**
	 * What the export entry is checked against when it is written (R6.5): the version drawn, the stored status and
	 * `updatedAt`, and when the results were released (card 2688's code review, E-L2: `updatedAt` is to the second).
	 */
	drawn: { versionNumber: number; status: string; updatedAt: Stamp; resultsReleasedAt: Stamp | null };
	version: { number: number; publishedAt: Stamp; content: ExportContent } | null;
	options: ViewOption[];
	surveyQuestions: ViewSurveyQuestion[];
	audiences: ExportAudience[];
	versions: VersionListed[];
	results: {
		round: number;
		/** The current version's live options, by label and title. */
		options: { optionId: number; label: string; title: string }[];
		current: RoundTally;
		/** Newest first, totals alone (R3.7). */
		earlierRounds: RoundTotals[];
		notResponded: { name: string; groups: string[]; reached: boolean }[];
		groupBreakdown: GroupTally[];
		removed: { name: string; role: string; latest: ResultRow | null }[];
		concerns: { name: string; comment: string; createdAt: Stamp; via: string }[];
		flags: ResultFlag[];
		/** The survey questions of each version a printed response was given under, by version number: what its answers are labelled by. */
		surveysByVersion: Record<number, PublishedSurveyQuestion[]>;
	};
	ruling: RulingRecord | null;
	release: { at: Stamp; byName: string; omitted: number } | null;
	released: ReleasedResults | null;
	questions: QuestionView[];
	record: { entries: RecordEntry[]; more: boolean };
	supersedes: NamedDecision | null;
	laterDecision: (NamedDecision & { superseded: boolean }) | null;
	exporter: Exporter;
};

export type DecisionExport = FullExport | ShareableExport;

/** Whether the decision has been ruled on: stored `ruled` or `superseded`. */
const isRuled = (decision: Pick<Decision, 'status'>) => decision.status === 'ruled' || decision.status === 'superseded';

/** The exporter's name and the UTC day of the export (S-L1). */
const exporterOf = (user: SessionUser): Exporter => ({ name: user.username, date: stamp().slice(0, 10) });

/** A version's content, field by field (R4: never by spreading). */
function contentOf(content: ViewContent): ExportContent {
	return {
		situation: content.situation,
		question: content.question,
		ask: content.ask,
		unknowns: content.unknowns,
		alreadyRuled: content.alreadyRuled,
		technicalDetail: content.technicalDetail,
		stories: content.stories.map((story) => ({ title: story.title, body: story.body })),
		agentDrafted: { ...content.agentDrafted }
	};
}

/** The stored content of version `number` of the decision, or null for none. */
function storedVersion(decisionId: number, number: number): { number: number; publishedAt: Stamp; content: VersionContent } | null {
	const row = db
		.select({ number: decisionVersions.number, publishedAt: decisionVersions.publishedAt, content: decisionVersions.content })
		.from(decisionVersions)
		.where(and(eq(decisionVersions.decisionId, decisionId), eq(decisionVersions.number, number)))
		.get();
	return row === undefined ? null : { number: row.number, publishedAt: row.publishedAt, content: parseVersionContent(row.content) };
}

/**
 * A version's options, survey questions and audiences as every viewer is
 * given them, from its stored content, with no group of anyone's (S-M1, A26):
 * every audience in stored order.
 */
function modelOf(content: VersionContent): { options: ViewOption[]; surveyQuestions: ViewSurveyQuestion[]; audiences: ExportAudience[] } {
	const model = viewModelOf(
		content,
		content.options.map((option) => ({ optionId: option.optionId, label: option.label })),
		new Set()
	);
	return {
		options: model.options,
		surveyQuestions: model.surveyQuestions,
		audiences: model.audiences.map((audience) => ({ heading: audience.heading, body: audience.body }))
	};
}

/**
 * Every version of the decision, oldest first: its number, when and by whom
 * it was published, whether it asked everyone again, and its change note
 * (row 4, A18). No content.
 */
export function versionsOf(decisionId: number): VersionListed[] {
	return db
		.select({
			number: decisionVersions.number,
			publishedAt: decisionVersions.publishedAt,
			publishedByName: decisionVersions.publishedByName,
			asksAgain: decisionVersions.asksAgain,
			changeNote: decisionVersions.changeNote
		})
		.from(decisionVersions)
		.where(eq(decisionVersions.decisionId, decisionId))
		.orderBy(asc(decisionVersions.number))
		.all();
}

/** The decision this one supersedes, and the one that superseded it once ruled, as the exporter may be told of them (`namedFor`). */
function supersedeOf(user: SessionUser, decision: Decision): Pick<FullExport, 'supersedes' | 'laterDecision'> {
	const named = (other: Decision): NamedDecision => {
		const shown = namedFor(user, other);
		return shown.title === undefined ? {} : { title: shown.title };
	};
	let supersedes: NamedDecision | null = null;
	if (decision.supersedesId !== null) {
		const earlier = db.select().from(decisions).where(eq(decisions.id, decision.supersedesId)).get();
		if (earlier !== undefined) supersedes = named(earlier);
	}
	let laterDecision: FullExport['laterDecision'] = null;
	const later = supersedingOf(decision.id);
	if (later !== null && isRuled(later)) laterDecision = { superseded: decision.status === 'superseded', ...named(later) };
	return { supersedes, laterDecision };
}

/** A tally without its rows (R3.7): an earlier round's figures alone. */
function totalsOf(tally: RoundTally): RoundTotals {
	return {
		round: tally.round,
		responded: tally.responded,
		voted: tally.voted,
		votes: tally.votes,
		scores: tally.scores,
		abstained: tally.abstained,
		noConcerns: tally.noConcerns,
		survey: tally.survey
	};
}

/**
 * Whether `user` may take `copy` of the decision, asked as its projection
 * asks it, and nothing else read (card 2688's code review, S-M1): the full
 * record `record` (404, then 403), the shareable copy `view` (404), and either
 * 409 for a draft. The route asks it before it takes the one place where a
 * decision's PDF is drawn, so that a caller refused never holds the place; the
 * projection, read once the place is held, asks it all again.
 */
export function requireExportable(user: SessionUser, decisionId: number, copy: 'full' | 'shareable'): void {
	const { decision } = requireDecision(user, decisionId, copy === 'full' ? 'record' : 'view');
	if (decision.status === 'draft') error(409, DRAFT_NOT_EXPORTED);
}

/**
 * The full private record of a decision for its PDF (R3): `record`, so 404
 * for a caller who may not view it and 403 for one who may and is neither the
 * decider (with board edit while the board exists) nor an administrator; 409
 * for a draft. Then the results, the questions and the record, each read
 * through its own guard under the page's source, and the record with no
 * administrator-only detail for anyone (`adminDetail: false`, S-M2).
 */
export function readFullExport(user: SessionUser, decisionId: number): FullExport {
	const { decision } = requireDecision(user, decisionId, 'record');
	if (decision.status === 'draft') error(409, DRAFT_NOT_EXPORTED);

	const results = readResults(user, decision.id, { source: 'ui' });
	const questions = readQuestions(user, decision.id, { source: 'ui' });
	const record = readRecord(user, decision.id, { participant: null, after: null }, { source: 'ui', limit: RECORD_READ_MAX, adminDetail: false });

	const version = storedVersion(decision.id, decision.currentVersion);
	const model = version === null ? { options: [], surveyQuestions: [], audiences: [] } : modelOf(version.content);

	const printed = [...results.current.rows, ...results.removed.flatMap((row) => (row.latest === null ? [] : [row.latest]))];
	const surveysByVersion: Record<number, PublishedSurveyQuestion[]> = {};
	for (const number of new Set(printed.map((row) => row.versionNumber))) {
		surveysByVersion[number] = publishedSurveyOf(decision.id, number).map((question) => ({ ...question }));
	}

	return {
		copy: 'full',
		decision: {
			id: decision.id,
			title: decision.title,
			boardName: decision.boardName,
			status: decision.status,
			shownStatus: decisionStatus(decision),
			voteMode: decision.voteMode === 'score' ? 'score' : 'single',
			deciderName: decision.deciderName,
			authorName: decision.authorName,
			openedAt: decision.openedAt,
			closesAt: decision.closesAt,
			closedAt: decision.closedAt,
			withdrawnAt: decision.withdrawnAt,
			withdrawnReason: decision.withdrawnReason
		},
		drawn: { versionNumber: decision.currentVersion, status: decision.status, updatedAt: decision.updatedAt, resultsReleasedAt: decision.resultsReleasedAt },
		version: version === null ? null : { number: version.number, publishedAt: version.publishedAt, content: contentOf(versionContentAnswer(version.content, 'session')) },
		options: model.options,
		surveyQuestions: model.surveyQuestions,
		audiences: model.audiences,
		versions: versionsOf(decision.id),
		results: {
			round: results.round,
			options: results.options,
			current: results.current,
			earlierRounds: results.earlierRounds.map(totalsOf),
			notResponded: results.notResponded.map((row) => ({ name: row.name, groups: row.groups, reached: row.reached })),
			groupBreakdown: results.groupBreakdown,
			removed: results.removed.map((row) => ({ name: row.name, role: row.role, latest: row.latest })),
			concerns: results.concerns,
			flags: results.flags ?? [],
			surveysByVersion
		},
		ruling: results.ruling,
		release: results.released,
		released: releasedOf(decision),
		// An agent's unpublished draft is nobody's answer (R3.10): left out.
		questions: questions.map(({ draft: _draft, ...question }) => question),
		record: { entries: record.entries, more: record.next !== null },
		...supersedeOf(user, decision),
		exporter: exporterOf(user)
	};
}

/**
 * The shareable copy of a decision for its PDF (R4): `view`, so 404 for a
 * caller who may not view it; 409 for a draft. Built from `readDecisionPage`
 * by allow-list, field by field, with the stored board name and the
 * version's options, survey questions and audiences built again with no group
 * of the exporter's. Nothing of anyone's participation, the exporter's
 * included, no closing time and no ruling moment.
 */
export function readShareableExport(user: SessionUser, decisionId: number): ShareableExport {
	const { decision } = requireDecision(user, decisionId, 'view');
	if (decision.status === 'draft') error(409, DRAFT_NOT_EXPORTED);
	const page = readDecisionPage(user, decision.id);

	const version = page.version === null ? null : storedVersion(decision.id, page.version.number);
	const model = version === null ? { options: [], surveyQuestions: [], audiences: [] } : modelOf(version.content);

	return {
		copy: 'shareable',
		decision: {
			id: decision.id,
			title: page.decision.title,
			boardName: decision.boardName,
			shownStatus: page.decision.shownStatus,
			voteMode: page.decision.voteMode,
			deciderName: page.decision.deciderName,
			withdrawnAt: page.decision.withdrawnAt,
			withdrawnReason: page.decision.withdrawnReason
		},
		version: page.version === null ? null : { number: page.version.number, publishedAt: page.version.publishedAt, content: contentOf(page.version.content) },
		options: model.options,
		surveyQuestions: model.surveyQuestions,
		audiences: model.audiences,
		ruling:
			page.ruling === null
				? null
				: {
						label: page.ruling.label,
						title: page.ruling.title,
						noneOfThese: page.ruling.noneOfThese,
						reason: page.ruling.reason,
						conditions: page.ruling.conditions,
						ruledByName: page.ruling.ruledByName,
						...(page.ruling.noOptions ? { noOptions: true as const } : {})
					},
		released: page.released,
		// S-L2 (card 2688's code review): that one exists, never which, even to an exporter who may view it.
		supersedes: page.supersedes === null ? null : {},
		laterDecision: page.laterDecision === null ? null : { superseded: page.laterDecision.superseded },
		exporter: exporterOf(user)
	};
}
