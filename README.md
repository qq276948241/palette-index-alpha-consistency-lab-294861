RgbQuant.js
-----------
an image quantization lib _(MIT Licensed)_

![quantization](https://raw.githubusercontent.com/leeoniya/RgbQuant.js/master/quantization.png "quantization")

---
### Intro

Color quantization is the process of reducing an image with thousands or millions of colors to one with fewer (usually 256). The trick is to balance speed, cpu and memory requirements while minimizing the perceptual loss in output quality. More info can be found on [wikipedia](http://en.wikipedia.org/wiki/Color_quantization). Various algorithms can be found on [rosettacode.org](http://rosettacode.org/wiki/Color_quantization).

RgbQuant.js is not a port or implementation of any specific quantization algorithm, though some overlap is inevitable.

---
### Demo: http://leeoniya.github.io/RgbQuant.js/demo/

![demo page](https://raw.githubusercontent.com/leeoniya/RgbQuant.js/master/demo_th.png "demo page")

---
### Usage

**Use Chrome, Firefox or IE10+** since many HTML5/JS features are used. Canvas, Typed Arrays, Array.forEach.

```js
// options with defaults (not required)
var opts = {
    colors: 256,             // desired palette size
    method: 2,               // histogram method, 2: min-population threshold within subregions; 1: global top-population
    boxSize: [64,64],        // subregion dims (if method = 2)
    boxPxls: 2,              // min-population threshold (if method = 2)
    initColors: 4096,        // # of top-occurring colors  to start with (if method = 1)
    minHueCols: 0,           // # of colors per hue group to evaluate regardless of counts, to retain low-count hues
    dithKern: null,          // dithering kernel name, see available kernels in docs below
    dithDelta: 0,            // dithering threshhold (0-1) e.g: 0.05 will not dither colors with <= 5% difference
    dithSerp: false,         // enable serpentine pattern dithering
    palette: [],             // a predefined palette to start with in r,g,b tuple format: [[r,g,b],[r,g,b]...]
                             // (in "transparent" alphaMode, [r,g,b,a] quads are honored; entries with a <= alphaThreshold become transparent slots)
    reIndex: false,          // affects predefined palettes only. if true, allows compacting of sparsed palette once target palette size is reached. also enables palette sorting.
    useCache: true,          // enables caching for perf usually, but can reduce perf in some cases, like pre-def palettes
    cacheFreq: 10,           // min color occurance count needed to qualify for caching
    colorDist: "euclidean",  // method used to determine color distance, can also be "manhattan"
    alphaMode: "ignore",     // alpha strategy: "ignore" (legacy), "transparent" (single transparent palette slot), "premultiply"
    alphaThreshold: 0,       // pixels with alpha <= alphaThreshold are transparent ("transparent" mode only)
};

var q = new RgbQuant(opts);

// analyze histograms
q.sample(imgA);
q.sample(imgB);
q.sample(imgC);

// build palette
var pal = q.palette();

// reduce images
var outA = q.reduce(imgA),
    outB = q.reduce(imgB),
    outC = q.reduce(imgC);
```

### Alpha strategies

Alpha is never implicitly folded into RGB distance; what happens to transparent
pixels is an explicit caller choice via `alphaMode`:

- `"ignore"` *(default, legacy)* - fully transparent pixels (alpha 0) are excluded
  from the histogram. On reduce they produce holes (`undefined`) in indexed output
  and transparent-black (`0,0,0,0`) in RGBA output. Partially transparent pixels
  are treated as opaque.
- `"transparent"` - pixels with `alpha <= alphaThreshold` are mapped to a single
  reserved transparent palette slot. The slot counts against the `colors` budget
  (a generated palette holds at most `colors - 1` opaque colors plus the slot).
  The slot is prepended at index 0 of generated palettes; for predefined palettes,
  supply an `[r,g,b,a]` entry with `a <= alphaThreshold`. Remaining pixels are
  quantized as opaque (their alpha is normalized to 255 and never enters the
  histogram keys or RGB distance).
- `"premultiply"` - every pixel participates in quantization with its
  premultiplied-alpha color `round(channel * alpha / 255)` (alpha 0 becomes
  black). The output palette and reduced images are opaque.

Correspondence guarantee: indices returned by `reduce(img, 2)`, the RGBA palette
from `paletteRGBA()`, and the output of `expand()` always line up -
`expand(reduce(img, 2), w, h)` equals `reduce(img, 1)` byte-for-byte, and index
`i` expands to `paletteRGBA().slice(i*4, i*4+4)`.

### Node.js

npm package: https://www.npmjs.com/package/rgbquant
example with https://www.npmjs.com/package/canvas

```js
var fs = require('fs'),
	Canvas = require('canvas'),
	Image = Canvas.Image,
	RgbQuant = require('rgbquant');

var imgPath = "./test.png",
	img, can, ctx, q, pal, out;

fs.readFile(imgPath, function(err, data) {
	img = new Image;
	img.src = data;

	can = new Canvas(img.width, img.height);
	ctx = can.getContext('2d');
	ctx.drawImage(img, 0, 0, img.width, img.height);

	q = new RgbQuant();
	q.sample(can);
	pal = q.palette(true);
	out = q.reduce(can);
});
```

---
### Docs

**.sample(image, width)** - Performs histogram analysis.<br>
`image` may be any of *&lt;img&gt;*, *&lt;canvas&gt;*, *Context2D*, *ImageData*, *Typed Array*, *Array*, or an ImageData-like plain object `{data, width, height}` (useful in Node).<br>
`width` is required if `image` is an array.<br>
Alternatively, pass tile opts to sample a sub-rectangle of a larger image:
`.sample(image, {width, height, x, y, fullWidth, fullHeight})`. Tiles must be
non-overlapping; every submitted pixel is counted exactly once and uncovered
regions contribute nothing. Submitting the same pixels as one image or as
several tiles yields an equivalent histogram and the same deterministic palette
(with `method: 2`, per-box counts are accumulated against the global box grid
and promoted when the palette is built; with `minHueCols > 0`, hue retention
still follows submission order, so tiling equivalence is only guaranteed for
the default `minHueCols: 0`). Tiled and untiled calls cannot be mixed.

**.palette(tuples, noSort)** - Retrieves the palette, building it on first call.<br>
`tuples` if `true` will return an array of `[r,g,b]` triplets, otherwise a Uint8Array is returned by default.<br>
`noSort` if `true` will disable palette sorting by hue/luminance and leaves it ordered from highest to lowest color occurrence counts.

**.paletteRGBA(noSort)** - Explicit RGBA view of the palette (Uint8Array, 4 bytes per entry).<br>
Index `i` occupies bytes `[i*4, i*4+4)`, matching the indices returned by `reduce(img, 2)` and consumed by `expand()`. The transparent slot (if any) reports alpha 0.

**.expand(indexed, width, height)** - Reverse of `reduce(img, 2)`: expands an (optionally sparse) indexed pixel array back to a Uint8Array of RGBA bytes using the current palette.<br>
Sparse holes (`undefined`/`null`) expand to transparent black. Out-of-range or non-integer indices, empty arrays and length/dimension mismatches throw stable `RgbQuant:` errors.

**.reduce(image, retType, dithKern, dithSerp, width)** - Quantizes an image.<br>
`image` can be any of the types specified for `.sample()` above.<br>
`retType` determines returned type. `1` - Uint8Array (default), `2` - Indexed array.<br>
`dithKern` is a dithering kernel that can override what was specified in global opts (off by default), available options are:

  - FloydSteinberg
  - FalseFloydSteinberg
  - Stucki
  - Atkinson
  - Jarvis
  - Burkes
  - Sierra
  - TwoSierra
  - SierraLite

`dithSerp` can be `true` or `false` and determines if dithering is done in a serpentine pattern.<br>
`width` is optional and only needed to give raw array inputs their real row width (required for correct dithering of typed arrays; ImageData-like `{data, width, height}` objects carry their own).<br>

\* With the default `alphaMode: "ignore"`, transparent pixels will result in a sparse indexed array. With `alphaMode: "transparent"` they map to the reserved transparent slot instead.

\* Dithering never diffuses quantization error out of transparent pixels into opaque regions, and error landing on transparent pixels is discarded with them. Dithering also no longer mutates the caller's buffer, so repeated `reduce()` calls on the same input reproduce pixel-for-pixel.

---
### Determinism & validation

- Identical samples produce identical palettes regardless of submission order or tiling: histogram ties are broken by ascending color value, palette sorting is stable, and equal-distance reductions keep original order.
- `useCache` on/off never changes the palette or the reduced output.
- Malformed input fails fast with stable `Error("RgbQuant: ...")` messages instead of silent truncation: empty data, data length not a multiple of 4, pixel counts not divisible by `width`, `width*height` mismatches, non-positive or fractional dimensions, images over 268,435,456 px, invalid palette channels, out-of-range tile geometry, and invalid indices passed to `expand()`. A failed call leaves the instance usable.
- Typed-array views with a non-zero `byteOffset` are read correctly (copied if misaligned).

### Compatibility constraints

Default behavior of `sample()`, `palette()` and `reduce()` is unchanged when the
new options are not used (`alphaMode: "ignore"`): transparent pixels are skipped
during sampling and produce sparse indices / transparent-black pixels. Two
deliberate fixes affect dithered output only, and only for images containing
transparent pixels: transparent pixels now stay transparent (previously they
were written as opaque black) and no longer emit diffusion error. Dithering also
operates on a copy of the input rather than mutating it in place.

---
### Caveats & Tips

RgbQuant.js, as any quantizer, makes trade-offs which affect its performance in certain cases. Some parameters may be tweaked to improve the quality of the output at the expense of palette computation and reduction speed. Since the methods used to determine the palette are based on occurrence counts of each pixel's color, three problematic situations can arise.

- No two pixels are the same color. eg: unscaled bidirectional gradients.
- Visually distinctive but low-density hues are overwhelmed by dissimilar, dominating hues. (see Quantum Frog)
- Hues are numerous and densities relatively equal such that choosing the 'top' ones is unpredictable and eliminates a large number of important ones. (see Fish)

The symptom of these issues is a lack of important color groups in the final palette which results in poorly reduced images.

Frequently, the solution is to set `minHueCols: 256` during instantiation. What this will do is inject the first 256 encountered distinct colors for each hue group (by default there are 10) into the initial palette for analysis. In effect, it forces each encountered hue group to be represented, regardless of specific color counts. If using `method: 1`, you may additionally increase `initColors` to advance the slicing point of the frequency-sorted initial histogram.

These adjustments come with a (often significant) speed penalty for palette generation. Reduction passes may also be affected because of the internal memoization/caching used during palette building.

---
### Why?

Let me acknowledge the elephant in the room: why not just use or port an existing quantization algorithm? As far as JS ports go, there are really only 3.5 options (which implement 2.5 algos).

  - [Median-Cut](http://www.cs.tau.ac.il/~dcor/Graphics/cg-slides/color_q.pdf) - https://github.com/mwcz/median-cut-js<br>
    Not particularly fast.

  - [Leptonica's Modified Median-Cut](http://www.leptonica.com/color-quantization.html) - https://gist.github.com/nrabinowitz/1104622<br>
    This port is slow and contains major unfixed issues (see my gist comments/samples). Author seems to have abandoned updating the project.

  - [NeuQuant](http://members.ozemail.com.au/~dekker/NEUQUANT.HTML) - [port 1](https://github.com/antimatter15/jsgif/blob/master/NeuQuant.js), [port 2](https://github.com/jnordberg/gif.js/blob/master/src/TypedNeuQuant.js)<br>
    Performs quite well for photographs. Tends to favor smoothness/quality of large gradients over the retention of visually distinct, but less frequent hues. Also, can introduce edge artifacts when used with graphics since it's not designed for working with a small number of colors.

  - [Agglomerative hierarchical clustering](http://www.improvedoutcomes.com/docs/WebSiteDocs/Clustering/Agglomerative_Hierarchical_Clustering_Overview.htm) - http://harthur.github.io/clusterfck/<br>
    I only discovered this one recently. It's not quite a full quantization lib, but seems to do the important parts. Rather slowly though :(

My original goal was to upscale frames from `<canvas>` graphics animations and pixelated SNES-style games for [GIFter.js](https://github.com/leeoniya/GIFter.js). It became apparent after trying the first three options that I would need something different.
