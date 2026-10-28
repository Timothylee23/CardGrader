// snapEdges.ts - make the card outline hug the card's REAL outer edge.
//
// Pattern: the first outline is rough - it can include a shadow, or land a
// few px inside when the card's edge is faint (silver border on a grey table).
// So for each side:
//   1. Take ~40 sample points along the rough side (skipping the corners).
//   2. At each one, walk across the side and list every place the colour
//      changes sharply ("candidates"). That includes the card edge, but also
//      the art edge further in, and wood grain or speckles further out.
//   3. Try straight lines through candidates. The card's edge is ONE straight
//      line along the whole side, so most sample points agree on it. Wood grain
//      wiggles and speckles are random, so they don't get enough votes.
//   4. Of the lines most samples agree on (card edge, art edge...), keep the
//      OUTERMOST one - that's the card's cut edge.
//   5. Intersect neighbouring sides' lines to get the corners.
//
// Only SHARP steps count as candidates. A card's cut edge goes from table to
// card in ~1-2px; a shadow fades over 10px+. So we compare the colour change
// across 2px with the change across 8px - for a shadow they're about the same
// rate, for a real edge the 2px change is much steeper.
//
// Example: on the left side, candidates at each sample are roughly
//   [+15 (grain), -3 (card edge), -11 (art edge)], [-3, -11, +4 (grain)], ...
// The line through -3 gets 36/40 votes, -11 gets 38/40, grain lines ~3/40.
// Outermost well-supported line = -3 -> the card edge is 3px inside the rough one.

import type { Mat } from "@techstark/opencv-js";
import {
  type Line, type Point, type Quad, distance, distanceToLine, fitLine, intersectLines,
} from "./geometry.ts";

const SAMPLES = 40;                    // sample points per side
const ALONG_START = 0.12, ALONG_END = 0.88; // skip the rounded corners
const SEARCH_FRACTION = 0.04;          // search +-4% of the side's length across it
const STEP = 0.5;                      // px between samples across the side
const MIN_STEP_STRENGTH = 5;           // RGB change per px; weaker isn't an edge
const CANDIDATE_RATIO = 0.15;          // candidates must be >= 15% of that sample's strongest step
const MIN_SHARPNESS = 1.6;             // (change rate over 2px) / (change rate over 8px); shadows ~1, edges 2-4
const VOTE_TOLERANCE = 1.5;            // px from a line to count as agreeing with it
const MIN_SUPPORT = 0.5;               // a line needs half the sample points to agree
const MAX_CORNER_MOVE = 0.03;          // give up if a corner moves more than 3% of the diagonal

export type SnapResult = {
  corners: Quad;
  support: number; // 0..1: share of sample points that agreed on the edge (weakest side). 0 = snapping failed.
};

// How far to search across each side. Default: +-4% of the side's length.
// "Grow" mode (see detectCard.ts) searches only OUTWARD, up to a fraction of
// the card's size the other way, to find a card edge outside an inner frame.
export type SnapOptions = { inwardPx?: number; outwardFraction?: number; maxCornerMove?: number };

// `photo` is RGBA; `rough` corners are in the photo's pixel coordinates.
export function snapToEdges(photo: Mat, rough: Quad, options: SnapOptions = {}): SnapResult {
  const failed = { corners: rough, support: 0 };
  const image = { data: photo.data, width: photo.cols, height: photo.rows };
  const center = {
    x: rough.reduce((s, p) => s + p.x, 0) / 4,
    y: rough.reduce((s, p) => s + p.y, 0) / 4,
  };

  const lines: Line[] = [];
  let weakestSupport = 1;
  for (let i = 0; i < 4; i++) {
    const start = rough[i], end = rough[(i + 1) % 4];
    const length = distance(start, end);
    const dir = { x: (end.x - start.x) / length, y: (end.y - start.y) / length };
    // Normal = perpendicular to the side, flipped if needed so it points OUTWARD.
    let normal = { x: -dir.y, y: dir.x };
    const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    if (normal.x * (mid.x - center.x) + normal.y * (mid.y - center.y) < 0) {
      normal = { x: -normal.x, y: -normal.y };
    }
    // Search window across the side: `outReach` px outside to `inReach` px inside.
    const across = distance(rough[(i + 1) % 4], rough[(i + 2) % 4]); // card size the other way
    const outReach = options.outwardFraction !== undefined
      ? options.outwardFraction * across
      : Math.max(6, SEARCH_FRACTION * length);
    const inReach = options.inwardPx ?? Math.max(6, SEARCH_FRACTION * length);

    // --- Steps 1 + 2: candidate offsets (positive = outward) at each sample ---
    const samples: { along: number; offsets: number[] }[] = [];
    for (let k = 0; k < SAMPLES; k++) {
      const along = (ALONG_START + ((ALONG_END - ALONG_START) * k) / (SAMPLES - 1)) * length;
      const base = { x: start.x + dir.x * along, y: start.y + dir.y * along };
      samples.push({ along, offsets: edgeCandidates(image, base, dir, normal, outReach, inReach) });
    }

    // --- Steps 3 + 4: outermost straight line most samples agree on ---
    const best = outermostSupportedLine(samples);
    if (!best) return failed; // edge too faint or too messy to trust
    weakestSupport = Math.min(weakestSupport, best.length / SAMPLES);

    // Turn the agreeing candidates into real points and fit a line through them.
    const points = best.map(({ along, offset }) => ({
      x: start.x + dir.x * along + normal.x * offset,
      y: start.y + dir.y * along + normal.y * offset,
    }));
    const first = fitLine(points);
    if (!first) return failed;
    const close = points.filter((p) => distanceToLine(p, first) < 1.5);
    const line = fitLine(close.length >= 8 ? close : points);
    if (!line) return failed;
    lines.push(line);
  }

  // --- Step 5: corners ---
  const snapped: Point[] = [];
  for (let i = 0; i < 4; i++) {
    const p = intersectLines(lines[(i + 3) % 4], lines[i]); // corner i is between side i-1 and side i
    if (!p) return failed;
    snapped.push(p);
  }
  const diagonal = distance(rough[0], rough[2]);
  const moved = Math.max(...snapped.map((p, i) => distance(p, rough[i])));
  if (moved > (options.maxCornerMove ?? MAX_CORNER_MOVE) * diagonal) return failed;
  return { corners: snapped as Quad, support: weakestSupport };
}

type Sample = { along: number; offsets: number[] };
type Hit = { along: number; offset: number };

// Try lines through pairs of candidates (one from the first third of the side,
// one from the last third). A line "offset = a + slope * along" collects a vote
// from every sample with a candidate within VOTE_TOLERANCE of it.
// Returns the agreeing hits of the outermost line with enough votes.
function outermostSupportedLine(samples: Sample[]): Hit[] | null {
  const third = Math.floor(samples.length / 3);
  const needed = MIN_SUPPORT * samples.length;
  let best: { hits: Hit[]; meanOffset: number } | null = null;

  for (let k1 = 0; k1 < third; k1 += 2) {
    for (let k2 = samples.length - third; k2 < samples.length; k2 += 2) {
      const s1 = samples[k1], s2 = samples[k2];
      for (const o1 of s1.offsets) {
        for (const o2 of s2.offsets) {
          const slope = (o2 - o1) / (s2.along - s1.along);
          const hits: Hit[] = [];
          for (const s of samples) {
            const predicted = o1 + slope * (s.along - s1.along);
            let closest: number | null = null;
            for (const o of s.offsets) {
              if (Math.abs(o - predicted) <= VOTE_TOLERANCE &&
                  (closest === null || Math.abs(o - predicted) < Math.abs(closest - predicted))) {
                closest = o;
              }
            }
            if (closest !== null) hits.push({ along: s.along, offset: closest });
          }
          if (hits.length < needed) continue;
          const meanOffset = hits.reduce((sum, h) => sum + h.offset, 0) / hits.length;
          if (!best || meanOffset > best.meanOffset) best = { hits, meanOffset };
        }
      }
    }
  }
  return best ? best.hits : null;
}

type Image = { data: Uint8Array; width: number; height: number };

// Walk from `outReach` px outside to `inReach` px inside along `normal`. Returns
// the offsets (positive = outward) of every sharp colour step.
function edgeCandidates(
  image: Image, base: Point, dir: Point, normal: Point, outReach: number, inReach: number,
): number[] {
  const count = Math.floor((outReach + inReach) / STEP) + 1;
  const colors: number[][] = [];
  for (let j = 0; j < count; j++) {
    const s = outReach - j * STEP; // outside -> inside
    // Average 5 points along the side to calm noise and print texture.
    let r = 0, g = 0, b = 0;
    for (let u = -2; u <= 2; u++) {
      const [cr, cg, cb] = colorAt(image, base.x + normal.x * s + dir.x * u, base.y + normal.y * s + dir.y * u);
      r += cr; g += cg; b += cb;
    }
    colors.push([r / 5, g / 5, b / 5]);
  }

  // Colour change per px, measured across `px` pixels centred on each point.
  const changeRate = (px: number) => {
    const span = Math.round(px / 2 / STEP);
    return colors.map((_, j) => {
      if (j < span || j >= count - span) return 0;
      const [r1, g1, b1] = colors[j - span], [r2, g2, b2] = colors[j + span];
      return Math.hypot(r2 - r1, g2 - g1, b2 - b1) / px;
    });
  };
  const fine = changeRate(2);   // sharp detail
  const coarse = changeRate(8); // the bigger picture
  const strength = fine.map((v, j) => (j === 0 || j === count - 1 ? v : (fine[j - 1] + 2 * v + fine[j + 1]) / 4));

  const needed = Math.max(MIN_STEP_STRENGTH, CANDIDATE_RATIO * Math.max(...strength));
  const offsets: number[] = [];
  for (let j = 1; j < count - 1; j++) {
    const [before, here, after] = [strength[j - 1], strength[j], strength[j + 1]];
    const sharp = here / Math.max(coarse[j], 0.5) >= MIN_SHARPNESS; // shadows fail this
    if (sharp && here >= needed && here >= before && here > after) {
      const curve = before - 2 * here + after; // parabola fit for sub-pixel accuracy
      const shift = curve === 0 ? 0 : (0.5 * (before - after)) / curve;
      offsets.push(outReach - (j + shift) * STEP);
    }
  }
  return offsets;
}

// Colour at a non-whole-number position, blended from the 4 nearest pixels ("bilinear").
function colorAt(image: Image, x: number, y: number): [number, number, number] {
  const { data, width, height } = image;
  x = Math.min(Math.max(x, 0), width - 1.001);
  y = Math.min(Math.max(y, 0), height - 1.001);
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const result: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const p = (yy: number, xx: number) => data[(yy * width + xx) * 4 + c];
    const top = p(y0, x0) * (1 - fx) + p(y0, x0 + 1) * fx;
    const bottom = p(y0 + 1, x0) * (1 - fx) + p(y0 + 1, x0 + 1) * fx;
    result[c] = top * (1 - fy) + bottom * fy;
  }
  return result;
}
