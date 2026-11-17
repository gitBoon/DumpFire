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
import { reportAppUrlNotUsed, reportAppUrlSetByOther, reportInstallation, reportPlaceholderOrigin } from '$lib/server/startup-checks';
import { mailPlacesNow, recordMailSetters } from '$lib/server/setting-setters';
import { api, type ApiResult } from './helpers/api';
import { effects, type Effects } from './helpers/effects';
import { FIXTURE_PASSWORD, addBoardMember, makeBoard, makeCard, makeSmtp, makeUser, resetDb, stepUp } from './helpers/fixtures';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';

vi.mock('$app/environment', () => ({ dev: false, building: false, browser: false, version: 'test' }));

/** Where the forged request claims to be for. In no link. */
const FORGED = 'evil.example.test';
const FORGED_HEADERS = { host: FORGED, 'x-forwarded-host': FORGED, 'x-forwarded-proto': 'https' };
/** A path on the forged address: what a server with no `ORIGIN` takes a request's address to be. */
const at = (path: string) => `https://${FORGED}${path}`;

/**
 * The administrator's request with `body`, sent with the forged headers, and
 * with their current password from a session of theirs (card 2701).
 */
const confirmed = (body: Record<string, unknown> = {}) => {
	const sent = stepUp(admin, body);
	return { ...sent, headers: { ...FORGED_HEADERS, ...sent.headers } };
};

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
			resolvedCardId: card.id
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
			status: 'pending'
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
		send: () => api('POST', at('/api/users'), confirmed({ username: 'newcomer', email: 'newcomer@example.test' })),
		to: 'newcomer@example.test',
		link: /^\/invite\/[0-9a-f-]{36}$/
	},
	{
		name: 'an invite, sent again',
		send: () => api('POST', at(`/api/users/${member.id}/invite`), confirmed()),
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
		// A link of the mail's own (card 2870): only its hash is kept.
		link: /^\/request\/\d+\/reply\?token=[0-9a-f]{64}$/
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
		link: /^\/request\/\d+\/reply\?token=[0-9a-f]{64}$/
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
		link: /^\/request\/\d+\/reply\?token=[0-9a-f]{64}$/
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
			// On ORIGIN's origin, with a path of its own: since card 2847 a setting
			// on another origin than the configuration names is not used.
			setAppUrl('https://from-origin.example.test/dumpfire');
			process.env.APP_URL = 'https://from-app-url.example.test';
			process.env.ORIGIN = 'https://from-origin.example.test';
		},
		base: 'https://from-origin.example.test/dumpfire'
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
			// On an origin the configuration names (card 2847).
			setAppUrl('https://from-origin.example.test/dumpfire');
			expect(linkBaseUrl(FROM, isDev)).toBe('https://from-origin.example.test/dumpfire');

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

	// The invites are refused before the administrator's password is checked
	// (card 2701): sent with it, and with no session, so that nothing is made
	// for them before the snapshot.
	it.each([
		{
			name: 'an invite for a new user, and does not make the user',
			send: () =>
				api('POST', at('/api/users'), {
					user: admin,
					headers: FORGED_HEADERS,
					body: { username: 'newcomer', email: 'newcomer@example.test', currentPassword: FIXTURE_PASSWORD }
				})
		},
		{
			name: 'an invite sent again, and makes no token',
			send: () =>
				api('POST', at(`/api/users/${member.id}/invite`), { user: admin, headers: FORGED_HEADERS, body: { currentPassword: FIXTURE_PASSWORD } })
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

	// Card 2851: a user given a password needs a set-up link for two-step sign-in, which has no address either.
	it('refuses a user who is given a password too, before the password is compared: there is no set-up link to make', async () => {
		const request = confirmed({ username: 'newcomer', email: 'newcomer@example.test', password: 'a long password' });
		const before = snapshotDb();

		const res = await api('POST', at('/api/users'), request);
		await sent.settle();

		expect(res.status).toBe(503);
		expect(res.body.message).toBe(NO_LINK_ADDRESS);
		// Nothing written: no user and no link, and not the session's count or the code's step either, which a compare writes.
		expectUnchanged(before);
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

// Card 2847, D3: a saved App URL on another origin than the configuration names is not used, and the start says so.
describe('the line in the system log when the App URL saved is not used (card 2847)', () => {
	const lines = () =>
		sqlite.prepare("SELECT level, message FROM system_logs WHERE context = 'STARTUP' ORDER BY id").all() as {
			level: string;
			message: string;
		}[];
	const rowIs = (value: string) => {
		sqlite.prepare("DELETE FROM settings WHERE key = 'app_url'").run();
		setAppUrl(value);
	};

	beforeEach(() => {
		process.env.LOG_LEVEL = 'WARN';
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	it('is one WARN line as the server starts naming the row, the configured origins and where links begin; none where the row is used, nothing is configured, or card 2850’s line applies', () => {
		rowIs('https://elsewhere.example.test');
		process.env.ORIGIN = 'https://origin.example.test';
		// With a superadmin, so that this is all there is to say.
		makeUser({ username: 'chief', role: 'superadmin' });

		reportInstallation();

		expect(lines()).toEqual([
			{
				level: 'WARN',
				message:
					"The App URL saved on the admin page, https://elsewhere.example.test, is not used: it is not on this server's own address " +
					'(https://origin.example.test), which its configuration sets. Links in mail begin with https://origin.example.test. ' +
					'The superadmin can clear it under Application Settings.'
			}
		]);

		// On the configured origin: used, and nothing to say.
		rowIs('https://origin.example.test/board');
		expect(reportAppUrlNotUsed()).toBe(false);
		// Nothing configured, the image's placeholder ORIGIN included: the setting is the only word on the address.
		rowIs('https://elsewhere.example.test');
		delete process.env.ORIGIN;
		expect(reportAppUrlNotUsed()).toBe(false);
		process.env.ORIGIN = PLACEHOLDER_ORIGIN;
		expect(reportAppUrlNotUsed()).toBe(false);
		// An https App URL on the host of an http ORIGIN, where card 2850's line was said this start: that line names it.
		rowIs('https://host.example.test');
		process.env.ORIGIN = 'http://host.example.test';
		expect(reportAppUrlNotUsed(true)).toBe(false);

		expect(lines()).toHaveLength(1);
	});

	// The code review, CS3: it was kept back on the hosts alone, also where COOKIE_SECURE had kept card 2850's line back.
	it('is said where card 2850’s line is not, COOKIE_SECURE keeping it back, and only card 2850’s is said where it is', () => {
		rowIs('https://host.example.test');
		process.env.ORIGIN = 'http://host.example.test';
		makeUser({ username: 'chief', role: 'superadmin' });
		const secure = process.env.COOKIE_SECURE;
		process.env.COOKIE_SECURE = 'true';
		try {
			reportInstallation();
		} finally {
			if (secure === undefined) delete process.env.COOKIE_SECURE;
			else process.env.COOKIE_SECURE = secure;
		}

		expect(lines()).toEqual([
			{
				level: 'WARN',
				message:
					"The App URL saved on the admin page, https://host.example.test, is not used: it is not on this server's own address " +
					'(http://host.example.test), which its configuration sets. Links in mail begin with http://host.example.test. ' +
					'The superadmin can clear it under Application Settings.'
			}
		]);

		sqlite.prepare('DELETE FROM system_logs').run();
		delete process.env.COOKIE_SECURE;
		reportInstallation();
		expect(lines().map((line) => line.message)).toEqual([expect.stringMatching(/^ORIGIN is http:\/\/host\.example\.test but the App URL is https:\/\/host\.example\.test:/)]);
	});

	// The code review, CS1: a row that is no plain web address is said quoted, so no control character reaches the log as one.
	it('quotes a saved App URL that is no plain web address', () => {
		rowIs('https://evil.example\n@host.example.test');
		expect(reportAppUrlNotUsed()).toBe(true);
		expect(lines().map((line) => line.message)).toEqual([
			'The App URL saved on the admin page, "https://evil.example\\n@host.example.test", is not used: it is not a plain web address. ' +
				'Links in mail begin with no address: none is configured. The superadmin can clear it under Application Settings.'
		]);
	});
});

// The code review, CS2: with no address configured, a row an administrator saved before card 2847 still steers every link.
describe('the line in the system log when the App URL in use was not saved by the superadmin (card 2847)', () => {
	const lines = () =>
		(sqlite.prepare("SELECT message FROM system_logs WHERE context = 'STARTUP' ORDER BY id").all() as { message: string }[]).map((line) => line.message);
	/** The App URL row, and who is recorded as having set it, as the route records a save (card 2397). */
	const savedBy = (who: SessionUser, url: string) => {
		const before = mailPlacesNow();
		setAppUrl(url);
		recordMailSetters(before, { id: who.id, superadmin: who.role === 'superadmin' }, false);
	};
	const ASK = 'not the superadmin; check it, or clear it and save it again as the superadmin.';

	beforeEach(() => {
		process.env.LOG_LEVEL = 'WARN';
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	it('names the account recorded, or none, and says nothing of the superadmin’s or of one not used', () => {
		const chief = makeUser({ username: 'chief', role: 'superadmin' });
		savedBy(admin, 'https://admins.example.test');

		// Said as the server starts, with nothing configured, so the row is in use.
		reportInstallation();
		expect(lines()).toEqual([`The App URL https://admins.example.test was saved by "admin", ${ASK}`]);

		sqlite.prepare("DELETE FROM setting_setters WHERE setting = 'app_url'").run();
		expect(reportAppUrlSetByOther()).toBe(true);
		expect(lines()[1]).toBe(`The App URL https://admins.example.test was saved by no recorded account, ${ASK}`);

		// Not in use: ORIGIN names another address (the not-used line says that one).
		process.env.ORIGIN = 'https://origin.example.test';
		expect(reportAppUrlSetByOther()).toBe(false);
		delete process.env.ORIGIN;

		// The superadmin's: nothing to say.
		sqlite.prepare("DELETE FROM settings WHERE key = 'app_url'").run();
		savedBy(chief, 'https://chiefs.example.test');
		expect(reportAppUrlSetByOther()).toBe(false);
		expect(lines()).toHaveLength(2);
	});
});
