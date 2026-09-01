import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SAGE = [144, 172, 154, 255];
const INK = [54, 54, 54, 255];
const CLEAR = [0, 0, 0, 0];
const ENVELOPE_RIGHT_INNER_EDGE = 0.78;
const SMOKE_RIGHT_LIMIT = 0.735;
const SMOKE_STROKE_HALF_WIDTH = 0.021;

const crcTable = (() => {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i += 1) {
		let value = i;
		for (let bit = 0; bit < 8; bit += 1) {
			value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		}
		table[i] = value >>> 0;
	}
	return table;
})();

function crc32(buffer) {
	let crc = 0xffffffff;
	for (const byte of buffer) {
		crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const header = Buffer.from(type);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([header, data])));
	return Buffer.concat([length, header, data, crc]);
}

function encodePng(width, height, paint) {
	const raw = Buffer.alloc((width * 4 + 1) * height);
	for (let y = 0; y < height; y += 1) {
		const row = y * (width * 4 + 1);
		raw[row] = 0;
		for (let x = 0; x < width; x += 1) {
			const [r, g, b, a] = paint(x, y, width, height);
			const i = row + 1 + x * 4;
			raw[i] = r;
			raw[i + 1] = g;
			raw[i + 2] = b;
			raw[i + 3] = a;
		}
	}

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;

	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw, { level: 9 })),
		chunk('IEND', Buffer.alloc(0))
	]);
}

function distToRoundedRect(x, y, size, radius) {
	const dx = Math.abs(x - (size - 1) / 2) - (size / 2 - radius);
	const dy = Math.abs(y - (size - 1) / 2) - (size / 2 - radius);
	const ox = Math.max(dx, 0);
	const oy = Math.max(dy, 0);
	return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - radius;
}

function envelopeInk(nx, ny) {
	if (nx < 0.18 || nx > 0.82 || ny < 0.22 || ny > 0.74) return false;

	const onBorder =
		(ny >= 0.22 && ny <= 0.26 && nx >= 0.18 && nx <= 0.82) ||
		(ny >= 0.7 && ny <= 0.74 && nx >= 0.18 && nx <= 0.82) ||
		(nx >= 0.18 && nx <= 0.22 && ny >= 0.22 && ny <= 0.74) ||
		(nx >= ENVELOPE_RIGHT_INNER_EDGE && nx <= 0.82 && ny >= 0.22 && ny <= 0.74);

	const flap = Math.abs(ny - (0.24 + 0.28 * (1 - Math.abs((nx - 0.5) * 2.2)))) < 0.035;
	const inFlapBand = ny >= 0.24 && ny <= 0.54 && nx >= 0.2 && nx <= 0.8;

	return onBorder || (flap && inFlapBand);
}

function segmentDistance(px, py, ax, ay, bx, by) {
	const dx = bx - ax;
	const dy = by - ay;
	const lengthSquared = dx * dx + dy * dy;
	const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
	return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function cubicPoint(start, controlA, controlB, end, t) {
	const inverse = 1 - t;
	return [
		inverse ** 3 * start[0] +
			3 * inverse ** 2 * t * controlA[0] +
			3 * inverse * t ** 2 * controlB[0] +
			t ** 3 * end[0],
		inverse ** 3 * start[1] +
			3 * inverse ** 2 * t * controlA[1] +
			3 * inverse * t ** 2 * controlB[1] +
			t ** 3 * end[1]
	];
}

function smokeSignalCoverage(nx, ny, size) {
	const curves = [
		[
			[0.61, 0.7],
			[0.72, 0.67],
			[0.64, 0.57],
			[0.71, 0.52]
		],
		[
			[0.71, 0.52],
			[SMOKE_RIGHT_LIMIT, 0.47],
			[0.65, 0.39],
			[0.72, 0.3]
		]
	];
	let distance = Number.POSITIVE_INFINITY;
	for (const curve of curves) {
		let previous = curve[0];
		for (let step = 1; step <= 32; step += 1) {
			const point = cubicPoint(curve[0], curve[1], curve[2], curve[3], step / 32);
			distance = Math.min(
				distance,
				segmentDistance(nx, ny, previous[0], previous[1], point[0], point[1])
			);
			previous = point;
		}
	}
	const antialias = 1.25 / size;
	return Math.max(
		0,
		Math.min(1, (SMOKE_STROKE_HALF_WIDTH + antialias - distance) / (2 * antialias))
	);
}

function blend(background, foreground, coverage) {
	return background.map((channel, index) =>
		index === 3 ? 255 : Math.round(channel * (1 - coverage) + foreground[index] * coverage)
	);
}

function paintAppIcon(x, y, size) {
	const radius = size * 0.26;
	const outside = distToRoundedRect(x + 0.5, y + 0.5, size, radius);
	if (outside > 0.6) return CLEAR;
	if (outside > -0.6) {
		const t = 1 - (outside + 0.6) / 1.2;
		return [SAGE[0], SAGE[1], SAGE[2], Math.round(255 * t)];
	}
	const nx = x / (size - 1);
	const ny = y / (size - 1);
	if (envelopeInk(nx, ny)) return INK;
	return blend(SAGE, INK, smokeSignalCoverage(nx, ny, size));
}

function paintMaskable(x, y, size) {
	const pad = 0.18;
	const nx = (x / (size - 1) - pad) / (1 - pad * 2);
	const ny = (y / (size - 1) - pad) / (1 - pad * 2);
	if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return SAGE;
	if (envelopeInk(nx, ny)) return INK;
	return blend(SAGE, INK, smokeSignalCoverage(nx, ny, size * (1 - pad * 2)));
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'static', 'icons');
mkdirSync(outDir, { recursive: true });

writeFileSync(join(outDir, 'icon-192.png'), encodePng(192, 192, paintAppIcon));
writeFileSync(join(outDir, 'icon-512.png'), encodePng(512, 512, paintAppIcon));
writeFileSync(join(outDir, 'apple-touch-icon.png'), encodePng(180, 180, paintAppIcon));
writeFileSync(join(outDir, 'icon-maskable-512.png'), encodePng(512, 512, paintMaskable));

const LIGHT_BG = [250, 250, 250, 255];
const DARK_BG = [14, 14, 16, 255];
const splashes = [
	[1170, 2532],
	[1179, 2556],
	[1290, 2796]
];

for (const [width, height] of splashes) {
	writeFileSync(
		join(outDir, `splash-${width}x${height}.png`),
		encodePng(width, height, () => LIGHT_BG)
	);
	writeFileSync(
		join(outDir, `splash-${width}x${height}-dark.png`),
		encodePng(width, height, () => DARK_BG)
	);
}

console.log('Wrote PWA icons and iOS splash screens to static/icons');
