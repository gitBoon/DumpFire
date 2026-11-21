/**
 * Report Schedule detail API — Update or delete a schedule.
 *
 * PUT    /api/report-schedules/:id  — Update schedule (enable/disable, change frequency); an address added,
 *                                     turning it on or a wider filter with the password and a code (card 2751)
 * DELETE /api/report-schedules/:id  — Delete a schedule
 *
 * Every change to a schedule, and every delete, writes one INFO line naming
 * the schedule and the addresses it is sent to: a change that asks for the
 * password by `reportScheduleSet` (card 2751), one that asks nothing by
 * `reportScheduleChanged`, and a delete by `reportScheduleDeleted` (card 2895).
 */

import { json, error } from '@sveltejs/kit';
import { db, sqlite } from '$lib/server/db';
import { recordScheduleWritten, recordSchedulesAs, requireOutboundKey } from '$lib/server/outbound-changes';
import { reportSchedules } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';
import { afterCommit } from '$lib/server/db/transaction';
import { whilePasswordHolds, type SessionUser } from '$lib/server/auth';
import { addressOf } from '$lib/server/client-address';
import {
	checkReportMail,
	overCapScheduleWords,
	parseStatusFilter,
	REPORT_STATUS_FILTER_LABELS,
	REPORT_STATUS_FILTERS,
	reportScheduleChanged,
	reportScheduleDeleted,
	reportScheduleSet,
	takeReportMail,
	type ReportMailSpend,
	type ScheduleChange,
	type UnaskedScheduleChange
} from '$lib/server/reports';
import { requireUser } from '$lib/server/route-guards';
import { confirmStepUp } from '$lib/server/step-up';
import { writeAs } from '$lib/server/write-as';
import {
	pathId,
	readBody,
	readBoolean,
	readChoice,
	readNumber,
	readReportRecipients,
	readText,
	readTime,
	readTimeZone,
	type RequestBody
} from '$lib/server/request-body';
import { MAX_REPORT_RECIPIENTS, reportRecipients } from '$lib/report-recipients';
import { nextRunAfter } from '$lib/report-schedule-time';
import { stamp } from '$lib/timestamps';
import type { RequestHandler } from './$types';

/** How often a schedule may run: the two the scheduler works out a next run for. */
const FREQUENCIES = ['weekly', 'monthly'] as const;

/**
 * PUT — change a schedule of the caller's own.
 *
 * Who it may reach (card 2182): `recipients`, when sent changed, is read as
 * the scheduler sends it and held to 10 addresses (400). A schedule whose list
 * is over 10, kept from before there was a cap, cannot be turned on unless the
 * same request sends a list of 10 or fewer (400); one still on can be sent
 * back with a change, as a page sends it. A change that can bring a send
 * forward (turning it on, or a new frequency, day, time or zone for one that
 * is on after the change) takes the schedule's addresses from the account's
 * report mail for the day (429), last, immediately before the write. A
 * changed list takes the addresses it adds, those not in the stored list:
 * otherwise a schedule made with none, given ten, sent and deleted would mail
 * without bound (the review's B1). A list sent back in another order or case,
 * or cut down, a change of name or filter, re-timing one that stays off, and
 * turning it off take nothing.
 *
 * When it is sent (cards 2144 and 2159): `timeZone` is read as `POST` reads
 * it. Turning the schedule on, or a new frequency, day, time or zone, works
 * its next run out again from now; a timing that cannot be dated is 400.
 *
 * What asks for the current password and a code (card 2751, D2, D3): a
 * change that adds an address (one not in the stored list, as
 * `reportRecipients` reads both: a swap adds one), on or off; one that turns
 * the schedule on; and one that widens its status filter, from any filter but
 * `all` as the scheduler reads it to another. Nothing else asks: a rename,
 * a re-timing, an address removed, a narrower filter, turning it off. That is
 * decided on the row as it is stored, in the transaction that would write the
 * change (D7): a change that asks nothing is written there; one that asks
 * writes nothing there, and goes through the step-up, every refusal above
 * made first in its guard with the day's report mail read and nothing taken,
 * then is read and written again while the password holds. Once it is
 * written, an INFO line names every address and the owner is told
 * (`reportScheduleSet`, D13). A change that asks nothing and changes
 * something (renamed, re-timed, turned off, narrowed, addresses removed)
 * writes one INFO line once committed, naming what changed, every address
 * it is now sent to and those removed, with no notice
 * (`reportScheduleChanged`, card 2895); a row sent back as it is writes none.
 */
export const PUT: RequestHandler = async ({ locals, params, request, cookies, getClientAddress }) => {
	// A quick refusal, binding no name: who the caller is is decided below.
	requireUser(locals.user);

	const scheduleId = pathId(params.id, 'schedule');
	const body = await readBody(request);

	// The schedule is looked for among the caller's own in the transaction
	// that changes it, once the body has arrived, and the answer is the row
	// as that transaction wrote it. The session is asked again first, and who
	// its account is now: a reset that ended it while the body was arriving is
	// a 401 (card 2253). A change that asks for the password is written
	// nowhere here (card 2751, D7).
	const asked = writeAs(locals, (caller) => {
		const user = requireUser(caller);
		const change = readScheduleChange(user, scheduleId, body);
		if (asks(change)) return { asks: true as const };
		// Last, with nothing awaited before the write.
		if (change.take) takeReportMail(user, change.take.n, change.take.spend);
		const row = writeChange(scheduleId, change.schedule, change.updates);
		// Said once committed, when something changed (card 2895, D3).
		const said: UnaskedScheduleChange = {};
		if (change.renamed) said.renamedFrom = change.schedule.name;
		if (change.retimed) said.retimed = true;
		if (change.turnedOff) said.turnedOff = true;
		if (change.narrowed) said.narrowedTo = REPORT_STATUS_FILTER_LABELS[parseStatusFilter(row.statusFilter)];
		if (change.removed.length > 0) said.removed = change.removed;
		if (Object.keys(said).length > 0) afterCommit(() => reportScheduleChanged(row, said));
		return { asks: false as const, row };
	});
	if (!asked.asks) return json(asked.row);

	const { userId, hash } = await confirmStepUp(locals, cookies, body, 'PUT /api/report-schedules/[id]', (caller) => {
		const user = requireUser(caller);
		const change = readScheduleChange(user, scheduleId, body);
		if (change.take) checkReportMail(user, change.take.n, change.take.spend);
	});

	// Read and decided again in the transaction that writes it, run only while
	// the stored hash is the one the password was checked against.
	const address = addressOf({ getClientAddress });
	const updated = await whilePasswordHolds(userId, hash, () =>
		writeAs(locals, (caller) => {
			const user = requireUser(caller);
			const change = readScheduleChange(user, scheduleId, body);
			// Last, with nothing awaited before the write.
			if (change.take) takeReportMail(user, change.take.n, change.take.spend);
			const row = writeChange(scheduleId, change.schedule, change.updates);
			if (asks(change)) {
				const said: ScheduleChange = {};
				if (change.added.length > 0) said.added = change.added;
				if (change.turnedOn) said.turnedOn = true;
				if (change.widened) said.widenedTo = REPORT_STATUS_FILTER_LABELS[parseStatusFilter(row.statusFilter)];
				afterCommit(() => reportScheduleSet(row, said, address));
			}
			return row;
		}));

	return json(updated);
};

/** Whether a change asks for the password and a code (card 2751, D2): it adds an address, turns the schedule on, or widens its filter. */
const asks = (change: ScheduleChangeRead) => change.added.length > 0 || change.turnedOn || change.widened;

/**
 * Write a change read by `readScheduleChange` to `before`, the row as it read it, and answer the row as written.
 * Switched on or off, and each address added or removed, recorded in this server's record of where it sends (card
 * 3004, O8; 3002-R12): a rename or a re-timing records nothing.
 */
function writeChange(scheduleId: number, before: typeof reportSchedules.$inferSelect, updates: Partial<typeof reportSchedules.$inferInsert>) {
	const row = db.update(reportSchedules)
		.set(updates)
		.where(eq(reportSchedules.id, scheduleId))
		.returning()
		.get();
	if (row !== undefined) recordScheduleWritten(sqlite, before, row);
	return row;
}

/** A change of a schedule as `readScheduleChange` reads it. */
type ScheduleChangeRead = ReturnType<typeof readScheduleChange>;

/**
 * A change to `user`'s schedule `scheduleId`, read from `body` against the
 * row as it is stored, with every refusal of it that needs no password: the
 * schedule (404), each field (400), the cap (400), turning one over the cap
 * on (400), and its timing (400). Answers the row, the updates, the
 * addresses it adds, whether it turns the schedule on or widens its status
 * filter, and what it takes from the day's report mail (`take`, null for
 * nothing). Reads only: asked in each transaction that decides, and in the
 * step-up's guard (card 2751, D5, D7).
 */
function readScheduleChange(user: SessionUser, scheduleId: number, body: RequestBody) {
	const schedule = db.select().from(reportSchedules)
		.where(and(eq(reportSchedules.id, scheduleId), eq(reportSchedules.userId, user.id)))
		.get();
	if (!schedule) throw error(404, 'Schedule not found');

	// Each as the scheduler reads it. A value stored before these were checked
	// is kept when the page sends it back. `frequency` keeps the words of the
	// route that creates a schedule; an unknown one used to be ignored, and
	// `dayOfMonth` above 28 was read as 28.
	const updates: Partial<typeof reportSchedules.$inferInsert> = { updatedAt: stamp() };
	const enabled = readBoolean(body, 'enabled', { keep: schedule.enabled });
	if (enabled !== undefined) updates.enabled = enabled;
	const name = readText(body, 'name', { trim: true, min: 1, max: 200, keep: schedule.name });
	if (name !== undefined) updates.name = name;
	const frequency = readChoice(body, 'frequency', {
		from: FREQUENCIES,
		keep: schedule.frequency,
		says: 'Invalid frequency. Must be: weekly or monthly'
	});
	if (frequency !== undefined) updates.frequency = frequency;
	const dayOfWeek = readNumber(body, 'dayOfWeek', { whole: true, min: 0, max: 6, keep: schedule.dayOfWeek });
	if (dayOfWeek !== undefined) updates.dayOfWeek = dayOfWeek;
	const dayOfMonth = readNumber(body, 'dayOfMonth', { whole: true, min: 1, max: 28, keep: schedule.dayOfMonth });
	if (dayOfMonth !== undefined) updates.dayOfMonth = dayOfMonth;
	// Empty is 09:00, as the scheduler reads it.
	const timeOfDay = readTime(body, 'timeOfDay', { empty: '09:00', keep: schedule.timeOfDay });
	if (timeOfDay !== undefined) updates.timeOfDay = timeOfDay;
	// Stored as the server names the zone, so `europe/london` sent for a
	// schedule in Europe/London is no change.
	const timeZone = readTimeZone(body, 'timeZone', { keep: schedule.timeZone });
	if (timeZone !== undefined) updates.timeZone = timeZone;
	// A list sent back as it is stored is kept as it is, unchecked: a page
	// that sends the row back can still switch an over-cap schedule off.
	const recipients = readReportRecipients(body, 'recipients', { keep: schedule.recipients });
	if (recipients !== undefined) updates.recipients = recipients;
	const statusFilter = readChoice(body, 'statusFilter', { from: REPORT_STATUS_FILTERS, keep: schedule.statusFilter });
	if (statusFilter !== undefined) updates.statusFilter = statusFilter;

	const addressCount = reportRecipients(updates.recipients ?? schedule.recipients).addresses.length;
	const listChanged = recipients !== undefined && recipients !== schedule.recipients;
	if (listChanged && addressCount > MAX_REPORT_RECIPIENTS) {
		throw error(400, `A schedule can be sent to at most ${MAX_REPORT_RECIPIENTS} addresses, and this names ${addressCount}. The schedule was not changed.`);
	}
	// Only turning one on: `enabled: true` sent back for a schedule that is
	// on already is the row as a page sends it (the review's O4).
	const turnedOn = enabled === true && !schedule.enabled;
	if (turnedOn && addressCount > MAX_REPORT_RECIPIENTS) {
		throw error(400, `This schedule cannot be turned on: ${overCapScheduleWords(addressCount)}. Delete it and make it again with at most ${MAX_REPORT_RECIPIENTS}.`);
	}

	// Re-timed: a new frequency, day, time or zone.
	const retimed =
		(frequency !== undefined && frequency !== schedule.frequency) ||
		(dayOfWeek !== undefined && dayOfWeek !== schedule.dayOfWeek) ||
		(dayOfMonth !== undefined && dayOfMonth !== schedule.dayOfMonth) ||
		(timeOfDay !== undefined && timeOfDay !== schedule.timeOfDay) ||
		(timeZone !== undefined && timeZone !== schedule.timeZone);

	// Turned on, or re-timed: the next run is worked out again from now, in
	// the schedule's zone (card 2159, decision 12). It used to stay where it
	// was, so the old time was sent once more after a change, and a schedule
	// turned back on was sent at the next tick for a run missed while it was
	// off. Any other change leaves it: a rename does not move a run that is
	// due. A timing the scheduler cannot date is refused, with nothing
	// changed and nothing taken from the day's report mail.
	if (turnedOn || retimed) {
		const next = nextRunAfter({ ...schedule, ...updates }, new Date());
		if ('fault' in next) {
			throw error(
				400,
				turnedOn
					? `This schedule cannot be turned on: ${next.fault}. Turn it on with a time, day and zone that can be read, or delete it and make it again.`
					: `The schedule was not changed: ${next.fault}`
			);
		}
		updates.nextRunAt = stamp(next.at);
	}

	// The addresses the list adds: those not in the stored list, both read as
	// the scheduler reads them, so that a list sent back in another order or
	// case, or cut down, adds none, and a swap adds one (card 2751, D2).
	const had = new Set(reportRecipients(schedule.recipients).addresses);
	const added = listChanged ? reportRecipients(recipients).addresses.filter((address) => !had.has(address)) : [];
	// Widened (card 2751, S2): a new status filter, from one that is not `all`
	// as the scheduler reads the stored one. The narrow filters are disjoint
	// parts of `all`, so a move between them, or to `all`, mails cards the
	// owner did not confirm; a move from `all` mails fewer.
	const widened = statusFilter !== undefined && statusFilter !== schedule.statusFilter && parseStatusFilter(schedule.statusFilter) !== 'all';

	// What a change that asks nothing did, for its line (card 2895, D3): a new
	// name; turned off; a new filter that is not wider; and the addresses the
	// list takes off, those stored and not in the new list, read as the
	// scheduler reads both.
	const renamed = name !== undefined && name !== schedule.name;
	const turnedOff = enabled === false && schedule.enabled;
	const narrowed = statusFilter !== undefined && statusFilter !== schedule.statusFilter && !widened;
	const kept = listChanged ? new Set(reportRecipients(recipients).addresses) : had;
	const removed = [...had].filter((address) => !kept.has(address));

	// Turned on, or re-timed while it stays on: either can bring a send
	// forward, and takes every address. A schedule that is off after the
	// change sends nothing, and turning it on later pays then (the review's
	// O-N2). Otherwise a changed list takes the ones it adds. Taken at the
	// write, last, with nothing awaited before it; read with nothing taken in
	// the step-up's guard.
	const take: { n: number; spend: ReportMailSpend } | null =
		(turnedOn || retimed) && (updates.enabled ?? schedule.enabled)
			? { n: addressCount, spend: 'changed schedule' }
			: listChanged
				? { n: added.length, spend: 'new recipients' }
				: null;

	// An address added or taken off is recorded by a keyed digest (card 3004's code review, NF-S4d): with no MFA key
	// loaded, 503, nothing saved and nothing taken from the day's report mail, a removal alone too, so that the record
	// misses no change.
	if (added.length + removed.length > 0) requireOutboundKey();

	return { schedule, updates, added, turnedOn, widened, take, renamed, retimed, turnedOff, narrowed, removed };
}

/**
 * DELETE — remove a schedule of the caller's own: looked for, and deleted, in
 * one transaction that asks first whether the session is still open (card
 * 2253). It asked nothing: a session ended by a reset could still delete.
 * Once committed, one INFO line names it and the addresses it was sent to
 * (`reportScheduleDeleted`, card 2895).
 */
export const DELETE: RequestHandler = async ({ locals, params }) => {
	requireUser(locals.user);

	const scheduleId = pathId(params.id, 'schedule');
	writeAs(locals, (caller) => {
		const user = requireUser(caller);
		const schedule = db.select().from(reportSchedules)
			.where(and(eq(reportSchedules.id, scheduleId), eq(reportSchedules.userId, user.id)))
			.get();

		if (!schedule) throw error(404, 'Schedule not found');

		// Recorded `deleted` while it can be read (card 3004, O9): a restore of an older backup brings it back paused.
		recordSchedulesAs(sqlite, [scheduleId], 'deleted');
		db.delete(reportSchedules).where(eq(reportSchedules.id, scheduleId)).run();
		afterCommit(() => reportScheduleDeleted(schedule));
	});
	return json({ success: true });
};
