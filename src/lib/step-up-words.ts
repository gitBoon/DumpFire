/**
 * step-up-words.ts — the words of the password asked for again before the
 * actions that cannot be taken back (card 2701), which the server and the
 * browser both use. Plain constants and functions with no imports, so that a
 * module the browser loads can use them, as `decision-words.ts` is used: the
 * server's `step-up.ts` and `auth.ts` answer with them, and the pages know a
 * refusal of the password itself by them.
 *
 * A refusal of the password or the code keeps the page's confirm dialog open,
 * with its words in it and the fields cleared to type again (decision 13),
 * the password kept for the refusals decided before it was compared
 * (`passwordKeptAfter`, card 2771). Any other refusal (the caller may not,
 * the board is gone) is said as the page said it before, and the dialog
 * closes.
 *
 * A page knows a refusal of the password by its code, `App.Error.stepUp`,
 * which every refusal the step-up and auth.ts's check make carries (the code
 * review's F3, 2026-11-04): never by its words, which are for display alone
 * and may change.
 */

/**
 * What a refusal of the password and code was, as `App.Error.stepUp` carries
 * it: `missing` (no current password or no code, or one not text), `wrong`
 * (the password or the code, never said which), `no-password` (an account
 * whose hash is no bcrypt hash), `in-flight` (a check of this session's
 * already under way), `busy` (the account's checks already in flight are the
 * most allowed), `signed-out` (the session ended at its third wrong answer,
 * or had ended), `confirmation` (the import's confirmation refused),
 * `changed` (the stored hash moved between the check and the write), and,
 * from card 2771, `code-malformed` (a code in neither form), `code-spent` (an
 * authenticator code whose step was already used), `no-factor` (an account
 * with no second factor) and `factor-unusable` (an authenticator that cannot
 * be opened on this server).
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
 *
 * `codeAsked` is the layout's (card 3064, R7): false only for an account that
 * holds no second factor while two-step sign-in is dormant, which the server
 * asks for the password alone (R6); then the code may be blank. Anything but
 * `false`, a page with no data among them, asks for the code: the server's
 * rule is the guard, and the page only follows it.
 */
export function proofTyped(currentPassword: string, currentCode: string, codeAsked: boolean = true): boolean {
	return currentPassword !== '' && (codeAsked === false || currentCode.trim() !== '');
}

/**
 * What a confirmation asks for, said inside a sentence (card 3064, F25): "your
 * password and a code" where `codeAsked`, and "your password" alone where it
 * is false, by the one rule `proofTyped` follows (the layout's `codeAsked` on a
 * page; the step-up's own rule, `codeAskedOf`, on the server). Anything but
 * `false` is the code asked, as there.
 */
export function yourProof(codeAsked: boolean = true): string {
	return codeAsked === false ? 'your password' : 'your password and a code';
}

/** `yourProof`, the code named in full: "your password and a code from your authenticator app", or "your password" alone. */
export function yourProofInFull(codeAsked: boolean = true): string {
	return codeAsked === false ? 'your password' : 'your password and a code from your authenticator app';
}

/** The answer to a listed request with no current password or no code, an empty one, or one that is not text. */
export const STEP_UP_MISSING = 'Enter your password and a code from your authenticator app to confirm this. Nothing was changed.';

/**
 * The answer to a listed request with no current password where no code is
 * asked (card 3064, F25): an account with no factor while two-step sign-in is
 * dormant (R6).
 */
export const STEP_UP_MISSING_PASSWORD = 'Enter your password to confirm this. Nothing was changed.';

/** The answer to no current password (or no code), by whether a code is asked (card 3064, F25): `STEP_UP_MISSING` or `STEP_UP_MISSING_PASSWORD`. */
export function stepUpMissing(codeAsked: boolean = true): string {
	return codeAsked === false ? STEP_UP_MISSING_PASSWORD : STEP_UP_MISSING;
}

/** Whether `refusal` is either answer to no current password (card 3064, F25), which a dialog that showed no field meets by showing it. */
export function isStepUpMissing(refusal: string | null): boolean {
	return refusal === STEP_UP_MISSING || refusal === STEP_UP_MISSING_PASSWORD;
}

/**
 * The answer to a wrong current password or a wrong code, on every listed
 * route: the same words whichever was wrong (card 2771, D4).
 */
export const STEP_UP_WRONG = 'Your password or code was not right. Nothing was changed.';

/** The answer to a wrong current password where no code was asked (card 3064, F25): the password was the only thing sent. */
export const STEP_UP_WRONG_PASSWORD = 'Your password was not right. Nothing was changed.';

/** The answer to a wrong answer, by whether a code was asked (card 3064, F25): `STEP_UP_WRONG` or `STEP_UP_WRONG_PASSWORD`. */
export function stepUpWrong(codeAsked: boolean = true): string {
	return codeAsked === false ? STEP_UP_WRONG_PASSWORD : STEP_UP_WRONG;
}

/**
 * The answer to a code in neither form: six digits from the authenticator
 * app, spaces aside, or a recovery code (card 2771, D2). Decided before
 * anything is counted.
 */
export const STEP_UP_CODE_MALFORMED =
	"That code is not in the right form. Enter the 6 digits from your authenticator app, or choose 'Use a recovery code instead'. Nothing was changed.";

/**
 * The answer to an authenticator code whose step was already used (card 2771,
 * D3): decided before the password is compared, whatever it is, so that it
 * says nothing of the password.
 */
export const STEP_UP_CODE_SPENT =
	'That code has just been used. Wait for the next code from your authenticator app and enter it. Nothing was changed.';

/** The answer to an account that holds no second factor (card 2771, D3): none exists since card 2769. */
export const STEP_UP_NO_FACTOR =
	'This account has no two-step sign-in to confirm with, so this cannot be done from it. Nothing was changed.';

/**
 * The answer to an authenticator code when the account's factor cannot be
 * opened on this server (no MFA key, another key): a recovery code still works
 * (card 2771, D3).
 */
export const STEP_UP_FACTOR_UNUSABLE =
	'Your authenticator cannot be checked on this server right now. Use one of your recovery codes, or ask an administrator. Nothing was changed.';

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
	'Nothing was changed. This session has been signed out, after three wrong passwords or codes, or because it had ended: sign in again.';

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

/** What the pages say beside an action that asks, where a code is asked. */
export const ASKS_FOR_PASSWORD = 'You will be asked for your password and a code from your authenticator app.';

/** What the pages say beside an action that asks, where no code is asked (card 3064, F25). */
export const ASKS_FOR_PASSWORD_ALONE = 'You will be asked for your password.';

/**
 * What the pages say beside an action that asks, by the layout's `codeAsked`
 * (card 3064, F25): `ASKS_FOR_PASSWORD`, or `ASKS_FOR_PASSWORD_ALONE` for an
 * account with no factor while two-step sign-in is dormant. Anything but
 * `false` is the code asked.
 */
export function asksForPassword(codeAsked: boolean = true): string {
	return codeAsked === false ? ASKS_FOR_PASSWORD_ALONE : ASKS_FOR_PASSWORD;
}

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
	changed: PASSWORD_CHANGED_MEANWHILE,
	'code-malformed': STEP_UP_CODE_MALFORMED,
	'code-spent': STEP_UP_CODE_SPENT,
	'no-factor': STEP_UP_NO_FACTOR,
	'factor-unusable': STEP_UP_FACTOR_UNUSABLE
};

/**
 * The refusals decided before the password is compared that keep it typed
 * (card 2771, D9, E9): the code was in neither form, its step already used,
 * or the authenticator could not be checked. Only the code is to be typed
 * again.
 */
const KEEPS_THE_PASSWORD: readonly string[] = [STEP_UP_CODE_SPENT, STEP_UP_CODE_MALFORMED, STEP_UP_FACTOR_UNUSABLE];

/**
 * What a dialog's password field holds after a refusal (card 2771, D9):
 * `sent`, the password it had sent, for the three refusals decided before
 * the password was compared, and `''` for any other, so that a password
 * shown wrong, or perhaps wrong, is typed again. `refusal` is what
 * `stepUpRefusal` gave, or null; known by identity, as those three are given
 * as this module's own words. The code is always cleared.
 */
export function passwordKeptAfter(refusal: string | null, sent: string): string {
	return refusal !== null && KEEPS_THE_PASSWORD.includes(refusal) ? sent : '';
}

/** The codes `stepUpRefusal` answers with this module's own words, for a dialog to tell by identity. */
const BY_IDENTITY: readonly StepUpCode[] = ['missing', 'signed-out', 'code-spent', 'code-malformed', 'factor-unusable'];

/** Whether `code` is one of the step-up's codes. */
const isStepUpCode = (code: unknown): code is StepUpCode => typeof code === 'string' && Object.hasOwn(WORDS_OF, code);

/**
 * The words of an answer that refused the password itself, or null for any
 * other answer, a success among them. Read from a copy, so that the caller
 * can read the answer too.
 *
 * Decided by the answer's code (`stepUp`), never by its words: an answer with
 * no code is no refusal of the password, whatever it says. The words given
 * back are the server's, for display; for the codes that change what a
 * dialog does, `missing` (it shows the field; `STEP_UP_MISSING_PASSWORD`
 * where the server said that, else `STEP_UP_MISSING`), `signed-out` (it takes the
 * field away, the page going to sign in), and `code-spent`, `code-malformed`
 * and `factor-unusable` (it keeps the password, card 2771), they are this
 * module's own words, so that a dialog can tell them by identity.
 */
export async function stepUpRefusal(res: Response): Promise<string | null> {
	if (res.ok) return null;
	try {
		const body: unknown = await res.clone().json();
		if (body === null || typeof body !== 'object') return null;
		const { message, stepUp } = body as { message?: unknown; stepUp?: unknown };
		if (!isStepUpCode(stepUp)) return null;
		// No password where no code is asked has words of its own (card 3064, F25), the server's by its rule.
		if (stepUp === 'missing' && message === STEP_UP_MISSING_PASSWORD) return STEP_UP_MISSING_PASSWORD;
		if (BY_IDENTITY.includes(stepUp)) return WORDS_OF[stepUp];
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
