// gradeCard.ts - runs the pipeline on a photo and collects the results.
//
// Right now: detect -> centering. Corners, edges, surface and the final
// weighted grade plug in here in later stages.
//
// Nothing OpenCV-shaped leaks out of this file: debug images are copied into
// plain ImageData-style objects and every Mat is deleted before we return.

import type { CV, Mat } from "@techstark/opencv-js";
import { detectCard } from "./detectCard.ts";
import { type CenteringResult, drawCenteringDebug, measureCentering } from "./centering.ts";

export type Face = "front" | "back";

// Same shape as the browser's ImageData, so the UI can draw it straight onto a canvas.
export type DebugImage = { width: number; height: number; data: Uint8ClampedArray };

export type FaceResult = {
  face: Face;
  error?: string;              // set if something failed
  method?: string;             // which detection mask found the card
  centering?: CenteringResult;
  debug: { label: string; image: DebugImage }[];
};

export type CardResult = {
  faces: FaceResult[];
  centeringGrade: number | null; // worse of front/back; null if any face failed
};

// Copy a Mat's pixels out of WASM memory. Expects RGBA (4 channels).
function toDebugImage(mat: Mat): DebugImage {
  return { width: mat.cols, height: mat.rows, data: new Uint8ClampedArray(mat.data) };
}

// Grade one photo. `photo` is an RGBA Mat - the caller still owns it.
export function gradeFace(cv: CV, photo: Mat, face: Face): FaceResult {
  const result: FaceResult = { face, debug: [] };

  // --- Step 1: detect + warp ---
  const found = detectCard(cv, photo);
  if (!found) {
    result.error = "No card found. Try a plain, contrasting background with space around the card.";
    return result;
  }
  try {
    result.method = found.method;
    result.debug.push({ label: "Detected outline", image: toDebugImage(found.outlineDebug) });

    // --- Step 2: centering ---
    result.centering = measureCentering(cv, found.warped, face === "front");
    if (!result.centering.ok) result.error = result.centering.error;

    const overlay = drawCenteringDebug(cv, found.warped, result.centering);
    try {
      result.debug.push({ label: "Measured borders", image: toDebugImage(overlay) });
    } finally {
      overlay.delete();
    }
  } finally {
    found.warped.delete();
    found.outlineDebug.delete();
  }
  return result;
}

// Combine front + back. Graders are strict: the worse face sets the grade.
export function combineFaces(faces: FaceResult[]): CardResult {
  const grades = faces.map((f) => (f.centering?.ok ? f.centering.grade : null));
  const allOk = grades.length > 0 && grades.every((g) => g !== null);
  return { faces, centeringGrade: allOk ? Math.min(...(grades as number[])) : null };
}
