// alpha strategies: ignore (legacy), transparent slot, premultiply
"use strict";

var assert = require("assert");
var RgbQuant = require("../src/rgbquant.js");
var H = require("./helpers.js");

var RED = [255, 0, 0, 255],
	GRN = [0, 255, 0, 255],
	BLU = [0, 0, 255, 255],
	TRN = [200, 100, 50, 0];	// transparent, non-zero RGB

test("alpha ignore (legacy default): transparent -> sparse index, transparent-black pixel", function() {
	var q = new RgbQuant({method: 1, colors: 4});
	q.sample(H.imgd([RED, RED, GRN, GRN], 4, 1));

	var idx = q.reduce(H.imgd([RED, TRN, GRN, TRN], 4, 1), 2);
	assert.equal(idx.length, 4);
	assert.strictEqual(idx[1], undefined, "transparent pixel -> sparse hole");
	assert.strictEqual(idx[3], undefined);

	var out = q.reduce(H.imgd([RED, TRN], 2, 1), 1);
	assert.deepEqual(Array.from(out.slice(4, 8)), [0, 0, 0, 0], "transparent -> transparent black");

	// palette contains no transparent entry
	var pal = q.paletteRGBA();
	for (var i = 0; i < pal.length; i += 4)
		assert.equal(pal[i + 3], 255);
});

test("alpha ignore: partial alpha keeps legacy raw-i32 histogram keys", function() {
	var semi = [10, 20, 30, 200];
	var q = new RgbQuant({method: 1});
	q.sample(H.imgd([semi, semi], 2, 1));
	assert.equal(q.histogram[H.rgba(10, 20, 30, 200)], 2, "legacy: raw i32 (with alpha) is the histogram key");
});

test("alpha transparent: single slot, budget, index/palette/expand correspondence", function() {
	var pixels = [RED, RED, RED, GRN, GRN, BLU, TRN, TRN, TRN];
	var q = new RgbQuant({method: 1, colors: 4, alphaMode: "transparent"});
	q.sample(H.imgd(pixels, 9, 1));

	assert.equal(q.transCount, 3);

	var pal = q.paletteRGBA();
	assert.equal(q.hasTrans, true, "transparent slot materializes when the palette is built");
	assert.equal(pal.length / 4, 4, "3 opaque + 1 transparent = colors budget");
	assert.deepEqual(Array.from(pal.slice(0, 4)), [0, 0, 0, 0], "slot 0 is transparent");

	var img = H.imgd([RED, TRN, GRN, TRN, BLU], 5, 1);
	var idx = q.reduce(img, 2);
	assert.strictEqual(idx[1], 0, "transparent pixel maps to slot 0");
	assert.strictEqual(idx[3], 0);
	assert.notStrictEqual(idx[0], undefined);

	// index -> paletteRGBA -> expand round trip
	var expanded = q.expand(idx, 5, 1);
	var direct = q.reduce(img, 1);
	assert.deepEqual(Array.from(expanded), Array.from(direct));
	assert.deepEqual(Array.from(expanded.slice(4, 8)), [0, 0, 0, 0]);

	// every palette index expands to its own paletteRGBA slice
	for (var i = 0; i < pal.length / 4; i++) {
		var one = q.expand([i], 1, 1);
		assert.deepEqual(Array.from(one), Array.from(pal.slice(i * 4, i * 4 + 4)));
	}
});

test("alpha transparent: alphaThreshold maps below-threshold pixels to the slot", function() {
	var a50 = [255, 0, 0, 50],
		a100 = [0, 255, 0, 100],
		a200 = [0, 0, 255, 200];
	var q = new RgbQuant({method: 1, colors: 4, alphaMode: "transparent", alphaThreshold: 64});
	q.sample(H.imgd([a50, a50, a100, a100, a200, a200], 6, 1));

	assert.equal(q.transCount, 2, "alpha 50 <= 64 -> transparent");
	// alpha 100 and 200 participate as opaque, normalized to alpha 255
	assert.equal(q.histogram[H.rgba(0, 255, 0, 255)], 2);
	assert.equal(q.histogram[H.rgba(0, 0, 255, 255)], 2);
	assert.equal(q.histogram[H.rgba(0, 255, 0, 100)], undefined, "alpha must not leak into histogram keys");

	var idx = q.reduce(H.imgd([a50, a100, a200], 3, 1), 2);
	assert.strictEqual(idx[0], 0);
	assert.ok(idx[1] > 0 && idx[2] > 0);
});

test("alpha transparent: image with only transparent pixels gets a single-slot palette", function() {
	var q = new RgbQuant({method: 1, colors: 8, alphaMode: "transparent"});
	q.sample(H.imgd([TRN, TRN, [0, 0, 0, 0]], 3, 1));
	var pal = q.paletteRGBA();
	assert.equal(pal.length / 4, 1);
	assert.deepEqual(Array.from(pal), [0, 0, 0, 0]);
	var idx = q.reduce(H.imgd([TRN], 1, 1), 2);
	assert.strictEqual(idx[0], 0);
});

test("alpha transparent: transparent slot survives predefined-palette pruning", function() {
	// fixed palette larger than `colors`, including a transparent entry
	var fixed = [
		[0, 0, 0], [255, 255, 255], [255, 0, 0], [0, 255, 0], [0, 0, 255], [0, 0, 0, 0],
	];
	var q = new RgbQuant({
		method: 1,
		colors: 3,
		palette: fixed,
		reIndex: true,
		alphaMode: "transparent",
	});
	assert.equal(q.hasTrans, true, "transparent entry recognized in predefined palette");

	// sample lots of red and green so pruning has something to do
	var pixels = [];
	for (var i = 0; i < 10; i++) pixels.push(RED, GRN, TRN);
	q.sample(H.imgd(pixels, 30, 1));
	var pal = q.paletteRGBA();
	assert.equal(pal.length / 4, 3, "pruned to colors=3, transparent slot included");

	var transIdx = q.i32idx[q.transI32];
	assert.notStrictEqual(transIdx, undefined, "transparent slot survived pruning");
	assert.deepEqual(Array.from(pal.slice(transIdx * 4, transIdx * 4 + 4)), [0, 0, 0, 0]);

	var idx = q.reduce(H.imgd([TRN, RED], 2, 1), 2);
	assert.strictEqual(idx[0], transIdx);
});

test("alpha premultiply: colors participate as premultiplied opaque", function() {
	var half_red = [255, 0, 0, 128],	// -> round(255*128/255) = 128,0,0
		quarter_grn = [0, 255, 0, 64],	// -> round(255*64/255) = 64,0... -> 0,64,0
		full_blu = [0, 0, 255, 255],
		zero = [200, 100, 50, 0];		// -> opaque black

	var q = new RgbQuant({method: 1, colors: 8, alphaMode: "premultiply"});
	q.sample(H.imgd([half_red, half_red, quarter_grn, full_blu, zero], 5, 1));

	assert.equal(q.histogram[H.rgba(128, 0, 0, 255)], 2);
	assert.equal(q.histogram[H.rgba(0, 64, 0, 255)], 1);
	assert.equal(q.histogram[H.rgba(0, 0, 255, 255)], 1);
	assert.equal(q.histogram[H.rgba(0, 0, 0, 255)], 1, "alpha 0 -> premultiplied black");
	assert.equal(Object.keys(q.histogram).length, 4);

	var ref = H.refHistogram([half_red, half_red, quarter_grn, full_blu, zero], "premultiply", 0);
	assert.deepEqual(q.histogram, ref.hist);

	// reduced output is opaque premultiplied color
	var out = q.reduce(H.imgd([half_red], 1, 1), 1);
	assert.equal(out[3], 255);
	assert.deepEqual(Array.from(out.slice(0, 3)), [128, 0, 0]);
});

test("alpha premultiply: matches reference histogram over random pixels", function() {
	var pixels = H.randomPixels(200, 99, true);
	var q = new RgbQuant({method: 1, colors: 16, alphaMode: "premultiply"});
	q.sample(H.imgd(pixels, 20, 10));
	var ref = H.refHistogram(pixels, "premultiply", 0);
	assert.deepEqual(q.histogram, ref.hist);
});

test("alpha transparent: histogram matches reference over random pixels", function() {
	var pixels = H.randomPixels(200, 1234, true);
	var q = new RgbQuant({method: 1, colors: 16, alphaMode: "transparent", alphaThreshold: 10});
	q.sample(H.imgd(pixels, 20, 10));
	var ref = H.refHistogram(pixels, "transparent", 10);
	assert.deepEqual(q.histogram, ref.hist);
	assert.equal(q.transCount, ref.trans);
});

test("alpha modes: tiled and whole sampling agree on transCount", function() {
	var W = 5, Hh = 3;
	var pixels = H.randomPixels(W * Hh, 5, true);
	var whole = new RgbQuant({method: 1, colors: 8, alphaMode: "transparent"});
	whole.sample(H.imgd(pixels, W, Hh));

	var tiled = new RgbQuant({method: 1, colors: 8, alphaMode: "transparent"});
	tiled.sample(H.imgd(H.crop(pixels, W, 0, 0, 5, 1), 5, 1).data, {width: 5, height: 1, x: 0, y: 0, fullWidth: W, fullHeight: Hh});
	tiled.sample(H.imgd(H.crop(pixels, W, 0, 1, 5, 2), 5, 2).data, {width: 5, height: 2, x: 0, y: 1, fullWidth: W, fullHeight: Hh});

	assert.equal(tiled.transCount, whole.transCount);
	assert.deepEqual(tiled.histogram, whole.histogram);
	assert.deepEqual(Array.from(tiled.paletteRGBA()), Array.from(whole.paletteRGBA()));
});
