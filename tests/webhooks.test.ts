/**
 * Webhooks: which of a board's webhooks an event is sent to, and what is not
 * sent and why.
 *
 * Card 2145: a webhook whose stored `events` is not a list is skipped, with a
 * WARN naming it, and every other webhook of the board is still sent. Before,
 * every webhook of one event was handled in one `try`, so a row holding `null`
 * stopped the loop, and every webhook after it on the board was sent nothing.
 *
 * Card 2161: a webhook is not sent inside the network. An address is judged as
 * written (`addressRefusal`) and, at delivery, by every address its name
 * resolves to, at the moment of connection (`guardedLookup` on the webhooks'
 * own agents); redirects are not followed; `WEBHOOK_ALLOW_INSIDE` names the
 * receivers inside that may be sent to. The delivery tests use the real
 * transport and no `effects()`: a local server listening with no host (one
 * listening on 127.0.0.1 makes a lookup, which the setup refuses), with
 * `dns.lookup` stood in for by assignment, per test.
 *
 * The routes (slice 3): the same rules at registration, as a 400 that names
 * why, with no lookup (card 2161); who set a webhook's address or secret,
 * recorded in `set_by` and given in no answer (card 2168); and at most 10
 * webhooks a board, an 11th refused 409, with a start-up line for a board
 * already over (card 2201). Who may change the address is in
 * access-control.test.ts (card 2154).
 *
 * Card 2178: what each webhook's last delivery came to, held in memory and
 * given to the board's owner as `lastDelivery`, at the first of a refusal, the
 * status line and an error before it; in fixed words, never an address; the
 * newer dispatch's result kept; forgotten when the address changes or the
 * webhook is deleted. Who may read it is in access-control.test.ts.
 *
 * Card 2278: which action sends which event, the whole map, and what each
 * kind of move sends. A reopening, and a move to another board, sent nothing:
 * a receiver of `card.moved` missed them. Each now sends `card.moved` to its
 * own board with that board's own entry, which names no other board (card
 * 2181); a move into Complete sends `card.completed` instead of `card.moved`.
 *
 * Card 2343: a card put in a goal or taken out sends `milestone.card_added` or
 * `milestone.card_removed` to its own board, by every route, with the entry's
 * words and every event's five fields; held as any event is (card 2325), and
 * asked for by name like any other.
 *
 * Card 2752: a webhook whose setter can no longer open its board is switched
 * off for good, with why and when, at the write that takes the access away
 * (six of them, each with its scope and the cause it names), at start, and at
 * delivery as the backstop; it stays off when the setter is given the board
 * back; switching it on is the owner's or an administrator's, and gives one
 * held for a lost setter a new secret; a create at an address held off is
 * refused to anyone else; the boards' owners are mailed. Card 2325's cases
 * are extended in place; a restore's sweep is in backups.test.ts.
 *
 * Card 2893: each webhook records the API key that last set its address or
 * secret or switched it on, and is switched off for good, `'key ended'`, when
 * that key is revoked (in the same write), expires, is deleted or is another
 * account's, and, for one set up before keys were recorded, once its setter
 * has no working key from then; switching it on with another key binds it to
 * that one; the owners of such webhooks are told once, at start, the date
 * each will stop. The Account page's count is in page-failures.test.ts.
 */
import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import { createHmac, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { isHttpError } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { inTransaction } from '$lib/server/db/transaction';
import { activityLog, boards, columns, users, webhooks } from '$lib/server/db/schema';
import { endAccountAccess, sessionTokenHash, type SessionUser } from '$lib/server/auth';
import { resetTwoStep } from '$lib/server/mfa-store';
import { disableAccount } from '$lib/server/account-disable';
import { deleteUser } from '$lib/server/deletes';
import { escapeHtml } from '$lib/escape-html';
import { ACTIONS, logActivity } from '$lib/server/logActivity';
import { EVENT_KINDS } from '$lib/server/decision-record';
import {
	deliver,
	deliveryResultFor,
	dispatchWebhook,
	forgetDeliveries,
	switchOffHeld,
	switchOffLostWebhooks,
	ENDING_IN_MAIL,
	webhooksLog,
	WARNINGS_REMEMBERED,
	WEBHOOK_EVENTS,
	webhookShareNotes
} from '$lib/server/webhooks';
import { addressRefusal, insideReason, parseAllowInside, readWebhookUrl } from '$lib/server/webhook-address';
import {
	announceWebhooksBeforeKeys,
	holdAlreadyOffWebhooksAtStart,
	reportWebhookAllowInside,
	reportWebhooksOverCap,
	reportWebhooksRefused,
	switchOffHeldWebhooksAtStart,
	WEBHOOKS_ALREADY_OFF_HELD,
	WEBHOOKS_BEFORE_KEYS_ANNOUNCED
} from '$lib/server/startup-checks';
import { api, type ApiResult } from './helpers/api';
import { eachWriteInTurn } from './helpers/each-write';
import { effects, type Effects } from './helpers/effects';
import {
	addBoardMember,
	makeApiKeyRow,
	makeBoard,
	makeCard,
	makeDecision,
	makeMilestone,
	makeSession,
	makeSmtp,
	makeTeam,
	makeUser,
	makeWebhook,
	forgetFirstRunFlags,
	resetDb,
	shareBoardWithTeam,
	stepUp
} from './helpers/fixtures';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';
import { readOpened, readOpenedUrl } from './helpers/reads';
import { HELD_FROM_UNSEALED_BACKUP } from '$lib/settings-held';
import {
	TYPED_SECRET_LOOKS_SEALED,
	openStored,
	sealPlainSecrets,
	sealValue,
	sealedForRestore,
	webhookSecretAad,
	webhookUrlAad
} from '$lib/server/stored-secrets';
import { currentMfaKey, keyFromBytes } from '$lib/server/mfa-key';

beforeEach(resetDb);
// Each first-run pass in full, as before migration 0084 seeded their flags (card 3064, R23).
beforeEach(() => forgetFirstRunFlags());

type Hook = ReturnType<typeof makeWebhook>;

/** The cause a test's ending of an account's access gives, for the log and the mail alike (card 2923's code review, S5). */
const RESET_IN_A_TEST = { log: 'a password reset in a test', mail: 'a password reset in a test' };

/** The webhook with `events` stored as this text, as a row written by hand or by an older `PUT` holds it. */
function storedAs(hook: Hook, events: string): Hook {
	sqlite.prepare('UPDATE webhooks SET events = ? WHERE id = ?').run(events, hook.id);
	return { ...hook, events };
}

/** The lines the webhooks wrote at `level`, oldest first. */
function lines(level: 'WARN' | 'ERROR'): string[] {
	return (
		sqlite.prepare("SELECT message FROM system_logs WHERE context = 'Webhooks' AND level = ? ORDER BY id").all(level) as {
			message: string;
		}[]
	).map((row) => row.message);
}

// The suite logs errors only; the lines these tests read are WARN ones. Kept
// off the console, where every one would be printed.
let level: string | undefined;
let quiet: { mockRestore(): void }[] = [];
beforeEach(() => {
	level = process.env.LOG_LEVEL;
	process.env.LOG_LEVEL = 'INFO';
	quiet = [vi.spyOn(console, 'warn').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {})];
});
afterEach(() => {
	if (level === undefined) delete process.env.LOG_LEVEL;
	else process.env.LOG_LEVEL = level;
	for (const spy of quiet) spy.mockRestore();
});

describe('a webhook whose events are not a list (card 2145)', () => {
	let sent: Effects;
	beforeEach(() => {
		sent = effects();
	});
	afterEach(() => sent.restore());

	it('is skipped and named, and every other webhook of its board is sent', async () => {
		const { board } = makeBoard({ owner: makeUser() });
		// `null` was written by `PUT … events: null`; a number or an object was
		// sent every event, and a string matched by substring.
		const hooks = ['null', '5', '"card.created"', '[]'].map((events) => storedAs(makeWebhook(board), events));

		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		await sent.settle();

		expect(sent.webhooks.map((w) => w.url)).toEqual([hooks[3].address]);
		expect(lines('WARN')).toEqual(
			hooks.slice(0, 3).map((h) => `Webhook ${h.id} on board ${board.id} not sent: its events are not a list`)
		);
		expect(lines('ERROR')).toEqual([]);
	});

	it('skips one whose events are not JSON at all, the same way', async () => {
		const { board } = makeBoard({ owner: makeUser() });
		const bad = storedAs(makeWebhook(board), 'card.created');
		const good = makeWebhook(board, { events: ['card.created'] });

		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		await sent.settle();

		expect(sent.webhooks.map((w) => w.url)).toEqual([good.address]);
		expect(lines('WARN')).toEqual([`Webhook ${bad.id} on board ${board.id} not sent: its events are not a list`]);
	});

	it('sends a list that names the event and an empty list, and not a list without it (a guard)', async () => {
		const { board } = makeBoard({ owner: makeUser() });
		const naming = makeWebhook(board, { events: ['card.moved', 'card.created'] });
		const every = makeWebhook(board, { events: [] });
		makeWebhook(board, { events: ['card.moved'] });

		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		await sent.settle();

		expect(sent.webhooks.map((w) => w.url)).toEqual([naming.address, every.address]);
		// One event is one body: every webhook of it is sent the same, timestamp and all.
		expect(sent.webhooks[0].body).toEqual(sent.webhooks[1].body);
		expect(sent.webhooks[0].body).toMatchObject({ event: 'card.created', boardId: board.id, data: { cardId: 1 } });
		expect(lines('WARN')).toEqual([]);
	});
});

// ─── Card 2161 ───────────────────────────────────────────────────────────

type Received = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };
type Receiver = { port: number; received: Received[]; connections: number };

const servers: http.Server[] = [];

/**
 * A server on this machine, listening with no host, that records each request
 * it is sent and answers 200, or as `answer` says.
 */
async function receiver(answer?: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<Receiver> {
	const got: Receiver = { port: 0, received: [], connections: 0 };
	const server = http.createServer((req, res) => {
		let body = '';
		req.on('data', (chunk) => (body += chunk));
		req.on('end', () => {
			got.received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
			if (answer) answer(req, res);
			else res.end('ok');
		});
	});
	server.on('connection', () => got.connections++);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, resolve));
	got.port = (server.address() as AddressInfo).port;
	return got;
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
	const server = http.createServer();
	await new Promise<void>((resolve) => server.listen(0, resolve));
	const { port } = server.address() as AddressInfo;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

type Answer = { address: string; family: number };

/** `dns.lookup` answers each name with these addresses; any other name is not found. */
function answerLookups(answers: Record<string, Answer[]>): void {
	(dns as unknown as { lookup: unknown }).lookup = (name: string, _options: unknown, callback: (err: Error | null, found?: Answer[]) => void) => {
		const found = answers[name];
		setImmediate(() =>
			found ? callback(null, found) : callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: 'ENOTFOUND' }))
		);
	};
}

const v4 = (address: string): Answer => ({ address, family: 4 });
const v6 = (address: string): Answer => ({ address, family: 6 });

/** Long enough for a delivery that was not made to show that it was not. */
const aMoment = () => new Promise((resolve) => setTimeout(resolve, 100));

const sign = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

let lookup: unknown;
let allowList: string | undefined;
beforeEach(() => {
	lookup = dns.lookup;
	allowList = process.env.WEBHOOK_ALLOW_INSIDE;
	delete process.env.WEBHOOK_ALLOW_INSIDE;
});
afterEach(async () => {
	(dns as unknown as { lookup: unknown }).lookup = lookup;
	if (allowList === undefined) delete process.env.WEBHOOK_ALLOW_INSIDE;
	else process.env.WEBHOOK_ALLOW_INSIDE = allowList;
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

describe('where a webhook is sent, at delivery (card 2161)', () => {
	it('refuses a loopback address as written, and sends to it once allowed, with its length, headers and signature', async () => {
		const server = await receiver();
		const { board } = makeBoard({ owner: makeUser() });
		const hook = makeWebhook(board, { url: `http://127.0.0.1:${server.port}/hook?token=t0k3n`, secret: 's3cret' });

		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		await vi.waitFor(() => expect(lines('WARN')).toHaveLength(1));
		expect(lines('WARN')).toEqual([`Webhook ${hook.id} on board ${board.id} not sent: 127.0.0.1 is a loopback address`]);
		expect(server.connections).toBe(0);

		process.env.WEBHOOK_ALLOW_INSIDE = '127.0.0.0/8';
		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		await vi.waitFor(() => expect(server.received).toHaveLength(1));

		const [got] = server.received;
		expect(got).toMatchObject({ method: 'POST', url: '/hook?token=t0k3n' });
		expect(got.headers).toMatchObject({
			'content-type': 'application/json',
			'content-length': String(Buffer.byteLength(got.body)),
			accept: '*/*',
			'x-dumpfire-event': 'card.created',
			'x-dumpfire-signature': sign('s3cret', got.body),
			'user-agent': 'DumpFire-Webhook/1.0',
			connection: 'close'
		});
		// Sent with its length, as fetch sent it: a receiver may not take a chunked body.
		expect(got.headers['transfer-encoding']).toBeUndefined();
		expect(JSON.parse(got.body)).toMatchObject({ event: 'card.created', boardId: board.id, data: { cardId: 1 } });
		await aMoment();
		expect(lines('ERROR')).toEqual([]);
		expect(lines('WARN')).toHaveLength(1);
	});

	it('sends a webhook with no secret an empty signature', async () => {
		process.env.WEBHOOK_ALLOW_INSIDE = '127.0.0.1';
		const server = await receiver();
		const { board } = makeBoard({ owner: makeUser() });
		makeWebhook(board, { url: `http://127.0.0.1:${server.port}/` });

		dispatchWebhook(board.id, 'card.moved', { cardId: 1 });
		await vi.waitFor(() => expect(server.received).toHaveLength(1));
		expect(server.received[0].headers['x-dumpfire-signature']).toBe('');
	});

	it('refuses a name that resolves inside, and connects to the address the lookup gave once the name is allowed', async () => {
		const server = await receiver();
		answerLookups({ 'hooks.example.test': [v4('127.0.0.1')] });
		const { board } = makeBoard({ owner: makeUser() });
		const hook = makeWebhook(board, { url: `http://hooks.example.test:${server.port}/x` });

		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		await vi.waitFor(() => expect(lines('WARN')).toHaveLength(1));
		expect(lines('WARN')).toEqual([
			`Webhook ${hook.id} on board ${board.id} not sent: hooks.example.test resolves to 127.0.0.1, a loopback address`
		]);
		expect(server.connections).toBe(0);

		process.env.WEBHOOK_ALLOW_INSIDE = 'HOOKS.example.test.';
		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		await vi.waitFor(() => expect(server.received).toHaveLength(1));
		expect(server.received[0].headers.host).toBe(`hooks.example.test:${server.port}`);
	});

	it('refuses at delivery a name registered while it looked outside, once it resolves inside', async () => {
		const server = await receiver();
		const owner = makeUser();
		const { board } = makeBoard({ owner });

		// No lookup is made at registration: the setup's refusal of every lookup is still in place.
		const made = await api('POST', `/api/v1/boards/${board.id}/webhooks`, {
			user: owner,
			body: { url: `http://rebinding.example.test:${server.port}/x` }
		});
		expect(made.status).toBe(201);

		answerLookups({ 'rebinding.example.test': [v4('127.0.0.1')] });
		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		await vi.waitFor(() => expect(lines('WARN')).toHaveLength(1));
		expect(lines('WARN')[0]).toMatch(/not sent: rebinding\.example\.test resolves to 127\.0\.0\.1, a loopback address$/);
		expect(server.connections).toBe(0);
	});

	it('looks the name up again for the next delivery, so a name taken off the list is refused at once', async () => {
		const server = await receiver();
		answerLookups({ 'hooks.example.test': [v4('127.0.0.1')] });
		process.env.WEBHOOK_ALLOW_INSIDE = 'hooks.example.test';
		const { board } = makeBoard({ owner: makeUser() });
		makeWebhook(board, { url: `http://hooks.example.test:${server.port}/x` });

		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		await vi.waitFor(() => expect(server.received).toHaveLength(1));

		process.env.WEBHOOK_ALLOW_INSIDE = '';
		dispatchWebhook(board.id, 'card.moved', { cardId: 1 });
		await vi.waitFor(() => expect(lines('WARN')).toHaveLength(1));
		expect(lines('WARN')[0]).toMatch(/not sent: hooks\.example\.test resolves to 127\.0\.0\.1/);
		expect(server.received).toHaveLength(1);
		expect(server.connections).toBe(1);
	});

	it('refuses a name that answers one address outside and one inside, before any connection', async () => {
		answerLookups({ 'both.example.test': [v4('93.184.216.34'), v4('127.0.0.1')] });
		const { board } = makeBoard({ owner: makeUser() });
		const hook = makeWebhook(board, { url: 'http://both.example.test/x' });

		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		await vi.waitFor(() => expect(lines('WARN')).toHaveLength(1));
		expect(lines('WARN')).toEqual([
			`Webhook ${hook.id} on board ${board.id} not sent: both.example.test resolves to 127.0.0.1, a loopback address`
		]);
		expect(lines('ERROR')).toEqual([]);
	});

	it('refuses every inside IPv6 answer, each given as the resolver gives it, before any connection', async () => {
		const answers: Record<string, [Answer[], string]> = {
			'a.example.test': [[v6('::1')], '::1, a loopback address'],
			'b.example.test': [[v6('::')], '::, the unspecified address, which reaches this server'],
			'c.example.test': [[v6('fd12::1')], 'fd12::1, a unique local address (a private network)'],
			'd.example.test': [[v6('fe80::1')], 'fe80::1, a link-local address'],
			'e.example.test': [[v6('::ffff:127.0.0.1')], '::ffff:127.0.0.1, a loopback address (it holds 127.0.0.1)'],
			'f.example.test': [[v6('::ffff:7f00:1')], '::ffff:7f00:1, a loopback address (it holds 127.0.0.1)'],
			'g.example.test': [
				[v6('::ffff:169.254.169.254')],
				'::ffff:169.254.169.254, a link-local address, where the cloud metadata service is (it holds 169.254.169.254)'
			],
			'h.example.test': [[v6('64:ff9b::7f00:1')], '64:ff9b::7f00:1, a loopback address (it holds 127.0.0.1)'],
			'i.example.test': [[v6('2002:7f00:1::1')], '2002:7f00:1::1, a loopback address (it holds 127.0.0.1)'],
			'j.example.test': [[v6('2606:4700::1111'), v6('::1')], '::1, a loopback address']
		};
		answerLookups(Object.fromEntries(Object.entries(answers).map(([name, [found]]) => [name, found])));
		const { board } = makeBoard({ owner: makeUser() });
		const hooks = Object.keys(answers).map((name) => [name, makeWebhook(board, { url: `http://${name}/x` })] as const);

		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		await vi.waitFor(() => expect(lines('WARN')).toHaveLength(hooks.length));
		expect(lines('WARN').sort()).toEqual(
			hooks.map(([name, hook]) => `Webhook ${hook.id} on board ${board.id} not sent: ${name} resolves to ${answers[name][1]}`).sort()
		);
		expect(lines('ERROR')).toEqual([]);
	});

	it('does not follow a redirect, and says so', async () => {
		process.env.WEBHOOK_ALLOW_INSIDE = '127.0.0.0/8';
		const server = await receiver((req, res) => {
			res.writeHead(307, { Location: '/elsewhere' });
			res.end();
		});
		const { board } = makeBoard({ owner: makeUser() });
		const hook = makeWebhook(board, { url: `http://127.0.0.1:${server.port}/first` });

		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		await vi.waitFor(() => expect(lines('WARN')).toHaveLength(1));
		await aMoment();
		expect(server.received.map((r) => r.url)).toEqual(['/first']);
		expect(lines('WARN')).toEqual([
			`Webhook ${hook.id} on board ${board.id}: 127.0.0.1:${server.port} answered 307, a redirect, which is not followed`
		]);
	});

	it('refuses a stored address with credentials, or inside as written, with no lookup and no connection', async () => {
		const server = await receiver();
		const { board } = makeBoard({ owner: makeUser() });
		const stored = [
			[`http://localhost:${server.port}/`, 'localhost is this server'],
			['http://n8n/', 'n8n is a name with no dot, which is looked up inside the network'],
			[`http://[::ffff:127.0.0.1]:${server.port}/`, '[::ffff:7f00:1] is a loopback address (it holds 127.0.0.1)']
		].map(([url, why]) => [makeWebhook(board, { url }), why] as const);

		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		await vi.waitFor(() => expect(lines('WARN')).toHaveLength(stored.length));
		expect(lines('WARN')).toEqual(stored.map(([hook, why]) => `Webhook ${hook.id} on board ${board.id} not sent: ${why}`));

		// A user name or password is refused even where the address is allowed.
		process.env.WEBHOOK_ALLOW_INSIDE = '127.0.0.0/8,localhost';
		sqlite.prepare('DELETE FROM webhooks').run();
		const withCredentials = makeWebhook(board, { url: `http://u:p@127.0.0.1:${server.port}/` });
		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		await vi.waitFor(() => expect(lines('WARN')).toHaveLength(stored.length + 1));
		expect(lines('WARN').at(-1)).toBe(
			`Webhook ${withCredentials.id} on board ${board.id} not sent: the address for 127.0.0.1:${server.port} carries a user name or password`
		);
		await aMoment();
		expect(server.connections).toBe(0);
	});

	it('refuses a stored address that is not http or https, or not an address at all', async () => {
		const { board } = makeBoard({ owner: makeUser() });
		const stored = [
			['ftp://files.example.test/x', 'its address is not an http or https address (ftp:)'],
			['data:text/plain,hello', 'its address is not an http or https address (data:)'],
			['not an address', 'its address is not a URL']
		].map(([url, why]) => [makeWebhook(board, { url }), why] as const);

		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		await vi.waitFor(() => expect(lines('WARN')).toHaveLength(stored.length));
		expect(lines('WARN')).toEqual(stored.map(([hook, why]) => `Webhook ${hook.id} on board ${board.id} not sent: ${why}`));
	});

	it('refuses https to a name inside before any handshake, and makes the handshake through the guarded lookup once allowed', async () => {
		const server = await receiver();
		answerLookups({ 'secure.example.test': [v4('127.0.0.1')] });
		const { board } = makeBoard({ owner: makeUser() });
		const hook = makeWebhook(board, { url: `https://secure.example.test:${server.port}/x` });

		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		await vi.waitFor(() => expect(lines('WARN')).toHaveLength(1));
		expect(lines('WARN')[0]).toMatch(/not sent: secure\.example\.test resolves to 127\.0\.0\.1/);
		expect(server.connections).toBe(0);

		// Allowed, it reaches the plain-HTTP server, and the handshake fails there.
		process.env.WEBHOOK_ALLOW_INSIDE = 'secure.example.test';
		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		await vi.waitFor(() => expect(lines('ERROR')).toHaveLength(1), { timeout: 5000 });
		expect(server.connections).toBe(1);
		expect(lines('ERROR')[0]).toMatch(
			new RegExp(`^Webhook ${hook.id} on board ${board.id}: delivery to secure\\.example\\.test:${server.port} failed: `)
		);
		expect(lines('ERROR')[0]).not.toContain('/x');
	});

	it('logs nothing for a receiver that answers and then holds its body open past the timeout', async () => {
		process.env.WEBHOOK_ALLOW_INSIDE = '127.0.0.1';
		const server = await receiver((req, res) => {
			res.writeHead(200, { 'Content-Type': 'text/plain' });
			res.write('still ');
		});
		const { board } = makeBoard({ owner: makeUser() });
		const hook = makeWebhook(board, { url: `http://127.0.0.1:${server.port}/` });

		deliver(hook, 'card.created', '{}', 150);
		await vi.waitFor(() => expect(server.received).toHaveLength(1));
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(lines('ERROR')).toEqual([]);
		expect(lines('WARN')).toEqual([]);
	});

	it('logs one ERROR naming the host, and not the path, for a closed port', async () => {
		process.env.WEBHOOK_ALLOW_INSIDE = '127.0.0.1';
		const port = await closedPort();
		const { board } = makeBoard({ owner: makeUser() });
		const hook = makeWebhook(board, { url: `http://127.0.0.1:${port}/secret-path?token=t0k3n` });

		deliver(hook, 'card.created', '{}', 8000);
		await vi.waitFor(() => expect(lines('ERROR')).toHaveLength(1), { timeout: 8000 });
		expect(lines('ERROR')[0]).toMatch(new RegExp(`^Webhook ${hook.id} on board ${board.id}: delivery to 127\\.0\\.0\\.1:${port} failed: `));
		expect(lines('ERROR')[0]).not.toMatch(/secret-path|t0k3n/);
	}, 10_000);

	it('logs one ERROR for a receiver that sends no status within the timeout', async () => {
		process.env.WEBHOOK_ALLOW_INSIDE = '127.0.0.1';
		const server = await receiver(() => {
			// No answer.
		});
		const { board } = makeBoard({ owner: makeUser() });
		const hook = makeWebhook(board, { url: `http://127.0.0.1:${server.port}/` });

		deliver(hook, 'card.created', '{}', 150);
		await vi.waitFor(() => expect(lines('ERROR')).toHaveLength(1));
		expect(lines('ERROR')).toEqual([
			`Webhook ${hook.id} on board ${board.id}: delivery to 127.0.0.1:${server.port} failed: no answer within 0.15 s`
		]);
	});

	it('keeps refusing this server and the metadata service while WEBHOOK_ALLOW_INSIDE is too wide to be taken', async () => {
		process.env.WEBHOOK_ALLOW_INSIDE = '0.0.0.0/0,::/0,::ffff:0:0/96,10.0.0.0/2';
		const server = await receiver();
		const { board } = makeBoard({ owner: makeUser() });
		makeWebhook(board, { url: `http://127.0.0.1:${server.port}/` });
		makeWebhook(board, { url: 'http://169.254.169.254/latest/meta-data/' });
		makeWebhook(board, { url: `http://[::ffff:127.0.0.1]:${server.port}/` });

		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		await vi.waitFor(() => expect(lines('WARN')).toHaveLength(3));
		expect(lines('WARN').map((line) => line.replace(/^Webhook \d+ on board \d+ not sent: /, ''))).toEqual([
			'127.0.0.1 is a loopback address',
			'169.254.169.254 is a link-local address, where the cloud metadata service is',
			'[::ffff:7f00:1] is a loopback address (it holds 127.0.0.1)'
		]);
		expect(server.connections).toBe(0);
	});

	it('refuses a listed name that resolves to 0.0.0.0 or ::, which a DNS filter answers for a name it blocks (the final review)', async () => {
		const server = await receiver();
		process.env.WEBHOOK_ALLOW_INSIDE = 'blocked.example.test,filtered.example.test';
		answerLookups({ 'blocked.example.test': [v4('0.0.0.0')], 'filtered.example.test': [v6('::')] });
		const { board } = makeBoard({ owner: makeUser() });
		const blocked = makeWebhook(board, { url: `http://blocked.example.test:${server.port}/x` });
		const filtered = makeWebhook(board, { url: `http://filtered.example.test:${server.port}/x` });

		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		await vi.waitFor(() => expect(lines('WARN')).toHaveLength(2));
		expect([...lines('WARN')].sort()).toEqual([
			`Webhook ${blocked.id} on board ${board.id} not sent: blocked.example.test resolves to 0.0.0.0, a "this network" address, which reaches this server`,
			`Webhook ${filtered.id} on board ${board.id} not sent: filtered.example.test resolves to ::, the unspecified address, which reaches this server`
		]);
		await aMoment();
		expect(server.connections).toBe(0);
		expect(lines('ERROR')).toEqual([]);
	});
});

describe('insideReason, the one judgement of an address (card 2161)', () => {
	const LOOPBACK = 'a loopback address';
	const PRIVATE = 'a private network address';
	const DOCUMENTATION = 'a documentation address';
	const THIS_NETWORK = 'a "this network" address, which reaches this server';
	const METADATA = 'a link-local address, where the cloud metadata service is';
	// Each row of decision 3's tables, as revised (N1): its first and last
	// address, and the address just outside it on each side where that is
	// outside every row.
	const TABLE: [string, string | null][] = [
		['0.0.0.0', THIS_NETWORK],
		['0.255.255.255', THIS_NETWORK],
		['1.0.0.0', null],
		['9.255.255.255', null],
		['10.0.0.0', PRIVATE],
		['10.255.255.255', PRIVATE],
		['11.0.0.0', null],
		['100.63.255.255', null],
		['100.64.0.0', 'a shared address (carrier NAT, Tailscale)'],
		['100.127.255.255', 'a shared address (carrier NAT, Tailscale)'],
		['100.128.0.0', null],
		['126.255.255.255', null],
		['127.0.0.0', LOOPBACK],
		['127.255.255.255', LOOPBACK],
		['128.0.0.0', null],
		['169.253.255.255', null],
		['169.254.0.0', METADATA],
		['169.254.255.255', METADATA],
		['169.255.0.0', null],
		['172.15.255.255', null],
		['172.16.0.0', PRIVATE],
		['172.31.255.255', PRIVATE],
		['172.32.0.0', null],
		['191.255.255.255', null],
		['192.0.0.0', 'an IETF protocol address'],
		['192.0.0.255', 'an IETF protocol address'],
		['192.0.1.0', null],
		['192.0.1.255', null],
		['192.0.2.0', DOCUMENTATION],
		['192.0.2.255', DOCUMENTATION],
		['192.0.3.0', null],
		['192.88.98.255', null],
		['192.88.99.0', 'a 6to4 relay address'],
		['192.88.99.255', 'a 6to4 relay address'],
		['192.88.100.0', null],
		['192.167.255.255', null],
		['192.168.0.0', PRIVATE],
		['192.168.255.255', PRIVATE],
		['192.169.0.0', null],
		['198.17.255.255', null],
		['198.18.0.0', 'a benchmarking address'],
		['198.19.255.255', 'a benchmarking address'],
		['198.20.0.0', null],
		['198.51.99.255', null],
		['198.51.100.0', DOCUMENTATION],
		['198.51.100.255', DOCUMENTATION],
		['198.51.101.0', null],
		['203.0.112.255', null],
		['203.0.113.0', DOCUMENTATION],
		['203.0.113.255', DOCUMENTATION],
		['203.0.114.0', null],
		['223.255.255.255', null],
		['224.0.0.0', 'a multicast address'],
		['239.255.255.255', 'a multicast address'],
		['240.0.0.0', 'a reserved address'],
		['255.255.255.255', 'a reserved address'],
		['8.8.8.8', null],
		['93.184.216.34', null],

		['::', 'the unspecified address, which reaches this server'],
		['::1', LOOPBACK],
		['::2', 'a reserved address'],
		['ff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'a reserved address'],
		['::1:0:0:0', 'a reserved address'],
		['::ffff:0:0:0', 'a reserved address'],
		['64:ff9b:1::', 'a local-use NAT64 address'],
		['64:ff9b:1:ffff:ffff:ffff:ffff:ffff', 'a local-use NAT64 address'],
		['64:ff9b:2::', 'a reserved address'],
		['100::', 'a discard-only address'],
		['100::ffff:ffff:ffff:ffff', 'a discard-only address'],
		['100:0:0:1::', null],
		['2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff', null],
		['2001::', 'an IETF protocol address'],
		['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'an IETF protocol address'],
		['2001:2::1', 'an IETF protocol address'],
		['2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff', 'an IETF protocol address'],
		['2001:200::', null],
		['2001:db7:ffff:ffff:ffff:ffff:ffff:ffff', null],
		['2001:db8::', DOCUMENTATION],
		['2001:db8:ffff:ffff:ffff:ffff:ffff:ffff', DOCUMENTATION],
		['2001:db9::', null],
		['2003::', null],
		['3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff', null],
		['3fff::', DOCUMENTATION],
		['3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff', DOCUMENTATION],
		['3fff:1000::', null],
		['5eff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', null],
		['5f00::', 'an SRv6 identifier'],
		['5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'an SRv6 identifier'],
		['5f01::', null],
		['fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', null],
		['fc00::', 'a unique local address (a private network)'],
		['fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'a unique local address (a private network)'],
		['fe00::', null],
		['fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff', null],
		['fe80::', 'a link-local address'],
		['febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'a link-local address'],
		['fe80::1%eth0', 'a link-local address'],
		['fec0::', 'a site-local address'],
		['feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'a site-local address'],
		['ff00::', 'a multicast address'],
		['ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'a multicast address'],
		['2606:4700::1111', null],

		// The forms that hold an IPv4 address are judged by it.
		['::ffff:127.0.0.1', `${LOOPBACK} (it holds 127.0.0.1)`],
		['::ffff:7f00:1', `${LOOPBACK} (it holds 127.0.0.1)`],
		['::ffff:0.0.0.0', `${THIS_NETWORK} (it holds 0.0.0.0)`],
		['::ffff:8.8.8.8', null],
		['::ffff:808:808', null],
		['64:ff9b::7f00:1', `${LOOPBACK} (it holds 127.0.0.1)`],
		['64:ff9b::127.0.0.1', `${LOOPBACK} (it holds 127.0.0.1)`],
		['64:ff9b::8.8.8.8', null],
		['2002:7f00:1::1', `${LOOPBACK} (it holds 127.0.0.1)`],
		['2002:a00:1::', `${PRIVATE} (it holds 10.0.0.1)`],
		['2002:808:808::1', null],

		// An address that cannot be read is inside: a "no" is never trusted for one.
		['not-an-ip', 'not an address'],
		['', 'not an address'],
		['127.1', 'not an address']
	];

	it.each(TABLE)('%s: %s', (address, why) => {
		expect(insideReason(address)).toBe(why);
	});
});

describe('addressRefusal, an address as written (card 2161)', () => {
	const refusal = (url: string) => addressRefusal(new URL(url));
	const inside = (reason: string) => ({ kind: 'inside', reason });

	it('reads an IPv4 address written in another form as the URL parser reads it', () => {
		for (const url of ['http://2130706433/', 'http://0x7f.1/', 'http://127.1/', 'http://0177.0.0.1/', 'http://127.0.0.1./']) {
			expect(refusal(url), url).toEqual(inside('127.0.0.1 is a loopback address'));
		}
		expect(refusal('http://0.0.0.0/')).toEqual(inside('0.0.0.0 is a "this network" address, which reaches this server'));
		expect(refusal('http://[::]/')).toEqual(inside('[::] is the unspecified address, which reaches this server'));
		expect(refusal('http://169.254.169.254/latest/')).toEqual(
			inside('169.254.169.254 is a link-local address, where the cloud metadata service is')
		);
	});

	it('judges the forms that hold an IPv4 address by it', () => {
		expect(refusal('http://[::ffff:127.0.0.1]/')).toEqual(inside('[::ffff:7f00:1] is a loopback address (it holds 127.0.0.1)'));
		expect(refusal('http://[0:0:0:0:0:ffff:7f00:1]/')).toEqual(inside('[::ffff:7f00:1] is a loopback address (it holds 127.0.0.1)'));
		expect(refusal('http://[64:ff9b::7f00:1]/')).toEqual(inside('[64:ff9b::7f00:1] is a loopback address (it holds 127.0.0.1)'));
		expect(refusal('http://[2002:7f00:1::1]/')).toEqual(inside('[2002:7f00:1::1] is a loopback address (it holds 127.0.0.1)'));
		for (const url of ['http://[::ffff:8.8.8.8]/', 'http://[64:ff9b::808:808]/', 'http://[2002:808:808::1]/']) {
			expect(refusal(url), url).toBeNull();
		}
	});

	it('refuses the names inside whatever they resolve to, with case ignored and every final dot removed', () => {
		const names: [string, string][] = [
			['localhost', 'localhost is this server'],
			['LOCALHOST.', 'localhost is this server'],
			['localhost..', 'localhost is this server'],
			['a.localhost', 'a.localhost is this server'],
			['n8n', 'n8n is a name with no dot, which is looked up inside the network'],
			['N8N.', 'n8n is a name with no dot, which is looked up inside the network'],
			['n8n..', 'n8n is a name with no dot, which is looked up inside the network'],
			['printer.local', 'printer.local is a name on the local link (.local)'],
			['PRINTER.LOCAL.', 'printer.local is a name on the local link (.local)'],
			['host.docker.internal', 'host.docker.internal is a name kept for private networks (.internal)'],
			['host.docker.internal.', 'host.docker.internal is a name kept for private networks (.internal)'],
			['x.home.arpa', 'x.home.arpa is a home network name (.home.arpa)'],
			['X.Home.Arpa.', 'x.home.arpa is a home network name (.home.arpa)'],
			['a..b.example.test', 'a..b.example.test is a name with an empty label']
		];
		for (const [host, why] of names) expect(refusal(`http://${host}:5678/x`), host).toEqual(inside(why));
		// Any other name is judged at delivery, by what it resolves to.
		expect(refusal('https://hooks.example.test/x')).toBeNull();
		expect(refusal('https://hooks.example.test./x')).toBeNull();
	});

	it('refuses a user name or password, wherever the address points', () => {
		expect(refusal('https://u:p@hooks.example.test/')).toEqual({
			kind: 'credentials',
			reason: 'the address for hooks.example.test carries a user name or password'
		});
		expect(refusal('https://u@hooks.example.test:8443/')).toMatchObject({ kind: 'credentials' });
	});

	it('lets in what WEBHOOK_ALLOW_INSIDE names, and nothing beside it', () => {
		process.env.WEBHOOK_ALLOW_INSIDE = ' n8n , 10.0.5.0/24, [fd00::1], not:valid ';
		expect(refusal('http://n8n:5678/x')).toBeNull();
		expect(refusal('http://N8N.:5678/x')).toBeNull();
		expect(refusal('http://10.0.5.20/x')).toBeNull();
		expect(refusal('http://[::ffff:10.0.5.20]/x')).toBeNull();
		expect(refusal('http://10.0.6.1/x')).toEqual(inside('10.0.6.1 is a private network address'));
		expect(refusal('http://[fd00::1]/x')).toBeNull();
		expect(refusal('http://[fd00::2]/x')).toEqual(inside('[fd00::2] is a unique local address (a private network)'));
		expect(refusal('http://jenkins/x')).toEqual(inside('jenkins is a name with no dot, which is looked up inside the network'));
		expect(refusal('http://localhost/x')).toEqual(inside('localhost is this server'));
		expect(refusal('http://u:p@n8n/x')).toMatchObject({ kind: 'credentials' });
	});

	it('keeps refusing this server and the metadata service while WEBHOOK_ALLOW_INSIDE is too wide to be taken', () => {
		for (const value of ['0.0.0.0/0', '::/0', '::ffff:0:0/96', '10.0.0.0/2', '0.0.0.0/0,::/0,::ffff:0:0/96,10.0.0.0/2']) {
			process.env.WEBHOOK_ALLOW_INSIDE = value;
			expect(refusal('http://169.254.169.254/'), value).toMatchObject({ kind: 'inside' });
			expect(refusal('http://127.0.0.1/'), value).toMatchObject({ kind: 'inside' });
			expect(refusal('http://[::ffff:127.0.0.1]/'), value).toMatchObject({ kind: 'inside' });
			expect(refusal('http://10.0.0.1/'), value).toMatchObject({ kind: 'inside' });
		}
	});

	it('refuses an address written in 0.0.0.0/8 whatever range is listed (the final review)', () => {
		// Each is kept as a range (one row holds it, and it holds no 0.0.0.0), and lets in nothing.
		process.env.WEBHOOK_ALLOW_INSIDE = '0.0.0.5,::ffff:0.0.0.6';
		expect(refusal('http://0.0.0.5/x')).toEqual(inside('0.0.0.5 is a "this network" address, which reaches this server'));
		expect(refusal('http://[::ffff:0.0.0.6]/x')).toEqual(
			inside('[::ffff:0:6] is a "this network" address, which reaches this server (it holds 0.0.0.6)')
		);
	});
});

describe('WEBHOOK_ALLOW_INSIDE (card 2161)', () => {
	it('keeps an address or range only if it lies wholly inside one inside range, and a host name as written', () => {
		const read = parseAllowInside(
			'0.0.0.0/0, ::/0, ::ffff:0:0/96, 10.0.0.0/2, 8.8.8.0/24, 8.8.8.8, 127.1, 0x7f.1, n8n:5678, *.corp.example, ' +
				'http://n8n/, 10.0.5.0/x, 10.0.5.0/33, n8n/24, 10.0.5.0/24, 10.0.5.20, fd00::/8, [fd00::1], N8N., host.docker.internal'
		);

		expect(read.bad).toEqual([
			{ entry: '0.0.0.0/0', why: 'wider than one inside range' },
			{ entry: '::/0', why: 'wider than one inside range' },
			{ entry: '::ffff:0:0/96', why: 'wider than one inside range' },
			{ entry: '10.0.0.0/2', why: 'wider than one inside range' },
			{ entry: '8.8.8.0/24', why: 'not inside the network, so it allows nothing' },
			{ entry: '8.8.8.8', why: 'not inside the network, so it allows nothing' },
			{ entry: '127.1', why: 'an IPv4 address not written as four decimal numbers' },
			{ entry: '0x7f.1', why: 'an IPv4 address not written as four decimal numbers' },
			{ entry: 'n8n:5678', why: 'not a host name, an address or a range (a port, a path or a wildcard is not taken)' },
			{ entry: '*.corp.example', why: 'not a host name, an address or a range (a port, a path or a wildcard is not taken)' },
			{ entry: 'http://n8n/', why: 'not a host name, an address or a range (a port, a path or a wildcard is not taken)' },
			{ entry: '10.0.5.0/x', why: 'its range is not a number of bits' },
			{ entry: '10.0.5.0/33', why: 'its range is not a number of bits' },
			{ entry: 'n8n/24', why: 'not a host name, an address or a range (a port, a path or a wildcard is not taken)' }
		]);
		expect([...read.names]).toEqual(['n8n', 'host.docker.internal']);
		expect(read.ranges).toHaveLength(4);
	});

	it('ignores an entry one row holds that also holds this server, or a row before that one (the review, S3)', () => {
		const SERVER_V6 = 'it holds ::, the unspecified address, which reaches this server';
		const SERVER_V4 = 'it holds 0.0.0.0, a "this network" address, which reaches this server';
		const read = parseAllowInside(
			'::ffff:10.0.5.0/24, ::1/8, ::/8, ::/96, 0.0.0.0/8, 0.0.0.0, ::, 64::/16, ::10.0.5.0/120, 64:ff9b::/64, ::ffff:0.0.0.0/104, ' +
				'::1, ::ffff:10.0.5.0/120, 64:ff9b:1::/48, 0.1.2.0/24'
		);

		expect(read.bad).toEqual([
			{ entry: '::ffff:10.0.5.0/24', why: 'an IPv4-mapped range needs /96 or more' },
			{ entry: '::1/8', why: SERVER_V6 },
			{ entry: '::/8', why: SERVER_V6 },
			{ entry: '::/96', why: SERVER_V6 },
			{ entry: '0.0.0.0/8', why: SERVER_V4 },
			{ entry: '0.0.0.0', why: SERVER_V4 },
			{ entry: '::', why: SERVER_V6 },
			{ entry: '64::/16', why: 'it holds 64:ff9b:1::/48, a local-use NAT64 address' },
			{ entry: '::10.0.5.0/120', why: 'a reserved range inside ::/8 (an IPv4-mapped range needs /96 or more)' },
			{ entry: '64:ff9b::/64', why: 'a NAT64 range needs /96 or more' },
			{ entry: '::ffff:0.0.0.0/104', why: SERVER_V4 }
		]);
		// `::1` alone is a receiver on this server named on purpose, as `127.0.0.1` is.
		expect(read.ranges).toHaveLength(4);
	});

	it('keeps refusing ::1 and 0.0.0.0 while an entry that would have let them in is ignored (the review, S3)', () => {
		for (const value of ['::ffff:10.0.5.0/24', '::1/8', '::/8', '::/96', '0.0.0.0/8']) {
			process.env.WEBHOOK_ALLOW_INSIDE = value;
			expect(addressRefusal(new URL('http://[::1]/')), value).toMatchObject({ kind: 'inside' });
			expect(addressRefusal(new URL('http://[::]/')), value).toMatchObject({ kind: 'inside' });
			expect(addressRefusal(new URL('http://0.0.0.0/')), value).toMatchObject({ kind: 'inside' });
		}
	});

	it('is named at start-up, one WARN for each entry ignored and none for one kept (R-S2)', () => {
		const startup = () =>
			(
				sqlite.prepare("SELECT level, message FROM system_logs WHERE context = 'STARTUP' ORDER BY id").all() as {
					level: string;
					message: string;
				}[]
			).map((row) => `${row.level} ${row.message}`);

		expect(reportWebhookAllowInside(undefined)).toBe(false);
		expect(reportWebhookAllowInside('n8n,10.0.5.0/24,[fd00::1]')).toBe(false);
		expect(startup()).toEqual([]);

		expect(reportWebhookAllowInside('0.0.0.0/0,::/0,10.0.0.0/2,127.1,10.0.5.0/24')).toBe(true);
		expect(startup()).toEqual([
			'WARN WEBHOOK_ALLOW_INSIDE: "0.0.0.0/0" ignored: wider than one inside range',
			'WARN WEBHOOK_ALLOW_INSIDE: "::/0" ignored: wider than one inside range',
			'WARN WEBHOOK_ALLOW_INSIDE: "10.0.0.0/2" ignored: wider than one inside range',
			'WARN WEBHOOK_ALLOW_INSIDE: "127.1" ignored: an IPv4 address not written as four decimal numbers'
		]);
	});
});

describe('readWebhookUrl, for registration (card 2161)', () => {
	const refused = (body: Record<string, unknown>, rule = {}) => {
		try {
			readWebhookUrl(body, rule);
		} catch (thrown) {
			if (isHttpError(thrown, 400)) return thrown.body.message;
			throw thrown;
		}
		return null;
	};

	it('answers 400 for an address inside, or one with credentials, naming why', () => {
		expect(refused({ url: 'http://127.0.0.1/x' })).toBe('Webhook url points inside the network: 127.0.0.1 is a loopback address');
		expect(refused({ url: 'http://localhost./' })).toBe('Webhook url points inside the network: localhost is this server');
		expect(refused({ url: 'https://u:p@hooks.example.test/' })).toBe('Webhook url must not carry a user name or password');
		expect(refused({ url: 'ftp://hooks.example.test/' })).toBe('url must be an http or https address');
	});

	it('takes a name outside without looking it up, and nothing when nothing is sent', () => {
		// The setup refuses every lookup, and fails the test that made one.
		expect(readWebhookUrl({ url: ' https://hooks.example.test/x ' }, {})).toBe('https://hooks.example.test/x');
		expect(readWebhookUrl({}, {})).toBeUndefined();
	});

	it('accepts a stored address sent back unchanged, and refuses another inside one', () => {
		const keep = 'http://10.0.0.5/x';
		expect(readWebhookUrl({ url: keep }, { keep })).toBe(keep);
		expect(refused({ url: 'http://10.0.0.6/x' }, { keep })).toBe(
			'Webhook url points inside the network: 10.0.0.6 is a private network address'
		);
	});
});

// ─── Slice 3: the routes ─────────────────────────────────────────────────

/** The board's webhooks as stored, in the order they were made. */
const rowsOf = (boardId: number) =>
	sqlite.prepare('SELECT id, url, secret, events, active, set_by FROM webhooks WHERE board_id = ? ORDER BY id').all(boardId) as {
		id: number;
		url: string;
		secret: string;
		events: string;
		active: number;
		set_by: number | null;
	}[];

describe('where a webhook may send, at registration (card 2161)', () => {
	/** Each is inside as written, whatever it would resolve to. */
	const INSIDE = [
		'http://127.0.0.1/x',
		'http://[::1]/',
		'http://localhost./',
		'http://a.localhost/',
		'http://n8n:5678/',
		'http://printer.local/',
		'http://host.docker.internal/',
		'http://x.home.arpa/',
		'http://169.254.169.254/',
		'http://2130706433/',
		'http://[::ffff:7f00:1]/'
	];
	const CREDENTIALS = 'https://u:p@hooks.example.test/';
	/** What lets each of INSIDE in: an address or a name, each exactly. */
	const ALLOW_ALL = '127.0.0.1,::1,localhost,a.localhost,n8n,printer.local,host.docker.internal,x.home.arpa,169.254.169.254';

	const said = (url: string) => `Webhook url points inside the network: ${addressRefusal(new URL(url))!.reason}`;

	it('refuses each address inside, and one with credentials, on a create and on an update, naming why, and writes nothing', async () => {
		const owner = makeUser();
		const { board } = makeBoard({ owner });
		const hook = makeWebhook(board, { setBy: owner });
		const before = snapshotDb();

		for (const url of INSIDE) {
			const made = await api('POST', `/api/v1/boards/${board.id}/webhooks`, { user: owner, body: { url } });
			const changed = await api('PUT', `/api/v1/webhooks/${hook.id}`, { user: owner, body: { url } });
			for (const res of [made, changed]) {
				expect(res.status, url).toBe(400);
				expect(res.body.message, url).toBe(said(url));
			}
		}
		const made = await api('POST', `/api/v1/boards/${board.id}/webhooks`, { user: owner, body: { url: CREDENTIALS } });
		const changed = await api('PUT', `/api/v1/webhooks/${hook.id}`, { user: owner, body: { url: CREDENTIALS } });
		for (const res of [made, changed]) {
			expect(res.status).toBe(400);
			expect(res.body.message).toBe('Webhook url must not carry a user name or password');
		}
		expectUnchanged(before);

		// Two in full, so that the words are pinned here and not only by addressRefusal's own tests.
		expect(said('http://127.0.0.1/x')).toBe('Webhook url points inside the network: 127.0.0.1 is a loopback address');
		expect(said('http://n8n:5678/')).toBe(
			'Webhook url points inside the network: n8n is a name with no dot, which is looked up inside the network'
		);
	});

	it('takes each once WEBHOOK_ALLOW_INSIDE names it, and never one with credentials', async () => {
		process.env.WEBHOOK_ALLOW_INSIDE = ALLOW_ALL;
		const owner = makeUser();
		const { board } = makeBoard({ owner });
		const hook = makeWebhook(board, { setBy: owner });

		for (const url of INSIDE) {
			const made = await api('POST', `/api/v1/boards/${board.id}/webhooks`, { user: owner, body: { url } });
			expect(made.status, url).toBe(201);
			// A board holds at most 10: each is taken away again.
			sqlite.prepare('DELETE FROM webhooks WHERE id = ?').run(made.body.id);
		}
		expect((await api('PUT', `/api/v1/webhooks/${hook.id}`, { user: owner, body: { url: 'http://n8n:5678/' } })).status).toBe(200);
		expect((await api('POST', `/api/v1/boards/${board.id}/webhooks`, { user: owner, body: { url: CREDENTIALS } })).status).toBe(400);
	});

	it('takes a public name without looking it up', async () => {
		const looked = vi.fn();
		(dns as unknown as { lookup: unknown }).lookup = looked;
		const owner = makeUser();
		const { board } = makeBoard({ owner });

		const made = await api('POST', `/api/v1/boards/${board.id}/webhooks`, { user: owner, body: { url: 'https://hooks.example.test/x' } });
		const changed = await api('PUT', `/api/v1/webhooks/${made.body.id}`, { user: owner, body: { url: 'https://other.example.test/y' } });

		expect(made.status).toBe(201);
		expect(changed.status).toBe(200);
		expect(looked).not.toHaveBeenCalled();
	});

	it('accepts a stored inside address sent back unchanged, and refuses a different inside one', async () => {
		const owner = makeUser();
		const { board } = makeBoard({ owner });
		// Stored before the rule, or while the allow-list named it.
		const hook = makeWebhook(board, { url: 'http://10.0.0.5/x' });

		const same = await api('PUT', `/api/v1/webhooks/${hook.id}`, { user: owner, body: { url: 'http://10.0.0.5/x', events: ['card.moved'] } });
		expect(same.status).toBe(200);
		expect(rowsOf(board.id)[0]).toMatchObject({ events: '["card.moved"]' });
		expect(readOpenedUrl(hook.id)).toBe('http://10.0.0.5/x');

		const other = await api('PUT', `/api/v1/webhooks/${hook.id}`, { user: owner, body: { url: 'http://10.0.0.6/x' } });
		expect(other.status).toBe(400);
		expect(other.body.message).toBe('Webhook url points inside the network: 10.0.0.6 is a private network address');
		expect(readOpenedUrl(hook.id)).toBe('http://10.0.0.5/x');
	});
});

describe('who set a webhook, recorded and never answered (card 2168)', () => {
	it('records the caller of a create as its setter, and gives the column in no answer', async () => {
		const owner = makeUser();
		const editor = makeUser();
		const { board } = makeBoard({ owner });
		addBoardMember(board, editor, 'editor');

		const made = await api('POST', `/api/v1/boards/${board.id}/webhooks`, { user: editor, body: { url: 'https://hooks.example.test/x' } });

		expect(made.status).toBe(201);
		expect(rowsOf(board.id)).toMatchObject([{ id: made.body.id, set_by: editor.id }]);
		const answers = [
			made.body,
			(await api('GET', `/api/v1/webhooks/${made.body.id}`, { user: owner })).body,
			(await api('GET', `/api/v1/boards/${board.id}/webhooks`, { user: owner })).body[0],
			(await api('PUT', `/api/v1/webhooks/${made.body.id}`, { user: owner, body: { url: 'https://hooks.example.test/y' } })).body
		];
		for (const answer of answers) {
			expect(answer).toHaveProperty('id', made.body.id);
			expect(answer).not.toHaveProperty('setBy');
			expect(answer).not.toHaveProperty('set_by');
		}
	});

	it('makes the caller of an update that changes the address or the secret, or switches it on, its setter, and nothing else does', async () => {
		const owner = makeUser();
		const admin = makeUser({ role: 'admin' });
		const editor = makeUser();
		const { board } = makeBoard({ owner });
		addBoardMember(board, editor, 'editor');
		const hook = makeWebhook(board, { url: 'https://hooks.example.test/x', secret: 's1', setBy: owner });
		const setter = () => rowsOf(board.id)[0].set_by;
		const put = (user: ReturnType<typeof makeUser>, body: Record<string, unknown>) =>
			api('PUT', `/api/v1/webhooks/${hook.id}`, { user, body });

		// What an editor may change leaves the setter as it was.
		expect((await put(editor, { events: ['card.moved'], active: false })).status).toBe(200);
		expect(setter()).toBe(owner.id);
		// The address and the secret sent back unchanged change nothing, the setter included.
		expect((await put(admin, { url: 'https://hooks.example.test/x', secret: 's1' })).status).toBe(200);
		expect(setter()).toBe(owner.id);

		// An administrator who re-points somebody else's webhook is its setter.
		expect((await put(admin, { url: 'https://admins.example.test/x' })).status).toBe(200);
		expect(setter()).toBe(admin.id);
		// And the owner who sets a new secret is.
		expect((await put(owner, { secret: 's2' })).status).toBe(200);
		expect(setter()).toBe(owner.id);
		// Switching it on does (the review, S2): their reset is what switches it off again.
		expect((await put(admin, { active: true })).status).toBe(200);
		expect(setter()).toBe(admin.id);
		// On for one already on changes nothing.
		expect((await put(owner, { active: true })).status).toBe(200);
		expect(setter()).toBe(admin.id);
	});
});

describe('at most 10 webhooks a board (card 2201)', () => {
	const create = (boardId: number, user: ReturnType<typeof makeUser>, body: Record<string, unknown> = { url: 'https://hooks.example.test/x' }) =>
		api('POST', `/api/v1/boards/${boardId}/webhooks`, { user, body });
	const full = (n: number) => `This board has ${n} webhooks, and a board may have at most 10: delete ${n - 9} before adding another.`;

	it('makes ten, and refuses the eleventh with 409, writing nothing', async () => {
		const owner = makeUser();
		const { board } = makeBoard({ owner });

		for (let i = 0; i < 10; i++) expect((await create(board.id, owner)).status).toBe(201);
		const before = snapshotDb();
		const eleventh = await create(board.id, owner);

		expect(eleventh.status).toBe(409);
		expect(eleventh.body).toEqual({ message: 'This board has 10 webhooks, and a board may have at most 10: delete 1 before adding another.' });
		expectUnchanged(before);
	});

	it('counts the ones switched off', async () => {
		const owner = makeUser();
		const { board } = makeBoard({ owner });
		for (let i = 0; i < 10; i++) makeWebhook(board, { active: i % 2 === 0 });

		const res = await create(board.id, owner);

		expect(res.status).toBe(409);
		expect(rowsOf(board.id)).toHaveLength(10);
	});

	it('makes room when one is deleted', async () => {
		const owner = makeUser();
		const { board } = makeBoard({ owner });
		const hooks = Array.from({ length: 10 }, () => makeWebhook(board));

		expect((await api('DELETE', `/api/v1/webhooks/${hooks[3].id}`, { user: owner })).status).toBe(200);

		expect((await create(board.id, owner)).status).toBe(201);
		expect(rowsOf(board.id)).toHaveLength(10);
	});

	it('gives the tenth place to one of two creates sent together, and refuses the other', async () => {
		const owner = makeUser();
		const { board } = makeBoard({ owner });
		for (let i = 0; i < 9; i++) makeWebhook(board);

		const answers = await Promise.all([create(board.id, owner), create(board.id, owner)]);

		expect(answers.map((res) => res.status).sort()).toEqual([201, 409]);
		expect(rowsOf(board.id)).toHaveLength(10);
	});

	it('answers every other refusal first: no url, an address inside, a viewer, a board that is not there', async () => {
		const owner = makeUser();
		const viewer = makeUser();
		const { board } = makeBoard({ owner });
		addBoardMember(board, viewer, 'viewer');
		for (let i = 0; i < 10; i++) makeWebhook(board);

		const missing = await create(board.id, owner, {});
		const inside = await create(board.id, owner, { url: 'http://127.0.0.1/x' });
		const viewing = await create(board.id, viewer);
		const nowhere = await create(999_999, owner);

		expect([missing.status, missing.body.message]).toEqual([400, 'URL is required']);
		expect(inside.status).toBe(400);
		expect(viewing.status).toBe(403);
		expect(nowhere.status).toBe(404);
	});

	it('counts each board apart', async () => {
		const owner = makeUser();
		const { board: crowded } = makeBoard({ owner });
		const { board: empty } = makeBoard({ owner });
		for (let i = 0; i < 10; i++) makeWebhook(crowded);

		expect((await create(empty.id, owner)).status).toBe(201);
		expect((await create(crowded.id, owner)).status).toBe(409);
	});

	it('refuses a create on a board already over the cap, naming its count, and still sends every webhook of it', async () => {
		const owner = makeUser();
		const { board } = makeBoard({ owner });
		const hooks = Array.from({ length: 14 }, () => makeWebhook(board));

		const res = await create(board.id, owner);
		expect(res.status).toBe(409);
		expect(res.body.message).toBe(full(14));
		expect(res.body.message).toContain('delete 5 before');

		// A guard: the board keeps every delivery (decision 24).
		const sent = effects();
		try {
			dispatchWebhook(board.id, 'card.moved', { cardId: 1 });
			await sent.settle();
			expect(sent.webhooks.map((w) => w.url)).toEqual(hooks.map((h) => h.address));
		} finally {
			sent.restore();
		}
	});

	describe('the start-up line', () => {
		const startup = () =>
			(
				sqlite.prepare("SELECT level, message FROM system_logs WHERE context = 'STARTUP' ORDER BY id").all() as {
					level: string;
					message: string;
				}[]
			).map((row) => `${row.level} ${row.message}`);
		const fill = (n: number) => {
			const { board } = makeBoard({ owner: makeUser() });
			for (let i = 0; i < n; i++) makeWebhook(board, { url: `https://secret-path.example.test/${board.id}/${i}` });
			return board;
		};

		it('names each board over the cap, by id and count, and no address', () => {
			fill(10);
			const over = fill(14);

			expect(reportWebhooksOverCap()).toBe(true);

			expect(startup()).toEqual([
				`WARN 1 board(s) have more webhooks than the 10 a board may have: board ${over.id} has 14. All of them are still sent, ` +
					'and none can be added to such a board until it has fewer than 10.'
			]);
			expect(startup().join(' ')).not.toContain('secret-path');
		});

		it('says nothing when no board is over', () => {
			fill(10);
			expect(reportWebhooksOverCap()).toBe(false);
			expect(startup()).toEqual([]);
		});

		it('names the first 20 boards, and counts the rest', () => {
			const boards = Array.from({ length: 21 }, () => fill(11));

			expect(reportWebhooksOverCap()).toBe(true);

			const named = boards.slice(0, 20).map((b) => `board ${b.id} has 11`).join(', ');
			expect(startup()).toEqual([
				`WARN 21 board(s) have more webhooks than the 10 a board may have: ${named}, and 1 more. All of them are still sent, ` +
					'and none can be added to such a board until it has fewer than 10.'
			]);
		});
	});
});

describe('the same WARN about a webhook at most once an hour (the review, O2)', () => {
	const HOUR = 60 * 60 * 1000;
	const at = (ms: number) => vi.setSystemTime(new Date(Date.parse('2026-10-18T09:00:00Z') + ms));
	afterEach(() => vi.useRealTimers());

	it('writes the first refusal at once, then none for that webhook and reason for an hour, then says how many were not', () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		at(0);
		const { board } = makeBoard({ owner: makeUser() });
		const loopback = makeWebhook(board, { url: 'http://127.0.0.1/x' });
		const lan = makeWebhook(board, { url: 'http://10.0.0.1/x' });
		const said = (hook: Hook, why: string) => `Webhook ${hook.id} on board ${board.id} not sent: ${why}`;
		const LOOPBACK = said(loopback, '127.0.0.1 is a loopback address');
		const LAN = said(lan, '10.0.0.1 is a private network address');

		for (let i = 0; i < 3; i++) dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		// One for each webhook: the hour is kept for each.
		expect(lines('WARN')).toEqual([LOOPBACK, LAN]);

		at(HOUR - 1);
		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		expect(lines('WARN')).toEqual([LOOPBACK, LAN]);

		at(HOUR);
		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		const more = ' (3 more like this since the last such line were not logged)';
		expect(lines('WARN')).toEqual([LOOPBACK, LAN, LOOPBACK + more, LAN + more]);

		// Another address refused as written is the same kind, held to the same
		// hour; another kind of reason for the same webhook is a line of its own, at once.
		sqlite.prepare('UPDATE webhooks SET url = ? WHERE id = ?').run('http://127.0.0.2/x', loopback.id);
		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		expect(lines('WARN')).toHaveLength(4);
		storedAs(loopback, '{}');
		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		expect(lines('WARN')).toHaveLength(5);
		expect(lines('WARN')[4]).toBe(said(loopback, 'its events are not a list'));
	});

	it('writes one line for a name resolving to a different inside address each time, then the latest words with the count (the final review)', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		at(0);
		let asked = 0;
		(dns as unknown as { lookup: unknown }).lookup = (_name: string, _options: unknown, callback: (err: null, found: Answer[]) => void) => {
			asked++;
			const found = [v4(`127.0.0.${asked}`)];
			setImmediate(() => callback(null, found));
		};
		const { board } = makeBoard({ owner: makeUser() });
		const hook = makeWebhook(board, { url: 'http://moving.example.test/x' });
		const said = (n: number) => `Webhook ${hook.id} on board ${board.id} not sent: moving.example.test resolves to 127.0.0.${n}, a loopback address`;

		for (let i = 0; i < 5; i++) dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		await vi.waitFor(() => expect(asked).toBe(5));
		await aMoment();
		expect(lines('WARN')).toEqual([said(1)]);

		at(HOUR);
		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		await vi.waitFor(() => expect(lines('WARN')).toHaveLength(2));
		expect(lines('WARN')[1]).toBe(`${said(6)} (4 more like this since the last such line were not logged)`);
	});

	it(`remembers at most ${WARNINGS_REMEMBERED} webhooks within the hour, forgetting the oldest (the final review)`, () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		at(0);
		const { board } = makeBoard({ owner: makeUser() });
		// A plain row, on purpose (card 2928's code review, C8): the made-up rows below take other ids, and a sealed
		// address is bound to its own id, so each would not open; the plain branch reads the address as it is.
		const stored = makeWebhook(board, { url: 'http://127.0.0.1/x' });
		const first = { ...stored, url: stored.address };
		const others = (from: number, count: number) => {
			for (let i = 0; i < count; i++) deliver({ ...first, id: 1_000_000 + from + i }, 'card.created', '{}');
		};
		const written = () => (sqlite.prepare("SELECT COUNT(*) AS n FROM system_logs WHERE context = 'Webhooks' AND level = 'WARN'").get() as { n: number }).n;

		deliver(first, 'card.created', '{}');
		others(0, WARNINGS_REMEMBERED - 1);
		// Full, and the first still held.
		deliver(first, 'card.created', '{}');
		expect(written()).toBe(WARNINGS_REMEMBERED);

		// One more webhook forgets the oldest, the first, which is written again at once.
		others(WARNINGS_REMEMBERED, 1);
		deliver(first, 'card.created', '{}');
		expect(written()).toBe(WARNINGS_REMEMBERED + 2);
		// Forgotten with its count: it is written as a first line is.
		expect(lines('WARN').at(-1)).toBe(`Webhook ${first.id} on board ${board.id} not sent: 127.0.0.1 is a loopback address`);
	});

	it('holds a webhook whose events are not a list, and a redirect, to the same hour', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		at(0);
		process.env.WEBHOOK_ALLOW_INSIDE = '127.0.0.0/8';
		const server = await receiver((req, res) => {
			res.writeHead(307, { Location: '/elsewhere' });
			res.end();
		});
		const { board } = makeBoard({ owner: makeUser() });
		const redirected = makeWebhook(board, { url: `http://127.0.0.1:${server.port}/first` });
		const odd = storedAs(makeWebhook(board, { url: 'https://hooks.example.test/x' }), '{}');

		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		await vi.waitFor(() => expect(server.received).toHaveLength(2));
		await aMoment();

		expect(lines('WARN')).toEqual([
			`Webhook ${odd.id} on board ${board.id} not sent: its events are not a list`,
			`Webhook ${redirected.id} on board ${board.id}: 127.0.0.1:${server.port} answered 307, a redirect, which is not followed`
		]);
	});

	it('writes every delivery failure, which is an ERROR', async () => {
		process.env.WEBHOOK_ALLOW_INSIDE = '127.0.0.1';
		const port = await closedPort();
		const { board } = makeBoard({ owner: makeUser() });
		makeWebhook(board, { url: `http://127.0.0.1:${port}/x` });

		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		await vi.waitFor(() => expect(lines('ERROR')).toHaveLength(2));
	});
});

describe('at most 20 connections to one receiver at once (the review, O12)', () => {
	it('holds the 21st delivery back until a connection is free, and each is still a connection of its own', async () => {
		process.env.WEBHOOK_ALLOW_INSIDE = '127.0.0.1';
		// Never answers: each delivery holds its connection until its timeout.
		const server = await receiver(() => {});
		const { board } = makeBoard({ owner: makeUser() });
		const hook = makeWebhook(board, { url: `http://127.0.0.1:${server.port}/x` });

		for (let i = 0; i < 25; i++) deliver(hook, 'card.created', '{}', 500);
		await vi.waitFor(() => expect(server.received).toHaveLength(20));
		await aMoment();
		expect(server.connections).toBe(20);
		expect(server.received.every((r) => r.headers.connection === 'close')).toBe(true);

		// Each ends at its own timeout, the five held back included.
		await vi.waitFor(() => expect(lines('ERROR')).toHaveLength(25), { timeout: 3000 });
	});
});

describe('the start-up line of webhooks refused as written (the review, O1)', () => {
	const startup = () =>
		(
			sqlite.prepare("SELECT level, message FROM system_logs WHERE context = 'STARTUP' ORDER BY id").all() as {
				level: string;
				message: string;
			}[]
		).map((row) => `${row.level} ${row.message}`);
	const END =
		'. Each is refused at every event until its address is changed or it is switched off; one inside the network ' +
		'can instead be named in WEBHOOK_ALLOW_INSIDE.';

	it('names each webhook that is on and refused as written, by id, board and why, never the path, and looks no name up', () => {
		const looked = vi.fn();
		(dns as unknown as { lookup: unknown }).lookup = looked;
		const { board } = makeBoard({ owner: makeUser() });
		const loopback = makeWebhook(board, { url: 'http://127.0.0.1:8080/secret-path?token=t0k3n' });
		const credentials = makeWebhook(board, { url: 'https://u:p@hooks.example.test/secret-path' });
		const lan = makeWebhook(board, { url: 'http://n8n:5678/secret-path' });
		const notHttp = makeWebhook(board, { url: 'ftp://hooks.example.test/secret-path' });
		// Off, or a public name that might resolve anywhere: neither named.
		makeWebhook(board, { url: 'http://127.0.0.1/secret-path', active: false });
		makeWebhook(board, { url: 'https://hooks.example.test/secret-path' });

		expect(reportWebhooksRefused()).toBe(true);

		expect(startup()).toEqual([
			'WARN 4 webhook(s) that are on are not sent, whatever their names resolve to: ' +
				`webhook ${loopback.id} on board ${board.id} (127.0.0.1 is a loopback address); ` +
				`webhook ${credentials.id} on board ${board.id} (the address for hooks.example.test carries a user name or password); ` +
				`webhook ${lan.id} on board ${board.id} (n8n is a name with no dot, which is looked up inside the network); ` +
				`webhook ${notHttp.id} on board ${board.id} (its address is not an http or https address (ftp:))` +
				END
		]);
		expect(startup().join(' ')).not.toMatch(/secret-path|t0k3n/);
		expect(looked).not.toHaveBeenCalled();
	});

	it('says nothing when none is refused, an address let in by WEBHOOK_ALLOW_INSIDE included', () => {
		process.env.WEBHOOK_ALLOW_INSIDE = 'n8n';
		const { board } = makeBoard({ owner: makeUser() });
		makeWebhook(board, { url: 'http://n8n:5678/x' });
		makeWebhook(board, { url: 'https://hooks.example.test/x' });

		expect(reportWebhooksRefused()).toBe(false);
		expect(startup()).toEqual([]);
	});

	it('names the first 20, and counts the rest', () => {
		const hooks = Array.from({ length: 21 }, () => makeWebhook(makeBoard({ owner: makeUser() }).board, { url: 'http://10.0.0.1/x' }));

		expect(reportWebhooksRefused()).toBe(true);

		const named = hooks
			.slice(0, 20)
			.map((h) => `webhook ${h.id} on board ${h.boardId} (10.0.0.1 is a private network address)`)
			.join('; ');
		expect(startup()).toEqual([`WARN 21 webhook(s) that are on are not sent, whatever their names resolve to: ${named}; and 1 more${END}`]);
	});
});

// ─── Card 2178 ───────────────────────────────────────────────────────────

describe("a webhook's last delivery result (card 2178)", () => {
	const UNREACHED = (seconds: number) => `The receiver could not be reached, or did not answer within ${seconds} seconds`;

	/** A board, and its owner, to read the webhook's answer as. */
	function ownersBoard() {
		const owner = makeUser();
		return { owner, board: makeBoard({ owner }).board };
	}

	/** `lastDelivery` as the owner's GET of the webhook answers it. */
	async function lastDelivery(hook: Hook, owner: ReturnType<typeof makeUser>) {
		const res = await api('GET', `/api/v1/webhooks/${hook.id}`, { user: owner });
		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('lastDelivery');
		return res.body.lastDelivery;
	}

	/** Once a result is held for the webhook. */
	const settled = (hook: Hook) => vi.waitFor(() => expect(deliveryResultFor(hook)).not.toBeNull(), { timeout: 5000 });

	it('gives the owner the status a receiver answered, with the moment the event was dispatched (W1)', async () => {
		process.env.WEBHOOK_ALLOW_INSIDE = '127.0.0.1';
		const server = await receiver((req, res) => {
			res.statusCode = 500;
			res.end('broken');
		});
		const { owner, board } = ownersBoard();
		const hook = makeWebhook(board, { url: `http://127.0.0.1:${server.port}/` });

		dispatchWebhook(board.id, 'card.moved', { cardId: 1 });
		await settled(hook);

		expect(await lastDelivery(hook, owner)).toEqual({
			at: JSON.parse(server.received[0].body).timestamp,
			event: 'card.moved',
			outcome: 'answered',
			status: 500,
			reason: 'The receiver answered 500'
		});
	});

	it('is null before any delivery since the server started', async () => {
		const { owner, board } = ownersBoard();
		const hook = makeWebhook(board);
		expect(await lastDelivery(hook, owner)).toBeNull();
	});

	it('calls a 2xx delivered (W2)', async () => {
		process.env.WEBHOOK_ALLOW_INSIDE = '127.0.0.1';
		const server = await receiver((req, res) => {
			res.statusCode = 204;
			res.end();
		});
		const { board } = ownersBoard();
		const hook = makeWebhook(board, { url: `http://127.0.0.1:${server.port}/` });

		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		await settled(hook);
		expect(deliveryResultFor(hook)).toMatchObject({ outcome: 'delivered', status: 204, reason: 'The receiver answered 204' });
	});

	it('reads a closed port as not reached, and a name that is not found as such (W3)', async () => {
		process.env.WEBHOOK_ALLOW_INSIDE = '127.0.0.1';
		answerLookups({});
		const port = await closedPort();
		const { board } = ownersBoard();
		const closed = makeWebhook(board, { url: `http://127.0.0.1:${port}/` });
		const nowhere = makeWebhook(board, { url: 'https://nowhere.example.test/x' });

		// A not-reached result waits out the timeout: a short one here.
		deliver(closed, 'card.created', '{}', 300);
		deliver(nowhere, 'card.created', '{}', 300);
		await settled(closed);
		await settled(nowhere);

		expect(deliveryResultFor(closed)).toMatchObject({ outcome: 'no-answer', status: null, reason: UNREACHED(0.3) });
		expect(deliveryResultFor(nowhere)).toMatchObject({
			outcome: 'no-answer',
			status: null,
			reason: "The receiver's host name could not be found"
		});
	});

	it('reads a receiver that sends no status in time as a closed port reads, and keeps a status that came before a body held open (W4)', async () => {
		process.env.WEBHOOK_ALLOW_INSIDE = '127.0.0.1';
		const silent = await receiver(() => {});
		const slowBody = await receiver((req, res) => {
			res.writeHead(200, { 'Content-Type': 'text/plain' });
			res.write('still ');
		});
		const { board } = ownersBoard();
		const quiet = makeWebhook(board, { url: `http://127.0.0.1:${silent.port}/` });
		const answered = makeWebhook(board, { url: `http://127.0.0.1:${slowBody.port}/` });

		deliver(quiet, 'card.created', '{}', 200);
		deliver(answered, 'card.created', '{}', 200);
		await settled(quiet);
		await settled(answered);
		// Past the timeout of the one that answered.
		await new Promise((resolve) => setTimeout(resolve, 400));

		expect(deliveryResultFor(quiet)).toMatchObject({ outcome: 'no-answer', status: null, reason: UNREACHED(0.2) });
		expect(deliveryResultFor(answered)).toMatchObject({ outcome: 'delivered', status: 200, reason: 'The receiver answered 200' });
	});

	it('says an address inside the network was not sent to, as written or as resolved, and never which address (W5)', async () => {
		const server = await receiver();
		answerLookups({ 'lan.example.test': [v4('10.0.0.5')] });
		const { owner, board } = ownersBoard();
		const written = makeWebhook(board, { url: `http://127.0.0.1:${server.port}/` });
		const resolved = makeWebhook(board, { url: `http://lan.example.test:${server.port}/` });

		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		await settled(written);
		await settled(resolved);

		for (const hook of [written, resolved]) {
			const result = await lastDelivery(hook, owner);
			expect(result).toMatchObject({ outcome: 'not-sent', status: null, reason: 'Not sent: the address is inside the network' });
			expect(JSON.stringify(result)).not.toMatch(/127\.0\.0\.1|10\.0\.0\.5/);
		}
		expect(server.connections).toBe(0);
	});

	it('says a webhook whose events are not a list was not sent (W6)', () => {
		const { board } = ownersBoard();
		const hook = storedAs(makeWebhook(board), 'null');

		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		expect(deliveryResultFor(hook)).toMatchObject({ outcome: 'not-sent', status: null, reason: 'Not sent: its events are not a list' });
	});

	it('says an address with credentials, one that is not http or https, and one that is not an address were not sent', () => {
		const { board } = ownersBoard();
		const credentials = makeWebhook(board, { url: 'https://u:p@hooks.example.test/x' });
		const ftp = makeWebhook(board, { url: 'ftp://hooks.example.test/x' });
		const notAUrl = makeWebhook(board, { url: 'not an address' });

		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		expect(deliveryResultFor(credentials)?.reason).toBe('Not sent: the address carries a user name or password');
		expect(deliveryResultFor(ftp)?.reason).toBe('Not sent: the address is not an http or https address');
		expect(deliveryResultFor(notAUrl)?.reason).toBe('Not sent: the address is not an http or https address');
	});

	it('records nothing for an event the webhook does not ask for, or a webhook switched off', () => {
		const { board } = ownersBoard();
		const other = makeWebhook(board, { url: 'http://127.0.0.1/x', events: ['card.moved'] });
		const off = makeWebhook(board, { url: 'http://127.0.0.1/y', active: false });

		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		expect(deliveryResultFor(other)).toBeNull();
		expect(deliveryResultFor(off)).toBeNull();
	});

	it('says a redirect was answered, and not followed (W7)', async () => {
		process.env.WEBHOOK_ALLOW_INSIDE = '127.0.0.1';
		const server = await receiver((req, res) => {
			res.writeHead(307, { Location: '/elsewhere' });
			res.end();
		});
		const { board } = ownersBoard();
		const hook = makeWebhook(board, { url: `http://127.0.0.1:${server.port}/` });

		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		await settled(hook);
		expect(deliveryResultFor(hook)).toMatchObject({
			outcome: 'answered',
			status: 307,
			reason: 'The receiver answered 307, a redirect, which is not followed'
		});
	});

	it('records each webhook of a board, a failing one not stopping the next (W8)', async () => {
		process.env.WEBHOOK_ALLOW_INSIDE = '127.0.0.1';
		// A name not found fails at once; a closed port's result would wait out the 10 s.
		answerLookups({});
		const server = await receiver();
		const { board } = ownersBoard();
		const failing = makeWebhook(board, { url: 'http://nowhere.example.test/' });
		const working = makeWebhook(board, { url: `http://127.0.0.1:${server.port}/` });

		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		await settled(failing);
		await settled(working);
		expect(deliveryResultFor(failing)).toMatchObject({ outcome: 'no-answer' });
		expect(deliveryResultFor(working)).toMatchObject({ outcome: 'delivered', status: 200 });
	});

	it('holds no part of the address, its path or query, or the secret (W9)', async () => {
		process.env.WEBHOOK_ALLOW_INSIDE = '127.0.0.1';
		const server = await receiver((req, res) => {
			res.statusCode = 401;
			res.end('bad signature');
		});
		const { owner, board } = ownersBoard();
		const hook = makeWebhook(board, { url: `http://127.0.0.1:${server.port}/T000/B000/XXXX?token=abc`, secret: 's3cr3t' });

		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		await settled(hook);
		const result = await lastDelivery(hook, owner);
		expect(result).toMatchObject({ outcome: 'answered', status: 401 });
		const text = JSON.stringify(result);
		for (const part of ['T000', 'XXXX', 'token', 'abc', 's3cr3t', '127.0.0.1', String(server.port)]) expect(text).not.toContain(part);
	});

	it("keeps the newer dispatch's result though the older answers last, both in one millisecond (W10)", async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-10-19T09:00:00.000Z'));
		try {
			process.env.WEBHOOK_ALLOW_INSIDE = '127.0.0.1';
			let n = 0;
			let older: http.ServerResponse | undefined;
			const server = await receiver((req, res) => {
				// The first is held, and answered 200 after the second, which is answered 500 at once.
				if (++n === 1) older = res;
				else {
					res.statusCode = 500;
					res.end();
				}
			});
			const { board } = ownersBoard();
			const hook = makeWebhook(board, { url: `http://127.0.0.1:${server.port}/` });

			dispatchWebhook(board.id, 'card.created', { cardId: 1 });
			dispatchWebhook(board.id, 'card.moved', { cardId: 1 });
			await vi.waitFor(() => expect(deliveryResultFor(hook)).toMatchObject({ status: 500 }));
			await vi.waitFor(() => expect(older).toBeDefined());
			await new Promise((resolve) => setTimeout(resolve, 300));
			older!.end('ok');
			await new Promise((resolve) => setTimeout(resolve, 100));

			const [first, second] = server.received.map((r) => JSON.parse(r.body));
			expect(first.timestamp).toBe(second.timestamp);
			expect(deliveryResultFor(hook)).toMatchObject({ event: 'card.moved', outcome: 'answered', status: 500 });
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps the newer dispatch's result when the clock is set back between them (W16)", () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			const { board } = ownersBoard();
			// Refused as written: each result is held at once, in the order dispatched.
			const hook = makeWebhook(board, { url: 'http://127.0.0.1/x' });

			vi.setSystemTime(new Date('2026-10-19T09:00:00.000Z'));
			dispatchWebhook(board.id, 'card.created', { cardId: 1 });
			vi.setSystemTime(new Date('2026-10-19T08:00:00.000Z'));
			dispatchWebhook(board.id, 'card.moved', { cardId: 1 });

			expect(deliveryResultFor(hook)).toMatchObject({ at: '2026-10-19T08:00:00.000Z', event: 'card.moved' });
		} finally {
			vi.useRealTimers();
		}
	});

	it('answers null once the owner changes the address, until the next delivery (W11)', async () => {
		answerLookups({});
		const { owner, board } = ownersBoard();
		const hook = makeWebhook(board, { url: 'http://127.0.0.1/x' });
		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		expect(await lastDelivery(hook, owner)).toMatchObject({ outcome: 'not-sent' });

		const changed = await api('PUT', `/api/v1/webhooks/${hook.id}`, { user: owner, body: { url: 'https://gone.example.test/x' } });
		expect(changed.status).toBe(200);
		expect(changed.body.lastDelivery).toBeNull();
		expect(await lastDelivery(hook, owner)).toBeNull();

		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		const notFound = { outcome: 'no-answer', reason: "The receiver's host name could not be found" };
		await vi.waitFor(async () => expect(await lastDelivery(hook, owner)).toMatchObject(notFound));
		// A change of the secret or the events keeps it.
		const other = await api('PUT', `/api/v1/webhooks/${hook.id}`, { user: owner, body: { secret: 'new', events: ['card.created'] } });
		expect(other.status).toBe(200);
		expect(other.body.lastDelivery).toMatchObject(notFound);
	});

	it('forgets a deleted webhook, and gives a row that reuses its id for another address nothing (W12)', async () => {
		const { owner, board } = ownersBoard();
		const hook = makeWebhook(board, { url: 'http://127.0.0.1/x' });
		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		expect(deliveryResultFor(hook)).not.toBeNull();

		expect((await api('DELETE', `/api/v1/webhooks/${hook.id}`, { user: owner })).status).toBe(200);
		// Asked of the row as it was: the result itself is gone.
		expect(deliveryResultFor(hook)).toBeNull();

		// Taken out with no route, as a restore or a reset would, and the id written again for another address.
		const again = makeWebhook(board, { url: 'http://127.0.0.1/y' });
		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		expect(deliveryResultFor(again)).not.toBeNull();
		sqlite.prepare('DELETE FROM webhooks WHERE id = ?').run(again.id);
		sqlite
			.prepare("INSERT INTO webhooks (id, board_id, url, events, created_at) VALUES (?, ?, 'https://elsewhere.example.test/z', '[]', ?)")
			.run(again.id, board.id, again.createdAt);
		expect(await lastDelivery(again, owner)).toBeNull();
	});

	it('writes nothing to the database: the result is held in memory (W13)', async () => {
		process.env.WEBHOOK_ALLOW_INSIDE = '127.0.0.1';
		let release: (() => void) | undefined;
		const server = await receiver((req, res) => {
			release = () => {
				res.statusCode = 500;
				res.end();
			};
		});
		const { board } = ownersBoard();
		const hook = makeWebhook(board, { url: `http://127.0.0.1:${server.port}/` });

		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		await vi.waitFor(() => expect(release).toBeDefined());
		const before = snapshotDb();
		release!();
		await settled(hook);

		expect(deliveryResultFor(hook)).toMatchObject({ status: 500 });
		expectUnchanged(before, 'after the delivery settled');
	});

	it('reads something that does not speak HTTP as not reached, and gives no parser code (W15)', async () => {
		process.env.WEBHOOK_ALLOW_INSIDE = '127.0.0.1';
		const sockets: net.Socket[] = [];
		const banner = net.createServer((socket) => {
			sockets.push(socket);
			socket.end('SSH-2.0-probe\r\n');
		});
		await new Promise<void>((resolve) => banner.listen(0, resolve));
		try {
			const { port } = banner.address() as AddressInfo;
			const { owner, board } = ownersBoard();
			const hook = makeWebhook(board, { url: `http://127.0.0.1:${port}/` });

			deliver(hook, 'card.created', '{}', 300);
			await settled(hook);

			const result = await lastDelivery(hook, owner);
			expect(result).toMatchObject({ outcome: 'no-answer', status: null, reason: UNREACHED(0.3) });
			expect(JSON.stringify(result)).not.toContain('HPE_');
			// The log keeps the error, for administrators.
			expect(lines('ERROR')).toHaveLength(1);
		} finally {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => banner.close(() => resolve()));
		}
	});

	it('reads https to a listener that does not speak TLS as not reached, not as a certificate', async () => {
		process.env.WEBHOOK_ALLOW_INSIDE = '127.0.0.1';
		const server = await receiver();
		const { board } = ownersBoard();
		const hook = makeWebhook(board, { url: `https://127.0.0.1:${server.port}/` });

		deliver(hook, 'card.created', '{}', 300);
		await settled(hook);
		expect(deliveryResultFor(hook)).toMatchObject({ outcome: 'no-answer', reason: UNREACHED(0.3) });
	});

	it('times a delivery from its connection, not from a wait behind the 20 others (the review, 1)', async () => {
		process.env.WEBHOOK_ALLOW_INSIDE = '127.0.0.1';
		// Each answered in 400 ms, inside the 600 ms timeout; the 21st waits about
		// 400 ms for a connection first, which is not counted.
		const server = await receiver((req, res) => {
			setTimeout(() => res.end('ok'), 400);
		});
		// A board of its own each, as a board has at most ten.
		const hooks = Array.from({ length: 21 }, (_, i) => makeWebhook(ownersBoard().board, { url: `http://127.0.0.1:${server.port}/${i}` }));

		for (const hook of hooks) deliver(hook, 'card.created', '{}', 600);
		await vi.waitFor(() => expect(hooks.every((hook) => deliveryResultFor(hook) !== null)).toBe(true), { timeout: 5000 });

		expect(hooks.map((hook) => deliveryResultFor(hook)?.outcome)).toEqual(hooks.map(() => 'delivered'));
		expect(server.connections).toBe(21);
	});

	it('records a port that refuses at once no sooner than the timeout, as one that never answers is (the review, 2)', async () => {
		process.env.WEBHOOK_ALLOW_INSIDE = '127.0.0.1';
		const port = await closedPort();
		const silent = await receiver(() => {});
		const { board } = ownersBoard();
		const refused = makeWebhook(board, { url: `http://127.0.0.1:${port}/` });
		const dropped = makeWebhook(board, { url: `http://127.0.0.1:${silent.port}/` });

		const from = performance.now();
		deliver(refused, 'card.created', '{}', 500);
		deliver(dropped, 'card.created', '{}', 500);
		// The refusal is logged at once, and its result is not yet held.
		await vi.waitFor(() => expect(lines('ERROR')).toHaveLength(1));
		expect(deliveryResultFor(refused)).toBeNull();

		await settled(refused);
		const refusedAfter = performance.now() - from;
		await settled(dropped);
		// A timer may run a millisecond or so before its time.
		expect(refusedAfter).toBeGreaterThanOrEqual(490);
		// The same words, the moment of each dispatch apart.
		const { at: _refusedAt, ...refusedSaid } = deliveryResultFor(refused)!;
		const { at: _droppedAt, ...droppedSaid } = deliveryResultFor(dropped)!;
		expect(refusedSaid).toEqual(droppedSaid);
		expect(refusedSaid).toMatchObject({ outcome: 'no-answer', status: null, reason: UNREACHED(0.5) });
	});

	it('does not hold a result still on its way when every result is forgotten, as a restart forgets it', async () => {
		process.env.WEBHOOK_ALLOW_INSIDE = '127.0.0.1';
		const port = await closedPort();
		const { board } = ownersBoard();
		const hook = makeWebhook(board, { url: `http://127.0.0.1:${port}/` });

		deliver(hook, 'card.created', '{}', 200);
		await vi.waitFor(() => expect(lines('ERROR')).toHaveLength(1));
		forgetDeliveries();
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(deliveryResultFor(hook)).toBeNull();
	});

	it('reads a 101 answer, which closes with no response and no error, as not reached (the review, 3)', async () => {
		process.env.WEBHOOK_ALLOW_INSIDE = '127.0.0.1';
		const server = await receiver((req, res) => {
			res.socket?.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: probe\r\n\r\n');
		});
		const { board } = ownersBoard();
		const hook = makeWebhook(board, { url: `http://127.0.0.1:${server.port}/` });

		deliver(hook, 'card.created', '{}', 300);
		await settled(hook);
		expect(deliveryResultFor(hook)).toMatchObject({ outcome: 'no-answer', status: null, reason: UNREACHED(0.3) });
		expect(lines('ERROR')).toEqual([
			`Webhook ${hook.id} on board ${board.id}: delivery to 127.0.0.1:${server.port} failed: the connection closed with no status`
		]);
	});

	it('replaces a 500 with the 2xx that follows it (the review, 4)', async () => {
		process.env.WEBHOOK_ALLOW_INSIDE = '127.0.0.1';
		let n = 0;
		const server = await receiver((req, res) => {
			res.statusCode = ++n === 1 ? 500 : 200;
			res.end();
		});
		const { owner, board } = ownersBoard();
		const hook = makeWebhook(board, { url: `http://127.0.0.1:${server.port}/` });

		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		await vi.waitFor(() => expect(deliveryResultFor(hook)).toMatchObject({ status: 500 }));
		dispatchWebhook(board.id, 'card.moved', { cardId: 1 });
		await vi.waitFor(() => expect(deliveryResultFor(hook)).toMatchObject({ status: 200 }));

		expect(await lastDelivery(hook, owner)).toMatchObject({ event: 'card.moved', outcome: 'delivered', status: 200 });
	});

	it('updates the result while the hourly WARN is held (the review, 4)', async () => {
		process.env.WEBHOOK_ALLOW_INSIDE = '127.0.0.1';
		let n = 0;
		const server = await receiver((req, res) => {
			res.writeHead(++n === 1 ? 307 : 308, { Location: '/elsewhere' });
			res.end();
		});
		const { board } = ownersBoard();
		const hook = makeWebhook(board, { url: `http://127.0.0.1:${server.port}/` });

		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		await vi.waitFor(() => expect(deliveryResultFor(hook)).toMatchObject({ status: 307 }));
		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		await vi.waitFor(() => expect(deliveryResultFor(hook)).toMatchObject({ status: 308 }));

		expect(lines('WARN')).toEqual([
			`Webhook ${hook.id} on board ${board.id}: 127.0.0.1:${server.port} answered 307, a redirect, which is not followed`
		]);
		expect(deliveryResultFor(hook)?.reason).toBe('The receiver answered 308, a redirect, which is not followed');
	});
});

// ─── Card 2278 ───────────────────────────────────────────────────────────

describe('which action sends which event, and what each move sends (card 2278)', () => {
	let sent: Effects;
	beforeEach(() => {
		sent = effects();
	});
	afterEach(() => sent.restore());

	// Card 2689 (L1): the webhook names every event, since an empty list hears no decision event (R6), and every entry
	// carries a decision's projection, since a decision event is sent from it alone (R10): only the map decides.
	it('sends each action its event, and every other action none, by either spelling: the whole map', async () => {
		const owner = makeUser();
		const { board } = makeBoard({ owner });
		makeWebhook(board, { events: [...WEBHOOK_EVENTS] });
		const decision = makeDecision({ board, author: owner, decider: owner, status: 'open' });
		const projection = { id: decision.id, title: decision.title, status: 'open' as const, supersededById: decision.id };

		const heard: Record<string, string | null> = {};
		for (const action of Object.values(ACTIONS)) {
			for (const spelling of [action, `api:${action}`]) {
				sent.clear();
				logActivity({ boardId: board.id, action: spelling, detail: spelling, decision: projection });
				await sent.settle();
				const events = sent.webhooks.map((w) => w.event);
				expect(events.length, spelling).toBeLessThanOrEqual(1);
				if (spelling === action) heard[action] = events[0] ?? null;
				else expect(events[0] ?? null, spelling).toBe(heard[action]);
			}
		}

		expect(heard).toEqual({
			card_created: 'card.created',
			card_updated: 'card.updated',
			card_moved: 'card.moved',
			// A move to another board, on each board's own entry (card 2278).
			card_moved_away: 'card.moved',
			card_moved_in: 'card.moved',
			// A move into Complete is a completion, instead of a move.
			card_completed: 'card.completed',
			// A move out of Complete is a move (card 2278).
			card_reopened: 'card.moved',
			// Across the commitment point (milestone 22, card 2460): out of an upstream column is its own
			// event, as a completion is; back into one is a move.
			card_committed: 'card.committed',
			card_returned_to_options: 'card.moved',
			// An option sent to another board, on the board it left, in place of card_moved_away (card 2463, ruling b).
			card_sent: 'card.moved',
			card_deleted: 'card.deleted',
			card_archived: null,
			// An option dropped, archived or deleted from upstream, is its own event (milestone 22, card 2461);
			// committed work archived unfinished sends none, as an archive does not (ruling f).
			card_discarded: 'card.discarded',
			card_abandoned: null,
			card_restored: null,
			cards_purged: null,
			cards_cleared: null,
			column_deleted: null,
			// One entry for a column made the Options column, cards and all (milestone 22, ruling i): no event.
			column_converted_to_options: null,
			// And one for a board made an ideas board, cards and all (card 2463, ruling i): no event.
			board_converted_to_ideas: null,
			subtask_created: null,
			subtask_updated: null,
			subtask_completed: null,
			subtask_deleted: null,
			comment_added: 'comment.added',
			comment_edited: null,
			// No `comment.deleted`: a new event would reach every webhook that asks for all (card 2283, decision 8).
			comment_deleted: null,
			// No `attachment.*` event (card 2337, decision 14): a new event would reach every webhook that asks for all, and a receiver could not fetch the file.
			attachment_added: null,
			attachment_deleted: null,
			// An image moved to the trash by retention (card 2754): DumpFire's own entry, no event.
			attachment_expired: null,
			assignee_added: null,
			assignee_removed: null,
			dependency_added: null,
			dependency_removed: null,
			board_created: null,
			board_updated: null,
			milestone_created: null,
			// No event for the goal itself (card 2289, decision 9; card 2343, ruling 1): its entries name no card, and a new event would reach every webhook that asks for all.
			milestone_updated: null,
			milestone_closed: null,
			milestone_reopened: null,
			milestone_deleted: null,
			// A card put in a goal or taken out (card 2343).
			milestone_card_added: 'milestone.card_added',
			milestone_card_removed: 'milestone.card_removed',
			// A decision's lifecycle (card 2675, decision 22; card 2689, R1): opened and withdrawn send their decision events;
			// a re-publish, a close, an extension and a delete none.
			decision_opened: 'decision.opened',
			decision_republished: null,
			decision_closed: null,
			decision_extended: null,
			decision_withdrawn: 'decision.withdrawn',
			decision_deleted: null,
			// Card 2679 (decision 17; card 2689, R1, R2): the ruling and the old decision superseded; a release of results none.
			decision_ruled: 'decision.ruled',
			decision_superseded: 'decision.superseded',
			decision_results_released: null,
			// Card 2680 (decision 22): none; on the card's board, whose readers may not view the decision (card 2689, R4).
			decision_card_linked: null,
			decision_card_unlinked: null,
			decision_card_link_deleted: null,
			// Card 2687 (R7): a link's relation changed, on the decision's board with no card; none.
			decision_card_relation_changed: null
		});
	});

	/**
	 * Two boards of one owner, named so that either name can be looked for. A's
	 * webhook `a` asks for every event, and `a-completions` for `card.completed`
	 * alone; B's webhook `b` asks for every event.
	 */
	const twoBoards = () => {
		const owner = makeUser({ username: 'owner' });
		const A = makeBoard({ owner, name: 'ALPHA-SECRET' });
		const B = makeBoard({ owner, name: 'BRAVO-SECRET' });
		makeWebhook(A.board, { url: 'https://hooks.example.test/a' });
		makeWebhook(A.board, { url: 'https://hooks.example.test/a-completions', events: ['card.completed'] });
		makeWebhook(B.board, { url: 'https://hooks.example.test/b' });
		return { owner, A, B };
	};
	type Move = (user: SessionUser, cardId: number, columnId: number) => Promise<ApiResult>;
	const routes: [string, Move][] = [
		['PUT /api/cards/reorder', (user, id, columnId) => api('PUT', '/api/cards/reorder', { user, body: { updates: [{ id, columnId, position: 0 }] } })],
		['PUT /api/cards/:id', (user, id, columnId) => api('PUT', `/api/cards/${id}`, { user, body: { columnId } })],
		['PUT /api/v1/cards/:id/move', (user, id, columnId) => api('PUT', `/api/v1/cards/${id}/move`, { user, body: { columnId } })]
	];
	// The drag refuses a move to another board.
	const acrossBoards = routes.slice(1);

	/**
	 * Make the move, and answer each delivery as [webhook, event, data.action,
	 * data.detail], checking on the way that each went to its own board's
	 * webhook, named its own board's id, and named neither board.
	 */
	async function deliveries(w: ReturnType<typeof twoBoards>, move: () => Promise<ApiResult>) {
		const res = await move();
		await sent.settle();
		expect(res.status).toBe(200);
		expect(sent.duringTransaction).toEqual([]);
		const text = JSON.stringify(sent.webhooks.map((d) => d.body));
		expect(text).not.toContain('ALPHA-SECRET');
		expect(text).not.toContain('BRAVO-SECRET');
		return sent.webhooks.map((d) => {
			const hook = d.url.split('/').pop()!;
			expect(d.body.boardId, hook).toBe(hook === 'b' ? w.B.board.id : w.A.board.id);
			expect(d.body.event).toBe(d.event);
			return [hook, d.event, d.body.data.action, d.body.data.detail];
		});
	}

	it.each(routes)('%s: a reopening sends card.moved to the board, as card_reopened', async (_route, move) => {
		const w = twoBoards();
		const card = makeCard(w.A.cols['Complete'], { title: 'Reopened' });

		expect(await deliveries(w, () => move(w.owner, card.id, w.A.cols['In Progress'].id))).toEqual([
			['a', 'card.moved', 'card_reopened', '"Reopened": Complete → In Progress']
		]);
	});

	it.each(routes)('%s: a completion sends card.completed instead of card.moved (a guard)', async (_route, move) => {
		const w = twoBoards();
		const card = makeCard(w.A.cols['In Progress'], { title: 'Finished' });

		expect(await deliveries(w, () => move(w.owner, card.id, w.A.cols['Complete'].id))).toEqual([
			['a', 'card.completed', 'card_completed', '"Finished": In Progress → Complete'],
			['a-completions', 'card.completed', 'card_completed', '"Finished": In Progress → Complete']
		]);
	});

	it.each(acrossBoards)('%s: a move to another board sends card.moved to each board, with its own entry', async (_route, move) => {
		const w = twoBoards();
		const card = makeCard(w.A.cols['To Do'], { title: 'Moving' });

		expect(await deliveries(w, () => move(w.owner, card.id, w.B.cols['In Progress'].id))).toEqual([
			['a', 'card.moved', 'card_moved_away', '"Moving" moved to another board (To Do → In Progress)'],
			['b', 'card.moved', 'card_moved_in', '"Moving" moved from another board (To Do → In Progress)']
		]);
	});

	it.each(acrossBoards)("%s: into the other board's Complete, the joined board hears the arrival and the completion", async (_route, move) => {
		const w = twoBoards();
		const card = makeCard(w.A.cols['In Progress'], { title: 'Moving' });

		expect(await deliveries(w, () => move(w.owner, card.id, w.B.cols['Complete'].id))).toEqual([
			['a', 'card.moved', 'card_moved_away', '"Moving" moved to another board (In Progress → Complete)'],
			['b', 'card.moved', 'card_moved_in', '"Moving" moved from another board (In Progress → Complete)'],
			['b', 'card.completed', 'card_completed', '"Moving": In Progress → Complete']
		]);
	});

	it('PUT /api/cards/:id: a move to another board with a new title tells the board left the old title only (a guard)', async () => {
		const w = twoBoards();
		const card = makeCard(w.A.cols['To Do'], { title: 'Old title' });

		const heard = await deliveries(w, () =>
			api('PUT', `/api/cards/${card.id}`, { user: w.owner, body: { columnId: w.B.cols['To Do'].id, title: 'New title' } })
		);

		expect(heard.map(([hook, event, action]) => [hook, event, action])).toEqual([
			['a', 'card.moved', 'card_moved_away'],
			['b', 'card.moved', 'card_moved_in'],
			['b', 'card.updated', 'card_updated']
		]);
		expect(heard[0][3]).toBe('"Old title" moved to another board (To Do → To Do)');
		expect(heard[1][3]).toBe('"Old title" moved from another board (To Do → To Do)');
		expect(heard[2][3]).toContain('"New title"');
		// The board the card left is never told the name it took on the other.
		expect(JSON.stringify(sent.webhooks.filter((d) => d.body.boardId === w.A.board.id))).not.toContain('New title');
	});

	it.each(acrossBoards)("%s: out of Complete into the other board's To Do, the joined board hears the arrival and the reopening", async (_route, move) => {
		const w = twoBoards();
		const card = makeCard(w.A.cols['Complete'], { title: 'Moving' });

		expect(await deliveries(w, () => move(w.owner, card.id, w.B.cols['To Do'].id))).toEqual([
			['a', 'card.moved', 'card_moved_away', '"Moving" moved to another board (Complete → To Do)'],
			['b', 'card.moved', 'card_moved_in', '"Moving" moved from another board (Complete → To Do)'],
			['b', 'card.moved', 'card_reopened', '"Moving": Complete → To Do']
		]);
	});

	// ─── Across the commitment point (milestone 22, card 2460) ───────────────

	/** As `twoBoards`, with an Options column "Ideas" at the far left of A; B an ideas board when `ideasBoard`. */
	const withOptions = (opts: { ideasBoard?: boolean } = {}) => {
		const w = twoBoards();
		const ideas = db.insert(columns).values({ boardId: w.A.board.id, title: 'Ideas', position: -1, role: 'options' }).returning().get();
		if (opts.ideasBoard) db.update(boards).set({ kind: 'ideas' }).where(eq(boards.id, w.B.board.id)).run();
		return { ...w, ideas };
	};

	it.each(routes)('%s: out of the Options column sends card.committed, as card_committed, and no card.moved', async (_route, move) => {
		const w = withOptions();
		const card = makeCard(w.ideas, { title: 'Chosen' });

		expect(await deliveries(w, () => move(w.owner, card.id, w.A.cols['To Do'].id))).toEqual([
			['a', 'card.committed', 'card_committed', `"Chosen": Ideas → To Do (column ${w.A.cols['To Do'].id}, from column ${w.ideas.id})`]
		]);
	});

	it.each(routes)('%s: back into the Options column sends card.moved, as card_returned_to_options', async (_route, move) => {
		const w = withOptions();
		const card = makeCard(w.A.cols['To Do'], { title: 'Put back' });

		expect(await deliveries(w, () => move(w.owner, card.id, w.ideas.id))).toEqual([
			['a', 'card.moved', 'card_returned_to_options', '"Put back": To Do → Ideas']
		]);
	});

	it.each(routes)('%s: from Complete back into the Options column sends one card.moved, from the return, and none from the reopening (ruling q)', async (_route, move) => {
		const w = withOptions();
		const card = makeCard(w.A.cols['Complete'], { title: 'Not needed', completedAt: '2026-10-01 09:00:00' });

		expect(await deliveries(w, () => move(w.owner, card.id, w.ideas.id))).toEqual([
			['a', 'card.moved', 'card_returned_to_options', '"Not needed": Complete → Ideas']
		]);
		// The reopening is still recorded: it sends nothing.
		const written = db.select().from(activityLog).where(eq(activityLog.cardId, card.id)).orderBy(activityLog.id).all();
		expect(written.map((e) => e.action.replace('api:', ''))).toEqual(['card_reopened', 'card_returned_to_options']);
	});

	it.each(routes)('%s: from the Options column straight into Complete sends card.committed and then card.completed', async (_route, move) => {
		const w = withOptions();
		const card = makeCard(w.ideas, { title: 'Done at once' });

		expect(await deliveries(w, () => move(w.owner, card.id, w.A.cols['Complete'].id))).toEqual([
			['a', 'card.committed', 'card_committed', `"Done at once": Ideas → Complete (column ${w.A.cols['Complete'].id}, from column ${w.ideas.id})`],
			['a', 'card.completed', 'card_completed', '"Done at once": Ideas → Complete'],
			['a-completions', 'card.completed', 'card_completed', '"Done at once": Ideas → Complete']
		]);
	});

	it.each(acrossBoards)("%s: from the Options column into another board's To Do, the joined board hears the arrival and the commitment", async (_route, move) => {
		const w = withOptions();
		const card = makeCard(w.ideas, { title: 'Chosen' });

		// The board it left hears it sent on, as by a Send (card 2463, the S5a review's L5).
		expect(await deliveries(w, () => move(w.owner, card.id, w.B.cols['To Do'].id))).toEqual([
			['a', 'card.moved', 'card_sent', '"Chosen" sent to another board\'s To Do (Ideas → To Do)'],
			['b', 'card.moved', 'card_moved_in', '"Chosen" moved from another board (Ideas → To Do)'],
			['b', 'card.committed', 'card_committed', `"Chosen": Ideas → To Do (column ${w.B.cols['To Do'].id}, from column ${w.ideas.id})`]
		]);
	});

	it.each(acrossBoards)("%s: from Complete onto an ideas board, the joined board hears two card.moved, the arrival and the return, and none for the reopening (C2)", async (_route, move) => {
		const w = withOptions({ ideasBoard: true });
		const card = makeCard(w.A.cols['Complete'], { title: 'Not needed', completedAt: '2026-10-01 09:00:00' });

		expect(await deliveries(w, () => move(w.owner, card.id, w.B.cols['To Do'].id))).toEqual([
			['a', 'card.moved', 'card_moved_away', '"Not needed" moved to another board (Complete → To Do)'],
			['b', 'card.moved', 'card_moved_in', '"Not needed" moved from another board (Complete → To Do)'],
			['b', 'card.moved', 'card_returned_to_options', '"Not needed": Complete → To Do']
		]);
		const written = db.select().from(activityLog).where(eq(activityLog.cardId, card.id)).orderBy(activityLog.id).all();
		expect(written.map((e) => e.action.replace('api:', ''))).toEqual(['card_moved_away', 'card_moved_in', 'card_reopened', 'card_returned_to_options']);
	});

	it.each(acrossBoards)('%s: from To Do onto an ideas board, the joined board hears the arrival and the return', async (_route, move) => {
		const w = withOptions({ ideasBoard: true });
		const card = makeCard(w.A.cols['To Do'], { title: 'Not yet' });

		expect(await deliveries(w, () => move(w.owner, card.id, w.B.cols['To Do'].id))).toEqual([
			['a', 'card.moved', 'card_moved_away', '"Not yet" moved to another board (To Do → To Do)'],
			['b', 'card.moved', 'card_moved_in', '"Not yet" moved from another board (To Do → To Do)'],
			['b', 'card.moved', 'card_returned_to_options', '"Not yet": To Do → To Do']
		]);
	});

	it('a webhook asking for card.committed alone hears a commitment and nothing else of the move', async () => {
		const w = withOptions();
		makeWebhook(w.A.board, { url: 'https://hooks.example.test/a-commitments', events: ['card.committed'] });
		const chosen = makeCard(w.ideas, { title: 'Chosen' });
		const back = makeCard(w.A.cols['To Do'], { title: 'Put back' });

		const v1Move = routes[2][1];
		expect((await v1Move(w.owner, chosen.id, w.A.cols['To Do'].id)).status).toBe(200);
		expect((await v1Move(w.owner, back.id, w.ideas.id)).status).toBe(200);
		await sent.settle();

		expect(sent.webhooks.filter((d) => d.url.endsWith('/a-commitments')).map((d) => [d.event, d.body.data.action, d.body.data.source])).toEqual([
			['card.committed', 'card_committed', 'api']
		]);
		// The webhook asking for every event heard both.
		expect(sent.webhooks.filter((d) => d.url.endsWith('/a')).map((d) => d.event)).toEqual(['card.committed', 'card.moved']);
	});
});

// ─── Card 2325 ───────────────────────────────────────────────────────────

describe('a webhook whose setter can no longer open the board is switched off for good (cards 2325 and 2752)', () => {
	/** `pausedBecause` for a webhook switched off because its setter lost the board, word for word (card 2752, 4.3). */
	const LOST =
		'This was switched off because the account that set it up could no longer open this board. It stays off if that account ' +
		'is given the board back. The address was chosen by that account: delete the webhook unless you recognise it; to keep it, ' +
		'switch it on with your own key, which makes you its setter and gives it a new secret, given in that answer and readable by ' +
		"the board's owner or an administrator, and update the receiver.";
	/**
	 * `pausedBecause` for a webhook switched off by a password or two-step reset (card 2915), an invite used, a disable
	 * (card 2671) or a delete of its setter (the code review's CS4); reworded by card 2923 (E12, S3) to name the holder's
	 * own change that ends keys and one held when already off; by card 2935 to name an account that could read its secret
	 * as the board's owner or an administrator, and one that lost that role; by card 2947 to name an API key that was given
	 * its secret, and to say the old secret is exposed now (R6).
	 */
	const ACCESS_ENDED =
		"This was switched off because the account that set it up, or an account that could read its secret as the board's owner or an " +
		'administrator, had its password or its two-step sign-in reset, ended its API keys when changing its own password, used an ' +
		'invite, was disabled, or was deleted, or, for one that could read it, lost that role; or because an API key that was given its ' +
		'secret was revoked, expired or passed its deadline; one already switched off then, or found ' +
		'switched off with its setter disabled or not recorded, is held the same way. Treat its old secret as exposed: change it at the ' +
		'receiver now, whether or not the webhook is switched on again, since until then the receiver trusts anything signed with it. Delete the webhook unless you recognise its ' +
		'address; to keep it, switch it on with your own key, which makes you its setter and gives it a new secret, given in that answer ' +
		"and readable by the board's owner or an administrator, and update the receiver.";
	/**
	 * `pausedBecause` for a webhook switched off because nobody is recorded as having set it up; since card 2923's code
	 * review (S1) it is given a new secret too.
	 */
	const NOBODY =
		'This was switched off because nobody is recorded as having set it up. Delete it unless you recognise the address; to keep ' +
		"it, switch it on with your own key, which makes you its setter and gives it a new secret, given in that answer and readable by the board's owner or an administrator, and update the receiver.";
	const LOST_REASON = 'Not sent: the account that set it up can no longer open this board';
	const NOBODY_REASON = 'Not sent: nobody is recorded as having set it up';
	/** `pausedBecause` for one on and held now, a window only a change outside the six writes can open (D7). */
	const LOST_NOW =
		'Nothing is sent: the account that set this up can no longer open this board. It is switched off at its next event, and ' +
		"stays off until the board's owner or an administrator switches it on.";
	const NOBODY_NOW =
		"Nothing is sent: nobody is recorded as having set this up. It is switched off at its next event, and stays off until the board's " +
		'owner or an administrator switches it on.';
	/** The answer to a `secret` sent with a switch-on that gives a new one (D3). */
	const NEW_SECRET_REFUSAL =
		'A webhook switched off this way is given a new secret when it is switched on: send active true alone, and read the new secret from the answer.';
	/** The answer to a create at a receiver held off on the board (D6; the code review's CS2). */
	const HELD_OFF_RECEIVER =
		"A webhook to this receiver (the same scheme, host and port) on this board was switched off. Only the board's owner or an administrator can switch it on again, or add another webhook to it.";
	/** The answer to an editor's delete of a webhook switched off for good (the code review's CS1). */
	const HELD_OFF_DELETE = "Only the board's owner or an administrator can delete a webhook that was switched off this way. Ask the board's owner.";
	/** The four columns no answer carries (D7). */
	const WITHHELD = ['setBy', 'heldBecause', 'heldAt', 'setByKey', 'setWithKey'];

	let sent: Effects;
	beforeEach(() => {
		makeSmtp();
		sent = effects();
	});
	afterEach(() => sent.restore());

	/**
	 * Owner O's board, editor E a direct member unless `viaTeam` (then E edits
	 * it through a team shared as editor, and is no member), and a superadmin
	 * and an administrator who are on nothing; with `coOwner`, a second owner
	 * on its member list.
	 */
	function scene(opts: { isPublic?: boolean; viaTeam?: boolean; coOwner?: boolean } = {}) {
		const owner = makeUser({ username: 'owner' });
		const editor = makeUser({ username: 'editor' });
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const chief = makeUser({ username: 'chief', role: 'superadmin' });
		const fixture = makeBoard({ owner, isPublic: opts.isPublic });
		const team = opts.viaTeam ? makeTeam([editor], 'Design') : undefined;
		if (team) shareBoardWithTeam(fixture.board, team, 'editor');
		else addBoardMember(fixture.board, editor, 'editor');
		const coOwner = opts.coOwner ? makeUser({ username: 'co-owner' }) : undefined;
		if (coOwner) addBoardMember(fixture.board, coOwner, 'owner');
		return { owner, editor, admin, chief, team, coOwner, ...fixture };
	}
	type Scene = ReturnType<typeof scene>;

	/** A webhook made by `user`'s own POST, so that they are its setter. */
	async function hookOf(s: Scene, user: SessionUser, name: string, secret?: string) {
		const made = await api('POST', `/api/v1/boards/${s.board.id}/webhooks`, {
			user,
			body: { url: `https://hooks.example.test/${name}`, ...(secret === undefined ? {} : { secret }) }
		});
		expect(made.status).toBe(201);
		return made.body as { id: number; url: string; secret: string };
	}

	let raised = 0;
	/** O raises a card through the API: the addresses it was delivered to, in order. */
	async function event(s: Scene): Promise<string[]> {
		sent.clear();
		const res = await api('POST', `/api/v1/boards/${s.board.id}/cards`, {
			user: s.owner,
			body: { title: `2325 card ${++raised}`, columnId: s.cols['To Do'].id }
		});
		expect(res.status).toBe(201);
		await sent.settle();
		expect(sent.webhooks.every((w) => w.event === 'card.created')).toBe(true);
		return sent.webhooks.map((w) => w.url);
	}

	/** O takes E off the board, as Share Board does, and what it sends has gone. */
	async function takeOff(s: Scene, user: SessionUser = s.editor) {
		sent.clear();
		const res = await api('DELETE', `/api/boards/${s.board.id}/share`, { user: s.owner, body: { type: 'user', targetId: user.id } });
		expect(res.status).toBe(200);
		await sent.settle();
	}

	/** O shares the board with E again, as Share Board does. */
	async function shareBack(s: Scene, user: SessionUser = s.editor, role: 'editor' | 'viewer' = 'editor') {
		const res = await api('POST', `/api/boards/${s.board.id}/share`, { user: s.owner, body: { type: 'user', targetId: user.id, role } });
		expect(res.status).toBe(200);
	}

	/** The webhook as `user`'s list and one GET answer it: [from the list, the one]. */
	async function answersTo(s: Scene, user: SessionUser, id: number) {
		const list = await api('GET', `/api/v1/boards/${s.board.id}/webhooks`, { user });
		const one = await api('GET', `/api/v1/webhooks/${id}`, { user });
		expect([list.status, one.status]).toEqual([200, 200]);
		return [list.body.find((h: { id: number }) => h.id === id), one.body];
	}

	const put = (user: SessionUser, id: number, body: Record<string, unknown>) => api('PUT', `/api/v1/webhooks/${id}`, { user, body });

	/** A delivery's signature as a receiver checks it: the body as sent, signed with `secret`. */
	const signedWith = (secret: string, delivery: Effects['webhooks'][number]) =>
		delivery.headers['x-dumpfire-signature'] === sign(secret, JSON.stringify(delivery.body));

	/** The webhook's row as stored: on or off, why and when it was held off, its setter and its secret, opened (card 2898). */
	const rowOf = (id: number) => {
		const row = sqlite.prepare('SELECT active, held_because AS heldBecause, held_at AS heldAt, set_by AS setBy, secret FROM webhooks WHERE id = ?').get(id) as {
			active: number;
			heldBecause: string | null;
			heldAt: string | null;
			setBy: number | null;
			secret: string;
		};
		return { ...row, secret: readOpened('webhooks', id)! };
	};

	/** Switched off for good by a hold: off, why, and a moment in the stored form (D1). */
	function expectHeldOff(id: number, hold: 'setter cannot open' | 'no setter' = 'setter cannot open') {
		expect(rowOf(id)).toMatchObject({ active: 0, heldBecause: hold, heldAt: expect.stringMatching(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/) });
	}

	/** On, with no hold. */
	const expectOn = (id: number) => expect(rowOf(id)).toMatchObject({ active: 1, heldBecause: null, heldAt: null });

	/** The WARN a switch-off writes, word for word (4.3): never the address. */
	const offLine = (hook: { id: number }, boardId: number, setter: SessionUser | null, cause: string) =>
		`Webhook ${hook.id} on board ${boardId} switched off: ` +
		(setter ? `the account that set it up (user ${setter.id}) can no longer open the board` : 'nobody is recorded as having set it up') +
		` (${cause}). It stays off until an owner of the board or an administrator switches it on.`;

	/** The mails that say webhooks were switched off. */
	const offMails = () => sent.emails.filter((mail) => / switched off$/.test(mail.subject));

	// ─── Card 2325's cases, extended in place (card 2752, E1, E2) ───

	it("1. (2752 case 1) an editor taken off the board: theirs switched off at the write, the owner told; shared back, it stays off", async () => {
		const s = scene();
		const theirs = await hookOf(s, s.editor, 'e');
		const owners = await hookOf(s, s.owner, 'o');
		expect(await event(s)).toEqual([theirs.url, owners.url]);

		await takeOff(s);

		// Straight after the write, before any event (E1).
		expectHeldOff(theirs.id);
		expectOn(owners.id);
		const cause = 'editor was taken off the board by owner';
		expect(lines('WARN')).toEqual([offLine(theirs, s.board.id, s.editor, cause)]);
		expect(offMails().map((mail) => mail.to)).toEqual([s.owner.email]);
		expect(offMails()[0].html).toContain(cause);

		await shareBack(s);
		expect(await event(s)).toEqual([owners.url]);
		expectHeldOff(theirs.id);
	});

	it.each([
		{
			// 2752 case 2.
			row: "the team's share removed, then shared again",
			remove: (s: Scene) => api('DELETE', `/api/boards/${s.board.id}/share`, { user: s.owner, body: { type: 'team', targetId: s.team!.id } }),
			cause: "the team Design's share was removed by owner",
			back: async (s: Scene) => {
				const res = await api('POST', `/api/boards/${s.board.id}/share`, { user: s.owner, body: { type: 'team', targetId: s.team!.id, role: 'editor' } });
				expect(res.status).toBe(200);
			}
		},
		{
			// 2752 case 6: the members are read before the delete takes them.
			row: 'the team deleted, then a new team with them shared',
			remove: (s: Scene) => api('DELETE', `/api/teams/${s.team!.id}`, { user: s.admin }),
			cause: 'the team Design was deleted by admin',
			back: async (s: Scene) => shareBoardWithTeam(s.board, makeTeam([s.editor]), 'editor')
		}
	])('2. (2752 cases 2 and 6) an editor through a team, $row: theirs switched off at the write, and stays off', async ({ remove, cause, back }) => {
		const s = scene({ viaTeam: true });
		const theirs = await hookOf(s, s.editor, 'e');
		const owners = await hookOf(s, s.owner, 'o');

		sent.clear();
		expect((await remove(s)).status).toBe(200);
		await sent.settle();

		expectHeldOff(theirs.id);
		expectOn(owners.id);
		expect(lines('WARN')).toEqual([offLine(theirs, s.board.id, s.editor, cause)]);
		expect(offMails().map((mail) => mail.to)).toEqual([s.owner.email]);
		expect(offMails()[0].html).toContain(escapeHtml(cause));

		await back(s);
		expect(await event(s)).toEqual([owners.url]);
	});

	it('3. (2752 case 3) an editor through a team, taken out of the team: theirs switched off at the write; put back, it stays off', async () => {
		const s = scene({ viaTeam: true });
		const theirs = await hookOf(s, s.editor, 'e');
		const owners = await hookOf(s, s.owner, 'o');

		sent.clear();
		const res = await api('DELETE', `/api/teams/${s.team!.id}/members/${s.editor.id}`, { user: s.admin });
		expect(res.status).toBe(200);
		await sent.settle();

		expectHeldOff(theirs.id);
		const cause = 'editor was taken out of the team Design by admin';
		expect(lines('WARN')).toEqual([offLine(theirs, s.board.id, s.editor, cause)]);
		expect(offMails().map((mail) => mail.to)).toEqual([s.owner.email]);
		expect(offMails()[0].html).toContain(cause);

		expect((await api('POST', `/api/teams/${s.team!.id}/members/${s.editor.id}`, { user: s.admin, body: {} })).status).toBe(201);
		expect(await event(s)).toEqual([owners.url]);
	});

	it("4. a public board's editor taken off its members can still open it, so theirs stays on and is sent (a guard)", async () => {
		const s = scene({ isPublic: true });
		const theirs = await hookOf(s, s.editor, 'e');
		const owners = await hookOf(s, s.owner, 'o');

		await takeOff(s);

		expectOn(theirs.id);
		expect(lines('WARN')).toEqual([]);
		expect(offMails()).toEqual([]);
		expect(await event(s)).toEqual([theirs.url, owners.url]);
	});

	it.each([
		// 2752 case 4, by Share Board's switch.
		{ row: 'the share PATCH', makePrivate: (s: Scene) => api('PATCH', `/api/boards/${s.board.id}/share`, { user: s.owner, body: { isPublic: false } }) },
		// 2752 case 7: the same through updateBoard.
		{ row: 'PUT /api/v1/boards/{id}', makePrivate: (s: Scene) => api('PUT', `/api/v1/boards/${s.board.id}`, { user: s.owner, body: { isPublic: false } }) }
	])('5. (2752 cases 4 and 7) then the board made private by $row: theirs switched off at the write; made public again, it stays off', async ({ makePrivate }) => {
		const s = scene({ isPublic: true });
		const theirs = await hookOf(s, s.editor, 'e');
		const owners = await hookOf(s, s.owner, 'o');
		await takeOff(s);

		sent.clear();
		expect((await makePrivate(s)).status).toBe(200);
		await sent.settle();

		expectHeldOff(theirs.id);
		expectOn(owners.id);
		const cause = 'the board was made private by owner';
		expect(lines('WARN')).toEqual([offLine(theirs, s.board.id, s.editor, cause)]);
		expect(offMails().map((mail) => mail.to)).toEqual([s.owner.email]);
		expect(offMails()[0].html).toContain(cause);

		expect((await api('PATCH', `/api/boards/${s.board.id}/share`, { user: s.owner, body: { isPublic: true } })).status).toBe(200);
		expect(await event(s)).toEqual([owners.url]);
	});

	it("6. (2752 case 5) an administrator on no member list made an ordinary user: theirs switched off at the write, another administrator's sent; made an administrator again, theirs stays off", async () => {
		const s = scene();
		const other = makeUser({ username: 'other-admin', role: 'admin' });
		const theirs = await hookOf(s, s.admin, 'a');
		const others = await hookOf(s, other, 'a2');
		// While an administrator, sent.
		expect(await event(s)).toEqual([theirs.url, others.url]);

		sent.clear();
		expect((await api('PUT', `/api/users/${s.admin.id}`, stepUp(s.chief, { role: 'user' }))).status).toBe(200);
		await sent.settle();

		expectHeldOff(theirs.id);
		expectOn(others.id);
		const cause = "admin's role was changed to user by chief";
		expect(lines('WARN')).toEqual([offLine(theirs, s.board.id, s.admin, cause)]);
		expect(offMails().map((mail) => mail.to)).toEqual([s.owner.email]);
		expect(offMails()[0].html).toContain(escapeHtml(cause));

		expect((await api('PUT', `/api/users/${s.admin.id}`, stepUp(s.chief, { role: 'admin' }))).status).toBe(200);
		expect(await event(s)).toEqual([others.url]);
	});

	it('7. an editor taken off and given the board back as a viewer: theirs is not sent again; it stays off (card 2325 pinned the reverse)', async () => {
		const s = scene();
		await hookOf(s, s.editor, 'e');
		const owners = await hookOf(s, s.owner, 'o');
		await takeOff(s);

		await shareBack(s, s.editor, 'viewer');

		expect(await event(s)).toEqual([owners.url]);
	});

	// ─── New (card 2752) ───

	it('8. (2752 case 8) the backstop at delivery: access lost where no write sweeps; delivered twice from the same stale row, switched off, said and mailed once; given back, still off', async () => {
		const s = scene();
		const theirs = makeWebhook(s.board, { url: 'https://hooks.example.test/stale', setBy: s.editor });
		// A path no sweep runs: the member row deleted from the host.
		sqlite.prepare('DELETE FROM board_members WHERE board_id = ? AND user_id = ?').run(s.board.id, s.editor.id);
		// Until its next event it is on, and its answer says nothing is sent (D7).
		for (const answer of await answersTo(s, s.owner, theirs.id)) {
			expect(answer).toMatchObject({ active: true, pausedBecause: LOST_NOW });
		}
		sent.clear();

		deliver(theirs, 'card.created', '{}');
		deliver(theirs, 'card.created', '{}');
		await sent.settle();

		expect(sent.webhooks).toEqual([]);
		expectHeldOff(theirs.id);
		expect(deliveryResultFor(theirs)).toMatchObject({ outcome: 'not-sent', status: null, reason: LOST_REASON });
		expect(lines('WARN')).toEqual([offLine(theirs, s.board.id, s.editor, 'found when an event was sent')]);
		expect(offMails().map((mail) => mail.to)).toEqual([s.owner.email]);

		addBoardMember(s.board, s.editor, 'editor');
		expect(await event(s)).toEqual([]);
		expectHeldOff(theirs.id);
	});

	it('9. (2752 case 9) the backstop when the switch-off write fails: the delivery is still not sent, and one ERROR says so', async () => {
		const s = scene();
		const theirs = makeWebhook(s.board, { url: 'https://hooks.example.test/failing', setBy: s.editor });
		sqlite.prepare('DELETE FROM board_members WHERE board_id = ? AND user_id = ?').run(s.board.id, s.editor.id);
		const prepare = sqlite.prepare.bind(sqlite);
		const failing = vi.spyOn(sqlite, 'prepare').mockImplementation(((source: string) => {
			if (source.startsWith('UPDATE webhooks SET active = 0, held_because')) throw new Error('disk I/O error');
			return prepare(source);
		}) as typeof sqlite.prepare);
		try {
			deliver(theirs, 'card.created', '{}');
		} finally {
			failing.mockRestore();
		}
		await sent.settle();

		expect(sent.webhooks).toEqual([]);
		expect(deliveryResultFor(theirs)).toMatchObject({ outcome: 'not-sent', reason: LOST_REASON });
		expect(lines('ERROR')).toEqual([`Webhook ${theirs.id} on board ${s.board.id} could not be switched off, and was not sent: disk I/O error`]);
		expect(lines('WARN')).toEqual([]);
		expect(offMails()).toEqual([]);
		expectOn(theirs.id);
	});

	it('10. (2752 case 10) a webhook with no setter is switched off with its own sentence, until the owner switches it on, given a new secret (card 2923, code review S1)', async () => {
		const s = scene();
		const nobodys = makeWebhook(s.board, { url: 'https://hooks.example.test/nobody', secret: 'old', setBy: null });
		const owners = await hookOf(s, s.owner, 'o');
		// Until its next event it is on, and its answer says nothing is sent (D7).
		for (const answer of await answersTo(s, s.owner, nobodys.id)) {
			expect(answer).toMatchObject({ active: true, pausedBecause: NOBODY_NOW });
		}

		expect(await event(s)).toEqual([owners.url]);
		expectHeldOff(nobodys.id, 'no setter');
		expect(lines('WARN')).toEqual([offLine(nobodys, s.board.id, null, 'found when an event was sent')]);
		expect(lines('WARN')[0]).not.toContain('hooks.example.test');
		const [listed, one] = await answersTo(s, s.owner, nobodys.id);
		for (const answer of [listed, one]) {
			expect(answer).toMatchObject({ active: false, pausedBecause: NOBODY });
			expect(answer.lastDelivery).toMatchObject({ outcome: 'not-sent', status: null, reason: NOBODY_REASON });
		}

		// Card 2923's code review (S1): a secret sent with the switch-on is refused; switched on alone, it is given a new one.
		expect((await put(s.owner, nobodys.id, { active: true, secret: 'new' })).status).toBe(400);
		const taken = await put(s.owner, nobodys.id, { active: true });
		expect(taken.status).toBe(200);
		expect(taken.body).toMatchObject({ active: true, pausedBecause: null });
		expect(taken.body.secret).toMatch(/^[0-9a-f]{64}$/);

		expect(await event(s)).toEqual([nobodys.address, owners.url]);
		expect(signedWith(taken.body.secret, sent.webhooks[0])).toBe(true);
	});

	it('11. (2752 case 11) a stale read whose setter changed meanwhile is left on: the write changes nothing, and says and mails nothing', async () => {
		const s = scene();
		const theirs = await hookOf(s, s.editor, 'e');
		// The sweep's row, read while the editor set it.
		const stale = db.select().from(webhooks).where(eq(webhooks.id, theirs.id)).get()!;
		// Meanwhile the owner switches it off and on: its setter is the owner now.
		expect((await put(s.owner, theirs.id, { active: false })).status).toBe(200);
		expect((await put(s.owner, theirs.id, { active: true })).status).toBe(200);
		sqlite.prepare('DELETE FROM board_members WHERE board_id = ? AND user_id = ?').run(s.board.id, s.editor.id);
		sent.clear();

		expect(switchOffHeld(stale, 'setter cannot open')).toBe(false);
		await sent.settle();

		expect(rowOf(theirs.id)).toMatchObject({ active: 1, heldBecause: null, heldAt: null, setBy: s.owner.id });
		expect(lines('WARN')).toEqual([]);
		expect(offMails()).toEqual([]);
	});

	it.each([
		{ row: 'where the schedulers run', value: 'on', mailed: true },
		{ row: 'where they do not', value: 'off', mailed: false }
	])('12. (2752 case 12) at start, $row: switched off with one WARN, the owners mailed only where the schedulers run; a second start changes nothing', async ({ value, mailed }) => {
		const s = scene();
		const theirs = makeWebhook(s.board, { setBy: s.editor });
		sqlite.prepare('DELETE FROM board_members WHERE board_id = ? AND user_id = ?').run(s.board.id, s.editor.id);
		const owners = makeWebhook(s.board);

		expect(switchOffHeldWebhooksAtStart(value, false)).toBe(1);
		await sent.settle();

		expectHeldOff(theirs.id);
		expectOn(owners.id);
		const line = offLine(theirs, s.board.id, s.editor, 'found when the server started');
		expect(lines('WARN')).toEqual(
			mailed
				? [line]
				: [line, 'The owners of the boards of the 1 webhook(s) switched off above were not mailed, as the schedulers are off (SCHEDULERS=off). The line above names it.']
		);
		expect(offMails().map((mail) => mail.to)).toEqual(mailed ? [s.owner.email] : []);

		sent.clear();
		expect(switchOffHeldWebhooksAtStart(value, false)).toBe(0);
		await sent.settle();
		expect(lines('WARN')).toHaveLength(mailed ? 1 : 2);
		expect(sent.emails).toEqual([]);
	});

	it.each([
		{ row: 'held for a lost setter: a new secret, given in the answer', hold: 'setter cannot open' as const, newSecret: true },
		// Card 2923's code review (S1): a new secret for no setter too.
		{ row: 'held for no setter: a new secret too', hold: 'no setter' as const, newSecret: true }
	])('15. (2752 case 15) switched on by the owner, $row; the owner its setter, the hold cleared', async ({ hold, newSecret }) => {
		const s = scene();
		const held =
			hold === 'setter cannot open'
				? await hookOf(s, s.editor, 'e', 'old-secret')
				: // The address as the test gave it, beside the stored row (card 2928's code review, C8).
					((made) => ({ id: made.id, url: made.address }))(
						makeWebhook(s.board, { url: 'https://hooks.example.test/nobody', secret: 'old-secret', setBy: null, heldBecause: 'no setter' })
					);
		if (hold === 'setter cannot open') await takeOff(s);
		expectHeldOff(held.id, hold);

		const on = await put(s.owner, held.id, { active: true });

		expect(on.status).toBe(200);
		expect(on.body).toMatchObject({ active: true, pausedBecause: null });
		if (newSecret) {
			expect(on.body.secret).toMatch(/^[0-9a-f]{64}$/);
			expect(on.body.secret).not.toBe('old-secret');
		} else {
			expect(on.body.secret).toBe('old-secret');
		}
		expect(rowOf(held.id)).toEqual({ active: 1, heldBecause: null, heldAt: null, setBy: s.owner.id, secret: on.body.secret });
		expect(await event(s)).toEqual([held.url]);
		expect(signedWith(on.body.secret, sent.webhooks[0])).toBe(true);
	});

	it("3012 (b). one held because it came in with a backup whose seal did not verify gives that sentence, word for word; a secret sent with the switch-on is refused; switched on alone, it is given a new one", async () => {
		const s = scene();
		const made = makeWebhook(s.board, { url: 'https://hooks.example.test/unsealed', secret: '', setBy: s.editor, heldBecause: HELD_FROM_UNSEALED_BACKUP });
		expect(rowOf(made.id)).toMatchObject({ active: 0, heldBecause: HELD_FROM_UNSEALED_BACKUP });

		const [listed, one] = await answersTo(s, s.owner, made.id);
		for (const answer of [listed, one]) {
			expect(answer).toMatchObject({
				active: false,
				pausedBecause:
					"This was switched off because it came in with a backup whose seal did not verify, so its address, its secret and who set it up are only the file's word, and its secret was discarded. " +
					"Delete it unless you recognise the address; to keep it, switch it on with your own key, which makes you its setter and gives it a new secret, given in that answer and readable by the board's owner or an administrator, and update the receiver."
			});
		}

		const before = snapshotDb();
		const refused = await put(s.owner, made.id, { active: true, secret: 'mine' });
		expect(refused.status).toBe(400);
		expect(refused.body.message).toBe(NEW_SECRET_REFUSAL);
		expectUnchanged(before, 'after a secret sent with the switch-on');

		const on = await put(s.owner, made.id, { active: true });
		expect(on.status).toBe(200);
		expect(on.body).toMatchObject({ active: true, pausedBecause: null });
		expect(on.body.secret).toMatch(/^[0-9a-f]{64}$/);
		expect(rowOf(made.id)).toEqual({ active: 1, heldBecause: null, heldAt: null, setBy: s.owner.id, secret: on.body.secret });
		expect(await event(s)).toEqual([made.address]);
		expect(signedWith(on.body.secret, sent.webhooks[0])).toBe(true);
	});

	it("3012 FP2. one held for a reason this build does not name, its secret discarded, fails closed: a secret sent with the switch-on is refused; switched on alone, it is given a new one", async () => {
		const s = scene();
		const made = makeWebhook(s.board, { url: 'https://hooks.example.test/later-build', secret: '', setBy: s.editor, heldBecause: 'a reason from a later build' });

		const before = snapshotDb();
		const refused = await put(s.owner, made.id, { active: true, secret: 'mine' });
		expect(refused.status).toBe(400);
		expect(refused.body.message).toBe(NEW_SECRET_REFUSAL);
		expectUnchanged(before, 'after a secret sent with the switch-on');

		const on = await put(s.owner, made.id, { active: true });
		expect(on.status).toBe(200);
		expect(on.body.secret).toMatch(/^[0-9a-f]{64}$/);
		expect(rowOf(made.id)).toEqual({ active: 1, heldBecause: null, heldAt: null, setBy: s.owner.id, secret: on.body.secret });
	});

	it('16. (2752 case 16) a secret sent with that switch-on is refused 400 and nothing is written; the former setter, given the board back, cannot switch it on', async () => {
		const s = scene();
		const theirs = await hookOf(s, s.editor, 'e', 'old-secret');
		await takeOff(s);

		const before = snapshotDb();
		const refused = await put(s.owner, theirs.id, { active: true, secret: 'mine' });
		expect(refused.status).toBe(400);
		expect(refused.body.message).toBe(NEW_SECRET_REFUSAL);
		expectUnchanged(before, 'after a secret sent with the switch-on');

		// Its status is not asserted: card 2719 decides it.
		await shareBack(s);
		const shared = snapshotDb();
		const theirOwn = await put(s.editor, theirs.id, { active: true });
		expect(theirOwn.status).toBeGreaterThanOrEqual(400);
		expectUnchanged(shared, "after the former setter's own switch-on");
		expectHeldOff(theirs.id);
	});

	it.each([
		{ row: 'an editor: refused 409, nothing written', who: 'editor' as const, status: 409 },
		{ row: 'the owner: made', who: 'owner' as const, status: 201 }
	])('17. (2752 case 17) a create at an address held off on the board, by $row', async ({ who, status }) => {
		const s = scene();
		const second = makeUser({ username: 'second' });
		addBoardMember(s.board, second, 'editor');
		const seconds = await hookOf(s, second, 'held-address');
		await takeOff(s, second);
		expectHeldOff(seconds.id);

		const before = snapshotDb();
		const made = await api('POST', `/api/v1/boards/${s.board.id}/webhooks`, { user: s[who], body: { url: seconds.url } });

		expect(made.status).toBe(status);
		if (status === 409) {
			expect(made.body.message).toBe(HELD_OFF_RECEIVER);
			expectUnchanged(before, 'after a create refused');
		} else {
			expect(made.body).toMatchObject({ url: seconds.url, active: true });
		}
	});

	it.each([
		{ row: "an editor's: each owner mailed once", who: 'editor' as const, mailed: true },
		{ row: "an owner's own: nobody mailed", who: 'owner' as const, mailed: false }
	])("18. (2752 case 18) the owners are told of a webhook somebody else made: $row", async ({ who, mailed }) => {
		const s = scene({ coOwner: true });
		sent.clear();

		const made = await hookOf(s, s[who], 'path-not-mailed?token=q');
		await sent.settle();

		const told = sent.emails.filter((mail) => mail.subject === `A webhook was made on ${s.board.name}`);
		expect(told.map((mail) => mail.to).sort()).toEqual(mailed ? [s.owner.email, s.coOwner!.email].sort() : []);
		for (const mail of told) {
			expect(mail.html).toContain('editor');
			expect(mail.html).toContain(`webhook ${made.id}`);
			expect(mail.html).toContain('hooks.example.test');
			expect(mail.html).not.toContain('path-not-mailed');
		}
	});

	it.each([
		{
			row: 'the creator and an owner on the member list, one mail each for two webhooks',
			run: async () => {
				const s = scene({ coOwner: true });
				const first = await hookOf(s, s.editor, 'e-secret-path?token=t1', 'never-mailed');
				const second = await hookOf(s, s.editor, 'e-other-path');
				await takeOff(s);
				return { to: [s.owner.email, s.coOwner!.email], ids: [first.id, second.id], cause: 'editor was taken off the board by owner' };
			}
		},
		{
			row: 'a board with no owner: every administrator and the superadmin',
			run: async () => {
				const admin = makeUser({ username: 'admin', role: 'admin' });
				const chief = makeUser({ username: 'chief', role: 'superadmin' });
				const editor = makeUser({ username: 'editor' });
				makeUser({ username: 'bystander' });
				const { board } = makeBoard();
				addBoardMember(board, editor, 'editor');
				const hook = makeWebhook(board, { url: 'https://hooks.example.test/e-secret-path', setBy: editor });
				sent.clear();
				expect((await api('DELETE', `/api/boards/${board.id}/share`, { user: admin, body: { type: 'user', targetId: editor.id } })).status).toBe(200);
				await sent.settle();
				return { to: [admin.email, chief.email], ids: [hook.id], cause: 'editor was taken off the board by admin' };
			}
		},
		{
			row: 'an owner who switched their mail off: still mailed',
			run: async () => {
				const s = scene();
				db.update(users).set({ notificationPrefs: JSON.stringify({ email_all: false }) }).where(eq(users.id, s.owner.id)).run();
				const hook = await hookOf(s, s.editor, 'e-secret-path');
				await takeOff(s);
				return { to: [s.owner.email], ids: [hook.id], cause: 'editor was taken off the board by owner' };
			}
		}
	])('19. (2752 case 19) who the switch-off mail goes to: $row, naming the cause and the host, never the path, query or secret', async ({ run }) => {
		const { to, ids, cause } = await run();

		expect(offMails().map((mail) => mail.to).sort()).toEqual([...to].sort());
		for (const mail of offMails()) {
			expect(mail.html).toContain(cause);
			for (const id of ids) expect(mail.html).toContain(`webhook ${id} to <strong>hooks.example.test</strong>`);
			for (const never of ['e-secret-path', 'e-other-path', 'token=', 'never-mailed']) expect(mail.html).not.toContain(never);
		}
	});

	it.each([
		{ row: '{ boardIds }', scope: (b: { a: number; b: number }) => ({ boardIds: [b.a] }), off: ['a1'] },
		{ row: '{ setters }', scope: (_b: unknown, x: SessionUser) => ({ setters: [x.id] }), off: ['a1', 'b1'] },
		{ row: "'all'", scope: () => 'all' as const, off: ['a1', 'b1', 'b2'] }
	])('20. (2752 case 20) the scope $row switches off only the held webhooks within it; outside a transaction it throws', async ({ scope, off }) => {
		const owner = makeUser({ username: 'owner' });
		const x = makeUser({ username: 'x' });
		const y = makeUser({ username: 'y' });
		const a = makeBoard({ owner }).board;
		const b = makeBoard({ owner }).board;
		const hooks = {
			a1: makeWebhook(a, { setBy: x }),
			a2: makeWebhook(a),
			b1: makeWebhook(b, { setBy: x }),
			b2: makeWebhook(b, { setBy: y }),
			b3: makeWebhook(b)
		};
		const ids = Object.fromEntries(Object.entries(hooks).map(([name, hook]) => [name, hook.id]));
		const chosen = scope({ a: a.id, b: b.id }, x) as Parameters<typeof switchOffLostWebhooks>[0];

		expect(() => switchOffLostWebhooks(chosen, 'a test')).toThrow(/none is open/);
		const done = inTransaction(() => switchOffLostWebhooks(chosen, 'a test'));

		expect(done.map((hook) => hook.id)).toEqual(off.map((name) => ids[name]));
		for (const [name, hook] of Object.entries(hooks)) {
			if (off.includes(name)) expectHeldOff(hook.id);
			else expectOn(hook.id);
		}
	});

	it.each([
		{ row: 'switched off by a hold: its sentence', how: 'hold' as const, says: LOST },
		{ row: 'switched off by a PUT: null', how: 'put' as const, says: null },
		// The code review's CS4: a reset records its hold, and says so.
		{ row: 'switched off by a password reset: its sentence', how: 'reset' as const, says: ACCESS_ENDED }
	])('21. (2752 case 21) pausedBecause as history, for a webhook $row; to the owner and an administrator only', async ({ how, says }) => {
		const s = scene();
		const viewer = makeUser({ username: 'viewer' });
		addBoardMember(s.board, viewer, 'viewer');
		const theirs = await hookOf(s, s.editor, 'e');
		if (how === 'hold') await takeOff(s);
		if (how === 'put') expect((await put(s.owner, theirs.id, { active: false })).status).toBe(200);
		if (how === 'reset') inTransaction(() => endAccountAccess(s.editor.id, { apiKeys: true, cause: RESET_IN_A_TEST }));

		for (const user of [s.owner, s.admin]) {
			for (const answer of await answersTo(s, user, theirs.id)) expect(answer).toMatchObject({ active: false, pausedBecause: says });
		}
		for (const answer of await answersTo(s, viewer, theirs.id)) expect(answer).not.toHaveProperty('pausedBecause');
	});

	it('22. (2752 case 22) no answer carries the hold or the key columns: the list, one, and the create', async () => {
		const s = scene();
		const theirs = await hookOf(s, s.editor, 'e');
		await takeOff(s);
		const made = await api('POST', `/api/v1/boards/${s.board.id}/webhooks`, { user: s.owner, body: { url: 'https://hooks.example.test/new' } });
		expect(made.status).toBe(201);

		for (const answer of [...(await answersTo(s, s.owner, theirs.id)), made.body]) {
			for (const key of WITHHELD) expect(answer, key).not.toHaveProperty(key);
		}
	});

	// ─── The code review (2026-11-18) ───

	it.each([
		{ row: 'the address as typed in another case', url: 'HTTPS://Hooks.Example.Test/held-address' },
		{ row: 'the default port written out', url: 'https://hooks.example.test:443/held-address' },
		{ row: 'a trailing slash', url: 'https://hooks.example.test/held-address/' },
		{ row: 'a query', url: 'https://hooks.example.test/held-address?a=1' },
		{ row: 'a fragment', url: 'https://hooks.example.test/held-address#x' },
		{ row: 'another path on the same host', url: 'https://hooks.example.test/somewhere-else' }
	])('CS2. a create by an editor at the receiver held off on the board, $row, is refused 409 with nothing written', async ({ url }) => {
		const s = scene();
		const second = makeUser({ username: 'second' });
		addBoardMember(s.board, second, 'editor');
		const seconds = await hookOf(s, second, 'held-address');
		await takeOff(s, second);

		const before = snapshotDb();
		const made = await api('POST', `/api/v1/boards/${s.board.id}/webhooks`, { user: s.editor, body: { url } });

		expect([made.status, made.body.message]).toEqual([409, HELD_OFF_RECEIVER]);
		expectUnchanged(before, 'after a create refused');
		expect(seconds.url).toBe('https://hooks.example.test/held-address');
	});

	it('CS2. another host, another port or another scheme is another receiver: made (a guard)', async () => {
		const s = scene();
		const second = makeUser({ username: 'second' });
		addBoardMember(s.board, second, 'editor');
		await hookOf(s, second, 'held-address');
		await takeOff(s, second);

		for (const url of ['https://other.example.test/held-address', 'https://hooks.example.test:8443/held-address', 'http://hooks.example.test/held-address']) {
			const made = await api('POST', `/api/v1/boards/${s.board.id}/webhooks`, { user: s.editor, body: { url } });
			expect(made.status, url).toBe(201);
		}
	});

	it.each([
		{ row: 'a secret over 256 characters', body: { secret: 'x'.repeat(257) } },
		{ row: 'an event that is not one of the ten', body: { events: ['card.exploded'] } }
	])('CS3. a malformed create at a held-off receiver is answered its own 400, as at any address: nothing says the receiver is held off ($row)', async ({ body }) => {
		const s = scene();
		const second = makeUser({ username: 'second' });
		addBoardMember(s.board, second, 'editor');
		const seconds = await hookOf(s, second, 'held-address');
		await takeOff(s, second);

		const atHeld = await api('POST', `/api/v1/boards/${s.board.id}/webhooks`, { user: s.editor, body: { url: seconds.url, ...body } });
		const elsewhere = await api('POST', `/api/v1/boards/${s.board.id}/webhooks`, { user: s.editor, body: { url: 'https://other.example.test/x', ...body } });

		expect(atHeld.status).toBe(400);
		expect(atHeld.body).toEqual(elsewhere.body);
	});

	it("CS1. a webhook switched off for good is the owner's or an administrator's to delete: an editor is refused 403 with nothing written; one switched off by a PUT an editor still deletes", async () => {
		const s = scene();
		const second = makeUser({ username: 'second' });
		addBoardMember(s.board, second, 'editor');
		const seconds = await hookOf(s, second, 'held-address');
		const owners = await hookOf(s, s.owner, 'o');
		await takeOff(s, second);
		expect((await put(s.owner, owners.id, { active: false })).status).toBe(200);

		const before = snapshotDb();
		const refused = await api('DELETE', `/api/v1/webhooks/${seconds.id}`, { user: s.editor });
		expect([refused.status, refused.body.message]).toEqual([403, HELD_OFF_DELETE]);
		expectUnchanged(before, "after an editor's delete refused");

		expect((await api('DELETE', `/api/v1/webhooks/${owners.id}`, { user: s.editor })).status).toBe(200);
		expect((await api('DELETE', `/api/v1/webhooks/${seconds.id}`, { user: s.owner })).status).toBe(200);
	});

	it.each([
		{
			row: 'a password reset (endAccountAccess)',
			end: (s: Scene) => inTransaction(() => endAccountAccess(s.editor.id, { apiKeys: true, cause: RESET_IN_A_TEST }))
		},
		// Card 2915 (case 13, E10): a reset of the two-step sign-in records the same hold.
		{ row: 'a two-step reset (resetTwoStep)', end: (s: Scene) => void inTransaction(() => resetTwoStep(s.editor.id, 'admin-reset', { cause: RESET_IN_A_TEST })) },
		// Card 2671: an account is disabled before it is deleted, and the disable switches its webhooks off.
		{
			row: 'the account disabled (disableAccount)',
			end: (s: Scene) => inTransaction(() => disableAccount(db.select().from(users).where(eq(users.id, s.editor.id)).get()!, s.chief))
		},
		// Card 2671's code review, CR1: deleteUser still switches off what a disabled account holds, as a restore or a
		// host edit can leave it: the columns written directly, the webhook left on.
		{
			row: 'the account deleted (deleteUser), disabled with its webhook still on',
			end: (s: Scene) => {
				sqlite.prepare("UPDATE users SET disabled_at = '2099-01-02 09:00:00', disabled_by = ? WHERE id = ?").run(s.chief.id, s.editor.id);
				deleteUser(s.editor.id, s.chief);
			}
		}
	])("CS4. $row records the hold 'setter access ended': switched on, a new secret; the create at its receiver refused to an editor; the Share window counts it", async ({ end }) => {
		const s = scene();
		const other = makeUser({ username: 'other' });
		addBoardMember(s.board, other, 'editor');
		const theirs = await hookOf(s, s.editor, 'reset-receiver', 'old-secret');

		end(s);

		expect(rowOf(theirs.id)).toMatchObject({ active: 0, heldBecause: 'setter access ended', heldAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/) });
		for (const answer of await answersTo(s, s.owner, theirs.id)) expect(answer).toMatchObject({ active: false, pausedBecause: ACCESS_ENDED });
		const share = await api('GET', `/api/boards/${s.board.id}/share`, { user: s.owner });
		expect(share.body.heldWebhooks).toBe(1);
		const refused = await api('POST', `/api/v1/boards/${s.board.id}/webhooks`, { user: other, body: { url: theirs.url } });
		expect([refused.status, refused.body.message]).toEqual([409, HELD_OFF_RECEIVER]);

		const on = await put(s.owner, theirs.id, { active: true });
		expect(on.status).toBe(200);
		expect(on.body.secret).toMatch(/^[0-9a-f]{64}$/);
		expect(rowOf(theirs.id)).toMatchObject({ active: 1, heldBecause: null, heldAt: null, setBy: s.owner.id, secret: on.body.secret });
	});

	// ─── Card 2923: ending an account's access holds its webhooks already switched off, and tells the owners ───

	it.each([
		{
			row: 'a password reset (endAccountAccess)',
			end: (s: Scene) => inTransaction(() => endAccountAccess(s.editor.id, { apiKeys: true, cause: RESET_IN_A_TEST }))
		},
		{
			row: 'the account deleted (deleteUser), disabled by the columns',
			end: (s: Scene) => {
				sqlite.prepare("UPDATE users SET disabled_at = '2099-01-02 09:00:00', disabled_by = ? WHERE id = ?").run(s.chief.id, s.editor.id);
				deleteUser(s.editor.id, s.chief);
			}
		}
	])("2923 case 1. a webhook the owner switched off by PUT, whose setter's access then ends by $row, is held: its sentence, a new secret, the create at its receiver refused, counted held", async ({ end }) => {
		const s = scene();
		const other = makeUser({ username: 'other' });
		addBoardMember(s.board, other, 'editor');
		const theirs = await hookOf(s, s.editor, 'paused-receiver', 'old-secret');
		expect((await put(s.owner, theirs.id, { active: false })).status).toBe(200);
		expect(rowOf(theirs.id)).toMatchObject({ active: 0, heldBecause: null, heldAt: null, setBy: s.editor.id });

		end(s);

		expect(rowOf(theirs.id)).toMatchObject({ active: 0, heldBecause: 'setter access ended', heldAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/) });
		for (const answer of await answersTo(s, s.owner, theirs.id)) expect(answer).toMatchObject({ active: false, pausedBecause: ACCESS_ENDED });
		const share = await api('GET', `/api/boards/${s.board.id}/share`, { user: s.owner });
		expect(share.body.heldWebhooks).toBe(1);
		const refused = await api('POST', `/api/v1/boards/${s.board.id}/webhooks`, { user: other, body: { url: theirs.url } });
		expect([refused.status, refused.body.message]).toEqual([409, HELD_OFF_RECEIVER]);

		const on = await put(s.owner, theirs.id, { active: true });
		expect(on.status).toBe(200);
		expect(on.body.secret).toMatch(/^[0-9a-f]{64}$/);
		expect(on.body.secret).not.toBe('old-secret');
		expect(rowOf(theirs.id)).toMatchObject({ active: 1, heldBecause: null, heldAt: null, setBy: s.owner.id, secret: on.body.secret });
	});

	// Card 2923's code review (S1, N3): a 'no setter' hold records no account, so a secret set on it since is no longer
	// trusted at the switch-on.
	it("2923 R1. a webhook held for no setter whose secret the owner then set by PUT, and whose owner's access then ends, is given a new secret at the switch-on; a secret sent with it is refused", async () => {
		const s = scene();
		const nobodys = makeWebhook(s.board, { url: 'https://hooks.example.test/nobody', secret: 'old', setBy: null, heldBecause: 'no setter' });
		const set = await put(s.owner, nobodys.id, { secret: 'known-to-the-owner' });
		expect(set.status).toBe(200);
		expect(rowOf(nobodys.id)).toMatchObject({ active: 0, heldBecause: 'no setter', setBy: s.owner.id, secret: 'known-to-the-owner' });
		inTransaction(() => endAccountAccess(s.owner.id, { apiKeys: true, cause: RESET_IN_A_TEST }));
		// Held already, for another reason: it keeps it (decision 4).
		expect(rowOf(nobodys.id)).toMatchObject({ active: 0, heldBecause: 'no setter', secret: 'known-to-the-owner' });

		const before = snapshotDb();
		expect((await put(s.admin, nobodys.id, { active: true, secret: 'mine' })).status).toBe(400);
		expectUnchanged(before, 'after a secret sent with the switch-on');
		const on = await put(s.admin, nobodys.id, { active: true });

		expect(on.status).toBe(200);
		expect(on.body.secret).toMatch(/^[0-9a-f]{64}$/);
		expect(rowOf(nobodys.id)).toMatchObject({ active: 1, heldBecause: null, setBy: s.admin.id, secret: on.body.secret });
		expect(rowOf(nobodys.id).secret).not.toBe('known-to-the-owner');
	});

	// Card 2923's code review (S4): an editor may not delete a webhook already off that an ending held.
	it('2923 R8. an editor’s DELETE of a webhook the owner had switched off, held once its setter’s access ends, is refused 403 with nothing written', async () => {
		const s = scene();
		const theirs = await hookOf(s, s.editor, 'paused');
		expect((await put(s.owner, theirs.id, { active: false })).status).toBe(200);
		inTransaction(() => endAccountAccess(s.editor.id, { apiKeys: true, cause: RESET_IN_A_TEST }));
		const second = makeUser({ username: 'second' });
		addBoardMember(s.board, second, 'editor');

		const before = snapshotDb();
		const refused = await api('DELETE', `/api/v1/webhooks/${theirs.id}`, { user: second });

		expect([refused.status, refused.body.message]).toEqual([403, HELD_OFF_DELETE]);
		expectUnchanged(before, "after an editor's delete refused");
	});

	/** The WARN for one webhook already off and now held (card 2923), word for word: never the address. */
	const heldLine = (hook: { id: number; boardId: number }, setter: SessionUser, cause: string) =>
		`Webhook ${hook.id} on board ${hook.boardId}, already switched off, is now held: the account that set it up (user ${setter.id}) ` +
		`had its access ended (${cause}). Switched on again by an owner of the board or an administrator, it is given a new secret.`;
	/** The held list's row in the owners' mail (card 2923, S1), host only. */
	const heldRow = (board: string, hook: { id: number }, host: string) =>
		`Board <strong>${board}</strong>: webhook ${hook.id} to <strong>${host}</strong>: already switched off; now held because the ` +
		'account that set it up had its access ended; switched on, it is given a new secret.';
	const NOTICE = 'A notice about webhooks on your boards';

	it.each([
		{ row: 'mixed: one switched off on A, one already off on B', mixed: true },
		{ row: 'held only: one already off on B', mixed: false }
	])('2923 case 3. told after the commit, $row: one mail to each owner of their own boards, the held listed apart; a WARN for each group', async ({ mixed }) => {
		const ann = makeUser({ username: 'ann' });
		const bea = makeUser({ username: 'bea' });
		const setter = makeUser({ username: 'samuel' });
		const a = makeBoard({ owner: ann, name: 'Board A' }).board;
		const b = makeBoard({ owner: bea, name: 'Board B' }).board;
		addBoardMember(b, ann, 'owner');
		const onA = mixed ? makeWebhook(a, { url: 'https://a.example.test/a-path?token=never-mailed', setBy: setter }) : null;
		const offB = makeWebhook(b, { url: 'https://b.example.test/b-path?token=never-mailed', setBy: setter, active: false });
		// The log names the account; the mail names the kind of action and nobody (card 2923's code review, S5).
		const cause = 'samuel set their password with an invite';
		sent.clear();

		inTransaction(() => {
			endAccountAccess(setter.id, { apiKeys: true, cause: { log: cause, mail: ENDING_IN_MAIL.invite } });
			// Nothing is told before the commit.
			expect(lines('WARN')).toEqual([]);
		});
		await sent.settle();

		expect(lines('WARN')).toEqual([
			...(onA ? [`Webhook ${onA.id} on board ${a.id} switched off: the account that set it up (user ${setter.id}) had its access ended (${cause}). It stays off until an owner of the board or an administrator switches it on.`] : []),
			heldLine(offB, setter, cause)
		]);
		// No setter's mail: one to each owner, Ann for both boards, Bea for hers.
		expect(sent.emails.map((mail) => [mail.to, mail.subject]).sort()).toEqual([
			[ann.email, NOTICE],
			[bea.email, NOTICE]
		]);
		const mailTo = (user: SessionUser) => sent.emails.find((mail) => mail.to === user.email)!;
		for (const mail of sent.emails) {
			expect(mail.html).toContain(NOTICE);
			expect(mail.html).toContain(`What caused it: ${escapeHtml(ENDING_IN_MAIL.invite)}.`);
			expect(mail.html).toContain(heldRow('Board B', offB, 'b.example.test'));
			for (const never of ['b-path', 'a-path', 'never-mailed', 'samuel']) expect(mail.html).not.toContain(never);
		}
		const switchedOffRow = (hook: { id: number }) =>
			`Board <strong>Board A</strong>: webhook ${hook.id} to <strong>a.example.test</strong>, switched off because the account that set it up had its access ended.`;
		if (onA) expect(mailTo(ann).html).toContain(switchedOffRow(onA));
		expect(mailTo(bea).html).not.toContain('Board A');
		expect(mailTo(bea).html).not.toContain('switched off because');
	});

	it('2923 case 4. 21 already-off webhooks over three boards held at one ending: the WARN names 20 and counts the rest; each owner one mail', async () => {
		const setter = makeUser({ username: 'setter' });
		const owners = [makeUser({ username: 'o1' }), makeUser({ username: 'o2' }), makeUser({ username: 'o3' })];
		const boardsOf = owners.map((owner, i) => makeBoard({ owner, name: `Board ${i + 1}` }).board);
		const held = [10, 10, 1].flatMap((n, i) =>
			Array.from({ length: n }, (_, j) => makeWebhook(boardsOf[i], { url: `https://h${i}.example.test/${j}`, setBy: setter, active: false }))
		);
		const cause = 'a reset in a test';
		sent.clear();

		inTransaction(() => endAccountAccess(setter.id, { apiKeys: true, cause: { log: cause, mail: cause } }));
		await sent.settle();

		const named = held
			.slice(0, 20)
			.map((hook) => `webhook ${hook.id} on board ${hook.boardId}: the account that set it up (user ${setter.id}) had its access ended`)
			.join('; ');
		expect(lines('WARN')).toEqual([
			`21 webhooks already switched off are now held (${cause}): ${named}; and 1 more. ` +
				'Each, switched on again by an owner of its board or an administrator, is given a new secret.'
		]);
		expect(sent.emails.map((mail) => mail.to).sort()).toEqual(owners.map((owner) => owner.email).sort());
		expect(sent.emails.every((mail) => mail.subject === NOTICE)).toBe(true);
	});

	// ─── Card 2325's other cases, to the switched-off state (card 2752) ───

	it('9b. tells the owner and an administrator why it was switched off, after a restart too, when the last delivery is forgotten', async () => {
		const s = scene();
		const theirs = makeWebhook(s.board, { url: 'https://hooks.example.test/e', setBy: s.editor });
		const owners = await hookOf(s, s.owner, 'o');
		sqlite.prepare('DELETE FROM board_members WHERE board_id = ? AND user_id = ?').run(s.board.id, s.editor.id);
		await event(s);

		for (const user of [s.owner, s.admin]) {
			for (const answer of await answersTo(s, user, theirs.id)) {
				expect(answer).toMatchObject({ active: false, pausedBecause: LOST });
				expect(answer.lastDelivery).toEqual({ at: expect.any(String), event: 'card.created', outcome: 'not-sent', status: null, reason: LOST_REASON });
			}
			for (const answer of await answersTo(s, user, owners.id)) expect(answer).toHaveProperty('pausedBecause', null);
		}

		// As a restart: the last delivery is forgotten, and why it was switched off is not.
		forgetDeliveries();
		for (const answer of await answersTo(s, s.owner, theirs.id)) {
			expect(answer).toMatchObject({ pausedBecause: LOST, lastDelivery: null });
		}
	});

	it("10b. gives pausedBecause where it gives the address: the owner, an administrator and a create's answer, and no viewer or editor", async () => {
		const s = scene();
		const viewer = makeUser({ username: 'viewer' });
		const remaining = makeUser({ username: 'remaining' });
		addBoardMember(s.board, viewer, 'viewer');
		addBoardMember(s.board, remaining, 'editor');
		const theirs = await hookOf(s, s.editor, 'e');
		await takeOff(s);

		for (const user of [viewer, remaining]) {
			for (const answer of await answersTo(s, user, theirs.id)) {
				for (const key of ['pausedBecause', 'url', 'secret', 'lastDelivery']) expect(answer, key).not.toHaveProperty(key);
			}
		}
		const edited = await put(remaining, theirs.id, { events: ['card.created'] });
		expect(edited.status).toBe(200);
		for (const key of ['pausedBecause', 'url', 'secret', 'lastDelivery']) expect(edited.body, key).not.toHaveProperty(key);

		for (const user of [s.owner, s.admin]) {
			for (const answer of await answersTo(s, user, theirs.id)) expect(answer).toHaveProperty('pausedBecause', LOST);
		}

		// The create's answer, to an editor too: its caller is its setter, and can open the board. Another receiver than
		// the one held off, which an editor may not add to (the code review's CS2).
		for (const user of [remaining, s.owner]) {
			const made = await api('POST', `/api/v1/boards/${s.board.id}/webhooks`, { user, body: { url: `https://new-${user.id}.example.test/x` } });
			expect(made.status).toBe(201);
			expect(made.body).toHaveProperty('pausedBecause', null);
		}
	});

	it('11b. one switched off by a hold and then sent active false stays held, and says so', async () => {
		const s = scene();
		const theirs = await hookOf(s, s.editor, 'e');
		await takeOff(s);

		const off = await put(s.owner, theirs.id, { active: false });
		expect(off.status).toBe(200);
		expect(off.body).toMatchObject({ active: false, pausedBecause: LOST });
		expectHeldOff(theirs.id);
		expect(await event(s)).toEqual([]);
	});

	it('12b. writes one WARN, at the write, naming the webhook, the board and the setter, and not the address; the events after it write none', async () => {
		const s = scene();
		const theirs = await hookOf(s, s.editor, 'e-secret-path');
		await takeOff(s);

		await event(s);
		await event(s);

		expect(lines('WARN')).toEqual([offLine(theirs, s.board.id, s.editor, 'editor was taken off the board by owner')]);
		expect(lines('WARN')[0]).not.toContain('e-secret-path');
		expect(lines('WARN')[0]).not.toContain('hooks.example.test');
	});

	it('13b. a webhook switched off is not dispatched: an event writes nothing for it', async () => {
		const s = scene();
		await hookOf(s, s.editor, 'e');
		const owners = await hookOf(s, s.owner, 'o');
		await takeOff(s);
		const card = makeCard(s.cols['To Do']);
		const logRows = () => (sqlite.prepare('SELECT COUNT(*) AS n FROM system_logs').get() as { n: number }).n;
		sent.clear();

		const before = snapshotDb();
		const logged = logRows();
		dispatchWebhook(s.board.id, 'card.created', { cardId: card.id });
		await sent.settle();

		expectUnchanged(before, 'after an event');
		expect(logRows()).toBe(logged);
		expect(sent.webhooks.map((w) => w.url)).toEqual([owners.url]);
	});

	it('14. an editor made a viewer can still open the board, so their webhook is sent (a guard)', async () => {
		const s = scene();
		const theirs = await hookOf(s, s.editor, 'e');
		const owners = await hookOf(s, s.owner, 'o');

		await shareBack(s, s.editor, 'viewer');

		expectOn(theirs.id);
		expect(await event(s)).toEqual([theirs.url, owners.url]);
	});

	it('15b. gives pausedBecause null for a webhook off with no hold, whoever set it', async () => {
		const s = scene();
		const nobodysOff = makeWebhook(s.board, { setBy: null, active: false });
		const ownersOff = makeWebhook(s.board, { active: false });

		for (const hook of [nobodysOff, ownersOff]) {
			for (const answer of await answersTo(s, s.owner, hook.id)) expect(answer).toMatchObject({ active: false, pausedBecause: null });
		}
	});

	// ─── The review's (2026-10-20) ───

	it('16b. switches off a webhook sent through deliver on its own, with no dispatch and no cache (decision 10)', async () => {
		const s = scene();
		const outsider = makeUser({ username: 'outsider' });
		const hook = makeWebhook(s.board, { url: 'https://hooks.example.test/direct', setBy: outsider });

		deliver(hook, 'card.created', '{}');
		await sent.settle();

		expect(sent.webhooks).toEqual([]);
		expect(deliveryResultFor(hook)).toMatchObject({ outcome: 'not-sent', status: null, reason: LOST_REASON });
		expectHeldOff(hook.id);
		expect(lines('WARN')).toEqual([offLine(hook, s.board.id, outsider, 'found when an event was sent')]);
	});

	it("17b. never carries one board's answer to another through a shared cache", async () => {
		const s = scene();
		const outsider = makeUser({ username: 'outsider' });
		const own = makeBoard({ owner: outsider }).board;
		const onTheirs = makeWebhook(own, { url: 'https://hooks.example.test/theirs' });
		const onOwners = makeWebhook(s.board, { url: 'https://hooks.example.test/owners', setBy: outsider });
		const shared = new Map<string, boolean>();

		deliver(onTheirs, 'card.created', '{}', undefined, undefined, shared);
		deliver(onOwners, 'card.created', '{}', undefined, undefined, shared);
		await sent.settle();

		expect(sent.webhooks.map((w) => w.url)).toEqual([onTheirs.address]);
		expect(deliveryResultFor(onOwners)).toMatchObject({ outcome: 'not-sent', reason: LOST_REASON });
		expectOn(onTheirs.id);
		expectHeldOff(onOwners.id);
	});

	it('18b. switches off a webhook whose setter names no account, as after a restore, with the lost-setter sentence', async () => {
		const s = scene();
		const owners = await hookOf(s, s.owner, 'o');
		const dangling = makeWebhook(s.board, { url: 'https://hooks.example.test/dangling' });
		// A restored row can name an account this database never had: the key is not asked here.
		sqlite.pragma('foreign_keys = OFF');
		try {
			sqlite.prepare('UPDATE webhooks SET set_by = 999999 WHERE id = ?').run(dangling.id);
		} finally {
			sqlite.pragma('foreign_keys = ON');
		}

		expect(await event(s)).toEqual([owners.url]);
		expectHeldOff(dangling.id);
		for (const answer of await answersTo(s, s.owner, dangling.id)) {
			expect(answer).toMatchObject({ active: false, pausedBecause: LOST });
			expect(answer.lastDelivery).toMatchObject({ outcome: 'not-sent', reason: LOST_REASON });
		}
	});
});

describe('a switch-off and the write that caused it are one (card 2752, E8)', () => {
	it('24. (2752 case 24) each write of a share removal failed in turn leaves the share and the webhook as they were, with no mail and no WARN; on success both come after the commit', async () => {
		/** The WARN lines after each run of the request: the untouched run first. */
		const warned: number[] = [];
		const run = await eachWriteInTurn({
			build: () => {
				makeSmtp();
				const owner = makeUser({ username: 'owner' });
				const editor = makeUser({ username: 'editor' });
				const { board } = makeBoard({ owner });
				addBoardMember(board, editor, 'editor');
				const hook = makeWebhook(board, { setBy: editor });
				return { owner, editor, board, hook };
			},
			request: async ({ owner, editor, board }) => {
				try {
					return await api('DELETE', `/api/boards/${board.id}/share`, { user: owner, body: { type: 'user', targetId: editor.id } });
				} finally {
					warned.push(lines('WARN').length);
				}
			},
			afterSuccess: ({ hook }, result, done) => {
				expect(result.status).toBe(200);
				expect(sqlite.prepare('SELECT active, held_because AS heldBecause FROM webhooks WHERE id = ?').get(hook.id)).toEqual({
					active: 0,
					heldBecause: 'setter cannot open'
				});
				expect(done.filter((effect) => effect.kind === 'email').map((effect) => (effect as { subject: string }).subject)).toEqual([
					'A webhook on your board was switched off'
				]);
			}
		});

		expect(run.writes.length).toBeGreaterThanOrEqual(2);
		expect(warned).toEqual([1, ...run.writes.map(() => 0)]);
	});
});

// ─── Card 2893 ───────────────────────────────────────────────────────────

describe('a webhook whose API key ended is switched off for good (card 2893)', () => {
	/** `pausedBecause` for a webhook switched off because its key ended, word for word (4.3). */
	const KEY_ENDED =
		"This was switched off because the API key that set it up ended: it expired, passed its deadline, was deleted or is not the setter's; " +
		'or, for a webhook set up before keys were recorded, the account that set it up has no working key from then. To keep it, ' +
		'switch it on with your own key, which makes you its setter and gives it a new secret, given in that answer and readable by ' +
		"the board's owner or an administrator, and update the receiver.";
	const KEY_ENDED_REASON = 'Not sent: the API key that set it up has ended';

	let sent: Effects;
	beforeEach(() => {
		makeSmtp();
		sent = effects();
	});
	afterEach(() => sent.restore());

	/** Owner O's board, with editor E a member. */
	function scene() {
		const owner = makeUser({ username: 'owner' });
		const editor = makeUser({ username: 'editor' });
		const fixture = makeBoard({ owner });
		addBoardMember(fixture.board, editor, 'editor');
		return { owner, editor, ...fixture };
	}
	type Scene = ReturnType<typeof scene>;

	/** The credential the gate records for a request made with this key's row (E15). */
	const byKey = (id: number) => ({ kind: 'api key' as const, id });

	/** A webhook made by `user`'s own POST with the key `keyId`. */
	async function hookWith(s: Scene, user: SessionUser, keyId: number, name: string) {
		const made = await api('POST', `/api/v1/boards/${s.board.id}/webhooks`, {
			user,
			credential: byKey(keyId),
			body: { url: `https://hooks.example.test/${name}` }
		});
		expect(made.status).toBe(201);
		return made.body as { id: number; url: string; secret: string };
	}

	let raised = 0;
	/** O raises a card through the API, with no key: the addresses it was delivered to, in order. */
	async function event(s: Scene): Promise<string[]> {
		sent.clear();
		const res = await api('POST', `/api/v1/boards/${s.board.id}/cards`, {
			user: s.owner,
			body: { title: `2893 card ${++raised}`, columnId: s.cols['To Do'].id }
		});
		expect(res.status).toBe(201);
		await sent.settle();
		return sent.webhooks.map((w) => w.url);
	}

	/** The webhook's row as stored: on or off, why, its setter and the key it records, its secret opened (card 2898). */
	const rowOf = (id: number) => ({
		...(sqlite
			.prepare(
				'SELECT active, held_because AS heldBecause, set_by AS setBy, set_by_key AS setByKey, set_with_key AS setWithKey, secret FROM webhooks WHERE id = ?'
			)
			.get(id) as { active: number; heldBecause: string | null; setBy: number | null; setByKey: number | null; setWithKey: number | null; secret: string }),
		secret: readOpened('webhooks', id)!
	});

	const expectKeyEnded = (id: number) => expect(rowOf(id)).toMatchObject({ active: 0, heldBecause: 'key ended' });
	const expectOn = (id: number) => expect(rowOf(id)).toMatchObject({ active: 1, heldBecause: null });

	/** The WARN a switch-off for an ended key writes, word for word (4.3): the key's id, never its prefix or the address. */
	const keyLine = (hookId: number, boardId: number, keyId: number | null, setter: SessionUser, cause: string) =>
		`Webhook ${hookId} on board ${boardId} switched off: the API key that set it up (${keyId === null ? 'no key recorded' : `key ${keyId}`}, ` +
		`user ${setter.id}) has ended (${cause}). It stays off until an owner of the board or an administrator switches it on.`;

	/** The mails that say webhooks were switched off. */
	const offMails = () => sent.emails.filter((mail) => / switched off$/.test(mail.subject));

	const nameOf = (keyId: number) => sqlite.prepare('SELECT name FROM api_keys WHERE id = ?').pluck().get(keyId) as string;
	/** The mail to the setter of a webhook whose key ended, in words of their own (S13; the ruling on S1's departure 10). */
	const setterMails = () => sent.emails.filter((mail) => mail.subject === 'A webhook you set was switched off');
	const revoke = (user: SessionUser, keyId: number) => api('DELETE', `/api/account/api-keys/${keyId}`, { user });
	const expire = (keyId: number) => sqlite.prepare("UPDATE api_keys SET expires_at = '2026-01-01 00:00:00' WHERE id = ?").run(keyId);

	it('1. a create records the key it was made with, and no answer shows it', async () => {
		const s = scene();
		const k = makeApiKeyRow(s.editor);

		const made = await api('POST', `/api/v1/boards/${s.board.id}/webhooks`, {
			user: s.editor,
			credential: byKey(k.id),
			body: { url: 'https://hooks.example.test/one' }
		});

		expect(made.status).toBe(201);
		expect(rowOf(made.body.id)).toMatchObject({ setBy: s.editor.id, setByKey: k.id, setWithKey: 1 });
		const listed = await api('GET', `/api/v1/boards/${s.board.id}/webhooks`, { user: s.owner });
		const one = await api('GET', `/api/v1/webhooks/${made.body.id}`, { user: s.owner });
		for (const answer of [made.body, listed.body[0], one.body]) {
			expect(answer).not.toHaveProperty('setByKey');
			expect(answer).not.toHaveProperty('setWithKey');
			expect(JSON.stringify(answer)).not.toContain(k.key);
		}
	});

	it.each([
		{ row: 'a new address: the caller and their key recorded', body: { url: 'https://hooks.example.test/moved' }, recorded: 'L' as const },
		{ row: 'events alone: the key it had kept', body: { events: ['card.created'] }, recorded: 'K' as const }
	])('2. a change by the owner with key L, $row', async ({ body, recorded }) => {
		const s = scene();
		const k = makeApiKeyRow(s.editor);
		const l = makeApiKeyRow(s.owner);
		const hook = await hookWith(s, s.editor, k.id, 'two');

		const changed = await api('PUT', `/api/v1/webhooks/${hook.id}`, { user: s.owner, credential: byKey(l.id), body });

		expect(changed.status).toBe(200);
		expect(rowOf(hook.id)).toMatchObject(
			recorded === 'L' ? { setBy: s.owner.id, setByKey: l.id, setWithKey: 1 } : { setBy: s.editor.id, setByKey: k.id, setWithKey: 1 }
		);
	});

	it.each([
		{ row: 'an API key: 1 and its id; sent', how: 'key' as const },
		{ row: 'a session: 1 and no key; switched off at the next event', how: 'session' as const },
		{ row: 'none at all (a test): 0 and no key; sent', how: 'none' as const }
	])('3. what each credential records (S11): $row', async ({ how }) => {
		const s = scene();
		const k = makeApiKeyRow(s.editor);
		const credential =
			how === 'key'
				? { credential: byKey(k.id) }
				: how === 'session'
					? { credential: { kind: 'session' as const, hash: sessionTokenHash(makeSession(s.editor)) } }
					: {};

		const made = await api('POST', `/api/v1/boards/${s.board.id}/webhooks`, {
			user: s.editor,
			...credential,
			body: { url: 'https://hooks.example.test/three' }
		});
		expect(made.status).toBe(201);

		expect(rowOf(made.body.id)).toMatchObject(
			how === 'key' ? { setByKey: k.id, setWithKey: 1 } : how === 'session' ? { setByKey: null, setWithKey: 1 } : { setByKey: null, setWithKey: 0 }
		);
		const delivered = await event(s);
		if (how === 'session') {
			expect(delivered).toEqual([]);
			expectKeyEnded(made.body.id);
			expect(lines('WARN')).toEqual([keyLine(made.body.id, s.board.id, null, s.editor, 'found when an event was sent')]);
		} else {
			expect(delivered).toEqual([made.body.url]);
			expectOn(made.body.id);
		}
	});

	it("4. revoking K switches off what it set in the same write: the answer counts it, one WARN, one mail each to the owner and the setter; another live key's stays on", async () => {
		const s = scene();
		const k = makeApiKeyRow(s.editor);
		const k2 = makeApiKeyRow(s.editor);
		const theirs = await hookWith(s, s.editor, k.id, 'k-secret-path');
		const kept = await hookWith(s, s.editor, k2.id, 'k2');
		const cause = `API key #${k.id} was revoked by editor`;
		const name = nameOf(k.id);
		sent.clear();

		const res = await revoke(s.editor, k.id);
		await sent.settle();

		expect(res.status).toBe(200);
		expect(res.body).toEqual({ success: true, webhooksSwitchedOff: 1, revealedWebhooksHeld: 0 });
		expect(rowOf(theirs.id)).toMatchObject({ active: 0, heldBecause: 'key ended', setByKey: null, setWithKey: 1 });
		expectOn(kept.id);
		expect(lines('WARN')).toEqual([keyLine(theirs.id, s.board.id, null, s.editor, cause)]);
		// The owner's mail, and the setter's in words of their own.
		expect(offMails().map((mail) => [mail.to, mail.subject]).sort()).toEqual(
			[
				[s.owner.email, 'A webhook on your board was switched off'],
				[s.editor.email, 'A webhook you set was switched off']
			].sort()
		);
		expect(setterMails()[0].html).toContain("ask the board's owner");
		for (const mail of offMails()) {
			// The mail names no account (card 2947, R12): the key and its account are in the WARN alone.
			expect(mail.html).toContain('What caused it: an API key was revoked by its holder.');
			expect(mail.html).not.toContain(cause);
			expect(mail.html).toContain(`webhook ${theirs.id} to <strong>hooks.example.test</strong>`);
			expect(mail.html).not.toContain('k-secret-path');
		}
		// The key by its id, never its name (the ruling on S1's departure 9).
		for (const text of [...lines('WARN'), ...offMails().map((mail) => mail.html)]) expect(text).not.toContain(name);
		expect(await event(s)).toEqual([kept.url]);
	});

	it("5. the revoke's count is known first (S13): the key list gives each key's webhooks that are on, and the page's confirm says it (page-failures.test.ts)", async () => {
		const s = scene();
		const k = makeApiKeyRow(s.editor);
		const k2 = makeApiKeyRow(s.editor);
		await hookWith(s, s.editor, k.id, 'a');
		await hookWith(s, s.editor, k.id, 'b');
		const off = await hookWith(s, s.editor, k.id, 'off');
		expect((await api('PUT', `/api/v1/webhooks/${off.id}`, { user: s.editor, credential: byKey(k.id), body: { active: false } })).status).toBe(200);
		await hookWith(s, s.editor, k2.id, 'other');
		// Another account's key: its count is not in this list.
		await hookWith(s, s.owner, makeApiKeyRow(s.owner).id, 'owners');

		const listed = await api('GET', '/api/account/api-keys', { user: s.editor });

		expect(listed.status).toBe(200);
		expect(listed.body.map((key: { id: number; webhooks: number }) => [key.id, key.webhooks])).toEqual([
			[k.id, 2],
			[k2.id, 1]
		]);
	});

	it.each([
		{ row: "the account's last working key from before the release: its count adds the webhooks from then, and the revoke switches them off", second: false },
		{ row: 'another working key from before the release left: neither counted nor switched off', second: true }
	])("CS4. a key from before keys were recorded, $row (the code review's CS4)", async ({ second }) => {
		const s = scene();
		sqlite.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('webhook_keys_recorded_at', '2026-06-01 00:00:00')").run();
		const oldKey = (user: SessionUser) => {
			const k = makeApiKeyRow(user);
			sqlite.prepare("UPDATE api_keys SET created_at = '2026-01-01 00:00:00' WHERE id = ?").run(k.id);
			return k;
		};
		const k0 = oldKey(s.editor);
		const k1 = second ? oldKey(s.editor) : undefined;
		const kNew = makeApiKeyRow(s.editor);
		const recorded = await hookWith(s, s.editor, k0.id, 'recorded');
		const before = makeWebhook(s.board, { setBy: s.editor, setWithKey: null });
		// One from before the release already switched off is not counted.
		makeWebhook(s.board, { setBy: s.editor, setWithKey: null, active: false });

		const listed = await api('GET', '/api/account/api-keys', { user: s.editor });
		const counts = Object.fromEntries(listed.body.map((key: { id: number; webhooks: number }) => [key.id, key.webhooks]));
		expect(counts).toEqual({ [k0.id]: second ? 1 : 2, ...(k1 ? { [k1.id]: 0 } : {}), [kNew.id]: 0 });

		const revoked = await revoke(s.editor, k0.id);
		expect(revoked.body).toEqual({ success: true, webhooksSwitchedOff: second ? 1 : 2, revealedWebhooksHeld: 0 });
		expectKeyEnded(recorded.id);
		if (second) expectOn(before.id);
		else expectKeyEnded(before.id);
	});

	it('6. K expired after the create: an event fired by another caller switches it off, unsent', async () => {
		const s = scene();
		const k = makeApiKeyRow(s.editor);
		const hook = await hookWith(s, s.editor, k.id, 'six');
		expect(await event(s)).toEqual([hook.url]);

		expire(k.id);

		expect(await event(s)).toEqual([]);
		expectKeyEnded(hook.id);
		expect(lines('WARN')).toEqual([keyLine(hook.id, s.board.id, k.id, s.editor, 'found when an event was sent')]);
		const one = await api('GET', `/api/v1/webhooks/${hook.id}`, { user: s.owner });
		expect(one.body).toMatchObject({ active: false, pausedBecause: KEY_ENDED, lastDelivery: { outcome: 'not-sent', reason: KEY_ENDED_REASON } });
	});

	it('7. K deleted by a path that does not sweep (the row deleted directly): switched off at the next event', async () => {
		const s = scene();
		const k = makeApiKeyRow(s.editor);
		const hook = await hookWith(s, s.editor, k.id, 'seven');

		sqlite.prepare('DELETE FROM api_keys WHERE id = ?').run(k.id);

		expect(rowOf(hook.id)).toMatchObject({ active: 1, setByKey: null, setWithKey: 1 });
		expect(await event(s)).toEqual([]);
		expectKeyEnded(hook.id);
		expect(lines('WARN')).toEqual([keyLine(hook.id, s.board.id, null, s.editor, 'found when an event was sent')]);
	});

	it("8. a recorded key of another account (S12): the editor's webhook recording the owner's live key is switched off at the next event", async () => {
		const s = scene();
		const owners = makeApiKeyRow(s.owner);
		const hook = makeWebhook(s.board, { setBy: s.editor, setWithKey: true, setByKey: owners.id });

		expect(await event(s)).toEqual([]);
		expectKeyEnded(hook.id);
		expect(lines('WARN')).toEqual([keyLine(hook.id, s.board.id, owners.id, s.editor, 'found when an event was sent')]);
	});

	it.each([
		{ row: 'its only key from before has expired: off', key: { created: '2026-01-01 00:00:00', expires: '2026-02-01 00:00:00' }, sent: false },
		{ row: 'a live key from before: sent', key: { created: '2026-01-01 00:00:00', expires: undefined }, sent: true },
		{ row: 'only a live key made after it: off', key: { created: '2026-07-01 00:00:00', expires: undefined }, sent: false }
	])('9. a webhook set up before keys were recorded (S9, E17), $row', async ({ key, sent: isSent }) => {
		const s = scene();
		sqlite.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('webhook_keys_recorded_at', '2026-06-01 00:00:00')").run();
		const k = makeApiKeyRow(s.editor, key.expires === undefined ? {} : { expiresAt: key.expires });
		sqlite.prepare('UPDATE api_keys SET created_at = ? WHERE id = ?').run(key.created, k.id);
		const hook = makeWebhook(s.board, { setBy: s.editor, setWithKey: null });

		const delivered = await event(s);

		if (isSent) {
			expect(delivered).toEqual([hook.address]);
			expectOn(hook.id);
		} else {
			expect(delivered).toEqual([]);
			expectKeyEnded(hook.id);
			expect(lines('WARN')).toEqual([
				`Webhook ${hook.id} on board ${s.board.id} switched off: the account that set it up (user ${s.editor.id}) has no working API key ` +
					'from before keys were recorded (found when an event was sent). It stays off until an owner of the board or an administrator switches it on.'
			]);
		}
	});

	it('10. switched on again by the owner with key M: on, M recorded, a new secret answered; M then revoked, off again', async () => {
		const s = scene();
		const k = makeApiKeyRow(s.editor);
		const m = makeApiKeyRow(s.owner);
		const hook = await hookWith(s, s.editor, k.id, 'ten');
		expect((await revoke(s.editor, k.id)).status).toBe(200);
		expectKeyEnded(hook.id);

		const on = await api('PUT', `/api/v1/webhooks/${hook.id}`, { user: s.owner, credential: byKey(m.id), body: { active: true } });

		expect(on.status).toBe(200);
		expect(on.body).toMatchObject({ active: true, pausedBecause: null });
		expect(on.body.secret).toMatch(/^[0-9a-f]{64}$/);
		expect(rowOf(hook.id)).toEqual({ active: 1, heldBecause: null, setBy: s.owner.id, setByKey: m.id, setWithKey: 1, secret: on.body.secret });
		expect(await event(s)).toEqual([hook.url]);

		const revoked = await revoke(s.owner, m.id);
		expect(revoked.body).toEqual({ success: true, webhooksSwitchedOff: 1, revealedWebhooksHeld: 0 });
		expectKeyEnded(hook.id);
		expect(await event(s)).toEqual([]);
	});

	it('11. at start: a webhook whose K expired is switched off by the start-up sweep; a second start changes nothing', async () => {
		const s = scene();
		const k = makeApiKeyRow(s.editor);
		const hook = await hookWith(s, s.editor, k.id, 'eleven');
		const owners = makeWebhook(s.board);
		expire(k.id);
		sent.clear();

		expect(switchOffHeldWebhooksAtStart('on', false)).toBe(1);
		await sent.settle();

		expectKeyEnded(hook.id);
		expectOn(owners.id);
		expect(lines('WARN')).toEqual([keyLine(hook.id, s.board.id, k.id, s.editor, 'found when the server started')]);
		expect(offMails().map((mail) => mail.to).sort()).toEqual([s.owner.email, s.editor.email].sort());

		sent.clear();
		expect(switchOffHeldWebhooksAtStart('on', false)).toBe(0);
		await sent.settle();
		expect(lines('WARN')).toHaveLength(1);
		expect(sent.emails).toEqual([]);
	});

	// Card 2923 (case 15, S3): the one-time pass at start over webhooks already off whose setter is disabled or not recorded.
	// Card 2923 (case 15, S3), as its code review ruled (S2, E3): every already-off webhook once, those of gone setters at every start.
	const heldRowsOf = (...ids: number[]) =>
		ids.map((id) => sqlite.prepare('SELECT active, held_because AS heldBecause, held_at AS heldAt FROM webhooks WHERE id = ?').get(id));
	const alreadyOffFlag = () => sqlite.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(WEBHOOKS_ALREADY_OFF_HELD);
	const STAMPED = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/;

	it('2923 case 15. at the first start, holds every already-off webhook with no hold, whoever set it, leaves one held already; one WARN, the flag; later starts hold only those of a disabled setter or none', async () => {
		const owner = makeUser({ username: 'owner' });
		const gone = makeUser({ username: 'gone' });
		const here = makeUser({ username: 'here' });
		const board = makeBoard({ owner }).board;
		const ofGone = makeWebhook(board, { url: 'https://gone.example.test/x', setBy: gone, active: false });
		const ofNobody = makeWebhook(board, { url: 'https://nobody.example.test/x', setBy: null, active: false });
		const ofHere = makeWebhook(board, { url: 'https://here.example.test/x', setBy: here, active: false });
		const on = makeWebhook(board, { url: 'https://on.example.test/x', setBy: here });
		const alreadyHeld = makeWebhook(board, { url: 'https://held.example.test/x', setBy: gone, active: false, heldBecause: 'key ended' });
		sqlite.prepare("UPDATE users SET disabled_at = '2099-01-02 09:00:00' WHERE id = ?").run(gone.id);
		const untouched = heldRowsOf(on.id, alreadyHeld.id);
		sent.clear();

		expect(holdAlreadyOffWebhooksAtStart()).toBe(3);
		await sent.settle();

		for (const [row] of [heldRowsOf(ofGone.id), heldRowsOf(ofNobody.id), heldRowsOf(ofHere.id)]) {
			expect(row).toMatchObject({ active: 0, heldBecause: 'setter access ended', heldAt: expect.stringMatching(STAMPED) });
		}
		expect(heldRowsOf(on.id, alreadyHeld.id)).toEqual(untouched);
		expect(lines('WARN')).toEqual([
			'3 webhook(s) already switched off with no hold are now held, whoever set them up (found when the server started, once): ' +
				`webhook ${ofGone.id} on board ${board.id} (user ${gone.id}); webhook ${ofNobody.id} on board ${board.id} (no setter recorded); ` +
				`webhook ${ofHere.id} on board ${board.id} (user ${here.id}). ` +
				"Each, switched on again by an owner of its board or an administrator, is given a new secret. Their boards' owners were not mailed."
		]);
		expect(sent.emails).toEqual([]);
		expect(typeof alreadyOffFlag()).toBe('string');

		// A later start: the flag is there, so only those of a disabled setter or none are held; an enabled setter's stays.
		const laterNobody = makeWebhook(board, { url: 'https://later.example.test/x', setBy: null, active: false });
		const laterHere = makeWebhook(board, { url: 'https://later-here.example.test/x', setBy: here, active: false });
		expect(holdAlreadyOffWebhooksAtStart()).toBe(1);
		expect(heldRowsOf(laterNobody.id)[0]).toMatchObject({ heldBecause: 'setter access ended' });
		expect(heldRowsOf(laterHere.id)[0]).toMatchObject({ heldBecause: null });
		expect(lines('WARN')[1]).toBe(
			'1 webhook(s) already switched off, whose setter is disabled or not recorded, are now held (found when the server started): ' +
				`webhook ${laterNobody.id} on board ${board.id} (no setter recorded). ` +
				"Each, switched on again by an owner of its board or an administrator, is given a new secret. Their boards' owners were not mailed."
		);

		// And one that holds nothing writes nothing, and says nothing (E3).
		const before = snapshotDb();
		expect(holdAlreadyOffWebhooksAtStart()).toBe(0);
		expectUnchanged(before, 'after a start with nothing to hold');
		expect(lines('WARN')).toHaveLength(2);
	});

	// Card 2923's code review (S4, E6): the failure paths.
	it('2923 R8. a hold that fails at start is said at WARN, holds nothing and writes no flag, and the next start holds them', async () => {
		const owner = makeUser({ username: 'owner' });
		const off = makeWebhook(makeBoard({ owner }).board, { url: 'https://off.example.test/x', setBy: owner, active: false });
		const before = snapshotDb();
		const prepare = sqlite.prepare.bind(sqlite);
		const failing = vi.spyOn(sqlite, 'prepare').mockImplementation(((source: string) => {
			if (source.includes("held_because = 'setter access ended'") && source.includes('? = 1')) throw new Error('disk I/O error');
			return prepare(source);
		}) as typeof sqlite.prepare);

		try {
			expect(holdAlreadyOffWebhooksAtStart()).toBeNull();
		} finally {
			failing.mockRestore();
		}

		expectUnchanged(before, 'after a hold that failed');
		expect(alreadyOffFlag()).toBeUndefined();
		expect(lines('WARN')).toEqual(['The webhooks already switched off with no hold could not be held at start: disk I/O error. The next start tries again.']);

		expect(holdAlreadyOffWebhooksAtStart()).toBe(1);
		expect(heldRowsOf(off.id)[0]).toMatchObject({ heldBecause: 'setter access ended' });
		expect(typeof alreadyOffFlag()).toBe('string');
	});

	it('2923 R11. a WARN that fails after the hold commits leaves the hold and the flag, says no failure of the hold, and returns the count', async () => {
		const owner = makeUser({ username: 'owner' });
		const off = makeWebhook(makeBoard({ owner }).board, { url: 'https://off.example.test/x', setBy: owner, active: false });
		const warn = vi.spyOn(webhooksLog, 'warn').mockImplementation(() => {
			throw new Error('the log is full');
		});

		try {
			expect(holdAlreadyOffWebhooksAtStart()).toBe(1);
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}

		expect(heldRowsOf(off.id)[0]).toMatchObject({ heldBecause: 'setter access ended' });
		expect(typeof alreadyOffFlag()).toBe('string');
		expect(lines('WARN').filter((line) => line.includes('could not be held'))).toEqual([]);
	});

	it.each([
		{ row: 'where the schedulers run: one WARN a webhook, one mail to the owner with each date, the flag; a second start sends nothing', how: 'mailed' as const },
		{ row: 'where they do not: WARN lines only, no mail, no flag', how: 'schedulers off' as const },
		{ row: 'with no mail set up: WARN lines and one more, no mail, the flag written', how: 'no mail' as const },
		{ row: 'with the mail refused: WARN lines and one more, no flag, so the next start says it again', how: 'refused' as const }
	])('12. the one-time announcement of webhooks set up before keys were recorded (D6), $row', async ({ how }) => {
		const s = scene();
		sqlite.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('webhook_keys_recorded_at', '2026-06-01 00:00:00')").run();
		const old = (user: SessionUser, opts: { expiresAt?: string; deadlineAt?: string }) => {
			const k = makeApiKeyRow(user, opts.expiresAt === undefined ? {} : { expiresAt: opts.expiresAt });
			sqlite.prepare("UPDATE api_keys SET created_at = '2026-01-01 00:00:00', deadline_at = ? WHERE id = ?").run(opts.deadlineAt ?? null, k.id);
		};
		// Ends far ahead of any day the suite runs (the code review's CR2). The editor's latest end among three keys,
		// each key's end the earlier of its expiry and its deadline (CR5): 2099-05-01, from the key with both, not its
		// later expiry; the owner's: a key with neither.
		old(s.editor, { expiresAt: '2099-03-01 00:00:00' });
		old(s.editor, { deadlineAt: '2099-01-10 00:00:00' });
		old(s.editor, { expiresAt: '2099-12-01 00:00:00', deadlineAt: '2099-05-01 00:00:00' });
		old(s.owner, {});
		// One from before the release held now, its setter's only key from then ended: left out, as the start's sweep
		// that follows switches it off and tells the owners (CR5).
		const lapsed = makeUser({ username: 'lapsed' });
		addBoardMember(s.board, lapsed, 'editor');
		old(lapsed, { expiresAt: '2026-02-01 00:00:00' });
		const editors = makeWebhook(s.board, { url: 'https://hooks.example.test/e-secret-path', setBy: s.editor, setWithKey: null });
		const owners = makeWebhook(s.board, { setBy: s.owner, setWithKey: null });
		const heldNow = makeWebhook(s.board, { setBy: lapsed, setWithKey: null });
		makeWebhook(s.board);
		if (how === 'no mail') sqlite.prepare("DELETE FROM settings WHERE key LIKE 'smtp_%'").run();
		if (how === 'refused') {
			sent.restore();
			sent = effects({ refuseMailTo: [s.owner.email] });
		}
		const flag = () => sqlite.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(WEBHOOKS_BEFORE_KEYS_ANNOUNCED);
		const announced = [
			`Webhook ${editors.id} on board ${s.board.id} was set up before API keys were recorded (user ${s.editor.id}): it stops at the earliest ` +
				'2099-05-01 00:00:00 UTC; later if that account keeps or replaces a key from before the release. To keep it, an owner of the board or an administrator re-saves it with a key.',
			`Webhook ${owners.id} on board ${s.board.id} was set up before API keys were recorded (user ${s.owner.id}): it stops on no set ` +
				'date, as a key of that account from then has neither an expiry nor a deadline. To keep it, an owner of the board or an administrator re-saves it with a key.'
		];
		sent.clear();

		const answer = await announceWebhooksBeforeKeys(how === 'schedulers off' ? 'off' : 'on', false);
		await sent.settle();

		for (const line of lines('WARN')) expect(line).not.toContain(`Webhook ${heldNow.id} `);
		if (how === 'mailed') {
			expect(answer).toBe(2);
			expect(lines('WARN')).toEqual(announced);
			expect(sent.emails.map((mail) => mail.to)).toEqual([s.owner.email]);
			const html = sent.emails[0].html;
			expect(html).toContain(
				`webhook ${editors.id} to <strong>hooks.example.test</strong>, stops at the earliest 2099-05-01 00:00:00 (UTC); later if that account keeps or replaces a key from before the release.`
			);
			expect(html).toContain(`webhook ${owners.id} to <strong>hooks.example.test</strong>, no date`);
			expect(html).not.toContain(`webhook ${heldNow.id} `);
			expect(html).toContain('re-save it with your key');
			expect(html).not.toContain('e-secret-path');
			expect(flag()).toEqual(expect.any(String));

			sent.clear();
			expect(await announceWebhooksBeforeKeys('on', false)).toBe(0);
			await sent.settle();
			expect(sent.emails).toEqual([]);
			expect(lines('WARN')).toEqual(announced);
		} else if (how === 'schedulers off') {
			expect(answer).toBeNull();
			expect(lines('WARN')).toEqual([
				...announced,
				'The owners of the boards of the 2 webhook(s) set up before API keys were recorded were not mailed, as the schedulers are off ' +
					'(SCHEDULERS=off). The lines above name each; the first start that runs the schedulers mails them.'
			]);
			expect(sent.emails).toEqual([]);
			expect(flag()).toBeUndefined();
		} else if (how === 'no mail') {
			expect(answer).toBe(2);
			expect(lines('WARN')).toEqual([
				...announced,
				'The owners of the boards of the 2 webhook(s) set up before API keys were recorded were not mailed, as mail is not set up. The lines above name each.'
			]);
			expect(sent.emails).toEqual([]);
			expect(flag()).toEqual(expect.any(String));
		} else {
			expect(answer).toBeNull();
			expect(sent.refusedMail.map((mail) => mail.to)).toEqual([s.owner.email]);
			expect(lines('WARN')).toEqual([
				...announced,
				'The owners of the boards of the 2 webhook(s) set up before API keys were recorded were not all mailed, as a mail did not go. ' +
					'The lines above name each. The next start mails every owner again.'
			]);
			expect(flag()).toBeUndefined();
		}
	});
});

describe("a change to a webhook held now is judged as switched off for good (card 2893's code review, CS3)", () => {
	let sent: Effects;
	beforeEach(() => {
		makeSmtp();
		sent = effects();
	});
	afterEach(() => sent.restore());

	/** Owner O's board, editor E, and E's webhook set with key K, which has then expired where nothing swept. */
	async function heldNow() {
		const owner = makeUser({ username: 'owner' });
		const editor = makeUser({ username: 'editor' });
		const { board } = makeBoard({ owner });
		addBoardMember(board, editor, 'editor');
		const k = makeApiKeyRow(editor);
		const made = await api('POST', `/api/v1/boards/${board.id}/webhooks`, {
			user: editor,
			credential: { kind: 'api key', id: k.id },
			body: { url: 'https://hooks.example.test/held-now', secret: 'old-secret' }
		});
		expect(made.status).toBe(201);
		sqlite.prepare("UPDATE api_keys SET expires_at = '2026-01-01 00:00:00' WHERE id = ?").run(k.id);
		expect(sqlite.prepare('SELECT active, held_because AS heldBecause FROM webhooks WHERE id = ?').get(made.body.id)).toEqual({ active: 1, heldBecause: null });
		return { owner, editor, board, id: made.body.id as number };
	}
	// The secret opened (card 2898).
	const rowOf = (id: number) => ({
		...(sqlite.prepare('SELECT active, held_because AS heldBecause, secret FROM webhooks WHERE id = ?').get(id) as { active: number; heldBecause: string | null; secret: string }),
		secret: readOpened('webhooks', id)!
	});

	it("(a) an editor's active false records the hold first: it ends 'key ended', said and mailed once, and the editor's delete is then 403", async () => {
		const s = await heldNow();
		sent.clear();

		const off = await api('PUT', `/api/v1/webhooks/${s.id}`, { user: s.editor, body: { active: false } });
		await sent.settle();

		expect(off.status).toBe(200);
		expect(rowOf(s.id)).toMatchObject({ active: 0, heldBecause: 'key ended' });
		expect(lines('WARN')).toHaveLength(1);
		expect(lines('WARN')[0]).toContain(`Webhook ${s.id} on board ${s.board.id} switched off: the API key that set it up`);
		expect(lines('WARN')[0]).toContain('(found when editor changed it)');
		expect(sent.emails.filter((mail) => / switched off$/.test(mail.subject)).map((mail) => mail.to).sort()).toEqual([s.owner.email, s.editor.email].sort());

		const removed = await api('DELETE', `/api/v1/webhooks/${s.id}`, { user: s.editor });
		expect(removed.status).toBe(403);
		expect(rowOf(s.id)).toMatchObject({ active: 0, heldBecause: 'key ended' });
	});

	it("(b) the owner's switch-on of it records the hold first, and so gives it a new secret", async () => {
		const s = await heldNow();
		const m = makeApiKeyRow(s.owner);

		const on = await api('PUT', `/api/v1/webhooks/${s.id}`, { user: s.owner, credential: { kind: 'api key', id: m.id }, body: { active: true } });

		expect(on.status).toBe(200);
		expect(on.body.secret).toMatch(/^[0-9a-f]{64}$/);
		expect(rowOf(s.id)).toEqual({ active: 1, heldBecause: null, secret: on.body.secret });
	});

	it("(c) an editor's delete of it is refused 403, as of one switched off this way, and nothing is written", async () => {
		const s = await heldNow();
		const before = snapshotDb();

		const removed = await api('DELETE', `/api/v1/webhooks/${s.id}`, { user: s.editor });

		expect(removed.status).toBe(403);
		expectUnchanged(before, "after an editor's delete refused");
	});
});

describe('a key revoked and its webhooks switched off are one (card 2893, E8)', () => {
	it('13. each write of a revoke failed in turn leaves the key and the webhook as they were, with no mail and no WARN; on success both come after the commit', async () => {
		/** The WARN lines after each run of the request: the untouched run first. */
		const warned: number[] = [];
		const run = await eachWriteInTurn({
			build: () => {
				makeSmtp();
				const owner = makeUser({ username: 'owner' });
				const editor = makeUser({ username: 'editor' });
				const { board } = makeBoard({ owner });
				addBoardMember(board, editor, 'editor');
				const k = makeApiKeyRow(editor);
				const hook = makeWebhook(board, { setBy: editor, setWithKey: true, setByKey: k.id });
				return { editor, k, hook };
			},
			request: async ({ editor, k }) => {
				try {
					return await api('DELETE', `/api/account/api-keys/${k.id}`, { user: editor });
				} finally {
					warned.push(lines('WARN').length);
				}
			},
			afterSuccess: ({ k, hook }, result, done) => {
				expect(result.status).toBe(200);
				expect(sqlite.prepare('SELECT id FROM api_keys WHERE id = ?').get(k.id)).toBeUndefined();
				expect(sqlite.prepare('SELECT active, held_because AS heldBecause FROM webhooks WHERE id = ?').get(hook.id)).toEqual({
					active: 0,
					heldBecause: 'key ended'
				});
				expect(done.filter((effect) => effect.kind === 'email').map((effect) => (effect as { subject: string }).subject)).toEqual([
					'A webhook you set was switched off',
					'A webhook on your board was switched off'
				]);
			}
		});

		expect(run.writes.length).toBeGreaterThanOrEqual(2);
		expect(warned).toEqual([1, ...run.writes.map(() => 0)]);
	});
});

// ─── Card 2343 ───────────────────────────────────────────────────────────

describe('a card put in a goal or taken out (card 2343)', () => {
	let sent: Effects;
	beforeEach(() => {
		sent = effects();
	});
	afterEach(() => sent.restore());

	/**
	 * The owner's boards A and B. On A, the cards Plan and Ship, and the goal
	 * Launch of A, holding them when `inGoal`. A's webhook `a` asks for every
	 * event and `a-updates` for `card.updated` alone; B's `b` for every event.
	 */
	function goalScene(inGoal: boolean) {
		const owner = makeUser({ username: 'owner' });
		const A = makeBoard({ owner, name: 'Alpha' });
		const B = makeBoard({ owner, name: 'Bravo' });
		const plan = makeCard(A.cols['To Do'], { title: 'Plan' });
		const ship = makeCard(A.cols['To Do'], { title: 'Ship' });
		const goal = makeMilestone({ board: A.board, name: 'Launch', createdBy: owner, cards: inGoal ? [plan, ship] : [] });
		makeWebhook(A.board, { url: 'https://hooks.example.test/a' });
		makeWebhook(A.board, { url: 'https://hooks.example.test/a-updates', events: ['card.updated'] });
		makeWebhook(B.board, { url: 'https://hooks.example.test/b' });
		return { owner, A, B, plan, ship, goal };
	}
	type Scene = ReturnType<typeof goalScene>;

	/** Each delivery as [webhook, event, the body's boardId, data], once the request is answered 200. */
	async function heard(res: Promise<ApiResult>) {
		const answer = await res;
		await sent.settle();
		expect(answer.status).toBe(200);
		expect(sent.duringTransaction).toEqual([]);
		return sent.webhooks.map((d) => {
			expect(d.body.event).toBe(d.event);
			return [d.url.split('/').pop(), d.event, d.body.boardId, d.body.data];
		});
	}

	const added = (s: Scene, card: { id: number; title: string }, source: string) => [
		'a',
		'milestone.card_added',
		s.A.board.id,
		{ cardId: card.id, action: 'milestone_card_added', source, detail: `Added "${card.title}" to milestone "Launch"`, user: 'owner' }
	];
	const removed = (s: Scene, card: { id: number; title: string }, source: string) => [
		'a',
		'milestone.card_removed',
		s.A.board.id,
		{ cardId: card.id, action: 'milestone_card_removed', source, detail: `Removed "${card.title}" from milestone "Launch"`, user: 'owner' }
	];

	type Route = [string, boolean, (s: Scene) => Promise<ApiResult>, (s: Scene) => unknown[]];
	const routes: Route[] = [
		[
			'PATCH /api/milestones/:id with cardId (the picker, the plan page)',
			false,
			(s) => api('PATCH', `/api/milestones/${s.goal.id}`, { user: s.owner, body: { cardId: s.plan.id } }),
			(s) => [added(s, s.plan, 'ui')]
		],
		[
			'PATCH /api/milestones/:id with attach: false',
			true,
			(s) => api('PATCH', `/api/milestones/${s.goal.id}`, { user: s.owner, body: { cardId: s.plan.id, attach: false } }),
			(s) => [removed(s, s.plan, 'ui')]
		],
		[
			'POST /api/v1/milestones/:id/cards',
			false,
			(s) => api('POST', `/api/v1/milestones/${s.goal.id}/cards`, { user: s.owner, body: { cardId: s.plan.id } }),
			(s) => [added(s, s.plan, 'api')]
		],
		[
			'DELETE /api/v1/milestones/:id/cards',
			true,
			(s) => api('DELETE', `/api/v1/milestones/${s.goal.id}/cards`, { user: s.owner, body: { cardId: s.plan.id } }),
			(s) => [removed(s, s.plan, 'api')]
		],
		[
			'PUT /api/v1/cards/:id with milestoneId',
			false,
			(s) => api('PUT', `/api/v1/cards/${s.plan.id}`, { user: s.owner, body: { milestoneId: s.goal.id } }),
			(s) => [added(s, s.plan, 'api')]
		],
		[
			'PUT /api/v1/cards/:id with milestoneId null',
			true,
			(s) => api('PUT', `/api/v1/cards/${s.plan.id}`, { user: s.owner, body: { milestoneId: null } }),
			(s) => [removed(s, s.plan, 'api')]
		],
		[
			'POST /api/v1/milestones/:id/cards/bulk',
			false,
			(s) => api('POST', `/api/v1/milestones/${s.goal.id}/cards/bulk`, { user: s.owner, body: { cardIds: [s.plan.id, s.ship.id] } }),
			(s) => [added(s, s.plan, 'api'), added(s, s.ship, 'api')]
		],
		[
			'DELETE /api/v1/milestones/:id/cards/bulk',
			true,
			(s) => api('DELETE', `/api/v1/milestones/${s.goal.id}/cards/bulk`, { user: s.owner, body: { cardIds: [s.plan.id, s.ship.id] } }),
			(s) => [removed(s, s.plan, 'api'), removed(s, s.ship, 'api')]
		]
	];

	it.each(routes)("%s: one delivery a card, to the card's board, shaped as every event is, and none to a webhook that did not ask", async (_route, inGoal, send, expected) => {
		const s = goalScene(inGoal);
		expect(await heard(send(s))).toEqual(expected(s));
	});

	it("names a goal across boards by its number, as the board's own entry does (card 2257)", async () => {
		const s = goalScene(false);
		const across = makeMilestone({ name: 'ACROSS-SECRET', createdBy: s.owner });

		const delivered = await heard(api('POST', `/api/v1/milestones/${across.id}/cards`, { user: s.owner, body: { cardId: s.plan.id } }));

		expect(delivered).toEqual([['a', 'milestone.card_added', s.A.board.id, expect.objectContaining({ detail: `Added "Plan" to milestone #${across.id}` })]]);
		expect(JSON.stringify(sent.webhooks)).not.toContain('ACROSS-SECRET');
	});

	it('sends a card moved from one goal to another as one milestone.card_added naming the goal it left, and no milestone.card_removed', async () => {
		const s = goalScene(false);
		makeMilestone({ board: s.A.board, name: 'Pilot', createdBy: s.owner, cards: [s.plan] });

		const delivered = await heard(api('POST', `/api/v1/milestones/${s.goal.id}/cards`, { user: s.owner, body: { cardId: s.plan.id } }));

		expect(delivered.map(([hook, event, , data]) => [hook, event, (data as { detail: string }).detail])).toEqual([
			['a', 'milestone.card_added', 'Added "Plan" to milestone "Launch" (from milestone "Pilot")']
		]);
	});

	it('holds the event for a webhook whose setter can no longer open the board, as any event (card 2325)', async () => {
		const s = goalScene(false);
		const outsider = makeUser({ username: 'outsider' });
		const held = makeWebhook(s.A.board, { url: 'https://hooks.example.test/held', setBy: outsider });

		const delivered = await heard(api('POST', `/api/v1/milestones/${s.goal.id}/cards`, { user: s.owner, body: { cardId: s.plan.id } }));

		expect(delivered.map(([hook]) => hook)).toEqual(['a']);
		expect(deliveryResultFor(held)).toMatchObject({
			event: 'milestone.card_added',
			outcome: 'not-sent',
			reason: 'Not sent: the account that set it up can no longer open this board'
		});
	});

	it('takes milestone.card_added as an event a webhook asks for by name, and sends it that alone', async () => {
		const s = goalScene(true);
		const made = await api('POST', `/api/v1/boards/${s.A.board.id}/webhooks`, {
			user: s.owner,
			body: { url: 'https://hooks.example.test/joins', events: ['milestone.card_added'] }
		});
		expect(made.status).toBe(201);
		expect(made.body.events).toEqual(['milestone.card_added']);

		const out = await heard(api('DELETE', `/api/v1/milestones/${s.goal.id}/cards`, { user: s.owner, body: { cardId: s.plan.id } }));
		expect(out.map(([hook, event]) => [hook, event])).toEqual([['a', 'milestone.card_removed']]);
		sent.clear();
		const back = await heard(api('POST', `/api/v1/milestones/${s.goal.id}/cards`, { user: s.owner, body: { cardId: s.plan.id } }));
		expect(back.map(([hook, event]) => [hook, event])).toEqual([
			['a', 'milestone.card_added'],
			['joins', 'milestone.card_added']
		]);
	});

	it('lists in the OpenAPI document, for a webhook made and one changed, the events the two routes accept', async () => {
		const spec = (await api('GET', '/api/v1/openapi.json')).body;
		const eventsOf = (path: string, method: string) => spec.paths[path][method].requestBody.content['application/json'].schema.properties.events.items.enum;

		expect(eventsOf('/api/v1/boards/{boardId}/webhooks', 'post')).toEqual([...WEBHOOK_EVENTS]);
		expect(eventsOf('/api/v1/webhooks/{webhookId}', 'put')).toEqual([...WEBHOOK_EVENTS]);
		expect(WEBHOOK_EVENTS).toContain('milestone.card_added');
		expect(WEBHOOK_EVENTS).toContain('milestone.card_removed');
	});
});

describe('a card that leaves a goal because of another change (card 2381)', () => {
	let sent: Effects;
	beforeEach(() => {
		sent = effects();
	});
	afterEach(() => sent.restore());

	/**
	 * The owner's boards A and B, and an administrator. On A, the cards Plan
	 * and Ship in the goal Launch of A. A's webhook `a` and B's `b` ask for
	 * every event.
	 */
	function leaveScene() {
		const owner = makeUser({ username: 'owner' });
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const A = makeBoard({ owner, name: 'Alpha' });
		const B = makeBoard({ owner, name: 'Bravo' });
		const plan = makeCard(A.cols['To Do'], { title: 'Plan' });
		const ship = makeCard(A.cols['To Do'], { title: 'Ship' });
		const goal = makeMilestone({ board: A.board, name: 'Launch', createdBy: owner, cards: [plan, ship] });
		makeWebhook(A.board, { url: 'https://hooks.example.test/a' });
		makeWebhook(B.board, { url: 'https://hooks.example.test/b' });
		return { owner, admin, A, B, plan, ship, goal };
	}
	type Scene = ReturnType<typeof leaveScene>;

	/** Each goal delivery as [webhook, event, the body's boardId, data], once the request is answered 200. */
	async function heard(res: Promise<ApiResult>) {
		const answer = await res;
		await sent.settle();
		expect(answer.status, JSON.stringify(answer.body)).toBe(200);
		expect(sent.duringTransaction).toEqual([]);
		return sent.webhooks
			.filter((d) => d.event.startsWith('milestone.'))
			.map((d) => [d.url.split('/').pop(), d.event, d.body.boardId, d.body.data]);
	}

	const removed = (s: Scene, card: { id: number; title: string }, source: string, why: string, user = 'owner') => [
		'a',
		'milestone.card_removed',
		s.A.board.id,
		{ cardId: card.id, action: 'milestone_card_removed', source, detail: `Removed "${card.title}" from milestone "Launch" (${why})`, user }
	];

	type Path = [string, (s: Scene) => Promise<ApiResult>, (s: Scene) => unknown[]];
	const paths: Path[] = [
		[
			'a card moved to another board, out of its board’s goal (v1 move): on the board it left',
			(s) => api('PUT', `/api/v1/cards/${s.plan.id}/move`, { user: s.owner, body: { columnId: s.B.cols['To Do'].id } }),
			(s) => [removed(s, s.plan, 'api', 'moved to another board')]
		],
		[
			'the goal deleted (v1): each card it released',
			(s) => api('DELETE', `/api/v1/milestones/${s.goal.id}`, { user: s.owner }),
			(s) => [removed(s, s.plan, 'api', 'milestone deleted'), removed(s, s.ship, 'api', 'milestone deleted')]
		],
		[
			'the goal deleted (the plan page): each card it released',
			(s) => api('DELETE', `/api/milestones/${s.goal.id}`, { user: s.owner }),
			(s) => [removed(s, s.plan, 'ui', 'milestone deleted'), removed(s, s.ship, 'ui', 'milestone deleted')]
		],
		[
			'a card in it deleted for good, beside its card.deleted',
			(s) => api('DELETE', `/api/v1/cards/${s.plan.id}?permanent=true`, { user: s.owner }),
			(s) => [removed(s, s.plan, 'api', 'card deleted')]
		],
		[
			'the column its cards are in deleted',
			(s) => api('DELETE', `/api/v1/columns/${s.A.cols['To Do'].id}`, { user: s.owner }),
			(s) => [removed(s, s.plan, 'api', 'card deleted'), removed(s, s.ship, 'api', 'card deleted')]
		],
		[
			"an administrator's clear of the board's cards",
			(s) => api('POST', `/api/admin/boards/${s.A.board.id}/clear-cards`, stepUp(s.admin)),
			(s) => [removed(s, s.plan, 'ui', 'card deleted', 'admin'), removed(s, s.ship, 'ui', 'card deleted', 'admin')]
		],
		[
			'a purge of archived cards, the archived one alone',
			(s) => {
				sqlite.prepare('UPDATE cards SET archived_at = ? WHERE id = ?').run('2026-10-01 09:00:00', s.plan.id);
				return api('POST', '/api/admin/purge-archived', stepUp(s.admin));
			},
			(s) => [removed(s, s.plan, 'ui', 'card deleted', 'admin')]
		]
	];

	it.each(paths)('%s: milestone.card_removed, one a card, to the card’s board, the card’s id in data', async (_path, send, expected) => {
		const s = leaveScene();
		expect(await heard(send(s))).toEqual(expected(s));
	});

	it("a board deleted: a card elsewhere released from the board's goal is sent to its own board, the goal named by number; the board's own cards send nothing, its webhooks gone with it", async () => {
		const s = leaveScene();
		const elsewhere = makeCard(s.B.cols['To Do'], { title: 'Elsewhere', milestoneId: s.goal.id });

		const delivered = await heard(api('DELETE', `/api/v1/boards/${s.A.board.id}`, { user: s.owner }));

		expect(delivered).toEqual([
			[
				'b',
				'milestone.card_removed',
				s.B.board.id,
				{
					cardId: elsewhere.id,
					action: 'milestone_card_removed',
					source: 'api',
					detail: `Removed "Elsewhere" from milestone #${s.goal.id} (milestone deleted with its board)`,
					user: 'owner'
				}
			]
		]);
	});

	it('a card deleted with its sub-board sends nothing: the sub-board, its log and its webhooks go in the same delete', async () => {
		const s = leaveScene();
		const sub = makeBoard({ owner: s.owner, name: 'Under Plan', parentCardId: s.plan.id });
		const deep = makeCard(sub.cols['To Do'], { title: 'Deep' });
		makeMilestone({ name: 'Across', createdBy: s.owner, cards: [deep] });
		makeWebhook(sub.board, { url: 'https://hooks.example.test/sub' });

		const delivered = await heard(api('DELETE', `/api/v1/cards/${s.plan.id}?permanent=true`, { user: s.owner }));

		expect(delivered).toEqual([removed(s, s.plan, 'api', 'card deleted')]);
		expect(sent.webhooks.map((d) => d.url.split('/').pop())).not.toContain('sub');
	});

	it('a move to another board that leaves no goal sends no goal event', async () => {
		const s = leaveScene();
		const loose = makeCard(s.A.cols['To Do'], { title: 'Loose' });

		expect(await heard(api('PUT', `/api/v1/cards/${loose.id}/move`, { user: s.owner, body: { columnId: s.B.cols['To Do'].id } }))).toEqual([]);
	});
});

// ─── Card 2329 ───────────────────────────────────────────────────────────

describe("the share list tells the board's owner which webhooks a removal stops and how many are held (card 2329)", () => {
	type ShareList = {
		members: { userId: number; stopsWebhooks?: number }[];
		teams: { teamId: number; stopsWebhooks?: number }[];
		heldWebhooks?: number;
		privateStopsWebhooks?: number;
	};

	/** Owner O's board, shared with an editor and a viewer as members; an administrator on nothing. */
	function scene(opts: { isPublic?: boolean } = {}) {
		const owner = makeUser({ username: 'owner' });
		const editor = makeUser({ username: 'editor' });
		const viewer = makeUser({ username: 'viewer' });
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const fixture = makeBoard({ owner, isPublic: opts.isPublic });
		addBoardMember(fixture.board, editor, 'editor');
		addBoardMember(fixture.board, viewer, 'viewer');
		return { owner, editor, viewer, admin, ...fixture };
	}
	type Scene = ReturnType<typeof scene>;

	/** The board's share list as the Share window reads it, for `user`. */
	async function shareList(s: Scene, user: SessionUser): Promise<ShareList> {
		const res = await api('GET', `/api/boards/${s.board.id}/share`, { user });
		expect(res.status).toBe(200);
		return res.body as ShareList;
	}
	const memberStops = (list: ShareList, user: SessionUser) => list.members.find((m) => m.userId === user.id)?.stopsWebhooks;
	const teamStops = (list: ShareList, team: { id: number }) => list.teams.find((t) => t.teamId === team.id)?.stopsWebhooks;
	const remove = (s: Scene, type: 'user' | 'team', targetId: number) =>
		api('DELETE', `/api/boards/${s.board.id}/share`, { user: s.owner, body: { type, targetId } });

	it("1. a member who opens the board only as a member: their removal stops the webhooks they set that are on, and nobody else's removal stops any", async () => {
		const s = scene();
		makeWebhook(s.board, { setBy: s.editor });
		makeWebhook(s.board, { setBy: s.editor });
		makeWebhook(s.board, { setBy: s.editor, active: false });
		makeWebhook(s.board); // the owner's own
		makeWebhook(s.board, { setBy: s.admin });

		const list = await shareList(s, s.owner);
		expect(memberStops(list, s.editor)).toBe(2);
		expect(memberStops(list, s.viewer)).toBe(0);
		expect(list.heldWebhooks).toBe(0);
	});

	it("2. a setter in a team the board is shared with as well as a member stops nothing either way; one in by the team alone, the team's removal stops theirs", async () => {
		const s = scene();
		const both = makeTeam([s.editor]);
		const teamOnly = makeUser({ username: 'teamonly' });
		const crew = makeTeam([teamOnly]);
		shareBoardWithTeam(s.board, both, 'viewer');
		shareBoardWithTeam(s.board, crew, 'editor');
		makeWebhook(s.board, { setBy: s.editor });
		makeWebhook(s.board, { setBy: teamOnly });

		const list = await shareList(s, s.owner);
		expect(memberStops(list, s.editor)).toBe(0);
		expect(teamStops(list, both)).toBe(0);
		expect(teamStops(list, crew)).toBe(1);
	});

	it('3. a member of a public board, and an administrator who is a member, stop nothing: each still opens the board', async () => {
		const s = scene({ isPublic: true });
		addBoardMember(s.board, s.admin, 'editor');
		makeWebhook(s.board, { setBy: s.editor });
		makeWebhook(s.board, { setBy: s.admin });

		const list = await shareList(s, s.owner);
		expect(memberStops(list, s.editor)).toBe(0);
		expect(memberStops(list, s.admin)).toBe(0);
	});

	it('4. heldWebhooks counts one with no setter and one whose setter lost the board, neither counted as stopped, and none switched off', async () => {
		const s = scene();
		const gone = makeUser({ username: 'gone' });
		makeWebhook(s.board, { setBy: null });
		makeWebhook(s.board, { setBy: gone });
		makeWebhook(s.board, { setBy: null, active: false });
		makeWebhook(s.board, { setBy: gone, active: false });

		const list = await shareList(s, s.owner);
		expect(list.heldWebhooks).toBe(2);
		expect(list.members.map((m) => m.stopsWebhooks)).toEqual([0, 0]);
	});

	it('5. a removal through the route holds what the list said it would stop, for a person and for a team', async () => {
		const s = scene();
		const teamOnly = makeUser({ username: 'teamonly' });
		const crew = makeTeam([teamOnly]);
		shareBoardWithTeam(s.board, crew, 'editor');
		makeWebhook(s.board, { setBy: s.editor });
		makeWebhook(s.board, { setBy: teamOnly });

		const before = await shareList(s, s.owner);
		expect([memberStops(before, s.editor), teamStops(before, crew), before.heldWebhooks]).toEqual([1, 1, 0]);

		expect((await remove(s, 'user', s.editor.id)).status).toBe(200);
		expect((await shareList(s, s.owner)).heldWebhooks).toBe(1);
		expect((await remove(s, 'team', crew.id)).status).toBe(200);
		expect((await shareList(s, s.owner)).heldWebhooks).toBe(2);
	});

	it('6. both counts go to the owner and an administrator; an editor and a viewer are answered neither key', async () => {
		const s = scene();
		shareBoardWithTeam(s.board, makeTeam([]), 'viewer');
		makeWebhook(s.board, { setBy: s.editor });
		makeWebhook(s.board, { setBy: null });

		for (const user of [s.owner, s.admin]) {
			const list = await shareList(s, user);
			expect(list.heldWebhooks, user.username).toBe(1);
			expect(memberStops(list, s.editor), user.username).toBe(1);
			expect(list.teams[0], user.username).toHaveProperty('stopsWebhooks', 0);
		}
		for (const user of [s.editor, s.viewer]) {
			const list = await shareList(s, user);
			expect(list, user.username).not.toHaveProperty('heldWebhooks');
			for (const row of [...list.members, ...list.teams]) expect(row, user.username).not.toHaveProperty('stopsWebhooks');
		}
	});

	// The review of card 2329: each webhook read its setter again and asked `roleOnBoard` once
	// for their row and once for every team the board is shared with, whether or not they were in it.
	it('7. a setter is worked out once however many webhooks they set, and only the shared teams they are in are asked of', () => {
		const s = scene();
		const theirs = makeTeam([s.editor]);
		shareBoardWithTeam(s.board, theirs, 'viewer');
		const others = [makeTeam([]), makeTeam([]), makeTeam([])];
		shareBoardWithTeam(s.board, others[0], 'viewer');
		makeWebhook(s.board, { setBy: s.editor });

		/** The notes, and how many statements reading them prepared. */
		const counted = () => {
			const prepare = vi.spyOn(sqlite, 'prepare');
			try {
				return { notes: webhookShareNotes(s.board), reads: prepare.mock.calls.length };
			} finally {
				prepare.mockRestore();
			}
		};
		const one = counted();
		expect(one.notes.byMember.get(s.editor.id)).toBeUndefined();
		expect(one.notes.byTeam.get(theirs.id)).toBeUndefined();

		makeWebhook(s.board, { setBy: s.editor });
		const two = counted();
		expect(two.reads).toBe(one.reads);

		// Two more shared teams the setter is not in: nothing more read for them.
		shareBoardWithTeam(s.board, others[1], 'viewer');
		shareBoardWithTeam(s.board, others[2], 'editor');
		expect(counted().reads).toBe(one.reads);

		// The answers are as before: with the setter's team taken away, their row's removal stops both.
		sqlite.prepare('DELETE FROM board_teams WHERE board_id = ? AND team_id = ?').run(s.board.id, theirs.id);
		const after = counted();
		expect(after.notes.byMember.get(s.editor.id)).toBe(2);
		expect([...after.notes.byTeam.values()]).toEqual([]);
		expect(after.notes.held).toBe(0);
	});

	// Card 2385: the switch to private gave no warning, though it holds every webhook whose
	// setter opens the board only because it is public.
	it('8. privateStopsWebhooks counts, on a public board, the webhooks whose setter opens it only because it is public; making it private switches off exactly those, and the held one, for good (card 2752)', async () => {
		const s = scene({ isPublic: true });
		const outsider = makeUser({ username: 'outsider' });
		const teamOnly = makeUser({ username: 'teamonly' });
		shareBoardWithTeam(s.board, makeTeam([teamOnly]), 'viewer');
		makeWebhook(s.board, { setBy: outsider });
		makeWebhook(s.board, { setBy: outsider });
		makeWebhook(s.board, { setBy: outsider, active: false });
		makeWebhook(s.board, { setBy: s.editor });
		makeWebhook(s.board, { setBy: teamOnly });
		makeWebhook(s.board, { setBy: s.admin });
		makeWebhook(s.board); // the owner's own
		makeWebhook(s.board, { setBy: null });

		const before = await shareList(s, s.owner);
		expect([before.privateStopsWebhooks, before.heldWebhooks]).toEqual([2, 1]);
		// Nobody's removal stops the outsider's: they are no share.
		expect(before.members.map((m) => m.stopsWebhooks)).toEqual([0, 0]);

		const visibility = (isPublic: boolean) => api('PATCH', `/api/boards/${s.board.id}/share`, { user: s.owner, body: { isPublic } });
		expect((await visibility(false)).status).toBe(200);
		const after = await shareList(s, s.owner);
		expect([after.privateStopsWebhooks, after.heldWebhooks]).toEqual([0, 3]);
		expect(sqlite.prepare('SELECT COUNT(*) FROM webhooks WHERE active = 0 AND held_because IS NOT NULL').pluck().get()).toBe(3);

		// Public again, they stay off (card 2752): nothing for the switch to stop, three held.
		expect((await visibility(true)).status).toBe(200);
		const again = await shareList(s, s.owner);
		expect([again.privateStopsWebhooks, again.heldWebhooks]).toEqual([0, 3]);
	});

	it('9. privateStopsWebhooks is 0 on a private board, and goes to the owner and an administrator alone', async () => {
		const s = scene({ isPublic: true });
		const outsider = makeUser({ username: 'outsider' });
		makeWebhook(s.board, { setBy: outsider });
		makeWebhook(s.board, { setBy: s.editor });
		for (const user of [s.owner, s.admin]) expect((await shareList(s, user)).privateStopsWebhooks, user.username).toBe(1);
		for (const user of [s.editor, s.viewer, outsider]) expect(await shareList(s, user), user.username).not.toHaveProperty('privateStopsWebhooks');

		// Private, the editor's webhook still sent: nothing left for the switch to stop.
		expect((await api('PATCH', `/api/boards/${s.board.id}/share`, { user: s.owner, body: { isPublic: false } })).status).toBe(200);
		const shut = await shareList(s, s.owner);
		expect([shut.privateStopsWebhooks, shut.heldWebhooks]).toEqual([0, 1]);
	});
});

// ─── Card 2898: a webhook's secret sealed at rest ───────────────────────────

describe("a webhook's secret, stored sealed (card 2898)", () => {
	let sent: Effects;
	beforeEach(() => {
		sent = effects();
	});
	afterEach(() => sent.restore());

	const LOOKS_SEALED = 'dfsealed:1:0123456789abcdef:AAAAAAAAAAAAAAAA:AAAA';
	const storedSecret = (id: number) => (sqlite.prepare('SELECT secret FROM webhooks WHERE id = ?').get(id) as { secret: string }).secret;
	const setterOf = (id: number) => (sqlite.prepare('SELECT set_by AS setBy FROM webhooks WHERE id = ?').get(id) as { setBy: number | null }).setBy;

	function scene() {
		const owner = makeUser({ username: 'owner' });
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const fixture = makeBoard({ owner });
		return { owner, admin, ...fixture };
	}
	type Scene = ReturnType<typeof scene>;
	const create = (s: Scene, body: Record<string, unknown>) => api('POST', `/api/v1/boards/${s.board.id}/webhooks`, { user: s.owner, body });
	const put = (user: SessionUser, id: number, body: Record<string, unknown>) => api('PUT', `/api/v1/webhooks/${id}`, { user, body });
	/** The owner raises a card through the API: the deliveries it made. */
	async function event(s: Scene) {
		sent.clear();
		const res = await api('POST', `/api/v1/boards/${s.board.id}/cards`, { user: s.owner, body: { title: 'A card, 2898', columnId: s.cols['To Do'].id } });
		expect(res.status).toBe(201);
		await sent.settle();
		return sent.webhooks;
	}
	const signedWith = (secret: string, delivery: Effects['webhooks'][number]) =>
		delivery.headers['x-dumpfire-signature'] === sign(secret, JSON.stringify(delivery.body));

	it('36: the POST stores the secret sealed and answers it in plain, and a delivery is signed with the plain secret; one made without a secret stays empty', async () => {
		const s = scene();
		const made = await create(s, { url: 'https://hooks.example.test/sealed', secret: 'whsec-2898-36' });

		expect(made.status).toBe(201);
		expect(made.body.secret).toBe('whsec-2898-36');
		expect(storedSecret(made.body.id)).toMatch(/^dfsealed:1:/);
		expect(storedSecret(made.body.id)).not.toContain('whsec-2898-36');
		const [delivery] = await event(s);
		expect(signedWith('whsec-2898-36', delivery)).toBe(true);

		// Row 2: no secret, none stored.
		const bare = await create(s, { url: 'https://hooks.example.test/bare' });
		expect(bare.status).toBe(201);
		expect(storedSecret(bare.body.id)).toBe('');
		expect(bare.body).toMatchObject({ hasSecret: false, secret: '' });
	});

	it('37: the PUT: the same secret sent back changes no setter; a new one is sealed; the switch-on gives a new one sealed and answered in plain; an address change seals the kept one again, which still signs', async () => {
		const s = scene();
		const made = await create(s, { url: 'https://hooks.example.test/first', secret: 'whsec-2898-37' });
		const id = made.body.id as number;

		// Row 1: sent back as it opens, by another account: nothing set.
		expect((await put(s.admin, id, { secret: 'whsec-2898-37' })).status).toBe(200);
		expect(setterOf(id)).toBe(s.owner.id);

		// Row 2: a new one.
		const changed = await put(s.owner, id, { secret: 'whsec-2898-37-new' });
		expect(changed.body.secret).toBe('whsec-2898-37-new');
		expect(storedSecret(id)).toMatch(/^dfsealed:1:/);
		expect(readOpened('webhooks', id)).toBe('whsec-2898-37-new');

		// Row 4: the address changed, the secret kept and sealed again for it.
		const before = storedSecret(id);
		const moved = await put(s.owner, id, { url: 'https://hooks.example.test/second' });
		expect(moved.status).toBe(200);
		expect(storedSecret(id)).not.toBe(before);
		expect(readOpened('webhooks', id)).toBe('whsec-2898-37-new');
		const [delivery] = await event(s);
		expect(delivery.url).toBe('https://hooks.example.test/second');
		expect(signedWith('whsec-2898-37-new', delivery)).toBe(true);

		// Row 3: held for good, the switch-on gives a new secret, sealed, answered in plain.
		sqlite.prepare("UPDATE webhooks SET active = 0, held_because = 'setter access ended', held_at = '2026-11-19 00:00:00' WHERE id = ?").run(id);
		const on = await put(s.owner, id, { active: true });
		expect(on.status).toBe(200);
		expect(on.body.secret).toMatch(/^[0-9a-f]{64}$/);
		expect(storedSecret(id)).toMatch(/^dfsealed:1:/);
		expect(readOpened('webhooks', id)).toBe(on.body.secret);
	});

	it('38: a typed webhook secret that begins dfsealed: is refused by the POST and the PUT, and nothing is written', async () => {
		const s = scene();
		const made = await create(s, { url: 'https://hooks.example.test/kept', secret: 'whsec-2898-38' });
		const before = snapshotDb();

		for (const res of [
			await create(s, { url: 'https://hooks.example.test/other', secret: LOOKS_SEALED }),
			await put(s.owner, made.body.id, { secret: LOOKS_SEALED })
		]) {
			expect(res.status).toBe(400);
			expect(res.body.message).toBe(TYPED_SECRET_LOOKS_SEALED);
		}
		expectUnchanged(before);
	});

	it('39: a secret that does not open is not delivered, recorded as not sent and said once, never sent unsigned; reveal gives it empty, with hasSecret', async () => {
		const s = scene();
		const made = await create(s, { url: 'https://hooks.example.test/tampered', secret: 'whsec-2898-39' });
		const id = made.body.id as number;
		// Moved by hand to another address: the seal no longer opens there.
		sqlite.prepare("UPDATE webhooks SET url = 'https://hooks.example.test/moved' WHERE id = ?").run(id);

		expect(await event(s)).toEqual([]);
		expect(await event(s)).toEqual([]);
		const hook = db.select().from(webhooks).where(eq(webhooks.id, id)).get()!;
		expect(deliveryResultFor(hook)).toMatchObject({ outcome: 'not-sent', status: null, reason: 'Not sent: its signing secret cannot be opened' });
		expect(lines('ERROR').filter((line) => line.includes(`Webhook ${id} `) && line.includes('cannot be opened'))).toHaveLength(1);

		// Row 2: the owner's answer.
		const answer = await api('GET', `/api/v1/webhooks/${id}`, { user: s.owner });
		expect(answer.body).toMatchObject({ hasSecret: true, secret: '' });
		expect(JSON.stringify(answer.body)).not.toContain('dfsealed');
	});

	it("39b: a PUT sending a secret for one that does not open is a change: '' clears it, unsigned, and a value replaces it (the code review E6)", async () => {
		const s = scene();
		const made = await create(s, { url: 'https://hooks.example.test/first', secret: 'whsec-2898-39b' });
		const id = made.body.id as number;
		// Moved by hand: the seal no longer opens at the address the row now has.
		sqlite.prepare("UPDATE webhooks SET url = 'https://hooks.example.test/moved' WHERE id = ?").run(id);

		const cleared = await put(s.admin, id, { secret: '' });
		expect(cleared.status).toBe(200);
		expect(cleared.body).toMatchObject({ hasSecret: false, secret: '' });
		expect(storedSecret(id)).toBe('');
		expect(setterOf(id)).toBe(s.admin.id);

		sqlite.prepare("UPDATE webhooks SET secret = ? WHERE id = ?").run(sealValue('whsec', webhookSecretAad(id, s.board.id, 'https://elsewhere.example.test/'), keyFromBytes(randomBytes(32))), id);
		const replaced = await put(s.owner, id, { secret: 'whsec-2898-39b-new' });
		expect(replaced.status).toBe(200);
		expect(readOpened('webhooks', id)).toBe('whsec-2898-39b-new');
		const [delivery] = await event(s);
		expect(signedWith('whsec-2898-39b-new', delivery)).toBe(true);
	});
});

// ─── Card 2928: a webhook's address sealed at rest (slice 1, the readers) ───

describe("a webhook's address, read sealed (card 2928)", () => {
	let sent: Effects;
	beforeEach(() => {
		sent = effects();
		forgetDeliveries();
	});
	afterEach(() => sent.restore());

	function scene() {
		const owner = makeUser({ username: 'owner' });
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const editor = makeUser({ username: 'editor' });
		const viewer = makeUser({ username: 'viewer' });
		const fixture = makeBoard({ owner });
		addBoardMember(fixture.board, editor, 'editor');
		addBoardMember(fixture.board, viewer, 'viewer');
		return { owner, admin, editor, viewer, ...fixture };
	}
	type Scene = ReturnType<typeof scene>;
	const SLACK = 'https://hooks.slack.com/services/T000/B000/xyz-2928';
	const stored = (id: number) => sqlite.prepare('SELECT url, receiver, secret FROM webhooks WHERE id = ?').get(id) as { url: string; receiver: string; secret: string };
	async function event(s: Scene) {
		sent.clear();
		const res = await api('POST', `/api/v1/boards/${s.board.id}/cards`, { user: s.owner, body: { title: 'A card, 2928', columnId: s.cols['To Do'].id } });
		expect(res.status).toBe(201);
		await sent.settle();
		return sent.webhooks;
	}
	const signedWith = (secret: string, delivery: Effects['webhooks'][number]) =>
		delivery.headers['x-dumpfire-signature'] === sign(secret, JSON.stringify(delivery.body));
	/** The address changed by a byte as stored: it no longer opens. */
	const spoil = (id: number) => {
		const { url } = stored(id);
		sqlite.prepare('UPDATE webhooks SET url = ? WHERE id = ?').run(url.slice(0, -3) + (url.slice(-3, -2) === 'A' ? 'B' : 'A') + url.slice(-2), id);
	};

	it('3: no answer to any caller holds receiver; the viewer and the editor are given no url', async () => {
		const s = scene();
		const hook = makeWebhook(s.board, { url: SLACK, secret: 'shh' });
		expect(stored(hook.id).receiver).toBe('https://hooks.slack.com');
		const answers: Record<string, unknown>[] = [];
		for (const user of [s.viewer, s.editor, s.owner, s.admin]) {
			const one = await api('GET', `/api/v1/webhooks/${hook.id}`, { user });
			const list = await api('GET', `/api/v1/boards/${s.board.id}/webhooks`, { user });
			expect([one.status, list.status], user.username).toEqual([200, 200]);
			answers.push(one.body, ...list.body);
			if (user === s.viewer || user === s.editor) expect(one.body, user.username).not.toHaveProperty('url');
			else expect(one.body.url, user.username).toBe(SLACK);
		}
		const own = await api('PUT', `/api/v1/webhooks/${hook.id}`, { user: s.editor, body: { events: ['card.moved'] } });
		expect(own.status).toBe(200);
		expect(own.body).not.toHaveProperty('url');
		const made = await api('POST', `/api/v1/boards/${s.board.id}/webhooks`, { user: s.owner, body: { url: 'https://hooks.example.test/made' } });
		expect(made.status).toBe(201);
		answers.push(own.body, made.body);
		for (const answer of answers) expect(answer).not.toHaveProperty('receiver');
	});

	it('4: an address stored sealed is delivered to, signed with the secret bound to the address as opened', async () => {
		const s = scene();
		const hook = makeWebhook(s.board, { url: SLACK });
		expect(stored(hook.id).url).toMatch(/^dfsealed:1:/);
		sqlite.prepare('UPDATE webhooks SET secret = ? WHERE id = ?').run(sealValue('whsec-2928-4', webhookSecretAad(hook.id, hook.boardId, SLACK), currentMfaKey()!), hook.id);

		const [delivery] = await event(s);

		expect(delivery.url).toBe(SLACK);
		expect(signedWith('whsec-2928-4', delivery)).toBe(true);
	});

	it.each([
		{ row: 'an address that does not open', change: 'spoil', reason: 'Not sent: its address cannot be opened' },
		{ row: "an address ''", change: 'empty', reason: 'Not sent: it has no address; set one with PUT /api/v1/webhooks/{id}' }
	])('5: a webhook with $row is not sent, and says so', async ({ change, reason }) => {
		const s = scene();
		const hook = makeWebhook(s.board, { url: SLACK });
		if (change === 'spoil') spoil(hook.id);
		else sqlite.prepare("UPDATE webhooks SET url = '' WHERE id = ?").run(hook.id);

		expect(await event(s)).toEqual([]);
		expect(await event(s)).toEqual([]);

		const answer = await api('GET', `/api/v1/webhooks/${hook.id}`, { user: s.owner });
		expect(answer.body.url).toBe('');
		expect(answer.body.lastDelivery).toMatchObject({ outcome: 'not-sent', reason });
		const errors = lines('ERROR');
		if (change === 'spoil') {
			expect(errors).toEqual([
				`Webhook ${hook.id} on board ${s.board.id} not sent: its address cannot be opened with this server's MFA key. Nothing is sent until the ` +
					"board's owner or an administrator sets its address with PUT /api/v1/webhooks/{id}."
			]);
		} else {
			expect(errors).toEqual([]);
		}
		expect([...errors, ...lines('WARN')].join(' ')).not.toContain('xyz-2928');
	});

	it("6: a secret beside an address that is '' or does not open reads as not opening: hasSecret true, secret ''", async () => {
		const s = scene();
		const spoiled = makeWebhook(s.board, { url: SLACK, secret: 'plain-beside-spoiled' });
		const empty = makeWebhook(s.board, { url: 'https://hooks.example.test/e', secret: 'plain-beside-empty' });
		spoil(spoiled.id);
		sqlite.prepare("UPDATE webhooks SET url = '' WHERE id = ?").run(empty.id);

		for (const hook of [spoiled, empty]) {
			const answer = await api('GET', `/api/v1/webhooks/${hook.id}`, { user: s.owner });
			expect(answer.body, String(hook.id)).toMatchObject({ hasSecret: true, secret: '', url: '' });
		}
	});

	it.each([
		{ row: 'one refused as written, by its host', change: 'inside' },
		{ row: 'one whose address does not open', change: 'spoil' }
	])('7: the start line names $row, and nothing of its path', ({ change }) => {
		const { board } = makeBoard({ owner: makeUser() });
		const hook = makeWebhook(board, { url: change === 'inside' ? 'http://127.0.0.1:8080/secret-path-2928' : SLACK });
		if (change === 'spoil') spoil(hook.id);

		expect(reportWebhooksRefused()).toBe(true);

		const line = (sqlite.prepare("SELECT message FROM system_logs WHERE context = 'STARTUP' ORDER BY id DESC").pluck().get() as string) ?? '';
		expect(line).toContain(
			change === 'inside'
				? `webhook ${hook.id} on board ${board.id} (127.0.0.1 is a loopback address)`
				: `webhook ${hook.id} on board ${board.id} (its address cannot be opened with this server's MFA key)`
		);
		expect(line).not.toMatch(/secret-path-2928|xyz-2928/);
	});

	it.each([
		{ row: 'a switch-off at delivery', how: 'delivery' },
		{ row: "an ending of the setter's access", how: 'ending' }
	])("8: $row names the host of the stored receiver in its WARN and the owners' mail, never the path", async ({ how }) => {
		const s = scene();
		makeSmtp();
		const hook = makeWebhook(s.board, { url: SLACK, setBy: s.editor });
		if (how === 'delivery') {
			sqlite.prepare('DELETE FROM board_members WHERE board_id = ? AND user_id = ?').run(s.board.id, s.editor.id);
			await event(s);
		} else {
			inTransaction(() => endAccountAccess(s.editor.id, { apiKeys: true, cause: RESET_IN_A_TEST }));
			await sent.settle();
		}

		expect(lines('WARN').some((line) => line.startsWith(`Webhook ${hook.id} on board ${s.board.id} switched off`))).toBe(true);
		const mail = sent.emails.find((each) => each.to === s.owner.email);
		expect(mail?.html).toContain('<strong>hooks.slack.com</strong>');
		expect(JSON.stringify(sent.emails)).not.toContain('xyz-2928');
	});

	it("9: an editor's create at a receiver held off on the board, whose address is '', is refused 409 by the stored receiver", async () => {
		const s = scene();
		const held = makeWebhook(s.board, { url: SLACK, heldBecause: 'setter access ended' });
		sqlite.prepare("UPDATE webhooks SET url = '' WHERE id = ?").run(held.id);
		const before = snapshotDb();

		const made = await api('POST', `/api/v1/boards/${s.board.id}/webhooks`, { user: s.editor, body: { url: 'https://HOOKS.slack.com:443/services/other' } });

		expect(made.status).toBe(409);
		expectUnchanged(before, 'after a create refused');
	});

	it("10: an old address with a lone surrogate is sealed as the one string its secret is bound to, and is sent signed (the code review, C3)", async () => {
		const s = scene();
		const hook = makeWebhook(s.board);
		// A plain row from before the release, as a restore hands it over, on purpose: an address no create of
		// today would take. (Read back from SQLite a string is already well-formed; a row in hand need not be.)
		const old = 'https://hooks.example.test/c3-\uD800-x';
		const restored = sealedForRestore('webhooks', [{ id: hook.id, board_id: hook.boardId, url: old, receiver: '', secret: 'whsec-c3', active: 1 }]).rows[0];
		const canonical = old.toWellFormed();
		expect(openStored(String(restored.url), webhookUrlAad(hook.id, hook.boardId, String(restored.receiver))).value).toBe(canonical);
		expect(openStored(String(restored.secret), webhookSecretAad(hook.id, hook.boardId, canonical)).value).toBe('whsec-c3');
		sqlite.prepare('UPDATE webhooks SET url = ?, receiver = ?, secret = ? WHERE id = ?').run(restored.url, restored.receiver, restored.secret, hook.id);

		// The start's sweep, on the row read back, makes the same one string.
		sqlite.prepare("UPDATE webhooks SET url = ?, receiver = '', secret = 'whsec-c3b' WHERE id = ?").run(old, hook.id);
		const asRead = stored(hook.id).url;
		sealPlainSecrets(sqlite, currentMfaKey());
		expect(readOpenedUrl(hook.id)).toBe(asRead.toWellFormed());
		sqlite.prepare('UPDATE webhooks SET url = ?, receiver = ?, secret = ? WHERE id = ?').run(restored.url, restored.receiver, restored.secret, hook.id);

		expect(stored(hook.id).receiver).toBe('https://hooks.example.test');
		const [delivery] = await event(s);
		expect(delivery.url).toBe(canonical);
		expect(signedWith('whsec-c3', delivery)).toBe(true);
	});
});

// ─── Card 2928, slice 2: the writers seal the address ───────────────────────

describe("a webhook's address, written sealed (card 2928)", () => {
	let sent: Effects;
	beforeEach(() => {
		sent = effects();
		forgetDeliveries();
	});
	afterEach(() => sent.restore());

	function scene() {
		const owner = makeUser({ username: 'owner' });
		const fixture = makeBoard({ owner });
		return { owner, ...fixture };
	}
	type Scene = ReturnType<typeof scene>;
	const SLACK = 'https://hooks.slack.com/services/T000/B000/xyz-2928';
	const TEAMS = 'https://example.webhook.office.com/webhookb2/abc-2928/IncomingWebhook/def/ghi';
	const stored = (id: number) =>
		sqlite.prepare('SELECT url, receiver, secret, set_by AS setBy, active FROM webhooks WHERE id = ?').get(id) as { url: string; receiver: string; secret: string; setBy: number | null; active: number };
	const put = (user: SessionUser, id: number, body: Record<string, unknown>) => api('PUT', `/api/v1/webhooks/${id}`, { user, body });
	async function event(s: Scene) {
		sent.clear();
		const res = await api('POST', `/api/v1/boards/${s.board.id}/cards`, { user: s.owner, body: { title: 'A card, 2928', columnId: s.cols['To Do'].id } });
		expect(res.status).toBe(201);
		await sent.settle();
		return sent.webhooks;
	}
	const signedWith = (secret: string, delivery: Effects['webhooks'][number]) =>
		delivery.headers['x-dumpfire-signature'] === sign(secret, JSON.stringify(delivery.body));
	const spoil = (id: number) => {
		const { url } = stored(id);
		sqlite.prepare('UPDATE webhooks SET url = ? WHERE id = ?').run(url.slice(0, -3) + (url.slice(-3, -2) === 'A' ? 'B' : 'A') + url.slice(-2), id);
	};
	const plainAddresses = () => (sqlite.prepare('SELECT url FROM webhooks').pluck().all() as string[]).filter((url) => url !== '' && !url.startsWith('dfsealed:1:'));

	it('15: the create stores the address sealed and its receiver plain, answers the address, and leaves no address in plain', async () => {
		const s = scene();
		const made = await api('POST', `/api/v1/boards/${s.board.id}/webhooks`, { user: s.owner, body: { url: SLACK, secret: 'whsec-15' } });

		expect(made.status).toBe(201);
		expect(made.body.url).toBe(SLACK);
		expect(stored(made.body.id)).toMatchObject({ url: expect.stringMatching(/^dfsealed:1:/), receiver: 'https://hooks.slack.com' });
		expect(stored(made.body.id).url).not.toContain('xyz-2928');
		expect(readOpenedUrl(made.body.id)).toBe(SLACK);
		expect(readOpened('webhooks', made.body.id)).toBe('whsec-15');
		const changed = await put(s.owner, made.body.id, { url: TEAMS });
		expect(changed.status).toBe(200);
		expect(plainAddresses()).toEqual([]);
	});

	it.each([
		{ row: 'the url alone', body: { url: SLACK } },
		{ row: 'the url with events', body: { url: SLACK, events: ['card.moved'] } }
	])('16: a PUT sending $row unchanged answers 200, writes the stored address back byte for byte and makes nobody its setter (R3)', async ({ body }) => {
		const s = scene();
		const admin = makeUser({ role: 'admin' });
		const hook = makeWebhook(s.board, { url: SLACK });
		const before = stored(hook.id);

		const res = await put(admin, hook.id, body);

		expect(res.status).toBe(200);
		expect(res.body.url).toBe(SLACK);
		expect(stored(hook.id)).toEqual({ ...before, setBy: before.setBy });
	});

	it('17: a PUT with a new address seals it with its new receiver, and seals the kept secret again for it, which still signs', async () => {
		const s = scene();
		const made = await api('POST', `/api/v1/boards/${s.board.id}/webhooks`, { user: s.owner, body: { url: SLACK, secret: 'whsec-17' } });
		const before = stored(made.body.id);

		const res = await put(s.owner, made.body.id, { url: TEAMS });

		expect(res.status).toBe(200);
		const after = stored(made.body.id);
		expect(after.receiver).toBe('https://example.webhook.office.com');
		expect(after.url).not.toBe(before.url);
		expect(after.secret).not.toBe(before.secret);
		expect(readOpenedUrl(made.body.id)).toBe(TEAMS);
		const [delivery] = await event(s);
		expect(delivery.url).toBe(TEAMS);
		expect(signedWith('whsec-17', delivery)).toBe(true);
	});

	it.each([
		{ row: "url '' is refused", change: 'empty', body: { url: '' }, status: 400 },
		{ row: 'active true alone is refused', change: 'spoil', body: { active: true }, status: 400 },
		{ row: 'url with active true switches it on', change: 'empty', body: { url: TEAMS, active: true }, status: 200 },
		{ row: 'events alone are taken (R7)', change: 'spoil', body: { events: ['card.moved'] }, status: 200 }
	])('18: on a webhook whose address is empty or does not open, $row', async ({ change, body, status }) => {
		const s = scene();
		const hook = makeWebhook(s.board, { url: SLACK, active: false });
		if (change === 'spoil') spoil(hook.id);
		else sqlite.prepare("UPDATE webhooks SET url = '' WHERE id = ?").run(hook.id);
		const before = snapshotDb();

		const res = await put(s.owner, hook.id, body);

		expect(res.status, JSON.stringify(res.body)).toBe(status);
		if (status === 400) {
			expectUnchanged(before, 'after a refusal');
			if ('active' in body) expect(res.body.message).toBe('This webhook has no address it can send to: send url with active true.');
		} else if ('url' in body) {
			expect(stored(hook.id)).toMatchObject({ active: 1, receiver: 'https://example.webhook.office.com' });
			expect(readOpenedUrl(hook.id)).toBe(TEAMS);
		} else {
			expect(stored(hook.id).active).toBe(0);
		}
	});

	it.each([
		{ row: 'a secret alone, on an address that does not open: refused', setup: 'spoil-address', body: { secret: 'whsec-19' }, status: 400 },
		{ row: 'a secret with url, on an address that does not open: taken', setup: 'spoil-address', body: { secret: 'whsec-19', url: TEAMS }, status: 200 },
		{ row: 'a url alone, beside a secret that does not open: refused', setup: 'spoil-secret', body: { url: TEAMS }, status: 400 },
		{ row: 'a url with a new secret, beside a secret that does not open: taken', setup: 'spoil-secret', body: { url: TEAMS, secret: 'whsec-19' }, status: 200 }
	])('19: no secret is sealed against an address that does not open, and none orphaned (R5): $row', async ({ setup, body, status }) => {
		const s = scene();
		const made = await api('POST', `/api/v1/boards/${s.board.id}/webhooks`, { user: s.owner, body: { url: SLACK, secret: 'whsec-old' } });
		const id = made.body.id as number;
		if (setup === 'spoil-address') spoil(id);
		else sqlite.prepare('UPDATE webhooks SET secret = ? WHERE id = ?').run(sealValue('theirs', webhookSecretAad(id, s.board.id, SLACK), keyFromBytes(randomBytes(32))), id);
		const before = snapshotDb();

		const res = await put(s.owner, id, body);

		expect(res.status, JSON.stringify(res.body)).toBe(status);
		if (status === 400) {
			expectUnchanged(before, 'after a refusal');
			expect(res.body.message).toBe(
				setup === 'spoil-address'
					? "This webhook's address is empty or cannot be opened, so a secret cannot be bound to it: send url with the secret."
					: "This webhook's secret cannot be opened, so it cannot be kept for a new address: send a new secret with the url, or '' for none."
			);
		} else {
			expect(readOpenedUrl(id)).toBe(TEAMS);
			expect(readOpened('webhooks', id)).toBe('whsec-19');
			const [delivery] = await event(s);
			expect(signedWith('whsec-19', delivery)).toBe(true);
		}
	});

	it("19b: a secret '' alone, on an address that does not open, is a clear and is taken: nothing sealed (the code review, C5)", async () => {
		const s = scene();
		const made = await api('POST', `/api/v1/boards/${s.board.id}/webhooks`, { user: s.owner, body: { url: SLACK, secret: 'whsec-old' } });
		const id = made.body.id as number;
		spoil(id);
		const spoiledUrl = stored(id).url;

		const res = await put(s.owner, id, { secret: '' });

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toMatchObject({ hasSecret: false, secret: '', url: '' });
		// The secret cleared; the address left as stored, byte for byte, still not opening.
		expect(stored(id)).toMatchObject({ secret: '', url: spoiledUrl });
	});

	it("20: a held webhook with a sealed address switched on is given a new secret bound to the address as opened, which signs", async () => {
		const s = scene();
		const hook = makeWebhook(s.board, { url: SLACK, secret: 'old', heldBecause: 'setter access ended' });

		const on = await put(s.owner, hook.id, { active: true });

		expect(on.status).toBe(200);
		expect(on.body.secret).toMatch(/^[0-9a-f]{64}$/);
		expect(readOpened('webhooks', hook.id)).toBe(on.body.secret);
		const [delivery] = await event(s);
		expect(delivery.url).toBe(SLACK);
		expect(signedWith(on.body.secret, delivery)).toBe(true);
	});

	it('21: a PUT of a secret alone on a sealed address seals it bound to the address as opened, and it signs', async () => {
		const s = scene();
		const hook = makeWebhook(s.board, { url: SLACK });

		const res = await put(s.owner, hook.id, { secret: 'whsec-21' });

		expect(res.status).toBe(200);
		expect(stored(hook.id).secret).toMatch(/^dfsealed:1:/);
		const [delivery] = await event(s);
		expect(signedWith('whsec-21', delivery)).toBe(true);
	});

	it('22: a url that is not well-formed text is refused 400, its text quoted nowhere (R18)', async () => {
		const s = scene();
		const before = snapshotDb();
		const broken = 'https://hooks.example.test/half-\uD800-2928';

		const made = await api('POST', `/api/v1/boards/${s.board.id}/webhooks`, { user: s.owner, body: { url: broken } });

		expect(made.status).toBe(400);
		expect(made.body.message).toBe('Webhook url must be well-formed text: it holds a character that is broken in half.');
		expect(JSON.stringify(made.body)).not.toContain('half-');
		expectUnchanged(before, 'after a refusal');
	});
});

// ─── Card 2689 ───────────────────────────────────────────────────────────

describe('decision events: named-only, from the projection alone, and never a record entry (card 2689)', () => {
	let sent: Effects;
	beforeEach(() => {
		sent = effects();
		forgetDeliveries();
	});
	afterEach(() => sent.restore());

	const DECISION_EVENTS = ['decision.opened', 'decision.ruled', 'decision.withdrawn', 'decision.superseded'];

	/** A board of an owner's with an open decision on it, which the owner, every fixture webhook's setter, may view. */
	function scene() {
		const owner = makeUser({ username: 'owner' });
		const { board, cols } = makeBoard({ owner });
		const decision = makeDecision({ board, author: owner, decider: owner, status: 'open', title: 'Budget for Q3' });
		return { owner, board, cols, decision };
	}

	it('W1: a decision event is sent only to a webhook that names it, and an empty list still hears every card event (R6)', async () => {
		const { board, cols, decision } = scene();
		const empty = makeWebhook(board, { url: 'https://hooks.example.test/empty' });
		const cards = makeWebhook(board, { url: 'https://hooks.example.test/cards', events: ['card.created'] });
		makeWebhook(board, { url: 'https://hooks.example.test/ruled', events: ['decision.ruled'] });

		dispatchWebhook(board.id, 'decision.ruled', { decisionId: decision.id, action: 'decision_ruled', source: 'ui', title: decision.title, status: 'ruled' });
		await sent.settle();

		expect(sent.webhooks.map((d) => [d.url.split('/').pop(), d.event])).toEqual([['ruled', 'decision.ruled']]);
		// Not asked for, so not an attempt: nothing recorded for either.
		expect(deliveryResultFor(empty)).toBeNull();
		expect(deliveryResultFor(cards)).toBeNull();

		sent.clear();
		const card = makeCard(cols['To Do'], { title: 'New' });
		logActivity({ boardId: board.id, cardId: card.id, action: ACTIONS.cardCreated, detail: '"New"' });
		await sent.settle();
		expect(sent.webhooks.map((d) => [d.url.split('/').pop(), d.event])).toEqual([
			['empty', 'card.created'],
			['cards', 'card.created']
		]);
	});

	// Card 2689's code review (S-L3): a list that cannot be read names no event, so a decision event is not an attempt.
	it('S-L3: a webhook whose stored events cannot be read records nothing and logs nothing for a decision event, and still does for a card event', async () => {
		const { board, decision } = scene();
		const unreadable = storedAs(makeWebhook(board), '5');

		dispatchWebhook(board.id, 'decision.ruled', { decisionId: decision.id, action: 'decision_ruled', source: 'ui', title: decision.title, status: 'ruled' });
		await sent.settle();

		expect(sent.webhooks).toEqual([]);
		expect(deliveryResultFor(unreadable)).toBeNull();
		expect(lines('WARN')).toEqual([]);
		expect(lines('ERROR')).toEqual([]);

		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		await sent.settle();
		expect(deliveryResultFor(unreadable)).toMatchObject({ event: 'card.created', outcome: 'not-sent' });
		expect(lines('WARN')).toEqual([`Webhook ${unreadable.id} on board ${board.id} not sent: its events are not a list`]);
	});

	it("L2: a decision event's data is exactly the decision's id, the action, the source, the title and the status, never the entry's name or detail; decision.superseded adds what replaced it (R5)", async () => {
		const { owner, board, decision } = scene();
		const newer = makeDecision({ board, author: owner, decider: owner, status: 'ruled' });
		makeWebhook(board, { events: DECISION_EVENTS });
		const cases = [
			['decision_opened', 'decision.opened', 'open'],
			['decision_ruled', 'decision.ruled', 'ruled'],
			['decision_withdrawn', 'decision.withdrawn', 'withdrawn'],
			['decision_superseded', 'decision.superseded', 'superseded']
		] as const;

		for (const [action, event, status] of cases) {
			for (const spelling of [action, `api:${action}`]) {
				sent.clear();
				logActivity({
					boardId: board.id,
					action: spelling,
					detail: '"Budget for Q3" by NAMEMARK',
					userId: owner.id,
					userName: 'NAMEMARK',
					// Every entry says what replaced it: only decision.superseded may carry it.
					decision: { id: decision.id, title: 'Budget for Q3', status, supersededById: newer.id }
				});
				await sent.settle();

				expect(sent.webhooks.map((d) => d.event), spelling).toEqual([event]);
				const { body } = sent.webhooks[0];
				expect(Object.keys(body), spelling).toEqual(['event', 'timestamp', 'boardId', 'data']);
				expect(body.data, spelling).toEqual({
					decisionId: decision.id,
					action,
					source: spelling === action ? 'ui' : 'api',
					title: 'Budget for Q3',
					status,
					...(event === 'decision.superseded' ? { supersededByDecisionId: newer.id } : {})
				});
				expect(JSON.stringify(body), spelling).not.toContain('NAMEMARK');
			}
		}
	});

	it.each(['decision_opened', 'decision_ruled', 'decision_withdrawn', 'decision_superseded'])(
		'L3: %s with no decision projection sends nothing, by either spelling, and is still written (R10)',
		async (action) => {
			const { board } = scene();
			const hooks = [makeWebhook(board, { events: [...WEBHOOK_EVENTS] }), makeWebhook(board)];

			for (const spelling of [action, `api:${action}`]) logActivity({ boardId: board.id, action: spelling, detail: '"Budget for Q3"', userName: 'owner' });
			await sent.settle();

			expect(sent.webhooks).toEqual([]);
			// Not dispatched at all: not even an attempt that `deliver`'s own view check then refused.
			for (const hook of hooks) expect(deliveryResultFor(hook), `${hook.id}`).toBeNull();
			expect(db.select().from(activityLog).all().map((row) => row.action)).toEqual([action, `api:${action}`]);
		}
	);

	it("L4: no kind of a decision's record, logged as an activity action by either spelling, sends any event (R12)", async () => {
		const { board, decision } = scene();
		makeWebhook(board, { events: [...WEBHOOK_EVENTS] });
		makeWebhook(board);
		// Card 2688's entry among them.
		expect(EVENT_KINDS).toContain('record_exported');

		for (const kind of EVENT_KINDS) {
			for (const spelling of [kind, `api:${kind}`]) {
				logActivity({ boardId: board.id, action: spelling, detail: spelling, decision: { id: decision.id, title: decision.title, status: 'open' } });
			}
		}
		await sent.settle();

		expect(sent.webhooks).toEqual([]);
	});
});
