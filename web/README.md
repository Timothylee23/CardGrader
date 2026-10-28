# CardGrader (web / PWA)

Grades trading cards from a photo using classic computer vision (OpenCV.js).
Everything runs in the browser: no servers, no APIs, photos never leave the phone.

## Run

```bash
npm install
npm run dev -- --host     # dev server, also reachable from your phone on the same Wi-Fi
npm run build             # production build -> dist/
npm run preview -- --host # serve the production build locally
```

## Layout

- `src/grading/` - the pipeline (no React, no DOM)
  - `detectCard.ts` - step 1: find the card, warp to 750x1050
  - `centering.ts` - step 2: border widths -> PSA centering grade
  - `gradeCard.ts` - runs the steps, combines front + back
  - `geometry.ts`, `mats.ts` - helpers
- `src/lib/` - browser glue (load OpenCV, load photos)
- `src/components/` - UI
- `public/` - `manifest.json`, `sw.js` (offline), icons. `opencv.js` is copied here from node_modules on dev/build.

The original Python prototype is `../card_grader.py`.
