// gradeCard.ts - runs the pipeline on a photo and collects the results.
//
// Right now: detect -> centering. Corners, edges, surface and the final
// weighted grade plug in here in later stages.
//
// Nothing OpenCV-shaped leaks out of this file: images are copied into
// plain ImageData-style objects and every Mat is deleted before we return.

import type { CV, Mat } from "@techstark/opencv-js";
import { detectCard, warpCard } from "./detectCard.ts";
import { type CenteringResult, measureCentering } from "./centering.ts";
import { ADJUST_MARGIN, type BorderLines, linesFromWidths } from "./adjust.ts";

// Below this, fewer than ~70% of points along some side agreed on where the
// card's edge is - the outline (and so the centering) may be a few px off.
const LOW_EDGE_CONFIDENCE = 0.7;

export type Face = "front" | "back";

// Same shape as the browser's ImageData, so the UI can draw it straight onto a canvas.
export type DebugImage = { width: number; height: number; data: Uint8ClampedArray };

export type FaceResult = {
  face: Face;
  error?: string;              // set if something failed
  method?: string;             // which detection mask found the card
  warnings: string[];          // problems worth checking (result may be off)
  centering?: CenteringResult;
  debug: { label: string; image: DebugImage }[];
  // For the border editor (only if the card was found): the flattened card
  // with ADJUST_MARGIN px of table around it, and where the lines start.
  adjust?: { image: DebugImage; autoLines: BorderLines };
};

export type CardResult = { faces: FaceResult[] };

// Copy a Mat's pixels out of WASM memory. Expects RGBA (4 channels).
function toDebugImage(mat: Mat): DebugImage {
  return { width: mat.cols, height: mat.rows, data: new Uint8ClampedArray(mat.data) };
}

// Grade one photo. `photo` is an RGBA Mat - the caller still owns it.
export function gradeFace(cv: CV, photo: Mat, face: Face): FaceResult {
  const result: FaceResult = { face, warnings: [], debug: [] };

  // --- Step 1: detect + warp ---
  const found = detectCard(cv, photo);
  if (!found) {
    result.error = "No card found. Try a plain background that contrasts with the card's border, with space around the card.";
    return result;
  }
  try {
    result.method = found.method;
    if (found.cutOff) {
      result.warnings.push("The card seems to run off the edge of the photo, so the outline may be on an " +
        "inner frame instead of the card's outer edge. Retake it with the whole card in view and space around it.");
    }
    if (found.edgeConfidence < LOW_EDGE_CONFIDENCE) {
      result.warnings.push("The card's edge was hard to see, so the outline may be a few px off - " +
        "check the green lines in the editor, or try a background that contrasts with the border.");
    }
    result.debug.push({ label: "Detected outline", image: toDebugImage(found.outlineDebug) });

    // --- Step 2: centering ---
    result.centering = measureCentering(cv, found.warped, face === "front");
    if (result.centering.ok) {
      result.warnings.push(...result.centering.warnings);
    } else {
      result.error = `${result.centering.error} You can also set the red lines by hand below.`;
    }

    // --- Border editor: same warp, with some table showing around the card ---
    const withMargin = warpCard(cv, photo, found.corners, ADJUST_MARGIN);
    try {
      result.adjust = {
        image: toDebugImage(withMargin),
        autoLines: linesFromWidths(result.centering.ok ? result.centering.widths : null),
      };
    } finally {
      withMargin.delete();
    }
  } finally {
    found.warped.delete();
    found.outlineDebug.delete();
  }
  return result;
}
