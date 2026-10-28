// Results.tsx - sub-scores, the border editor and debug images.
//
// The border lines live here as state, one set per face. The table and the
// Centering score are always computed from the CURRENT lines, so dragging a
// line in the editor updates the numbers and grade immediately.

import { useEffect, useRef, useState } from "react";
import { type BorderLines, centeringFromLines, widthsFromLines } from "../grading/adjust.ts";
import type { CardResult, DebugImage, FaceResult } from "../grading/gradeCard.ts";
import { BorderEditor } from "./BorderEditor.tsx";

// Draws one of the pipeline's debug images onto a <canvas>.
function DebugCanvas({ image }: { image: DebugImage }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    canvas.width = image.width;
    canvas.height = image.height;
    // Copy into a fresh array so the type is exactly what ImageData wants.
    const pixels = new Uint8ClampedArray(image.data);
    canvas.getContext("2d")?.putImageData(new ImageData(pixels, image.width, image.height), 0, 0);
  }, [image]);
  return <canvas ref={ref} className="debug-canvas" />;
}

// "52.6/47.4"
const split = (pct: number) => `${pct.toFixed(1)}/${(100 - pct).toFixed(1)}`;

// True if any line was moved away from where the algorithm put it.
const edited = (a: BorderLines, b: BorderLines) =>
  JSON.stringify(a) !== JSON.stringify(b);

// Lines worth grading: measured automatically, or set by the user. If the
// automatic step failed and nothing was moved yet, the lines are just a
// starting guess - don't turn that into a grade.
function gradableLines(face: FaceResult, lines: BorderLines | null): BorderLines | null {
  if (!lines || !face.adjust) return null;
  const measured = face.centering?.ok ?? false;
  return measured || edited(lines, face.adjust.autoLines) ? lines : null;
}

type FaceCardProps = {
  result: FaceResult;
  lines: BorderLines | null;
  onLinesChange: (lines: BorderLines) => void;
};

function FaceCard({ result, lines, onLinesChange }: FaceCardProps) {
  const isFront = result.face === "front";
  const gradable = gradableLines(result, lines);
  const numbers = gradable ? centeringFromLines(gradable, isFront) : null;
  const widths = gradable ? widthsFromLines(gradable) : null;
  const wasEdited = lines && result.adjust ? edited(lines, result.adjust.autoLines) : false;

  return (
    <section className="face">
      <h3>
        {isFront ? "Front" : "Back"}
        {wasEdited && <span className="badge">adjusted</span>}
      </h3>
      {result.error && <p className="error">{result.error}</p>}

      {numbers && widths && (
        <table>
          <tbody>
            <tr><td>Borders (px)</td>
              <td>L {widths.left.toFixed(1)} · R {widths.right.toFixed(1)} · T {widths.top.toFixed(1)} · B {widths.bottom.toFixed(1)}</td></tr>
            <tr><td>Left / Right</td><td>{split(numbers.leftPct)}</td></tr>
            <tr><td>Top / Bottom</td><td>{split(numbers.topPct)}</td></tr>
            <tr><td>Worst split</td><td>{split(numbers.worstPct)}</td></tr>
            <tr><td>Centering</td><td><strong>{numbers.grade}</strong></td></tr>
          </tbody>
        </table>
      )}
      {result.warnings.map((w) => <p key={w} className="warning">⚠ {w}</p>)}

      {result.debug.map((d) => (
        <figure key={d.label}>
          <DebugCanvas image={d.image} />
          <figcaption>{d.label}{d.label === "Detected outline" && result.method ? ` (found via ${result.method})` : ""}</figcaption>
        </figure>
      ))}

      {result.adjust && lines && (
        <>
          <h4>Adjust borders</h4>
          <BorderEditor
            image={result.adjust.image}
            lines={lines}
            autoLines={result.adjust.autoLines}
            onChange={onLinesChange}
          />
        </>
      )}
    </section>
  );
}

export function Results({ result }: { result: CardResult }) {
  // One set of lines per face, starting where the algorithm put them.
  // (App gives this component a new `key` for each grading, which resets this state.)
  const [lines, setLines] = useState<(BorderLines | null)[]>(
    () => result.faces.map((f) => f.adjust?.autoLines ?? null),
  );

  // Graders are strict: the worse face sets the centering score.
  const grades = result.faces.map((f, i) => {
    const l = gradableLines(f, lines[i]);
    return l ? centeringFromLines(l, f.face === "front").grade : null;
  });
  const centering = grades.length > 0 && grades.every((g) => g !== null)
    ? Math.min(...(grades as number[]))
    : null;

  return (
    <div className="results">
      <div className="scores">
        <div className="score"><span>Centering</span><strong>{centering ?? "–"}</strong></div>
        {/* Placeholders for later stages */}
        <div className="score pending"><span>Corners</span><strong>–</strong></div>
        <div className="score pending"><span>Edges</span><strong>–</strong></div>
        <div className="score pending"><span>Surface</span><strong>–</strong></div>
      </div>
      <p className="note">Final grade comes once corners, edges and surface are built.</p>
      {result.faces.map((f, i) => (
        <FaceCard
          key={f.face}
          result={f}
          lines={lines[i]}
          onLinesChange={(next) => setLines((all) => all.map((l, j) => (j === i ? next : l)))}
        />
      ))}
    </div>
  );
}
