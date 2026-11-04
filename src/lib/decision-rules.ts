/**
 * decision-rules.ts — the rules of a decision that the server and the browser
 * both hold (card 2679, code review F8): the limits a form shows and the
 * server refuses past, and the reading of a tally as "most chosen" and
 * "against". The server's writes and reads, and the pages, take them from
 * here alone, so that a form never says one limit while the server holds
 * another, and the ruling form's warning is the rule `ruleDecision` records.
 *
 * Pure: no server module, no state, and only types imported, so that a module
 * the browser loads can use it, as `decision-words.ts` is used.
 */
import type { RoundTally } from './decision-view-types';

/** How long a decision's title may be (decision 30): `readTitle`, the editor and the supersede form. */
export const DECISION_TITLE_MAX = 200;

/**
 * How long a response's comment, a ruling's reason and its conditions, and a
 * concern may be (card 2677, decision 11; card 2679, S7): 4,000 characters.
 */
export const DECISION_TEXT_MAX = 4000;

/** The most concerns one participant raises about one ruling (card 2679, decision 4): the write refuses a sixth, and the page offers none. */
export const CONCERNS_PER_PARTICIPANT = 5;

/** How long a clarification question may be (card 2678, decision 3): 2,000 characters. An answer takes `DECISION_TEXT_MAX`. */
export const QUESTION_TEXT_MAX = 2000;

/** The most questions one participant asks on one decision (card 2678, decision 4): the write refuses an 11th, and the page offers no form past it. */
export const QUESTIONS_PER_PARTICIPANT = 10;

/**
 * The option or options most chosen (card 2679, decision 11): in single mode
 * those with the most votes, in score mode those with the highest total
 * score. Empty with no votes. Abstentions and "no concerns" are not votes.
 */
export function mostChosenOf(tally: Pick<RoundTally, 'voted' | 'votes' | 'scores'>, voteMode: 'single' | 'score'): number[] {
	if (tally.voted === 0) return [];
	const figures = voteMode === 'single' ? tally.votes.map((v) => ({ optionId: v.optionId, n: v.count })) : tally.scores.map((s) => ({ optionId: s.optionId, n: s.total }));
	if (figures.length === 0) return [];
	const most = Math.max(...figures.map((figure) => figure.n));
	return figures.filter((figure) => figure.n === most).map((figure) => figure.optionId);
}

/**
 * Whether ruling `optionId` (null: none of these) goes against the responses
 * (card 2679, decision 11): `voted` at least one, and the choice not among
 * `mostChosen`. A tie that includes the choice is not against; none of these
 * with votes is.
 */
export function againstOf(optionId: number | null, voted: number, mostChosen: readonly number[]): boolean {
	if (voted === 0) return false;
	return optionId === null || !mostChosen.includes(optionId);
}
