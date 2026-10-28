// grade.ts - glue between the UI (Files) and the grading pipeline (Mats).

import type { CV } from "@techstark/opencv-js";
import { type CardResult, type Face, type FaceResult, gradeFace } from "../grading/gradeCard.ts";
import { fileToImageData } from "./loadImage.ts";

export async function gradePhotos(
  cv: CV,
  photos: { face: Face; file: File }[],
): Promise<CardResult> {
  const faces: FaceResult[] = [];
  for (const { face, file } of photos) {
    const imageData = await fileToImageData(file);
    const mat = cv.matFromImageData(imageData); // RGBA Mat in WASM memory
    try {
      faces.push(gradeFace(cv, mat, face));
    } finally {
      mat.delete();
    }
  }
  return { faces };
}
