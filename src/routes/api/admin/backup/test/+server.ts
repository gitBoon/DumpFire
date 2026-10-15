/**
 * /api/admin/backup/test — Test a destination connection.
 *
 * The superadmin's alone: see `/api/admin/backup`. A test of a destination
 * whose secrets are masked connects with the stored ones, to whatever host
 * the request names.
 */

import { json } from '@sveltejs/kit';
import { createDestination, readDestination } from '$lib/server/backup-destinations';
import { getBackupConfig } from '$lib/server/backup';
import { readBody } from '$lib/server/request-body';
import { requireSuperadmin } from '$lib/server/route-guards';
import type { RequestHandler } from './$types';
import { createLogger } from '$lib/server/logger';

const log = createLogger('BACKUP');

/** POST — Test a specific destination connection. */
export const POST: RequestHandler = async ({ request, locals }) => {
	requireSuperadmin(locals.user);

	// The destination, read as PUT /api/admin/backup reads one (card 2117,
	// R10): its fields by its type, and a secret sent masked the one stored
	// under its name.
	const body = await readBody(request);
	const existing = getBackupConfig();
	const destConfig = readDestination(
		body,
		null,
		(name) => existing.destinations.find((d) => d.name === name),
		'Missing destination type or name'
	);

	try {
		const dest = createDestination(destConfig);
		const result = await dest.test();
		return json(result);
	} catch (err: any) {
		log.error(`Destination test failed for "${destConfig.name}" (${destConfig.type}): ${err.message}`);
		return json({ success: false, message: err.message || 'Test failed' });
	}
};
