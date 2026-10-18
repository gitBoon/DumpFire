/**
 * Where the address in a mailed link comes from.
 *
 * With no App URL set, a link used to take its host from the request's
 * `X-Forwarded-Host`: whoever could send a request could have an invite
 * mailed with a link to a server of their own, and an invite sets a password.
 * A link's address is configuration now and nothing a request says. In order:
 * the App URL setting, the `APP_URL` variable, then `ORIGIN` as the node
 * adapter reads it (`linkBaseUrl` in `src/lib/server/email.ts`). A server
 * given none of the three has no address, and then a mail that is nothing
 * without its link is refused before anything is written, and a notification
 * is skipped with a line in the log.
 *
 * This file runs as a built server does. `vite dev` is the one place where
 * the request's own address is still used, last of all, and vitest runs as
 * the dev server: so `$app/environment` is replaced here and `dev` is false in
 * every module a handler below is made of. What the dev server does is asked
 * of `linkBaseUrl` directly, by passing the mode in.
 *
 * Every request is sent to a forged address, with a forged `Host` and
 * `X-Forwarded-Host`: `evil.example.test` is in no link.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dev } from '$app/environment';
import type { SessionUser } from '$lib/server/auth';
import { db, sqlite } from '$lib/server/db';
import { inviteTokens, settings, taskRequests, type Board, type Card, type Column } from '$lib/server/db/schema';
import { NO_LINK_ADDRESS, PLACEHOLDER_ORIGIN, configuredOrigin, linkBaseUrl } from '$lib/server/email';
import { resetAllRateLimits } from '$lib/server/rate-limit';
import { issueFormToken } from '$lib/server/request-tokens';
import { reportInstallation, reportPlaceholderOrigin } from '$lib/server/startup-checks';
import { api, type ApiResult } from './helpers/api';
import { effects, type Effects } from './helpers/effects';
import { addBoardMember, makeBoard, makeCard, makeSmtp, makeUser, resetDb } from './helpers/fixtures';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';

vi.mock('$app/environment', () => ({ dev: false, building: false, browser: false, version: 'test' }));

/** Where the forged request claims to be for. In no link. */
const FORGED = 'evil.example.test';
const FORGED_HEADERS = { host: FORGED, 'x-forwarded-host': FORGED, 'x-forwarded-proto': 'https' };
/** A path on the forged address: what a server with no `ORIGIN` takes a request's address to be. */
const at = (path: string) => `https://${FORGED}${path}`;

const VARIABLES = ['APP_URL', 'ORIGIN', 'LOG_LEVEL'] as const;
const environment = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));

let admin: SessionUser;
let owner: SessionUser;
let member: SessionUser;
let board: Board;
let cols: Record<string, Column>;
let card: Card;
let sent: Effects;

beforeEach(() => {
	resetDb();
	resetAllRateLimits();
	// Whatever the shell that started the tests has: each test says its own.
	delete process.env.APP_URL;
	delete process.env.ORIGIN;
	admin = makeUser({ username: 'admin', role: 'admin' });
	owner = makeUser({ username: 'owner' });
	member = makeUser({ username: 'member' });
	({ board, cols } = makeBoard({ owner, name: 'A board' }));
	addBoardMember(board, member, 'editor');
	card = makeCard(cols['To Do'], { title: 'A card' });
	makeSmtp();
	sent = effects();
});

afterEach(() => {
	sent.restore();
	vi.restoreAllMocks();
	for (const name of VARIABLES) {
		if (environment[name] === undefined) delete process.env[name];
		else process.env[name] = environment[name];
	}
});

const setAppUrl = (value: string) => db.insert(settings).values({ key: 'app_url', value }).run();

/** Every address a mail links to. */
const linksIn = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);

/** A request from outside, accepted and made into `card`: its requester is told of the card's progress. */
const acceptedRequest = () =>
	db
		.insert(taskRequests)
		.values({
			targetType: 'user',
			targetId: owner.id,
			requesterName: 'Rita',
			requesterEmail: 'rita@example.test',
			title: 'Please add an export',
			desiredBoardId: board.id,
			status: 'accepted',
			resolvedCardId: card.id,
			accessToken: 'a'.repeat(64)
		})
		.returning()
		.get();

/** One waiting for an answer, addressed to `owner`. */
const pendingRequest = () =>
	db
		.insert(taskRequests)
		.values({
			targetType: 'user',
			targetId: owner.id,
			requesterName: 'Rita',
			requesterEmail: 'rita@example.test',
			title: 'Please add an export',
			desiredBoardId: board.id,
			status: 'pending',
			accessToken: 'b'.repeat(64)
		})
		.returning()
		.get();

/** What the public request form sends. */
const asking = () => ({
	targetType: 'user',
	targetId: owner.id,
	desiredBoardId: board.id,
	title: 'Please add an export',
	requesterName: 'Pat',
	requesterEmail: 'pat@example.test'
});

/**
 * Each mail that carries a link: the request that sends it, who it goes to,
 * and what its link is after the address. Every request is sent to the forged
 * address with the forged headers.
 */
const MAILS: {
	name: string;
	send: () => Promise<{ status: number }>;
	to: string;
	link: RegExp;
}[] = [
	{
		name: 'an invite, when an administrator creates a user with no password',
		send: () =>
			api('POST', at('/api/users'), {
				user: admin,
				headers: FORGED_HEADERS,
				body: { username: 'newcomer', email: 'newcomer@example.test' }
			}),
		to: 'newcomer@example.test',
		link: /^\/invite\/[0-9a-f-]{36}$/
	},
	{
		name: 'an invite, sent again',
		send: () => api('POST', at(`/api/users/${member.id}/invite`), { user: admin, headers: FORGED_HEADERS }),
		to: 'member@example.test',
		link: /^\/invite\/[0-9a-f-]{36}$/
	},
	{
		name: "a public request's confirmation",
		send: () =>
			api('POST', at('/api/requests'), {
				headers: { ...FORGED_HEADERS, 'x-form-token': issueFormToken() },
				body: asking()
			}),
		to: 'pat@example.test',
		link: /^\/request\/\d+\/confirm\?token=[0-9a-f]{64}$/
	},
	{
		name: 'a reply to a request, mailed to its requester',
		send: () =>
			api('POST', at(`/api/requests/${pendingRequest().id}/messages`), {
				user: owner,
				headers: FORGED_HEADERS,
				body: { message: 'Which export do you mean?', senderType: 'admin' }
			}),
		to: 'rita@example.test',
		link: /^\/request\/\d+\/reply\?token=b{64}$/
	},
	{
		// Card 2158: asked for from the page a dead link opens, by someone with
		// no session, and mailed to the address on the request.
		name: 'a new link to a request, asked for by its requester',
		send: () =>
			api('POST', at(`/api/requests/${pendingRequest().id}/link`), {
				headers: FORGED_HEADERS,
				body: { email: 'rita@example.test' }
			}),
		to: 'rita@example.test',
		link: /^\/request\/\d+\/reply\?token=b{64}$/
	},
	{
		name: "the requester's progress mail, when their card is moved",
		send: () => {
			acceptedRequest();
			return api('PUT', at(`/api/cards/${card.id}`), {
				user: owner,
				headers: FORGED_HEADERS,
				body: { columnId: cols['In Progress'].id }
			});
		},
		to: 'rita@example.test',
		link: /^\/request\/\d+\/reply\?token=a{64}$/
	},
	{
		name: 'an ordinary notification, of a card that was assigned',
		send: () =>
			api('POST', at(`/api/cards/${card.id}/assignees`), {
				user: owner,
				headers: FORGED_HEADERS,
				body: { userId: member.id }
			}),
		to: 'member@example.test',
		link: /^\/board\/\d+\?card=\d+$/
	}
];

/** Each place an address is configured, with the two below it set as well: the first that is set is the one used. */
const SOURCES: { name: string; arrange: () => void; base: string }[] = [
	{
		name: 'the App URL setting',
		arrange: () => {
			setAppUrl('https://dumpfire.example.test');
			process.env.APP_URL = 'https://from-app-url.example.test';
			process.env.ORIGIN = 'https://from-origin.example.test';
		},
		base: 'https://dumpfire.example.test'
	},
	{
		name: 'APP_URL, with no App URL set',
		arrange: () => {
			process.env.APP_URL = 'https://from-app-url.example.test/';
			process.env.ORIGIN = 'https://from-origin.example.test';
		},
		base: 'https://from-app-url.example.test'
	},
	{
		name: 'ORIGIN, with neither, as the adapter reads it',
		arrange: () => {
			// The adapter takes the origin of whatever address it is given.
			process.env.ORIGIN = ' https://From-Origin.example.test:443/ ';
		},
		base: 'https://from-origin.example.test'
	}
];

describe('this file', () => {
	it('runs as a built server: the dev flag is off in every module', () => {
		expect(dev).toBe(false);
		// And so the mode `linkBaseUrl` is in when it is not told.
		expect(linkBaseUrl(new URL(at('/')))).toBeNull();
	});
});

describe.each(SOURCES)('a mailed link, with $name', ({ arrange, base }) => {
	it.each(MAILS)('begins with it in $name, whatever the request says', async ({ send, to, link }) => {
		arrange();

		const res = await send();
		await sent.settle();

		expect(res.status).toBeLessThan(300);
		const mails = sent.emails.filter((mail) => mail.to === to);
		expect(mails, JSON.stringify(sent.emails.map((mail) => mail.to))).toHaveLength(1);
		const links = linksIn(mails[0].html);
		expect(links).toHaveLength(1);
		expect(links[0].startsWith(`${base}/`)).toBe(true);
		expect(links[0].slice(base.length)).toMatch(link);
		// Nothing of what the request said of itself is in any mail.
		for (const mail of sent.emails) expect(mail.html).not.toContain(FORGED);
	});
});

describe('linkBaseUrl, the one function that decides', () => {
	const FROM = new URL(at('/api/users'));

	it('is the App URL, then APP_URL, then ORIGIN, in a built server and under the dev server alike', () => {
		for (const isDev of [false, true]) {
			process.env.ORIGIN = 'https://from-origin.example.test';
			expect(linkBaseUrl(FROM, isDev)).toBe('https://from-origin.example.test');
			process.env.APP_URL = 'https://from-app-url.example.test';
			expect(linkBaseUrl(FROM, isDev)).toBe('https://from-app-url.example.test');
			setAppUrl('https://dumpfire.example.test');
			expect(linkBaseUrl(FROM, isDev)).toBe('https://dumpfire.example.test');

			db.delete(settings).run();
			delete process.env.APP_URL;
			delete process.env.ORIGIN;
		}
	});

	it('is nothing in a built server that was given none of them, and never the address the request was sent to', () => {
		expect(linkBaseUrl(FROM, false)).toBeNull();
		expect(linkBaseUrl(undefined, false)).toBeNull();
	});

	it('is the address the request was sent to under the dev server, last of all, as it always was', () => {
		expect(linkBaseUrl(new URL('http://localhost:5173/api/users'), true)).toBe('http://localhost:5173');
		expect(linkBaseUrl(undefined, true)).toBeNull();
	});

	it('takes no request, so no header of one can reach it', () => {
		// (url, isDev): were a request ever passed again, this is where it would show.
		expect(linkBaseUrl.length).toBeLessThanOrEqual(2);
	});

	it('reads ORIGIN as the adapter does, and an ORIGIN the adapter would refuse as none', () => {
		expect(configuredOrigin('https://kanban.example.com/')).toBe('https://kanban.example.com');
		expect(configuredOrigin(' http://LOCALHOST:3000 ')).toBe('http://localhost:3000');
		expect(configuredOrigin('https://kanban.example.com:8443/some/path?x=1')).toBe('https://kanban.example.com:8443');
		for (const none of [undefined, '', 'kanban.example.com', 'ftp://kanban.example.com', 'not an address']) {
			expect(configuredOrigin(none), String(none)).toBeNull();
		}
	});
});

describe('a server with no address configured', () => {
	const warnings = () =>
		sqlite.prepare("SELECT context, message FROM system_logs WHERE level = 'WARN' ORDER BY id").all() as {
			context: string;
			message: string;
		}[];

	beforeEach(() => {
		// A line at WARN is kept only where the level lets it be.
		process.env.LOG_LEVEL = 'WARN';
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	it.each([
		{
			name: 'an invite for a new user, and does not make the user',
			send: () =>
				api('POST', at('/api/users'), {
					user: admin,
					headers: FORGED_HEADERS,
					body: { username: 'newcomer', email: 'newcomer@example.test' }
				})
		},
		{
			name: 'an invite sent again, and makes no token',
			send: () => api('POST', at(`/api/users/${member.id}/invite`), { user: admin, headers: FORGED_HEADERS })
		},
		{
			name: 'a public request, which is nothing without its confirmation link',
			send: () =>
				api('POST', at('/api/requests'), {
					headers: { ...FORGED_HEADERS, 'x-form-token': issueFormToken() },
					body: asking()
				})
		},
		{
			name: 'a new link to a request (card 2158), which is nothing but its link',
			send: (id?: number) =>
				api('POST', at(`/api/requests/${id}/link`), {
					headers: FORGED_HEADERS,
					body: { email: 'rita@example.test' }
				}),
			// The request it asks about is there before the snapshot.
			arrange: () => pendingRequest().id,
			// Its requester has no account: told in plain words, and why is in the log (card 2169's O7).
			said: 'New links cannot be sent just now. Please contact the team that sent you the link.'
		}
	])('refuses $name, before anything is written, and says why', async ({ send, arrange, said }: { send: (id?: number) => Promise<ApiResult>; arrange?: () => number; said?: string }) => {
		// The key the form's tokens are signed with is made, and kept in the
		// settings, the first time one is needed: made now, so that it is not
		// taken for a row the refused request wrote.
		issueFormToken();
		const id = arrange?.();
		const before = snapshotDb();

		const res = await send(id);
		await sent.settle();

		expect(res.status).toBe(503);
		expect(res.body.message).toBe(said ?? NO_LINK_ADDRESS);
		if (said) expect(warnings().map((line) => line.message)).toContain(`A new link to a request was asked for, and none can be sent: ${NO_LINK_ADDRESS}.`);
		expect(NO_LINK_ADDRESS).toContain('no address configured');
		expectUnchanged(before);
		expect(db.select().from(inviteTokens).all()).toEqual([]);
		expect(sent.emails).toEqual([]);
	});

	it('still creates a user who is given a password: there is no link to make', async () => {
		const res = await api('POST', at('/api/users'), {
			user: admin,
			headers: FORGED_HEADERS,
			body: { username: 'newcomer', email: 'newcomer@example.test', password: 'a long password' }
		});

		expect(res.status).toBe(201);
		expect(sent.emails).toEqual([]);
	});

	it("skips the requester's progress mail with one line in the log, and the move is made all the same", async () => {
		acceptedRequest();

		const res = await api('PUT', at(`/api/cards/${card.id}`), {
			user: owner,
			headers: FORGED_HEADERS,
			body: { columnId: cols['In Progress'].id }
		});
		await sent.settle();

		expect(res.status).toBe(200);
		expect(sqlite.prepare('SELECT column_id AS columnId FROM cards WHERE id = ?').get(card.id)).toEqual({
			columnId: cols['In Progress'].id
		});
		expect(sent.emails).toEqual([]);
		expect(warnings()).toHaveLength(1);
		expect(warnings()[0].context).toBe('NOTIFY');
		expect(warnings()[0].message).toMatch(/^The progress mail to the requester of request \d+ was not sent: this server has no address/);
	});

	it('skips an ordinary notification the same way, and what it was about is done', async () => {
		const res = await api('POST', at(`/api/cards/${card.id}/assignees`), {
			user: owner,
			headers: FORGED_HEADERS,
			body: { userId: member.id }
		});
		await sent.settle();

		expect(res.status).toBe(200);
		expect(sqlite.prepare('SELECT COUNT(*) AS n FROM card_assignees').get()).toEqual({ n: 1 });
		expect(sent.emails).toEqual([]);
		expect(warnings().map((line) => line.message)).toEqual([
			'The mail about a card that was assigned was not sent: this server has no address to make its link from. ' +
				'Set the App URL on the admin page, or start the server with ORIGIN set to its public address.'
		]);
	});

	it('saves a reply to a request and skips its mail, and takes a request from somebody signed in', async () => {
		const reply = await api('POST', at(`/api/requests/${pendingRequest().id}/messages`), {
			user: owner,
			headers: FORGED_HEADERS,
			body: { message: 'Which export do you mean?', senderType: 'admin' }
		});
		// Signed in, there is nothing to confirm and so no link the request needs.
		const asked = await api('POST', at('/api/requests'), { user: member, headers: FORGED_HEADERS, body: asking() });
		await sent.settle();

		expect(reply.status).toBe(200);
		expect(asked.status).toBe(201);
		expect(sqlite.prepare('SELECT COUNT(*) AS n FROM request_messages').get()).toEqual({ n: 1 });
		expect(sent.emails).toEqual([]);
		expect(warnings()).toHaveLength(2);
	});
});

describe('the line in the system log when ORIGIN is still the address the image is built with', () => {
	const lines = () =>
		sqlite.prepare("SELECT level, message FROM system_logs WHERE context = 'STARTUP' ORDER BY id").all() as {
			level: string;
			message: string;
		}[];

	beforeEach(() => {
		process.env.LOG_LEVEL = 'WARN';
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	it('is one WARN line when no App URL is set, and it is what the server says as it starts', () => {
		process.env.ORIGIN = PLACEHOLDER_ORIGIN;
		// With a superadmin, so that this is all there is to say.
		makeUser({ username: 'chief', role: 'superadmin' });

		reportInstallation();

		expect(lines()).toHaveLength(1);
		expect(lines()[0].level).toBe('WARN');
		expect(lines()[0].message).toContain('ORIGIN is http://localhost:3000');
		expect(lines()[0].message).toContain('no App URL is set');
	});

	it('is not said when an App URL is set, in the settings or in APP_URL', () => {
		process.env.ORIGIN = PLACEHOLDER_ORIGIN;

		process.env.APP_URL = 'https://dumpfire.example.test';
		expect(reportPlaceholderOrigin()).toBe(false);
		delete process.env.APP_URL;
		setAppUrl('https://dumpfire.example.test');
		expect(reportPlaceholderOrigin()).toBe(false);

		expect(lines()).toEqual([]);
	});

	it('is not said when ORIGIN is another address, or is not set', () => {
		expect(reportPlaceholderOrigin()).toBe(false);
		process.env.ORIGIN = 'https://dumpfire.example.test';
		expect(reportPlaceholderOrigin()).toBe(false);

		expect(lines()).toEqual([]);
	});

	it('is not taken for an address that is not usable: a server that really is at localhost:3000 mails that', () => {
		process.env.ORIGIN = PLACEHOLDER_ORIGIN;

		expect(linkBaseUrl(new URL(at('/')), false)).toBe(PLACEHOLDER_ORIGIN);
	});
});
