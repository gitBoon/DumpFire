/**
 * Completion percentage for display.
 *
 * `Math.round` on its own is wrong at both ends. A board with 209 of its 210
 * cards done is 99.52%, which rounds to a flat 100% — and because the boards
 * list also keys its "complete" styling off `pct === 100`, a board with a card
 * still In Progress rendered as finished. The same fault mirrors at the bottom:
 * 1 of 210 done rounds to 0% and reads as untouched.
 *
 * So 100 means *actually* finished and 0 means *actually* nothing done. Anything
 * in between is clamped into 1..99, which keeps it visibly in progress however
 * close to either end it gets.
 */
export function completionPercent(done: number, total: number): number {
	if (total <= 0) return 0;
	if (done >= total) return 100;
	if (done <= 0) return 0;
	return Math.min(99, Math.max(1, Math.round((done / total) * 100)));
}

/** "1 option", "3 options". */
function optionsText(options: number): string {
	return `${options} option${options === 1 ? '' : 's'}`;
}

/**
 * A goal's progress as the goals list writes it beside its bar: "3/5",
 * "no cards", and its options after it, "3/5 and 2 options" (milestone 22,
 * card 2462). An option, in an Options column or on an ideas board, is no
 * committed work: it is in neither figure of the fraction, nor in the bar.
 * A goal of options alone reads "2 options".
 */
export function goalProgressText(done: number, total: number, options = 0): string {
	if (total === 0) return options > 0 ? optionsText(options) : 'no cards';
	return options > 0 ? `${done}/${total} and ${optionsText(options)}` : `${done}/${total}`;
}

/**
 * The tooltip of a goal's Ready chip, on the goals list and the plan page:
 * every committed card is complete. A goal that still holds options stays
 * Ready, and says so (the S4b review's J7).
 */
export function readyToCloseTitle(options = 0): string {
	if (options <= 0) return 'Every card in this goal is complete — close it when you are satisfied it is delivered';
	return options === 1
		? 'Every committed card in this goal is complete. It still holds 1 option, not committed to: commit, discard or take it out of the goal before you close it.'
		: `Every committed card in this goal is complete. It still holds ${options} options, not committed to: commit, discard or take them out of the goal before you close it.`;
}

/** The plan page's note under its cards-complete figure: "and 2 options", or null with none (milestone 22). */
export function goalOptionsNote(options: number | undefined): string | null {
	return options ? `and ${optionsText(options)}` : null;
}
