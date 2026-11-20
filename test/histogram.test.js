// histogram correctness, tiled sampling equivalence, deterministic ordering
"use strict";

var assert = require("assert");
var RgbQuant = require("../src/rgbquant.js");
var H = require("./helpers.js");

var RED = [255, 0, 0, 255],
	GRN = [0, 255, 0, 255],
	BLU = [0, 0, 255, 255],
	BLK = [0, 0, 0, 255],
	TRN = [200, 100, 50, 0];	// transparent with non-zero RGB

test("histogram: method 1 counts match hand-computed reference", function() {
	var pixels = [RED, RED, GRN, BLU, TRN, RED, GRN, BLK, BLK, BLK];
	var q = new RgbQuant({method: 1});
	q.sample(H.imgd(pixels, 5, 2));

	var ref = H.refHistogram(pixels, "ignore", 0);
	assert.deepEqual(q.histogram, ref.hist);
	assert.equal(q.histogram[H.rgba(255, 0, 0, 255)], 3);
	assert.equal(q.histogram[H.rgba(0, 0, 0, 255)], 3);
	assert.equal(q.histogram[H.rgba(200, 100, 50, 0)], undefined, "transparent pixel must not enter histogram");
});

test("histogram: method 2 subregion threshold (hand-computed)", function() {
	// 4x2 image, boxes 2x2 -> 2 boxes; boxPxls 2 -> a color needs 2+ pixels in one box
	// box0 (x 0..1): RED x3, GRN x1  -> RED promoted, GRN dropped
	// box1 (x 2..3): GRN x2, BLU x2  -> both promoted
	var row0 = [RED, RED, GRN, BLU],
		row1 = [RED, GRN, GRN, BLU];
	var pixels = row0.concat(row1);

	var q = new RgbQuant({method: 2, boxSize: [2, 2], boxPxls: 2});
	q.sample(H.imgd(pixels, 4, 2));

	assert.deepEqual(q.histogram, {
		[H.rgba(255, 0, 0, 255)]: 3,
		[H.rgba(0, 255, 0, 255)]: 2,	// only box1's pair counts; box1 BLU pair too
		[H.rgba(0, 0, 255, 255)]: 2,
	});
});

test("histogram: odd image width handled exactly", function() {
	// 5x3, boxes 2x2 -> 3 cols (2,2,1) x 2 rows (2,1)
	var pixels = [];
	for (var i = 0; i < 15; i++) pixels.push(i % 2 ? RED : GRN);

	var q = new RgbQuant({method: 2, boxSize: [2, 2], boxPxls: 2});
	q.sample(H.imgd(pixels, 5, 3));

	// reference: replay box logic by hand
	// boxes: (0,0,2,2) (2,0,2,2) (4,0,1,2) (0,2,2,1) (2,2,2,1) (4,2,1,1)
	// pixel (x,y) = pixels[y*5+x] is RED when (y*5+x) odd
	function boxCount(bx, by, bw, bh, pred) {
		var n = 0;
		for (var y = by; y < by + bh; y++)
			for (var x = bx; x < bx + bw; x++)
				if (pred((y * 5 + x) % 2)) n++;
		return n;
	}
	var boxes = [[0, 0, 2, 2], [2, 0, 2, 2], [4, 0, 1, 2], [0, 2, 2, 1], [2, 2, 2, 1], [4, 2, 1, 1]];
	var ref = {};
	boxes.forEach(function(b) {
		var effc = Math.max(Math.round((b[2] * b[3]) / 4) * 2, 2);
		var red = boxCount(b[0], b[1], b[2], b[3], function(m) { return m == 1; });
		var grn = boxCount(b[0], b[1], b[2], b[3], function(m) { return m == 0; });
		// promotion: once in histG, later boxes add directly
		if (H.rgba(255, 0, 0, 255) in ref) ref[H.rgba(255, 0, 0, 255)] += red;
		else if (red >= effc) ref[H.rgba(255, 0, 0, 255)] = red;
		if (H.rgba(0, 255, 0, 255) in ref) ref[H.rgba(0, 255, 0, 255)] += grn;
		else if (grn >= effc) ref[H.rgba(0, 255, 0, 255)] = grn;
	});
	assert.deepEqual(q.histogram, ref);
});

test("tiling: method 1 whole vs tiles -> identical histogram and palette", function() {
	var W = 7, Hh = 5;
	var pixels = H.randomPixels(W * Hh, 42, true);

	var whole = new RgbQuant({method: 1, colors: 8});
	whole.sample(H.imgd(pixels, W, Hh));

	var tiled = new RgbQuant({method: 1, colors: 8});
	// submit in scrambled tile order: bottom-right, top strip, middle
	tiled.sample(H.imgd(H.crop(pixels, W, 3, 2, 4, 3), 4, 3).data, {width: 4, height: 3, x: 3, y: 2, fullWidth: W, fullHeight: Hh});
	tiled.sample(H.imgd(H.crop(pixels, W, 0, 0, 7, 2), 7, 2).data, {width: 7, height: 2, x: 0, y: 0, fullWidth: W, fullHeight: Hh});
	tiled.sample(H.imgd(H.crop(pixels, W, 0, 2, 3, 3), 3, 3).data, {width: 3, height: 3, x: 0, y: 2, fullWidth: W, fullHeight: Hh});

	assert.deepEqual(tiled.histogram, whole.histogram);
	assert.deepEqual(Array.from(tiled.palette()), Array.from(whole.palette()));
});

test("tiling: method 2 whole vs tiles -> identical histogram and palette (odd width, box-crossing)", function() {
	var W = 7, Hh = 5;
	// repeated colors so box thresholds are met
	var pixels = [];
	for (var i = 0; i < W * Hh; i++)
		pixels.push([RED, GRN, BLU, BLK][i % 4]);

	var opts = {method: 2, boxSize: [3, 3], boxPxls: 2, colors: 8};

	var whole = new RgbQuant(opts);
	whole.sample(H.imgd(pixels, W, Hh));

	// vertical split inside box 0 (boxes are 3 wide: x 0..2 | 3..5 | 6)
	var tiled = new RgbQuant(opts);
	tiled.sample(H.imgd(H.crop(pixels, W, 4, 0, 3, 5), 3, 5).data, {width: 3, height: 5, x: 4, y: 0, fullWidth: W, fullHeight: Hh});
	tiled.sample(H.imgd(H.crop(pixels, W, 0, 0, 4, 5), 4, 5).data, {width: 4, height: 5, x: 0, y: 0, fullWidth: W, fullHeight: Hh});

	// method 2 tile counts are promoted into the histogram when the palette is built
	tiled.palette();
	assert.deepEqual(tiled.histogram, whole.histogram);
	assert.deepEqual(Array.from(tiled.palette()), Array.from(whole.palette()));

	// horizontal split inside a box row, tiles submitted bottom-up
	var tiled2 = new RgbQuant(opts);
	tiled2.sample(H.imgd(H.crop(pixels, W, 0, 3, 7, 2), 7, 2).data, {width: 7, height: 2, x: 0, y: 3, fullWidth: W, fullHeight: Hh});
	tiled2.sample(H.imgd(H.crop(pixels, W, 0, 0, 7, 3), 7, 3).data, {width: 7, height: 3, x: 0, y: 0, fullWidth: W, fullHeight: Hh});

	tiled2.palette();
	assert.deepEqual(tiled2.histogram, whole.histogram);
});

test("tiling: uncovered regions contribute nothing; every covered pixel counted once", function() {
	var W = 6, Hh = 4;
	var pixels = [];
	for (var i = 0; i < W * Hh; i++) pixels.push([i * 10 % 256, 0, 0, 255]);

	var q = new RgbQuant({method: 1});
	// cover only the top-left 3x2 and bottom-right 2x1
	q.sample(H.imgd(H.crop(pixels, W, 0, 0, 3, 2), 3, 2).data, {width: 3, height: 2, x: 0, y: 0, fullWidth: W, fullHeight: Hh});
	q.sample(H.imgd(H.crop(pixels, W, 4, 3, 2, 1), 2, 1).data, {width: 2, height: 1, x: 4, y: 3, fullWidth: W, fullHeight: Hh});

	var covered = H.crop(pixels, W, 0, 0, 3, 2).concat(H.crop(pixels, W, 4, 3, 2, 1));
	var ref = H.refHistogram(covered, "ignore", 0);
	assert.deepEqual(q.histogram, ref.hist);
	var total = 0;
	Object.keys(q.histogram).forEach(function(k) { total += q.histogram[k]; });
	assert.equal(total, 8, "exactly the 8 covered pixels");
});

test("determinism: sample order does not change palette (method 1, shuffled images)", function() {
	// three images, each color with a distinct frequency
	var imgA = [RED, RED, RED, GRN].map(function(c){return c;});
	var imgB = [GRN, BLU, BLU];
	var imgC = [BLK, BLK, BLK, BLK];

	function build(order) {
		var q = new RgbQuant({method: 1, colors: 8});
		order.forEach(function(px) {
			q.sample(H.imgd(px, px.length, 1));
		});
		return q.palette(true, true);	// noSort: raw frequency order
	}

	var p1 = build([imgA, imgB, imgC]);
	var p2 = build([imgC, imgA, imgB]);
	var p3 = build([imgB, imgC, imgA]);
	assert.deepEqual(p2, p1);
	assert.deepEqual(p3, p1);
	// hand-computed: BLK x4, RED x3, BLU x2, GRN x2 (tie -> ascending i32: GRN 0xff00ff00 < BLU 0xffff0000)
	assert.deepEqual(p1, [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255]]);
});

test("determinism: equal frequencies break ties by ascending color value", function() {
	// all colors appear exactly twice
	var pixels = [BLU, RED, GRN, BLK, GRN, BLU, BLK, RED];
	var q = new RgbQuant({method: 1, colors: 8});
	q.sample(H.imgd(pixels, 8, 1));

	var pal = q.palette(true, true);	// noSort
	// i32 ascending: BLK 0xff000000 < RED 0xff0000ff < GRN 0xff00ff00 < BLU 0xffff0000
	assert.deepEqual(pal, [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255]]);

	// same pixels, submitted in a different order -> identical palette
	var q2 = new RgbQuant({method: 1, colors: 8});
	q2.sample(H.imgd([GRN, BLK, RED, BLU], 4, 1));
	q2.sample(H.imgd([BLU, BLK, GRN, RED], 4, 1));
	assert.deepEqual(q2.palette(true, true), pal);
});

test("determinism: sorted palette is stable across shuffled sampling", function() {
	var pixels = H.randomPixels(64, 7, false).concat(H.randomPixels(64, 7, false));
	function build(chunks) {
		var q = new RgbQuant({method: 1, colors: 16});
		chunks.forEach(function(c) { q.sample(H.imgd(c, c.length, 1)); });
		return Array.from(q.palette());	// sorted (reIndex default)
	}
	var half = pixels.length / 2;
	var p1 = build([pixels.slice(0, half), pixels.slice(half)]);
	var p2 = build([pixels.slice(half), pixels.slice(0, half)]);
	var p3 = build([pixels]);
	assert.deepEqual(p2, p1);
	assert.deepEqual(p3, p1);
});

test("determinism: minHueCols with empty hue groups is deterministic", function() {
	// only reds sampled: most hue groups stay empty
	var pixels = [RED, RED, [200, 0, 0, 255], [200, 0, 0, 255], [128, 0, 0, 255]];
	function build() {
		var q = new RgbQuant({method: 1, colors: 8, minHueCols: 2});
		q.sample(H.imgd(pixels, 5, 1));
		return q.palette(true);
	}
	var p1 = build(), p2 = build();
	assert.deepEqual(p1, p2);
	assert.ok(p1.length <= 8);
});

test("palette: budget cap respected including transparent slot", function() {
	// 3 opaque colors + transparent pixels, colors: 3 -> 2 opaque + 1 transparent
	var pixels = [RED, RED, RED, GRN, GRN, BLU, TRN, TRN];
	var q = new RgbQuant({method: 1, colors: 3, alphaMode: "transparent"});
	q.sample(H.imgd(pixels, 8, 1));
	var pal = q.paletteRGBA();
	assert.equal(pal.length / 4, 3, "palette capped at colors=3 including transparent slot");
	// slot 0 is transparent
	assert.deepEqual(Array.from(pal.slice(0, 4)), [0, 0, 0, 0]);

	// without transparent pixels, no slot is reserved
	var q2 = new RgbQuant({method: 1, colors: 3, alphaMode: "transparent"});
	q2.sample(H.imgd([RED, RED, GRN, GRN, BLU, BLU], 6, 1));
	assert.equal(q2.paletteRGBA().length / 4, 3);
	assert.equal(q2.hasTrans, false);
});
