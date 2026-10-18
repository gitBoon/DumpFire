/**
 * What `http.request` and `https.request` are replaced with in a test hands
 * back: enough of a request for webhooks.ts's `deliver`, which listens for
 * 'response' and 'error', and calls `end(body)` and `destroy`.
 *
 * Used by tests/setup.ts, whose refusal answers with an 'error', and by
 * `effects()`, whose recorder answers with a 200.
 */
import { EventEmitter } from 'node:events';

/** The arguments `http.request` was given, as the URL and the headers it would have sent. */
export function requestOf(args: unknown[]): { url: string; host: string; headers: Record<string, string> } {
	const [first, second] = args;
	const options = (typeof second === 'object' && second !== null ? second : typeof first === 'object' && !(first instanceof URL) ? first : {}) as {
		hostname?: string;
		host?: string;
		headers?: Record<string, unknown>;
	};
	const url = typeof first === 'string' || first instanceof URL ? String(first) : '';
	let host = options.hostname ?? options.host ?? '';
	if (url !== '') {
		try {
			host = new URL(url).hostname;
		} catch {
			// Not a URL: left to the request, which refuses it.
		}
	}
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(options.headers ?? {})) headers[name.toLowerCase()] = String(value);
	return { url, host: host.replace(/^\[(.*)\]$/, '$1'), headers };
}

/** A request that sends nothing. `onEnd` is called with the body when it is ended. */
export class StandInRequest extends EventEmitter {
	destroyed = false;
	private chunks: string[] = [];

	constructor(private onEnd: (body: string, request: StandInRequest) => void = () => {}) {
		super();
	}

	write(chunk: unknown): boolean {
		this.chunks.push(String(chunk));
		return true;
	}

	end(chunk?: unknown): this {
		if (chunk !== undefined && typeof chunk !== 'function') this.chunks.push(String(chunk));
		this.onEnd(this.chunks.join(''), this);
		return this;
	}

	destroy(err?: Error): this {
		if (this.destroyed) return this;
		this.destroyed = true;
		if (err) process.nextTick(() => this.emit('error', err));
		return this;
	}

	setTimeout(): this {
		return this;
	}

	setHeader(): this {
		return this;
	}

	/** Answer with this status on a later turn, as a server would. */
	answer(statusCode: number): void {
		process.nextTick(() => {
			if (this.destroyed) return;
			const response = Object.assign(new EventEmitter(), { statusCode, headers: {}, resume() {}, destroy() {} });
			this.emit('response', response);
		});
	}
}
