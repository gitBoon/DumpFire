/**
 * One Secure rule for every cookie DumpFire sets (card 2850).
 *
 * Every cookie the server sets or deletes is Secure by `httpsOnlyCookie(url)`
 * (src/lib/server/auth.ts): a request that came over `https:` always, whatever
 * `COOKIE_SECURE` says; otherwise `COOKIE_SECURE` when it is set (so `false`
 * keeps a plain-HTTP LAN install working), and `NODE_ENV` exactly `production`
 * when it is not. The remembered-browser cookie moved onto it from the older
 * half-rule, `secureCookies()`, which is now private. A built server whose App
 * URL is `https:` while `ORIGIN` is set and `http:` writes one WARN at start
 * (`reportPlainOriginBehindHttps`, src/lib/server/startup-checks.ts).
 *
 * The cases are the plan's T1, T2, T4 and T5
 * (`docs/planning/card-2850-secure-cookies-by-protocol.md`, section 5). T3, the
 * dashboard's browser-written cookie, is in
 * tests/dashboard-side-pane.svelte.test.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cookies } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import * as auth from '$lib/server/auth';
import { httpsOnlyCookie } from '$lib/server/auth';
import { KNOWN_BROWSER_SECONDS, knownBrowserCookie, rememberBrowser } from '$lib/server/known-browsers';
import { reportPlainOriginBehindHttps } from '$lib/server/startup-checks';

const VARIABLES = ['COOKIE_SECURE', 'NODE_ENV', 'ORIGIN', 'APP_URL', 'LOG_LEVEL'] as const;
const environment = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));

beforeEach(() => {
	// Whatever the shell that started the tests has: each case says its own.
	delete process.env.COOKIE_SECURE;
	delete process.env.ORIGIN;
	delete process.env.APP_URL;
	process.env.NODE_ENV = 'test';
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const name of VARIABLES) {
		if (environment[name] === undefined) delete process.env[name];
		else process.env[name] = environment[name];
	}
});

describe('the remembered-browser cookie', () => {
	it('T1: is Secure on an https: request when neither COOKIE_SECURE nor NODE_ENV asks for it', () => {
		const set: { name: string; options: Record<string, unknown> }[] = [];
		const cookies = { set: (name: string, _value: string, options: Record<string, unknown>) => set.push({ name, options }) };

		rememberBrowser(cookies as unknown as Cookies, 7, 'a hash', new URL('https://kanban.example.test/login/verify'), 1);

		expect(set).toEqual([
			{
				name: knownBrowserCookie(7),
				options: { path: '/login', httpOnly: true, sameSite: 'strict', secure: true, maxAge: KNOWN_BROWSER_SECONDS }
			}
		]);
	});
});

describe('the one rule, httpsOnlyCookie', () => {
	it.each([
		{ row: 'a', url: 'https://kanban.example.test/', set: {}, secure: true },
		{ row: 'b', url: 'https://kanban.example.test/', set: { COOKIE_SECURE: 'false' }, secure: true },
		{ row: 'c', url: 'http://192.168.1.50:3000/', set: { NODE_ENV: 'production' }, secure: true },
		{ row: 'd', url: 'http://192.168.1.50:3000/', set: { NODE_ENV: 'production', COOKIE_SECURE: 'false' }, secure: false },
		{ row: 'e', url: 'http://192.168.1.50:3000/', set: { NODE_ENV: 'prod' }, secure: false }
	])('T2 ($row): $url with $set is Secure: $secure', ({ url, set, secure }) => {
		Object.assign(process.env, set);
		expect(httpsOnlyCookie(new URL(url))).toBe(secure);
	});
});

describe('the start-up line for an http ORIGIN behind an https App URL', () => {
	const lines = () =>
		sqlite.prepare("SELECT level, message FROM system_logs WHERE context = 'STARTUP' ORDER BY id").all() as {
			level: string;
			message: string;
		}[];

	beforeEach(() => {
		sqlite.prepare('DELETE FROM system_logs').run();
		sqlite.prepare("DELETE FROM settings WHERE key = 'app_url'").run();
		process.env.LOG_LEVEL = 'WARN';
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	const PLAIN = 'http://kanban.example.test';
	const HTTPS = 'https://kanban.example.test';
	it.each([
		{ row: 'a', name: 'a built server, ORIGIN http, App URL https', isDev: false, origin: PLAIN, appUrl: HTTPS, set: {}, said: true },
		{ row: 'b', name: 'the same under the dev server', isDev: true, origin: PLAIN, appUrl: HTTPS, set: {}, said: false },
		{ row: 'c', name: 'ORIGIN https', isDev: false, origin: HTTPS, appUrl: HTTPS, set: {}, said: false },
		{
			row: 'd',
			name: 'ORIGIN http with COOKIE_SECURE=true',
			isDev: false,
			origin: PLAIN,
			appUrl: HTTPS,
			set: { COOKIE_SECURE: 'true' },
			said: false
		},
		{ row: 'e', name: 'ORIGIN unset', isDev: false, origin: undefined, appUrl: HTTPS, set: {}, said: false },
		{ row: 'f', name: 'no App URL', isDev: false, origin: PLAIN, appUrl: undefined, set: {}, said: false }
	])('T4 ($row): $name: said $said', ({ isDev, origin, appUrl, set, said }) => {
		if (appUrl !== undefined) process.env.APP_URL = appUrl;
		Object.assign(process.env, set);

		expect(reportPlainOriginBehindHttps(isDev, origin)).toBe(said);

		if (said) {
			expect(lines()).toHaveLength(1);
			expect(lines()[0].level).toBe('WARN');
			expect(lines()[0].message).toContain('ORIGIN is http://kanban.example.test but the App URL is https://kanban.example.test');
		} else {
			expect(lines()).toEqual([]);
		}
	});
});

describe('every cookie the server sets', () => {
	const ROOT = process.cwd();

	/** Every `.ts` file under src/, by its path from the repository's root with forward slashes. */
	const sourceFiles = (ext: RegExp) =>
		(readdirSync(join(ROOT, 'src'), { recursive: true }) as string[])
			.filter((file) => ext.test(file))
			.map((file) => relative(ROOT, join(ROOT, 'src', file)).split(sep).join('/'))
			.sort();

	it('T5: goes through the one rule, the page writes a cookie in one place only, and secureCookies is private', () => {
		const calls: { at: string; secure: string | undefined }[] = [];
		for (const file of sourceFiles(/\.ts$/)) {
			const text = readFileSync(join(ROOT, file), 'utf8');
			const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
			const visit = (node: ts.Node) => {
				if (
					ts.isCallExpression(node) &&
					ts.isPropertyAccessExpression(node.expression) &&
					['set', 'delete'].includes(node.expression.name.text) &&
					/cookies$/i.test(node.expression.expression.getText(source))
				) {
					const options = node.arguments[node.arguments.length - 1];
					const secure =
						options && ts.isObjectLiteralExpression(options)
							? options.properties
									.filter(ts.isPropertyAssignment)
									.find((p) => p.name.getText(source) === 'secure')
									?.initializer.getText(source)
							: undefined;
					const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
					calls.push({ at: `${file}:${line + 1} ${node.expression.getText(source)}`, secure });
				}
				ts.forEachChild(node, visit);
			};
			visit(source);
		}

		// The session, challenge and set-up link cookies, set and deleted, and the remembered browser's.
		expect(calls.length).toBeGreaterThanOrEqual(7);
		expect(calls.filter((c) => c.secure !== 'httpsOnlyCookie(url)')).toEqual([]);

		// The page writes one cookie of its own, the dashboard's display choice.
		const writers = sourceFiles(/\.(ts|svelte)$/).filter((file) => /document\.cookie\s*=[^=]/.test(readFileSync(join(ROOT, file), 'utf8')));
		expect(writers).toEqual(['src/lib/dashboard/side-pane.ts']);

		// The older half-rule cannot be picked up by a new cookie.
		expect('secureCookies' in auth).toBe(false);
		expect(readFileSync(join(ROOT, 'src/lib/server/auth.ts'), 'utf8')).not.toMatch(/export\s+function\s+secureCookies/);
	});
});
