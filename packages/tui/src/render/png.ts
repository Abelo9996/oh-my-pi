/**
 * Minimal PNG chunk framing and row cropping for terminal image protocols.
 *
 * iTerm2 places a whole file and cannot clip it, so a placement whose top rows
 * left the live viewport is re-sent as a top-cropped PNG (see `TUI`'s direct
 * placement writer). Only the scanline stream is touched: pixels are never
 * resampled, so the visible slice stays pixel-identical to the original.
 */
import * as zlib from "node:zlib";

export const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** Bits per sample multiplier for each PNG color type. */
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Frame a PNG chunk: 4-byte big-endian length, type+data, then the CRC-32 of type+data. */
export function pngChunk(type: string, data: Uint8Array): Uint8Array {
	const out = Buffer.alloc(data.byteLength + 12);
	out.writeUInt32BE(data.byteLength, 0);
	out.write(type, 4, 4, "latin1");
	out.set(data, 8);
	out.writeUInt32BE(Bun.hash.crc32(out.subarray(4, 8 + data.byteLength)) >>> 0, 8 + data.byteLength);
	return out;
}

interface Chunk {
	type: string;
	data: Uint8Array;
}

function readChunks(png: Uint8Array): Chunk[] | null {
	if (png.byteLength < PNG_SIGNATURE.byteLength || PNG_SIGNATURE.some((byte, i) => png[i] !== byte)) return null;
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	const chunks: Chunk[] = [];
	for (let offset = PNG_SIGNATURE.byteLength; offset + 12 <= png.byteLength;) {
		const length = view.getUint32(offset);
		const end = offset + 12 + length;
		if (end > png.byteLength) return null;
		const type = String.fromCharCode(png[offset + 4]!, png[offset + 5]!, png[offset + 6]!, png[offset + 7]!);
		chunks.push({ type, data: png.subarray(offset + 8, offset + 8 + length) });
		if (type === "IEND") return chunks;
		offset = end;
	}
	return null;
}

function paeth(left: number, up: number, upLeft: number): number {
	const p = left + up - upLeft;
	const pa = Math.abs(p - left);
	const pb = Math.abs(p - up);
	const pc = Math.abs(p - upLeft);
	return pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
}

/**
 * `png` without its first `rows` pixel rows. Pixels are kept exactly; the
 * first kept scanline is re-emitted unfiltered and the rest keep their
 * original filters, since each only references the unchanged row above it.
 * Chunks before the image data (palette, transparency, color space) are kept;
 * chunks after it are dropped. An animated PNG becomes a static crop of its
 * default image: its frame controls describe the uncropped canvas.
 *
 * Returns `null` for anything it cannot rewrite exactly: not a PNG, an
 * interlaced or malformed stream, or a crop that leaves no rows.
 */
export function cropPngTop(png: Uint8Array, rows: number): Uint8Array | null {
	const chunks = readChunks(png);
	const header = chunks?.[0];
	if (!chunks || header?.type !== "IHDR" || header.data.byteLength !== 13) return null;
	const ihdr = new DataView(header.data.buffer, header.data.byteOffset, header.data.byteLength);
	const width = ihdr.getUint32(0);
	const height = ihdr.getUint32(4);
	const channels = CHANNELS[header.data[9]!];
	if (channels === undefined || header.data[10] !== 0 || header.data[11] !== 0 || header.data[12] !== 0) return null;
	if (!Number.isSafeInteger(rows) || rows < 0 || rows >= height) return null;
	if (rows === 0) return png;

	const bitsPerPixel = channels * header.data[8]!;
	const bpp = Math.max(1, bitsPerPixel >> 3);
	const stride = Math.ceil((width * bitsPerPixel) / 8);
	const firstIdat = chunks.findIndex(chunk => chunk.type === "IDAT");
	if (firstIdat < 0) return null;
	let raw: Uint8Array;
	try {
		raw = zlib.inflateSync(Buffer.concat(chunks.filter(chunk => chunk.type === "IDAT").map(chunk => chunk.data)));
	} catch {
		return null;
	}
	if (raw.byteLength < height * (stride + 1)) return null;

	// Reconstruct rows 0..rows: the first kept row's filter references the
	// reconstructed row above it, which the cropped stream no longer carries.
	let previous = new Uint8Array(stride);
	let current = new Uint8Array(stride);
	for (let y = 0; y <= rows; y++) {
		const base = y * (stride + 1);
		const filter = raw[base];
		for (let x = 0; x < stride; x++) {
			const value = raw[base + 1 + x]!;
			const left = x >= bpp ? current[x - bpp]! : 0;
			const up = previous[x]!;
			switch (filter) {
				case 0:
					current[x] = value;
					break;
				case 1:
					current[x] = value + left;
					break;
				case 2:
					current[x] = value + up;
					break;
				case 3:
					current[x] = value + ((left + up) >> 1);
					break;
				case 4:
					current[x] = value + paeth(left, up, x >= bpp ? previous[x - bpp]! : 0);
					break;
				default:
					return null;
			}
		}
		[previous, current] = [current, previous];
	}

	const kept = height - rows;
	const scanlines = new Uint8Array(kept * (stride + 1));
	scanlines.set(previous, 1);
	scanlines.set(raw.subarray((rows + 1) * (stride + 1), height * (stride + 1)), stride + 1);
	const cropped = new Uint8Array(header.data);
	new DataView(cropped.buffer).setUint32(4, kept);
	return Buffer.concat([
		PNG_SIGNATURE,
		pngChunk("IHDR", cropped),
		...chunks
			.slice(1, firstIdat)
			.filter(chunk => chunk.type !== "acTL" && chunk.type !== "fcTL")
			.map(chunk => pngChunk(chunk.type, chunk.data)),
		pngChunk("IDAT", zlib.deflateSync(scanlines)),
		pngChunk("IEND", new Uint8Array(0)),
	]);
}
