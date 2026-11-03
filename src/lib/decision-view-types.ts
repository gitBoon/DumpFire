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

/** `DecisionView`'s props (decision 21), but its snippets `banner`, `response`, `questions` and `linkedCards`. */
export type DecisionViewProps = {
	decision: ViewDecision;
	content: ViewContent;
	options: ViewOption[];
	audiences: ViewAudience[];
	participant: ViewParticipant | null;
	mode: 'participant' | 'preview';
};

/** What both pages' loads give (decision 3): `readDecisionPage` and `readLinkPage`. */
export type DecisionPageData = {
	via: 'session' | 'link';
	/** `id` is left out, and `boardName` is null, for `via: 'link'`. */
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
	/** The latest in the current round. */
	ownResponse: OwnResponse | null;
	/** The latest of an earlier round, when the current has none. */
	earlierResponse: OwnResponse | null;
	/** Consulted, reachable, and the shown status open. */
	mayRespond: boolean;
	/** What the page's seen post records; null, and no post, on a ruled or superseded decision until card 2679 shows the ruling. */
	stage: 'question' | 'withdrawal' | null;
	/** Session only. */
	mayEdit: boolean;
	/** Link only: the signed-in account's name (decision 9). */
	signedInAs: string | null;
};
