/**
 * /api/admin/backup — Backup config, history, and manual trigger.
 */

import { json, error } from '@sveltejs/kit';
import { getBackupConfig, saveBackupConfig, getBackupHistory, runBackup } from '$lib/server/backup';
import type { RequestHandler } from './$types';

/** GET — Return backup config and recent history. */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user || (locals.user.role !== 'admin' && locals.user.role !== 'superadmin')) {
		throw error(403, 'Forbidden');
	}

	const config = getBackupConfig();
	const history = getBackupHistory(30);

	// Mask sensitive credentials in destination configs
	const maskedDestinations = config.destinations.map(d => {
		const masked: Record<string, unknown> = { ...d };
		if ('password' in masked && masked.password) masked.password = '••••••••';
		if ('privateKey' in masked && masked.privateKey) masked.privateKey = '••••••••';
		if ('secretAccessKey' in masked && masked.secretAccessKey) masked.secretAccessKey = '••••••••';
		if ('clientSecret' in masked && masked.clientSecret) masked.clientSecret = '••••••••';
		if ('serviceAccountJson' in masked && masked.serviceAccountJson) {
			try {
				const parsed = JSON.parse(masked.serviceAccountJson as string);
				masked.serviceAccountJson = JSON.stringify({ ...parsed, private_key: '••••••••' });
			} catch {
				masked.serviceAccountJson = '••••••••';
			}
		}
		return masked;
	});

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

/** PUT — Save backup config (schedule + destinations). */
export const PUT: RequestHandler = async ({ request, locals }) => {
	if (!locals.user || (locals.user.role !== 'admin' && locals.user.role !== 'superadmin')) {
		throw error(403, 'Forbidden');
	}

	const data = await request.json();
	const existing = getBackupConfig();

	// Merge destinations — preserve existing secrets for masked fields
	const destinations = (data.destinations || []).map((newDest: Record<string, unknown>, i: number) => {
		const existingDest = existing.destinations.find(d => d.name === newDest.name) || existing.destinations[i];
		if (!existingDest) return newDest;

		const merged: Record<string, unknown> = { ...newDest };

		// Preserve masked secrets
		if (merged.password === '••••••••') merged.password = (existingDest as any).password || '';
		if (merged.privateKey === '••••••••') merged.privateKey = (existingDest as any).privateKey || '';
		if (merged.secretAccessKey === '••••••••') merged.secretAccessKey = (existingDest as any).secretAccessKey || '';
		if (merged.clientSecret === '••••••••') merged.clientSecret = (existingDest as any).clientSecret || '';
		if (typeof merged.serviceAccountJson === 'string' && merged.serviceAccountJson.includes('••••••••')) {
			merged.serviceAccountJson = (existingDest as any).serviceAccountJson || '';
		}

		return merged;
	});

	saveBackupConfig({
		schedule: data.schedule || 'disabled',
		scheduleTime: data.scheduleTime || '02:00',
		scheduleDay: data.scheduleDay ?? 0,
		retention: data.retention ?? 7,
		destinations,
		notifyOnFailure: data.notifyOnFailure ?? false,
		notifyEmail: data.notifyEmail || ''
	});

	return json({ success: true });
};

/** POST — Trigger an immediate manual backup. */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user || (locals.user.role !== 'admin' && locals.user.role !== 'superadmin')) {
		throw error(403, 'Forbidden');
	}

	const body = await request.json().catch(() => ({}));
	const targetDestination = (body as Record<string, unknown>).destination as string | undefined;

	const results = await runBackup(targetDestination);

	return json({ results });
};
