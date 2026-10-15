/**
 * Prove that a request is all or nothing, by failing each of its writes in
 * turn.
 *
 *     const run = await eachWriteInTurn({
 *         build: () => { const user = makeUser(); ...; return { user, card }; },
 *         request: ({ user, card }) => api('PUT', `/api/cards/${card.id}`, { user, body })
 *     });
 *     expect(run.writes.length).toBeGreaterThanOrEqual(2);
 *     expect(run.effects.map((e) => e.kind)).toEqual(['webhook', 'event']);
 *
 * The fixture is built and the request made once, untouched, to count its
 * writes: N. Then, for each i from 1 to N, the database is emptied, the same
 * fixture is built again and the request is made with its ith write made to
 * fail. Each time:
 *
 *   - the failure must have fired, so the request did reach that write;
 *   - the request must not have reported success;
 *   - every row of every table must be as the fixture left it, id counters
 *     included and `system_logs` left out;
 *   - no webhook, live event or mail may have been sent;
 *   - no transaction may be left open.
 *
 * The untouched run is checked too: none of its effects may have started while
 * its transaction was still open.
 *
 * `build` must make the same rows every time. The builders in `fixtures.ts`
 * do, because `resetDb()` puts the id counters and their own numbering back.
 *
 * Installs `failingWrite` and `effects` for its duration and removes both, so
 * it cannot be used while a test has either installed itself.
 */
import { sqlite } from '$lib/server/db';
import { effects, type RecordedEffect } from './effects';
import { failingWrite, InjectedWriteFailure } from './failing-write';
import { resetDb } from './fixtures';
import { expectUnchanged, snapshotDb } from './snapshot';

export type EachWriteOptions<F, R> = {
	/** Build the fixture. Called on an empty database, once for each run. */
	build: () => F;
	/** Make the request under test. */
	request: (fixture: F) => R | Promise<R>;
	/**
	 * Whether what the request returned is a failure. By default anything with
	 * a numeric `status` of 500 or more, which is what `api()` returns when a
	 * route catches the failure and answers for itself. A request that throws
	 * the injected failure has failed whatever this says.
	 */
	failed?: (result: R) => boolean;
	/**
	 * Called at the end of the untouched run, with the database as the request
	 * left it. For assertions about what a success wrote.
	 */
	afterSuccess?: (fixture: F, result: R, effects: RecordedEffect[]) => void | Promise<void>;
};

export type EachWriteRun<R> = {
	/** The SQL of each write of the untouched run, in order. Its length is N. */
	writes: string[];
	/** What the untouched run returned. */
	result: R;
	/** What the untouched run sent, in order. */
	effects: RecordedEffect[];
};

const reportsFailure = (result: unknown): boolean => {
	const status = (result as { status?: unknown } | null | undefined)?.status;
	return typeof status === 'number' && status >= 500;
};

/** Whether `thrown` is the injected failure, or was caused by it. */
function isInjected(thrown: unknown): boolean {
	for (let e = thrown, depth = 0; e instanceof Error && depth < 10; e = e.cause, depth++) {
		if (e instanceof InjectedWriteFailure) return true;
	}
	return false;
}

export async function eachWriteInTurn<F, R>(opts: EachWriteOptions<F, R>): Promise<EachWriteRun<R>> {
	const failed = opts.failed ?? reportsFailure;
	const writes = failingWrite();
	const sent = effects();

	try {
		// The untouched run.
		resetDb();
		const fixture = opts.build();
		writes.reset();
		const result = await opts.request(fixture);
		await sent.settle();

		const counted = [...writes.writes];
		const succeeded = [...sent.all];
		if (counted.length === 0) {
			throw new Error('eachWriteInTurn: the request made no write, so there is nothing to fail');
		}
		const early = sent.duringTransaction;
		if (early.length > 0) {
			throw new Error(
				`${early.length} effect(s) started while the transaction was still open: ` +
					early.map((e) => `${e.kind}${'event' in e ? ` ${e.event}` : ` ${e.subject}`}`).join(', ')
			);
		}
		await opts.afterSuccess?.(fixture, result, succeeded);

		// Each write in turn.
		for (let i = 1; i <= counted.length; i++) {
			const when = `with write ${i} of ${counted.length} failed (${counted[i - 1]})`;

			resetDb();
			const again = opts.build();
			const before = snapshotDb();
			sent.clear();
			writes.failNth(i);

			let outcome: { threw: unknown } | { returned: R };
			try {
				outcome = { returned: await opts.request(again) };
			} catch (thrown) {
				outcome = { threw: thrown };
			}
			const fired = writes.fired;
			// Disarmed before anything else, so that nothing below is failed in its turn.
			writes.reset();
			await sent.settle();

			// A crash that is not the injected failure is a fault of its own.
			if ('threw' in outcome && !isInjected(outcome.threw)) throw outcome.threw;
			if (!fired) {
				throw new Error(`${when}: the failure never fired. This run did not make that write.`);
			}
			if ('returned' in outcome && !failed(outcome.returned)) {
				throw new Error(
					`${when}: the request reported success, so something caught the failure and carried on.`
				);
			}

			if (sqlite.inTransaction) throw new Error(`${when}: a transaction was left open`);
			expectUnchanged(before, when);
			if (sent.all.length > 0) {
				throw new Error(
					`${when}: nothing was saved, but ${sent.all.length} effect(s) were sent: ` +
						sent.all.map((e) => `${e.kind}${'event' in e ? ` ${e.event}` : ` ${e.subject}`}`).join(', ')
				);
			}
		}

		return { writes: counted, result, effects: succeeded };
	} finally {
		writes.restore();
		sent.restore();
	}
}
