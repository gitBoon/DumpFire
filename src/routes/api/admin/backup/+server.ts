/**
 * /api/admin/backup — Backup config, history, and manual trigger.
 *
 * The superadmin's alone, every method, and so are the two routes beneath
 * it. Whoever may add a destination may add one of their own and have the
 * whole database sent to it.
 *
 * No secret leaves in an answer, and none is used anywhere but where it was
 * saved (cards 2187 and 2190). The GET masks every secret field, the Google
 * Drive refresh token included (`maskDestination`). A save that sends a secret
 * back masked keeps it only from the one stored destination that is the same
 * in type, name and every field that is not secret (`keepMaskedSecrets`), and
 * is refused otherwise: a destination renamed, or pointed at another host,
 * bucket, folder or path, needs its secret typed again, so a stored password
 * is never sent to a host it was not saved for.
 */

import { error, json } from '@sveltejs/kit';
import {
	BACKUP_SCHEDULES,
	getBackupConfig,
	saveBackupConfig,
	getBackupHistory,
	runBackup,
	type BackupConfig
} from '$lib/server/backup';
import { readDestination } from '$lib/server/backup-destinations';
import { keepMaskedSecrets, maskDestination, twiceNamed } from '$lib/server/backup-secrets';
import { inTransaction } from '$lib/server/db/transaction';
import {
	readBody,
	readBoolean,
	readChoice,
	readEmailText,
	readNumber,
	readObjects,
	readText,
	readTime
} from '$lib/server/request-body';
import { requireSuperadmin } from '$lib/server/route-guards';
import type { RequestHandler } from './$types';

/** GET — Return backup config and recent history. */
export const GET: RequestHandler = async ({ locals }) => {
	requireSuperadmin(locals.user);

	const config = getBackupConfig();
	const history = getBackupHistory(30);

	// Every secret field masked, by the one list (card 2187).
	const maskedDestinations = config.destinations.map(maskDestination);

	return json({
		schedule: config.schedule,
		scheduleTime: config.scheduleTime,
		scheduleDay: config.scheduleDay,
		retention: config.retention,
		notifyOnFailure: config.notifyOnFailure,
		notifyEmail: config.notifyEmail,
		destinations: maskedDestinations,
		history
	});
};

/**
 * PUT — Save backup config (schedule + destinations).
 *
 * What is sent is written over the settings, and what is not sent is kept
 * (card 2117, decision 19). A save of part of them used to write the defaults
 * over the rest: `{}` switched the schedule off and deleted every destination.
 * `{}` is a 400 now. Each field is read by its rule (R10), a value the settings
 * hold now kept as it is, sent back unchanged:
 *
 *     schedule         one of BACKUP_SCHEDULES
 *     scheduleTime     HH:MM; empty text is 02:00, as it was
 *     scheduleDay      0 to 6
 *     retention        a whole number from 1 to 100, as the page's input allows
 *     notifyOnFailure  true or false
 *     notifyEmail      email addresses, separated by commas, semicolons or
 *                      lines, stored separated by commas; empty text for none
 *     destinations     a list of destinations (readDestination): the whole list.
 *                      Two of one name are a 400 naming it (twiceNamed). A
 *                      secret sent masked is kept by keepMaskedSecrets, or
 *                      the save is a 400 naming the destination, what to
 *                      type again and what changed; nothing is written
 */
export const PUT: RequestHandler = async ({ request, locals }) => {
	requireSuperadmin(locals.user);
	const body = await readBody(request);

	// One transaction: the settings are read and written in it, so what is
	// kept is what is there when the change is written.
	inTransaction(() => {
		const existing = getBackupConfig();
		const config: BackupConfig = { ...existing };

		const schedule = readChoice(body, 'schedule', { from: BACKUP_SCHEDULES, keep: existing.schedule });
		if (schedule !== undefined) config.schedule = schedule;
		const scheduleTime = readTime(body, 'scheduleTime', { empty: '02:00', keep: existing.scheduleTime });
		if (scheduleTime !== undefined) config.scheduleTime = scheduleTime;
		const scheduleDay = readNumber(body, 'scheduleDay', { whole: true, min: 0, max: 6, keep: existing.scheduleDay });
		if (scheduleDay !== undefined) config.scheduleDay = scheduleDay;
		const retention = readNumber(body, 'retention', { whole: true, min: 1, max: 100, keep: existing.retention });
		if (retention !== undefined) config.retention = retention;
		const notifyOnFailure = readBoolean(body, 'notifyOnFailure', { keep: existing.notifyOnFailure });
		if (notifyOnFailure !== undefined) config.notifyOnFailure = notifyOnFailure;
		// One address or several, as the mailer sent to each (card 2117's second fix pass).
		const notifyEmail = readEmailText(body, 'notifyEmail', { keep: existing.notifyEmail });
		if (notifyEmail !== undefined) config.notifyEmail = notifyEmail;

		// Each read by its type, then a secret sent back masked kept from the one
		// stored destination that is the same in everything but its secrets,
		// never by its place in the list (card 2190): the first that cannot be
		// is the refusal, before anything is written.
		const destinations = readObjects(body, 'destinations', {});
		if (destinations !== undefined) {
			const read = destinations.map((entry, i) =>
				readDestination(entry, `destinations[${i}]`, (name) => existing.destinations.find((d) => d.name === name))
			);
			// Two of one name are refused (the review-fix pass's S4): a destination
			// is found by its name to connect, test and back up to.
			const twice = twiceNamed(read, existing.destinations);
			if (twice !== null) throw error(400, twice);
			config.destinations = read.map((sent) => {
				const kept = keepMaskedSecrets(sent, existing.destinations);
				if ('refusal' in kept) throw error(400, kept.refusal);
				return kept.destination;
			});
		}

		const sent = [schedule, scheduleTime, scheduleDay, retention, notifyOnFailure, notifyEmail, destinations];
		if (sent.every((value) => value === undefined)) throw error(400, 'No valid fields to update');

		saveBackupConfig(config);
	});

	return json({ success: true });
};

/** POST — Trigger an immediate manual backup. */
export const POST: RequestHandler = async ({ request, locals }) => {
	requireSuperadmin(locals.user);

	// A body that is missing, is not JSON or is not an object is a 400, and one
	// over the limit a 413 (`guardBody`): a failed read used to be swallowed,
	// and ran a backup to every destination (card 2117, decision 19). The page
	// sends `{}`, which backs up to every destination; `destination` names one.
	const body = await readBody(request);
	const targetDestination = readText(body, 'destination', {});

	const results = await runBackup(targetDestination);

	return json({ results });
};
