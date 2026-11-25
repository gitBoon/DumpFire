/**
 * The UI kit's motion (card 3074): two Svelte actions, each doing nothing
 * where the reader has asked for less motion (`prefers-reduced-motion`), and
 * nothing in a browser without the means (jsdom has neither `matchMedia` nor
 * `Element.animate`). Neither writes a <style> element: the fade is the Web
 * Animations API and the count writes text, so the page's CSP is untouched.
 *
 *   - `fadeIn`: the element comes in once, from transparent and 4px lower,
 *     over 180ms.
 *   - `tickUp`: a number counts up to its value once, as the browser first
 *     draws the element; a later value is written at once, and a number the
 *     server drew is left as it is.
 */

/** Whether the reader has asked for less motion. A browser that cannot say is taken to have asked. */
export function prefersReducedMotion(): boolean {
	if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
	return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export interface FadeInOptions {
	/** Milliseconds before it starts. */
	delay?: number;
}

/** Fades the element in and up by 4px over 180ms, once. */
export function fadeIn(node: HTMLElement, options: FadeInOptions = {}) {
	if (prefersReducedMotion() || typeof node.animate !== 'function') return {};
	node.animate(
		[
			{ opacity: 0, transform: 'translateY(4px)' },
			{ opacity: 1, transform: 'translateY(0)' }
		],
		{ duration: 180, delay: options.delay ?? 0, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'backwards' }
	);
	return {};
}

export interface TickUpOptions {
	value: number;
	/** How long the count takes, in milliseconds. */
	duration?: number;
	/** How each number is written; by default as the value is, to its own decimal places. */
	format?: (n: number) => string;
}

/** The decimal places a number is written with. */
function placesOf(value: number): number {
	const text = String(value);
	const dot = text.indexOf('.');
	return dot === -1 || /e/i.test(text) ? 0 : text.length - dot - 1;
}

/**
 * The counted elements the server drew, found as this module is first run:
 * before the page is hydrated, which needs this module. Hydration takes
 * them over as they are, already showing their numbers, so they are not
 * counted again from 0 (a flash of 0 after the right number). Only an
 * element the browser draws afterwards, on a page opened from another, is
 * counted. Each is marked `data-tick-up` (as Stat's value is).
 */
const drawnByServer: WeakSet<Element> = new WeakSet(typeof document === 'undefined' ? [] : document.querySelectorAll('[data-tick-up]'));

/**
 * Counts the element's number up from 0 to its value as the browser first
 * draws it. The element holds the final number in its markup; the count
 * rewrites that text node's data, so Svelte's own node is kept. An element
 * the server drew keeps its number (`drawnByServer`).
 */
export function tickUp(node: HTMLElement, params: number | TickUpOptions) {
	let options = typeof params === 'number' ? { value: params } : params;
	let frame = 0;

	const formatOf = (o: TickUpOptions) => o.format ?? ((n: number) => n.toFixed(placesOf(o.value)));
	const write = (text: string) => {
		const only = node.childNodes.length === 1 ? node.firstChild : null;
		if (only && only.nodeType === 3) (only as Text).data = text;
		else node.textContent = text;
	};
	const stop = () => {
		if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
		frame = 0;
	};

	const target = options.value;
	if (!Number.isFinite(target) || target === 0 || drawnByServer.has(node) || prefersReducedMotion() || typeof requestAnimationFrame !== 'function') {
		write(formatOf(options)(target));
	} else {
		const duration = options.duration ?? 700;
		const started = performance.now();
		const step = (now: number) => {
			const t = Math.min(1, (now - started) / duration);
			const eased = 1 - Math.pow(1 - t, 3);
			write(formatOf(options)(t === 1 ? target : target * eased));
			frame = t === 1 ? 0 : requestAnimationFrame(step);
		};
		write(formatOf(options)(0));
		frame = requestAnimationFrame(step);
	}

	return {
		update(next: number | TickUpOptions) {
			stop();
			options = typeof next === 'number' ? { value: next } : next;
			write(formatOf(options)(options.value));
		},
		destroy: stop
	};
}
