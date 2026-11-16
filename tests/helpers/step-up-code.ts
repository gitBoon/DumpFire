/**
 * The sign-in code a step-up dialog asks for beside the password (card 2770,
 * plan section 4.3, UX5): one code every mounted test types, where to find
 * the field it is typed in, and the proof a dialog hands its caller.
 *
 * Each file that mounts a dialog types `CODE` into `codeFieldIn(within)` with
 * its own `type`, as it types the password: the files' `type`s differ in how
 * they flush.
 */
import type { StepUpProof } from '$lib/step-up-words';

/** The code every mounted test types: the server reads none of it until card 2771. */
export const CODE = '123456';

/** The code field of the one `CurrentPasswordField` within `within`, or null where none is drawn. */
export function codeFieldIn(within: ParentNode): HTMLInputElement | null {
	return within.querySelector<HTMLInputElement>('input[id$="-current-code"]');
}

/** What a dialog hands its caller once `password` and `CODE` are typed. */
export function proofOf(password: string): StepUpProof {
	return { currentPassword: password, currentCode: CODE };
}
