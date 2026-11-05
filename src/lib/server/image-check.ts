/**
 * image-check.ts — whether some bytes are a PNG, JPEG, GIF or WebP image, and
 * those bytes with their metadata taken out (card 2754).
 *
 * A key's upload names its type and its file name, and both are the caller's:
 * only the bytes are evidence. So the bytes are walked, structure by
 * structure, to the end of the format, and what is kept is kept by
 * allow-list (S4 of the plan review): a structure this module does not know
 * is dropped where the format marks it as safe to drop, and refused where it
 * does not. What is dropped is what carries metadata: text chunks, EXIF, XMP,
 * IPTC, comments, thumbnails and the like. Nothing is decoded or re-encoded:
 * the pixel data is copied as it came.
 *
 * Refused, whatever else the file holds:
 * - bytes after the end of the image (after `IEND`, `EOI`, the GIF trailer or
 *   the RIFF size), which is how a second file rides along inside an image;
 * - animation: an APNG, a GIF of more than one image, an animated WebP;
 * - more than `MAX_SIDE` pixels on a side or `MAX_PIXELS` in all, which no
 *   screenshot needs and a decompression bomb does.
 *
 * Every length read is checked against the bytes left before it is used, so
 * a short or lying file is refused and never read past its end. The pieces
 * kept are views of the bytes given, joined once at the end.
 *
 * No imports and nothing at load: `uploads.ts`, which the logger imports,
 * asks `sniffImage` when it serves a file.
 */

/** The four types an image may be. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

/** The most pixels on either side. */
export const MAX_SIDE = 8000;
/** The most pixels in all: 40 megapixels. */
export const MAX_PIXELS = 40_000_000;

const EXTENSION: Record<ImageType, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/gif': 'gif',
	'image/webp': 'webp'
};
const NAME: Record<ImageType, string> = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/gif': 'GIF', 'image/webp': 'WebP' };

export type CheckedImage = {
	ok: true;
	/** The image with its metadata taken out. */
	bytes: Uint8Array;
	mimeType: ImageType;
	extension: string;
	width: number;
	height: number;
};
export type RefusedImage = { ok: false; status: 400 | 415; message: string };

/** One of the four types, from a `Content-Type` as it was sent, or `null`. Parameters and case are ignored. */
export function imageTypeOf(declared: string | null | undefined): ImageType | null {
	const type = String(declared ?? '').split(';')[0].trim().toLowerCase();
	return (IMAGE_TYPES as readonly string[]).includes(type) ? (type as ImageType) : null;
}

function startsWith(bytes: Uint8Array, at: number, expected: readonly number[] | string): boolean {
	const want = typeof expected === 'string' ? [...expected].map((c) => c.charCodeAt(0)) : expected;
	if (at + want.length > bytes.length) return false;
	return want.every((byte, i) => bytes[at + i] === byte);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The type the bytes' magic names, or `null`. It says what the file claims to be, not that it is one. */
export function sniffImage(bytes: Uint8Array): ImageType | null {
	if (startsWith(bytes, 0, PNG_SIGNATURE)) return 'image/png';
	if (startsWith(bytes, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
	if (startsWith(bytes, 0, 'GIF87a') || startsWith(bytes, 0, 'GIF89a')) return 'image/gif';
	if (startsWith(bytes, 0, 'RIFF') && startsWith(bytes, 8, 'WEBP')) return 'image/webp';
	return null;
}

// ─── Reading ────────────────────────────────────────────────────────────────

/** Why a walk stopped: the file is not a valid image of its type. Never leaves this module. */
class Invalid extends Error {}

function invalid(message: string): never {
	throw new Invalid(message);
}

/** Refuse unless `n` bytes from `at` are there. */
function need(bytes: Uint8Array, at: number, n: number): void {
	if (at < 0 || n < 0 || at + n > bytes.length) invalid('it ends early');
}

function u16be(b: Uint8Array, at: number): number {
	need(b, at, 2);
	return b[at] * 0x100 + b[at + 1];
}
function u32be(b: Uint8Array, at: number): number {
	need(b, at, 4);
	return b[at] * 0x1000000 + b[at + 1] * 0x10000 + b[at + 2] * 0x100 + b[at + 3];
}
function u16le(b: Uint8Array, at: number): number {
	need(b, at, 2);
	return b[at] + b[at + 1] * 0x100;
}
function u24le(b: Uint8Array, at: number): number {
	need(b, at, 3);
	return b[at] + b[at + 1] * 0x100 + b[at + 2] * 0x10000;
}
function u32le(b: Uint8Array, at: number): number {
	need(b, at, 4);
	return b[at] + b[at + 1] * 0x100 + b[at + 2] * 0x10000 + b[at + 3] * 0x1000000;
}
function ascii(b: Uint8Array, at: number, n: number): string {
	need(b, at, n);
	return String.fromCharCode(...b.subarray(at, at + n));
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
	let length = 0;
	for (const part of parts) length += part.length;
	const out = new Uint8Array(length);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

type Walked = { bytes: Uint8Array; width: number; height: number };

// ─── PNG ────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** Ancillary chunks kept: transparency and colour, and the pixel size. Every other ancillary chunk is dropped. */
const PNG_KEEP: ReadonlySet<string> = new Set(['tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'cICP', 'sBIT', 'pHYs']);
/** The APNG chunks: an animated PNG is refused. */
const PNG_ANIMATION: ReadonlySet<string> = new Set(['acTL', 'fcTL', 'fdAT']);
/** The bit depths each colour type allows. */
const PNG_DEPTHS: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

function walkPng(b: Uint8Array): Walked {
	const parts: Uint8Array[] = [b.subarray(0, 8)];
	let at = 8;
	let width = 0;
	let height = 0;
	let colourType = -1;
	let palette = false;
	/** No `IDAT` yet, in a run of them, or past the run. */
	let data: 'none' | 'in' | 'after' = 'none';

	for (;;) {
		const length = u32be(b, at);
		if (length > 0x7fffffff) invalid('a chunk is longer than a PNG allows');
		const type = ascii(b, at + 4, 4);
		if (!/^[A-Za-z]{4}$/.test(type)) invalid('a chunk has a name that is not four letters');
		const end = at + 12 + length;
		if (end > b.length) invalid('a chunk runs past the end');
		if (crc32(b.subarray(at + 4, at + 8 + length)) !== u32be(b, at + 8 + length)) invalid(`the ${type} chunk's checksum is wrong`);
		const chunk = b.subarray(at, end);
		const body = b.subarray(at + 8, at + 8 + length);

		if (colourType < 0 && type !== 'IHDR') invalid('it does not start with IHDR');
		if (data === 'in' && type !== 'IDAT') data = 'after';

		if (type === 'IHDR') {
			if (colourType >= 0) invalid('it has a second IHDR');
			if (length !== 13) invalid('its IHDR is the wrong length');
			width = u32be(body, 0);
			height = u32be(body, 4);
			const depth = body[8];
			colourType = body[9];
			if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) invalid('its size is not one a PNG allows');
			if (!PNG_DEPTHS[colourType]?.includes(depth)) invalid('its colour type and bit depth do not go together');
			if (body[10] !== 0 || body[11] !== 0 || body[12] > 1) invalid('its IHDR names a method PNG does not have');
			parts.push(chunk);
		} else if (type === 'PLTE') {
			if (palette || data !== 'none') invalid('its palette is out of place');
			if (colourType === 0 || colourType === 4) invalid('a grey image has a palette');
			if (length === 0 || length % 3 !== 0 || length > 768) invalid('its palette is the wrong length');
			palette = true;
			parts.push(chunk);
		} else if (type === 'IDAT') {
			if (data === 'after') invalid('its IDAT chunks are not together');
			if (colourType === 3 && !palette) invalid('a palette image has no palette');
			data = 'in';
			parts.push(chunk);
		} else if (type === 'IEND') {
			if (length !== 0) invalid('its IEND is not empty');
			if (data === 'none') invalid('it has no image data');
			parts.push(chunk);
			at = end;
			break;
		} else if (PNG_ANIMATION.has(type)) {
			invalid('it is an animated PNG');
		} else if (type.charCodeAt(0) < 0x61) {
			// An upper-case first letter: a critical chunk, which a reader may not skip.
			invalid(`it has a critical chunk, ${type}, that is not accepted`);
		} else if (PNG_KEEP.has(type)) {
			parts.push(chunk);
		}
		// Any other ancillary chunk is dropped.
		at = end;
	}

	if (at !== b.length) invalid('there are bytes after IEND');
	return { bytes: concat(parts), width, height };
}

// ─── JPEG ───────────────────────────────────────────────────────────────────

/** The frames accepted: baseline, extended sequential and progressive, all Huffman-coded. */
const JPEG_FRAMES: ReadonlySet<number> = new Set([0xc0, 0xc1, 0xc2]);
/** Huffman and quantisation tables, kept as they are. */
const JPEG_TABLES: ReadonlySet<number> = new Set([0xc4, 0xdb]);

function walkJpeg(b: Uint8Array): Walked {
	const parts: Uint8Array[] = [b.subarray(0, 2)];
	let at = 2;
	let frame: { width: number; height: number } | null = null;
	let scans = 0;

	for (;;) {
		if (at >= b.length) invalid('it ends before EOI');
		if (b[at] !== 0xff) invalid('a byte between segments is not a marker');
		// Fill bytes: any number of 0xFF before the marker's code.
		while (at < b.length && b[at] === 0xff) at++;
		if (at >= b.length) invalid('it ends before EOI');
		const marker = b[at];
		const markerAt = at - 1;
		at++;

		if (marker === 0xd9) {
			if (!frame || scans === 0) invalid('it has no image data');
			parts.push(b.subarray(markerAt, at));
			break;
		}
		if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
			invalid('it has a marker out of place');
		}

		const length = u16be(b, at);
		if (length < 2) invalid('a segment is shorter than its own length');
		const end = at + length;
		if (end > b.length) invalid('a segment runs past the end');
		const segment = b.subarray(markerAt, end);
		const body = b.subarray(at + 2, end);
		at = end;

		if (JPEG_FRAMES.has(marker)) {
			if (frame) invalid('it has more than one frame');
			need(body, 0, 6);
			const precision = body[0];
			const height = u16be(body, 1);
			const width = u16be(body, 3);
			const components = body[5];
			if (precision !== 8 && !(precision === 12 && marker !== 0xc0)) invalid('its frame has a precision JPEG does not allow');
			if (height === 0) invalid('its frame has no height');
			if (width === 0) invalid('its frame has no width');
			if (components < 1 || components > 4 || body.length !== 6 + 3 * components) invalid('its frame is the wrong length');
			frame = { width, height };
			parts.push(segment);
		} else if (marker === 0xda) {
			if (!frame) invalid('a scan comes before the frame');
			const components = body.length > 0 ? body[0] : 0;
			if (components < 1 || components > 4 || body.length !== 4 + 2 * components) invalid('a scan header is the wrong length');
			parts.push(segment);
			scans++;
			// The entropy-coded data, to the next marker: a 0xFF in it is followed
			// by 0x00 (a stuffed byte), a restart marker, or more fill.
			const start = at;
			for (;;) {
				if (at >= b.length) invalid('it ends inside a scan');
				if (b[at] !== 0xff) {
					at++;
					continue;
				}
				if (at + 1 >= b.length) invalid('it ends inside a scan');
				const next = b[at + 1];
				if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) at += 2;
				else if (next === 0xff) at++;
				else break;
			}
			parts.push(b.subarray(start, at));
		} else if (JPEG_TABLES.has(marker)) {
			parts.push(segment);
		} else if (marker === 0xdd) {
			// Restart interval: kept, so only at its exact length, two bytes, or
			// anything after them would ride along.
			if (body.length !== 2) invalid('its restart interval is the wrong length');
			parts.push(segment);
		} else if (marker === 0xe0) {
			// JFIF only, written again without its thumbnail. JFXX, which holds
			// nothing but a thumbnail, is dropped with every other APP0.
			if (startsWith(body, 0, 'JFIF\0') && body.length >= 14) {
				const jfif = new Uint8Array(18);
				jfif.set([0xff, 0xe0, 0x00, 0x10]);
				jfif.set(body.subarray(0, 12), 4);
				parts.push(jfif);
			}
		} else if (marker === 0xe2) {
			if (startsWith(body, 0, 'ICC_PROFILE\0')) parts.push(segment);
		} else if (marker === 0xee) {
			// Adobe's colour transform: a four-component JPEG reads wrongly without it.
			// Kept, so only at its exact length: "Adobe", version, two flag words
			// and the transform, twelve bytes.
			if (startsWith(body, 0, 'Adobe')) {
				if (body.length !== 12) invalid('its Adobe segment is the wrong length');
				parts.push(segment);
			}
		} else if ((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe) {
			// EXIF, XMP, IPTC and every other application segment, and comments: dropped.
		} else {
			invalid(`it has a marker, 0xFF${marker.toString(16).toUpperCase()}, that is not accepted`);
		}
	}

	if (at !== b.length) invalid('there are bytes after EOI');
	if (!frame) invalid('it has no frame');
	return { bytes: concat(parts), width: frame.width, height: frame.height };
}

// ─── GIF ────────────────────────────────────────────────────────────────────

/** The index just past a run of sub-blocks starting at `at`, its terminator included. */
function pastSubBlocks(b: Uint8Array, at: number): number {
	for (;;) {
		if (at >= b.length) invalid('it ends inside a block');
		const size = b[at];
		at += 1 + size;
		if (size === 0) return at;
	}
}

function colourTableSize(packed: number): number {
	return packed & 0x80 ? 3 * (1 << ((packed & 0x07) + 1)) : 0;
}

function walkGif(b: Uint8Array): Walked {
	const width = u16le(b, 6);
	const height = u16le(b, 8);
	need(b, 10, 3);
	if (width === 0 || height === 0) invalid('its screen has no size');
	let at = 13 + colourTableSize(b[10]);
	need(b, 0, at);
	const parts: Uint8Array[] = [b.subarray(0, at)];
	let images = 0;

	for (;;) {
		if (at >= b.length) invalid('it ends before its trailer');
		const block = b[at];
		if (block === 0x3b) {
			parts.push(b.subarray(at, at + 1));
			at++;
			break;
		}
		if (block === 0x2c) {
			if (images > 0) invalid('it has more than one image: an animated GIF');
			const left = u16le(b, at + 1);
			const top = u16le(b, at + 3);
			const w = u16le(b, at + 5);
			const h = u16le(b, at + 7);
			need(b, at + 9, 1);
			if (w === 0 || h === 0 || left + w > width || top + h > height) invalid('its image is not inside its screen');
			let end = at + 10 + colourTableSize(b[at + 9]);
			need(b, end, 1);
			const codeSize = b[end];
			if (codeSize < 2 || codeSize > 8) invalid('its image has a code size GIF does not allow');
			end = pastSubBlocks(b, end + 1);
			parts.push(b.subarray(at, end));
			images++;
			at = end;
			continue;
		}
		if (block === 0x21) {
			need(b, at + 1, 1);
			const label = b[at + 1];
			const end = pastSubBlocks(b, at + 2);
			if (label === 0xf9) {
				// Graphic control: transparency. Kept, so only in its exact shape: one
				// sub-block of four bytes, then the terminator, eight bytes in all.
				if (b[at + 2] !== 4 || end !== at + 8) invalid('its graphic control block is the wrong length');
				parts.push(b.subarray(at, end));
			} else if (label === 0xff) {
				// Application: only the loop extension; XMP, ICC and the rest are dropped.
				// Kept, so only in its exact shape: the 11-byte name, one sub-block of
				// three bytes, then the terminator, nineteen bytes in all.
				if (b[at + 2] === 11 && startsWith(b, at + 3, 'NETSCAPE2.0')) {
					if (b[at + 14] !== 3 || end !== at + 19) invalid('its loop extension is the wrong length');
					parts.push(b.subarray(at, end));
				}
			} else if (label !== 0xfe && label !== 0x01) {
				invalid('it has an extension that is not accepted');
			}
			// A comment or plain text: dropped.
			at = end;
			continue;
		}
		invalid('a byte starts no block');
	}

	if (at !== b.length) invalid('there are bytes after its trailer');
	if (images === 0) invalid('it has no image');
	return { bytes: concat(parts), width, height };
}

// ─── WebP ───────────────────────────────────────────────────────────────────

/** `VP8X` flags. */
const VP8X_ANIMATION = 0x02;
const VP8X_XMP = 0x04;
const VP8X_EXIF = 0x08;

type RiffChunk = { fourcc: string; body: Uint8Array; whole: Uint8Array };

/** The size of a `VP8 ` or `VP8L` bitstream. */
function bitstreamSize(chunk: RiffChunk): { width: number; height: number } {
	const body = chunk.body;
	if (chunk.fourcc === 'VP8 ') {
		need(body, 0, 10);
		const tag = body[0] + body[1] * 0x100 + body[2] * 0x10000;
		if (tag & 1) invalid('its VP8 data does not start with a key frame');
		if (((tag >> 1) & 7) > 3) invalid('its VP8 data has a version VP8 does not have');
		if (Math.floor(tag / 32) > body.length - 10) invalid('its VP8 data is shorter than it says');
		if (!startsWith(body, 3, [0x9d, 0x01, 0x2a])) invalid('its VP8 data has no start code');
		const width = u16le(body, 6) & 0x3fff;
		const height = u16le(body, 8) & 0x3fff;
		if (width === 0 || height === 0) invalid('its VP8 data has no size');
		return { width, height };
	}
	need(body, 0, 5);
	if (body[0] !== 0x2f) invalid('its VP8L data has no signature');
	const bits = u32le(body, 1);
	if (Math.floor(bits / 0x20000000) !== 0) invalid('its VP8L data has a version VP8L does not have');
	return { width: (bits & 0x3fff) + 1, height: (Math.floor(bits / 0x4000) & 0x3fff) + 1 };
}

function walkWebp(b: Uint8Array): Walked {
	const size = u32le(b, 4);
	if (size < b.length - 8) invalid('there are bytes after its RIFF data');
	if (size > b.length - 8) invalid('it ends before its RIFF data does');

	const chunks: RiffChunk[] = [];
	let at = 12;
	while (at < b.length) {
		const fourcc = ascii(b, at, 4);
		const length = u32le(b, at + 4);
		const end = at + 8 + length;
		if (end > b.length) invalid('a chunk runs past the end');
		const padded = end + (length & 1);
		if (padded > b.length) invalid("an odd-sized chunk's pad byte is missing");
		chunks.push({ fourcc, body: b.subarray(at + 8, end), whole: b.subarray(at, padded) });
		at = padded;
	}
	if (chunks.length === 0) invalid('it has no image');

	const first = chunks[0];
	const kept: Uint8Array[] = [];
	let width: number;
	let height: number;

	if (first.fourcc === 'VP8 ' || first.fourcc === 'VP8L') {
		if (chunks.length !== 1) invalid('a simple WebP has more than its image');
		({ width, height } = bitstreamSize(first));
		kept.push(first.whole);
	} else if (first.fourcc === 'VP8X') {
		if (first.body.length !== 10) invalid('its VP8X chunk is the wrong length');
		const flags = first.body[0];
		if (flags & VP8X_ANIMATION) invalid('it is an animated WebP');
		width = u24le(first.body, 4) + 1;
		height = u24le(first.body, 7) + 1;
		const vp8x = first.whole.slice();
		vp8x[8] = flags & ~(VP8X_EXIF | VP8X_XMP);
		kept.push(vp8x);

		let image: RiffChunk | null = null;
		let alpha = false;
		for (const [index, chunk] of chunks.entries()) {
			if (index === 0) continue;
			switch (chunk.fourcc) {
				case 'ICCP':
					if (index !== 1) invalid('its ICCP chunk is not straight after VP8X');
					kept.push(chunk.whole);
					break;
				case 'ALPH':
					if (alpha || image) invalid('its ALPH chunk is out of place');
					alpha = true;
					kept.push(chunk.whole);
					break;
				case 'VP8 ':
				case 'VP8L':
					if (image) invalid('it has more than one image');
					image = chunk;
					kept.push(chunk.whole);
					break;
				case 'EXIF':
				case 'XMP ':
					break;
				default:
					invalid(
						chunk.fourcc === 'ANIM' || chunk.fourcc === 'ANMF'
							? 'it is an animated WebP'
							: `it has a chunk, ${JSON.stringify(chunk.fourcc)}, that is not accepted`
					);
			}
		}
		if (!image) invalid('it has no image');
		if (alpha && image.fourcc === 'VP8L') invalid('it has an ALPH chunk with a lossless image');
		const inner = bitstreamSize(image);
		if (inner.width !== width || inner.height !== height) invalid('its image is not the size its canvas says');
	} else {
		invalid('it does not start with VP8, VP8L or VP8X');
	}

	const header = new Uint8Array(12);
	header.set([0x52, 0x49, 0x46, 0x46]);
	let total = 4;
	for (const piece of kept) total += piece.length;
	header.set([total & 0xff, (total >>> 8) & 0xff, (total >>> 16) & 0xff, (total >>> 24) & 0xff], 4);
	header.set([0x57, 0x45, 0x42, 0x50], 8);
	return { bytes: concat([header, ...kept]), width, height };
}

// ─── The check ──────────────────────────────────────────────────────────────

const WALKERS: Record<ImageType, (bytes: Uint8Array) => Walked> = {
	'image/png': walkPng,
	'image/jpeg': walkJpeg,
	'image/gif': walkGif,
	'image/webp': walkWebp
};

/**
 * Check that `bytes` are an image of the `declared` type, one of the four,
 * and answer them with their metadata taken out, or why they are refused:
 * 415 for a type that is not one of the four or bytes that are not the type
 * declared, 400 for bytes that are not a valid image of their type, are
 * animated, have bytes after their end, or are too large.
 */
export function checkImage(bytes: Uint8Array, declared: string | null | undefined): CheckedImage | RefusedImage {
	const type = imageTypeOf(declared);
	if (!type) return { ok: false, status: 415, message: 'Content-Type must be image/png, image/jpeg, image/gif or image/webp' };
	const found = sniffImage(bytes);
	if (!found) return { ok: false, status: 415, message: 'The body is not a PNG, JPEG, GIF or WebP image' };
	if (found !== type) return { ok: false, status: 415, message: `The body is a ${NAME[found]} image, not the ${type} its Content-Type says` };

	let walked: Walked;
	try {
		walked = WALKERS[type](bytes);
	} catch (err) {
		if (err instanceof Invalid) return { ok: false, status: 400, message: `The ${NAME[type]} image is not valid: ${err.message}` };
		throw err;
	}

	const { width, height } = walked;
	if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
		return {
			ok: false,
			status: 400,
			message:
				`The image is ${width} x ${height} pixels: the most accepted is ${MAX_SIDE} on a side ` +
				`and ${MAX_PIXELS.toLocaleString('en-GB')} in all`
		};
	}
	return { ok: true, bytes: walked.bytes, mimeType: type, extension: EXTENSION[type], width, height };
}
