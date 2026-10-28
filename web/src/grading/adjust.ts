// adjust.ts - the border lines the user can drag to correct the automatic measurement.
//
// The editor shows the flattened card with ADJUST_MARGIN px of table around it.
// There are 8 lines: 4 "outer" (the card's cut edge) and 4 "inner" (where the
// border stops). Positions are in that image's pixels: x for left/right
// lines, y for top/bottom lines.
//
// Example: outer.left = 40 (the card edge), inner.left = 71.5
// -> the left border is 31.5px wide.

import { CARD_HEIGHT, CARD_WIDTH } from "./detectCard.ts";
import { type CenteringNumbers, type Widths, centeringFromWidths } from "./centering.ts";

export const ADJUST_MARGIN = 40; // px of table shown around the card
const GUESS_WIDTH = 30;          // where inner lines start if no border was found (~typical border)

export type BorderLines = { outer: Widths; inner: Widths };

// Lines for a card whose edge sits exactly at the margin, with these border widths.
// No widths (automatic measurement failed) -> start from a typical border.
export function linesFromWidths(widths: Widths | null): BorderLines {
  const w = widths ?? { left: GUESS_WIDTH, top: GUESS_WIDTH, right: GUESS_WIDTH, bottom: GUESS_WIDTH };
  const outer = {
    left: ADJUST_MARGIN,
    top: ADJUST_MARGIN,
    right: ADJUST_MARGIN + CARD_WIDTH - 1,
    bottom: ADJUST_MARGIN + CARD_HEIGHT - 1,
  };
  const inner = {
    left: outer.left + w.left,
    top: outer.top + w.top,
    right: outer.right - w.right,
    bottom: outer.bottom - w.bottom,
  };
  return { outer, inner };
}

// Border width on each side = distance between its outer and inner line.
export function widthsFromLines({ outer, inner }: BorderLines): Widths {
  return {
    left: inner.left - outer.left,
    top: inner.top - outer.top,
    right: outer.right - inner.right,
    bottom: outer.bottom - inner.bottom,
  };
}

export function centeringFromLines(lines: BorderLines, isFront: boolean): CenteringNumbers {
  return centeringFromWidths(widthsFromLines(lines), isFront);
}
