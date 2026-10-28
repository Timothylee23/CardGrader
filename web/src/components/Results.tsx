// Results.tsx - sub-scores, final grade and debug overlays.

import { useEffect, useRef } from "react";
import type { CardResult, DebugImage, FaceResult } from "../grading/gradeCard.ts";

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

function FaceCard({ result }: { result: FaceResult }) {
  const c = result.centering;
  return (
    <section className="face">
      <h3>{result.face === "front" ? "Front" : "Back"}</h3>
      {result.error && <p className="error">{result.error}</p>}

      {c?.ok && (
        <table>
          <tbody>
            <tr><td>Borders (px)</td>
              <td>L {c.sides.left.width.toFixed(0)} · R {c.sides.right.width.toFixed(0)} · T {c.sides.top.width.toFixed(0)} · B {c.sides.bottom.width.toFixed(0)}</td></tr>
            <tr><td>Left / Right</td><td>{split(c.leftPct)}</td></tr>
            <tr><td>Top / Bottom</td><td>{split(c.topPct)}</td></tr>
            <tr><td>Worst split</td><td>{split(c.worstPct)}</td></tr>
            <tr><td>Centering</td><td><strong>{c.grade}</strong></td></tr>
          </tbody>
        </table>
      )}
      {c?.ok && c.warnings.map((w) => <p key={w} className="warning">⚠ {w}</p>)}

      {result.debug.map((d) => (
        <figure key={d.label}>
          <DebugCanvas image={d.image} />
          <figcaption>{d.label}{d.label === "Detected outline" && result.method ? ` (found via ${result.method})` : ""}</figcaption>
        </figure>
      ))}
    </section>
  );
}

export function Results({ result }: { result: CardResult }) {
  return (
    <div className="results">
      <div className="scores">
        <div className="score"><span>Centering</span><strong>{result.centeringGrade ?? "–"}</strong></div>
        {/* Placeholders for later stages */}
        <div className="score pending"><span>Corners</span><strong>–</strong></div>
        <div className="score pending"><span>Edges</span><strong>–</strong></div>
        <div className="score pending"><span>Surface</span><strong>–</strong></div>
      </div>
      <p className="note">Final grade comes once corners, edges and surface are built.</p>
      {result.faces.map((f) => <FaceCard key={f.face} result={f} />)}
    </div>
  );
}
