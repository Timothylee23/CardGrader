// geometry.ts - small 2D math helpers. Plain TypeScript, no OpenCV needed.

export type Point = { x: number; y: number };

// Four corners, always in this order: top-left, top-right, bottom-right, bottom-left.
export type Quad = [Point, Point, Point, Point];

// A line stored as "a point on the line" + "which way it goes".
export type Line = { point: Point; dir: Point };

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Average width and height of a quad (opposite sides can differ under perspective).
export function quadSize(q: Quad): { width: number; height: number } {
  const [tl, tr, br, bl] = q;
  return {
    width: (distance(tl, tr) + distance(bl, br)) / 2,
    height: (distance(tl, bl) + distance(tr, br)) / 2,
  };
}

// Put 4 points in TL, TR, BR, BL order. Works even when the card is tilted.
export function orderCorners(points: Point[]): Quad {
  const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
  const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length;
  // Sorting by angle around the centre goes clockwise on screen (image y points DOWN).
  const sorted = [...points].sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx),
  );
  // Rotate the list so it starts at the top-left (smallest x + y).
  let start = 0;
  sorted.forEach((p, i) => {
    if (p.x + p.y < sorted[start].x + sorted[start].y) start = i;
  });
  const ordered = [0, 1, 2, 3].map((i) => sorted[(start + i) % 4]);
  return ordered as Quad;
}

// Best-fit straight line through a bunch of points ("total least squares").
// Unlike y = mx + b this also works for vertical lines.
export function fitLine(points: Point[]): Line | null {
  if (points.length < 2) return null;
  const n = points.length;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of points) {
    sxx += (p.x - mx) ** 2;
    syy += (p.y - my) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  // Angle of the direction the points are most spread out along.
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { point: { x: mx, y: my }, dir: { x: Math.cos(angle), y: Math.sin(angle) } };
}

// Distance from a point to an (infinite) line.
export function distanceToLine(p: Point, line: Line): number {
  // Cross product of the direction with (p - linePoint) = perpendicular distance.
  return Math.abs(line.dir.x * (p.y - line.point.y) - line.dir.y * (p.x - line.point.x));
}

// Where two lines cross, or null if they're parallel.
export function intersectLines(l1: Line, l2: Line): Point | null {
  const cross = l1.dir.x * l2.dir.y - l1.dir.y * l2.dir.x;
  if (Math.abs(cross) < 1e-9) return null;
  const dx = l2.point.x - l1.point.x;
  const dy = l2.point.y - l1.point.y;
  const t = (dx * l2.dir.y - dy * l2.dir.x) / cross;
  return { x: l1.point.x + t * l1.dir.x, y: l1.point.y + t * l1.dir.y };
}

// Value at a given percentile (0-100) of an already-sorted array.
export function percentile(sorted: number[], pct: number): number {
  if (sorted.length === 0) return NaN;
  const index = (pct / 100) * (sorted.length - 1);
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
}
