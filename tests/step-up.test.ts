/**
 * The caller's password, asked for again before the actions that cannot be
 * taken back (card 2701, src/lib/server/step-up.ts).
 *
 * Slice 1: the admin actions (Reset Everything, the import through its
 * confirmation, Purge Archived, Clear Cards, Clear Categories and Reset XP),
 * the count of wrong current passwords on the session's own row (migration
 * 0062), the sign-out at the third, one check in flight per session, and the
 * import's single-use confirmation. Slice 2a: the account routes (making an
 * account, changing one's role or email, deleting one, setting its password
 * and sending it an invite). Slice 2b: the board delete, and the column
 * delete when the column holds a card, and their v1 twins left as they were
 * (card 2703). Slice 2c: what sends the database or the mail elsewhere (the
 * export, now a POST; the backup save with destinations, and Run Now; the
 * Google Drive Connect; the mail save), and the list pinned against the
 * routes. Each case is numbered as the plan numbers it
 * (docs/planning/card-2701-admin-step-up.md, section 6).
 *
 * Every fixture user's password is `FIXTURE_PASSWORD`, hashed at bcrypt's
 * lowest cost. The suite checks passwords on the test's own thread, a turn
 * later (`PASSWORD_THREADS=0`); `checkPassword` is stood in for here so that
 * a test can count the compares made and hold one in flight.
 */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

const stub = vi.hoisted(() => ({
	/** Passwords compared since the test began. */
	compared: 0,
	/** While set, each compare waits for it: a check held in flight. */
	hold: undefined as Promise<void> | undefined,
	/** What a backup destination, stood in for, was handed: `destination/filename`. */
	uploaded: [] as string[]
}));

// A backup destination that keeps the name of what it is given and reaches nowhere.
vi.mock('$lib/server/backup-destinations', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/backup-destinations')>();
	return {
		...real,
		createDestination: (config: { type: string; name: string }) => ({
			type: config.type,
			name: config.name,
			test: async () => ({ success: true, message: 'ok' }),
			upload: async (_data: Buffer, filename: string) => void stub.uploaded.push(`${config.name}/${filename}`),
			list: async () => [],
			delete: async () => {}
		})
	};
});

vi.mock('$lib/server/passwords', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/passwords')>();
	return {
		...real,
		checkPassword: async (...args: Parameters<typeof real.checkPassword>) => {
			stub.compared++;
			await stub.hold;
			return real.checkPassword(...args);
		}
	};
});

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashSync } from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { google } from 'googleapis';
import ts from 'typescript';
import { DRIVE_FILE_SCOPE } from '$lib/drive-scope';
import { db, sqlite } from '$lib/server/db';
import { afterCommit } from '$lib/server/db/transaction';
import {
	apiKeys,
	boardCategories,
	boards,
	cards,
	categories,
	columns,
	decisionParticipants,
	enrolmentLinks,
	inviteTokens,
	mfaFactors,
	mfaRecoveryCodes,
	people,
	reportSchedules,
	sessions,
	settings,
	userXp,
	users,
	webhooks
} from '$lib/server/db/schema';
import { PASSWORD_CHANGED_MEANWHILE, SESSION_COOKIE_NAME, deleteSession, forgetChecksInFlight, passwordHeld, whilePasswordHolds } from '$lib/server/auth';
import { addressKey } from '$lib/server/client-address';
import { PASSWORDS_BUSY } from '$lib/server/passwords';
import {
	FIRST_LANE_CHECKS_PER_ACCOUNT,
	checkRateLimit,
	enterSignIn,
	firstLaneChecksAt,
	leaveSignIn,
	resetAllRateLimits,
	signInWait,
	wrongSignInsAt
} from '$lib/server/rate-limit';
import {
	CONFIRMATION_HEADER,
	CONFIRMATION_REFUSED,
	STEP_UP_ACTIONS,
	STEP_UP_CODE_MALFORMED,
	STEP_UP_CODE_SPENT,
	STEP_UP_FACTOR_UNUSABLE,
	STEP_UP_IN_FLIGHT,
	STEP_UP_MISSING,
	STEP_UP_NO_FACTOR,
	STEP_UP_NO_PASSWORD,
	STEP_UP_SIGNED_OUT,
	STEP_UP_WRONG,
	forgetImportConfirmations,
	issueImportConfirmation,
	takeImportConfirmation,
	type StepUpAction
} from '$lib/server/step-up';
import { api, type ApiResult } from './helpers/api';
import { effects } from './helpers/effects';
import {
	FIXTURE_PASSWORD,
	FIXTURE_PASSWORD_HASH,
	addBoardMember,
	importConfirmation,
	makeApiKey,
	makeBoard,
	makeCard,
	makeDecision,
	makeParticipant,
	makePerson,
	makeSession,
	makeSmtp,
	makeUser,
	makeWebhook,
	resetDb,
	stepUp,
	stepUpCode,
	stepUpFactor,
	sessionHashOf,
	sessionCredential
} from './helpers/fixtures';
import { failingWrite } from './helpers/failing-write';
import { FROM_THE_PAGE, gate } from './helpers/gate';
import { expectUnchanged, snapshotDb, type DbSnapshot } from './helpers/snapshot';
import { readOpened, readOpenedUrl } from './helpers/reads';
import { handlersOf } from './helpers/source-scan';
import { codeFor, giveAuthenticator, giveFactor, wrongCodeFor } from './helpers/two-step';
import { factorSecret, spendStep } from '$lib/server/mfa-store';
import { stepAt } from '$lib/server/totp';

beforeEach(() => {
	resetDb();
	resetAllRateLimits();
	stub.compared = 0;
	stub.hold = undefined;
	stub.uploaded.length = 0;
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	process.env.LOG_LEVEL = 'ERROR';
});

/** What a signed-out session is answered, whatever its password (decision 6), with its code (the code review's F3). */
const SIGNED_OUT = { message: STEP_UP_SIGNED_OUT, signedOut: true, stepUp: 'signed-out' };
/** What no current password is answered. */
const MISSING = { message: STEP_UP_MISSING, stepUp: 'missing' };
/** What a wrong current password is answered on a listed route. */
const WRONG_ONE = { message: STEP_UP_WRONG, stepUp: 'wrong' };
/** What an import's confirmation refused is answered. */
const REFUSED = { message: CONFIRMATION_REFUSED, stepUp: 'confirmation' };

/** Not the fixture's password. */
const WRONG = 'not the password';

/** The account's second factor as stored (card 2771). */
const factorRow = (user: { id: number }) => db.select().from(mfaFactors).where(eq(mfaFactors.userId, user.id)).get()!;
/** The last step its codes spent, or null for none. */
const lastStepOf = (user: { id: number }) => factorRow(user).lastStep;
/**
 * A six-digit code that is wrong for every authenticator of the account now
 * (card 2772, E25): with several, not another one's right code.
 */
const wrongCodeOf = (user: { id: number }) =>
	wrongCodeFor(
		db.select().from(mfaFactors).where(eq(mfaFactors.userId, user.id)).orderBy(mfaFactors.id).all().map((factor) => {
			const opened = factorSecret(factor);
			if (!opened.usable) throw new Error(`factor ${factor.id} does not open`);
			return opened.secret;
		})
	);
/** The account's recovery codes used so far. */
const recoveryUsed = (user: { id: number }) =>
	db.select({ usedAt: mfaRecoveryCodes.usedAt }).from(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, user.id)).all().filter((code) => code.usedAt !== null).length;

/**
 * The columns a right password with a wrong code writes on the account (card 2771, D6): its banner, its failed
 * codes, and the latest signal's moment (card 2772's code review, CS1).
 */
const SIGNAL = ['security_banner', 'security_banner_at', 'failed_codes_since_sign_in', 'security_signal_last_at'];
/** A snapshot with `SIGNAL` taken out of `users`. */
const withoutSignal = (snapshot: DbSnapshot): DbSnapshot => ({
	...snapshot,
	users: Object.fromEntries(
		Object.entries(snapshot.users).map(([id, row]) => [id, Object.fromEntries(Object.entries(row).filter(([column]) => !SIGNAL.includes(column)))])
	)
});

/**
 * The superadmin, an administrator and an ordinary member; a board of the
 * administrator's with a card, an archived card and a category; and XP.
 */
function scene() {
	const chief = makeUser({ username: 'chief', role: 'superadmin' });
	const admin = makeUser({ username: 'admin', role: 'admin' });
	const member = makeUser({ username: 'member' });
	const { board, cols } = makeBoard({ owner: admin, name: 'Cleared' });
	makeCard(cols['To Do'], { title: 'Kept' });
	makeCard(cols['To Do'], { title: 'Archived', archivedAt: '2026-10-01 00:00:00' });
	db.insert(categories).values({ boardId: board.id, name: 'Kind' }).run();
	db.insert(userXp).values({ name: 'admin', xp: 40 }).run();
	return { chief, admin, member, board, cols };
}
type Scene = ReturnType<typeof scene>;
/** The `api()` options `stepUp` makes. */
type Confirmed = ReturnType<typeof stepUp>;

/** The session a request's cookie names. */
const tokenOf = (sent: { headers: Record<string, string> }) => sent.headers.cookie.slice(`${SESSION_COOKIE_NAME}=`.length);

/** The session's count of wrong current passwords, or undefined once it has gone. */
const countOf = (token: string) =>
	db.select({ count: sessions.wrongPasswordCount }).from(sessions).where(eq(sessions.tokenHash, sessionHashOf(token))).get()?.count;

/** The archived card is still there: nothing was purged. */
const archivedLeft = () => db.select().from(cards).all().filter((card) => card.archivedAt !== null).length;

/** The status and body of an answer, to compare in one. */
const answer = (res: ApiResult) => ({ status: res.status, body: res.body });

/** Hold every check in flight until the returned function is called. */
function holdChecks(): () => void {
	let release!: () => void;
	stub.hold = new Promise<void>((resolve) => (release = resolve));
	return () => {
		stub.hold = undefined;
		release();
	};
}

/** A working directory of the test's own, where the import writes its temporary copy and safety file. */
function workingDirectory(): string {
	const dir = mkdtempSync(join(tmpdir(), 'dumpfire-2701-'));
	onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
	vi.spyOn(process, 'cwd').mockReturnValue(dir);
	vi.spyOn(console, 'error').mockImplementation(() => {});
	return dir;
}

/** The lines of the system log at `level` whose message starts with `start`. */
const linesStarting = (level: string, start: string) =>
	sqlite
		.prepare('SELECT message, user_id AS userId FROM system_logs WHERE level = ? AND message LIKE ? ORDER BY id')
		.all(level, `${start}%`) as { message: string; userId: number | null }[];

/** Run with lines at `level` and above written to the system log, and none printed. */
function logAt(level: 'INFO' | 'WARN'): void {
	process.env.LOG_LEVEL = level;
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
}

/** An S3 destination with its secret entered, which Run Now sends a copy to. */
const BUCKET = { type: 's3', name: 'Bucket', region: 'eu-west-2', bucket: 'dumpfire-backups', accessKeyId: 'AKIA2701NOTSECRET', secretAccessKey: 'bucket-secret-2701', prefix: 'dumpfire/' };
/** A Google Drive destination not yet connected. */
const DRIVE = { type: 'gdrive', name: 'G', authMethod: 'oauth', clientId: 'g-client.apps.example.test', clientSecret: 'g-client-secret-2701', folderId: '' };

/** The backup settings with `BUCKET` and `DRIVE`, the schedule off. */
function backingUp(): void {
	const config = { schedule: 'disabled', scheduleTime: '02:00', scheduleDay: 0, retention: 7, destinations: [BUCKET, DRIVE], notifyOnFailure: false, notifyEmail: '' };
	db.insert(settings).values({ key: 'backup_config', value: JSON.stringify(config) }).run();
}

/** The backup settings as stored. */
// Opened: a save stores the destinations' secrets sealed (card 2898).
const backupConfig = () => JSON.parse(readOpened('settings', 'backup_config')!);

/** Google, stood in for: the code exchanged for a refresh token, and a folder made. The exchange is answered. */
function standInGoogle() {
	const files = {
		create: vi.fn().mockResolvedValue({ data: { id: 'made-folder-2701' } }),
		delete: vi.fn().mockResolvedValue({ data: {} }),
		get: vi.fn(),
		list: vi.fn().mockResolvedValue({ data: { files: [] } })
	};
	vi.spyOn(google, 'drive').mockReturnValue({ files } as never);
	return vi
		.spyOn(google.auth.OAuth2.prototype, 'getToken')
		.mockImplementation((async () => ({ tokens: { refresh_token: 'rt-2701', scope: DRIVE_FILE_SCOPE }, res: null })) as never);
}

/**
 * A Connect of `DRIVE` begun by `who` in the session `confirmed` carries, as
 * the page begins one: what the code is then sent with, the state among it.
 */
async function connecting(who: Scene['admin'], confirmed: ReturnType<typeof stepUp>) {
	const credential = sessionCredential(tokenOf(confirmed));
	const begun = await api('GET', '/api/admin/backup/gdrive/auth?dest=G', { user: who, credential });
	expect(begun.status).toBe(200);
	const state = new URL(begun.body.authUrl).searchParams.get('state');
	return (sent: Record<string, unknown>) =>
		api('POST', '/api/admin/backup/gdrive/auth', { ...confirmed, credential, body: { code: 'the-code', state, destName: 'G', ...sent } });
}

/**
 * Card 2697 (case 60): a person in the people directory, consulted on an open
 * decision by a personal link, which a change of their address or account
 * ends.
 */
function aLinkHolder() {
	const person = makePerson({ fullName: 'Pat Doe', email: 'pat.doe@example.test' });
	const decision = makeDecision({ title: 'Asked of Pat', status: 'open', closesAt: '2099-01-01 12:00:00', currentVersion: 1, openedAt: '2026-11-01 09:00:00' });
	const row = makeParticipant(decision, { person, token: 'a-live-link-2697' });
	return { person, decision, row };
}
/** The link holder a case's setup made. */
let linked: ReturnType<typeof aLinkHolder> | undefined;
/** The row a case's setup made for its path: a key to keep, an authenticator to remove (card 2772). */
let madeFor: number | undefined;
/** The time of the warning a case's setup raised, as the page shows it: a moment ago (card 2772). */
const bannerShown = new Date(Date.now() - 60_000).toISOString().slice(0, 19).replace('T', ' ');

/** The reasons of the `link_revoked` events recorded on a participant row, in order. */
const linkRevokedReasons = (participantId: number) =>
	(sqlite.prepare("SELECT detail FROM decision_events WHERE kind = 'link_revoked' AND participant_id = ? ORDER BY id").all(participantId) as { detail: string }[]).map(
		(event) => JSON.parse(event.detail).reason
	);

// ─── 1 and 2. The list, and the routes that ask ──────────────────────────────

describe('the list of what asks, pinned against the routes (cases 1 and 2)', () => {
	it("is the forty-three actions: decision 2's eighteen (the import among them, as its confirmation), card 2697's eight, card 2679's two, card 2773's one, card 2771's three, card 2772's five, card 2751's three, card 2671's two and card 2922's one, each with why it asks", () => {
		expect(Object.keys(STEP_UP_ACTIONS).sort()).toEqual(
			[
				// Card 2922: a setting held for review kept or removed.
				'POST /api/admin/settings/held',
				'POST /api/admin/reset',
				'POST /api/admin/import/confirm',
				'POST /api/admin/purge-archived',
				'POST /api/admin/boards/[id]/clear-cards',
				'POST /api/admin/boards/[id]/clear-categories',
				'POST /api/admin/reset-xp',
				'POST /api/users',
				'PUT /api/users/[id]',
				'DELETE /api/users/[id]',
				'PUT /api/users/[id]/password',
				'POST /api/users/[id]/invite',
				'DELETE /api/boards/[id]',
				'DELETE /api/columns/[id]',
				'POST /api/admin/export',
				'PUT /api/admin/backup',
				'POST /api/admin/backup',
				'POST /api/admin/backup/gdrive/auth',
				'PUT /api/admin/smtp',
				// Card 2697, B2b (Q9, Q21): a participant's account and address on a decision, and a person's address or account.
				'PUT /api/decisions/[id]/participants/[participantId]/account',
				'PUT /api/decisions/[id]/participants/[participantId]/address',
				'PUT /api/people/[id]',
				// Card 2697's code review, part B (S1): every other People write that sets or ends an address or an account.
				'POST /api/people',
				'DELETE /api/people/[id]',
				'POST /api/people/from-accounts',
				// Card 2697, B4 (Q9, Q29): a decision's delete and withdrawal, once it has been opened.
				'DELETE /api/decisions/[id]',
				'POST /api/decisions/[id]/withdraw',
				// Card 2679 (decision 2): a ruling, and the one-way release of its results.
				'POST /api/decisions/[id]/rule',
				'POST /api/decisions/[id]/release',
				// Card 2773: another account's two-step sign-in reset, which hands the caller its enrolment link.
				'POST /api/users/[id]/mfa/reset',
				// Card 2771 (D7): the Account page's three forms.
				'PUT /api/account/password',
				'PUT /api/account/email',
				'POST /api/account/api-keys',
				// Card 2772 (D5): a key made before two-step sign-in kept past its deadline.
				'POST /api/account/api-keys/[id]/keep',
				// Card 2772 (D1-D3, D6): the Account page's two-step section, and the warning at its top.
				'POST /api/account/two-step/authenticators',
				'DELETE /api/account/two-step/authenticators/[id]',
				'POST /api/account/two-step/recovery-codes',
				'DELETE /api/account/two-step/banner',
				// Card 2751 (D1, D2): a report schedule made, one given an address, turned on or widened, and the report mail.
				'POST /api/report-schedules',
				'PUT /api/report-schedules/[id]',
				'POST /api/reports/email',
				// Card 2671: an account disabled, and enabled again.
				'POST /api/users/[id]/disable',
				'POST /api/users/[id]/enable'
			].sort()
		);
		expect(Object.keys(STEP_UP_ACTIONS)).toHaveLength(43);
		for (const [action, why] of Object.entries(STEP_UP_ACTIONS)) expect(why.trim().length, action).toBeGreaterThan(20);
		expect(Object.isFrozen(STEP_UP_ACTIONS)).toBe(true);
	});

	it('agrees with the source both ways: every handler that asks is listed under its own key, every listed one asks, and before what it guards', () => {
		const root = join(process.cwd(), 'src', 'routes', 'api');
		const files = (readdirSync(root, { recursive: true }) as string[])
			.map((file) => file.split('\\').join('/'))
			.filter((file) => file === '+server.ts' || file.endsWith('/+server.ts'));
		/** What a confirmation stands for: the import asks at its confirmation (decision 8). */
		const CONFIRMED_AT: Record<string, string> = { 'POST /api/admin/import': 'POST /api/admin/import/confirm' };
		/** What the check must come before: the write held to the hash, or what cannot be held so. */
		const GUARDED = ['whilePasswordHolds', 'requirePasswordUnchanged', 'restoreFromBackup'];
		const asking = new Set<string>();
		const faults: string[] = [];
		let handlers = 0;

		for (const file of files) {
			const route = file === '+server.ts' ? '/api' : `/api/${file.slice(0, -'/+server.ts'.length)}`;
			const source = readFileSync(join(root, file), 'utf8');
			const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
			const named = (call: ts.CallExpression, names: string[]) => ts.isIdentifier(call.expression) && names.includes(call.expression.text);
			const callsIn = (node: ts.Node): ts.CallExpression[] => {
				const found: ts.CallExpression[] = [];
				const visit = (inner: ts.Node): void => {
					if (ts.isCallExpression(inner)) found.push(inner);
					ts.forEachChild(inner, visit);
				};
				visit(node);
				return found;
			};
			const inHandlers = new Set<ts.Node>();
			for (const { method, fn } of handlersOf(tree)) {
				handlers++;
				const key = `${method} ${route}`;
				if (!fn) {
					// Failing closed: a handler this cannot read in a file that asks.
					if (/confirmStepUp|takeImportConfirmation/.test(source)) faults.push(`${key}: a handler this test cannot read`);
					continue;
				}
				const calls = callsIn(fn);
				for (const call of calls) inHandlers.add(call);
				const asks = calls.filter((call) => named(call, ['confirmStepUp', 'takeImportConfirmation']));
				if (asks.length === 0) continue;
				for (const call of asks) {
					if (named(call, ['takeImportConfirmation'])) {
						if (!CONFIRMED_AT[key]) faults.push(`${key} takes an import's confirmation, and is not the import`);
						else asking.add(CONFIRMED_AT[key]);
						continue;
					}
					const action = call.arguments[3];
					if (!action || !ts.isStringLiteralLike(action)) faults.push(`${key} names its action other than in a text written out`);
					else if (action.text !== key) faults.push(`${key} asks under ${action.text}`);
					else asking.add(key);
				}
				const first = Math.min(...asks.map((call) => call.getStart(tree)));
				for (const call of calls.filter((call) => named(call, GUARDED))) {
					if (call.getStart(tree) < first) faults.push(`${key} calls ${call.expression.getText(tree)} before it asks for the password`);
				}
			}
			// A call that asks outside every handler cannot be put to a key: it fails.
			for (const call of callsIn(tree)) {
				if (named(call, ['confirmStepUp', 'takeImportConfirmation']) && !inHandlers.has(call)) faults.push(`${route}: asks outside its handlers`);
			}
		}

		expect(faults).toEqual([]);
		expect([...asking].sort()).toEqual(Object.keys(STEP_UP_ACTIONS).sort());
		// It looked: every handler of the internal routes and of v1.
		expect(handlers).toBeGreaterThan(200);
	});
});

// ─── 3. Each listed action: missing, wrong, right ────────────────────────────

/** Card 2751: the mail a report row sends, recorded, with mail set up; its INFO lines written. */
let mailed: ReturnType<typeof effects> | undefined;

/** Mail set up and recorded, and lines at INFO written, for a report row (card 2751), as the invite row records its mail. */
function mailing(): void {
	makeSmtp();
	const recorded = effects();
	mailed = recorded;
	onTestFinished(() => recorded.restore());
	logAt('INFO');
}

/** A report schedule of `owner`'s on the scene's board (card 2751): weekly at 09:00 UTC, as `values` says otherwise. */
function scheduleOf(owner: { id: number }, board: { id: number }, values: Partial<typeof reportSchedules.$inferInsert>): number {
	return db
		.insert(reportSchedules)
		.values({ userId: owner.id, name: 'Weekly', scope: 'board', scopeId: board.id, timeZone: 'UTC', ...values })
		.returning()
		.get().id;
}

/**
 * Card 2751 (D13): once its mail has gone, the one `report-schedule-set` notice
 * to `owner`, and the one INFO line naming the schedule's addresses, the
 * owner as its user.
 */
async function toldOfSchedule(owner: { id: number; email: string }, subject: string, line: RegExp): Promise<void> {
	await mailed!.settle();
	const notices = mailed!.emails.filter((mail) => mail.to === owner.email && /report schedule/.test(mail.subject));
	expect(notices.map((mail) => mail.subject)).toEqual([subject]);
	expect(linesStarting('INFO', 'Report schedule ').map(({ message, userId }) => ({ userId, line: line.test(message) }))).toEqual([
		{ userId: owner.id, line: true }
	]);
}

describe('each admin action asks for the current password (case 3)', () => {
	const ACTIONS: {
		action: StepUpAction;
		who: 'chief' | 'admin';
		path: (s: Scene) => string;
		/** What the action is sent with but the password: nothing unless said. */
		body?: (s: Scene) => Record<string, unknown>;
		/** What the right ones are sent with in place of `body`'s, read after the wrong ones: unless said, `body`'s. */
		rightBody?: (s: Scene) => Record<string, unknown>;
		/** The method, when it is not POST. */
		method?: 'PUT' | 'DELETE';
		/** The status of its success, when it is not 200. */
		status?: number;
		/** What the action needs that the scene does not have. */
		setup?: (s: Scene) => void;
		/**
		 * The session's count after the first wrong answer and after the second
		 * (card 2772, E2): one for each authenticator the account holds, as a wrong
		 * answer counts (D4). [1, 2] unless said. `signed out` for a second
		 * that reaches three: with two authenticators each wrong answer counts
		 * two, so the second signs the session out, and the right one is sent
		 * from a session of its own.
		 */
		counts?: readonly [number, number | 'signed out'];
		/** Awaited: a report row (card 2751) waits for the mail started after its commit. */
		done: (res: ApiResult, s: Scene) => void | Promise<void>;
	}[] = [
		{
			action: 'POST /api/admin/reset',
			who: 'chief',
			path: () => '/api/admin/reset',
			done: (res) => {
				expect(res.body).toMatchObject({ success: true, redirect: '/setup' });
				expect(db.select().from(users).all()).toEqual([]);
			}
		},
		{
			action: 'POST /api/admin/purge-archived',
			who: 'admin',
			path: () => '/api/admin/purge-archived',
			done: (res) => {
				expect(res.body).toEqual({ success: true, purged: 1 });
				expect(archivedLeft()).toBe(0);
			}
		},
		{
			action: 'POST /api/admin/boards/[id]/clear-cards',
			who: 'admin',
			path: (s) => `/api/admin/boards/${s.board.id}/clear-cards`,
			done: (res) => {
				expect(res.body).toEqual({ success: true });
				expect(db.select().from(cards).all()).toEqual([]);
			}
		},
		{
			action: 'POST /api/admin/boards/[id]/clear-categories',
			who: 'admin',
			path: (s) => `/api/admin/boards/${s.board.id}/clear-categories`,
			done: (res) => {
				expect(res.body).toEqual({ success: true });
				expect(db.select().from(categories).all()).toEqual([]);
			}
		},
		{
			action: 'POST /api/admin/reset-xp',
			who: 'admin',
			path: () => '/api/admin/reset-xp',
			done: (res) => {
				expect(res.body).toEqual({ success: true });
				expect(db.select({ xp: userXp.xp }).from(userXp).all()).toEqual([{ xp: 0 }]);
			}
		},
		// Slice 2a: the account routes.
		{
			action: 'POST /api/users',
			who: 'admin',
			path: () => '/api/users',
			body: () => ({ username: 'newcomer', email: 'newcomer@example.test', password: 'a long new password' }),
			status: 201,
			done: (res) => {
				expect(res.body).toMatchObject({ username: 'newcomer', role: 'user', invited: false });
				expect(db.select({ username: users.username }).from(users).where(eq(users.username, 'newcomer')).get()).toBeDefined();
			}
		},
		{
			action: 'PUT /api/users/[id]',
			who: 'admin',
			method: 'PUT',
			path: (s) => `/api/users/${s.member.id}`,
			body: () => ({ email: 'moved@example.test' }),
			done: (res, s) => {
				expect(res.body).toMatchObject({ id: s.member.id, email: 'moved@example.test', invitesEnded: 0 });
			}
		},
		{
			action: 'DELETE /api/users/[id]',
			who: 'admin',
			method: 'DELETE',
			path: (s) => `/api/users/${s.member.id}`,
			// Card 2671: only a disabled account is deleted.
			setup: (s) => void db.update(users).set({ disabledAt: '2099-01-01 09:00:00', disabledBy: s.admin.id }).where(eq(users.id, s.member.id)).run(),
			done: (res, s) => {
				expect(res.body).toEqual({ success: true });
				expect(db.select().from(users).where(eq(users.id, s.member.id)).get()).toBeUndefined();
			}
		},
		{
			action: 'PUT /api/users/[id]/password',
			who: 'admin',
			method: 'PUT',
			path: (s) => `/api/users/${s.member.id}/password`,
			body: () => ({ password: 'a long new password' }),
			done: (res, s) => {
				expect(res.body).toMatchObject({ success: true });
				expect(db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, s.member.id)).get()!.hash).not.toBe(
					FIXTURE_PASSWORD_HASH
				);
			}
		},
		{
			action: 'POST /api/users/[id]/invite',
			who: 'admin',
			path: (s) => `/api/users/${s.member.id}/invite`,
			// Mail to send the invite by, and its mail recorded, not sent.
			setup: () => {
				makeSmtp();
				const sent = effects();
				onTestFinished(() => sent.restore());
			},
			done: (res, s) => {
				expect(res.body).toMatchObject({ success: true, mailSent: true });
				expect(db.select().from(inviteTokens).where(eq(inviteTokens.userId, s.member.id)).all()).toHaveLength(1);
			}
		},
		// Card 2773: another account's two-step sign-in reset, its link answered once.
		{
			action: 'POST /api/users/[id]/mfa/reset',
			who: 'admin',
			path: (s) => `/api/users/${s.member.id}/mfa/reset`,
			done: (res, s) => {
				expect(res.body).toMatchObject({ success: true, enrolmentUrl: expect.stringContaining('/enrol/') });
				expect(db.select().from(enrolmentLinks).where(eq(enrolmentLinks.userId, s.member.id)).all()).toHaveLength(1);
			}
		},
		// Slice 2b: the board and column deletes.
		{
			action: 'DELETE /api/boards/[id]',
			who: 'admin',
			method: 'DELETE',
			path: (s) => `/api/boards/${s.board.id}`,
			done: (res, s) => {
				expect(res.body).toEqual({ success: true });
				expect(db.select().from(boards).where(eq(boards.id, s.board.id)).get()).toBeUndefined();
				expect(db.select().from(cards).all()).toEqual([]);
			}
		},
		{
			action: 'DELETE /api/columns/[id]',
			who: 'admin',
			method: 'DELETE',
			// To Do holds a card and an archived one.
			path: (s) => `/api/columns/${s.cols['To Do'].id}`,
			done: (res, s) => {
				expect(res.body).toEqual({ success: true });
				expect(db.select().from(columns).where(eq(columns.id, s.cols['To Do'].id)).get()).toBeUndefined();
				expect(db.select().from(cards).all()).toEqual([]);
			}
		},
		// Slice 2c: what sends the database or the mail elsewhere.
		{
			action: 'POST /api/admin/export',
			who: 'chief',
			path: () => '/api/admin/export',
			done: (res) => {
				expect(res.headers.get('content-type')).toBe('application/x-sqlite3');
				expect(res.headers.get('cache-control')).toBe('no-store');
			}
		},
		{
			action: 'PUT /api/admin/backup',
			who: 'admin',
			method: 'PUT',
			path: () => '/api/admin/backup',
			body: () => ({ destinations: [{ ...BUCKET, name: 'Offsite' }] }),
			done: (res) => {
				expect(res.body).toEqual({ success: true });
				expect(backupConfig().destinations.map((d: { name: string }) => d.name)).toEqual(['Offsite']);
			}
		},
		{
			action: 'POST /api/admin/backup',
			who: 'admin',
			path: () => '/api/admin/backup',
			body: () => ({ destination: 'Bucket' }),
			setup: backingUp,
			done: (res) => {
				expect(res.body.results).toEqual([expect.objectContaining({ destination: 'Bucket', status: 'success' })]);
				expect(stub.uploaded).toEqual([expect.stringMatching(/^Bucket\/.*-manual\.db$/)]);
			}
		},
		{
			action: 'PUT /api/admin/smtp',
			who: 'admin',
			method: 'PUT',
			path: () => '/api/admin/smtp',
			body: () => ({ host: 'smtp.example.test', port: 587, fromAddress: 'board@example.test' }),
			done: (res) => {
				expect(res.body).toEqual({ success: true });
				expect(db.select().from(settings).where(eq(settings.key, 'smtp_host')).get()?.value).toBe('smtp.example.test');
			}
		},
		// Card 2697, B2b (Q21, case 60 (a)): a person's address, which decides where their decision mail and links go.
		{
			action: 'PUT /api/people/[id]',
			who: 'admin',
			method: 'PUT',
			path: () => `/api/people/${linked!.person.id}`,
			body: () => ({ email: 'moved.person@example.test' }),
			setup: () => {
				linked = aLinkHolder();
			},
			done: (res) => {
				expect(res.body).toMatchObject({ id: linked!.person.id, email: 'moved.person@example.test' });
				expect(db.select({ hash: decisionParticipants.linkTokenHash }).from(decisionParticipants).where(eq(decisionParticipants.id, linked!.row.id)).get()).toEqual({ hash: null });
				expect(linkRevokedReasons(linked!.row.id)).toEqual(['address_changed']);
			}
		},
		// Card 2697's code review, part B (S1): adding a person, deleting one, and Add from accounts.
		{
			action: 'POST /api/people',
			who: 'admin',
			path: () => '/api/people',
			body: () => ({ fullName: 'Ann Lee', email: 'ann.lee@example.test' }),
			status: 201,
			done: (res) => {
				expect(res.body).toMatchObject({ fullName: 'Ann Lee', email: 'ann.lee@example.test' });
				expect(db.select({ email: people.email }).from(people).all()).toEqual([{ email: 'ann.lee@example.test' }]);
			}
		},
		{
			action: 'DELETE /api/people/[id]',
			who: 'admin',
			method: 'DELETE',
			path: () => `/api/people/${linked!.person.id}`,
			setup: () => {
				linked = aLinkHolder();
			},
			done: (res) => {
				expect(res.body).toEqual({ success: true, linksCleared: 1 });
				expect(db.select().from(people).where(eq(people.id, linked!.person.id)).get()).toBeUndefined();
				expect(linkRevokedReasons(linked!.row.id)).toEqual(['person_deleted']);
			}
		},
		{
			action: 'POST /api/people/from-accounts',
			who: 'admin',
			path: () => '/api/people/from-accounts',
			body: (s) => ({ userIds: [s.member.id] }),
			done: (res, s) => {
				expect(res.body).toEqual({ created: 1, skipped: [] });
				expect(db.select({ userId: people.userId }).from(people).all()).toEqual([{ userId: s.member.id }]);
			}
		},
		// Card 2771 (D7): the Account page's three forms, through the step-up since.
		{
			action: 'PUT /api/account/email',
			who: 'admin',
			method: 'PUT',
			path: () => '/api/account/email',
			body: () => ({ newEmail: 'moved@example.test' }),
			done: (res, s) => {
				expect(res.body).toEqual({ success: true, email: 'moved@example.test' });
				expect(db.select({ email: users.email }).from(users).where(eq(users.id, s.admin.id)).get()).toEqual({ email: 'moved@example.test' });
			}
		},
		{
			action: 'PUT /api/account/password',
			who: 'admin',
			method: 'PUT',
			path: () => '/api/account/password',
			body: () => ({ newPassword: 'a long new password' }),
			done: (res, s) => {
				// Card 2935: the webhooks of others whose secret it could read, counted apart (none: the keys are kept).
				// Card 2922: nothing held, as the keys are kept.
				expect(res.body).toEqual({ success: true, apiKeysEnded: 0, webhooksSwitchedOff: 0, readableWebhooksHeld: 0, reportSchedulesPaused: 0, settingsHeld: null });
				expect(db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, s.admin.id)).get()!.hash).not.toBe(FIXTURE_PASSWORD_HASH);
				// A new session, in place of the one the change ended.
				expect(db.select().from(sessions).where(eq(sessions.userId, s.admin.id)).all()).toHaveLength(1);
			}
		},
		{
			action: 'POST /api/account/api-keys',
			who: 'admin',
			path: () => '/api/account/api-keys',
			body: () => ({ name: 'my script' }),
			status: 201,
			done: (res, s) => {
				expect(res.body).toMatchObject({ name: 'my script', key: expect.any(String) });
				expect(db.select({ name: apiKeys.name }).from(apiKeys).where(eq(apiKeys.userId, s.admin.id)).all()).toEqual([{ name: 'my script' }]);
			}
		},
		// Card 2772 (D5): a key made before two-step sign-in kept past its deadline.
		{
			action: 'POST /api/account/api-keys/[id]/keep',
			who: 'admin',
			path: () => `/api/account/api-keys/${madeFor!}/keep`,
			setup: (s) => {
				makeApiKey(s.admin, 'Made before');
				madeFor = db.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.userId, s.admin.id)).get()!.id;
				db.update(apiKeys).set({ deadlineAt: '2099-01-01 00:00:00' }).where(eq(apiKeys.id, madeFor)).run();
			},
			done: (res) => {
				expect(res.body).toEqual({ success: true });
				expect(db.select({ deadlineAt: apiKeys.deadlineAt }).from(apiKeys).where(eq(apiKeys.id, madeFor!)).get()).toEqual({ deadlineAt: null });
			}
		},
		// Card 2772 (D1-D3, D6): the Account page's two-step section, and the warning at its top.
		{
			action: 'POST /api/account/two-step/authenticators',
			who: 'admin',
			path: () => '/api/account/two-step/authenticators',
			body: () => ({ label: 'Spare phone' }),
			done: (res, s) => {
				expect(res.body).toMatchObject({ pendingId: expect.any(String), account: 'admin', issuer: 'DumpFire' });
				expect(db.select().from(mfaFactors).where(eq(mfaFactors.userId, s.admin.id)).all()).toHaveLength(1);
			}
		},
		{
			action: 'DELETE /api/account/two-step/authenticators/[id]',
			who: 'admin',
			method: 'DELETE',
			path: () => `/api/account/two-step/authenticators/${madeFor!}`,
			// Two authenticators: the step-up's, and the one removed.
			setup: (s) => {
				stepUpFactor(s.admin);
				madeFor = giveAuthenticator(s.admin, 'Old phone').factorId;
			},
			counts: [2, 'signed out'],
			done: (res, s) => {
				expect(res.body).toMatchObject({ success: true });
				expect(db.select({ label: mfaFactors.label }).from(mfaFactors).where(eq(mfaFactors.userId, s.admin.id)).all()).toEqual([{ label: 'Authenticator' }]);
			}
		},
		{
			action: 'POST /api/account/two-step/recovery-codes',
			who: 'admin',
			path: () => '/api/account/two-step/recovery-codes',
			done: (res, s) => {
				expect(res.body.codes).toHaveLength(10);
				expect(db.select().from(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, s.admin.id)).all()).toHaveLength(10);
			}
		},
		{
			action: 'DELETE /api/account/two-step/banner',
			who: 'admin',
			method: 'DELETE',
			path: () => '/api/account/two-step/banner',
			// Raised a moment ago, so that a wrong code within the hour does not raise a newer one.
			body: () => ({ bannerAt: bannerShown }),
			// That wrong code is a signal all the same, and moves the latest (card 2772's code review, CS1): the
			// right ones are sent with it, as the page read again shows it.
			rightBody: (s) => ({
				bannerAt: db.select({ at: users.securitySignalLastAt }).from(users).where(eq(users.id, s.admin.id)).get()!.at
			}),
			setup: (s) => {
				db.update(users).set({ securityBanner: 'wrong-code', securityBannerAt: bannerShown }).where(eq(users.id, s.admin.id)).run();
			},
			done: (res, s) => {
				expect(res.body).toEqual({ success: true });
				expect(
					db
						.select({ banner: users.securityBanner, at: users.securityBannerAt, latest: users.securitySignalLastAt })
						.from(users)
						.where(eq(users.id, s.admin.id))
						.get()
				).toEqual({ banner: null, at: null, latest: null });
			}
		},
		// Card 2751 (T1): a schedule made, to the caller's own address alone, asks all the same (ruling 4).
		{
			action: 'POST /api/report-schedules',
			who: 'admin',
			path: () => '/api/report-schedules',
			body: (s) => ({ name: 'Weekly', scope: 'board', scopeId: s.board.id, frequency: 'weekly', recipients: s.admin.email }),
			status: 201,
			setup: mailing,
			done: async (res, s) => {
				expect(res.body).toMatchObject({ name: 'Weekly', recipients: s.admin.email, enabled: true, userId: s.admin.id });
				await toldOfSchedule(
					s.admin,
					'A report schedule was made on your DumpFire account',
					new RegExp(`^Report schedule ${res.body.id} "Weekly" was made, a report of the board "Cleared", sent to: ${s.admin.email}$`)
				);
			}
		},
		// Card 2751 (T2): an address added to a schedule that is off asks, and it stays off (D2).
		{
			action: 'PUT /api/report-schedules/[id]',
			who: 'admin',
			method: 'PUT',
			path: () => `/api/report-schedules/${madeFor!}`,
			body: () => ({ recipients: 'a@x.test, b@x.test' }),
			setup: (s) => {
				mailing();
				madeFor = scheduleOf(s.admin, s.board, { enabled: false, recipients: 'a@x.test' });
			},
			done: async (res, s) => {
				expect(res.body).toMatchObject({ id: madeFor, recipients: 'a@x.test, b@x.test', enabled: false });
				await toldOfSchedule(
					s.admin,
					'A report schedule of yours was changed on DumpFire',
					/^Report schedule \d+ "Weekly" was given addresses, a report of the board "Cleared", sent to: a@x\.test, b@x\.test; added: b@x\.test$/
				);
			}
		},
		// Card 2751 (T3): turning one on asks (D3), and works its next run out.
		{
			action: 'PUT /api/report-schedules/[id]',
			who: 'admin',
			method: 'PUT',
			path: () => `/api/report-schedules/${madeFor!}`,
			body: () => ({ enabled: true }),
			setup: (s) => {
				mailing();
				madeFor = scheduleOf(s.admin, s.board, { enabled: false, recipients: 'a@x.test', nextRunAt: null });
			},
			done: async (res, s) => {
				expect(res.body).toMatchObject({ id: madeFor, enabled: true, nextRunAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2} 09:00:00$/) });
				await toldOfSchedule(
					s.admin,
					'A report schedule of yours was changed on DumpFire',
					/^Report schedule \d+ "Weekly" was turned on, a report of the board "Cleared", sent to: a@x\.test$/
				);
			}
		},
		// Card 2751 (T4): the report mail asks for every address; nothing reaches it before the right ones.
		{
			action: 'POST /api/reports/email',
			who: 'admin',
			path: () => '/api/reports/email',
			body: (s) => ({ scope: 'board', scopeId: s.board.id, periodStart: '2026-10-01', periodEnd: '2026-10-14', recipients: ['someone@example.test'] }),
			setup: mailing,
			done: async (res, s) => {
				expect(res.body).toMatchObject({ message: 'Report sent to 1 recipient(s)' });
				await mailed!.settle();
				// The one mail to the address, sent by the right ones: the wrong ones reached nobody there.
				expect(mailed!.emails.filter((mail) => mail.to === 'someone@example.test').map((mail) => mail.subject)).toEqual(['DumpFire Report: Cleared']);
				expect(linesStarting('INFO', 'Report "').map(({ message, userId }) => ({ message, userId }))).toEqual([
					{ message: `Report "Cleared" was mailed by admin (ID: ${s.admin.id}) to: someone@example.test`, userId: s.admin.id }
				]);
			}
		},
		// Card 2751 (T5): a status filter widened, from Completed only to All work, asks (S2).
		{
			action: 'PUT /api/report-schedules/[id]',
			who: 'admin',
			method: 'PUT',
			path: () => `/api/report-schedules/${madeFor!}`,
			body: () => ({ statusFilter: 'all' }),
			setup: (s) => {
				mailing();
				madeFor = scheduleOf(s.admin, s.board, { statusFilter: 'completed', recipients: 'a@x.test' });
			},
			done: async (res, s) => {
				expect(res.body).toMatchObject({ id: madeFor, statusFilter: 'all', enabled: true });
				await toldOfSchedule(
					s.admin,
					'A report schedule of yours was changed on DumpFire',
					/^Report schedule \d+ "Weekly" was widened to All work, a report of the board "Cleared", sent to: a@x\.test$/
				);
			}
		}
	];

	it.each(ACTIONS)(
		'$action: none is 400 and nothing is counted, nor a password with no code; a wrong password or a wrong code 403 in the same words, changing nothing but the count and the code unspent; the right ones its success',
		async ({ who, path, body = () => ({}), rightBody, method = 'POST' as const, status = 200, setup, counts = [1, 2], done }) => {
			const s = scene();
			setup?.(s);
			const confirmed = stepUp(s[who], body(s));
			const token = tokenOf(confirmed);
			const wrongCode = wrongCodeOf(s[who]);
			const before = snapshotDb();

			const missing = await api(method, path(s), { ...confirmed, body: body(s) });
			expect(answer(missing)).toEqual({ status: 400, body: MISSING });
			// Card 2771 (D1): the right password and no code is missing too, and counted no more.
			const noCode = await api(method, path(s), { ...confirmed, body: { ...body(s), currentPassword: FIXTURE_PASSWORD } });
			expect(answer(noCode)).toEqual({ status: 400, body: MISSING });
			expectUnchanged(before);
			expect(stub.compared).toBe(0);

			const wrong = await api(method, path(s), { ...confirmed, body: { ...body(s), currentPassword: WRONG, currentCode: confirmed.body.currentCode } });
			expect(answer(wrong)).toEqual({ status: 403, body: WRONG_ONE });
			expect(countOf(token)).toBe(counts[0]);
			expectUnchanged({ ...before, sessions: snapshotDb().sessions });

			// Card 2771 (D4): the right password and a wrong code, answered as a wrong password is, counted, and the
			// code not spent; nothing else changed but the account's signal (D6).
			const wrongOne = await api(method, path(s), { ...confirmed, body: { ...body(s), currentPassword: FIXTURE_PASSWORD, currentCode: wrongCode } });
			if (counts[1] === 'signed out') {
				expect(answer(wrongOne)).toEqual({ status: 403, body: SIGNED_OUT });
				expect(countOf(token)).toBeUndefined();
			} else {
				expect(answer(wrongOne)).toEqual({ status: 403, body: WRONG_ONE });
				expect(countOf(token)).toBe(counts[1]);
			}
			expect(lastStepOf(s[who])).toBeNull();
			const now = snapshotDb();
			expectUnchanged(withoutSignal({ ...before, sessions: now.sessions }), '', withoutSignal(now));

			// A session signed out sends the right ones from a new one, as its holder signs in again.
			const right = await api(
				method,
				path(s),
				counts[1] === 'signed out'
					? stepUp(s[who], body(s))
					: rightBody
						? { ...confirmed, body: { ...confirmed.body, ...rightBody(s) } }
						: confirmed
			);
			expect(right.status, JSON.stringify(right.body)).toBe(status);
			await done(right, s);
		}
	);

	it('POST /api/admin/import, through its confirmation: none is 403, a wrong password at the confirmation 403, the right one and then the upload 200', async () => {
		const s = scene();
		const confirmed = stepUp(s.chief);
		const token = tokenOf(confirmed);
		const bytes = sqlite.serialize();
		const dir = workingDirectory();
		const upload = (confirmation?: string) =>
			api('POST', '/api/admin/import?outside=keep', {
				user: s.chief,
				headers: {
					cookie: confirmed.headers.cookie,
					'content-type': 'application/octet-stream',
					...(confirmation === undefined ? {} : { [CONFIRMATION_HEADER]: confirmation })
				},
				body: bytes
			});
		const confirm = (body: Record<string, unknown>) => api('POST', '/api/admin/import/confirm', { ...confirmed, body });
		const before = snapshotDb();

		expect(answer(await upload())).toEqual({ status: 403, body: REFUSED });
		expect(answer(await confirm({}))).toEqual({ status: 400, body: MISSING });
		expectUnchanged(before);
		expect(answer(await confirm({ currentPassword: WRONG, currentCode: confirmed.body.currentCode }))).toEqual({ status: 403, body: WRONG_ONE });
		expect(countOf(token)).toBe(1);
		expectUnchanged({ ...before, sessions: snapshotDb().sessions });
		expect(readdirSync(dir)).toEqual([]);

		const issued = await confirm({ currentPassword: FIXTURE_PASSWORD, currentCode: confirmed.body.currentCode });
		expect(issued.status).toBe(200);
		const imported = await upload(issued.body.confirmation);
		expect(imported.status, JSON.stringify(imported.body)).toBe(200);
		expect(imported.body.success).toBe(true);
		expect(readdirSync(dir)).toEqual(['.pre-restore-safety.json']);
	});

	it('POST /api/admin/backup/gdrive/auth, Google stood in for: none is 400 and a wrong one 403, changing nothing but the count, the right one connects', async () => {
		const s = scene();
		backingUp();
		standInGoogle();
		const confirmed = stepUp(s.admin);
		const token = tokenOf(confirmed);
		const connect = await connecting(s.admin, confirmed);
		const before = snapshotDb();

		expect(answer(await connect({}))).toEqual({ status: 400, body: MISSING });
		expectUnchanged(before);
		expect(stub.compared).toBe(0);

		expect(answer(await connect({ currentPassword: WRONG, currentCode: confirmed.body.currentCode }))).toEqual({ status: 403, body: WRONG_ONE });
		expect(countOf(token)).toBe(1);
		expectUnchanged({ ...before, sessions: snapshotDb().sessions });

		const right = await connect({ currentPassword: FIXTURE_PASSWORD, currentCode: confirmed.body.currentCode });
		expect(right.status, JSON.stringify(right.body)).toBe(200);
		expect(right.body.success).toBe(true);
		expect(backupConfig().destinations[1]).toMatchObject({ name: 'G', refreshToken: 'rt-2701', folderId: 'made-folder-2701' });
	});
});

// ─── 4. What needs no password is refused first ──────────────────────────────

describe('everything refusable without the password is refused first (case 4)', () => {
	it('an ordinary user on purge-archived, an administrator when the gate read them, is refused by the guard: 403, nothing counted, no password compared', async () => {
		const s = scene();
		const confirmed = stepUp(s.member);
		const token = tokenOf(confirmed);
		const before = snapshotDb();

		// Past the quick check, as the gate read them; the guard asks who they are now.
		const res = await api('POST', '/api/admin/purge-archived', {
			...confirmed,
			user: { ...s.member, role: 'admin' },
			credential: sessionCredential(token)
		});

		expect(answer(res)).toEqual({ status: 403, body: { message: 'Forbidden' } });
		expect(stub.compared).toBe(0);
		expect(countOf(token)).toBe(0);
		expectUnchanged(before);
	});

	// Slice 2a: the account routes' own refusals, each made with the right
	// password sent, before it is looked at.
	it.each([
		{
			what: 'an administrator deleting the superadmin',
			confirm: (s: Scene) => stepUp(s.admin),
			send: (s: Scene, confirmed: Confirmed) => api('DELETE', `/api/users/${s.chief.id}`, confirmed),
			refused: { status: 403, body: { message: 'Cannot delete superadmin account' } }
		},
		{
			what: 'a role change with a username another account has',
			confirm: (s: Scene) => stepUp(s.chief, { role: 'admin', username: 'admin' }),
			send: (s: Scene, confirmed: Confirmed) => api('PUT', `/api/users/${s.member.id}`, confirmed),
			refused: { status: 409, body: { message: 'Username already taken' } }
		},
		{
			what: 'an invite with no mail host',
			confirm: (s: Scene) => stepUp(s.admin),
			send: (s: Scene, confirmed: Confirmed) => api('POST', `/api/users/${s.member.id}/invite`, confirmed),
			refused: { status: 400, body: { message: 'SMTP is not configured' } }
		},
		// Slice 2b: the board and column deletes (D5: the owner check is the service's).
		{
			what: 'an editor deleting a board they do not own',
			setup: (s: Scene) => addBoardMember(s.board, s.member, 'editor'),
			confirm: (s: Scene) => stepUp(s.member),
			send: (s: Scene, confirmed: Confirmed) => api('DELETE', `/api/boards/${s.board.id}`, confirmed),
			refused: { status: 403, body: { message: 'Only board owners and admins can delete boards' } }
		},
		{
			what: "a delivery board's Options column deleted",
			setup: (s: Scene) => makeBoard({ owner: s.admin, name: 'Kept', options: true }),
			confirm: (s: Scene) => stepUp(s.admin),
			send: (_s: Scene, confirmed: Confirmed) =>
				api('DELETE', `/api/columns/${db.select().from(columns).where(eq(columns.role, 'options')).get()!.id}`, confirmed),
			refused: { status: 409, body: { message: 'Every delivery board keeps its Options column. Fold it away with the arrow on its strip instead.' } }
		}
	])('$what is refused by the guard, in its own words: nothing counted, no password compared', async ({ setup, confirm, send, refused }) => {
		const s = scene();
		setup?.(s);
		// Built before the snapshot: it gives the caller the factor its code is made from (card 2771).
		const confirmed = confirm(s);
		const before = snapshotDb();

		const res = await send(s, confirmed);

		expect(answer(res)).toEqual(refused);
		expect(stub.compared).toBe(0);
		// The session made for the request, and its count, which reads none.
		expect(db.select({ count: sessions.wrongPasswordCount }).from(sessions).all()).toEqual([{ count: 0 }]);
		expectUnchanged({ ...before, sessions: snapshotDb().sessions });
	});

	// Card 2751 (T7 to T9, D6): what a report covers, by the one rule every report opens with, asked in the
	// guard: an administrator, who opens every board, is refused a scope that is not there or holds no board.
	it.each([
		{ what: 'T7. a board id that is no board', scope: 'board', scopeId: () => 9999 },
		{ what: 'T8. a grouping with no board in it', scope: 'category', scopeId: () => db.insert(boardCategories).values({ name: 'Empty' }).returning().get().id },
		{ what: 'T9. a grouping id that is no grouping', scope: 'category', scopeId: () => 9999 }
	])('POST /api/reports/email by an administrator on $what, with a wrong password, is refused by the guard: 403, nothing counted', async ({ scope, scopeId }) => {
		const s = scene();
		// Mail set up: past the guard, the next answer would be the password's.
		makeSmtp();
		const wrong = stepUp(
			s.admin,
			{ scope, scopeId: scopeId(), periodStart: '2026-10-01', periodEnd: '2026-10-14', recipients: ['someone@example.test'] },
			WRONG
		);
		const before = snapshotDb();

		const res = await api('POST', '/api/reports/email', wrong);

		expect(answer(res)).toEqual({ status: 403, body: { message: 'Failed to generate report or no access' } });
		expect(stub.compared).toBe(0);
		expect(countOf(tokenOf(wrong))).toBe(0);
		expectUnchanged({ ...before, sessions: snapshotDb().sessions });
	});
});

// ─── 5. What is read with no row is read before the password ─────────────────

describe('the fields read with no row are read before the password (case 5)', () => {
	it('refuses POST /api/users with a bad email and a wrong password 400, in the words for the email, nothing counted', async () => {
		const s = scene();
		const wrong = stepUp(s.admin, { username: 'newcomer', email: 'not an email', password: 'a long new password' }, WRONG);
		const before = snapshotDb();

		const res = await api('POST', '/api/users', wrong);

		expect(answer(res)).toEqual({ status: 400, body: { message: 'Valid email required' } });
		expect(stub.compared).toBe(0);
		expect(countOf(tokenOf(wrong))).toBe(0);
		expectUnchanged(before);
	});
});

// ─── 6. The conditional triggers ────────────────────────────────────────────

describe('what asks only when it carries what it guards (case 6)', () => {
	it.each([
		{
			what: 'PUT /api/users/[id] with an emoji alone and no password is its success',
			body: { emoji: '🦊' },
			answered: (s: Scene) => ({ status: 200, body: expect.objectContaining({ id: s.member.id, emoji: '🦊', invitesEnded: 0 }) }),
			changes: true
		},
		{
			what: 'PUT /api/users/[id] with an email and no password is 400',
			body: { email: 'moved@example.test' },
			answered: () => ({ status: 400, body: MISSING }),
			changes: false
		}
	])('$what', async ({ body, answered, changes }) => {
		const s = scene();
		const token = makeSession(s.admin);
		const before = snapshotDb();

		const res = await api('PUT', `/api/users/${s.member.id}`, { user: s.admin, body, headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } });

		expect(answer(res)).toEqual(answered(s));
		expect(stub.compared).toBe(0);
		expect(countOf(token)).toBe(0);
		if (changes) expect(db.select({ emoji: users.emoji }).from(users).where(eq(users.id, s.member.id)).get()).toEqual({ emoji: '🦊' });
		else expectUnchanged(before);
	});

	// Slice 2b: decision 18.
	it('DELETE /api/columns/[id] of an empty column with no password is its success', async () => {
		const s = scene();
		const token = makeSession(s.admin);
		const empty = s.cols['On Hold'].id;

		const res = await api('DELETE', `/api/columns/${empty}`, { user: s.admin, body: {}, headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } });

		expect(answer(res)).toEqual({ status: 200, body: { success: true } });
		expect(stub.compared).toBe(0);
		expect(countOf(token)).toBe(0);
		expect(db.select().from(columns).where(eq(columns.id, empty)).get()).toBeUndefined();
	});

	// Slice 2c: decision 17's backup trigger.
	it.each([
		{
			what: 'PUT /api/admin/backup without destinations and no password is its success',
			body: { retention: 9 },
			answered: { status: 200, body: { success: true } },
			retention: 9
		},
		{
			what: 'PUT /api/admin/backup with destinations and no password is 400',
			body: { retention: 9, destinations: [BUCKET, DRIVE] },
			answered: { status: 400, body: MISSING },
			retention: 7
		}
	])('$what', async ({ body, answered, retention }) => {
		const s = scene();
		backingUp();
		const token = makeSession(s.admin);

		const res = await api('PUT', '/api/admin/backup', { user: s.admin, body, headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } });

		expect(answer(res)).toEqual(answered);
		expect(stub.compared).toBe(0);
		expect(countOf(token)).toBe(0);
		expect(backupConfig()).toMatchObject({ retention, destinations: [BUCKET, DRIVE] });
	});

	// Card 2697, B2b (Q21, case 60 (b) and (c)): a person's account asks, linked or unlinked; a rename asks nothing.
	it.each([
		{
			what: 'PUT /api/people/[id] linking an account with no password is 400, nothing changed',
			body: (s: Scene) => ({ userId: s.member.id }),
			linkedToMember: false,
			answered: () => ({ status: 400, body: MISSING })
		},
		{
			what: 'PUT /api/people/[id] unlinking its account with no password is 400, nothing changed',
			body: () => ({ userId: null }),
			linkedToMember: true,
			answered: () => ({ status: 400, body: MISSING })
		},
		{
			what: 'PUT /api/people/[id] with a name and a job title alone and no password is its success',
			body: () => ({ fullName: 'Pat Renamed', jobTitle: 'Engineer' }),
			linkedToMember: false,
			answered: () => ({ status: 200, body: expect.objectContaining({ fullName: 'Pat Renamed', jobTitle: 'Engineer', email: 'pat.doe@example.test' }) })
		}
	])('$what', async ({ body, linkedToMember, answered }) => {
		const s = scene();
		const { person, row } = aLinkHolder();
		if (linkedToMember) db.update(people).set({ userId: s.member.id }).where(eq(people.id, person.id)).run();
		const token = makeSession(s.admin);
		const before = snapshotDb();

		const res = await api('PUT', `/api/people/${person.id}`, { user: s.admin, body: body(s), headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } });

		expect(answer(res)).toEqual(answered());
		expect(stub.compared).toBe(0);
		expect(countOf(token)).toBe(0);
		if (res.status === 200) {
			expect(db.select({ fullName: people.fullName, jobTitle: people.jobTitle }).from(people).where(eq(people.id, person.id)).get()).toEqual({
				fullName: 'Pat Renamed',
				jobTitle: 'Engineer'
			});
			// A rename moves no mail: the link stands.
			expect(linkRevokedReasons(row.id)).toEqual([]);
		} else {
			expectUnchanged(before);
		}
	});

	// Card 2751 (T6, D2): a narrower filter asks nothing; written in the transaction that decided.
	it('T6. PUT /api/report-schedules/[id] narrowing a schedule from All work to Completed only, with no password, is its success', async () => {
		const s = scene();
		const id = scheduleOf(s.admin, s.board, { statusFilter: 'all', recipients: 'a@x.test' });
		const token = makeSession(s.admin);

		const res = await api('PUT', `/api/report-schedules/${id}`, { user: s.admin, body: { statusFilter: 'completed' }, headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } });

		expect(answer(res)).toEqual({ status: 200, body: expect.objectContaining({ id, statusFilter: 'completed', recipients: 'a@x.test' }) });
		expect(stub.compared).toBe(0);
		expect(countOf(token)).toBe(0);
	});

	// Case 60 (d): a refusal that needs no password is made before one is looked at.
	it("PUT /api/people/[id] with another person's address and a wrong password is 409 before any password, nothing counted", async () => {
		const s = scene();
		const { person } = aLinkHolder();
		makePerson({ fullName: 'Someone Else', email: 'someone.else@example.test' });
		const wrong = stepUp(s.admin, { email: 'someone.else@example.test' }, WRONG);
		const before = snapshotDb();

		const res = await api('PUT', `/api/people/${person.id}`, wrong);

		expect(res.status, JSON.stringify(res.body)).toBe(409);
		expect(stub.compared).toBe(0);
		expect(countOf(tokenOf(wrong))).toBe(0);
		expectUnchanged({ ...before, sessions: snapshotDb().sessions });
	});

	// The code review's part B (S1): the add, the delete and Add from accounts make their refusals first too.
	it.each([
		{
			what: "POST /api/people with another person's address",
			confirm: (s: Scene) => stepUp(s.admin, { fullName: 'Another Pat', email: 'pat.doe@example.test' }, WRONG),
			send: (confirmed: Confirmed) => api('POST', '/api/people', confirmed),
			refused: { status: 409, body: { message: 'Email already in the directory: Pat Doe' } }
		},
		{
			what: 'DELETE /api/people/[id] of nobody',
			confirm: (s: Scene) => stepUp(s.admin, {}, WRONG),
			send: (confirmed: Confirmed) => api('DELETE', '/api/people/9999', confirmed),
			refused: { status: 404, body: { message: 'Person not found' } }
		},
		{
			what: 'POST /api/people/from-accounts with an id that is no account',
			confirm: (s: Scene) => stepUp(s.admin, { userIds: [s.member.id, 9999] }, WRONG),
			send: (confirmed: Confirmed) => api('POST', '/api/people/from-accounts', confirmed),
			refused: { status: 400, body: { message: 'userId 9999 is not an account' } }
		}
	])('$what and a wrong password is refused by the guard, before any password: nothing counted or changed', async ({ confirm, send, refused }) => {
		const s = scene();
		aLinkHolder();
		// Built before the snapshot: it gives the caller the factor its code is made from (card 2771).
		const confirmed = confirm(s);
		const before = snapshotDb();

		const res = await send(confirmed);

		expect(answer(res)).toEqual(refused);
		expect(stub.compared).toBe(0);
		expect(db.select({ count: sessions.wrongPasswordCount }).from(sessions).all()).toEqual([{ count: 0 }]);
		expectUnchanged({ ...before, sessions: snapshotDb().sessions });
	});

	// Case 60 (e): the stored hash moved between the check and the write.
	it('PUT /api/people/[id] with an address, whose stored hash moved after the check, is 409 and changes nothing', async () => {
		const s = scene();
		const { person, row } = aLinkHolder();
		const confirmed = stepUp(s.admin, { email: 'moved.person@example.test' });
		const release = holdChecks();

		const pending = api('PUT', `/api/people/${person.id}`, confirmed);
		await vi.waitFor(() => expect(stub.compared).toBe(1));
		db.update(users).set({ passwordHash: hashSync(FIXTURE_PASSWORD, 4) }).where(eq(users.id, s.admin.id)).run();
		release();
		const res = await pending;

		expect(answer(res)).toEqual({ status: 409, body: { message: PASSWORD_CHANGED_MEANWHILE, stepUp: 'changed' } });
		expect(db.select({ email: people.email }).from(people).where(eq(people.id, person.id)).get()).toEqual({ email: 'pat.doe@example.test' });
		expect(linkRevokedReasons(row.id)).toEqual([]);
	});
});

// ─── 7 and 8. No session cookie; no usable password ──────────────────────────

describe('what is refused before anything is counted (cases 7 and 8)', () => {
	it('refuses a request with no session cookie 401, nothing counted and no password compared', async () => {
		const s = scene();
		const token = makeSession(s.admin);
		const currentCode = stepUpCode(s.admin);
		const before = snapshotDb();

		const res = await api('POST', '/api/admin/purge-archived', { user: s.admin, body: { currentPassword: FIXTURE_PASSWORD, currentCode } });

		expect(answer(res)).toEqual({ status: 401, body: { message: 'Not authenticated' } });
		expect(stub.compared).toBe(0);
		expect(countOf(token)).toBe(0);
		expectUnchanged(before);
	});

	it('refuses an account with no usable password 403, with no check, nothing counted, and one WARN line', async () => {
		const s = scene();
		db.update(users).set({ passwordHash: 'no-bcrypt-hash' }).where(eq(users.id, s.admin.id)).run();
		const confirmed = stepUp(s.admin);
		const before = snapshotDb();
		logAt('WARN');

		const res = await api('POST', '/api/admin/purge-archived', confirmed);

		expect(answer(res)).toEqual({ status: 403, body: { message: STEP_UP_NO_PASSWORD, stepUp: 'no-password' } });
		expect(stub.compared).toBe(0);
		expect(countOf(tokenOf(confirmed))).toBe(0);
		expectUnchanged(before);
		expect(linesStarting('WARN', '')).toEqual([
			{
				message: `Password not confirmed for user ${s.admin.id} on POST /api/admin/purge-archived: the account has no usable password`,
				userId: s.admin.id
			}
		]);
	});
});

// ─── 9 to 16. The count on the session's row ─────────────────────────────────

describe("the count of wrong passwords on the session's row (cases 9 to 16)", () => {
	it('ends the session at the third wrong password, through the gate, with its cookie cleared and a WARN line, and answers the next request 401', async () => {
		const s = scene();
		const token = makeSession(s.admin);
		const headers = { cookie: `${SESSION_COOKIE_NAME}=${token}`, ...FROM_THE_PAGE, accept: 'application/json' };
		const currentCode = stepUpCode(s.admin);
		const send = (currentPassword: string) => gate('POST', '/api/admin/purge-archived', { headers, body: { currentPassword, currentCode } });
		logAt('WARN');

		for (let n = 1; n <= 2; n++) {
			const res = await send(WRONG);
			expect({ status: res.status, body: await res.json() }).toEqual({ status: 403, body: WRONG_ONE });
			expect(countOf(token)).toBe(n);
		}
		const third = await send(WRONG);

		expect({ status: third.status, body: await third.json() }).toEqual({ status: 403, body: SIGNED_OUT });
		expect(third.headers.get('set-cookie')).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=;.*Max-Age=0`, 'i'));
		expect(countOf(token)).toBeUndefined();
		expect(linesStarting('WARN', 'Session ended')).toEqual([
			{
				message: `Session ended after three wrong current passwords for user ${s.admin.id} on POST /api/admin/purge-archived`,
				userId: s.admin.id
			}
		]);
		const next = await send(FIXTURE_PASSWORD);
		expect(next.status).toBe(401);
		expect(archivedLeft()).toBe(1);
	});

	it.each([
		['the memory of the server forgotten, as a restart forgets it', () => {
			forgetChecksInFlight();
			forgetImportConfirmations();
			resetAllRateLimits();
		}],
		// Eleven hours: inside an administrator's idle limit of twelve, which
		// would end the session itself (card 2775).
		['eleven hours gone by', () => vi.setSystemTime(Date.now() + 11 * 60 * 60 * 1000)]
	])('keeps the count for the session’s whole life: two wrong, %s, and the third signs out', async (_between, meanwhile) => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const s = scene();
		const wrong = stepUp(s.admin, {}, WRONG);
		const token = tokenOf(wrong);

		expect((await api('POST', '/api/admin/purge-archived', wrong)).status).toBe(403);
		expect(countOf(token)).toBe(1);
		expect((await api('POST', '/api/admin/purge-archived', wrong)).status).toBe(403);
		expect(countOf(token)).toBe(2);
		meanwhile();

		expect(answer(await api('POST', '/api/admin/purge-archived', wrong))).toEqual({ status: 403, body: SIGNED_OUT });
		expect(countOf(token)).toBeUndefined();
	});

	it('keeps one count for the Account forms and the admin actions, which only a right password and code clear', async () => {
		const s = scene();
		const token = makeSession(s.admin);
		const cookie = { cookie: `${SESSION_COOKIE_NAME}=${token}` };
		// A code made for each send: the right one before the last spends its step.
		const purge = (currentPassword: string) =>
			api('POST', '/api/admin/purge-archived', { user: s.admin, body: { currentPassword, currentCode: stepUpCode(s.admin) }, headers: cookie });

		// Through the step-up since card 2771, in its words.
		for (let n = 1; n <= 2; n++) {
			const res = await api('PUT', '/api/account/email', {
				user: s.admin,
				body: { newEmail: 'moved@example.test', currentPassword: WRONG, currentCode: stepUpCode(s.admin) },
				headers: cookie
			});
			expect(answer(res)).toEqual({ status: 403, body: WRONG_ONE });
		}
		expect(countOf(token)).toBe(2);

		expect(answer(await purge(FIXTURE_PASSWORD))).toEqual({ status: 200, body: { success: true, purged: 1 } });
		expect(countOf(token)).toBe(0);

		// One wrong after it is the first again, not the third.
		expect(answer(await purge(WRONG))).toEqual({ status: 403, body: WRONG_ONE });
		expect(countOf(token)).toBe(1);
	});

	it.each([
		{ path: '/api/account/email', method: 'PUT' as const, body: (currentPassword: string) => ({ newEmail: 'moved@example.test', currentPassword }) },
		{ path: '/api/account/password', method: 'PUT' as const, body: (currentPassword: string) => ({ currentPassword, newPassword: 'a new long password' }) },
		{ path: '/api/account/api-keys', method: 'POST' as const, body: (currentPassword: string) => ({ name: 'my script', currentPassword }) }
	])("$method $path: the first two wrong passwords in the step-up's words (card 2771), and the third signs the session out", async ({ path, method, body }) => {
		const s = scene();
		const token = makeSession(s.member);
		const currentCode = stepUpCode(s.member);
		const send = () => api(method, path, { user: s.member, body: { ...body(WRONG), currentCode }, headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } });

		for (let n = 1; n <= 2; n++) expect(answer(await send())).toEqual({ status: 403, body: WRONG_ONE });
		expect(answer(await send())).toEqual({ status: 403, body: SIGNED_OUT });

		expect(countOf(token)).toBeUndefined();
		expect(db.select({ email: users.email, hash: users.passwordHash }).from(users).where(eq(users.id, s.member.id)).get()).toEqual({
			email: 'member@example.test',
			hash: FIXTURE_PASSWORD_HASH
		});
	});

	it('refuses a session whose stored count is 3 with no password compared, the right one included, and ends it', async () => {
		const s = scene();
		const confirmed = stepUp(s.admin);
		const token = tokenOf(confirmed);
		db.update(sessions).set({ wrongPasswordCount: 3 }).where(eq(sessions.tokenHash, sessionHashOf(token))).run();

		const res = await api('POST', '/api/admin/purge-archived', confirmed);

		expect(answer(res)).toEqual({ status: 403, body: SIGNED_OUT });
		expect(stub.compared).toBe(0);
		expect(countOf(token)).toBeUndefined();
		expect(archivedLeft()).toBe(1);
	});

	it('checks one password at a time for a session: a second is 429 with no compare, and not counted; another session of the account goes ahead, and with the same code loses its spend (card 2771, E3)', async () => {
		const s = scene();
		const first = stepUp(s.admin);
		const token = tokenOf(first);
		// The same code, from another session: both pass step 2b before either spends it.
		const other = stepUp(s.admin, {}, FIXTURE_PASSWORD, first.body.currentCode as string);
		const otherToken = tokenOf(other);
		const release = holdChecks();

		const held = api('POST', '/api/admin/purge-archived', first);
		await vi.waitFor(() => expect(stub.compared).toBe(1));
		const second = await api('POST', '/api/admin/purge-archived', first);

		expect(answer(second)).toEqual({ status: 429, body: { message: STEP_UP_IN_FLIGHT, stepUp: 'in-flight' } });
		expect(stub.compared).toBe(1);
		// The first, which compares, is counted; the second compared nothing (the code review's S1).
		expect(countOf(token)).toBe(1);

		const elsewhere = api('POST', '/api/admin/purge-archived', other);
		await vi.waitFor(() => expect(stub.compared).toBe(2));
		release();

		// Both passwords right; the step is spent once. Whichever spends it goes through and clears its count; the
		// other is 403 wrong, counted on its own session: a spend lost after the compare is never code-spent (S1).
		const both = [await held, await elsewhere].map(answer).sort((a, b) => a.status - b.status);
		expect(both).toEqual([
			{ status: 200, body: { success: true, purged: 1 } },
			{ status: 403, body: WRONG_ONE }
		]);
		expect([countOf(token), countOf(otherToken)].sort()).toEqual([0, 1]);
		expect(archivedLeft()).toBe(0);
	});

	/** Take every one of the account's places in the first lane of password checks, as five checks in flight would. */
	function fillFirstLane(userId: number): () => void {
		const place = firstLaneChecksAt(userId);
		for (let n = 0; n < FIRST_LANE_CHECKS_PER_ACCOUNT; n++) expect(enterSignIn(place, FIRST_LANE_CHECKS_PER_ACCOUNT)).toBe(true);
		return () => {
			for (let n = 0; n < FIRST_LANE_CHECKS_PER_ACCOUNT; n++) leaveSignIn(place);
		};
	}

	it('answers 429 busy, with no compare and the count unchanged, when the account has no place left in the first lane (the code review’s S1)', async () => {
		const s = scene();
		const confirmed = stepUp(s.admin, {}, WRONG);
		const token = tokenOf(confirmed);
		db.update(sessions).set({ wrongPasswordCount: 2 }).where(eq(sessions.tokenHash, sessionHashOf(token))).run();
		const free = fillFirstLane(s.admin.id);

		const res = await api('POST', '/api/admin/purge-archived', confirmed);
		free();

		expect(answer(res)).toEqual({ status: 429, body: { message: PASSWORDS_BUSY, stepUp: 'busy' } });
		expect(stub.compared).toBe(0);
		// Two, as it was: a third that compared nothing does not end the session.
		expect(countOf(token)).toBe(2);
		expect(archivedLeft()).toBe(1);
	});

	it('never ends a session for refusals that compared nothing: three busy answers, and the right password then goes through', async () => {
		const s = scene();
		const confirmed = stepUp(s.admin);
		const token = tokenOf(confirmed);
		const free = fillFirstLane(s.admin.id);

		for (let n = 1; n <= 3; n++) {
			expect((await api('POST', '/api/admin/purge-archived', confirmed)).status).toBe(429);
			expect(countOf(token)).toBe(0);
		}
		free();

		expect(stub.compared).toBe(0);
		expect(answer(await api('POST', '/api/admin/purge-archived', confirmed))).toEqual({ status: 200, body: { success: true, purged: 1 } });
		expect(countOf(token)).toBe(0);
	});

	it.each([
		['the right password', FIXTURE_PASSWORD, false],
		['a wrong one', WRONG, false],
		['the right password with a recovery code', FIXTURE_PASSWORD, true]
	])('answers %s signed out when the session ended while it was being checked, in the same words, spending no code (card 2771)', async (_which, password, recovery) => {
		const s = scene();
		const given = giveFactor(s.admin);
		const confirmed = stepUp(s.admin, {}, password, recovery ? given.recoveryCodes[0] : stepUpCode(s.admin));
		const token = tokenOf(confirmed);
		const release = holdChecks();

		const pending = api('POST', '/api/admin/purge-archived', confirmed);
		await vi.waitFor(() => expect(stub.compared).toBe(1));
		deleteSession(sessionHashOf(token), 'signed out elsewhere');
		release();

		expect(answer(await pending)).toEqual({ status: 403, body: SIGNED_OUT });
		expect(archivedLeft()).toBe(1);
		// Neither the step nor a recovery code is spent by a session that ended meanwhile.
		expect(lastStepOf(s.admin)).toBeNull();
		expect(recoveryUsed(s.admin)).toBe(0);
	});

	it("leaves sign-in's counts alone: the address's attempts, the account's wrong sign-ins, no wait, and the code lanes, their pauses and the lock, which do not stop a step-up (card 2771, D6)", async () => {
		const s = scene();
		const address = '203.0.113.9';
		const wrong = stepUp(s.admin, {}, WRONG);
		/** Sign-in's code lanes, their pauses and the recovery count (master plan D4). */
		const lanes = () =>
			db
				.select({
					known: users.mfaKnownWrong,
					other: users.mfaOtherWrong,
					knownResumes: users.mfaKnownResumesAt,
					otherResumes: users.mfaOtherResumesAt,
					recovery: users.mfaRecoveryWrong,
					recoveryResumes: users.mfaRecoveryResumesAt
				})
				.from(users)
				.where(eq(users.id, s.admin.id))
				.get();
		const was = lanes();

		for (let n = 1; n <= 2; n++) expect((await api('POST', '/api/admin/purge-archived', { ...wrong, ip: address })).status).toBe(403);

		// Card 2771: from another session, the right password with a wrong authenticator code and with a recovery code the account does not hold.
		const codes = stepUp(s.admin);
		for (const currentCode of [wrongCodeOf(s.admin), 'ABCD-EFGH-JKMN-PQRS']) {
			const res = await api('POST', '/api/admin/purge-archived', { ...codes, ip: address, body: { currentPassword: FIXTURE_PASSWORD, currentCode } });
			expect(answer(res)).toEqual({ status: 403, body: WRONG_ONE });
		}

		expect(wrongSignInsAt(`user:${s.admin.id}`)).toBe(0);
		expect(signInWait(`user:${s.admin.id}`)).toBe(0);
		// The address's next sign-in attempt is the first of its window.
		expect(checkRateLimit(`login:${addressKey(address)}`).attempts).toBe(1);
		expect(lanes()).toEqual(was);

		// Authenticator codes locked at sign-in: a step-up still takes one.
		db.update(users).set({ mfaKnownWrong: 30 }).where(eq(users.id, s.admin.id)).run();
		expect(answer(await api('POST', '/api/admin/purge-archived', { ...codes, ip: address }))).toEqual({ status: 200, body: { success: true, purged: 1 } });
	});
});

// ─── 17. Never the password ──────────────────────────────────────────────────

describe('the password in the log and the answers (case 17)', () => {
	it('writes one INFO line for each right password, and no log line or answer holds a password or a confirmation', async () => {
		const s = scene();
		const guess = 'a wrong guess for 2701';
		logAt('INFO');

		const answers = [
			await api('POST', '/api/admin/purge-archived', stepUp(s.admin)),
			await api('POST', '/api/admin/purge-archived', stepUp(s.admin, {}, guess))
		];
		const confirmed = await api('POST', '/api/admin/import/confirm', stepUp(s.chief));
		const ended = stepUp(s.admin, {}, guess);
		db.update(sessions).set({ wrongPasswordCount: 3 }).where(eq(sessions.tokenHash, sessionHashOf(tokenOf(ended)))).run();
		answers.push(await api('POST', '/api/admin/purge-archived', ended));

		expect(answers.map((res) => res.status)).toEqual([200, 403, 403]);
		expect(confirmed.status).toBe(200);
		// Card 2771 (D13): the password and the code.
		expect(linesStarting('INFO', 'Password')).toEqual([
			{ message: `Password and code confirmed by admin (ID: ${s.admin.id}) for POST /api/admin/purge-archived`, userId: s.admin.id },
			{ message: `Password and code confirmed by chief (ID: ${s.chief.id}) for POST /api/admin/import/confirm`, userId: s.chief.id }
		]);
		const logged = JSON.stringify(sqlite.prepare('SELECT message, context, meta FROM system_logs').all());
		for (const secret of [FIXTURE_PASSWORD, guess, confirmed.body.confirmation]) expect(logged).not.toContain(secret);
		for (const res of answers) {
			for (const secret of [FIXTURE_PASSWORD, guess, confirmed.body.confirmation]) expect(JSON.stringify(res.body)).not.toContain(secret);
		}
		expect(JSON.stringify(confirmed.body)).not.toContain(FIXTURE_PASSWORD);
	});
});

// ─── Card 2771: the code beside the password (T1 to T11) ────────────────────

describe('the code from the authenticator app, or a recovery code, beside the password (card 2771, T1 to T11)', () => {
	const PURGE = '/api/admin/purge-archived';
	/** What a code in neither form is answered (D2). */
	const MALFORMED = { message: STEP_UP_CODE_MALFORMED, stepUp: 'code-malformed' };
	/** What a code whose step is already spent is answered (D3). */
	const SPENT = { message: STEP_UP_CODE_SPENT, stepUp: 'code-spent' };
	/** The account's row, as the signal reads it. */
	const userRow = (user: { id: number }) => db.select().from(users).where(eq(users.id, user.id)).get()!;
	/** Mail sent through a mail host, recorded and not sent, until the test ends. */
	const mailed = () => {
		makeSmtp();
		const sent = effects();
		onTestFinished(() => sent.restore());
		return sent;
	};

	it.each([
		['absent', undefined],
		['empty', ''],
		['a number', 5],
		['null', null]
	])('T1. answers the right password with the code %s 400 missing: no compare, nothing counted, nothing spent', async (_what, code) => {
		const s = scene();
		const confirmed = stepUp(s.admin);
		const token = tokenOf(confirmed);
		const body = code === undefined ? { currentPassword: FIXTURE_PASSWORD } : { currentPassword: FIXTURE_PASSWORD, currentCode: code };
		const before = snapshotDb();

		const res = await api('POST', PURGE, { ...confirmed, body });

		expect(answer(res)).toEqual({ status: 400, body: MISSING });
		expect(stub.compared).toBe(0);
		expect(countOf(token)).toBe(0);
		expect(lastStepOf(s.admin)).toBeNull();
		expectUnchanged(before);
	});

	it('T2. answers a code in neither form 400 code-malformed with a right or a wrong password, uncounted and with no compare, and lets through six digits with spaces and a recovery code in lower case with spaces', async () => {
		const s = scene();
		const given = giveFactor(s.admin);
		const confirmed = stepUp(s.admin);
		const token = tokenOf(confirmed);
		const recovery = given.recoveryCodes[0];
		const before = snapshotDb();

		for (const code of [
			'12345',
			'1234567',
			'12a456',
			// A recovery code cut at the authenticator field's seven characters (SR1).
			recovery.slice(0, 7),
			// Sixty-five characters, a recovery code the account holds among them: refused for its length before any pattern (S7).
			`${' '.repeat(65 - recovery.length)}${recovery}`
		]) {
			for (const password of [FIXTURE_PASSWORD, WRONG]) {
				const res = await api('POST', PURGE, { ...confirmed, body: { currentPassword: password, currentCode: code } });
				expect(answer(res), JSON.stringify(code)).toEqual({ status: 400, body: MALFORMED });
			}
		}
		expect(stub.compared).toBe(0);
		expect(countOf(token)).toBe(0);
		expectUnchanged(before);

		// Passed through, and good: the authenticator's code with spaces round and in it, and then a recovery code as typed.
		const code = confirmed.body.currentCode as string;
		const spaced = await api('POST', PURGE, { ...confirmed, body: { currentPassword: FIXTURE_PASSWORD, currentCode: ` ${code.slice(0, 3)} ${code.slice(3)} ` } });
		expect(answer(spaced)).toEqual({ status: 200, body: { success: true, purged: 1 } });
		const typed = ` ${recovery.toLowerCase().replace(/-/g, ' ')} `;
		const byRecovery = await api('POST', PURGE, { ...confirmed, body: { currentPassword: FIXTURE_PASSWORD, currentCode: typed } });
		expect(answer(byRecovery)).toEqual({ status: 200, body: { success: true, purged: 0 } });
		expect(stub.compared).toBe(2);
		expect(recoveryUsed(s.admin)).toBe(1);
	});

	it('T3. counts a right password with a wrong code once, answers it as a wrong password, spends nothing, raises the signal and mails it once an hour, and the third wrong answer signs the session out', async () => {
		const s = scene();
		const sent = mailed();
		logAt('WARN');
		const token = makeSession(s.admin);
		const headers = { cookie: `${SESSION_COOKIE_NAME}=${token}`, ...FROM_THE_PAGE, accept: 'application/json' };
		const code = stepUpCode(s.admin);
		const wrongCode = wrongCodeOf(s.admin);
		const send = async (currentPassword: string, currentCode: string) => {
			const res = await gate('POST', PURGE, { headers, body: { currentPassword, currentCode } });
			return { status: res.status, body: await res.json(), cookie: res.headers.get('set-cookie') };
		};

		const wrongCodeAnswer = await send(FIXTURE_PASSWORD, wrongCode);
		expect(wrongCodeAnswer).toMatchObject({ status: 403, body: WRONG_ONE });
		expect(countOf(token)).toBe(1);
		expect(lastStepOf(s.admin)).toBeNull();
		expect(linesStarting('WARN', 'Wrong code')).toEqual([
			{ message: `Wrong code for user ${s.admin.id} on POST /api/admin/purge-archived: the password was right`, userId: s.admin.id }
		]);
		expect(userRow(s.admin)).toMatchObject({ securityBanner: 'wrong-code', failedCodesSinceSignIn: 1 });
		await sent.settle();
		expect(sent.emails.map((mail) => mail.subject)).toEqual(['Your DumpFire password was used with a wrong code']);
		expect(sent.emails[0].html).toContain('while confirming a change, and then a wrong code.');

		// A second wrong code within the hour, from another session: counted there, and no second notice.
		const elsewhere = stepUp(s.admin, {}, FIXTURE_PASSWORD, wrongCode);
		expect(answer(await api('POST', PURGE, elsewhere))).toEqual({ status: 403, body: WRONG_ONE });
		expect(userRow(s.admin).failedCodesSinceSignIn).toBe(2);
		await sent.settle();
		expect(sent.emails).toHaveLength(1);

		// A wrong password with the right code: the same body, counted, the code unspent, no signal.
		const wrongPassword = await send(WRONG, code);
		expect(wrongPassword.body).toEqual(wrongCodeAnswer.body);
		expect(countOf(token)).toBe(2);
		expect(lastStepOf(s.admin)).toBeNull();
		expect(userRow(s.admin).failedCodesSinceSignIn).toBe(2);

		// The third: a right password and a wrong code signs the session out.
		const third = await send(FIXTURE_PASSWORD, wrongCode);
		expect({ status: third.status, body: third.body }).toEqual({ status: 403, body: SIGNED_OUT });
		expect(third.cookie).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=;.*Max-Age=0`, 'i'));
		expect(countOf(token)).toBeUndefined();
		expect(archivedLeft()).toBe(1);
		await sent.settle();
		expect(sent.emails).toHaveLength(1);
	});

	it('T4. lets the right password and the right code through on a new session, the code a wrong password was sent with before, unspent: the count cleared, the step spent, and the INFO line', async () => {
		const s = scene();
		logAt('INFO');
		const at = Date.now();
		const code = stepUpCode(s.admin, at);
		expect((await api('POST', PURGE, stepUp(s.admin, {}, WRONG, code))).status).toBe(403);
		expect(lastStepOf(s.admin)).toBeNull();

		const right = stepUp(s.admin, {}, FIXTURE_PASSWORD, code);
		const res = await api('POST', PURGE, right);

		expect(answer(res)).toEqual({ status: 200, body: { success: true, purged: 1 } });
		expect(countOf(tokenOf(right))).toBe(0);
		expect(factorRow(s.admin)).toMatchObject({ lastStep: stepAt(at), lastUsedAt: expect.stringMatching(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/) });
		expect(linesStarting('INFO', 'Password and code confirmed')).toEqual([
			{ message: `Password and code confirmed by admin (ID: ${s.admin.id}) for POST /api/admin/purge-archived`, userId: s.admin.id }
		]);
	});

	it('T5. answers a code whose step is spent 400 code-spent before the password is compared, with the right password or a wrong one: nothing counted, nothing spent, the secret zeroed', async () => {
		const s = scene();
		const confirmed = stepUp(s.admin);
		const token = tokenOf(confirmed);
		expect((await api('POST', PURGE, confirmed)).status).toBe(200);
		const spent = lastStepOf(s.admin);
		expect(spent).not.toBeNull();
		db.update(sessions).set({ wrongPasswordCount: 2 }).where(eq(sessions.tokenHash, sessionHashOf(token))).run();
		const fill = vi.spyOn(Buffer.prototype, 'fill');

		for (const password of [FIXTURE_PASSWORD, WRONG]) {
			const res = await api('POST', PURGE, { ...confirmed, body: { currentPassword: password, currentCode: confirmed.body.currentCode } });
			expect(answer(res)).toEqual({ status: 400, body: SPENT });
		}

		// Only the success compared a password: neither of these did.
		expect(stub.compared).toBe(1);
		expect(countOf(token)).toBe(2);
		expect(lastStepOf(s.admin)).toBe(spent);
		// The secret, opened at step 2b to read the step, was zeroed each time.
		const zeroed = fill.mock.contexts.filter((buffer, n) => fill.mock.calls[n][0] === 0 && (buffer as Buffer).length === 20);
		expect(zeroed.length).toBeGreaterThanOrEqual(2);
		for (const buffer of zeroed) expect([...(buffer as Buffer)].every((byte) => byte === 0)).toBe(true);
	});

	it('T6. takes a recovery code once: its use spent, the count cleared, a WARN line and a notice in the words for a confirmation; the same again, or one the account does not hold, is a wrong one', async () => {
		const s = scene();
		const sent = mailed();
		logAt('WARN');
		const { recoveryCodes } = giveFactor(s.admin);
		const confirmed = stepUp(s.admin, {}, FIXTURE_PASSWORD, recoveryCodes[0]);
		const token = tokenOf(confirmed);

		expect(answer(await api('POST', PURGE, confirmed))).toEqual({ status: 200, body: { success: true, purged: 1 } });
		expect(recoveryUsed(s.admin)).toBe(1);
		expect(countOf(token)).toBe(0);
		expect(lastStepOf(s.admin)).toBeNull();
		expect(linesStarting('WARN', 'A recovery code')).toEqual([
			{ message: `A recovery code confirmed POST /api/admin/purge-archived for admin (ID: ${s.admin.id}): 9 left`, userId: s.admin.id }
		]);
		await sent.settle();
		expect(sent.emails.map((mail) => mail.subject)).toEqual(['A recovery code was used to confirm a change on DumpFire']);
		expect(sent.emails[0].html).toContain('A recovery code was used to confirm a change on your DumpFire account');

		// The same code again: wrong, counted, and the signal raised.
		expect(answer(await api('POST', PURGE, confirmed))).toEqual({ status: 403, body: WRONG_ONE });
		expect(countOf(token)).toBe(1);
		expect(userRow(s.admin).securityBanner).toBe('wrong-code');

		// One in the form that the account does not hold: wrong, counted, no recovery row changed.
		const codesBefore = snapshotDb().mfa_recovery_codes;
		const unknown = await api('POST', PURGE, { ...confirmed, body: { currentPassword: FIXTURE_PASSWORD, currentCode: 'ABCD-EFGH-JKMN-PQRS' } });
		expect(answer(unknown)).toEqual({ status: 403, body: WRONG_ONE });
		expect(countOf(token)).toBe(2);
		expect(snapshotDb().mfa_recovery_codes).toEqual(codesBefore);
	});

	it('T7. refuses an account with no second factor 403 no-factor, with no compare, nothing counted and one WARN line', async () => {
		const s = scene();
		const confirmed = stepUp(s.admin);
		db.delete(mfaFactors).where(eq(mfaFactors.userId, s.admin.id)).run();
		const before = snapshotDb();
		logAt('WARN');

		const res = await api('POST', PURGE, confirmed);

		expect(answer(res)).toEqual({ status: 403, body: { message: STEP_UP_NO_FACTOR, stepUp: 'no-factor' } });
		expect(stub.compared).toBe(0);
		expect(countOf(tokenOf(confirmed))).toBe(0);
		expectUnchanged(before);
		expect(linesStarting('WARN', '')).toEqual([
			{ message: `Password not confirmed for user ${s.admin.id} on POST /api/admin/purge-archived: the account has no second factor`, userId: s.admin.id }
		]);
	});

	it('T8. answers an authenticator code 503 factor-unusable, uncounted, when the factor does not open, and takes a recovery code; a factor that stops opening during the compare fails closed', async () => {
		const s = scene();
		const { recoveryCodes } = giveFactor(s.admin);
		const confirmed = stepUp(s.admin);
		const token = tokenOf(confirmed);
		const keyId = factorRow(s.admin).keyId;
		const otherKey = () => db.update(mfaFactors).set({ keyId: 'another-key' }).where(eq(mfaFactors.userId, s.admin.id)).run();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		otherKey();
		const before = snapshotDb();

		const unusable = await api('POST', PURGE, confirmed);

		expect(answer(unusable)).toEqual({ status: 503, body: { message: STEP_UP_FACTOR_UNUSABLE, stepUp: 'factor-unusable' } });
		expect(stub.compared).toBe(0);
		expect(countOf(token)).toBe(0);
		expectUnchanged(before);
		expect(linesStarting('ERROR', 'A second factor could not be opened')).toHaveLength(1);

		// A recovery code does not need the factor opened.
		const byRecovery = await api('POST', PURGE, { ...confirmed, body: { currentPassword: FIXTURE_PASSWORD, currentCode: recoveryCodes[0] } });
		expect(answer(byRecovery)).toEqual({ status: 200, body: { success: true, purged: 1 } });

		// It opens at step 2b and not in the transaction: nothing spent, counted, and wrong.
		db.update(mfaFactors).set({ keyId }).where(eq(mfaFactors.userId, s.admin.id)).run();
		const again = stepUp(s.admin);
		const release = holdChecks();
		const pending = api('POST', PURGE, again);
		await vi.waitFor(() => expect(stub.compared).toBe(2));
		otherKey();
		release();

		expect(answer(await pending)).toEqual({ status: 403, body: WRONG_ONE });
		expect(countOf(tokenOf(again))).toBe(1);
		expect(lastStepOf(s.admin)).toBeNull();
	});

	it('T9. leaves the code unspent and the attempt counted when the clear of the count fails (E7)', async () => {
		const s = scene();
		const confirmed = stepUp(s.admin);
		const token = tokenOf(confirmed);
		const writes = failingWrite();

		try {
			// The count, the spend, and then the clear (STEP_UP_WRITES): the third is failed.
			writes.failNth(3);
			await expect(api('POST', PURGE, confirmed)).rejects.toThrow(/made to fail/);
			expect(writes.fired).toBe(true);
		} finally {
			writes.restore();
		}

		expect(lastStepOf(s.admin)).toBeNull();
		expect(countOf(token)).toBe(1);
		expect(archivedLeft()).toBe(1);
	});

	it('T9b. judges the code at the moment it arrived: one of the step before then is taken though a step boundary passes during the compare (code review CS2): 200, spent, the count cleared, no signal', async () => {
		const s = scene();
		vi.useFakeTimers({ toFake: ['Date'] });
		// Twenty-five seconds into a step: the code of the step before is good as it arrives.
		const arrived = stepAt(Date.now()) * 30_000 + 25_000;
		vi.setSystemTime(arrived);
		const confirmed = stepUp(s.admin, {}, FIXTURE_PASSWORD, stepUpCode(s.admin, arrived - 30_000));
		const token = tokenOf(confirmed);
		const release = holdChecks();
		const pending = api('POST', PURGE, confirmed);
		await vi.waitFor(() => expect(stub.compared).toBe(1));

		// Ten seconds on, the next step has begun: the code is now two steps back.
		vi.setSystemTime(arrived + 10_000);
		release();

		expect(answer(await pending)).toEqual({ status: 200, body: { success: true, purged: 1 } });
		expect(lastStepOf(s.admin)).toBe(stepAt(arrived) - 1);
		expect(countOf(token)).toBe(0);
		expect(userRow(s.admin)).toMatchObject({ securityBanner: null, failedCodesSinceSignIn: 0 });
	});

	it.each([
		{ path: '/api/account/email', method: 'PUT' as const, body: { newEmail: 'moved@example.test' } },
		{ path: '/api/account/api-keys', method: 'POST' as const, body: { name: 'my script' } }
	])('T10. $method $path no longer reads `password`: the right one sent there, with a right code, is 400 missing, with nothing compared or changed', async ({ path, method, body }) => {
		const s = scene();
		const confirmed = stepUp(s.admin);
		const before = snapshotDb();

		const res = await api(method, path, { ...confirmed, body: { ...body, password: FIXTURE_PASSWORD, currentCode: confirmed.body.currentCode } });

		expect(answer(res)).toEqual({ status: 400, body: MISSING });
		expect(stub.compared).toBe(0);
		expectUnchanged(before);
	});

	it.each([
		{
			what: "an email address the readers refuse, on PUT /api/account/email",
			send: (s: Scene) => api('PUT', '/api/account/email', stepUp(s.admin, { newEmail: 'me@localhost' }, WRONG)),
			refused: { status: 400, body: { message: 'Invalid email address' } }
		},
		{
			// Not 409: whether an address is taken is asked only after the password
			// and the code, so a session cannot learn it uncounted (code review CS1).
			what: 'an email address another account holds, sent with no password, on PUT /api/account/email: missing, never 409 (CS1)',
			send: (s: Scene) => {
				const { user, headers } = stepUp(s.admin);
				return api('PUT', '/api/account/email', { user, headers, body: { newEmail: 'member@example.test' } });
			},
			refused: { status: 400, body: MISSING }
		},
		{
			what: 'an eleventh API key, on POST /api/account/api-keys',
			setup: (s: Scene) => {
				for (let n = 1; n <= 10; n++) makeApiKey(s.admin, `key ${n}`);
			},
			send: (s: Scene) => api('POST', '/api/account/api-keys', stepUp(s.admin, { name: 'one too many' }, WRONG)),
			refused: { status: 400, body: { message: 'Maximum of 10 API keys per user' } }
		},
		{
			what: 'a new password too short, on PUT /api/account/password',
			send: (s: Scene) => api('PUT', '/api/account/password', stepUp(s.admin, { newPassword: 'short' }, WRONG)),
			refused: { status: 400, body: { message: 'New password must be at least 8 characters' } }
		}
	])('T11. refuses $what before the password: no compare, nothing counted', async ({ setup, send, refused }) => {
		const s = scene();
		setup?.(s);

		const res = await send(s);

		expect(answer(res)).toEqual(refused);
		expect(stub.compared).toBe(0);
		expect(db.select({ count: sessions.wrongPasswordCount }).from(sessions).all()).toEqual([{ count: 0 }]);
	});
});

// ─── Card 2772, S1: every authenticator tried, the weight taken first ────────

describe('every authenticator of the account tried, each wrong answer counting one for each (card 2772, T7 to T9)', () => {
	const PURGE = '/api/admin/purge-archived';
	/** The factor with this id as stored. */
	const factorOf = (id: number) => db.select().from(mfaFactors).where(eq(mfaFactors.id, id)).get()!;

	it('T7. takes the second authenticator’s code while the first does not open: 200, the second’s step alone spent, counted 1 (one tried) during the compare, one ERROR line, the count 0 after', async () => {
		const s = scene();
		const first = giveFactor(s.admin);
		const second = giveAuthenticator(s.admin);
		db.update(mfaFactors).set({ keyId: 'another-key' }).where(eq(mfaFactors.id, first.factorId)).run();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const at = Date.now();
		const confirmed = stepUp(s.admin, {}, FIXTURE_PASSWORD, codeFor(second.secret, at));
		const token = tokenOf(confirmed);
		const release = holdChecks();

		const pending = api('POST', PURGE, confirmed);
		await vi.waitFor(() => expect(stub.compared).toBe(1));
		// Counted before the compare, by the authenticators tried: the one that opens.
		expect(countOf(token)).toBe(1);
		release();

		expect(answer(await pending)).toEqual({ status: 200, body: { success: true, purged: 1 } });
		expect(factorOf(second.factorId).lastStep).toBe(stepAt(at));
		expect(factorOf(first.factorId)).toMatchObject({ lastStep: null, lastUsedAt: null });
		// Said once, at step 2b: the transaction's second look does not say it again.
		expect(linesStarting('ERROR', 'A second factor could not be opened')).toHaveLength(1);
		expect(countOf(token)).toBe(0);
	});

	it('T8. answers the second authenticator’s code at its spent step 400 code-spent at step 2b: no compare, nothing counted', async () => {
		const s = scene();
		giveFactor(s.admin);
		const second = giveAuthenticator(s.admin);
		const at = Date.now();
		expect(spendStep(second.factorId, stepAt(at))).toBe('spent');
		const confirmed = stepUp(s.admin, {}, FIXTURE_PASSWORD, codeFor(second.secret, at));
		const token = tokenOf(confirmed);
		const before = snapshotDb();

		const res = await api('POST', PURGE, confirmed);

		expect(answer(res)).toEqual({ status: 400, body: { message: STEP_UP_CODE_SPENT, stepUp: 'code-spent' } });
		expect(stub.compared).toBe(0);
		expect(countOf(token)).toBe(0);
		expectUnchanged(before);
	});

	it('T9. takes the weight before the compare, the same for either wrong part: with two authenticators each wrong answer counts 2 and a recovery code 1; with three one wrong answer signs the session out', async () => {
		const s = scene();
		const first = giveFactor(s.admin);
		const second = giveAuthenticator(s.admin);
		const code = () => codeFor(second.secret);
		const wrongCode = () => wrongCodeFor([first.secret, second.secret]);

		// A wrong password with an authenticator code: 2, counted before the compare.
		const wrongPassword = stepUp(s.admin, {}, WRONG, code());
		const release = holdChecks();
		const pending = api('POST', PURGE, wrongPassword);
		await vi.waitFor(() => expect(stub.compared).toBe(1));
		expect(countOf(tokenOf(wrongPassword))).toBe(2);
		release();
		expect(answer(await pending)).toEqual({ status: 403, body: WRONG_ONE });
		expect(countOf(tokenOf(wrongPassword))).toBe(2);

		// A right password with a wrong code: the same 2, and the same answer, so neither says which part was wrong.
		const wrongOne = stepUp(s.admin, {}, FIXTURE_PASSWORD, wrongCode());
		expect(answer(await api('POST', PURGE, wrongOne))).toEqual({ status: 403, body: WRONG_ONE });
		expect(countOf(tokenOf(wrongOne))).toBe(2);

		// A recovery code with a wrong password: 1.
		const byRecovery = stepUp(s.admin, {}, WRONG, first.recoveryCodes[0]);
		expect(answer(await api('POST', PURGE, byRecovery))).toEqual({ status: 403, body: WRONG_ONE });
		expect(countOf(tokenOf(byRecovery))).toBe(1);

		// Three authenticators: one wrong answer, either part, signs the session out.
		const third = giveAuthenticator(s.admin, 'New phone');
		const signedOutBy = [
			stepUp(s.admin, {}, WRONG, codeFor(third.secret)),
			stepUp(s.admin, {}, FIXTURE_PASSWORD, wrongCodeFor([first.secret, second.secret, third.secret]))
		];
		for (const sent of signedOutBy) {
			expect(answer(await api('POST', PURGE, sent))).toEqual({ status: 403, body: SIGNED_OUT });
			expect(countOf(tokenOf(sent))).toBeUndefined();
		}
		expect(archivedLeft()).toBe(1);
	});

	it('T9c. with three authenticators, a second request from the session while a right step-up compares, its count held at 3, is 429 in-flight: no compare, nothing counted, nothing ended; the first then 200, the count 0 (code review CR1)', async () => {
		const s = scene();
		const first = giveFactor(s.admin);
		giveAuthenticator(s.admin);
		giveAuthenticator(s.admin, 'New phone');
		const right = stepUp(s.admin, {}, FIXTURE_PASSWORD, codeFor(first.secret));
		const token = tokenOf(right);
		const release = holdChecks();

		const held = api('POST', PURGE, right);
		await vi.waitFor(() => expect(stub.compared).toBe(1));
		// Counted by its weight before its compare: three authenticators tried.
		expect(countOf(token)).toBe(3);

		const second = await api('POST', PURGE, right);

		expect(answer(second)).toEqual({ status: 429, body: { message: STEP_UP_IN_FLIGHT, stepUp: 'in-flight' } });
		expect(stub.compared).toBe(1);
		expect(countOf(token)).toBe(3);
		release();
		expect(answer(await held)).toEqual({ status: 200, body: { success: true, purged: 1 } });
		expect(countOf(token)).toBe(0);
		expect(archivedLeft()).toBe(0);
	});
});

// ─── 18 to 20. The import's confirmation ─────────────────────────────────────

describe("the import's confirmation (cases 18 to 20)", () => {
	/** The superadmin's upload of `bytes`, this database by default, from `token`'s session, with `headers`. */
	const upload = (s: Scene, token: string, headers: Record<string, string>, bytes: Uint8Array = sqlite.serialize()) =>
		api('POST', '/api/admin/import?outside=keep', {
			user: s.chief,
			headers: { cookie: `${SESSION_COOKIE_NAME}=${token}`, 'content-type': 'application/octet-stream', ...headers },
			body: bytes
		});

	it.each([
		['missing', (): Record<string, string> => ({})],
		[
			'used',
			(s: Scene, token: string) => {
				const confirmation = issueImportConfirmation(sessionHashOf(token), s.chief.id, FIXTURE_PASSWORD_HASH);
				takeImportConfirmation(confirmation, sessionHashOf(token));
				return { [CONFIRMATION_HEADER]: confirmation };
			}
		],
		[
			'expired, 61 seconds on',
			(s: Scene, token: string) => {
				vi.useFakeTimers({ toFake: ['Date'] });
				const confirmation = issueImportConfirmation(sessionHashOf(token), s.chief.id, FIXTURE_PASSWORD_HASH);
				vi.setSystemTime(Date.now() + 61 * 1000);
				return { [CONFIRMATION_HEADER]: confirmation };
			}
		],
		[
			"another session's",
			(s: Scene) => ({ [CONFIRMATION_HEADER]: issueImportConfirmation(sessionHashOf(makeSession(s.chief)), s.chief.id, FIXTURE_PASSWORD_HASH) })
		]
	])('refuses an import whose confirmation is %s 403, before a byte of the upload is read, and changes nothing', async (_what, confirming) => {
		const s = scene();
		const token = makeSession(s.chief);
		const headers = confirming(s, token);
		const read = vi.spyOn(Request.prototype, 'arrayBuffer');
		const dir = workingDirectory();
		const before = snapshotDb();

		const res = await upload(s, token, headers);

		expect(answer(res)).toEqual({ status: 403, body: REFUSED });
		expect(read).not.toHaveBeenCalled();
		expectUnchanged(before);
		expect(readdirSync(dir)).toEqual([]);
	});

	it.each([
		[
			'the password was changed while the upload arrived',
			(s: Scene, token: string) => {
				const real = Request.prototype.arrayBuffer;
				const changed = hashSync('another password', 4);
				vi.spyOn(Request.prototype, 'arrayBuffer').mockImplementation(function (this: Request) {
					db.update(users).set({ passwordHash: changed }).where(eq(users.id, s.chief.id)).run();
					return real.call(this);
				});
				return importConfirmation(s.chief, token);
			}
		],
		[
			'the confirmation is another account’s, issued on this session',
			(s: Scene, token: string) => ({ [CONFIRMATION_HEADER]: issueImportConfirmation(sessionHashOf(token), s.admin.id, FIXTURE_PASSWORD_HASH) })
		]
	])('refuses an import when %s: 403, nothing restored', async (_what, confirming) => {
		const s = scene();
		const token = makeSession(s.chief);
		const headers = confirming(s, token);
		const dir = workingDirectory();
		const bytes = sqlite.serialize();
		// Made after the backup was taken: a restore would take it away, and the session with it.
		db.insert(boards).values({ name: 'Made after the upload was sent' }).run();

		const res = await upload(s, token, headers, bytes);

		expect(answer(res)).toEqual({ status: 403, body: REFUSED });
		// Refused once the upload was in: the confirmation was taken, and is gone.
		expect(() => takeImportConfirmation(headers[CONFIRMATION_HEADER], sessionHashOf(token))).toThrow();
		expect(readdirSync(dir)).toEqual([]);
		expect(countOf(token)).toBe(0);
		expect(db.select({ name: boards.name }).from(boards).all().map((board) => board.name)).toEqual([
			'Cleared',
			'Made after the upload was sent'
		]);
	});

	it('answers its confirmation with no-store, one for each session: a second replaces the first, which is then refused', async () => {
		const s = scene();
		const confirmed = stepUp(s.chief);
		const token = tokenOf(confirmed);

		const first = await api('POST', '/api/admin/import/confirm', confirmed);
		expect(first.status).toBe(200);
		expect(first.headers.get('cache-control')).toBe('no-store');
		expect(first.body).toEqual({ confirmation: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), expiresInSeconds: 60 });
		// From the same session, with the code made again: the first spent its step (card 2771).
		const second = await api('POST', '/api/admin/import/confirm', { ...confirmed, body: { ...confirmed.body, currentCode: stepUpCode(s.chief) } });
		expect(second.body.confirmation).not.toBe(first.body.confirmation);

		const read = vi.spyOn(Request.prototype, 'arrayBuffer');
		workingDirectory();
		expect(answer(await upload(s, token, { [CONFIRMATION_HEADER]: first.body.confirmation }))).toEqual({
			status: 403,
			body: REFUSED
		});
		expect(read).not.toHaveBeenCalled();
		expect(takeImportConfirmation(second.body.confirmation, sessionHashOf(token))).toEqual({ userId: s.chief.id, hash: FIXTURE_PASSWORD_HASH });
	});
});

// ─── 21 to 23. The export, Run Now and the Drive Connect ─────────────────────

describe('what sends the database elsewhere (cases 21 to 23)', () => {
	it('serves the export to a POST with the right password, no-store and named as a backup, and answers a GET 405, through the gate', async () => {
		const s = scene();
		const token = makeSession(s.chief);
		const headers = { cookie: `${SESSION_COOKIE_NAME}=${token}`, ...FROM_THE_PAGE, accept: '*/*' };

		const res = await gate('POST', '/api/admin/export', { headers, body: { currentPassword: FIXTURE_PASSWORD, currentCode: stepUpCode(s.chief) } });

		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/x-sqlite3');
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="dumpfire-backup-\d{4}-\d\d-\d\d\.db"$/);
		expect(Buffer.from(await res.arrayBuffer()).subarray(0, 16).toString('latin1')).toBe('SQLite format 3\0');

		const got = await gate('GET', '/api/admin/export', { headers: { cookie: `${SESSION_COOKIE_NAME}=${token}`, accept: '*/*' } });
		expect(got.status).toBe(405);
	});

	it.each([
		{
			what: 'the export',
			who: 'chief' as const,
			send: (confirmed: ReturnType<typeof stepUp>) => api('POST', '/api/admin/export', confirmed),
			setup: () => {}
		},
		{
			what: 'Run Now',
			who: 'admin' as const,
			send: (confirmed: ReturnType<typeof stepUp>) => api('POST', '/api/admin/backup', confirmed),
			setup: backingUp
		}
	])('refuses $what 403 when the password changed between its check and the copy, sending nothing', async ({ who, send, setup }) => {
		const s = scene();
		setup();
		const confirmed = stepUp(s[who]);
		const release = holdChecks();

		const pending = send(confirmed);
		await vi.waitFor(() => expect(stub.compared).toBe(1));
		db.update(users).set({ passwordHash: hashSync('another password', 4) }).where(eq(users.id, s[who].id)).run();
		release();
		const res = await pending;

		expect(answer(res)).toEqual({ status: 403, body: { message: PASSWORD_CHANGED_MEANWHILE, stepUp: 'changed' } });
		expect(stub.uploaded).toEqual([]);
		expect(sqlite.prepare('SELECT * FROM backup_log').all()).toEqual([]);
	});

	it('refuses a write whose stored hash moved after the check 409, and never compares the password again, even one that would match (the code review’s S2)', async () => {
		const s = scene();
		const confirmed = stepUp(s.admin);
		const token = tokenOf(confirmed);
		const release = holdChecks();

		const pending = api('POST', '/api/admin/purge-archived', confirmed);
		await vi.waitFor(() => expect(stub.compared).toBe(1));
		// The same password, hashed again, as a change to it would leave it: a second compare would match.
		db.update(users).set({ passwordHash: hashSync(FIXTURE_PASSWORD, 4) }).where(eq(users.id, s.admin.id)).run();
		release();
		const res = await pending;

		expect(answer(res)).toEqual({ status: 409, body: { message: PASSWORD_CHANGED_MEANWHILE, stepUp: 'changed' } });
		expect(stub.compared).toBe(1);
		expect(archivedLeft()).toBe(1);
		// The one compare made was right, and cleared the count.
		expect(countOf(token)).toBe(0);
		// And the code was spent with it, before the write was refused (card 2771, S4).
		expect(lastStepOf(s.admin)).not.toBeNull();
	});

	it('checks the Connect’s password before Google: a wrong one is 403, no code is exchanged, and the Connect is still there to finish', async () => {
		const s = scene();
		backingUp();
		const getToken = standInGoogle();
		const confirmed = stepUp(s.admin);
		const connect = await connecting(s.admin, confirmed);

		expect(answer(await connect({ currentPassword: WRONG, currentCode: confirmed.body.currentCode }))).toEqual({ status: 403, body: WRONG_ONE });
		expect(getToken).not.toHaveBeenCalled();
		expect(backupConfig().destinations[1]).toEqual(DRIVE);

		const right = await connect({ currentPassword: FIXTURE_PASSWORD, currentCode: confirmed.body.currentCode });
		expect(right.status, JSON.stringify(right.body)).toBe(200);
		expect(right.body.success).toBe(true);
		expect(getToken).toHaveBeenCalledTimes(1);
	});
});

// ─── 24. v1's deletes, left as they were ────────────────────────────────────

describe("v1's board and column deletes are untouched (case 24, card 2703)", () => {
	it.each([
		{ what: 'DELETE /api/v1/boards/{id}', path: (s: Scene) => `/api/v1/boards/${s.board.id}` },
		{ what: 'DELETE /api/v1/columns/{id}', path: (s: Scene) => `/api/v1/columns/${s.cols['To Do'].id}` }
	])('$what with a key and no password is its success, through the gate', async ({ path }) => {
		const s = scene();
		const key = makeApiKey(s.admin);

		const res = await gate('DELETE', path(s), { headers: { authorization: `Bearer ${key}` } });

		expect(res.status, await res.clone().text()).toBe(200);
		expect(stub.compared).toBe(0);
		expect(db.select().from(cards).all()).toEqual([]);
	});
});

// ─── 25 and 26. Webhooks, written only with a key (card 2702) ───────────────

/** A board's owner, the board, and a webhook of it already there. */
function hooked() {
	const owner = makeUser({ username: 'owner' });
	const { board } = makeBoard({ owner, name: 'Hooked' });
	const hook = makeWebhook(board, { url: 'https://hooks.example.test/kept' });
	return { owner, board, hook };
}

/** Every webhook row, as stored. */
const webhookRows = () => db.select().from(webhooks).all();

describe('webhooks are written only with a key, which takes the password to make (cases 25 and 26, card 2702)', () => {
	it.each([
		{ method: 'POST', path: (h: ReturnType<typeof hooked>) => `/api/v1/boards/${h.board.id}/webhooks` },
		{ method: 'PUT', path: (h: ReturnType<typeof hooked>) => `/api/v1/webhooks/${h.hook.id}` }
	])('refuses $method from a signed-in session 401, even with its right password, writing and counting nothing (case 25)', async ({ method, path }) => {
		const h = hooked();
		const token = makeSession(h.owner);
		const before = webhookRows();

		// The page's own request, its session and the right password, and no key: the gate decides before any route.
		const res = await gate(method, path(h), {
			headers: { cookie: `${SESSION_COOKIE_NAME}=${token}`, ...FROM_THE_PAGE },
			body: { url: 'https://hooks.example.test/x', currentPassword: FIXTURE_PASSWORD }
		});

		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ message: 'Missing or invalid Authorization header. Use: Bearer <api_key>' });
		expect(webhookRows()).toEqual(before);
		expect(stub.compared).toBe(0);
		expect(countOf(token)).toBe(0);
	});

	it('creates a webhook with a key and no password, the key’s account its setter: the departure card 2703 (key scopes) revisits (case 26)', async () => {
		const owner = makeUser({ username: 'owner' });
		const { board } = makeBoard({ owner, name: 'Hooked' });
		const key = makeApiKey(owner);

		const res = await gate('POST', `/api/v1/boards/${board.id}/webhooks`, {
			headers: { authorization: `Bearer ${key}` },
			body: { url: 'https://hooks.example.test/x' }
		});

		expect(res.status, await res.clone().text()).toBe(201);
		// The address read opened (card 2928: stored sealed).
		expect(webhookRows().map(({ id, boardId, setBy }) => ({ boardId, url: readOpenedUrl(id), setBy }))).toEqual([
			{ boardId: board.id, url: 'https://hooks.example.test/x', setBy: owner.id }
		]);
		expect(stub.compared).toBe(0);
	});
});

// ─── Card 2726: the proof a service asks for itself ─────────────────────────

describe("passwordHeld: the proof whilePasswordHolds holds while its write runs (card 2726)", () => {
	it("is true only inside the write, for its own account; false after it returns or throws, and never set when the hash moved", async () => {
		const pat = makeUser({ username: 'pat' });
		const sam = makeUser({ username: 'sam' });
		const seen: Record<string, boolean> = {};

		seen.before = passwordHeld(pat.id);
		await whilePasswordHolds(pat.id, FIXTURE_PASSWORD_HASH, () => {
			seen.ownInside = passwordHeld(pat.id);
			seen.otherInside = passwordHeld(sam.id);
		});
		seen.afterReturn = passwordHeld(pat.id);

		await expect(
			whilePasswordHolds(pat.id, FIXTURE_PASSWORD_HASH, () => {
				throw new Error('the write failed');
			})
		).rejects.toThrow('the write failed');
		seen.afterThrow = passwordHeld(pat.id);

		let ranOnMovedHash = false;
		const moved = whilePasswordHolds(pat.id, hashSync('another password', 4), () => {
			ranOnMovedHash = true;
		});
		seen.whileRefused = passwordHeld(pat.id);
		await expect(moved).rejects.toMatchObject({ status: 409, body: { message: PASSWORD_CHANGED_MEANWHILE, stepUp: 'changed' } });

		expect(seen).toEqual({ before: false, ownInside: true, otherInside: false, afterReturn: false, afterThrow: false, whileRefused: false });
		expect(ranOnMovedHash).toBe(false);
	});

	it("keeps the outer account held through a nested whilePasswordHolds for another account, which proves that account alone and only while it runs", async () => {
		const pat = makeUser({ username: 'pat' });
		const sam = makeUser({ username: 'sam' });
		const seen: Record<string, boolean> = {};
		let inner: Promise<void> | undefined;

		await whilePasswordHolds(pat.id, FIXTURE_PASSWORD_HASH, () => {
			inner = whilePasswordHolds(sam.id, FIXTURE_PASSWORD_HASH, () => {
				seen.innerSam = passwordHeld(sam.id);
				seen.innerPat = passwordHeld(pat.id);
			});
			seen.afterInnerPat = passwordHeld(pat.id);
			seen.afterInnerSam = passwordHeld(sam.id);
		});
		await inner;
		seen.afterOuterPat = passwordHeld(pat.id);

		expect(seen).toEqual({ innerSam: true, innerPat: true, afterInnerPat: true, afterInnerSam: false, afterOuterPat: false });
	});

	it('is false in an afterCommit effect queued by the write: the effect runs once the proof is cleared', async () => {
		const pat = makeUser({ username: 'pat' });
		const seen: Record<string, boolean> = {};

		await whilePasswordHolds(pat.id, FIXTURE_PASSWORD_HASH, () => {
			seen.inWrite = passwordHeld(pat.id);
			afterCommit(() => {
				seen.inEffect = passwordHeld(pat.id);
			});
		});
		await vi.waitFor(() => expect(seen).toHaveProperty('inEffect'));

		expect(seen).toEqual({ inWrite: true, inEffect: false });
	});
});
