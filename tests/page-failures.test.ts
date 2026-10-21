/**
 * What a page does with an answer that is a failure, in the places where it
 * did the wrong thing.
 *
 *   - The reports page read the body of a failed answer with a bare
 *     `await res.json()`. An answer that is not JSON, a proxy's HTML 502 above
 *     all, made that throw, and the reader was shown the parser's complaint
 *     ("Unexpected token '<' ...") in place of anything about the report. It
 *     now asks `failureMessage` in `src/lib/api.ts`, as the other pages do.
 *   - The card's dependency list showed the server's message when removing a
 *     link was refused, and left the row where it was. The refusal is nearly
 *     always that somebody else removed the link first, so the row left
 *     behind was the one thing known to be out of date. The list is now read
 *     again, as it is when the card is opened.
 *   - The import said "Invalid backup file" for every failure there is, a
 *     proxy's refusal of the upload for its size among them, and a card's
 *     attachments said nothing at all and could be left saying "Uploading..."
 *     for ever. Both tell four things apart now, in `uploadFailure` and its
 *     neighbours in `src/lib/api.ts`.
 *   - The export saved whatever it was answered as the backup: a refusal was a
 *     file of a few bytes named `.db`, under "exported successfully".
 *   - The admin page showed an administrator what is the superadmin's alone,
 *     and asked the server for it when it opened.
 *   - A page whose session had ended was handed the login page's HTML, with
 *     a 200, for every request it made to an internal route, and went on as
 *     if each had worked. The gate answers those 401 now, and the page is
 *     sent to the login page on the first: `src/hooks.client.ts` and
 *     `$lib/signed-out.ts`.
 *   - The live-update streams asked again every three seconds, for ever,
 *     whatever had refused them. They wait longer each time now, and do not
 *     ask again for a stream refused because the session has ended:
 *     `$lib/live-stream.ts`.
 *   - Generate Key on the account page said nothing when it was refused. It
 *     asks for the password now, so a wrong one is a refusal the person must
 *     see. And the three pages where a password is set say what setting it
 *     ends: the account page, the admin page's reset dialog and the invite page.
 *   - Restoring a card, deleting a team, removing a member, saving a card in
 *     All Tasks, a template, a label, a cover, a schedule (card 2109): on the
 *     archived, All Tasks, teams, admin and reports pages, in the card window
 *     and for the board page's restore, a write that was refused said it had
 *     worked, or said nothing. Each now says what the server said, and puts
 *     back what it had changed on the page. A failure's toast stays until it
 *     is closed. A write whose answer is thrown away anywhere else is on a
 *     list that can only shrink. The admin page shows on each user's row only
 *     what the server would let the caller do there, by the server's own rule.
 *   - The card window's labels moved into a picker of their own, which makes,
 *     renames, recolours and deletes them as well (card 2010). It is held to
 *     the same rule as the window's other controls: each answer read, a chip
 *     changed only once the server has changed it, to what the server says
 *     it is now, and a refusal said.
 *
 * A page cannot be run here: these tests have no browser and no DOM. So, as
 * `tests/error-shape.test.ts` does for the routes, this reads the source. The
 * `<script lang="ts">` of each page is parsed with the TypeScript compiler
 * and the branch that handles a failure is looked at. `failureMessage`, the
 * watch on `fetch` and the stream that opens itself again are functions, and
 * are called, with stand-ins for what they would reach for in a browser.
 *
 * Only the account rule needs the database: it is held to the server's guard
 * with accounts made by `makeUser`. `tests/setup.ts` runs, as it does for
 * every file, and gives this one a database of its own.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { compile } from 'svelte/compiler';
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	answerBody,
	cardArchiveWarning,
	dependencyEndBody,
	dependencyRow,
	failureMessage,
	leftMilestoneNotice,
	sizeInWords,
	subBoardLinkWarning,
	uploadFailure,
	uploadNoAnswer,
	uploadNotRead
} from '$lib/api';
import { mayManageAccount } from '$lib/account-rule';
import { NO_ANSWER as ADMIN_NO_ANSWER, sent } from '$lib/admin/send';
import * as bulkActions from '$lib/board/bulk-actions';
import * as cardActions from '$lib/board/card-actions';
import * as dndHandlers from '$lib/board/dnd-handlers';
import { BoardState } from '$lib/board/board-state.svelte';
import { CardWindow, changedFields, WINDOW_FIELDS, windowFields } from '$lib/board/card-window.svelte';
import { copyColumns, moveCards, patchCard, removeCard, reorderColumns, undoDrag, withCurrentCards } from '$lib/board/board-patches';
import * as apiModule from '$lib/api';
import * as boardActions from '$lib/board/board-actions';
import type { BoardContentsData } from '$lib/board/contents-answer';
import { BULK_HOLD_MS, refreshSchedule } from '$lib/board/refresh-schedule';
import { attachmentsChanged, commentsChanged, connectSSE } from '$lib/board/sse';
import { SOURCES, TRIGGERS } from 'svelte-dnd-action';
import { keepStreamOpen, reconnectDelay, streamVerdict, type StreamEnvironment } from '$lib/live-stream';
import { NOTIFICATION_PREFS } from '$lib/notification-prefs';
import { readTimeZone } from '$lib/server/request-body';
import { requireManagedAccount } from '$lib/server/route-guards';
import { endsTheSession, watchForSignOut, type Fetch } from '$lib/signed-out';
import { MOST_FAILURES, TOAST_MS, toasts } from '$lib/stores/toast';
import type { CardType, ColumnType } from '$lib/types';
import { isCardBlocked, subBoardIncompleteCount } from '$lib/utils/card-utils';
import { makeUser, resetDb } from './helpers/fixtures';

const ROOT = process.cwd();

/** The `<script lang="ts">` of a Svelte file, parsed. */
function scriptOf(file: string, source = readFileSync(join(ROOT, file), 'utf8')): ts.SourceFile {
	const script = /<script lang="ts">([\s\S]*?)<\/script>/.exec(source);
	if (!script) throw new Error(`${file} has no <script lang="ts">`);
	return ts.createSourceFile(file, script[1], ts.ScriptTarget.Latest, true);
}

/** The function declared as `name` at the top of a script. */
function functionNamed(tree: ts.SourceFile, name: string): ts.FunctionDeclaration {
	const found = tree.statements.find(
		(statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === name
	);
	if (!found) throw new Error(`${tree.fileName} has no function ${name}`);
	return found;
}

/** Every call of `callee`, written as it is in the source (`res.json`, `failureMessage`), inside `within`. */
function callsOf(within: ts.Node, callee: string): ts.CallExpression[] {
	const found: ts.CallExpression[] = [];
	const visit = (node: ts.Node) => {
		if (ts.isCallExpression(node) && node.expression.getText() === callee) found.push(node);
		ts.forEachChild(node, visit);
	};
	visit(within);
	return found;
}

/**
 * Which side of an `if` on `res.ok` a node is on: 'ok' in the branch taken
 * when the answer is a success, 'failed' in the other, and null when it is
 * in neither, which is to say it runs whatever the answer was.
 */
function branchOf(node: ts.Node): 'ok' | 'failed' | null {
	for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
		if (!ts.isIfStatement(parent)) continue;
		const test = parent.expression.getText().replace(/\s/g, '');
		if (test !== 'res.ok' && test !== '!res.ok') continue;
		if (parent.thenStatement === child) return test === 'res.ok' ? 'ok' : 'failed';
		if (parent.elseStatement === child) return test === 'res.ok' ? 'failed' : 'ok';
	}
	return null;
}

/** For each call of `callee` in the function `name`: the branch it is in. */
const branches = (tree: ts.SourceFile, name: string, callee: string) =>
	callsOf(functionNamed(tree, name), callee).map(branchOf);

describe('failureMessage, given an answer that is a failure', () => {
	it('gives the fallback for a proxy’s HTML 502, and not what the parser said about it', async () => {
		const page = new Response('<html><body><h1>502 Bad Gateway</h1></body></html>', {
			status: 502,
			headers: { 'content-type': 'text/html' }
		});

		expect(await failureMessage(page, 'Failed to generate report')).toBe('Failed to generate report');
		expect(await failureMessage(new Response(null, { status: 504 }), 'Failed to send')).toBe('Failed to send');
	});

	it('gives the server’s own message when the answer carries one', async () => {
		const refused = Response.json({ message: 'Admin only for a report on all boards' }, { status: 403 });

		expect(await failureMessage(refused, 'Failed to generate report')).toBe('Admin only for a report on all boards');
	});

	it('gives the fallback for a message that says nothing', async () => {
		for (const body of [{ message: 'Internal Error' }, { message: '  ' }, { message: 5 }, { error: 'No' }, [], null]) {
			expect(await failureMessage(Response.json(body, { status: 500 }), 'Failed to send')).toBe('Failed to send');
		}
	});
});

describe('the reports page, src/routes/reports/+page.svelte', () => {
	const page = scriptOf('src/routes/reports/+page.svelte');

	it.each(['generateReport', 'sendReportEmail'])('%s reads the body of a failure with failureMessage alone', (name) => {
		// Read as JSON only where the answer is known to be a success.
		expect(branches(page, name, 'res.json').filter((branch) => branch !== 'ok')).toEqual([]);
		// And asked for its message where it is known to be a failure, once.
		expect(branches(page, name, 'failureMessage')).toEqual(['failed']);
		const [asked] = callsOf(functionNamed(page, name), 'failureMessage');
		expect(asked.arguments[0].getText()).toBe('res');
		// A plain fallback, written out where it is used.
		expect(ts.isStringLiteralLike(asked.arguments[1])).toBe(true);
	});

	it('imports failureMessage from $lib/api', () => {
		expect(page.getText()).toMatch(/import \{[^}]*\bfailureMessage\b[^}]*\} from '\$lib\/api';/);
	});

	// Card 2162's review: the preview frame shows a blob: address, which runs
	// as this page's own origin. Typed as the answer's type, an answer that is
	// HTML (a proxy's page among them) would be drawn there as a page. Typed
	// as a PDF it is only ever handed to the PDF viewer.
	it('makes the preview a PDF whatever type the answer gives', () => {
		const generate = functionNamed(page, 'generateReport').getText();
		expect(generate).toContain("new Blob([await res.arrayBuffer()], { type: 'application/pdf' })");
		expect(generate).not.toContain('res.blob()');
	});

	// Group B's review: a browser can name a zone the server's ICU does not
	// know. Refused outright, the viewer got no report at all.
	it('asks once more without timeZone when the server refuses the zone, and says so once the report is made', () => {
		const refuses = functionNamed(page, 'refusesZone').getText();
		expect(refuses).toContain('res.status === 400');
		expect(refuses).toContain("(await failureMessage(res.clone(), '')) === ZONE_REFUSED");
		// The server's own words, as `readTimeZone` says them.
		let said = '';
		try {
			readTimeZone({ timeZone: 'Mars/Base' }, 'timeZone', {});
		} catch (e) {
			said = (e as { body: { message: string } }).body.message;
		}
		expect(said).not.toBe('');
		expect(page.getText()).toContain(`const ZONE_REFUSED = '${said}';`);
		expect(functionNamed(page, 'zoneNotice').getText()).toContain("'warning'");

		for (const [name, url] of [['generateReport', '/api/reports'], ['sendReportEmail', '/api/reports/email']]) {
			const fn = functionNamed(page, name);
			const sent = callsOf(fn, 'fetch');
			expect(sent.map((call) => call.arguments[0].getText()), name).toEqual([`'${url}'`, `'${url}'`]);
			expect(sent[0].arguments[1].getText(), name).toContain('JSON.stringify({ ...request, timeZone: browserZone ?? undefined })');
			expect(sent[1].arguments[1].getText(), name).toContain('body: JSON.stringify(request)');
			// The second only when the first was refused for its zone.
			expect(ts.findAncestor(sent[1], ts.isIfStatement)!.expression.getText(), name).toBe('await refusesZone(res)');
			// Said only for a report that was made.
			expect(callsOf(fn, 'zoneNotice').map(sideOf), name).toEqual(['ok']);
		}
	});

	// Card 2182: the page reads a list as the server does, and a schedule kept
	// with more than 10 addresses, which the scheduler switches off, shows them,
	// since the page cannot edit one and its owner is told to remake it (R2).
	it('reads recipients through reportRecipients, and lists the addresses of a schedule over the cap', () => {
		const markup = readFileSync(join(ROOT, 'src/routes/reports/+page.svelte'), 'utf8');
		expect(functionNamed(page, 'sendReportEmail').getText()).toContain('reportRecipients(emailRecipients)');
		expect(markup).toContain('{@const sentTo = reportRecipients(schedule.recipients).addresses}');
		expect(markup).not.toContain("schedule.recipients.split(',')");
		expect(markup).toContain('{sentTo.length} recipients: the most is {MAX_REPORT_RECIPIENTS}, so it is not sent');
		expect(markup).toContain(`<div class="over-cap-addresses">{sentTo.join(', ')}</div>`);
	});
});

// Card 2280, slice B4: the list, its writes and its markup moved into the
// window's section of their own, CardDependencies.svelte; the window still
// reads the links when it opens, and hands the section `loadDependencies`.
describe('the card’s dependency list, src/lib/components/card/CardDependencies.svelte (from CardModal.svelte)', () => {
	const modal = scriptOf('src/lib/components/CardModal.svelte');
	const section = scriptOf('src/lib/components/card/CardDependencies.svelte');

	it('is read when the card is opened by loadDependencies', () => {
		const opened = modal.statements
			.filter((statement) => ts.isExpressionStatement(statement) && statement.getText().startsWith('onMount('))
			.flatMap((statement) => callsOf(statement, 'loadDependencies'));

		expect(opened).toHaveLength(1);
	});

	it('is read again by loadDependencies after a removal that was refused', () => {
		// In the branch for a failure; and in the success's only when its body
		// cannot be read as the two lists (card 2379's review), the one place a
		// removal that worked is not answered with the lists as they now are.
		expect(branches(section, 'removeDependency', 'loadDependencies')).toEqual(['ok', 'failed']);
		const onSuccess = callsOf(functionNamed(section, 'removeDependency'), 'loadDependencies')[0];
		const unread = ts.findAncestor(onSuccess, ts.isIfStatement)!;
		expect(unread.expression.getText()).toBe('data');
		expect(ts.findAncestor(onSuccess, (node) => node === unread.elseStatement)).toBeDefined();
		// The window's own reader, handed to the section.
		const window = readFileSync(join(ROOT, 'src/lib/components/CardModal.svelte'), 'utf8');
		expect(window.slice(window.indexOf('<CardDependencies'), window.indexOf('/>', window.indexOf('<CardDependencies')))).toContain('{loadDependencies}');
		// The message is still set there, before the lists are read again.
		const refused = functionNamed(section, 'removeDependency').getText();
		const said = "depError = await failureMessage(res, 'Could not remove that dependency')";
		expect(refused.indexOf(said)).toBeGreaterThan(-1);
		expect(refused.indexOf(said)).toBeLessThan(refused.lastIndexOf('loadDependencies()'));
	});

	// Card 2138. A row is a card or a subtask, and its `cardId` is its own id: a
	// subtask's for a subtask row. The remove button sent it as a card's
	// whatever the row was, and the row's number and link named that card.

	it('names the other end of a link by its kind, in one function: the four bodies', () => {
		const card = { kind: 'card' as const, cardId: 12, parentCardId: null };
		const subtask = { kind: 'subtask' as const, cardId: 45, parentCardId: 12 };

		expect(dependencyEndBody('blocked-by', card)).toEqual({ dependsOnCardId: 12 });
		expect(dependencyEndBody('blocked-by', subtask)).toEqual({ dependsOnSubtaskId: 45 });
		expect(dependencyEndBody('blocks', card)).toEqual({ blocksCardId: 12 });
		expect(dependencyEndBody('blocks', subtask)).toEqual({ blocksSubtaskId: 45 });
	});

	it('labels a row by its kind, and links a subtask row to its card', () => {
		expect(dependencyRow({ kind: 'card', cardId: 12, parentCardId: null, boardId: 3 })).toEqual({ label: '#12', href: '/board/3?card=12' });
		expect(dependencyRow({ kind: 'subtask', cardId: 45, parentCardId: 12, boardId: 3 })).toEqual({
			label: 'subtask #45 of #12',
			href: '/board/3?card=12'
		});
		// A subtask whose card is not known links nowhere, rather than to card 45.
		expect(dependencyRow({ kind: 'subtask', cardId: 45, parentCardId: null, boardId: 3 })).toEqual({ label: 'subtask #45', href: undefined });
		// Nor does a row on a board the caller cannot open (card 2129): the page would refuse them.
		expect(dependencyRow({ kind: 'card', cardId: 12, parentCardId: null, boardId: null, withheld: true })).toEqual({ label: '#12', href: undefined });
		expect(dependencyRow({ kind: 'card', cardId: 12, parentCardId: null, boardId: 3, withheld: true })).toEqual({ label: '#12', href: undefined });
	});

	it('builds the bodies it sends with dependencyEndBody, and writes no field name of its own', () => {
		for (const name of ['addDependency', 'removeDependency']) {
			const fn = functionNamed(section, name);
			expect(callsOf(fn, 'dependencyEndBody'), name).toHaveLength(1);
			expect(fn.getText(), name).not.toMatch(/\b(dependsOn|blocks)(Card|Subtask)Id\b/);
		}
	});

	it('passes the row from both remove buttons, and numbers and links each row through dependencyRow', () => {
		const source = readFileSync(join(ROOT, 'src/lib/components/card/CardDependencies.svelte'), 'utf8');
		const markup = source.slice(source.indexOf('</script>', source.indexOf('<script lang="ts">')));
		// Nor does the window's own markup, which draws the section.
		expect(readFileSync(join(ROOT, 'src/lib/components/CardModal.svelte'), 'utf8')).not.toMatch(/removeDependency|dependencyRow/);

		expect(markup.match(/removeDependency\([^)]*\)/g)).toEqual(["removeDependency(d, 'blocked-by')", "removeDependency(d, 'blocks')"]);
		expect(markup.match(/\{@const row = dependencyRow\(d\)\}/g)).toHaveLength(2);
		expect(markup.match(/<a class="dep-link" href=\{row\.href\}/g)).toHaveLength(2);
		expect(markup.match(/<span class="dep-id">\{row\.label\}<\/span>/g)).toHaveLength(2);
		// Nothing in the lists takes a row's own id for a card's.
		expect(markup).not.toContain('?card={d.cardId}');
		expect(markup).not.toContain('#{d.cardId}');
	});
});

// ─── Uploads ─────────────────────────────────────────────────────────────────

describe('an upload that was not accepted, said for what it is', () => {
	const PROXY_413 = () =>
		new Response('<html><head><title>413 Request Entity Too Large</title></head><body>nginx</body></html>', {
			status: 413,
			headers: { 'content-type': 'text/html' }
		});

	it('is a file that could not be read here, or a server that gave no answer', () => {
		expect(uploadNotRead('"notes.pdf"')).toBe('"notes.pdf" could not be read on this computer, so nothing was sent.');
		expect(uploadNoAnswer('"notes.pdf"')).toBe('No answer from the server. It is not known whether "notes.pdf" was accepted.');
	});

	it('is a refusal before it reached DumpFire when the answer is not JSON, with the status the proxy gave', async () => {
		expect(await uploadFailure(PROXY_413(), 'The backup "production.db"')).toBe(
			'The backup "production.db" was refused before it reached DumpFire, probably a size limit at the proxy in front of it (HTTP 413).'
		);
		expect(await uploadFailure(new Response(null, { status: 502 }), '"notes.pdf"')).toBe(
			'"notes.pdf" was refused before it reached DumpFire, probably a size limit at the proxy in front of it (HTTP 502).'
		);
		// JSON that is no object is not DumpFire's either: every failure it answers is { message }.
		expect(await uploadFailure(Response.json('too big', { status: 413 }), '"notes.pdf"')).toContain('before it reached DumpFire');
	});

	it('is larger than this server accepts when DumpFire answers 413, with the limit the answer gives', async () => {
		const gate = Response.json(
			{ message: 'The request is larger than this server accepts here: it is 27 MB, and the limit is 26 MB', limitBytes: 26 * 1024 * 1024 },
			{ status: 413 }
		);
		expect(await uploadFailure(gate, '"film.mov"')).toBe('"film.mov" is larger than this server accepts. The limit here is 26 MB.');

		// The adapter's own, of a body that ran past the length it declared: no limit in it.
		const adapter = Response.json({ message: 'Payload Too Large' }, { status: 413 });
		expect(await uploadFailure(adapter, '"film.mov"')).toBe('"film.mov" is larger than this server accepts.');
	});

	it('is the server’s own message for anything else it refused, by the rule failureMessage goes by', async () => {
		const refused = Response.json({ message: 'No edit access to this board' }, { status: 403 });
		expect(await uploadFailure(refused, '"notes.pdf"')).toBe('No edit access to this board');

		const fault = Response.json({ message: 'Internal Error' }, { status: 500 });
		expect(await uploadFailure(fault, '"notes.pdf"')).toBe('"notes.pdf" was not accepted (HTTP 500).');
	});

	it('is a page in place of an answer when a success is not JSON, which is what a session that ended looks like', async () => {
		const login = new Response('<!doctype html><title>Sign in</title>', { status: 200, headers: { 'content-type': 'text/html' } });

		expect(await uploadFailure(login, '"notes.pdf"')).toBe(
			'"notes.pdf" was not accepted: the answer was a page and not DumpFire\'s (HTTP 200). You may have been signed out. Reload the page and try again.'
		);
	});

	it('reads an answer’s body as a JSON object or as nothing, and a size as a person reads it', async () => {
		expect(await answerBody(Response.json({ id: 4 }))).toEqual({ id: 4 });
		for (const none of [Response.json([1]), Response.json(null), Response.json('x'), new Response('<html>'), new Response(null)]) {
			expect(await answerBody(none)).toBeNull();
		}
		expect([100, 512 * 1024, 26 * 1024 * 1024, 1536 * 1024 * 1024].map(sizeInWords)).toEqual(['100 bytes', '512 KB', '26 MB', '1.5 GB']);
	});
});

/** Every `try` in `within` that has a `finally`, as the text of that `finally`. */
function finallyBlocks(within: ts.Node): string[] {
	const found: string[] = [];
	const visit = (node: ts.Node) => {
		if (ts.isTryStatement(node) && node.finallyBlock) found.push(node.finallyBlock.getText().replace(/\s+/g, ' '));
		ts.forEachChild(node, visit);
	};
	visit(within);
	return found;
}

// Card 2280, slice B4: moved with the Files tab into CardAttachments.svelte.
describe('a card’s attachments, src/lib/components/card/CardAttachments.svelte (from CardModal.svelte)', () => {
	const source = readFileSync(join(ROOT, 'src/lib/components/card/CardAttachments.svelte'), 'utf8');
	const modal = scriptOf('src/lib/components/card/CardAttachments.svelte');

	it('says which of the four things went wrong, once each, and reads no answer as JSON unguarded', () => {
		const one = functionNamed(modal, 'uploadFile');

		for (const callee of ['uploadNotRead', 'uploadNoAnswer', 'uploadFailure']) {
			expect(callsOf(one, callee), callee).toHaveLength(1);
		}
		// A bare `res.json()` on an answer that is a proxy's page is what threw.
		expect(callsOf(one, 'res.json')).toEqual([]);
		expect(source).toMatch(/import \{[^}]*\buploadFailure\b[^}]*\} from '\$lib\/api';/);
	});

	it('stops saying "Uploading..." whatever happened: the flag is cleared in a finally', () => {
		const all = functionNamed(modal, 'uploadFiles');

		expect(finallyBlocks(all)).toHaveLength(1);
		expect(finallyBlocks(all)[0]).toContain('uploading = false;');
		// And nowhere outside it, where a request that threw would skip it.
		expect(all.getText().match(/uploading = false/g)).toHaveLength(1);
		// Each file is tried, whatever became of the one before.
		expect(callsOf(all, 'uploadFile')).toHaveLength(1);
	});

	it('shows what it was told, for each file that was not attached', () => {
		expect(functionNamed(modal, 'uploadFiles').getText()).toContain('uploadErrors = [...uploadErrors, failure]');
		expect(source).toMatch(/\{#if uploadErrors\.length > 0\}[\s\S]*?role="alert"[\s\S]*?\{#each uploadErrors as failure\}/);
		// The window draws the tab whatever tab is shown, so an upload under way, and what it was told, outlast a switch of tab.
		const window = readFileSync(join(ROOT, 'src/lib/components/CardModal.svelte'), 'utf8');
		// Told of each file shown, which raises the window's floor (card 2337).
		expect(window).toContain('<CardAttachments {card} {activeTab} bind:attachments {loadingAttachments} {loadAttachments} bind:windowError onWritten={attachmentWritten} />');
		expect(blocksAround(window, window.indexOf('<CardAttachments'))).toEqual([]);
		expect(source).toContain("{#if card && activeTab === 'attachments'}");
		expect(source).not.toMatch(/\bonMount\b|\$effect/);
	});
});

describe('the card window’s own messages and Escape, src/lib/components/CardModal.svelte', () => {
	const source = readFileSync(join(ROOT, 'src/lib/components/CardModal.svelte'), 'utf8');
	const modal = scriptOf('src/lib/components/CardModal.svelte');

	it('shows a refusal at the top of the window however far it is scrolled, and brings it into view when it is set', () => {
		// A refusal of a comment or a file, far down the window, was said above what could be seen.
		const style = /\.window-error \{([^}]*)\}/.exec(source)![1].replace(/\s+/g, ' ');
		expect(style).toContain('position: sticky; top: 0; z-index: 1;');
		// Opaque, so that what scrolls under it does not show through.
		expect(style).toContain('var(--bg-surface)');
		expect(source).toContain('<div class="dep-error window-error" role="alert" bind:this={windowErrorBox}>');

		const shown = modal.statements.filter(
			(statement) => ts.isExpressionStatement(statement) && statement.getText().startsWith('$effect(') && statement.getText().includes('windowErrorBox')
		);
		expect(shown).toHaveLength(1);
		expect(shown[0].getText().replace(/\s+/g, ' ')).toContain("if (windowError && windowErrorBox) windowErrorBox.scrollIntoView({ block: 'nearest' });");
	});

	it('leaves Escape to a confirmation the page opened over it, which takes it as Cancel, and closes on Escape otherwise', () => {
		// All Tasks' "Archive Card" and the board page's: Escape cancelled the
		// confirmation and closed the window under it as well. Since card 2338
		// any confirmation, a comment's Delete inside the window too
		// (tests/card-window-keys.svelte.test.ts runs that one).
		const handler = functionNamed(modal, 'handleKeydown').getText().replace(/\s+/g, ' ');
		const leaves = 'if (confirming) return;';
		expect(handler).toContain("const confirming = document.querySelector('.confirm-modal');");
		expect(handler).toContain(leaves);
		expect(handler.indexOf(leaves)).toBeLessThan(handler.indexOf('onClose();'));
		// Escape, and Ctrl+Enter, which saves (card 2280, slice B5c: tests/card-window-keys.svelte.test.ts).
		expect(handler).toContain("if (e.key !== 'Escape' && !saveKey) return;");
		// With the box that has the focus told to the follow (card 2280, the B5d review).
		expect(source).toContain('aria-label="Card editor" onfocusin={(e) => (focusedField = boxField(e.target))} onfocusout={() => (focusedField = null)}>');

		// What it looks for is the confirmation those pages open, which answers Escape itself.
		const confirmation = readFileSync(join(ROOT, 'src/lib/components/ConfirmModal.svelte'), 'utf8');
		expect(confirmation).toContain('<div class="confirm-modal"');
		expect(confirmation).toContain("if (e.key === 'Escape') onCancel();");
		for (const file of ['src/routes/all/+page.svelte', 'src/routes/todo/+page.svelte', 'src/routes/board/[id]/+page.svelte']) {
			const page = readFileSync(join(ROOT, file), 'utf8');
			expect(page, file).toContain('<CardModal');
			expect(page, file).toContain('<ConfirmModal');
		}
	});
});

// Cards 2147 and 2163. The window sent `colorTag: ""` with every save, which
// cleared a tag set through the API; and a template's labels were stored and
// never applied. What a save sends and what a template's labels become are
// run in `tests/card-window.test.ts`; this reads where the window keeps them.
describe('the card window’s save and its template’s labels, src/lib/components/CardModal.svelte (cards 2147 and 2163)', () => {
	const source = readFileSync(join(ROOT, 'src/lib/components/CardModal.svelte'), 'utf8');
	const modal = scriptOf('src/lib/components/CardModal.svelte');
	const from = source.indexOf('</script>');
	const markup = source.slice(from);

	it('hands the page no colour tag, and a new card’s template labels as pendingLabelIds', () => {
		const handed = callsOf(functionNamed(modal, 'save'), 'onSave');
		expect(handed).toHaveLength(1);
		const object = handed[0].arguments[0];
		expect(ts.isObjectLiteralExpression(object)).toBe(true);
		const properties = (object as ts.ObjectLiteralExpression).properties;
		expect(properties.map((property) => property.name?.getText() ?? property.getText())).not.toContain('colorTag');
		const labelled = properties.find((property) => property.name?.getText() === 'pendingLabelIds');
		expect(labelled?.getText().replace(/\s+/g, ' ')).toBe('pendingLabelIds: !card && templateLabels.length > 0 ? templateLabels : undefined');

		// Nor does the type of what it hands the page name one.
		// (It hands back the page's promise, so that one save is out at a time: card 2280, slice B5c.)
		const typed = /onSave: \(data: \{([^}]*)\}\) => void \| Promise<unknown>;/.exec(modal.getText())![1];
		expect(typed).not.toContain('colorTag');
		expect(typed).toContain('pendingLabelIds?: number[]');
	});

	it('keeps the labels of the template applied that are labels of this board, through templateLabelIds', () => {
		expect(modal.getText()).toContain("import { templateLabelIds } from '$lib/templates';");
		const applying = functionNamed(modal, 'applyTemplate');
		expect(assignmentsTo(applying, 'templateLabels').map((assignment) => assignment.right.getText())).toEqual(['templateLabelIds(tmpl.labelsJson, labels)']);
	});

	it('lists them above the footer of the New Task window, and nowhere else', () => {
		const line = 'Labels from the template:';
		expect(markup.split(line)).toHaveLength(2);
		const at = from + markup.indexOf(line);
		expect(blocksAround(source, at)).toContainEqual({ condition: '!card && templateLabels.length > 0', inElse: false });
		expect(at).toBeLessThan(source.indexOf('<div class="modal-footer">'));
		// Read-only: a chip that does nothing, and no picker of its own.
		const shown = source.slice(at, source.indexOf('<div class="modal-footer">'));
		expect(shown).not.toMatch(/\bon\w+=\{/);
	});

	it('says that a template holds the labels too', () => {
		// In the Save as Template dialog, which moved into CardTemplates.svelte (card 2280, slice B4); the window draws it.
		const dialogs = readFileSync(join(ROOT, 'src/lib/components/card/CardTemplates.svelte'), 'utf8');
		expect(dialogs).toContain('<p class="template-desc">Saves this card\'s title, description, priority, subtasks and labels as a reusable template.</p>');
		expect(markup).toContain('<CardTemplates');
	});
});

// Card 2200. The window sent `onHoldNote: onHoldNote || undefined` and the
// same for the business value, so an emptied box was left out of the body
// and the route kept the old text. Both routes refuse `null` for these two
// fields and store `''`, which is what an emptied box is sent as now.
describe('the card window clears what it shows (card 2200)', () => {
	const modal = scriptOf('src/lib/components/CardModal.svelte');

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("sends an emptied on-hold note or business value as '', and only when the card held one", () => {
		const handed = callsOf(functionNamed(modal, 'save'), 'onSave');
		expect(handed).toHaveLength(1);
		const properties = (handed[0].arguments[0] as ts.ObjectLiteralExpression).properties;
		const initial = (name: string) => {
			const property = properties.find((p) => p.name?.getText() === name);
			expect(property && ts.isPropertyAssignment(property), name).toBe(true);
			return (property as ts.PropertyAssignment).initializer.getText().replace(/\s/g, '');
		};
		expect(initial('onHoldNote')).toBe("onHoldNote||(card?.onHoldNote?'':undefined)");
		expect(initial('businessValue')).toBe("businessValue||(card?.businessValue?'':undefined)");
	});

	it("reaches the card update with the empty text, through the board page's saveCard", async () => {
		const sent: { url: string; method?: string; body: Record<string, unknown> }[] = [];
		vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
			sent.push({ url, method: init.method, body: JSON.parse(String(init.body)) });
			return new Response(JSON.stringify({ id: 5 }), { status: 200, headers: { 'content-type': 'application/json' } });
		});
		const card = { id: 5, title: 'Held', onHoldNote: 'waiting on X', businessValue: 'saves an hour' } as unknown as CardType;

		await cardActions.saveCard(card, null, 1, [], {
			title: 'Held', description: '', priority: 'medium', categoryId: null, dueDate: null,
			onHoldNote: '', businessValue: ''
		});

		expect(sent).toHaveLength(1);
		expect(`${sent[0].method} ${sent[0].url}`).toBe('PUT /api/cards/5');
		expect(sent[0].body).toMatchObject({ onHoldNote: '', businessValue: '' });
	});
});

// Card 2280, slice B2b. The board's card window threw away the answer to an
// update, and closed as if saved; a new card's pending subtasks and assignees
// were sent and their answers thrown away.
describe('the board’s card window save reads every answer, src/lib/board/card-actions.ts (card 2280, slice B2b)', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	const fields = { title: 'Held', description: '', priority: 'medium', categoryId: null, dueDate: null };

	it('gives back an update refused or unanswered as a failure, in the server’s words', async () => {
		const card = { id: 5, title: 'Held' } as unknown as CardType;
		vi.stubGlobal('fetch', async () => json(403, { message: 'Viewers cannot change cards' }));
		expect(await cardActions.saveCard(card, null, 1, [], fields)).toEqual({ isNew: false, title: 'Held', failure: 'Viewers cannot change cards' });
		vi.stubGlobal('fetch', async () => {
			throw new TypeError('fetch failed');
		});
		expect(await cardActions.saveCard(card, null, 1, [], fields)).toEqual({ isNew: false, title: 'Held', failure: 'No answer from the server. The card may not have been saved.' });
		vi.stubGlobal('fetch', async () => json(200, { id: 5 }));
		expect(await cardActions.saveCard(card, null, 1, [], fields)).toEqual({ isNew: false, title: 'Held' });
	});

	it('names each pending subtask of a new card that was not made, sends the rest, and keeps the card', async () => {
		const sent: string[] = [];
		vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
			const title = JSON.parse(String(init.body)).title;
			sent.push(`${init.method} ${url} ${title}`);
			if (url === '/api/cards') return json(201, { id: 50 });
			if (title === 'Two') return json(400, { message: 'A subtask title is at most 500 characters' });
			if (title === 'Three') throw new TypeError('fetch failed');
			return json(201, { id: 1 });
		});
		const pendingSubtasks = ['One', 'Two', 'Three', 'Four'].map((title) => JSON.stringify({ title }));
		const result = await cardActions.saveCard(null, 3, 1, [{ id: 3, cards: [] }] as unknown as ColumnType[], { ...fields, title: 'New', pendingSubtasks });

		expect(result).toMatchObject({
			isNew: true,
			cardId: 50,
			subtaskFailures: [
				{ title: 'Two', message: 'A subtask title is at most 500 characters' },
				{ title: 'Three', message: 'No answer from the server, so it may be on the card after all.' }
			]
		});
		expect(sent).toEqual(['POST /api/cards New', 'POST /api/subtasks One', 'POST /api/subtasks Two', 'POST /api/subtasks Three', 'POST /api/subtasks Four']);
	});

	it('assigns the people chosen for a new card one at a time, and gives back each not assigned with why', async () => {
		const sent: string[] = [];
		vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
			const { userId } = JSON.parse(String(init.body));
			sent.push(`${init.method} ${url} ${userId}`);
			if (userId === 2) return json(403, { message: 'That user cannot open this board' });
			if (userId === 3) throw new TypeError('fetch failed');
			return json(201, {});
		});
		expect(await cardActions.assignPending(50, [1, 2, 3])).toEqual([
			{ userId: 2, message: 'That user cannot open this board' },
			{ userId: 3, message: 'No answer from the server, so they may be assigned after all.' }
		]);
		expect(sent).toEqual(['POST /api/cards/50/assignees 1', 'POST /api/cards/50/assignees 2', 'POST /api/cards/50/assignees 3']);
	});
});

// Card 2164. `?card=` was read in `onMount` alone, and SvelteKit keeps the
// page for every address of the route, so a dependency link to a card on
// this board, or on another, opened no card. The parameter was taken off the
// address with `window.history.replaceState({}, ...)`, which threw away
// SvelteKit's own state in the history entry.
describe('the card an address names, src/routes/board/[id]/+page.svelte (card 2164)', () => {
	const board = scriptOf('src/routes/board/[id]/+page.svelte');
	/** Asked in each test, so that a page without it fails each and not the file. */
	const opening = () => functionNamed(board, 'openCardFromAddress');

	it('is opened after every navigation that keeps the page, and not in onMount', () => {
		// The other `afterNavigate` is the list view's (card 2079), which opens no card.
		expect(callsOf(board, 'afterNavigate')).toHaveLength(2);
		const navigated = callsOf(board, 'afterNavigate').filter((call) => call.getText().includes('openCardFromAddress'));
		expect(navigated).toHaveLength(1);
		const callback = navigated[0].arguments[0] as ts.ArrowFunction;
		expect(callback.parameters.map((parameter) => parameter.getText())).toEqual(['{ from, to }']);
		const steps = (callback.body as ts.Block).statements.map((statement) => statement.getText().replace(/\s+/g, ' '));
		// The window is closed first where the navigation calls for it (Q-F's
		// review), then the card named opened; the window is its controller's
		// (card 2280, slice B2c).
		expect(steps).toEqual([
			'if (cardActions.navigationClosesWindow(from, to, cardWindow.cardId !== null)) cardWindow.close();',
			'openCardFromAddress(to?.url);'
		]);
		expect(opening().getText()).toContain("searchParams.get('card')");
		const mounted = board.statements.filter((statement) => ts.isExpressionStatement(statement) && statement.getText().startsWith('onMount('));
		expect(mounted.length).toBeGreaterThan(0);
		for (const statement of mounted) expect(statement.getText()).not.toContain("'card'");
	});

	// Card 2280, slice B2a: the board state is the page's one copy, made from
	// the load before `afterNavigate` runs, and made afresh for another board.
	it('looks the card up in the board state, which is the board the navigation brought, and not in the load', () => {
		expect(opening().getText()).toContain('boardState.columns.flatMap((c) => c.cards).find((c) => c.id === cardId)');
		expect(opening().getText()).not.toContain('data.');
	});

	it('closes a window already open, and opens the card and puts the address right only after the next tick', () => {
		expect(board.getText()).toMatch(/import \{[^}]*\breplaceState\b[^}]*\} from '\$app\/navigation';/);
		expect(board.getText()).toMatch(/import \{[^}]*\btick as nextTick\b[^}]*\} from 'svelte';/);
		// SvelteKit's, and nowhere else: the browser's lost SvelteKit's state.
		expect([...callsOf(board, 'window.history.replaceState'), ...callsOf(board, 'history.replaceState')]).toEqual([]);
		// And `setBoardView`, which puts the list view in the address (card 2079).
		expect(callsOf(board, 'replaceState').map((call) => ts.findAncestor(call, ts.isFunctionDeclaration)?.name?.text)).toEqual(['openCardFromAddress', 'setBoardView']);

		const steps = opening().body!.statements.map((statement) => statement.getText());
		const waited = steps.indexOf('await nextTick();');
		expect(waited).toBeGreaterThan(-1);
		const closed = steps.indexOf('cardWindow.close();');
		expect(closed).toBeGreaterThan(-1);
		expect(closed).toBeLessThan(waited);
		expect(steps.findIndex((step) => step.startsWith('replaceState('))).toBeGreaterThan(waited);
		expect(steps.indexOf('if (card) openCardModal(card);')).toBeGreaterThan(waited);
	});

	// Card 2280, slice B2c: the card window's save is its controller's
	// (`src/lib/board/card-window.svelte.ts`), which names each part of a new
	// card that was not put on it and gives back what to say, in order; its
	// cases run in `tests/card-window.test.ts`. The page says it.
	const controller = () =>
		ts.createSourceFile('card-window.ts', readFileSync(join(ROOT, 'src/lib/board/card-window.svelte.ts'), 'utf8'), ts.ScriptTarget.Latest, true);

	it('says each label, subtask, assignee and sub-board of a new card that was not put on it, as an error in the shared toast', () => {
		const saving = functionNamed(board, 'saveCard');
		const told = callsOf(saving, 'toasts.add').filter((call) => call.arguments[0].getText() === 'message');
		expect(told.map((call) => call.arguments.map((argument) => argument.getText()))).toEqual([['message', "'error'", 'started'], ['message']]);
		expect(told.map((call) => (ts.findAncestor(call, ts.isIfStatement)?.expression.getText()))).toEqual(['failed', 'failed']);
		expect(saving.getText()).toContain('for (const { message, failed } of written.told) {');
		// The type of what the window hands it, as the window's.
		expect(saving.parameters[0].type!.getText()).toBe('CardWindowSave');
		const type = controller().statements.find((statement): statement is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(statement) && statement.name.text === 'CardWindowSave')!;
		expect(type.type.getText()).not.toContain('colorTag');
		expect(type.type.getText()).toContain('pendingLabelIds?: number[]');
	});

	it('names a label deleted while the window was open as one that no longer exists, not by its number (the review)', () => {
		const said = controller().getText();
		expect(said).toContain("const named = label ? `The template's label \"${label.name}\"` : 'A label of the template that no longer exists';");
		expect(said).toContain('told.push({ message: `${named} was not put on "${title}". ${message}`, failed: true });');
		expect(said).not.toContain('#${labelId}');
	});

	it('says a create that made no card, keeps the window open, and says nothing was created (the review)', () => {
		const steps = functionNamed(board, 'saveCard').body!.statements.map((statement) => statement.getText());
		const failed = steps.findIndex((step) => step.startsWith('if (!written.ok) {'));
		expect(failed).toBeGreaterThan(steps.findIndex((step) => step.includes('await cardWindow.save(cardData)')));
		// Before anything it was told is said.
		expect(failed).toBeLessThan(steps.findIndex((step) => step.startsWith('for (const { message, failed } of written.told)')));
		const branch = (functionNamed(board, 'saveCard').body!.statements[failed] as ts.IfStatement).thenStatement as ts.Block;
		expect(branch.statements.map((statement) => statement.getText())).toEqual(["toasts.add(written.failure, 'error', started);", 'return;']);
	});
});

/**
 * The `{#if}` blocks a place in a Svelte file's markup is inside, outermost
 * first: each with its condition, and whether the place is in its `{:else}`.
 */
function blocksAround(source: string, index: number): { condition: string; inElse: boolean }[] {
	const stack: { condition: string; inElse: boolean }[] = [];
	for (const tag of source.slice(0, index).matchAll(/\{#if ([^}]+)\}|\{:else[^}]*\}|\{\/if\}/g)) {
		if (tag[0].startsWith('{#if')) stack.push({ condition: tag[1].trim(), inElse: false });
		else if (tag[0].startsWith('{:else')) stack[stack.length - 1].inElse = true;
		else stack.pop();
	}
	return stack;
}

// Card 2281, slice C1a: the admin page's backup half is in components of its
// own under src/lib/components/admin, which the page draws. What was read
// from the page is read from the file that now holds it, and what is said to
// be gone is looked for in the page and in every one of them. Slice C1b moved
// the rest the same way: every section of the page is a component now.
const ADMIN_PAGE = 'src/routes/admin/+page.svelte';

/** The admin page's components that are the superadmin's alone (card 2281, slices C1a and C1b). */
const SUPERADMIN_COMPONENTS = [
	'AppUrlPanel',
	'BackupHistory',
	'BackupRestorePanel',
	'DestinationForm',
	'GDriveConnectModal',
	'ScheduledBackupsPanel',
	'SmtpPanel'
].map((name) => `src/lib/components/admin/${name}.svelte`);

/** And those every administrator is shown (card 2281, slice C1b). */
const ADMINISTRATOR_COMPONENTS = [
	'AdminOverview',
	'BoardManagementPanel',
	'DangerZonePanel',
	'InviteLinkDialog',
	'ResetPasswordDialog',
	'TeamsPanel',
	'UsersPanel'
].map((name) => `src/lib/components/admin/${name}.svelte`);

/** The components the admin page is split into. */
function adminComponents(): string[] {
	return (readdirSync(join(ROOT, 'src/lib/components/admin')) as string[])
		.filter((name) => name.endsWith('.svelte'))
		.map((name) => `src/lib/components/admin/${name}`);
}

/** The components All Tasks is split into (card 2281, slice C3a-2). */
function tasksComponents(): string[] {
	return (readdirSync(join(ROOT, 'src/lib/components/tasks')) as string[])
		.filter((name) => name.endsWith('.svelte'))
		.map((name) => `src/lib/components/tasks/${name}`);
}

/** The components the plan page is split into (card 2281, slice C3a-3). */
function planComponents(): string[] {
	return (readdirSync(join(ROOT, 'src/lib/components/plan')) as string[])
		.filter((name) => name.endsWith('.svelte'))
		.map((name) => `src/lib/components/plan/${name}`);
}

/** The modules the admin page and its components share (`sent`, the formatters). */
function adminModules(): string[] {
	return (readdirSync(join(ROOT, 'src/lib/admin')) as string[]).filter((name) => name.endsWith('.ts')).map((name) => `src/lib/admin/${name}`);
}

/** The admin page and each of its components, with its source: the files with markup and a script. */
function adminSvelteSources(): { file: string; source: string }[] {
	return [ADMIN_PAGE, ...adminComponents()].map((file) => ({ file, source: readFileSync(join(ROOT, file), 'utf8') }));
}

/** The admin page, its components and the modules they share, with each one's source: everywhere a thing said to be gone could be. */
function adminSources(): { file: string; source: string }[] {
	return [...adminSvelteSources(), ...adminModules().map((file) => ({ file, source: readFileSync(join(ROOT, file), 'utf8') }))];
}

/**
 * Whether an admin component is drawn for the superadmin only: each of its
 * tags (the destination form has two), in the page or in the component that
 * draws it, followed up to the page, is inside the page's `{#if isSuperadmin}`
 * and not in its `{:else}`.
 */
function drawnForSuperadminOnly(component: string): boolean {
	const name = component.slice(component.lastIndexOf('/') + 1, -'.svelte'.length);
	const tags = adminSvelteSources().flatMap(({ file, source }) =>
		[...source.matchAll(new RegExp(`<${name}[\\s/>]`, 'g'))].map((tag) => ({ file, at: tag.index! }))
	);
	expect(tags.length, `the tags of ${name}`).toBeGreaterThan(0);
	return tags.every(({ file, at }) =>
		file === ADMIN_PAGE
			? blocksAround(readFileSync(join(ROOT, ADMIN_PAGE), 'utf8'), at).some((block) => block.condition === 'isSuperadmin' && !block.inElse)
			: drawnForSuperadminOnly(file)
	);
}

/**
 * Whether an admin component is drawn for every administrator (card 2281,
 * slice C1b): each of its tags, in the page or in the component that draws
 * it, followed up to the page, is inside no `{#if}` at all.
 */
function drawnForEveryAdministrator(component: string): boolean {
	const name = component.slice(component.lastIndexOf('/') + 1, -'.svelte'.length);
	const tags = adminSvelteSources().flatMap(({ file, source }) =>
		[...source.matchAll(new RegExp(`<${name}[\\s/>]`, 'g'))].map((tag) => ({ file, source, at: tag.index! }))
	);
	expect(tags.length, `the tags of ${name}`).toBeGreaterThan(0);
	return tags.every(({ file, source, at }) => blocksAround(source, at).length === 0 && (file === ADMIN_PAGE || drawnForEveryAdministrator(file)));
}

describe('the admin page, src/routes/admin/+page.svelte', () => {
	const file = ADMIN_PAGE;
	const source = readFileSync(join(ROOT, file), 'utf8');
	const page = scriptOf(file);
	const markup = source.slice(source.indexOf('</script>'));
	const from = source.indexOf('</script>');
	// The export, the import and its dialog, and the scheduled backups (card 2281, slice C1a).
	const RESTORE = 'src/lib/components/admin/BackupRestorePanel.svelte';
	const SCHEDULED = 'src/lib/components/admin/ScheduledBackupsPanel.svelte';
	const restore = scriptOf(RESTORE);
	const restoreSource = readFileSync(join(ROOT, RESTORE), 'utf8');
	const restoreMarkup = restoreSource.slice(restoreSource.indexOf('</script>'));
	const scheduled = scriptOf(SCHEDULED);
	const scheduledSource = readFileSync(join(ROOT, SCHEDULED), 'utf8');
	const scheduledMarkup = scheduledSource.slice(scheduledSource.indexOf('</script>'));
	/** The page, its components and their modules, where something said to be gone could be. */
	const everywhere = adminSources()
		.map((admin) => admin.source)
		.join('\n');

	/**
	 * Whether the one place `text` is in the markup, of the page or of one of
	 * its components, is shown to the superadmin only: in the page, inside its
	 * `{#if isSuperadmin}`; in a component, one the page draws there, or one
	 * the page draws for everybody and hands its own `isSuperadmin`, inside
	 * the component's `{#if isSuperadmin}` (card 2281, slice C1b: Reset
	 * Everything in the danger zone).
	 */
	const forSuperadminOnly = (text: string) => {
		const holders = adminSources().filter((admin) => admin.source.includes(text));
		expect(
			holders.map((admin) => admin.file),
			text
		).toHaveLength(1);
		const [holder] = holders;
		const heldFrom = holder.source.indexOf('</script>');
		const held = holder.source.slice(heldFrom);
		expect(held.split(text), text).toHaveLength(2);
		const inSuperadminBlock = (within: string, at: number) =>
			blocksAround(within, at).some((block) => block.condition === 'isSuperadmin' && !block.inElse);
		if (holder.file !== ADMIN_PAGE) {
			if (drawnForSuperadminOnly(holder.file)) return true;
			const name = holder.file.slice(holder.file.lastIndexOf('/') + 1, -'.svelte'.length);
			const tags = [...source.matchAll(new RegExp(`<${name}[\\s/>][^>]*>`, 'g'))].map((tag) => tag[0]);
			// The page's own isSuperadmin, under that name: `{isSuperadmin}` or `isSuperadmin={isSuperadmin}`, and not `foo={isSuperadmin}`.
			const handsItOn = (tag: string) => /\s(\{isSuperadmin\}|isSuperadmin=\{isSuperadmin\})[\s/>]/.test(tag);
			return tags.length > 0 && tags.every(handsItOn) && inSuperadminBlock(holder.source, heldFrom + held.indexOf(text));
		}
		return inSuperadminBlock(source, from + markup.indexOf(text));
	};

	it.each([
		'<h2>🌐 Application Settings</h2>',
		'<h2>💾 Backup & Restore</h2>',
		'<h2>☁️ Scheduled Backups</h2>',
		'<h2>📧 Email / SMTP</h2>',
		'<strong>Reset Everything</strong>',
		'onclick={exportDatabase}',
		'onclick={openImportDialog}',
		'onclick={runManualBackup}',
		'onchange={handleFileSelected}'
	])('shows %s to the superadmin and to nobody else', (text) => {
		expect(forSuperadminOnly(text)).toBe(true);
	});

	it.each([
		'<h2>📊 Database Overview</h2>',
		'<h2>📋 Board Management</h2>',
		'<h2>👥 User Management</h2>',
		'<h2>🏢 Team Management</h2>',
		'<strong>Purge Archived Cards</strong>',
		'<strong>Vacuum Database</strong>',
		'<strong>Reset All XP</strong>'
	])('still shows %s to an administrator', (text) => {
		expect(forSuperadminOnly(text)).toBe(false);
	});

	// Card 2281, slice C1a: each panel and each part of one is drawn only
	// where the page draws for the superadmin, every place it is drawn (the
	// destination form is drawn twice, for an edit and for an add).
	it.each(SUPERADMIN_COMPONENTS)('draws %s for the superadmin and for nobody else', (component) => {
		expect(drawnForSuperadminOnly(component)).toBe(true);
	});

	// Card 2281, slice C1b: and the sections every administrator is shown are
	// drawn for each of them, in no block at all.
	it.each(ADMINISTRATOR_COMPONENTS)('draws %s for every administrator', (component) => {
		expect(drawnForEveryAdministrator(component)).toBe(true);
		expect(drawnForSuperadminOnly(component)).toBe(false);
	});

	it('has each of its components in one of those two lists, so that a new one is held to one of them', () => {
		expect([...SUPERADMIN_COMPONENTS, ...ADMINISTRATOR_COMPONENTS].sort()).toEqual([...adminComponents()].sort());
	});

	it('tells an administrator, in their place, whose they are and who that is', () => {
		const line = 'belong to the superadmin, <strong>{superadminName}</strong>';
		expect(markup.split(line)).toHaveLength(2);

		const around = blocksAround(source, from + markup.indexOf(line));
		// In the `{:else}` of the block the superadmin's sections are in.
		expect(around[0]).toEqual({ condition: 'isSuperadmin', inElse: true });
		expect(markup).toContain('Exporting, importing and resetting the database, the scheduled backups and their destinations, and the mail and App URL settings belong to the superadmin');
		// The name is the account whose role it is, from the list the page was loaded with.
		expect(page.getText()).toContain("data.users.find((u) => u.role === 'superadmin')?.username");
	});

	it('asks the server for none of it when it opens, unless it is the superadmin who opened it', () => {
		// What is asked for as the page opens is asked in an `$effect`: the
		// backup settings and the App URL in their panels' own (card 2281, slice
		// C1a), the mail settings in the mail panel's (slice C1b; on the page
		// its effect began by leaving for anybody else), each a panel the page
		// draws for the superadmin alone.
		const LOADS: [file: string, load: string][] = [
			[SCHEDULED, 'loadBackupConfig'],
			['src/lib/components/admin/AppUrlPanel.svelte', 'loadAppUrl'],
			['src/lib/components/admin/SmtpPanel.svelte', 'loadSmtpConfig']
		];
		const effectsOf = (tree: ts.SourceFile) =>
			tree.statements.filter((statement) => ts.isExpressionStatement(statement) && statement.getText().startsWith('$effect('));
		const bodyOf = (effect: ts.Statement) => ((((effect as ts.ExpressionStatement).expression as ts.CallExpression).arguments[0] as ts.ArrowFunction).body as ts.Block);

		// Each called once in all, in an effect, and none in the page's script, which has no effect of its own.
		expect(LOADS.flatMap(([, load]) => adminSvelteSources().flatMap((admin) => effectsOf(scriptOf(admin.file)).flatMap((effect) => callsOf(effect, load))))).toHaveLength(3);
		for (const [, load] of LOADS) expect(callsOf(page, load), load).toEqual([]);
		expect(effectsOf(page)).toEqual([]);
		for (const [held, load] of LOADS) {
			const tree = scriptOf(held);
			const loading = effectsOf(tree).filter((effect) => callsOf(effect, load).length > 0);
			expect(loading, load).toHaveLength(1);
			expect(bodyOf(loading[0]).statements.map((statement) => statement.getText())).toEqual([`${load}();`]);
			expect(drawnForSuperadminOnly(held), held).toBe(true);
			// And none of the three is called as the script runs, outside a function.
			const atTheTop = tree.statements.filter((statement) => ts.isExpressionStatement(statement) && !effectsOf(tree).includes(statement));
			expect(atTheTop.flatMap((statement) => callsOf(statement, load)), load).toEqual([]);
			// Each fetches a route that is the superadmin's.
			expect(functionNamed(tree, load).getText()).toMatch(/fetch\('\/api\/admin\/(smtp|backup)'\)/);
		}
	});

	it('saves no file for an export that was refused, and shows the refusal as a failure', () => {
		const exporting = functionNamed(restore, 'exportDatabase');
		const text = exporting.getText();

		// The answer is looked at before it is read as the file.
		const refusal = text.indexOf('if (!res.ok) {');
		const file = text.indexOf('res.blob()');
		expect(refusal).toBeGreaterThan(-1);
		expect(file).toBeGreaterThan(refusal);
		// And what is done about it is to say so and stop.
		expect(branches(restore, 'exportDatabase', 'failureMessage')).toEqual(['failed']);
		const [asked] = callsOf(exporting, 'failureMessage');
		expect(branchOf(asked)).toBe('failed');
		const stop = text.slice(refusal, file);
		expect(stop).toMatch(/showToast\(await failureMessage\(res, '[^']+'\), 'error', started\);\s+return;\s+\}/);
		expect(text.indexOf("showToast('Database exported successfully')")).toBeGreaterThan(file);
	});

	it('says which of the four things went wrong with an import, and no longer blames the file for all of them', () => {
		const importing = functionNamed(restore, 'handleFileSelected');

		for (const callee of ['uploadNotRead', 'uploadNoAnswer', 'uploadFailure']) {
			expect(callsOf(importing, callee), callee).toHaveLength(1);
		}
		expect(callsOf(importing, 'res.json')).toEqual([]);
		expect(everywhere).not.toContain("'Invalid backup file'");
		// A proxy's refusal and DumpFire's own 413 are both handed to uploadFailure.
		expect(importing.getText()).toContain('if (result === null || res.status === 413) {');
		expect(finallyBlocks(importing).some((block) => block.includes('importing = false;'))).toBe(true);
	});

	it('says an import that failed in the report under the button, and not in a toast as well', () => {
		const importing = functionNamed(restore, 'handleFileSelected');
		const failing = callsOf(importing, 'showToast').filter((call) => call.arguments[1]?.getText() === "'error'");

		// Each failure the report shows is set with no toast beside it: the
		// toast waits to be closed, and was the same words a second time.
		const reported = assignmentsTo(importing, 'importReport').filter((set) => set.right.getText().includes('trouble: true'));
		expect(reported).toHaveLength(4);
		// One toast is left, for a fault after the answer came, when there is no report to say it in.
		expect(failing).toHaveLength(1);
		const caught = ts.findAncestor(failing[0], ts.isCatchClause);
		expect(caught).toBeDefined();
		expect(assignmentsTo(caught!, 'importReport')).toEqual([]);
		// The catch of the whole import, not of one of its steps.
		expect(caught!.parent).toBe(importing.body!.statements.find(ts.isTryStatement));
	});

	it('offers no second removal of a backup destination while the first is being saved', () => {
		// Two quick removals, the first refused, put the first's list back over the second's.
		const button = everywhere.split('\n').filter((line) => line.includes('removeDestination(dest.name)'));
		expect(button).toHaveLength(1);
		expect(scheduledMarkup).toContain(button[0]);
		expect(button[0]).toContain('disabled={backupSaving}');
		// And the flag is up for the whole of the save a removal makes.
		expect(callsOf(functionNamed(scheduled, 'removeDestination'), 'saveBackupConfig')).toHaveLength(1);
		const saving = functionNamed(scheduled, 'saveBackupConfig');
		expect(saving.body!.statements[0].getText()).toBe('backupSaving = true;');
		expect(finallyBlocks(saving)).toEqual(['{ backupSaving = false; }']);
	});

	it('knows a .db backup by the ending of its name in any case', () => {
		const said = functionNamed(restore, 'handleFileSelected').getText().replace(/\s+/g, ' ');

		expect(said).toContain('const named = file.name.toLowerCase();');
		expect(said).toContain("const isDbFile = named.endsWith('.db') || named.endsWith('.sqlite') || named.endsWith('.sqlite3');");
	});

	it('says in the import dialog that everybody is signed out, and that a backup with no superadmin is refused', () => {
		const dialog = restoreMarkup.slice(restoreMarkup.indexOf('<h2>Import Database</h2>'));

		expect(dialog).toContain('Everybody is signed out, you included: no session is restored, whatever the backup holds');
		expect(dialog).toContain('A backup with users and no superadmin among them is refused.');
		expect(everywhere).not.toContain('unless the backup holds your current session');
	});

	it('says in the import dialog that a backup holds no secret, and no longer that the outside comes back exactly (card 2169)', () => {
		const dialog = restoreMarkup.slice(restoreMarkup.indexOf('<h2>Import Database</h2>'));
		const asItIs = dialog.slice(dialog.indexOf('<strong>Restore everything as it is</strong>'));
		const said = /<span class="import-choice-desc">([^<]*)<\/span>/.exec(asItIs)?.[1];

		expect(said).toBe(
			'For putting this installation back. Backup destinations, report schedules, mail settings and webhooks come ' +
				'back as the backup has them. A backup holds no mail password, destination credential or webhook secret: ' +
				'the ones this server has for the same accounts are kept, and the result lists any to enter again; a ' +
				'webhook that had a secret stays off until it is set.'
		);
		expect(everywhere).not.toContain('come back exactly as the backup has them');
	});

	it('shows what an import kept from this server and what is to enter again, each a line after the working copy’s (card 2169)', () => {
		const js = ts.transpileModule(functionNamed(restore, 'accountOf').getText(), {
			compilerOptions: { target: ts.ScriptTarget.ES2022 }
		}).outputText;
		const accountOf = new Function('count', `${js}\nreturn accountOf;`)((n: number) => String(n)) as (
			result: Record<string, unknown>
		) => Record<string, unknown>;
		const KEPT = 'Kept from this server, because a backup does not hold them: the mail password.';
		const TO_ENTER = 'To enter again, because a backup does not hold them: the mail password (Admin, Email Settings).';

		expect(accountOf({ restored: {}, secretsKept: KEPT, secretsToEnter: TO_ENTER })).toMatchObject({
			secretsKept: KEPT,
			secretsToEnter: TO_ENTER
		});
		// A backup from before card 2169, or one that needed nothing, says neither.
		const quiet = accountOf({ restored: {} });
		expect(quiet.secretsKept).toBeUndefined();
		expect(quiet.secretsToEnter).toBeUndefined();

		const report = restoreMarkup.slice(restoreMarkup.indexOf('{#if importReport}'));
		const lines = [
			'{#if importReport.workingCopy}',
			'{#if importReport.secretsKept}\n',
			'{#if importReport.secretsToEnter}\n',
			'{#if importReport.superadmin}'
		].map((line) => report.replace(/\r\n/g, '\n').indexOf(line));
		expect(lines.every((at) => at > -1)).toBe(true);
		expect([...lines].sort((a, b) => a - b)).toEqual(lines);
		expect(report).toMatch(/\{#if importReport\.secretsKept\}\s*<p class="import-report-detail">\{importReport\.secretsKept\}<\/p>/);
		expect(report).toMatch(
			/\{#if importReport\.secretsToEnter\}\s*<p class="import-report-detail">\{importReport\.secretsToEnter\}<\/p>/
		);
	});

	it('shows how many request links an import replaced, a line beside the files put back (card 2158, the review’s O1)', () => {
		const js = ts.transpileModule(functionNamed(restore, 'accountOf').getText(), {
			compilerOptions: { target: ts.ScriptTarget.ES2022 }
		}).outputText;
		const accountOf = new Function('count', `${js}\nreturn accountOf;`)((n: number) => String(n)) as (
			result: Record<string, unknown>
		) => Record<string, unknown>;

		expect(accountOf({ restored: {}, requestLinksReplaced: 2 }).requestLinks).toBe(
			'2 request links replaced: a link mailed before this restore no longer works, and its requester can have a new ' +
				'one sent from the page it opens.'
		);
		expect(accountOf({ restored: {}, requestLinksReplaced: 1 }).requestLinks).toBe(
			'1 request link replaced: a link mailed before this restore no longer works, and its requester can have a new ' +
				'one sent from the page it opens.'
		);
		expect(accountOf({ restored: {}, requestLinksReplaced: 0 }).requestLinks).toBeUndefined();
		expect(accountOf({ restored: {} }).requestLinks).toBeUndefined();

		const report = restoreMarkup.slice(restoreMarkup.indexOf('{#if importReport}')).replace(/\r\n/g, '\n');
		const lines = ['{#if importReport.putBack}', '{#if importReport.requestLinks}', '{#if importReport.workingCopy}'].map((line) =>
			report.indexOf(line)
		);
		expect(lines.every((at) => at > -1)).toBe(true);
		expect([...lines].sort((a, b) => a - b)).toEqual(lines);
		expect(report).toMatch(/\{#if importReport\.requestLinks\}\s*<p class="import-report-detail">\{importReport\.requestLinks\}<\/p>/);
	});

	it('says after a change of role that an invite sent earlier no longer works, when the answer says one ended', () => {
		// The users panel (card 2281, slice C1b).
		const users = scriptOf('src/lib/components/admin/UsersPanel.svelte');
		const changing = functionNamed(users, 'changeUserRole');

		expect(branches(users, 'changeUserRole', 'answerBody')).toEqual(['ok']);
		const said = changing.getText().replace(/\s+/g, ' ');
		expect(said).toContain('const invitesEnded = result?.invitesEnded;');
		expect(said).toContain(
			"typeof invitesEnded === 'number' && invitesEnded > 0 " +
				"? 'Role updated. The invite sent to this account earlier no longer works: send a new one with 📧.' " +
				": 'Role updated'"
		);
	});
});

// ─── What setting a password ends, said on the page ─────────────────────────
//
// Setting a password ends the account's sessions and its invites not yet
// used. An administrator's reset and an invite end its API keys too, and the
// holder's own change ends them only when asked (cards 2116 and 2137). The
// webhooks the account set go with the keys, and a reset or an invite pauses
// its report schedules as well (card 2168). Making a key asks for the
// password. These are what the three pages say about it.

/** Every `name = ...` inside `within`. */
function assignmentsTo(within: ts.Node, name: string): ts.BinaryExpression[] {
	const found: ts.BinaryExpression[] = [];
	const visit = (node: ts.Node) => {
		if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && node.left.getText() === name) {
			found.push(node);
		}
		ts.forEachChild(node, visit);
	};
	visit(within);
	return found;
}

/** The names of the properties of the object each `JSON.stringify({ ... })` in `within` sends. */
function bodiesSent(within: ts.Node): string[][] {
	return callsOf(within, 'JSON.stringify').map((call) => {
		const sent = call.arguments[0];
		if (!sent || !ts.isObjectLiteralExpression(sent)) return [];
		return sent.properties.map((property) => property.name?.getText() ?? '');
	});
}

describe('the account page, src/routes/account/+page.svelte', () => {
	const file = 'src/routes/account/+page.svelte';
	const source = readFileSync(join(ROOT, file), 'utf8');
	const page = scriptOf(file);
	const markup = source.slice(source.indexOf('</script>'));
	const from = source.indexOf('</script>');
	const around = (text: string) => {
		expect(markup.split(text), text).toHaveLength(2);
		return blocksAround(source, from + markup.indexOf(text));
	};

	it('makes a key with the password, and shows a refusal of it in the server’s words', () => {
		const generating = functionNamed(page, 'generateApiKey');

		// The password goes with the name.
		expect(bodiesSent(generating)).toEqual([['name', 'password']]);
		// Read as JSON only where the answer is a success, and a refusal asked
		// for its message, once, in the branch for a failure.
		expect(branches(page, 'generateApiKey', 'res.json')).toEqual(['ok']);
		expect(branches(page, 'generateApiKey', 'failureMessage')).toEqual(['failed']);
		const [asked] = callsOf(generating, 'failureMessage');
		expect(asked.arguments[0].getText()).toBe('res');
		expect(ts.isStringLiteralLike(asked.arguments[1])).toBe(true);
		expect(asked.parent.parent.getText()).toBe(`apiKeyError = ${asked.parent.getText()}`);
		expect(page.getText()).toMatch(/import \{[^}]*\bfailureMessage\b[^}]*\} from '\$lib\/api';/);

		// And the page shows it.
		expect(around('{apiKeyError}')).toEqual([{ condition: 'apiKeyError', inElse: false }]);
	});

	it('clears the password after every attempt, and keeps Generate Key off until there is a name and a password', () => {
		const cleared = assignmentsTo(functionNamed(page, 'generateApiKey'), 'newKeyPassword');

		expect(cleared.map((assignment) => assignment.right.getText())).toEqual(["''"]);
		// Whatever the answer was: in neither branch.
		expect(cleared.map(branchOf)).toEqual([null]);
		// A password field of its own, which a browser fills with the one it has saved.
		expect(markup).toMatch(/<input\s+id="apikey-password"\s+type="password"\s+bind:value=\{newKeyPassword\}[^>]*autocomplete="current-password"/);
		expect(markup).toContain('disabled={!newKeyName.trim() || !newKeyPassword || generatingKey}');
	});

	it('offers to end the API keys with a password change, not ticked, and only when there are keys to end or webhooks to switch off', () => {
		// Not ticked unless the holder ticks it.
		expect(page.getText()).toContain('let endApiKeysToo = $state(false);');
		expect(assignmentsTo(page, 'endApiKeysToo').map((assignment) => assignment.right.getText())).toEqual(['false', 'false']);
		// And cleared whenever the box is not offered, not only after a change: a
		// box ticked beside a key that was then revoked must not come back ticked
		// beside the next one.
		const cleared = page.statements.filter(
			(statement) => ts.isExpressionStatement(statement) && statement.getText().startsWith('$effect(')
		);
		expect(cleared.map((statement) => assignmentsTo(statement, 'endApiKeysToo').length)).toContain(1);
		expect(page.getText()).toMatch(/\$effect\(\(\) => \{\s*if \(!offerToEnd\) endApiKeysToo = false;\s*\}\);/);

		// The box while the list holds a key, or while the account set a webhook
		// that is on (card 2168): deleting the key that made a webhook leaves the
		// webhook sending. For a webhook alone, only once the key list has been
		// read, so that a list that failed to load does not hide keys the box
		// would end.
		expect(page.getText()).toContain('let webhooksSet = $derived(data.webhooks ?? 0);');
		expect(page.getText()).toContain('let offerToEnd = $derived(apiKeys.length > 0 || (apiKeysRead && webhooksSet > 0));');
		expect(assignmentsTo(page, 'apiKeysRead').map((assignment) => assignment.right.getText())).toEqual(['true']);
		expect(around('bind:checked={endApiKeysToo}')).toEqual([{ condition: 'offerToEnd', inElse: false }]);
		// "It" for one, "they" for more.
		expect(around(
			"You have {keysInWords(apiKeys.length)}. {apiKeys.length === 1 ? 'It keeps' : 'They keep'} working after a password change unless you tick the box."
		)).toEqual([
			{ condition: 'offerToEnd', inElse: false },
			{ condition: 'apiKeys.length > 0', inElse: false }
		]);
		expect(around(
			"You set up {webhooksInWords(webhooksSet)}. {webhooksSet === 1 ? 'It keeps' : 'They keep'} sending your boards' events after a password change unless you tick the box."
		)).toEqual([
			{ condition: 'offerToEnd', inElse: false },
			{ condition: 'webhooksSet > 0', inElse: false }
		]);
		// What ticking it ends, worded for what there is.
		expect(markup).toContain('<span>{whatTheBoxEnds(apiKeys.length, webhooksSet)}</span>');
		const words = functionNamed(page, 'whatTheBoxEnds').getText();
		for (const phrase of [
			'`End my ${keysInWords(keys)} too, and switch off the ${webhooksInWords(hooks)} I set up.`',
			'`End my ${keysInWords(keys)} too.`',
			'`Switch off the ${webhooksInWords(hooks)} I set up.`',
			"'Do this if anyone else may have used your account.'",
			"`Anything that uses ${keys === 1 ? 'the key' : 'the keys'} stops working until it is given a new key.`",
			"\"A webhook switched off sends nothing until the board's owner or an administrator switches it on again.\""
		]) {
			expect(words, phrase).toContain(phrase);
		}
	});

	it('sends the choice as endApiKeys, says what the change ended, and reads the key list again after keys were ended', () => {
		const changing = functionNamed(page, 'changePassword');

		expect(bodiesSent(changing)).toEqual([['currentPassword', 'newPassword', 'endApiKeys']]);
		expect(changing.getText()).toContain('const endApiKeys = endApiKeysToo && offerToEnd;');
		// The counts are the answer's, read where the answer is a success.
		expect(branches(page, 'changePassword', 'answerBody')).toEqual(['ok']);
		expect(changing.getText()).toContain('const answer = await answerBody(res);');
		expect(changing.getText()).toContain("typeof answer?.apiKeysEnded === 'number'");
		expect(changing.getText()).toContain("typeof answer?.webhooksSwitchedOff === 'number'");
		expect(changing.getText()).toContain("'Password changed. Your other sessions were signed out'");
		expect(changing.getText()).toContain(
			"`the ${webhooksInWords(hooksOff)} you set up ${hooksOff === 1 ? 'was' : 'were'} switched off`"
		);
		expect(branches(page, 'changePassword', 'loadApiKeys')).toEqual(['ok']);
		// And the count of webhooks is read again once they were switched off.
		expect(branches(page, 'changePassword', 'invalidateAll')).toEqual(['ok']);
		expect(branches(page, 'changePassword', 'failureMessage')).toEqual(['failed']);
	});

	it('hides a key just made once a change has ended it, and is never left at "Changing..."', () => {
		const changing = functionNamed(page, 'changePassword');
		const within = (node: ts.Node, block: ts.Node | undefined) => {
			for (let at: ts.Node | undefined = node; at; at = at.parent) if (at === block) return true;
			return false;
		};

		// The panel that shows a new key goes when the keys were ended.
		const hidden = assignmentsTo(changing, 'newlyCreatedKey');
		expect(hidden.map((assignment) => assignment.right.getText())).toEqual(["''"]);
		expect(hidden.map(branchOf)).toEqual(['ok']);
		const ifEnded = hidden[0].parent.parent.parent;
		expect(ts.isIfStatement(ifEnded) && ifEnded.expression.getText()).toBe('endApiKeys');

		// The button is given back in a finally, as Generate Key's is, and a
		// request with no answer says so.
		const attempts = changing.body!.statements.filter(ts.isTryStatement);
		expect(attempts).toHaveLength(1);
		const [attempt] = attempts;
		expect(within(callsOf(changing, 'fetch')[0], attempt.tryBlock)).toBe(true);
		const settled = assignmentsTo(changing, 'changingPassword').filter((assignment) => assignment.right.getText() === 'false');
		expect(settled.map((assignment) => within(assignment, attempt.finallyBlock))).toEqual([true]);
		expect(attempt.catchClause?.getText()).toContain("passwordMessage = 'No answer from the server.");
	});

	it('links to the API documentation the application serves', () => {
		expect(markup).toContain('<a href="/docs" target="_blank">API documentation</a>');
		expect(source).not.toContain('DUMPFIRE_API.md');
	});
});

// Card 2281, slice C1b: the dialog and its script are a component of the admin page, drawn by the users panel.
describe('the admin page’s password dialog, src/lib/components/admin/ResetPasswordDialog.svelte', () => {
	const file = 'src/lib/components/admin/ResetPasswordDialog.svelte';
	const source = readFileSync(join(ROOT, file), 'utf8');
	const page = scriptOf(file);
	const markup = source.slice(source.indexOf('</script>'));
	const from = source.indexOf('</script>');
	const around = (text: string) => {
		expect(markup.split(text), text).toHaveLength(2);
		return blocksAround(source, from + markup.indexOf(text));
	};

	it('tells an administrator on their own row that their keys and webhooks keep working, and sends no endApiKeys', () => {
		const line =
			'Your API keys and the webhooks you set up keep working. To end the keys and switch off those webhooks too, ' +
			'change your password on the <a href="/account">Account page</a>.';

		expect(around(line).at(-1)).toEqual({ condition: 'resettingOwnPassword', inElse: false });
		expect(bodiesSent(functionNamed(page, 'resetPassword'))).toEqual([['currentPassword', 'newPassword'], ['password']]);
	});

	it('says beforehand how many API keys a reset ends, from the count the page was loaded with', () => {
		const count = "They have {counted(resetTargetKeys, 'API key')}, which {resetTargetKeys === 1 ? 'stops' : 'stop'} working.";

		// None for null, which the page is given for an account the caller may not reset.
		expect(around(count).slice(-2)).toEqual([
			{ condition: 'resettingOwnPassword', inElse: true },
			{ condition: 'resetTargetKeys !== null && resetTargetKeys > 0', inElse: false }
		]);
		expect(
			around(
				'They are signed out everywhere, every API key they have stops working, any invite not yet used stops working, ' +
					'the webhooks they set up are switched off and their report schedules are paused.'
			).at(-1)
		).toEqual({
			condition: 'resettingOwnPassword',
			inElse: true
		});
		expect(page.getText()).toContain('let resetTarget = $derived(data.users.find((u) => u.id === resetPasswordUserId));');
		expect(page.getText()).toContain('let resetTargetKeys = $derived(resetKeysRead ? (resetTarget?.apiKeys ?? null) : null);');
	});

	it('says beforehand how many webhooks a reset switches off and report schedules it pauses, once the counts are read again (card 2168)', () => {
		const webhooks = "They set up {counted(resetTargetWebhooks, 'webhook')}, which {resetTargetWebhooks === 1 ? 'is' : 'are'} switched off.";
		const schedules = "They have {counted(resetTargetSchedules, 'report schedule')}, which {resetTargetSchedules === 1 ? 'is' : 'are'} paused.";

		expect(around(webhooks).slice(-2)).toEqual([
			{ condition: 'resettingOwnPassword', inElse: true },
			{ condition: 'resetTargetWebhooks !== null && resetTargetWebhooks > 0', inElse: false }
		]);
		expect(around(schedules).slice(-2)).toEqual([
			{ condition: 'resettingOwnPassword', inElse: true },
			{ condition: 'resetTargetSchedules !== null && resetTargetSchedules > 0', inElse: false }
		]);
		// Null until the page's data has been read again since the dialog opened, as the key count is.
		expect(page.getText()).toContain('let resetTargetWebhooks = $derived(resetKeysRead ? (resetTarget?.webhooks ?? null) : null);');
		expect(page.getText()).toContain(
			'let resetTargetSchedules = $derived(resetKeysRead ? (resetTarget?.reportSchedules ?? null) : null);'
		);
	});

	it('reads the counts again when the dialog opens, and shows none until it has', () => {
		// The one way the dialog opens: 🔑 on a row of the users panel, which draws the dialog.
		const users = readFileSync(join(ROOT, 'src/lib/components/admin/UsersPanel.svelte'), 'utf8');
		expect(users).toContain('onclick={() => resetDialog?.openResetDialog(u.id)} title="Reset password">🔑</button>');
		expect(users).toContain('<ResetPasswordDialog bind:this={resetDialog} {data} />');
		expect(
			adminSources()
				.map((admin) => admin.source)
				.join('\n')
				.match(/openResetDialog\(/g)
		).toHaveLength(2);
		expect(assignmentsTo(page, 'resetPasswordUserId').map((assignment) => assignment.right.getText())).toEqual(['userId', 'null']);
		expect(markup).not.toMatch(/resetPasswordUserId = (?!null)/);

		// Not read, then read again, then read.
		const opening = functionNamed(page, 'openResetDialog');
		const rereads = callsOf(opening, 'invalidateAll');
		expect(rereads).toHaveLength(1);
		const marks = assignmentsTo(opening, 'resetKeysRead');
		expect(marks.map((assignment) => assignment.right.getText())).toEqual(['false', 'true']);
		expect(marks[0].getStart()).toBeLessThan(rereads[0].getStart());
		expect(marks[1].getStart()).toBeGreaterThan(rereads[0].getStart());
		// Only for the opening the read was made for.
		expect(marks[1].parent.parent.getText()).toBe(
			'if (opening === resetOpenings && resetPasswordUserId === userId) resetKeysRead = true;'
		);
		// And nowhere else.
		expect(assignmentsTo(page, 'resetKeysRead')).toHaveLength(2);
	});

	it('gives the counts the answer gives in the toast after a reset, and reads the counts on the page again', () => {
		const resetting = functionNamed(page, 'resetPassword');

		expect(branches(page, 'resetPassword', 'answerBody')).toEqual(['ok']);
		expect(resetting.getText()).toContain(
			"`Password reset: ${counted(sessionsEnded, 'session')} and ${counted(apiKeysEnded, 'API key')} ended, ` +"
		);
		expect(resetting.getText()).toContain(
			"`${counted(webhooksSwitchedOff, 'webhook')} switched off and ${counted(reportSchedulesPaused, 'report schedule')} paused`"
		);
		for (const count of ['sessionsEnded', 'apiKeysEnded', 'webhooksSwitchedOff', 'reportSchedulesPaused']) {
			expect(resetting.getText()).toContain(`const ${count} = result?.${count};`);
			expect(resetting.getText()).toContain(`typeof ${count} === 'number'`);
		}
		expect(branches(page, 'resetPassword', 'invalidateAll')).toEqual(['ok']);
		expect(branches(page, 'resetPassword', 'failureMessage')).toEqual(['failed']);
	});
});

describe('the invite page, src/routes/invite/[token]/+page.svelte', () => {
	const file = 'src/routes/invite/[token]/+page.svelte';
	const source = readFileSync(join(ROOT, file), 'utf8');
	const markup = source.slice(source.indexOf('</script>'));
	const from = source.indexOf('</script>');
	const around = (text: string) => {
		expect(markup.split(text), text).toHaveLength(2);
		return blocksAround(source, from + markup.indexOf(text));
	};

	/** The words the form answers a dead link with: `DEAD_LINK` in the page's server file, its pieces joined. */
	function formWords(): string {
		const server = ts.createSourceFile(
			'+page.server.ts',
			readFileSync(join(ROOT, 'src/routes/invite/[token]/+page.server.ts'), 'utf8'),
			ts.ScriptTarget.Latest,
			true
		);
		const pieces: string[] = [];
		const visit = (node: ts.Node) => {
			if (ts.isVariableDeclaration(node) && node.name.getText() === 'DEAD_LINK' && node.initializer) {
				const collect = (part: ts.Node) => {
					if (ts.isStringLiteralLike(part)) pieces.push(part.text);
					ts.forEachChild(part, collect);
				};
				collect(node.initializer);
			}
			ts.forEachChild(node, visit);
		};
		visit(server);
		return pieces.join('');
	}

	it('says the same about a dead link as the form does, whatever made it so', () => {
		const words = formWords();

		expect(words).toBe(
			'This invite link no longer works. It has expired, it has already been used, or it was cancelled when a ' +
				"newer invite was sent or the account's password, email address or role was changed. Ask an " +
				'administrator to send you a new one.'
		);
		expect(around(words)).toEqual([{ condition: 'data.valid', inElse: true }]);
		expect(source).not.toContain('invalid or has already been used');
	});

	it('says, before the form is sent, that setting a password ends the account’s API keys, switches off its webhooks and pauses its report schedules', () => {
		const notice = 'Setting a password here {whatItEnds} and signs it out everywhere else.';

		expect(around(notice)).toEqual([
			{ condition: 'data.valid', inElse: false },
			{ condition: 'whatItEnds', inElse: false }
		]);
		const script = scriptOf(file).getText();
		expect(script).toContain('let apiKeys = $derived(data.apiKeys ?? 0);');
		expect(script).toContain('let webhooks = $derived(data.webhooks ?? 0);');
		expect(script).toContain('let reportSchedules = $derived(data.reportSchedules ?? 0);');
		for (const phrase of [
			"`ends this account's ${apiKeys} API key${apiKeys === 1 ? '' : 's'}`",
			"`switches off the ${webhooks} webhook${webhooks === 1 ? '' : 's'} it set up`",
			"`pauses its ${reportSchedules} report schedule${reportSchedules === 1 ? '' : 's'}`"
		]) {
			expect(script, phrase).toContain(phrase);
		}
	});
});

// ─── A request link that no longer works (card 2158) ─────────────────────────

describe('a request’s pages, for a link that no longer works (card 2158)', () => {
	const REPLY = 'src/routes/request/[id]/reply/+page.svelte';
	const CONFIRM = 'src/routes/request/[id]/confirm/+page.svelte';
	const FORM = 'src/lib/components/NewRequestLink.svelte';

	type Answer = { status: number; body?: unknown };
	type Page = {
		loadData: () => Promise<void>;
		pollMessages: () => Promise<void>;
		readonly state: { request: unknown; linkGone: boolean; polling: unknown };
		asked: string[];
		started: unknown[][];
		stopped: unknown[];
	};

	/**
	 * The reply page's loading and polling, as written, run with a stand-in
	 * `fetch` that answers each address from `answers` and a stand-in timer:
	 * the page's state is plain variables here.
	 */
	function replyPage(answers: (url: string) => Answer): Page {
		const tree = scriptOf(REPLY);
		const functions = ['loadData', 'readThread', 'pollMessages', 'showLinkGone', 'stopPolling']
			.map((name) => functionNamed(tree, name).getText())
			.join('\n');
		const js = ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
		const asked: string[] = [];
		const started: unknown[][] = [];
		const stopped: unknown[] = [];
		const fetch = async (url: string) => {
			asked.push(url);
			const { status, body } = answers(url);
			return { status, ok: status >= 200 && status < 300, json: async () => body };
		};
		const setInterval = (...args: unknown[]) => {
			started.push(args);
			return `timer ${started.length}`;
		};
		const clearInterval = (handle: unknown) => stopped.push(handle);
		const page = new Function(
			'fetch',
			'setInterval',
			'clearInterval',
			'failureMessage',
			"let request = null, messages = [], loading = true, errorMsg = '', threadError = '', linkGone = false, pollInterval = null;\n" +
				"const requestId = 5, token = 'the-link';\nfunction scrollToBottom() {}\n" +
				`${js}\n` +
				'return { loadData, pollMessages, get state() { return { request, linkGone, polling: pollInterval }; } };'
		)(fetch, setInterval, clearInterval, failureMessage);
		return Object.assign(page, { asked, started, stopped }) as Page;
	}

	const THREAD = { status: 200, body: { id: 5, title: 'A request', status: 'pending' } };

	it.each([403, 404])('does not poll a link that opens no thread (%i), and shows the form that asks for a new one', async (status) => {
		const page = replyPage(() => ({ status, body: { message: 'Request not found' } }));

		await page.loadData();

		expect(page.state).toEqual({ request: null, linkGone: true, polling: null });
		// Not even the messages are asked for, and nothing is polled.
		expect(page.asked).toEqual(['/api/requests/5?token=the-link']);
		expect(page.started).toEqual([]);
	});

	it.each([403, 404])('polls once a thread has loaded, and stops at the first %i, showing the form', async (status) => {
		let gone = false;
		const page = replyPage((url) => (gone ? { status } : url.includes('/messages') ? { status: 200, body: [] } : THREAD));

		await page.loadData();

		expect(page.started).toEqual([[page.pollMessages, 5000]]);
		expect(page.state).toEqual({ request: THREAD.body, linkGone: false, polling: 'timer 1' });

		// Loaded again after a reply is sent: still one poll.
		await page.loadData();
		expect(page.started).toHaveLength(1);

		// The link is replaced while the page is open (a restore).
		gone = true;
		await page.pollMessages();

		expect(page.stopped).toEqual(['timer 1']);
		expect(page.state).toEqual({ request: null, linkGone: true, polling: null });
	});

	it('shows the form in place of the thread on the reply page, and under the refusal on the confirm page', () => {
		const reply = readFileSync(join(ROOT, REPLY), 'utf8');
		expect(reply).toMatch(/\{:else if linkGone\}\s*<div class="link-gone">\s*<NewRequestLink \{requestId\} \/>/);
		expect(reply).not.toContain('Use the link in the most recent email');

		const confirm = readFileSync(join(ROOT, CONFIRM), 'utf8');
		expect(confirm).toMatch(
			/\{#if errorMsg\}\s*<div class="error-msg">\{errorMsg\}<\/div>\s*\{\/if\}\s*\{#if linkGone\}\s*<NewRequestLink \{requestId\} \/>/
		);
		// A refusal for what the link is, and no other, is a link that no longer works.
		expect(scriptOf(CONFIRM).getText()).toContain('linkGone = res.status === 404;');
	});

	it('says what card 2171’s decision 13 says, asks the one route, and shows its answer and when to expect the mail', () => {
		const form = readFileSync(join(ROOT, FORM), 'utf8');
		const markup = form.slice(form.indexOf('</script>'));

		// A request made signed in is mailed at the account's address as it is
		// now (card 2171), so the page says which address to give.
		expect(form).toContain(
			'"This link no longer works. Enter the email address you made the request with (if you made it while signed ' +
				'in to DumpFire, your account\'s email address as it is now), and a new link will be sent to it."'
		);
		expect(form).toContain('fetch(`/api/requests/${requestId}/link`');
		expect(form).toContain('body: JSON.stringify({ email: email.trim() })');
		expect(markup).toContain('Send me a new link');
		expect(markup).toMatch(/\{#if answered\}\s*<p class="new-link-text">\{answered\}<\/p>\s*<p class="new-link-hint">It can take a few minutes to arrive\.<\/p>/);
		// A refusal (a 429, a 503) is said in the server's words.
		expect(callsOf(scriptOf(FORM), 'failureMessage')).toHaveLength(1);
	});

	it('says, with every state of the form, that a request not confirmed in seven days is gone, and so says nothing of this one (card 2243)', () => {
		const form = readFileSync(join(ROOT, FORM), 'utf8');
		const markup = form.slice(form.indexOf('</script>'));
		const sentence =
			'<p class="new-link-lapsed">A request not confirmed within seven days is no longer kept; make it again at <a href="/request">/request</a>.</p>';

		// Written once, after the {#if answered} block closes: shown before the
		// form is used and after its answer alike, on the reply page and the
		// confirm page alike, so it tells nobody whether this request lapsed.
		expect(markup.split(sentence)).toHaveLength(2);
		expect(markup).toMatch(/\{\/if\}\s*\{\/if\}\s*(?:<!--[^]*?-->\s*)?<p class="new-link-lapsed">/);
		expect(markup.slice(markup.indexOf(sentence) + sentence.length)).toMatch(/^\s*<\/div>/);
	});
});

// ─── A session that has ended ────────────────────────────────────────────────

describe('a 401 that says the page’s session has ended, src/lib/signed-out.ts', () => {
	const PAGE = 'http://localhost/board/1';

	it('is one from this page’s own server, under /api/, and outside /api/v1/ and the request form’s routes', () => {
		const cases: [RequestInfo | URL, boolean][] = [
			['/api/boards', true],
			['/api/cards/1/attachments', true],
			['http://localhost/api/cards/1', true],
			[new URL('http://localhost/api/events'), true],
			[new Request('http://localhost/api/boards/1/events'), true],
			// Named like the form's routes, and not one of them: the gate answers it as an internal route.
			['/api/requestsX', true],
			// Read against the page's own address, as the browser reads it.
			['api/boards', false],
			['https://elsewhere.example.test/api/boards', false],
			['http://localhost:5173/api/boards', false],
			['/api/v1/me', false],
			['/api/requests', false],
			['/api/requests/targets', false],
			['/api/requests/4/messages?token=x', false],
			['/login', false],
			['/board/1/__data.json', false],
			['/api', false],
			['http://[not an address', false]
		];

		for (const [input, ends] of cases) {
			expect({ input: String(input instanceof Request ? input.url : input), ends: endsTheSession(input, PAGE) }).toEqual({
				input: String(input instanceof Request ? input.url : input),
				ends
			});
		}
	});

	/** A `fetch` that answers each request with the next of `statuses`, and the page it watches for. */
	function stage(statuses: number[], signedIn: () => boolean = () => true) {
		const sentToLogin: string[] = [];
		const answered: Response[] = [];
		const fetch: Fetch = async () => {
			const res = new Response(JSON.stringify({ message: 'x' }), { status: statuses.shift() ?? 200 });
			answered.push(res);
			return res;
		};
		const watched = watchForSignOut(fetch, { address: () => PAGE, signedIn, toLogin: () => sentToLogin.push('/login') });
		return { watched, sentToLogin, answered };
	}

	it('sends a signed-in page to the login page on the first, once, and hands every answer back as it came', async () => {
		const { watched, sentToLogin, answered } = stage([401, 401, 401]);

		const first = await watched('/api/boards');
		await watched('/api/cards/1', { method: 'PUT' });
		await watched('/api/events');

		expect(sentToLogin).toEqual(['/login']);
		expect(first).toBe(answered[0]);
		expect(first.status).toBe(401);
		expect(await first.json()).toEqual({ message: 'x' });
	});

	it('leaves a page with nobody signed in where it is: a requester whose form has lapsed has no account to sign in to', async () => {
		const { watched, sentToLogin } = stage([401, 401], () => false);

		await watched('/api/boards');
		await watched('/api/cards/1');

		expect(sentToLogin).toEqual([]);
	});

	it('leaves every other answer alone: another status, the documented API, the request form’s routes, another server', async () => {
		const { watched, sentToLogin } = stage([403, 404, 500, 200, 401, 401, 401]);

		for (const input of ['/api/boards', '/api/boards', '/api/boards', '/api/boards', '/api/v1/me', '/api/requests/targets', 'https://elsewhere.example.test/api/boards']) {
			await watched(input);
		}

		expect(sentToLogin).toEqual([]);
	});

	it('cannot make a request fail that would not have, nor one succeed that would not have', async () => {
		const confused = watchForSignOut(async () => new Response(null, { status: 401 }), {
			address: () => PAGE,
			signedIn: () => {
				throw new Error('cannot tell');
			},
			toLogin: () => {}
		});
		expect((await confused('/api/boards')).status).toBe(401);

		const offline = new TypeError('Failed to fetch');
		const unreachable = watchForSignOut(
			async () => {
				throw offline;
			},
			{ address: () => PAGE, signedIn: () => true, toLogin: () => {} }
		);
		await expect(unreachable('/api/boards')).rejects.toBe(offline);
	});
});

describe('a live-update stream that fails, src/lib/live-stream.ts', () => {
	type Fake = {
		url: string;
		onopen: (() => void) | null;
		onerror: (() => void) | null;
		closed: boolean;
		close: () => void;
		addEventListener: () => void;
	};

	/** A stream as the page would keep it, with stand-ins for the browser: each ask is answered with the next of `answers`. */
	function stage(answers: (number | 'no answer')[]) {
		const opened: Fake[] = [];
		const timers: { run: () => void; ms: number }[] = [];
		const asked: { url: string; signal: AbortSignal | null | undefined }[] = [];
		const listened: Fake[] = [];
		let reopened = 0;

		const env: StreamEnvironment = {
			open: (url) => {
				const source: Fake = {
					url,
					onopen: null,
					onerror: null,
					closed: false,
					close() {
						this.closed = true;
					},
					addEventListener: () => {}
				};
				opened.push(source);
				return source as unknown as EventSource;
			},
			fetch: async (input, init) => {
				asked.push({ url: String(input), signal: init?.signal });
				const answer = answers.shift();
				if (answer === undefined || answer === 'no answer') throw new TypeError('Failed to fetch');
				return new Response(null, { status: answer });
			},
			setTimeout: (run, ms) => {
				const timer = { run, ms };
				timers.push(timer);
				return timer;
			},
			clearTimeout: (timer) => {
				const at = timers.indexOf(timer as (typeof timers)[number]);
				if (at >= 0) timers.splice(at, 1);
			}
		};

		const close = keepStreamOpen('/api/events', (source) => listened.push(source as unknown as Fake), () => reopened++, env);

		/** The wait that is pending, run, and whatever it asked answered. */
		const waitOut = async () => {
			const timer = timers.shift();
			if (!timer) throw new Error('nothing is waiting');
			timer.run();
			await new Promise((settled) => setTimeout(settled, 0));
			return timer.ms;
		};
		const latest = () => opened[opened.length - 1];

		return { close, opened, timers, asked, listened, waitOut, latest, reopened: () => reopened };
	}

	it('waits three seconds after a failure, twice as long after each failure that follows, and five minutes at most', () => {
		expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 20].map(reconnectDelay)).toEqual([
			3000, 6000, 12000, 24000, 48000, 96000, 192000, 300000, 300000, 300000
		]);
	});

	it('asks for the stream before it opens it again, opens it again on a success, and has the page re-read', async () => {
		const s = stage([200]);
		s.latest().onopen?.();
		expect(s.reopened()).toBe(0);

		s.latest().onerror?.();
		expect(s.opened[0].closed).toBe(true);
		expect(await s.waitOut()).toBe(3000);

		expect(s.asked.map((a) => a.url)).toEqual(['/api/events']);
		expect(s.opened).toHaveLength(2);
		expect(s.listened).toEqual(s.opened);
		s.latest().onopen?.();
		expect(s.reopened()).toBe(1);
	});

	it.each([401, 403, 404])('stays closed when the stream is refused %i: asking again would not mend it', async (status) => {
		const s = stage([status]);
		s.latest().onopen?.();
		s.latest().onerror?.();
		await s.waitOut();

		expect(s.asked).toHaveLength(1);
		expect(s.opened).toHaveLength(1);
		expect(s.timers).toEqual([]);
	});

	it('waits longer each time there is no answer or a failure that may pass, and from three seconds again once it is open', async () => {
		const s = stage(['no answer', 503, 429, 200]);
		s.latest().onopen?.();
		s.latest().onerror?.();

		const waits = [await s.waitOut(), await s.waitOut(), await s.waitOut(), await s.waitOut()];
		expect(waits).toEqual([3000, 6000, 12000, 24000]);
		expect(s.opened).toHaveLength(2);

		s.latest().onopen?.();
		s.latest().onerror?.();
		expect(s.timers.map((t) => t.ms)).toEqual([3000]);
	});

	it('lets go of the answer it asked for as soon as it has the status', async () => {
		const s = stage([200]);
		s.latest().onerror?.();
		await s.waitOut();

		expect(s.asked[0].signal?.aborted).toBe(true);
		expect(await streamVerdict('/api/events', async () => new Response(null, { status: 502 }))).toBe('later');
	});

	it('stops waiting, and opens nothing more, once the page closes it', async () => {
		const s = stage([200]);
		s.latest().onerror?.();
		s.close();
		expect(s.timers).toEqual([]);

		const asking = stage([200]);
		asking.latest().onerror?.();
		const timer = asking.timers.shift()!;
		timer.run();
		asking.close();
		await new Promise((settled) => setTimeout(settled, 0));
		expect(asking.opened).toHaveLength(1);
	});
});

describe('where the watch and the streams are used, read from the source', () => {
	it('src/hooks.client.ts watches fetch once, as the app starts, for a page with a signed-in user', () => {
		const tree = ts.createSourceFile('hooks.client.ts', readFileSync(join(ROOT, 'src/hooks.client.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
		const init = tree.statements.find(
			(statement) => ts.isVariableStatement(statement) && statement.getText().startsWith('export const init: ClientInit = ')
		);
		expect(init).toBeDefined();
		const text = init!.getText().replace(/\s+/g, ' ');

		expect(text).toContain('window.fetch = watchForSignOut(window.fetch.bind(window), {');
		expect(text).toContain('signedIn: () => Boolean(page.data?.user)');
		expect(text).toContain("toLogin: () => window.location.assign('/login')");
		expect(tree.getText().match(/watchForSignOut\(/g)).toHaveLength(1);
		expect(tree.getText()).toContain("import { page } from '$app/state';");
	});

	it('opens every live-update stream through keepStreamOpen, and nothing else opens one again', () => {
		const files = (readdirSync(join(ROOT, 'src'), { recursive: true }) as string[])
			.map((file) => file.split('\\').join('/'))
			.filter((file) => /\.(ts|svelte)$/.test(file));
		const opening = files.filter((file) => readFileSync(join(ROOT, 'src', file), 'utf8').includes('new EventSource('));

		// The audit page's console is the one other. It opens one stream and
		// only notes an error: the browser's own EventSource gives up on a
		// refusal, and nothing opens another (see the console's own tests).
		expect(opening.sort()).toEqual(['lib/live-stream.ts', 'routes/audit/+page.svelte']);
		const audit = readFileSync(join(ROOT, 'src/routes/audit/+page.svelte'), 'utf8');
		expect(audit.match(/new EventSource\(/g)).toHaveLength(1);
		expect(audit).not.toContain('setTimeout(');

		for (const file of ['src/lib/board/sse.ts', 'src/lib/live-refresh.ts', 'src/routes/all/+page.svelte']) {
			const source = readFileSync(join(ROOT, file), 'utf8');
			expect(source.match(/keepStreamOpen\(/g), file).toHaveLength(1);
			expect(source, file).not.toMatch(/setTimeout\(connect/);
		}
		// All Tasks' one stream is the page's: none of its components opens another (card 2281, slice C3a-2).
		for (const file of tasksComponents()) expect(readFileSync(join(ROOT, file), 'utf8'), file).not.toContain('keepStreamOpen(');
	});

	// Card 2281, slice C3b (card 2012's section 6.3, case 1): All Tasks re-read
	// itself 250 ms after every live event, so a bulk archive of 20 cards was 20
	// re-reads. Each event is now handed to the board page's refresh schedule.
	it('All Tasks’ stream listener hands each event to the refresh schedule and calls no invalidateAll in a per-event timer', () => {
		const source = readFileSync(join(ROOT, 'src/routes/all/+page.svelte'), 'utf8');
		const listener = source.slice(source.indexOf('function listenToGlobalSSE('), source.indexOf('function onVisibilityChange('));
		const update = listener.slice(listener.indexOf("addEventListener('update'"), listener.indexOf("addEventListener('celebrate'"));
		expect(update).toContain('liveRefresh.schedule();');
		expect(listener).not.toContain('setTimeout(');
		expect(listener).not.toContain('invalidateAll');
		expect(listener).not.toContain('fetchActivity');

		// The schedule's read is what the event's timer did: the page, and the Activity Log when it is open.
		expect(source).toContain("import { refreshSchedule } from '$lib/board/refresh-schedule';");
		expect(source.match(/refreshSchedule\(/g)).toHaveLength(1);
		const run = source.slice(source.indexOf('const liveRefresh = refreshSchedule('), source.indexOf('});', source.indexOf('const liveRefresh = refreshSchedule(')));
		expect(run).toContain('invalidateAll()');
		expect(run).toContain('activityOpen ? activityPanel?.fetchActivity() : undefined');
		// And it stops with the page.
		const destroy = source.slice(source.indexOf('onDestroy(() => {'), source.indexOf('});', source.indexOf('onDestroy(() => {')));
		expect(destroy).toContain('liveRefresh.dispose();');
	});
});

// Card 2184. SvelteKit keeps a page's component when only its params change,
// so after a link to another board, or Back to one, the board page went on
// listening to the first board's stream, with the first board's selection,
// panels, search and card window. A layout keyed on the board makes the page
// afresh for each: its `onDestroy` closes the first stream and the new page's
// `onMount` opens the second.
describe('the board page’s live stream follows the board it shows, src/routes/board/[id]/+layout.svelte (card 2184)', () => {
	const LAYOUT = 'src/routes/board/[id]/+layout.svelte';
	const board = scriptOf('src/routes/board/[id]/+page.svelte');

	/** The function given to each call of `name` made as the script runs. */
	const handedTo = (name: string) =>
		board.statements
			.filter((statement): statement is ts.ExpressionStatement => ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) && statement.expression.expression.getText() === name)
			.map((statement) => (statement.expression as ts.CallExpression).arguments[0]);

	it('makes the page afresh for each board, keyed on the board and nothing else', () => {
		const source = readFileSync(join(ROOT, LAYOUT), 'utf8');
		const script = scriptOf(LAYOUT).getText();
		const markup = source.slice(source.indexOf('</script>') + '</script>'.length);

		expect(script).toContain("import { page } from '$app/state';");
		expect(markup.replace(/\s+/g, '')).toBe('{#keypage.params.id}{@renderchildren()}{/key}');
	});

	it('opens the stream once, as the page mounts, for the board it shows, and closes it as the page is destroyed', () => {
		const opened = callsOf(board, 'connectSSE');
		expect(opened).toHaveLength(1);
		expect(opened[0].arguments[0].getText()).toBe('data.board.id');
		const mounted = handedTo('onMount');
		expect(mounted.filter((fn) => fn.getStart() <= opened[0].getStart() && opened[0].getEnd() <= fn.getEnd())).toHaveLength(1);

		const destroyed = handedTo('onDestroy');
		expect(destroyed).toHaveLength(1);
		expect(callsOf(destroyed[0], 'cleanupSSE')).toHaveLength(1);
		// Not followed by an effect, which would keep the rest of the first board's page.
		for (const fn of handedTo('$effect')) expect(callsOf(fn, 'connectSSE')).toEqual([]);
	});

	it('closes the first board’s stream and opens the second’s, as the page of each is made and destroyed', () => {
		const sources: { url: string; closed: boolean }[] = [];
		const listeners = { added: 0, removed: 0 };
		vi.stubGlobal(
			'EventSource',
			class {
				closed = false;
				onopen: (() => void) | null = null;
				onerror: (() => void) | null = null;
				constructor(readonly url: string) {
					sources.push(this);
				}
				addEventListener() {}
				close() {
					this.closed = true;
				}
			}
		);
		vi.stubGlobal('document', {
			visibilityState: 'visible',
			addEventListener: (type: string) => type === 'visibilitychange' && listeners.added++,
			removeEventListener: (type: string) => type === 'visibilitychange' && listeners.removed++
		});
		try {
			const callbacks = { onUpdate: () => {}, onCelebrate: () => {}, onXpUpdate: () => {} };
			const first = connectSSE(1, callbacks);
			first();
			connectSSE(2, callbacks);

			expect(sources.map((source) => [source.url, source.closed])).toEqual([
				['/api/boards/1/events', true],
				['/api/boards/2/events', false]
			]);
			expect(listeners).toEqual({ added: 2, removed: 1 });
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe('the audit console’s live log, src/routes/audit/+page.svelte', () => {
	const file = 'src/routes/audit/+page.svelte';
	const source = readFileSync(join(ROOT, file), 'utf8');
	const markup = source.slice(source.indexOf('</script>'));

	/** A stand-in for the browser's EventSource, opened and driven by hand. */
	class FakeEventSource {
		static readonly CONNECTING = 0;
		static readonly OPEN = 1;
		static readonly CLOSED = 2;
		readyState = FakeEventSource.CONNECTING;
		onopen: (() => void) | null = null;
		onerror: (() => void) | null = null;
		onmessage: ((e: { data: string }) => void) | null = null;
		constructor(readonly url: string) {}
		close() {
			this.readyState = FakeEventSource.CLOSED;
		}
	}

	type Console = { es: FakeEventSource; connected: boolean; disconnected: boolean; entries: { id: number }[] };

	/**
	 * The page's `onMount` that opens the stream, as written, run with the
	 * stand-in: the page's state is three plain variables here.
	 */
	function mount(): Console {
		const opening = scriptOf(file).statements.find(
			(statement) => ts.isExpressionStatement(statement) && statement.getText().startsWith('onMount(') && statement.getText().includes('new EventSource(')
		) as ts.ExpressionStatement | undefined;
		expect(opening).toBeDefined();
		const start = ((opening!.expression as ts.CallExpression).arguments[0] as ts.ArrowFunction).getText();
		const js = ts.transpileModule(`const start = ${start};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
		let es: FakeEventSource | undefined;
		const Opening = class extends FakeEventSource {
			constructor(url: string) {
				super(url);
				es = this;
			}
		};
		const state = new Function(
			'EventSource',
			`let connected = false, disconnected = false, entries = [];\n${js}\nstart();\n` +
				'return { get connected() { return connected; }, get disconnected() { return disconnected; }, get entries() { return entries; } };'
		)(Opening) as Omit<Console, 'es'>;
		expect(es?.url).toBe('/api/logs/stream');
		return Object.assign(state, { es: es! }) as Console;
	}

	const at = (second: number) => `2026-10-14T10:00:${String(second).padStart(2, '0')}.000Z`;
	const entry = (id: number, second: number) => ({ id, timestamp: at(second), level: 'INFO', context: 'TEST', message: `line ${id}`, meta: null, userId: null, ip: null });
	const send = (c: Console, ...sent: ReturnType<typeof entry>[]) => {
		for (const e of sent) c.es.onmessage!({ data: JSON.stringify(e) });
	};

	it('says it is disconnected once the browser has given up on the stream, not reconnecting for ever', () => {
		const c = mount();
		c.es.readyState = FakeEventSource.OPEN;
		c.es.onopen!();
		expect([c.connected, c.disconnected]).toEqual([true, false]);

		// A dropped connection: the browser is trying again.
		c.es.readyState = FakeEventSource.CONNECTING;
		c.es.onerror!();
		expect([c.connected, c.disconnected]).toEqual([false, false]);

		// Answered 401 (or 403) when it tried: it has given up for good.
		c.es.readyState = FakeEventSource.CLOSED;
		c.es.onerror!();
		expect([c.connected, c.disconnected]).toEqual([false, true]);

		// And the status says so, where it said "reconnecting…" for ever.
		expect(markup).toContain(
			"{connected ? '● live' : disconnected ? '○ disconnected: reload the page' : '○ reconnecting…'}"
		);
	});

	it('shows each entry once when the stream sends its last entries again on reconnecting, and every entry after a restart', () => {
		const c = mount();
		send(c, entry(1, 1), entry(2, 2), entry(3, 3));

		// Reconnected: the last entries again, then a new one.
		send(c, entry(1, 1), entry(2, 2), entry(3, 3), entry(4, 4));
		expect(c.entries.map((e) => e.id)).toEqual([1, 2, 3, 4]);

		// The server restarted, and its ids count from 1 again: later entries, shown.
		send(c, entry(1, 10), entry(2, 11));
		expect(c.entries.map((e) => e.id)).toEqual([1, 2, 3, 4, 1, 2]);
	});
});

// ─── Every page action that can fail says so (card 2109) ────────────────────
//
// In the archived, All Tasks, teams, admin and reports pages and the card
// window, and for the board page's restore, archive and duplicate, a write
// that was refused said it had worked, or said nothing. Each now reads the
// refusal with `failureMessage`, `deleteFailure` or the admin page's `sent()`,
// says it, and changes the page only for a success, putting back what it
// changed before the answer came.

/**
 * What the test of an `if` says about a request's answer: 'failed' when the
 * `if` is taken for a request that was not done, 'ok' when it is taken for
 * one that was, and null when it says neither. A failure is `!res.ok`;
 * `failure`, which is what `deleteFailure` gives; `!res`, which is what the
 * admin page's `sent()` gives; or a call that was awaited, negated, as
 * `!(await sent(...))` and `!(await saveBackupConfig())`.
 */
function takenWhen(statement: ts.IfStatement): 'ok' | 'failed' | null {
	const test = statement.expression.getText().replace(/\s/g, '');
	// `written` is what the board state's write came to (card 2280, slice B2b);
	// `result.failure` a card window's save that made nothing; `failed` the
	// cards of a bulk change the server did not take.
	if (test === 'res.ok' || test === 'written.ok') return 'ok';
	if (['!res.ok', 'failure', '!res', '!written.ok', 'result.failure', 'failed.length>0'].includes(test) || /^!\(await[\w.]+\(/.test(test)) return 'failed';
	return null;
}

/** Whether `node` is inside `block`, or is it. */
function isWithin(node: ts.Node, block: ts.Node): boolean {
	for (let at: ts.Node | undefined = node; at; at = at.parent) if (at === block) return true;
	return false;
}

/** Whether a statement always ends by returning: a `return`, or a block whose last statement is one. */
function endsByReturning(statement: ts.Statement): boolean {
	if (ts.isReturnStatement(statement)) return true;
	return ts.isBlock(statement) && statement.statements.length > 0 && ts.isReturnStatement(statement.statements[statement.statements.length - 1]);
}

/**
 * Which side of a request's answer a node is on. 'failed': in the branch for
 * an answer that is a failure, or in a `catch`, which is a request that got
 * no answer. 'ok': in the branch for a success, or after a branch for a
 * failure that ends by returning. Null: neither, which is to say it runs
 * whatever the answer was. The nearest decides.
 */
function sideOf(node: ts.Node): 'ok' | 'failed' | null {
	for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
		if (ts.isCatchClause(parent)) return 'failed';
		if (ts.isIfStatement(parent) && child !== parent.expression) {
			const taken = takenWhen(parent);
			if (taken) return (parent.thenStatement === child) === (taken === 'failed') ? 'failed' : 'ok';
		}
		if (ts.isBlock(parent) || ts.isSourceFile(parent)) {
			const before = parent.statements.slice(0, parent.statements.indexOf(child as ts.Statement));
			const failedFirst = before.some(
				(earlier) =>
					ts.isIfStatement(earlier) && takenWhen(earlier) === 'failed' && !earlier.elseStatement && endsByReturning(earlier.thenStatement)
			);
			if (failedFirst) return 'ok';
		}
	}
	return null;
}

/** Every statement in `within` that is `text` and nothing more, as written (`showCardModal = false`). */
function statementsOf(within: ts.Node, text: string): ts.ExpressionStatement[] {
	const wanted = text.replace(/\s+/g, ' ');
	const found: ts.ExpressionStatement[] = [];
	const visit = (node: ts.Node) => {
		if (ts.isExpressionStatement(node) && node.expression.getText().replace(/\s+/g, ' ') === wanted) found.push(node);
		ts.forEachChild(node, visit);
	};
	visit(within);
	return found;
}

/** The functions of `$lib/api.ts` that send a write: each calls `jsonRequest`, or `fetch` with a method that writes. */
function apiWrites(): string[] {
	const tree = ts.createSourceFile('api.ts', readFileSync(join(ROOT, 'src/lib/api.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
	return tree.statements
		.filter((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && !!statement.name)
		.filter((fn) => fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
		.filter((fn) => callsOf(fn, 'jsonRequest').length > 0 || callsOf(fn, 'fetch').some((call) => writeOf(call, []) !== null))
		.map((fn) => fn.name!.text);
}

/**
 * The write a call sends, or null for a call that sends none: `fetch PUT`
 * for `fetch` with a method that writes, and `api.updateCard` for a write of
 * `$lib/api.ts`, whose names are `writes`. `handBack` names the functions,
 * as they are called, that hand back the answer to a write they send
 * (`handingBack`): `boardActions.updateColumn`, or a page's own wrapper.
 */
function writeOf(call: ts.CallExpression, writes: string[], handBack: string[] = []): string | null {
	const callee = call.expression.getText();
	if (callee === 'fetch') {
		const method = /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/.exec(call.arguments[1]?.getText() ?? '');
		return method ? `fetch ${method[1]}` : null;
	}
	if (handBack.includes(callee)) return callee;
	const named = /^api\.(\w+)$/.exec(callee);
	return named && writes.includes(named[1]) ? callee : null;
}

/**
 * The functions declared in `tree` that hand back the answer to a write they
 * send: `return api.updateColumn(...)`, or a `return` of another such
 * function, followed until no more are found. A caller that drops what one
 * returns drops that answer (card 2280, slice B2b: the board page's
 * `updateColumn` dropped three answers the list did not see).
 */
function writesHandedBack(tree: ts.SourceFile, writes: string[], handBack: string[] = []): string[] {
	const found = new Set<string>();
	for (let grew = true; grew; ) {
		grew = false;
		for (const statement of tree.statements) {
			if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body || found.has(statement.name.text)) continue;
			let hands = false;
			const visit = (node: ts.Node) => {
				if (ts.isReturnStatement(node) && node.expression) {
					let returned: ts.Expression = node.expression;
					while (ts.isAwaitExpression(returned) || ts.isParenthesizedExpression(returned)) returned = returned.expression;
					if (ts.isCallExpression(returned) && writeOf(returned, writes, [...handBack, ...found])) hands = true;
				}
				// A function inside it returns for itself.
				if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit);
			};
			ts.forEachChild(statement.body, visit);
			if (hands) {
				found.add(statement.name.text);
				grew = true;
			}
		}
	}
	return [...found];
}

/**
 * What hands back a write's answer, as a file calls it: the functions of
 * each `$lib/board` module it imports (`boardActions.updateColumn` for
 * `import * as boardActions`, or the bare name for a named import), and the
 * file's own functions that wrap a write and return its answer.
 */
function handingBack(file: string, source: string, writes: string[]): string[] {
	const trees = codeOf(file, source).map((code) => code.tree);
	const called: string[] = [];
	for (const tree of trees) {
		for (const statement of tree.statements) {
			if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings) continue;
			const module = /^'\$lib\/board\/([\w.-]+)'$/.exec(statement.moduleSpecifier.getText());
			if (!module) continue;
			const path = join(ROOT, 'src/lib/board', `${module[1]}.ts`);
			if (!existsSync(path)) continue;
			const helpers = writesHandedBack(ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true), writes);
			const bindings = statement.importClause.namedBindings;
			if (ts.isNamespaceImport(bindings)) called.push(...helpers.map((name) => `${bindings.name.text}.${name}`));
			else for (const element of bindings.elements) if (helpers.includes((element.propertyName ?? element.name).text)) called.push(element.name.text);
		}
	}
	for (const tree of trees) called.push(...writesHandedBack(tree, writes, called));
	return called;
}

/** The name of the function `node` is in: declared, or an arrow or function given to a name. */
function enclosingName(node: ts.Node): string {
	for (let at = node.parent; at; at = at.parent) {
		if (ts.isFunctionDeclaration(at) && at.name) return at.name.text;
		if (ts.isVariableDeclaration(at) && at.initializer && (ts.isArrowFunction(at.initializer) || ts.isFunctionExpression(at.initializer))) {
			return at.name.getText();
		}
	}
	return '(top)';
}

/**
 * The helpers that are handed a request to send and read its answer
 * themselves; the board state's writes among them, which put back the change
 * on a refusal and give back the server's words (card 2280, slice B2b).
 */
const READ_BY = ['sent', 'deleteFailure', 'api.deleteFailure', 'boardState.write', 'boardState.writeCard', 'boardState.writeColumn'];

/** Whether the variable `name`, declared by `declared`, is read anywhere in the function it is declared in. */
function isRead(declared: ts.VariableDeclaration): boolean {
	const name = declared.name.getText();
	const scope = ts.findAncestor(declared, (node) => ts.isFunctionLike(node) || ts.isSourceFile(node)) ?? declared.getSourceFile();
	let read = false;
	const visit = (node: ts.Node) => {
		if (ts.isIdentifier(node) && node !== declared.name && node.text === name) read = true;
		if (!read) ts.forEachChild(node, visit);
	};
	visit(scope);
	return read;
}

/**
 * Whether the answer to the request `call` sends is thrown away. It is when
 * the request is, awaited or not:
 *
 *   - a statement and nothing more: `fetch(...)`, `await fetch(...)`;
 *   - after `void`;
 *   - followed by `.then` or `.catch`, which a page has used to swallow it;
 *   - the body of an arrow written without braces, `() => fetch(...)`, that
 *     is not handed to a helper that reads the answer (`sent`,
 *     `deleteFailure`): an event handler, or a `.map` for `Promise.all`;
 *   - kept as a variable that is never read: `const res = await fetch(...)`.
 */
function thrownAway(call: ts.CallExpression): boolean {
	let at: ts.Node = call;
	while (ts.isAwaitExpression(at.parent) || ts.isParenthesizedExpression(at.parent)) at = at.parent;
	const parent = at.parent;
	if (ts.isExpressionStatement(parent) || ts.isVoidExpression(parent)) return true;
	if (ts.isPropertyAccessExpression(parent) && parent.expression === at && ['then', 'catch'].includes(parent.name.text)) return true;
	if (ts.isArrowFunction(parent) && parent.body === at) {
		const handedTo = ts.isCallExpression(parent.parent) && parent.parent.arguments.includes(parent) ? parent.parent.expression.getText() : null;
		return !READ_BY.includes(handedTo ?? '');
	}
	if (ts.isVariableDeclaration(parent) && parent.initializer === at && ts.isIdentifier(parent.name)) return !isRead(parent);
	return false;
}

/**
 * The code of a file, parsed: a module whole, and a `.svelte` file in every
 * `<script>` and in every `on...={...}` of its markup. `where` names an event
 * handler of the markup, `markup onclick`, and is absent for a script.
 */
function codeOf(file: string, source: string): { tree: ts.SourceFile; where?: string }[] {
	const parse = (code: string) => ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
	if (!file.endsWith('.svelte')) return [{ tree: parse(source) }];
	const found: { tree: ts.SourceFile; where?: string }[] = [];
	for (const script of source.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) found.push({ tree: parse(script[1]) });
	const markup = source.replace(/<script[^>]*>[\s\S]*?<\/script>|<style[^>]*>[\s\S]*?<\/style>/g, '');
	for (const handler of markup.matchAll(/\b(on\w+)=\{/g)) {
		const open = handler.index! + handler[0].length - 1;
		let depth = 0;
		let end = open;
		for (; end < markup.length; end++) {
			if (markup[end] === '{') depth++;
			else if (markup[end] === '}' && --depth === 0) break;
		}
		found.push({ tree: parse(`(${markup.slice(open + 1, end)});`), where: `markup ${handler[1]}` });
	}
	return found;
}

/**
 * Every write in a file whose answer is thrown away (`thrownAway`): `fetch`
 * with a method that writes, `api.<write>(...)`, or a function that hands
 * back a write's answer (`handingBack`). Each as `file › where › what`,
 * `where` being the function it is in, or `markup onclick` for an event
 * handler written in a Svelte file's markup.
 */
function discardedIn(file: string, source: string, writes: string[]): string[] {
	const found: string[] = [];
	const handBack = handingBack(file, source, writes);
	for (const { tree, where } of codeOf(file, source)) {
		const visit = (node: ts.Node) => {
			if (ts.isCallExpression(node)) {
				const what = writeOf(node, writes, handBack);
				if (what && thrownAway(node)) found.push(`${file} › ${where ?? enclosingName(node)} › ${what}`);
			}
			ts.forEachChild(node, visit);
		};
		visit(tree);
	}
	return found;
}

/** Every file under `dir` whose name ends with `ending`, as a path from the repository. */
const filesUnder = (dir: string, ending: string) =>
	(readdirSync(join(ROOT, dir), { recursive: true }) as string[])
		.map((file) => `${dir}/${file.split('\\').join('/')}`)
		.filter((file) => file.endsWith(ending));

/** What a write of one of the pages must do with its answer. */
type Write = {
	/** The function, by its name at the top of the page's script. */
	name: string;
	/**
	 * How a refusal is read and put into words. `write`: through the board
	 * state's `write`, `writeCard` or `writeColumn`, which shows the change at
	 * once and puts it back for a refusal or no answer, and gives back the
	 * words, which the page says (card 2280, slice B2b).
	 */
	reads?: 'failureMessage' | 'deleteFailure' | 'sent' | 'write';
	/** It sends through another function of the page, which is in the table. */
	via?: string;
	/** What puts back what was changed before the answer came: each only for a failure. */
	putsBack?: string[];
	/** What says it was done, or acts as if it was: each only for a success. */
	done?: string[];
};

/**
 * Every write in the seven files of card 2109, in the label picker of card
 * 2010, and in the four files of card 2148; for the board page, the three it
 * names, card 2134's column rename and the writes of card 2280's slice B2b.
 */
const WRITES: Record<string, Write[]> = {
	'src/routes/board/[id]/+page.svelte': [
		{ name: 'restoreCard', reads: 'deleteFailure', done: ['archivedCards = archivedCards.filter(c => c.id !== cardId)', "toasts.add('Card restored')"] },
		// Sent, read, and the card taken off the board as answered, by the card
		// window's controller (card 2280, slice B2c; its cases are in
		// `tests/card-window.test.ts`), which gives back what to say.
		{ name: 'confirmDeleteCard', via: 'cardWindow.archive', done: ["toasts.add('Card archived. Restore it from Archived Cards.', 'info')"] },
		// Card 2139: it said "Board linked as sub-board" whatever the answer, and nothing was saved.
		{ name: 'linkSubBoard', reads: 'failureMessage', done: ['await boardState.refreshNow()', "toasts.add('Board linked as sub-board')"] },
		// Card 2134: a rename that would change whether the column is a Complete
		// column is refused while it holds cards, and the page showed the new title.
		{ name: 'finishEditColumn', reads: 'failureMessage', done: ['col.title = title'] },
		// Card 2280, slice B2b: the 21 writes whose answer was thrown away (the
		// 20 left for card 2012, less the two with no caller, and the column's
		// colour, WIP limit and Show Add Task, sent through the page's own
		// `updateColumn`), in 18 functions: `saveCard` sent three of them (a
		// card's update, a new card's subtasks and assignees), which the card
		// window's controller sends now (slice B2c), and `confirmOnHold` two (the
		// move and the note). Each is shown at once where it changes the board,
		// put back for a refusal or no answer, and said.
		{ name: 'saveInlineEdit', reads: 'write', done: ["toasts.add('Title updated')"] },
		{ name: 'cyclePriority', reads: 'write' },
		{ name: 'setPriorityFromMenu', reads: 'write', done: ['toasts.add(`Priority → ${priority}`)'] },
		// "Moved to X" only once the move was taken (decision 18).
		{ name: 'moveFromMenu', reads: 'write', done: ['toasts.add(`Moved to ${col.title}`)'] },
		{ name: 'togglePin', reads: 'write', done: ['toasts.add(pinned ? `Pinned "${card.title}"` : `Unpinned "${card.title}"`)'] },
		// A refusal keeps the prompt, with what was typed.
		{ name: 'saveCompletionPrompt', reads: 'write' },
		{ name: 'addCategory', reads: 'write', done: ['boardState.categories = [...boardState.categories, made]'] },
		{ name: 'deleteCategory', reads: 'write', done: ['boardState.categories = boardState.categories.filter((c) => c.id !== id)'] },
		{ name: 'saveBoardName', reads: 'write', putsBack: ['boardState.board = { ...boardState.board, name: was }'] },
		{ name: 'saveBoardEmoji', reads: 'write', putsBack: ['boardState.board = { ...boardState.board, emoji: was }'] },
		{ name: 'addColumn', reads: 'write', done: ['boardState.columns = insertColumn(boardState.columns, { ...made, cards: [] }).columns', 'showAddColumnModal = false'] },
		{ name: 'saveWipLimit', reads: 'write', done: ["toasts.add(limit > 0 ? `WIP limit set to ${limit}` : 'WIP limit removed')"] },
		{ name: 'setColumnColor', reads: 'write' },
		{ name: 'toggleShowAddCard', reads: 'write' },
		{ name: 'handleColumnDndFinalize', reads: 'write' },
		// Each card the server refused is put back by the board state and stays selected.
		{ name: 'handleBulkPriority', via: 'bulkOps.bulkPriority', putsBack: ['selectedCards = new Set(failed.map((f) => f.cardId))'], done: ['clearSelection()'] },
		// The move first, the note only once it is taken (R7).
		{ name: 'confirmOnHold', via: 'dndHandlers.confirmOnHold', putsBack: ['putBackOnHold()'], done: ['boardState.columns = moveCards(boardState.columns, onHoldState.pendingUpdates).columns'] },
		// A refused update keeps the window open with what was typed; each subtask, assignee, label or sub-board of a new card refused is named
		// (the card window's controller, slice B2c: it sends only the fields changed since the window opened, and gives back what to say).
		{ name: 'saveCard', via: 'cardWindow.save', done: ['toasts.add(message)'] }
	],
	'src/routes/archived/+page.svelte': [
		{ name: 'restoreCard', reads: 'deleteFailure', done: ["toasts.add('Card restored')", 'await invalidateAll()'] },
		{ name: 'permanentlyDeleteCard', reads: 'deleteFailure', done: ['await invalidateAll()'] },
		{ name: 'purgeAll', reads: 'failureMessage', done: ['await invalidateAll()'] }
	],
	// All Tasks: the page keeps the card window's save and archive, and each
	// other write moved to the component that sends it (card 2281, slice C3a-2).
	'src/routes/all/+page.svelte': [
		// The card window's save and archive, sent, read and put back by its
		// controller (card 2281, slice C3a-1; `tests/page-card-window.test.ts`),
		// which gives back what to say.
		{ name: 'saveFromWindow', via: 'cardWindow.save', done: ['toasts.add(message)', 'await invalidateAll()'] },
		{ name: 'archiveFromWindow', via: 'cardWindow.archive', done: ["toasts.add('Card archived. Restore it from Archived Cards.', 'info')", 'await invalidateAll()'] }
	],
	'src/lib/components/tasks/MoveCardModal.svelte': [
		// The review's O3: a move to another board that took the card out of its milestone says so.
		{ name: 'doMoveCard', reads: 'failureMessage', done: ['showMoveModal = false', 'playMoveSound()', 'playCompleteSound()', "toasts.add(leftGoal, 'info')"] }
	],
	'src/lib/components/tasks/TasksArchivePanel.svelte': [
		{ name: 'restoreArchivedCard', reads: 'deleteFailure', done: ['archivedCards = archivedCards.filter(c => c.id !== cardId)', "toasts.add('Card restored')"] },
		{ name: 'permanentlyDeleteArchivedCard', reads: 'deleteFailure', done: ['archivedCards = archivedCards.filter(c => c.id !== cardId)'] }
	],
	// Card 2240: All To Do opens the card window as All Tasks does, with no
	// Move window; through the same controller since card 2281's slice C3a-1,
	// so it sends no write of its own (NO_WRITE_OF_ITS_OWN).
	'src/routes/todo/+page.svelte': [
		{ name: 'saveFromWindow', via: 'cardWindow.save', done: ['toasts.add(message)', 'await invalidateAll()'] },
		{ name: 'archiveFromWindow', via: 'cardWindow.archive', done: ["toasts.add('Card archived. Restore it from Archived Cards.', 'info')", 'await invalidateAll()'] }
	],
	'src/routes/teams/+page.svelte': [
		{ name: 'createTeam', reads: 'failureMessage', done: ['showCreateTeam = false', "showToast('Team created')"] },
		{ name: 'deleteTeam', reads: 'deleteFailure', done: ["showToast('Team deleted')"] },
		// Its toast is worded from the answer's action since the card 2374 review.
		{ name: 'addTeamMember', reads: 'failureMessage', done: ['addMemberUserId = null', 'await invalidateAll()'] },
		// Card 2355: a member's role changed in place, the picker put back for a refusal from the data as it is then (the card 2355 review).
		// Card 2376: Change saves the role chosen; a failure forgets it, so the picker shows the stored role.
		{ name: 'changeRole', reads: 'failureMessage', putsBack: ['putBack()'], done: ['await invalidateAll()'] },
		{ name: 'removeTeamMember', reads: 'deleteFailure', done: ["showToast('Member removed')"] }
	],
	// The admin page's backup half, in components of its own (card 2281, slice C1a).
	'src/lib/components/admin/AppUrlPanel.svelte': [{ name: 'saveAppUrl', reads: 'sent', done: ["showToast('App URL saved')"] }],
	// Its one write, the import, is held by the tests of its own above.
	'src/lib/components/admin/BackupRestorePanel.svelte': [],
	'src/lib/components/admin/GDriveConnectModal.svelte': [{ name: 'exchangeGDriveCode', reads: 'sent', done: ['await loadBackupConfig()'] }],
	'src/lib/components/admin/ScheduledBackupsPanel.svelte': [
		{ name: 'saveBackupConfig', reads: 'sent', done: ["showToast('Backup settings saved')"] },
		// The card 2250 review's M3 and S3: once saved, the list is read again
		// from the server, so that it holds the masked secrets and not one typed,
		// and the destination's host key box is forgotten.
		{
			name: 'addDestination',
			via: 'saveBackupConfig',
			putsBack: ['backupDestinations = was'],
			done: ['resetDestForm()', 'showAddDestination = false', 'forgetHostKeyCheck(added.name)']
		},
		{
			name: 'updateDestination',
			via: 'saveBackupConfig',
			putsBack: ['backupDestinations = was'],
			// By the name the form edited when the save went (the card 2305 review).
			done: ['editingDest = null', 'resetDestForm()', 'forgetHostKeyCheck(editing)']
		},
		{ name: 'removeDestination', via: 'saveBackupConfig', putsBack: ['backupDestinations = was'], done: ['forgetHostKeyCheck(name)'] },
		{ name: 'testDestination', reads: 'sent' },
		// Card 2250: Confirm saves the host key a Test showed, and only once it is saved tests again.
		{
			name: 'confirmHostKey',
			via: 'saveBackupConfig',
			putsBack: ['backupDestinations = was'],
			done: ['await testDestination(backupDestinations.find(d => d.name === name) ?? updated[idx])']
		},
		{ name: 'runManualBackup', reads: 'sent', done: ['await loadBackupConfig()'] }
	],
	// The rest of the admin page, each section in a component of its own (card
	// 2281, slice C1b): the page itself sends no write now.
	'src/lib/components/admin/BoardManagementPanel.svelte': [
		{ name: 'deleteBoard', reads: 'sent', done: ["showToast('Board deleted')"] },
		{ name: 'clearBoardCards', reads: 'sent', done: ["showToast('All cards cleared from board')"] },
		{ name: 'clearBoardCategories', reads: 'sent', done: ["showToast('All categories cleared from board')"] }
	],
	'src/lib/components/admin/DangerZonePanel.svelte': [
		{ name: 'resetDatabase', reads: 'failureMessage', done: ['window.location.href = redirect'] },
		{ name: 'vacuumDatabase', reads: 'sent', done: ["showToast('Database vacuumed. Unused space was reclaimed.')"] },
		{ name: 'resetAllXp', reads: 'sent', done: ["showToast('All XP has been reset to 0')"] },
		{ name: 'purgeArchivedCards', reads: 'sent', done: ['await invalidateAll()'] }
	],
	'src/lib/components/admin/UsersPanel.svelte': [
		{ name: 'createUser', reads: 'sent', done: ['showCreateUser = false'] },
		{ name: 'changeUserRole', reads: 'failureMessage', putsBack: ['putBack()'], done: ['await invalidateAll()'] },
		{ name: 'deleteUser', reads: 'sent', done: ["showToast('User deleted')"] },
		{ name: 'resendInvite', reads: 'sent' }
	],
	'src/lib/components/admin/ResetPasswordDialog.svelte': [
		{ name: 'resetPassword', reads: 'failureMessage', done: ['resetPasswordUserId = null'] }
	],
	'src/lib/components/admin/TeamsPanel.svelte': [
		{ name: 'createTeam', reads: 'sent', done: ['showCreateTeam = false', "showToast('Team created')"] },
		{ name: 'deleteTeam', reads: 'sent', done: ["showToast('Team deleted')"] },
		// Its toast is worded from the answer's action since the card 2374 review.
		{ name: 'addTeamMember', reads: 'sent', done: ['addMemberUserId = null', 'await invalidateAll()'] },
		{ name: 'changeRole', reads: 'sent', putsBack: ['putBack()'], done: ['await invalidateAll()'] },
		{ name: 'removeTeamMember', reads: 'sent', done: ["showToast('Member removed')"] }
	],
	'src/lib/components/admin/SmtpPanel.svelte': [
		{ name: 'saveSmtp', reads: 'failureMessage', done: ["smtpMessage = 'SMTP settings saved!'"] },
		{ name: 'testSmtp', reads: 'failureMessage' }
	],
	'src/routes/reports/+page.svelte': [
		{ name: 'generateReport', reads: 'failureMessage' },
		{ name: 'sendReportEmail', reads: 'failureMessage' },
		{ name: 'createSchedule', reads: 'failureMessage', done: ['showNewSchedule = false', "schedName = ''", 'await invalidateAll()'] },
		{ name: 'toggleSchedule', reads: 'failureMessage', done: ['await invalidateAll()'] },
		// Card 2159: a schedule's time read in the viewer's zone from now on.
		{ name: 'useMyTimeZone', reads: 'failureMessage', done: ['await invalidateAll()'] },
		{ name: 'deleteSchedule', reads: 'deleteFailure', done: ['await invalidateAll()'] }
	],
	// The card window's fifteen writes, each in the section that holds it
	// since card 2280's slice B4 (from CardModal.svelte, as they were).
	'src/lib/components/CardModal.svelte': [
		// A label is put on and taken off by the label picker, below (card 2010).
		{ name: 'createCategoryInline', reads: 'failureMessage', done: ['showNewCategory = false'] }
	],
	'src/lib/components/card/CardCoverPicker.svelte': [
		{ name: 'setCover', reads: 'failureMessage', putsBack: ['coverUrl = was'] },
		{ name: 'clearCover', via: 'setCover' }
	],
	'src/lib/components/card/CardMetaChips.svelte': [
		{ name: 'assignUser', reads: 'failureMessage' },
		{ name: 'unassignUser', reads: 'deleteFailure' }
	],
	'src/lib/components/card/CardTemplates.svelte': [
		{ name: 'saveAsTemplate', reads: 'failureMessage', done: ['showSaveTemplate = false', "templateName = ''"] },
		{ name: 'deleteTemplate', reads: 'deleteFailure', done: ['templates = templates.filter(t => t.id !== id)'] }
	],
	'src/lib/components/card/CardSubtasks.svelte': [
		{ name: 'toggleSubtask', reads: 'failureMessage', done: ['subtask.completed = !subtask.completed'] }
	],
	'src/lib/components/card/CardDependencies.svelte': [
		{ name: 'addDependency', reads: 'failureMessage', done: ['pickerMode = null'] },
		// Its refusal reads the links again, held in the dependency list's own case above: so
		// does a success whose body is not the lists (card 2379's review), so it is no putsBack.
		{ name: 'removeDependency', reads: 'failureMessage', done: ['blocks = data.blocks'] },
		{ name: 'saveMilestone', reads: 'failureMessage', putsBack: ['putBack()'], done: ['milestoneId = next'] }
	],
	'src/lib/components/card/CardComments.svelte': [
		// Card 2342: the box is emptied as the post goes, and a refusal puts the text back.
		{ name: 'postComment', reads: 'failureMessage', putsBack: ['putBack(text)'], done: ['comments = [created, ...comments.filter(c => c.id !== created.id)]'] },
		{ name: 'deleteComment', reads: 'deleteFailure', done: ['comments = comments.filter(c => c.id !== commentId)'] },
		{ name: 'saveEditComment', reads: 'failureMessage', done: ['editingCommentId = null'] }
	],
	'src/lib/components/card/CardAttachments.svelte': [
		{ name: 'deleteAttachment', reads: 'deleteFailure', putsBack: ['await loadAttachments()'], done: ['attachments = attachments.filter(a => a.id !== id)'] }
	],
	// Card 2010: the card window's Labels section. The chip changes only once
	// the server has changed it, as the window's own toggle did (card 2109),
	// and to what the server says it is now (`toggled`), not to the opposite of
	// what the window believed; a label made is offered and put on the card,
	// and one changed or deleted is shown so, only once the server has said yes.
	'src/lib/components/LabelPicker.svelte': [
		{ name: 'toggleLabel', reads: 'failureMessage', done: ['selected = toggled ? [...others, labelId] : others'] },
		{
			name: 'createLabel',
			reads: 'failureMessage',
			done: ['list = [...list.filter((label) => label.id !== made.id), made]', 'showNew = false', 'await toggleLabel(made.id)']
		},
		{ name: 'saveLabel', reads: 'failureMessage', done: ['list = list.map((label) => (label.id === changed.id ? changed : label))', 'editingId = null'] },
		{
			name: 'deleteLabel',
			reads: 'deleteFailure',
			done: ['list = list.filter((label) => label.id !== id)', 'selected = selected.filter((labelId) => labelId !== id)', 'editingId = null']
		}
	],
	// Card 2148: the share window, the subtask window, the dashboard and the
	// account page. A write that was refused looked saved, or said nothing, and
	// what it had changed on the page stayed changed. Each now says why where
	// the reader is looking (its decision 11, held below), and puts back what
	// it changed first (decision 12).
	'src/lib/components/ShareModal.svelte': [
		{ name: 'togglePublic', reads: 'failureMessage', done: ['isPublic = !isPublic'] },
		{ name: 'shareWithUser', reads: 'failureMessage', done: ['selectedUserId = null', 'await loadData()'] },
		{ name: 'shareWithTeam', reads: 'failureMessage', done: ['selectedTeamId = null', 'await loadData()'] },
		{ name: 'updateRole', reads: 'failureMessage', putsBack: ['putBack()'], done: ['await loadData()'] },
		{ name: 'removeAccess', reads: 'deleteFailure', done: ['await loadData()'] }
	],
	'src/lib/components/SubtaskModal.svelte': [
		{ name: 'save', reads: 'failureMessage', done: ['onSave(updated)', 'onSave(created)'] },
		// Its `onDelete()` is held below: a subtask of a card not yet made goes with no request.
		{ name: 'handleDelete', reads: 'deleteFailure' }
	],
	// The dashboard: the page keeps the board's delete, and each other write
	// moved to the component that sends it (card 2281, slice C2).
	'src/routes/+page.svelte': [
		{ name: 'deleteBoard', reads: 'deleteFailure', done: ['await invalidateAll()'] }
	],
	'src/lib/components/dashboard/CreateBoardModal.svelte': [
		{ name: 'createBoard', reads: 'failureMessage', done: ['showCreate = false', 'goto(`/board/${board.id}`)'] }
	],
	'src/lib/components/dashboard/BoardsTable.svelte': [
		{
			name: 'toggleFavourite',
			reads: 'failureMessage',
			putsBack: ['showStar(boardId, was)'],
			done: ['showStar(boardId, (await res.json()).favourited === true)']
		}
	],
	'src/lib/components/dashboard/BoardContextMenu.svelte': [
		{ name: 'createSubBoardInline', reads: 'failureMessage', done: ['closeBoardContextMenu()', 'await invalidateAll()'] },
		{ name: 'setBoardCategory', reads: 'failureMessage', done: ['await invalidateAll()'] },
		{ name: 'createBoardCategoryInline', reads: 'failureMessage', done: ['await setBoardCategory(boardCtx.boardId, created.id)', 'showNewBoardCat = false'] }
	],
	'src/routes/account/+page.svelte': [
		{ name: 'changeEmoji', reads: 'failureMessage', putsBack: ['currentEmoji = was'], done: ['await invalidateAll()'] },
		{ name: 'changeEmail', reads: 'failureMessage', done: ["emailMessage = 'Email updated successfully!'", 'displayedEmail = result.email'] },
		{ name: 'changePassword', reads: 'failureMessage', done: ['await loadApiKeys()'] },
		{ name: 'generateApiKey', reads: 'failureMessage', done: ['newlyCreatedKey = result.key', 'await loadApiKeys()'] },
		{ name: 'revokeKey', reads: 'failureMessage', done: ['apiKeys = apiKeys.filter(k => k.id !== id)'] },
		{ name: 'toggleNotif', reads: 'failureMessage', putsBack: ['notifPrefs = was'], done: ['notifPrefs = await res.json()'] }
	]
};

/** Writes in the files above that have tests of their own above, by file. */
const TESTED_ABOVE: Record<string, string[]> = {
	'src/lib/components/admin/BackupRestorePanel.svelte': ['handleFileSelected'],
	'src/lib/components/card/CardAttachments.svelte': ['uploadFile']
};

/**
 * Files above whose every write goes through a module, so that none sends one
 * itself; All Tasks since card 2281's slice C3a-2, whose Move window and
 * Archived Cards send theirs from components of their own.
 */
const NO_WRITE_OF_ITS_OWN = ['src/routes/todo/+page.svelte', 'src/routes/all/+page.svelte'];

describe('every write of the seven pages of card 2109, of the label picker, and of the four screens of card 2148, says when it was refused', () => {
	const writes = apiWrites();

	it.each(Object.keys(WRITES).filter((file) => !file.startsWith('src/routes/board/')))(
		'%s: every function that sends a write is in the table',
		(file) => {
			const sending = scriptOf(file)
				.statements.filter((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && !!statement.name)
				.filter((fn) => {
					let sends = false;
					const visit = (node: ts.Node) => {
						if (ts.isCallExpression(node) && writeOf(node, writes)) sends = true;
						ts.forEachChild(node, visit);
					};
					visit(fn);
					return sends;
				})
				.map((fn) => fn.name!.text);
			const named = [...WRITES[file].map((write) => write.name), ...(TESTED_ABOVE[file] ?? [])];

			if (NO_WRITE_OF_ITS_OWN.includes(file)) expect(sending).toEqual([]);
			else expect(sending.length).toBeGreaterThan(0);
			expect(sending.filter((name) => !named.includes(name))).toEqual([]);
		}
	);

	// Card 2280, slice B4: the card window's writes are in its sections, each
	// a file of the table above. One that sent a write and was not would be
	// held to nothing.
	it('has every section of the card window that sends a write, src/lib/components/card/', () => {
		const sends = (file: string) =>
			scriptOf(file).statements.some((statement) => {
				let found = false;
				const visit = (node: ts.Node) => {
					if (ts.isCallExpression(node) && writeOf(node, writes)) found = true;
					ts.forEachChild(node, visit);
				};
				visit(statement);
				return found;
			});
		const sending = filesUnder('src/lib/components/card', '.svelte').filter(sends);
		expect(sending.length).toBeGreaterThan(0);
		expect(sending.filter((file) => !(file in WRITES))).toEqual([]);
	});

	// Card 2281, slice C1a: the same for the admin page's components.
	it('has every component of the admin page that sends a write, src/lib/components/admin/', () => {
		const sends = (file: string) =>
			scriptOf(file).statements.some((statement) => {
				let found = false;
				const visit = (node: ts.Node) => {
					if (ts.isCallExpression(node) && writeOf(node, writes)) found = true;
					ts.forEachChild(node, visit);
				};
				visit(statement);
				return found;
			});
		const sending = adminComponents().filter(sends);
		expect(sending.length).toBeGreaterThan(0);
		expect(sending.filter((file) => !(file in WRITES))).toEqual([]);
	});

	// Card 2281, slice C2: the same for the dashboard's components.
	it('has every component of the dashboard that sends a write, src/lib/components/dashboard/', () => {
		const sends = (file: string) =>
			scriptOf(file).statements.some((statement) => {
				let found = false;
				const visit = (node: ts.Node) => {
					if (ts.isCallExpression(node) && writeOf(node, writes)) found = true;
					ts.forEachChild(node, visit);
				};
				visit(statement);
				return found;
			});
		const sending = filesUnder('src/lib/components/dashboard', '.svelte').filter(sends);
		expect(sending.length).toBeGreaterThan(0);
		expect(sending.filter((file) => !(file in WRITES))).toEqual([]);
	});

	// Card 2281, slice C3a-2: the same for All Tasks' components.
	it('has every component of All Tasks that sends a write, src/lib/components/tasks/', () => {
		const sends = (file: string) =>
			scriptOf(file).statements.some((statement) => {
				let found = false;
				const visit = (node: ts.Node) => {
					if (ts.isCallExpression(node) && writeOf(node, writes)) found = true;
					ts.forEachChild(node, visit);
				};
				visit(statement);
				return found;
			});
		const sending = tasksComponents().filter(sends);
		expect(sending.length).toBeGreaterThan(0);
		expect(sending.filter((file) => !(file in WRITES))).toEqual([]);
	});

	// Card 2281, slice C3a-3: the plan page's components send none of their
	// own. Every change to the goal goes through the page's one PATCH path,
	// `mutate`, which they are handed. One that sent a write would be held to
	// nothing here: it would go in the table above, and this case would say so.
	it('has no component of the plan page that sends a write of its own, src/lib/components/plan/', () => {
		const sends = (file: string) =>
			scriptOf(file).statements.some((statement) => {
				let found = false;
				const visit = (node: ts.Node) => {
					if (ts.isCallExpression(node) && writeOf(node, writes)) found = true;
					ts.forEachChild(node, visit);
				};
				visit(statement);
				return found;
			});
		expect(planComponents().length).toBeGreaterThanOrEqual(7);
		expect(planComponents().filter(sends)).toEqual([]);
		// The page's `mutate` is the one, handed to the header, the card picker and the work table.
		expect(scriptOf('src/routes/plan/[id]/+page.svelte').getText()).toContain("method: 'PATCH'");
		const page = readFileSync(join(ROOT, 'src/routes/plan/[id]/+page.svelte'), 'utf8');
		for (const name of ['PlanHeader', 'PlanCardPicker', 'WorkTable']) expect(page).toMatch(new RegExp(`<${name} [^>]*\\{mutate\\}`));
	});

	const cases = Object.entries(WRITES).flatMap(([file, list]) => list.map((write) => [`${file} ${write.name}`, file, write] as const));

	it.each(cases)('%s says what the server said, and changes the page only for a success', (_, file, write) => {
		const fn = functionNamed(scriptOf(file), write.name);

		if (write.reads === 'failureMessage') {
			const asked = [...callsOf(fn, 'failureMessage'), ...callsOf(fn, 'api.failureMessage')];
			expect(asked.length).toBeGreaterThan(0);
			expect(asked.map(sideOf)).toEqual(asked.map(() => 'failed'));
		}
		if (write.reads === 'deleteFailure') {
			const asked = [...callsOf(fn, 'deleteFailure'), ...callsOf(fn, 'api.deleteFailure')];
			expect(asked).toHaveLength(1);
			// Kept as `failure`, and what is said when there is one.
			const kept = asked[0].parent.parent;
			expect(ts.isVariableDeclaration(kept) && kept.name.getText()).toBe('failure');
			const ifFailure: ts.IfStatement[] = [];
			const visit = (node: ts.Node) => {
				if (ts.isIfStatement(node) && node.expression.getText() === 'failure') ifFailure.push(node);
				ts.forEachChild(node, visit);
			};
			visit(fn);
			expect(ifFailure).toHaveLength(1);
			expect(ifFailure[0].thenStatement.getText()).toMatch(/\(failure[,)]|= failure;/);
		}
		if (write.reads === 'sent') expect(callsOf(fn, 'sent')).toHaveLength(1);
		if (write.reads === 'write') {
			const through = ['boardState.write', 'boardState.writeCard', 'boardState.writeColumn'].flatMap((callee) => callsOf(fn, callee));
			expect(through).toHaveLength(1);
			// Its words said for a refusal or no answer, and only then, in the shared toast.
			const said = callsOf(fn, 'toasts.add').filter((call) => call.arguments[0]?.getText() === 'written.failure');
			expect(said.length).toBeGreaterThan(0);
			expect(said.map(sideOf)).toEqual(said.map(() => 'failed'));
			expect(said.map((call) => call.arguments.slice(1).map((argument) => argument.getText()))).toEqual(said.map(() => ["'error'", 'started']));
		}
		if (write.via) expect(callsOf(fn, write.via)).toHaveLength(1);

		// No answer is read as JSON unless it is a success.
		expect(callsOf(fn, 'res.json').map(sideOf).filter((side) => side !== 'ok')).toEqual([]);
		for (const text of write.putsBack ?? []) {
			const found = statementsOf(fn, text);
			expect(found.length, text).toBeGreaterThan(0);
			expect(found.map(sideOf), text).toEqual(found.map(() => 'failed'));
			// For a refusal, and not only for a request that got no answer.
			const inCatch = (node: ts.Node) => ts.findAncestor(node, ts.isCatchClause) !== undefined;
			expect(found.some((statement) => !inCatch(statement)), text).toBe(true);
		}
		for (const text of write.done ?? []) {
			const found = statementsOf(fn, text);
			expect(found.length, text).toBeGreaterThan(0);
			expect(found.map(sideOf), text).toEqual(found.map(() => 'ok'));
		}
	});

	it('leaves no request whose failure goes unsaid: each is asked in a try whose catch says so, or through a helper that does', () => {
		// A request that gets no answer throws. Where a page calls `fetch` itself
		// for one of these writes, it does so in a `try` with a `catch`; the
		// helpers (`deleteFailure`, `sent`) have their own.
		for (const [file, list] of Object.entries(WRITES)) {
			const tree = scriptOf(file);
			for (const write of list) {
				const fn = functionNamed(tree, write.name);
				for (const call of callsOf(fn, 'fetch')) {
					let caught = false;
					let helped = false;
					for (let at: ts.Node | undefined = call; at && at !== fn; at = at.parent) {
						if (ts.isTryStatement(at.parent) && at.parent.tryBlock === at && at.parent.catchClause) caught = true;
						if (ts.isCallExpression(at) && ['sent', 'deleteFailure', 'api.deleteFailure'].includes(at.expression.getText())) helped = true;
					}
					expect(caught || helped, `${file} ${write.name}`).toBe(true);
				}
			}
		}
	});
});

describe('no page throws away the answer to a write', () => {
	// The list of writes left for a card of their own is gone. Card 2148 took
	// six off it (sharing a board, deleting a subtask from its window, the
	// dashboard's favourite and category, the account page's emoji and mail
	// settings), card 2115's review the share window's `updateRole`, card 2208
	// the drop's request to clear the on-hold note, card 2209 the bulk move's.
	// Card 2280 (slice B2b of card 2012's part B) took the last twenty: the
	// board page's, and those of the modules in src/lib/board it sends them
	// through, each now read through the board state (the table of writes
	// above). Two of them, `addCategory` and `deleteCategory` of
	// `board-actions.ts`, had no caller and went.
	it('finds none', () => {
		const writes = apiWrites();
		// With the admin page's modules (card 2281, slice C1a) and the dashboard's (slice C2).
		const files = [
			...filesUnder('src/routes', '.svelte'),
			...filesUnder('src/lib/components', '.svelte'),
			...filesUnder('src/lib/board', '.ts'),
			...filesUnder('src/lib/admin', '.ts'),
			...filesUnder('src/lib/dashboard', '.ts')
		];
		const found = files.flatMap((file) => discardedIn(file, readFileSync(join(ROOT, file), 'utf8'), writes));

		expect(found.sort()).toEqual([]);
	});

	// Card 2280, slice B2b: the board page sent its column's colour, WIP limit
	// and Show Add Task through its own `updateColumn`, which awaited
	// `boardActions.updateColumn` and dropped the answer. The list did not see
	// them: neither call was a write of `$lib/api.ts`.
	it('follows a page’s own wrapper of a write, and a module function that hands back a write’s answer', () => {
		const page = [
			'<script lang="ts">',
			"\timport * as api from '$lib/api';",
			"\timport * as boardActions from '$lib/board/board-actions';",
			'\tasync function updateColumn(colId: number, updates: Record<string, unknown>) {',
			'\t\tawait boardActions.updateColumn(colId, updates, 1);',
			'\t}',
			'\tfunction send(cardId: number) {',
			'\t\treturn api.updateCard(cardId, {});',
			'\t}',
			'\tasync function rename(cardId: number) {',
			'\t\tawait send(cardId);',
			'\t}',
			'\tasync function renameRead(cardId: number) {',
			'\t\tconst res = await send(cardId);',
			'\t\treturn res.ok;',
			'\t}',
			'</script>',
			'<button onclick={() => send(3)}>x</button>',
			'<button onclick={() => updateColumn(3, {})}>y</button>'
		].join('\n');

		expect(discardedIn('src/routes/x/+page.svelte', page, apiWrites()).sort()).toEqual([
			'src/routes/x/+page.svelte › markup onclick › send',
			'src/routes/x/+page.svelte › rename › send',
			'src/routes/x/+page.svelte › updateColumn › boardActions.updateColumn'
		]);
	});

	it('knows the writes of $lib/api.ts, and no read among them', () => {
		const writes = apiWrites();

		expect(writes).toEqual(expect.arrayContaining(['createCard', 'updateCard', 'deleteCard', 'reorderCards', 'deleteBoardApi', 'toggleLabel']));
		expect(writes).not.toContain('loadActivities');
		expect(writes).not.toContain('fetchXp');
		expect(writes).not.toContain('deleteFailure');
	});
});

describe('the toast, src/lib/stores/toast.ts and src/lib/components/Toast.svelte', () => {
	afterEach(() => {
		vi.useRealTimers();
		for (const shown of get(toasts)) toasts.dismiss(shown.id);
	});

	const shown = () => get(toasts).map((toast) => `${toast.type}: ${toast.message}`);

	it('keeps a failure until it is closed, and lets anything else go after three seconds', () => {
		vi.useFakeTimers();
		toasts.add('Saved');
		toasts.add('No edit access to this board', 'error');
		toasts.add('Card archived', 'info');
		toasts.add('Over the WIP limit', 'warning');

		vi.advanceTimersByTime(TOAST_MS - 1);
		expect(shown()).toHaveLength(4);
		vi.advanceTimersByTime(1);
		expect(shown()).toEqual(['error: No edit access to this board']);
		expect(TOAST_MS).toBe(3000);

		// Ten minutes on, it is still there: it waits to be closed.
		vi.advanceTimersByTime(10 * 60_000);
		expect(shown()).toEqual(['error: No edit access to this board']);
		toasts.dismiss(get(toasts)[0].id);
		expect(shown()).toEqual([]);
	});

	it('clears every failure and nothing else when its page is left', () => {
		vi.useFakeTimers();
		toasts.add('Card not found', 'error');
		toasts.add('Restored');
		toasts.add('The team was not deleted.', 'error');

		toasts.clearErrors();
		expect(shown()).toEqual(['success: Restored']);
		vi.advanceTimersByTime(TOAST_MS);
		expect(shown()).toEqual([]);
	});

	it('shows the same failure once, as the newest, and no more than three failures, the oldest going first', () => {
		vi.useFakeTimers();
		toasts.add('Card not found', 'error');
		toasts.add('Saved');
		toasts.add('Card not found', 'error');
		expect(shown()).toEqual(['success: Saved', 'error: Card not found']);

		toasts.add('One', 'error');
		toasts.add('Two', 'error');
		toasts.add('Three', 'error');
		expect(MOST_FAILURES).toBe(3);
		expect(shown()).toEqual(['success: Saved', 'error: One', 'error: Two', 'error: Three']);
		// What is not a failure is not counted among them.
		toasts.add('Card archived', 'info');
		expect(shown()).toEqual(['success: Saved', 'error: One', 'error: Two', 'error: Three', 'info: Card archived']);
		// The same as one shown is not a fourth: it is shown once, as the newest.
		toasts.add('One', 'error');
		expect(shown()).toEqual(['success: Saved', 'error: Two', 'error: Three', 'info: Card archived', 'error: One']);
	});

	it('drops a failure whose request was started before a navigation, and shows one started after it', () => {
		const before = toasts.navigation();
		toasts.add('Card not found', 'error', before);
		expect(shown()).toEqual(['error: Card not found']);

		toasts.navigated();
		expect(toasts.navigation()).toBe(before + 1);
		toasts.clearErrors();
		// The answer to a request the page left behind comes in on the next page.
		toasts.add('The team was not deleted.', 'error', before);
		expect(shown()).toEqual([]);
		// One started on this page is shown, and so is a check made before any request.
		toasts.add('The schedule was not changed.', 'error', toasts.navigation());
		toasts.add('Destination name is required', 'error');
		expect(shown()).toEqual(['error: The schedule was not changed.', 'error: Destination name is required']);
	});

	it('is cleared of failures by Toast.svelte when its page goes, and when the page is navigated without going', () => {
		const component = scriptOf('src/lib/components/Toast.svelte');
		const given = (callee: string) => callsOf(component, callee).map((call) => call.arguments.map((argument) => argument.getText()));

		expect(given('onDestroy')).toEqual([['() => toasts.clearErrors()']]);
		// From a board to its sub-board SvelteKit keeps the page: nothing is destroyed.
		expect(given('afterNavigate')).toEqual([['() => toasts.clearErrors()']]);
		// And each navigation is counted as it begins, so that a failure that comes after it is dropped.
		expect(given('onNavigate')).toEqual([['() => toasts.navigated()']]);
		expect(component.getText()).toContain("import { afterNavigate, onNavigate } from '$app/navigation';");
	});

	it.each(Object.keys(WRITES))('%s gives each failure that follows a request the navigation the request was started in', (file) => {
		const source = readFileSync(join(ROOT, file), 'utf8');
		const awaitsIn = (fn: ts.Node) => {
			const found: ts.AwaitExpression[] = [];
			const visit = (node: ts.Node) => {
				if (ts.isAwaitExpression(node)) found.push(node);
				ts.forEachChild(node, visit);
			};
			visit(fn);
			return found;
		};
		const checked: string[] = [];
		for (const { tree } of codeOf(file, source)) {
			// The dashboard calls the store `failureToasts`: it has `toasts` of its own, the new-request notices.
			const failures = [...callsOf(tree, 'toasts.add'), ...callsOf(tree, 'failureToasts.add'), ...callsOf(tree, 'showToast')].filter((call) =>
				call.arguments[1]?.getText().includes("'error'")
			);
			for (const call of failures) {
				const fn = ts.findAncestor(call.parent, ts.isFunctionLike);
				// A check made before any request, such as a name left empty, has no request to wait for.
				if (!fn || !awaitsIn(fn).some((waited) => waited.getStart() < call.getStart())) continue;
				checked.push(call.getText());
				expect(call.arguments[2]?.getText(), call.getText()).toBe('started');
				// Read as the request starts: before the first `await` of the function that reads it.
				let declared: ts.VariableDeclaration | undefined;
				for (let at: ts.Node | undefined = fn; at && !declared; at = ts.findAncestor(at.parent, ts.isFunctionLike)) {
					const outer = at;
					const visit = (node: ts.Node) => {
						if (ts.isVariableDeclaration(node) && node.name.getText() === 'started' && ts.findAncestor(node.parent, ts.isFunctionLike) === outer) declared = node;
						if (!declared) ts.forEachChild(node, visit);
					};
					visit(outer);
				}
				const store = call.expression.getText() === 'failureToasts.add' ? 'failureToasts' : 'toasts';
				expect(declared?.initializer?.getText(), call.getText()).toBe(`${store}.navigation()`);
				const reader = ts.findAncestor(declared!.parent, ts.isFunctionLike)!;
				expect(awaitsIn(reader).every((waited) => waited.getStart() > declared!.getStart()), call.getText()).toBe(true);
			}
		}
		// The card window, its label picker, the share and subtask windows and the
		// account page say a refusal on a line of their own, not in a toast.
		const ownLine = [
			'src/lib/components/CardModal.svelte',
			// Its sections (card 2280, slice B4), which say a refusal in its message box.
			...filesUnder('src/lib/components/card', '.svelte'),
			'src/lib/components/LabelPicker.svelte',
			'src/lib/components/ShareModal.svelte',
			'src/lib/components/SubtaskModal.svelte',
			'src/routes/account/+page.svelte',
			// The admin page's mail panel, under the panel (card 2281, slice C1b).
			'src/lib/components/admin/SmtpPanel.svelte'
		];
		// The App URL panel says a refusal only through `sent`, which is held to it below (card 2281, slice C1a);
		// so do the board and team panels, and the danger zone, whose reset says its own in the page's notice (slice C1b).
		const throughSent = [
			'src/lib/components/admin/AppUrlPanel.svelte',
			'src/lib/components/admin/BoardManagementPanel.svelte',
			'src/lib/components/admin/TeamsPanel.svelte',
			'src/lib/components/admin/DangerZonePanel.svelte'
		];
		if (ownLine.includes(file) || throughSent.includes(file)) expect(checked).toEqual([]);
		else expect(checked.length).toBeGreaterThan(0);
	});

	// Card 2281, slice C1a: the admin page's `sent`, which says every refusal
	// of the page and its panels that send through it, is a module of its own.
	it('src/lib/admin/send.ts gives each failure that follows a request the navigation the request was started in', () => {
		const file = 'src/lib/admin/send.ts';
		const [{ tree }] = codeOf(file, readFileSync(join(ROOT, file), 'utf8'));
		const sending = tree.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === 'sent')!;
		const failures = callsOf(sending, 'showToast').filter((call) => call.arguments[1]?.getText() === "'error'");

		expect(failures).toHaveLength(2);
		for (const call of failures) expect(call.arguments[2]?.getText(), call.getText()).toBe('started');
		// Read as the request starts, before its first `await`.
		expect(sending.body!.statements[0].getText()).toBe('const started = toasts.navigation();');
	});

	it('src/lib/admin/send.ts sent says the server’s words for a refusal, the fallback for one without words, and that it is not known for no answer', async () => {
		const fallback = 'Failed to save App URL';
		const refused = await sent(async () => Response.json({ message: 'Superadmin only' }, { status: 403 }), fallback);
		const wordless = await sent(async () => new Response('<html><body>502 Bad Gateway</body></html>', { status: 502, headers: { 'content-type': 'text/html' } }), fallback);
		const unanswered = await sent(async () => {
			throw new TypeError('Failed to fetch');
		}, fallback);
		const done = await sent(async () => Response.json({ ok: true }), fallback);

		// Null for each that was not done, so that the caller changes nothing; the answer for one that was.
		expect([refused, wordless, unanswered]).toEqual([null, null, null]);
		expect(done?.status).toBe(200);
		expect(shown()).toEqual(['error: Superadmin only', `error: ${fallback}`, `error: ${ADMIN_NO_ANSWER}`]);
		expect(ADMIN_NO_ANSWER).toBe('No answer from the server. It is not known whether this was done.');
	});

	it('is shown above every dialog, which a refusal is shown beside', () => {
		const zIndexes = (file: string) => [...readFileSync(join(ROOT, file), 'utf8').matchAll(/z-index:\s*(\d+)/g)].map((found) => Number(found[1]));
		const [toast] = zIndexes('src/lib/components/Toast.svelte');

		for (const dialog of [
			'src/app.css',
			'src/lib/components/CardModal.svelte',
			// Its sections' dropdowns and template dialogs (card 2280, slice B4).
			...filesUnder('src/lib/components/card', '.svelte'),
			'src/lib/components/ConfirmModal.svelte',
			// The admin page's panels and their dialogs (card 2281, slice C1a).
			...filesUnder('src/lib/components/admin', '.svelte'),
			// And the admin page itself, which is in the table of writes no longer (slice C1b).
			ADMIN_PAGE,
			// All Tasks' Move window and live toasts (card 2281, slice C3a-2).
			...tasksComponents(),
			...Object.keys(WRITES).filter((file) => file.startsWith('src/routes/'))
		]) {
			for (const below of zIndexes(dialog)) expect(toast, dialog).toBeGreaterThan(below);
		}
		// The archived page's confirmation is the app's, ConfirmModal above (card 2362: it was its own, at 9999).
		const archived = readFileSync(join(ROOT, 'src/routes/archived/+page.svelte'), 'utf8');
		expect(archived).toContain('<ConfirmModal');
		expect(archived).not.toContain('modal-overlay');
		for (const below of zIndexes('src/routes/archived/+page.svelte')) expect(toast, 'src/routes/archived/+page.svelte').toBeGreaterThan(below);
	});

	it.each(['src/routes/admin/+page.svelte', 'src/routes/teams/+page.svelte', 'src/routes/reports/+page.svelte', 'src/routes/all/+page.svelte', 'src/routes/todo/+page.svelte'])(
		'%s shows its toasts through the shared one, and no toast of its own',
		(file) => {
			const source = readFileSync(join(ROOT, file), 'utf8');
			const markup = source.slice(source.indexOf('</script>'));

			expect(source).toContain("import Toast from '$lib/components/Toast.svelte';");
			expect(markup.match(/<Toast \/>/g)).toHaveLength(1);
			expect(source).not.toContain('toast-notification');
			expect(source).not.toMatch(/setTimeout\(\(\) => \(toast = ''\)/);
		}
	);

	// Card 2281, slice C1a: and the admin page's panels show theirs through the page's.
	it.each(adminComponents())('%s shows its toasts through the admin page’s shared one, and no toast of its own', (file) => {
		const source = readFileSync(join(ROOT, file), 'utf8');

		expect(source).not.toContain('<Toast');
		expect(source).not.toContain('toast-notification');
		expect(source).not.toMatch(/setTimeout\(\(\) => \(toast = ''\)/);
	});

	// Card 2281, slice C3a-2: and All Tasks' components show theirs through the page's
	// (the live toasts of other people's changes are LiveToasts' own, as they were the page's).
	it.each(tasksComponents())('%s shows its toasts through All Tasks’ shared one, and no toast of its own', (file) => {
		const source = readFileSync(join(ROOT, file), 'utf8');

		expect(source).not.toContain('<Toast');
		expect(source).not.toContain('toast-notification');
		expect(source).not.toMatch(/setTimeout\(\(\) => \(toast = ''\)/);
	});

	it.each(['src/routes/teams/+page.svelte'])('%s keeps showToast, as one line that adds to the store', (file) => {
		const body = functionNamed(scriptOf(file), 'showToast').body!;

		expect(body.statements.map((statement) => statement.getText())).toEqual(['toasts.add(msg, type, started);']);
	});

	// Card 2281, slice C1a: the admin page's is in src/lib/admin/send.ts, which the page and its panels import.
	it('keeps the admin page’s showToast, as one line that adds to the store, in src/lib/admin/send.ts, and no other in the page or its panels', () => {
		const send = ts.createSourceFile('send.ts', readFileSync(join(ROOT, 'src/lib/admin/send.ts'), 'utf8'), ts.ScriptTarget.Latest, true);

		expect(functionNamed(send, 'showToast').body!.statements.map((statement) => statement.getText())).toEqual(['toasts.add(msg, type, started);']);
		for (const { file, source } of adminSources().filter((admin) => admin.file !== 'src/lib/admin/send.ts')) {
			const tree = file.endsWith('.svelte') ? scriptOf(file, source) : ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
			expect(tree.statements.some((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'showToast'), file).toBe(false);
			if (callsOf(tree, 'showToast').length > 0) expect(source, file).toMatch(/import \{[^}]*\bshowToast\b[^}]*\} from '\$lib\/admin\/send';/);
		}
	});

	it('is never a dialog box: no alert, which would hold the page while a 401 sends it to the login page', () => {
		const files = [
			...filesUnder('src/routes', '.svelte'),
			...filesUnder('src/routes', '.ts'),
			...filesUnder('src/lib/components', '.svelte'),
			...filesUnder('src/lib/board', '.ts'),
			// The admin page's `sent` and formatters (card 2281, slice C1a), and the dashboard's (slice C2).
			...filesUnder('src/lib/admin', '.ts'),
			...filesUnder('src/lib/dashboard', '.ts')
		];
		const alerting = files.filter((file) => /\balert\(/.test(readFileSync(join(ROOT, file), 'utf8')));

		expect(files.length).toBeGreaterThan(50);
		expect(alerting).toEqual([]);
	});
});

describe('a page whose session has ended, for the seven pages of card 2109', () => {
	it.each(Object.keys(WRITES))('%s sends through the global fetch, and does nothing of its own about a 401', (file) => {
		const script = scriptOf(file).getText();

		// The one fetch the sign-out watch replaces (src/hooks.client.ts).
		expect(script).not.toMatch(/(window|globalThis|self)\.fetch\b/);
		// The watch sends the page to the login page; the page only says what failed.
		expect(script).not.toMatch(/\b401\b/);
		expect(script).not.toMatch(/['"`]\/login/);
	});

	// Card 2281, slice C1a: the admin page and its panels send through `sent`, which is a module of its own.
	it.each(filesUnder('src/lib/admin', '.ts'))('%s sends through the global fetch, and does nothing of its own about a 401', (file) => {
		const script = readFileSync(join(ROOT, file), 'utf8');

		expect(script).not.toMatch(/(window|globalThis|self)\.fetch\b/);
		expect(script).not.toMatch(/\b401\b/);
		expect(script).not.toMatch(/['"`]\/login/);
	});
});

// Card 2281, slice C3a-1 (the plan's section 6.3, case 2). All To Do (card
// 2240) carried its own copy of All Tasks' card window handlers, held alike
// here, and the plan page saved through card-actions and said "Card updated"
// whatever came back. All three now open, save and archive the window
// through the board page's controller, over their own lists
// (`src/lib/board/page-card-window.svelte.ts`, whose cases are in
// `tests/page-card-window.test.ts`; the pages are mounted in
// `tests/card-window-pages.test.ts`). The plan page's window has no Archive,
// as before.
// All Tasks' parts are in components of their own since slice C3a-2, and
// the plan page's since slice C3a-3 (with its graph's module): what is said
// to be gone is looked for in each of them as well (`parts`).
const WINDOW_PAGES = [
	{ file: 'src/routes/all/+page.svelte', save: 'saveFromWindow', archive: 'archiveFromWindow', list: 'buckets', derived: 'let buckets = $derived(data.buckets);', parts: tasksComponents() },
	{ file: 'src/routes/todo/+page.svelte', save: 'saveFromWindow', archive: 'archiveFromWindow', list: 'cards', derived: 'let cards = $derived(data.cards);', parts: [] },
	{ file: 'src/routes/plan/[id]/+page.svelte', save: 'saveCardFromPlan', archive: null, list: 'modalCard', derived: null, parts: [...planComponents(), 'src/lib/plan-graph.ts'] }
];

describe.each(WINDOW_PAGES)('the card window on $file goes through the controller (card 2281, slice C3a-1)', ({ file, save, archive, list, derived, parts }) => {
	const page = scriptOf(file);
	const board = scriptOf('src/routes/board/[id]/+page.svelte');
	const source = readFileSync(join(ROOT, file), 'utf8');
	/** The page and its components, as one text, and their scripts (a module's whole text is its script). */
	const everywhere = [source, ...parts.map((part) => readFileSync(join(ROOT, part), 'utf8'))].join('\n');
	const scripts = [
		page,
		...parts.map((part) =>
			part.endsWith('.ts') ? ts.createSourceFile(part, readFileSync(join(ROOT, part), 'utf8'), ts.ScriptTarget.Latest, true) : scriptOf(part)
		)
	];
	const markup = source.slice(source.indexOf('</script>'));
	const opened = markup.slice(markup.indexOf('<CardModal'));
	const modal = opened.slice(0, opened.indexOf('/>')).replace(/\s+/g, ' ');

	it('makes one controller, over the page’s own list, and keeps no card, board or open flag of the window’s own', () => {
		const made = page.statements.filter((statement) => /new PageCardWindow\(/.test(statement.getText()));
		expect(made).toHaveLength(1);
		expect(made[0].getText()).toMatch(new RegExp(`^const cardWindow = new PageCardWindow\\(\\s*\\{ get: \\(\\) => .*\\b${list}\\b.*, set: \\(next\\) => \\(${list} = `, 's'));
		expect(made[0].getText()).toContain('() => invalidateAll()');
		// The list is the load's, written to by a save, and replaced by each re-read (the C3a-1 review).
		if (derived) expect(page.statements.map((statement) => statement.getText())).toContain(derived);
		expect(everywhere).not.toMatch(/\b(editingCard|showCardModal|editingBoardId)\b/);
		expect(callsOf(functionNamed(page, 'openCard'), 'cardWindow.openCard')).toHaveLength(1);

		expect(modal).toContain('card={cardWindow.card}');
		expect(modal).toContain(`onSave={${save}}`);
		expect(markup.match(/<CardModal\b/g)).toHaveLength(1);
		// The window is the page's alone: none of its components draws one or makes a controller of its own.
		for (const part of parts) expect(readFileSync(join(ROOT, part), 'utf8'), part).not.toMatch(/<CardModal\b|new PageCardWindow\(|new CardWindow\(/);
	});

	it('defines no saveCard or deleteCard of its own, and sends no save or archive itself', () => {
		// Not by any name in the file, script or markup (`saveCardFromPlan` is the plan page's handler), nor in its components.
		expect(everywhere).not.toMatch(/\b(saveCard|deleteCard)\b/);
		for (const script of scripts) expect(script.getText(), script.fileName).not.toMatch(/cardActions\.|from '\$lib\/board\/card-actions'/);
		const writes = apiWrites();
		for (const name of [save, archive].filter((name): name is string => !!name)) {
			const fn = functionNamed(page, name);
			for (const callee of ['fetch', 'deleteFailure', 'failureMessage']) expect(callsOf(fn, callee), `${name} ${callee}`).toEqual([]);
			// No call in it sends a write: neither a `fetch` that writes nor a write of `$lib/api.ts`.
			const sending: string[] = [];
			const visit = (node: ts.Node) => {
				if (ts.isCallExpression(node)) {
					const write = writeOf(node, writes);
					if (write) sending.push(write);
				}
				ts.forEachChild(node, visit);
			};
			visit(fn);
			expect(sending, name).toEqual([]);
		}
		expect(callsOf(functionNamed(page, save), 'cardWindow.save')).toHaveLength(1);
	});

	it('says a refusal in the controller’s words, with the window left open; nothing for a save with nothing changed; what was done once saved, and reads the page again', async () => {
		const run = async (result: unknown) => {
			const said: unknown[][] = [];
			const reread = vi.fn(async () => {});
			const close = vi.fn();
			const names = file.includes('/plan/') ? [save, 'closeCard'] : [save];
			const fn = new Function(
				'cardWindow',
				'toasts',
				'invalidateAll',
				`let modalCard = {}, modalContext = {}, wrote = false;\n${runnable(page, names)}\nreturn ${save};`
			)({ save: async () => result, close }, { navigation: () => 'started', add: (...args: unknown[]) => said.push(args) }, reread);
			await fn({ title: 'Plan' });
			return { said, rereads: reread.mock.calls.length, closed: close.mock.calls.length };
		};

		expect(await run({ ok: false, failure: 'Viewers cannot change cards' })).toEqual({ said: [['Viewers cannot change cards', 'error', 'started']], rereads: 0, closed: 0 });
		expect(await run({ ok: true, told: [{ message: 'Card updated', failed: false }] })).toMatchObject({ said: [['Card updated']], rereads: 1 });
		// Nothing changed: nothing said, and nothing read again, the plan page included (card 2324: it re-read as its window closed, saved or not).
		expect(await run({ ok: true, told: [] })).toMatchObject({ said: [], rereads: 0 });
	});

	it('archives through the controller once confirmed, saying the same as the board page before and after, from one text; or offers no Archive, as before', () => {
		if (!archive) {
			expect(modal).not.toContain('onDelete');
			return;
		}
		const archiving = functionNamed(page, archive);
		const asked = callsOf(archiving, 'showConfirm');
		expect(asked).toHaveLength(1);
		expect(asked[0].arguments[1].getText()).toBe('cardArchiveWarning(cardWindow.card?.title)');
		const confirmed = asked[0].arguments[3];
		expect(ts.isArrowFunction(confirmed)).toBe(true);
		const archived = callsOf(archiving, 'cardWindow.archive');
		expect(archived).toHaveLength(1);
		expect(isWithin(archived[0], confirmed)).toBe(true);
		expect(modal).toContain(`onDelete={${archive}}`);

		expect(callsOf(functionNamed(board, 'confirmDeleteCard'), 'api.cardArchiveWarning')).toHaveLength(1);
		for (const tree of [page, board]) {
			expect(tree.getText()).toContain("toasts.add('Card archived. Restore it from Archived Cards.', 'info');");
			expect(tree.getText()).not.toContain('It is taken off the board and nothing on it is deleted');
		}
		expect(cardArchiveWarning('Ship it')).toBe(
			'Archive "Ship it"? It is taken off the board and nothing on it is deleted. It can be restored from Archived Cards, in the More menu.'
		);
		expect(cardArchiveWarning(undefined)).toMatch(/^Archive this card\? /);

		expect(markup).toContain('{#if confirmState.show}');
		expect(markup).toContain('onConfirm={() => { confirmState.show = false; confirmState.onConfirm(); }}');
		// All Tasks' Archived Cards panel deletes for good, through the page's confirm (its panel's since slice C3a-2); All To Do has no such panel.
		if (file === 'src/routes/all/+page.svelte') {
			const panel = scriptOf('src/lib/components/tasks/TasksArchivePanel.svelte');
			expect(callsOf(functionNamed(panel, 'permanentlyDeleteArchivedCard'), 'showConfirm')).toHaveLength(1);
			expect(markup).toContain('<TasksArchivePanel bind:this={archivePanel} {showConfirm} bind:showArchivePanel />');
		}
		for (const script of scripts) expect(script.getText(), script.fileName).not.toMatch(/window\.(alert|confirm)\(/);
	});
});

// Card 2186. All Tasks built the card window's card field by field and left
// out the five reporting fields and `requestOrigin`, so the window opened its
// Reporting section empty on a card with values, and showed no "Created from
// request by ..."; and its save sent none of the five, so what was typed
// there was dropped. The route itself is run in `tests/card-updates.test.ts`.
// Since card 2281's slice C3a-1 both pages hand the window their row through
// the controller's adapter (`windowCard`), and a save sends what the
// controller finds changed among `WINDOW_FIELDS`.
describe.each(['src/routes/all/+page.svelte', 'src/routes/todo/+page.svelte'])('the card window on %s (card 2186)', (file) => {
	const page = scriptOf(file);
	const REPORTING = ['summary', 'theme', 'customerImpact', 'closeReason', 'releaseState'];

	it('hands the window the row as loaded, with its fall-backs, so the reporting fields and requestOrigin come with it', () => {
		// The page hands the controller the row itself, building nothing of its own.
		expect(callsOf(functionNamed(page, 'openCard'), 'cardWindow.openCard').map((call) => call.getText())).toEqual(['cardWindow.openCard(card, card.boardId)']);
		expect(functionNamed(page, 'openCard').getText()).not.toMatch(/\.\.\.card/);

		const adapter = scriptOf('src/lib/board/page-card-window.svelte.ts', `<script lang="ts">${readFileSync(join(ROOT, 'src/lib/board/page-card-window.svelte.ts'), 'utf8')}</script>`);
		const given = assignmentsTo(functionNamed(adapter, 'windowCard'), 'shown');
		expect(given).toHaveLength(1);
		const object = given[0].right;
		expect(ts.isObjectLiteralExpression(object)).toBe(true);
		const properties = (object as ts.ObjectLiteralExpression).properties;
		expect(properties[0].getText()).toBe('...card');
		const own = properties.slice(1).map((property) => property.name?.getText() ?? property.getText());
		for (const name of [...REPORTING, 'requestOrigin']) expect(own, name).not.toContain(name);
		expect(own.sort()).toEqual(
			['position', 'subtasks', 'labelIds', 'pinned', 'onHoldNote', 'businessValue', 'subBoards', 'assignees', 'archivedAt', 'coverUrl', 'milestoneId', 'updatedAt'].sort()
		);
	});

	it('sends each of the five reporting fields changed in a save, as the window gives it', () => {
		// Among the fields the controller compares and sends, and nothing of a save is built by the page.
		for (const name of REPORTING) expect(WINDOW_FIELDS, name).toContain(name);
		expect(bodiesSent(functionNamed(page, 'saveFromWindow'))).toEqual([]);
		// As the window gives them: text, or null for a cleared field, which clears it.
		const card = { id: 7, title: 'Plan', summary: 'Old words', theme: 'Growth' } as unknown as CardType;
		const typed = { title: 'Plan', description: '', priority: 'medium', categoryId: null, dueDate: null, summary: 'New words', theme: null, customerImpact: 'Faster', closeReason: null, releaseState: 'Shipped' };
		expect(changedFields(windowFields(card), typed)).toEqual({ summary: 'New words', theme: null, customerImpact: 'Faster', releaseState: 'Shipped' });
	});

	// Review of card 2198: the window was given every account, so a mention
	// of someone off the card's board was drawn as a chip and not mailed.
	it("gives the window the people of the card's own board, read with the card's context, not every account", () => {
		const markup = readFileSync(join(ROOT, file), 'utf8');
		expect(markup).not.toContain('boardUsers={data.allUsers}');
		expect(markup).toContain('boardUsers={editingBoardUsers}');
		expect(callsOf(functionNamed(page, 'openCard'), 'loadBoardUsers').map((call) => call.getText())).toEqual(['loadBoardUsers(card.id)']);
		const load = functionNamed(page, 'loadBoardUsers').getText();
		expect(load).toContain('fetch(`/api/cards/${cardId}/context`)');
		expect(load).toContain('const body = await res.json();');
		// An answer for a card no longer open is not used.
		expect(load).toContain('if (cardWindow.cardId === cardId) editingBoardUsers = body.boardUsers;');
	});
});

describe('Purge on the archived page, src/routes/archived/+page.svelte', () => {
	it('is offered inside a block for an administrator alone, as it already was', () => {
		const file = 'src/routes/archived/+page.svelte';
		const source = readFileSync(join(ROOT, file), 'utf8');
		const from = source.indexOf('</script>');
		const markup = source.slice(from);
		const button = 'onclick={purgeAll}';

		expect(markup.split(button)).toHaveLength(2);
		const around = blocksAround(source, from + markup.indexOf(button));
		expect(around.some((block) => block.condition.startsWith('data.isAdmin') && !block.inElse)).toBe(true);
	});
});

describe('duplicating a card, src/lib/board/card-actions.ts and the board page', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const answer = (status: number, body: unknown) =>
		new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	const card = {
		id: 7,
		title: 'Ship it',
		description: '',
		priority: 'urgent',
		colorTag: '',
		categoryId: null,
		dueDate: null,
		subtasks: [
			{ title: 'One', description: '', priority: 'low', colorTag: '', dueDate: null },
			{ title: 'Two', description: '', priority: 'low', colorTag: '', dueDate: null },
			{ title: 'Three', description: '', priority: 'low', colorTag: '', dueDate: null }
		]
	} as unknown as CardType;
	const columns = [{ id: 3, cards: [card] }] as unknown as ColumnType[];

	/** A `fetch` that answers each request with the next of `answers`, and the requests it was sent. */
	function stage(answers: (Response | 'no answer')[]) {
		const sent: string[] = [];
		vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
			sent.push(`${init.method} ${url}`);
			const next = answers.shift();
			if (next === undefined || next === 'no answer') throw new TypeError('fetch failed');
			return next;
		});
		return sent;
	}

	it('is not "Duplicated" when the copy is refused: the server’s words, and no subtask is sent', async () => {
		const sent = stage([answer(400, { message: 'priority must be one of low, medium, high or critical' })]);

		expect(await cardActions.duplicateCard(card, columns, 9, [])).toEqual({
			title: null,
			failure: 'priority must be one of low, medium, high or critical'
		});
		expect(sent).toEqual(['POST /api/cards']);

		stage(['no answer']);
		expect(await cardActions.duplicateCard(card, columns, 9, [])).toEqual({
			title: null,
			failure: 'No answer from the server. The card may not have been duplicated.'
		});
	});

	it('stops at the first subtask refused, keeps the copy and says how far it got', async () => {
		const sent = stage([answer(201, { id: 50 }), answer(201, { id: 1 }), answer(400, { message: 'Title is required' }), answer(201, { id: 3 })]);

		expect(await cardActions.duplicateCard(card, columns, 9, [])).toEqual({
			title: 'Ship it',
			failure: '"Ship it" was duplicated with 1 of its 3 subtasks. Subtask "Two" was not copied, nor the 1 after it. Title is required'
		});
		expect(sent).toEqual(['POST /api/cards', 'POST /api/subtasks', 'POST /api/subtasks']);
	});

	it('is the title alone when the copy and every subtask were made', async () => {
		const sent = stage([answer(201, { id: 50 }), answer(201, {}), answer(201, {}), answer(201, {})]);

		expect(await cardActions.duplicateCard(card, columns, 9, [])).toEqual({ title: 'Ship it', failure: null });
		expect(sent).toHaveLength(4);
	});

	it('is said by the board page in the server’s words, and "Duplicated" only when nothing failed', () => {
		const said = functionNamed(scriptOf('src/routes/board/[id]/+page.svelte'), 'duplicateCard').getText().replace(/\s+/g, ' ');

		expect(said).toContain('const { title, failure, into } = await cardActions.duplicateCard(card, boardState.columns, data.board.id, boardState.categories);');
		// The copy of a finished card is made in another column, which it names (card 2134, O7).
		expect(said).toContain(
			"if (failure) { toasts.add(failure, 'error', started); } else if (title) { toasts.add(into ? `Duplicated \"${title} (Copy)\" into ${into}` : `Duplicated \"${title}\"`); }"
		);
	});
});

describe('linking an existing board under a card, src/lib/board/card-actions.ts and the board page (card 2139)', () => {
	// The page said "Board linked as sub-board" whatever the answer, and the
	// route saved nothing. The route saves it now, for the board's owner; the
	// page asks first and says what the server said.
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const board = scriptOf('src/routes/board/[id]/+page.svelte');

	it('sends the card to the board route and hands back the answer', async () => {
		const sent: { url: string; method?: string; body: unknown }[] = [];
		const refused = Response.json({ message: 'Only the board’s owner may' }, { status: 403 });
		vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
			sent.push({ url, method: init.method, body: JSON.parse(String(init.body)) });
			return refused;
		});

		expect(await cardActions.linkSubBoard(3, 7)).toBe(refused);
		expect(sent).toEqual([{ url: '/api/boards/7', method: 'PUT', body: { parentCardId: 3 } }]);
	});

	it('asks first, saying what linking does, and sends the link only once it is confirmed', () => {
		const linking = functionNamed(board, 'linkSubBoard');
		const asked = callsOf(linking, 'showConfirm');
		expect(asked).toHaveLength(1);
		expect(asked[0].arguments[1].getText()).toBe('api.subBoardLinkWarning(name)');

		const confirmed = asked[0].arguments[3];
		expect(ts.isArrowFunction(confirmed)).toBe(true);
		const requests = callsOf(linking, 'cardActions.linkSubBoard');
		expect(requests).toHaveLength(1);
		expect(isWithin(requests[0], confirmed)).toBe(true);
	});

	it('says in the dialog who will see the board and its cards, who can move it, that the card cannot be completed while it has open cards, and what deletes it', () => {
		expect(subBoardLinkWarning('Website')).toBe(
			'Put "Website" under this card? It will be shown on this card instead of on the dashboard, and its members who cannot open this board will no longer see it on theirs. ' +
				// A report is its reader's: whoever downloads or sends it, and a
				// scheduled one's owner (card 2150, decision 2).
				'Those who can open this board see it on this card only if they can open "Website" too. ' +
				"Its cards are in this board's reports only when whoever downloads, sends or schedules the report can open \"Website\" too; whoever they send it to gets what that person can see. " +
				"This board's editors can move this card, taking \"Website\" with it. " +
				'This card cannot be completed while "Website" has cards that are not complete, and "Website" is deleted for good, with everything on it, if this card, its column or this board is ever deleted for good.'
		);
	});
});

describe("a move to another board that takes the card out of its milestone (card 2155, the review's O3)", () => {
	// The card leaves a milestone of the board it left, and moving it back does
	// not put it back in. The mover was told nothing: the card was simply gone
	// from the goal. The answer of PUT /api/cards/{id} names the goal.
	it('is said in one sentence, from one place, and only when the answer names a goal', () => {
		expect(leftMilestoneNotice({ id: 5, leftMilestone: { id: 3, name: 'Goal M' } })).toBe(
			'Moved. It left milestone "Goal M"; moving it back does not put it back in.'
		);
		expect(leftMilestoneNotice({ id: 5, leftMilestone: null })).toBeNull();
		expect(leftMilestoneNotice({ id: 5 })).toBeNull();
		expect(leftMilestoneNotice({ id: 5, leftMilestone: { id: 3 } })).toBeNull();
		expect(leftMilestoneNotice(null)).toBeNull();

		// No page or component writes the words itself, so each says them alike.
		const pages = [...filesUnder('src/routes', '.svelte'), ...filesUnder('src/lib/components', '.svelte'), ...filesUnder('src/lib/board', '.ts')];
		for (const file of pages) expect(readFileSync(join(ROOT, file), 'utf8'), file).not.toContain('put it back in');
	});

	it('is said by All Tasks for a move that succeeded, read from its answer', () => {
		// In its Move window (card 2281, slice C3a-2: moved from src/routes/all/+page.svelte).
		const said = functionNamed(scriptOf('src/lib/components/tasks/MoveCardModal.svelte'), 'doMoveCard').getText().replace(/\s+/g, ' ');

		expect(said).toContain('const leftGoal = leftMilestoneNotice(await answerBody(res));');
		expect(said).toContain("if (leftGoal) toasts.add(leftGoal, 'info');");
		expect(said.indexOf('leftMilestoneNotice(')).toBeGreaterThan(said.indexOf('if (!res.ok)'));
	});

	it('has no other page to be said on: the board page and All To Do move no card to another board', () => {
		// All Tasks' Move window is the one place a person chooses another board
		// for a card. The board page moves a card among its own columns (a drag,
		// the card menu and the bulk move, each through PUT /api/cards/reorder),
		// its card window sends no column, and All To Do has no Move window
		// (card 2240). A page that gains one says the sentence above too.
		// The board page's markup is in its components too (card 2280, slice B3).
		const boardParts = ['BoardHeader', 'BoardMoreMenu', 'KanbanColumnHeader', 'KanbanCardBody', 'ActivityPanel', 'ArchivePanel', 'SidePanel', 'XpLeaderboard'].map((name) => `src/lib/components/board/${name}.svelte`);
		for (const file of ['src/routes/board/[id]/+page.svelte', ...boardParts, 'src/routes/todo/+page.svelte']) {
			const source = readFileSync(join(ROOT, file), 'utf8');
			expect(source, file).not.toContain('id="move-board"');
			expect(source, file).not.toMatch(/columnId: move/);
		}
		// All Tasks' Move window is a component of its own (card 2281, slice C3a-2).
		expect(readFileSync(join(ROOT, 'src/lib/components/tasks/MoveCardModal.svelte'), 'utf8')).toContain('id="move-board"');
	});
});

describe('making a sub-board from the board page, src/lib/board/card-actions.ts and the board page (card 2172)', () => {
	// Sub-boards nest at most 20 levels deep, and the server refuses one deeper,
	// 409. The card menu's Create Sub-board then did nothing at all, and the
	// new-card window said "Created" for the card and nothing of the sub-board.
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const board = scriptOf('src/routes/board/[id]/+page.svelte');
	const refusal = 'Sub-boards can be nested at most 20 levels deep, and a board under this card would be deeper.';

	it('gives back the new board, the server’s words for a refusal, or that there was no answer', async () => {
		const sent: { url: string; method?: string; body: unknown }[] = [];
		vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
			sent.push({ url, method: init.method, body: JSON.parse(String(init.body)) });
			return Response.json({ message: refusal }, { status: 409 });
		});
		expect(await cardActions.createSubBoard(3, 'Plans')).toEqual({ message: refusal });
		expect(sent).toEqual([{ url: '/api/boards', method: 'POST', body: { name: 'Plans', emoji: '🗂️', parentCardId: 3 } }]);

		vi.stubGlobal('fetch', async () => Response.json({ id: 12 }, { status: 201 }));
		expect(await cardActions.createSubBoard(3, 'Plans')).toEqual({ id: 12 });

		vi.stubGlobal('fetch', async () => {
			throw new TypeError('fetch failed');
		});
		expect(await cardActions.createSubBoard(3, 'Plans')).toEqual({ message: 'No answer from the server. The sub-board may not have been made.' });
	});

	it('is said by the card menu’s Create Sub-board as an error, and the page goes to the new board only when it was made', () => {
		const said = functionNamed(board, 'createSubBoard').getText().replace(/\s+/g, ' ');

		expect(said).toContain("const made = await cardActions.createSubBoard(card.id, name || card.title); if ('message' in made) { toasts.add(made.message, 'error', started); return; } window.location.href = `/board/${made.id}`;");
	});

	// Card 2280, slice B2c: made by the card window's controller, which gives
	// back what to say for each; the page says each failure as an error (the
	// card 2164 describe above). Run in `tests/card-window.test.ts`.
	it('is said by the new-card window for each sub-board refused, in the server’s words, and the card is kept', () => {
		const tree = ts.createSourceFile('card-window.ts', readFileSync(join(ROOT, 'src/lib/board/card-window.svelte.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
		let create: ts.MethodDeclaration | undefined;
		const find = (node: ts.Node) => {
			if (ts.isMethodDeclaration(node) && node.name.getText() === '#create') create = node;
			ts.forEachChild(node, find);
		};
		find(tree);
		const asked = callsOf(create!, 'api.failureMessage');

		expect(asked).toHaveLength(1);
		expect(sideOf(asked[0])).toBe('failed');
		const said = create!.getText().replace(/\s+/g, ' ');
		expect(said).toContain(
			"if (res.ok) told.push({ message: `Sub-board \"${name}\" created`, failed: false }); else told.push({ message: `Sub-board \"${name}\" was not made. ${await api.failureMessage(res, 'The server refused it.')}`, failed: true });"
		);
		// A request with no answer is said too, and the next name is still sent.
		expect(said).toContain("} catch { told.push({ message: `No answer from the server. Sub-board \"${name}\" may not have been made.`, failed: true }); continue; }");
	});
});

describe('the bulk move, src/lib/board/bulk-actions.ts and the board page (card 2209)', () => {
	// One request may move at most 100 cards to another column, and the server
	// refuses more, 400, moving none. The bulk move threw the answer away, so
	// the page cleared the selection as if they had moved.
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const refusal = 'At most 100 cards can be moved to another column at once, and this moves 120. Nothing was moved: move them in groups of 100 or fewer.';

	it('gives back the server’s words for a refusal, null when they moved, and says when there was no answer', async () => {
		const sent: { url: string; method?: string; body: { updates: unknown[] } }[] = [];
		vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
			sent.push({ url, method: init.method, body: JSON.parse(String(init.body)) });
			return Response.json({ message: refusal }, { status: 400 });
		});
		expect(await bulkActions.bulkMove(new Set([4, 5]), 9, 2, 1, 'owner', '👤')).toBe(refusal);
		expect(sent.map(({ url, method, body }) => [url, method, body.updates])).toEqual([
			['/api/cards/reorder', 'PUT', [{ id: 4, columnId: 9, position: 2 }, { id: 5, columnId: 9, position: 3 }]]
		]);

		vi.stubGlobal('fetch', async () => Response.json({ success: true }));
		expect(await bulkActions.bulkMove(new Set([4]), 9, 0, 1, 'owner', '👤')).toBeNull();

		vi.stubGlobal('fetch', async () => {
			throw new TypeError('fetch failed');
		});
		expect(await bulkActions.bulkMove(new Set([4]), 9, 0, 1, 'owner', '👤')).toBe('No answer from the server. The cards may not have been moved.');
	});

	// Card 2280, slice B2b: through the board state, which moves the cards at
	// once and puts them back on a refusal, reading the board then; a move made
	// is not read again (its echo is).
	it('is said by the board page as an error, which keeps the selection, the cards moved and put back by the board state', () => {
		const handle = functionNamed(scriptOf('src/routes/board/[id]/+page.svelte'), 'handleBulkMove');
		const said = handle.getText().replace(/\s+/g, ' ');

		expect(said).toContain("const failure = await bulkOps.bulkMove(selectedCards, targetColumnId, targetCol.cards.length, data.board.id, currentUser?.username || '', currentUser?.emoji || '👤', boardState);");
		expect(said).toContain("if (failure) { toasts.add(failure, 'error', started); } else { clearSelection(); }");
		expect(said).not.toContain('boardState.refresh()');
		// The only clearSelection is the one for a move that was made.
		const cleared = callsOf(handle, 'clearSelection');
		expect(cleared).toHaveLength(1);
		const ifFailure = ts.findAncestor(cleared[0], ts.isIfStatement)!;
		expect(ifFailure.expression.getText()).toBe('failure');
		expect(isWithin(cleared[0], ifFailure.elseStatement!)).toBe(true);
	});
});

// Card 2280, slice B2b. The bulk priority sent each card's change and threw
// the answers away, and the page cleared the selection whatever they were;
// each bulk change re-read the board after it. They go through the board
// state now: every card changed at once, each sent in turn as before, each
// refused card put back and kept selected, the count and the first reason said.
describe('bulk priority, archive and move through the board state, src/lib/board/bulk-actions.ts and the board page (card 2280, slice B2b)', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

	/** A board state of cards 1, 2 and 3 (low priority) in column 10 and an empty column 20; its own reads are kept, never answered. */
	function boardOfThree() {
		const card = (id: number) => ({ id, columnId: 10, position: id, title: `Card ${id}`, priority: 'low', subtasks: [], subBoards: [], labelIds: [], assignees: [] }) as unknown as CardType;
		const column = (id: number, position: number, cards: CardType[]) => ({ id, boardId: 9, title: `Column ${id}`, position, color: '#888888', showAddCard: false, wipLimit: 0, cards });
		const data = {
			board: { id: 9, name: 'Board', emoji: null, parentCardId: null },
			breadcrumbs: [],
			columns: [column(10, 0, [card(1), card(2), card(3)]), column(20, 1, [])],
			categories: [],
			labels: [],
			linkableBoards: [],
			canEdit: true,
			canManage: true,
			userBoardRole: 'owner',
			boardUsers: [],
			blockedState: {},
			cardTokens: {},
			boardTokenSummary: null,
			milestones: []
		} as unknown as BoardContentsData;
		const reads: string[] = [];
		const state = new BoardState(data, {
			invalidate: async () => {},
			fetch: (input) => {
				reads.push(String(input));
				return new Promise<Response>(() => {});
			}
		});
		return { state, reads };
	}
	const shown = (state: BoardState) => state.columns.map((c) => [c.id, c.cards.map((k) => `${k.id}:${k.priority}`)]);

	/** The writes' `fetch`: card 2 refused, card 3 unanswered, the rest taken, answering what was sent. */
	function refusingTwoAndThree() {
		const sent: string[] = [];
		vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
			sent.push(`${init.method} ${url}`);
			if (url.endsWith('/2')) return json(403, { message: 'No edit access to this board' });
			if (url.endsWith('/3')) throw new TypeError('fetch failed');
			return json(200, { id: Number(url.split('/').pop()), ...JSON.parse(String(init.body ?? '{}')) });
		});
		return sent;
	}

	it('bulk priority changes every card at once, sends them one at a time, puts back only the cards not taken, and says each in its words', async () => {
		const { state, reads } = boardOfThree();
		try {
			const sent = refusingTwoAndThree();
			const changing = bulkActions.bulkPriority(new Set([1, 2, 3]), 'critical', 9, state);
			expect(shown(state)[0]).toEqual([10, ['1:critical', '2:critical', '3:critical']]);
			expect(sent).toEqual([]);

			expect(await changing).toEqual({
				changed: 1,
				failed: [
					{ cardId: 2, message: 'No edit access to this board' },
					{ cardId: 3, message: 'No answer from the server. The priority may not have been changed.' }
				]
			});
			expect(sent).toEqual(['PUT /api/cards/1', 'PUT /api/cards/2', 'PUT /api/cards/3']);
			expect(shown(state)[0]).toEqual([10, ['1:critical', '2:low', '3:low']]);
			// The board is read once, for the two refusals, once nothing holds it.
			expect(state.holds).toBe(0);
			expect(reads).toEqual(['/api/boards/9/contents']);
		} finally {
			state.dispose();
		}
	});

	it('bulk archive takes every card off at once and puts back, in its place, each the server did not archive', async () => {
		const { state } = boardOfThree();
		try {
			const sent = refusingTwoAndThree();
			const archiving = bulkActions.bulkDelete(new Set([1, 2, 3]), 9, state);
			expect(shown(state)[0]).toEqual([10, []]);
			expect(await archiving).toEqual({
				archived: 1,
				failed: [
					{ cardId: 2, message: 'No edit access to this board' },
					{ cardId: 3, message: 'No answer from the server. The card may not have been archived.' }
				]
			});
			expect(sent).toEqual(['DELETE /api/cards/1', 'DELETE /api/cards/2', 'DELETE /api/cards/3']);
			expect(shown(state)[0]).toEqual([10, ['2:low', '3:low']]);
		} finally {
			state.dispose();
		}
	});

	it('bulk move moves the cards at once, setting their column, and puts them all back when the move is refused', async () => {
		const { state } = boardOfThree();
		try {
			vi.stubGlobal('fetch', async () => json(200, { success: true }));
			expect(await bulkActions.bulkMove(new Set([1, 3]), 20, 0, 9, 'owner', '👤', state)).toBeNull();
			expect(shown(state)).toEqual([
				[10, ['2:low']],
				[20, ['1:low', '3:low']]
			]);
			expect(state.columns[1].cards.map((k) => [k.columnId, k.position])).toEqual([
				[20, 0],
				[20, 1]
			]);

			vi.stubGlobal('fetch', async () => json(400, { message: 'At most 100 cards can be moved to another column at once' }));
			expect(await bulkActions.bulkMove(new Set([2]), 20, 2, 9, 'owner', '👤', state)).toBe('At most 100 cards can be moved to another column at once');
			expect(shown(state)[0]).toEqual([10, ['2:low']]);
		} finally {
			state.dispose();
		}
	});

	it('is said by the board page as the count and the first reason, the refused cards kept selected, and no read of its own', () => {
		const board = scriptOf('src/routes/board/[id]/+page.svelte');
		const priority = functionNamed(board, 'handleBulkPriority').getText().replace(/\/\/[^\n]*\n/g, '').replace(/\s+/g, ' ');
		expect(priority).toContain('const { failed } = await bulkOps.bulkPriority(selectedCards, priority, data.board.id, boardState);');
		expect(priority).toContain(
			"if (failed.length > 0) { toasts.add(`${failed.length} ${failed.length === 1 ? 'card' : 'cards'} not changed. ${failed[0].message}`, 'error', started); selectedCards = new Set(failed.map((f) => f.cardId)); } else { clearSelection(); }"
		);
		const archive = functionNamed(board, 'handleBulkDelete').getText().replace(/\s+/g, ' ');
		expect(archive).toContain('const { archived, failed } = await bulkOps.bulkDelete(selectedCards, data.board.id, boardState);');
		expect(archive).toContain('selectedCards = new Set(failed.map((f) => f.cardId));');
		for (const name of ['handleBulkMove', 'handleBulkDelete', 'handleBulkPriority']) {
			expect(callsOf(functionNamed(board, name), 'boardState.refresh'), name).toEqual([]);
		}
	});
});

describe('a drop onto Complete, src/lib/board/dnd-handlers.ts and the board page (card 2130’s review)', () => {
	// The board page leaves off a card the sub-boards the caller cannot open,
	// and the server still refuses to complete the card while they have open
	// cards. The page counted only the ones it showed, and threw the answer to
	// the move away: the card landed in Complete with its sound, and the next
	// reload put it back without a word.
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const answer = (status: number, body: unknown) =>
		new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	const card = (over: Partial<CardType> = {}) =>
		({ id: 7, columnId: 1, title: 'Ship it', subtasks: [], subBoards: [], onHoldNote: '', ...over }) as unknown as CardType;
	const columnsWith = (moving: CardType) =>
		[
			{ id: 1, title: 'In Progress', cards: [moving] },
			{ id: 2, title: 'Complete', cards: [] }
		] as unknown as ColumnType[];

	/** `moving` dropped onto Complete, with `fetch` answering each request with the next of `answers`; and what was sent. */
	async function drop(moving: CardType, answers: (Response | 'no answer')[] = []) {
		const sent: string[] = [];
		vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
			sent.push(`${init.method} ${url}`);
			const next = answers.shift();
			if (next === undefined || next === 'no answer') throw new TypeError('fetch failed');
			return next;
		});
		const result = await dndHandlers.handleCardDndFinalize(2, [moving], columnsWith(moving), 9, 'editor', '🦊');
		return { result, sent };
	}

	it('counts the open cards on sub-boards the caller cannot open, and stops the drop on them alone, offering none to open and sending nothing', async () => {
		const held = card({ hiddenOpenCount: 2 });
		expect(isCardBlocked(held)).toBe(true);
		expect(subBoardIncompleteCount(held)).toBe(2);

		const { result, sent } = await drop(held);
		expect(result).toEqual({
			action: 'blocked',
			blockedState: { show: true, card: held, incomplete: 2, reason: 'subboard', subBoardId: null }
		});
		expect(sent).toEqual([]);
	});

	it('offers to open a sub-board on the card that has open cards, and counts the hidden ones beside it', async () => {
		const held = card({
			subBoards: [
				{ id: 30, name: 'Finished', emoji: '🗂️', done: 2, total: 2 },
				{ id: 31, name: 'Site', emoji: '🗂️', done: 1, total: 3 }
			],
			hiddenOpenCount: 1
		});

		expect((await drop(held)).result).toMatchObject({ action: 'blocked', blockedState: { incomplete: 3, reason: 'subboard', subBoardId: 31 } });
	});

	it('moves a card that has nothing open once the server has taken it', async () => {
		const free = card({ hiddenOpenCount: 0 });
		const { result, sent } = await drop(free, [answer(200, { success: true })]);

		expect(result).toMatchObject({ action: 'committed', movedCards: [{ card: free, fromName: 'In Progress', toName: 'Complete', isComplete: true }] });
		expect(sent).toEqual(['PUT /api/cards/reorder']);
	});

	it('is refused in the server’s words when the server does not take the move, and says so when there is no answer', async () => {
		const said = 'Sub-board "Site" has 1 incomplete card that must be completed first';

		expect((await drop(card(), [answer(409, { message: said })])).result).toEqual({ action: 'refused', message: said });
		expect((await drop(card(), [new Response('<html>Bad gateway</html>', { status: 502 })])).result).toEqual({
			action: 'refused',
			message: 'The move was not saved.'
		});
		expect((await drop(card(), ['no answer'])).result).toEqual({
			action: 'refused',
			message: 'No answer from the server. The move may not have been saved.'
		});
	});

	it('is said by the board page through the shared toast, with the columns read again, and no sound', () => {
		const finalize = functionNamed(scriptOf('src/routes/board/[id]/+page.svelte'), 'handleCardDndFinalize');
		const clauses: ts.CaseClause[] = [];
		const visit = (node: ts.Node) => {
			if (ts.isCaseClause(node)) clauses.push(node);
			ts.forEachChild(node, visit);
		};
		visit(finalize);
		const refused = clauses.find((clause) => clause.expression.getText() === "'refused'");
		expect(refused).toBeDefined();
		const said = refused!.getText().replace(/\s+/g, ' ');

		expect(said).toContain("toasts.add(result.message, 'error', started);");
		// Put back from the columns as the drag found them, at once, and the board read once (card 2280, slice B2b).
		expect(said).toContain('boardState.columns = undoDrag(boardState.columns, from, dragged); boardState.refresh();');
		expect(said).not.toMatch(/Sound|queueCompletionPrompt/);
		// `started` is read before the move is sent, so a toast for a page since left is not shown.
		const text = finalize.getText();
		expect(text.indexOf('const started = toasts.navigation();')).toBeGreaterThan(-1);
		expect(text.indexOf('const started = toasts.navigation();')).toBeLessThan(text.indexOf('dndHandlers.handleCardDndFinalize('));
	});

	it('offers no sub-board to open when only ones the caller cannot open hold the card back', () => {
		const source = readFileSync(join(ROOT, 'src/routes/board/[id]/+page.svelte'), 'utf8');
		const start = source.indexOf('{#if blockedState.show}');
		const modal = source.slice(start, source.indexOf('{/if}', start)).replace(/\s+/g, ' ');

		expect(modal).toContain("confirmText={blockedState.subBoardId !== null ? 'Open Sub-board' : 'Open Card'}");
		// Whoever can give them the sub-board, or finish its cards, is the board's owner (the review's O-N5).
		expect(modal).toContain("on a sub-board you cannot open. All sub-board tasks must be completed first. Ask this board's owner.`");
		expect(modal).toContain('if (blockedState.subBoardId !== null) { window.location.href = `/board/${blockedState.subBoardId}`; } else { openCardModal(blockedState.card); }');
	});
});

describe('a drop out of On Hold, src/lib/board/dnd-handlers.ts (card 2208)', () => {
	// The server clears the note in the move now, by every route. The drop
	// sent a second request first to clear it, without reading its answer,
	// which wrote "Updated fields: onHoldNote" and sent `card.updated` beside
	// the move's own entry.
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('sends the move alone, and clears its own copy of the note', async () => {
		const held = { id: 7, columnId: 1, title: 'Paused', subtasks: [], subBoards: [], onHoldNote: 'waiting on X' } as unknown as CardType;
		const columns = [
			{ id: 1, title: 'On Hold', cards: [held] },
			{ id: 2, title: 'In Progress', cards: [] }
		] as unknown as ColumnType[];
		const sent: string[] = [];
		vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
			sent.push(`${init.method} ${url}`);
			return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'content-type': 'application/json' } });
		});

		const result = await dndHandlers.handleCardDndFinalize(2, [held], columns, 9, 'editor', '🦊');

		expect(sent).toEqual(['PUT /api/cards/reorder']);
		expect(result.action).toBe('committed');
		const moved = result.action === 'committed' ? result.updatedColumns.find((c) => c.id === 2)!.cards[0] : null;
		expect(moved?.onHoldNote).toBe('');
	});
});

describe('a drop sends the columns it touched, once, src/lib/board/dnd-handlers.ts and the board page (card 2213)', () => {
	// A drop sent every card of the board, from both zones: svelte-dnd-action
	// fires `finalize` on the zone dropped into and then on the zone the card
	// left. The second call found no card coming in, so it skipped the On Hold
	// note and the blocked-card check, and still sent the card in its new
	// column: Cancel on the On Hold note did not undo the move, and a blocked
	// card dropped onto Complete showed a red toast beside its window.
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	type Entry = { id: number; columnId: number; position: number };
	const card = (id: number, columnId: number) =>
		({ id, columnId, title: `Card ${id}`, subtasks: [], subBoards: [], onHoldNote: '' }) as unknown as CardType;
	/** Three columns of 3, 2 and 4 cards: 1-3 in To Do (1), 4-5 in In Progress (2), 6-9 in the third. */
	const board = (third = 'Review') =>
		[
			{ id: 1, title: 'To Do', cards: [card(1, 1), card(2, 1), card(3, 1)] },
			{ id: 2, title: 'In Progress', cards: [card(4, 2), card(5, 2)] },
			{ id: 3, title: third, cards: [card(6, 3), card(7, 3), card(8, 3), card(9, 3)] }
		] as unknown as ColumnType[];

	/** Each request's method, path and `updates`, with `fetch` answering 200. */
	function watchRequests() {
		const sent: { what: string; updates?: Entry[] }[] = [];
		vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
			const body = init.body ? JSON.parse(String(init.body)) : {};
			sent.push({ what: `${init.method} ${url}`, updates: body.updates });
			return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'content-type': 'application/json' } });
		});
		return sent;
	}

	it('sends the cards of the column dropped into and of the column the card came from, numbered from 0, and none of any other', async () => {
		const sent = watchRequests();
		const columns = board();
		const moving = columns[0].cards[1];
		// What the page holds as the target zone fires: the card has left To Do.
		columns[0].cards = [columns[0].cards[0], columns[0].cards[2]];

		const result = await dndHandlers.handleCardDndFinalize(2, [columns[1].cards[0], moving, columns[1].cards[1]], columns, 9, 'editor', '🦊');

		expect(result.action).toBe('committed');
		expect(sent.map((s) => s.what)).toEqual(['PUT /api/cards/reorder']);
		expect(sent[0].updates).toEqual([
			{ id: 1, columnId: 1, position: 0 },
			{ id: 3, columnId: 1, position: 1 },
			{ id: 4, columnId: 2, position: 0 },
			{ id: 2, columnId: 2, position: 1 },
			{ id: 5, columnId: 2, position: 2 }
		]);
	});

	it('sends a drop within one column as that column’s cards alone', async () => {
		const sent = watchRequests();
		const columns = board();
		const [six, seven, eight, nine] = columns[2].cards;

		await dndHandlers.handleCardDndFinalize(3, [nine, six, seven, eight], columns, 9, 'editor', '🦊');

		expect(sent.map((s) => s.updates)).toEqual([
			[
				{ id: 9, columnId: 3, position: 0 },
				{ id: 6, columnId: 3, position: 1 },
				{ id: 7, columnId: 3, position: 2 },
				{ id: 8, columnId: 3, position: 3 }
			]
		]);
	});

	it('holds a drop into On Hold back with the two touched columns alone, and sends them only when the note is confirmed', async () => {
		const sent = watchRequests();
		const columns = board();
		const moving = columns[0].cards[0];
		columns[0].cards = columns[0].cards.slice(1);

		const result = await dndHandlers.handleCardDndFinalize(2, [moving, ...columns[1].cards], columns.map((c) =>
			c.id === 2 ? { ...c, title: 'On Hold' } : c
		), 9, 'editor', '🦊');

		expect(result.action).toBe('on-hold');
		expect(sent).toEqual([]);
		const held = result.action === 'on-hold' ? result.onHoldState : null;
		const expected = [
			{ id: 2, columnId: 1, position: 0 },
			{ id: 3, columnId: 1, position: 1 },
			{ id: 1, columnId: 2, position: 0 },
			{ id: 4, columnId: 2, position: 1 },
			{ id: 5, columnId: 2, position: 2 }
		];
		expect(held?.pendingUpdates).toEqual(expected);

		// The move first, and the note once it is taken (card 2280, slice B2b; R7).
		expect(await dndHandlers.confirmOnHold({ ...held!, note: 'waiting on X' }, 9, 'editor', '🦊')).toEqual({ failure: null, noteFailure: null });
		expect(sent.map((s) => s.what)).toEqual(['PUT /api/cards/reorder', 'PUT /api/cards/1']);
		expect(sent[0].updates).toEqual(expected);
	});

	// Card 2280, slice B2b: the note was sent first and neither answer read, so
	// a refused move left a note on a card that never moved, and said nothing.
	it('sends no note for a move refused or unanswered, and says a note refused after the move was taken apart from the move', async () => {
		const held = { show: true, cardId: 1, cardTitle: 'Card 1', note: 'waiting on X', pendingUpdates: [{ id: 1, columnId: 2, position: 0 }], pendingColumnId: 2 };
		const answering = (byRequest: Record<string, () => Response>) => {
			const sent: string[] = [];
			vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
				const what = `${init.method} ${url}`;
				sent.push(what);
				return byRequest[what]();
			});
			return sent;
		};
		const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

		let sent = answering({ 'PUT /api/cards/reorder': () => json(403, { message: 'Viewers cannot move cards' }) });
		expect(await dndHandlers.confirmOnHold(held, 9, 'viewer', '🦊')).toEqual({ failure: 'Viewers cannot move cards', noteFailure: null });
		expect(sent).toEqual(['PUT /api/cards/reorder']);

		sent = answering({
			'PUT /api/cards/reorder': () => {
				throw new TypeError('fetch failed');
			}
		});
		expect(await dndHandlers.confirmOnHold(held, 9, 'editor', '🦊')).toEqual({ failure: 'No answer from the server. The card may not have been put on hold.', noteFailure: null });
		expect(sent).toEqual(['PUT /api/cards/reorder']);

		answering({ 'PUT /api/cards/reorder': () => json(200, { success: true }), 'PUT /api/cards/1': () => json(400, { message: 'onHoldNote is at most 2000 characters' }) });
		expect(await dndHandlers.confirmOnHold(held, 9, 'editor', '🦊')).toEqual({ failure: null, noteFailure: 'onHoldNote is at most 2000 characters' });
		answering({
			'PUT /api/cards/reorder': () => json(200, { success: true }),
			'PUT /api/cards/1': () => {
				throw new TypeError('fetch failed');
			}
		});
		expect(await dndHandlers.confirmOnHold(held, 9, 'editor', '🦊')).toEqual({ failure: null, noteFailure: 'No answer from the server, so the note may not have been saved.' });

		// The move taken already (the window kept for the note): the note alone is sent again.
		sent = answering({ 'PUT /api/cards/1': () => json(200, { id: 1, onHoldNote: 'waiting on X' }) });
		expect(await dndHandlers.confirmOnHold({ ...held, pendingUpdates: [] }, 9, 'editor', '🦊')).toEqual({ failure: null, noteFailure: null });
		expect(sent).toEqual(['PUT /api/cards/1']);
	});

	it('called as the zone the card left, with its shadow already in On Hold, names no card outside that zone', async () => {
		const sent = watchRequests();
		const columns = board('On Hold');
		const moving = columns[0].cards[0];
		// The origin zone's `finalize` comes after the target's: the page's On
		// Hold column still holds the shadow item, which carries the card's id.
		columns[0].cards = columns[0].cards.slice(1);
		columns[2].cards = [{ ...moving, isDndShadowItem: true } as CardType, ...columns[2].cards];

		await dndHandlers.handleCardDndFinalize(1, columns[0].cards, columns, 9, 'editor', '🦊');

		for (const request of sent) {
			expect(request.updates?.every((u) => u.columnId === 1)).toBe(true);
			expect(request.updates?.map((u) => u.id)).not.toContain(moving.id);
		}
	});

	it('is not called by the board page for the zone the card left: that zone takes its items and sends nothing', () => {
		const finalize = functionNamed(scriptOf('src/routes/board/[id]/+page.svelte'), 'handleCardDndFinalize');
		const text = finalize.getText().replace(/\s+/g, ' ');

		const leaving = text.indexOf('if (e.detail.info?.trigger === TRIGGERS.DROPPED_INTO_ANOTHER) {');
		expect(leaving).toBeGreaterThan(-1);
		expect(leaving).toBeLessThan(text.indexOf('dndHandlers.handleCardDndFinalize('));
		const branch = text.slice(leaving, text.indexOf('}', text.indexOf('return;', leaving)) + 1);
		// Its items only: `handleCardDndConsider` would hold the reads for a drag already over (card 2280, slice B2a).
		expect(branch).toContain('takeCardItems(columnId, e);');
		expect(branch).toContain('return;');
		expect(branch).not.toMatch(/api\.|dndHandlers\.|toasts\.|invalidateAll/);

		const source = readFileSync(join(ROOT, 'src/routes/board/[id]/+page.svelte'), 'utf8');
		expect(source).toMatch(/import \{[^}]*\bTRIGGERS\b[^}]*\} from 'svelte-dnd-action';/);
	});
});

describe('the share window’s role select, src/lib/components/ShareModal.svelte (card 2115’s review)', () => {
	// The share route makes nobody an owner now (card 2117's readers, card
	// 2115's guard): `owner` is refused to anyone not already stored as one.
	// The window offered Owner on every person's row and threw the answer
	// away, so the choice snapped back on the next read and nothing was said.
	// The minimal part of card 2148's decision 13. Card 2148 then moved what a
	// refusal says from the toast to the window's own line, as the window's
	// other writes say theirs (its decision 11).
	const file = 'src/lib/components/ShareModal.svelte';
	const source = readFileSync(join(ROOT, file), 'utf8');
	const markup = source.slice(source.indexOf('</script>'));
	const updateRole = functionNamed(scriptOf(file), 'updateRole');

	it('offers Owner only on a row already stored as owner, and never for a team or a new share', () => {
		expect(markup.match(/<option value="owner">/g)).toHaveLength(1);
		expect(markup).toMatch(/\{#if member\.role === 'owner'\}\s*<option value="owner">Owner<\/option>\s*\{\/if\}/);
	});

	it('hands updateRole the select itself, from both lists, so that it can be put back', () => {
		const given = [...markup.matchAll(/updateRole\(([^)]*)\)/g)].map((call) => call[1]);

		expect(given).toEqual(["'user', member.userId, e.currentTarget", "'team', team.teamId, e.currentTarget"]);
	});

	it('says what the server said, and puts the select back, for a refusal only; reads the list again for a success only', () => {
		const asked = callsOf(updateRole, 'failureMessage');
		expect(asked).toHaveLength(1);
		expect(sideOf(asked[0])).toBe('failed');

		const putBack = statementsOf(updateRole, 'putBack()');
		expect(putBack.map(sideOf)).toEqual(['failed', 'failed']);
		// For a refusal, and not only for a request that got no answer.
		expect(putBack.some((statement) => ts.findAncestor(statement, ts.isCatchClause) === undefined)).toBe(true);

		expect(statementsOf(updateRole, 'await loadData()').map(sideOf)).toEqual(['ok']);
		expect(callsOf(updateRole, 'res.json')).toEqual([]);
	});

	it('says each failure on the window’s own line, which it clears as it starts (card 2148)', () => {
		const said = assignmentsTo(updateRole, 'error');
		expect(said.map((set) => set.right.getText())).toEqual([
			"''",
			"'No answer from the server. The role may not have been changed.'",
			"await failureMessage(res, 'The role was not changed.')"
		]);
		expect(said.map(sideOf)).toEqual([null, 'failed', 'failed']);
		expect(callsOf(updateRole, 'toasts.add')).toEqual([]);

		// The request is asked in a try whose catch says so, after the line is cleared.
		const [request] = callsOf(updateRole, 'fetch');
		const tried = ts.findAncestor(request, ts.isTryStatement);
		expect(tried?.catchClause).toBeDefined();
		expect(said[0].getStart()).toBeLessThan(tried!.getStart());
	});
});

// ─── A refusal said where it is read (card 2148) ────────────────────────────
//
// The share window, the subtask window, the dashboard and the account page
// threw some answers away and read others without saying anything. The table
// of writes above holds that each reads its answer and puts back what it
// changed. These hold where what it read is shown (the plan's decision 11):
// on a line in the share and subtask windows, above their buttons, as the
// card window shows its failures; in the dashboard's shared toast, which it
// already used for a failed delete; and on the account page on a line under
// the control, as its email, password and key forms have.

/**
 * What the message a call reads is given to: `error` for
 * `error = await failureMessage(...)`, and `failureToasts.add(…, 'error',
 * started)` for a toast, `…` standing for the message.
 */
function givenTo(asked: ts.CallExpression): string {
	let at: ts.Node = asked;
	while (ts.isAwaitExpression(at.parent) || ts.isParenthesizedExpression(at.parent)) at = at.parent;
	const user = at.parent;
	if (ts.isBinaryExpression(user) && user.right === at) return user.left.getText();
	if (ts.isCallExpression(user)) return `${user.expression.getText()}(${user.arguments.map((argument) => (argument === at ? '…' : argument.getText())).join(', ')})`;
	return `(${user.getText()})`;
}

/** A Svelte file's script, parsed, its source, and where in its markup a text is, by the `{#if}` blocks around it. */
function svelteFile(file: string) {
	const source = readFileSync(join(ROOT, file), 'utf8');
	const from = source.indexOf('</script>');
	const markup = source.slice(from);
	return {
		tree: scriptOf(file),
		source,
		markup,
		around: (text: string) => {
			expect(markup.split(text), text).toHaveLength(2);
			return blocksAround(source, from + markup.indexOf(text));
		}
	};
}

// Card 2185. The subtask window offered a colour tag that was stored and drawn
// nowhere but in the picker itself, which put the stored value into a
// `style` attribute unchecked. The picker is gone, and the window sends no
// `colorTag`, so a colour set through the API is kept by a save there. That
// the route keeps it is run in `tests/card-updates.test.ts`.
describe('the subtask window offers no colour, src/lib/components/SubtaskModal.svelte (card 2185)', () => {
	it('has no colour tag in its script or its markup, and sends none', () => {
		const subtask = svelteFile('src/lib/components/SubtaskModal.svelte');

		expect(subtask.tree.getText()).not.toMatch(/colorTag/);
		expect(subtask.markup).not.toContain('type="color"');
		expect(subtask.markup).not.toContain('Color Tag');
		expect(subtask.markup).not.toMatch(/color-tag|color-custom|color-native/);

		const declared = subtask.tree.statements
			.filter(ts.isVariableStatement)
			.flatMap((statement) => statement.declarationList.declarations);
		const payload = ts.forEachChild(functionNamed(subtask.tree, 'save'), function find(node): ts.VariableDeclaration | undefined {
			if (ts.isVariableDeclaration(node) && node.name.getText() === 'payload') return node;
			return ts.forEachChild(node, find);
		});
		expect(declared.map((declaration) => declaration.name.getText())).not.toContain('colorTags');
		expect(payload?.initializer && ts.isObjectLiteralExpression(payload.initializer)).toBe(true);
		const keys = (payload!.initializer as ts.ObjectLiteralExpression).properties.map((property) => property.name?.getText());
		expect(keys).toEqual(['title', 'description', 'priority', 'dueDate', 'completed', 'boardId']);
	});
});

describe('the share and subtask windows, the dashboard and the account page say a refusal where it is read (card 2148)', () => {
	it('the share window says a failed load or write on its own line, above Close, and clears it as each write starts', () => {
		const share = svelteFile('src/lib/components/ShareModal.svelte');
		const WRITING = ['togglePublic', 'shareWithUser', 'shareWithTeam', 'updateRole', 'removeAccess'];

		for (const name of ['loadData', ...WRITING.filter((write) => write !== 'removeAccess')]) {
			const asked = callsOf(functionNamed(share.tree, name), 'failureMessage');
			expect(asked.length, name).toBeGreaterThan(0);
			expect(asked.map(givenTo), name).toEqual(asked.map(() => 'error'));
		}
		// A removal's words are deleteFailure's.
		expect(statementsOf(functionNamed(share.tree, 'removeAccess'), 'error = failure')).toHaveLength(1);
		// Cleared before each write asks, so a success leaves no failure behind it.
		for (const name of WRITING) {
			const fn = functionNamed(share.tree, name);
			const cleared = statementsOf(fn, "error = ''");
			expect(cleared, name).toHaveLength(1);
			const asking = [...callsOf(fn, 'fetch'), ...callsOf(fn, 'deleteFailure')].map((call) => call.getStart());
			expect(cleared[0].getStart(), name).toBeLessThan(Math.min(...asking));
		}
		// Drawn once, in `{#if error}` alone, so that a load that failed is said too, before the footer.
		expect(share.around('{error}')).toEqual([{ condition: 'error', inElse: false }]);
		expect(share.markup).toMatch(/\{#if error\}\s*<div class="share-error" role="alert">\s*<span>\{error\}<\/span>/);
		expect(share.markup.indexOf('{error}')).toBeLessThan(share.markup.indexOf('<div class="share-footer">'));
		expect(share.tree.getText()).not.toMatch(/\btoasts\./);
	});

	it('the subtask window says a refused save or delete above its buttons, and does not close for one', () => {
		const subtask = svelteFile('src/lib/components/SubtaskModal.svelte');

		expect(callsOf(functionNamed(subtask.tree, 'save'), 'failureMessage').map(givenTo)).toEqual(['error', 'error']);
		expect(statementsOf(functionNamed(subtask.tree, 'handleDelete'), 'error = failure')).toHaveLength(1);
		// The window is closed by the card window's onSave and onDelete, which are called for a success alone.
		for (const name of ['save', 'handleDelete']) expect(callsOf(functionNamed(subtask.tree, name), 'onClose'), name).toEqual([]);
		expect(subtask.around('{error}')).toEqual([{ condition: 'error', inElse: false }]);
		expect(subtask.markup).toMatch(/\{#if error\}\s*<div class="subtask-error" role="alert">\s*<span>\{error\}<\/span>/);
		expect(subtask.markup.indexOf('{error}')).toBeLessThan(subtask.markup.indexOf('<div class="modal-actions">'));
	});

	it('the subtask window takes a subtask off the card once the server has deleted it, or at once for a card not yet made', () => {
		const deleting = functionNamed(svelteFile('src/lib/components/SubtaskModal.svelte').tree, 'handleDelete');
		const asked = callsOf(deleting, 'deleteFailure');
		const removed = statementsOf(deleting, 'onDelete()');

		expect(asked).toHaveLength(1);
		expect(removed).toHaveLength(2);
		// A card not yet made: its subtasks are on the page alone, with ids below
		// zero, and nothing is sent, as `save` sends nothing for one.
		expect(ts.findAncestor(removed[0], ts.isIfStatement)?.expression.getText()).toBe('cardId === 0');
		expect(removed[0].getStart()).toBeLessThan(asked[0].getStart());
		// Any other: after the request, and only when deleteFailure said there was no failure.
		expect(removed[1].getStart()).toBeGreaterThan(asked[0].getStart());
		expect(sideOf(removed[1])).toBe('ok');
	});

	it('the dashboard says each refusal in the shared toast, and a sub-board’s on its form’s line, in the server’s words', () => {
		// Each in the component that now sends it (card 2281, slice C2).
		const menu = svelteFile('src/lib/components/dashboard/BoardContextMenu.svelte');
		const holder: Record<string, ReturnType<typeof svelteFile>> = {
			createBoard: svelteFile('src/lib/components/dashboard/CreateBoardModal.svelte'),
			toggleFavourite: svelteFile('src/lib/components/dashboard/BoardsTable.svelte'),
			setBoardCategory: menu,
			createBoardCategoryInline: menu
		};

		for (const name of ['createBoard', 'toggleFavourite', 'setBoardCategory', 'createBoardCategoryInline']) {
			const asked = callsOf(functionNamed(holder[name].tree, name), 'failureMessage');
			expect(asked.length, name).toBeGreaterThan(0);
			expect(asked.map(givenTo), name).toEqual(asked.map(() => "failureToasts.add(…, 'error', started)"));
		}
		const dashboard = menu;
		const subBoard = callsOf(functionNamed(dashboard.tree, 'createSubBoardInline'), 'failureMessage');
		expect(subBoard.map(givenTo)).toEqual(['subBoardError', 'subBoardError']);
		// Its two texts as they were, for an answer that gives no reason.
		expect(subBoard.map((asked) => asked.arguments[1].getText())).toEqual(["'Could not create the parent card'", "'Could not create the sub-board'"]);
		expect(dashboard.around('{subBoardError}').at(-1)).toEqual({ condition: 'subBoardError', inElse: false });
	});

	it('the account page says each refusal on a line under its control', () => {
		const account = svelteFile('src/routes/account/+page.svelte');
		const said = (name: string) => callsOf(functionNamed(account.tree, name), 'failureMessage').map(givenTo);

		expect(said('changeEmoji')).toEqual(['emojiError']);
		expect(said('toggleNotif')).toEqual(['notifError']);
		expect(said('revokeKey')).toEqual(['apiKeyError']);
		expect(said('changeEmail')).toEqual(['emailMessage']);
		// A failure's body is no longer read as JSON with a catch of its own.
		expect(callsOf(functionNamed(account.tree, 'changeEmail'), 'res.json').map(sideOf)).toEqual(['ok']);

		// The avatar's line under the avatar, the switches' under the switches.
		expect(account.around('{emojiError}')).toEqual([{ condition: 'emojiError', inElse: false }]);
		expect(account.markup).toMatch(/\{#if emojiError\}\s*<div class="password-msg error avatar-error" role="alert">\{emojiError\}<\/div>/);
		const avatar = account.markup.indexOf('{emojiError}');
		expect(avatar).toBeGreaterThan(account.markup.indexOf('<EmojiPicker'));
		expect(avatar).toBeLessThan(account.markup.indexOf('<div class="profile-details">'));
		expect(account.around('{notifError}')).toEqual([
			{ condition: 'notifLoading', inElse: true },
			{ condition: 'notifError', inElse: false }
		]);
		expect(account.markup).toMatch(/\{#if notifError\}\s*<div class="password-msg error notif-error" role="alert">\{notifError\}<\/div>/);
		expect(account.markup.indexOf('{notifError}')).toBeGreaterThan(account.markup.indexOf('{#each NOTIFICATION_PREFS as type}'));
		// No second save while one is on its way, which a refusal of the first would put back over.
		expect(account.markup.match(/disabled=\{notifSaving\b/g)).toHaveLength(2);
	});

	it('the account page draws its mail switches from the one list in $lib/notification-prefs, Mentions among them (card 2146)', () => {
		const account = svelteFile('src/routes/account/+page.svelte');
		const toggling = functionNamed(account.tree, 'toggleNotif').getText();

		expect(account.tree.getText()).toContain("import { MASTER_PREF, NOTIFICATION_PREFS, type NotificationPrefKey } from '$lib/notification-prefs';");
		// No list of its own, and no key of its own.
		expect(account.source).not.toContain('NOTIF_TYPES');
		expect(account.source).not.toMatch(/['"]email_\w+['"]/);
		expect(account.markup.match(/\{#each NOTIFICATION_PREFS as type\}/g)).toHaveLength(1);
		// The list says `description`, where the page's own said `desc`.
		expect(account.markup).toContain('<span class="notif-hint">{type.description}</span>');
		expect(account.markup).toContain('onclick={() => toggleNotif(type.key)}');
		expect(account.markup).toContain('onclick={() => toggleNotif(MASTER_PREF)}');
		// The master switch sets every kind of the list, Mentions and Request Progress with the rest.
		expect(toggling.match(/for \(const t of NOTIFICATION_PREFS\)/g)).toHaveLength(2);
		expect(NOTIFICATION_PREFS.map((kind) => kind.label)).toEqual(expect.arrayContaining(['Mentions', 'Request Progress']));
		// A switch is on unless it is stored as false, as it is drawn, so its first click turns it off.
		expect(toggling).toContain('const newVal = notifPrefs[key] === false;');
	});
});

// ─── A page left open across a deploy (card 2167) ───────────────────────────
//
// An open tab ran the old scripts until it was reloaded by hand: SvelteKit
// never asked whether there was a new version. It asks once a minute now, and
// the root layout says so when there is one, and makes the next move to
// another page a full page load. Nothing reloads by itself.

/** Where the root layout's `<div class="app-layout">` ends, in its markup: past its own `</div>`. */
function appLayoutEnd(markup: string): number {
	const start = markup.indexOf('<div class="app-layout">');
	expect(start).toBeGreaterThan(-1);
	let depth = 0;
	for (const tag of markup.slice(start).matchAll(/<div[\s>]|<\/div>/g)) {
		depth += tag[0] === '</div>' ? -1 : 1;
		if (depth === 0) return start + tag.index! + tag[0].length;
	}
	throw new Error('.app-layout is not closed');
}

describe('a page left open across a deploy, svelte.config.js and src/routes/+layout.svelte (card 2167)', () => {
	const layout = svelteFile('src/routes/+layout.svelte');
	const BAR = '<div class="update-bar" role="status" bind:offsetHeight={barHeight}>';

	it('asks for a new version once a minute, the version being the time of the build', async () => {
		const { default: config } = await import('../svelte.config.js');

		expect(config.kit?.version?.pollInterval).toBe(60_000);
		expect(config.kit?.version?.name).toBeUndefined();
	});

	it('imports updated from $app/state and beforeNavigate from $app/navigation', () => {
		expect(layout.tree.getText()).toContain("import { beforeNavigate } from '$app/navigation';");
		expect(layout.tree.getText()).toContain("import { updated } from '$app/state';");
	});

	it('shows the bar while there is a new version, with a Reload button, and reloads nowhere else', () => {
		expect(layout.around(BAR)).toEqual([{ condition: 'updated.current', inElse: false }]);
		expect(layout.markup).toContain('<span>DumpFire has been updated. Save anything you are editing, then reload to use the new version.</span>');
		expect(layout.markup).toContain('<button type="button" class="update-bar-reload" onclick={() => location.reload()}>Reload</button>');
		expect(layout.source.match(/location\.reload\(/g)).toHaveLength(1);
	});

	it('makes a move to another page a full page load once there is one, by SvelteKit’s documented pattern', () => {
		const calls = callsOf(layout.tree, 'beforeNavigate');

		expect(calls).toHaveLength(1);
		// Called as the script runs, not in onMount or an effect.
		expect(layout.tree.statements.some((statement) => ts.isExpressionStatement(statement) && statement.expression === calls[0])).toBe(true);
		expect(calls[0].arguments[0].getText().replace(/\s+/g, ' ')).toBe(
			'({ willUnload, to }) => { if (updated.current && !willUnload && to?.url) { location.href = to.url.href; } }'
		);
	});

	it('draws the bar above every other layer, every page’s windows and the toast among them', () => {
		const layers = [...filesUnder('src', '.svelte'), ...filesUnder('src', '.css')].flatMap((file) =>
			[...readFileSync(join(ROOT, file), 'utf8').matchAll(/z-index:\s*(\d+)/g)].map((found) => Number(found[1]))
		);
		const bar = Number(/\.update-bar \{[^}]*z-index:\s*(\d+)/.exec(layout.source)?.[1]);

		expect(layers.length).toBeGreaterThan(20);
		expect(layers.filter((z) => z >= bar)).toEqual([bar]);
		// And outside .app-layout, whose own z-index keeps everything a page draws beneath anything outside it.
		expect(layout.markup.indexOf('{#if updated.current}')).toBeGreaterThan(appLayoutEnd(layout.markup));
	});
});

// ─── The review of group Q-F (cards 2143 to 2167), its fixes ────────────────

describe('the user badge, the update bar, the avatar and the subtask window’s Save (the review of group Q-F)', () => {
	const layout = svelteFile('src/routes/+layout.svelte');

	it('draws the user badge inside .app-layout, with the pages’ windows and beneath them, where it was drawn above every one', () => {
		const badge = layout.markup.indexOf('<div class="user-badge glass">');
		const page = layout.markup.indexOf('<div class="app-layout">');
		expect(badge).toBeGreaterThan(page);
		expect(badge).toBeLessThan(appLayoutEnd(layout.markup));
		expect(layout.markup.match(/class="user-badge glass"/g)).toHaveLength(1);
		// Beneath every window: each `.modal-overlay` is at 1000 or more.
		const z = Number(/\.user-badge \{[^}]*z-index:\s*(\d+)/.exec(layout.source)?.[1]);
		expect(z).toBeLessThan(1000);
		expect(Number(/\.modal-overlay \{[^}]*z-index:\s*(\d+)/.exec(readFileSync(join(ROOT, 'src/app.css'), 'utf8'))?.[1])).toBe(1000);
	});

	// Card 2239. The badge had only the global .glass's background, 2 to 6%
	// opaque in every theme, and the Live Console's footer on the audit page, a
	// page of the window's height that does not scroll, read through it.
	it('draws the user badge opaque in every theme, and ends each page, or its scroll, above it (card 2239)', () => {
		const css = readFileSync(join(ROOT, 'src/app.css'), 'utf8');
		const badge = /\.user-badge,\s*\.user-badge:hover \{([^}]*)\}/.exec(layout.source)?.[1] ?? '';
		expect(badge).toContain('background: var(--bg-elevated);');
		expect(badge).toContain('box-shadow: var(--shadow-md);');
		expect(/\.glass \{([^}]*)\}/.exec(css)![1]).toContain('background: var(--glass-bg);');
		// Each theme's block (the one that sets --glass-bg) gives --bg-elevated as a solid colour.
		const themes = [...css.matchAll(/(:root|html\[data-theme="[a-z]+"\]) \{([^}]*)\}/g)].filter((m) => m[2].includes('--glass-bg:'));
		expect(themes).toHaveLength(17);
		for (const [, theme, body] of themes) {
			expect(body, theme).toMatch(/--bg-elevated: #[0-9a-f]{6};/);
			expect(body, theme).toMatch(/--shadow-md: /);
		}
		// How far up a page's foot has to stop: the badge's own bottom, its height and a gap, the update bar included.
		// The height follows the root font size: 18px of padding and border, and the taller of the sign-out
		// button (28px) and the emoji's line (1.2rem at line-height 1.5).
		expect(/\.app-layout \{([^}]*)\}/.exec(layout.source)![1]).toContain(
			'--user-badge-space: calc(var(--space-lg) + 18px + max(28px, 1.8rem) + var(--space-sm) + var(--update-bar-space, 0px));'
		);
		expect(/\.user-badge-emoji \{([^}]*)\}/.exec(layout.source)![1]).toContain('font-size: 1.2rem;');
		expect(/\.user-badge-logout \{([^}]*)\}/.exec(layout.source)![1]).toContain('height: 28px;');
		const rules: [string, RegExp, string][] = [
			['src/routes/audit/+page.svelte', /\.audit-page \{([^}]*)\}/, 'padding: var(--space-md) var(--space-lg) var(--user-badge-space);'],
			['src/routes/board/[id]/+page.svelte', /\.column-cards \{([^}]*)\}/, 'padding: 0 var(--space-md) var(--user-badge-space);'],
			['src/lib/components/board/ColumnListView.svelte', /\.list-view \{([^}]*)\}/, 'padding: var(--space-lg) var(--space-lg) var(--user-badge-space);'],
			['src/routes/all/+page.svelte', /\.card-list \{([^}]*)\}/, 'padding: 0 var(--space-md) var(--user-badge-space);'],
			['src/routes/todo/+page.svelte', /\.todo-page \{([^}]*)\}/, 'padding: 0 var(--space-xl) var(--user-badge-space);'],
			['src/routes/plan/[id]/+page.svelte', /\.plan-body \{([^}]*)\}/, 'padding: var(--space-xl) var(--space-xl) var(--user-badge-space);'],
			['src/routes/archived/+page.svelte', /\.archived-page \{([^}]*)\}/, 'padding: 0 var(--space-xl) var(--user-badge-space);'],
			['src/routes/admin/+page.svelte', /\.admin-content \{([^}]*)\}/, 'padding: var(--space-2xl) var(--space-2xl) var(--user-badge-space);'],
			['src/routes/reports/+page.svelte', /\.reports-content \{([^}]*)\}/, 'padding: var(--space-xl) var(--space-xl) var(--user-badge-space);'],
			['src/routes/inbox/+page.svelte', /\.inbox-content \{([^}]*)\}/, 'padding: var(--space-2xl) var(--space-2xl) var(--user-badge-space);'],
			['src/routes/+page.svelte', /\.dashboard \{([^}]*)\}/, 'padding: var(--space-xl) var(--space-xl) var(--user-badge-space);'],
			['src/routes/account/+page.svelte', /\.account-content \{([^}]*)\}/, 'padding: var(--space-2xl) var(--space-2xl) var(--user-badge-space);'],
			// The API docs' sidebar scrolls within the window's height, so its last entries sat under the badge.
			['src/routes/docs/+page.svelte', /\.docs-sidebar \{([^}]*)\}/, 'padding: var(--space-xl) var(--space-lg) var(--user-badge-space);']
		];
		for (const [file, rule, padding] of rules) {
			expect(rule.exec(readFileSync(join(ROOT, file), 'utf8'))?.[1], file).toContain(padding);
		}
		// The two pages whose narrow-window rule sets the padding again keep the space there too.
		for (const file of ['src/routes/plan/[id]/+page.svelte', 'src/routes/reports/+page.svelte']) {
			expect(readFileSync(join(ROOT, file), 'utf8'), file).toContain('{ padding: var(--space-md) var(--space-md) var(--user-badge-space); }');
		}
	});

	it('puts the update bar at the foot of the screen, and keeps the windows, the toast and the badge clear of it while it shows', () => {
		const bar = /\.update-bar \{([^}]*)\}/.exec(layout.source)![1];
		expect(bar).toMatch(/\bbottom: 0;/);
		expect(bar).not.toMatch(/\btop:/);
		// Its height, measured, is set on the page's root while it shows, and nothing otherwise.
		expect(layout.markup).toContain('<div class="update-bar" role="status" bind:offsetHeight={barHeight}>');
		expect(layout.tree.getText()).toContain("document.documentElement.style.setProperty('--update-bar-space', updated.current ? `${barHeight}px` : '0px');");
		// And each of them keeps clear of it by that much.
		expect(/\.modal-overlay \{([^}]*)\}/.exec(readFileSync(join(ROOT, 'src/app.css'), 'utf8'))![1]).toContain('padding-bottom: var(--update-bar-space, 0px);');
		expect(readFileSync(join(ROOT, 'src/lib/components/Toast.svelte'), 'utf8')).toContain('bottom: calc(24px + var(--update-bar-space, 0px));');
		expect(/\.user-badge \{([^}]*)\}/.exec(layout.source)![1]).toContain('bottom: calc(var(--space-lg) + var(--update-bar-space, 0px));');
	});

	it('reads the page’s data again once a new avatar is kept, so that the badge shows it without a reload, and only then', () => {
		const account = svelteFile('src/routes/account/+page.svelte');
		const changing = functionNamed(account.tree, 'changeEmoji');

		expect(account.tree.getText()).toContain("import { invalidateAll } from '$app/navigation';");
		const read = statementsOf(changing, 'await invalidateAll()');
		expect(read).toHaveLength(1);
		expect(sideOf(read[0])).toBe('ok');
		// The badge draws the layout's user, which `invalidateAll` loads again.
		expect(layout.tree.getText()).toContain('let user = $derived($page.data.user);');
		expect(layout.markup).toContain('<span class="user-badge-emoji">{user.emoji}</span>');
	});

	it('disables the avatar picker while a change is on its way, as the mail switches are', () => {
		const account = svelteFile('src/routes/account/+page.svelte');
		const changing = functionNamed(account.tree, 'changeEmoji');
		const steps = changing.body!.statements.map((statement) => statement.getText());

		expect(steps[0]).toBe('if (savingEmoji) return;');
		expect(account.markup).toContain('<EmojiPicker value={currentEmoji} onSelect={(e) => changeEmoji(e)} disabled={savingEmoji} />');
		const picker = readFileSync(join(ROOT, 'src/lib/components/EmojiPicker.svelte'), 'utf8');
		expect(picker).toContain('disabled = false }: { value?: string; onSelect: (emoji: string) => void; disabled?: boolean } = $props();');
		expect(picker).toMatch(/<button class="emoji-trigger" bind:this=\{triggerEl\} onclick=\{togglePicker\} type="button" \{disabled\}>/);
	});

	it('disables the subtask window’s Save while a save is on its way, so a double click makes one subtask', () => {
		const subtask = svelteFile('src/lib/components/SubtaskModal.svelte');
		const saving = functionNamed(subtask.tree, 'save');
		const steps = saving.body!.statements;

		expect(steps[0].getText()).toBe('if (!title.trim() || saving) return;');
		// Set before the request, and cleared in a `finally`, whatever the answer.
		const set = statementsOf(saving, 'saving = true');
		expect(set).toHaveLength(1);
		expect(set[0].getStart()).toBeLessThan(Math.min(...callsOf(saving, 'fetch').map((call) => call.getStart())));
		const tried = steps.find((step): step is ts.TryStatement => ts.isTryStatement(step))!;
		expect(tried.finallyBlock?.statements.map((statement) => statement.getText())).toEqual(['saving = false;']);
		expect(subtask.markup).toContain('onclick={save} disabled={!title.trim() || saving}>');
	});
});

// Card 2281, slice C1b: the rows are in the users panel, a component of the admin page.
describe('the admin page’s user rows, src/lib/components/admin/UsersPanel.svelte', () => {
	const file = 'src/lib/components/admin/UsersPanel.svelte';
	const source = readFileSync(join(ROOT, file), 'utf8');
	const from = source.indexOf('</script>');
	const markup = source.slice(from);
	const around = (text: string) => {
		expect(markup.split(text), text).toHaveLength(2);
		return blocksAround(source, from + markup.indexOf(text));
	};
	const RULE = 'mayManageAccount(data.currentUser, u)';
	const NOT_OWN = 'u.id !== data.currentUser.id';

	it('shows the role select, the invite and the delete only where the rule lets the caller use them, and never on their own row', () => {
		for (const control of [
			'onchange={(e) => chooseUserRole(u.id, e.currentTarget)}',
			'onclick={() => changeUserRole(u.id, u.username)}',
			'onclick={(e) => resendInvite(u.id, e.currentTarget)}',
			'() => deleteUser(u.id))}'
		]) {
			const blocks = around(control);
			expect(blocks.some((block) => block.condition === RULE && !block.inElse), control).toBe(true);
			expect(blocks.some((block) => block.condition === NOT_OWN && !block.inElse), control).toBe(true);
		}
	});

	it('shows 🔑 where the rule lets the caller use it, their own row included, and 🔒 everywhere else', () => {
		const key = around('onclick={() => resetDialog?.openResetDialog(u.id)} title="Reset password">🔑</button>');
		expect(key.some((block) => block.condition === RULE && !block.inElse)).toBe(true);
		expect(key.some((block) => block.condition === NOT_OWN)).toBe(false);

		const lock = around('<span class="superadmin-lock"');
		expect(lock.some((block) => block.condition === RULE && block.inElse)).toBe(true);
	});

	it('asks the one rule the server asks, which the page’s users panel and the guard import', () => {
		expect(scriptOf(file).getText()).toContain("import { mayManageAccount } from '$lib/account-rule';");
		const guard = readFileSync(join(ROOT, 'src/lib/server/route-guards.ts'), 'utf8');
		expect(guard).toContain("import { mayManageAccount } from '$lib/account-rule';");
		expect(guard).toContain('if (!mayManageAccount(caller, target)) {');
		// The admin page's load asks it too, for which rows get a count of keys.
		expect(readFileSync(join(ROOT, 'src/routes/admin/+page.server.ts'), 'utf8')).toContain(
			'const mayReset = (target: { id: number; role: string }) => target.id !== caller.id && mayManageAccount(caller, target);'
		);
	});
});

describe('whose account a caller may manage, src/lib/account-rule.ts', () => {
	beforeEach(() => {
		resetDb();
	});

	const SAYS = { superadmin: 'refused: the superadmin’s', admin: 'refused: an administrator’s' };

	/** What `requireManagedAccount` answered, the account or the refusal's status and words. */
	function guard(caller: Parameters<typeof requireManagedAccount>[0], userId: number): string {
		try {
			return `account ${requireManagedAccount(caller, userId, SAYS).id}`;
		} catch (e) {
			const refusal = e as { status: number; body: { message: string } };
			return `${refusal.status} ${refusal.body.message}`;
		}
	}

	it('is the rule the guard refuses by, for every caller and every account, the caller’s own included', () => {
		const user = makeUser({ role: 'user' });
		const otherUser = makeUser({ role: 'user' });
		const admin = makeUser({ role: 'admin' });
		const otherAdmin = makeUser({ role: 'admin' });
		const superadmin = makeUser({ role: 'superadmin' });
		const otherSuperadmin = makeUser({ role: 'superadmin' });

		// The guard's answers as they were before it asked the rule, written out.
		const cases: [string, typeof user, typeof user, string][] = [
			['a user, another user', user, otherUser, '403 Forbidden'],
			['a user, their own', user, user, '403 Forbidden'],
			['a user, an administrator', user, admin, '403 Forbidden'],
			['an administrator, a user', admin, user, `account ${user.id}`],
			['an administrator, their own', admin, admin, `account ${admin.id}`],
			['an administrator, another administrator', admin, otherAdmin, `403 ${SAYS.admin}`],
			['an administrator, the superadmin', admin, superadmin, `403 ${SAYS.superadmin}`],
			['the superadmin, a user', superadmin, user, `account ${user.id}`],
			['the superadmin, an administrator', superadmin, admin, `account ${admin.id}`],
			['the superadmin, their own', superadmin, superadmin, `account ${superadmin.id}`],
			['the superadmin, another superadmin', superadmin, otherSuperadmin, `403 ${SAYS.superadmin}`]
		];

		for (const [who, caller, target, answered] of cases) {
			expect({ who, answered: guard(caller, target.id) }).toEqual({ who, answered });
			expect({ who, may: mayManageAccount(caller, target) }).toEqual({ who, may: answered.startsWith('account') });
		}
		// An account that is not there is a 404 before the rule is asked.
		expect(guard(admin, 999_999)).toBe('404 User not found');
		expect(guard(null, user.id)).toBe('401 Not authenticated');
	});
});

describe('the check itself', () => {
	const script = (code: string) => scriptOf('example.svelte', `<script lang="ts">\n${code}\n</script>\n<p>x</p>\n`);

	it('finds the blocks a place in the markup is inside, and which side of each', () => {
		const svelte = '<p>a</p>{#if one}<p>b</p>{#if two}<p>c</p>{:else}<p>d</p>{/if}{:else if three}<p>e</p>{/if}<p>f</p>';
		const around = (text: string) => blocksAround(svelte, svelte.indexOf(text));

		expect(around('<p>a</p>')).toEqual([]);
		expect(around('<p>b</p>')).toEqual([{ condition: 'one', inElse: false }]);
		expect(around('<p>c</p>')).toEqual([{ condition: 'one', inElse: false }, { condition: 'two', inElse: false }]);
		expect(around('<p>d</p>')).toEqual([{ condition: 'one', inElse: false }, { condition: 'two', inElse: true }]);
		expect(around('<p>e</p>')).toEqual([{ condition: 'one', inElse: true }]);
		expect(around('<p>f</p>')).toEqual([]);
	});

	it('finds a finally, and what it does', () => {
		const tree = script('async function f() {\n\ttry { await a(); } finally { busy = false; }\n\ttry { b(); } catch { c(); }\n}');

		expect(finallyBlocks(functionNamed(tree, 'f'))).toEqual(['{ busy = false; }']);
	});

	// The reports page as it was: both shapes are found.
	it('finds a failure read as JSON with no catch, in the branch for it or before the branch', () => {
		const inBranch = script(
			"async function generateReport() {\n\tconst res = await fetch('/x');\n" +
				"\tif (!res.ok) {\n\t\tconst err = await res.json();\n\t\tgenError = err.message || 'Failed';\n\t} else {\n\t\tblob = await res.blob();\n\t}\n}"
		);
		const before = script(
			"async function sendReportEmail() {\n\tconst res = await fetch('/x');\n\tconst data = await res.json();\n" +
				"\tif (res.ok) {\n\t\tresult = data.message;\n\t} else {\n\t\tresult = data.message || 'Failed';\n\t}\n}"
		);

		expect(branches(inBranch, 'generateReport', 'res.json')).toEqual(['failed']);
		expect(branches(inBranch, 'generateReport', 'failureMessage')).toEqual([]);
		expect(branches(before, 'sendReportEmail', 'res.json')).toEqual([null]);
	});

	// The modal as it was: a message, and no second read.
	it('finds no second read where a refused removal only sets a message', () => {
		const was = script(
			"async function removeDependency() {\n\tconst res = await fetch('/x');\n" +
				"\tif (res.ok) {\n\t\tblockedBy = (await res.json()).blockedBy;\n\t} else {\n" +
				"\t\tconst err = await res.json().catch(() => ({}));\n\t\tdepError = err.message || 'Could not remove that dependency';\n\t}\n}"
		);

		expect(branches(was, 'removeDependency', 'loadDependencies')).toEqual([]);
	});

	it('tells the branch for a success from the branch for a failure, either way round', () => {
		const both = script(
			'async function f() {\n\tif (res.ok) { a(); } else { b(); }\n\tif (!res.ok) { c(); } else { d(); }\n\te();\n}'
		);

		expect(['a', 'b', 'c', 'd', 'e'].map((callee) => branches(both, 'f', callee))).toEqual([
			['ok'],
			['failed'],
			['failed'],
			['ok'],
			[null]
		]);
	});

	it('tells which side of the answer a statement is on, after an early return and in a catch too', () => {
		const tree = script(
			'async function f() {\n\tbefore();\n\ttry { res = await fetch(x); } catch { gone(); return; }\n' +
				'\tif (!res.ok) { refused(); return; }\n\tdone();\n}\n' +
				'async function g() {\n\tconst failure = await deleteFailure(send);\n\tif (failure) { said(); return; }\n\tif (other) { inner(); }\n}\n' +
				"async function h() {\n\tif (!(await sent(send, 'x'))) return;\n\tafter();\n\tif (!res.ok) { kept(); }\n\tstill();\n}"
		);
		const side = (name: string, callee: string) => callsOf(functionNamed(tree, name), callee).map(sideOf);

		expect(side('f', 'before')).toEqual([null]);
		expect(side('f', 'gone')).toEqual(['failed']);
		expect(side('f', 'refused')).toEqual(['failed']);
		expect(side('f', 'done')).toEqual(['ok']);
		expect(side('g', 'said')).toEqual(['failed']);
		expect(side('g', 'inner')).toEqual(['ok']);
		expect(side('h', 'after')).toEqual(['ok']);
		expect(side('h', 'kept')).toEqual(['failed']);
		// A failure branch that does not return leaves what follows it to the one before.
		expect(side('h', 'still')).toEqual(['ok']);
		// A request's own call is in neither.
		expect(callsOf(functionNamed(tree, 'h'), 'sent').map(sideOf)).toEqual([null]);
	});

	it('finds a write whose answer is thrown away, in a script and in the markup, and no other', () => {
		const page =
			'<script lang="ts">\n' +
			"async function lost() {\n\tawait fetch('/api/x', { method: 'DELETE' });\n\tfetch('/api/y', { method: 'POST' });\n\tawait api.updateCard(1, {});\n}\n" +
			"async function kept() {\n\tconst res = await fetch('/api/x', { method: 'PUT' });\n\tif (!res.ok) said();\n\tawait fetch('/api/read');\n\tawait api.loadActivities(1);\n}\n" +
			"const arrow = async () => { await api.createCard({}); };\n" +
			'</script>\n' +
			"<button onclick={async () => { await fetch(`/api/${id}`, { method: 'PATCH', body: JSON.stringify({ a: { b: 1 } }) }); }}>x</button>\n" +
			'<Thing onSave={(card) => api.updateCard(card.id, {})} />\n' +
			'<style>.x { color: red; }</style>\n';

		expect(discardedIn('x.svelte', page, ['updateCard', 'createCard'])).toEqual([
			'x.svelte › lost › fetch DELETE',
			'x.svelte › lost › fetch POST',
			'x.svelte › lost › api.updateCard',
			'x.svelte › arrow › api.createCard',
			'x.svelte › markup onclick › fetch PATCH',
			// An arrow without braces gives its answer to the handler's caller, which drops it.
			'x.svelte › markup onSave › api.updateCard'
		]);
		// A module is read whole.
		expect(discardedIn('x.ts', "export async function f() {\n\tawait api.updateCard(1, {});\n}", ['updateCard'])).toEqual(['x.ts › f › api.updateCard']);
	});

	it('finds an answer thrown away by void, .then, .catch, an arrow without braces, and a variable never read', () => {
		const module =
			'export async function lost(ids: number[]) {\n' +
			"\tvoid fetch('/api/a', { method: 'POST' });\n" +
			"\tfetch('/api/b', { method: 'PUT' }).then(() => done());\n" +
			"\tawait fetch('/api/c', { method: 'DELETE' }).catch(() => {});\n" +
			"\tawait Promise.all(ids.map(id => fetch(`/api/d/${id}`, { method: 'POST' })));\n" +
			"\tconst res = await fetch('/api/e', { method: 'PATCH' });\n" +
			'\tawait api.updateCard(1, {}).then(() => {});\n' +
			'}\n' +
			'export async function kept(ids: number[]) {\n' +
			"\tconst res = await fetch('/api/a', { method: 'POST' });\n" +
			'\tif (!res.ok) said();\n' +
			"\tconst failure = await deleteFailure(() => fetch('/api/b', { method: 'DELETE' }), 'card');\n" +
			"\tconst answer = await sent(() => fetch('/api/c', { method: 'PUT' }), 'x');\n" +
			"\tconst answers = await Promise.all(ids.map(async (id) => { const r = await fetch(`/api/d/${id}`, { method: 'POST' }); return r.ok; }));\n" +
			"\treturn fetch('/api/e', { method: 'PATCH' });\n" +
			'}\n';

		expect(discardedIn('x.ts', module, ['updateCard'])).toEqual([
			'x.ts › lost › fetch POST',
			'x.ts › lost › fetch PUT',
			'x.ts › lost › fetch DELETE',
			'x.ts › lost › fetch POST',
			'x.ts › lost › fetch PATCH',
			'x.ts › lost › api.updateCard'
		]);
	});
});

// Card 2281, slice C1b: Create User, 📧 and their script are in the users
// panel, the dialog in a component of its own, the mail panel's record in the
// mail panel; the link itself is the page's, bound into the first two.
describe('the admin page’s invite whose mail was not sent, src/lib/components/admin/UsersPanel.svelte and InviteLinkDialog.svelte (card 2196)', () => {
	const file = 'src/lib/components/admin/UsersPanel.svelte';
	const source = readFileSync(join(ROOT, file), 'utf8');
	const tree = scriptOf(file);
	const markup = source.slice(source.indexOf('</script>'));
	const DIALOG = 'src/lib/components/admin/InviteLinkDialog.svelte';
	const dialogSource = readFileSync(join(ROOT, DIALOG), 'utf8');
	const dialogTree = scriptOf(DIALOG);
	const opens = dialogSource.indexOf('<!-- The link of an invite whose mail was not sent');
	/** The dialog's markup, from its comment to the component's style. */
	const dialog = opens === -1 ? '' : dialogSource.slice(opens, dialogSource.indexOf('<style>', opens));
	const SMTP = 'src/lib/components/admin/SmtpPanel.svelte';
	const smtpSource = readFileSync(join(ROOT, SMTP), 'utf8');
	const smtpTree = scriptOf(SMTP);
	// The page is CRLF in the working copy: lines are joined with \n to read it.
	const pageSource = readFileSync(join(ROOT, ADMIN_PAGE), 'utf8').replace(/\r\n/g, '\n');

	/** Every `inviteLink = <something>` in a function, the clearing `= null` left out. */
	const linkSet = (fn: ts.Node) => {
		const found: ts.BinaryExpression[] = [];
		const visit = (node: ts.Node) => {
			if (
				ts.isBinaryExpression(node) &&
				node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
				node.left.getText() === 'inviteLink' &&
				node.right.getText() !== 'null'
			) {
				found.push(node);
			}
			ts.forEachChild(node, visit);
		};
		visit(fn);
		return found;
	};

	it.each(['resendInvite', 'createUser'])('%s sets the link only from an answer that is a success and says mailSent: false', (name) => {
		const set = linkSet(functionNamed(tree, name));

		expect(set.length).toBeGreaterThan(0);
		for (const assignment of set) {
			expect(sideOf(assignment)).toBe('ok');
			const under = ts.findAncestor(assignment, (node) => ts.isIfStatement(node) && node.expression.getText().includes('mailSent === false'));
			expect(under, assignment.getText()).toBeDefined();
			expect(assignment.right.getText()).toContain('inviteUrl');
		}
	});

	it('sets the link nowhere else, puts it in no toast and in no storage, and clears it with Done', () => {
		// Looked for in the page and in every one of its components.
		const scripts = adminSvelteSources().map((admin) => scriptOf(admin.file, admin.source));
		const touching = scripts
			.flatMap((script) => script.statements)
			.filter((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && !!statement.name)
			.filter((fn) => /\binviteLink\b/.test(fn.getText()))
			.map((fn) => fn.name!.text)
			.sort();
		expect(touching).toEqual(['closeInviteLink', 'copyInviteLink', 'createUser', 'resendInvite']);
		expect(linkSet(functionNamed(dialogTree, 'closeInviteLink'))).toEqual([]);
		expect(statementsOf(functionNamed(dialogTree, 'closeInviteLink'), 'inviteLink = null')).toHaveLength(1);

		for (const script of scripts) {
			for (const call of callsOf(script, 'showToast')) {
				expect(call.getText(), call.getText()).not.toMatch(/inviteLink|inviteUrl/);
			}
			expect(script.getText()).not.toMatch(/(localStorage|sessionStorage|history\.|goto\()[^\n]*invite/i);
		}

		expect(dialog.split('onclick={closeInviteLink}>Done</button>')).toHaveLength(2);
		const allMarkup = adminSvelteSources()
			.map((admin) => admin.source.slice(admin.source.indexOf('</script>')))
			.join('\n');
		expect(allMarkup.split('{#if inviteLink}')).toHaveLength(2);
		expect(dialogSource.split('{#if inviteLink}')).toHaveLength(2);
		// No markup sets it: only the users panel's two functions, and Done.
		expect(allMarkup).not.toMatch(/inviteLink\s*=[^=]/);
		// The page holds it, and hands it to the panel that sets it and the dialog that shows it.
		expect(pageSource).toContain('let inviteLink = $state<{ url: string; username: string; message: string; returnTo?: HTMLElement } | null>(null);');
		expect(pageSource.split('\n').filter((line) => line.includes('<UsersPanel ') && line.includes(' bind:inviteLink '))).toHaveLength(1);
		expect(pageSource).toContain('<InviteLinkDialog bind:inviteLink {isSuperadmin} />');
	});

	it('copies the link with the clipboard, as the Account page copies a new key', () => {
		expect(functionNamed(dialogTree, 'copyInviteLink').getText()).toContain('navigator.clipboard.writeText(inviteLink.url)');
		expect(dialog).toContain('onclick={copyInviteLink}');
	});

	it('says what decision 9 says, word for word', () => {
		for (const words of [
			'📧 The invite mail was not sent',
			'Give this link to {inviteLink.username} yourself, by a way only they read. Whoever opens it can set the password of ' +
				"{inviteLink.username}'s account and is then signed in as them. It works once, for seven days, and stops working if " +
				'another invite is sent to this account. Do not open it yourself.',
			'It is not shown again. If it is lost, send a new invite with 📧.',
			'Why it failed is under Email / SMTP below.',
			'The superadmin can see why under Email / SMTP.'
		]) {
			expect(dialog, words).toContain(words);
		}
		expect(functionNamed(tree, 'createUser').getText()).toContain(
			'`User ${made} was made, but the invite mail could not be sent: ${result.mailProblem}.`'
		);
	});

	it('gates every 📧 and Create User on one flag, inviteInFlight, set before the request and cleared in finally (R-S5)', () => {
		for (const name of ['resendInvite', 'createUser']) {
			const fn = functionNamed(tree, name);
			const tried = fn.body!.statements.find((statement): statement is ts.TryStatement => ts.isTryStatement(statement));
			expect(tried, name).toBeDefined();
			expect(tried!.finallyBlock?.statements.map((statement) => statement.getText()), name).toContain('inviteInFlight = null;');
			expect(fn.body!.statements.slice(0, fn.body!.statements.indexOf(tried!)).map((statement) => statement.getText()), name).toContain(
				'if (inviteInFlight !== null || inviteLink !== null) return;'
			);
		}
		expect(statementsOf(functionNamed(tree, 'resendInvite'), 'inviteInFlight = userId')).toHaveLength(1);
		expect(functionNamed(tree, 'createUser').getText()).toContain("if (!newPassword) inviteInFlight = 'new';");

		expect(markup).toContain(
			'<button class="btn-ghost btn-sm" onclick={(e) => resendInvite(u.id, e.currentTarget)} disabled={inviteInFlight !== null || inviteLink !== null} title="Resend invite email">{inviteInFlight === u.id ? \'…\' : \'📧\'}</button>'
		);
		expect(markup).toContain('onclick={createUser} disabled={creatingUser || inviteInFlight !== null || inviteLink !== null || !newUsername || !newEmail}>');
	});

	it('reads the mail panel again once an invite is answered, so the panel the dialog points to shows the failure (review fixes, item 1)', () => {
		for (const name of ['resendInvite', 'createUser']) {
			const tried = functionNamed(tree, name).body!.statements.find((statement): statement is ts.TryStatement => ts.isTryStatement(statement));
			expect(tried!.finallyBlock?.statements.map((statement) => statement.getText()), name).toContain('if (isSuperadmin) loadMailStatus();');
		}
		// The panel's loadMailStatus is the mail panel's own (card 2281, slice C1b), reached through the page.
		expect(pageSource).toContain('loadMailStatus={() => smtpPanel?.loadMailStatus()}');
		expect(pageSource).toContain('<SmtpPanel bind:this={smtpPanel} currentUser={data.currentUser} />');
		expect(smtpTree.getText()).toContain('export async function loadMailStatus() {');
	});

	it('focuses Copy when the dialog opens, and describes the dialog by its words (review fixes, item 3)', () => {
		expect(dialog).toMatch(/role="alertdialog"[^>]*aria-describedby="invite-link-said invite-link-warning"/);
		expect(dialog).toContain('<p id="invite-link-said"');
		expect(dialog).toContain('<p id="invite-link-warning"');
		// Through the dialog's hold on the focus since card 2365, which keeps Tab in it too and, since its review, gives the focus back to
		// the control the users panel names (mounted in tests/admin-panels.test.ts).
		expect(dialog).toContain("use:holdFocus={{ first: '.invite-link-row button', returnTo: backTo(inviteLink) }}");
		expect(dialog).toContain('<button class="btn-ghost btn-sm" onclick={copyInviteLink}>');
	});

	it('says "Invite sent!" only for an answer that says mailSent: true, and an answer that says neither is not taken as sent (review fixes, item 4)', () => {
		const fn = functionNamed(tree, 'resendInvite');
		const toasts = callsOf(fn, 'showToast');
		const sentToasts = toasts.filter((call) => call.getText().includes('Invite sent'));
		expect(sentToasts).toHaveLength(1);
		const under = ts.findAncestor(sentToasts[0], (node) => ts.isIfStatement(node) && node.expression.getText() === 'result?.mailSent === true');
		expect(under, sentToasts[0].getText()).toBeDefined();
		expect(toasts.map((call) => call.getText())).toContain(
			"showToast('The invite was made, but the answer did not say whether its mail was sent.', 'error', started)"
		);
	});

	it('reads the mail panel’s record only from an answer that is a success, when the panel loads and after Save and Send Test', () => {
		for (const name of ['loadSmtpConfig', 'loadMailStatus']) {
			const set = statementsOf(functionNamed(smtpTree, name), 'mailStatus = readMailStatus(data.mailStatus)');
			expect(set, name).toHaveLength(1);
			expect(branchOf(set[0]), name).toBe('ok');
		}
		expect(callsOf(functionNamed(smtpTree, 'saveSmtp'), 'loadMailStatus')).toHaveLength(1);
		expect(callsOf(functionNamed(smtpTree, 'testSmtp'), 'loadMailStatus')).toHaveLength(1);
	});

	it('shows decision 11’s block in the mail panel, under Send Test, to the superadmin alone', () => {
		const smtpMarkup = smtpSource.slice(smtpSource.indexOf('</script>'));
		const panel = smtpMarkup.slice(smtpMarkup.indexOf('<h2>📧 Email / SMTP</h2>'));
		const block = panel.slice(panel.indexOf('{#if mailStatus}'));
		expect(panel.indexOf('{#if mailStatus}')).toBeGreaterThan(panel.indexOf('onclick={testSmtp}'));
		for (const words of [
			'Since the server started ({when(mailStatus.since)}): {mailStatus.sent} sent, {mailStatus.failed} failed.',
			'✅ No mail has failed since then.',
			'⚠️ Last failure, {when(mailStatus.lastFailure.at)}: "{mailStatus.lastFailure.subject}": {mailStatus.lastFailure.problem}. The mail error was: {mailStatus.lastFailure.detail}.',
			'Mail has been sent since then, last at {when(mailStatus.lastSentAt)}.',
			'No mail has been sent since then.',
			'Every failure is also in the system log, on the Audit page, with its recipient.'
		]) {
			expect(block, words).toContain(words);
		}
		// In the mail panel, which the page draws for the superadmin alone.
		expect(smtpSource.split('{#if mailStatus}')).toHaveLength(2);
		expect(drawnForSuperadminOnly(SMTP)).toBe(true);
	});
});

// Card 2281, slice C1a: the box and its script moved from the admin page into a component of their own.
describe('the Google Drive Connect’s paste box, src/lib/components/admin/GDriveConnectModal.svelte (card 2251)', () => {
	const file = 'src/lib/components/admin/GDriveConnectModal.svelte';
	const source = readFileSync(join(ROOT, file), 'utf8');
	const tree = scriptOf(file);
	// Lines are joined with \n to read the markup, as for the CRLF page it came from.
	const markup = source.slice(source.indexOf('</script>')).replace(/\r\n/g, '\n');
	const box = markup.slice(markup.indexOf('<!-- Google Drive OAuth code entry -->'));
	const exchange = () => functionNamed(tree, 'exchangeGDriveCode');

	/** Decision 5's words, and R12's for an address Google ended with an error. */
	const PASTE_WHOLE_ADDRESS =
		"Paste the whole address from the browser's address bar: it holds the code and the check that this connection was started here.";
	const ACCESS_DENIED = 'Google says access was not granted (access_denied). Press Connect again and allow access.';
	const OTHER_ERROR = '`Google answered with an error (${googleError}). Press Connect again.`';

	it('says decision 5’s words, word for word', () => {
		expect(tree.getText().replace(/\r\n/g, '\n')).toContain(`const PASTE_WHOLE_ADDRESS =\n\t\t"${PASTE_WHOLE_ADDRESS}";`);
	});

	it('sends the state read from the pasted address with its code', () => {
		const fn = exchange();
		expect(fn.getText()).toContain("const code = address?.searchParams.get('code');");
		expect(fn.getText()).toContain("const state = address?.searchParams.get('state');");
		expect(fn.getText()).toContain('body: JSON.stringify({ code, state, destName: gdriveConnecting })');
		// The pasted text is no longer sent as the code when it is not an address.
		expect(fn.getText()).not.toContain('not a URL, use as-is');
	});

	it.each([
		['a bare code, or an address without its state', 'PASTE_WHOLE_ADDRESS'],
		['an address holding error=access_denied', ACCESS_DENIED],
		['an address holding any other error', OTHER_ERROR]
	])('says what is wrong with %s and returns before anything is sent (decision 5, R12)', (_case, words) => {
		const fn = exchange();
		const said = callsOf(fn, 'showToast').filter((call) => call.getText().includes(words));
		const sends = callsOf(fn, 'sent');

		expect(said, words).toHaveLength(1);
		expect(sends).toHaveLength(1);
		// A statement of the function itself, an `if` whose branch says it and
		// returns, ahead of the call that sends.
		const guard = ts.findAncestor(said[0], (node) => ts.isIfStatement(node) && node.parent === fn.body) as ts.IfStatement | undefined;
		expect(guard, words).toBeDefined();
		const branch = guard!.thenStatement;
		expect(ts.isBlock(branch) && branch.statements.some((statement) => ts.isReturnStatement(statement)), words).toBe(true);
		expect(guard!.getEnd()).toBeLessThan(sends[0].getStart());
		expect(said[0].getText()).toContain("'error'");
	});

	it('reads Google’s error before the code, so an address holding both is not sent', () => {
		const text = exchange().getText();
		expect(text.indexOf("address?.searchParams.get('error')")).toBeGreaterThan(-1);
		expect(text.indexOf("address?.searchParams.get('error')")).toBeLessThan(text.indexOf("address?.searchParams.get('code')"));
		expect(text).toContain("googleError === 'access_denied'");
	});

	it('asks for the whole address, in the instructions and the placeholder (R12)', () => {
		expect(box).toContain('placeholder="Paste the whole address, starting http://localhost/?state=…"');
		expect(box).not.toContain('authorization code here');
		expect(box).toContain(
			"Copy the <strong>whole address</strong> from your browser's address bar, not only the code: it holds the code and the check that this connection was started here. Paste it below:"
		);
	});

	const CONSENT = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=c&state=s1';
	const LATER = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=c&state=s2';

	/**
	 * connectGDriveOAuth compiled from the page and run (cards 2265 and 2266),
	 * with the real failureMessage and answerBody, and stand-ins for fetch,
	 * whose answers the test gives one at a time, window.open and the toast.
	 * Cancel is what the box's Cancel button does. The exchange (✅ Connect)
	 * is compiled with them, with `sent` a stand-in whose answers the test
	 * gives in `posts`. `loadBackupConfig` is the Scheduled Backups panel's,
	 * handed to the box; connectGDriveOAuth is exported for the panel's 🔗
	 * Connect, and run here without its `export` (card 2281, slice C1a).
	 */
	function connecting(opened: unknown = {}) {
		const declared = (name: string) => tree.statements.some((s) => ts.isFunctionDeclaration(s) && s.name?.text === name);
		const names = ['isGoogleConsent', 'connectGDriveOAuth', 'closeGDriveConnect', 'exchangeGDriveCode'].filter(declared);
		const js = ts.transpileModule(names.map((name) => functionNamed(tree, name).getText().replace(/^export /, '')).join('\n'), {
			compilerOptions: { target: ts.ScriptTarget.ES2022 }
		}).outputText;
		const answers: Array<(res: Response) => void> = [];
		const fetch = vi.fn(() => new Promise<Response>((resolve) => answers.push(resolve)));
		const posts: Array<(res: Response | null) => void> = [];
		const sent = vi.fn(() => new Promise<Response | null>((resolve) => posts.push(resolve)));
		const loadBackupConfig = vi.fn(async () => true);
		const window = { open: vi.fn(() => opened) };
		const showToast = vi.fn();
		const page = new Function(
			'fetch',
			'window',
			'showToast',
			'toasts',
			'failureMessage',
			'answerBody',
			'sent',
			'loadBackupConfig',
			"let gdriveConnecting = '', gdriveAuthCode = 'old paste', gdriveAuthUrl = '', gdriveBlocked = false, gdriveAttempt = 0, gdriveExchanging = false;\n" +
				"const PASTE_WHOLE_ADDRESS = 'Paste the whole address.';\n" +
				`${js}\n` +
				'return {\n' +
				'\tconnect: connectGDriveOAuth,\n' +
				"\tcancel: typeof closeGDriveConnect === 'function' ? () => closeGDriveConnect() : () => { gdriveConnecting = ''; gdriveAuthCode = ''; },\n" +
				'\tstate: () => ({ connecting: gdriveConnecting, code: gdriveAuthCode, authUrl: gdriveAuthUrl, blocked: gdriveBlocked }),\n' +
				'\tpaste: (text) => { gdriveAuthCode = text; },\n' +
				'\texchange: () => exchangeGDriveCode(),\n' +
				'\texchanging: () => gdriveExchanging\n' +
				'};'
		)(fetch, window, showToast, { navigation: () => 7 }, failureMessage, answerBody, sent, loadBackupConfig) as {
			connect: (name: string) => Promise<void>;
			cancel: () => void;
			state: () => { connecting: string; code: string; authUrl: string; blocked: boolean };
			paste: (text: string) => void;
			exchange: () => Promise<void>;
			exchanging: () => boolean;
		};
		return { ...page, answers, posts, fetch, loadBackupConfig, window, showToast };
	}

	it.each([
		[400, 'Client ID and Secret required'],
		[404, 'Google Drive destination not found'],
		[403, 'Superadmin only']
	])('says the server’s reason for a %i refusal of the Connect, opens no window and closes the box (card 2265)', async (status, message) => {
		const page = connecting();
		const done = page.connect('Drive');
		expect(page.state().connecting).toBe('Drive');
		page.answers[0](Response.json({ message }, { status }));
		await done;

		expect(page.showToast.mock.calls).toEqual([[message, 'error', 7]]);
		expect(page.window.open).not.toHaveBeenCalled();
		expect(page.state()).toEqual({ connecting: '', code: '', authUrl: '', blocked: false });
	});

	it('says "Failed to generate auth URL" for a refusal that gives no reason, a proxy’s HTML 502 (card 2265)', async () => {
		const page = connecting();
		const done = page.connect('Drive');
		page.answers[0](new Response('<html><body>502 Bad Gateway</body></html>', { status: 502, headers: { 'content-type': 'text/html' } }));
		await done;

		expect(page.showToast.mock.calls).toEqual([['Failed to generate auth URL', 'error', 7]]);
		expect(page.window.open).not.toHaveBeenCalled();
		expect(page.state().connecting).toBe('');
	});

	it('asks failureMessage once in connectGDriveOAuth, where the answer is a refusal (card 2265)', () => {
		expect(branches(tree, 'connectGDriveOAuth', 'failureMessage')).toEqual(['failed']);
		const [asked] = callsOf(functionNamed(tree, 'connectGDriveOAuth'), 'failureMessage');
		expect(asked.getText()).toBe("failureMessage(res, 'Failed to generate auth URL')");
		expect(callsOf(functionNamed(tree, 'connectGDriveOAuth'), 'res.json')).toEqual([]);
	});

	it.each([
		['{}', () => Response.json({})],
		['{ "authUrl": 5 }', () => Response.json({ authUrl: 5 })],
		['{ "authUrl": "" }', () => Response.json({ authUrl: '' })],
		['a 200 that is a proxy’s page', () => new Response('<html>Sign in to the proxy</html>', { headers: { 'content-type': 'text/html' } })]
	])('opens no window for an answer without a consent address, %s: it says "Failed to generate auth URL" and closes the box (card 2266)', async (_case, answer) => {
		const page = connecting();
		const done = page.connect('Drive');
		page.answers[0](answer());
		await done;

		expect(page.window.open).not.toHaveBeenCalled();
		expect(page.showToast.mock.calls).toEqual([['Failed to generate auth URL', 'error', 7]]);
		expect(page.state()).toEqual({ connecting: '', code: '', authUrl: '', blocked: false });
	});

	it('says the window was blocked when window.open gives null, and keeps the consent address for the link (card 2266)', async () => {
		const page = connecting(null);
		const done = page.connect('Drive');
		// No address before the answer: the box says it is opening Google's page.
		expect(page.state()).toEqual({ connecting: 'Drive', code: '', authUrl: '', blocked: false });
		page.answers[0](Response.json({ authUrl: CONSENT }));
		await done;

		expect(page.window.open.mock.calls).toEqual([[CONSENT, '_blank', 'width=600,height=700']]);
		expect(page.state()).toEqual({ connecting: 'Drive', code: '', authUrl: CONSENT, blocked: true });
		expect(page.showToast).not.toHaveBeenCalled();
	});

	it('says the window opened when window.open gives a window, and still keeps the address for the link (card 2266, decision 1 (c))', async () => {
		const page = connecting({ closed: false });
		const done = page.connect('Drive');
		page.answers[0](Response.json({ authUrl: CONSENT }));
		await done;

		expect(page.window.open).toHaveBeenCalledTimes(1);
		expect(page.state()).toEqual({ connecting: 'Drive', code: '', authUrl: CONSENT, blocked: false });
	});

	it('opens nothing and shows no address for a Connect cancelled before its answer came (card 2266)', async () => {
		const page = connecting();
		const done = page.connect('Drive');
		page.cancel();
		page.answers[0](Response.json({ authUrl: CONSENT }));
		await done;

		expect(page.window.open).not.toHaveBeenCalled();
		expect(page.state()).toEqual({ connecting: '', code: '', authUrl: '', blocked: false });
		expect(page.showToast).not.toHaveBeenCalled();
	});

	it('says nothing of a cancelled Connect’s refusal, and does not close the Connect started after it (card 2266)', async () => {
		const page = connecting();
		const first = page.connect('Drive');
		page.cancel();
		const second = page.connect('Drive');
		page.answers[0](Response.json({ message: 'Google Drive destination not found' }, { status: 404 }));
		await first;

		expect(page.showToast).not.toHaveBeenCalled();
		expect(page.state().connecting).toBe('Drive');
		page.answers[1](Response.json({ authUrl: LATER }));
		await second;
		expect(page.state()).toEqual({ connecting: 'Drive', code: '', authUrl: LATER, blocked: false });
	});

	it('shows only the later Connect’s address, and opens one window, when an earlier Connect answers after it (card 2266)', async () => {
		const page = connecting();
		const first = page.connect('Drive');
		const second = page.connect('Drive');
		page.answers[1](Response.json({ authUrl: LATER }));
		await second;
		page.answers[0](Response.json({ authUrl: CONSENT }));
		await first;

		expect(page.window.open.mock.calls).toEqual([[LATER, '_blank', 'width=600,height=700']]);
		expect(page.state().authUrl).toBe(LATER);
	});

	it.each([
		['a javascript: address', 'javascript:alert(document.cookie)'],
		['Google’s address over http', 'http://accounts.google.com/o/oauth2/v2/auth?client_id=c&state=s1'],
		['another host over https', 'https://evil.example/o/oauth2/v2/auth?client_id=c&state=s1'],
		['a host that only starts with Google’s', 'https://accounts.google.com.evil.example/o/oauth2/v2/auth?client_id=c&state=s1'],
		['text that is no address', 'accounts.google.com/o/oauth2/v2/auth']
	])('opens no window and shows no link for %s: it says "Failed to generate auth URL" and closes the box (the card 2266 review)', async (_case, authUrl) => {
		const page = connecting();
		const done = page.connect('Drive');
		page.answers[0](Response.json({ authUrl }));
		await done;

		expect(page.window.open).not.toHaveBeenCalled();
		expect(page.showToast.mock.calls).toEqual([['Failed to generate auth URL', 'error', 7]]);
		expect(page.state()).toEqual({ connecting: '', code: '', authUrl: '', blocked: false });
	});

	it('opens Google’s own consent page over https, as answered (the card 2266 review)', async () => {
		const good = 'https://accounts.google.com/o/oauth2/auth?client_id=c&redirect_uri=http%3A%2F%2Flocalhost&state=s1';
		const page = connecting();
		const done = page.connect('Drive');
		page.answers[0](Response.json({ authUrl: good }));
		await done;

		expect(page.window.open.mock.calls).toEqual([[good, '_blank', 'width=600,height=700']]);
		expect(page.state()).toEqual({ connecting: 'Drive', code: '', authUrl: good, blocked: false });
		expect(page.showToast).not.toHaveBeenCalled();
	});

	/** A Connect answered with `authUrl`, and the whole address Google's page led to pasted. */
	async function readyToExchange(page: ReturnType<typeof connecting>, authUrl: string, state: string) {
		const at = page.answers.length;
		const done = page.connect('Drive');
		page.answers[at](Response.json({ authUrl }));
		await done;
		page.paste(`http://localhost/?state=${state}&code=c-${state}`);
	}

	it('ends the exchange at a Cancel, and an exchange answering after a Cancel leaves the next Connect’s box and its GET alone (the card 2266 review)', async () => {
		const page = connecting();
		await readyToExchange(page, CONSENT, 's1');
		const old = page.exchange();
		expect(page.exchanging()).toBe(true);

		// Cancel mid exchange: the box closes, and the next one's ✅ Connect is not left disabled.
		page.cancel();
		expect(page.exchanging()).toBe(false);

		// Connect again; its GET is still on its way when the old exchange answers.
		const next = page.connect('Drive');
		page.posts[0](Response.json({ success: true }));
		await old;
		expect(page.state()).toEqual({ connecting: 'Drive', code: '', authUrl: '', blocked: false });
		// The old exchange's own toast and reload stay: it did connect the destination.
		expect(page.showToast.mock.calls).toEqual([['Google Drive connected!']]);
		expect(page.loadBackupConfig).toHaveBeenCalledTimes(1);

		page.answers[1](Response.json({ authUrl: LATER }));
		await next;
		expect(page.state()).toEqual({ connecting: 'Drive', code: '', authUrl: LATER, blocked: false });
		expect(page.window.open).toHaveBeenCalledTimes(2);
	});

	it('keeps ✅ Connect disabled through a newer exchange when an older one answers in the middle of it (the card 2266 review)', async () => {
		const page = connecting();
		await readyToExchange(page, CONSENT, 's1');
		const old = page.exchange();
		page.cancel();
		await readyToExchange(page, LATER, 's2');
		const newer = page.exchange();
		expect(page.exchanging()).toBe(true);

		page.posts[0](Response.json({ success: false, message: 'Invalid grant' }));
		await old;
		expect(page.exchanging()).toBe(true);
		expect(page.state()).toEqual({ connecting: 'Drive', code: 'http://localhost/?state=s2&code=c-s2', authUrl: LATER, blocked: false });

		page.posts[1](Response.json({ success: true }));
		await newer;
		expect(page.exchanging()).toBe(false);
		expect(page.state()).toEqual({ connecting: '', code: '', authUrl: '', blocked: false });
	});

	it('says "Opening Google’s sign-in page…" until the address is known, the blocked sentence only when blocked, and offers the link in both other states (card 2266)', () => {
		const opening = box.indexOf('{#if !gdriveAuthUrl}');
		const blocked = box.indexOf('{:else if gdriveBlocked}');
		const opened = box.indexOf('{:else}', blocked);
		const end = box.indexOf('{/if}', opened);
		expect([opening, blocked, opened, end].every((at) => at > -1)).toBe(true);
		expect(opening).toBeLessThan(blocked);
		const [whileOpening, whileBlocked, whileOpened] = [
			box.slice(opening, blocked),
			box.slice(blocked, opened),
			box.slice(opened, end)
		];
		const LINK = '<a href={gdriveAuthUrl} target="_blank" rel="noopener noreferrer">';

		expect(whileOpening).toContain("Opening Google's sign-in page…");
		expect(whileOpening).not.toContain('<a ');
		expect(whileBlocked).toContain("Your browser blocked Google's sign-in window.");
		expect(whileBlocked).toContain(`${LINK}Open Google's sign-in page</a>`);
		expect(whileOpened).toContain(`A Google sign-in window has opened. If you cannot see it, ${LINK}open Google's sign-in page</a>.`);
		expect(box.split('has opened')).toHaveLength(2);
		expect(box.split('<a ')).toHaveLength(3);

		// The paste box and its Connect wait for the address.
		expect(box).toMatch(/<input\s+type="text"\s+placeholder="Paste the whole address, starting http:\/\/localhost\/\?state=…"\s+bind:value=\{gdriveAuthCode\}\s+disabled=\{!gdriveAuthUrl\}/);
		expect(box).toContain('disabled={!gdriveAuthUrl || !gdriveAuthCode.trim() || gdriveExchanging}');
		expect(box).toContain('<button class="btn-ghost" onclick={closeGDriveConnect}>Cancel</button>');
	});

	it('closes the box in one place, which forgets the address and moves the Connect on (card 2266)', () => {
		const close = functionNamed(tree, 'closeGDriveConnect');
		const said = close.body!.statements.map((statement) => statement.getText());
		expect(said).toEqual(['gdriveAttempt++;', "gdriveConnecting = '';", "gdriveAuthCode = '';", "gdriveAuthUrl = '';", 'gdriveBlocked = false;', 'gdriveExchanging = false;']);
		// Nowhere else is the box closed by hand.
		expect(statementsOf(tree, "gdriveConnecting = ''")).toHaveLength(1);
		expect(callsOf(functionNamed(tree, 'exchangeGDriveCode'), 'closeGDriveConnect')).toHaveLength(2);
		expect(callsOf(functionNamed(tree, 'connectGDriveOAuth'), 'closeGDriveConnect')).toHaveLength(3);
	});
});

// Card 2281, slice C1a: the Scheduled Backups panel, with the destinations'
// script, and the add and edit forms are components of the admin page.
describe('the SFTP host key on the admin page, src/lib/components/admin/ScheduledBackupsPanel.svelte and DestinationForm.svelte (card 2250)', () => {
	const file = 'src/lib/components/admin/ScheduledBackupsPanel.svelte';
	const source = readFileSync(join(ROOT, file), 'utf8');
	const tree = scriptOf(file);
	const panel = source.slice(source.indexOf('</script>'));
	const formSource = readFileSync(join(ROOT, 'src/lib/components/admin/DestinationForm.svelte'), 'utf8');
	const form = formSource.slice(formSource.indexOf('</script>'));
	// The markup of the page and of every one of its components, where a box or a
	// button could be; the page is CRLF in the working copy: lines are joined with \n.
	const markup = adminSvelteSources()
		.map((admin) => admin.source.slice(admin.source.indexOf('</script>')))
		.join('\n')
		.replace(/\r\n/g, '\n');
	/** The page, its components and their modules whole, where something said to be gone could be. */
	const everywhere = adminSources()
		.map((admin) => admin.source)
		.join('\n');
	const row = panel.slice(panel.indexOf('{#each backupDestinations as dest'), panel.indexOf('<!-- Inline edit form -->'));
	const editForm = form.slice(form.indexOf('<!-- Inline edit form -->'), form.indexOf('<!-- Add Destination Form -->'));
	const addForm = form.slice(form.indexOf('<!-- Add Destination Form -->'));

	/** R5's placeholder for the Host key box, in both forms. */
	const PLACEHOLDER = 'Paste the line ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub prints, or leave it empty and press Test';
	const NEW = 'ssh-ed25519 SHA256:s16t1ixxsjxOgoaXCXACvAIOEG1K5biSlM7GekmavrY';
	const OLD = 'ssh-ed25519 SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU';

	/** A form's SFTP part: from its `{#if newDestType === 'sftp'}` to its S3 part. */
	const sftpPart = (form: string) => form.slice(form.indexOf("{#if newDestType === 'sftp'}"), form.indexOf("{:else if newDestType === 's3'}"));

	it.each([
		['the add form', () => addForm],
		['the inline edit form', () => editForm]
	])('has a Host key box in the SFTP part of %s, with R5’s placeholder', (_form, form) => {
		const part = sftpPart(form());
		expect(part.length).toBeGreaterThan(0);
		expect(part).toContain(`<input type="text" placeholder="${PLACEHOLDER}" bind:value={destHostKey}`);
	});

	it('has the box twice and nowhere else', () => {
		expect(markup.split('bind:value={destHostKey}')).toHaveLength(3);
	});

	it('carries the key in the form: empty when reset, the destination’s when it is edited, and sent with every SFTP destination the form builds', () => {
		expect(tree.getText()).toContain("let destHostKey = $state('');");
		expect(statementsOf(functionNamed(tree, 'resetDestForm'), "destHostKey = ''")).toHaveLength(1);

		const populating = functionNamed(tree, 'populateDestForm').body!.statements.find(ts.isIfStatement)!;
		expect(populating.expression.getText()).toBe("dest.type === 'sftp'");
		expect(statementsOf(populating.thenStatement, "destHostKey = (dest.hostKey as string) || ''")).toHaveLength(1);

		// A field not sent is not kept: a save without it would remove the key,
		// and with the password masked it is refused (slice 1's readDestination).
		const building = functionNamed(tree, 'buildDestConfig').body!.statements.find(ts.isIfStatement)!;
		expect(building.expression.getText()).toBe("newDestType === 'sftp'");
		const returned = (building.thenStatement as ts.Block).statements.find(ts.isReturnStatement)!.expression!;
		expect(ts.isObjectLiteralExpression(returned)).toBe(true);
		expect((returned as ts.ObjectLiteralExpression).properties.map((property) => property.getText())).toContain('hostKey: destHostKey');
	});

	it('reads what a Test said of the host key: the key presented, the confirmed one, both, or neither (decision 10, R3)', () => {
		const js = ts.transpileModule(functionNamed(tree, 'hostKeyCheckOf').getText(), {
			compilerOptions: { target: ts.ScriptTarget.ES2022 }
		}).outputText;
		const hostKeyCheckOf = new Function(`${js}\nreturn hostKeyCheckOf;`)() as (result: unknown) => unknown;

		expect(hostKeyCheckOf({ success: false, message: 'not confirmed', hostKey: NEW })).toEqual({ message: 'not confirmed', presented: NEW, confirmed: null });
		expect(hostKeyCheckOf({ success: false, message: 'mismatch', hostKey: NEW, confirmedHostKey: OLD })).toEqual({
			message: 'mismatch',
			presented: NEW,
			confirmed: OLD
		});
		expect(hostKeyCheckOf({ success: false, message: 'not offered', confirmedHostKey: OLD })).toEqual({ message: 'not offered', presented: null, confirmed: OLD });
		expect(hostKeyCheckOf({ success: true, message: 'Connected to nas.example:22' })).toBeNull();
		expect(hostKeyCheckOf({ success: false, message: 'Connection failed', hostKey: 7 })).toBeNull();
		expect(hostKeyCheckOf(null)).toBeNull();
	});

	it('shows a Test’s host key answer in the box under the destination and not in a toast, and forgets the box at any other answer', () => {
		const fn = functionNamed(tree, 'testDestination');
		const text = fn.getText().replace(/\s+/g, ' ');

		expect(text).toContain("const check = dest.type === 'sftp' ? hostKeyCheckOf(result) : null;");
		expect(text).toContain('hostKeyChecks = { ...hostKeyChecks, [dest.name]: check };');
		expect(callsOf(fn, 'showToast')).toHaveLength(1);
		const guard = text.indexOf('if (check !== null) return;');
		expect(guard).toBeGreaterThan(text.indexOf('hostKeyChecks = { ...hostKeyChecks, [dest.name]: check };'));
		expect(guard).toBeLessThan(text.indexOf('showToast('));
	});

	it('shows under an SFTP destination the Test’s words, and Confirm only for a key not confirmed yet; both keys for one that did not match; no Confirm where the confirmed type is no longer offered (decisions 3 and 5, R3)', () => {
		const at = row.indexOf("{#if dest.type === 'sftp' && byName(hostKeyChecks, dest.name)}");
		expect(at).toBeGreaterThan(-1);
		const box = row.slice(at);
		const branches = ['{#if check.presented && !check.confirmed}', '{:else if check.presented}', '{:else}', '{/if}'].map((mark) => box.indexOf(mark));
		expect(branches.every((mark) => mark > -1)).toBe(true);
		expect([...branches].sort((a, b) => a - b)).toEqual(branches);
		const [unconfirmed, mismatch, typeGone] = [0, 1, 2].map((i) => box.slice(branches[i], branches[i + 1]));

		expect(box.slice(0, branches[0])).toContain('{check.message}');
		expect(unconfirmed).toContain('<code>{check.presented}</code>');
		expect(unconfirmed).toMatch(/<button class="btn-primary btn-xs" disabled=\{backupSaving\} onclick=\{\(\) => confirmHostKey\(dest\.name, check\.presented\)\}>/);
		expect(mismatch).toContain('<code>{check.presented}</code>');
		expect(mismatch).toContain('<code>{check.confirmed}</code>');
		expect(typeGone).toContain('<code>{check.confirmed}</code>');
		expect(typeGone).not.toContain('check.presented');
		// One Confirm on the page, in the first branch.
		expect(markup.match(/confirmHostKey\(/g)).toHaveLength(1);
	});

	it('saves with Confirm exactly the key shown, as the destination’s hostKey, and tests again once it is saved (decision 3)', () => {
		const fn = functionNamed(tree, 'confirmHostKey');
		const text = fn.getText().replace(/\s+/g, ' ');

		expect(text).toContain('updated[idx] = { ...updated[idx], hostKey: key };');
		expect(text).toContain('backupDestinations = updated;');
		expect(callsOf(fn, 'testDestination')).toHaveLength(1);
		// The Test is of the destination as the server now holds it, read again
		// after the save (the review's M3): its secret masked, its key as stored.
		const reload = text.indexOf('await loadBackupConfig(true)');
		expect(reload).toBeGreaterThan(text.indexOf('saveBackupConfig()'));
		expect(text.indexOf('await testDestination(backupDestinations.find(d => d.name === name) ?? updated[idx])')).toBeGreaterThan(reload);
	});

	it('has a private key box in the SFTP part of the inline edit form, as the add form has, filled as the password is (the review’s M2)', () => {
		for (const form of [addForm, editForm]) {
			expect(sftpPart(form)).toContain('<textarea placeholder="Paste private key (PEM format)" bind:value={destPrivateKey}');
		}
		expect(markup.split('bind:value={destPrivateKey}')).toHaveLength(3);
		// The edit form is filled with what the GET shows, the mask for a stored
		// key, and sends it back as it is, as it does the password.
		const populating = functionNamed(tree, 'populateDestForm').body!.statements.find(ts.isIfStatement)!;
		expect(statementsOf(populating.thenStatement, "destPassword = (dest.password as string) || ''")).toHaveLength(1);
		expect(statementsOf(populating.thenStatement, "destPrivateKey = (dest.privateKey as string) || ''")).toHaveLength(1);
	});

	it('reads the backup settings again quietly after a destination is saved, without the loading line in place of the section (the review’s M3)', () => {
		const fn = functionNamed(tree, 'loadBackupConfig');
		expect(fn.parameters.map((parameter) => parameter.getText())).toEqual(['quiet = false']);
		const loading = statementsOf(fn, 'backupLoading = true');
		expect(loading).toHaveLength(1);
		expect(ts.isIfStatement(loading[0].parent) && loading[0].parent.expression.getText()).toBe('!quiet');
		for (const name of ['addDestination', 'updateDestination', 'confirmHostKey']) {
			expect(callsOf(functionNamed(tree, name), 'loadBackupConfig'), name).toHaveLength(1);
		}
	});

	it('says so when a destination was saved and the settings could not be read back, as the list may still hold a secret as typed (card 2250 fix pass)', async () => {
		// loadBackupConfig is true only when it read the settings and put them on the page.
		const js = ts.transpileModule(functionNamed(tree, 'loadBackupConfig').getText(), {
			compilerOptions: { target: ts.ScriptTarget.ES2022 }
		}).outputText;
		const load = (answer: () => Promise<unknown>) =>
			new Function(
				'fetch',
				'let backupLoading, backupSchedule, backupScheduleTime, backupScheduleDay, backupRetention, backupNotifyOnFailure, backupNotifyEmail, backupHistory;\n' +
					`let backupDestinations = ['typed'];\n${js}\nreturn async () => [await loadBackupConfig(true), backupDestinations];`
			)(answer)() as Promise<[unknown, unknown]>;
		const read = { ok: true, json: async () => ({ destinations: ['masked'] }) };
		expect(await load(async () => read)).toEqual([true, ['masked']]);
		expect(await load(async () => ({ ok: false, json: async () => ({}) }))).toEqual([false, ['typed']]);
		expect(await load(async () => { throw new TypeError('Failed to fetch'); })).toEqual([false, ['typed']]);

		// Each save that reads them back says so where it could not.
		expect(source).toContain("const SETTINGS_UNREAD = 'Saved, but the page could not read the settings back: reload the page before editing again.';");
		for (const name of ['addDestination', 'updateDestination', 'confirmHostKey']) {
			const fn = functionNamed(tree, name);
			const said = statementsOf(fn, "showToast(SETTINGS_UNREAD, 'error', started)");
			expect(said, name).toHaveLength(1);
			const unread = said[0].parent;
			expect(ts.isIfStatement(unread) && unread.expression.getText(), name).toBe('!(await loadBackupConfig(true))');
		}
		// Confirm still tests, with the key it saved where the list was not read back.
		const confirming = functionNamed(tree, 'confirmHostKey').getText().replace(/\s+/g, ' ');
		expect(confirming.indexOf('await testDestination(backupDestinations.find(d => d.name === name) ?? updated[idx])')).toBeGreaterThan(
			confirming.indexOf("showToast(SETTINGS_UNREAD, 'error', started)")
		);
	});

	it('marks an SFTP destination with no confirmed host key on its card, as Connected marks a Drive one (the review’s S1)', () => {
		const actions = row.slice(row.indexOf('<div class="dest-actions">'), row.indexOf('<div class="dest-card-detail">'));
		const at = actions.indexOf("{#if dest.type === 'sftp' && !dest.hostKey}");
		expect(at).toBeGreaterThan(-1);
		expect(actions.slice(at, actions.indexOf('{/if}', at))).toContain('Host key not confirmed — press Test');
	});

	it('forgets a destination’s host key box when it is added, changed or removed, and drops the answer of a Test overtaken by a later Test or save (the review’s S3)', () => {
		const declared = (name: string) => tree.statements.some((s) => ts.isFunctionDeclaration(s) && s.name?.text === name);
		const js = ts.transpileModule(['byName', 'forgetHostKeyCheck'].filter(declared).map((name) => functionNamed(tree, name).getText()).join('\n'), {
			compilerOptions: { target: ts.ScriptTarget.ES2022 }
		}).outputText;
		const page = new Function(
			`let hostKeyChecks = { NAS: { message: 'old' }, Other: { message: 'kept' } };\nconst hostKeyTests = { NAS: 4 };\n${js}\n` +
				'return { forget: forgetHostKeyCheck, checks: () => hostKeyChecks, tests: hostKeyTests };'
		)() as { forget: (name: string) => void; checks: () => unknown; tests: Record<string, number> };

		page.forget('NAS');
		page.forget('New');
		expect(page.checks()).toEqual({ NAS: null, Other: { message: 'kept' }, New: null });
		expect(page.tests).toEqual({ NAS: 5, New: 1 });

		// A Test takes the next number, and its answer is dropped where the
		// number has moved on by the time it comes back.
		const fn = functionNamed(tree, 'testDestination');
		const text = fn.getText().replace(/\s+/g, ' ');
		const take = text.indexOf('const ticket = (byName(hostKeyTests, dest.name) ?? 0) + 1; hostKeyTests[dest.name] = ticket;');
		const drop = text.indexOf('if (byName(hostKeyTests, dest.name) !== ticket) return;');
		expect(take).toBeGreaterThan(-1);
		expect(take).toBeLessThan(text.indexOf('sent('));
		expect(drop).toBeGreaterThan(text.indexOf('const result = await answerBody(res);'));
		expect(drop).toBeLessThan(text.indexOf('hostKeyChecks = { ...hostKeyChecks, [dest.name]: check };'));
		expect(drop).toBeLessThan(text.indexOf('showToast('));
	});

	/** The Test button's markup, and the expression that keeps it disabled while its Test waits. */
	const testButton = /<button class="btn-ghost btn-xs" onclick=\{\(\) => testDestination\(dest\)\} disabled=\{([^}]*)\}>\s*\{([^}]*)\} Test/.exec(row);
	/** The condition the host key box under a destination is shown on. */
	const hostKeyBox = /\{#if (dest\.type === 'sftp' && [^}]*hostKeyChecks[^}]*)\}/.exec(row);

	/**
	 * testDestination, forgetHostKeyCheck and hostKeyCheckOf compiled from the
	 * page and run (card 2268), with hostKeyTests as the page declares it,
	 * `sent` a stand-in whose answers the test gives one at a time, and
	 * `waiting(name)` and `shown(name)` the Test button's own disabled
	 * expression and the host key box's condition, read from the markup, so
	 * they are asked exactly what the page asks.
	 */
	function testing() {
		const declared = (name: string) => tree.statements.some((s) => ts.isFunctionDeclaration(s) && s.name?.text === name);
		const hostKeyTests = tree.statements.find(
			(s) => ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => d.name.getText() === 'hostKeyTests')
		)!;
		const js = ts.transpileModule(
			[
				hostKeyTests.getText(),
				...['byName', 'testDestination', 'forgetHostKeyCheck', 'hostKeyCheckOf'].filter(declared).map((name) => functionNamed(tree, name).getText())
			].join('\n'),
			{ compilerOptions: { target: ts.ScriptTarget.ES2022 } }
		).outputText;
		const answers: Array<(res: Response | null) => void> = [];
		const sent = vi.fn(() => new Promise<Response | null>((resolve) => answers.push(resolve)));
		const showToast = vi.fn();
		const page = new Function(
			'sent',
			'answerBody',
			'showToast',
			'toasts',
			'fetch',
			'let hostKeyChecks = {};\nlet testsInFlight = {};\nlet testingDest = null;\n' +
				`${js}\n` +
				'return {\n' +
				'\ttest: (name) => testDestination({ type: "sftp", name }),\n' +
				'\tforget: forgetHostKeyCheck,\n' +
				'\tchecks: () => hostKeyChecks,\n' +
				`\twaiting: (name) => { const dest = { name }; return (${testButton![1]}); },\n` +
				`\tshown: (name) => { const dest = { type: "sftp", name }; return Boolean(${hostKeyBox![1]}); }\n` +
				'};'
		)(sent, answerBody, showToast, { navigation: () => 3 }, vi.fn()) as {
			test: (name: string) => Promise<void>;
			forget: (name: string) => void;
			checks: () => Record<string, unknown>;
			waiting: (name: string) => boolean;
			shown: (name: string) => boolean;
		};
		return { ...page, answers, showToast };
	}
	const connected = () => Response.json({ success: true, message: 'Connected to nas.example:22' });

	it('keeps a destination’s Test button waiting until its own Test answers, whatever other Test starts or answers meanwhile (card 2268)', async () => {
		const page = testing();
		const a = page.test('A');
		expect(page.waiting('A')).toBe(true);
		const b = page.test('B');
		expect([page.waiting('A'), page.waiting('B')]).toEqual([true, true]);

		page.answers[1](connected());
		await b;
		expect([page.waiting('A'), page.waiting('B')]).toEqual([true, false]);

		page.answers[0](connected());
		await a;
		expect([page.waiting('A'), page.waiting('B')]).toEqual([false, false]);
		expect(page.showToast).toHaveBeenCalledTimes(2);
	});

	it('drops the answer of a Test overtaken by a save of its destination, and its button still comes back when that answer arrives (card 2268)', async () => {
		const page = testing();
		const a = page.test('A');
		page.forget('A');
		expect(page.waiting('A')).toBe(true);

		page.answers[0](Response.json({ success: false, message: 'not confirmed', hostKey: NEW }));
		await a;
		expect(page.waiting('A')).toBe(false);
		expect(page.showToast).not.toHaveBeenCalled();
		expect(page.checks()).toEqual({ A: null });
	});

	it.each([
		['refused (sent gives null)', () => null],
		['answered with something that is not JSON', () => new Response('<html>502</html>', { status: 200 })]
	])('brings the button back for a Test %s (card 2268)', async (_case, answer) => {
		const page = testing();
		const a = page.test('A');
		expect(page.waiting('A')).toBe(true);
		page.answers[0](answer());
		await a;
		expect(page.waiting('A')).toBe(false);
	});

	it.each(['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'])(
		'treats a destination named %s as any other: its Test button free before a Test, waiting during it and free after, no host key box before a Test, and its Tests numbered (the card 2268 review)',
		async (name) => {
			const page = testing();
			expect(page.waiting(name)).toBe(false);
			expect(page.shown(name)).toBe(false);

			// A Test whose answer speaks of the host key: the button waits for it, and the box shows it.
			const first = page.test(name);
			expect(page.waiting(name)).toBe(true);
			page.answers[0](Response.json({ success: false, message: 'not confirmed', hostKey: NEW }));
			await first;
			expect(page.waiting(name)).toBe(false);
			expect(page.shown(name)).toBe(true);

			// A Test overtaken by a save says nothing, and its button still comes back.
			const second = page.test(name);
			page.forget(name);
			expect(page.shown(name)).toBe(false);
			page.answers[1](connected());
			await second;
			expect(page.waiting(name)).toBe(false);
			expect(page.showToast).not.toHaveBeenCalled();

			// The next Test is its own, and its answer is said.
			const third = page.test(name);
			expect(page.waiting(name)).toBe(true);
			page.answers[2](connected());
			await third;
			expect(page.waiting(name)).toBe(false);
			expect(page.showToast.mock.calls).toEqual([['Connected to nas.example:22', 'success', 3]]);
		}
	);

	it('disables the Test button and shows ⏳ by testsInFlight, and testingDest is gone from the page (card 2268)', () => {
		expect(testButton).not.toBeNull();
		expect(testButton![1]).toBe('byName(testsInFlight, dest.name) !== undefined');
		expect(testButton![2]).toBe("byName(testsInFlight, dest.name) !== undefined ? '⏳' : '🧪'");
		expect(everywhere).not.toContain('testingDest');
		expect(tree.getText()).toContain('let testsInFlight = $state<Record<string, number>>({});');
	});

	it('reads each record kept by destination name through byName, never by indexing it (the card 2268 review)', () => {
		const script = tree.getText();
		for (const record of ['testsInFlight', 'hostKeyChecks', 'hostKeyTests']) {
			// Indexed only to be written, or by the spread and destructuring that copy own names alone.
			const indexed = [...script.matchAll(new RegExp(`\\b${record}\\[[^\\]]+\\](?!\\s*=[^=])`, 'g'))].map((m) => m[0]);
			expect(indexed, record).toEqual([]);
			expect(markup.match(new RegExp(`\\b${record}\\[`, 'g')), record).toBeNull();
		}
		expect(hostKeyBox![1]).toBe("dest.type === 'sftp' && byName(hostKeyChecks, dest.name)");
		expect(row).toContain('{@const check = byName(hostKeyChecks, dest.name)!}');
	});
});

// ─── Pages that said nothing when a read or a send failed (cards 2262, 2263, 2272) ───
//
// The Audit Log swallowed every failure, and kept the rows of the search
// before under it. The inbox's conversation, its Accept and Reject, its list
// and its thread read acted on a success alone, and a request that got no
// answer threw and left a button on "..." for good; the requester's reply page
// the same for a reply. Each now says what the server said, on a line where
// the reader is looking, keeps what was typed, and clears its flag in a
// `finally`. The functions are run as written, with stand-ins for `fetch`.

/** The named functions of a page's script, as written, made into JavaScript that can be run. */
function runnable(tree: ts.SourceFile, names: string[]): string {
	return ts.transpileModule(names.map((name) => functionNamed(tree, name).getText()).join('\n'), {
		compilerOptions: { target: ts.ScriptTarget.ES2022 }
	}).outputText;
}

/** A stand-in `fetch` that gives each request to `answer`, and keeps what it was asked, as `METHOD url`. */
function fetchBy(answer: (url: string, init?: RequestInit) => Response | Promise<Response>) {
	const asked: string[] = [];
	const fetch = async (url: string, init?: RequestInit) => {
		asked.push(`${init?.method ?? 'GET'} ${url}`);
		return answer(url, init);
	};
	return { fetch, asked };
}

const answered = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const noAnswer = () => {
	throw new TypeError('Failed to fetch');
};

describe('the Audit Log says why an answer failed, src/routes/audit/+page.svelte (card 2262)', () => {
	const audit = svelteFile('src/routes/audit/+page.svelte');
	const loading = functionNamed(audit.tree, 'loadAudit');

	/** `loadAudit` as written, with a page of two rows, a stand-in `fetch` and the page's state as plain variables. */
	function auditLog(answer: (url: string) => Response | Promise<Response>) {
		const { fetch, asked } = fetchBy(answer);
		const page = new Function(
			'fetch',
			'failureMessage',
			"let auditRows = [], auditLoading = false, auditExhausted = false, auditError = '', auditAsked = 0;\n" +
				"const AUDIT_PAGE = 2;\nlet fBoardId = '', fUserId = '', fAction = '', fSource = '', fFrom = '', fTo = '';\n" +
				`${runnable(audit.tree, ['loadAudit', 'clearAudit'])}\n` +
				'return { loadAudit, get state() { return { rows: auditRows.map((row) => row.id), loading: auditLoading, exhausted: auditExhausted, error: auditError }; } };'
		)(fetch, failureMessage) as { loadAudit: (reset: boolean) => Promise<void>; readonly state: { rows: number[]; loading: boolean; exhausted: boolean; error: string } };
		return Object.assign(page, { asked });
	}

	const REVERSED = () => answered(400, { message: '`from` is after `to`' });
	// A full page of two says more follows, as the route's `hasMore` would here; Load more reads it (card 2383).
	const PAGE = (...ids: number[]) => () => answered(200, { data: ids.map((id) => ({ id })), pagination: { hasMore: ids.length === 2 } });

	it('shows no earlier answer under a refused Apply, says the server’s words, and clears them on the next answer that works', async () => {
		let next: () => Response = PAGE(1, 2);
		const page = auditLog(() => next());

		await page.loadAudit(true);
		expect(page.state).toEqual({ rows: [1, 2], loading: false, exhausted: false, error: '' });

		next = REVERSED;
		await page.loadAudit(true);
		// The rows of the search before were left on screen under the refusal.
		expect(page.state).toEqual({ rows: [], loading: false, exhausted: true, error: '`from` is after `to`' });

		next = PAGE(3);
		await page.loadAudit(true);
		expect(page.state).toEqual({ rows: [3], loading: false, exhausted: true, error: '' });
	});

	it('keeps the rows read for a refused Load more, with the button to try again', async () => {
		let next: () => Response = PAGE(1, 2);
		const page = auditLog(() => next());
		await page.loadAudit(true);

		next = () => answered(503, { message: 'Service Unavailable' });
		await page.loadAudit(false);
		expect(page.state).toEqual({ rows: [1, 2], loading: false, exhausted: false, error: 'Service Unavailable' });
		expect(page.asked.at(-1)).toContain('offset=2');
	});

	it('says when no answer came, and stops saying "Loading…", for Apply and for Load more', async () => {
		let next: () => Response = PAGE(1, 2);
		const page = auditLog(() => next());
		await page.loadAudit(true);

		next = noAnswer;
		await page.loadAudit(false);
		expect(page.state).toEqual({ rows: [1, 2], loading: false, exhausted: false, error: 'No answer from the server. The audit log was not read.' });
		await page.loadAudit(true);
		expect(page.state).toEqual({ rows: [], loading: false, exhausted: true, error: 'No answer from the server. The audit log was not read.' });
	});

	it('shows no older answer over a newer Apply’s, refused or not, and stops saying "Loading…" only for the newest (the review)', async () => {
		const replies: ((res: Response) => void)[] = [];
		const page = auditLog(() => new Promise<Response>((done) => replies.push(done)));

		const older = page.loadAudit(true);
		const newer = page.loadAudit(true);
		replies[1](PAGE(3)());
		await newer;
		expect(page.state).toEqual({ rows: [3], loading: false, exhausted: true, error: '' });

		replies[0](REVERSED());
		await older;
		expect(page.state).toEqual({ rows: [3], loading: false, exhausted: true, error: '' });

		// The other way about: the older answer, a page that worked, comes first and is not shown; the newer still loads.
		const first = page.loadAudit(true);
		const second = page.loadAudit(true);
		replies[2](PAGE(1, 2)());
		await first;
		expect(page.state).toEqual({ rows: [3], loading: true, exhausted: true, error: '' });
		replies[3](PAGE(4)());
		await second;
		expect(page.state).toEqual({ rows: [4], loading: false, exhausted: true, error: '' });
	});

	it('reads a failure with failureMessage on the failed side alone, and clears its flag in a finally', () => {
		const asked = callsOf(loading, 'failureMessage');
		expect(asked.map(sideOf)).toEqual(['failed']);
		expect(asked[0].arguments[1].getText()).toBe("'The audit log could not be read.'");
		expect(statementsOf(loading, 'auditError = failure').map(sideOf)).toEqual(['failed']);
		expect(callsOf(loading, 'res.json').map(sideOf)).toEqual(['ok']);
		expect(statementsOf(loading, "auditError = ''").map(sideOf)).toEqual(['ok']);
		expect(loading.getText()).not.toMatch(/catch\s*\{\s*\/\* silent \*\/\s*\}/);
		expect(finallyBlocks(loading)).toEqual(['{ if (asked === auditAsked) auditLoading = false; }']);
		expect(loading.getText().match(/auditLoading = false/g)).toHaveLength(1);
		expect(audit.tree.getText()).toMatch(/import \{[^}]*\bfailureMessage\b[^}]*\} from '\$lib\/api';/);
	});

	it('shows the line under the filters, and "No audit entries match these filters." only without it', () => {
		expect(audit.around('{auditError}').at(-1)).toEqual({ condition: 'auditError', inElse: false });
		expect(audit.markup).toMatch(/\{#if auditError\}\s*<p class="audit-error" role="alert">\{auditError\}<\/p>\s*\{\/if\}/);
		const line = audit.markup.indexOf('{auditError}');
		expect(line).toBeGreaterThan(audit.markup.indexOf('onclick={() => loadAudit(true)}>Apply</button>'));
		expect(line).toBeLessThan(audit.markup.indexOf('Loading audit log…'));
		expect(audit.around('No audit entries match these filters.').at(-1)).toEqual({ condition: '!auditError', inElse: false });
	});
});

describe('the inbox says when a request, a message or a read failed, src/routes/inbox/+page.svelte (cards 2263 and 2272)', () => {
	const inbox = svelteFile('src/routes/inbox/+page.svelte');
	const fn = (name: string) => functionNamed(inbox.tree, name);
	const REQUEST = { id: 7, title: 'A request', status: 'pending' };

	type Inbox = {
		loadRequests: () => Promise<void>;
		acceptRequest: () => Promise<void>;
		rejectRequest: () => Promise<void>;
		openChat: (req: typeof REQUEST) => Promise<void>;
		closeChat: () => void;
		pollChatMessages: (id: number) => Promise<void>;
		sendChatMessage: () => Promise<void>;
		readonly state: Record<string, any>;
		set: (name: 'acceptModal' | 'rejectModal', value: Record<string, unknown>) => void;
		type: (text: string) => void;
		asked: string[];
		/** The request id each poll started was for. */
		polled: number[];
	};

	/**
	 * The inbox's reads and sends as written, with a stand-in `fetch` and
	 * timer. Each window's state starts as the page declares it, read from its
	 * `$state(...)`, so a field the page leaves out is left out here too.
	 */
	function inboxPage(answer: (url: string, init?: RequestInit) => Response | Promise<Response>): Inbox {
		const { fetch, asked } = fetchBy(answer);
		// A poll started is counted against the request the window shows when it starts.
		let view: Inbox | undefined;
		const polled: number[] = [];
		const startPoll = () => {
			polled.push(view!.state.chatModal.request?.id);
			return 'timer';
		};
		const declared = (name: string) => {
			const found = new RegExp(`let ${name} = \\$state<[^\\n]*>\\(([\\s\\S]*?)\\);`).exec(inbox.tree.getText());
			expect(found, name).not.toBeNull();
			return found![1];
		};
		const page = new Function(
			'fetch',
			'failureMessage',
			'setInterval',
			'clearInterval',
			"let requests = [], loading = true, listError = '';\n" +
				`let acceptModal = ${declared('acceptModal')};\nlet rejectModal = ${declared('rejectModal')};\nlet chatModal = ${declared('chatModal')};\n` +
				'let chatPollInterval = null;\nfunction scrollChatToBottom() {}\n' +
				`${runnable(inbox.tree, ['loadRequests', 'acceptRequest', 'rejectRequest', 'openChat', 'closeChat', 'readThread', 'pollChatMessages', 'sendChatMessage'])}\n` +
				'return { loadRequests, acceptRequest, rejectRequest, openChat, closeChat, pollChatMessages, sendChatMessage,\n' +
				'  get state() { return { requests, loading, listError, acceptModal, rejectModal, chatModal }; },\n' +
				'  set(name, value) { if (name === "acceptModal") acceptModal = value; else rejectModal = value; },\n' +
				'  type(text) { chatModal.newMsg = text; } };'
		)(fetch, failureMessage, startPoll, () => {});
		view = Object.assign(page, { asked, polled }) as Inbox;
		return view;
	}

	describe('the conversation’s send (card 2263)', () => {
		it.each([
			[400, 'Request is already resolved'],
			[401, 'Not authenticated'],
			[400, 'message must be at most 5000 characters']
		])('says a %i refusal under the box in the server’s words, keeps the text and lets it be sent again', async (status, message) => {
			let sending: Response | (() => never) = answered(status, { message });
			const page = inboxPage((url, init) => (init?.method === 'POST' ? (typeof sending === 'function' ? sending() : sending) : answered(200, [])));
			await page.openChat(REQUEST);
			page.type('  Is this still wanted?  ');

			await page.sendChatMessage();
			expect(page.state.chatModal).toMatchObject({ error: message, newMsg: '  Is this still wanted?  ', sending: false });
			// The thread is not read again for a message that was not sent.
			expect(page.asked).toEqual(['GET /api/requests/7/messages', 'POST /api/requests/7/messages']);

			sending = answered(201, { id: 1 });
			await page.sendChatMessage();
			expect(page.state.chatModal).toMatchObject({ error: '', newMsg: '', sending: false });
			expect(page.asked.at(-1)).toBe('GET /api/requests/7/messages');
		});

		it('says when no answer came, and Send is not left on "..."', async () => {
			const page = inboxPage((url, init) => (init?.method === 'POST' ? noAnswer() : answered(200, [])));
			await page.openChat(REQUEST);
			page.type('Hello');

			await page.sendChatMessage();
			expect(page.state.chatModal).toMatchObject({
				error: 'No answer from the server. The message may not have been sent.',
				newMsg: 'Hello',
				sending: false
			});
		});

		it('says nothing in a window that was closed, or shows another request, by the time the answer came', async () => {
			let release: (res: Response) => void = () => {};
			const page = inboxPage((url, init) => (init?.method === 'POST' ? new Promise<Response>((done) => (release = done)) : answered(200, [])));
			await page.openChat(REQUEST);
			page.type('Hello');

			const sent = page.sendChatMessage();
			page.closeChat();
			await page.openChat({ ...REQUEST, id: 8 });
			page.type('Typed in the other window');
			release(answered(400, { message: 'Request is already resolved' }));
			await sent;

			// It threw on `chatModal.request.id` once the window had closed.
			expect(page.state.chatModal).toMatchObject({ request: { id: 8 }, error: '', newMsg: 'Typed in the other window' });
		});

		it('leaves another window’s send on its way when an earlier window’s answer comes (the review)', async () => {
			const releases: Record<string, (res: Response) => void> = {};
			const page = inboxPage((url, init) => (init?.method === 'POST' ? new Promise<Response>((done) => (releases[url] = done)) : answered(200, [])));
			await page.openChat(REQUEST);
			page.type('Hello');
			const first = page.sendChatMessage();
			page.closeChat();
			await page.openChat({ ...REQUEST, id: 8 });
			page.type('From the other window');
			const second = page.sendChatMessage();
			expect(page.state.chatModal.sending).toBe(true);

			releases['/api/requests/7/messages'](answered(201, { id: 1 }));
			await first;
			expect(page.state.chatModal).toMatchObject({ request: { id: 8 }, sending: true, newMsg: 'From the other window' });

			releases['/api/requests/8/messages'](answered(201, { id: 2 }));
			await second;
			expect(page.state.chatModal).toMatchObject({ request: { id: 8 }, sending: false, newMsg: '' });
		});

		it('sends once for a second Send, or Ctrl+Enter, while one is on its way, and keeps what was typed after it was sent (the review)', async () => {
			let release: (res: Response) => void = () => {};
			const page = inboxPage((url, init) => (init?.method === 'POST' ? new Promise<Response>((done) => (release = done)) : answered(200, [])));
			await page.openChat(REQUEST);
			page.type('Hello');

			const sent = page.sendChatMessage();
			await page.sendChatMessage();
			expect(page.asked.filter((a) => a.startsWith('POST'))).toHaveLength(1);

			page.type('Hello, and one more thing');
			release(answered(201, { id: 1 }));
			await sent;
			expect(page.state.chatModal).toMatchObject({ newMsg: 'Hello, and one more thing', sending: false, error: '' });
			expect(page.asked.at(-1)).toBe('GET /api/requests/7/messages');
		});

		it('reads a failure with failureMessage on the failed side alone, clears the box only for a success, and clears its flag in a finally', () => {
			const send = fn('sendChatMessage');
			const asked = callsOf(send, 'failureMessage');
			expect(asked.map(givenTo)).toEqual(['chatModal.error']);
			expect(asked.map(sideOf)).toEqual(['failed']);
			expect(statementsOf(send, "chatModal.newMsg = ''").map(sideOf)).toEqual(['ok']);
			expect(finallyBlocks(send)).toEqual(['{ if (chatModal.request?.id === req.id) chatModal.sending = false; }']);
			expect(send.getText()).toMatch(/^async function sendChatMessage\(\) \{\s*if \(chatModal\.sending\) return;/);
			expect(send.getText().match(/chatModal\.sending = false/g)).toHaveLength(1);
			// The request is taken before the first await, and not read from the window after it.
			expect(send.getText()).not.toContain('chatModal.request.id');
			expect(inbox.tree.getText()).toMatch(/import \{[^}]*\bfailureMessage\b[^}]*\} from '\$lib\/api';/);
		});

		it('shows the line under the box, inside the window', () => {
			expect(inbox.around('{chatModal.error}').at(-1)).toEqual({ condition: 'chatModal.error', inElse: false });
			expect(inbox.markup).toMatch(/\{#if chatModal\.error\}\s*<p class="chat-error" role="alert">\{chatModal\.error\}<\/p>\s*\{\/if\}/);
			expect(inbox.markup.indexOf('{chatModal.error}')).toBeGreaterThan(inbox.markup.indexOf('<div class="chat-input-area">'));
		});
	});

	describe('Accept, Reject, the list and the thread (card 2272)', () => {
		const ACCEPTING = { show: true, request: REQUEST, boardId: 1, columnId: 2, assigneeId: null, sending: false, error: '' };
		const REJECTING = { show: true, request: REQUEST, reason: 'Not this quarter', sending: false, error: '' };

		it('says a refused or unanswered Accept in its window, which stays open with what was chosen', async () => {
			let next: () => Response = () => answered(400, { message: 'Column not found on this board' });
			const page = inboxPage((url, init) => (init?.method === 'PATCH' ? next() : answered(200, [])));

			page.set('acceptModal', { ...ACCEPTING });
			await page.acceptRequest();
			expect(page.state.acceptModal).toEqual({ ...ACCEPTING, error: 'Column not found on this board' });

			next = noAnswer;
			await page.acceptRequest();
			expect(page.state.acceptModal).toEqual({ ...ACCEPTING, error: 'No answer from the server. The request may not have been accepted.' });
			expect(page.asked).toEqual(['PATCH /api/requests/7', 'PATCH /api/requests/7']);

			next = () => answered(200, { ok: true });
			await page.acceptRequest();
			expect(page.state.acceptModal).toMatchObject({ show: false, request: null, sending: false, error: '' });
			expect(page.asked.at(-1)).toBe('GET /api/requests');
		});

		it('says a refused or unanswered Reject in its window, and keeps the reason typed', async () => {
			let next: () => Response = () => answered(400, { message: 'Request already resolved' });
			const page = inboxPage((url, init) => (init?.method === 'PATCH' ? next() : answered(200, [])));

			page.set('rejectModal', { ...REJECTING });
			await page.rejectRequest();
			expect(page.state.rejectModal).toEqual({ ...REJECTING, error: 'Request already resolved' });

			next = noAnswer;
			await page.rejectRequest();
			expect(page.state.rejectModal).toEqual({ ...REJECTING, error: 'No answer from the server. The request may not have been rejected.' });

			next = () => answered(200, { ok: true });
			await page.rejectRequest();
			expect(page.state.rejectModal).toMatchObject({ show: false, request: null, reason: '', sending: false, error: '' });
		});

		it.each(['accept', 'reject'] as const)(
			'reads the list again when %s is refused because someone else resolved the request first, and for no other refusal (the review)',
			async (action) => {
				let next: () => Response = () => answered(400, { message: 'Request already resolved' });
				const page = inboxPage((url, init) => (init?.method === 'PATCH' ? next() : answered(200, [])));
				const send = () => {
					page.set(`${action}Modal`, action === 'accept' ? { ...ACCEPTING } : { ...REJECTING });
					return action === 'accept' ? page.acceptRequest() : page.rejectRequest();
				};

				await send();
				expect(page.asked).toEqual(['PATCH /api/requests/7', 'GET /api/requests']);
				expect(page.state[`${action}Modal`]).toMatchObject({ show: true, error: 'Request already resolved', sending: false });

				next = () => answered(403, { message: 'No edit access to this board' });
				await send();
				expect(page.asked.slice(2)).toEqual(['PATCH /api/requests/7']);

				// The words compared are the route's own.
				expect(readFileSync(join(ROOT, 'src/routes/api/requests/[id]/+server.ts'), 'utf8')).toContain(
					"throw error(400, 'Request already resolved');"
				);
			}
		);

		it.each(['accept', 'reject'] as const)(
			'says nothing in, does not close, and leaves the send of, a %s window that shows another request when the answer comes (the review)',
			async (action) => {
				let release: (res: Response) => void = () => {};
				const page = inboxPage((url, init) => (init?.method === 'PATCH' ? new Promise<Response>((done) => (release = done)) : answered(200, [])));
				const modal = `${action}Modal` as const;
				const open = action === 'accept' ? ACCEPTING : REJECTING;
				const other = { ...open, request: { ...REQUEST, id: 8 }, sending: true };

				for (const answer of [answered(200, { ok: true }), answered(400, { message: 'Column not found on this board' })]) {
					page.set(modal, { ...open });
					const sent = action === 'accept' ? page.acceptRequest() : page.rejectRequest();
					page.set(modal, { ...other });
					release(answer);
					await sent;
					expect(page.state[modal], String(answer.status)).toEqual(other);
				}
				// The accepted one is still read out of the list.
				expect(page.asked).toEqual(['PATCH /api/requests/7', 'GET /api/requests', 'PATCH /api/requests/7']);
			}
		);

		it('says why the list was not read in place of the list, empty, and never stays on "Loading..."', async () => {
			let next: () => Response = () => answered(200, [REQUEST]);
			const page = inboxPage(() => next());

			await page.loadRequests();
			expect(page.state).toMatchObject({ requests: [REQUEST], loading: false, listError: '' });

			next = () => answered(500, { message: 'Internal Error' });
			await page.loadRequests();
			expect(page.state).toMatchObject({ requests: [], loading: false, listError: 'The inbox could not be read.' });

			next = noAnswer;
			await page.loadRequests();
			expect(page.state).toMatchObject({ requests: [], loading: false, listError: 'No answer from the server. The inbox was not read.' });

			next = () => answered(200, [REQUEST]);
			await page.loadRequests();
			expect(page.state).toMatchObject({ requests: [REQUEST], loading: false, listError: '' });
		});

		it('says why the thread was not read where it would be, clears it on the next read that works, and polls whatever happened', async () => {
			let next: () => Response = () => answered(403, { message: 'This request is not addressed to you' });
			const page = inboxPage(() => next());

			await page.openChat(REQUEST);
			expect(page.state.chatModal).toMatchObject({ messages: [], readError: 'This request is not addressed to you' });

			next = () => answered(200, [{ id: 1, message: 'Hi' }]);
			await page.pollChatMessages(7);
			expect(page.state.chatModal).toMatchObject({ messages: [{ id: 1, message: 'Hi' }], readError: '' });

			next = noAnswer;
			await page.openChat(REQUEST);
			expect(page.state.chatModal).toMatchObject({ messages: [], readError: 'No answer from the server. The conversation was not read.' });
		});

		it('puts no request’s messages into a window that shows another one by the time they came', async () => {
			const replies: Record<string, (res: Response) => void> = {};
			const page = inboxPage((url) => new Promise<Response>((done) => (replies[url] = done)));

			const first = page.openChat(REQUEST);
			page.closeChat();
			const second = page.openChat({ ...REQUEST, id: 8 });
			replies['/api/requests/8/messages'](answered(200, [{ id: 2, message: 'For 8' }]));
			await second;
			replies['/api/requests/7/messages'](answered(200, [{ id: 1, message: 'For 7' }]));
			await first;
			expect(page.state.chatModal).toMatchObject({ request: { id: 8 }, messages: [{ id: 2, message: 'For 8' }] });
			// One poll, the open window's: the closed one's read, answered late, starts none.
			expect(page.polled).toEqual([8]);

			// A poll of the first request, answered late, likewise.
			const late = page.pollChatMessages(7);
			replies['/api/requests/7/messages'](answered(200, [{ id: 1 }, { id: 3 }]));
			await late;
			expect(page.state.chatModal.messages).toEqual([{ id: 2, message: 'For 8' }]);
		});

		it('reads each failure with failureMessage on the failed side alone, and clears each flag in a finally', () => {
			const said = (name: string) => callsOf(fn(name), 'failureMessage');
			expect(said('acceptRequest').map(givenTo)).toEqual(['acceptModal.error']);
			expect(said('rejectRequest').map(givenTo)).toEqual(['rejectModal.error']);
			expect(said('loadRequests').map(givenTo)).toEqual(['listError']);
			expect(said('readThread').map(givenTo)).toEqual(['chatModal.readError']);
			for (const name of ['acceptRequest', 'rejectRequest', 'loadRequests', 'readThread']) expect(said(name).map(sideOf), name).toEqual(['failed']);
			expect(finallyBlocks(fn('acceptRequest'))).toEqual(['{ if (acceptModal.request?.id === req.id) acceptModal.sending = false; }']);
			expect(finallyBlocks(fn('rejectRequest'))).toEqual(['{ if (rejectModal.request?.id === req.id) rejectModal.sending = false; }']);
			expect(finallyBlocks(fn('loadRequests'))).toEqual(['{ loading = false; }']);
			// Each window is closed for a success alone.
			for (const [name, modal] of [['acceptRequest', 'acceptModal'], ['rejectRequest', 'rejectModal']]) {
				expect(assignmentsTo(fn(name), modal).map(sideOf), name).toEqual(['ok']);
			}
		});

		it('gives every window it opens or closes an empty line and no send on its way', () => {
			for (const modal of ['acceptModal', 'rejectModal', 'chatModal']) {
				const set = [...inbox.source.matchAll(new RegExp(`${modal} = \\{([^}]*)\\}`, 'g'))].map((m) => m[1]);
				expect(set.length, modal).toBeGreaterThan(1);
				for (const fields of set) {
					expect(fields, modal).toContain("sending: false");
					expect(fields, modal).toContain("error: ''");
				}
			}
			expect(inbox.source.match(/chatModal = \{[^}]*\}/g)!.every((set) => set.includes("readError: ''"))).toBe(true);
		});

		it('shows each line where its window or list is read, and disables Accept and Reject while one is on its way', () => {
			// Accept's and Reject's above their buttons.
			for (const modal of ['acceptModal', 'rejectModal']) {
				expect(inbox.markup).toMatch(new RegExp(`\\{#if ${modal}\\.error\\}\\s*<p class="modal-error" role="alert">\\{${modal}\\.error\\}</p>\\s*\\{/if\\}\\s*<div class="modal-actions">`));
			}
			expect(inbox.markup).toContain('disabled={!acceptModal.boardId || !acceptModal.columnId || acceptModal.sending}');
			expect(inbox.markup).toContain('<button class="btn-reject-confirm" disabled={rejectModal.sending} onclick={rejectRequest}>');
			// The list's in place of the list.
			expect(inbox.markup).toMatch(/\{:else if listError\}\s*<p class="inbox-error" role="alert">\{listError\}<\/p>\s*\{:else if pendingRequests\.length === 0/);
			// The thread's in the thread, and "No messages yet" only without it.
			expect(inbox.markup).toMatch(/<div class="chat-messages" bind:this=\{chatMessagesEl\}>\s*\{#if chatModal\.readError\}\s*<p class="chat-read-error" role="alert">\{chatModal\.readError\}<\/p>\s*\{\/if\}/);
			expect(inbox.around('No messages yet. Start the conversation!').at(-1)).toEqual({ condition: 'chatModal.messages.length === 0 && !chatModal.readError', inElse: false });
		});
	});
});

describe('the requester’s reply page says when a reply was not sent, src/routes/request/[id]/reply/+page.svelte (card 2272)', () => {
	const REPLY = 'src/routes/request/[id]/reply/+page.svelte';
	const tree = scriptOf(REPLY);

	/**
	 * `sendReply` as written, with a stand-in `fetch`; the thread's reload and
	 * the link form are counted, not run, and so is a reload of the whole page
	 * (`loadData`, which shows "Loading..." in place of everything).
	 */
	function replyBox(answer: (url: string, init?: RequestInit) => Response | Promise<Response>) {
		const { fetch, asked } = fetchBy(answer);
		const page = new Function(
			'fetch',
			'failureMessage',
			"let newMessage = '', sending = false, errorMsg = '', reloaded = 0, wholePage = 0, linkGone = false;\nconst requestId = 5, token = 'the-link';\n" +
				'async function readThread() { reloaded++; }\nasync function loadData() { wholePage++; }\nfunction showLinkGone() { linkGone = true; }\n' +
				`${runnable(tree, ['sendReply'])}\n` +
				'return { sendReply, type(text) { newMessage = text; }, get state() { return { newMessage, sending, errorMsg, reloaded, linkGone }; }, get wholePage() { return wholePage; } };'
		)(fetch, failureMessage) as { sendReply: () => Promise<void>; type: (text: string) => void; readonly state: Record<string, unknown>; readonly wholePage: number };
		return Object.assign(page, { asked });
	}

	it('says a refusal in the server’s words and keeps the text; no answer says so, and "Sending..." is not left on', async () => {
		let next: () => Response = () => answered(400, { message: 'message must be at most 5000 characters' });
		const page = replyBox(() => next());
		page.type('Any news?');

		await page.sendReply();
		expect(page.state).toEqual({ newMessage: 'Any news?', sending: false, errorMsg: 'message must be at most 5000 characters', reloaded: 0, linkGone: false });

		next = noAnswer;
		await page.sendReply();
		expect(page.state).toEqual({ newMessage: 'Any news?', sending: false, errorMsg: 'No answer from the server. The reply may not have been sent.', reloaded: 0, linkGone: false });

		// A 404 is a link that no longer works (card 2158), as it was.
		next = () => answered(404, { message: 'Request not found' });
		await page.sendReply();
		expect(page.state).toMatchObject({ newMessage: 'Any news?', sending: false, linkGone: true });

		next = () => answered(201, { id: 1 });
		await page.sendReply();
		expect(page.state).toMatchObject({ newMessage: '', sending: false, errorMsg: '', reloaded: 1 });
		// The thread alone is read again, and the page is not replaced by "Loading..." (the review).
		expect(page.wholePage).toBe(0);
	});

	it('sends once for a second Send Reply, or Ctrl+Enter, while one is on its way, and keeps what was typed after it was sent (the review)', async () => {
		let release: (res: Response) => void = () => {};
		const page = replyBox(() => new Promise<Response>((done) => (release = done)));
		page.type('Any news?');

		const sent = page.sendReply();
		await page.sendReply();
		expect(page.asked).toEqual(['POST /api/requests/5/messages']);

		page.type('Any news? And one more thing');
		release(answered(201, { id: 1 }));
		await sent;
		expect(page.state).toMatchObject({ newMessage: 'Any news? And one more thing', sending: false, reloaded: 1 });
	});

	it('reads a failure with failureMessage, and clears its flag in a finally', () => {
		const send = functionNamed(tree, 'sendReply');
		expect(callsOf(send, 'failureMessage').map(givenTo)).toEqual(['errorMsg']);
		expect(callsOf(send, 'res.json')).toEqual([]);
		expect(finallyBlocks(send)).toEqual(['{ sending = false; }']);
		expect(send.getText().match(/sending = false/g)).toHaveLength(1);
		expect(send.getText()).toMatch(/^async function sendReply\(\) \{\s*if \(sending \|\| /);
		expect(callsOf(send, 'loadData')).toEqual([]);
	});

	describe('its thread read (the review)', () => {
		/** `loadData`, `readThread` and `pollMessages` as written, with a stand-in `fetch` and timer. */
		function thread(answer: (url: string) => Response | Promise<Response>) {
			const { fetch } = fetchBy(answer);
			return new Function(
				'fetch',
				'failureMessage',
				'setInterval',
				'clearInterval',
				"let request = null, messages = [], loading = true, errorMsg = '', threadError = '', linkGone = false, pollInterval = null;\n" +
					"const requestId = 5, token = 'the-link';\nfunction scrollToBottom() {}\n" +
					`${runnable(tree, ['loadData', 'readThread', 'pollMessages', 'showLinkGone', 'stopPolling'])}\n` +
					'return { loadData, pollMessages, get state() { return { loading, messages, threadError, linkGone, polling: pollInterval }; } };'
			)(fetch, failureMessage, () => 'timer', () => {}) as { loadData: () => Promise<void>; pollMessages: () => Promise<void>; readonly state: Record<string, unknown> };
		}
		const REQUEST = answered(200, { id: 5, title: 'A request', status: 'pending' });

		it('says why the thread was not read where it would be, and the next poll that works clears it', async () => {
			let messages: () => Response | never = () => answered(500, { message: 'Internal Error' });
			const page = thread((url) => (url.includes('/messages') ? messages() : REQUEST.clone()));

			await page.loadData();
			expect(page.state).toEqual({ loading: false, messages: [], threadError: 'The conversation could not be read.', linkGone: false, polling: 'timer' });

			messages = () => answered(200, [{ id: 1, message: 'Hi' }]);
			await page.pollMessages();
			expect(page.state).toMatchObject({ messages: [{ id: 1, message: 'Hi' }], threadError: '' });

			messages = noAnswer;
			await page.loadData();
			expect(page.state).toMatchObject({ loading: false, threadError: 'No answer from the server. The conversation was not read.' });
		});

		it('shows the line in the thread, and "No messages yet" only without it', () => {
			const reply = svelteFile(REPLY);
			expect(reply.markup).toMatch(/<div class="messages-thread" bind:this=\{threadEl\}>\s*\{#if threadError\}\s*<p class="thread-error" role="alert">\{threadError\}<\/p>\s*\{\/if\}/);
			expect(reply.around('No messages yet. Start the conversation below.').at(-1)).toEqual({ condition: 'messages.length === 0 && !threadError', inElse: false });
		});
	});
});

// Card 2280, slice B2a of card 2012's part B. The board page read its whole
// load again (`invalidateAll`) after its own writes and on every event of its
// stream, and an `$effect` copied each load over what it drew, so anyone's
// change put a drag in hand back under the user's hand. It draws from one
// board state now (`$lib/board/board-state.svelte.ts`, slice B1), which reads
// the board's contents alone, a burst as one read, and not while a drag or a
// write of the page's own is out. How each write applies is unchanged (B2b).
describe('the board page draws from its board state and reads the board alone (card 2280, slice B2a)', () => {
	const PAGE = 'src/routes/board/[id]/+page.svelte';
	const board = () => scriptOf(PAGE);
	const source = () => readFileSync(join(ROOT, PAGE), 'utf8');
	const flat = (node: ts.Node) => node.getText().replace(/\s+/g, ' ');
	/** The function given to each call of `name` made as the script runs. */
	const handedTo = (tree: ts.SourceFile, name: string) =>
		tree.statements
			.filter((statement): statement is ts.ExpressionStatement => ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) && statement.expression.expression.getText() === name)
			.map((statement) => (statement.expression as ts.CallExpression).arguments[0]);

	it('calls no invalidateAll: the page hands it to the board state, whose refused read is the one call left', () => {
		const tree = board();
		const uses: ts.Identifier[] = [];
		const visit = (node: ts.Node) => {
			if (ts.isIdentifier(node) && node.text === 'invalidateAll') uses.push(node);
			ts.forEachChild(node, visit);
		};
		visit(tree);
		// Imported, and handed to the board state as its `invalidate`; never called.
		expect(uses.map((use) => ts.SyntaxKind[use.parent.kind])).toEqual(['ImportSpecifier', 'PropertyAssignment']);
		const handed = uses[1].parent as ts.PropertyAssignment;
		expect(handed.name.getText()).toBe('invalidate');
		expect(ts.findAncestor(handed, ts.isNewExpression)?.expression.getText()).toBe('BoardState');
		expect(source().slice(source().indexOf('</script>'))).not.toContain('invalidateAll');

		// Nor the modules and components the board page draws and writes with.
		const dirs = ['src/lib/board', 'src/lib/components/board', 'src/lib/components/card'].filter((dir) => existsSync(join(ROOT, dir)));
		const files = dirs.flatMap((dir) => [...filesUnder(dir, '.ts'), ...filesUnder(dir, '.svelte')]);
		expect(files).toContain('src/lib/board/board-state.svelte.ts');
		for (const file of files) {
			const text = readFileSync(join(ROOT, file), 'utf8');
			expect(text, file).not.toMatch(/\binvalidateAll\s*\(/);
			expect(text, file).not.toMatch(/import[^;]*\binvalidateAll\b[^;]*from '\$app\/navigation'/);
		}
		// The board state's own: once, where the read is refused (R6).
		const state = ts.createSourceFile('board-state.ts', readFileSync(join(ROOT, 'src/lib/board/board-state.svelte.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
		const asked = callsOf(state, 'this.#invalidate');
		expect(asked).toHaveLength(1);
		expect(ts.findAncestor(asked[0], ts.isMethodDeclaration)?.name.getText()).toBe('#refuse');
	});

	it('hands the stream’s access event to the board state at once, and every other update, reconnect and return to the tab to its refresh', () => {
		// The stream says what each update was ($lib/board/sse.ts).
		const listeners = new Map<string, (e: { data: string }) => void>();
		const opened: { onopen: (() => void) | null }[] = [];
		let onVisible: (() => void) | null = null;
		vi.stubGlobal(
			'EventSource',
			class {
				onopen: (() => void) | null = null;
				onerror: (() => void) | null = null;
				constructor() {
					opened.push(this);
				}
				addEventListener(type: string, listener: (e: { data: string }) => void) {
					listeners.set(type, listener);
				}
				close() {}
			}
		);
		vi.stubGlobal('document', {
			visibilityState: 'visible',
			addEventListener: (type: string, listener: () => void) => {
				if (type === 'visibilitychange') onVisible = listener;
			},
			removeEventListener: () => {}
		});
		const told: unknown[] = [];
		try {
			const close = connectSSE(7, { onUpdate: (event) => told.push(event), onCelebrate: () => {}, onXpUpdate: () => {} });
			listeners.get('update')!({ data: JSON.stringify({ type: 'access' }) });
			listeners.get('update')!({ data: JSON.stringify({ type: 'card', id: 5 }) });
			listeners.get('update')!({ data: 'not JSON' });
			listeners.get('update')!({ data: '5' });
			onVisible!();
			opened[0].onopen!(); // the first open: the page's load is current
			opened[0].onopen!(); // an open after a gap
			close();
		} finally {
			vi.unstubAllGlobals();
		}
		expect(told).toEqual([{ type: 'access' }, { type: 'card', id: 5 }, null, null, null, null]);

		// And the page sends the access event to `accessChanged`, which is never
		// held, and everything else to `refresh`, a burst as one read.
		const sse = callsOf(board(), 'connectSSE');
		expect(sse).toHaveLength(1);
		const callbacks = sse[0].arguments[1] as ts.ObjectLiteralExpression;
		const onUpdate = callbacks.properties.find((property) => property.name?.getText() === 'onUpdate') as ts.PropertyAssignment;
		const called: string[] = [];
		const state = { refresh: () => called.push('refresh'), accessChanged: () => called.push('accessChanged') };
		// The card window is open on card 5. Its comments changed, or the page
		// was away (null), raises the window's `commentsTold` (card 2282); its
		// files changed, or the same gaps, its `attachmentsTold` (card 2337).
		const { route, commentsTold, attachmentsTold } = new Function(
			'boardState',
			'cardWindow',
			'commentsChanged',
			'attachmentsChanged',
			`let commentsTold = 0; let attachmentsTold = 0; const route = ${ts.transpile(onUpdate.initializer.getText(), { target: ts.ScriptTarget.ES2022 })}; return { route, commentsTold: () => commentsTold, attachmentsTold: () => attachmentsTold };`
		)(state, { cardId: 5 }, commentsChanged, attachmentsChanged);
		const counts = () => [commentsTold(), attachmentsTold()];
		route({ type: 'access' });
		route({ type: 'card', id: 5 });
		expect(counts()).toEqual([0, 0]);
		route({ type: 'comment', cardId: 6 });
		expect(counts()).toEqual([0, 0]);
		route({ type: 'comment', cardId: 5 });
		expect(counts()).toEqual([1, 0]);
		route({ type: 'attachment', cardId: 6 });
		expect(counts()).toEqual([1, 0]);
		route({ type: 'attachment', cardId: 5 });
		expect(counts()).toEqual([1, 1]);
		route(null);
		expect(counts()).toEqual([2, 2]);
		route(undefined);
		expect(counts()).toEqual([3, 3]);
		expect(called).toEqual(['accessChanged', 'refresh', 'refresh', 'refresh', 'refresh', 'refresh', 'refresh', 'refresh']);
		// And the window is handed the counts, inside its own tag.
		const page = readFileSync(join(ROOT, 'src/routes/board/[id]/+page.svelte'), 'utf8');
		expect(page).toMatch(/<CardModal\b(?:(?!\/>)[\s\S])*\{commentsTold\}(?:(?!\/>)[\s\S])*\/>/);
		expect(page).toMatch(/<CardModal\b(?:(?!\/>)[\s\S])*\{attachmentsTold\}(?:(?!\/>)[\s\S])*\/>/);
	});

	it('holds the reads from a drag’s first move, before the columns change, until the move’s answer, let go in a finally', () => {
		const tree = board();
		// One hold per drag, taken at its first move, before the columns change;
		// one the watchdog has let go is not used again (the review). And the
		// columns as the drag found them, copied once, to put back a move refused,
		// blocked or cancelled (slice B2b).
		expect(flat(functionNamed(tree, 'holdDrag').body!)).toBe('{ if (!dragHold || dragHold.released) dragHold = boardState.hold(); dragFrom ??= copyColumns(boardState.columns); }');
		for (const name of ['handleCardDndConsider', 'handleColumnDndConsider']) {
			const steps = functionNamed(tree, name).body!.statements.map(flat);
			// A keyboard drag ends with a consider and no drop: its hold is let go there, not taken.
			expect(steps[0], name).toMatch(/^if \(e\.detail\.info\?\.trigger === TRIGGERS\.DRAG_STOPPED\) \{ .* stopDrag\(\); return; \}$/);
			expect(steps[1], name).toBe('holdDrag();');
		}
		expect(flat(functionNamed(tree, 'stopDrag').body!)).toBe('{ dragHold?.(); dragHold = null; dragFrom = null; }');
		expect(flat(functionNamed(tree, 'takeDragFrom').body!)).toBe('{ const from = dragFrom ?? copyColumns(boardState.columns); dragFrom = null; return from; }');
		// Taken over by the drop that sends the move (a drop with no first move holds then).
		expect(flat(functionNamed(tree, 'takeDragHold').body!)).toBe('{ const release = dragHold && !dragHold.released ? dragHold : boardState.hold(); dragHold = null; return release; }');

		for (const [name, sends] of [
			['handleCardDndFinalize', 'dndHandlers.handleCardDndFinalize'],
			['handleColumnDndFinalize', 'dndHandlers.handleColumnDndFinalize']
		]) {
			const fn = functionNamed(tree, name);
			const sent = callsOf(fn, sends);
			expect(sent, name).toHaveLength(1);
			const taken = fn.body!.statements.filter((statement) => flat(statement) === 'const release = takeDragHold();');
			expect(taken, name).toHaveLength(1);
			const tried = ts.findAncestor(sent[0], ts.isTryStatement)!;
			expect(tried.getStart(), name).toBeGreaterThan(taken[0].getStart());
			expect(flat(tried.finallyBlock!), name).toMatch(/\brelease\(\);/);
		}

		// The zone a card left takes its items, holds nothing and lets nothing go.
		const finalize = flat(functionNamed(tree, 'handleCardDndFinalize'));
		const leaving = finalize.slice(finalize.indexOf('if (e.detail.info?.trigger === TRIGGERS.DROPPED_INTO_ANOTHER) {'));
		const branch = leaving.slice(0, leaving.indexOf('return;') + 'return;'.length);
		expect(branch).toContain('takeCardItems(columnId, e);');
		expect(branch).not.toMatch(/hold|release/i);
		expect(finalize.indexOf('TRIGGERS.DROPPED_INTO_ANOTHER')).toBeLessThan(finalize.indexOf('const release = takeDragHold();'));

		// A move into On Hold is sent once the note is confirmed: the note window
		// holds, out of the watchdog's reach, until Confirm is answered or Cancel
		// (the review); the drag's own hold is let go as the window opens.
		const clauses: ts.CaseClause[] = [];
		const visitClauses = (node: ts.Node) => {
			if (ts.isCaseClause(node)) clauses.push(node);
			ts.forEachChild(node, visitClauses);
		};
		visitClauses(functionNamed(tree, 'handleCardDndFinalize'));
		expect(clauses.filter((clause) => flat(clause).includes('onHoldRelease = boardState.hold({ watchdog: false });')).map((clause) => clause.expression.getText())).toEqual(["'on-hold'"]);
		const confirm = functionNamed(tree, 'confirmOnHold');
		const confirmTry = ts.findAncestor(callsOf(confirm, 'dndHandlers.confirmOnHold')[0], ts.isTryStatement)!;
		// Closed and let go together, answered or not: a second Confirm cannot be
		// sent unheld. Kept open, and held, only for a note refused after the move
		// was taken (slice B2b); a success is not read again (its echo is), a
		// throw is (the re-check).
		expect(flat(confirmTry.finallyBlock!)).toBe(
			"{ if (!noteKept) { onHoldState = { show: false, cardId: 0, cardTitle: '', note: '', pendingUpdates: [], pendingColumnId: 0 }; onHoldFrom = null; releaseOnHold(); } }"
		);
		expect(flat(confirmTry.catchClause!)).toBe("catch { toasts.add('No answer from the server. The card may not have been put on hold.', 'error', started); boardState.refresh(); }");
		expect(callsOf(functionNamed(tree, 'cancelOnHold'), 'releaseOnHold')).toHaveLength(1);
		expect(flat(functionNamed(tree, 'releaseOnHold').body!)).toBe('{ onHoldRelease?.(); onHoldRelease = null; }');

		// The blocked window holds the same way while it is open (R6; slice B2b), let go by its Confirm or Cancel.
		expect(clauses.filter((clause) => flat(clause).includes('blockedRelease = boardState.hold({ watchdog: false });')).map((clause) => clause.expression.getText())).toEqual(["'blocked'"]);
		expect(flat(functionNamed(tree, 'closeBlocked').body!)).toBe('{ blockedState.show = false; releaseBlocked(); }');
		expect(flat(functionNamed(tree, 'releaseBlocked').body!)).toBe('{ blockedRelease?.(); blockedRelease = null; }');
		const modal = source().slice(source().indexOf('{#if blockedState.show}'));
		const blockedModal = modal.slice(0, modal.indexOf('{/if}')).replace(/\s+/g, ' ');
		expect(blockedModal).toContain('onConfirm={() => { closeBlocked();');
		expect(blockedModal).toContain('onCancel={closeBlocked}');
	});

	describe('the drag’s and the note window’s holds, run against a real refresh schedule (the review)', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});
		afterEach(() => {
			vi.useRealTimers();
		});

		/**
		 * The page's drag and On Hold functions as written, with a stand-in
		 * board state whose `hold` and `refresh` are a real `refreshSchedule`'s,
		 * and `dndHandlers` answering as `next` says.
		 */
		function dragPage() {
			let reads = 0;
			const schedule = refreshSchedule(async () => {
				reads++;
			});
			// Card 5 in In Progress (slice B2b: a move not made is put back from the columns as the drag found them).
			const five = { id: 5, columnId: 1, position: 0, title: 'Ship it' };
			const state = {
				columns: [
					{ id: 1, title: 'In Progress', position: 0, cards: [five] },
					{ id: 2, title: 'On Hold', position: 1, cards: [] as unknown[] }
				],
				columnSorts: {},
				setSort: () => {},
				refresh: () => schedule.schedule(),
				hold: (options?: { watchdog?: boolean }) => schedule.hold(options),
				// The board state's write, as far as the drag needs it: held while out, the change put back on a refusal, the board read then.
				write: async (change: ((columns: unknown[]) => { columns: never[]; undo: (current: unknown[]) => never[] }) | null, send: () => Promise<Response>, words: { refused: string }) => {
					const release = schedule.hold();
					const patched = change ? change(state.columns) : null;
					if (patched) state.columns = patched.columns;
					try {
						const res = await send();
						if (res.ok) return { ok: true, res, answer: null };
						if (patched) state.columns = patched.undo(state.columns);
						schedule.schedule();
						return { ok: false, failure: words.refused };
					} finally {
						schedule.settled();
						release();
					}
				}
			};
			const next: { finalize: unknown; confirm: () => Promise<{ failure: string | null; noteFailure: string | null }>; columns: Response } = {
				finalize: { action: 'committed', updatedColumns: state.columns, movedCards: [], updates: [] },
				confirm: async () => ({ failure: null, noteFailure: null }),
				columns: new Response('{}')
			};
			const confirmed: { note: string; pendingUpdates: unknown[] }[] = [];
			const dnd = {
				handleCardDndFinalize: async () => next.finalize,
				handleColumnDndFinalize: async () => next.columns,
				confirmOnHold: (held: { note: string; pendingUpdates: unknown[] }) => {
					confirmed.push({ note: held.note, pendingUpdates: held.pendingUpdates });
					return next.confirm();
				}
			};
			const said: unknown[][] = [];
			const names = [
				'holdDrag', 'takeDragHold', 'takeDragFrom', 'stopDrag', 'takeCardItems', 'handleCardDndConsider', 'handleColumnDndConsider', 'handleCardDndFinalize', 'handleColumnDndFinalize',
				'releaseOnHold', 'putBackOnHold', 'confirmOnHold', 'cancelOnHold', 'releaseBlocked', 'closeBlocked'
			];
			const page = new Function(
				'boardState', 'dndHandlers', 'TRIGGERS', 'toasts', 'data', 'currentUser', 'playCompleteSound', 'playMoveSound', 'queueCompletionPrompt', 'warnIfStillBlocked',
				'copyColumns', 'undoDrag', 'moveCards', 'patchCard', 'reorderColumns', 'withCurrentCards', 'SOURCES',
				'let dragHold = null; let dragFrom = null; let onHoldRelease = null; let onHoldFrom = null; let blockedRelease = null; let blockedState = { show: false }; let onHoldState = { show: false };\n' +
					`${runnable(board(), names)}\n` +
					`return { ${names.join(', ')}, get onHoldState() { return onHoldState; }, get blockedState() { return blockedState; } };`
			)(
				state, dnd, TRIGGERS, { navigation: () => 'started', add: (...args: unknown[]) => said.push(args) }, { board: { id: 9 } }, { username: 'editor', emoji: '🦊' }, () => {}, () => {}, () => {}, () => {},
				copyColumns, undoDrag, moveCards, patchCard, reorderColumns, withCurrentCards, SOURCES
			);
			const event = (trigger: string, items: unknown[] = []) => ({ detail: { items, info: { trigger, id: 5 } } });
			return { page, schedule, state, next, event, said, confirmed, five, reads: () => reads };
		}

		/** Where each card is: each column's id with its cards' ids. */
		const places = (columns: { id: number; cards: unknown[] }[]) => columns.map((c) => [c.id, c.cards.map((k) => (k as { id: number }).id)]);

		/** Card 5 dragged from In Progress over On Hold, as svelte-dnd-action tells it: picked up, then over the other zone. */
		function dragFiveOver(drag: ReturnType<typeof dragPage>) {
			drag.page.handleCardDndConsider(1, drag.event(TRIGGERS.DRAG_STARTED, []));
			drag.page.handleCardDndConsider(2, drag.event(TRIGGERS.DRAGGED_ENTERED, [drag.five]));
			expect(places(drag.state.columns)).toEqual([
				[1, []],
				[2, [5]]
			]);
		}

		// Card 2280, slice B2b: each move not made is put back from the columns as
		// the drag found them, at once; the blocked and note windows hold the board.
		it('puts a refused drop back where the drag found it at once, says why, and reads the board once', async () => {
			const drag = dragPage();
			dragFiveOver(drag);
			drag.next.finalize = { action: 'refused', message: 'Viewers cannot move cards' };
			await drag.page.handleCardDndFinalize(2, drag.event(TRIGGERS.DROPPED_INTO_ZONE, [drag.five]));
			expect(places(drag.state.columns)).toEqual([
				[1, [5]],
				[2, []]
			]);
			expect(drag.said).toEqual([['Viewers cannot move cards', 'error', 'started']]);
			expect(drag.schedule.holds).toBe(0);
			expect(drag.reads()).toBe(1);
		});

		it('puts a blocked drop back at once, sends nothing, and holds the board while the blocked window is open, however long, until it closes', async () => {
			const drag = dragPage();
			dragFiveOver(drag);
			drag.next.finalize = { action: 'blocked', blockedState: { show: true, card: drag.five, incomplete: 2, reason: 'subtasks', subBoardId: null } };
			await drag.page.handleCardDndFinalize(2, drag.event(TRIGGERS.DROPPED_INTO_ZONE, [drag.five]));
			expect(places(drag.state.columns)).toEqual([
				[1, [5]],
				[2, []]
			]);
			expect(drag.page.blockedState.show).toBe(true);
			// Someone else's change meanwhile is not drawn under the window.
			drag.state.refresh();
			await vi.advanceTimersByTimeAsync(5 * 60_000);
			expect(drag.schedule.holds).toBe(1);
			expect(drag.reads()).toBe(0);
			drag.page.closeBlocked();
			expect(drag.page.blockedState.show).toBe(false);
			expect(drag.schedule.holds).toBe(0);
			expect(drag.reads()).toBe(1);
		});

		it('puts the card back on the note window’s Cancel with no read, and on a refused move with one, writing no note', async () => {
			const drag = dragPage();
			const held = (columns: unknown) => ({ action: 'on-hold', onHoldState: { show: true, cardId: 5, cardTitle: 'Ship it', note: '', pendingUpdates: [{ id: 5, columnId: 2, position: 0 }], pendingColumnId: 2 }, updatedColumns: columns });
			dragFiveOver(drag);
			drag.next.finalize = held(drag.state.columns);
			await drag.page.handleCardDndFinalize(2, drag.event(TRIGGERS.DROPPED_INTO_ZONE, [drag.five]));
			drag.page.cancelOnHold();
			expect(places(drag.state.columns)).toEqual([
				[1, [5]],
				[2, []]
			]);
			expect(drag.schedule.holds).toBe(0);
			expect(drag.reads()).toBe(0);

			dragFiveOver(drag);
			drag.next.finalize = held(drag.state.columns);
			await drag.page.handleCardDndFinalize(2, drag.event(TRIGGERS.DROPPED_INTO_ZONE, [drag.five]));
			drag.next.confirm = async () => ({ failure: 'Viewers cannot move cards', noteFailure: null });
			await drag.page.confirmOnHold();
			expect(places(drag.state.columns)).toEqual([
				[1, [5]],
				[2, []]
			]);
			expect(drag.said).toEqual([['Viewers cannot move cards', 'error', 'started']]);
			expect(drag.page.onHoldState.show).toBe(false);
			expect(drag.schedule.holds).toBe(0);
			expect(drag.reads()).toBe(1);
		});

		it('keeps the note window open, held, on the note typed, when the note alone is refused after the move was taken; its next Confirm sends the note alone', async () => {
			const drag = dragPage();
			dragFiveOver(drag);
			drag.next.finalize = { action: 'on-hold', onHoldState: { show: true, cardId: 5, cardTitle: 'Ship it', note: 'waiting on the supplier', pendingUpdates: [{ id: 5, columnId: 2, position: 0 }], pendingColumnId: 2 }, updatedColumns: drag.state.columns };
			await drag.page.handleCardDndFinalize(2, drag.event(TRIGGERS.DROPPED_INTO_ZONE, [drag.five]));
			drag.next.confirm = async () => ({ failure: null, noteFailure: 'onHoldNote is at most 2000 characters' });
			await drag.page.confirmOnHold();

			// Moved: the card is in On Hold, its column set.
			expect(places(drag.state.columns)).toEqual([
				[1, []],
				[2, [5]]
			]);
			expect(drag.state.columns[1].cards[0]).toMatchObject({ id: 5, columnId: 2 });
			expect(drag.said).toEqual([['"Ship it" was put on hold, but its note was not saved. onHoldNote is at most 2000 characters', 'error', 'started']]);
			expect(drag.page.onHoldState).toMatchObject({ show: true, note: 'waiting on the supplier', pendingUpdates: [] });
			expect(drag.schedule.holds).toBe(1);

			drag.next.confirm = async () => ({ failure: null, noteFailure: null });
			await drag.page.confirmOnHold();
			expect(drag.confirmed.map((c) => c.pendingUpdates.length)).toEqual([1, 0]);
			expect(drag.page.onHoldState.show).toBe(false);
			expect(drag.state.columns[1].cards[0]).toMatchObject({ id: 5, onHoldNote: 'waiting on the supplier' });
			expect(drag.schedule.holds).toBe(0);
		});

		it('puts a refused column drag back in the order the drag found, and says why', async () => {
			const drag = dragPage();
			const [inProgress, onHold] = drag.state.columns;
			drag.page.handleColumnDndConsider(drag.event(TRIGGERS.DRAG_STARTED, [inProgress, onHold]));
			drag.page.handleColumnDndConsider(drag.event(TRIGGERS.DRAGGED_OVER_INDEX, [onHold, inProgress]));
			expect(drag.state.columns.map((c) => c.id)).toEqual([2, 1]);
			drag.next.columns = new Response(JSON.stringify({ message: 'Viewers cannot reorder columns' }), { status: 403 });
			await drag.page.handleColumnDndFinalize(drag.event(TRIGGERS.DROPPED_INTO_ZONE, [onHold, inProgress]));
			expect(drag.state.columns.map((c) => [c.id, c.position])).toEqual([
				[1, 0],
				[2, 1]
			]);
			expect(drag.said).toEqual([['The columns were not reordered.', 'error', 'started']]);
			expect(drag.schedule.holds).toBe(0);
		});

		it('lets a keyboard drag’s hold go at its stop, which comes as a consider with no drop, and a read asked meanwhile goes out at once', async () => {
			// Picked up and put down where it was: no drop at all.
			const { page, schedule, state, event, reads } = dragPage();
			page.handleCardDndConsider(1, event(TRIGGERS.DRAG_STARTED));
			expect(schedule.holds).toBe(1);
			state.refresh();
			await vi.advanceTimersByTimeAsync(2000);
			expect(reads()).toBe(0);
			page.handleCardDndConsider(1, event(TRIGGERS.DRAG_STOPPED));
			expect(schedule.holds).toBe(0);
			expect(reads()).toBe(1);

			// Moved with the arrow keys, each move a drop of its own, then stopped.
			const second = dragPage();
			second.page.handleCardDndConsider(1, second.event(TRIGGERS.DRAG_STARTED));
			await second.page.handleCardDndFinalize(1, second.event(TRIGGERS.DROPPED_INTO_ZONE));
			await second.page.handleCardDndFinalize(1, second.event(TRIGGERS.DROPPED_INTO_ZONE));
			second.page.handleCardDndConsider(1, second.event(TRIGGERS.DRAG_STOPPED));
			expect(second.schedule.holds).toBe(0);

			// The columns' own drag, the same.
			const third = dragPage();
			third.page.handleColumnDndConsider(third.event(TRIGGERS.DRAG_STARTED));
			await third.page.handleColumnDndFinalize(third.event(TRIGGERS.DROPPED_INTO_ZONE));
			third.page.handleColumnDndConsider(third.event(TRIGGERS.DRAG_STOPPED));
			expect(third.schedule.holds).toBe(0);
		});

		it('does not use again a drag’s hold the watchdog has let go: the next drag holds afresh', async () => {
			const { page, schedule, event } = dragPage();
			page.handleCardDndConsider(1, event(TRIGGERS.DRAG_STARTED));
			await vi.advanceTimersByTimeAsync(31_000);
			expect(schedule.holds).toBe(0);
			page.handleCardDndConsider(1, event(TRIGGERS.DRAGGED_OVER_INDEX));
			expect(schedule.holds).toBe(1);
			await page.handleCardDndFinalize(1, event(TRIGGERS.DROPPED_INTO_ZONE));
			expect(schedule.holds).toBe(0);
		});

		it('holds while the On Hold note window is open, however long, until Cancel, or until Confirm is answered or not', async () => {
			const { page, schedule, state, next, event, said, reads } = dragPage();
			next.finalize = { action: 'on-hold', onHoldState: { show: true, cardId: 5, cardTitle: 'Ship it', note: '', pendingUpdates: [], pendingColumnId: 2 }, updatedColumns: state.columns };
			page.handleCardDndConsider(2, event(TRIGGERS.DRAG_STARTED));
			await page.handleCardDndFinalize(2, event(TRIGGERS.DROPPED_INTO_ZONE));
			expect(page.onHoldState.show).toBe(true);
			await vi.advanceTimersByTimeAsync(5 * 60_000);
			expect(schedule.holds).toBe(1);
			page.cancelOnHold();
			expect(schedule.holds).toBe(0);

			// Confirm with no answer: said, not thrown; the window closes as the hold
			// is let go, so a second Confirm cannot be sent unheld; and the board is
			// read once as it is let go, to show where the card is (the re-check).
			page.handleCardDndConsider(2, event(TRIGGERS.DRAG_STARTED));
			await page.handleCardDndFinalize(2, event(TRIGGERS.DROPPED_INTO_ZONE));
			next.confirm = async () => {
				throw new TypeError('Failed to fetch');
			};
			const readsBefore = reads();
			said.length = 0;
			await expect(page.confirmOnHold()).resolves.toBeUndefined();
			expect(said).toEqual([['No answer from the server. The card may not have been put on hold.', 'error', 'started']]);
			expect(page.onHoldState.show).toBe(false);
			expect(schedule.holds).toBe(0);
			expect(reads() - readsBefore).toBe(1);
		});
	});

	// The B2b review: the page's functions as written, against a real board
	// state (and so its real refresh schedule), with `fetch` answering each
	// write when the test says.
	describe('the B2b review, replayed against a real board state', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});
		afterEach(() => {
			vi.useRealTimers();
			vi.unstubAllGlobals();
		});

		type Asked = { what: string; body: Record<string, unknown> | null; answer: (res: Response | 'none') => void };
		type Card = { id: number; columnId: number; title: string; priority: string };
		type Column = { id: number; title: string; cards: Card[] };
		const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
		const card = (id: number, columnId: number, position = 0) =>
			({ id, columnId, position, title: `Card ${id}`, priority: 'low', onHoldNote: '', summary: null, closeReason: null, subtasks: [], subBoards: [], labelIds: [], assignees: [] }) as Card;
		const column = (id: number, position: number, title: string, cards: Card[]) => ({ id, boardId: 9, title, position, color: '#888888', showAddCard: false, wipLimit: 0, cards });
		const places = (columns: Column[]) => columns.map((c) => [c.id, c.cards.map((k) => k.id)]);
		const keyed = (trigger: string, items: unknown[], source: string = SOURCES.POINTER) => ({ detail: { items, info: { trigger, id: 5, source } } });
		const LETS = [
			'dragHold', 'dragFrom', 'onHoldRelease', 'onHoldFrom', 'blockedRelease', 'blockedState', 'onHoldState', 'inlineEditCardId', 'inlineEditValue', 'boardNameDraft', 'editingBoardName',
			'selectionMode', 'selectedCards', 'contextMenu', 'confirmState'
		];
		const NAMES = [
			'holdDrag', 'takeDragHold', 'takeDragFrom', 'stopDrag', 'takeCardItems', 'handleCardDndConsider', 'handleCardDndFinalize', 'releaseOnHold', 'putBackOnHold', 'cancelOnHold',
			'releaseBlocked', 'closeBlocked', 'cyclePriority', 'saveInlineEdit', 'cancelInlineEdit', 'saveBoardName', 'handleBulkPriority', 'clearSelection', 'confirmDeleteCard'
		];

		function livePage(columns: ReturnType<typeof column>[]) {
			const reads: string[] = [];
			const data = {
				board: { id: 9, name: 'Board', emoji: null, parentCardId: null },
				breadcrumbs: [],
				columns,
				categories: [],
				labels: [],
				linkableBoards: [],
				canEdit: true,
				canManage: true,
				userBoardRole: 'owner',
				boardUsers: [],
				blockedState: {},
				cardTokens: {},
				boardTokenSummary: null,
				milestones: []
			} as unknown as BoardContentsData;
			// Its own reads are counted and never answered.
			const state = new BoardState(data, {
				invalidate: async () => {},
				fetch: (input) => {
					reads.push(String(input));
					return new Promise<Response>(() => {});
				}
			});
			const asked: Asked[] = [];
			vi.stubGlobal(
				'fetch',
				(url: string, init: RequestInit) =>
					new Promise<Response>((resolve, reject) =>
						asked.push({
							what: `${init.method} ${url}`,
							body: init.body ? JSON.parse(String(init.body)) : null,
							answer: (res) => (res === 'none' ? reject(new TypeError('Failed to fetch')) : resolve(res))
						})
					)
			);
			const next: { finalize: unknown } = { finalize: null };
			const dnd = {
				handleCardDndFinalize: async (columnId: number, items: unknown[], cols: unknown[]) =>
					typeof next.finalize === 'function' ? next.finalize(columnId, items, cols) : next.finalize
			};
			const said: unknown[][] = [];
			// The confirm dialog's Confirm, pressed when the test says.
			const confirms: (() => Promise<void>)[] = [];
			const page = new Function(
				'boardState', 'dndHandlers', 'TRIGGERS', 'SOURCES', 'toasts', 'data', 'currentUser', 'playCompleteSound', 'playMoveSound', 'queueCompletionPrompt', 'warnIfStillBlocked',
				'copyColumns', 'undoDrag', 'moveCards', 'patchCard', 'reorderColumns', 'withCurrentCards', 'api', 'bulkOps', 'boardActions', 'PRIORITY_CYCLE', 'PRIORITY_WORDS',
				'cardActions', 'removeCard', 'showConfirm', 'BULK_HOLD_MS', 'cardWindow',
				`let ${LETS.map((name) => `${name} = null`).join(', ')};\n` +
					"blockedState = { show: false }; onHoldState = { show: false }; selectedCards = new Set(); contextMenu = { show: false }; selectionMode = true; confirmState = { show: false };\n" +
					`${runnable(board(), NAMES)}\n` +
					`return { ${NAMES.join(', ')}, vars: { ${LETS.map((name) => `get ${name}() { return ${name}; }, set ${name}(v) { ${name} = v; }`).join(', ')} } };`
			)(
				state, dnd, TRIGGERS, SOURCES, { navigation: () => 'started', add: (...args: unknown[]) => said.push(args) }, { board: { id: 9 } }, { username: 'editor', emoji: '🦊' }, () => {}, () => {}, () => {}, () => {},
				copyColumns, undoDrag, moveCards, patchCard, reorderColumns, withCurrentCards, apiModule, bulkActions, boardActions,
				['low', 'medium', 'high', 'critical'], { refused: 'The priority was not changed.', noAnswer: 'No answer from the server. The priority may not have been changed.' },
				cardActions, removeCard, (_title: string, _message: string, _text: string, onConfirm: () => Promise<void>) => confirms.push(onConfirm), BULK_HOLD_MS,
				// The card window's controller on the same board state (slice B2c), which archives.
				new CardWindow(state, 9)
			);
			return { page, state, asked, next, said, reads, confirms, columns: () => state.columns as unknown as Column[] };
		}

		/** What `dndHandlers` gives for a drop that is taken, or held for its note: the column dropped into holds `items`. */
		const dropped = (action: 'committed' | 'on-hold') => (columnId: number, items: Card[], cols: Column[]) => {
			const updatedColumns = cols.map((c) => (c.id === columnId ? { ...c, cards: items } : c));
			const updates = items.map((k, i) => ({ id: k.id, columnId, position: i }));
			return action === 'committed'
				? { action, movedCards: [], updatedColumns, updates }
				: { action, onHoldState: { show: true, cardId: 5, cardTitle: 'Card 5', note: '', pendingUpdates: updates, pendingColumnId: columnId }, updatedColumns };
		};

		// MUST 1: a keyboard drag fires the zone a card leaves first, with no
		// consider between hops; the second hop's columns were copied after the
		// card had left, and a blocked or cancelled drop put it nowhere.
		it.each(['blocked', 'on-hold'] as const)('a keyboard drag’s second hop, %s and closed, puts the card back in the column the first hop took it to', async (second) => {
			const five = card(5, 1);
			const live = livePage([column(1, 0, 'In Progress', [five]), column(2, 1, 'Review', []), column(3, 2, second === 'blocked' ? 'Complete' : 'On Hold', [])]);
			const { page, next } = live;
			try {
				page.handleCardDndConsider(1, keyed(TRIGGERS.DRAG_STARTED, [five], SOURCES.KEYBOARD));
				// First hop, In Progress → Review: the zone left, then the zone entered.
				await page.handleCardDndFinalize(1, keyed(TRIGGERS.DROPPED_INTO_ANOTHER, [], SOURCES.KEYBOARD));
				next.finalize = dropped('committed');
				await page.handleCardDndFinalize(2, keyed(TRIGGERS.DROPPED_INTO_ZONE, [five], SOURCES.KEYBOARD));
				expect(places(live.columns())).toEqual([
					[1, []],
					[2, [5]],
					[3, []]
				]);

				// Second hop, Review → the third column.
				await page.handleCardDndFinalize(2, keyed(TRIGGERS.DROPPED_INTO_ANOTHER, [], SOURCES.KEYBOARD));
				next.finalize = second === 'blocked' ? { action: 'blocked', blockedState: { show: true, card: five, incomplete: 1, reason: 'subtasks', subBoardId: null } } : dropped('on-hold');
				await page.handleCardDndFinalize(3, keyed(TRIGGERS.DROPPED_INTO_ZONE, [five], SOURCES.KEYBOARD));
				if (second === 'blocked') page.closeBlocked();
				else page.cancelOnHold();
				expect(places(live.columns())).toEqual([
					[1, []],
					[2, [5]],
					[3, []]
				]);
				expect(live.state.holds).toBe(0);
			} finally {
				live.state.dispose();
			}
		});

		it('takes the keyboard drag’s columns in the zone left only for a keyboard drag, before it takes its items', () => {
			const leaving = flat(functionNamed(board(), 'handleCardDndFinalize'));
			const branch = leaving.slice(leaving.indexOf('if (e.detail.info?.trigger === TRIGGERS.DROPPED_INTO_ANOTHER) {'));
			expect(branch).toMatch(/^if \(e\.detail\.info\?\.trigger === TRIGGERS\.DROPPED_INTO_ANOTHER\) \{ .*if \(e\.detail\.info\?\.source === SOURCES\.KEYBOARD\) dragFrom \?\?= copyColumns\(boardState\.columns\); takeCardItems\(columnId, e\); return; \}/);
		});

		// SHOULD 2: the first of two quick changes to one field, answered or
		// refused after the second, put its own value back on the screen.
		it('two quick priority changes to one card: the first answer, coming while the second is out, does not undo it', async () => {
			const live = livePage([column(1, 0, 'In Progress', [card(5, 1)])]);
			const click = () => live.page.cyclePriority(live.columns()[0].cards[0], { stopPropagation: () => {} });
			try {
				const one = click();
				const two = click();
				expect(live.columns()[0].cards[0].priority).toBe('high');
				expect(live.asked.map((a) => a.body?.priority)).toEqual(['medium', 'high']);
				live.asked[0].answer(json(200, { id: 5, priority: 'medium' }));
				await one;
				expect(live.columns()[0].cards[0].priority).toBe('high');
				live.asked[1].answer(json(200, { id: 5, priority: 'high' }));
				await two;
				expect(live.columns()[0].cards[0].priority).toBe('high');
			} finally {
				live.state.dispose();
			}
		});

		it('two quick priority changes to one card: the first refused after the second was taken leaves the second', async () => {
			const live = livePage([column(1, 0, 'In Progress', [card(5, 1)])]);
			const click = () => live.page.cyclePriority(live.columns()[0].cards[0], { stopPropagation: () => {} });
			try {
				const one = click();
				const two = click();
				live.asked[1].answer(json(200, { id: 5, priority: 'high' }));
				await two;
				live.asked[0].answer(json(403, { message: 'No' }));
				await one;
				expect(live.columns()[0].cards[0].priority).toBe('high');
				expect(live.said).toEqual([['No', 'error', 'started']]);
			} finally {
				live.state.dispose();
			}
		});

		it('two quick renames of the board: the first refused after the second was sent leaves the second name', async () => {
			const live = livePage([column(1, 0, 'In Progress', [])]);
			try {
				live.page.vars.boardNameDraft = 'Second';
				const one = live.page.saveBoardName();
				live.page.vars.boardNameDraft = 'Third';
				const two = live.page.saveBoardName();
				expect(live.state.board.name).toBe('Third');
				live.asked[0].answer(json(403, { message: 'No' }));
				await one;
				expect(live.state.board.name).toBe('Third');
				live.asked[1].answer(json(200, { id: 9, name: 'Third' }));
				await two;
				expect(live.state.board.name).toBe('Third');
			} finally {
				live.state.dispose();
			}
		});

		// SHOULD 3: a write taken back during a drag came back with the drag's
		// copy of the card, refused or taken.
		it.each(['refused', 'committed'] as const)('a title write refused during a drag stays taken back when the drop is %s', async (drop) => {
			const live = livePage([column(1, 0, 'In Progress', [card(5, 1)]), column(2, 1, 'Review', [])]);
			const { page, next } = live;
			try {
				const renaming = live.state.writeCard(5, { title: 'Mine' }, () => apiModule.updateCard(5, { title: 'Mine' }), { refused: 'Not renamed.', noAnswer: 'No answer.' });
				const five = live.columns()[0].cards[0];
				page.handleCardDndConsider(1, keyed(TRIGGERS.DRAG_STARTED, []));
				page.handleCardDndConsider(2, keyed(TRIGGERS.DRAGGED_ENTERED, [five]));
				let answerDrop!: () => void;
				const gate = new Promise<void>((done) => (answerDrop = done));
				next.finalize = async (columnId: number, items: Card[], cols: Column[]) => {
					const result = drop === 'refused' ? { action: 'refused', message: 'Viewers cannot move cards' } : dropped('committed')(columnId, items, cols);
					await gate;
					return result;
				};
				const dropping = page.handleCardDndFinalize(2, keyed(TRIGGERS.DROPPED_INTO_ZONE, [five]));
				// The rename is refused while the drop is out.
				live.asked[0].answer(json(403, { message: 'No' }));
				await renaming;
				answerDrop();
				await dropping;
				const shown = live.columns().flatMap((c) => c.cards).find((k) => k.id === 5);
				expect(shown?.title).toBe('Card 5');
				expect(places(live.columns())).toEqual(drop === 'refused' ? [[1, [5]], [2, []]] : [[1, []], [2, [5]]]);
			} finally {
				live.state.dispose();
			}
		});

		// SHOULD 4: Escape takes the input away, and Chromium's blur then saved it.
		it('saves no inline title after Escape, nor twice after Enter and the blur that follows', async () => {
			const live = livePage([column(1, 0, 'In Progress', [card(5, 1)])]);
			try {
				live.page.vars.inlineEditCardId = 5;
				live.page.vars.inlineEditValue = 'Typed';
				live.page.cancelInlineEdit();
				await live.page.saveInlineEdit(5);
				expect(live.asked).toEqual([]);

				live.page.vars.inlineEditCardId = 5;
				live.page.vars.inlineEditValue = 'Entered';
				const entered = live.page.saveInlineEdit(5);
				const blurred = live.page.saveInlineEdit(5);
				expect(live.asked.map((a) => a.what)).toEqual(['PUT /api/cards/5']);
				live.asked[0].answer(json(200, { id: 5, title: 'Entered' }));
				await Promise.all([entered, blurred]);
			} finally {
				live.state.dispose();
			}
			expect(flat(functionNamed(board(), 'saveInlineEdit').body!.statements[0])).toBe('if (inlineEditCardId !== cardId) return;');
		});

		// The re-check: a card archived just before a drag, answered while the
		// drag was in hand, came back with the drag's copy when the drag was put back.
		it.each(['refused', 'blocked', 'cancelled'] as const)('a card archived while a drag is in hand stays off when the drag is %s', async (end) => {
			const five = card(5, 1, 0);
			const six = card(6, 1, 1);
			const live = livePage([column(1, 0, 'In Progress', [five, six]), column(2, 1, end === 'cancelled' ? 'On Hold' : 'Review', [])]);
			const { page, next } = live;
			try {
				// Archive card 6: confirmed, and out.
				page.confirmDeleteCard(6);
				const archiving = live.confirms[0]();
				expect(live.asked.map((a) => a.what)).toEqual(['DELETE /api/cards/6']);
				// Card 5 dragged into the other column.
				const shown = live.columns()[0].cards;
				page.handleCardDndConsider(1, keyed(TRIGGERS.DRAG_STARTED, [shown[1]]));
				page.handleCardDndConsider(2, keyed(TRIGGERS.DRAGGED_ENTERED, [shown[0]]));
				// The archive is answered while the drag is in hand.
				live.asked[0].answer(json(200, { success: true }));
				await archiving;
				expect(places(live.columns())).toEqual([
					[1, []],
					[2, [5]]
				]);
				next.finalize =
					end === 'refused'
						? { action: 'refused', message: 'Viewers cannot move cards' }
						: end === 'blocked'
							? { action: 'blocked', blockedState: { show: true, card: five, incomplete: 1, reason: 'subtasks', subBoardId: null } }
							: dropped('on-hold');
				await page.handleCardDndFinalize(2, keyed(TRIGGERS.DROPPED_INTO_ZONE, [live.columns()[1].cards[0]]));
				if (end === 'blocked') page.closeBlocked();
				if (end === 'cancelled') page.cancelOnHold();
				expect(places(live.columns())).toEqual([
					[1, [5]],
					[2, []]
				]);
			} finally {
				live.state.dispose();
			}
		});

		it('a bulk change whose request never answers lets the board be read after 5 minutes', async () => {
			const live = livePage([column(1, 0, 'In Progress', [card(1, 1, 0)])]);
			try {
				live.page.vars.selectedCards = new Set([1]);
				void live.page.handleBulkPriority('high');
				live.state.refresh();
				await vi.advanceTimersByTimeAsync(BULK_HOLD_MS - 1000);
				expect(live.reads).toEqual([]);
				await vi.advanceTimersByTimeAsync(2000);
				expect(live.reads).toEqual(['/api/boards/9/contents']);
				expect(BULK_HOLD_MS).toBe(5 * 60_000);
			} finally {
				live.state.dispose();
			}
		});

		// NOTE 6: each card's hold had the 30 s watchdog, and so had the bulk's
		// own: a bulk change taking longer let reads in under it.
		it('holds the reads for the whole of a bulk change, however long it takes, and reads once at its end', async () => {
			const live = livePage([column(1, 0, 'In Progress', [card(1, 1, 0), card(2, 1, 1), card(3, 1, 2)])]);
			try {
				live.page.vars.selectedCards = new Set([1, 2, 3]);
				const changing = live.page.handleBulkPriority('high');
				live.state.refresh(); // someone else's change meanwhile
				for (let i = 0; i < 3; i++) {
					await vi.advanceTimersByTimeAsync(20_000);
					expect(live.reads, `after ${(i + 1) * 20} s`).toEqual([]);
					live.asked[i].answer(json(200, { id: i + 1, priority: 'high' }));
					await vi.advanceTimersByTimeAsync(0);
				}
				await changing;
				expect(live.reads).toEqual(['/api/boards/9/contents']);
				expect(live.state.holds).toBe(0);
				expect(live.page.vars.selectedCards.size).toBe(0);
			} finally {
				live.state.dispose();
			}
		});
	});

	// SHOULD 5: the category window emptied its box as it handed the name on,
	// so a refused add lost what was typed.
	it('the category window keeps the name typed until the page says it was added', async () => {
		const modal = (added: boolean) =>
			new Function(
				'onAdd',
				`let newName = 'Ops'; let newColor = '#ff0000'; let adding = false;\n${runnable(scriptOf('src/lib/components/board/CategoryModal.svelte'), ['addCategory'])}\nreturn { addCategory, get newName() { return newName; } };`
			)(async () => added);
		const refused = modal(false);
		await refused.addCategory();
		expect(refused.newName).toBe('Ops');
		const taken = modal(true);
		await taken.addCategory();
		expect(taken.newName).toBe('');

		const adding = flat(functionNamed(board(), 'addCategory'));
		expect(adding).toContain("if (!written.ok) { toasts.add(written.failure, 'error', started); return false; }");
		expect(adding).toMatch(/return true; \}$/);
	});

	// The re-check: a second Add or Enter while the first was out made the
	// category twice, and a name typed meanwhile was cleared with the first.
	it('the category window sends one add at a time, and keeps a name typed while it was out', async () => {
		const file = 'src/lib/components/board/CategoryModal.svelte';
		let answer!: (added: boolean) => void;
		const sent: string[] = [];
		const modal = new Function(
			'onAdd',
			`let newName = 'Ops'; let newColor = '#ff0000'; let adding = false;\n${runnable(scriptOf(file), ['addCategory'])}\n` +
				'return { addCategory, get newName() { return newName; }, set newName(v) { newName = v; }, get adding() { return adding; } };'
		)((data: { name: string }) => {
			sent.push(data.name);
			return new Promise<boolean>((done) => (answer = done));
		});
		const first = modal.addCategory();
		expect(modal.adding).toBe(true);
		await modal.addCategory(); // a double click, or Enter again
		expect(sent).toEqual(['Ops']);
		modal.newName = 'Ops 2';
		answer(true);
		await first;
		expect(modal.newName).toBe('Ops 2');
		expect(modal.adding).toBe(false);

		// Add disabled while it is out.
		const source = readFileSync(join(ROOT, file), 'utf8');
		expect(source.slice(source.indexOf('</script>'))).toContain('disabled={!newName.trim() || adding}');
	});

	it('holds the reads while each write of its own is out, let go in a finally, and takes no hold for an inline edit', () => {
		const tree = board();
		const writes = apiWrites();
		const HELPER = /^(cardActions|boardActions|bulkOps|dndHandlers)\.(\w+)$/;
		const SENDS_NOTHING = ['navigationClosesWindow', 'findSubBoardName'];
		// The card window's controller holds while each of its sends is out (slice B2c; shown in tests/card-window.test.ts).
		const WINDOW = /^cardWindow\.(save|archive)$/;
		const sending: string[] = [];
		for (const { tree: code, where } of codeOf(PAGE, source())) {
			const visit = (node: ts.Node) => {
				if (ts.isCallExpression(node)) {
					const helper = HELPER.exec(node.expression.getText());
					const byWindow = WINDOW.test(node.expression.getText());
					const what = writeOf(node, writes) ?? (helper && !SENDS_NOTHING.includes(helper[2]) ? helper[0] : null) ?? (byWindow ? node.expression.getText() : null);
					if (what) {
						const at = `${where ?? enclosingName(node)} › ${what}`;
						sending.push(at);
						let held = byWindow;
						for (let child: ts.Node = node; child.parent; child = child.parent) {
							const parent = child.parent;
							if (ts.isTryStatement(parent) && parent.tryBlock === child && parent.finallyBlock && /\brelease(OnHold)?\(\)/.test(parent.finallyBlock.getText())) held = true;
							// Or sent by the board state's write, which holds while it is out (slice B2b).
							if (ts.isCallExpression(parent) && /^boardState\.write(Card|Column)?$/.test(parent.expression.getText()) && parent.arguments.some((argument) => argument === child)) held = true;
						}
						expect(held, at).toBe(true);
					}
				}
				ts.forEachChild(node, visit);
			};
			visit(code);
		}
		expect(sending.length).toBeGreaterThan(20);

		// Each hold is the board state's, or the drag's (`takeDragHold`, which takes one for a drop that had no first move).
		const releases: string[] = [];
		const collect = (node: ts.Node) => {
			if (ts.isVariableDeclaration(node) && node.name.getText() === 'release') releases.push(node.initializer!.getText());
			ts.forEachChild(node, collect);
		};
		for (const { tree: code } of codeOf(PAGE, source())) collect(code);
		// Fewer than the writes: a write through the board state holds for itself (slice B2b).
		expect(releases.length).toBeGreaterThan(10);
		// The bulk changes' own is out of the watchdog's reach: their last card's answer lets it go (the B2b review).
		expect([...new Set(releases)].sort()).toEqual(['boardState.hold()', 'boardState.hold({ watchdogMs: BULK_HOLD_MS })', 'dragHold && !dragHold.released ? dragHold : boardState.hold()', 'takeDragHold()']);

		// An inline edit is its own state, which a read cannot overwrite (R6): starting one holds nothing.
		for (const name of ['startInlineEdit', 'handleInlineKeydown', 'cancelInlineEdit', 'startEditColumn', 'startEditWipLimit']) {
			expect(callsOf(functionNamed(tree, name), 'boardState.hold'), name).toEqual([]);
		}
		const saving = functionNamed(tree, 'saveInlineEdit').body!.statements.map(flat);
		expect(saving.findIndex((step) => step.includes('await boardState.writeCard('))).toBeGreaterThan(saving.findIndex((step) => step.startsWith('if (!trimmed)')));

		// A sub-board's progress is the server's: read at once, after the write's own hold is let go.
		for (const name of ['linkSubBoard', 'deleteSubBoard']) {
			const now = callsOf(functionNamed(tree, name), 'boardState.refreshNow');
			expect(now, name).toHaveLength(1);
			expect(flat(now[0].parent), name).toBe('await boardState.refreshNow()');
			expect(ts.findAncestor(now[0], ts.isTryStatement), name).toBeUndefined();
		}
	});

	it('makes its board state once from the load, draws from it, and copies no load over it: the $effect that did is gone', () => {
		const tree = board();
		expect(source().match(/new BoardState\(/g)).toHaveLength(1);
		expect(tree.statements.map(flat)).toContain('const boardState = new BoardState(data as unknown as BoardContentsData, { invalidate: invalidateAll });');
		const destroyed = handedTo(tree, 'onDestroy');
		expect(destroyed).toHaveLength(1);
		expect(callsOf(destroyed[0], 'boardState.dispose')).toHaveLength(1);

		// The load is read for the board's id alone, which this page never
		// changes (the layout makes it afresh per board); all it draws is the state's.
		const read = new Set<string>();
		const visit = (node: ts.Node) => {
			if (ts.isPropertyAccessExpression(node) && node.expression.getText() === 'data') {
				read.add(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node ? node.parent.getText() : node.getText());
			}
			ts.forEachChild(node, visit);
		};
		visit(tree);
		expect([...read]).toEqual(['data.board.id']);
		const markup = source().slice(source().indexOf('</script>'), source().indexOf('<style>'));
		expect([...new Set(markup.match(/(?<![\w$.])data\.\w+(?:\.\w+)?/g))]).toEqual(['data.board.id']);

		// One $effect reads the load: a load that finds the board open after a
		// refused read (access given back) is handed over then, and only then.
		const effects = handedTo(tree, '$effect');
		const readingData = effects.filter((fn) => {
			let reads = false;
			const find = (node: ts.Node) => {
				if (ts.isIdentifier(node) && node.text === 'data') reads = true;
				ts.forEachChild(node, find);
			};
			find(fn);
			return reads;
		});
		expect(readingData.map(flat)).toEqual([
			'() => { const next = data; untrack(() => { if (boardState.refused) boardState.take(next as unknown as BoardContentsData); }); }'
		]);
		for (const fn of effects) expect(flat(fn)).not.toMatch(/boardState\.\w+ = |boardColumns/);

		// The viewer's column sorts are the state's, put back on every read.
		expect(flat(functionNamed(tree, 'setColumnSort').body!)).toBe('{ boardState.setSort(columnId, sort); openDropdown = null; }');
		expect(callsOf(tree, 'sortCards')).toEqual([]);
		expect(tree.getText()).not.toMatch(/\blet columnSorts\b/);
		expect(flat(functionNamed(tree, 'handleCardDndFinalize'))).toContain("if (boardState.columnSorts[columnId]) boardState.setSort(columnId, 'none');");
	});
});

// Card 2280, slice B2c: the board page's card window is opened, kept in step
// with the board, saved and archived by its controller,
// `src/lib/board/card-window.svelte.ts`, whose cases (the lost update among
// them) run in `tests/card-window.test.ts`. CardModal's props are unchanged:
// All Tasks, All To Do and the plan page draw the same window through the
// same controller since card 2281's slice C3a-1 (the describe of their own,
// above).
describe('the board page’s card window goes through its controller (card 2280, slice B2c)', () => {
	const PAGE = 'src/routes/board/[id]/+page.svelte';
	const board = () => scriptOf(PAGE);
	const source = () => readFileSync(join(ROOT, PAGE), 'utf8');
	const flat = (node: ts.Node) => node.getText().replace(/\s+/g, ' ');

	it('makes one controller on its board state, keeps no card, column or open flag of the window’s own, and hands the window the board’s card', () => {
		const tree = board();
		expect(tree.statements.map(flat)).toContain('const cardWindow = new CardWindow(boardState, data.board.id);');
		expect(source().match(/new CardWindow\(/g)).toHaveLength(1);
		// The page's copies, which a sub-board link and delete had to put right by hand, are gone.
		expect(source()).not.toMatch(/\b(editingCard|showCardModal|cardModalColumnId)\b/);
		// Nor in what the page draws through its components (card 2280, slice B3).
		for (const name of ['BoardHeader', 'BoardMoreMenu', 'KanbanColumnHeader', 'KanbanCardBody', 'ActivityPanel', 'ArchivePanel', 'SidePanel', 'XpLeaderboard']) {
			const file = `src/lib/components/board/${name}.svelte`;
			expect(readFileSync(join(ROOT, file), 'utf8'), file).not.toMatch(/\b(editingCard|showCardModal|cardModalColumnId)\b/);
		}
		expect(flat(functionNamed(tree, 'openCardModal').body!)).toBe('{ cardWindow.openCard(card); }');
		expect(flat(functionNamed(tree, 'openNewCardModal').body!)).toBe('{ cardWindow.openNew(columnId); }');

		const markup = source().slice(source().indexOf('</script>'));
		const opened = markup.slice(markup.indexOf('{#if cardWindow.open}'));
		const modal = opened.slice(0, opened.indexOf('{/if}')).replace(/\s+/g, ' ');
		expect(modal).toContain('<CardModal card={cardWindow.card}');
		expect(modal).toContain('onSave={saveCard}');
		expect(modal).toContain('onClose={() => cardWindow.close()}');
		expect(modal).toContain('onDelete={cardWindow.card ? () => confirmDeleteCard(cardWindow.cardId!) : undefined}');
		// A card the board has lost is said in the window (the B2c review), which shows the notice it is given.
		expect(modal).toContain("notice={cardWindow.gone ? CARD_GONE : ''}");
		const window = readFileSync(join(ROOT, 'src/lib/components/CardModal.svelte'), 'utf8').replace(/\s+/g, ' ');
		expect(window).toContain("notice = '',");
		expect(window).toContain('{#if notice} <div class="dep-error window-error" role="status">{notice}</div> {/if}');
		// No other window on the page is a CardModal.
		expect(markup.match(/<CardModal\b/g)).toHaveLength(1);
		// The window shows the sub-boards as the read after a link or delete draws them, with nothing put on it by hand.
		for (const name of ['linkSubBoard', 'deleteSubBoard']) expect(flat(functionNamed(tree, name)), name).not.toMatch(/cardWindow|\.find\(c => c\.id === cardId\)/);
	});

	it('saves through the controller and says what it gives back: a refusal in its words, with the window left open; what was done and what was not, in order', async () => {
		const saving = functionNamed(board(), 'saveCard');
		expect(callsOf(saving, 'cardWindow.save')).toHaveLength(1);
		// Nothing sent, held or read by the page itself: the controller does each.
		for (const callee of ['boardState.refresh', 'boardState.hold', 'cardActions.saveCard', 'cardActions.assignPending', 'fetch']) expect(callsOf(saving, callee), callee).toEqual([]);

		const run = async (result: unknown) => {
			const said: unknown[][] = [];
			const page = new Function('cardWindow', 'toasts', `${runnable(board(), ['saveCard'])}\nreturn { saveCard };`)(
				{ save: async () => result },
				{ navigation: () => 'started', add: (...args: unknown[]) => said.push(args) }
			);
			await page.saveCard({ title: 'New' });
			return said;
		};
		expect(await run({ ok: false, failure: 'Viewers cannot change cards' })).toEqual([['Viewers cannot change cards', 'error', 'started']]);
		expect(
			await run({
				ok: true,
				told: [
					{ message: 'Created "New"', failed: false },
					{ message: 'Subtask "Two" was not added to "New". It was refused.', failed: true },
					{ message: 'Sub-board "Plans" created', failed: false }
				]
			})
		).toEqual([['Created "New"'], ['Subtask "Two" was not added to "New". It was refused.', 'error', 'started'], ['Sub-board "Plans" created']]);
		// A save that changed nothing sent nothing, and says nothing.
		expect(await run({ ok: true, told: [] })).toEqual([]);
	});

	it('archives through the controller, only once the confirm is pressed, and says what came of it', () => {
		const archiving = functionNamed(board(), 'confirmDeleteCard');
		const asked = callsOf(archiving, 'showConfirm');
		expect(asked).toHaveLength(1);
		const confirmed = asked[0].arguments[3];
		expect(ts.isArrowFunction(confirmed)).toBe(true);
		const sent = callsOf(archiving, 'cardWindow.archive');
		expect(sent).toHaveLength(1);
		expect(isWithin(sent[0], confirmed)).toBe(true);
		expect(((confirmed as ts.ArrowFunction).body as ts.Block).statements.map((statement) => flat(statement))).toEqual([
			'const started = toasts.navigation();',
			'const failure = await cardWindow.archive(cardId);',
			'confirmState.show = false;',
			"if (failure) { // The card is still on the board, so its window stays open. toasts.add(failure, 'error', started); return; }",
			"toasts.add('Card archived. Restore it from Archived Cards.', 'info');"
		]);
	});
});

// Cards 2308, 2313 and 2316: what the split of the admin page, the dashboard
// and All Tasks (card 2281) carried over unused. A theme subscription on each
// page nobody read, functions nobody called, rules matching nothing (the
// unused-selector warning was switched off in svelte.config.js, so the build
// never said; card 2357 switched it on, and the case after this block holds
// every component to it), stale comments and whitespace.
describe('nothing left unused on the admin page, the dashboard and All Tasks (cards 2308, 2313 and 2316)', () => {
	const PAGES: [page: string, parts: string][] = [
		['src/routes/admin/+page.svelte', 'src/lib/components/admin'],
		['src/routes/+page.svelte', 'src/lib/components/dashboard'],
		['src/routes/all/+page.svelte', 'src/lib/components/tasks']
	];
	const files = PAGES.flatMap(([page, parts]) => [
		page,
		...readdirSync(join(ROOT, parts))
			.filter((name) => name.endsWith('.svelte'))
			.map((name) => `${parts}/${name}`)
	]);
	const read = (file: string) => readFileSync(join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
	const all = (node: ts.Node, test: (n: ts.Node) => boolean): ts.Node[] => {
		const found: ts.Node[] = [];
		const visit = (n: ts.Node) => {
			if (test(n)) found.push(n);
			ts.forEachChild(n, visit);
		};
		visit(node);
		return found;
	};

	/**
	 * The component's own script, parsed, whatever its attributes (a module
	 * script, `context="module"` or `module`, apart); an empty one for a file
	 * with none. The file's `scriptOf` above wants `<script lang="ts">` and
	 * throws without it, which its other checks rely on.
	 */
	const instanceScript = (file: string, source: string): ts.SourceFile => {
		const script = /<script(?![^>]*\b(?:context="module"|module)\b)[^>]*>([\s\S]*?)<\/script>/.exec(source);
		return ts.createSourceFile(file, script ? script[1] : '', ts.ScriptTarget.Latest, true);
	};

	/**
	 * Every name the markup reads: each identifier in a `{…}` expression (strings
	 * left out, and a property after a `.` not a name), each component's tag, and
	 * each directive's name (`bind:inviteLink`, `use:action`, `transition:fade`).
	 */
	const markupReads = (markup: string): Set<string> => {
		const names = new Set<string>();
		const expressions: string[] = [];
		for (let at = markup.indexOf('{'); at !== -1; at = markup.indexOf('{', at)) {
			let depth = 0;
			let end = at;
			for (; end < markup.length; end++) {
				if (markup[end] === '{') depth++;
				else if (markup[end] === '}' && --depth === 0) break;
			}
			expressions.push(markup.slice(at + 1, end));
			at = end + 1;
		}
		for (const expression of expressions) {
			const bare = expression.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, "''");
			for (const found of bare.matchAll(/(?<![\w$.])[A-Za-z_$][\w$]*/g)) names.add(found[0].replace(/^\$(?=\w)/, ''));
		}
		for (const found of markup.matchAll(/<([A-Z][\w]*)/g)) names.add(found[1]);
		for (const found of markup.matchAll(/\b(?:bind|use|transition|in|out|animate|class):([\w$]+)/g)) names.add(found[1]);
		return names;
	};

	it('leaves no name at the top of a script that nothing reads', () => {
		const unread: string[] = [];
		for (const file of files) {
			const source = read(file);
			const script = instanceScript(file, source);
			// What the markup reads: the file less its scripts, its styles and its comments.
			const reads = markupReads(
				source
					.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
					.replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, '')
					.replace(/<!--[\s\S]*?-->/g, '')
			);
			// Each import, function, const and let at the top; an exported function is the component's own API, read through bind:this.
			const declared = script.statements.flatMap((statement): ts.Identifier[] => {
				if (ts.isImportDeclaration(statement)) {
					const clause = statement.importClause;
					const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements.map((e) => e.name) : [];
					return [...(clause?.name ? [clause.name] : []), ...named];
				}
				const exported = ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
				if (ts.isFunctionDeclaration(statement) && statement.name && !exported) return [statement.name];
				if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.map((d) => d.name).filter(ts.isIdentifier);
				return [];
			});
			// A plain assignment's left side writes the name and does not read it: a `let` only ever set is unread. `$name` reads a store.
			const written = (n: ts.Node) =>
				ts.isBinaryExpression(n.parent) && n.parent.left === n && n.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
			for (const name of declared) {
				const inScript = all(script, (n) => ts.isIdentifier(n) && n !== name && (n.text === name.text || n.text === `$${name.text}`) && !written(n));
				if (inScript.length === 0 && !reads.has(name.text)) unread.push(`${file} ${name.text}`);
			}
		}
		expect(unread).toEqual([]);
	});

	it('has none of the rules the compiler cannot judge: the two of card 2316 and card 2313', () => {
		// What the compiler judges, every component's, is the next block's (card 2357).
		// A class written with a value in it (`class="priority-{card.priority}"`, `class={…}`) stops the
		// compiler flagging any class rule of that file: it cannot know what the value will be. Six of
		// these files have one, and their class rules are judged by nothing here but these lines:
		// BackupHistory.svelte, ScheduledBackupsPanel.svelte and UsersPanel.svelte (admin),
		// AnalyticsSidebar.svelte and RequestToasts.svelte (dashboard), and AllTaskCard.svelte (All Tasks).
		expect(files.filter((file) => /class=\{|class="[^"]*\{/.test(read(file))).map((file) => file.split('/').at(-1))).toEqual([
			'BackupHistory.svelte',
			'ScheduledBackupsPanel.svelte',
			'UsersPanel.svelte',
			'AnalyticsSidebar.svelte',
			'RequestToasts.svelte',
			'AllTaskCard.svelte'
		]);
		const source = files.map(read).join('\n');
		expect(source).not.toMatch(/\.column-tag\b/);
		// A class: directive whose class no rule of its file styles (All Tasks' subtask badge has one; the boards table's sub-board count had none).
		expect(read('src/lib/components/dashboard/BoardsTable.svelte')).not.toMatch(/class:all-done|\.all-done\b/);
	});

	it('has no theme subscription, and no comment about the page before the split, left in the mail panel', () => {
		for (const file of files) expect(read(file), file).not.toMatch(/currentTheme|theme\.subscribe/);
		const smtp = read('src/lib/components/admin/SmtpPanel.svelte');
		expect(smtp).not.toContain('appUrl is now in Application Settings');
		expect(smtp).not.toContain('appUrl loaded separately');
	});

	it('has no line that ends in a space or a tab', () => {
		const trailing = files.flatMap((file) =>
			read(file)
				.split('\n')
				.flatMap((line, i) => (/[ \t]$/.test(line) ? [`${file}:${i + 1}`] : []))
		);
		expect(trailing).toEqual([]);
	});
});

// Card 2357: svelte.config.js switched the unused-selector warning off for the
// whole app, so a rule that matched nothing was never reported. It is on now,
// and `npm run check` reports one; this holds the suite to it as well.
describe('no rule in any component matches nothing, as the compiler judges it (card 2357)', () => {
	it('leaves the warning on, and no .svelte file under src gives it', async () => {
		const config = (await import(/* @vite-ignore */ pathToFileURL(join(ROOT, 'svelte.config.js')).href)).default;
		const filter = config.compilerOptions.warningFilter as (warning: { code: string }) => boolean;
		expect(filter({ code: 'css_unused_selector' })).toBe(true);

		const components: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
				const path = `${dir}/${entry.name}`;
				if (entry.isDirectory()) walk(path);
				else if (entry.name.endsWith('.svelte')) components.push(path);
			}
		};
		walk('src');
		expect(components.length).toBeGreaterThan(100);
		const unused = components.flatMap((file) =>
			compile(readFileSync(join(ROOT, file), 'utf8'), { filename: file, generate: false })
				.warnings.filter((warning) => warning.code === 'css_unused_selector')
				.map((warning) => `${file}:${warning.start?.line}: ${warning.message.split('\n')[0]}`)
		);
		expect(unused).toEqual([]);
	});
});
