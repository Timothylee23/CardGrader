// centering.ts - STEP 2: measure border widths and turn them into a PSA-style grade.
//
// Pattern: for each side, learn the border colour from a thin strip just
// inside the card edge. Then, on ~300 scan lines, walk inward until the colour
// clearly changes - that's the border width on that line. Take the MEDIAN of
// all lines, so text or a scratch on a few lines doesn't matter.
//
// Example: left median 40px, right 37px -> 40 / (40 + 37) = 51.9/48.1.
// The worse split of left/right vs top/bottom is looked up in the PSA table.

import type { CV, Mat } from "@techstark/opencv-js";
import { MatTracker } from "./mats.ts";
import { CARD_HEIGHT, CARD_WIDTH } from "./detectCard.ts";
import { type Point, percentile } from "./geometry.ts";

// --- Settings (pixels of the 750x1050 warped card) ---
const EDGE_SKIP = 8;              // ignore outermost pixels (edge wear, small warp errors)
const REF_STRIP = 8;              // thickness of the strip used to learn the border colour
const COLOR_CHANGE_THRESHOLD = 25; // Lab distance that counts as "not border any more"
const RUN_LENGTH = 4;             // colour must stay different this many pixels in a row
const MAX_BORDER_FRACTION = 0.25; // never look more than 25% into the card
const SCAN_START = 0.2, SCAN_END = 0.8; // only scan the middle 60% of each side
const MAX_SPREAD = 6;             // px; more than this between scan lines = unreliable

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
  width: number;      // median border width in px
  spread: number;     // middle-50% range of the scan lines (big = unreliable)
  found: number;      // scan lines that found an edge
  scanned: number;    // scan lines tried
  hitPoints: Point[]; // where each line found the edge (for the debug image)
};

// Either a full result or an error - check `ok` first (a "discriminated union").
export type CenteringResult =
  | {
      ok: true;
      sides: Record<SideName, SideMeasurement>; // like Dictionary<SideName, SideMeasurement>
      leftPct: number;   // left / (left + right) * 100
      topPct: number;    // top / (top + bottom) * 100
      worstPct: number;  // worse of the two splits, always >= 50
      grade: number;
      warnings: string[];
    }
  | { ok: false; error: string };

export function centeringGrade(worstPct: number, isFront: boolean): number {
  for (const [grade, frontLimit, backLimit] of PSA_CENTERING) {
    if (worstPct <= (isFront ? frontLimit : backLimit)) return grade;
  }
  return 1;
}

export function measureCentering(cv: CV, warped: Mat, isFront: boolean): CenteringResult {
  const lab = toLab(cv, warped);

  const sides = {} as Record<SideName, SideMeasurement>;
  for (const side of SIDES) {
    const m = measureSide(lab, side);
    if (!m) return { ok: false, error: `Couldn't find the inner edge of the ${side} border (full-art card?).` };
    sides[side] = m;
  }

  const { left, right, top, bottom } = sides;
  const leftPct = (100 * left.width) / (left.width + right.width);
  const topPct = (100 * top.width) / (top.width + bottom.width);
  // 45/55 is as bad as 55/45, so always take the bigger side.
  const worstPct = Math.max(leftPct, 100 - leftPct, topPct, 100 - topPct);

  const warnings = SIDES
    .filter((s) => sides[s].spread > MAX_SPREAD)
    .map((s) => `${s} border is inconsistent (spread ${sides[s].spread.toFixed(0)}px) - check the overlay`);

  return { ok: true, sides, leftPct, topPct, worstPct, grade: centeringGrade(worstPct, isFront), warnings };
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
// is the LEFT side. A scan line is "row", and "depth" is how far in from the
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
  const horizontal = side === "left" || side === "right";
  const rows = horizontal ? CARD_HEIGHT : CARD_WIDTH; // length of this side
  const cols = horizontal ? CARD_WIDTH : CARD_HEIGHT; // distance across the card
  const firstRow = Math.floor(rows * SCAN_START);
  const lastRow = Math.floor(rows * SCAN_END);
  const maxDepth = Math.floor(cols * MAX_BORDER_FRACTION);

  // Read the 3 Lab values of the pixel at (row, depth).
  const pixel = (row: number, depth: number): [number, number, number] => {
    const { x, y } = viewToCard(side, row, depth);
    const i = (y * CARD_WIDTH + x) * 3;
    return [lab[i], lab[i + 1], lab[i + 2]];
  };

  // Learn the border colour: median of each channel over the reference strip.
  const channels: number[][] = [[], [], []];
  for (let row = firstRow; row < lastRow; row++) {
    for (let depth = EDGE_SKIP; depth < EDGE_SKIP + REF_STRIP; depth++) {
      pixel(row, depth).forEach((v, c) => channels[c].push(v));
    }
  }
  const border = channels.map((values) => percentile(values.sort((a, b) => a - b), 50));

  // Scan every 2nd line inward until RUN_LENGTH pixels in a row look "not border".
  const depths: number[] = [];
  const hitPoints: Point[] = [];
  let scanned = 0;
  for (let row = firstRow; row < lastRow; row += 2) {
    scanned++;
    let run = 0;
    for (let depth = EDGE_SKIP; depth < maxDepth; depth++) {
      const [l, a, b] = pixel(row, depth);
      const diff = Math.hypot(l - border[0], a - border[1], b - border[2]);
      run = diff > COLOR_CHANGE_THRESHOLD ? run + 1 : 0;
      if (run === RUN_LENGTH) {
        const edgeDepth = depth - RUN_LENGTH + 1; // where the run started
        depths.push(edgeDepth);
        hitPoints.push(viewToCard(side, row, edgeDepth));
        break;
      }
    }
  }

  // Most lines never found an edge: no clear border.
  if (depths.length < 0.3 * scanned) return null;

  depths.sort((a, b) => a - b);
  return {
    width: percentile(depths, 50),
    spread: percentile(depths, 75) - percentile(depths, 25),
    found: depths.length,
    scanned,
    hitPoints,
  };
}

// Debug image: warped card + cyan dot per scan hit + red box for the inner frame.
// CALLER MUST .delete() the returned Mat.
export function drawCenteringDebug(cv: CV, warped: Mat, result: CenteringResult): Mat {
  const image = warped.clone();
  if (!result.ok) return image;
  const cyan = new cv.Scalar(0, 255, 255, 255);
  const red = new cv.Scalar(255, 0, 0, 255);

  // Red box first, dots on top so they stay visible.
  const { left, right, top, bottom } = result.sides;
  cv.rectangle(image,
    new cv.Point(Math.round(left.width), Math.round(top.width)),
    new cv.Point(Math.round(CARD_WIDTH - 1 - right.width), Math.round(CARD_HEIGHT - 1 - bottom.width)),
    red, 2);
  for (const side of SIDES) {
    for (const p of result.sides[side].hitPoints) {
      cv.circle(image, new cv.Point(p.x, p.y), 2, cyan, -1);
    }
  }
  return image;
}
