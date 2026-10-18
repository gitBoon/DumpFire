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
 */
import dns from 'node:dns';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { isHttpError } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sqlite } from '$lib/server/db';
import { deliver, dispatchWebhook, WARNINGS_REMEMBERED } from '$lib/server/webhooks';
import { addressRefusal, insideReason, parseAllowInside, readWebhookUrl } from '$lib/server/webhook-address';
import { reportWebhookAllowInside, reportWebhooksOverCap, reportWebhooksRefused } from '$lib/server/startup-checks';
import { api } from './helpers/api';
import { effects, type Effects } from './helpers/effects';
import { addBoardMember, makeBoard, makeUser, makeWebhook, resetDb } from './helpers/fixtures';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';

beforeEach(resetDb);

type Hook = ReturnType<typeof makeWebhook>;

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

		expect(sent.webhooks.map((w) => w.url)).toEqual([hooks[3].url]);
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

		expect(sent.webhooks.map((w) => w.url)).toEqual([good.url]);
		expect(lines('WARN')).toEqual([`Webhook ${bad.id} on board ${board.id} not sent: its events are not a list`]);
	});

	it('sends a list that names the event and an empty list, and not a list without it (a guard)', async () => {
		const { board } = makeBoard({ owner: makeUser() });
		const naming = makeWebhook(board, { events: ['card.moved', 'card.created'] });
		const every = makeWebhook(board, { events: [] });
		makeWebhook(board, { events: ['card.moved'] });

		dispatchWebhook(board.id, 'card.created', { cardId: 1 });
		await sent.settle();

		expect(sent.webhooks.map((w) => w.url)).toEqual([naming.url, every.url]);
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
		expect(rowsOf(board.id)[0]).toMatchObject({ url: 'http://10.0.0.5/x', events: '["card.moved"]' });

		const other = await api('PUT', `/api/v1/webhooks/${hook.id}`, { user: owner, body: { url: 'http://10.0.0.6/x' } });
		expect(other.status).toBe(400);
		expect(other.body.message).toBe('Webhook url points inside the network: 10.0.0.6 is a private network address');
		expect(rowsOf(board.id)[0].url).toBe('http://10.0.0.5/x');
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
			expect(sent.webhooks.map((w) => w.url)).toEqual(hooks.map((h) => h.url));
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
		const first = makeWebhook(board, { url: 'http://127.0.0.1/x' });
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
