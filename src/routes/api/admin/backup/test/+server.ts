/**
 * /api/admin/backup/test — Test a destination connection.
 *
 * Every administrator's: see `/api/admin/backup`. A Test runs only a saved
 * destination, exactly as it is stored (card 2939, ruling P3,
 * `destinationToTest`): sent with no secret typed, the same in type, name and
 * every field that is not secret as the one stored entry of its name, and it
 * is that stored entry that is tested, never what was sent. Anything else is
 * 400 "Save the destination first, then Test it."; a masked destination
 * pointed elsewhere keeps the save's own refusal (card 2190,
 * `keepMaskedSecrets`). An SFTP destination's host key must be the stored one
 * exactly, none where none is stored (the card 2250 review's M1): only a save
 * may add a key (Confirm saves, then tests). So no address, endpoint, folder,
 * key or credential typed into a Test is ever connected to: a Test reaches
 * only where a save, with its step-up, has already pointed. The admin page
 * tests only saved destinations, so its Test button is unchanged.
 *
 * An SFTP Test answers, beside `success` and `message`, the host key the
 * server presented (`hostKey`) where none is confirmed or it did not match,
 * and the confirmed one (`confirmedHostKey`) where a key was refused (card
 * 2250, decision 10 and R3); a refusal is one ERROR line. With no key
 * confirmed, nothing secret is sent: the Test only looks at the key.
 */

import { error, json } from '@sveltejs/kit';
import { HostKeySignatureFailed, createDestination, readDestination, type SftpTestResult } from '$lib/server/backup-destinations';
import { destinationHeldWordsNow, getBackupConfig } from '$lib/server/backup';
import { destinationToTest } from '$lib/server/backup-secrets';
import { TYPED_SECRET_LOOKS_SEALED, destinationLooksSealed, unopenableFields } from '$lib/server/stored-secrets';
import { readBody } from '$lib/server/request-body';
import { requireAdmin } from '$lib/server/route-guards';
import { stillCallerNow } from '$lib/server/write-as';
import type { RequestHandler } from './$types';
import { createLogger } from '$lib/server/logger';

const log = createLogger('BACKUP');

/** The fingerprint of a host key as a Test answers it, `<type> SHA256:…`: the part after its last space. */
const fingerprintPart = (key: string) => key.slice(key.lastIndexOf(' ') + 1);

/** POST — Test a specific destination connection. */
export const POST: RequestHandler = async ({ request, locals }) => {
	requireAdmin(locals.user);

	// The destination, read as PUT /api/admin/backup reads one (card 2117,
	// R10): its fields by its type, and a secret sent masked kept as the save
	// keeps it (card 2190), or refused with its words.
	const body = await readBody(request);
	// Asked again once the body is in, with nothing awaited before the
	// destination is made and a stored secret can leave with it (card 2253):
	// a session that has ended, or an account that is no longer an
	// administrator, connects to nothing. The Test writes nothing. Its lines
	// are filed under the administrator who asked, as the Connect's and the
	// backup settings' are.
	const byCaller = { userId: requireAdmin(stillCallerNow(locals)).id };
	const existing = getBackupConfig();
	const sent = readDestination(
		body,
		null,
		(name) => existing.destinations.find((d) => d.name === name),
		'Missing destination type or name'
	);
	// A secret typed that looks sealed is refused (card 2898, S9): it would be taken for one.
	if (destinationLooksSealed(sent)) throw error(400, TYPED_SECRET_LOOKS_SEALED);
	// Only a saved destination is tested, exactly as it is stored (card 2939, ruling P3).
	const kept = destinationToTest(sent, existing.destinations);
	if ('refusal' in kept) throw error(400, kept.refusal);
	// Nor one held for the superadmin's review (card 2922): a Test reaches it, its credentials and all. Asked of the
	// stored entry about to be tested, with nothing awaited between this and the connect below.
	const held = destinationHeldWordsNow(kept.destination);
	if (held !== null) throw error(409, held);
	// A kept secret whose stored value does not open is no secret to test
	// with, and an SFTP Test without it would try none (card 2898's code review, E2, S3).
	if (unopenableFields(kept.destination).length > 0) {
		throw error(400, `Backup destination "${String(kept.destination.name ?? '')}": type its credentials again. The saved ones cannot be opened with this server's MFA key.`);
	}
	const destConfig = kept.destination;

	try {
		const dest = createDestination(destConfig);
		const result: SftpTestResult = await dest.test();
		// An SFTP host key refused (card 2250): one ERROR line, naming both keys
		// for a key that did not match, and the confirmed one for a server that
		// no longer offers a key of its type. The answer is as the Test gave it.
		if (destConfig.type === 'sftp' && result.confirmedHostKey !== undefined) {
			const at = `destination "${destConfig.name}" at ${destConfig.host}:${destConfig.port || 22}`;
			log.error(
				result.hostKey !== undefined
					? `SFTP host key mismatch for ${at}: presented ${fingerprintPart(result.hostKey)}, confirmed ${fingerprintPart(result.confirmedHostKey)}. Nothing was sent.`
					: `SFTP host key type not offered for ${at}: confirmed ${result.confirmedHostKey}. Nothing was sent.`,
				undefined,
				byCaller
			);
		}
		return json(result);
	} catch (err: any) {
		// The confirmed key shown by a server that could not sign with it (the
		// review's S4): one ERROR line naming its fingerprint, and the answer R3's
		// keys have, the confirmed key and no Confirm.
		if (err instanceof HostKeySignatureFailed && destConfig.type === 'sftp') {
			log.error(
				`SFTP host key signature failed for destination "${destConfig.name}" at ${destConfig.host}:${destConfig.port || 22}: ` +
					`confirmed ${fingerprintPart(err.confirmed)}. Nothing was sent.`,
				undefined,
				byCaller
			);
			const answer: SftpTestResult = { success: false, message: err.message, confirmedHostKey: err.confirmed };
			return json(answer);
		}
		log.error(`Destination test failed for "${destConfig.name}" (${destConfig.type}): ${err.message}`, undefined, byCaller);
		return json({ success: false, message: err.message || 'Test failed' });
	}
};
