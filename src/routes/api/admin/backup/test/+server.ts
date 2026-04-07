/**
 * /api/admin/backup/test — Test a destination connection.
 */

import { json, error } from '@sveltejs/kit';
import { createDestination, type DestinationConfig } from '$lib/server/backup-destinations';
import { getBackupConfig } from '$lib/server/backup';
import type { RequestHandler } from './$types';

/** POST — Test a specific destination connection. */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user || (locals.user.role !== 'admin' && locals.user.role !== 'superadmin')) {
		throw error(403, 'Forbidden');
	}

	const body = await request.json();
	const destConfig = body as DestinationConfig;

	if (!destConfig.type || !destConfig.name) {
		throw error(400, 'Missing destination type or name');
	}

	// If secrets are masked, pull from existing config
	const existing = getBackupConfig();
	const existingDest = existing.destinations.find(d => d.name === destConfig.name);

	if (existingDest) {
		const merged = destConfig as unknown as Record<string, unknown>;
		if (merged.password === '••••••••') merged.password = (existingDest as any).password || '';
		if (merged.privateKey === '••••••••') merged.privateKey = (existingDest as any).privateKey || '';
		if (merged.secretAccessKey === '••••••••') merged.secretAccessKey = (existingDest as any).secretAccessKey || '';
		if (merged.clientSecret === '••••••••') merged.clientSecret = (existingDest as any).clientSecret || '';
		if (typeof merged.serviceAccountJson === 'string' && (merged.serviceAccountJson as string).includes('••••••••')) {
			merged.serviceAccountJson = (existingDest as any).serviceAccountJson || '';
		}
	}

	try {
		const dest = createDestination(destConfig);
		const result = await dest.test();
		return json(result);
	} catch (err: any) {
		return json({ success: false, message: err.message || 'Test failed' });
	}
};
