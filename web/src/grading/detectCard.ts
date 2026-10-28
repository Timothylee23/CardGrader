// detectCard.ts - STEP 1: find the card in a photo and warp it flat.
//
// Pattern:
//   1. Shrink the photo, make grayscale, blur.
//   2. Make black/white "masks" where the card might be one solid blob
//      (Canny edges, faint edges, "bright things", "dark things", "not the table").
//   3. Outline every blob, keep the biggest one that simplifies to 4 corners
//      and has a card's shape (~1.4x taller than wide).
//   4. Refine the corners: fit a straight line along each edge and intersect
//      them (real cards have rounded corners, so the "corner" is virtual).
//   5. Snap each side onto the card's real edge at full resolution (snapEdges.ts),
//      so shadows and faint silver edges don't throw the outline off.
//   6. Perspective-warp to a straight-on 750x1050 image (2.5"x3.5" @ 300dpi).

import type { CV, Mat } from "@techstark/opencv-js";
import { MatTracker } from "./mats.ts";
import { snapToEdges } from "./snapEdges.ts";
import {
  type Point, type Quad, distance, distanceToLine, fitLine, intersectLines,
  orderCorners, quadArea, quadSize,
} from "./geometry.ts";

export const CARD_WIDTH = 750;
export const CARD_HEIGHT = 1050;
const DETECT_MAX_SIDE = 1200; // shrink to this before searching (faster, less noise)

export type QuadResult = {
  method: string;         // which mask found it, e.g. "edges", "not table"
  corners: Quad;          // in the input image's pixel coordinates
  edgeConfidence: number; // 0..1: how clearly the card's edge was found (weakest side)
  cutOff: boolean;        // card seems to run off the photo's edge (we may have found an inner frame)
};

export type DetectResult = QuadResult & {
  warped: Mat;       // 750x1050 RGBA card. CALLER MUST .delete() IT.
  outlineDebug: Mat; // shrunk photo with the outline drawn. CALLER MUST .delete() IT.
};

// Everything we learn about one candidate blob.
export type Candidate = { method: string; area: number; corners: Quad };

// Steps 1-4 + 5: find the card and warp it flat. Used for grading.
export function detectCard(cv: CV, photo: Mat): DetectResult | null {
  const found = findCardQuad(cv, photo);
  if (!found) return null;
  const warped = warpCard(cv, photo, found.corners);
  const outlineDebug = drawOutline(cv, photo, found.corners);
  return { ...found, warped, outlineDebug }; // "..." copies method + corners in
}

// Steps 1-5: find the card's 4 corners, no warp.
// minArea: smallest blob (fraction of the image) that can count as the card.
// The scanner passes a smaller value so it can say "move closer".
// snap: the live scanner turns this off - it runs ~10x a second and only
// needs "is the card in frame?"; the full-res capture gets snapped later.
export function findCardQuad(cv: CV, photo: Mat, minArea = 0.1, snap = true): QuadResult | null {
  const { candidates, edgeBlobs } = findRoughQuads(cv, photo, minArea);
  if (candidates.length === 0) return null;
  if (!snap) {
    const biggest = candidates.reduce((a, b) => (b.area > a.area ? b : a));
    return {
      method: biggest.method, corners: biggest.corners, edgeConfidence: 1,
      cutOff: looksCutOff(biggest.corners, edgeBlobs, photo.cols, photo.rows),
    };
  }

  // --- 5. Snap every candidate onto real edges. Candidates whose sides snap
  // cleanly (most points agree on a straight edge) beat ones that don't - a
  // blob that swallowed wood grain has ragged sides. Among clean ones, the
  // BIGGEST wins: the card's outer edge always surrounds its inner frame, and
  // a perfectly printed inner frame shouldn't win just for being neater.
  let best: { method: string; corners: Quad; support: number } | null = null;
  let bestArea = 0;
  for (const c of candidates) {
    const snapped = snapToEdges(photo, c.corners);
    const area = snapped.support > 0 ? quadArea(snapped.corners) : c.area;
    const better = !best ||
      (snapped.support > 0 && best.support === 0) ||
      ((snapped.support > 0) === (best.support > 0) && area > bestArea);
    if (better) {
      best = { method: c.method, corners: snapped.corners, support: snapped.support };
      bestArea = area;
    }
  }
  let { method, corners, support } = best!;

  // --- 6. Grow: is there a clean straight edge further OUT? If no mask
  // outlined the card's outer edge (border blends into the table), we may be
  // on an inner frame - search outward up to 8% of the card's size.
  const grown = snapToEdges(photo, corners, { inwardPx: 3, outwardFraction: 0.08, maxCornerMove: 0.1 });
  if (grown.support > 0 && quadArea(grown.corners) > 1.03 * quadArea(corners)) {
    corners = grown.corners;
    support = grown.support;
    method += " + grow";
  }

  return { method, corners, edgeConfidence: support, cutOff: looksCutOff(corners, edgeBlobs, photo.cols, photo.rows) };
}

// Steps 1-4: the best card-shaped blob from EACH mask, as rough outlines in
// full-photo coordinates (can be off by a few px, or include a shadow), plus
// any big blobs touching the photo's edge (all in full-photo coordinates).
export function findRoughQuads(
  cv: CV, photo: Mat, minArea = 0.1,
): { candidates: Candidate[]; edgeBlobs: EdgeBlob[] } {
  const t = new MatTracker();
  try {
    // --- 1. Shrink (small inputs like video frames are left as-is) ---
    const scale = Math.min(1, DETECT_MAX_SIDE / Math.max(photo.cols, photo.rows));
    const small = t.track(new cv.Mat());
    cv.resize(photo, small, new cv.Size(Math.round(photo.cols * scale), Math.round(photo.rows * scale)),
      0, 0, cv.INTER_AREA);
    const realScale = small.cols / photo.cols; // exact scale after rounding

    // --- 2 + 3 + 4. One card-shaped blob per mask ---
    const candidates: Candidate[] = [];
    const edgeBlobs: EdgeBlob[] = [];
    for (const { method, mask } of makeMasks(cv, small, t)) {
      const found = findCardInMask(cv, mask, method, minArea, t);
      for (const b of found.edgeBlobs) {
        edgeBlobs.push({
          area: b.area / realScale ** 2,
          box: { x: b.box.x / realScale, y: b.box.y / realScale, width: b.box.width / realScale, height: b.box.height / realScale },
        });
      }
      if (!found.card) continue;
      // Back to full-photo coordinates. OpenCV puts pixel CENTRES on whole
      // numbers, hence the +0.5 / -0.5 (plain "/ scale" is off by ~1px).
      const corners = found.card.corners.map((p) => ({
        x: (p.x + 0.5) / realScale - 0.5,
        y: (p.y + 0.5) / realScale - 0.5,
      })) as Quad;
      candidates.push({ method, area: found.card.area / realScale ** 2, corners });
    }
    return { candidates, edgeBlobs };
  } finally {
    t.deleteAll(); // runs even if something above throws
  }
}

// Does the card seem to run off the photo? Two checks:
//  1. The outline we found is right at (or past) the photo's edge - less than
//     3% of the card's size of table around it. Either the card is cut off,
//     or there's no table left to see its edge against. (This is the common
//     one: after "move closer", the card's outer edge leaves the frame and
//     what's left that looks like a card is its INNER frame, ~a border inside.)
//  2. Backup: the outline sits inside a slightly bigger blob that touches the
//     photo's edge. (A card's inner frame is ~75-90% of the card's area, so
//     that blob would be a little bigger - not 3x bigger like the table.)
function looksCutOff(corners: Quad, edgeBlobs: EdgeBlob[], photoWidth: number, photoHeight: number): boolean {
  const { width, height } = quadSize(corners);
  const minMargin = 0.03 * Math.min(width, height);
  const closeToEdge = corners.some((p) =>
    Math.min(p.x, p.y, photoWidth - 1 - p.x, photoHeight - 1 - p.y) < minMargin);
  if (closeToEdge) return true;

  const area = quadArea(corners);
  const cx = corners.reduce((s, p) => s + p.x, 0) / 4;
  const cy = corners.reduce((s, p) => s + p.y, 0) / 4;
  return edgeBlobs.some(({ area: blobArea, box }) =>
    blobArea > 1.05 * area && blobArea < 2.5 * area &&
    cx > box.x && cx < box.x + box.width && cy > box.y && cy < box.y + box.height);
}

// Build the masks. All Mats are tracked, so they get cleaned up later.
function makeMasks(cv: CV, small: Mat, t: MatTracker): { method: string; mask: Mat }[] {
  const gray = t.track(new cv.Mat());
  cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
  const blurred = t.track(new cv.Mat());
  cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

  // Edges: Canny marks pixels where brightness changes sharply.
  const edges = t.track(new cv.Mat());
  cv.Canny(blurred, edges, 50, 150);
  const kernel = t.track(cv.Mat.ones(5, 5, cv.CV_8U));
  cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel); // close small gaps in the outline

  // Brightness: Otsu automatically picks the best light/dark split.
  // The card might be the light part OR the dark part, so keep both.
  const bright = t.track(new cv.Mat());
  cv.threshold(blurred, bright, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  const dark = t.track(new cv.Mat());
  cv.bitwise_not(bright, dark);

  // Faint edges: same as above with much lower thresholds, for cards whose
  // edge barely differs from the table (silver border on white).
  const faintEdges = t.track(new cv.Mat());
  cv.Canny(blurred, faintEdges, 15, 45);
  cv.morphologyEx(faintEdges, faintEdges, cv.MORPH_CLOSE, kernel);

  return [
    { method: "edges", mask: edges },
    { method: "bright", mask: bright },
    { method: "dark", mask: dark },
    { method: "faint edges", mask: faintEdges },
    { method: "not table", mask: notTableMask(cv, small, t) },
  ];
}

// "Everything that isn't the table." Learns the table's colour from a band
// around the photo's edge (the card shouldn't touch the edge), allowing for
// light that gets brighter or darker across the photo. Even if a card's edge
// matches the table, the art inside it won't, so the card shows up as a blob.
function notTableMask(cv: CV, small: Mat, t: MatTracker): Mat {
  const rgb = t.track(new cv.Mat());
  cv.cvtColor(small, rgb, cv.COLOR_RGBA2RGB);
  const lab = t.track(new cv.Mat());
  cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
  const data = lab.data;
  const width = lab.cols, height = lab.rows;

  // Sample the band (every 3rd pixel) and fit a flat-but-tilted colour
  // surface per channel: colour = a + b*x + c*y.
  const band = Math.round(0.04 * Math.min(width, height));
  const xs: number[] = [], ys: number[] = [];
  const values: number[][] = [[], [], []];
  for (let y = 0; y < height; y += 3) {
    for (let x = 0; x < width; x += 3) {
      if (x >= band && x < width - band && y >= band && y < height - band) continue;
      xs.push(x); ys.push(y);
      for (let c = 0; c < 3; c++) values[c].push(data[(y * width + x) * 3 + c]);
    }
  }
  const planes = values.map((v) => fitPlane(xs, ys, v));
  const tableAt = (c: number, x: number, y: number) => planes[c][0] + planes[c][1] * x + planes[c][2] * y;

  // How "noisy" the table is: 95th percentile of the band's leftover differences.
  const residuals = xs.map((x, i) =>
    Math.hypot(...[0, 1, 2].map((c) => values[c][i] - tableAt(c, x, ys[i]))),
  ).sort((a, b) => a - b);
  const threshold = Math.max(10, 2 * residuals[Math.floor(residuals.length * 0.95)]);

  // Mark every pixel that's further from the table colour than that.
  // (This loop runs on every pixel, so it's written for speed: compare squared
  // distances to skip a square root, and step the table colour along each row
  // by adding the x-slope instead of recomputing it.)
  const mask = t.track(new cv.Mat(height, width, cv.CV_8UC1));
  const out = mask.data;
  const limit = threshold * threshold;
  const [p0, p1, p2] = planes;
  for (let y = 0; y < height; y++) {
    let t0 = tableAt(0, 0, y), t1 = tableAt(1, 0, y), t2 = tableAt(2, 0, y);
    for (let x = 0, i = y * width; x < width; x++, i++) {
      const d0 = data[i * 3] - t0, d1 = data[i * 3 + 1] - t1, d2 = data[i * 3 + 2] - t2;
      out[i] = d0 * d0 + d1 * d1 + d2 * d2 > limit ? 255 : 0;
      t0 += p0[1]; t1 += p1[1]; t2 += p2[1];
    }
  }

  // Clean up: fill pinholes, then remove specks.
  const close = t.track(cv.Mat.ones(7, 7, cv.CV_8U));
  const open = t.track(cv.Mat.ones(5, 5, cv.CV_8U));
  cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, close);
  cv.morphologyEx(mask, mask, cv.MORPH_OPEN, open);
  return mask;
}

// Least-squares fit of v = a + b*x + c*y. Returns [a, b, c].
function fitPlane(xs: number[], ys: number[], vs: number[]): [number, number, number] {
  // Build the 3x3 "normal equations" and solve them with Cramer's rule.
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0, sv = 0, sxv = 0, syv = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i], y = ys[i], v = vs[i];
    n++; sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y;
    sv += v; sxv += x * v; syv += y * v;
  }
  const det3 = (m: number[][]) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const A = [[n, sx, sy], [sx, sxx, sxy], [sy, sxy, syy]];
  const rhs = [sv, sxv, syv];
  const d = det3(A);
  if (Math.abs(d) < 1e-9) return [sv / Math.max(n, 1), 0, 0]; // fall back to a flat colour
  const withColumn = (col: number) => A.map((row, r) => row.map((v, c) => (c === col ? rhs[r] : v)));
  return [det3(withColumn(0)) / d, det3(withColumn(1)) / d, det3(withColumn(2)) / d];
}

// A big, rectangle-ish blob that touches the photo's edge. Usually that's the
// table - but if it surrounds the card we found, the CARD is probably cut off
// by the photo's edge and what we found is an inner frame.
type EdgeBlob = { area: number; box: { x: number; y: number; width: number; height: number } };

function findCardInMask(
  cv: CV, mask: Mat, method: string, minArea: number, t: MatTracker,
): { card: Candidate | null; edgeBlobs: EdgeBlob[] } {
  const contours = t.track(new cv.MatVector());
  const hierarchy = t.track(new cv.Mat());
  cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);

  const imageArea = mask.rows * mask.cols;
  let best: Candidate | null = null;
  const edgeBlobs: EdgeBlob[] = [];

  for (let i = 0; i < contours.size(); i++) {
    const contour = contours.get(i); // .get() makes a new Mat handle -> delete it
    try {
      const area = cv.contourArea(contour);
      if (area < minArea * imageArea) continue; // too small to be the card

      const box = cv.boundingRect(contour);
      const touchesEdge = box.x <= 2 || box.y <= 2 ||
        box.x + box.width >= mask.cols - 2 || box.y + box.height >= mask.rows - 2;
      if (touchesEdge) {
        // Remember it if it's rectangle-shaped and not the whole photo. (The table's
        // outline wraps the entire photo; a card filling the frame can cover ~90%.)
        const rect = cv.minAreaRect(contour);
        const fill = area / Math.max(1, rect.size.width * rect.size.height);
        if (area < 0.97 * imageArea && fill > 0.8) edgeBlobs.push({ area, box });
        continue;
      }

      const rough = contourToQuad(cv, contour);
      if (!rough || !looksLikeCard(rough)) continue;

      const corners = refineCorners(contourPoints(contour), rough);
      if (!best || area > best.area) best = { method, area, corners };
    } finally {
      contour.delete();
    }
  }
  return { card: best, edgeBlobs };
}

// Copy a contour's points out of WASM memory into a normal JS array.
function contourPoints(contour: Mat): Point[] {
  const data = contour.data32S; // [x0, y0, x1, y1, ...]
  const points: Point[] = [];
  for (let i = 0; i < data.length; i += 2) points.push({ x: data[i], y: data[i + 1] });
  return points;
}

// Simplify a blob outline to 4 corners, or null.
function contourToQuad(cv: CV, contour: Mat): Quad | null {
  const perimeter = cv.arcLength(contour, true);
  // Rounded card corners sometimes need a looser simplification, so try a few.
  for (const eps of [0.02, 0.03, 0.04, 0.05]) {
    const approx = new cv.Mat();
    try {
      cv.approxPolyDP(contour, approx, eps * perimeter, true);
      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        return orderCorners(contourPoints(approx));
      }
    } finally {
      approx.delete();
    }
  }

  // Fallback: if the blob is very rectangle-like, use its tightest rotated box.
  const rect = cv.minAreaRect(contour);
  const boxArea = rect.size.width * rect.size.height;
  if (boxArea > 0 && cv.contourArea(contour) / boxArea > 0.9) {
    return orderCorners(rotatedRectCorners(rect.center, rect.size, rect.angle));
  }
  return null;
}

// The 4 corners of a rotated rectangle (done by hand - simple trig).
function rotatedRectCorners(
  center: Point, size: { width: number; height: number }, angleDeg: number,
): Point[] {
  const a = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const hw = size.width / 2, hh = size.height / 2;
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([dx, dy]) => ({
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  }));
}

// A card is 3.5 / 2.5 = 1.4x taller than wide. Allow slack for camera angle.
function looksLikeCard(q: Quad): boolean {
  const { width, height } = quadSize(q);
  if (Math.min(width, height) === 0) return false;
  const ratio = Math.max(width, height) / Math.min(width, height);
  return ratio >= 1.2 && ratio <= 1.7;
}

// Make corners precise: fit a line along the middle of each edge, then
// intersect neighbouring lines. 2px of error here = several % of centering later.
function refineCorners(points: Point[], rough: Quad): Quad {
  const lines = [];
  for (let i = 0; i < 4; i++) {
    // Side i runs from corner i to corner i+1 (% 4 wraps 3 -> 0).
    const start = rough[i], end = rough[(i + 1) % 4];
    const length = distance(start, end);
    const roughLine = {
      point: start,
      dir: { x: (end.x - start.x) / length, y: (end.y - start.y) / length },
    };
    // Keep outline points near this side, but away from the (rounded) corners.
    const onSide = points.filter((p) => {
      const along = ((p.x - start.x) * roughLine.dir.x + (p.y - start.y) * roughLine.dir.y) / length;
      return along > 0.1 && along < 0.9 && distanceToLine(p, roughLine) < 0.03 * length;
    });
    if (onSide.length < 10) return rough;

    // Fit once, drop stragglers more than 1.5px off, fit again.
    const first = fitLine(onSide);
    if (!first) return rough;
    const close = onSide.filter((p) => distanceToLine(p, first) < 1.5);
    const line = fitLine(close.length >= 10 ? close : onSide);
    if (!line) return rough;
    lines.push(line);
  }

  const refined: Point[] = [];
  for (let i = 0; i < 4; i++) {
    // Corner i sits between side i-1 and side i.
    const p = intersectLines(lines[(i + 3) % 4], lines[i]);
    if (!p) return rough;
    refined.push(p);
  }

  // Safety check: if a corner moved a lot, something went wrong - keep the rough ones.
  const diagonal = distance(rough[0], rough[2]);
  const moved = Math.max(...refined.map((p, i) => distance(p, rough[i])));
  return moved > 0.05 * diagonal ? rough : (refined as Quad);
}

// Warp the card to a straight-on 750x1050 image. `margin` adds that many px
// of the surrounding table on every side (the border editor uses this so the
// outer lines can be dragged outward too). CALLER MUST .delete() the result.
export function warpCard(cv: CV, photo: Mat, corners: Quad, margin = 0): Mat {
  let [tl, tr, br, bl] = corners;
  const { width, height } = quadSize(corners);
  if (width > height) {
    // Card is lying sideways: re-order so the long side becomes vertical.
    [tl, tr, br, bl] = [tr, br, bl, tl];
  }

  const t = new MatTracker();
  try {
    const src = t.track(cv.matFromArray(4, 1, cv.CV_32FC2,
      [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]));
    const m = margin, right = margin + CARD_WIDTH - 1, bottom = margin + CARD_HEIGHT - 1;
    const dst = t.track(cv.matFromArray(4, 1, cv.CV_32FC2, [m, m, right, m, right, bottom, m, bottom]));
    const matrix = t.track(cv.getPerspectiveTransform(src, dst));
    const warped = new cv.Mat(); // NOT tracked: we hand it back to the caller
    cv.warpPerspective(photo, warped, matrix, new cv.Size(CARD_WIDTH + 2 * margin, CARD_HEIGHT + 2 * margin),
      cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());
    return warped;
  } finally {
    t.deleteAll();
  }
}

// Debug image: a shrunk copy of the photo with a green outline and labelled corners.
function drawOutline(cv: CV, photo: Mat, corners: Quad): Mat {
  const scale = Math.min(1, DETECT_MAX_SIDE / Math.max(photo.cols, photo.rows));
  const image = new cv.Mat();
  cv.resize(photo, image, new cv.Size(Math.round(photo.cols * scale), Math.round(photo.rows * scale)),
    0, 0, cv.INTER_AREA);
  const pts = corners.map((p) => new cv.Point(Math.round(p.x * scale), Math.round(p.y * scale)));

  const green = new cv.Scalar(0, 255, 0, 255); // RGBA
  const red = new cv.Scalar(255, 0, 0, 255);
  const labels = ["TL", "TR", "BR", "BL"];
  pts.forEach((p, i) => cv.line(image, p, pts[(i + 1) % 4], green, 3));
  pts.forEach((p, i) => {
    cv.circle(image, p, 8, red, -1); // -1 = filled
    cv.putText(image, labels[i], new cv.Point(p.x + 10, p.y - 10), cv.FONT_HERSHEY_SIMPLEX, 1, red, 2);
  });
  return image;
}
