// InstallHint.tsx - tells iPhone users how to add the app to their home screen.
// iOS has no "install" button/prompt like Android, so we have to explain it.

import { useState } from "react";

const DISMISS_KEY = "installHintDismissed";

function shouldShow(): boolean {
  const ua = navigator.userAgent;
  // iPads on iPadOS 13+ pretend to be Macs, so also check for a touch screen.
  const isIos = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  // Already launched from the home screen? Then don't nag.
  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return isIos && !isStandalone && localStorage.getItem(DISMISS_KEY) !== "1";
}

export function InstallHint() {
  const [visible, setVisible] = useState(shouldShow);
  if (!visible) return null;

  return (
    <div className="install-hint">
      <span>
        Install this app: tap <strong>Share</strong> <span aria-hidden>⎋</span> then{" "}
        <strong>Add to Home Screen</strong>.
      </span>
      <button
        className="link"
        onClick={() => {
          localStorage.setItem(DISMISS_KEY, "1");
          setVisible(false);
        }}
      >
        Got it
      </button>
    </div>
  );
}
