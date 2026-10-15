/**
 * The Content-Security-Policy of every page, and the Inter font served by
 * DumpFire itself (cards 2162 and 2203; docs/planning/card-2162-colours-and-csp.md,
 * sections 2, 6, 8 and 9).
 *
 * The policy is SvelteKit's `kit.csp` in svelte.config.js: SvelteKit sets it on
 * every page it renders, with a fresh nonce on its own start-up script and on
 * the theme script in src/app.html. `secured()` (gate-answers.ts) never replaces
 * it, puts none on anything else, and moves it to report only while
 * `CSP_MODE=report-only`.
 *
 * In the gate harness SvelteKit runs in development mode, where it adds
 * 'unsafe-inline' to the style directives of the header itself (for the
 * <style> elements `vite dev` injects). So the page tests read the directives
 * that development leaves alone, and the first test holds the configured ones,
 * style directives included, as a built server sends them.
 *
 * What the suite cannot show, because it has no browser: that a browser applies
 * the policy and every page still works under it. That is the plan's hands-on
 * checks.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sqlite } from '$lib/server/db';
import { SESSION_COOKIE_NAME, type SessionUser } from '$lib/server/auth';
import { cspMode, secured } from '$lib/server/gate-answers';
import { resetAllRateLimits } from '$lib/server/rate-limit';
import { reportCspMode, reportInstallation } from '$lib/server/startup-checks';
import { makeApiKey, makeAttachment, makeBoard, makeCard, makeSession, makeUser, resetDb } from './helpers/fixtures';
import { gate } from './helpers/gate';

const ROOT = process.cwd();
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

/** The policy of section 2.1, as revised by 9.3 (card 2203): written out here, not taken from the config. */
const POLICY = {
	mode: 'auto',
	directives: {
		'default-src': ['self'],
		'script-src': ['self'],
		'style-src': ['self', 'unsafe-inline'],
		'style-src-elem': ['self'],
		'style-src-attr': ['unsafe-inline'],
		'img-src': ['self', 'data:'],
		'font-src': ['self'],
		'connect-src': ['self'],
		'frame-src': ['blob:'],
		'object-src': ['blob:'],
		'base-uri': ['self'],
		'form-action': ['self']
	}
};

/** A policy header as a map of directive to its sources. */
function directivesOf(header: string): Record<string, string[]> {
	return Object.fromEntries(
		header
			.split(';')
			.map((part) => part.trim().split(/\s+/))
			.filter((words) => words[0])
			.map(([name, ...sources]) => [name, sources])
	);
}

/** The nonce a policy gives its scripts, or null. */
function nonceOf(header: string): string | null {
	const sources = directivesOf(header)['script-src'] ?? [];
	const found = sources.map((s) => /^'nonce-([^']+)'$/.exec(s)).find(Boolean);
	return found ? found[1] : null;
}

/**
 * Every `<script` tag of a page that a browser would run: a data block
 * (`type="application/json"`, which a universal `load` would add) runs
 * nothing and needs no nonce.
 */
function executableScripts(html: string): string[] {
	return [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]).filter((tag) => !/\btype\s*=\s*"application\/json"/i.test(tag));
}

/** The five headers `secured()` sets, as a page another site may not frame carries them. */
const FIVE: Record<string, string | null> = {
	'x-content-type-options': 'nosniff',
	'x-frame-options': 'DENY',
	'referrer-policy': 'strict-origin-when-cross-origin',
	'permissions-policy': 'camera=(), microphone=(), geolocation=()',
	'x-xss-protection': '0'
};
const headersOf = (res: Response) => Object.fromEntries(Object.keys(FIVE).map((name) => [name, res.headers.get(name)]));
const HTML = { accept: 'text/html' };

let user: SessionUser;
let asUser: Record<string, string>;

beforeEach(() => {
	resetDb();
	resetAllRateLimits();
	user = makeUser();
	asUser = { cookie: `${SESSION_COOKIE_NAME}=${makeSession(user)}` };
});

afterEach(() => {
	resetAllRateLimits();
	delete process.env.CSP_MODE;
	vi.restoreAllMocks();
});

describe('the configured policy', () => {
	it('is exactly the plan’s: a nonce per page, no <style> element, nothing from another site', async () => {
		const config = (await import('../svelte.config.js')).default;

		expect(config.kit?.csp).toEqual(POLICY);
		// A <style> element is refused; style attributes are not (decision 7).
		expect(config.kit?.csp?.directives?.['style-src-elem']).not.toContain('unsafe-inline');
		// Decisions 8 and 10, and 2.1's "not set" row: none of these.
		for (const absent of ['upgrade-insecure-requests', 'frame-ancestors', 'report-uri', 'report-to']) {
			expect(config.kit?.csp?.directives, absent).not.toHaveProperty(absent);
		}
		expect(config.kit?.csp).not.toHaveProperty('reportOnly');
	});

	// What would make Svelte write a <style> element at run time
	// (svelte/src/internal/client/dom/css.js), which `style-src-elem 'self'`
	// refuses: a component compiled with its CSS injected (R13).
	it('is not undone by a component that injects its own <style> element', async () => {
		const config = (await import('../svelte.config.js')).default as {
			compilerOptions?: { css?: unknown };
			vitePlugin?: { emitCss?: unknown };
		};
		expect(config.compilerOptions?.css).toBeUndefined();
		expect(config.vitePlugin?.emitCss).not.toBe(false);
		expect(read('vite.config.ts')).not.toMatch(/emitCss|css\s*:\s*['"]injected['"]/);

		const injecting = svelteFiles('src').filter((file) => /<svelte:options[^>]*\bcss\s*=\s*["']injected["']/.test(read(file)));
		expect(injecting).toEqual([]);
	});
});

/** Every `.svelte` file under `dir`, as a path from the repository root. */
function svelteFiles(dir: string): string[] {
	return filesUnder(dir).filter((file) => file.endsWith('.svelte'));
}

/** Every file under `dir`, as a path from the repository root with forward slashes. */
function filesUnder(dir: string): string[] {
	const out: string[] = [];
	const walk = (abs: string) => {
		for (const name of readdirSync(abs)) {
			const path = join(abs, name);
			if (statSync(path).isDirectory()) walk(path);
			else out.push(relative(ROOT, path).replace(/\\/g, '/'));
		}
	};
	walk(join(ROOT, dir));
	return out;
}

describe('a page', () => {
	it(
		'carries the policy, with a nonce of its own on every script it has, and the five headers as before',
		async () => {
			const { board } = makeBoard({ owner: user });
			const pages: [string, string, Record<string, string>, number][] = [
				['the login page, for nobody', '/login', HTML, 200],
				['the API’s documents, for nobody', '/docs', HTML, 200],
				['the dashboard, signed in', '/', { ...asUser, ...HTML }, 200],
				['a board, signed in', `/board/${board.id}`, { ...asUser, ...HTML }, 200],
				['All Tasks, signed in', '/all', { ...asUser, ...HTML }, 200],
				['the request form, for nobody', '/request', HTML, 200],
				['a path that is no route, signed in', '/no-such-page', { ...asUser, ...HTML }, 404]
			];

			const nonces: string[] = [];
			for (const [what, path, headers, status] of pages) {
				const res = await gate('GET', path, { headers });
				const html = await res.text();
				expect({ what, status: res.status }).toEqual({ what, status });

				const header = res.headers.get('content-security-policy');
				expect(header, what).toBeTruthy();
				const directives = directivesOf(header!);
				const nonce = nonceOf(header!);
				expect(nonce, what).toBeTruthy();
				nonces.push(nonce!);

				expect(directives['default-src'], what).toEqual(["'self'"]);
				expect(directives['script-src'], what).toEqual(["'self'", `'nonce-${nonce}'`]);
				expect(directives['img-src'], what).toEqual(["'self'", 'data:']);
				expect(directives['font-src'], what).toEqual(["'self'"]);
				expect(directives['connect-src'], what).toEqual(["'self'"]);
				expect(directives['frame-src'], what).toEqual(['blob:']);
				expect(directives['object-src'], what).toEqual(['blob:']);
				expect(directives['base-uri'], what).toEqual(["'self'"]);
				expect(directives['form-action'], what).toEqual(["'self'"]);
				expect(directives, what).not.toHaveProperty('frame-ancestors');
				expect(res.headers.get('content-security-policy-report-only'), what).toBeNull();

				// The theme script and SvelteKit's own, at least, and every one with
				// this page's nonce: a script without it would not run.
				const scripts = executableScripts(html);
				expect(scripts.length, what).toBeGreaterThanOrEqual(2);
				for (const tag of scripts) expect(tag, what).toContain(`nonce="${nonce}"`);
				expect(html, what).toContain('dumpfire-theme');

				expect(headersOf(res), what).toEqual(path === '/request' ? { ...FIVE, 'x-frame-options': null } : FIVE);
			}

			// A nonce is made for each page, never kept.
			expect(new Set(nonces).size).toBe(nonces.length);
		},
		60_000
	);

	it(
		'names no Google host and asks no other site for anything before it is drawn',
		async () => {
			for (const path of ['/login', '/request']) {
				const html = await (await gate('GET', path, { headers: HTML })).text();
				expect(html, path).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
				expect(html, path).not.toMatch(/rel="preconnect"/);
			}
		},
		60_000
	);
});

describe('nothing but a page', () => {
	it('carries a policy: an API answer, a v1 answer, the gate’s 401 and a redirect have none, and an attachment keeps its own', async () => {
		const withKey = { authorization: `Bearer ${makeApiKey(user)}` };
		const card = makeCard(makeBoard({ owner: user }).cols['To Do']);
		const attachment = makeAttachment(card, { name: 'notes.html', mimeType: 'text/html', content: '<script>1</script>' });

		const answers: [string, Response, number][] = [
			['an internal API answer', await gate('GET', '/api/boards', { headers: { ...asUser, accept: '*/*' } }), 200],
			['a v1 answer', await gate('GET', '/api/v1/me', { headers: withKey }), 200],
			['the gate’s 401', await gate('GET', '/api/v1/me'), 401],
			['a redirect to sign in', await gate('GET', '/', { headers: HTML }), 303]
		];
		for (const [what, res, status] of answers) {
			expect({ what, status: res.status }).toEqual({ what, status });
			expect(res.headers.get('content-security-policy'), what).toBeNull();
			expect(res.headers.get('content-security-policy-report-only'), what).toBeNull();
		}

		const own = await gate('GET', `/api/cards/${card.id}/attachments/${attachment.id}`, { headers: asUser });
		expect(own.status).toBe(200);
		expect(own.headers.get('content-security-policy')).toBe('sandbox');
	});
});

describe('report-only mode', () => {
	it('reads CSP_MODE: report-only when it says so, enforced for anything else or nothing', () => {
		expect(cspMode('report-only')).toBe('report-only');
		for (const value of [undefined, 'enforce', 'off', '', 'REPORT-ONLY', ' report-only']) {
			expect(cspMode(value), String(value)).toBe('enforce');
		}
		process.env.CSP_MODE = 'report-only';
		expect(cspMode()).toBe('report-only');
		delete process.env.CSP_MODE;
		expect(cspMode()).toBe('enforce');
	});

	it(
		'sends a page the same policy to report only, and leaves an attachment’s sandbox enforced',
		async () => {
			const enforced = (await gate('GET', '/login', { headers: HTML })).headers.get('content-security-policy')!;

			process.env.CSP_MODE = 'report-only';
			const res = await gate('GET', '/login', { headers: HTML });
			const html = await res.text();

			expect(res.status).toBe(200);
			expect(res.headers.get('content-security-policy')).toBeNull();
			const reported = res.headers.get('content-security-policy-report-only');
			expect(reported).toBeTruthy();
			// The same policy, but for its own nonce, which is still on every script.
			const nonce = nonceOf(reported!)!;
			expect(reported!.replace(nonce, 'N')).toBe(enforced.replace(nonceOf(enforced)!, 'N'));
			for (const tag of executableScripts(html)) expect(tag).toContain(`nonce="${nonce}"`);
			expect(headersOf(res)).toEqual(FIVE);

			const card = makeCard(makeBoard({ owner: user }).cols['To Do']);
			const attachment = makeAttachment(card, { name: 'notes.html', mimeType: 'text/html', content: '<script>1</script>' });
			const own = await gate('GET', `/api/cards/${card.id}/attachments/${attachment.id}`, { headers: asUser });
			expect(own.headers.get('content-security-policy')).toBe('sandbox');
			expect(own.headers.get('content-security-policy-report-only')).toBeNull();
		},
		60_000
	);

	it('is a move made by secured() on a page’s answer alone, and only in that mode', () => {
		const page = () =>
			new Response('<!doctype html>', {
				headers: { 'x-sveltekit-page': 'true', 'content-type': 'text/html', 'content-security-policy': "default-src 'self'" }
			});
		const attachment = () => new Response('x', { headers: { 'content-security-policy': 'sandbox' } });

		const moved = secured(page(), '/login', 'report-only');
		expect(moved.headers.get('content-security-policy')).toBeNull();
		expect(moved.headers.get('content-security-policy-report-only')).toBe("default-src 'self'");

		const kept = secured(page(), '/login', 'enforce');
		expect(kept.headers.get('content-security-policy')).toBe("default-src 'self'");
		expect(kept.headers.get('content-security-policy-report-only')).toBeNull();

		const own = secured(attachment(), '/api/cards/[id]/attachments/[attachmentId]', 'report-only');
		expect(own.headers.get('content-security-policy')).toBe('sandbox');
		expect(own.headers.get('content-security-policy-report-only')).toBeNull();

		// A page with no policy of its own is given none.
		const none = secured(new Response('x', { headers: { 'x-sveltekit-page': 'true' } }), '/login', 'report-only');
		expect(none.headers.get('content-security-policy')).toBeNull();
		expect(none.headers.get('content-security-policy-report-only')).toBeNull();
	});
});

describe('the start-up line', () => {
	const cspLines = () =>
		sqlite.prepare("SELECT level, context, message FROM system_logs WHERE message LIKE 'CSP_MODE%' ORDER BY id").all() as {
			level: string;
			context: string;
			message: string;
		}[];

	it('is said once for report-only, once naming any other value, and not for enforce or nothing', () => {
		const level = process.env.LOG_LEVEL;
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			process.env.LOG_LEVEL = 'WARN';
			sqlite.prepare('DELETE FROM system_logs').run();

			expect(reportCspMode(undefined)).toBe(false);
			expect(reportCspMode('enforce')).toBe(false);
			expect(cspLines()).toEqual([]);

			expect(reportCspMode('report-only')).toBe(true);
			expect(cspLines()).toEqual([
				{
					level: 'WARN',
					context: 'STARTUP',
					message:
						'CSP_MODE=report-only: pages are sent the Content-Security-Policy to report only, not to enforce; ' +
						'remove CSP_MODE once the trial is over. See docs/deployment.md.'
				}
			]);

			sqlite.prepare('DELETE FROM system_logs').run();
			expect(reportCspMode('off')).toBe(true);
			expect(cspLines()).toEqual([
				{
					level: 'WARN',
					context: 'STARTUP',
					message: 'CSP_MODE is "off", which is neither enforce nor report-only: the Content-Security-Policy is enforced.'
				}
			]);

			// Said by the start-up checks, from the environment.
			sqlite.prepare('DELETE FROM system_logs').run();
			process.env.CSP_MODE = 'report-only';
			reportInstallation();
			expect(cspLines().map((line) => line.message)).toEqual([expect.stringMatching(/^CSP_MODE=report-only: /)]);
		} finally {
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		}
	});

	it('is written to the console whatever LOG_LEVEL is', () => {
		const level = process.env.LOG_LEVEL;
		const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			process.env.LOG_LEVEL = 'ERROR';
			expect(reportCspMode('report-only')).toBe(true);
			expect(warned.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('CSP_MODE=report-only'))).toHaveLength(1);
		} finally {
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		}
	});
});

describe('the theme script', () => {
	it('is in app.html with the page’s nonce, and no longer in the root layout', () => {
		const layout = read('src/routes/+layout.svelte');
		const head = /<svelte:head>([\s\S]*?)<\/svelte:head>/.exec(layout)?.[1] ?? '';
		expect(head).not.toMatch(/<script/i);

		const app = read('src/app.html');
		const scripts = [...app.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
		expect(scripts).toEqual(['<script nonce="%sveltekit.nonce%">']);
		expect(app).toContain("localStorage.getItem('dumpfire-theme')");
	});
});

describe('the font', () => {
	/** The seven files Google served for Inter (v20) on 2026-10-15, by SHA-256: Fontsource 5.3.0's are the same bytes. */
	const FILES: Record<string, string> = {
		'inter-cyrillic-ext-wght-normal.woff2': 'ca157063339ac4ad418f214f3abfed119b0798ab4d377386ce5c9e5a7a435ebd',
		'inter-cyrillic-wght-normal.woff2': '71d5ee93cc1e9f1d520a3a8b66456de18c7879d8df09d57fcd2eaff75fef0075',
		'inter-greek-ext-wght-normal.woff2': '6e9e020a25f9b56d418f2c085b1d3c09725a4da23fe693a5b463064606732190',
		'inter-greek-wght-normal.woff2': '1be3448e292fbf05ffe176fe1e43f135013d50b1e7d324ad1a558f623d3bb6f6',
		'inter-vietnamese-wght-normal.woff2': '5c66f9e07e90c6d4ac4922cc68d60de26c17b1858e677fb5e603fce3952b3ff2',
		'inter-latin-ext-wght-normal.woff2': '34b9c504cab7a73e37b746343a449132e56cf7b5481af2cb81dc74dcff25c956',
		'inter-latin-wght-normal.woff2': '3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62'
	};
	const CSS = 'src/lib/fonts/inter.css';

	it('is named by no file under src or static as Google’s', () => {
		const naming = [...filesUnder('src'), ...filesUnder('static'), 'svelte.config.js'].filter(
			(file) => !file.endsWith('.woff2') && /fonts\.(googleapis|gstatic)\.com/.test(read(file))
		);
		expect(naming).toEqual([]);
	});

	it('is declared by inter.css, one face per file, weights 300 to 800, under the name app.css uses', () => {
		const css = read(CSS);
		const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]);
		expect(faces).toHaveLength(7);

		const named: string[] = [];
		for (const face of faces) {
			expect(face).toMatch(/font-family:\s*'Inter';/);
			expect(face).toMatch(/font-weight:\s*300 800;/);
			expect(face).toMatch(/font-style:\s*normal;/);
			expect(face).toMatch(/font-display:\s*swap;/);
			expect(face).toMatch(/unicode-range:\s*U\+/);
			const url = /src:\s*url\('\.\/inter\/([^']+)'\)\s*format\('woff2'\);/.exec(face);
			expect(url, face).toBeTruthy();
			expect(existsSync(join(ROOT, dirname(CSS), 'inter', url![1])), url![1]).toBe(true);
			named.push(url![1]);
		}
		expect(named.sort()).toEqual(Object.keys(FILES).sort());

		// The root layout imports it before app.css, which names the family.
		const layout = read('src/routes/+layout.svelte');
		const font = layout.search(/^\s*import '\$lib\/fonts\/inter\.css';/m);
		expect(font).toBeGreaterThan(-1);
		expect(font).toBeLessThan(layout.search(/^\s*import '\.\.\/app\.css';/m));
		expect(read('src/app.css')).toMatch(/--font-family:\s*'Inter',/);
	});

	it('is the seven files Google serves, byte for byte, and nothing else beside them', () => {
		const dir = join(ROOT, 'src/lib/fonts/inter');
		expect(readdirSync(dir).sort()).toEqual(Object.keys(FILES).sort());
		for (const [name, sha256] of Object.entries(FILES)) {
			const bytes = readFileSync(join(dir, name));
			expect(bytes.subarray(0, 4).toString('latin1'), name).toBe('wOF2');
			// Over Vite's inlining limit, so each is served as a file, which
			// font-src 'self' allows, and never as a data: address, which it does not.
			expect(bytes.length, name).toBeGreaterThan(4096);
			expect(createHash('sha256').update(bytes).digest('hex'), name).toBe(sha256);
		}
	});

	it('travels with its licence', () => {
		const licence = read('static/licences/inter-OFL.txt');
		expect(licence.startsWith('Copyright 2016 The Inter Project Authors')).toBe(true);
		expect(licence).toContain('SIL OPEN FONT LICENSE Version 1.1');
		expect(read(CSS)).toContain('static/licences/inter-OFL.txt');
	});
});
