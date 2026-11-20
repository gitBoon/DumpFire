// @vitest-environment jsdom
/**
 * A held request's release dialog in the inbox (card 3020, slice 3: the plan's
 * case (ae), R1 and R3). `RequestMailHeld` is mounted alone with Svelte's
 * client runtime, `fetch` a stand-in that keeps every request sent.
 *
 * The request came in with a backup whose seal did not verify, so its
 * requester's address is only the file's word: the dialog shows it with
 * `asciiShown`, each character outside printable ASCII as its code point (a
 * direction override, a control character and a Cyrillic look-alike among
 * them), and the request's title, its card's title and its board through
 * `printable`, so that none of them can turn round or hide what follows.
 *
 * What the server answers is in tests/request-mail-held.test.ts. The plan is
 * docs/planning/card-3020-unsealed-request-addresses.md, section 3.9.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Svelte from 'svelte';

// A bare 'svelte' gives the server's runtime: the client's, by its path, for the components' own imports too.
vi.mock('svelte', async () => {
	const { join } = await import('node:path');
	const { pathToFileURL } = await import('node:url');
	return await import(/* @vite-ignore */ pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href);
});
// The page's data, as the layout's load gives it: empty.
vi.mock('$app/state', () => ({ page: { data: {} } }));

import RequestMailHeld, { type HeldRequest } from '$lib/components/RequestMailHeld.svelte';
import { CODE, codeFieldIn } from './helpers/step-up-code';

const clientEntry = pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href;
const { flushSync, mount, unmount }: typeof Svelte = await import(/* @vite-ignore */ clientEntry);

let drawn: { component: ReturnType<typeof mount>; target: HTMLElement }[] = [];

beforeEach(() => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
	);
});

afterEach(() => {
	for (const { component, target } of drawn) {
		unmount(component);
		target.remove();
	}
	drawn = [];
	document.body.replaceChildren();
	vi.unstubAllGlobals();
});

/**
 * A held request as a file whose seal did not verify may give it: the address
 * with a U+202E right-to-left override, a U+0007 bell and a Cyrillic a look-alike
 * (U+0430) for the Latin a; the titles and the board each with a character
 * `printable` replaces.
 *
 * Each is built from its code point, so that this file holds none of them as written.
 */
const [RLO, BELL, CYRILLIC_A, ZERO_WIDTH] = [0x202e, 0x7, 0x430, 0x200b].map((point) => String.fromCodePoint(point));

const held: HeldRequest = {
	id: 7,
	title: `Pay${RLO}troper the invoice`,
	status: 'accepted',
	unconfirmed: false,
	releasable: true,
	requesterName: 'Pat',
	address: `p${CYRILLIC_A}t@ex${BELL}ample.test${RLO}moc.live`,
	card: { id: 3, title: 'Invoice\nrun', board: `Fin${ZERO_WIDTH}ance` },
	heldBecause: 'restored from a backup whose seal did not verify',
	createdAt: '2026-11-19 09:00:00'
};

describe('RequestMailHeld (card 3020, slice 3)', () => {
	it('(ae) card 3020, R3: the release dialog shows the address through asciiShown, as code points, and the title, card title and board through printable', () => {
		const target = document.createElement('ul');
		document.body.appendChild(target);
		drawn.push({ component: mount(RequestMailHeld as never, { target, props: { held } as never }), target });
		flushSync();

		[...target.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent!.trim() === 'Release')!.click();
		flushSync();

		const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
		expect(dialog).not.toBeNull();
		expect(dialog.getAttribute('aria-label')).toBe('Pay troper the invoice');
		expect(dialog.querySelector('h3')!.textContent).toBe('Pay troper the invoice');
		const message = dialog.querySelector('.confirm-message')!.textContent!;
		expect(message).toContain(
			'Mail to p\\u{430}t@ex\\u{7}ample.test\\u{202E}moc.live is held: this request came in with a backup whose seal did not verify. ' +
				'Its card: Invoice run on Fin ance. Release it only if you recognise the address and the card.'
		);
		// Nothing of the file's own characters reaches the dialog's words.
		for (const character of [CYRILLIC_A, BELL, RLO, '\n', ZERO_WIDTH]) expect(message).not.toContain(character);
		// The row the dialog was opened from shows the address the same way.
		expect(target.querySelector('code')!.textContent).toBe('p\\u{430}t@ex\\u{7}ample.test\\u{202E}moc.live');
	});

	it("(ae2) card 3020's code review, FP4: Release sends back the address and the card, its title and its board, as they were reviewed, with the password and the code", async () => {
		const target = document.createElement('ul');
		document.body.appendChild(target);
		drawn.push({ component: mount(RequestMailHeld as never, { target, props: { held } as never }), target });
		flushSync();
		[...target.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent!.trim() === 'Release')!.click();
		flushSync();
		const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
		const password = dialog.querySelector<HTMLInputElement>('input[type="password"]')!;
		password.value = 'my password';
		password.dispatchEvent(new Event('input', { bubbles: true }));
		const code = codeFieldIn(dialog)!;
		code.value = CODE;
		code.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();

		[...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent!.trim() === 'Release')!.click();
		await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));

		const [url, init] = vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/api/requests/held');
		expect(JSON.parse(init.body as string)).toEqual({
			requestId: 7,
			address: held.address,
			cardId: 3,
			cardTitle: 'Invoice\nrun',
			cardBoard: `Fin${ZERO_WIDTH}ance`,
			currentPassword: 'my password',
			currentCode: CODE
		});
	});

	it("(ae3) card 3020's code review, FP3: a held request with no address offers no Release, and says why", () => {
		const target = document.createElement('ul');
		document.body.appendChild(target);
		drawn.push({ component: mount(RequestMailHeld as never, { target, props: { held: { ...held, address: null, releasable: false } } as never }), target });
		flushSync();

		expect([...target.querySelectorAll('button')].map((button) => button.textContent!.trim())).toEqual([]);
		expect(target.textContent).toContain('Cannot be released: no address');
		expect(target.textContent).not.toContain('lapses');
	});
});
