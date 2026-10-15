/**
 * report-recipients.ts — the one reading of who a mailed report goes to
 * (card 2182).
 *
 * The emailed report, both schedule routes, the scheduler and the reports page
 * all read a list of recipients through `reportRecipients`, so the number the
 * server holds a list to is the number the page shows and the number of mails
 * sent. It imports nothing from the server, so the page can use it.
 *
 * Why the separators are commas, semicolons and white space: the mailer
 * (nodemailer's address parser) reads `a@x.test;b@x.test` as two addresses in
 * one mail, each in view of the other, and `a@x.test` on one line with
 * `b@x.test` on the next as one address, `a@x.test`, with the second as its
 * display name, which is never mailed. Split here on every one of them, each
 * address is handed to the mailer on its own and is exactly one recipient.
 *
 * Why an address is held to more than an `@`: the mailer also reads a part
 * such as `a@b.c<x>` as a mail to `x`, and `abc<def>@x.com` as one to `def`,
 * so the page would show and count one address and the mail would go to
 * another. A part may be written `<address>`, and the address inside is what
 * is counted, shown, de-duplicated and sent: so `Alice Smith <alice@x.test>`
 * is the address `alice@x.test` and two parts that are not addresses.
 */

/** The most addresses one emailed report, or one schedule, may be sent to. */
export const MAX_REPORT_RECIPIENTS = 10;

/** Commas, semicolons and white space (spaces, tabs, new lines): each separates two parts. */
const SEPARATORS = /[,;\s]+/;

/**
 * No white space, and none of `@ < > ( ) [ ] \ , ; : "` on either side of the
 * one `@`; a dot after it. And no control or format character (`\p{C}`): a
 * right-to-left override (U+202E) turns the text after it round on the page,
 * so the address shown would not be the one mailed (the review's N6).
 */
const ADDRESS = /^[^\s@<>()[\]\\,;:"\p{C}]+@[^\s@<>()[\]\\,;:"\p{C}]+\.[^\s@<>()[\]\\,;:"\p{C}]+$/u;

/** The longest address there can be, as `readEmail` on the server holds one. */
const LONGEST = 254;

export type ReportRecipients = {
	/** Each address once, lower-cased, in the order first written: what is sent. */
	addresses: string[];
	/** Each part that is not an address once, lower-cased: never sent. */
	notAddresses: string[];
};

/**
 * A list of recipients as the email route takes it (a list of texts) or as a
 * schedule keeps it (one text): each text split on commas, semicolons and
 * white space, each part trimmed and lower-cased, empty parts and repeats
 * dropped, and the rest told apart into addresses and parts that are not.
 */
export function reportRecipients(input: string | readonly string[] | null | undefined): ReportRecipients {
	const texts: readonly unknown[] = Array.isArray(input) ? input : [input ?? ''];
	// Sets, so a list as long as a body can hold is told apart in one pass.
	const addresses = new Set<string>();
	const notAddresses = new Set<string>();
	for (const text of texts) {
		if (typeof text !== 'string') continue;
		for (const raw of text.split(SEPARATORS)) {
			const part = raw.trim().toLowerCase();
			if (part === '') continue;
			// One enclosing `<` … `>` is taken off; anything else round it is not an address.
			const inner = part.startsWith('<') && part.endsWith('>') ? part.slice(1, -1) : part;
			if (inner.length <= LONGEST && ADDRESS.test(inner)) addresses.add(inner);
			else notAddresses.add(part);
		}
	}
	return { addresses: [...addresses], notAddresses: [...notAddresses] };
}
