/**
 * /api/admin/backup — Backup config, history, and manual trigger.
 *
 * Every administrator's, every method, and so are the two routes beneath it
 * (card 2395, at the owner's request: the superadmin's alone before). Whoever
 * may add a destination may add one of their own and have the whole database
 * sent to it, every password hash and email address included. Who saved the
 * settings is not kept with them: they stay in force when that account is
 * demoted or deleted, as they always did for the superadmin's.
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
	SCHEDULE_INTERVALS,
	type BackupConfig
} from '$lib/server/backup';
import { readDestination } from '$lib/server/backup-destinations';
import {
	hostKeyChanges,
	keepMaskedSecrets,
	maskDestination,
	quotedName as quoted,
	settingsChanges,
	twiceNamed,
	type BackupSettingsChanges,
	type HostKeyChange
} from '$lib/server/backup-secrets';
import { afterCommit } from '$lib/server/db/transaction';
import { createLogger } from '$lib/server/logger';
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
import { requireAdmin } from '$lib/server/route-guards';
import { stillCallerNow, writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

const log = createLogger('BACKUP');

/**
 * The line a save writes for one SFTP host key it adds, changes or removes
 * (card 2267). It names the destination, its host and the keys, as the Test's
 * ERROR lines do, and no secret; the logger makes the name and host printable.
 * Where the same save moved the destination, the old key is named with the
 * place it was for (the card 2267 review).
 */
function hostKeyChangeLine(change: HostKeyChange): string {
	const at = `SFTP host key of destination ${quoted(change.name)} at ${change.host}:${change.port}`;
	const was = change.fromAt === undefined ? change.from : `${change.from} (at ${change.fromAt})`;
	if (change.removed) return `${at} removed with the destination: was ${was}`;
	if (change.from === '') return `${at} added: ${change.to}`;
	if (change.to === '') return `${at} cleared: was ${was}`;
	return `${at} changed from ${was} to ${change.to}`;
}

/**
 * The line a save writes for what it changed in the backup settings (card
 * 2270): each setting with its values, `notifyEmail` by name alone, and each
 * destination added, removed or changed, a changed one by the names of its
 * fields, never a value. A host key is named as a field, and its keys are left
 * to `hostKeyChangeLine` (decision 3).
 */
function settingsChangeLine(changes: BackupSettingsChanges): string {
	const parts = [
		...changes.settings.map((s) => ('from' in s ? `${s.field} from ${s.from} to ${s.to}` : s.field)),
		...changes.added.map((d) => `destination ${quoted(d.name)} added (${d.type})`),
		...changes.changed.map((d) => `destination ${quoted(d.name)} changed: ${d.fields.join(', ')}`),
		...changes.removed.map((d) => `destination ${quoted(d.name)} removed (${d.type})`)
	];
	return `Backup settings changed: ${parts.join('; ')}`;
}

/**
 * How long the copies kept at each destination reach back: the retention
 * times the schedule's interval, none for `disabled` or a schedule this
 * version does not know (the card 2270 review).
 */
function timeKept(config: BackupConfig): number {
	const interval = Object.hasOwn(SCHEDULE_INTERVALS, config.schedule) ? SCHEDULE_INTERVALS[config.schedule] : 0;
	return (Number(config.retention) || 0) * interval;
}

/**
 * Whether a save leaves fewer copies, or sends them elsewhere (card 2270,
 * decision 1, as its review ruled): a destination removed or saved as another
 * type; a destination kept whose account or place changed (`elsewhere`); less
 * time covered by the copies kept (`timeKept`), which is the schedule switched
 * off or made more frequent; or the retention lowered, which the next run,
 * a Run Now under `disabled` too, keeps to at every destination, deleting the
 * older copies. Such a line is a WARN, any other an INFO.
 */
function leavesFewerCopies(before: BackupConfig, after: BackupConfig, changes: BackupSettingsChanges): boolean {
	return (
		changes.removed.length > 0 ||
		changes.changed.some((d) => d.elsewhere) ||
		timeKept(after) < timeKept(before) ||
		Number(after.retention) < Number(before.retention)
	);
}

/** GET — Return backup config and recent history. */
export const GET: RequestHandler = async ({ locals }) => {
	requireAdmin(locals.user);

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
 *
 * A save that changes anything is one line under BACKUP, filed under the
 * account that saved it, naming what changed (card 2270): a WARN where it
 * leaves fewer copies or sends them elsewhere (a destination removed, one
 * kept pointed at another account or place, or less time covered by the
 * copies kept: the retention lowered, the schedule switched off or made more
 * frequent), an INFO otherwise. Each SFTP host key the save adds,
 * changes, clears or removes with its destination is one WARN line after it
 * (card 2267), so a key confirmed and later put back leaves both changes on
 * record. A save that changes nothing, is refused or fails writes none.
 */
export const PUT: RequestHandler = async ({ request, locals }) => {
	requireAdmin(locals.user);
	const body = await readBody(request);

	// One transaction: the settings are read and written in it, so what is
	// kept is what is there when the change is written. It asks first whether
	// the session is still open and whether its account is still an
	// administrator (cards 2253 and 2395), and the lines are filed under that
	// account.
	writeAs(locals, (caller) => {
		const user = requireAdmin(caller);
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

		// After the commit, not here: the logger writes a row logged inside a
		// transaction whichever way it ends, and a save that fails would leave
		// a line for a change it never saved (cards 2267 and 2270). The line for
		// the whole save is queued first, so it reads before the key lines.
		const changed = settingsChanges(existing, config);
		if (changed !== null) {
			const write = leavesFewerCopies(existing, config, changed) ? log.warn : log.info;
			afterCommit(() => write(settingsChangeLine(changed), changed, { userId: user.id }));
		}
		const changes = destinations === undefined ? [] : hostKeyChanges(existing.destinations, config.destinations);
		for (const change of changes) {
			afterCommit(() =>
				log.warn(
					hostKeyChangeLine(change),
					{ destination: change.name, from: change.from, to: change.to, ...(change.fromAt === undefined ? {} : { fromAt: change.fromAt }) },
					{ userId: user.id }
				)
			);
		}

		saveBackupConfig(config);
	});

	return json({ success: true });
};

/** POST — Trigger an immediate manual backup. */
export const POST: RequestHandler = async ({ request, locals }) => {
	requireAdmin(locals.user);

	// A body that is missing, is not JSON or is not an object is a 400, and one
	// over the limit a 413 (`guardBody`): a failed read used to be swallowed,
	// and ran a backup to every destination (card 2117, decision 19). The page
	// sends `{}`, which backs up to every destination; `destination` names one.
	const body = await readBody(request);
	// Asked again once the body is in, with nothing awaited before the backup
	// starts (card 2253): a session that has ended, or an account that is no
	// longer an administrator, sends the database nowhere.
	requireAdmin(stillCallerNow(locals));
	const targetDestination = readText(body, 'destination', {});

	const results = await runBackup(targetDestination);

	return json({ results });
};
