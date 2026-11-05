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
import { boards, cards, categories, columns, decisionParticipants, inviteTokens, people, sessions, settings, userXp, users, webhooks } from '$lib/server/db/schema';
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
	STEP_UP_IN_FLIGHT,
	STEP_UP_MISSING,
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
	stepUp
} from './helpers/fixtures';
import { FROM_THE_PAGE, gate } from './helpers/gate';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';
import { handlersOf } from './helpers/source-scan';

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

/** The session a request's cookie names. */
const tokenOf = (sent: { headers: Record<string, string> }) => sent.headers.cookie.slice(`${SESSION_COOKIE_NAME}=`.length);

/** The session's count of wrong current passwords, or undefined once it has gone. */
const countOf = (token: string) =>
	db.select({ count: sessions.wrongPasswordCount }).from(sessions).where(eq(sessions.id, token)).get()?.count;

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
const backupConfig = () => JSON.parse(db.select().from(settings).where(eq(settings.key, 'backup_config')).get()!.value);

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
	const credential = { kind: 'session' as const, token: tokenOf(confirmed) };
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

/** The reasons of the `link_revoked` events recorded on a participant row, in order. */
const linkRevokedReasons = (participantId: number) =>
	(sqlite.prepare("SELECT detail FROM decision_events WHERE kind = 'link_revoked' AND participant_id = ? ORDER BY id").all(participantId) as { detail: string }[]).map(
		(event) => JSON.parse(event.detail).reason
	);

// ─── 1 and 2. The list, and the routes that ask ──────────────────────────────

describe('the list of what asks, pinned against the routes (cases 1 and 2)', () => {
	it("is the twenty-eight actions: decision 2's eighteen (the import among them, as its confirmation), card 2697's eight and card 2679's two, each with why it asks", () => {
		expect(Object.keys(STEP_UP_ACTIONS).sort()).toEqual(
			[
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
				'POST /api/decisions/[id]/release'
			].sort()
		);
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

describe('each admin action asks for the current password (case 3)', () => {
	const ACTIONS: {
		action: StepUpAction;
		who: 'chief' | 'admin';
		path: (s: Scene) => string;
		/** What the action is sent with but the password: nothing unless said. */
		body?: (s: Scene) => Record<string, unknown>;
		/** The method, when it is not POST. */
		method?: 'PUT' | 'DELETE';
		/** The status of its success, when it is not 200. */
		status?: number;
		/** What the action needs that the scene does not have. */
		setup?: () => void;
		done: (res: ApiResult, s: Scene) => void;
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
		}
	];

	it.each(ACTIONS)(
		'$action: none is 400 and nothing is counted, a wrong one 403 changing nothing but the count, the right one its success',
		async ({ who, path, body = () => ({}), method = 'POST' as const, status = 200, setup, done }) => {
			const s = scene();
			setup?.();
			const confirmed = stepUp(s[who], body(s));
			const token = tokenOf(confirmed);
			const before = snapshotDb();

			const missing = await api(method, path(s), { ...confirmed, body: body(s) });
			expect(answer(missing)).toEqual({ status: 400, body: MISSING });
			expectUnchanged(before);
			expect(stub.compared).toBe(0);

			const wrong = await api(method, path(s), { ...confirmed, body: { ...body(s), currentPassword: WRONG } });
			expect(answer(wrong)).toEqual({ status: 403, body: WRONG_ONE });
			expect(countOf(token)).toBe(1);
			expectUnchanged({ ...before, sessions: snapshotDb().sessions });

			const right = await api(method, path(s), confirmed);
			expect(right.status, JSON.stringify(right.body)).toBe(status);
			done(right, s);
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
		expect(answer(await confirm({ currentPassword: WRONG }))).toEqual({ status: 403, body: WRONG_ONE });
		expect(countOf(token)).toBe(1);
		expectUnchanged({ ...before, sessions: snapshotDb().sessions });
		expect(readdirSync(dir)).toEqual([]);

		const issued = await confirm({ currentPassword: FIXTURE_PASSWORD });
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

		expect(answer(await connect({ currentPassword: WRONG }))).toEqual({ status: 403, body: WRONG_ONE });
		expect(countOf(token)).toBe(1);
		expectUnchanged({ ...before, sessions: snapshotDb().sessions });

		const right = await connect({ currentPassword: FIXTURE_PASSWORD });
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
			credential: { kind: 'session', token }
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
			send: (s: Scene) => api('DELETE', `/api/users/${s.chief.id}`, stepUp(s.admin)),
			refused: { status: 403, body: { message: 'Cannot delete superadmin account' } }
		},
		{
			what: 'a role change with a username another account has',
			send: (s: Scene) => api('PUT', `/api/users/${s.member.id}`, stepUp(s.chief, { role: 'admin', username: 'admin' })),
			refused: { status: 409, body: { message: 'Username already taken' } }
		},
		{
			what: 'an invite with no mail host',
			send: (s: Scene) => api('POST', `/api/users/${s.member.id}/invite`, stepUp(s.admin)),
			refused: { status: 400, body: { message: 'SMTP is not configured' } }
		},
		// Slice 2b: the board and column deletes (D5: the owner check is the service's).
		{
			what: 'an editor deleting a board they do not own',
			setup: (s: Scene) => addBoardMember(s.board, s.member, 'editor'),
			send: (s: Scene) => api('DELETE', `/api/boards/${s.board.id}`, stepUp(s.member)),
			refused: { status: 403, body: { message: 'Only board owners and admins can delete boards' } }
		},
		{
			what: "a delivery board's Options column deleted",
			setup: (s: Scene) => makeBoard({ owner: s.admin, name: 'Kept', options: true }),
			send: (s: Scene) =>
				api('DELETE', `/api/columns/${db.select().from(columns).where(eq(columns.role, 'options')).get()!.id}`, stepUp(s.admin)),
			refused: { status: 409, body: { message: 'Every delivery board keeps its Options column. Fold it away with the arrow on its strip instead.' } }
		}
	])('$what is refused by the guard, in its own words: nothing counted, no password compared', async ({ setup, send, refused }) => {
		const s = scene();
		setup?.(s);
		const before = snapshotDb();

		const res = await send(s);

		expect(answer(res)).toEqual(refused);
		expect(stub.compared).toBe(0);
		// The session made for the request, and its count, which reads none.
		expect(db.select({ count: sessions.wrongPasswordCount }).from(sessions).all()).toEqual([{ count: 0 }]);
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
			send: (s: Scene) => api('POST', '/api/people', stepUp(s.admin, { fullName: 'Another Pat', email: 'pat.doe@example.test' }, WRONG)),
			refused: { status: 409, body: { message: 'Email already in the directory: Pat Doe' } }
		},
		{
			what: 'DELETE /api/people/[id] of nobody',
			send: (s: Scene) => api('DELETE', '/api/people/9999', stepUp(s.admin, {}, WRONG)),
			refused: { status: 404, body: { message: 'Person not found' } }
		},
		{
			what: 'POST /api/people/from-accounts with an id that is no account',
			send: (s: Scene) => api('POST', '/api/people/from-accounts', stepUp(s.admin, { userIds: [s.member.id, 9999] }, WRONG)),
			refused: { status: 400, body: { message: 'userId 9999 is not an account' } }
		}
	])('$what and a wrong password is refused by the guard, before any password: nothing counted or changed', async ({ send, refused }) => {
		const s = scene();
		aLinkHolder();
		const before = snapshotDb();

		const res = await send(s);

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
		const before = snapshotDb();

		const res = await api('POST', '/api/admin/purge-archived', { user: s.admin, body: { currentPassword: FIXTURE_PASSWORD } });

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
		const send = (currentPassword: string) => gate('POST', '/api/admin/purge-archived', { headers, body: { currentPassword } });
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
		['a day gone by', () => vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000)]
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

	it('keeps one count for the Account forms and the admin actions, which only a right password clears', async () => {
		const s = scene();
		const token = makeSession(s.admin);
		const cookie = { cookie: `${SESSION_COOKIE_NAME}=${token}` };
		const purge = (currentPassword: string) => api('POST', '/api/admin/purge-archived', { user: s.admin, body: { currentPassword }, headers: cookie });

		for (let n = 1; n <= 2; n++) {
			const res = await api('PUT', '/api/account/email', { user: s.admin, body: { newEmail: 'moved@example.test', password: WRONG }, headers: cookie });
			expect(answer(res)).toEqual({ status: 403, body: { message: 'Password is incorrect', stepUp: 'wrong' } });
		}
		expect(countOf(token)).toBe(2);

		expect(answer(await purge(FIXTURE_PASSWORD))).toEqual({ status: 200, body: { success: true, purged: 1 } });
		expect(countOf(token)).toBe(0);

		// One wrong after it is the first again, not the third.
		expect(answer(await purge(WRONG))).toEqual({ status: 403, body: WRONG_ONE });
		expect(countOf(token)).toBe(1);
	});

	it.each([
		{ path: '/api/account/email', method: 'PUT' as const, body: (password: string) => ({ newEmail: 'moved@example.test', password }), wrong: 'Password is incorrect' },
		{ path: '/api/account/password', method: 'PUT' as const, body: (currentPassword: string) => ({ currentPassword, newPassword: 'a new long password' }), wrong: 'Current password is incorrect' },
		{ path: '/api/account/api-keys', method: 'POST' as const, body: (password: string) => ({ name: 'my script', password }), wrong: 'Password is incorrect' }
	])('$method $path: the first two wrong passwords in its own words, and the third signs the session out', async ({ path, method, body, wrong }) => {
		const s = scene();
		const token = makeSession(s.member);
		const send = () => api(method, path, { user: s.member, body: body(WRONG), headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } });

		for (let n = 1; n <= 2; n++) expect(answer(await send())).toEqual({ status: 403, body: { message: wrong, stepUp: 'wrong' } });
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
		db.update(sessions).set({ wrongPasswordCount: 3 }).where(eq(sessions.id, token)).run();

		const res = await api('POST', '/api/admin/purge-archived', confirmed);

		expect(answer(res)).toEqual({ status: 403, body: SIGNED_OUT });
		expect(stub.compared).toBe(0);
		expect(countOf(token)).toBeUndefined();
		expect(archivedLeft()).toBe(1);
	});

	it('checks one password at a time for a session: a second is 429 with no compare, and not counted; another session of the account goes ahead', async () => {
		const s = scene();
		const first = stepUp(s.admin);
		const token = tokenOf(first);
		const other = stepUp(s.admin);
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

		// Both right, and both through: one purged the archived card, whichever was first.
		const both = [await held, await elsewhere];
		expect(both.map((res) => res.status)).toEqual([200, 200]);
		expect(both.map((res) => res.body.purged).sort()).toEqual([0, 1]);
		expect(countOf(token)).toBe(0);
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
		db.update(sessions).set({ wrongPasswordCount: 2 }).where(eq(sessions.id, token)).run();
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
		['the right password', FIXTURE_PASSWORD],
		['a wrong one', WRONG]
	])('answers %s signed out when the session ended while it was being checked, in the same words', async (_which, password) => {
		const s = scene();
		const confirmed = stepUp(s.admin, {}, password);
		const token = tokenOf(confirmed);
		const release = holdChecks();

		const pending = api('POST', '/api/admin/purge-archived', confirmed);
		await vi.waitFor(() => expect(stub.compared).toBe(1));
		deleteSession(token, 'signed out elsewhere');
		release();

		expect(answer(await pending)).toEqual({ status: 403, body: SIGNED_OUT });
		expect(archivedLeft()).toBe(1);
	});

	it("leaves sign-in's counts alone: the address's attempts and the account's wrong sign-ins, and no wait", async () => {
		const s = scene();
		const address = '203.0.113.9';
		const wrong = stepUp(s.admin, {}, WRONG);

		for (let n = 1; n <= 2; n++) expect((await api('POST', '/api/admin/purge-archived', { ...wrong, ip: address })).status).toBe(403);

		expect(wrongSignInsAt(`user:${s.admin.id}`)).toBe(0);
		expect(signInWait(`user:${s.admin.id}`)).toBe(0);
		// The address's next sign-in attempt is the first of its window.
		expect(checkRateLimit(`login:${addressKey(address)}`).attempts).toBe(1);
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
		db.update(sessions).set({ wrongPasswordCount: 3 }).where(eq(sessions.id, tokenOf(ended))).run();
		answers.push(await api('POST', '/api/admin/purge-archived', ended));

		expect(answers.map((res) => res.status)).toEqual([200, 403, 403]);
		expect(confirmed.status).toBe(200);
		expect(linesStarting('INFO', 'Password confirmed')).toEqual([
			{ message: `Password confirmed by admin (ID: ${s.admin.id}) for POST /api/admin/purge-archived`, userId: s.admin.id },
			{ message: `Password confirmed by chief (ID: ${s.chief.id}) for POST /api/admin/import/confirm`, userId: s.chief.id }
		]);
		const logged = JSON.stringify(sqlite.prepare('SELECT message, context, meta FROM system_logs').all());
		for (const secret of [FIXTURE_PASSWORD, guess, confirmed.body.confirmation]) expect(logged).not.toContain(secret);
		for (const res of answers) {
			for (const secret of [FIXTURE_PASSWORD, guess, confirmed.body.confirmation]) expect(JSON.stringify(res.body)).not.toContain(secret);
		}
		expect(JSON.stringify(confirmed.body)).not.toContain(FIXTURE_PASSWORD);
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
				const confirmation = issueImportConfirmation(token, s.chief.id, FIXTURE_PASSWORD_HASH);
				takeImportConfirmation(confirmation, token);
				return { [CONFIRMATION_HEADER]: confirmation };
			}
		],
		[
			'expired, 61 seconds on',
			(s: Scene, token: string) => {
				vi.useFakeTimers({ toFake: ['Date'] });
				const confirmation = issueImportConfirmation(token, s.chief.id, FIXTURE_PASSWORD_HASH);
				vi.setSystemTime(Date.now() + 61 * 1000);
				return { [CONFIRMATION_HEADER]: confirmation };
			}
		],
		[
			"another session's",
			(s: Scene) => ({ [CONFIRMATION_HEADER]: issueImportConfirmation(makeSession(s.chief), s.chief.id, FIXTURE_PASSWORD_HASH) })
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
			(s: Scene, token: string) => ({ [CONFIRMATION_HEADER]: issueImportConfirmation(token, s.admin.id, FIXTURE_PASSWORD_HASH) })
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
		expect(() => takeImportConfirmation(headers[CONFIRMATION_HEADER], token)).toThrow();
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
		const second = await api('POST', '/api/admin/import/confirm', confirmed);
		expect(second.body.confirmation).not.toBe(first.body.confirmation);

		const read = vi.spyOn(Request.prototype, 'arrayBuffer');
		workingDirectory();
		expect(answer(await upload(s, token, { [CONFIRMATION_HEADER]: first.body.confirmation }))).toEqual({
			status: 403,
			body: REFUSED
		});
		expect(read).not.toHaveBeenCalled();
		expect(takeImportConfirmation(second.body.confirmation, token)).toEqual({ userId: s.chief.id, hash: FIXTURE_PASSWORD_HASH });
	});
});

// ─── 21 to 23. The export, Run Now and the Drive Connect ─────────────────────

describe('what sends the database elsewhere (cases 21 to 23)', () => {
	it('serves the export to a POST with the right password, no-store and named as a backup, and answers a GET 405, through the gate', async () => {
		const s = scene();
		const token = makeSession(s.chief);
		const headers = { cookie: `${SESSION_COOKIE_NAME}=${token}`, ...FROM_THE_PAGE, accept: '*/*' };

		const res = await gate('POST', '/api/admin/export', { headers, body: { currentPassword: FIXTURE_PASSWORD } });

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
	});

	it('checks the Connect’s password before Google: a wrong one is 403, no code is exchanged, and the Connect is still there to finish', async () => {
		const s = scene();
		backingUp();
		const getToken = standInGoogle();
		const confirmed = stepUp(s.admin);
		const connect = await connecting(s.admin, confirmed);

		expect(answer(await connect({ currentPassword: WRONG }))).toEqual({ status: 403, body: WRONG_ONE });
		expect(getToken).not.toHaveBeenCalled();
		expect(backupConfig().destinations[1]).toEqual(DRIVE);

		const right = await connect({ currentPassword: FIXTURE_PASSWORD });
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
		expect(webhookRows().map(({ boardId, url, setBy }) => ({ boardId, url, setBy }))).toEqual([
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
