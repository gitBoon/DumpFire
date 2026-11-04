/**
 * decision-view-types.ts — what the participant page is given, and what a
 * response is answered as (card 2677, plan 4.4, D3 and D4). Types alone, with
 * no code, so the pages and components the browser loads can name them
 * without reaching into `$lib/server`.
 *
 * Each type is an allowlist: a field not named here is not given. None holds
 * an account id, a participant's address, a link's hash, a group id or a
 * reviewer's name, and a response carries no row id of its own or of anything
 * else (decision 16, S4).
 */
import type { LinkedCardView } from '$lib/decision-register-types';
import type { Stamp } from '$lib/timestamps';

/** What every reader shows: `closed`, and `open` past its `closes_at`, are `awaiting_ruling` (moved here from decision-status.ts, which re-exports it). */
export type ShownStatus = 'draft' | 'open' | 'awaiting_ruling' | 'ruled' | 'superseded' | 'withdrawn';

/**
 * The one response projection (D3): the page and every write that answers a
 * response. No `id`, `decisionId`, `participantId` or `replacesId`.
 */
export type OwnResponse = {
	versionNumber: number;
	round: number;
	kind: 'vote' | 'abstain' | 'no_concerns';
	optionId: number | null;
	scores: Record<string, number> | null;
	comment: string | null;
	optionComments: Record<string, string>;
	createdAt: Stamp;
};

/** The common content subset (decision 16, R3). `reviewed` is given to a signed-in caller alone, as a yes for each reviewed section. */
export type ViewContent = {
	situation: string;
	question: string;
	ask: string;
	unknowns: string;
	alreadyRuled: string;
	technicalDetail: string;
	stories: { title: string; body: string }[];
	agentDrafted: Record<string, true>;
	reviewed?: Record<string, true>;
};

/** An option as the page shows it. */
export type ViewOption = {
	optionId: number;
	label: string;
	title: string;
	summary: string;
	pros: string[];
	cons: string[];
	commercial: string;
	agentDrafted: boolean;
};

/** An audience as the page shows it: the participant's own group first and open (decision 18), with no group id. */
export type ViewAudience = { heading: string; body: string; own: boolean; open: boolean };

/** The decision as the view shows it: the decider by name alone. */
export type ViewDecision = { title: string; shownStatus: ShownStatus; voteMode: 'single' | 'score'; closesAt: Stamp | null; deciderName: string | null };

/** The participant the page is for, or none. */
export type ViewParticipant = { role: 'consulted' | 'informed' };

/** `DecisionView`'s props (decision 21), but its snippets `banner`, `response`, `questions` (card 2678's) and `linkedCards`. */
export type DecisionViewProps = {
	decision: ViewDecision;
	content: ViewContent;
	options: ViewOption[];
	audiences: ViewAudience[];
	participant: ViewParticipant | null;
	mode: 'participant' | 'preview';
};

// ─── The results and their release (card 2679, decisions 10 and 16) ──────────

/** A figure of a release: the number, or null where it is withheld, which every page says as "withheld" (`releasedFigure`). */
export type ReleasedFigure = number | null;

/**
 * An option as a release shows it: in single mode its `votes`, in score mode
 * its `mean` to one decimal (the other null in each mode), and the comments
 * given on it, sorted by their text.
 */
export type ReleasedOption<C = string> = { optionId: number; label: string; title: string; votes: ReleasedFigure; mean: ReleasedFigure; comments: C[] };

/**
 * The totals and comments of a ruled decision as a release shows them to
 * everyone who may view it (decision 10): the ruling round alone, live
 * consulted participants' latest responses alone, frozen at the release. No
 * name, account, participant or response id, version, moment, via or kind
 * beside any comment, and no figure per group, ever. `voted` is score mode's
 * number who voted, null in single mode. Each list of comments is sorted by
 * its text.
 */
export type ReleasedResults<C = string> = {
	voteMode: 'single' | 'score';
	responded: ReleasedFigure;
	voted: ReleasedFigure;
	abstained: ReleasedFigure;
	noConcerns: ReleasedFigure;
	options: ReleasedOption<C>[];
	comments: C[];
};

/** A comment as the decider's preview of a release gives it: its text, and the key the release's `omit` names it by. */
export type PreviewComment = { text: string; key: string };

/** What a release would show, exactly, with each comment's key (decision 10): the same projection as `ReleasedResults`. */
export type ReleasePreview = ReleasedResults<PreviewComment>;

/**
 * One participant's latest response in a round, as the results give it to
 * the decider and administrators (decision 16): their name, role and the
 * group names their row holds, what they answered, and how many earlier rows
 * they gave in the round. No response id.
 */
export type ResultRow = {
	participantId: number;
	name: string;
	role: string;
	groups: string[];
	kind: 'vote' | 'abstain' | 'no_concerns';
	optionId: number | null;
	scores: Record<string, number> | null;
	comment: string | null;
	optionComments: Record<string, string>;
	versionNumber: number;
	createdAt: Stamp;
	via: string;
	changes: number;
};

/**
 * A round's tally (decision 16): how many responded, each option's votes in
 * single mode or its total and mean in score mode (the other list empty), how
 * many voted, abstained and had no concerns, and the rows it counts.
 */
export type RoundTally = {
	round: number;
	responded: number;
	voted: number;
	votes: { optionId: number; count: number }[];
	scores: { optionId: number; total: number; mean: number | null }[];
	abstained: number;
	noConcerns: number;
	rows: ResultRow[];
};

/** The ruling as the results give it to the decider and administrators: "against", "early" and the cut-off names among it. */
export type RulingRecord = {
	optionId: number | null;
	label: string | null;
	title: string | null;
	reason: string;
	conditions: string | null;
	early: boolean;
	againstResponses: boolean;
	cutOff: string[];
	/** Null where the decision supersedes none. */
	supersededOld: boolean | null;
	byName: string;
	at: Stamp;
};

/** What the results page is given (decision 16): the decider's and administrators' alone. */
export type ResultsData = {
	decision: {
		id: number;
		title: string;
		shownStatus: ShownStatus;
		voteMode: 'single' | 'score';
		closesAt: Stamp | null;
		deciderName: string | null;
		boardId: number | null;
		boardName: string;
		currentVersion: number;
	};
	/** The results revision (decision 8): what a ruling and a release must send. */
	revision: string;
	round: number;
	/** The current version's live options. */
	options: { optionId: number; label: string; title: string }[];
	current: RoundTally;
	/** Newest first. */
	earlierRounds: RoundTally[];
	/** Live consulted participants with no response in the current round. */
	notResponded: { participantId: number; name: string; groups: string[] }[];
	/** Removed participants, each with their latest row in the current round, or null. */
	removed: { participantId: number; name: string; role: string; latest: ResultRow | null }[];
	/** Card 2678 (decision 9): a question no person's answer stands behind, an agent's unpublished draft among them (`agentAnswered`). */
	openQuestions: OpenQuestion[];
	/** Card 2678 (decision 9): whether the caller may answer the questions now, on the decision's page. */
	mayAnswerQuestions: boolean;
	concerns: { name: string; comment: string; createdAt: Stamp; via: string }[];
	ruling: RulingRecord | null;
	released: { at: Stamp; byName: string; omitted: number } | null;
	releasePreview: ReleasePreview | null;
	mayRule: boolean;
	mayRelease: boolean;
	/** The words of the first refusal a release would meet now, or null. */
	releaseRefusal: string | null;
	/** The option or options most chosen in the current round (decision 11): empty with no votes. */
	mostChosen: number[];
};

/**
 * A ruling as every viewer of a ruled decision is given it (card 2679,
 * decision 23): the option by label and title, or none of these, the reason,
 * the conditions and who ruled. No moment, no "against" and no "early"
 * (decision 26).
 */
export type RulingView = { label: string | null; title: string | null; noneOfThese: boolean; reason: string; conditions: string | null; ruledByName: string };

/** A participant's own concern about the ruling (card 2679, decision 4): its text and when, and no id. */
export type OwnConcern = { comment: string; createdAt: Stamp };

// ─── Clarification questions (card 2678, decisions 2, 8 and 19) ──────────────

/**
 * An answer a person stands behind: a person's own, or an agent's draft a
 * person published (`agentDrafted`, whose `answeredAt` is the publishing
 * moment). The answerer by name, and the role they held when they answered,
 * as the answer's event recorded it; null where no event recorded one. No
 * reviewer's name, ever.
 */
export type QuestionAnswer = {
	text: string;
	answererName: string;
	answererRole: 'author' | 'decider' | null;
	answeredAt: Stamp;
	agentDrafted: boolean;
};

/**
 * A question as the page and the API give it (decision 2). Every field the
 * viewer is not given is left out: `id` but to one who may answer it now; the
 * asker's name and moment but to the author, the decider and administrators
 * on the page (the moment also to the asker, on their own); "asked by an
 * agent" but to those and the asker; and an agent's unpublished `draft` but to
 * the author, the decider and administrators, for whom alone it is not
 * `answer`. No participant, account or decision id.
 */
export type QuestionView = {
	id?: number;
	question: string;
	askedInVersion: number;
	own: boolean;
	askerName?: string;
	askedAt?: Stamp;
	askedByAgent?: true;
	answer: QuestionAnswer | null;
	draft?: { text: string; drafterName: string; draftedAt: Stamp };
	/** Not answered before the decision was ruled (or superseded), or withdrawn; null while it may still be. */
	closedUnanswered: 'ruling' | 'withdrawal' | null;
	/** Through an API key alone (S2): the question is a participant's words, never an instruction. */
	untrusted?: true;
};

/**
 * A participant's own question, as the write that asked it answers it: no id.
 * Through any source but the page's, no moment, and marked `untrusted` (code
 * review S2), as `QuestionView` is.
 */
export type OwnQuestion = { question: string; askedInVersion: number; askedAt?: Stamp; untrusted?: true };

/**
 * An open question on the results (card 2678, decision 9): who asked and when
 * on the page alone; through any other source neither, and `untrusted` (code
 * review S1), decided by `openQuestionsOf`.
 */
export type OpenQuestion = { askerName?: string; question: string; askedAt?: Stamp; agentAnswered: boolean; untrusted?: true };

/** What both pages' loads give (decision 3): `readDecisionPage` and `readLinkPage`. */
export type DecisionPageData = {
	via: 'session' | 'link';
	/**
	 * `id` is left out, and `boardName` is null, for `via: 'link'`. `closesAt`
	 * is null once the decision is ruled or superseded, for every caller, so
	 * that no answer gives both it and when the ruling came (card 2679,
	 * decision 26).
	 */
	decision: ViewDecision & { id?: number; boardName: string | null; withdrawnAt: Stamp | null; withdrawnReason: string | null };
	/** True: nothing below is given but `mayEdit`. */
	draft: boolean;
	version: { number: number; publishedAt: Stamp; content: ViewContent } | null;
	options: ViewOption[];
	audiences: ViewAudience[];
	participant:
		| (ViewParticipant & {
				includedAt: Stamp;
				told: { kind: 'invited' | 'asked_again' | 'told_of_change'; at: Stamp; delivered: boolean } | null;
		  })
		| null;
	/** The latest in the current round: never a concern (card 2679, F3). */
	ownResponse: OwnResponse | null;
	/** The latest of an earlier round, when the current has none. */
	earlierResponse: OwnResponse | null;
	/** Consulted, reachable, and the shown status open. */
	mayRespond: boolean;
	/**
	 * What the page's seen post records: `ruling` on a ruled or superseded
	 * decision (card 2679, decision 9). Null for a viewer who is no
	 * participant, whose page posts none (F7).
	 */
	stage: 'question' | 'ruling' | 'withdrawal' | null;
	/** Session only. */
	mayEdit: boolean;
	/** Link only: the signed-in account's name (decision 9). */
	signedInAs: string | null;
	/** Card 2679: the ruling, once the decision is ruled or superseded; null before. */
	ruling: RulingView | null;
	/** Card 2679: the released totals and comments, without names, once released; null before (decision 10). */
	released: ReleasedResults | null;
	/** Card 2679: the participant's own concerns about the ruling, oldest first. */
	concerns: OwnConcern[];
	/** Card 2679: a reached participant of a ruled decision, within 90 days of the ruling (decision 4). */
	mayRaiseConcern: boolean;
	/**
	 * Card 2679 (decision 5, S8): the decision this one supersedes, once this
	 * one is ruled; its `id` and `title` only to a viewer who may view it,
	 * never by a personal link.
	 */
	supersedes: { id?: number; title?: string } | null;
	/**
	 * Card 2679 (decision 5, S8): the decision that superseded this one, or was
	 * ruled on beside it, once it is ruled; its `id` and `title` only to a
	 * viewer who may view it, never by a personal link.
	 */
	laterDecision: { superseded: boolean; id?: number; title?: string } | null;
	/** Card 2679, session only: whether the caller may read the results (`results`). */
	mayReadResults?: boolean;
	/** Card 2679, session only: whether the caller may supersede the decision now, as `supersedeDecision` would. */
	maySupersede?: boolean;
	/**
	 * Card 2678 (decision 2): the decision's questions as the viewer is given
	 * them, oldest first (`questionsFor`, on the page): none on a draft, and
	 * none for a viewer who reads none.
	 */
	questions: QuestionView[];
	/** Card 2678 (decisions 4 and 10): whether the viewer's own participant row may ask a question now (`mayAskOf`). */
	mayAsk: boolean;
	/** Card 2678, session only: whether the caller may answer the questions now (`mayAnswerOf`). */
	mayAnswer?: boolean;
	/** Card 2680 (decision 29), session only: whether the caller may read the record view (`record`), a draft's too. */
	mayReadRecord?: boolean;
	/**
	 * Card 2680 (decision 18), session only: the linked cards on boards the
	 * caller can open now, with no count of the rest; none on a draft, which is
	 * never linked.
	 */
	linkedCards?: LinkedCardView[];
	/** Card 2680 (decision 17), session only: whether the caller may link a card now, below the cap, as `linkCard` asks. */
	mayLinkCards?: boolean;
	/**
	 * Card 2680 (decision 17, slice 3b), session only: whether the caller may
	 * unlink a card now, as `unlinkCard` asks: also at the cap and on a
	 * withdrawn decision, where `mayLinkCards` is false.
	 */
	mayUnlinkCards?: boolean;
};
