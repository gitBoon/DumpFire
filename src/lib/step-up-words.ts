/**
 * step-up-words.ts — the words of the password asked for again before the
 * actions that cannot be taken back (card 2701), which the server and the
 * browser both use. Plain constants and functions with no imports, so that a
 * module the browser loads can use them, as `decision-words.ts` is used: the
 * server's `step-up.ts` and `auth.ts` answer with them, and the pages know a
 * refusal of the password itself by them.
 *
 * A refusal of the password itself keeps the page's confirm dialog open, with
 * its words in it and the field cleared to type again (decision 13). Any
 * other refusal (the caller may not, the board is gone) is said as the page
 * said it before, and the dialog closes.
 *
 * A page knows a refusal of the password by its code, `App.Error.stepUp`,
 * which every refusal the step-up and auth.ts's check make carries (the code
 * review's F3, 2026-11-04): never by its words, which are for display alone
 * and may change.
 */

/**
 * What a refusal of the password was, as `App.Error.stepUp` carries it:
 * `missing` (no current password, or not text), `wrong`, `no-password` (an
 * account whose hash is no bcrypt hash), `in-flight` (a check of this
 * session's already under way), `busy` (the account's checks already in
 * flight are the most allowed), `signed-out` (the session ended at its third
 * wrong password, or had ended), `confirmation` (the import's confirmation
 * refused) and `changed` (the stored hash moved between the check and the
 * write).
 */
export type StepUpCode = NonNullable<App.Error['stepUp']>;

/** The body field the caller's current password is sent in. Not `password`, which two listed routes use for another. */
export const STEP_UP_FIELD = 'currentPassword';

/**
 * The body field the code from the caller's authenticator app, or one of the
 * caller's recovery codes, is sent in beside the password (card 2770, the MFA
 * plan's D6). Never `code`, which Google Drive's Connect sends for Google's
 * own code. Sent as typed: the server's rules read it.
 */
export const STEP_UP_CODE_FIELD = 'currentCode';

/**
 * What a dialog that asks hands its caller (card 2770, D1): the password and
 * the code typed, each sent under its own literal key, never spread into a
 * body (the page-failures scan reads the keys).
 */
export type StepUpProof = { currentPassword: string; currentCode: string };

/** The proof of a dialog that asked for nothing: both empty. */
export const NO_PROOF: Readonly<StepUpProof> = Object.freeze({ currentPassword: '', currentCode: '' });

/**
 * Whether a dialog that asks may send: a password typed and a code that is
 * not blank (card 2770, the plan review's S1). The one rule of every send
 * guard and button that sends a proof, so that Enter cannot get round one.
 */
export function proofTyped(currentPassword: string, currentCode: string): boolean {
	return currentPassword !== '' && currentCode.trim() !== '';
}

/** The answer to a listed request with no current password, an empty one, or one that is not text. */
export const STEP_UP_MISSING = 'Enter your password to confirm this. Nothing was changed.';

/** The answer to a wrong current password, on every listed route. */
export const STEP_UP_WRONG = 'Password is incorrect. Nothing was changed.';

/** The answer to an account whose stored hash is no bcrypt hash (decision 9): none exists today. */
export const STEP_UP_NO_PASSWORD =
	'This account has no password to confirm with, so this cannot be done from it. Nothing was changed.';

/** The answer to a check from a session that already has one under way (decision 5). */
export const STEP_UP_IN_FLIGHT =
	'Your password is already being checked for this session. Wait for that answer and try again. Nothing was changed.';

/**
 * The answer once a session has been ended by its third wrong current
 * password, or had ended some other way while its check was made: the same
 * words whichever, and whether the password was right or not (decision 6).
 * It comes with `signedOut: true`; the session's next request is 401, and the
 * page goes to sign in on it (`$lib/signed-out.ts`).
 */
export const STEP_UP_SIGNED_OUT =
	'Nothing was changed. This session has been signed out, after three wrong passwords or because it had ended: sign in again.';

/** The answer to an import whose confirmation is missing, unknown, used, expired, another session's or no longer good. */
export const CONFIRMATION_REFUSED =
	'Confirm the import with your password again: the confirmation was not found, was used or has expired. Nothing was changed.';

/**
 * The answer when the stored hash moved between the check of the password and
 * the write it guards (a password change or reset meanwhile): the proof no
 * longer holds, and it is not compared again (the code review's S2).
 */
export const PASSWORD_CHANGED_MEANWHILE =
	'Your password was changed while this was being saved. Nothing was changed. Try again.';

/** The header the import's confirmation is sent in. Hyphens: proxies that drop underscored headers keep it. */
export const CONFIRMATION_HEADER = 'x-dumpfire-confirmation';

/** What the pages say beside an action that asks. */
export const ASKS_FOR_PASSWORD = 'You will be asked for your password and a code from your authenticator app.';

/** What a dialog says when its Confirm got no answer at all (the code review's F9). */
export const NO_ANSWER_TRY_AGAIN = 'No answer from the server. Try again.';

/** The codes a refusal of the password may carry, and the words for one that came without any. */
const WORDS_OF: Readonly<Record<StepUpCode, string>> = {
	missing: STEP_UP_MISSING,
	wrong: STEP_UP_WRONG,
	'no-password': STEP_UP_NO_PASSWORD,
	'in-flight': STEP_UP_IN_FLIGHT,
	busy: 'The server is busy checking passwords. Wait a minute and try again. Nothing was changed.',
	'signed-out': STEP_UP_SIGNED_OUT,
	confirmation: CONFIRMATION_REFUSED,
	changed: PASSWORD_CHANGED_MEANWHILE
};

/** Whether `code` is one of the step-up's codes. */
const isStepUpCode = (code: unknown): code is StepUpCode => typeof code === 'string' && Object.hasOwn(WORDS_OF, code);

/**
 * The words of an answer that refused the password itself, or null for any
 * other answer, a success among them. Read from a copy, so that the caller
 * can read the answer too.
 *
 * Decided by the answer's code (`stepUp`), never by its words: an answer with
 * no code is no refusal of the password, whatever it says. The words given
 * back are the server's, for display; for the two codes that change what a
 * dialog does, `missing` (it shows the field) and `signed-out` (it takes the
 * field away, the page going to sign in), they are this module's own
 * `STEP_UP_MISSING` and `STEP_UP_SIGNED_OUT`, so that a dialog can tell them
 * by identity.
 */
export async function stepUpRefusal(res: Response): Promise<string | null> {
	if (res.ok) return null;
	try {
		const body: unknown = await res.clone().json();
		if (body === null || typeof body !== 'object') return null;
		const { message, stepUp } = body as { message?: unknown; stepUp?: unknown };
		if (!isStepUpCode(stepUp)) return null;
		if (stepUp === 'missing' || stepUp === 'signed-out') return WORDS_OF[stepUp];
		return typeof message === 'string' && message ? message : WORDS_OF[stepUp];
	} catch {
		// Not JSON: not DumpFire's refusal of a password.
		return null;
	}
}

/**
 * Whether an answer says the session is signed out by the step-up (its third
 * wrong password, or it had ended): read from a copy. The sign-out watch
 * (`$lib/signed-out.ts`) sends the page to sign in on it as on a 401 (the
 * code review's F5).
 */
export async function isStepUpSignOut(res: Response): Promise<boolean> {
	if (res.status !== 403) return false;
	try {
		const body: unknown = await res.clone().json();
		return body !== null && typeof body === 'object' && (body as { stepUp?: unknown }).stepUp === 'signed-out';
	} catch {
		return false;
	}
}

/**
 * A watch on a request that sends the password, for its refusal of the
 * password itself, where the request is sent through a helper that reads the
 * answer (`deleteFailure`, the board state's `write`):
 *
 *     const asked = refusalWatch();
 *     const failure = await deleteFailure(() => asked.watch(fetch(...)), 'board');
 *     const refusal = asked.refusal();
 *
 * `watch` hands the answer on untouched, for the helper to read as it did;
 * once it has come, `refusal()` gives that refusal's words, or null.
 */
export function refusalWatch(): { watch: (answer: Promise<Response>) => Promise<Response>; refusal: () => string | null } {
	let said: string | null = null;
	return {
		watch: async (answer) => {
			said = null;
			const res = await answer;
			said = await stepUpRefusal(res);
			return res;
		},
		refusal: () => said
	};
}
