/**
 * /api/admin/backup/test — Test a destination connection.
 *
 * The superadmin's alone: see `/api/admin/backup`. A test of a destination
 * whose secrets are masked connects with the stored ones only when it is the
 * stored destination they were saved with, the same in type, name and every
 * field that is not secret (card 2190, `keepMaskedSecrets`); otherwise it is
 * refused, as a save is. The admin page tests only saved destinations, so its
 * Test button is unchanged.
 */

import { error, json } from '@sveltejs/kit';
import { createDestination, readDestination } from '$lib/server/backup-destinations';
import { getBackupConfig } from '$lib/server/backup';
import { keepMaskedSecrets } from '$lib/server/backup-secrets';
import { readBody } from '$lib/server/request-body';
import { requireSuperadmin } from '$lib/server/route-guards';
import type { RequestHandler } from './$types';
import { createLogger } from '$lib/server/logger';

const log = createLogger('BACKUP');

/** POST — Test a specific destination connection. */
export const POST: RequestHandler = async ({ request, locals }) => {
	requireSuperadmin(locals.user);

	// The destination, read as PUT /api/admin/backup reads one (card 2117,
	// R10): its fields by its type, and a secret sent masked kept as the save
	// keeps it (card 2190), or refused with its words.
	const body = await readBody(request);
	const existing = getBackupConfig();
	const sent = readDestination(
		body,
		null,
		(name) => existing.destinations.find((d) => d.name === name),
		'Missing destination type or name'
	);
	const kept = keepMaskedSecrets(sent, existing.destinations);
	if ('refusal' in kept) throw error(400, kept.refusal);
	const destConfig = kept.destination;

	try {
		const dest = createDestination(destConfig);
		const result = await dest.test();
		return json(result);
	} catch (err: any) {
		log.error(`Destination test failed for "${destConfig.name}" (${destConfig.type}): ${err.message}`);
		return json({ success: false, message: err.message || 'Test failed' });
	}
};
