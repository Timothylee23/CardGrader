// scan.ts - live scanning: decide when a video frame is good enough to grade.
//
// Pattern: run fast checks on small video frames ~10x a second.
//   1. Find the card's 4 corners (same detector as grading, no warp).
//   2. Check the frame: is the card big enough? Is the phone flat over it
//      (not tilted)? Is the image sharp (not motion-blurred)?
//   3. If everything passes for several frames IN A ROW and the corners
//      barely move, the card is "locked" -> grab a full-resolution frame.
//
// Example: frames 1-3 "Move closer", frame 4 OK, frames 5-11 OK and the
// corners moved < 1% each time -> 8 good frames -> capture.

import type { CV, Mat } from "@techstark/opencv-js";
import { findCardQuad } from "./detectCard.ts";
import { type Quad, distance, quadSize } from "./geometry.ts";
import { MatTracker } from "./mats.ts";

// --- Settings ---
export const ANALYZE_SIDE = 640; // video frames are shrunk to this (long side) before checking
const MIN_AREA = 0.25;           // card must fill at least 25% of the frame (more pixels = better grade)
const MIN_SQUARENESS = 0.9;      // opposite sides must be >= 90% the same length (phone held flat)
const MIN_SHARPNESS = 20;        // Laplacian variance; below this the frame is blurry
const MAX_MOVE = 0.01;           // corners may move <= 1% of the frame diagonal between frames
const STABLE_FRAMES = 8;         // good frames in a row needed to lock (~0.8 s)

export type FrameCheck = {
  corners: Quad | null; // in frame pixel coordinates
  issue: string | null; // what the user should fix, or null if the frame is good
  sharpness: number;
};

// Check one (small) video frame. `frame` is RGBA; the caller still owns it.
export function analyzeFrame(cv: CV, frame: Mat): FrameCheck {
  // Accept small cards here (3%) so we can tell the user to move closer.
  const found = findCardQuad(cv, frame, 0.03);
  if (!found) {
    return { corners: null, issue: "Looking for the card… keep all 4 edges in view", sharpness: 0 };
  }
  const corners = found.corners;
  const sharpness = measureSharpness(cv, frame, corners);

  // Tilt first: tilting also makes the card look smaller, and "move closer"
  // wouldn't fix that.
  if (squareness(corners) < MIN_SQUARENESS) {
    return { corners, issue: "Hold the phone flat, straight above the card", sharpness };
  }
  const areaFraction = quadArea(corners) / (frame.cols * frame.rows);
  if (areaFraction < MIN_AREA) return { corners, issue: "Move closer", sharpness };
  if (sharpness < MIN_SHARPNESS) return { corners, issue: "Hold steady, it's blurry", sharpness };

  return { corners, issue: null, sharpness };
}

// Area of a 4-sided shape ("shoelace formula").
function quadArea(q: Quad): number {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

// 1.0 = perfect rectangle seen straight on. Tilting the phone makes the far
// side look shorter than the near side, so this drops below 1.
function squareness(q: Quad): number {
  const [tl, tr, br, bl] = q;
  const top = distance(tl, tr), bottom = distance(bl, br);
  const left = distance(tl, bl), right = distance(tr, br);
  return Math.min(Math.min(top, bottom) / Math.max(top, bottom), Math.min(left, right) / Math.max(left, right));
}

// Sharpness = how "edgy" the card area is. The Laplacian highlights edges;
// blur smears them out, so its variance (spread) drops.
function measureSharpness(cv: CV, frame: Mat, corners: Quad): number {
  const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
  const x = Math.max(0, Math.floor(Math.min(...xs)));
  const y = Math.max(0, Math.floor(Math.min(...ys)));
  const w = Math.min(frame.cols, Math.ceil(Math.max(...xs))) - x;
  const h = Math.min(frame.rows, Math.ceil(Math.max(...ys))) - y;
  if (w < 10 || h < 10) return 0;

  const t = new MatTracker();
  try {
    const roi = t.track(frame.roi(new cv.Rect(x, y, w, h))); // a view of just the card area
    const gray = t.track(new cv.Mat());
    cv.cvtColor(roi, gray, cv.COLOR_RGBA2GRAY);
    const lap = t.track(new cv.Mat());
    cv.Laplacian(gray, lap, cv.CV_64F);
    const mean = t.track(new cv.Mat());
    const stdDev = t.track(new cv.Mat());
    cv.meanStdDev(lap, mean, stdDev);
    return stdDev.data64F[0] ** 2; // variance = std dev squared
  } finally {
    t.deleteAll();
  }
}

export type ScanState = "searching" | "adjust" | "steadying" | "locked";

export type ScanStatus = {
  state: ScanState;
  message: string;
  progress: number; // 0..1 toward locking
  detail: string;   // small debug text (sharpness etc.) to help tune the settings
};

// Remembers recent frames and decides when the card has been steady long enough.
export class ScanTracker {
  private previous: Quad | null = null;
  private goodFrames = 0;

  update(check: FrameCheck, frameWidth: number, frameHeight: number): ScanStatus {
    const detail = `sharpness ${check.sharpness.toFixed(0)}`;

    if (!check.corners || check.issue) {
      this.previous = check.corners;
      this.goodFrames = 0;
      return {
        state: check.corners ? "adjust" : "searching",
        message: check.issue ?? "Looking for the card…",
        progress: 0,
        detail,
      };
    }

    // Did the corners stay put since the last frame?
    const diagonal = Math.hypot(frameWidth, frameHeight);
    const moved = this.previous
      ? Math.max(...check.corners.map((p, i) => distance(p, this.previous![i])))
      : Infinity;
    this.goodFrames = moved <= MAX_MOVE * diagonal ? this.goodFrames + 1 : 1;
    this.previous = check.corners;

    const progress = Math.min(1, this.goodFrames / STABLE_FRAMES);
    const { width, height } = quadSize(check.corners);
    return {
      state: progress >= 1 ? "locked" : "steadying",
      message: progress >= 1 ? "Got it!" : "Hold still…",
      progress,
      detail: `${detail} · card ${width.toFixed(0)}×${height.toFixed(0)}px`,
    };
  }
}
