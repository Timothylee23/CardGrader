// BorderEditor.tsx - drag the card-edge (green) and border (red) lines to fix the measurement.
//
// Two views:
//   - Overview: the whole flattened card with all 8 lines. Tap near a side to pick it.
//   - Zoom: a close-up of the picked side, where you drag its 2 lines.
//     (A full-art border is ~10px - under 5 screen px on a phone without zoom.)
// Plus nudge buttons for half-pixel steps, and Reset to go back to the automatic lines.

import { useEffect, useMemo, useRef, useState } from "react";
import type { BorderLines } from "../grading/adjust.ts";
import { widthsFromLines } from "../grading/adjust.ts";
import type { SideName } from "../grading/centering.ts";
import type { DebugImage } from "../grading/gradeCard.ts";

type Props = {
  image: DebugImage;        // flattened card with some table around it
  lines: BorderLines;       // current lines (the parent owns this state)
  autoLines: BorderLines;   // what the algorithm found, for Reset
  onChange: (lines: BorderLines) => void;
};

type Which = "outer" | "inner";
type Crop = { x: number; y: number; w: number; h: number }; // part of the image shown in the zoom view

const SIDES: SideName[] = ["left", "top", "right", "bottom"];
const LABELS: Record<SideName, string> = { left: "Left", top: "Top", right: "Right", bottom: "Bottom" };
const OVERVIEW_W = 600;             // drawing size in "canvas px" (CSS scales it to fit the screen)
const ZOOM_W = 600, ZOOM_H = 360;
const ZOOM_SPAN = 110;              // card px shown across the side in the zoom view (at least)
const NUDGE = 0.5;                  // card px per nudge-button tap
const GRAB_DISTANCE = 45;           // zoom-canvas px: how close a touch must be to grab a line
const OUTER_COLOR = "#22c55e";      // green = card edge
const INNER_COLOR = "#ef4444";      // red = inner edge of the border

const isVertical = (side: SideName) => side === "left" || side === "right";

export function BorderEditor({ image, lines, autoLines, onChange }: Props) {
  const [side, setSide] = useState<SideName>("left");
  const [crop, setCrop] = useState<Crop>(() => cropFor("left", lines, image));
  const [active, setActive] = useState<Which | null>(null); // line being dragged (drawn thicker)
  const overviewRef = useRef<HTMLCanvasElement>(null);
  const zoomRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ which: Which; startPointer: number; startValue: number } | null>(null);

  // The image as a canvas we can copy pieces from (made once per image).
  const source = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext("2d")?.putImageData(
      new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
    return canvas;
  }, [image]);

  const overviewH = Math.round((OVERVIEW_W * image.height) / image.width);
  const overviewScale = OVERVIEW_W / image.width;
  const zoomScale = ZOOM_W / crop.w; // zoom-canvas px per image px

  // --- Drawing (re-runs whenever lines, side, crop or the dragged line change) ---
  useEffect(() => {
    const ctx = setupCanvas(overviewRef.current, OVERVIEW_W, overviewH);
    if (!ctx) return;
    ctx.drawImage(source, 0, 0, OVERVIEW_W, overviewH);
    // Highlight the picked side's border strip.
    ctx.fillStyle = "rgba(245, 197, 24, 0.25)";
    const band = bandRect(side, lines);
    ctx.fillRect(band.x * overviewScale, band.y * overviewScale, band.w * overviewScale, band.h * overviewScale);
    for (const s of SIDES) {
      const width = s === side ? 4 : 2.5;
      drawLine(ctx, s, lines.outer[s], overviewScale, 0, 0, OVERVIEW_W, overviewH, OUTER_COLOR, width);
      drawLine(ctx, s, lines.inner[s], overviewScale, 0, 0, OVERVIEW_W, overviewH, INNER_COLOR, width);
    }
  }, [source, lines, side, overviewH, overviewScale]);

  useEffect(() => {
    const ctx = setupCanvas(zoomRef.current, ZOOM_W, ZOOM_H);
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false; // show real pixels, so you can see exactly where the border ends
    ctx.drawImage(source, crop.x, crop.y, crop.w, crop.h, 0, 0, ZOOM_W, ZOOM_H);
    for (const which of ["outer", "inner"] as Which[]) {
      const color = which === "outer" ? OUTER_COLOR : INNER_COLOR;
      const width = active === which ? 5 : 3;
      drawLine(ctx, side, lines[which][side], zoomScale, crop.x, crop.y, ZOOM_W, ZOOM_H, color, width, true);
    }
  }, [source, lines, side, crop, active, zoomScale]);

  // --- Picking a side ---
  function pickSide(next: SideName, current = lines) {
    setSide(next);
    setCrop(cropFor(next, current, image));
  }

  // Tap on the overview: pick the side whose border strip is closest to the tap.
  function handleOverviewTap(e: React.PointerEvent<HTMLCanvasElement>) {
    const p = toCanvas(e, OVERVIEW_W, overviewH);
    const x = p.x / overviewScale, y = p.y / overviewScale;
    const distance = (s: SideName) => {
      const middle = (lines.outer[s] + lines.inner[s]) / 2;
      return Math.abs((isVertical(s) ? x : y) - middle);
    };
    pickSide(SIDES.reduce((a, b) => (distance(b) < distance(a) ? b : a)));
  }

  // --- Dragging in the zoom view ---
  // Position across the side (x for left/right, y for top/bottom), in zoom-canvas px.
  const across = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = toCanvas(e, ZOOM_W, ZOOM_H);
    return isVertical(side) ? p.x : p.y;
  };
  const onScreen = (which: Which) =>
    (lines[which][side] - (isVertical(side) ? crop.x : crop.y)) * zoomScale;

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    const at = across(e);
    // Grab whichever line is closer to the finger (if either is close enough).
    const nearest: Which = Math.abs(onScreen("outer") - at) <= Math.abs(onScreen("inner") - at) ? "outer" : "inner";
    if (Math.abs(onScreen(nearest) - at) > GRAB_DISTANCE) return;
    e.currentTarget.setPointerCapture(e.pointerId); // keep getting moves even if the finger slides off
    drag.current = { which: nearest, startPointer: at, startValue: lines[nearest][side] };
    setActive(nearest);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drag.current) return;
    const { which, startPointer, startValue } = drag.current;
    onChange(moveLine(lines, side, which, startValue + (across(e) - startPointer) / zoomScale, image));
  }

  function handlePointerUp() {
    if (!drag.current) return;
    drag.current = null;
    setActive(null);
    // If a line got dragged out of the zoom view, re-centre on the side.
    const inView = (which: Which) => onScreen(which) > 10 && onScreen(which) < (isVertical(side) ? ZOOM_W : ZOOM_H) - 10;
    if (!inView("outer") || !inView("inner")) setCrop(cropFor(side, lines, image));
  }

  function nudge(which: Which, direction: -1 | 1) {
    onChange(moveLine(lines, side, which, lines[which][side] + direction * NUDGE, image));
  }

  const widths = widthsFromLines(lines);
  const [less, more] = isVertical(side) ? ["◀", "▶"] : ["▲", "▼"];

  return (
    <div className="editor">
      <canvas ref={overviewRef} className="editor-overview" onPointerDown={handleOverviewTap} />

      <div className="editor-tabs">
        {SIDES.map((s) => (
          <button key={s} className={s === side ? "tab selected" : "tab"} onClick={() => pickSide(s)}>
            {LABELS[s]}<br /><small>{widths[s].toFixed(1)}px</small>
          </button>
        ))}
      </div>

      <canvas
        ref={zoomRef}
        className="editor-zoom"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />
      <p className="note">Drag the lines in the close-up. Green = card edge, red = inner edge of the border.</p>

      <div className="editor-nudges">
        <span style={{ color: OUTER_COLOR }}>Card edge</span>
        <button className="tab" onClick={() => nudge("outer", -1)}>{less}</button>
        <button className="tab" onClick={() => nudge("outer", 1)}>{more}</button>
        <span style={{ color: INNER_COLOR }}>Border</span>
        <button className="tab" onClick={() => nudge("inner", -1)}>{less}</button>
        <button className="tab" onClick={() => nudge("inner", 1)}>{more}</button>
      </div>
      <button className="link" onClick={() => { onChange(autoLines); pickSide(side, autoLines); }}>
        Reset to automatic
      </button>
    </div>
  );
}

// --- Helpers (plain functions, no React) ---

// Size a canvas for sharp drawing on high-DPI (Retina) screens; returns its 2D context.
function setupCanvas(canvas: HTMLCanvasElement | null, width: number, height: number) {
  if (!canvas) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in "canvas px"; the browser handles the rest
  return ctx;
}

// Pointer position in "canvas px" (the canvas is CSS-scaled to fit the screen).
function toCanvas(e: React.PointerEvent<HTMLCanvasElement>, width: number, height: number) {
  const rect = e.currentTarget.getBoundingClientRect();
  return { x: ((e.clientX - rect.left) * width) / rect.width, y: ((e.clientY - rect.top) * height) / rect.height };
}

// Draw one side's line. `value` is in image px; offsetX/Y is where the view starts in the image.
function drawLine(
  ctx: CanvasRenderingContext2D, side: SideName, value: number, scale: number,
  offsetX: number, offsetY: number, viewW: number, viewH: number,
  color: string, width: number, withGrip = false,
) {
  const vertical = isVertical(side);
  const pos = vertical ? (value - offsetX) * scale : (value - offsetY) * scale;
  const path = () => {
    ctx.beginPath();
    if (vertical) { ctx.moveTo(pos, 0); ctx.lineTo(pos, viewH); }
    else { ctx.moveTo(0, pos); ctx.lineTo(viewW, pos); }
  };
  // Dark outline first, then the colour on top: visible on light AND dark card art.
  path();
  ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
  ctx.lineWidth = width + 2;
  ctx.stroke();
  path();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
  if (withGrip) drawGrip(ctx, vertical ? pos : viewW / 2, vertical ? viewH / 2 : pos, color);
}

// A round handle so it's obvious the line can be dragged (big enough for a fingertip).
function drawGrip(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  ctx.beginPath();
  ctx.arc(x, y, 16, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "white";
  ctx.stroke();
}

// The rectangle between a side's outer and inner line (its border strip), in image px.
function bandRect(side: SideName, { outer, inner }: BorderLines) {
  switch (side) {
    case "left": return { x: outer.left, y: outer.top, w: inner.left - outer.left, h: outer.bottom - outer.top };
    case "right": return { x: inner.right, y: outer.top, w: outer.right - inner.right, h: outer.bottom - outer.top };
    case "top": return { x: outer.left, y: outer.top, w: outer.right - outer.left, h: inner.top - outer.top };
    case "bottom": return { x: outer.left, y: inner.bottom, w: outer.right - outer.left, h: outer.bottom - inner.bottom };
  }
}

// Which part of the image to show in the zoom view: centred on the side's
// border strip, halfway along the side, wide enough to show both lines.
function cropFor(side: SideName, lines: BorderLines, image: DebugImage): Crop {
  const middle = (lines.outer[side] + lines.inner[side]) / 2;
  const span = Math.max(ZOOM_SPAN, Math.abs(lines.inner[side] - lines.outer[side]) + 40);
  if (isVertical(side)) {
    const h = (span * ZOOM_H) / ZOOM_W;
    return { x: middle - span / 2, y: image.height / 2 - h / 2, w: span, h };
  }
  const w = (span * ZOOM_W) / ZOOM_H;
  return { x: image.width / 2 - w / 2, y: middle - span / 2, w, h: span };
}

// Move one line, keeping it inside the image and the inner line at least 1px
// inside the outer one (toward the middle of the card).
function moveLine(lines: BorderLines, side: SideName, which: Which, value: number, image: DebugImage): BorderLines {
  const max = (isVertical(side) ? image.width : image.height) - 1;
  let v = Math.min(Math.max(value, 0), max);
  const towardMiddle = side === "left" || side === "top" ? 1 : -1;
  const outer = lines.outer[side], inner = lines.inner[side];
  if (which === "inner") v = towardMiddle > 0 ? Math.max(v, outer + 1) : Math.min(v, outer - 1);
  else v = towardMiddle > 0 ? Math.min(v, inner - 1) : Math.max(v, inner + 1);
  return which === "outer"
    ? { outer: { ...lines.outer, [side]: v }, inner: lines.inner }
    : { outer: lines.outer, inner: { ...lines.inner, [side]: v } };
}
