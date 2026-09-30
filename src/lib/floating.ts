/**
 * floating.ts — where a floating panel goes, and a way to lift it out of the page.
 *
 * Shared by the click-to-open popovers (Popover.svelte) and the hover
 * explanations (InfoTip.svelte), which both render through FloatingPanel.
 * The placement maths is pure so it can be checked without a browser.
 */

export interface Box {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface Placement {
	left: number;
	top: number;
	/** Which side of the trigger the panel ended up on. */
	side: 'bottom' | 'top';
	/** Where the pointer arrow sits, from the panel's left edge. */
	arrow: number;
}

export interface PlaceOptions {
	/** Space between trigger and panel. */
	gap?: number;
	/** Closest the panel may come to the viewport edge. */
	margin?: number;
	prefer?: 'bottom' | 'top';
	/** Line the panel up with the trigger's left edge, or centre it on the trigger. */
	align?: 'start' | 'center';
}

/**
 * Below the trigger if it fits, above if it does not, and whichever side has
 * more room if neither does. Slid sideways to stay on screen, with the arrow
 * still pointing at the trigger. Viewport coordinates, for position: fixed.
 */
export function placeFloating(
	trigger: Box,
	panel: { width: number; height: number },
	viewport: { width: number; height: number },
	{ gap = 8, margin = 8, prefer = 'bottom', align = 'start' }: PlaceOptions = {}
): Placement {
	const below = trigger.top + trigger.height + gap;
	const above = trigger.top - gap - panel.height;
	const fitsBelow = below + panel.height <= viewport.height - margin;
	const fitsAbove = above >= margin;

	let side: 'bottom' | 'top';
	if (prefer === 'bottom') side = fitsBelow || !fitsAbove ? 'bottom' : 'top';
	else side = fitsAbove || !fitsBelow ? 'top' : 'bottom';
	if (!fitsBelow && !fitsAbove) {
		const roomBelow = viewport.height - (trigger.top + trigger.height);
		side = roomBelow >= trigger.top ? 'bottom' : 'top';
	}

	const wanted = align === 'center' ? trigger.left + trigger.width / 2 - panel.width / 2 : trigger.left;
	const maxLeft = viewport.width - panel.width - margin;
	const left = Math.round(maxLeft < margin ? margin : Math.min(Math.max(wanted, margin), maxLeft));
	const top = Math.round(side === 'bottom' ? Math.max(margin, below) : Math.max(margin, above));

	const centre = trigger.left + trigger.width / 2 - left;
	const arrow = Math.round(Math.min(Math.max(centre, 14), Math.max(14, panel.width - 14)));
	return { left, top, side, arrow };
}

/**
 * Move a node to the end of <body>. A panel inside the page can be clipped by
 * an ancestor's overflow or trapped under a sticky header's stacking context;
 * from the body it floats over everything.
 */
export function portal(node: HTMLElement) {
	document.body.appendChild(node);
	return {
		destroy() {
			node.remove();
		}
	};
}
