// centering.ts - STEP 2: measure border widths and turn them into a PSA-style grade.
//
// Pattern: the inner edge of a border is a STRAIGHT line parallel to the card
// edge. Texture, text and art are not. So for each side:
//   1. Split the side into 8 segments. In each segment, AVERAGE ~90 rows into
//      one colour profile running from the edge inward. Straight edges stay
//      sharp; swirls, text and noise blur away.
//   2. Turn the profile into an "edge strength" curve: how fast the colour
//      changes at each depth. Every bump on that curve is a candidate edge.
//   3. VOTE: the border edge is the first depth where at least 5 of the 8
//      segments have a candidate (within 3px). A logo or a swirl only shows up
//      in one or two segments, so it loses the vote - even if it's stronger.
//   4. Border width = median of the agreeing segments.
//
// Example: candidates per segment on the left side:
//   seg 1: 40, 52     seg 2: 40, 52     seg 3: 23 (logo), 40, 52   ...
//   depth 23 -> 1 vote, depth 40 -> 8 votes -> border is 40px.
// Right side comes out 37px -> 40 / (40 + 37) = 51.9/48.1.

import type { CV, Mat } from "@techstark/opencv-js";
import { MatTracker } from "./mats.ts";
import { CARD_HEIGHT, CARD_WIDTH } from "./detectCard.ts";
import { type Point, percentile } from "./geometry.ts";

// --- Settings (pixels of the 750x1050 warped card) ---
// Ignore the outermost pixels: the card's own edge (and any worn rim) shows up
// as a peak at 0-3px. Keep this SMALL - full-art cards have silver borders
// only ~1mm wide, which is just 8-10px here.
const EDGE_SKIP = 4;
const SEARCH_DEPTH = Math.round(CARD_WIDTH * 0.15); // look up to 112px in (15% of card width)
const SEGMENTS = 8;              // pieces per side; each one gives its own answer
const SCAN_START = 0.15, SCAN_END = 0.85; // skip the rounded corners
const MIN_EDGE_STRENGTH = 1.5;   // Lab change per pixel; weaker than this isn't a printed edge.
                                 // Low on purpose: silver next to white art is only ~2-6. The vote
                                 // below (5 of 8 segments must agree) filters out random bumps.
const PEAK_RATIO = 0.05;         // ...and at least 5% of that segment's strongest edge (bold text can be 10x stronger)
const MIN_VOTES = 5;             // segments (of 8) that must agree on an edge
const VOTE_TOLERANCE = 3;        // px; candidates this close count as "the same edge"
const MAX_SPREAD = 4;            // px between segments before we call it unreliable

// PSA centering: [grade, worst allowed front %, worst allowed back %].
// "55" means 55/45 or better. Double-check against psacard.com.
export const PSA_CENTERING: [number, number, number][] = [
  [10, 55, 75],
  [9, 60, 90],
  [8, 65, 90],
  [7, 70, 90],
  [6, 80, 90],
  [5, 85, 90],
  [4, 85, 90],
  [3, 90, 90],
  [2, 90, 90],
  [1, 100, 100],
];

export type SideName = "left" | "top" | "right" | "bottom";
const SIDES: SideName[] = ["left", "top", "right", "bottom"];

export type SideMeasurement = {
  width: number;          // median border width in px
  spread: number;         // middle-50% range of the segment answers (big = unreliable)
  found: number;          // segments that found an edge
  scanned: number;        // segments tried
};

// Border widths in px - like a C# record { Left, Top, Right, Bottom }.
export type Widths = Record<SideName, number>;

// The numbers we show for any set of border widths (measured OR hand-adjusted).
export type CenteringNumbers = {
  leftPct: number;   // left / (left + right) * 100
  topPct: number;    // top / (top + bottom) * 100
  worstPct: number;  // worse of the two splits, always >= 50
  grade: number;
};

// Either a full result or an error - check `ok` first (a "discriminated union").
export type CenteringResult =
  | (CenteringNumbers & {
      ok: true;
      sides: Record<SideName, SideMeasurement>; // like Dictionary<SideName, SideMeasurement>
      widths: Widths;
      warnings: string[];
    })
  | { ok: false; error: string };

export function centeringGrade(worstPct: number, isFront: boolean): number {
  for (const [grade, frontLimit, backLimit] of PSA_CENTERING) {
    if (worstPct <= (isFront ? frontLimit : backLimit)) return grade;
  }
  return 1;
}

// Widths -> ratios + PSA grade. Used for the automatic measurement and for
// the border editor, so both always agree.
export function centeringFromWidths(w: Widths, isFront: boolean): CenteringNumbers {
  const leftPct = (100 * w.left) / (w.left + w.right);
  const topPct = (100 * w.top) / (w.top + w.bottom);
  // 45/55 is as bad as 55/45, so always take the bigger side.
  const worstPct = Math.max(leftPct, 100 - leftPct, topPct, 100 - topPct);
  return { leftPct, topPct, worstPct, grade: centeringGrade(worstPct, isFront) };
}

export function measureCentering(cv: CV, warped: Mat, isFront: boolean): CenteringResult {
  const lab = toLab(cv, warped);

  const sides = {} as Record<SideName, SideMeasurement>;
  for (const side of SIDES) {
    const m = measureSide(lab, side);
    if (!m) {
      return {
        ok: false,
        error: `Couldn't find the inner edge of the ${side} border. If the card's edge blends into the table ` +
          "(e.g. a silver or white border on a white table), try a background that contrasts with the border.",
      };
    }
    sides[side] = m;
  }

  const widths: Widths = {
    left: sides.left.width, top: sides.top.width, right: sides.right.width, bottom: sides.bottom.width,
  };
  const warnings = SIDES
    .filter((s) => sides[s].spread > MAX_SPREAD)
    .map((s) => `${s} border is inconsistent (segments differ by ${sides[s].spread.toFixed(0)}px) - check it in the editor`);

  return { ok: true, sides, widths, warnings, ...centeringFromWidths(widths, isFront) };
}

// Blur + convert to Lab colour space, copied into a plain JS array.
// (In Lab, distance between colours roughly matches how different they LOOK.)
function toLab(cv: CV, warped: Mat): Uint8Array {
  const t = new MatTracker();
  try {
    const rgb = t.track(new cv.Mat());
    cv.cvtColor(warped, rgb, cv.COLOR_RGBA2RGB);
    cv.GaussianBlur(rgb, rgb, new cv.Size(5, 5), 0);
    const lab = t.track(new cv.Mat());
    cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
    return new Uint8Array(lab.data); // copy: lab.data points into WASM memory
  } finally {
    t.deleteAll();
  }
}

// Trick to write the scan code once instead of 4 times: pretend every side
// is the LEFT side. "row" runs along the side, "depth" is how far in from the
// edge we are. This converts (row, depth) to real (x, y) on the card.
function viewToCard(side: SideName, row: number, depth: number): Point {
  const w = CARD_WIDTH, h = CARD_HEIGHT;
  switch (side) {
    case "left": return { x: depth, y: row };
    case "top": return { x: w - 1 - row, y: depth };
    case "right": return { x: w - 1 - depth, y: h - 1 - row };
    case "bottom": return { x: row, y: h - 1 - depth };
  }
}

function measureSide(lab: Uint8Array, side: SideName): SideMeasurement | null {
  const sideLength = side === "left" || side === "right" ? CARD_HEIGHT : CARD_WIDTH;
  const firstRow = Math.floor(sideLength * SCAN_START);
  const segmentLength = (sideLength * (SCAN_END - SCAN_START)) / SEGMENTS;

  // --- Steps 1 + 2: candidate edges for each segment ---
  const candidates: number[][] = [];  // candidate depths, one list per segment
  for (let s = 0; s < SEGMENTS; s++) {
    const rowStart = Math.floor(firstRow + s * segmentLength);
    const rowEnd = Math.floor(firstRow + (s + 1) * segmentLength);
    candidates.push(findPeaks(edgeStrength(averageProfile(lab, side, rowStart, rowEnd))));
  }

  // --- Step 3: vote. Try candidates from the outside in; first to get enough votes wins. ---
  const allDepths = candidates.flat().sort((a, b) => a - b);
  let agreeing: (number | null)[] | null = null; // each segment's matching depth, or null
  for (const depth of allDepths) {
    const matches = candidates.map((list) => closestWithin(list, depth, VOTE_TOLERANCE));
    if (matches.filter((m) => m !== null).length >= MIN_VOTES) {
      agreeing = matches;
      break;
    }
  }
  if (!agreeing) return null; // no edge that most segments agree on: no clear border

  // --- Step 4: widths from the agreeing segments ---
  // The strength peak sits halfway between the last border pixel and the
  // first frame pixel, so the border is (peak + 0.5) pixels wide.
  const depths = agreeing.filter((peak) => peak !== null).map((peak) => peak + 0.5);
  depths.sort((a, b) => a - b);
  return {
    width: percentile(depths, 50),
    spread: percentile(depths, 75) - percentile(depths, 25),
    found: depths.length,
    scanned: SEGMENTS,
  };
}

// Average colour at each depth across rows rowStart..rowEnd.
// Returns one [L, a, b] per depth from 0 to SEARCH_DEPTH + 1.
function averageProfile(lab: Uint8Array, side: SideName, rowStart: number, rowEnd: number): number[][] {
  const profile: number[][] = [];
  const count = rowEnd - rowStart;
  for (let depth = 0; depth <= SEARCH_DEPTH + 1; depth++) {
    let l = 0, a = 0, b = 0;
    for (let row = rowStart; row < rowEnd; row++) {
      const { x, y } = viewToCard(side, row, depth);
      const i = (y * CARD_WIDTH + x) * 3;
      l += lab[i]; a += lab[i + 1]; b += lab[i + 2];
    }
    profile.push([l / count, a / count, b / count]);
  }
  return profile;
}

// How fast the colour changes at each depth: distance between the colours one
// pixel before and one pixel after, then lightly smoothed to calm noise.
function edgeStrength(profile: number[][]): number[] {
  const raw = profile.map((_, d) => {
    if (d === 0 || d === profile.length - 1) return 0;
    const [l1, a1, b1] = profile[d - 1];
    const [l2, a2, b2] = profile[d + 1];
    return Math.hypot(l2 - l1, a2 - a1, b2 - b1) / 2;
  });
  // [1, 2, 1] smoothing keeps peaks in the same place.
  return raw.map((v, d) => (d === 0 || d === raw.length - 1 ? v : (raw[d - 1] + 2 * v + raw[d + 1]) / 4));
}

// Depths (with sub-pixel precision) of every bump on the strength curve that's
// strong enough to be a printed edge.
function findPeaks(strength: number[]): number[] {
  const last = Math.min(SEARCH_DEPTH, strength.length - 2);
  let strongest = 0;
  for (let d = EDGE_SKIP; d <= last; d++) strongest = Math.max(strongest, strength[d]);
  const needed = Math.max(MIN_EDGE_STRENGTH, PEAK_RATIO * strongest);

  const peaks: number[] = [];
  for (let d = EDGE_SKIP; d <= last; d++) {
    const [before, here, after] = [strength[d - 1], strength[d], strength[d + 1]];
    if (here >= needed && here >= before && here > after) {
      // Fit a parabola through the 3 points to find the true top between pixels.
      const curve = before - 2 * here + after;
      const offset = curve === 0 ? 0 : (0.5 * (before - after)) / curve;
      peaks.push(d + offset);
    }
  }
  return peaks;
}

// The value in `list` closest to `target`, if it's within `tolerance`; else null.
function closestWithin(list: number[], target: number, tolerance: number): number | null {
  let best: number | null = null;
  for (const v of list) {
    if (Math.abs(v - target) <= tolerance && (best === null || Math.abs(v - target) < Math.abs(best - target))) {
      best = v;
    }
  }
  return best;
}
