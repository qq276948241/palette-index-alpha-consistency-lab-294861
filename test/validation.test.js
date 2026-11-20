// input validation: stable errors, no silent truncation
"use strict";

var assert = require("assert");
var RgbQuant = require("../src/rgbquant.js");
var H = require("./helpers.js");

function throwsStable(fn, re, label) {
	assert.throws(fn, function(e) {
		return e instanceof Error && re.test(e.message);
	}, label);
}

test("validation: empty image data", function() {
	var q = new RgbQuant();
	throwsStable(function() { q.sample(new Uint8Array(0)); }, /RgbQuant: image data is empty/);
	throwsStable(function() { q.sample([]); }, /RgbQuant: image data is empty/);
	throwsStable(function() { q.sample(new Uint32Array(0)); }, /RgbQuant: image data is empty/);
});

test("validation: data length not a multiple of 4", function() {
	var q = new RgbQuant();
	throwsStable(function() { q.sample(new Uint8Array(6)); }, /not a multiple of 4/);
	throwsStable(function() { q.sample([255, 0, 0]); }, /not a multiple of 4/);
});

test("validation: width must be a positive integer", function() {
	var q = new RgbQuant();
	var img = new Uint8Array(16);
	throwsStable(function() { q.sample(img, -1); }, /width must be a positive integer/);
	throwsStable(function() { q.sample(img, 1.5); }, /width must be a positive integer/);
	throwsStable(function() { q.sample(img, "2"); }, /width must be a positive integer/);
	// width 0 is treated as unset (legacy behavior), must not throw
	q.sample(img, 0);
});

test("validation: pixel count not divisible by width", function() {
	var q = new RgbQuant();
	throwsStable(function() { q.sample(new Uint8Array(16), 3); }, /not divisible by width 3/);
});

test("validation: ImageData-like object length/dimension mismatch", function() {
	var q = new RgbQuant();
	throwsStable(function() {
		q.sample({data: new Uint8Array(8), width: 2, height: 2});
	}, /pixel count 2 does not match dimensions 2x2/);
	throwsStable(function() {
		q.sample({data: new Uint8Array(16), width: 0, height: 4});
	}, /does not match dimensions/);
});

test("validation: oversized dimensions rejected before allocation", function() {
	var q = new RgbQuant();
	throwsStable(function() {
		q.sample({data: new Uint8Array(4), width: 20000, height: 20000});
	}, /exceed maximum/);
});

test("validation: unsupported input type", function() {
	var q = new RgbQuant();
	throwsStable(function() { q.sample(null); }, /unsupported image type/);
	throwsStable(function() { q.sample(42); }, /unsupported image type/);
});

test("validation: Uint8Array with non-zero byteOffset reads the view, not the buffer", function() {
	// 6 pixels in one buffer; the sampled view covers only the last 3 (all red)
	var base = new Uint8Array(24);
	for (var i = 0; i < 6; i++) {
		base[i * 4] = i < 3 ? 0 : 255;	// first 3 black, last 3 red
		base[i * 4 + 3] = 255;
	}
	var view = base.subarray(12, 24);	// byteOffset 12 (aligned)
	var q = new RgbQuant({method: 1});
	q.sample(view, 3);
	assert.deepEqual(q.histogram, {[H.rgba(255, 0, 0, 255)]: 3});

	// misaligned offset forces a copy, must still read the right pixels
	var view2 = base.subarray(13, 25 - 1);	// byteOffset 13, 11 bytes -> invalid length
	assert.throws(function() { new RgbQuant().sample(view2); }, /not a multiple of 4/);

	var base2 = new Uint8Array(26);
	base2.fill(0);
	for (var i = 0; i < 3; i++) {
		base2[2 + i * 4] = 0;
		base2[2 + i * 4 + 1] = 255;		// green
		base2[2 + i * 4 + 2] = 0;
		base2[2 + i * 4 + 3] = 255;
	}
	var view3 = base2.subarray(2, 14);	// byteOffset 2 (misaligned), 3 green px
	var q3 = new RgbQuant({method: 1});
	q3.sample(view3, 3);
	assert.deepEqual(q3.histogram, {[H.rgba(0, 255, 0, 255)]: 3});
});

test("validation: Uint32Array input including subarray views", function() {
	var q = new RgbQuant({method: 1});
	var buf = new Uint32Array([H.rgba(1, 2, 3, 255), H.rgba(1, 2, 3, 255), H.rgba(4, 5, 6, 255)]);
	q.sample(buf.subarray(1), 2);
	assert.deepEqual(q.histogram, {
		["" + H.rgba(1, 2, 3, 255)]: 1,
		["" + H.rgba(4, 5, 6, 255)]: 1,
	});
});

test("validation: invalid predefined palette entries", function() {
	throwsStable(function() { new RgbQuant({palette: [[1, 2]]}); }, /palette entry 0/);
	throwsStable(function() { new RgbQuant({palette: [[1, 2, 300]]}); }, /invalid channel value 300/);
	throwsStable(function() { new RgbQuant({palette: [[1.5, 2, 3]]}); }, /invalid channel value 1.5/);
	throwsStable(function() { new RgbQuant({palette: [[0, 0, 0, 256]], alphaMode: "transparent"}); }, /invalid channel value 256/);
});

test("validation: invalid alphaMode / alphaThreshold", function() {
	throwsStable(function() { new RgbQuant({alphaMode: "yolo"}); }, /invalid alphaMode/);
	throwsStable(function() { new RgbQuant({alphaMode: "transparent", alphaThreshold: -1}); }, /alphaThreshold/);
	throwsStable(function() { new RgbQuant({alphaMode: "transparent", alphaThreshold: 256}); }, /alphaThreshold/);
});

test("validation: expand() checks length, dimensions and index range", function() {
	var q = new RgbQuant({method: 1, colors: 4});
	q.sample(H.imgd([[255, 0, 0, 255], [0, 255, 0, 255]], 2, 1));
	q.palette();

	throwsStable(function() { q.expand([], 0, 0); }, /indexed pixel array is empty/);
	throwsStable(function() { q.expand([0, 1], 3); }, /not divisible by width 3/);
	throwsStable(function() { q.expand([0, 1], 1, 1); }, /does not match dimensions 1x1/);
	throwsStable(function() { q.expand([0, 99], 2, 1); }, /invalid palette index 99 at pixel 1/);
	throwsStable(function() { q.expand([0, -1], 2, 1); }, /invalid palette index -1 at pixel 1/);
	throwsStable(function() { q.expand([0, 1.5], 2, 1); }, /invalid palette index 1.5 at pixel 1/);
	throwsStable(function() { q.expand(null, 1, 1); }, /must be an array or typed array/);
	throwsStable(function() { q.expand({}, 1, 1); }, /must be an array or typed array/);
});

test("validation: reduce() validates its input too", function() {
	var q = new RgbQuant({method: 1});
	q.sample(H.imgd([[255, 0, 0, 255], [255, 0, 0, 255]], 2, 1));
	throwsStable(function() { q.reduce(new Uint8Array(3)); }, /not a multiple of 4/);
	throwsStable(function() { q.reduce(new Uint8Array(16), 1, null, false, 3); }, /not divisible by width 3/);
});

test("validation: tiled sampling rejects bad geometry", function() {
	var mk = function() { return new RgbQuant({method: 2, boxSize: [2, 2]}); };
	var tile = H.imgd([[1, 1, 1, 255], [2, 2, 2, 255], [3, 3, 3, 255], [4, 4, 4, 255]], 2, 2);

	var q = mk();
	throwsStable(function() {
		q.sample(tile.data, {width: 2, height: 2, x: -1, y: 0, fullWidth: 4, fullHeight: 4});
	}, /tile offset/);

	q = mk();
	throwsStable(function() {
		q.sample(tile.data, {width: 2, height: 2, x: 3, y: 0, fullWidth: 4, fullHeight: 4});
	}, /exceeds full image bounds/);

	q = mk();
	q.sample(tile.data, {width: 2, height: 2, x: 0, y: 0, fullWidth: 4, fullHeight: 4});
	throwsStable(function() {
		q.sample(tile.data, {width: 2, height: 2, x: 2, y: 0, fullWidth: 5, fullHeight: 4});
	}, /inconsistent full image dimensions/);

	// mixing tiled and untiled calls
	q = mk();
	q.sample(tile.data, 2);
	throwsStable(function() {
		q.sample(tile.data, {width: 2, height: 2, x: 0, y: 0, fullWidth: 4, fullHeight: 4});
	}, /cannot mix tiled and untiled/);

	q = mk();
	q.sample(tile.data, {width: 2, height: 2, x: 0, y: 0, fullWidth: 4, fullHeight: 4});
	throwsStable(function() {
		q.sample(tile.data, 2);
	}, /cannot mix tiled and untiled/);
});
