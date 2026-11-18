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

// ─── EXIF (card 2761) ───────────────────────────────────────────────────────

/** What a phone writes into a photo's EXIF, each piece plainly findable in the bytes. */
export const EXIF_MAKE = 'Pixelphone secret-maker\0';
export const EXIF_MODEL = 'Pixelphone secret-model 9\0';
export const EXIF_DATE = '2026:11:17 09:41:07\0';
export const EXIF_THUMBNAIL = bytes(0xff, 0xd8, 'secret-thumbnail', 0xff, 0xd9);

/** How a phone's EXIF is to be written, and the faults to write into it (card 2761, E14). */
export type ExifOptions = {
	/** The TIFF byte order: `II` little-endian, `MM` big-endian. */
	order?: 'II' | 'MM';
	/** The orientation's value (6 unless said), or null for no orientation entry at all. */
	orientation?: number | null;
	/** The orientation entry's type, 3 (SHORT) unless said. */
	orientationType?: number;
	/** The orientation entry's count, 1 unless said. */
	orientationCount?: number;
	/** A second orientation entry, at the end of IFD0, with this value. */
	orientationAgain?: number;
	/** The IFD0 offset the header gives, in place of where IFD0 is (8). */
	ifd0Offset?: number;
	/** The entry count IFD0 gives, in place of how many it holds. */
	ifd0Count?: number;
	/** The four bytes of the TIFF header, in place of the order's. */
	header?: Bytes;
	/** The TIFF cut this many bytes after IFD0's entries: under 4 leaves the next IFD's offset outside the segment. */
	cutAfterIfd0Entries?: number;
};

/**
 * The body of a JPEG's EXIF `APP1` as a phone writes it: `Exif\0\0`, then a
 * TIFF of IFD0 (Make, Model, Orientation, XResolution as a RATIONAL, and
 * pointers to the Exif sub-IFD and the GPS IFD, the orientation not first),
 * the Exif sub-IFD (DateTimeOriginal), the GPS IFD (latitude and longitude,
 * each three RATIONALs, and their references), and IFD1, the thumbnail's
 * (JPEGInterchangeFormat and its length), then the values that do not fit in
 * an entry, and the thumbnail. Also handed back, the GPS IFD's bytes as
 * written and the latitude and longitude, to look for in what is kept.
 *
 * Laid out here, offset by offset, and not by anything under test.
 */
export function phoneExif(options: ExifOptions = {}): { body: Bytes; gps: Bytes; position: Bytes } {
	const { order = 'II', orientation = 6, orientationType = 3, orientationCount = 1 } = options;
	const w16 = (n: number) => (order === 'II' ? le16(n) : be16(n));
	const w32 = (n: number) => (order === 'II' ? le32(n) : be32(n));
	/** A SHORT in an entry's four value bytes: in its first two, in the file's order. */
	const short = (n: number) => [...w16(n), 0, 0];
	const entry = (tag: number, type: number, count: number, value: readonly number[]) => bytes(w16(tag), w16(type), w32(count), value);
	const rational = (num: number, den: number) => [...w32(num), ...w32(den)];

	const ifd0Entries = 6 + (orientation === null ? 0 : 1) + (options.orientationAgain === undefined ? 0 : 1);
	const ifd0At = 8;
	const exifAt = ifd0At + 2 + 12 * ifd0Entries + 4;
	const gpsAt = exifAt + 2 + 12 + 4;
	const ifd1At = gpsAt + 2 + 12 * 4 + 4;
	const makeAt = ifd1At + 2 + 12 * 2 + 4;
	const modelAt = makeAt + EXIF_MAKE.length;
	const xResolutionAt = modelAt + EXIF_MODEL.length;
	const dateAt = xResolutionAt + 8;
	const latitudeAt = dateAt + EXIF_DATE.length;
	const longitudeAt = latitudeAt + 24;
	const thumbnailAt = longitudeAt + 24;

	const orientationValue = (value: number) => (orientationType === 4 ? w32(value) : short(value));
	const ifd0 = bytes(
		w16(options.ifd0Count ?? ifd0Entries),
		entry(0x010f, 2, EXIF_MAKE.length, w32(makeAt)),
		entry(0x0110, 2, EXIF_MODEL.length, w32(modelAt)),
		orientation === null ? [] : entry(0x0112, orientationType, orientationCount, orientationValue(orientation)),
		entry(0x011a, 5, 1, w32(xResolutionAt)),
		entry(0x0128, 3, 1, short(2)),
		entry(0x8769, 4, 1, w32(exifAt)),
		entry(0x8825, 4, 1, w32(gpsAt)),
		options.orientationAgain === undefined ? [] : entry(0x0112, 3, 1, short(options.orientationAgain)),
		w32(ifd1At)
	);
	const exif = bytes(w16(1), entry(0x9003, 2, EXIF_DATE.length, w32(dateAt)), w32(0));
	const gps = bytes(
		w16(4),
		entry(0x0001, 2, 2, ['N'.charCodeAt(0), 0, 0, 0]),
		entry(0x0002, 5, 3, w32(latitudeAt)),
		entry(0x0003, 2, 2, ['W'.charCodeAt(0), 0, 0, 0]),
		entry(0x0004, 5, 3, w32(longitudeAt)),
		w32(0)
	);
	const ifd1 = bytes(w16(2), entry(0x0201, 4, 1, w32(thumbnailAt)), entry(0x0202, 4, 1, w32(EXIF_THUMBNAIL.length)), w32(0));
	const position = bytes(rational(51, 1), rational(30, 1), rational(2615, 100), rational(0, 1), rational(7, 1), rational(3912, 100));

	const header = options.header ?? (order === 'II' ? bytes('II', 0x2a, 0x00) : bytes('MM', 0x00, 0x2a));
	const tiff = bytes(
		header,
		w32(options.ifd0Offset ?? ifd0At),
		ifd0,
		exif,
		gps,
		ifd1,
		EXIF_MAKE,
		EXIF_MODEL,
		rational(72, 1),
		EXIF_DATE,
		position,
		EXIF_THUMBNAIL
	);
	const cut = options.cutAfterIfd0Entries === undefined ? tiff : tiff.subarray(0, ifd0At + 2 + 12 * ifd0Entries + options.cutAfterIfd0Entries);
	return { body: bytes('Exif\0\0', cut), gps, position };
}

/** A JPEG photo as a phone writes it: JFIF, then its EXIF `APP1` (`phoneExif`), then `after`. */
export function phoneJpeg(options: ExifOptions = {}, after: Bytes[] = []): Bytes {
	return jpeg({ before: [JFIF, jpegSegment(0xe1, phoneExif(options).body), ...after] });
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
