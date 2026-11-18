/**
 * The ISO/IEC 27001:2022 checklist (card 2670): every Annex A control and
 * every clause 4 to 10, each with how far DumpFire meets it, the evidence in
 * this repository, and the cards that close what is still open. It is the one
 * source of `/admin/iso-27001`, and the in-application half of the ISO
 * register that a card closing a gap updates in its own commit (plan D9).
 *
 * Server-only on purpose (plan D2): it lists DumpFire's known weaknesses with
 * the files they are in. A module the page imported would be in a script
 * under `/_app/`, which anyone can fetch without signing in; kept here, it
 * reaches a browser only through the page's load, behind the gate and the
 * load's own administrator check.
 *
 * The standard's text is copyrighted: an item holds the control's title and
 * our own words, never the control or its guidance (plan D6).
 *
 * The rules `tests/iso-27001.test.ts` holds this to:
 *   - every Annex A control and every clause once, in the standard's order;
 *   - an `organisational` item is the organisation's, with no gap cards;
 *   - an `app` or `supports` item is DumpFire's, with evidence that exists
 *     (never under the git-ignored docs/planning/), a `supports` item says
 *     what the organisation must still do, and an `app` item says nothing of
 *     the kind;
 *   - only an organisational item is ever `not-applicable`;
 *   - a `partly-met` or `not-met` item names a gap card or an accepted risk,
 *     and a `met` item names neither.
 *
 * Keeping it current (plan D9, `docs/iso-27001-checklist.md`): a card that
 * closes a gap removes its number from `gapCards`, changes `status` once no
 * gap card is left and the evidence shows the control met, and moves
 * `CHECKED_ON`. A new gap is raised as a card first, and its number added.
 */

/** Where an item comes from: an Annex A control or a clause of the standard's body. */
export type IsoKind = 'annex-a' | 'clause';

/** An Annex A control's theme, by its chapter (5 to 8). Null for a clause. */
export type IsoTheme = 'organisational' | 'people' | 'physical' | 'technological';

/**
 * Who implements it: `app`, DumpFire itself; `supports`, DumpFire provides
 * part of it and the organisation does the rest; `organisational`, the
 * organisation alone.
 */
export type IsoApplicability = 'app' | 'supports' | 'organisational';

/**
 * How far it is met. `organisational` is for organisational items alone.
 * `not-applicable` is the organisation's decision, through its Statement of
 * Applicability, and carries its `reason`.
 */
export type IsoStatus = 'met' | 'partly-met' | 'not-met' | 'not-applicable' | 'organisational';

/** Who owns the item: DumpFire for app and supports items, the organisation for the rest. */
export type IsoOwner = 'DumpFire' | 'the organisation';

/**
 * A piece of evidence: a path from the repository's root, with a heading's
 * anchor in a Markdown file or a name that appears in a source file. Never a
 * line number, which every edit would make stale.
 */
export type IsoEvidence = { path: string; anchor?: string; symbol?: string };

/** A risk the organisation has accepted in place of closing a gap, where it is written down. */
export type IsoAcceptedRisk = { risk: string; path: string; anchor: string };

export type IsoItem = {
	/** `A.5.1` to `A.8.34` for Annex A; `4.1` to `10.2` for a clause. */
	ref: string;
	kind: IsoKind;
	/** The control's or clause's title, and no more of the standard's text. */
	title: string;
	theme: IsoTheme | null;
	applicability: IsoApplicability;
	status: IsoStatus;
	/** How DumpFire meets it, in our own words; for an organisational item, what DumpFire offers it. */
	how: string;
	evidence: IsoEvidence[];
	owner: IsoOwner;
	/** The cards that close what is still open, as numbers on the DumpFire board. */
	gapCards: number[];
	accepted?: IsoAcceptedRisk[];
	/** What the organisation must still do. Required for a `supports` item, and never on an `app` one: an item with an organisation's part is `supports`. */
	organisationalPart?: string;
	/** Why it does not apply. Required for `not-applicable`. */
	reason?: string;
};

/** The day every status below was last checked against the code. */
export const CHECKED_ON = '2026-11-18';

/** Every status, in the order the page counts them. */
export const STATUSES: readonly IsoStatus[] = ['met', 'partly-met', 'not-met', 'not-applicable', 'organisational'];

/** The words an organisational item says of DumpFire, where it offers nothing more. */
const NOT_DUMPFIRE = 'Not something DumpFire does: the organisation meets it.';

/**
 * An organisational item: the organisation's, owner and status so, no gap
 * card. `offers.how` and `offers.evidence` name what DumpFire gives it to
 * use, without claiming the control; `offers.note` is a note of our own on
 * the item (plan D5).
 */
function organisational(ref: string, kind: IsoKind, title: string, offers?: { how?: string; evidence?: IsoEvidence[]; note?: string }): IsoItem {
	const parts = [NOT_DUMPFIRE];
	if (offers?.how) parts.push(`DumpFire offers evidence for it: ${offers.how}`);
	if (offers?.note) parts.push(offers.note);
	return {
		ref,
		kind,
		title,
		theme: kind === 'clause' ? null : themeOf(ref),
		applicability: 'organisational',
		status: 'organisational',
		how: parts.join(' '),
		evidence: offers?.evidence ?? [],
		owner: 'the organisation',
		gapCards: []
	};
}

/** An Annex A control's theme, from its chapter. */
function themeOf(ref: string): IsoTheme {
	const chapter = ref.split('.')[1];
	if (chapter === '5') return 'organisational';
	if (chapter === '6') return 'people';
	if (chapter === '7') return 'physical';
	return 'technological';
}

const AUTH_DOC = 'docs/authentication-security.md';
const BACKUP_DOC = 'docs/backup-reporting.md';
const ADMIN_DOC = 'docs/admin-guide.md';
const ACCEPTED_RISKS = { path: AUTH_DOC, anchor: 'accepted-risks' };

/**
 * The checklist: the 93 Annex A controls in order, then the 23 clauses. The
 * application side was checked against the code at `CHECKED_ON`.
 */
export const CHECKLIST: readonly IsoItem[] = [
	// ─── A.5 Organisational controls ────────────────────────────────────────
	organisational('A.5.1', 'annex-a', 'Policies for information security'),
	organisational('A.5.2', 'annex-a', 'Information security roles and responsibilities'),
	{
		ref: 'A.5.3',
		kind: 'annex-a',
		title: 'Segregation of duties',
		theme: 'organisational',
		applicability: 'supports',
		status: 'partly-met',
		how:
			'Export, import and Reset Everything are the superadmin\'s alone, as are lowering Keep Last, removing a backup destination and switching the failure mail off, ' +
			'and, since card 2847, setting the App URL that every mailed link begins with, which must also be on the address the server\'s configuration names where it names one. ' +
			'Any administrator can still add a backup destination of their own and Run Now, which sends it a full copy of the database, and whoever sets the mail server reads every mail (card 2906, to be ruled).',
		evidence: [
			{ path: 'src/routes/api/admin/export/+server.ts', symbol: 'requireSuperadmin' },
			{ path: 'src/lib/server/route-guards.ts', symbol: 'requireSuperadmin' },
			{ path: 'src/routes/api/admin/smtp/+server.ts', symbol: 'APP_URL_NEEDS_SUPERADMIN' },
			{ path: ADMIN_DOC, anchor: 'who-may-do-what' }
		],
		owner: 'DumpFire',
		gapCards: [2906],
		organisationalPart: 'Assign roles so that no one person holds duties that conflict.'
	},
	organisational('A.5.4', 'annex-a', 'Management responsibilities'),
	organisational('A.5.5', 'annex-a', 'Contact with authorities'),
	organisational('A.5.6', 'annex-a', 'Contact with special interest groups'),
	organisational('A.5.7', 'annex-a', 'Threat intelligence'),
	organisational('A.5.8', 'annex-a', 'Information security in project management'),
	organisational('A.5.9', 'annex-a', 'Inventory of information and other associated assets'),
	organisational('A.5.10', 'annex-a', 'Acceptable use of information and other associated assets'),
	organisational('A.5.11', 'annex-a', 'Return of assets'),
	organisational('A.5.12', 'annex-a', 'Classification of information'),
	organisational('A.5.13', 'annex-a', 'Labelling of information'),
	{
		ref: 'A.5.14',
		kind: 'annex-a',
		title: 'Information transfer',
		theme: 'organisational',
		applicability: 'supports',
		status: 'met',
		how:
			'Mail needs STARTTLS and checks the server\'s certificate, unless an administrator switches on mail without a checked, encrypted connection. Webhooks are signed with HMAC-SHA256. The SFTP host key is pinned. ' +
			'Report schedules and report mail ask for the password and a code before board data goes to an address (card 2751). ' +
			'A webhook whose setter loses the board is switched off for good, and only the board\'s owner or an administrator switches it on again, with an API key, which gives it a new secret; ' +
			'the board\'s owners are told (card 2752). So is a webhook whose API key ends: each records the key that set it up, and is switched off when that key is revoked, expires, passes its deadline or is deleted; ' +
			'one set up before keys were recorded stops once its setter has no working key from then, and its owners were told the date (card 2893).',
		evidence: [
			{ path: 'src/lib/server/email.ts', symbol: 'requireTLS' },
			{ path: 'src/lib/server/webhooks.ts', symbol: 'createHmac' },
			{ path: 'src/lib/server/webhooks.ts', symbol: 'switchOffLostWebhooks' },
			{ path: 'src/lib/server/webhooks.ts', symbol: 'keyOfWrite' },
			{ path: 'src/lib/server/webhooks.ts', symbol: 'keysBeforeRecorded' },
			{ path: 'src/routes/api/account/api-keys/[id]/+server.ts', symbol: 'switchOffLostWebhooks' },
			{ path: 'src/lib/server/startup-checks.ts', symbol: 'announceWebhooksBeforeKeys' },
			{ path: 'src/lib/server/ssh-host-key.ts' },
			{ path: 'src/routes/api/reports/email/+server.ts', symbol: 'confirmStepUp' },
			{ path: 'src/routes/api/report-schedules/+server.ts', symbol: 'confirmStepUp' },
			{ path: AUTH_DOC, anchor: 'report-schedules-and-report-mail-card-2751' }
		],
		owner: 'DumpFire',
		gapCards: [],
		organisationalPart: 'Rules for transferring information, and agreements with those who receive it.'
	},
	{
		ref: 'A.5.15',
		kind: 'annex-a',
		title: 'Access control',
		theme: 'organisational',
		applicability: 'app',
		status: 'partly-met',
		how:
			'Every route passes the gate, and every board read and write asks who may view or change that board, pinned by the route-by-route access tests. ' +
			'An API key carries its owner\'s full rights, with no scopes.',
		evidence: [
			{ path: 'src/hooks.server.ts', symbol: 'ADMIN_ROUTES' },
			{ path: 'src/lib/server/board-access.ts', symbol: 'canViewBoard' },
			{ path: 'tests/access-every-route.test.ts' },
			{ path: 'tests/access-control.test.ts' }
		],
		owner: 'DumpFire',
		gapCards: [2703]
	},
	{
		ref: 'A.5.16',
		kind: 'annex-a',
		title: 'Identity management',
		theme: 'organisational',
		applicability: 'app',
		status: 'partly-met',
		how:
			'Accounts are unique and made by administrators, by invite or with a chosen password. ' +
			'An account can only be deleted, not disabled.',
		evidence: [
			{ path: 'src/routes/api/users/+server.ts' },
			{ path: 'src/lib/server/invites.ts' },
			{ path: 'src/routes/api/users/[id]/+server.ts', symbol: 'DELETE' },
			{ path: 'tests/user-delete.test.ts' }
		],
		owner: 'DumpFire',
		gapCards: [2671]
	},
	{
		ref: 'A.5.17',
		kind: 'annex-a',
		title: 'Authentication information',
		theme: 'organisational',
		applicability: 'app',
		status: 'partly-met',
		how:
			'Passwords are hashed with bcrypt at cost 12. Authenticator secrets are sealed with AES-256-GCM under a key kept outside the database. ' +
			'Session ids, invite tokens, API keys, recovery codes, sign-in challenges, decision links and (since card 2870) requester links are held only as SHA-256 hashes. ' +
			'Every route that sets a password refuses one over 1,024 characters, the most the step-up reads (card 2888). ' +
			'Requester links end 90 days after their request is settled (card 2902). ' +
			'Still open: the mail password, backup destination credentials, webhook secrets and the server\'s own signing keys are stored in plain in the live database.',
		evidence: [
			{ path: 'src/lib/server/passwords.ts', symbol: 'BCRYPT_ROUNDS' },
			{ path: 'src/lib/server/passwords.ts', symbol: 'LONGEST_PASSWORD' },
			{ path: 'src/lib/server/mfa-crypto.ts', symbol: 'aes-256-gcm' },
			{ path: 'src/lib/server/mfa-key.ts' },
			{ path: 'src/lib/server/db/schema.ts', symbol: 'tokenHash' },
			{ path: 'src/lib/server/db/schema.ts', symbol: 'keyHash' },
			{ path: 'src/lib/server/db/schema.ts', symbol: 'linkTokenHash' },
			{ path: 'src/lib/server/request-tokens.ts', symbol: 'request_links' },
			{ path: 'src/lib/server/request-access.ts', symbol: 'SETTLED_LINK_DAYS' },
			{ path: AUTH_DOC, anchor: 'requester-links-stored-as-hashes-card-2870' },
			{ path: AUTH_DOC, anchor: 'isoiec-270012022' }
		],
		owner: 'DumpFire',
		gapCards: [2898]
	},
	{
		ref: 'A.5.18',
		kind: 'annex-a',
		title: 'Access rights',
		theme: 'organisational',
		applicability: 'supports',
		status: 'partly-met',
		how:
			'A role change, a delete and a password reset end what the account held: its sessions and keys end, the webhooks it set are switched off and its report schedules paused, and each is logged. ' +
			'Removing an authenticator ends the account\'s other sessions and pending sign-ins (card 2772). ' +
			'A change that takes an account\'s board access away switches off, for good, the webhooks it set on that board; giving the access back does not switch them on (card 2752). ' +
			'Revoking an API key switches off, in the same change, the webhooks it set up, and one whose key expires or passes its deadline is switched off at the next start, restore or event (card 2893). ' +
			'Every way of setting a password, the holder\'s own change included, and a reset of an account\'s two-step sign-in, from the admin page or the host, pause the account\'s report schedules; the reset says how many API keys and webhooks the account still has, and its mail names them, and removing an authenticator lists its schedules that are on (card 2894). ' +
			'Still open: an account cannot be disabled.',
		evidence: [
			{ path: 'src/lib/server/auth.ts', symbol: 'endAccountAccess' },
			{ path: 'src/routes/api/account/password/+server.ts', symbol: 'endAccountAccess' },
			{ path: 'scripts/mfa-reset.mjs', symbol: 'report_schedules' },
			{ path: 'src/lib/server/webhooks.ts', symbol: 'switchOffHeld' },
			{ path: 'src/routes/api/account/api-keys/[id]/+server.ts', symbol: 'switchOffLostWebhooks' },
			{ path: 'src/lib/server/mfa-store.ts', symbol: 'resetTwoStep' },
			{ path: 'src/lib/server/account-two-step.ts' },
			{ path: 'src/lib/server/audit-log.ts' },
			{ path: AUTH_DOC, anchor: 'passwords-sessions-and-invites-change-together' }
		],
		owner: 'DumpFire',
		gapCards: [2671],
		organisationalPart: 'Review regularly who holds which role.'
	},
	organisational('A.5.19', 'annex-a', 'Information security in supplier relationships'),
	organisational('A.5.20', 'annex-a', 'Addressing information security within supplier agreements'),
	organisational('A.5.21', 'annex-a', 'Managing information security in the information and communication technology (ICT) supply chain'),
	organisational('A.5.22', 'annex-a', 'Monitoring, review and change management of supplier services'),
	organisational('A.5.23', 'annex-a', 'Information security for use of cloud services', {
		how: 'backups to cloud storage (S3, Google Drive, OneDrive) are configured per destination.',
		evidence: [{ path: 'src/lib/server/backup-destinations.ts' }]
	}),
	organisational('A.5.24', 'annex-a', 'Information security incident management planning and preparation', {
		how: 'sign-in notices and the security banner tell an account holder of events on their account.',
		evidence: [{ path: 'src/lib/server/notifications.ts' }]
	}),
	organisational('A.5.25', 'annex-a', 'Assessment and decision on information security events', {
		how: 'sign-in notices and the security banner tell an account holder of events on their account.',
		evidence: [{ path: 'src/lib/server/notifications.ts' }]
	}),
	organisational('A.5.26', 'annex-a', 'Response to information security incidents', {
		how: 'sign-in notices and the security banner tell an account holder of events on their account.',
		evidence: [{ path: 'src/lib/server/notifications.ts' }]
	}),
	organisational('A.5.27', 'annex-a', 'Learning from information security incidents', {
		how: 'sign-in notices and the security banner tell an account holder of events on their account.',
		evidence: [{ path: 'src/lib/server/notifications.ts' }]
	}),
	organisational('A.5.28', 'annex-a', 'Collection of evidence', {
		how: 'the system log records who did what, and when (an import can still replace it; card 2899).',
		evidence: [{ path: 'src/lib/server/logger.ts' }]
	}),
	organisational('A.5.29', 'annex-a', 'Information security during disruption'),
	organisational('A.5.30', 'annex-a', 'ICT readiness for business continuity'),
	organisational('A.5.31', 'annex-a', 'Legal, statutory, regulatory and contractual requirements'),
	organisational('A.5.32', 'annex-a', 'Intellectual property rights'),
	organisational('A.5.33', 'annex-a', 'Protection of records', {
		how: 'decision records keep what was decided, by whom and with whom.',
		evidence: [{ path: 'src/lib/server/decision-record.ts' }]
	}),
	{
		ref: 'A.5.34',
		kind: 'annex-a',
		title: 'Privacy and protection of personal identifiable information (PII)',
		theme: 'organisational',
		applicability: 'supports',
		status: 'partly-met',
		how:
			'People, accounts and task requests can be deleted. A backup holds no session, unused invite or requester link, and requester links are held only as hashes (card 2870) ' +
			'and end 90 days after their request is settled (card 2902). ' +
			'A requester\'s address is never written to the system log: a mail to them that fails names the request (card 2896). ' +
			'Still open: what DumpFire holds about one person cannot be exported or erased in one step.',
		evidence: [
			{ path: 'src/routes/api/people/[id]/+server.ts', symbol: 'DELETE' },
			{ path: 'src/routes/api/users/[id]/+server.ts', symbol: 'DELETE' },
			{ path: 'src/routes/api/requests/[id]/+server.ts', symbol: 'DELETE' },
			{ path: BACKUP_DOC, anchor: 'what-a-backup-holds' },
			{ path: 'src/lib/server/email.ts', symbol: 'requesterLabel' },
			{ path: 'src/lib/server/request-access.ts', symbol: 'SETTLED_LINK_DAYS' }
		],
		owner: 'DumpFire',
		gapCards: [2909],
		organisationalPart: 'Lawful basis, privacy notices, data subject requests and records of processing.'
	},
	organisational('A.5.35', 'annex-a', 'Independent review of information security'),
	organisational('A.5.36', 'annex-a', 'Compliance with policies, rules and standards for information security'),
	{
		ref: 'A.5.37',
		kind: 'annex-a',
		title: 'Documented operating procedures',
		theme: 'organisational',
		applicability: 'supports',
		status: 'met',
		how: 'Deployment, administration, and backup and restore are written down.',
		evidence: [{ path: 'docs/deployment.md' }, { path: ADMIN_DOC }, { path: BACKUP_DOC }],
		owner: 'DumpFire',
		gapCards: [],
		organisationalPart: 'Approve, publish and review the procedures.'
	},

	// ─── A.6 People controls ────────────────────────────────────────────────
	organisational('A.6.1', 'annex-a', 'Screening'),
	organisational('A.6.2', 'annex-a', 'Terms and conditions of employment'),
	organisational('A.6.3', 'annex-a', 'Information security awareness, education and training'),
	organisational('A.6.4', 'annex-a', 'Disciplinary process'),
	organisational('A.6.5', 'annex-a', 'Responsibilities after termination or change of employment'),
	organisational('A.6.6', 'annex-a', 'Confidentiality or non-disclosure agreements'),
	organisational('A.6.7', 'annex-a', 'Remote working'),
	organisational('A.6.8', 'annex-a', 'Information security event reporting'),

	// ─── A.7 Physical controls ──────────────────────────────────────────────
	organisational('A.7.1', 'annex-a', 'Physical security perimeters'),
	organisational('A.7.2', 'annex-a', 'Physical entry'),
	organisational('A.7.3', 'annex-a', 'Securing offices, rooms and facilities'),
	organisational('A.7.4', 'annex-a', 'Physical security monitoring'),
	organisational('A.7.5', 'annex-a', 'Protecting against physical and environmental threats'),
	organisational('A.7.6', 'annex-a', 'Working in secure areas'),
	organisational('A.7.7', 'annex-a', 'Clear desk and clear screen'),
	organisational('A.7.8', 'annex-a', 'Equipment siting and protection'),
	organisational('A.7.9', 'annex-a', 'Security of assets off-premises'),
	organisational('A.7.10', 'annex-a', 'Storage media'),
	organisational('A.7.11', 'annex-a', 'Supporting utilities'),
	organisational('A.7.12', 'annex-a', 'Cabling security'),
	organisational('A.7.13', 'annex-a', 'Equipment maintenance'),
	organisational('A.7.14', 'annex-a', 'Secure disposal or re-use of equipment'),

	// ─── A.8 Technological controls ─────────────────────────────────────────
	organisational('A.8.1', 'annex-a', 'User endpoint devices'),
	{
		ref: 'A.8.2',
		kind: 'annex-a',
		title: 'Privileged access rights',
		theme: 'technological',
		applicability: 'app',
		status: 'partly-met',
		how:
			'There are three roles. The superadmin\'s database operations ask for the password and an authenticator code at every step-up. ' +
			'Administrators\' sessions have shorter limits, and the superadmin\'s two-step reset can only be done from the host. ' +
			'The App URL that every mailed link begins with is the superadmin\'s alone, and held to the address the server\'s configuration names (card 2847). ' +
			'Still open: an API key acts with its owner\'s full rights, an administrator\'s included, with no step-up. ' +
			'Any administrator can still add a backup destination of their own and Run Now, which sends it a full copy of the database, and whoever sets the mail server reads every mail (card 2906, to be ruled).',
		evidence: [
			{ path: 'src/lib/server/step-up.ts', symbol: 'confirmStepUp' },
			{ path: 'tests/step-up.test.ts' },
			{ path: 'tests/session-hardening.test.ts' },
			{ path: 'scripts/mfa-reset.mjs' }
		],
		owner: 'DumpFire',
		gapCards: [2703, 2906]
	},
	{
		ref: 'A.8.3',
		kind: 'annex-a',
		title: 'Information access restriction',
		theme: 'technological',
		applicability: 'app',
		status: 'partly-met',
		how:
			'Every read is filtered by board access, pinned by tests of each page load and each route. ' +
			'A board, a card, a grouping, anything on a board, or a milestone that the caller cannot open or see, asked for by its id, is answered as one that does not exist, ' +
			'404 in the same words, in single answers and in batches (cards 2719, 2911), and so is a task request a signed-in caller cannot read, as it is to a caller with no account (card 2914). ' +
			'An id under a card\'s address, an attachment or a comment, is asked about only once the caller can open the card (card 2762). ' +
			'Still open: the dependency lists still give the ids of work on a board the caller cannot open that is linked to their own, withheld but numbered (card 2129\'s design; a loop withholds its nodes\' ids, card 2719), awaiting the owner\'s ruling (2917); ' +
			'reads under an API key rely on a test scan rather than a refusal at run time (2730).',
		evidence: [
			{ path: 'src/lib/server/board-access.ts', symbol: 'canViewBoard' },
			{ path: 'src/lib/server/route-guards.ts', symbol: 'requireBoard' },
			{ path: 'src/lib/server/card-attachments.ts', symbol: 'deleteAttachment' },
			{ path: 'src/lib/server/list-access.ts' },
			{ path: 'src/lib/server/work-access.ts' },
			{ path: 'tests/load-access-reads.test.ts' },
			{ path: 'tests/access-every-route.test.ts' },
			{ path: 'tests/not-found-not-forbidden.test.ts' }
		],
		owner: 'DumpFire',
		gapCards: [2730, 2917],
		accepted: [
			{ risk: 'R5: a missing id is answered a little faster than one the caller cannot open: a board, a card, a milestone or a task request', ...ACCEPTED_RISKS },
			{ risk: 'R6: ids are counted up one at a time, so anyone who can make a board, a card, a milestone or a task request learns from its id how many were made since their last', ...ACCEPTED_RISKS }
		]
	},
	organisational('A.8.4', 'annex-a', 'Access to source code'),
	{
		ref: 'A.8.5',
		kind: 'annex-a',
		title: 'Secure authentication',
		theme: 'technological',
		applicability: 'app',
		status: 'partly-met',
		how:
			'A password and then an authenticator or recovery code before any session, with no switch to turn the second step off. Every authenticator an account holds is tried (card 2772). ' +
			'Wrong codes are counted in the database, with pauses and a lock that survive a restart; a code not in the right form is refused before anything is counted, at sign-in as at the step-up (card 2889). ' +
			'The step-up asks for a code again. Sessions have idle and total limits. ' +
			'API keys made before two-step sign-in stop at their deadline unless kept with the password and a code (card 2772). ' +
			'Still open, as accepted risks: R1, R3 and R4 below.',
		evidence: [
			{ path: 'src/lib/server/second-step.ts', symbol: 'verifyStep' },
			{ path: 'src/lib/server/totp.ts' },
			{ path: 'src/lib/server/mfa-store.ts', symbol: 'matchFactors' },
			{ path: 'src/lib/server/sign-in-challenges.ts', symbol: 'codePause' },
			{ path: 'src/lib/server/auth.ts', symbol: 'keyEnded' },
			{ path: 'tests/two-step-sign-in.test.ts' },
			{ path: 'tests/session-hardening.test.ts' },
			{ path: 'tests/api-key-deadline.test.ts' },
			{ path: AUTH_DOC, anchor: 'isoiec-270012022' }
		],
		owner: 'DumpFire',
		gapCards: [],
		accepted: [
			{ risk: 'R1: on a server with no mail host, an account with no factor can be set up first by a holder of its password, for 14 days from the release', ...ACCEPTED_RISKS },
			{ risk: 'R3: a holder of the password can evict the owner\'s live sign-in challenge', ...ACCEPTED_RISKS },
			{ risk: 'R4: an older image started after the release makes sessions on a password alone', ...ACCEPTED_RISKS }
		]
	},
	organisational('A.8.6', 'annex-a', 'Capacity management', {
		how: 'request body and upload limits.',
		evidence: [{ path: 'src/lib/server/body-limits.ts' }, { path: 'src/lib/server/upload-allowance.ts' }]
	}),
	{
		ref: 'A.8.7',
		kind: 'annex-a',
		title: 'Protection against malware',
		theme: 'technological',
		applicability: 'supports',
		status: 'met',
		how:
			'Every image attached, through the API or the card window, is checked byte by byte by allow-list: the type its bytes are, ' +
			"metadata taken out but a JPEG's orientation, animation refused, data after a PNG's, GIF's or WebP's end refused and after a JPEG's " +
			'image cut off; capped at 20 a card and 30 uploads an hour ' +
			'and 100 MB a day for each account. The images stored before were checked once in the same way (card 2761). Every other file ' +
			'is stored as sent and only ever served as a download; every attachment is served with nosniff and a sandbox.',
		evidence: [
			{ path: 'src/lib/server/image-check.ts', symbol: 'checkImage' },
			{ path: 'tests/image-check.test.ts' },
			{ path: 'src/lib/server/gate-answers.ts', symbol: 'nosniff' },
			{ path: 'src/routes/api/cards/[id]/attachments/+server.ts' },
			{ path: 'src/lib/server/image-recheck.ts', symbol: 'recheckStoredImages' },
			{ path: 'tests/uploads.test.ts' }
		],
		owner: 'DumpFire',
		gapCards: [],
		organisationalPart: 'Malware protection on the host and on endpoints, which is what scans a file downloaded from a card: DumpFire checks images only.'
	},
	{
		ref: 'A.8.8',
		kind: 'annex-a',
		title: 'Management of technical vulnerabilities',
		theme: 'technological',
		applicability: 'supports',
		status: 'partly-met',
		how:
			'Dependencies are pinned in the lock file and listed in the SBOM, and production advisories have been cleared card by card (docs/planning/). ' +
			'Still open: nothing checks for advisories automatically.',
		evidence: [
			{ path: 'package-lock.json' },
			{ path: 'docs/sbom-analysis.md', anchor: '6-security-audit' },
			{ path: 'docs/sbom-analysis.md', anchor: '7-supply-chain-hygiene' }
		],
		owner: 'DumpFire',
		gapCards: [2901],
		organisationalPart: 'Watch advisories, patch the host and the image, and run penetration tests.'
	},
	{
		ref: 'A.8.9',
		kind: 'annex-a',
		title: 'Configuration management',
		theme: 'technological',
		applicability: 'supports',
		status: 'met',
		how:
			'Settings are documented and checked at start. The image runs as a user who is not root. ' +
			'Cookies are Secure over HTTPS whatever NODE_ENV says. The Content-Security-Policy is set in the build\'s configuration.',
		evidence: [
			{ path: 'docs/deployment.md' },
			{ path: 'src/lib/server/startup-checks.ts' },
			{ path: 'Dockerfile', symbol: 'USER node' },
			{ path: 'tests/secure-cookies.test.ts' },
			{ path: 'svelte.config.js', symbol: 'csp' }
		],
		owner: 'DumpFire',
		gapCards: [],
		organisationalPart: 'Keep configuration baselines for the host and the reverse proxy.'
	},
	{
		ref: 'A.8.10',
		kind: 'annex-a',
		title: 'Information deletion',
		theme: 'technological',
		applicability: 'app',
		status: 'met',
		how:
			'Accounts, people, cards, archived cards, decisions and task requests are deleted by route. The attachment trash empties after 30 days, and the images of long-closed cards retire. ' +
			'The system log is pruned after LOG_RETENTION_DAYS, and backup copies are pruned to Keep Last.',
		evidence: [
			{ path: 'src/routes/api/users/[id]/+server.ts', symbol: 'DELETE' },
			{ path: 'src/routes/api/people/[id]/+server.ts', symbol: 'DELETE' },
			{ path: 'src/routes/api/cards/[id]/+server.ts', symbol: 'DELETE' },
			{ path: 'src/routes/api/decisions/[id]/+server.ts', symbol: 'DELETE' },
			{ path: 'src/routes/api/requests/[id]/+server.ts', symbol: 'DELETE' },
			{ path: 'src/routes/api/admin/purge-archived/+server.ts', symbol: 'POST' },
			{ path: 'src/lib/server/uploads-sweep.ts' },
			{ path: 'src/lib/server/image-retention.ts' },
			{ path: 'src/lib/server/logger.ts', symbol: 'cleanOldSystemLogs' },
			{ path: BACKUP_DOC, anchor: 'retention-cleanup' }
		],
		owner: 'DumpFire',
		gapCards: []
	},
	{
		ref: 'A.8.11',
		kind: 'annex-a',
		title: 'Data masking',
		theme: 'technological',
		applicability: 'supports',
		status: 'met',
		how:
			'Stored secrets are masked in every settings answer, invite addresses are masked in the system log, and a token in a mail server\'s words is masked before they are logged. ' +
			'The address of anyone outside the organisation is never logged: a failed mail to a task request\'s requester names the request (card 2896), and one to a decision participant names the participant, in the mail server\'s words too. ' +
			'An account holder\'s address is still named on a failed mail to them, as the Users page already shows it to the same administrators.',
		evidence: [
			{ path: 'src/lib/server/backup-secrets.ts', symbol: 'SECRET_MASK' },
			{ path: ADMIN_DOC, anchor: 'what-a-backup-holds' },
			{ path: 'src/lib/server/email.ts', symbol: 'withoutAddress' },
			{ path: 'src/lib/server/email.ts', symbol: 'maskMailText' }
		],
		owner: 'DumpFire',
		gapCards: [],
		organisationalPart: 'Decide what is masked, and where.'
	},
	{
		ref: 'A.8.12',
		kind: 'annex-a',
		title: 'Data leakage prevention',
		theme: 'technological',
		applicability: 'app',
		status: 'partly-met',
		how:
			'Export is the superadmin\'s, behind a step-up. Report schedules and report mail ask for the password and a code before board data goes to an address, and owners were told of the schedules already running (card 2751). ' +
			'Every password change and a reset of the two-step sign-in pause the account\'s report schedules, each turned on again only with the password and a code (card 2894). ' +
			'There is a Content-Security-Policy and a Referrer-Policy. Backups hold no secret and no requester link. ' +
			'Still open: a schedule covers boards added to its grouping later. ' +
			'Any administrator can still add a backup destination of their own and Run Now, which sends it a full copy of the database, and whoever sets the mail server reads every mail (card 2906, to be ruled).',
		evidence: [
			{ path: 'src/routes/api/admin/export/+server.ts', symbol: 'requireSuperadmin' },
			{ path: 'src/routes/api/report-schedules/[id]/+server.ts', symbol: 'confirmStepUp' },
			{ path: 'src/routes/api/reports/email/+server.ts', symbol: 'confirmStepUp' },
			{ path: 'svelte.config.js', symbol: 'csp' },
			{ path: 'src/lib/server/gate-answers.ts', symbol: 'Referrer-Policy' },
			{ path: AUTH_DOC, anchor: 'the-content-security-policy' },
			{ path: BACKUP_DOC, anchor: 'what-a-backup-holds' }
		],
		owner: 'DumpFire',
		gapCards: [2897, 2906]
	},
	{
		ref: 'A.8.13',
		kind: 'annex-a',
		title: 'Information backup',
		theme: 'technological',
		applicability: 'supports',
		status: 'partly-met',
		how:
			'Scheduled backups to SFTP, S3, Google Drive and OneDrive, with Keep Last, a history and failure mail. Each backup is sealed with an HMAC, and a restore checks it. ' +
			'Attachment files are kept out of the backup by design; the organisation backs up the uploads folder. ' +
			'Still open: the backup file is not encrypted, yet it holds every password hash, address and card.',
		evidence: [
			{ path: 'src/lib/server/backup.ts' },
			{ path: 'src/lib/server/backup-destinations.ts' },
			{ path: 'src/lib/server/backup-secrets.ts', symbol: 'sealOf' },
			{ path: 'src/lib/server/db/restore.ts' },
			{ path: 'tests/backups.test.ts' },
			{ path: BACKUP_DOC, anchor: 'failure-notifications' }
		],
		owner: 'DumpFire',
		gapCards: [2900],
		organisationalPart: 'Back up the uploads folder, test restores, and set the backup policy.'
	},
	organisational('A.8.14', 'annex-a', 'Redundancy of information processing facilities'),
	{
		ref: 'A.8.15',
		kind: 'annex-a',
		title: 'Logging',
		theme: 'technological',
		applicability: 'supports',
		status: 'partly-met',
		how:
			'Every entry goes to stdout, the system log table and the live audit feed. Reset Everything keeps the log. ' +
			'Report schedules and report mail log the addresses an asked action adds (card 2751). ' +
			'The scheduled run\'s line names every address it reached and missed, and every change to a schedule, and its delete, is logged with its addresses (card 2895). ' +
			'Still open: an import replaces the log with the backup\'s, an edited one included.',
		evidence: [
			{ path: 'src/lib/server/logger.ts' },
			{ path: 'src/lib/server/audit-log.ts' },
			{ path: 'tests/audit-log.test.ts' },
			{ path: 'tests/logger.test.ts' },
			{ path: 'src/routes/api/admin/reset/+server.ts', symbol: 'KEPT' },
			{ path: 'src/lib/server/db/restore.ts', symbol: 'rowsToRestore' },
			{ path: 'src/lib/server/reports.ts', symbol: 'reportScheduleChanged' }
		],
		owner: 'DumpFire',
		gapCards: [2899],
		organisationalPart: 'Send stdout to a store the application cannot write, and set its retention.'
	},
	{
		ref: 'A.8.16',
		kind: 'annex-a',
		title: 'Monitoring activities',
		theme: 'technological',
		applicability: 'supports',
		status: 'met',
		how:
			'The audit page\'s live console. The account holder is mailed at every enrolment, recovery-code use, pause, lock and likely stolen password, and shown the security banner. ' +
			'Backup failures are mailed.',
		evidence: [
			{ path: 'src/routes/audit/+page.svelte' },
			{ path: 'src/lib/server/notifications.ts' },
			{ path: BACKUP_DOC, anchor: 'failure-notifications' }
		],
		owner: 'DumpFire',
		gapCards: [],
		organisationalPart: 'Someone watches and acts on it; network and host monitoring. DumpFire alerts no administrator: watch /audit and stdout.'
	},
	organisational('A.8.17', 'annex-a', 'Clock synchronization', {
		how: 'every timestamp is stored in UTC.',
		evidence: [{ path: 'src/lib/server/db/timestamps.ts' }]
	}),
	organisational('A.8.18', 'annex-a', 'Use of privileged utility programs', {
		how: 'the superadmin\'s two-step reset runs only from the host.',
		evidence: [{ path: 'scripts/mfa-reset.mjs' }]
	}),
	organisational('A.8.19', 'annex-a', 'Installation of software on operational systems'),
	organisational('A.8.20', 'annex-a', 'Networks security'),
	organisational('A.8.21', 'annex-a', 'Security of network services'),
	organisational('A.8.22', 'annex-a', 'Segregation of networks'),
	organisational('A.8.23', 'annex-a', 'Web filtering'),
	{
		ref: 'A.8.24',
		kind: 'annex-a',
		title: 'Use of cryptography',
		theme: 'technological',
		applicability: 'supports',
		status: 'partly-met',
		how:
			'AES-256-GCM with bound additional data, and key rotation at start. bcrypt for passwords. SHA-256 for every token kept. ' +
			'An HMAC seal on backups and on webhook deliveries. STARTTLS with certificate checks, unless an administrator switches on mail without a checked, encrypted connection. A pinned SFTP host key, and __Host- Secure cookies. ' +
			'Still open: the stored service credentials are not encrypted, and neither are backup files.',
		evidence: [
			{ path: 'src/lib/server/mfa-crypto.ts', symbol: 'createCipheriv' },
			{ path: 'src/lib/server/mfa-key.ts' },
			{ path: 'src/lib/server/startup-checks.ts' },
			{ path: 'src/lib/server/passwords.ts', symbol: 'BCRYPT_ROUNDS' },
			{ path: 'src/lib/server/webhooks.ts', symbol: 'createHmac' }
		],
		owner: 'DumpFire',
		gapCards: [2898, 2900],
		organisationalPart: 'TLS at the reverse proxy, custody of MFA_KEY_FILE, and a cryptography policy.'
	},
	{
		ref: 'A.8.25',
		kind: 'annex-a',
		title: 'Secure development life cycle',
		theme: 'technological',
		applicability: 'supports',
		status: 'met',
		how: 'Each card is planned before it is built (docs/planning/), with triage, decisions and security rows, and the whole suite runs in every image build.',
		evidence: [{ path: 'docs/testing.md' }, { path: 'Dockerfile', symbol: 'npm run verify' }],
		owner: 'DumpFire',
		gapCards: [],
		organisationalPart: 'Adopt and document the secure development policy.'
	},
	{
		ref: 'A.8.26',
		kind: 'annex-a',
		title: 'Application security requirements',
		theme: 'technological',
		applicability: 'supports',
		status: 'met',
		how: 'Security requirements are written into each card\'s plan (docs/planning/) and ruled before building; those built are kept in the security design.',
		evidence: [{ path: AUTH_DOC, anchor: 'accepted-risks' }, { path: AUTH_DOC, anchor: 'isoiec-270012022' }],
		owner: 'DumpFire',
		gapCards: [],
		organisationalPart: 'Requirements for applications the organisation buys in.'
	},
	{
		ref: 'A.8.27',
		kind: 'annex-a',
		title: 'Secure system architecture and engineering principles',
		theme: 'technological',
		applicability: 'supports',
		status: 'partly-met',
		how:
			'The architecture and the security design are written down. The gate fails closed: a route not on its public list needs a session. ' +
			'Still open: reads under an API key rely on a test scan rather than a refusal at run time, and the step-up\'s proof can still be forged by server code.',
		evidence: [{ path: 'docs/architecture.md' }, { path: AUTH_DOC }, { path: 'src/hooks.server.ts', symbol: 'PUBLIC_ROUTES' }],
		owner: 'DumpFire',
		gapCards: [2730, 2737],
		organisationalPart: 'Engineering principles for the organisation\'s other systems.'
	},
	{
		ref: 'A.8.28',
		kind: 'annex-a',
		title: 'Secure coding',
		theme: 'technological',
		applicability: 'supports',
		status: 'partly-met',
		how:
			'Parameterised queries, HTML escaping, the Content-Security-Policy, request body limits, and source scans of every write. ' +
			'Still open: the step-up\'s proof can still be forged by server code.',
		evidence: [
			{ path: 'src/lib/escape-html.ts' },
			{ path: 'src/lib/server/body-limits.ts' },
			{ path: 'tests/check-at-the-write.test.ts' }
		],
		owner: 'DumpFire',
		gapCards: [2737],
		organisationalPart: 'Secure coding training.'
	},
	{
		ref: 'A.8.29',
		kind: 'annex-a',
		title: 'Security testing in development and acceptance',
		theme: 'technological',
		applicability: 'supports',
		status: 'met',
		how: 'The route-by-route access tests, the gate\'s tests and the step-up\'s tests run on every test run and in every image build.',
		evidence: [
			{ path: 'tests/access-every-route.test.ts' },
			{ path: 'tests/gate.test.ts' },
			{ path: 'tests/step-up.test.ts' },
			{ path: 'docs/testing.md' },
			{ path: 'Dockerfile', symbol: 'npm run verify' }
		],
		owner: 'DumpFire',
		gapCards: [],
		organisationalPart: 'Independent penetration tests and acceptance.'
	},
	organisational('A.8.30', 'annex-a', 'Outsourced development'),
	organisational('A.8.31', 'annex-a', 'Separation of development, test and production environments', {
		how: 'the tests refuse any database but an in-memory one.',
		evidence: [{ path: 'tests/setup.ts' }]
	}),
	{
		ref: 'A.8.32',
		kind: 'annex-a',
		title: 'Change management',
		theme: 'technological',
		applicability: 'supports',
		status: 'met',
		how: 'Append-only migrations with a reconciling runner, tested and rehearsed. Every change goes through a card and a commit.',
		evidence: [{ path: 'src/lib/server/db/migrate.ts' }, { path: 'tests/migrations.test.ts' }, { path: 'tests/rehearsal' }],
		owner: 'DumpFire',
		gapCards: [],
		organisationalPart: 'Approve releases to production.'
	},
	{
		ref: 'A.8.33',
		kind: 'annex-a',
		title: 'Test information',
		theme: 'technological',
		applicability: 'supports',
		status: 'met',
		how:
			'The tests refuse any database but an in-memory one, and build their data from fixtures. ' +
			'A migration rehearsal runs on a copy of a real database, starts no server or scheduler, and deletes the copy when it ends unless asked to keep it.',
		evidence: [
			{ path: 'tests/setup.ts', symbol: ':memory:' },
			{ path: 'tests/helpers/fixtures.ts' },
			{ path: 'scripts/rehearse.mjs', symbol: 'rmSync' }
		],
		owner: 'DumpFire',
		gapCards: [],
		organisationalPart:
			'Authorise each rehearsal on a copy of production data, delete any copy kept, and keep production data out of any test environment the organisation runs.'
	},
	organisational('A.8.34', 'annex-a', 'Protection of information systems during audit testing'),

	// ─── Clauses 4 to 10 ────────────────────────────────────────────────────
	organisational('4.1', 'clause', 'Understanding the organization and its context', {
		note: 'Amendment 1:2024 adds climate change to what the organisation considers here.'
	}),
	organisational('4.2', 'clause', 'Understanding the needs and expectations of interested parties', {
		note: 'Amendment 1:2024 adds that interested parties may have requirements about climate change.'
	}),
	organisational('4.3', 'clause', 'Determining the scope of the information security management system'),
	organisational('4.4', 'clause', 'Information security management system'),
	organisational('5.1', 'clause', 'Leadership and commitment'),
	organisational('5.2', 'clause', 'Policy'),
	organisational('5.3', 'clause', 'Organizational roles, responsibilities and authorities'),
	organisational('6.1', 'clause', 'Actions to address risks and opportunities', {
		note: 'This checklist is an input to the Statement of Applicability (6.1.3 d), not the statement itself: the organisation decides which controls apply, and why.'
	}),
	organisational('6.2', 'clause', 'Information security objectives and planning to achieve them'),
	organisational('6.3', 'clause', 'Planning of changes'),
	organisational('7.1', 'clause', 'Resources'),
	organisational('7.2', 'clause', 'Competence'),
	organisational('7.3', 'clause', 'Awareness'),
	organisational('7.4', 'clause', 'Communication'),
	organisational('7.5', 'clause', 'Documented information'),
	organisational('8.1', 'clause', 'Operational planning and control'),
	organisational('8.2', 'clause', 'Information security risk assessment'),
	organisational('8.3', 'clause', 'Information security risk treatment'),
	organisational('9.1', 'clause', 'Monitoring, measurement, analysis and evaluation'),
	organisational('9.2', 'clause', 'Internal audit'),
	organisational('9.3', 'clause', 'Management review'),
	organisational('10.1', 'clause', 'Continual improvement'),
	organisational('10.2', 'clause', 'Nonconformity and corrective action')
];

/** Each status's count, every status present at 0. */
export type IsoCounts = Record<IsoStatus, number>;

/** The two sides counted apart: the application (app and supports) and the organisation (organisational). */
export type IsoSummary = { application: IsoCounts; organisation: IsoCounts };

/**
 * The items counted by status, on two sides that never mix: `application`
 * counts `app` and `supports` items, `organisation` counts `organisational`
 * ones. A certificate is the organisation's, so its side is never added to
 * the application's.
 */
export function summarise(items: readonly IsoItem[]): IsoSummary {
	const zero = (): IsoCounts => ({ met: 0, 'partly-met': 0, 'not-met': 0, 'not-applicable': 0, organisational: 0 });
	const summary: IsoSummary = { application: zero(), organisation: zero() };
	for (const item of items) {
		const side = item.applicability === 'organisational' ? summary.organisation : summary.application;
		side[item.status]++;
	}
	return summary;
}
