// @vitest-environment jsdom
/**
 * The app's confirm dialog taking, keeping and giving back the keyboard's
 * focus (card 2353), `ConfirmModal` mounted alone with Svelte's client
 * runtime, a button outside it standing for the one that opened it.
 *
 *   - It moved no focus: the focus stayed on whatever opened it, behind the
 *     overlay, Tab walked the page behind, and nothing gave it back when the
 *     dialog closed. Cancel now takes it as the dialog opens, Tab and
 *     Shift+Tab stay on the dialog's two buttons, and a Tab from outside the
 *     dialog comes back to Cancel.
 *   - The dialog's message is tied to it by `aria-describedby`, so a screen
 *     reader that lands on Cancel reads what is being confirmed (F5).
 *   - On close the focus goes back to the opener after one macrotask, and
 *     only if the opener is still in the page and nothing else has taken the
 *     focus: a card window the confirm opened (the board page's Cannot
 *     Complete, Open Card) focuses its title in a microtask, and keeps it.
 *
 * The plan is `docs/planning/cards-2337-2338-2341-2342-2353-card-window.md`
 * (section 3.1, decisions 1 to 4, tests 3 to 7).
 *
 * Card 2701 (cases 26 and 27 of `docs/planning/card-2701-admin-step-up.md`):
 * with `askPassword` the dialog asks for the caller's own password, hands it
 * to an awaited `onConfirm`, and stays open on the refusal that gives back,
 * showing it, the field cleared and focused; a 400 asking for a password the
 * dialog did not ask for shows the field.
 *
 * Card 2772 (T10 of `docs/planning/card-2772-account-two-step.md`): with more
 * than one authenticator, the field says before sending what one wrong answer
 * costs. The page's data is stood in for (`$app/state`), empty but where a
 * case gives it `authenticators`.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type * as Svelte from 'svelte';
import ConfirmModal from '$lib/components/ConfirmModal.svelte';
import CurrentPasswordField from '$lib/components/CurrentPasswordField.svelte';
import {
	NO_ANSWER_TRY_AGAIN,
	NO_PROOF,
	STEP_UP_CODE_MALFORMED,
	STEP_UP_CODE_SPENT,
	STEP_UP_FACTOR_UNUSABLE,
	STEP_UP_MISSING,
	STEP_UP_SIGNED_OUT,
	STEP_UP_WRONG,
	type StepUpProof
} from '$lib/step-up-words';
import { CODE, codeFieldIn, proofOf } from './helpers/step-up-code';

// A bare 'svelte' gives the server's runtime, whose flushSync does nothing: the client's, by its path, for the
// components' own imports too (card 2770's CR1, the code switch drawn before it takes the focus).
vi.mock('svelte', async () => {
	const { join } = await import('node:path');
	const { pathToFileURL } = await import('node:url');
	return await import(/* @vite-ignore */ pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href);
});

// The page's data, as the layout's load gives it: empty unless a case says (card 2772).
const pageStub = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock('$app/state', () => ({ page: pageStub }));

// The browser's `mount`, loaded by its path: a bare 'svelte' gives the server's (see the XP bars' file).
const clientEntry = pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href;
const { flushSync, mount, unmount }: typeof Svelte = await import(/* @vite-ignore */ clientEntry);

let drawn: { component: ReturnType<typeof mount>; target: HTMLElement } | null = null;
let opener: HTMLButtonElement;
let onConfirm: Mock<() => void>;
let onCancel: Mock<() => void>;

beforeEach(() => {
	pageStub.data = {};
	onConfirm = vi.fn<() => void>();
	onCancel = vi.fn<() => void>();
	// The button a page's confirm is opened from, with the focus, as a click or Enter leaves it.
	opener = document.createElement('button');
	opener.textContent = 'Delete Team';
	document.body.appendChild(opener);
	opener.focus();
});

afterEach(() => {
	close();
	document.body.replaceChildren();
});

/** Opens the dialog, as a page does on its button. */
function open(extra: Record<string, unknown> = {}) {
	const target = document.createElement('div');
	document.body.appendChild(target);
	const props = { title: 'Delete Team', message: 'The team will be deleted.', onConfirm, onCancel, ...extra };
	drawn = { component: mount(ConfirmModal, { target, props: props as never }), target };
	flushSync();
	return target;
}

/** Closes the dialog, as a page does by no longer drawing it. */
function close() {
	if (!drawn) return;
	unmount(drawn.component);
	drawn.target.remove();
	drawn = null;
	flushSync();
}

const cancelButton = (target: HTMLElement) => [...target.querySelectorAll('button')].find((b) => b.textContent!.trim() === 'Cancel')!;
/** Confirm: the second of the dialog's two buttons, whose words say "Working…" while its answer is awaited (card 2701, F2). */
const confirmButton = (target: HTMLElement) => target.querySelectorAll<HTMLButtonElement>('.confirm-actions button')[1];

/** A Tab (or Shift+Tab) pressed where the focus is, bubbling as a real one does; gives back whether its default was taken. */
function tab(shiftKey = false): boolean {
	const key = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
	(document.activeElement ?? document.body).dispatchEvent(key);
	flushSync();
	return key.defaultPrevented;
}

/** One macrotask turn: what the dialog schedules as it closes has run. */
const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the confirm dialog takes the focus as it opens (card 2353)', () => {
	it('gives Cancel the focus, and ties its message to the dialog', () => {
		const target = open();
		expect(document.activeElement).toBe(cancelButton(target));

		const dialog = target.querySelector('[role="dialog"]')!;
		const message = target.querySelector('.confirm-message')!;
		expect(message.id).not.toBe('');
		expect(dialog.getAttribute('aria-describedby')).toBe(message.id);
	});

	it('names no message when it has none', () => {
		const target = open({ message: '' });
		expect(target.querySelector('[role="dialog"]')!.hasAttribute('aria-describedby')).toBe(false);
		expect(document.activeElement).toBe(cancelButton(target));
	});
});

describe('the confirm dialog keeps the focus on its two buttons (card 2353)', () => {
	it('Tab on the confirm button goes to Cancel, and Shift+Tab on Cancel to the confirm button, each taking the default; Tab on Cancel is the browser’s own', () => {
		const target = open();
		confirmButton(target).focus();
		expect(tab()).toBe(true);
		expect(document.activeElement).toBe(cancelButton(target));

		expect(tab(true)).toBe(true);
		expect(document.activeElement).toBe(confirmButton(target));

		// From Cancel forwards the next button is the confirm button: left to the browser.
		cancelButton(target).focus();
		expect(tab()).toBe(false);
		expect(document.activeElement).toBe(cancelButton(target));
		expect(onConfirm).not.toHaveBeenCalled();
		expect(onCancel).not.toHaveBeenCalled();
	});

	it('Tab with the focus outside the dialog (a click on its overlay leaves it on the page) brings it to Cancel', () => {
		const target = open();
		(document.activeElement as HTMLElement).blur();
		expect(document.activeElement).toBe(document.body);
		expect(tab()).toBe(true);
		expect(document.activeElement).toBe(cancelButton(target));

		opener.focus();
		expect(tab(true)).toBe(true);
		expect(document.activeElement).toBe(cancelButton(target));
	});
});

describe('the confirm dialog gives the focus back as it closes (card 2353)', () => {
	it('to the button that opened it, after one macrotask, when the focus was on the dialog', async () => {
		const target = open();
		confirmButton(target).focus();
		close();
		// Not at once, nor in a microtask: a window the confirm opened may focus its title then.
		await Promise.resolve();
		expect(document.activeElement).not.toBe(opener);
		await macrotask();
		expect(document.activeElement).toBe(opener);
	});

	it('to nothing when something else took the focus as it closed (a card window’s title), or when its opener is gone; and nothing throws', async () => {
		// Passes on a dialog that gives nothing back: it guards against a give-back that beats the title.
		let target = open();
		confirmButton(target).focus();
		const title = document.createElement('input');
		document.body.appendChild(title);
		close();
		// As Svelte's `autofocus` does: in a microtask, if the focus is then on the body.
		queueMicrotask(() => {
			if (document.activeElement === document.body) title.focus();
		});
		await macrotask();
		expect(document.activeElement).toBe(title);

		// The opener the action removed: a deleted comment's Delete button, say.
		opener.focus();
		target = open();
		confirmButton(target).focus();
		opener.remove();
		close();
		await macrotask();
		expect(document.activeElement).toBe(document.body);
	});
});

/** The dialog's password field, if it shows one. */
const passwordField = (target: HTMLElement) => target.querySelector<HTMLInputElement>('input[type="password"]');

/** Types `text` into a box, as `bind:value` hears it. */
function type(box: HTMLInputElement, text: string) {
	box.value = text;
	box.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

/** Types `CODE` into the dialog's code field (card 2770). */
const typeCode = (within: HTMLElement) => type(codeFieldIn(within)!, CODE);

/** The switch between the authenticator's code and a recovery code (card 2770). */
const codeSwitch = (target: HTMLElement) => target.querySelector<HTMLButtonElement>('.code-switch');

/** Enter pressed in a box, bubbling as a real one does; gives back the event, to read whether its default was taken. */
function enterIn(box: HTMLElement): KeyboardEvent {
	const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
	box.dispatchEvent(enter);
	flushSync();
	return enter;
}

/** An `onConfirm` whose answer the case gives when it likes: what it was handed, and how to answer. */
function heldConfirm() {
	const handed: StepUpProof[] = [];
	const answers: Array<{ resolve: (answer: string | null | void) => void; reject: (fault: unknown) => void }> = [];
	const fn = vi.fn((proof: StepUpProof) => {
		handed.push(proof);
		return new Promise<string | null | void>((resolve, reject) => answers.push({ resolve, reject }));
	});
	return {
		fn,
		handed,
		answer: (said: string | null | void) => answers.shift()!.resolve(said),
		/** The answer never comes: `onConfirm`'s promise is rejected, as a fetch with no answer rejects. */
		fail: (fault: unknown) => answers.shift()!.reject(fault)
	};
}

describe('the confirm dialog asks for the caller’s password (card 2701, case 26)', () => {
	it('shows a labelled password field the browser fills as the current password, Confirm off until something is typed, and the focus in it', () => {
		const target = open({ askPassword: true });
		const field = passwordField(target)!;

		expect(field).not.toBeNull();
		expect(field.type).toBe('password');
		expect(field.getAttribute('autocomplete')).toBe('current-password');
		// Labelled: a screen reader names it, and a click on its words goes to it.
		const label = target.querySelector<HTMLLabelElement>(`label[for="${field.id}"]`);
		expect(label?.textContent?.trim()).toBe('Your password');
		// The focus is in it as the dialog opens: Enter does nothing until something is typed.
		expect(document.activeElement).toBe(field);
		expect(confirmButton(target).disabled).toBe(true);
		confirmButton(target).click();
		field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		flushSync();
		expect(onConfirm).not.toHaveBeenCalled();

		type(field, 'my-own-password');
		typeCode(target);
		expect(confirmButton(target).disabled).toBe(false);
	});

	it('confirms on Enter in the field, handing onConfirm the text typed, which the field no longer holds', async () => {
		const asked = heldConfirm();
		const target = open({ askPassword: true, onConfirm: asked.fn });
		const field = passwordField(target)!;
		type(field, 'my-own-password');
		typeCode(target);
		const enter = enterIn(field);

		expect(enter.defaultPrevented).toBe(true);
		expect(asked.handed).toEqual([proofOf('my-own-password')]);
		// Cleared once sent: it is held nowhere but the request.
		expect(field.value).toBe('');
		asked.answer();
		await macrotask();
	});

	it('clears what was typed on Cancel, sending nothing', () => {
		const target = open({ askPassword: true });
		type(passwordField(target)!, 'my-own-password');
		typeCode(target);
		cancelButton(target).click();
		flushSync();

		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onConfirm).not.toHaveBeenCalled();
		expect(passwordField(target)!.value).toBe('');
		// Card 2770: the code goes with it.
		expect(codeFieldIn(target)!.value).toBe('');
	});

	it('shows no field, and hands onConfirm an empty text, where it is not asked for: the dialogs that ask nothing are as they were', () => {
		const target = open();
		expect(passwordField(target)).toBeNull();
		expect(codeFieldIn(target)).toBeNull();
		expect(confirmButton(target).disabled).toBe(false);
		confirmButton(target).click();
		flushSync();
		expect(onConfirm).toHaveBeenCalledTimes(1);
		// Card 2770: the proof of a dialog that asked for nothing.
		expect(onConfirm.mock.calls[0]).toEqual([NO_PROOF]);
	});
});

describe('the confirm dialog asks for a sign-in code beside the password (card 2770)', () => {
	it('shows a labelled code field after the password, Confirm off with the password alone or a code of spaces, on with both; Tab from the password reaches it (T1)', () => {
		const target = open({ askPassword: true });
		const field = passwordField(target)!;
		const code = codeFieldIn(target)!;

		expect(code).not.toBeNull();
		expect(target.querySelector<HTMLLabelElement>(`label[for="${code.id}"]`)?.textContent?.trim()).toBe('Code from your authenticator app');
		expect(code.getAttribute('autocomplete')).toBe('one-time-code');
		expect(code.getAttribute('inputmode')).toBe('numeric');
		expect(code.getAttribute('maxlength')).toBe('7');
		// After the password in the page, and so the next stop of a Tab from it.
		expect(field.compareDocumentPosition(code) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		const inputs = [...target.querySelectorAll<HTMLElement>('input, button')];
		expect(inputs[inputs.indexOf(field) + 1]).toBe(code);
		expect(tab()).toBe(false);

		type(field, 'my-own-password');
		expect(confirmButton(target).disabled).toBe(true);
		type(code, '   ');
		expect(confirmButton(target).disabled).toBe(true);
		type(code, CODE);
		expect(confirmButton(target).disabled).toBe(false);
	});

	it('hands the proof as typed, both fields empty after; Enter in the password with the code blank moves to the code and sends nothing, Enter in the code confirms; on the bare field too (T2)', async () => {
		const asked = heldConfirm();
		const target = open({ askPassword: true, onConfirm: asked.fn });
		const field = passwordField(target)!;
		const code = codeFieldIn(target)!;
		type(field, 'my-own-password');

		expect(enterIn(field).defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(code);
		expect(asked.fn).not.toHaveBeenCalled();

		type(code, '123 456');
		expect(enterIn(code).defaultPrevented).toBe(true);
		expect(asked.handed).toEqual([{ currentPassword: 'my-own-password', currentCode: '123 456' }]);
		expect(field.value).toBe('');
		expect(code.value).toBe('');
		asked.answer();
		await macrotask();
		close();

		// The bare field, with no `onEnter` (UX7): Enter in the password still moves to the code.
		const bare = document.createElement('div');
		document.body.appendChild(bare);
		const component = mount(CurrentPasswordField, { target: bare, props: { value: '', code: '' } as never });
		flushSync();
		const bareField = passwordField(bare)!;
		bareField.focus();
		expect(enterIn(bareField).defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(codeFieldIn(bare));
		unmount(component);
	});

	it('the switch turns the same field to a recovery code, emptied and focused at once, handed as typed, and back; off while the answer is awaited (T3)', async () => {
		const asked = heldConfirm();
		const target = open({ askPassword: true, onConfirm: asked.fn });
		const code = codeFieldIn(target)!;
		const label = () => target.querySelector<HTMLLabelElement>(`label[for="${code.id}"]`)?.textContent?.trim();
		type(code, '12');

		expect(codeSwitch(target)!.textContent!.trim()).toBe('Use a recovery code instead');
		// What the field says of its keyboard at the moment it takes the focus (the code review's CR1).
		const atFocus: Array<{ autocomplete: string | null; inputmode: string | null; maxlength: string | null; value: string }> = [];
		const onFocus = () =>
			atFocus.push({ autocomplete: code.getAttribute('autocomplete'), inputmode: code.getAttribute('inputmode'), maxlength: code.getAttribute('maxlength'), value: code.value });
		code.addEventListener('focus', onFocus);
		codeSwitch(target)!.click();
		// Focused in the click's own handler, before any flush of the case's: a phone keeps its keyboard up, and opens the right one.
		expect(document.activeElement).toBe(code);
		expect(atFocus).toEqual([{ autocomplete: 'off', inputmode: 'text', maxlength: null, value: '' }]);
		code.removeEventListener('focus', onFocus);
		flushSync();
		expect(codeFieldIn(target)).toBe(code);
		expect(code.value).toBe('');
		expect(label()).toBe('Recovery code');
		expect(code.getAttribute('autocomplete')).toBe('off');
		expect(code.getAttribute('inputmode')).toBe('text');
		expect(code.hasAttribute('maxlength')).toBe(false);
		expect(codeSwitch(target)!.textContent!.trim()).toBe('Use a code from your authenticator app instead');

		type(passwordField(target)!, 'my-own-password');
		type(code, 'abcd-efgh-ijkl-mnop');
		confirmButton(target).click();
		flushSync();
		expect(asked.handed).toEqual([{ currentPassword: 'my-own-password', currentCode: 'abcd-efgh-ijkl-mnop' }]);
		// Off while the answer is awaited.
		expect(codeSwitch(target)!.disabled).toBe(true);
		asked.answer(STEP_UP_WRONG);
		await macrotask();
		flushSync();
		expect(codeSwitch(target)!.disabled).toBe(false);

		codeSwitch(target)!.click();
		flushSync();
		expect(label()).toBe('Code from your authenticator app');
		expect(code.getAttribute('autocomplete')).toBe('one-time-code');
		expect(code.getAttribute('inputmode')).toBe('numeric');
		expect(code.getAttribute('maxlength')).toBe('7');
	});

	it('opened again after closing in recovery mode, is back in the authenticator mode with the field empty (T4)', () => {
		let target = open({ askPassword: true });
		codeSwitch(target)!.click();
		flushSync();
		type(codeFieldIn(target)!, 'abcd');
		expect(codeFieldIn(target)!.getAttribute('autocomplete')).toBe('off');
		close();

		target = open({ askPassword: true });
		const code = codeFieldIn(target)!;
		expect(code.value).toBe('');
		expect(code.getAttribute('autocomplete')).toBe('one-time-code');
		expect(target.querySelector<HTMLLabelElement>(`label[for="${code.id}"]`)?.textContent?.trim()).toBe('Code from your authenticator app');
	});
});

describe('the confirm dialog waits for its answer and keeps a refusal in it (card 2701, case 27, D6)', () => {
	it('turns both buttons off while onConfirm runs, so one press sends one request, and ignores Escape meanwhile', async () => {
		const asked = heldConfirm();
		const target = open({ askPassword: true, onConfirm: asked.fn });
		type(passwordField(target)!, 'my-own-password');
		typeCode(target);
		confirmButton(target).click();
		flushSync();

		expect(confirmButton(target).disabled).toBe(true);
		expect(cancelButton(target).disabled).toBe(true);
		// Said to be working, to the eye and to a screen reader (the code review's F2).
		expect(confirmButton(target).textContent!.trim()).toBe('Working…');
		expect(confirmButton(target).getAttribute('aria-busy')).toBe('true');
		type(passwordField(target)!, 'again');
		typeCode(target);
		confirmButton(target).click();
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		flushSync();
		expect(asked.fn).toHaveBeenCalledTimes(1);
		expect(onCancel).not.toHaveBeenCalled();

		asked.answer();
		await macrotask();
		expect(cancelButton(target).disabled).toBe(false);
		expect(confirmButton(target).textContent!.trim()).toBe('Delete');
		expect(confirmButton(target).hasAttribute('aria-busy')).toBe(false);
	});

	it('says no answer in the dialog when onConfirm is rejected, the field cleared and focused to try again (the code review’s F9)', async () => {
		const asked = heldConfirm();
		const target = open({ askPassword: true, onConfirm: asked.fn });
		const field = passwordField(target)!;
		type(field, 'my-own-password');
		typeCode(target);
		confirmButton(target).click();
		flushSync();
		asked.fail(new TypeError('Failed to fetch'));
		await macrotask();
		flushSync();

		expect(target.querySelector('[role="alert"]')?.textContent).toBe(NO_ANSWER_TRY_AGAIN);
		expect(target.querySelector('[role="dialog"]')).not.toBeNull();
		expect(field.value).toBe('');
		// Card 2770: the code is cleared with it.
		expect(codeFieldIn(target)!.value).toBe('');
		expect(document.activeElement).toBe(field);
		expect(onCancel).not.toHaveBeenCalled();
	});

	it('takes the field away once the session is signed out: nothing more can be sent from it (the code review’s F5)', async () => {
		const asked = heldConfirm();
		const target = open({ askPassword: true, onConfirm: asked.fn });
		type(passwordField(target)!, 'a-wrong-one');
		typeCode(target);
		confirmButton(target).click();
		flushSync();
		asked.answer(STEP_UP_SIGNED_OUT);
		await macrotask();
		flushSync();

		expect(target.querySelector('[role="alert"]')?.textContent).toBe(STEP_UP_SIGNED_OUT);
		expect(passwordField(target)!.disabled).toBe(true);
		// Card 2770: the code field and its switch are off too.
		expect(codeFieldIn(target)!.disabled).toBe(true);
		expect(codeSwitch(target)!.disabled).toBe(true);
		expect(confirmButton(target).disabled).toBe(true);
	});

	it('stays open on a refusal, says it in an alert, clears the field and puts the focus in it; the next Confirm sends what is typed then', async () => {
		const asked = heldConfirm();
		const target = open({ askPassword: true, onConfirm: asked.fn });
		const field = passwordField(target)!;
		type(field, 'a-wrong-one');
		typeCode(target);
		confirmButton(target).click();
		flushSync();
		asked.answer(STEP_UP_WRONG);
		await macrotask();
		flushSync();

		const alert = target.querySelector('[role="alert"]');
		expect(alert?.textContent).toBe(STEP_UP_WRONG);
		expect(target.querySelector('[role="dialog"]')).not.toBeNull();
		expect(field.value).toBe('');
		// Card 2770: the code is cleared too, and named by the same alert.
		expect(codeFieldIn(target)!.value).toBe('');
		expect(codeFieldIn(target)!.getAttribute('aria-describedby')).toBe(alert!.id);
		expect(document.activeElement).toBe(field);
		expect(field.getAttribute('aria-describedby')).toBe(alert!.id);
		expect(confirmButton(target).disabled).toBe(true);

		type(field, 'the-right-one');
		type(codeFieldIn(target)!, '654321');
		confirmButton(target).click();
		flushSync();
		// The last refusal goes as the next Confirm is sent.
		expect(target.querySelector('[role="alert"]')).toBeNull();
		expect(asked.handed).toEqual([proofOf('a-wrong-one'), { currentPassword: 'the-right-one', currentCode: '654321' }]);
		asked.answer();
		await macrotask();
	});

	it('leaves the closing to its caller for an answer that is not a refusal', async () => {
		const asked = heldConfirm();
		const closing = vi.fn();
		const target = open({
			askPassword: true,
			onConfirm: async (proof: StepUpProof) => {
				await asked.fn(proof);
				closing();
			}
		});
		type(passwordField(target)!, 'the-right-one');
		typeCode(target);
		confirmButton(target).click();
		asked.answer(null);
		await macrotask();
		flushSync();

		expect(closing).toHaveBeenCalledTimes(1);
		expect(target.querySelector('[role="alert"]')).toBeNull();
		// The dialog is the caller's to close, as it does by no longer drawing it.
		close();
		await macrotask();
		expect(document.activeElement).toBe(opener);
	});

	it('shows the field where the server asked for a password the dialog did not ask for (a column of archived cards alone, decision 18)', async () => {
		const asked = heldConfirm();
		const target = open({ onConfirm: asked.fn });
		expect(passwordField(target)).toBeNull();
		confirmButton(target).click();
		flushSync();
		expect(asked.handed).toEqual([NO_PROOF]);
		asked.answer(STEP_UP_MISSING);
		await macrotask();
		flushSync();

		const field = passwordField(target)!;
		expect(field).not.toBeNull();
		expect(document.activeElement).toBe(field);
		expect(target.querySelector('[role="alert"]')?.textContent).toBe(STEP_UP_MISSING);
		expect(confirmButton(target).disabled).toBe(true);
		// Card 2770: both fields shown, and Confirm off until both are typed.
		expect(codeFieldIn(target)).not.toBeNull();
		type(field, 'my-own-password');
		expect(confirmButton(target).disabled).toBe(true);
		typeCode(target);
		expect(confirmButton(target).disabled).toBe(false);
		confirmButton(target).click();
		flushSync();
		expect(asked.handed).toEqual([NO_PROOF, proofOf('my-own-password')]);
		asked.answer();
		await macrotask();
	});
});

// Card 2771 (plan section 5.1, T15; D9, E9): a refusal decided before the password was compared keeps it typed.
describe('the confirm dialog keeps the password before the compare’s refusals (card 2771)', () => {
	it('T15. keeps the password typed on code-spent, code-malformed and factor-unusable, the code emptied and focused, and Confirm hands the kept password with the new code; on wrong both are emptied and the password focused', async () => {
		for (const kept of [STEP_UP_CODE_SPENT, STEP_UP_CODE_MALFORMED, STEP_UP_FACTOR_UNUSABLE]) {
			const asked = heldConfirm();
			const target = open({ askPassword: true, onConfirm: asked.fn });
			const field = passwordField(target)!;
			type(field, 'my-own-password');
			typeCode(target);
			confirmButton(target).click();
			flushSync();
			asked.answer(kept);
			await macrotask();
			flushSync();

			expect(target.querySelector('[role="alert"]')?.textContent, kept).toBe(kept);
			expect(field.value, kept).toBe('my-own-password');
			expect(codeFieldIn(target)!.value, kept).toBe('');
			expect(document.activeElement, kept).toBe(codeFieldIn(target));
			// Confirm off until the new code is typed; then the kept password goes with it.
			expect(confirmButton(target).disabled, kept).toBe(true);
			type(codeFieldIn(target)!, '654321');
			confirmButton(target).click();
			flushSync();
			expect(asked.handed, kept).toEqual([proofOf('my-own-password'), { currentPassword: 'my-own-password', currentCode: '654321' }]);
			asked.answer();
			await macrotask();
			close();
		}

		const asked = heldConfirm();
		const target = open({ askPassword: true, onConfirm: asked.fn });
		const field = passwordField(target)!;
		type(field, 'my-own-password');
		typeCode(target);
		confirmButton(target).click();
		flushSync();
		asked.answer(STEP_UP_WRONG);
		await macrotask();
		flushSync();

		expect(target.querySelector('[role="alert"]')?.textContent).toBe(STEP_UP_WRONG);
		expect(field.value).toBe('');
		expect(codeFieldIn(target)!.value).toBe('');
		expect(document.activeElement).toBe(field);
	});
});

// Card 2772 (plan section 5.1, T10; D4, E2): a wrong answer counts one for each authenticator, said before sending.
describe('the confirm dialog says what a wrong answer costs with several authenticators (card 2772)', () => {
	/** The line, if the field shows one. */
	const weightLine = (target: HTMLElement) => target.querySelector<HTMLElement>('.current-code-weight');

	it('T10. shows the line for 2 and for 3 in the authenticator mode, tied to the code field, and none in the recovery-code mode; with 1, none', () => {
		for (const [held, words] of [
			[2, 'You have 2 authenticators, so each wrong answer here counts twice: two wrong answers sign this browser out.'],
			[3, 'You have 3 authenticators, so one wrong answer here signs this browser out.']
		] as const) {
			pageStub.data = { authenticators: held };
			const target = open({ askPassword: true });
			const line = weightLine(target);

			expect(line?.textContent?.trim(), String(held)).toBe(words);
			expect(codeFieldIn(target)!.getAttribute('aria-describedby'), String(held)).toBe(line!.id);
			codeSwitch(target)!.click();
			flushSync();
			expect(weightLine(target), String(held)).toBeNull();
			expect(codeFieldIn(target)!.hasAttribute('aria-describedby'), String(held)).toBe(false);
			close();
		}

		pageStub.data = { authenticators: 1 };
		const target = open({ askPassword: true });
		expect(weightLine(target)).toBeNull();
		expect(codeFieldIn(target)!.hasAttribute('aria-describedby')).toBe(false);
	});
});
