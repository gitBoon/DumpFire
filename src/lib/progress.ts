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
