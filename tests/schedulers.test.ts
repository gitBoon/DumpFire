/**
 * Whether an instance runs its schedulers: what SCHEDULERS means in each mode.
 *
 * An instance acts on whatever its database says, so a dev server holding a
 * copy of production's data would back up to production's destination, prune
 * the backups there and send production's reports. The schedulers are therefore
 * off under the dev server unless they are asked for, and that default is what
 * these tests guard: nothing else would say it had flipped until a backup went
 * out.
 *
 * Only the decision is tested. `startSchedulers` is never called, so no
 * scheduler is started here. That `hooks.server.ts` makes the one call is not
 * covered: the suite does not load that file.
 */
import { describe, expect, it } from 'vitest';
import { schedulerSetting } from '$lib/server/schedulers';

/** The two modes, as `isDev`. */
const MODES: [string, boolean][] = [
	['under the dev server', true],
	['in a built server', false]
];

/** What each mode does when SCHEDULERS does not decide. */
const defaultFor = (isDev: boolean) =>
	isDev
		? { run: false, reason: 'this is the dev server' }
		: { run: true, reason: 'the default for a built server' };

describe('SCHEDULERS not set', () => {
	it('runs the schedulers in a built server', () => {
		expect(schedulerSetting(undefined, false)).toEqual({
			run: true,
			reason: 'the default for a built server',
			unrecognised: null
		});
	});

	it('does not run them under the dev server', () => {
		expect(schedulerSetting(undefined, true)).toEqual({
			run: false,
			reason: 'this is the dev server',
			unrecognised: null
		});
	});
});

describe.each(MODES)('SCHEDULERS set to on or off, %s', (_mode, isDev) => {
	it('runs them when it is on', () => {
		expect(schedulerSetting('on', isDev)).toEqual({ run: true, reason: 'SCHEDULERS=on', unrecognised: null });
	});

	it('does not run them when it is off', () => {
		expect(schedulerSetting('off', isDev)).toEqual({ run: false, reason: 'SCHEDULERS=off', unrecognised: null });
	});

	it.each<[string, boolean, string]>([
		[' ON ', true, 'SCHEDULERS=on'],
		['On', true, 'SCHEDULERS=on'],
		['Off', false, 'SCHEDULERS=off'],
		['\tOFF\n', false, 'SCHEDULERS=off']
	])('ignores case and surrounding spaces: %j', (value, run, reason) => {
		expect(schedulerSetting(value, isDev)).toEqual({ run, reason, unrecognised: null });
	});
});

describe.each(MODES)('SCHEDULERS set to nothing, %s', (_mode, isDev) => {
	it.each(['', '   ', '\t\n'])('is treated as not set: %j', (value) => {
		// Not reported as unrecognised: a variable left empty has not been misspelt.
		expect(schedulerSetting(value, isDev)).toEqual({ ...defaultFor(isDev), unrecognised: null });
	});
});

describe.each(MODES)('SCHEDULERS set to something that is neither on nor off, %s', (_mode, isDev) => {
	it.each(['true', '0', 'yes'])('falls back to the default for the mode and hands the value back: %j', (value) => {
		// 'true' and 'yes' do not turn the schedulers on under the dev server, and
		// '0' does not turn them off in a built one. Only on and off are understood.
		expect(schedulerSetting(value, isDev)).toEqual({ ...defaultFor(isDev), unrecognised: value });
	});

	it('hands the value back exactly as it was given, spaces and case included', () => {
		expect(schedulerSetting(' Yes ', isDev).unrecognised).toBe(' Yes ');
	});
});

describe('the reason', () => {
	// When the schedulers are off, the reason is printed in the log line that
	// says so, and it is the only account of why nothing is being scheduled.
	it('is one of four, and names what decided', () => {
		expect(schedulerSetting('on', true).reason).toBe('SCHEDULERS=on');
		expect(schedulerSetting('off', false).reason).toBe('SCHEDULERS=off');
		expect(schedulerSetting(undefined, true).reason).toBe('this is the dev server');
		expect(schedulerSetting(undefined, false).reason).toBe('the default for a built server');
	});

	it('is the same for an unrecognised value as for none', () => {
		expect(schedulerSetting('enabled', true).reason).toBe('this is the dev server');
		expect(schedulerSetting('enabled', false).reason).toBe('the default for a built server');
	});
});
