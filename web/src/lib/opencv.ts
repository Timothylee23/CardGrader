// opencv.ts - loads OpenCV.js once, on demand.
//
// opencv.js is ~13 MB (the WebAssembly is baked into the file), so instead of
// bundling it into our app code we serve it as a plain file from /public and
// add a <script> tag. The service worker caches it, so after the first load
// it works offline. Photos never leave the phone - everything runs here.

import type { CV } from "@techstark/opencv-js";

let cvPromise: Promise<CV> | null = null; // shared, so we only ever load it once

export function loadOpenCv(): Promise<CV> {
  if (cvPromise) return cvPromise;

  cvPromise = new Promise<CV>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${import.meta.env.BASE_URL}opencv.js`; // BASE_URL is "./" (see vite.config.ts)
    script.async = true;
    script.onload = async () => {
      // The script sets window.cv. Depending on the build it's either a
      // Promise, an object that's still starting up, or ready to go.
      let cv = (window as unknown as { cv: unknown }).cv;
      if (cv instanceof Promise) {
        cv = await cv;
      } else if (!(cv as CV).Mat) {
        await new Promise<void>((done) => {
          (cv as { onRuntimeInitialized: () => void }).onRuntimeInitialized = done;
        });
      }
      resolve(cv as CV);
    };
    script.onerror = () => {
      cvPromise = null; // allow a retry
      reject(new Error("Couldn't load opencv.js"));
    };
    document.body.appendChild(script);
  });
  return cvPromise;
}
