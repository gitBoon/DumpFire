/**
 * Card 2754, slice S1: whether bytes are a PNG, JPEG, GIF or WebP image, and
 * those bytes with their metadata taken out (`$lib/server/image-check`).
 *
 * One case per path through each format's walk: what it keeps, what it
 * drops, each way it refuses, and the size ceiling. Then the walks against
 * bytes nobody would write: every truncation of a valid file, and seeded
 * random and changed bytes (S4 of the plan review), which may be refused but
 * must never throw.
 */
import { describe, expect, it } from 'vitest';
import {
	checkImage,
	imageTypeOf,
	MAX_PIXELS,
	MAX_SIDE,
	sniffImage,
	type CheckedImage,
	type ImageType,
	type RefusedImage
} from '$lib/server/image-check';
import {
	be16,
	be32,
	bytes,
	DHT,
	DQT,
	EXIF_DATE,
	EXIF_MAKE,
	EXIF_MODEL,
	EXIF_THUMBNAIL,
	gif,
	gifExtension,
	gifImage,
	GRAPHIC_CONTROL,
	ihdr,
	JFIF,
	jpeg,
	jpegSegment,
	le16,
	le24,
	le32,
	LOOP,
	phoneExif,
	phoneJpeg,
	png,
	pngChunk,
	riffChunk,
	sof,
	SOS,
	vp8,
	vp8l,
	vp8x,
	webp,
	webpOf,
	type Bytes,
	type ExifOptions
} from './helpers/image-bytes';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function accepted(input: Bytes, declared: string): CheckedImage {
	const result = checkImage(input, declared);
	if (!result.ok) throw new Error(`refused ${result.status}: ${result.message}`);
	return result;
}

/** The 400 message for bytes that are not a valid image of their type. */
function invalid(input: Bytes, declared: string): string {
	const result = checkImage(input, declared);
	expect(result.ok, 'accepted').toBe(false);
	expect((result as RefusedImage).status, (result as RefusedImage).message).toBe(400);
	return (result as RefusedImage).message;
}

/** The bytes as text, one character a byte, to look for what was dropped. */
const text = (input: Bytes) => Buffer.from(input).toString('latin1');

/** A PNG's chunk names, in order. */
function pngChunks(input: Bytes): string[] {
	const names: string[] = [];
	for (let at = 8; at < input.length; ) {
		const length = Buffer.from(input).readUInt32BE(at);
		names.push(text(input.subarray(at + 4, at + 8)));
		at += 12 + length;
	}
	return names;
}

/** A JPEG's markers, in order, its scans' data passed over. */
function jpegMarkers(input: Bytes): number[] {
	const markers: number[] = [0xd8];
	let at = 2;
	while (at < input.length) {
		const marker = input[at + 1];
		markers.push(marker);
		if (marker === 0xd9) break;
		at += 2 + input[at + 2] * 256 + input[at + 3];
		if (marker === 0xda) {
			while (at < input.length && !(input[at] === 0xff && input[at + 1] !== 0x00 && (input[at + 1] < 0xd0 || input[at + 1] > 0xd7))) at++;
		}
	}
	return markers;
}

/** A RIFF file's chunk names, in order. */
function riffChunks(input: Bytes): string[] {
	const names: string[] = [];
	for (let at = 12; at < input.length; ) {
		const length = Buffer.from(input).readUInt32LE(at + 4);
		names.push(text(input.subarray(at, at + 4)));
		at += 8 + length + (length & 1);
	}
	return names;
}

/** A GIF's blocks after its colour table: `image`, `ext <label>` (an application one by its name), `trailer`. */
function gifBlocks(input: Bytes): string[] {
	const blocks: string[] = [];
	let at = 13 + (input[10] & 0x80 ? 3 * (1 << ((input[10] & 7) + 1)) : 0);
	const pastSubBlocks = (from: number) => {
		while (input[from] !== 0) from += 1 + input[from];
		return from + 1;
	};
	while (at < input.length) {
		if (input[at] === 0x3b) {
			blocks.push('trailer');
			at++;
		} else if (input[at] === 0x2c) {
			blocks.push('image');
			at = pastSubBlocks(at + 11);
		} else {
			const label = input[at + 1];
			blocks.push(label === 0xff ? `ext ${text(input.subarray(at + 3, at + 14))}` : `ext ${label.toString(16)}`);
			at = pastSubBlocks(at + 2);
		}
	}
	return blocks;
}

// ─── What the bytes claim ───────────────────────────────────────────────────

describe('sniffImage', () => {
	it('names each format by its magic bytes, and nothing else', () => {
		expect(sniffImage(png())).toBe('image/png');
		expect(sniffImage(jpeg())).toBe('image/jpeg');
		expect(sniffImage(gif())).toBe('image/gif');
		expect(sniffImage(bytes('GIF87a', 0, 0))).toBe('image/gif');
		expect(sniffImage(webp())).toBe('image/webp');

		for (const [what, input] of [
			['SVG', bytes('<svg xmlns="http://www.w3.org/2000/svg"/>')],
			['HTML', bytes('<!doctype html><p>hi')],
			['nothing', bytes()],
			['the start of a PNG', bytes(0x89, 0x50, 0x4e)],
			['a RIFF that is not WebP', bytes('RIFF', le32(4), 'WAVE')],
			['GIF88a', bytes('GIF88a')]
		] as const) {
			expect(sniffImage(input), what).toBeNull();
		}
	});
});

describe('imageTypeOf', () => {
	it('reads a Content-Type as one of the four, its parameters and case aside', () => {
		expect(imageTypeOf('IMAGE/PNG; q=1')).toBe('image/png');
		expect(imageTypeOf(' image/webp ')).toBe('image/webp');
		expect(imageTypeOf('image/svg+xml')).toBeNull();
		expect(imageTypeOf('image/jpg')).toBeNull();
		expect(imageTypeOf(null)).toBeNull();
	});
});

// ─── The happy path, each walker ────────────────────────────────────────────

describe('a valid image of each format', () => {
	it.each([
		['PNG', png({ width: 3, height: 5 }), 'image/png', 'png', 3, 5],
		['baseline JPEG', jpeg({ width: 7, height: 4 }), 'image/jpeg', 'jpg', 7, 4],
		['progressive JPEG with restarts', jpeg({ width: 9, height: 2, progressive: true, restarts: true }), 'image/jpeg', 'jpg', 9, 2],
		['GIF', gif({ width: 4, height: 3 }), 'image/gif', 'gif', 4, 3],
		['lossy WebP', webp('lossy', 5, 7), 'image/webp', 'webp', 5, 7],
		['lossless WebP', webp('lossless', 6, 4), 'image/webp', 'webp', 6, 4],
		['extended WebP', webpOf(vp8x(3, 3, 0x10), riffChunk('ALPH', [0]), vp8(3, 3)), 'image/webp', 'webp', 3, 3]
	] as const)('passes a %s, with its type, extension and size, and its bytes as they were', (_what, input, type, extension, width, height) => {
		const result = accepted(input, type);
		expect(result).toMatchObject({ ok: true, mimeType: type, extension, width, height });
		expect(result.bytes).toEqual(input);
	});
});

describe('the declared type', () => {
	it('is refused 415 when it is not one of the four, or the bytes are another', () => {
		expect(checkImage(png(), 'image/svg+xml')).toEqual({
			ok: false,
			status: 415,
			message: 'Content-Type must be image/png, image/jpeg, image/gif or image/webp'
		});
		expect(checkImage(jpeg(), 'image/png')).toEqual({ ok: false, status: 415, message: 'The body is a JPEG image, not the image/png its Content-Type says' });
		expect(checkImage(bytes('<svg/>'), 'image/png')).toEqual({ ok: false, status: 415, message: 'The body is not a PNG, JPEG, GIF or WebP image' });
		expect(checkImage(bytes(), 'image/gif')).toMatchObject({ ok: false, status: 415 });
		expect(accepted(png(), 'IMAGE/PNG; q=1').mimeType).toBe('image/png');
	});
});

// ─── PNG ────────────────────────────────────────────────────────────────────

describe('a PNG', () => {
	it('keeps its colour, transparency and pixel-size chunks and drops every other ancillary chunk', () => {
		const input = png({
			before: [
				pngChunk('tEXt', 'Author\0Somebody'),
				pngChunk('PLTE', [0, 0, 0, 255, 255, 255]),
				pngChunk('tRNS', [0, 0, 0, 0, 0, 0]),
				pngChunk('gAMA', be32(45455)),
				pngChunk('cHRM', new Array(32).fill(1)),
				pngChunk('sRGB', [0]),
				pngChunk('iCCP', 'sRGB\0\0profile'),
				pngChunk('cICP', [1, 13, 0, 1]),
				pngChunk('sBIT', [8, 8, 8]),
				pngChunk('pHYs', [0, 0, 11, 19, 0, 0, 11, 19, 1]),
				pngChunk('zTXt', 'Comment\0\0secret'),
				pngChunk('iTXt', 'XML:com.adobe.xmp\0\0\0\0\0secret'),
				pngChunk('eXIf', 'MM\0*secret'),
				pngChunk('tIME', [7, 234, 11, 5, 12, 0, 0]),
				pngChunk('bKGD', [0, 0, 0, 0, 0, 0])
			],
			after: [pngChunk('tEXt', 'Comment\0secret')]
		});

		const result = accepted(input, 'image/png');

		expect(pngChunks(result.bytes)).toEqual(['IHDR', 'PLTE', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'cICP', 'sBIT', 'pHYs', 'IDAT', 'IEND']);
		expect(text(result.bytes)).not.toMatch(/secret|Somebody/);
		expect(result.bytes.subarray(0, 8)).toEqual(Uint8Array.from(PNG_SIGNATURE));
	});

	const SIG = PNG_SIGNATURE;
	const IDAT = pngChunk('IDAT', [1, 2, 3]);
	const IEND = pngChunk('IEND');
	const badCrc = png();
	badCrc[32] ^= 0xff;

	it.each([
		['a wrong checksum', badCrc, /IHDR chunk's checksum is wrong/],
		['an unknown critical chunk', png({ before: [pngChunk('ABCD', 'x')] }), /critical chunk, ABCD,/],
		['no IHDR first', png({ header: bytes(pngChunk('sRGB', [0]), ihdr(2, 2)) }), /does not start with IHDR/],
		['an IHDR of the wrong length', png({ header: pngChunk('IHDR', new Array(12).fill(1)) }), /IHDR is the wrong length/],
		['a depth its colour type does not allow', png({ header: ihdr(2, 2, 4, 2) }), /colour type and bit depth/],
		['a colour type PNG does not have', png({ header: ihdr(2, 2, 8, 5) }), /colour type and bit depth/],
		['no width', png({ header: ihdr(0, 2) }), /size is not one a PNG allows/],
		['a second IHDR', png({ before: [ihdr(2, 2)] }), /second IHDR/],
		['a palette after the image data', png({ after: [pngChunk('PLTE', [0, 0, 0])] }), /palette is out of place/],
		['a palette image with no palette', png({ header: ihdr(2, 2, 8, 3) }), /palette image has no palette/],
		['a grey image with a palette', png({ header: ihdr(2, 2, 8, 0), before: [pngChunk('PLTE', [0, 0, 0])] }), /grey image has a palette/],
		['IDAT chunks apart', bytes(SIG, ihdr(1, 1), IDAT, pngChunk('gAMA', be32(1)), IDAT, IEND), /IDAT chunks are not together/],
		['no image data', bytes(SIG, ihdr(1, 1), IEND), /no image data/],
		['an IEND that is not empty', bytes(SIG, ihdr(1, 1), IDAT, pngChunk('IEND', [0])), /IEND is not empty/],
		['a chunk past the end', bytes(SIG, ihdr(1, 1), be32(100), 'IDAT', [1, 2, 3]), /runs past the end/],
		['a chunk longer than PNG allows', bytes(SIG, ihdr(1, 1), be32(0x80000000), 'IDAT', [1, 2, 3]), /longer than a PNG allows/],
		['a chunk name that is not four letters', png({ before: [pngChunk('ab1c', 'x')] }), /not four letters/],
		['acTL', png({ before: [pngChunk('acTL', [0, 0, 0, 2, 0, 0, 0, 0])] }), /animated PNG/],
		['fcTL', png({ before: [pngChunk('fcTL', new Array(26).fill(0))] }), /animated PNG/],
		['fdAT', png({ after: [pngChunk('fdAT', [0, 0, 0, 1])] }), /animated PNG/],
		['a byte after IEND', bytes(png(), 0), /bytes after IEND/],
		['a second file after IEND', bytes(png(), webp()), /bytes after IEND/]
	] as const)('is refused 400 for %s', (_what, input, message) => {
		expect(invalid(input, 'image/png')).toMatch(message);
	});
});

// ─── JPEG ───────────────────────────────────────────────────────────────────

describe('a JPEG', () => {
	const app = (n: number, data: string | Bytes) => jpegSegment(0xe0 + n, data);

	it('keeps JFIF without its thumbnail, ICC and Adobe, and drops every other application segment and comment, between scans too', () => {
		const input = jpeg({
			progressive: true,
			restarts: true,
			before: [
				app(0, bytes('JFIF\0', 1, 2, 0, be16(72), be16(72), 1, 1, [1, 2, 3])),
				app(0, 'JFXX\0\x10thumbnail-secret'),
				app(1, 'Exif\0\0MM\0*secret'),
				app(1, 'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>secret</x:xmpmeta>'),
				app(2, 'ICC_PROFILE\0\x01\x01profile'),
				app(2, 'MPF\0secret'),
				app(3, 'secret'),
				app(13, 'Photoshop 3.0\x008BIMsecret'),
				app(14, bytes('Adobe', 0, 100, 0, 0, 0, 0, 1)),
				app(15, 'secret'),
				jpegSegment(0xfe, 'a comment, secret')
			],
			between: [jpegSegment(0xfe, 'between scans, secret'), app(1, 'Exif\0\0between secret'), DHT]
		});

		const result = accepted(input, 'image/jpeg');

		expect(jpegMarkers(result.bytes)).toEqual([0xd8, 0xe0, 0xe2, 0xee, 0xdb, 0xc2, 0xc4, 0xdd, 0xda, 0xc4, 0xda, 0xd9]);
		expect(text(result.bytes)).not.toMatch(/secret|thumbnail/);
		// JFIF as it was, with a 0 x 0 thumbnail and no thumbnail data.
		expect(result.bytes.subarray(2, 20)).toEqual(bytes(0xff, 0xe0, 0, 16, 'JFIF\0', 1, 2, 0, be16(72), be16(72), 0, 0));
		expect(text(result.bytes)).toContain('ICC_PROFILE');
		expect(text(result.bytes)).toContain('Adobe');
	});

	it('passes over fill bytes before a marker, and drops them', () => {
		const plain = jpeg();
		const filled = bytes(plain.subarray(0, 2), 0xff, 0xff, plain.subarray(2));
		expect(accepted(filled, 'image/jpeg').bytes).toEqual(plain);
	});

	const SOI = [0xff, 0xd8];
	const afterSoi = jpeg().subarray(2);

	it.each([
		['a segment shorter than its own length', bytes(SOI, 0xff, 0xe1, 0, 1, afterSoi), /shorter than its own length/],
		['a segment past the end', bytes(SOI, 0xff, 0xe1, 0xff, 0xff, 'x'), /segment runs past the end/],
		['a frame with no height', jpeg({ frame: sof(2, 0) }), /frame has no height/],
		['a frame with no width', jpeg({ frame: sof(0, 2) }), /frame has no width/],
		['a 12-bit baseline frame', jpeg({ frame: jpegSegment(0xc0, [12, 0, 2, 0, 2, 1, 1, 0x11, 0]) }), /precision/],
		['a frame of the wrong length', jpeg({ frame: jpegSegment(0xc0, [8, 0, 2, 0, 2, 2, 1, 0x11, 0]) }), /frame is the wrong length/],
		['a second frame', jpeg({ before: [JFIF, sof(2, 2)] }), /more than one frame/],
		['a scan before the frame', bytes(SOI, DQT, SOS, 0x12, 0xff, 0xd9), /scan comes before the frame/],
		['a scan header of the wrong length', bytes(SOI, sof(2, 2), jpegSegment(0xda, [1, 1, 0, 0, 63]), 0x12, 0xff, 0xd9), /scan header/],
		['a lossless frame', jpeg({ frame: sof(2, 2, 0xc3) }), /0xFFC3, that is not accepted/],
		['a hierarchical frame', jpeg({ frame: sof(2, 2, 0xc5) }), /0xFFC5, that is not accepted/],
		['an arithmetic-coded frame', jpeg({ frame: sof(2, 2, 0xc9) }), /0xFFC9, that is not accepted/],
		['DNL', jpeg({ before: [JFIF, jpegSegment(0xdc, be16(2))] }), /0xFFDC, that is not accepted/],
		['a restart interval longer than two bytes', jpeg({ before: [JFIF, jpegSegment(0xdd, [0, 1, ...bytes('secret')])] }), /restart interval is the wrong length/],
		['an Adobe segment longer than twelve bytes', jpeg({ before: [JFIF, app(14, bytes('Adobe', 0, 100, 0, 0, 0, 0, 1, 'secret'))] }), /Adobe segment is the wrong length/],
		['a restart marker between segments', bytes(SOI, 0xff, 0xd0, afterSoi), /marker out of place/],
		['a second SOI', bytes(SOI, SOI, afterSoi), /marker out of place/],
		['a byte that is not a marker between segments', bytes(SOI, JFIF, 0x00, jpeg({ before: [] }).subarray(2)), /not a marker/],
		['no EOI', jpeg().subarray(0, jpeg().length - 2), /ends inside a scan/],
		['no scan', bytes(SOI, JFIF, DQT, sof(2, 2), 0xff, 0xd9), /no image data/]
	] as const)('is refused 400 for %s', (_what, input, message) => {
		expect(invalid(input, 'image/jpeg')).toMatch(message);
	});
});

// ─── GIF ────────────────────────────────────────────────────────────────────

describe('a GIF', () => {
	it('keeps its graphic control and loop extensions, and drops comments, plain text and other application extensions', () => {
		const input = gif({
			before: [
				gifExtension(0xfe, 'a comment, secret'),
				GRAPHIC_CONTROL,
				LOOP,
				gifExtension(0xff, 'XMP DataXMP', '<x:xmpmeta>secret</x:xmpmeta>'),
				gifExtension(0x01, new Array(12).fill(0), 'plain text, secret')
			],
			after: [gifExtension(0xfe, 'after the image, secret')]
		});

		const result = accepted(input, 'image/gif');

		expect(gifBlocks(result.bytes)).toEqual(['ext f9', 'ext NETSCAPE2.0', 'image', 'trailer']);
		expect(text(result.bytes)).not.toMatch(/secret|XMP/);
	});

	/** A GIF's image descriptor with a given LZW code size. */
	const withCodeSize = (size: number) => bytes(0x2c, le16(0), le16(0), le16(2), le16(2), 0, size, 2, 0x44, 0x01, 0);

	it.each([
		['two images', gif({ frames: 2 }), /more than one image: an animated GIF/],
		['an image outside its screen', gif({ frames: 0, before: [gifImage(2, 2, 1, 0)] }), /not inside its screen/],
		['an image taller than its screen', gif({ frames: 0, before: [gifImage(2, 3)] }), /not inside its screen/],
		['a sub-block past the end', bytes(gif().subarray(0, 19), 0x21, 0xfe, 10, 'abc'), /ends inside a block/],
		['no trailer', gif().subarray(0, gif().length - 1), /ends before its trailer/],
		['a byte after the trailer', bytes(gif(), 0), /bytes after its trailer/],
		['a second file after the trailer', bytes(gif(), png()), /bytes after its trailer/],
		['an unknown extension', gif({ before: [gifExtension(0x99, 'x')] }), /extension that is not accepted/],
		['a byte that starts no block', gif({ before: [bytes(0)] }), /starts no block/],
		['a code size of 1', gif({ frames: 0, before: [withCodeSize(1)] }), /code size/],
		['a code size of 9', gif({ frames: 0, before: [withCodeSize(9)] }), /code size/],
		['a screen with no width', gif({ width: 0 }), /screen has no size/],
		['a graphic control block of the wrong length', gif({ before: [gifExtension(0xf9, [1, 0, 0])] }), /graphic control block/],
		['a graphic control block with a second sub-block', gif({ before: [gifExtension(0xf9, [1, 0, 0, 0], 'secret')] }), /graphic control block/],
		['a loop extension with a second sub-block', gif({ before: [gifExtension(0xff, 'NETSCAPE2.0', [1, 0, 0], 'secret')] }), /loop extension is the wrong length/],
		['no image', gif({ frames: 0 }), /has no image/]
	] as const)('is refused 400 for %s', (_what, input, message) => {
		expect(invalid(input, 'image/gif')).toMatch(message);
	});
});

// ─── WebP ───────────────────────────────────────────────────────────────────

describe('a WebP', () => {
	it('drops EXIF and XMP, clears only their VP8X flags, keeps ICC and alpha, and writes its RIFF size again', () => {
		const input = webpOf(
			vp8x(2, 2, 0x20 | 0x10 | 0x08 | 0x04),
			riffChunk('ICCP', 'icc'),
			riffChunk('ALPH', [0]),
			vp8(2, 2),
			riffChunk('EXIF', 'Exif\0\0secret'),
			riffChunk('XMP ', '<x:xmpmeta>secret</x:xmpmeta>')
		);

		const result = accepted(input, 'image/webp');

		expect(riffChunks(result.bytes)).toEqual(['VP8X', 'ICCP', 'ALPH', 'VP8 ']);
		expect(result.bytes[20]).toBe(0x30);
		expect(Buffer.from(result.bytes).readUInt32LE(4)).toBe(result.bytes.length - 8);
		expect(text(result.bytes)).not.toMatch(/secret/);
		// ICCP is 3 bytes, so it keeps its pad byte, and the output reads again.
		expect(accepted(result.bytes, 'image/webp').bytes).toEqual(result.bytes);
	});

	const vp8With = (tag: number, start: readonly number[]) =>
		riffChunk('VP8 ', [...le24(tag), ...start, ...le16(2), ...le16(2), 0, 0, 0]);
	const KEY = (3 << 5) | (1 << 4);

	it.each([
		['a RIFF size shorter than the file', bytes(webp(), 0, 0), /bytes after its RIFF data/],
		['a second file after the RIFF data', bytes(webp(), png()), /bytes after its RIFF data/],
		['a RIFF size longer than the file', webp().subarray(0, webp().length - 1), /ends before its RIFF data/],
		['ANIM', webpOf(vp8x(2, 2), riffChunk('ANIM', new Array(6).fill(0)), vp8l(2, 2)), /animated WebP/],
		['ANMF', webpOf(vp8x(2, 2), vp8l(2, 2), riffChunk('ANMF', new Array(16).fill(0))), /animated WebP/],
		['the animation flag', webpOf(vp8x(2, 2, 0x02), vp8l(2, 2)), /animated WebP/],
		['an unknown chunk', webpOf(vp8x(2, 2), riffChunk('ABCD', 'x'), vp8l(2, 2)), /"ABCD", that is not accepted/],
		['two images', webpOf(vp8x(2, 2), vp8l(2, 2), vp8l(2, 2)), /more than one image/],
		['no image', webpOf(vp8x(2, 2)), /has no image/],
		['no chunk at all', webpOf(), /has no image/],
		['ICCP not straight after VP8X', webpOf(vp8x(2, 2), riffChunk('ALPH', [0]), riffChunk('ICCP', 'i'), vp8(2, 2)), /ICCP chunk/],
		['ALPH after the image', webpOf(vp8x(2, 2), vp8(2, 2), riffChunk('ALPH', [0])), /ALPH chunk is out of place/],
		['ALPH with a lossless image', webpOf(vp8x(2, 2), riffChunk('ALPH', [0]), vp8l(2, 2)), /ALPH chunk with a lossless image/],
		['a simple file with a second chunk', webpOf(vp8l(2, 2), riffChunk('EXIF', 'x')), /simple WebP has more than its image/],
		['a first chunk that is no image', webpOf(riffChunk('EXIF', 'x'), vp8l(2, 2)), /does not start with VP8, VP8L or VP8X/],
		['a VP8X of the wrong length', webpOf(riffChunk('VP8X', new Array(9).fill(0)), vp8l(2, 2)), /VP8X chunk is the wrong length/],
		['a missing pad byte', bytes('RIFF', le32(4 + 8 + 7), 'WEBP', 'VP8L', le32(7), [0x2f, ...le32((1 << 14) | 1), 0, 0]), /pad byte is missing/],
		['a chunk past the end', bytes('RIFF', le32(4 + 8 + 2), 'WEBP', 'VP8L', le32(100), [0x2f, 0]), /chunk runs past the end/],
		['a VP8 frame that is not a key frame', webpOf(vp8With(KEY | 1, [0x9d, 0x01, 0x2a])), /key frame/],
		['a VP8 start code that is wrong', webpOf(vp8With(KEY, [0x9d, 0x01, 0x2b])), /no start code/],
		['a VP8 version it does not have', webpOf(vp8With(KEY | (5 << 1), [0x9d, 0x01, 0x2a])), /version VP8 does not have/],
		['a VP8 partition longer than its data', webpOf(vp8With((99 << 5) | (1 << 4), [0x9d, 0x01, 0x2a])), /shorter than it says/],
		['a VP8L signature that is wrong', webpOf(riffChunk('VP8L', [0x2e, 0, 0, 0, 0, 0, 0])), /VP8L data has no signature/],
		['a VP8L version it does not have', webpOf(riffChunk('VP8L', [0x2f, ...le32(0x20000000), 0, 0])), /version VP8L does not have/],
		['an image that is not the size of its canvas', webpOf(vp8x(3, 3), vp8l(2, 2)), /not the size its canvas says/]
	] as const)('is refused 400 for %s', (_what, input, message) => {
		expect(invalid(input, 'image/webp')).toMatch(message);
	});
});

// ─── Size ───────────────────────────────────────────────────────────────────

describe('the size ceiling', () => {
	it('refuses more than 8000 pixels on a side or 40 megapixels in all, and passes 8000 x 5000', () => {
		expect([MAX_SIDE, MAX_PIXELS]).toEqual([8000, 40_000_000]);
		expect(invalid(png({ width: 8001, height: 1 }), 'image/png')).toBe(
			'The image is 8001 x 1 pixels: the most accepted is 8000 on a side and 40,000,000 in all'
		);
		expect(invalid(png({ width: 1, height: 8001 }), 'image/png')).toMatch(/1 x 8001 pixels/);
		expect(invalid(png({ width: 7000, height: 7000 }), 'image/png')).toMatch(/7000 x 7000 pixels/);
		expect(invalid(webpOf(vp8x(8001, 1), vp8l(8001, 1)), 'image/webp')).toMatch(/8001 x 1 pixels/);
		expect(accepted(png({ width: 8000, height: 5000 }), 'image/png')).toMatchObject({ width: 8000, height: 5000 });
	});
});

// ─── Bytes nobody would write ───────────────────────────────────────────────

/** A valid file of each kind, with something to strip in most. */
const SAMPLES: [string, Bytes, ImageType][] = [
	['PNG', png({ before: [pngChunk('tEXt', 'a\0b'), pngChunk('sRGB', [0])], idat: 2 }), 'image/png'],
	['baseline JPEG', jpeg({ before: [JFIF, jpegSegment(0xe1, 'Exif\0\0x')] }), 'image/jpeg'],
	['progressive JPEG', jpeg({ progressive: true, restarts: true, between: [jpegSegment(0xfe, 'x')] }), 'image/jpeg'],
	['GIF', gif({ before: [GRAPHIC_CONTROL, LOOP, gifExtension(0xfe, 'x')] }), 'image/gif'],
	['lossless WebP', webp('lossless'), 'image/webp'],
	['lossy WebP', webp('lossy'), 'image/webp'],
	['extended WebP', webpOf(vp8x(2, 2, 0x38), riffChunk('ICCP', 'icc'), riffChunk('ALPH', [0]), vp8(2, 2), riffChunk('EXIF', 'x')), 'image/webp']
];

/** A seeded generator (mulberry32), so a failure can be run again. */
function seeded(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe('bytes nobody would write', () => {
	it('refuses every truncation of each valid file, and never throws', () => {
		const accepted: string[] = [];
		for (const [what, sample, type] of SAMPLES) {
			expect(checkImage(sample, type).ok, what).toBe(true);
			for (let length = 0; length < sample.length; length++) {
				if (checkImage(sample.subarray(0, length), type).ok) accepted.push(`${what} cut to ${length} of ${sample.length}`);
			}
		}
		expect(accepted).toEqual([]);
	});

	it('answers seeded random bytes and seeded changes to each file with an image or a refusal, never a throw, in bounded time', () => {
		const random = seeded(2754);
		const byte = () => Math.floor(random() * 256);
		const MAGIC: Record<ImageType, Bytes> = {
			'image/png': Uint8Array.from(PNG_SIGNATURE),
			'image/jpeg': bytes(0xff, 0xd8, 0xff),
			'image/gif': bytes('GIF89a'),
			'image/webp': bytes('RIFF', le32(64), 'WEBP')
		};
		const inputs: [Bytes, ImageType][] = [];
		for (const type of Object.keys(MAGIC) as ImageType[]) {
			for (let n = 0; n < 300; n++) {
				const tail = Array.from({ length: Math.floor(random() * 200) }, byte);
				inputs.push([bytes(MAGIC[type], tail), type]);
			}
		}
		for (const [, sample, type] of SAMPLES) {
			for (let n = 0; n < 300; n++) {
				const changed = sample.slice();
				const changes = 1 + Math.floor(random() * 4);
				for (let c = 0; c < changes; c++) changed[Math.floor(random() * changed.length)] = byte();
				inputs.push([changed, type]);
			}
		}

		const thrown: string[] = [];
		const notStable: string[] = [];
		const start = Date.now();
		for (const [input, type] of inputs) {
			try {
				const result = checkImage(input, type);
				if (result.ok) {
					const again = checkImage(result.bytes, type);
					if (!again.ok || Buffer.compare(Buffer.from(again.bytes), Buffer.from(result.bytes)) !== 0) {
						notStable.push(Buffer.from(input).toString('hex'));
					}
				} else {
					expect([400, 415]).toContain(result.status);
				}
			} catch (err) {
				thrown.push(`${Buffer.from(input).toString('hex')}: ${err instanceof Error ? err.stack : String(err)}`);
			}
		}

		expect(thrown).toEqual([]);
		// What is accepted, once stripped, is accepted again unchanged.
		expect(notStable).toEqual([]);
		expect(Date.now() - start).toBeLessThan(10_000);
	});
});

// ─── A JPEG's orientation (card 2761) ───────────────────────────────────────

describe("a JPEG's orientation, kept from its EXIF (card 2761, D4)", () => {
	// Written out byte by byte from the plan's D4, not built by anything under test: FF E1, the length 0x0022,
	// Exif\0\0, the TIFF header with IFD0 at 8, one entry (0x0112, SHORT, count 1, the value 6), next IFD 0.
	const KEPT_II = bytes(
		[0xff, 0xe1, 0x00, 0x22],
		[0x45, 0x78, 0x69, 0x66, 0x00, 0x00],
		[0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00],
		[0x01, 0x00],
		[0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00],
		[0x00, 0x00, 0x00, 0x00]
	);
	const KEPT_MM = bytes(
		[0xff, 0xe1, 0x00, 0x22],
		[0x45, 0x78, 0x69, 0x66, 0x00, 0x00],
		[0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08],
		[0x00, 0x01],
		[0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00],
		[0x00, 0x00, 0x00, 0x00]
	);
	/** Whether `part` is anywhere in `whole`. */
	const holds = (whole: Bytes, part: Bytes) => Buffer.from(whole).indexOf(Buffer.from(part)) >= 0;
	/** Each APP1 segment kept, whole. */
	const app1s = (input: Bytes): Bytes[] => {
		const found: Bytes[] = [];
		for (let at = 2; at < input.length && input[at + 1] !== 0xda; at += 2 + input[at + 2] * 256 + input[at + 3]) {
			if (input[at + 1] === 0xe1) found.push(input.subarray(at, at + 2 + input[at + 2] * 256 + input[at + 3]));
		}
		return found;
	};

	it('8. keeps orientation 6 of a phone photo, in II and in MM, as the one 36-byte APP1 of D4, in its place, and nothing else of the EXIF', () => {
		const plain = accepted(jpeg(), 'image/jpeg').bytes;
		for (const [order, kept] of [
			['II', KEPT_II],
			['MM', KEPT_MM]
		] as const) {
			const exif = phoneExif({ order });
			const result = accepted(phoneJpeg({ order }), 'image/jpeg');

			expect(app1s(result.bytes), order).toEqual([kept]);
			// In the EXIF segment's place: straight after JFIF, before the tables.
			expect(jpegMarkers(result.bytes), order).toEqual([0xd8, 0xe0, 0xe1, 0xdb, 0xc0, 0xc4, 0xda, 0xd9]);
			expect(result.bytes.subarray(20, 56), order).toEqual(kept);
			// No byte of the make, the model, the date, the GPS IFD, the position or the thumbnail left.
			for (const [what, part] of [
				['make', bytes(EXIF_MAKE)],
				['model', bytes(EXIF_MODEL)],
				['date', bytes(EXIF_DATE)],
				['GPS IFD', exif.gps],
				['position', exif.position],
				['thumbnail', EXIF_THUMBNAIL]
			] as const) {
				expect(holds(result.bytes, part), `${order}: ${what}`).toBe(false);
			}
			expect(text(result.bytes), order).not.toMatch(/secret|Pixelphone/);
			// The rest of the file is the photo without its EXIF.
			expect(Buffer.compare(Buffer.concat([result.bytes.subarray(0, 20), result.bytes.subarray(56)]), Buffer.from(plain)), order).toBe(0);
		}
	});

	it('9. drops the EXIF and accepts the photo for every arm that is not exactly an orientation of 2 to 8; the first EXIF APP1 alone is read', () => {
		const plain = Buffer.from(accepted(jpeg(), 'image/jpeg').bytes);
		const arms: [string, ExifOptions][] = [
			['value 1, the default', { orientation: 1 }],
			['value 9, which EXIF does not have', { orientation: 9 }],
			['no orientation entry', { orientation: null }],
			['the orientation entry twice', { orientationAgain: 6 }],
			['type 4 (LONG)', { orientationType: 4 }],
			['count 2', { orientationCount: 2 }],
			['an IFD0 offset of 4', { ifd0Offset: 4 }],
			['an IFD0 past the segment', { ifd0Offset: 100_000 }],
			['an IFD0 of 0 entries', { ifd0Count: 0 }],
			// The code review's CR3: a count no segment can hold, and entries that fit with only the next IFD's offset outside.
			['an IFD0 of 0xffff entries', { ifd0Count: 0xffff }],
			['an IFD0 whose next-IFD offset alone is past the segment', { cutAfterIfd0Entries: 2 }],
			['a header II+\\0', { header: bytes('II+\0') }]
		];
		for (const [what, options] of arms) {
			for (const order of ['II', 'MM'] as const) {
				const result = checkImage(phoneJpeg({ order, ...options }), 'image/jpeg');
				expect(result.ok, `${what}, ${order}: ${(result as RefusedImage).message}`).toBe(true);
				const kept = (result as CheckedImage).bytes;
				expect(app1s(kept), `${what}, ${order}`).toEqual([]);
				expect(Buffer.compare(Buffer.from(kept), plain), `${what}, ${order}`).toBe(0);
			}
		}

		// The bound the last arm meets: with the whole of the next-IFD offset inside, the orientation is kept.
		expect(app1s(accepted(phoneJpeg({ cutAfterIfd0Entries: 4 }), 'image/jpeg').bytes)).toEqual([KEPT_II]);

		// A second EXIF APP1, of orientation 3, after a first of 6: the first wins, kept once.
		const twice = accepted(phoneJpeg({ order: 'II' }, [jpegSegment(0xe1, phoneExif({ order: 'MM', orientation: 3 }).body)]), 'image/jpeg');
		expect(app1s(twice.bytes)).toEqual([KEPT_II]);
		// And a first that is dropped does not let a second be read.
		const afterDropped = accepted(phoneJpeg({ order: 'II', orientation: 1 }, [jpegSegment(0xe1, phoneExif({ order: 'II', orientation: 3 }).body)]), 'image/jpeg');
		expect(app1s(afterDropped.bytes)).toEqual([]);
	});

	it('10. answers seeded changes inside the EXIF APP1 with an image or a refusal, never a throw, in bounded time; and checks what it keeps to itself', () => {
		const random = seeded(2761);
		const byte = () => Math.floor(random() * 256);
		const fixtures = (['II', 'MM'] as const).flatMap((order) => [
			phoneJpeg({ order }),
			phoneJpeg({ order, orientation: 3 }),
			phoneJpeg({ order, orientationAgain: 8 }),
			phoneJpeg({ order }, [jpegSegment(0xe1, phoneExif({ order, orientation: 5 }).body)])
		]);
		const inputs: Bytes[] = [];
		for (const fixture of fixtures) {
			// The first APP1's body, after its marker and length: straight after JFIF's 18 bytes.
			const from = 2 + 18 + 4;
			const to = 2 + 18 + 2 + fixture[2 + 18 + 2] * 256 + fixture[2 + 18 + 3];
			expect(fixture[2 + 18 + 1]).toBe(0xe1);
			for (let n = 0; n < 400; n++) {
				const changed = fixture.slice();
				const changes = 1 + Math.floor(random() * 4);
				for (let c = 0; c < changes; c++) changed[from + Math.floor(random() * (to - from))] = byte();
				inputs.push(changed);
			}
		}

		const thrown: string[] = [];
		const notStable: string[] = [];
		let kept = 0;
		const start = Date.now();
		for (const input of inputs) {
			try {
				const result = checkImage(input, 'image/jpeg');
				if (!result.ok) {
					expect([400, 415]).toContain(result.status);
					continue;
				}
				if (app1s(result.bytes).length > 0) kept++;
				const again = checkImage(result.bytes, 'image/jpeg');
				if (!again.ok || Buffer.compare(Buffer.from(again.bytes), Buffer.from(result.bytes)) !== 0) notStable.push(Buffer.from(input).toString('hex'));
			} catch (err) {
				thrown.push(`${Buffer.from(input).toString('hex')}: ${err instanceof Error ? err.stack : String(err)}`);
			}
		}

		expect(thrown).toEqual([]);
		expect(notStable).toEqual([]);
		// The changes reach the reader on both sides: some keep an orientation, and some drop it.
		expect(kept).toBeGreaterThan(0);
		expect(kept).toBeLessThan(inputs.length);
		expect(Date.now() - start).toBeLessThan(10_000);
	});

	// The code review's CS1: what a phone appends after the primary image is cut off, and the primary stripped as any other.
	/** `input` checked, the answer the stripped primary alone, its orientation kept, and checked again to itself. */
	const cutTo = (input: Bytes, primary: Bytes, what: string) => {
		const result = accepted(input, 'image/jpeg');
		expect(Buffer.compare(Buffer.from(result.bytes), Buffer.from(accepted(primary, 'image/jpeg').bytes)), what).toBe(0);
		expect(Buffer.compare(Buffer.from(accepted(result.bytes, 'image/jpeg').bytes), Buffer.from(result.bytes)), `${what}, again`).toBe(0);
		return result.bytes;
	};

	it('14. cuts an Ultra HDR or MPF gain map after the primary image: an MPF APP2 dropped, the second JPEG after EOI gone, the orientation kept', () => {
		// The MPF index (APP2 "MPF\0", a TIFF of its own) in the primary, and the gain map, a whole second JPEG with
		// EXIF and a position of its own, after the primary's EOI.
		const mpf = jpegSegment(0xe2, bytes('MPF\0', 'MM', 0x00, 0x2a, be32(8), be16(1), be16(0xb000), be16(7), be32(4), '0100', be32(0), 'secret-mp-index'));
		const gainMap = phoneJpeg({ order: 'MM', orientation: 3 });
		const exif = phoneExif({ order: 'II' });
		const primary = phoneJpeg({ order: 'II' }, [mpf]);

		const kept = cutTo(bytes(primary, gainMap), phoneJpeg({ order: 'II' }), 'MPF and gain map');
		expect(app1s(kept)).toEqual([KEPT_II]);
		expect(jpegMarkers(kept)).toEqual([0xd8, 0xe0, 0xe1, 0xdb, 0xc0, 0xc4, 0xda, 0xd9]);
		for (const [what, part] of [
			['MPF', bytes('MPF\0')],
			['position', exif.position],
			['GPS IFD', exif.gps],
			['make', bytes(EXIF_MAKE)],
			['thumbnail', EXIF_THUMBNAIL]
		] as const) {
			expect(holds(kept, part), what).toBe(false);
		}
		// One EOI, at the end: nothing of the gain map after it.
		expect(kept.subarray(-2)).toEqual(bytes(0xff, 0xd9));
		expect(Buffer.from(kept).indexOf(Buffer.from([0xff, 0xd9]))).toBe(kept.length - 2);
	});

	it("15. cuts a motion photo's video, a trailer, a byte and a second file after EOI, and keeps refusing every other fault", () => {
		const exif = phoneExif({ order: 'MM' });
		const video = bytes(be32(0x18), 'ftypmp42', be32(0), 'mp42isom', be32(0x20), 'mdat', 'secret-video-frames', exif.position);
		const kept = cutTo(bytes(phoneJpeg({ order: 'MM' }), video), phoneJpeg({ order: 'MM' }), 'a motion photo');
		expect(app1s(kept)).toEqual([KEPT_MM]);
		expect(text(kept)).not.toMatch(/ftyp|mdat|secret/);
		expect(holds(kept, exif.position)).toBe(false);

		// A Samsung-style trailer, one byte, and a second file: each cut off.
		cutTo(bytes(jpeg(), 'SEFH', le32(1), 'secret-trailer', 'SEFT'), jpeg(), 'a trailer');
		cutTo(bytes(jpeg(), 0), jpeg(), 'a byte');
		cutTo(bytes(jpeg(), png()), jpeg(), 'a second file');

		// Only what follows EOI is cut: a primary image cut short, or a byte between its segments, is still refused,
		// and a PNG with a byte after IEND is still refused.
		expect(invalid(bytes(jpeg().subarray(0, jpeg().length - 2), video), 'image/jpeg')).toMatch(/not a marker|ends|marker/);
		expect(invalid(bytes([0xff, 0xd8], JFIF, 0x00, jpeg({ before: [] }).subarray(2), video), 'image/jpeg')).toMatch(/not a marker/);
		expect(invalid(bytes(png(), 0), 'image/png')).toMatch(/bytes after IEND/);
	});
});
