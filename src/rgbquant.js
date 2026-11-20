/*
* Copyright (c) 2015, Leon Sorokin
* All rights reserved. (MIT Licensed)
*
* RgbQuant.js - an image quantization lib
*/

(function(){
	function RgbQuant(opts) {
		opts = opts || {};

		// 1 = by global population, 2 = subregion population threshold
		this.method = opts.method || 2;
		// desired final palette size
		this.colors = opts.colors || 256;
		// # of highest-frequency colors to start with for palette reduction
		this.initColors = opts.initColors || 4096;
		// color-distance threshold for initial reduction pass
		this.initDist = opts.initDist || 0.01;
		// subsequent passes threshold
		this.distIncr = opts.distIncr || 0.005;
		// palette grouping
		this.hueGroups = opts.hueGroups || 10;
		this.satGroups = opts.satGroups || 10;
		this.lumGroups = opts.lumGroups || 10;
		// if > 0, enables hues stats and min-color retention per group
		this.minHueCols = opts.minHueCols || 0;
		// HueStats instance
		this.hueStats = this.minHueCols ? new HueStats(this.hueGroups, this.minHueCols) : null;

		// subregion partitioning box size
		this.boxSize = opts.boxSize || [64,64];
		// number of same pixels required within box for histogram inclusion
		this.boxPxls = opts.boxPxls || 2;
		// palette locked indicator
		this.palLocked = false;
		// palette sort order
//		this.sortPal = ['hue-','lum-','sat-'];

		// dithering/error diffusion kernel name
		this.dithKern = opts.dithKern || null;
		// dither serpentine pattern
		this.dithSerp = opts.dithSerp || false;
		// minimum color difference (0-1) needed to dither
		this.dithDelta = opts.dithDelta || 0;

		// accumulated histogram
		this.histogram = {};
		// palette - rgb triplets
		this.idxrgb = opts.palette ? opts.palette.slice(0) : [];
		// palette - int32 vals
		this.idxi32 = [];
		// reverse lookup {i32:idx}
		this.i32idx = {};
		// {i32:rgb}
		this.i32rgb = {};
		// enable color caching (also incurs overhead of cache misses and cache building)
		this.useCache = opts.useCache !== false;
		// min color occurance count needed to qualify for caching
		this.cacheFreq = opts.cacheFreq || 10;
		// allows pre-defined palettes to be re-indexed (enabling palette compacting and sorting)
		this.reIndex = opts.reIndex || this.idxrgb.length == 0;
		// selection of color-distance equation
		this.colorDist = opts.colorDist == "manhattan" ? distManhattan : distEuclidean;

		// alpha handling strategy:
		//   "ignore"      - legacy default: alpha==0 pixels are skipped during sampling and
		//                   produce null (sparse) indices / transparent-black pixels on reduce
		//   "transparent" - pixels with alpha <= alphaThreshold are mapped to a single reserved
		//                   transparent palette slot (counted against the `colors` budget)
		//   "premultiply" - pixels participate in quantization with premultiplied-alpha colors
		this.alphaMode = opts.alphaMode || "ignore";
		if (this.alphaMode != "ignore" && this.alphaMode != "transparent" && this.alphaMode != "premultiply")
			throw quantErr('invalid alphaMode "' + this.alphaMode + '" (expected "ignore", "transparent" or "premultiply")');
		// pixels with alpha <= alphaThreshold are treated as transparent ("transparent" mode only)
		this.alphaThreshold = opts.alphaThreshold || 0;
		if (!isInt(this.alphaThreshold) || this.alphaThreshold < 0 || this.alphaThreshold > 255)
			throw quantErr("alphaThreshold must be an integer between 0 and 255");

		// i32 value of the transparent palette slot (null when the palette has none)
		this.transI32 = null;
		// whether the palette currently holds a transparent slot
		this.hasTrans = false;
		// number of sampled pixels mapped to the transparent slot
		this.transCount = 0;
		// tiled sampling state (see sampleTiled)
		this._tiled = null;
		this._tileFull = null;
		this._tileGrid = null;
		this._boxLocal = {};
		// effective palette budget during buildPal (colors minus reserved transparent slot)
		this._budget = null;

		// if pre-defined palette, build lookups
		if (this.idxrgb.length > 0) {
			var self = this;
			this.idxrgb.forEach(function(rgb, i) {
				if (!rgb || rgb.length < 3 || rgb.length > 4)
					throw quantErr("palette entry " + i + " must be an [r,g,b] or [r,g,b,a] array");

				for (var c = 0; c < rgb.length; c++) {
					if (!isInt(rgb[c]) || rgb[c] < 0 || rgb[c] > 255)
						throw quantErr("palette entry " + i + " has invalid channel value " + rgb[c]);
				}

				// alpha of a 4th channel is honored in "transparent" mode only
				var alpha = (self.alphaMode == "transparent" && rgb.length > 3) ? rgb[3] : 255;

				var i32 = (
					(alpha << 24) |	// alpha
					(rgb[2] << 16) |	// blue
					(rgb[1] <<  8) |	// green
					 rgb[0]				// red
				) >>> 0;

				self.idxi32[i]		= i32;
				self.i32idx[i32]	= i;
				self.i32rgb[i32]	= rgb.slice(0, 3);

				if (alpha <= self.alphaThreshold && self.transI32 === null) {
					self.transI32 = i32;
					self.hasTrans = true;
				}
			});
		}
	}

	// gathers histogram info
	// @width: legacy number, or tile opts {width, height, x, y, fullWidth, fullHeight}
	//         for submitting sub-rectangles of a larger image (see sampleTiled)
	RgbQuant.prototype.sample = function sample(img, width) {
		if (this.palLocked)
			throw "Cannot sample additional images, palette already assembled.";

		var tileOpts = (width != null && typeof width == "object") ? width : null,
			data = getImageData(img, tileOpts ? {width: tileOpts.width, height: tileOpts.height} : width);

		if (tileOpts)
			this.sampleTiled(data, tileOpts);
		else {
			if (this._tiled === true)
				throw quantErr("cannot mix tiled and untiled sample calls");
			this._tiled = false;

			switch (this.method) {
				case 1: this.colorStats1D(data.buf32); break;
				case 2: this.colorStats2D(data.buf32, data.width); break;
			}
		}
	};

	// image quantizer
	// todo: memoize colors here also
	// @retType: 1 - Uint8Array (default), 2 - Indexed array, 3 - Match @img type (unimplemented, todo)
	// @width: optional pixel width for raw array inputs (required for correct dithering of typed arrays)
	RgbQuant.prototype.reduce = function reduce(img, retType, dithKern, dithSerp, width) {
		if (!this.palLocked)
			this.buildPal();

		dithKern = dithKern || this.dithKern;
		dithSerp = typeof dithSerp != "undefined" ? dithSerp : this.dithSerp;

		retType = retType || 1;

		// reduce w/dither
		if (dithKern)
			var out32 = this.dither(img, dithKern, dithSerp, width);
		else {
			var data = getImageData(img, width),
				buf32 = data.buf32,
				len = buf32.length,
				out32 = new Uint32Array(len);

			for (var i = 0; i < len; i++) {
				var i32 = buf32[i];
				out32[i] = this.nearestColor(i32);
			}
		}

		if (retType == 1)
			return new Uint8Array(out32.buffer);

		if (retType == 2) {
			var out = [],
				len = out32.length;

			for (var i = 0; i < len; i++) {
				var i32 = out32[i];
				out[i] = this.i32idx[i32];
			}

			return out;
		}
	};

	// adapted from http://jsbin.com/iXofIji/2/edit by PAEz
	RgbQuant.prototype.dither = function(img, kernel, serpentine, width) {
		// http://www.tannerhelland.com/4660/dithering-eleven-algorithms-source-code/
		var kernels = {
			FloydSteinberg: [
				[7 / 16, 1, 0],
				[3 / 16, -1, 1],
				[5 / 16, 0, 1],
				[1 / 16, 1, 1]
			],
			FalseFloydSteinberg: [
				[3 / 8, 1, 0],
				[3 / 8, 0, 1],
				[2 / 8, 1, 1]
			],
			Stucki: [
				[8 / 42, 1, 0],
				[4 / 42, 2, 0],
				[2 / 42, -2, 1],
				[4 / 42, -1, 1],
				[8 / 42, 0, 1],
				[4 / 42, 1, 1],
				[2 / 42, 2, 1],
				[1 / 42, -2, 2],
				[2 / 42, -1, 2],
				[4 / 42, 0, 2],
				[2 / 42, 1, 2],
				[1 / 42, 2, 2]
			],
			Atkinson: [
				[1 / 8, 1, 0],
				[1 / 8, 2, 0],
				[1 / 8, -1, 1],
				[1 / 8, 0, 1],
				[1 / 8, 1, 1],
				[1 / 8, 0, 2]
			],
			Jarvis: [			// Jarvis, Judice, and Ninke / JJN?
				[7 / 48, 1, 0],
				[5 / 48, 2, 0],
				[3 / 48, -2, 1],
				[5 / 48, -1, 1],
				[7 / 48, 0, 1],
				[5 / 48, 1, 1],
				[3 / 48, 2, 1],
				[1 / 48, -2, 2],
				[3 / 48, -1, 2],
				[5 / 48, 0, 2],
				[3 / 48, 1, 2],
				[1 / 48, 2, 2]
			],
			Burkes: [
				[8 / 32, 1, 0],
				[4 / 32, 2, 0],
				[2 / 32, -2, 1],
				[4 / 32, -1, 1],
				[8 / 32, 0, 1],
				[4 / 32, 1, 1],
				[2 / 32, 2, 1],
			],
			Sierra: [
				[5 / 32, 1, 0],
				[3 / 32, 2, 0],
				[2 / 32, -2, 1],
				[4 / 32, -1, 1],
				[5 / 32, 0, 1],
				[4 / 32, 1, 1],
				[2 / 32, 2, 1],
				[2 / 32, -1, 2],
				[3 / 32, 0, 2],
				[2 / 32, 1, 2],
			],
			TwoSierra: [
				[4 / 16, 1, 0],
				[3 / 16, 2, 0],
				[1 / 16, -2, 1],
				[2 / 16, -1, 1],
				[3 / 16, 0, 1],
				[2 / 16, 1, 1],
				[1 / 16, 2, 1],
			],
			SierraLite: [
				[2 / 4, 1, 0],
				[1 / 4, -1, 1],
				[1 / 4, 0, 1],
			],
		};

		if (!kernel || !kernels[kernel]) {
			throw 'Unknown dithering kernel: ' + kernel;
		}

		var ds = kernels[kernel];

		var data = getImageData(img, width),
//			buf8 = data.buf8,
			// work on a copy so the caller's buffer is never mutated and
			// repeated reduce() calls reproduce pixel-for-pixel
			buf32 = new Uint32Array(data.buf32),
			width = data.width,
			height = data.height,
			len = buf32.length;

		var dir = serpentine ? -1 : 1;

		for (var y = 0; y < height; y++) {
			if (serpentine)
				dir = dir * -1;

			var lni = y * width;

			for (var x = (dir == 1 ? 0 : width - 1), xend = (dir == 1 ? width : 0); x !== xend; x += dir) {
				// Image pixel
				var idx = lni + x,
					i32 = buf32[idx];

				if (this.alphaMode == "premultiply")
					i32 = premultI32(i32);

				var alpha = (i32 & 0xff000000) >>> 24,
					isTrans = this.alphaMode == "transparent" ? alpha <= this.alphaThreshold : alpha == 0;

				// transparent pixels stay transparent and never diffuse error into opaque regions
				if (isTrans) {
					buf32[idx] = (this.alphaMode == "transparent" && this.hasTrans) ? this.transI32 : 0;
					continue;
				}

				var r1 = (i32 & 0xff),
					g1 = (i32 & 0xff00) >> 8,
					b1 = (i32 & 0xff0000) >> 16;

				// Reduced pixel
				var i32x = this.nearestColor(i32),
					r2 = (i32x & 0xff),
					g2 = (i32x & 0xff00) >> 8,
					b2 = (i32x & 0xff0000) >> 16;

				buf32[idx] =
					(255 << 24)	|	// alpha
					(b2  << 16)	|	// blue
					(g2  <<  8)	|	// green
					 r2;

				// dithering strength
				if (this.dithDelta) {
					var dist = this.colorDist([r1, g1, b1], [r2, g2, b2]);
					if (dist < this.dithDelta)
						continue;
				}

				// Component distance
				var er = r1 - r2,
					eg = g1 - g2,
					eb = b1 - b2;

				for (var i = (dir == 1 ? 0 : ds.length - 1), end = (dir == 1 ? ds.length : 0); i !== end; i += dir) {
					var x1 = ds[i][1] * dir,
						y1 = ds[i][2];

					var lni2 = y1 * width;

					if (x1 + x >= 0 && x1 + x < width && y1 + y >= 0 && y1 + y < height) {
						var d = ds[i][0];
						var idx2 = idx + (lni2 + x1);

						var r3 = (buf32[idx2] & 0xff),
							g3 = (buf32[idx2] & 0xff00) >> 8,
							b3 = (buf32[idx2] & 0xff0000) >> 16;

						var r4 = Math.max(0, Math.min(255, r3 + er * d)),
							g4 = Math.max(0, Math.min(255, g3 + eg * d)),
							b4 = Math.max(0, Math.min(255, b3 + eb * d));

						// alpha of the receiving pixel is preserved, so error
						// landing on transparent pixels is discarded with them
						buf32[idx2] =
							(buf32[idx2] & 0xff000000)	|	// alpha
							(b4  << 16)	|	// blue
							(g4  <<  8)	|	// green
							 r4;			// red
					}
				}
			}
		}

		return buf32;
	};

	// reduces histogram to palette, remaps & memoizes reduced colors
	RgbQuant.prototype.buildPal = function buildPal(noSort) {
		if (this.palLocked || this.idxrgb.length > 0 && this.idxrgb.length <= this.colors) return;

		this.finalizeTiles();

		var histG  = this.histogram,
			sorted = sortedHashKeys(histG, true);

		// reserve a palette slot for transparency when the caller opted in and
		// transparent pixels were actually sampled (counts against `colors` budget)
		var wantTrans = this.alphaMode == "transparent" && this.transI32 === null &&
			this.transCount > 0 && this.idxrgb.length == 0;

		if (sorted.length == 0) {
			// an image of only transparent pixels still gets a (single-slot) palette
			if (wantTrans) {
				this.addTransSlot();
				this.palLocked = true;
				return;
			}
			throw "Nothing has been sampled, palette cannot be built.";
		}

		this._budget = this.colors - (wantTrans ? 1 : 0);
		if (this._budget < 1)
			throw quantErr("colors budget too small: transparent slot leaves no room for opaque colors");

		switch (this.method) {
			case 1:
				var cols = this.initColors,
					last = sorted[cols - 1],
					freq = histG[last];

				var idxi32 = sorted.slice(0, cols);

				// add any cut off colors with same freq as last
				var pos = cols, len = sorted.length;
				while (pos < len && histG[sorted[pos]] == freq)
					idxi32.push(sorted[pos++]);

				// inject min huegroup colors
				if (this.hueStats)
					this.hueStats.inject(idxi32);

				break;
			case 2:
				var idxi32 = sorted;
				break;
		}

		// int32-ify values
		idxi32 = idxi32.map(function(v){return +v;});

		this.reducePal(idxi32);

		if (!noSort && this.reIndex)
			this.sortPal();

		// transparent slot lives at index 0, outside the sorted opaque range
		if (wantTrans)
			this.addTransSlot();

		// build cache of top histogram colors
		if (this.useCache)
			this.cacheHistogram(idxi32);

		this._budget = null;
		this.palLocked = true;
	};

	// prepends the reserved transparent slot (index 0) to a generated palette
	RgbQuant.prototype.addTransSlot = function addTransSlot() {
		this.transI32 = 0;
		this.idxrgb.unshift([0,0,0]);
		this.idxi32.unshift(0);
		this.i32rgb[0] = [0,0,0];

		for (var i = 0; i < this.idxi32.length; i++)
			this.i32idx[this.idxi32[i]] = i;

		this.hasTrans = true;
	};

	RgbQuant.prototype.palette = function palette(tuples, noSort) {
		this.buildPal(noSort);
		return tuples ? this.idxrgb : new Uint8Array((new Uint32Array(this.idxi32)).buffer);
	};

	// explicit RGBA view of the palette; index i occupies bytes [i*4, i*4+4)
	// so reduce(img, 2) indices, paletteRGBA() and expand() stay in correspondence
	RgbQuant.prototype.paletteRGBA = function paletteRGBA(noSort) {
		this.buildPal(noSort);
		return new Uint8Array((new Uint32Array(this.idxi32)).buffer);
	};

	// reverse of reduce(img, 2): expands an (optionally sparse) indexed pixel array
	// back to RGBA bytes using the current palette
	RgbQuant.prototype.expand = function expand(indexed, width, height) {
		if (!this.palLocked)
			this.buildPal();

		if (!indexed || typeof indexed.length != "number")
			throw quantErr("indexed pixels must be an array or typed array");

		var len = indexed.length;

		if (len == 0)
			throw quantErr("indexed pixel array is empty");

		if (width != null && (!isInt(width) || width <= 0))
			throw quantErr("width must be a positive integer, got " + width);
		if (height != null && (!isInt(height) || height <= 0))
			throw quantErr("height must be a positive integer, got " + height);

		if (width == null)
			width = len;
		if (height == null) {
			if (len % width != 0)
				throw quantErr("pixel count " + len + " is not divisible by width " + width);
			height = len / width;
		}

		if (width * height > MAX_PIXELS)
			throw quantErr("image dimensions " + width + "x" + height + " exceed maximum of " + MAX_PIXELS + " pixels");

		if (width * height != len)
			throw quantErr("indexed pixel count " + len + " does not match dimensions " + width + "x" + height);

		var out32 = new Uint32Array(len);

		for (var i = 0; i < len; i++) {
			var idx = indexed[i];

			// sparse holes (transparent pixels in "ignore" mode) expand to transparent black
			if (idx == null) {
				out32[i] = 0;
				continue;
			}

			if (!isInt(idx) || idx < 0 || idx >= this.idxi32.length || this.idxi32[idx] == null)
				throw quantErr("invalid palette index " + idx + " at pixel " + i);

			out32[i] = this.idxi32[idx];
		}

		return new Uint8Array(out32.buffer);
	};

	RgbQuant.prototype.prunePal = function prunePal(keep) {
		var i32;

		for (var j = 0; j < this.idxrgb.length; j++) {
			if (!keep[j]) {
				i32 = this.idxi32[j];
				this.idxrgb[j] = null;
				this.idxi32[j] = null;
				delete this.i32idx[i32];
			}
		}

		// compact
		if (this.reIndex) {
			var idxrgb = [],
				idxi32 = [],
				i32idx = {};

			for (var j = 0, i = 0; j < this.idxrgb.length; j++) {
				if (this.idxrgb[j]) {
					i32 = this.idxi32[j];
					idxrgb[i] = this.idxrgb[j];
					i32idx[i32] = i;
					idxi32[i] = i32;
					i++;
				}
			}

			this.idxrgb = idxrgb;
			this.idxi32 = idxi32;
			this.i32idx = i32idx;
		}
	};

	// reduces similar colors from an importance-sorted Uint32 rgba array
	RgbQuant.prototype.reducePal = function reducePal(idxi32) {
		// palette budget; a reserved transparent slot (generated palettes) shrinks it by one
		var maxCols = this._budget != null ? this._budget : this.colors;

		// if pre-defined palette's length exceeds target
		if (this.idxrgb.length > maxCols) {
			// quantize histogram to existing palette
			var len = idxi32.length, keep = {}, uniques = 0, idx, pruned = false;

			// the transparent slot always survives pruning
			if (this.transI32 !== null && (""+this.transI32) in this.i32idx) {
				keep[this.i32idx[this.transI32]] = true;
				uniques = 1;
			}

			for (var i = 0; i < len; i++) {
				// palette length reached, unset all remaining colors (sparse palette)
				if (uniques == maxCols && !pruned) {
					this.prunePal(keep);
					pruned = true;
				}

				idx = this.nearestIndex(idxi32[i]);

				if (uniques < maxCols && !keep[idx]) {
					keep[idx] = true;
					uniques++;
				}
			}

			if (!pruned) {
				this.prunePal(keep);
				pruned = true;
			}
		}
		// reduce histogram to create initial palette
		else {
			// build full rgb palette
			var idxrgb = idxi32.map(function(i32) {
				return [
					(i32 & 0xff),
					(i32 & 0xff00) >> 8,
					(i32 & 0xff0000) >> 16,
				];
			});

			var len = idxrgb.length,
				palLen = len,
				thold = this.initDist;

			// palette already at or below desired length
			if (palLen > maxCols) {
				while (palLen > maxCols) {
					var memDist = [];

					// iterate palette
					for (var i = 0; i < len; i++) {
						var pxi = idxrgb[i], i32i = idxi32[i];
						if (!pxi) continue;

						for (var j = i + 1; j < len; j++) {
							var pxj = idxrgb[j], i32j = idxi32[j];
							if (!pxj) continue;

							var dist = this.colorDist(pxi, pxj);

							if (dist < thold) {
								// store index,rgb,dist
								memDist.push([j, pxj, i32j, dist]);

								// kill squashed value
								delete(idxrgb[j]);
								palLen--;
							}
						}
					}

					// palette reduction pass
					// console.log("palette length: " + palLen);

					// if palette is still much larger than target, increment by larger initDist
					thold += (palLen > maxCols * 3) ? this.initDist : this.distIncr;
				}

				// if palette is over-reduced, re-add removed colors with largest distances from last round
				if (palLen < maxCols) {
					// sort descending, ties broken by original (ascending) palette position
					sort.call(memDist, function(a,b) {
						return b[3] - a[3] || a[0] - b[0];
					});

					var k = 0;
					while (palLen < maxCols) {
						// re-inject rgb into final palette
						idxrgb[memDist[k][0]] = memDist[k][1];

						palLen++;
						k++;
					}
				}
			}

			var len = idxrgb.length;
			for (var i = 0; i < len; i++) {
				if (!idxrgb[i]) continue;

				this.idxrgb.push(idxrgb[i]);
				this.idxi32.push(idxi32[i]);

				this.i32idx[idxi32[i]] = this.idxi32.length - 1;
				this.i32rgb[idxi32[i]] = idxrgb[i];
			}
		}
	};

	// normalizes a pixel according to the alpha strategy; returns null when the
	// pixel is transparent and must not enter the color histogram
	RgbQuant.prototype.histKey = function histKey(col) {
		var alpha = (col & 0xff000000) >>> 24;

		switch (this.alphaMode) {
			case "premultiply":
				return premultI32(col);
			case "transparent":
				if (alpha <= this.alphaThreshold) {
					this.transCount++;
					return null;
				}
				// remaining pixels participate as opaque; alpha never enters RGB distance
				return (col | 0xff000000) >>> 0;
			default: // "ignore"
				return alpha == 0 ? null : col;
		}
	};

	// global top-population
	RgbQuant.prototype.colorStats1D = function colorStats1D(buf32) {
		var histG = this.histogram,
			num = 0, col,
			len = buf32.length;

		for (var i = 0; i < len; i++) {
			col = this.histKey(buf32[i]);

			// skip transparent
			if (col === null) continue;

			// collect hue stats
			if (this.hueStats)
				this.hueStats.check(col);

			if (col in histG)
				histG[col]++;
			else
				histG[col] = 1;
		}
	};

	// population threshold within subregions
	// FIXME: this can over-reduce (few/no colors same?), need a way to keep
	// important colors that dont ever reach local thresholds (gradients?)
	RgbQuant.prototype.colorStats2D = function colorStats2D(buf32, width) {
		var boxW = this.boxSize[0],
			boxH = this.boxSize[1],
			area = boxW * boxH,
			boxes = makeBoxes(width, buf32.length / width, boxW, boxH),
			histG = this.histogram,
			self = this;

		boxes.forEach(function(box) {
			var effc = Math.max(Math.round((box.w * box.h) / area) * self.boxPxls, 2),
				histL = {}, col;

			iterBox(box, width, function(i) {
				col = self.histKey(buf32[i]);

				// skip transparent
				if (col === null) return;

				// collect hue stats
				if (self.hueStats)
					self.hueStats.check(col);

				if (col in histG)
					histG[col]++;
				else if (col in histL) {
					if (++histL[col] >= effc)
						histG[col] = histL[col];
				}
				else
					histL[col] = 1;
			});
		});

		if (this.hueStats)
			this.hueStats.inject(histG);
	};

	// samples a sub-rectangle of a larger image.
	// tile opts: {width, height, x, y, fullWidth, fullHeight}
	//   x, y       - tile origin within the full image (default 0, 0)
	//   fullWidth, fullHeight - full image dims (default: tile dims)
	// Tiles must be non-overlapping; every submitted pixel is counted exactly once
	// and uncovered regions contribute nothing. For method 2, per-box counts are
	// accumulated against the *global* box grid and promoted when the palette is
	// built, so tiled submission yields the same histogram as whole-image sampling.
	RgbQuant.prototype.sampleTiled = function sampleTiled(data, opts) {
		var x0 = opts.x != null ? opts.x : 0,
			y0 = opts.y != null ? opts.y : 0,
			fullW = opts.fullWidth != null ? opts.fullWidth : data.width,
			fullH = opts.fullHeight != null ? opts.fullHeight : data.height;

		if (!isInt(x0) || !isInt(y0) || x0 < 0 || y0 < 0)
			throw quantErr("tile offset (x, y) must be non-negative integers");
		if (!isInt(fullW) || !isInt(fullH) || fullW <= 0 || fullH <= 0)
			throw quantErr("fullWidth/fullHeight must be positive integers");
		if (x0 + data.width > fullW || y0 + data.height > fullH)
			throw quantErr("tile at (" + x0 + "," + y0 + ") sized " + data.width + "x" + data.height +
				" exceeds full image bounds " + fullW + "x" + fullH);
		if (this._tiled === false)
			throw quantErr("cannot mix tiled and untiled sample calls");
		if (this._tileFull) {
			if (this._tileFull[0] != fullW || this._tileFull[1] != fullH)
				throw quantErr("inconsistent full image dimensions across tiles: " +
					this._tileFull[0] + "x" + this._tileFull[1] + " vs " + fullW + "x" + fullH);
		}
		else
			this._tileFull = [fullW, fullH];

		this._tiled = true;

		// method 1 keeps global counts, so tiles are naturally equivalent
		if (this.method == 1) {
			this.colorStats1D(data.buf32);
			return;
		}

		var grid = this._tileGrid;

		if (!grid) {
			var boxW = this.boxSize[0],
				boxH = this.boxSize[1];

			grid = this._tileGrid = {
				boxes: makeBoxes(fullW, fullH, boxW, boxH),
				boxCols: Math.ceil(fullW / boxW),
				boxW: boxW,
				boxH: boxH,
			};
		}

		var buf32 = data.buf32,
			wid = data.width,
			len = buf32.length;

		for (var i = 0; i < len; i++) {
			var col = this.histKey(buf32[i]);

			// skip transparent
			if (col === null) continue;

			// collect hue stats
			if (this.hueStats)
				this.hueStats.check(col);

			var gx = x0 + (i % wid),
				gy = y0 + ((i / wid) | 0),
				bidx = (((gy / grid.boxH) | 0) * grid.boxCols) + ((gx / grid.boxW) | 0),
				local = this._boxLocal[bidx] || (this._boxLocal[bidx] = {});

			local[col] = (local[col] || 0) + 1;
		}
	};

	// merges deferred per-box tile counts into the global histogram, replaying the
	// same promotion rules as colorStats2D in canonical (row-major) box order
	RgbQuant.prototype.finalizeTiles = function finalizeTiles() {
		if (!this._tiled || this.method != 2)
			return;

		var histG = this.histogram,
			grid = this._tileGrid,
			area = this.boxSize[0] * this.boxSize[1],
			boxes = grid.boxes;

		for (var b = 0; b < boxes.length; b++) {
			var local = this._boxLocal[b];
			if (!local) continue;

			var effc = Math.max(Math.round((boxes[b].w * boxes[b].h) / area) * this.boxPxls, 2);

			for (var col in local) {
				var num = local[col];

				if (col in histG)
					histG[col] += num;
				else if (num >= effc)
					histG[col] = num;
			}
		}

		if (this.hueStats)
			this.hueStats.inject(histG);

		this._boxLocal = {};
	};

	// TODO: group very low lum and very high lum colors
	// TODO: pass custom sort order
	RgbQuant.prototype.sortPal = function sortPal() {
		var self = this;

		// stable sort: fully-tied entries keep their (deterministic) frequency order
		sort.call(this.idxi32, function(a,b) {
			var idxA = self.i32idx[a],
				idxB = self.i32idx[b],
				rgbA = self.idxrgb[idxA],
				rgbB = self.idxrgb[idxB];

			var hslA = rgb2hsl(rgbA[0],rgbA[1],rgbA[2]),
				hslB = rgb2hsl(rgbB[0],rgbB[1],rgbB[2]);

			// sort all grays + whites together
			var hueA = (rgbA[0] == rgbA[1] && rgbA[1] == rgbA[2]) ? -1 : hueGroup(hslA.h, self.hueGroups);
			var hueB = (rgbB[0] == rgbB[1] && rgbB[1] == rgbB[2]) ? -1 : hueGroup(hslB.h, self.hueGroups);

			var hueDiff = hueB - hueA;
			if (hueDiff) return -hueDiff;

			var lumDiff = lumGroup(+hslB.l.toFixed(2)) - lumGroup(+hslA.l.toFixed(2));
			if (lumDiff) return -lumDiff;

			var satDiff = satGroup(+hslB.s.toFixed(2)) - satGroup(+hslA.s.toFixed(2));
			if (satDiff) return -satDiff;
		});

		// sync idxrgb & i32idx
		this.idxi32.forEach(function(i32, i) {
			self.idxrgb[i] = self.i32rgb[i32];
			self.i32idx[i32] = i;
		});
	};

	// TOTRY: use HUSL - http://boronine.com/husl/
	RgbQuant.prototype.nearestColor = function nearestColor(i32) {
		var idx = this.nearestIndex(i32);
		return idx === null ? 0 : this.idxi32[idx];
	};

	// TOTRY: use HUSL - http://boronine.com/husl/
	RgbQuant.prototype.nearestIndex = function nearestIndex(i32) {
		var mode = this.alphaMode;

		if (mode == "premultiply")
			i32 = premultI32(i32);
		else {
			var alpha = (i32 & 0xff000000) >>> 24;

			if (mode == "transparent") {
				// below-threshold pixels map to the single transparent slot
				if (alpha <= this.alphaThreshold)
					return this.hasTrans ? this.i32idx[this.transI32] : null;
				// remaining pixels participate as opaque; alpha never enters RGB distance
				i32 = (i32 | 0xff000000) >>> 0;
			}
			// legacy: alpha 0 returns null index
			else if (alpha == 0)
				return null;
		}

		if (this.useCache && (""+i32) in this.i32idx)
			return this.i32idx[i32];

		var min = 1000,
			idx,
			rgb = [
				(i32 & 0xff),
				(i32 & 0xff00) >> 8,
				(i32 & 0xff0000) >> 16,
			],
			len = this.idxrgb.length,
			skipTrans = mode == "transparent",
			thresh = this.alphaThreshold;

		for (var i = 0; i < len; i++) {
			if (!this.idxrgb[i]) continue;		// sparse palettes

			// transparent slots are never the nearest color for opaque pixels
			if (skipTrans && ((this.idxi32[i] & 0xff000000) >>> 24) <= thresh) continue;

			var dist = this.colorDist(rgb, this.idxrgb[i]);

			if (dist < min) {
				min = dist;
				idx = i;
			}
		}

		return idx;
	};

	RgbQuant.prototype.cacheHistogram = function cacheHistogram(idxi32) {
		for (var i = 0, i32 = idxi32[i]; i < idxi32.length && this.histogram[i32] >= this.cacheFreq; i32 = idxi32[i++])
			this.i32idx[i32] = this.nearestIndex(i32);
	};

	function HueStats(numGroups, minCols) {
		this.numGroups = numGroups;
		this.minCols = minCols;
		this.stats = {};

		for (var i = -1; i < numGroups; i++)
			this.stats[i] = {num: 0, cols: []};

		this.groupsFull = 0;
	}

	HueStats.prototype.check = function checkHue(i32) {
		if (this.groupsFull == this.numGroups + 1)
			this.check = function() {return;};

		var r = (i32 & 0xff),
			g = (i32 & 0xff00) >> 8,
			b = (i32 & 0xff0000) >> 16,
			hg = (r == g && g == b) ? -1 : hueGroup(rgb2hsl(r,g,b).h, this.numGroups),
			gr = this.stats[hg],
			min = this.minCols;

		gr.num++;

		if (gr.num > min)
			return;
		if (gr.num == min)
			this.groupsFull++;

		if (gr.num <= min)
			this.stats[hg].cols.push(i32);
	};

	HueStats.prototype.inject = function injectHues(histG) {
		for (var i = -1; i < this.numGroups; i++) {
			if (this.stats[i].num <= this.minCols) {
				switch (typeOf(histG)) {
					case "Array":
						this.stats[i].cols.forEach(function(col){
							if (histG.indexOf(col) == -1)
								histG.push(col);
						});
						break;
					case "Object":
						this.stats[i].cols.forEach(function(col){
							if (!histG[col])
								histG[col] = 1;
							else
								histG[col]++;
						});
						break;
				}
			}
		}
	};

	// Rec. 709 (sRGB) luma coef
	var Pr = .2126,
		Pg = .7152,
		Pb = .0722;

	// http://alienryderflex.com/hsp.html
	function rgb2lum(r,g,b) {
		return Math.sqrt(
			Pr * r*r +
			Pg * g*g +
			Pb * b*b
		);
	}

	var rd = 255,
		gd = 255,
		bd = 255;

	var euclMax = Math.sqrt(Pr*rd*rd + Pg*gd*gd + Pb*bd*bd);
	// perceptual Euclidean color distance
	function distEuclidean(rgb0, rgb1) {
		var rd = rgb1[0]-rgb0[0],
			gd = rgb1[1]-rgb0[1],
			bd = rgb1[2]-rgb0[2];

		return Math.sqrt(Pr*rd*rd + Pg*gd*gd + Pb*bd*bd) / euclMax;
	}

	var manhMax = Pr*rd + Pg*gd + Pb*bd;
	// perceptual Manhattan color distance
	function distManhattan(rgb0, rgb1) {
		var rd = Math.abs(rgb1[0]-rgb0[0]),
			gd = Math.abs(rgb1[1]-rgb0[1]),
			bd = Math.abs(rgb1[2]-rgb0[2]);

		return (Pr*rd + Pg*gd + Pb*bd) / manhMax;
	}

	// http://rgb2hsl.nichabi.com/javascript-function.php
	function rgb2hsl(r, g, b) {
		var max, min, h, s, l, d;
		r /= 255;
		g /= 255;
		b /= 255;
		max = Math.max(r, g, b);
		min = Math.min(r, g, b);
		l = (max + min) / 2;
		if (max == min) {
			h = s = 0;
		} else {
			d = max - min;
			s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
			switch (max) {
				case r: h = (g - b) / d + (g < b ? 6 : 0); break;
				case g:	h = (b - r) / d + 2; break;
				case b:	h = (r - g) / d + 4; break
			}
			h /= 6;
		}
//		h = Math.floor(h * 360)
//		s = Math.floor(s * 100)
//		l = Math.floor(l * 100)
		return {
			h: h,
			s: s,
			l: rgb2lum(r,g,b),
		};
	}

	function hueGroup(hue, segs) {
		var seg = 1/segs,
			haf = seg/2;

		if (hue >= 1 - haf || hue <= haf)
			return 0;

		for (var i = 1; i < segs; i++) {
			var mid = i*seg;
			if (hue >= mid - haf && hue <= mid + haf)
				return i;
		}
	}

	function satGroup(sat) {
		return sat;
	}

	function lumGroup(lum) {
		return lum;
	}

	function typeOf(val) {
		return Object.prototype.toString.call(val).slice(8,-1);
	}

	var sort = isArrSortStable() ? Array.prototype.sort : stableSort;

	// must be used via stableSort.call(arr, fn)
	function stableSort(fn) {
		var type = typeOf(this[0]);

		if (type == "Number" || type == "String") {
			var ord = {}, len = this.length, val;

			for (var i = 0; i < len; i++) {
				val = this[i];
				if (ord[val] || ord[val] === 0) continue;
				ord[val] = i;
			}

			return this.sort(function(a,b) {
				return fn(a,b) || ord[a] - ord[b];
			});
		}
		else {
			var ord = this.map(function(v){return v});

			return this.sort(function(a,b) {
				return fn(a,b) || ord.indexOf(a) - ord.indexOf(b);
			});
		}
	}

	// test if js engine's Array#sort implementation is stable
	function isArrSortStable() {
		var str = "abcdefghijklmnopqrstuvwxyz";

		return "xyzvwtursopqmnklhijfgdeabc" == str.split("").sort(function(a,b) {
			return ~~(str.indexOf(b)/2.3) - ~~(str.indexOf(a)/2.3);
		}).join("");
	}

	// premultiplies a pixel's RGB channels by its alpha and marks it opaque;
	// idempotent (alpha 255 passes through, alpha 0 becomes opaque black)
	function premultI32(i32) {
		var a = (i32 & 0xff000000) >>> 24;

		if (a == 255)
			return i32;
		if (a == 0)
			return 0xff000000;

		var r = Math.round(((i32 & 0xff) * a) / 255),
			g = Math.round((((i32 & 0xff00) >> 8) * a) / 255),
			b = Math.round((((i32 & 0xff0000) >> 16) * a) / 255);

		return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
	}

	var MAX_PIXELS = 0x10000000;	// 268,435,456 px (1 GiB of RGBA)

	// stable error type for all input-validation failures
	function quantErr(msg) {
		return new Error("RgbQuant: " + msg);
	}

	function isInt(v) {
		return typeof v == "number" && isFinite(v) && Math.floor(v) === v;
	}

	// 32-bit view over an 8-bit buffer, honoring its byte offset (copies if misaligned)
	function u32view(buf8) {
		if (buf8.byteOffset % 4 == 0)
			return new Uint32Array(buf8.buffer, buf8.byteOffset, buf8.byteLength / 4);

		var copy = new Uint8Array(buf8.byteLength);
		copy.set(buf8);
		return new Uint32Array(copy.buffer);
	}

	// returns uniform pixel data from various img
	// @opts: legacy number width, or {width, height}
	function getImageData(img, opts) {
		var can, ctx, imgd, buf8, buf32, width, height;

		if (opts != null && typeof opts == "object") {
			width = opts.width;
			height = opts.height;
		}
		else
			width = opts;

		var type = typeOf(img);

		// ImageData-like plain objects (Node.js): {data, width, height}
		if (type == "Object" && img != null && img.data != null && img.width != null)
			type = "ImageData";

		switch (type) {
			case "HTMLImageElement":
				can = document.createElement("canvas");
				can.width = img.naturalWidth;
				can.height = img.naturalHeight;
				ctx = can.getContext("2d");
				ctx.drawImage(img,0,0);
			case "Canvas":
			case "HTMLCanvasElement":
				can = can || img;
				ctx = ctx || can.getContext("2d");
			case "CanvasRenderingContext2D":
				ctx = ctx || img;
				can = can || ctx.canvas;
				imgd = ctx.getImageData(0, 0, can.width, can.height);
			case "ImageData":
				imgd = imgd || img;
				width = imgd.width;
				height = imgd.height;
				if (typeOf(imgd.data) == "CanvasPixelArray")
					buf8 = new Uint8Array(imgd.data);
				else
					buf8 = imgd.data;
				break;
			case "Array":
			case "CanvasPixelArray":
				buf8 = new Uint8Array(img);
				break;
			case "Uint8Array":
			case "Uint8ClampedArray":
				buf8 = img;
				break;
			case "Uint32Array":
				buf32 = img;
				break;
			default:
				throw quantErr("unsupported image type: " + type);
		}

		if (buf32) {
			if (buf32.byteOffset != 0 || buf32.byteLength != buf32.buffer.byteLength)
				buf32 = new Uint32Array(buf32.buffer, buf32.byteOffset, buf32.length);
			buf8 = new Uint8Array(buf32.buffer, buf32.byteOffset, buf32.byteLength);
		}
		else {
			if (!buf8 || buf8.length % 4 != 0)
				throw quantErr("image data length " + (buf8 ? buf8.length : 0) + " is not a multiple of 4 (RGBA)");
			buf32 = u32view(buf8);
		}

		var numPx = buf32.length;

		// width/height of 0 are treated as unset (legacy behavior)
		if (width != null && (!isInt(width) || width < 0))
			throw quantErr("width must be a positive integer, got " + width);
		if (height != null && (!isInt(height) || height < 0))
			throw quantErr("height must be a positive integer, got " + height);
		if (!width) width = null;
		if (!height) height = null;

		if (width != null && height != null && width * height > MAX_PIXELS)
			throw quantErr("image dimensions " + width + "x" + height + " exceed maximum of " + MAX_PIXELS + " pixels");

		if (numPx == 0)
			throw quantErr("image data is empty");

		if (width == null)
			width = numPx;
		if (height == null) {
			if (numPx % width != 0)
				throw quantErr("pixel count " + numPx + " is not divisible by width " + width);
			height = numPx / width;
		}

		if (width * height != numPx)
			throw quantErr("pixel count " + numPx + " does not match dimensions " + width + "x" + height);

		return {
			can: can,
			ctx: ctx,
			imgd: imgd,
			buf8: buf8,
			buf32: buf32,
			width: width,
			height: height,
		};
	}

	// partitions a rect of wid x hgt into
	// array of bboxes of w0 x h0 (or less)
	function makeBoxes(wid, hgt, w0, h0) {
		var wnum = ~~(wid/w0), wrem = wid%w0,
			hnum = ~~(hgt/h0), hrem = hgt%h0,
			xend = wid-wrem, yend = hgt-hrem;

		var bxs = [];
		for (var y = 0; y < hgt; y += h0)
			for (var x = 0; x < wid; x += w0)
				bxs.push({x:x, y:y, w:(x==xend?wrem:w0), h:(y==yend?hrem:h0)});

		return bxs;
	}

	// iterates @bbox within a parent rect of width @wid; calls @fn, passing index within parent
	function iterBox(bbox, wid, fn) {
		var b = bbox,
			i0 = b.y * wid + b.x,
			i1 = (b.y + b.h - 1) * wid + (b.x + b.w - 1),
			cnt = 0, incr = wid - b.w + 1, i = i0;

		do {
			fn.call(this, i);
			i += (++cnt % b.w == 0) ? incr : 1;
		} while (i <= i1);
	}

	// returns array of hash keys sorted by their values;
	// ties are broken deterministically by ascending numeric key (color value),
	// so the result never depends on histogram insertion order
	function sortedHashKeys(obj, desc) {
		var keys = [];

		for (var key in obj)
			keys.push(key);

		return sort.call(keys, function(a,b) {
			return desc ? (obj[b] - obj[a] || a - b) : (obj[a] - obj[b] || a - b);
		});
	}

	// expose
	this.RgbQuant = RgbQuant;

	// expose to commonJS
	if (typeof module !== 'undefined' && module.exports) {
		module.exports = RgbQuant;
	}

}).call(this);