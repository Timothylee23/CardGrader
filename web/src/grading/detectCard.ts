// detectCard.ts - STEP 1: find the card in a photo and warp it flat.
//
// Pattern:
//   1. Shrink the photo, make grayscale, blur.
//   2. Make black/white "masks" where the card might be one solid blob
//      (Canny edges, "bright things", "dark things").
//   3. Outline every blob, keep the biggest one that simplifies to 4 corners
//      and has a card's shape (~1.4x taller than wide).
//   4. Refine the corners: fit a straight line along each edge and intersect
//      them (real cards have rounded corners, so the "corner" is virtual).
//   5. Perspective-warp to a straight-on 750x1050 image (2.5"x3.5" @ 300dpi).

import type { CV, Mat } from "@techstark/opencv-js";
import { MatTracker } from "./mats.ts";
import {
  type Point, type Quad, distance, distanceToLine, fitLine, intersectLines,
  orderCorners, quadSize,
} from "./geometry.ts";

export const CARD_WIDTH = 750;
export const CARD_HEIGHT = 1050;
const DETECT_MAX_SIDE = 1200; // shrink to this before searching (faster, less noise)

export type DetectResult = {
  method: string;        // which mask found it: "edges" | "bright" | "dark"
  corners: Quad;         // in full-photo pixel coordinates
  warped: Mat;           // 750x1050 RGBA card. CALLER MUST .delete() IT.
  outlineDebug: Mat;     // shrunk photo with the outline drawn. CALLER MUST .delete() IT.
};

// Everything we learn about one candidate blob.
type Candidate = { method: string; area: number; corners: Quad };

export function detectCard(cv: CV, photo: Mat): DetectResult | null {
  const t = new MatTracker();
  try {
    // --- 1. Shrink ---
    const scale = Math.min(1, DETECT_MAX_SIDE / Math.max(photo.cols, photo.rows));
    const small = t.track(new cv.Mat());
    cv.resize(photo, small, new cv.Size(Math.round(photo.cols * scale), Math.round(photo.rows * scale)),
      0, 0, cv.INTER_AREA);
    const realScale = small.cols / photo.cols; // exact scale after rounding

    // --- 2 + 3. Try each mask, keep the biggest card-shaped blob ---
    let best: Candidate | null = null;
    for (const { method, mask } of makeMasks(cv, small, t)) {
      const found = findCardInMask(cv, mask, method, t);
      if (found && (!best || found.area > best.area)) best = found;
    }
    if (!best) return null;

    // Back to full-photo coordinates. OpenCV puts pixel CENTRES on whole
    // numbers, hence the +0.5 / -0.5 (plain "/ scale" is off by ~1px).
    const corners = best.corners.map((p) => ({
      x: (p.x + 0.5) / realScale - 0.5,
      y: (p.y + 0.5) / realScale - 0.5,
    })) as Quad;

    // --- 5. Warp ---
    const warped = warpCard(cv, photo, corners);
    const outlineDebug = drawOutline(cv, small, best.corners);
    return { method: best.method, corners, warped, outlineDebug };
  } finally {
    t.deleteAll(); // runs even if something above throws
  }
}

// Build the three masks. All Mats are tracked, so they get cleaned up later.
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

  return [
    { method: "edges", mask: edges },
    { method: "bright", mask: bright },
    { method: "dark", mask: dark },
  ];
}

function findCardInMask(cv: CV, mask: Mat, method: string, t: MatTracker): Candidate | null {
  const contours = t.track(new cv.MatVector());
  const hierarchy = t.track(new cv.Mat());
  cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);

  const imageArea = mask.rows * mask.cols;
  let best: Candidate | null = null;

  for (let i = 0; i < contours.size(); i++) {
    const contour = contours.get(i); // .get() makes a new Mat handle -> delete it
    try {
      const area = cv.contourArea(contour);
      if (area < 0.1 * imageArea) continue; // too small to be the card

      const box = cv.boundingRect(contour);
      const touchesEdge = box.x <= 2 || box.y <= 2 ||
        box.x + box.width >= mask.cols - 2 || box.y + box.height >= mask.rows - 2;
      if (touchesEdge) continue; // background, or the card is cut off

      const rough = contourToQuad(cv, contour);
      if (!rough || !looksLikeCard(rough)) continue;

      const corners = refineCorners(contourPoints(contour), rough);
      if (!best || area > best.area) best = { method, area, corners };
    } finally {
      contour.delete();
    }
  }
  return best;
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

function warpCard(cv: CV, photo: Mat, corners: Quad): Mat {
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
    const dst = t.track(cv.matFromArray(4, 1, cv.CV_32FC2,
      [0, 0, CARD_WIDTH - 1, 0, CARD_WIDTH - 1, CARD_HEIGHT - 1, 0, CARD_HEIGHT - 1]));
    const matrix = t.track(cv.getPerspectiveTransform(src, dst));
    const warped = new cv.Mat(); // NOT tracked: we hand it back to the caller
    cv.warpPerspective(photo, warped, matrix, new cv.Size(CARD_WIDTH, CARD_HEIGHT),
      cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());
    return warped;
  } finally {
    t.deleteAll();
  }
}

// Debug image: the shrunk photo with a green outline and labelled corners.
function drawOutline(cv: CV, small: Mat, corners: Quad): Mat {
  const image = small.clone();
  const green = new cv.Scalar(0, 255, 0, 255); // RGBA
  const red = new cv.Scalar(255, 0, 0, 255);
  const labels = ["TL", "TR", "BR", "BL"];
  corners.forEach((p, i) => {
    const next = corners[(i + 1) % 4];
    cv.line(image, new cv.Point(p.x, p.y), new cv.Point(next.x, next.y), green, 3);
  });
  corners.forEach((p, i) => {
    cv.circle(image, new cv.Point(p.x, p.y), 8, red, -1); // -1 = filled
    cv.putText(image, labels[i], new cv.Point(p.x + 10, p.y - 10),
      cv.FONT_HERSHEY_SIMPLEX, 1, red, 2);
  });
  return image;
}
