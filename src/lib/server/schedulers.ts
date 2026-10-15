/**
 * schedulers.ts — whether this instance runs its schedulers, decided in one place.
 *
 * An instance acts on whatever its database says. A copy of production's data,
 * started anywhere, holds production's backup destinations, report schedules
 * and mail settings. Left to run, it would back up to production's destination,
 * prune the backups already there and send production's reports.
 *
 * So the schedulers are off under the dev server unless they are asked for, and
 * a rehearsal sets SCHEDULERS=off. A built server runs them unless it is told
 * not to.
 *
 * Two things this does not cover:
 *
 * - The log maintenance timer stays on. It only deletes old rows from this
 *   database.
 * - Email and webhooks sent in answer to an action are not schedulers and are
 *   not affected.
 */
import { dev } from '$app/environment';
import { initBackupScheduler } from './backup';
import { createLogger } from './logger';
import { initReportScheduler } from './reports';
import { initSnapshotScheduler } from './snapshots';

const log = createLogger('SCHEDULERS');

export type SchedulerSetting = {
	/** Whether the schedulers are to run. */
	run: boolean;
	/** What decided it, worded to go inside a log line. */
	reason: string;
	/** SCHEDULERS as it was given, if it was neither on nor off. Otherwise `null`. */
	unrecognised: string | null;
};

/**
 * What a value of SCHEDULERS means, under the dev server or in a built one.
 *
 * `on` and `off` decide, whatever the case or surrounding space. Unset or empty
 * gives the default for the mode. So does anything else, and the value is
 * handed back in `unrecognised` so the caller can say it was not understood: a
 * misspelt `off` must not pass for one in silence.
 *
 * Nothing is logged and nothing is started here, so this can be tested.
 */
export function schedulerSetting(value: string | undefined, isDev: boolean): SchedulerSetting {
	const asked = (value ?? '').trim().toLowerCase();
	if (asked === 'on') return { run: true, reason: 'SCHEDULERS=on', unrecognised: null };
	if (asked === 'off') return { run: false, reason: 'SCHEDULERS=off', unrecognised: null };

	const unrecognised = value !== undefined && asked !== '' ? value : null;
	return isDev
		? { run: false, reason: 'this is the dev server', unrecognised }
		: { run: true, reason: 'the default for a built server', unrecognised };
}

/**
 * Start the backup, report and snapshot schedulers, or none of them.
 *
 * Called once, from hooks.server.ts, as the server loads. Importing this module
 * starts nothing.
 */
export function startSchedulers(
	value: string | undefined = process.env.SCHEDULERS,
	isDev: boolean = dev
): SchedulerSetting {
	const setting = schedulerSetting(value, isDev);

	if (setting.unrecognised !== null) {
		log.error(
			`SCHEDULERS is set to "${setting.unrecognised}", which is neither on nor off. ` +
				`Using the default for ${isDev ? 'the dev server' : 'a built server'}: ${setting.run ? 'on' : 'off'}.`
		);
	}

	if (setting.run) {
		// Nothing is logged here: each of these says that it was initialised.
		initBackupScheduler();
		initReportScheduler();
		initSnapshotScheduler();
	} else {
		log.warn(
			`Schedulers are off (${setting.reason}). No scheduled backup, report or snapshot ` +
				'will run from this instance. Set SCHEDULERS=on to run them.'
		);
	}

	return setting;
}
