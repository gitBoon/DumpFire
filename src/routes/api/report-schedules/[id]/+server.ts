/**
 * Report Schedule detail API — Update or delete a schedule.
 *
 * PUT    /api/report-schedules/:id  — Update schedule (enable/disable, change frequency)
 * DELETE /api/report-schedules/:id  — Delete a schedule
 */

import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { reportSchedules } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';
import { overCapScheduleWords, REPORT_STATUS_FILTERS, takeReportMail } from '$lib/server/reports';
import { requireUser } from '$lib/server/route-guards';
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
	readTimeZone
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
 */
export const PUT: RequestHandler = async ({ locals, params, request }) => {
	// A quick refusal, binding no name: who the caller is is decided below.
	requireUser(locals.user);

	const scheduleId = pathId(params.id, 'schedule');
	const body = await readBody(request);

	// The schedule is looked for among the caller's own in the transaction
	// that changes it, once the body has arrived, and the answer is the row
	// as that transaction wrote it. The session is asked again first, and who
	// its account is now: a reset that ended it while the body was arriving is
	// a 401 (card 2253).
	const updated = writeAs(locals, (caller) => {
		const user = requireUser(caller);
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
		if (recipients !== undefined && recipients !== schedule.recipients && addressCount > MAX_REPORT_RECIPIENTS) {
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

		// Turned on, or re-timed while it stays on: either can bring a send
		// forward, and takes every address. A schedule that is off after the
		// change sends nothing, and turning it on later pays then (the review's
		// O-N2). Otherwise a changed list takes the ones it adds. Last, with
		// nothing awaited before the write.
		if ((turnedOn || retimed) && (updates.enabled ?? schedule.enabled)) {
			takeReportMail(user, addressCount, 'changed schedule');
		} else if (recipients !== undefined && recipients !== schedule.recipients) {
			const had = new Set(reportRecipients(schedule.recipients).addresses);
			const added = reportRecipients(recipients).addresses.filter((address) => !had.has(address)).length;
			takeReportMail(user, added, 'new recipients');
		}

		return db.update(reportSchedules)
			.set(updates)
			.where(eq(reportSchedules.id, scheduleId))
			.returning()
			.get();
	});

	return json(updated);
};

/**
 * DELETE — remove a schedule of the caller's own: looked for, and deleted, in
 * one transaction that asks first whether the session is still open (card
 * 2253). It asked nothing: a session ended by a reset could still delete.
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

		db.delete(reportSchedules).where(eq(reportSchedules.id, scheduleId)).run();
	});
	return json({ success: true });
};
