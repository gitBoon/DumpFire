/**
 * The text of a PDF that `pdfkit` wrote, for a test that asks what a report
 * says (card 2150).
 *
 *     const text = pdfText(await res.arrayBuffer());
 *     expect(text).toContain('SHOWN-CARD');
 *     expect(text).not.toContain('HIDDEN-CARD');
 *
 * It reads `pdfkit`'s own output and nothing more: every stream inflated with
 * `zlib` (a stream that is not compressed is read as it is), and in each, the
 * text `pdfkit` shows, which it always writes as hex strings, with `Tj` or, when
 * a line is kerned, as an array with `TJ`. Each hex string is decoded as the
 * standard fonts' codes, which are Latin-1 for every ASCII character. One
 * showing is one line of the result, the pieces of a kerned one joined.
 *
 * It is not a PDF reader. A literal string `(...)`, a font of the document's
 * own and an object stream are not read, and `pdfkit` writes none of them for
 * a report. The document's information (its title and subject) is not in a
 * stream: a test that must find a name nowhere reads the bytes as Latin-1 too.
 */
import { inflateSync } from 'node:zlib';

/** A text showing: `[<..> 12 <..>] TJ` or `<..> Tj`. */
const SHOWN = /\[([^\]]*)\]\s*TJ|<([0-9a-fA-F]*)>\s*Tj/g;
const HEX = /<([0-9a-fA-F]*)>/g;

const decode = (hex: string) => Buffer.from(hex, 'hex').toString('latin1');

export function pdfText(bytes: Uint8Array | ArrayBuffer): string {
	const pdf = Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes);
	const raw = pdf.toString('latin1');
	const lines: string[] = [];

	let from = 0;
	for (;;) {
		const keyword = raw.indexOf('stream', from);
		if (keyword === -1) break;
		// "endstream" holds the word too: what follows it is no stream.
		if (raw.slice(keyword - 3, keyword) === 'end') {
			from = keyword + 'stream'.length;
			continue;
		}
		// The data starts after the end of the keyword's line (CRLF or LF).
		let start = keyword + 'stream'.length;
		if (raw[start] === '\r') start++;
		if (raw[start] === '\n') start++;
		const end = raw.indexOf('endstream', start);
		if (end === -1) break;
		from = end + 'endstream'.length;

		// The line end before "endstream" is not part of the data.
		let stop = end;
		if (raw[stop - 1] === '\n') stop--;
		if (raw[stop - 1] === '\r') stop--;
		const data = pdf.subarray(start, stop);
		let content: string;
		try {
			content = inflateSync(data).toString('latin1');
		} catch {
			content = data.toString('latin1');
		}

		for (const shown of content.matchAll(SHOWN)) {
			if (shown[1] !== undefined) {
				lines.push([...shown[1].matchAll(HEX)].map((piece) => decode(piece[1])).join(''));
			} else {
				lines.push(decode(shown[2]));
			}
		}
	}
	return lines.join('\n');
}
