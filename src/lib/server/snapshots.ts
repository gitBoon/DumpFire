/**
 * snapshots.ts — Daily snapshot capture for CFD and burndown charts.
 *
 * Captures per-column card counts for every board once per day.
 * Called from a setInterval timer in hooks.server.ts.
 */

import { db } from './db';
import { boards, columns, cards, dailySnapshots } from './db/schema';
import { eq, and, isNull, inArray, asc } from 'drizzle-orm';
import { createLogger } from './logger';

const log = createLogger('Snapshots');

/**
 * Capture a daily snapshot of card counts per column for all boards.
 * Safe to call multiple times per day — skips if today's snapshot already exists.
 */
export async function captureSnapshots(): Promise<void> {
	const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

	const allBoards = db.select({ id: boards.id }).from(boards).all();

	for (const board of allBoards) {
		const boardCols = db.select()
			.from(columns)
			.where(eq(columns.boardId, board.id))
			.orderBy(asc(columns.position))
			.all();

		for (const col of boardCols) {
			// Check if snapshot already exists for this column today
			const existing = db.select({ id: dailySnapshots.id })
				.from(dailySnapshots)
				.where(and(
					eq(dailySnapshots.boardId, board.id),
					eq(dailySnapshots.columnId, col.id),
					eq(dailySnapshots.date, today)
				))
				.get();

			if (existing) continue; // Already captured today

			// Count active (non-archived) cards in this column
			const cardCount = db.select({ id: cards.id })
				.from(cards)
				.where(and(eq(cards.columnId, col.id), isNull(cards.archivedAt)))
				.all()
				.length;

			db.insert(dailySnapshots)
				.values({
					boardId: board.id,
					columnId: col.id,
					date: today,
					cardCount
				})
				.run();
		}
	}
}

// ─── Scheduler ──────────────────────────────────────────────────────────────

let snapshotTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Initialize the daily snapshot scheduler.
 * Captures an initial snapshot immediately, then every hour (to catch midnight).
 */
export function initSnapshotScheduler(): void {
	if (snapshotTimer) {
		clearInterval(snapshotTimer);
	}

	// Capture initial snapshot
	captureSnapshots().catch(err => {
		log.error('Initial snapshot capture failed', err);
	});

	// Check every hour — captureSnapshots() is idempotent and skips if already done today
	snapshotTimer = setInterval(async () => {
		try {
			await captureSnapshots();
		} catch (err) {
			log.error('Snapshot scheduler error', err);
		}
	}, 60 * 60 * 1000); // Every hour

	log.warn('Snapshot scheduler initialized');
}
