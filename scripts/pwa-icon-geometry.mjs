export const ENVELOPE_STROKE_HALF_WIDTH = 0.022;
export const SMOKE_STROKE_HALF_WIDTH = 0.021;

export const ENVELOPE_SEGMENTS = [
	[
		[0.2, 0.24],
		[0.8, 0.24]
	],
	[
		[0.2, 0.24],
		[0.2, 0.72]
	],
	[
		[0.2, 0.72],
		[0.68, 0.72]
	],
	[
		[0.8, 0.24],
		[0.8, 0.48]
	],
	[
		[0.2, 0.26],
		[0.5, 0.52]
	],
	[
		[0.5, 0.52],
		[0.8, 0.26]
	]
];

export const SMOKE_CURVES = [
	[
		[0.75, 0.69],
		[0.84, 0.67],
		[0.8, 0.57],
		[0.86, 0.52]
	],
	[
		[0.86, 0.52],
		[0.91, 0.46],
		[0.82, 0.38],
		[0.88, 0.3]
	]
];

export function segmentDistance(px, py, ax, ay, bx, by) {
	const dx = bx - ax;
	const dy = by - ay;
	const lengthSquared = dx * dx + dy * dy;
	const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
	return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function cubicPoint(start, controlA, controlB, end, t) {
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

export function distanceToEnvelopeCenterline(nx, ny) {
	return Math.min(
		...ENVELOPE_SEGMENTS.map(([start, end]) =>
			segmentDistance(nx, ny, start[0], start[1], end[0], end[1])
		)
	);
}
