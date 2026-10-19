/**
 * Record everything a request tells the outside world, and send none of it.
 *
 *     const sent = effects();
 *     await api('PUT', '/api/cards/reorder', { user, body });
 *     sent.webhooks;            // the deliveries it would have made
 *     sent.events;              // the live events pages would have received
 *     sent.emails;              // the mail it would have sent
 *     sent.duringTransaction;   // must be empty: see below
 *     sent.restore();
 *
 * Three things are replaced while it is installed:
 *
 *   - `http.request` and `https.request`, which is how a webhook is delivered
 *     (card 2161). A request that carries `X-DumpFire-Event` is recorded when
 *     it is ended and answered 200; any other is handed to the `request` this
 *     replaced, the refusal in tests/setup.ts, so a backup upload or a stray
 *     request is not passed off as a webhook. `fetch` is not replaced: nothing
 *     on the server calls it, and the setup's refusal fails a test that does.
 *   - nodemailer's `createTransport`, which every mail goes through. The
 *     transport it hands back records the message and reports it sent. Mail is
 *     only attempted when SMTP is configured: see `makeSmtp` in the fixtures.
 *   - nothing, for live events: a listener is subscribed to every board, as the
 *     All Tasks page does.
 *
 * Each record notes whether a transaction was open on the connection at the
 * moment the effect started. An effect must never start inside one: if the
 * transaction then rolled back, something that did not happen would have been
 * announced. `duringTransaction` lists the ones that did.
 *
 * A mail server that refuses some addresses, for a test of what is said when
 * mail does not go (card 2113):
 *
 *     const sent = effects({ refuseMailTo: ['b@example.test'] });
 *
 * The transport then throws for a mail to one of those addresses, as one
 * does when the server refuses it. The mail is not in `emails` or `all`:
 * it is in `refusedMail`. A refused mail is still an effect that started,
 * so one started inside a transaction is in `duringTransaction` too.
 *
 * A refusal of its own, for a test of what is said and logged of it (card
 * 2196):
 *
 *     const sent = effects({ mailRefusal: (mail) => refused('EAUTH', `535 ${linkIn(mail.html)}`) });
 *
 * `mailRefusal` is asked about every mail, as the transport is handed it,
 * and the error it returns is what the transport throws; `undefined` lets the
 * mail through. It is called after the commit, inside the send, so it can
 * quote the mail's own link, and can change the database while the mail is
 * out, as another request would. A mail it refuses is in `refusedMail`, as
 * one in `refuseMailTo` is.
 */
import http from 'node:http';
import https from 'node:https';
import nodemailer from 'nodemailer';
import { vi } from 'vitest';
import { sqlite } from '$lib/server/db';
import { subscribeGlobal } from '$lib/server/events';
import { requestOf, StandInRequest } from './stand-in-request';

export type RecordedEffect =
	| {
			kind: 'webhook';
			url: string;
			/** The `X-DumpFire-Event` header, e.g. `card.completed`. */
			event: string;
			headers: Record<string, string>;
			/** The JSON body, parsed: `{ event, timestamp, boardId, data }`. */
			body: any;
			inTransaction: boolean;
	  }
	| {
			kind: 'event';
			boardId: number;
			/** `update`, `celebrate`, `xp-update`, ... */
			event: string;
			data: any;
			inTransaction: boolean;
	  }
	| {
			kind: 'email';
			to: string;
			subject: string;
			html: string;
			/** File names of what was attached. */
			attachments: string[];
			/**
			 * What was attached, name and bytes, in the order of `attachments`:
			 * a report's PDF is read from here with `pdfText` (tests/helpers/pdf.ts).
			 */
			files: { filename: string; content: Buffer }[];
			inTransaction: boolean;
	  };

type Of<K extends RecordedEffect['kind']> = Extract<RecordedEffect, { kind: K }>;

export type Effects = {
	/** Everything recorded, in the order it started. */
	readonly all: RecordedEffect[];
	readonly webhooks: Of<'webhook'>[];
	readonly events: Of<'event'>[];
	readonly emails: Of<'email'>[];
	/** The ones that started while a transaction was open, refused mail included. Should be empty. */
	readonly duringTransaction: RecordedEffect[];
	/** The mail the transport refused, with `refuseMailTo` or `mailRefusal`, in the order it was tried. */
	readonly refusedMail: Of<'email'>[];
	/**
	 * Let effects that start on a later turn of the event loop start. A mail
	 * that needs a PDF built first takes longer than this waits: use
	 * `vi.waitFor` for that one.
	 */
	settle(): Promise<void>;
	/** Forget what has been recorded so far. */
	clear(): void;
	/** Put `http.request`, `https.request` and nodemailer back and stop listening. Call it in `afterEach`. */
	restore(): void;
};

let installed = false;

/** The text the recorded transport throws for an address in `refuseMailTo`. */
export const REFUSED_MAIL = '550 Mailbox unavailable (refused by the recorded transport)';

/** What `mailRefusal` is shown of a mail. */
export type OfferedMail = { to: string; subject: string; html: string };

export function effects(
	options: { refuseMailTo?: string[]; mailRefusal?: (mail: OfferedMail) => Error | undefined } = {}
): Effects {
	if (installed) throw new Error('effects() is already installed: call restore() on the last one first');
	installed = true;

	const all: RecordedEffect[] = [];
	const refusedMail: Of<'email'>[] = [];
	/** Every effect that started, refused mail among them, in the order it started. */
	const started: RecordedEffect[] = [];
	const refuse = new Set(options.refuseMailTo ?? []);
	const record = (effect: RecordedEffect) => {
		all.push(effect);
		started.push(effect);
	};

	type Requests = { request: (...args: unknown[]) => unknown };
	const modules = [http, https] as unknown as Requests[];
	const replaced = modules.map((module) => module.request);
	modules.forEach((module, i) => {
		module.request = (...args: unknown[]) => {
			const { url, headers } = requestOf(args);
			if (headers['x-dumpfire-event'] === undefined) return replaced[i](...args);
			const request = new StandInRequest((sent, self) => {
				let body: unknown = sent;
				try {
					body = JSON.parse(sent);
				} catch {
					// Not JSON: kept as it was sent.
				}
				record({
					kind: 'webhook',
					url,
					event: headers['x-dumpfire-event'],
					headers,
					body,
					inTransaction: sqlite.inTransaction
				});
				self.answer(200);
			});
			const respond = args.at(-1);
			if (typeof respond === 'function') request.once('response', respond as (...a: unknown[]) => void);
			return request;
		};
	});

	const transport = vi.spyOn(nodemailer, 'createTransport').mockImplementation((() => ({
		sendMail: async (mail: {
			to?: unknown;
			subject?: unknown;
			html?: unknown;
			attachments?: { filename?: string; content?: unknown }[];
		}) => {
			const recorded: Of<'email'> = {
				kind: 'email',
				to: String(mail.to ?? ''),
				subject: String(mail.subject ?? ''),
				html: String(mail.html ?? ''),
				attachments: (mail.attachments ?? []).map((a) => a.filename ?? ''),
				files: (mail.attachments ?? []).map((a) => ({
					filename: a.filename ?? '',
					// Copied, so that what the test reads is what was handed over.
					content: Buffer.from(
						typeof a.content === 'string' ? Buffer.from(a.content) : a.content instanceof Uint8Array ? a.content : []
					)
				})),
				inTransaction: sqlite.inTransaction
			};
			const refusal = options.mailRefusal?.({ to: recorded.to, subject: recorded.subject, html: recorded.html });
			if (refusal || refuse.has(recorded.to)) {
				refusedMail.push(recorded);
				started.push(recorded);
				throw refusal ?? new Error(REFUSED_MAIL);
			}
			record(recorded);
			return { messageId: `<recorded-${all.length}@example.test>` };
		}
	})) as unknown as typeof nodemailer.createTransport);

	const unsubscribe = subscribeGlobal((event, data) => {
		const { boardId, ...rest } = (data ?? {}) as { boardId: number };
		record({ kind: 'event', boardId, event, data: rest, inTransaction: sqlite.inTransaction });
	});

	const of = <K extends RecordedEffect['kind']>(kind: K) => all.filter((e): e is Of<K> => e.kind === kind);

	return {
		all,
		get webhooks() {
			return of('webhook');
		},
		get events() {
			return of('event');
		},
		get emails() {
			return of('email');
		},
		get duringTransaction() {
			return started.filter((e) => e.inTransaction);
		},
		refusedMail,
		async settle() {
			for (let turn = 0; turn < 3; turn++) await new Promise((resolve) => setImmediate(resolve));
		},
		clear() {
			all.length = 0;
			refusedMail.length = 0;
			started.length = 0;
		},
		restore() {
			modules.forEach((module, i) => (module.request = replaced[i]));
			transport.mockRestore();
			unsubscribe();
			installed = false;
		}
	};
}
