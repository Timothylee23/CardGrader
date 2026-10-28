// App.tsx - the main screen: pick photos -> grade -> show results.

import { useEffect, useState } from "react";
import type { CV } from "@techstark/opencv-js";
import { InstallHint } from "./components/InstallHint.tsx";
import { type Photo, PhotoPicker } from "./components/PhotoPicker.tsx";
import { Results } from "./components/Results.tsx";
import type { CardResult, Face } from "./grading/gradeCard.ts";
import { gradePhotos } from "./lib/grade.ts";
import { loadOpenCv } from "./lib/opencv.ts";

export default function App() {
  const [front, setFront] = useState<Photo | null>(null);
  const [back, setBack] = useState<Photo | null>(null);
  const [cv, setCv] = useState<CV | null>(null);
  const [cvError, setCvError] = useState<string | null>(null);
  const [grading, setGrading] = useState(false);
  const [result, setResult] = useState<CardResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Start loading OpenCV in the background as soon as the app opens.
  useEffect(() => {
    loadOpenCv().then(setCv).catch((e) => setCvError(String(e)));
  }, []);

  // Swap in a new photo for one side: free the old preview URL, make a new one,
  // and clear the old result since it no longer matches the photos.
  function pickPhoto(face: Face, file: File | null) {
    const old = face === "front" ? front : back;
    if (old) URL.revokeObjectURL(old.url);
    const next = file ? { file, url: URL.createObjectURL(file) } : null;
    if (face === "front") setFront(next);
    else setBack(next);
    setResult(null);
  }

  async function handleGrade() {
    if (!cv) return;
    setGrading(true);
    setError(null);
    setResult(null);
    // Grading blocks the page for a moment; wait a tick so "Grading…" actually shows.
    await new Promise((r) => setTimeout(r, 50));
    try {
      const photos: { face: Face; file: File }[] = [];
      if (front) photos.push({ face: "front", file: front.file });
      if (back) photos.push({ face: "back", file: back.file });
      setResult(await gradePhotos(cv, photos));
    } catch (e) {
      setError(`Something went wrong: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setGrading(false);
    }
  }

  const canGrade = cv && (front || back) && !grading;

  return (
    <main>
      <h1>CardGrader</h1>
      <InstallHint />

      <div className="pickers">
        <PhotoPicker label="Front" photo={front} onChange={(f) => pickPhoto("front", f)} />
        <PhotoPicker label="Back" photo={back} onChange={(f) => pickPhoto("back", f)} />
      </div>

      <button className="button primary" disabled={!canGrade} onClick={handleGrade}>
        {grading ? "Grading…" : cv ? "Grade card" : "Loading OpenCV…"}
      </button>
      {cvError && <p className="error">{cvError}</p>}
      {error && <p className="error">{error}</p>}

      {result && <Results result={result} />}

      <p className="note">
        Tips: plain dark background, bright even light, no flash, phone straight above the card,
        whole card in frame with space around it. Photos never leave your phone.
      </p>
    </main>
  );
}
