// Scanner.tsx - full-screen live camera that auto-captures once the card is
// in frame, flat, sharp and steady.
//
// Loop: every ~100 ms, copy the current video frame into a small canvas, run
// analyzeFrame() on it, draw the outline on top of the video, and update the
// message. When ScanTracker says "locked", grab a FULL-resolution frame and
// hand it back as a File, exactly like a photo from the camera button.

import { useEffect, useRef, useState } from "react";
import type { CV } from "@techstark/opencv-js";
import type { Face } from "../grading/gradeCard.ts";
import type { Quad } from "../grading/geometry.ts";
import { ANALYZE_SIDE, type ScanStatus, ScanTracker, analyzeFrame } from "../grading/scan.ts";

type Props = {
  cv: CV;
  face: Face;
  onCapture: (file: File) => void;
  onCancel: () => void;
};

const CHECK_INTERVAL_MS = 100; // ~10 checks per second

export function Scanner({ cv, face, onCapture, onCancel }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<ScanStatus>({
    state: "searching", message: "Starting camera…", progress: 0, detail: "",
  });
  const [error, setError] = useState<string | null>(null);

  // Keep the latest onCapture in a ref so the camera effect below doesn't
  // restart every time the parent re-renders with a new function.
  const onCaptureRef = useRef(onCapture);
  useEffect(() => {
    onCaptureRef.current = onCapture;
  });

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer = 0;
    let stopped = false;
    const tracker = new ScanTracker();
    const work = document.createElement("canvas"); // small canvas for analysis
    const workCtx = work.getContext("2d", { willReadFrequently: true })!;

    async function start() {
      // getUserMedia only exists on HTTPS (or localhost) pages.
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("Live scanning needs HTTPS. Use the https:// address, or use Take photo instead.");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          // Rear camera, as high-res as the phone will give us (4K on most iPhones).
          video: { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: 2160 } },
        });
      } catch (e) {
        setError(`Couldn't open the camera: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      if (stopped) return stopCamera(); // user closed the scanner while we waited

      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
      timer = window.setTimeout(tick, CHECK_INTERVAL_MS);
    }

    function tick() {
      if (stopped) return;
      const video = videoRef.current;
      if (video && video.videoWidth > 0) {
        // 1. Copy a shrunk video frame into the work canvas.
        const scale = ANALYZE_SIDE / Math.max(video.videoWidth, video.videoHeight);
        work.width = Math.round(video.videoWidth * scale);
        work.height = Math.round(video.videoHeight * scale);
        workCtx.drawImage(video, 0, 0, work.width, work.height);

        // 2. Check it with OpenCV.
        const frame = cv.matFromImageData(workCtx.getImageData(0, 0, work.width, work.height));
        let check;
        try {
          check = analyzeFrame(cv, frame);
        } finally {
          frame.delete();
        }
        const next = tracker.update(check, work.width, work.height);

        // 3. Show the user what we see.
        drawOverlay(overlayRef.current, work.width, work.height, check.corners, next);
        setStatus(next);

        // 4. Locked? Grab the full-resolution frame and stop checking.
        if (next.state === "locked") {
          grabFrame(video, face).then((file) => onCaptureRef.current(file));
          return;
        }
      }
      timer = window.setTimeout(tick, CHECK_INTERVAL_MS);
    }

    function stopCamera() {
      window.clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop()); // turns the camera light off
    }

    start();
    // Cleanup runs when the scanner closes: stop the loop and release the camera.
    return () => {
      stopped = true;
      stopCamera();
    };
  }, [cv, face]);

  // Fallback if auto-capture never locks (odd lighting, busy background, ...).
  async function captureNow() {
    const video = videoRef.current;
    if (video && video.videoWidth > 0) onCapture(await grabFrame(video, face));
  }

  return (
    <div className="scanner">
      <div className="scanner-view">
        {/* playsInline + muted are required for iOS to show live video inline */}
        <video ref={videoRef} playsInline muted autoPlay />
        <canvas ref={overlayRef} />
      </div>

      <div className="scanner-bar">
        <p className={`scanner-message ${status.state}`}>{error ?? status.message}</p>
        <div className="progress"><div style={{ width: `${status.progress * 100}%` }} /></div>
        {status.detail && <p className="scanner-detail">{status.detail}</p>}
        <div className="scanner-buttons">
          <button className="button" onClick={onCancel}>Cancel</button>
          <button className="button" onClick={captureNow} disabled={!!error}>Capture now</button>
        </div>
      </div>
    </div>
  );
}

// Draw the detected outline on the transparent canvas over the video.
// The canvas is the same size as the analysis frame and uses the same CSS
// object-fit as the video, so the two line up.
function drawOverlay(
  canvas: HTMLCanvasElement | null, width: number, height: number,
  corners: Quad | null, status: ScanStatus,
) {
  if (!canvas) return;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx || !corners) return;

  ctx.lineWidth = 4;
  ctx.strokeStyle = status.state === "steadying" || status.state === "locked" ? "#22c55e" : "#f5c518";
  ctx.beginPath();
  corners.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
  ctx.stroke();
}

// Copy the current video frame at full resolution into a JPEG File.
async function grabFrame(video: HTMLVideoElement, face: Face): Promise<File> {
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d")!.drawImage(video, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.95));
  if (!blob) throw new Error("Couldn't capture the frame");
  return new File([blob], `${face}-scan.jpg`, { type: "image/jpeg" });
}
