// copy-opencv.mjs - copies opencv.js from node_modules into public/ so it's
// served as a plain file (see src/lib/opencv.ts for why).
// Runs automatically before `npm run dev` and `npm run build`.

import { copyFileSync, existsSync } from "node:fs";

const from = "node_modules/@techstark/opencv-js/dist/opencv.js";
const to = "public/opencv.js";

if (!existsSync(from)) {
  console.error(`Missing ${from} - run "npm install" first.`);
  process.exit(1);
}
copyFileSync(from, to);
console.log(`Copied ${from} -> ${to}`);
