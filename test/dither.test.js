// error-diffusion dithering: reference equivalence, transparent isolation, reproducibility
"use strict";

var assert = require("assert");
var RgbQuant = require("../src/rgbquant.js");
var H = require("./helpers.js");

var PAL_BW = [[0, 0, 0, 255], [255, 255, 255, 255]];
var PAL_BWT = [[0, 0, 0, 0], [0, 0, 0, 255], [255, 255, 255, 255]];

function grayImg(vals, width, height, alpha) {
	var pixels = vals.map(function(v) { return [v, v, v, alpha == null ? 255 : alpha]; });
	return H.u32img(pixels, width, height);
}

function runDither(q, img, kernel, serp) {
	return new Uint32Array(q.reduce(img.data, 1, kernel, serp, img.width).buffer);
}

["FloydSteinberg", "SierraLite"].forEach(function(KERNEL) {
	test("dither " + KERNEL + ": matches independent reference (serpentine off)", function() {
		var vals = [];
		var rnd = H.prng(11);
		for (var i = 0; i < 8 * 5; i++) vals.push((rnd() * 256) | 0);
		var img = grayImg(vals, 8, 5);

		var q = new RgbQuant({palette: [[0, 0, 0], [255, 255, 255]], useCache: false});
		var got = runDither(q, img, KERNEL, false);
		var want = H.refDither(img.buf32, 8, 5, KERNEL, false, PAL_BW, 0, -1);
		assert.deepEqual(Array.from(got), Array.from(want));
	});

	test("dither " + KERNEL + ": matches independent reference (serpentine on)", function() {
		var vals = [];
		var rnd = H.prng(11);
		for (var i = 0; i < 8 * 5; i++) vals.push((rnd() * 256) | 0);
		var img = grayImg(vals, 8, 5);

		var q = new RgbQuant({palette: [[0, 0, 0], [255, 255, 255]], useCache: false});
		var got = runDither(q, img, KERNEL, true);
		var want = H.refDither(img.buf32, 8, 5, KERNEL, true, PAL_BW, 0, -1);
		assert.deepEqual(Array.from(got), Array.from(want));
	});

	test("dither " + KERNEL + ": serpentine changes result but both are deterministic", function() {
		var img = grayImg([100, 100, 100, 100, 100, 100, 100, 100, 100], 3, 3);
		var mk = function() { return new RgbQuant({palette: [[0, 0, 0], [255, 255, 255]], useCache: false}); };

		var a1 = runDither(mk(), img, KERNEL, false);
		var a2 = runDither(mk(), img, KERNEL, false);
		var b1 = runDither(mk(), img, KERNEL, true);
		var b2 = runDither(mk(), img, KERNEL, true);

		assert.deepEqual(Array.from(a1), Array.from(a2), "same input, same kernel -> identical output");
		assert.deepEqual(Array.from(b1), Array.from(b2));
	});

	test("dither " + KERNEL + ": transparent pixels never diffuse error into opaque regions", function() {
		// a transparent pixel with heavy non-zero RGB sits between opaque grays;
		// legacy code would have pushed its RGB error into the neighbors
		var pixels = [
			[128, 128, 128, 255], [200, 100, 50, 0], [128, 128, 128, 255],
			[128, 128, 128, 255], [128, 128, 128, 255], [128, 128, 128, 255],
			[128, 128, 128, 255], [128, 128, 128, 255], [128, 128, 128, 255],
		];
		var img = H.u32img(pixels, 3, 3);

		var q = new RgbQuant({
			palette: [[0, 0, 0], [255, 255, 255], [0, 0, 0, 0]],
			alphaMode: "transparent",
			useCache: false,
		});
		var got = runDither(q, img, KERNEL, false);
		var want = H.refDither(img.buf32, 3, 3, KERNEL, false, PAL_BWT, 0, 0);
		assert.deepEqual(Array.from(got), Array.from(want));

		// the transparent pixel itself stays transparent
		assert.equal(got[1], 0, "transparent pixel stays transparent");
		// its right neighbor (idx 2) is a plain 128-gray quantization: 128 -> white (0.5+ luma... nearest by dist)
		// with zero accumulated error from the transparent pixel
		var refNoTrans = H.refDither(H.u32img([
			[128, 128, 128, 255], [0, 0, 0, 0], [128, 128, 128, 255],
			[128, 128, 128, 255], [128, 128, 128, 255], [128, 128, 128, 255],
			[128, 128, 128, 255], [128, 128, 128, 255], [128, 128, 128, 255],
		]).buf32, 3, 3, KERNEL, false, PAL_BWT, 0, 0);
		assert.equal(got[2], refNoTrans[2], "neighbor unaffected by transparent pixel's RGB");
	});

	test("dither " + KERNEL + ": image edges and 1-pixel-wide/tall images", function() {
		var q = function() { return new RgbQuant({palette: [[0, 0, 0], [255, 255, 255]], useCache: false}); };

		var col = grayImg([10, 200, 30, 240, 90], 1, 5);
		assert.deepEqual(
			Array.from(runDither(q(), col, KERNEL, true)),
			Array.from(H.refDither(col.buf32, 1, 5, KERNEL, true, PAL_BW, 0, -1))
		);

		var row = grayImg([10, 200, 30, 240, 90], 5, 1);
		assert.deepEqual(
			Array.from(runDither(q(), row, KERNEL, true)),
			Array.from(H.refDither(row.buf32, 5, 1, KERNEL, true, PAL_BW, 0, -1))
		);

		var one = grayImg([77], 1, 1);
		assert.deepEqual(
			Array.from(runDither(q(), one, KERNEL, false)),
			Array.from(H.refDither(one.buf32, 1, 1, KERNEL, false, PAL_BW, 0, -1))
		);
	});

	test("dither " + KERNEL + ": repeated reduce on same instance reproduces and does not mutate input", function() {
		var img = grayImg([60, 120, 180, 240, 30, 90, 150, 210, 255], 3, 3);
		var before = new Uint32Array(img.buf32);

		var q = new RgbQuant({palette: [[0, 0, 0], [255, 255, 255]], dithKern: KERNEL, useCache: false});
		var first = q.reduce(img.data, 1, null, null, 3);
		var second = q.reduce(img.data, 1, null, null, 3);

		assert.deepEqual(Array.from(first), Array.from(second), "repeated reduce must reproduce pixel-for-pixel");
		assert.deepEqual(Array.from(img.buf32), Array.from(before), "caller buffer must not be mutated");
	});

	test("dither " + KERNEL + ": dithDelta suppresses small-error diffusion", function() {
		var img = grayImg([250, 250, 250, 250], 2, 2);
		var q = new RgbQuant({
			palette: [[0, 0, 0], [255, 255, 255]],
			dithDelta: 0.5,
			useCache: false,
		});
		var got = runDither(q, img, KERNEL, false);
		var want = H.refDither(img.buf32, 2, 2, KERNEL, false, PAL_BW, 0.5, -1);
		assert.deepEqual(Array.from(got), Array.from(want));
	});
});

test("dither: unknown kernel throws a stable error, instance stays usable", function() {
	var q = new RgbQuant({method: 1});
	q.sample(H.imgd([[255, 0, 0, 255], [255, 0, 0, 255]], 2, 1));
	assert.throws(function() {
		q.reduce(H.imgd([[255, 0, 0, 255]], 1, 1), 1, "NoSuchKernel");
	}, /Unknown dithering kernel/);
	// instance still works afterwards
	var out = q.reduce(H.imgd([[255, 0, 0, 255]], 1, 1));
	assert.deepEqual(Array.from(out), [255, 0, 0, 255]);
});

test("dither: transparent mode without dither matches dithered transparent placement", function() {
	// transparent pixels land on the transparent slot with and without dithering
	var pixels = [
		[10, 10, 10, 255], [0, 0, 0, 0], [250, 250, 250, 255],
		[250, 250, 250, 255], [0, 0, 0, 0], [10, 10, 10, 255],
	];
	var img = H.u32img(pixels, 3, 2);
	var opts = {
		palette: [[0, 0, 0], [255, 255, 255], [0, 0, 0, 0]],
		alphaMode: "transparent",
		useCache: false,
	};
	var q1 = new RgbQuant(opts);
	var plain = q1.reduce(img.data, 2, null, null, 3);
	assert.strictEqual(plain[1], q1.i32idx[q1.transI32]);
	assert.strictEqual(plain[4], q1.i32idx[q1.transI32]);

	var q2 = new RgbQuant(opts);
	var dit = new Uint32Array(q2.reduce(img.data, 1, "FloydSteinberg", false, 3).buffer);
	assert.equal(dit[1], 0);
	assert.equal(dit[4], 0);
});
