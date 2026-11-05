/**
 * Small, valid PNG, JPEG, GIF and WebP files, made in the test, with the
 * pieces each format can carry to add (card 2754). For
 * `tests/image-check.test.ts` and for any test that has to upload or serve a
 * real image.
 *
 * The PNG checksum is worked out here, by a CRC of this file's own, so that
 * the check in `$lib/server/image-check` is never tested against itself.
 */
import { deflateSync } from 'node:zlib';

export type Bytes = Uint8Array;

/** Bytes from numbers, text (each character one byte) and other bytes, in order. */
export function bytes(...parts: (number | string | Bytes | readonly number[])[]): Bytes {
	const out: number[] = [];
	for (const part of parts) {
		if (typeof part === 'number') out.push(part & 0xff);
		else if (typeof part === 'string') for (const c of part) out.push(c.charCodeAt(0) & 0xff);
		else out.push(...part);
	}
	return Uint8Array.from(out);
}

export const be16 = (n: number) => [(n >>> 8) & 0xff, n & 0xff];
export const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
export const le16 = (n: number) => [n & 0xff, (n >>> 8) & 0xff];
export const le24 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];
export const le32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

// ─── PNG ────────────────────────────────────────────────────────────────────

/** CRC-32, bit by bit: slow, and plainly not the table the module under test uses. */
function crc(data: Bytes): number {
	let c = 0xffffffff;
	for (const byte of data) {
		c ^= byte;
		for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
	}
	return (c ^ 0xffffffff) >>> 0;
}

/** A PNG chunk: its length, name, data and checksum. */
export function pngChunk(type: string, data: Bytes | readonly number[] | string = []): Bytes {
	const body = bytes(type, typeof data === 'string' ? data : data);
	return bytes(be32(body.length - 4), body, be32(crc(body)));
}

export function ihdr(width: number, height: number, depth = 8, colourType = 2): Bytes {
	return pngChunk('IHDR', [...be32(width), ...be32(height), depth, colourType, 0, 0, 0]);
}

/**
 * A PNG of `width` x `height`, RGB, black: IHDR, then `before` (between IHDR
 * and the image data), the data in `idat` chunks, `after`, and IEND. A large
 * one gets a short stand-in for its data: nothing here decodes it.
 */
export function png(
	options: { width?: number; height?: number; before?: Bytes[]; after?: Bytes[]; idat?: number; header?: Bytes } = {}
): Bytes {
	const { width = 2, height = 2, before = [], after = [], idat = 1 } = options;
	const raw = width * height <= 65_536 ? new Uint8Array(height * (1 + width * 3)) : new Uint8Array(16);
	const data = deflateSync(raw);
	const pieces: Bytes[] = [];
	const step = Math.ceil(data.length / idat);
	for (let i = 0; i < idat; i++) pieces.push(pngChunk('IDAT', data.subarray(i * step, (i + 1) * step)));
	return bytes(
		[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
		options.header ?? ihdr(width, height),
		...before,
		...pieces,
		...after,
		pngChunk('IEND')
	);
}

// ─── JPEG ───────────────────────────────────────────────────────────────────

/** A JPEG segment: the marker and its length, which counts itself. */
export function jpegSegment(marker: number, data: Bytes | readonly number[] | string = []): Bytes {
	const body = bytes(typeof data === 'string' ? data : data);
	return bytes(0xff, marker, be16(body.length + 2), body);
}

export const JFIF = jpegSegment(0xe0, bytes('JFIF\0', 1, 2, 0, be16(72), be16(72), 0, 0));

export function sof(width: number, height: number, marker = 0xc0): Bytes {
	return jpegSegment(marker, [8, ...be16(height), ...be16(width), 1, 1, 0x11, 0]);
}
export const DQT = jpegSegment(0xdb, [0, ...new Array(64).fill(1)]);
// One code of one bit for each table: a DC table of symbol 0, an AC table of end-of-block.
export const DHT = jpegSegment(0xc4, [0x00, 1, ...new Array(15).fill(0), 0x00, 0x10, 1, ...new Array(15).fill(0), 0x00]);
export const SOS = jpegSegment(0xda, [1, 1, 0x00, 0, 63, 0]);

/**
 * A JPEG of `width` x `height`: SOI, `before` (after SOI), the tables, the
 * frame, and one scan, or two for a progressive one with `between` between
 * them, then EOI. The scans hold a stuffed 0xFF, and a restart marker when
 * `restarts` is set.
 */
export function jpeg(
	options: { width?: number; height?: number; before?: Bytes[]; between?: Bytes[]; progressive?: boolean; restarts?: boolean; frame?: Bytes } = {}
): Bytes {
	const { width = 2, height = 2, before = [JFIF], between = [], progressive = false, restarts = false } = options;
	const scan = restarts ? bytes(0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56) : bytes(0x12, 0xff, 0x00, 0x34);
	return bytes(
		0xff,
		0xd8,
		...before,
		DQT,
		options.frame ?? sof(width, height, progressive ? 0xc2 : 0xc0),
		DHT,
		restarts ? jpegSegment(0xdd, be16(1)) : [],
		SOS,
		scan,
		...(progressive ? [...between, SOS, scan] : []),
		0xff,
		0xd9
	);
}

// ─── GIF ────────────────────────────────────────────────────────────────────

/** A GIF extension: its label and its data in sub-blocks, then the terminator. */
export function gifExtension(label: number, ...blocks: (Bytes | readonly number[] | string)[]): Bytes {
	const out: (number | Bytes)[] = [0x21, label];
	for (const block of blocks) {
		const data = bytes(typeof block === 'string' ? block : block);
		out.push(data.length, data);
	}
	out.push(0);
	return bytes(...out);
}

export const GRAPHIC_CONTROL = gifExtension(0xf9, [0x01, 0x00, 0x00, 0x00]);
export const LOOP = gifExtension(0xff, 'NETSCAPE2.0', [0x01, 0x00, 0x00]);

/** An image descriptor and its data, at `left`, `top`. */
export function gifImage(width: number, height: number, left = 0, top = 0): Bytes {
	return bytes(0x2c, le16(left), le16(top), le16(width), le16(height), 0x00, 0x02, 0x02, 0x44, 0x01, 0x00);
}

/** A GIF89a of `width` x `height` with a two-colour table: `before`, `frames` images, `after`, the trailer. */
export function gif(options: { width?: number; height?: number; before?: Bytes[]; frames?: number; after?: Bytes[] } = {}): Bytes {
	const { width = 2, height = 2, before = [], frames = 1, after = [] } = options;
	return bytes(
		'GIF89a',
		le16(width),
		le16(height),
		0x80,
		0,
		0,
		[0, 0, 0, 0xff, 0xff, 0xff],
		...before,
		...Array.from({ length: frames }, () => gifImage(width, height)),
		...after,
		0x3b
	);
}

// ─── WebP ───────────────────────────────────────────────────────────────────

/** A RIFF chunk: its name, size and data, and a pad byte when the size is odd. */
export function riffChunk(fourcc: string, data: Bytes | readonly number[] | string = []): Bytes {
	const body = bytes(typeof data === 'string' ? data : data);
	return bytes(fourcc, le32(body.length), body, body.length & 1 ? [0] : []);
}

/** A lossless bitstream of `width` x `height`: 7 bytes, so its chunk is padded. */
export function vp8l(width: number, height: number): Bytes {
	const bits = (width - 1) | ((height - 1) << 14);
	return riffChunk('VP8L', [0x2f, ...le32(bits >>> 0), 0x00, 0x00]);
}

/** A lossy key frame of `width` x `height`, its first partition 3 bytes: 13 bytes, padded. */
export function vp8(width: number, height: number): Bytes {
	const tag = (3 << 5) | (1 << 4);
	return riffChunk('VP8 ', [...le24(tag), 0x9d, 0x01, 0x2a, ...le16(width), ...le16(height), 0, 0, 0]);
}

/** A VP8X chunk: `flags`, and the canvas. */
export function vp8x(width: number, height: number, flags = 0): Bytes {
	return riffChunk('VP8X', [flags, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)]);
}

/** A WebP holding `chunks`, its RIFF size worked out. */
export function webpOf(...chunks: Bytes[]): Bytes {
	const body = bytes('WEBP', ...chunks);
	return bytes('RIFF', le32(body.length), body);
}

/** A simple lossless WebP or a simple lossy one. An extended one is `webpOf(vp8x(...), ...)`. */
export function webp(kind: 'lossless' | 'lossy' = 'lossless', width = 2, height = 2): Bytes {
	return webpOf(kind === 'lossless' ? vp8l(width, height) : vp8(width, height));
}
