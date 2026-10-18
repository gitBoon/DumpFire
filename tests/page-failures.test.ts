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
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	answerBody,
	cardArchiveWarning,
	dependencyEndBody,
	dependencyRow,
	failureMessage,
	sizeInWords,
	subBoardLinkWarning,
	uploadFailure,
	uploadNoAnswer,
	uploadNotRead
} from '$lib/api';
import { mayManageAccount } from '$lib/account-rule';
import * as bulkActions from '$lib/board/bulk-actions';
import * as cardActions from '$lib/board/card-actions';
import * as dndHandlers from '$lib/board/dnd-handlers';
import { connectSSE } from '$lib/board/sse';
import { keepStreamOpen, reconnectDelay, streamVerdict, type StreamEnvironment } from '$lib/live-stream';
import { NOTIFICATION_PREFS } from '$lib/notification-prefs';
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

describe('the card’s dependency list, src/lib/components/CardModal.svelte', () => {
	const modal = scriptOf('src/lib/components/CardModal.svelte');

	it('is read when the card is opened by loadDependencies', () => {
		const opened = modal.statements
			.filter((statement) => ts.isExpressionStatement(statement) && statement.getText().startsWith('onMount('))
			.flatMap((statement) => callsOf(statement, 'loadDependencies'));

		expect(opened).toHaveLength(1);
	});

	it('is read again by loadDependencies after a removal that was refused', () => {
		// In the branch for a failure, and nowhere else: a removal that worked
		// is answered with the two lists as they now are.
		expect(branches(modal, 'removeDependency', 'loadDependencies')).toEqual(['failed']);
		// The message is still set there, before the lists are read again.
		const refused = functionNamed(modal, 'removeDependency').getText();
		const said = "depError = await failureMessage(res, 'Could not remove that dependency')";
		expect(refused.indexOf(said)).toBeGreaterThan(-1);
		expect(refused.indexOf(said)).toBeLessThan(refused.indexOf('loadDependencies()'));
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
			const fn = functionNamed(modal, name);
			expect(callsOf(fn, 'dependencyEndBody'), name).toHaveLength(1);
			expect(fn.getText(), name).not.toMatch(/\b(dependsOn|blocks)(Card|Subtask)Id\b/);
		}
	});

	it('passes the row from both remove buttons, and numbers and links each row through dependencyRow', () => {
		const source = readFileSync(join(ROOT, 'src/lib/components/CardModal.svelte'), 'utf8');
		const markup = source.slice(source.indexOf('</script>'));

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

describe('a card’s attachments, src/lib/components/CardModal.svelte', () => {
	const source = readFileSync(join(ROOT, 'src/lib/components/CardModal.svelte'), 'utf8');
	const modal = scriptOf('src/lib/components/CardModal.svelte');

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
		// confirmation and closed the window under it as well.
		const handler = functionNamed(modal, 'handleKeydown').getText().replace(/\s+/g, ' ');
		const leaves = 'if (confirming && !overlay?.contains(confirming)) return;';
		expect(handler).toContain("const confirming = document.querySelector('.confirm-modal');");
		expect(handler).toContain(leaves);
		expect(handler.indexOf(leaves)).toBeLessThan(handler.indexOf('onClose();'));
		expect(handler).toContain("if (e.key !== 'Escape') return;");
		expect(source).toContain('aria-label="Card editor" bind:this={overlay}>');

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
		const typed = /onSave: \(data: \{([^}]*)\}\) => void;/.exec(modal.getText())![1];
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
		expect(markup).toContain('<p class="template-desc">Saves this card\'s title, description, priority, subtasks and labels as a reusable template.</p>');
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
		// The window is closed first where the navigation calls for it (Q-F's review), then the card named opened.
		expect(steps).toEqual([
			'if (cardActions.navigationClosesWindow(from, to, editingCard !== null)) { showCardModal = false; editingCard = null; }',
			'openCardFromAddress(to?.url);'
		]);
		expect(opening().getText()).toContain("searchParams.get('card')");
		const mounted = board.statements.filter((statement) => ts.isExpressionStatement(statement) && statement.getText().startsWith('onMount('));
		expect(mounted.length).toBeGreaterThan(0);
		for (const statement of mounted) expect(statement.getText()).not.toContain("'card'");
	});

	it('looks the card up in the board the navigation brought, data.columns, and not the page’s own copy', () => {
		expect(opening().getText()).toContain('(data.columns as unknown as ColumnType[]).flatMap((c) => c.cards).find((c) => c.id === cardId)');
		expect(opening().getText()).not.toContain('boardColumns');
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
		expect(steps.indexOf('showCardModal = false;')).toBeLessThan(waited);
		expect(steps.indexOf('editingCard = null;')).toBeLessThan(waited);
		expect(steps.findIndex((step) => step.startsWith('replaceState('))).toBeGreaterThan(waited);
		expect(steps.indexOf('if (card) openCardModal(card);')).toBeGreaterThan(waited);
	});

	it('says each label of a new card’s template that was not put on it, as an error in the shared toast', () => {
		const saving = functionNamed(board, 'saveCard');
		const said = saving.getText().replace(/\s+/g, ' ');
		expect(said).toContain('for (const { labelId, message } of result.labelFailures ?? []) {');
		const told = callsOf(saving, 'toasts.add').filter((call) => call.getText().includes('message'));
		expect(told.map((call) => [call.arguments[1]?.getText(), call.arguments[2]?.getText()])).toEqual([["'error'", 'started']]);
		// The type of what the window hands it, as the window's.
		expect(saving.parameters[0].type!.getText()).not.toContain('colorTag');
		expect(saving.parameters[0].type!.getText()).toContain('pendingLabelIds?: number[]');
	});

	it('names a label deleted while the window was open as one that no longer exists, not by its number (the review)', () => {
		const said = functionNamed(board, 'saveCard').getText();
		expect(said).toContain("const named = label ? `The template's label \"${label.name}\"` : 'A label of the template that no longer exists';");
		expect(said).toContain('toasts.add(`${named} was not put on "${cardData.title}". ${message}`, \'error\', started);');
		expect(said).not.toContain('#${labelId}');
	});

	it('says a create that made no card, keeps the window open, and says nothing was created (the review)', () => {
		const saving = functionNamed(board, 'saveCard');
		const steps = saving.body!.statements.map((statement) => statement.getText());
		const failed = steps.findIndex((step) => step.startsWith('if (result.failure) {'));
		expect(failed).toBeGreaterThan(steps.findIndex((step) => step.includes('await cardActions.saveCard(')));
		// Before the window is closed and anything is said to be created.
		expect(failed).toBeLessThan(steps.indexOf('showCardModal = false;'));
		expect(failed).toBeLessThan(steps.findIndex((step) => step.includes('Created "')));
		const branch = (saving.body!.statements[failed] as ts.IfStatement).thenStatement as ts.Block;
		expect(branch.statements.map((statement) => statement.getText())).toEqual(["toasts.add(result.failure, 'error', started);", 'return;']);
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

describe('the admin page, src/routes/admin/+page.svelte', () => {
	const file = 'src/routes/admin/+page.svelte';
	const source = readFileSync(join(ROOT, file), 'utf8');
	const page = scriptOf(file);
	const markup = source.slice(source.indexOf('</script>'));
	const from = source.indexOf('</script>');

	/** Whether the one place `text` is in the markup is shown to the superadmin only. */
	const forSuperadminOnly = (text: string) => {
		expect(markup.split(text), text).toHaveLength(2);
		return blocksAround(source, from + markup.indexOf(text)).some((block) => block.condition === 'isSuperadmin' && !block.inElse);
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
		// What is asked for as the page opens is asked in an `$effect`. Each of
		// the three that fetch what is the superadmin's begins by leaving.
		const LOADS = ['loadBackupConfig', 'loadAppUrl', 'loadSmtpConfig'];
		const effects = page.statements.filter(
			(statement) => ts.isExpressionStatement(statement) && statement.getText().startsWith('$effect(')
		);
		const loading = effects.filter((effect) => LOADS.some((load) => callsOf(effect, load).length > 0));

		expect(LOADS.flatMap((load) => effects.flatMap((effect) => callsOf(effect, load)))).toHaveLength(3);
		for (const effect of loading) {
			const call = (effect as ts.ExpressionStatement).expression as ts.CallExpression;
			const body = (call.arguments[0] as ts.ArrowFunction).body as ts.Block;
			expect(body.statements[0].getText()).toBe('if (!isSuperadmin) return;');
		}
		// And none of the three is called as the script runs, outside a function.
		const atTheTop = page.statements.filter((statement) => ts.isExpressionStatement(statement) && !effects.includes(statement));
		expect(LOADS.flatMap((load) => atTheTop.flatMap((statement) => callsOf(statement, load)))).toEqual([]);
		// Each fetches a route that is the superadmin's.
		for (const load of LOADS) expect(functionNamed(page, load).getText()).toMatch(/fetch\('\/api\/admin\/(smtp|backup)'\)/);
	});

	it('saves no file for an export that was refused, and shows the refusal as a failure', () => {
		const exporting = functionNamed(page, 'exportDatabase');
		const text = exporting.getText();

		// The answer is looked at before it is read as the file.
		const refusal = text.indexOf('if (!res.ok) {');
		const file = text.indexOf('res.blob()');
		expect(refusal).toBeGreaterThan(-1);
		expect(file).toBeGreaterThan(refusal);
		// And what is done about it is to say so and stop.
		expect(branches(page, 'exportDatabase', 'failureMessage')).toEqual(['failed']);
		const [asked] = callsOf(exporting, 'failureMessage');
		expect(branchOf(asked)).toBe('failed');
		const stop = text.slice(refusal, file);
		expect(stop).toMatch(/showToast\(await failureMessage\(res, '[^']+'\), 'error', started\);\s+return;\s+\}/);
		expect(text.indexOf("showToast('Database exported successfully')")).toBeGreaterThan(file);
	});

	it('says which of the four things went wrong with an import, and no longer blames the file for all of them', () => {
		const importing = functionNamed(page, 'handleFileSelected');

		for (const callee of ['uploadNotRead', 'uploadNoAnswer', 'uploadFailure']) {
			expect(callsOf(importing, callee), callee).toHaveLength(1);
		}
		expect(callsOf(importing, 'res.json')).toEqual([]);
		expect(source).not.toContain("'Invalid backup file'");
		// A proxy's refusal and DumpFire's own 413 are both handed to uploadFailure.
		expect(importing.getText()).toContain('if (result === null || res.status === 413) {');
		expect(finallyBlocks(importing).some((block) => block.includes('importing = false;'))).toBe(true);
	});

	it('says an import that failed in the report under the button, and not in a toast as well', () => {
		const importing = functionNamed(page, 'handleFileSelected');
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
		const button = markup.split('\n').filter((line) => line.includes('removeDestination(dest.name)'));
		expect(button).toHaveLength(1);
		expect(button[0]).toContain('disabled={backupSaving}');
		// And the flag is up for the whole of the save a removal makes.
		expect(callsOf(functionNamed(page, 'removeDestination'), 'saveBackupConfig')).toHaveLength(1);
		const saving = functionNamed(page, 'saveBackupConfig');
		expect(saving.body!.statements[0].getText()).toBe('backupSaving = true;');
		expect(finallyBlocks(saving)).toEqual(['{ backupSaving = false; }']);
	});

	it('knows a .db backup by the ending of its name in any case', () => {
		const said = functionNamed(page, 'handleFileSelected').getText().replace(/\s+/g, ' ');

		expect(said).toContain('const named = file.name.toLowerCase();');
		expect(said).toContain("const isDbFile = named.endsWith('.db') || named.endsWith('.sqlite') || named.endsWith('.sqlite3');");
	});

	it('says in the import dialog that everybody is signed out, and that a backup with no superadmin is refused', () => {
		const dialog = markup.slice(markup.indexOf('<h2>Import Database</h2>'));

		expect(dialog).toContain('Everybody is signed out, you included: no session is restored, whatever the backup holds');
		expect(dialog).toContain('A backup with users and no superadmin among them is refused.');
		expect(source).not.toContain('unless the backup holds your current session');
	});

	it('says after a change of role that an invite sent earlier no longer works, when the answer says one ended', () => {
		const changing = functionNamed(page, 'changeUserRole');

		expect(branches(page, 'changeUserRole', 'answerBody')).toEqual(['ok']);
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
// holder's own change ends them only when asked (cards 2116 and 2137). Making
// a key asks for the password. These are what the three pages say about it.

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

	it('offers to end the API keys with a password change, not ticked, and only when there are keys to end', () => {
		// Not ticked unless the holder ticks it.
		expect(page.getText()).toContain('let endApiKeysToo = $state(false);');
		expect(assignmentsTo(page, 'endApiKeysToo').map((assignment) => assignment.right.getText())).toEqual(['false', 'false']);
		// And cleared whenever the list is empty, not only after a change: a box
		// ticked beside a key that was then revoked must not come back ticked
		// beside the next one.
		const cleared = page.statements.filter(
			(statement) => ts.isExpressionStatement(statement) && statement.getText().startsWith('$effect(')
		);
		expect(cleared.map((statement) => assignmentsTo(statement, 'endApiKeysToo').length)).toContain(1);
		expect(page.getText()).toMatch(/\$effect\(\(\) => \{\s*if \(apiKeys\.length === 0\) endApiKeysToo = false;\s*\}\);/);

		// The box, with the count, only when the list holds a key.
		expect(around('bind:checked={endApiKeysToo}')).toEqual([{ condition: 'apiKeys.length > 0', inElse: false }]);
		// "It" for one key, "they" for more.
		expect(markup).toContain(
			"You have {keysInWords(apiKeys.length)}. {apiKeys.length === 1 ? 'It keeps' : 'They keep'} working after a password change unless you tick the box."
		);
		expect(markup).toContain(
			"End my {keysInWords(apiKeys.length)} too. Do this if anyone else may have used your account. Anything that uses {apiKeys.length === 1 ? 'it' : 'them'} stops working until it is given a new key."
		);
	});

	it('sends the choice as endApiKeys, says what the change ended, and reads the key list again after keys were ended', () => {
		const changing = functionNamed(page, 'changePassword');

		expect(bodiesSent(changing)).toEqual([['currentPassword', 'newPassword', 'endApiKeys']]);
		expect(changing.getText()).toContain('const endApiKeys = endApiKeysToo && apiKeys.length > 0;');
		// The count is the answer's, read where the answer is a success.
		expect(branches(page, 'changePassword', 'answerBody')).toEqual(['ok']);
		expect(changing.getText()).toContain('(await answerBody(res))?.apiKeysEnded');
		expect(changing.getText()).toContain("'Password changed. Your other sessions were signed out'");
		expect(branches(page, 'changePassword', 'loadApiKeys')).toEqual(['ok']);
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

describe('the admin page’s password dialog, src/routes/admin/+page.svelte', () => {
	const file = 'src/routes/admin/+page.svelte';
	const source = readFileSync(join(ROOT, file), 'utf8');
	const page = scriptOf(file);
	const markup = source.slice(source.indexOf('</script>'));
	const from = source.indexOf('</script>');
	const around = (text: string) => {
		expect(markup.split(text), text).toHaveLength(2);
		return blocksAround(source, from + markup.indexOf(text));
	};

	it('tells an administrator on their own row that their keys keep working, and sends no endApiKeys', () => {
		const line = 'Your API keys keep working. To end them too, change your password on the <a href="/account">Account page</a>.';

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
		expect(around('They are signed out everywhere, every API key they have stops working, and any invite not yet used stops working.').at(-1)).toEqual({
			condition: 'resettingOwnPassword',
			inElse: true
		});
		expect(page.getText()).toContain('let resetTarget = $derived(data.users.find((u) => u.id === resetPasswordUserId));');
		expect(page.getText()).toContain('let resetTargetKeys = $derived(resetKeysRead ? (resetTarget?.apiKeys ?? null) : null);');
	});

	it('reads the counts again when the dialog opens, and shows none until it has', () => {
		// The one way the dialog opens.
		expect(markup).toContain('onclick={() => openResetDialog(u.id)} title="Reset password">🔑</button>');
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
			"`Password reset: ${counted(sessionsEnded, 'session')} and ${counted(apiKeysEnded, 'API key')} ended`"
		);
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

	it('says, before the form is sent, that setting a password ends the account’s API keys', () => {
		const notice = "Setting a password here ends this account's {apiKeys} API key{apiKeys === 1 ? '' : 's'} and signs it out everywhere else.";

		expect(around(notice)).toEqual([
			{ condition: 'data.valid', inElse: false },
			{ condition: 'apiKeys > 0', inElse: false }
		]);
		expect(scriptOf(file).getText()).toContain('let apiKeys = $derived(data.apiKeys ?? 0);');
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
	if (test === 'res.ok') return 'ok';
	if (test === '!res.ok' || test === 'failure' || test === '!res' || /^!\(await[\w.]+\(/.test(test)) return 'failed';
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
 * `$lib/api.ts`, whose names are `writes`.
 */
function writeOf(call: ts.CallExpression, writes: string[]): string | null {
	const callee = call.expression.getText();
	if (callee === 'fetch') {
		const method = /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/.exec(call.arguments[1]?.getText() ?? '');
		return method ? `fetch ${method[1]}` : null;
	}
	const named = /^api\.(\w+)$/.exec(callee);
	return named && writes.includes(named[1]) ? callee : null;
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

/** The helpers that are handed a request to send and read its answer themselves. */
const READ_BY = ['sent', 'deleteFailure', 'api.deleteFailure'];

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
 * with a method that writes, or `api.<write>(...)`. Each as
 * `file › where › what`, `where` being the function it is in, or
 * `markup onclick` for an event handler written in a Svelte file's markup.
 */
function discardedIn(file: string, source: string, writes: string[]): string[] {
	const found: string[] = [];
	for (const { tree, where } of codeOf(file, source)) {
		const visit = (node: ts.Node) => {
			if (ts.isCallExpression(node)) {
				const what = writeOf(node, writes);
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
	/** How a refusal is read and put into words. */
	reads?: 'failureMessage' | 'deleteFailure' | 'sent';
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
 * names and card 2134's column rename.
 */
const WRITES: Record<string, Write[]> = {
	'src/routes/board/[id]/+page.svelte': [
		{ name: 'restoreCard', reads: 'deleteFailure', done: ['archivedCards = archivedCards.filter(c => c.id !== cardId)', "toasts.add('Card restored')"] },
		{ name: 'confirmDeleteCard', reads: 'deleteFailure', done: ["toasts.add('Card archived. Restore it from Archived Cards.', 'info')", 'showCardModal = false'] },
		// Card 2139: it said "Board linked as sub-board" whatever the answer, and nothing was saved.
		{ name: 'linkSubBoard', reads: 'failureMessage', done: ['await invalidateAll()', "toasts.add('Board linked as sub-board')"] },
		// Card 2134: a rename that would change whether the column is a Complete
		// column is refused while it holds cards, and the page showed the new title.
		{ name: 'finishEditColumn', reads: 'failureMessage', done: ['col.title = title'] }
	],
	'src/routes/archived/+page.svelte': [
		{ name: 'restoreCard', reads: 'deleteFailure', done: ["toasts.add('Card restored')", 'await invalidateAll()'] },
		{ name: 'permanentlyDeleteCard', reads: 'deleteFailure', done: ['await invalidateAll()'] },
		{ name: 'purgeAll', reads: 'failureMessage', done: ['await invalidateAll()'] }
	],
	'src/routes/all/+page.svelte': [
		{ name: 'doMoveCard', reads: 'failureMessage', done: ['showMoveModal = false', 'playMoveSound()', 'playCompleteSound()'] },
		{ name: 'saveCard', reads: 'failureMessage', done: ["toasts.add('Card updated')", 'showCardModal = false'] },
		{ name: 'deleteCard', reads: 'deleteFailure', done: ["toasts.add('Card archived. Restore it from Archived Cards.', 'info')", 'showCardModal = false'] },
		{ name: 'restoreArchivedCard', reads: 'deleteFailure', done: ['archivedCards = archivedCards.filter(c => c.id !== cardId)', "toasts.add('Card restored')"] },
		{ name: 'permanentlyDeleteArchivedCard', reads: 'deleteFailure', done: ['archivedCards = archivedCards.filter(c => c.id !== cardId)'] }
	],
	// Card 2240: All To Do opens the card window as All Tasks does, with no Move window.
	'src/routes/todo/+page.svelte': [
		{ name: 'saveCard', reads: 'failureMessage', done: ["toasts.add('Card updated')", 'showCardModal = false'] },
		{ name: 'deleteCard', reads: 'deleteFailure', done: ["toasts.add('Card archived. Restore it from Archived Cards.', 'info')", 'showCardModal = false'] }
	],
	'src/routes/teams/+page.svelte': [
		{ name: 'createTeam', reads: 'failureMessage', done: ['showCreateTeam = false', "showToast('Team created')"] },
		{ name: 'deleteTeam', reads: 'deleteFailure', done: ["showToast('Team deleted')"] },
		{ name: 'addTeamMember', reads: 'failureMessage', done: ['addMemberUserId = null', "showToast('Member added')"] },
		{ name: 'removeTeamMember', reads: 'deleteFailure', done: ["showToast('Member removed')"] }
	],
	'src/routes/admin/+page.svelte': [
		{ name: 'saveAppUrl', reads: 'sent', done: ["showToast('App URL saved')"] },
		{ name: 'saveBackupConfig', reads: 'sent', done: ["showToast('Backup settings saved')"] },
		{ name: 'addDestination', via: 'saveBackupConfig', putsBack: ['backupDestinations = was'], done: ['resetDestForm()', 'showAddDestination = false'] },
		{ name: 'updateDestination', via: 'saveBackupConfig', putsBack: ['backupDestinations = was'], done: ['editingDest = null', 'resetDestForm()'] },
		{ name: 'removeDestination', via: 'saveBackupConfig', putsBack: ['backupDestinations = was'] },
		{ name: 'testDestination', reads: 'sent' },
		{ name: 'runManualBackup', reads: 'sent', done: ['await loadBackupConfig()'] },
		{ name: 'exchangeGDriveCode', reads: 'sent', done: ['await loadBackupConfig()'] },
		{ name: 'deleteBoard', reads: 'sent', done: ["showToast('Board deleted')"] },
		{ name: 'clearBoardCards', reads: 'sent', done: ["showToast('All cards cleared from board')"] },
		{ name: 'clearBoardCategories', reads: 'sent', done: ["showToast('All categories cleared from board')"] },
		{ name: 'resetDatabase', reads: 'failureMessage', done: ['window.location.href = redirect'] },
		{ name: 'vacuumDatabase', reads: 'sent', done: ["showToast('Database vacuumed. Unused space was reclaimed.')"] },
		{ name: 'resetAllXp', reads: 'sent', done: ["showToast('All XP has been reset to 0')"] },
		{ name: 'purgeArchivedCards', reads: 'sent', done: ['await invalidateAll()'] },
		{ name: 'createUser', reads: 'sent', done: ['showCreateUser = false'] },
		{ name: 'changeUserRole', reads: 'failureMessage', putsBack: ['putBack()'], done: ['await invalidateAll()'] },
		{ name: 'resetPassword', reads: 'failureMessage', done: ['resetPasswordUserId = null'] },
		{ name: 'deleteUser', reads: 'sent', done: ["showToast('User deleted')"] },
		{ name: 'resendInvite', reads: 'sent' },
		{ name: 'createTeam', reads: 'sent', done: ['showCreateTeam = false', "showToast('Team created')"] },
		{ name: 'deleteTeam', reads: 'sent', done: ["showToast('Team deleted')"] },
		{ name: 'addTeamMember', reads: 'sent', done: ['addMemberUserId = null', "showToast('Member added')"] },
		{ name: 'removeTeamMember', reads: 'sent', done: ["showToast('Member removed')"] },
		{ name: 'saveSmtp', reads: 'failureMessage', done: ["smtpMessage = 'SMTP settings saved!'"] },
		{ name: 'testSmtp', reads: 'failureMessage' }
	],
	'src/routes/reports/+page.svelte': [
		{ name: 'generateReport', reads: 'failureMessage' },
		{ name: 'sendReportEmail', reads: 'failureMessage' },
		{ name: 'createSchedule', reads: 'failureMessage', done: ['showNewSchedule = false', "schedName = ''", 'await invalidateAll()'] },
		{ name: 'toggleSchedule', reads: 'failureMessage', done: ['await invalidateAll()'] },
		{ name: 'deleteSchedule', reads: 'deleteFailure', done: ['await invalidateAll()'] }
	],
	'src/lib/components/CardModal.svelte': [
		// A label is put on and taken off by the label picker, below (card 2010).
		{ name: 'setCover', reads: 'failureMessage', putsBack: ['coverUrl = was'] },
		{ name: 'clearCover', via: 'setCover' },
		{ name: 'createCategoryInline', reads: 'failureMessage', done: ['showNewCategory = false'] },
		{ name: 'assignUser', reads: 'failureMessage' },
		{ name: 'unassignUser', reads: 'deleteFailure' },
		{ name: 'saveAsTemplate', reads: 'failureMessage', done: ['showSaveTemplate = false', "templateName = ''"] },
		{ name: 'deleteTemplate', reads: 'deleteFailure', done: ['templates = templates.filter(t => t.id !== id)'] },
		{ name: 'toggleSubtask', reads: 'failureMessage', done: ['subtask.completed = !subtask.completed'] },
		{ name: 'addDependency', reads: 'failureMessage', done: ['pickerMode = null'] },
		{ name: 'removeDependency', reads: 'failureMessage', putsBack: ['await loadDependencies()'], done: ['blocks = data.blocks'] },
		{ name: 'saveMilestone', reads: 'failureMessage', putsBack: ['putBack()'], done: ['milestoneId = next'] },
		{ name: 'postComment', reads: 'failureMessage', done: ["newComment = ''"] },
		{ name: 'deleteComment', reads: 'deleteFailure', done: ['comments = comments.filter(c => c.id !== commentId)'] },
		{ name: 'saveEditComment', reads: 'failureMessage', done: ['editingCommentId = null'] },
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
	'src/routes/+page.svelte': [
		{ name: 'createBoard', reads: 'failureMessage', done: ['showCreate = false', 'goto(`/board/${board.id}`)'] },
		{ name: 'deleteBoard', reads: 'deleteFailure', done: ['await invalidateAll()'] },
		{
			name: 'toggleFavourite',
			reads: 'failureMessage',
			putsBack: ['showStar(boardId, was)'],
			done: ['showStar(boardId, (await res.json()).favourited === true)']
		},
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
	'src/routes/admin/+page.svelte': ['handleFileSelected'],
	'src/lib/components/CardModal.svelte': ['uploadFile']
};

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

			expect(sending.length).toBeGreaterThan(0);
			expect(sending.filter((name) => !named.includes(name))).toEqual([]);
		}
	);

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
	/**
	 * The writes whose answer is still thrown away, each a fault known and left
	 * for a card of its own, with the number of the card that puts it right.
	 * The list can only shrink: an entry that is no longer found fails the
	 * test, so take it off when the write is put right.
	 */
	const LEFT: Record<string, 2012> = {
		// Card 2012, which rewrites the board page's writes and the modules in
		// src/lib/board it sends them through. Until then they are as they were.
		'src/routes/board/[id]/+page.svelte › saveInlineEdit › api.updateCard': 2012,
		'src/routes/board/[id]/+page.svelte › cyclePriority › api.updateCard': 2012,
		'src/routes/board/[id]/+page.svelte › saveCompletionPrompt › api.updateCard': 2012,
		// The assignees chosen for a new card, each sent in a `.map` whose answers `Promise.all` drops.
		'src/routes/board/[id]/+page.svelte › saveCard › fetch POST': 2012,
		'src/routes/board/[id]/+page.svelte › markup onMove › api.reorderCards': 2012,
		'src/routes/board/[id]/+page.svelte › markup onPriority › api.updateCard': 2012,
		'src/routes/board/[id]/+page.svelte › markup onAdd › api.createCategory': 2012,
		'src/routes/board/[id]/+page.svelte › markup onDeleteCategory › api.deleteCategoryApi': 2012,
		'src/lib/board/board-actions.ts › saveBoardName › api.updateBoard': 2012,
		'src/lib/board/board-actions.ts › saveBoardEmoji › api.updateBoard': 2012,
		'src/lib/board/board-actions.ts › addColumn › api.createColumn': 2012,
		'src/lib/board/board-actions.ts › addCategory › api.createCategory': 2012,
		'src/lib/board/board-actions.ts › deleteCategory › api.deleteCategoryApi': 2012,
		'src/lib/board/bulk-actions.ts › bulkPriority › api.updateCard': 2012,
		'src/lib/board/card-actions.ts › saveCard › api.updateCard': 2012,
		'src/lib/board/card-actions.ts › saveCard › api.createSubtask': 2012,
		'src/lib/board/card-actions.ts › togglePin › api.updateCard': 2012,
		'src/lib/board/dnd-handlers.ts › confirmOnHold › api.updateCard': 2012,
		'src/lib/board/dnd-handlers.ts › confirmOnHold › api.reorderCards': 2012,
		'src/lib/board/dnd-handlers.ts › handleColumnDndFinalize › api.reorderColumns': 2012
		// Card 2148's six came off with it: sharing a board, deleting a subtask
		// from its window, the dashboard's favourite and category, and the
		// account page's emoji and mail settings. Each reads its answer now (the
		// table of writes above). The share window's `updateRole` had come off
		// with card 2115's review. The drop's request to clear the on-hold note
		// came off with card 2208: the server clears it in the move, and the drop
		// sends no second request. The bulk move's came off with card 2209: a
		// move of more than 100 cards to another column is refused, and the page
		// says so (the test of the bulk move below).
	};

	it('finds none but the ones left for a card of their own, and each of those', () => {
		const writes = apiWrites();
		const files = [...filesUnder('src/routes', '.svelte'), ...filesUnder('src/lib/components', '.svelte'), ...filesUnder('src/lib/board', '.ts')];
		const found = files.flatMap((file) => discardedIn(file, readFileSync(join(ROOT, file), 'utf8'), writes));

		expect(found.sort()).toEqual(Object.keys(LEFT).sort());
	});

	it('leaves each to card 2012, which owns the board page and src/lib/board; card 2148 left none', () => {
		for (const [write, card] of Object.entries(LEFT)) {
			const boards = write.startsWith('src/routes/board/[id]/+page.svelte ›') || write.startsWith('src/lib/board/');
			expect({ write, card, boards }).toEqual({ write, card: 2012, boards: true });
		}
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
			'src/lib/components/LabelPicker.svelte',
			'src/lib/components/ShareModal.svelte',
			'src/lib/components/SubtaskModal.svelte',
			'src/routes/account/+page.svelte'
		];
		if (ownLine.includes(file)) expect(checked).toEqual([]);
		else expect(checked.length).toBeGreaterThan(0);
	});

	it('is shown above every dialog, which a refusal is shown beside', () => {
		const zIndexes = (file: string) => [...readFileSync(join(ROOT, file), 'utf8').matchAll(/z-index:\s*(\d+)/g)].map((found) => Number(found[1]));
		const [toast] = zIndexes('src/lib/components/Toast.svelte');

		for (const dialog of [
			'src/app.css',
			'src/lib/components/CardModal.svelte',
			'src/lib/components/ConfirmModal.svelte',
			...Object.keys(WRITES).filter((file) => file.startsWith('src/routes/'))
		]) {
			for (const below of zIndexes(dialog)) expect(toast, dialog).toBeGreaterThan(below);
		}
		// The archived page's own confirmation is one of them, at 9999.
		expect(zIndexes('src/routes/archived/+page.svelte')).toContain(9999);
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

	it.each(['src/routes/admin/+page.svelte', 'src/routes/teams/+page.svelte'])('%s keeps showToast, as one line that adds to the store', (file) => {
		const body = functionNamed(scriptOf(file), 'showToast').body!;

		expect(body.statements.map((statement) => statement.getText())).toEqual(['toasts.add(msg, type, started);']);
	});

	it('is never a dialog box: no alert, which would hold the page while a 401 sends it to the login page', () => {
		const files = [
			...filesUnder('src/routes', '.svelte'),
			...filesUnder('src/routes', '.ts'),
			...filesUnder('src/lib/components', '.svelte'),
			...filesUnder('src/lib/board', '.ts')
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
});

// All To Do (card 2240) carries its own copy of All Tasks' card window
// handlers, held to the same rules here until card 2012 merges them.
describe.each(['src/routes/all/+page.svelte', 'src/routes/todo/+page.svelte'])('archiving a card from %s', (file) => {
	const page = scriptOf(file);
	const board = scriptOf('src/routes/board/[id]/+page.svelte');

	it('asks first, in the board page’s words, and sends the archive only once it is confirmed', () => {
		const archiving = functionNamed(page, 'deleteCard');
		const asked = callsOf(archiving, 'showConfirm');
		expect(asked).toHaveLength(1);
		expect(asked[0].arguments[1].getText()).toBe('cardArchiveWarning(editingCard.title)');

		const confirmed = asked[0].arguments[3];
		expect(ts.isArrowFunction(confirmed)).toBe(true);
		const requests = callsOf(archiving, 'fetch');
		expect(requests).toHaveLength(1);
		expect(requests[0].arguments[1].getText()).toContain("method: 'DELETE'");
		expect(isWithin(requests[0], confirmed)).toBe(true);
	});

	it('says the same as the board page before and after, from one text', () => {
		expect(callsOf(functionNamed(board, 'confirmDeleteCard'), 'api.cardArchiveWarning')).toHaveLength(1);
		expect(callsOf(functionNamed(page, 'deleteCard'), 'cardArchiveWarning')).toHaveLength(1);
		for (const tree of [page, board]) {
			expect(tree.getText()).toContain("toasts.add('Card archived. Restore it from Archived Cards.', 'info');");
			expect(tree.getText()).not.toContain('It is taken off the board and nothing on it is deleted');
		}
		expect(cardArchiveWarning('Ship it')).toBe(
			'Archive "Ship it"? It is taken off the board and nothing on it is deleted. It can be restored from Archived Cards, in the More menu.'
		);
		expect(cardArchiveWarning(undefined)).toMatch(/^Archive this card\? /);
	});

	it('has the confirmation and the toast in its markup', () => {
		const source = readFileSync(join(ROOT, file), 'utf8');
		const markup = source.slice(source.indexOf('</script>'));

		expect(markup).toContain('{#if confirmState.show}');
		expect(markup).toContain('onConfirm={() => { confirmState.show = false; confirmState.onConfirm(); }}');
		// All Tasks' Archived Cards panel deletes for good; All To Do has no such panel.
		if (file === 'src/routes/all/+page.svelte') expect(callsOf(functionNamed(page, 'permanentlyDeleteArchivedCard'), 'showConfirm')).toHaveLength(1);
		expect(page.getText()).not.toMatch(/window\.(alert|confirm)\(/);
	});
});

// Card 2186. All Tasks built the card window's card field by field and left
// out the five reporting fields and `requestOrigin`, so the window opened its
// Reporting section empty on a card with values, and showed no "Created from
// request by ..."; and its save sent none of the five, so what was typed
// there was dropped. The route itself is run in `tests/card-updates.test.ts`.
describe.each(['src/routes/all/+page.svelte', 'src/routes/todo/+page.svelte'])('the card window on %s (card 2186)', (file) => {
	const page = scriptOf(file);
	const REPORTING = ['summary', 'theme', 'customerImpact', 'closeReason', 'releaseState'];

	it('hands the window the row as loaded, with its fall-backs, so the reporting fields and requestOrigin come with it', () => {
		const given = assignmentsTo(functionNamed(page, 'openCard'), 'editingCard');
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

	it('sends the five reporting fields with the rest of a save', () => {
		expect(bodiesSent(functionNamed(page, 'saveCard'))).toEqual([
			['title', 'description', 'priority', 'categoryId', 'dueDate', 'onHoldNote', 'businessValue', 'boardId', ...REPORTING]
		]);
		// As the window gives them: text, or null for a cleared field, which clears it.
		const said = functionNamed(page, 'saveCard').getText().replace(/\s+/g, ' ');
		for (const name of REPORTING) expect(said).toContain(`${name}: cardData.${name}`);
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

		expect(said).toContain('const { title, failure, into } = await cardActions.duplicateCard(card, boardColumns, data.board.id, boardCategories);');
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
				'Those who can open this board see it on this card only if they can open "Website" too, ' +
				"but this board's reports, scheduled ones included, will include its cards for all of them. " +
				"This board's editors can move this card, taking \"Website\" with it. " +
				'This card cannot be completed while "Website" has cards that are not complete, and "Website" is deleted for good, with everything on it, if this card, its column or this board is ever deleted for good.'
		);
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

	it('is said by the new-card window for each sub-board refused, in the server’s words, and the card is kept', () => {
		const save = functionNamed(board, 'saveCard');
		const asked = callsOf(save, 'api.failureMessage');

		expect(asked).toHaveLength(1);
		expect(sideOf(asked[0])).toBe('failed');
		const said = save.getText().replace(/\s+/g, ' ');
		expect(said).toContain(
			"if (res.ok) { toasts.add(`Sub-board \"${sbName}\" created`); } else { toasts.add(`Sub-board \"${sbName}\" was not made. ${await api.failureMessage(res, 'The server refused it.')}`, 'error', started); }"
		);
		// A request with no answer is said too, and the next name is still sent.
		expect(said).toContain("} catch { toasts.add(`No answer from the server. Sub-board \"${sbName}\" may not have been made.`, 'error', started); continue; }");
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

	it('is said by the board page as an error, which keeps the selection, and the board is read again either way', () => {
		const handle = functionNamed(scriptOf('src/routes/board/[id]/+page.svelte'), 'handleBulkMove');
		const said = handle.getText().replace(/\s+/g, ' ');

		expect(said).toContain('const failure = await bulkOps.bulkMove(');
		expect(said).toContain("if (failure) { toasts.add(failure, 'error', started); } else { clearSelection(); } await invalidateAll();");
		// The only clearSelection is the one for a move that was made.
		const cleared = callsOf(handle, 'clearSelection');
		expect(cleared).toHaveLength(1);
		const ifFailure = ts.findAncestor(cleared[0], ts.isIfStatement)!;
		expect(ifFailure.expression.getText()).toBe('failure');
		expect(isWithin(cleared[0], ifFailure.elseStatement!)).toBe(true);
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
		expect(said).toContain('await invalidateAll();');
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
		expect(modal).toContain('on a sub-board you cannot open.');
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
		const dashboard = svelteFile('src/routes/+page.svelte');

		for (const name of ['createBoard', 'toggleFavourite', 'setBoardCategory', 'createBoardCategoryInline']) {
			const asked = callsOf(functionNamed(dashboard.tree, name), 'failureMessage');
			expect(asked.length, name).toBeGreaterThan(0);
			expect(asked.map(givenTo), name).toEqual(asked.map(() => "failureToasts.add(…, 'error', started)"));
		}
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

describe('the admin page’s user rows, src/routes/admin/+page.svelte', () => {
	const file = 'src/routes/admin/+page.svelte';
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
			'onchange={(e) => changeUserRole(u.id, e.currentTarget)}',
			'onclick={() => resendInvite(u.id)}',
			'() => deleteUser(u.id))}'
		]) {
			const blocks = around(control);
			expect(blocks.some((block) => block.condition === RULE && !block.inElse), control).toBe(true);
			expect(blocks.some((block) => block.condition === NOT_OWN && !block.inElse), control).toBe(true);
		}
	});

	it('shows 🔑 where the rule lets the caller use it, their own row included, and 🔒 everywhere else', () => {
		const key = around('onclick={() => openResetDialog(u.id)} title="Reset password">🔑</button>');
		expect(key.some((block) => block.condition === RULE && !block.inElse)).toBe(true);
		expect(key.some((block) => block.condition === NOT_OWN)).toBe(false);

		const lock = around('<span class="superadmin-lock"');
		expect(lock.some((block) => block.condition === RULE && block.inElse)).toBe(true);
	});

	it('asks the one rule the server asks, which the page and the guard import', () => {
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
