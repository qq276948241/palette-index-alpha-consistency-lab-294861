// cache on/off equivalence and instance reuse after failures
"use strict";

var assert = require("assert");
var RgbQuant = require("../src/rgbquant.js");
var H = require("./helpers.js");

test("cache: useCache on/off produce identical palette and indices", function() {
	var pixels = H.randomPixels(32 * 32, 2024, false);
	var img = H.imgd(pixels, 32, 32);

	var cached = new RgbQuant({method: 1, colors: 16, useCache: true, cacheFreq: 2});
	var plain = new RgbQuant({method: 1, colors: 16, useCache: false});
	cached.sample(img);
	plain.sample(img);

	assert.deepEqual(Array.from(cached.palette()), Array.from(plain.palette()), "palette identical");
	assert.deepEqual(cached.reduce(img, 2), plain.reduce(img, 2), "indices identical");
	assert.deepEqual(
		Array.from(cached.reduce(img, 1)),
		Array.from(plain.reduce(img, 1)),
		"RGBA output identical"
	);
});

test("cache: on/off identical with dithering (FloydSteinberg + SierraLite)", function() {
	var pixels = H.randomPixels(16 * 16, 77, false);
	var img = H.imgd(pixels, 16, 16);

	["FloydSteinberg", "SierraLite"].forEach(function(kernel) {
		var cached = new RgbQuant({method: 1, colors: 8, useCache: true, cacheFreq: 2, dithKern: kernel});
		var plain = new RgbQuant({method: 1, colors: 8, useCache: false, dithKern: kernel});
		cached.sample(img);
		plain.sample(img);
		assert.deepEqual(
			Array.from(cached.reduce(img, 1, null, null, 16)),
			Array.from(plain.reduce(img, 1, null, null, 16)),
			kernel + " dithered output identical"
		);
	});
});

test("cache: on/off identical in transparent mode", function() {
	var pixels = H.randomPixels(20 * 20, 555, true);
	var img = H.imgd(pixels, 20, 20);

	var cached = new RgbQuant({method: 1, colors: 12, alphaMode: "transparent", useCache: true, cacheFreq: 2});
	var plain = new RgbQuant({method: 1, colors: 12, alphaMode: "transparent", useCache: false});
	cached.sample(img);
	plain.sample(img);

	assert.deepEqual(Array.from(cached.paletteRGBA()), Array.from(plain.paletteRGBA()));
	assert.deepEqual(cached.reduce(img, 2), plain.reduce(img, 2));
});

test("cache: on/off identical in premultiply mode", function() {
	var pixels = H.randomPixels(20 * 20, 556, true);
	var img = H.imgd(pixels, 20, 20);

	var cached = new RgbQuant({method: 1, colors: 12, alphaMode: "premultiply", useCache: true, cacheFreq: 2});
	var plain = new RgbQuant({method: 1, colors: 12, alphaMode: "premultiply", useCache: false});
	cached.sample(img);
	plain.sample(img);

	assert.deepEqual(Array.from(cached.paletteRGBA()), Array.from(plain.paletteRGBA()));
	assert.deepEqual(cached.reduce(img, 2), plain.reduce(img, 2));
});

test("reuse: failed sample() leaves the instance usable", function() {
	var q = new RgbQuant({method: 1, colors: 4});
	assert.throws(function() { q.sample(new Uint8Array(3)); }, /not a multiple of 4/);
	assert.throws(function() { q.sample(new Uint8Array(16), 3); }, /not divisible/);

	// instance must be unaffected: histogram still empty, still sample-able
	assert.deepEqual(q.histogram, {});
	q.sample(H.imgd([[255, 0, 0, 255], [255, 0, 0, 255]], 2, 1));
	assert.equal(q.histogram[H.rgba(255, 0, 0, 255)], 2);
	assert.equal(q.paletteRGBA().length, 4);
});

test("reuse: failed tiled sample does not corrupt tiling state", function() {
	var q = new RgbQuant({method: 2, boxSize: [2, 2]});
	var tile = H.imgd([[255, 0, 0, 255], [255, 0, 0, 255], [0, 255, 0, 255], [0, 255, 0, 255]], 2, 2);

	// out-of-bounds tile rejected
	assert.throws(function() {
		q.sample(tile.data, {width: 2, height: 2, x: 3, y: 3, fullWidth: 4, fullHeight: 4});
	}, /exceeds full image bounds/);

	// valid tiles still accepted and counted once
	q.sample(tile.data, {width: 2, height: 2, x: 0, y: 0, fullWidth: 4, fullHeight: 4});
	q.sample(tile.data, {width: 2, height: 2, x: 2, y: 2, fullWidth: 4, fullHeight: 4});
	q.palette();
	assert.equal(q.histogram[H.rgba(255, 0, 0, 255)], 4);
	assert.equal(q.histogram[H.rgba(0, 255, 0, 255)], 4);
});

test("reuse: buildPal failure (nothing sampled) does not lock the palette", function() {
	var q = new RgbQuant({method: 1});
	assert.throws(function() { q.palette(); }, /Nothing has been sampled/);
	assert.throws(function() { q.reduce(H.imgd([[255, 0, 0, 255]], 1, 1)); }, /Nothing has been sampled/);

	q.sample(H.imgd([[255, 0, 0, 255], [0, 255, 0, 255]], 2, 1));
	assert.ok(q.paletteRGBA().length >= 8);
});

test("reuse: sampling after palette is locked still throws (legacy)", function() {
	var q = new RgbQuant({method: 1});
	q.sample(H.imgd([[255, 0, 0, 255], [255, 0, 0, 255]], 2, 1));
	q.palette();
	assert.throws(function() {
		q.sample(H.imgd([[0, 255, 0, 255]], 1, 1));
	}, /palette already assembled/);
});

test("reuse: repeated palette()/reduce() calls are stable", function() {
	var pixels = H.randomPixels(64, 9, true);
	var img = H.imgd(pixels, 8, 8);
	var q = new RgbQuant({method: 1, colors: 8, alphaMode: "transparent"});
	q.sample(img);

	var p1 = Array.from(q.paletteRGBA());
	var p2 = Array.from(q.paletteRGBA());
	assert.deepEqual(p1, p2);

	var r1 = q.reduce(img, 2);
	var r2 = q.reduce(img, 2);
	assert.deepEqual(r1, r2);

	var e1 = Array.from(q.expand(r1, 8, 8));
	var e2 = Array.from(q.expand(r2, 8, 8));
	assert.deepEqual(e1, e2);
});
