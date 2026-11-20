// shared helpers: hand-rolled RGBA samples + independent reference implementations
"use strict";

// pack/unpack matching RgbQuant's i32 layout (A<<24 | B<<16 | G<<8 | R)
function rgba(r, g, b, a) {
	return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

function unpack(i32) {
	return [i32 & 0xff, (i32 & 0xff00) >> 8, (i32 & 0xff0000) >> 16, (i32 & 0xff000000) >>> 24];
}

// ImageData-like plain object
function imgd(pixels /*array of [r,g,b,a]*/, width, height) {
	var data = new Uint8Array(pixels.length * 4);
	pixels.forEach(function(px, i) {
		data[i * 4] = px[0];
		data[i * 4 + 1] = px[1];
		data[i * 4 + 2] = px[2];
		data[i * 4 + 3] = px[3];
	});
	return {data: data, width: width, height: height};
}

function u32img(pixels, width, height) {
	var buf = new Uint32Array(pixels.length);
	pixels.forEach(function(px, i) {
		buf[i] = rgba(px[0], px[1], px[2], px[3]);
	});
	return {buf32: buf, width: width, height: height, data: new Uint8Array(buf.buffer)};
}

// deterministic PRNG (LCG)
function prng(seed) {
	var s = seed >>> 0;
	return function() {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 0x100000000;
	};
}

function randomPixels(n, seed, withAlpha) {
	var rnd = prng(seed), out = [];
	for (var i = 0; i < n; i++) {
		out.push([
			(rnd() * 256) | 0,
			(rnd() * 256) | 0,
			(rnd() * 256) | 0,
			withAlpha ? (rnd() < 0.25 ? 0 : 128 + ((rnd() * 128) | 0)) : 255,
		]);
	}
	return out;
}

// ---- independent reference implementations (same spec, separate code) ----

var Pr = 0.2126, Pg = 0.7152, Pb = 0.0722;
var EUCL_MAX = Math.sqrt(Pr * 255 * 255 + Pg * 255 * 255 + Pb * 255 * 255);

function refDist(rgb0, rgb1) {
	var rd = rgb1[0] - rgb0[0], gd = rgb1[1] - rgb0[1], bd = rgb1[2] - rgb0[2];
	return Math.sqrt(Pr * rd * rd + Pg * gd * gd + Pb * bd * bd) / EUCL_MAX;
}

// naive nearest-palette-index scan (skips entries whose alpha <= thresh)
function refNearest(r, g, b, palette /*[[r,g,b,a]]*/, thresh) {
	var min = Infinity, idx = -1;
	for (var i = 0; i < palette.length; i++) {
		if (palette[i][3] <= thresh) continue;
		var d = refDist([r, g, b], palette[i]);
		if (d < min) {
			min = d;
			idx = i;
		}
	}
	return idx;
}

var REF_KERNELS = {
	FloydSteinberg: [
		[7 / 16, 1, 0],
		[3 / 16, -1, 1],
		[5 / 16, 0, 1],
		[1 / 16, 1, 1]
	],
	SierraLite: [
		[2 / 4, 1, 0],
		[1 / 4, -1, 1],
		[1 / 4, 0, 1],
	],
};

// reference error-diffusion dither.
// contract: transparent pixels (alpha <= thresh) are written as transparent black
// and never emit error; error may land on them but is discarded there.
function refDither(px32, width, height, kernel, serpentine, palette, dithDelta, thresh) {
	var buf = new Uint32Array(px32); // operate on a copy
	var ds = REF_KERNELS[kernel];
	var dir = serpentine ? -1 : 1;

	for (var y = 0; y < height; y++) {
		if (serpentine) dir = -dir;
		var lni = y * width;

		for (var x = (dir == 1 ? 0 : width - 1), xend = (dir == 1 ? width : 0); x !== xend; x += dir) {
			var idx = lni + x,
				i32 = buf[idx],
				a = (i32 & 0xff000000) >>> 24;

			if (a <= thresh) {
				buf[idx] = 0;
				continue;
			}

			var r1 = i32 & 0xff,
				g1 = (i32 & 0xff00) >> 8,
				b1 = (i32 & 0xff0000) >> 16;

			var ni = refNearest(r1, g1, b1, palette, thresh),
				pr = palette[ni][0],
				pg = palette[ni][1],
				pb = palette[ni][2];

			buf[idx] = rgba(pr, pg, pb, 255);

			if (dithDelta) {
				if (refDist([r1, g1, b1], [pr, pg, pb]) < dithDelta)
					continue;
			}

			var er = r1 - pr, eg = g1 - pg, eb = b1 - pb;

			for (var i = (dir == 1 ? 0 : ds.length - 1), end = (dir == 1 ? ds.length : 0); i !== end; i += dir) {
				var x1 = ds[i][1] * dir,
					y1 = ds[i][2];

				if (x1 + x >= 0 && x1 + x < width && y1 + y >= 0 && y1 + y < height) {
					var d = ds[i][0],
						idx2 = idx + (y1 * width + x1),
						r3 = buf[idx2] & 0xff,
						g3 = (buf[idx2] & 0xff00) >> 8,
						b3 = (buf[idx2] & 0xff0000) >> 16;

					var r4 = Math.max(0, Math.min(255, r3 + er * d)),
						g4 = Math.max(0, Math.min(255, g3 + eg * d)),
						b4 = Math.max(0, Math.min(255, b3 + eb * d));

					// receiving pixel keeps its own alpha
					buf[idx2] = rgba(r4, g4, b4, (buf[idx2] & 0xff000000) >>> 24);
				}
			}
		}
	}

	return buf;
}

// reference histogram for method 1 (global counts) under a given alpha mode
function refHistogram(pixels, alphaMode, alphaThreshold) {
	var hist = {}, trans = 0;
	pixels.forEach(function(px) {
		var r = px[0], g = px[1], b = px[2], a = px[3];
		if (alphaMode == "premultiply") {
			if (a < 255) {
				if (a == 0) { r = g = b = 0; }
				else {
					r = Math.round(r * a / 255);
					g = Math.round(g * a / 255);
					b = Math.round(b * a / 255);
				}
				a = 255;
			}
		}
		else if (alphaMode == "transparent") {
			if (a <= alphaThreshold) { trans++; return; }
			a = 255;
		}
		else {
			if (a == 0) return;
		}
		var k = rgba(r, g, b, a);
		hist[k] = (hist[k] || 0) + 1;
	});
	return {hist: hist, trans: trans};
}

// extract a tile of pixels (row-major [r,g,b,a] quads)
function crop(pixels, fullW, x, y, w, h) {
	var out = [];
	for (var j = 0; j < h; j++)
		for (var i = 0; i < w; i++)
			out.push(pixels[(y + j) * fullW + (x + i)]);
	return out;
}

module.exports = {
	rgba: rgba,
	unpack: unpack,
	imgd: imgd,
	u32img: u32img,
	prng: prng,
	randomPixels: randomPixels,
	refDist: refDist,
	refNearest: refNearest,
	refDither: refDither,
	refHistogram: refHistogram,
	crop: crop,
};
