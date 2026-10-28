"""
card_grader.py - Trading card grader, steps 1 and 2.

  Step 1: Find the card in a photo and warp it into a flat, straight-on rectangle.
  Step 2: Measure the border widths and turn them into a PSA-style centering grade.

Usage (from the CardGrader folder):
    python card_grader.py --front photos/front.jpg
    python card_grader.py --front photos/front.jpg --back photos/back.jpg

Debug images are written to the "debug" folder so you can see what the
algorithm "sees" at each stage.
"""

# --- Imports (like "using" statements in C#) ---
import argparse            # reads command-line arguments (like string[] args in Main)
from pathlib import Path   # file-path helper (like System.IO.Path / FileInfo)

import cv2                 # OpenCV: the computer-vision library
import numpy as np         # NumPy: fast arrays. In OpenCV, an image IS a NumPy array.


# =============================================================================
# Settings - tweak these while testing. (Python has no "const"; ALL_CAPS
# names are just the convention for "please don't change this at runtime".)
# =============================================================================

# Standard trading card is 2.5" x 3.5". At 300 pixels per inch that's 750 x 1050.
CARD_WIDTH_PX = 750
CARD_HEIGHT_PX = 1050

# Photos are shrunk to this size (longest side) before searching for the card.
# Faster, and tiny details like card texture stop confusing the edge finder.
DETECT_MAX_SIDE = 1200

# Centering measurement settings (in pixels of the 750x1050 warped card).
EDGE_SKIP_PX = 8              # skip the outermost pixels (edge wear, small warp errors)
REF_STRIP_PX = 8              # thickness of the strip used to learn the border colour
COLOR_CHANGE_THRESHOLD = 25.0  # how different (in Lab colour space) counts as "not border"
RUN_LENGTH = 4                # colour must stay different this many pixels in a row
MAX_BORDER_FRACTION = 0.25    # never look more than 25% of the way into the card
SCAN_START, SCAN_END = 0.20, 0.80  # only scan the middle 60% of each side (avoid corners)

# PSA centering standards: (grade, worst allowed front %, worst allowed back %).
# "55" means a 55/45 split or better. Check psacard.com for the current table;
# these are the commonly published values.
PSA_CENTERING = [
    (10, 55, 75),
    (9, 60, 90),
    (8, 65, 90),
    (7, 70, 90),
    (6, 80, 90),
    (5, 85, 90),
    (4, 85, 90),
    (3, 90, 90),
    (2, 90, 90),
    (1, 100, 100),
]


# =============================================================================
# Small helpers
# =============================================================================

def load_image(path):
    """Load an image. (cv2.imread can't handle non-English characters in
    Windows paths, so we read the raw bytes with NumPy and decode them.)"""
    if not Path(path).is_file():
        return None
    data = np.fromfile(str(path), dtype=np.uint8)
    image = cv2.imdecode(data, cv2.IMREAD_COLOR)
    return image  # None if the file isn't a readable image (e.g. iPhone .HEIC)


def save_image(path, image):
    """Save an image (same Windows-path workaround as load_image)."""
    ok, encoded = cv2.imencode(Path(path).suffix, image)
    if ok:
        encoded.tofile(str(path))


def distance(p1, p2):
    """Straight-line distance between two (x, y) points."""
    return float(np.linalg.norm(np.asarray(p1) - np.asarray(p2)))


# =============================================================================
# STEP 1: Find the card and warp it flat
# =============================================================================

def resize_for_detection(image):
    """Shrink the photo so its longest side is DETECT_MAX_SIDE.
    Returns (small_image, scale) so we can map points back to full size."""
    height, width = image.shape[:2]   # shape is (rows, columns, channels)
    scale = DETECT_MAX_SIDE / max(height, width)
    if scale >= 1.0:
        return image.copy(), 1.0
    small = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    return small, scale


def make_masks(small):
    """Make a few black-and-white "masks" where the card might show up as a
    white blob. Different photos suit different methods, so we try them all.
    Returns a list of (method_name, mask) pairs - Python's version of a list of tuples."""
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)   # OpenCV stores colour as BGR, not RGB
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)      # soften noise before finding edges

    # Method 1: edges. Canny marks pixels where brightness changes sharply.
    edges = cv2.Canny(blurred, 50, 150)
    kernel = np.ones((5, 5), np.uint8)
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel)  # close small gaps in the outline

    # Methods 2 and 3: brightness. Otsu picks the best split between "light"
    # and "dark" automatically. The card may be the light part or the dark part.
    _, bright = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    dark = cv2.bitwise_not(bright)

    return [("edges", edges), ("bright", bright), ("dark", dark)]


def order_corners(points):
    """Put 4 corner points in a fixed order: top-left, top-right,
    bottom-right, bottom-left. Works even if the card is tilted."""
    center = points.mean(axis=0)
    # Angle of each point around the centre. Image y points DOWN, so sorting by
    # angle goes clockwise on screen: TL, TR, BR, BL (starting point varies).
    angles = np.arctan2(points[:, 1] - center[1], points[:, 0] - center[0])
    points = points[np.argsort(angles)]
    # Rotate the list so it starts at the top-left (smallest x + y).
    start = int(np.argmin(points.sum(axis=1)))
    return np.roll(points, -start, axis=0)


def contour_to_quad(contour):
    """Simplify a blob outline down to 4 corner points, or return None."""
    perimeter = cv2.arcLength(contour, True)
    # approxPolyDP removes points until the shape is within eps of the original.
    # Rounded card corners may need a slightly looser eps, so try a few.
    for eps in (0.02, 0.03, 0.04, 0.05):
        approx = cv2.approxPolyDP(contour, eps * perimeter, True)
        if len(approx) == 4 and cv2.isContourConvex(approx):
            return approx.reshape(4, 2).astype(np.float32)

    # Fallback: if the blob is very rectangle-like, use its tightest rotated box.
    rect = cv2.minAreaRect(contour)
    box_area = rect[1][0] * rect[1][1]
    if box_area > 0 and cv2.contourArea(contour) / box_area > 0.90:
        return cv2.boxPoints(rect).astype(np.float32)
    return None


def looks_like_card(corners):
    """A card is 3.5/2.5 = 1.4 times taller than wide. Allow some slack for
    camera angle. Returns True/False."""
    tl, tr, br, bl = corners
    width = (distance(tl, tr) + distance(bl, br)) / 2
    height = (distance(tl, bl) + distance(tr, br)) / 2
    if min(width, height) == 0:
        return False
    ratio = max(width, height) / min(width, height)
    return 1.2 <= ratio <= 1.7


def intersect_lines(line1, line2):
    """Where two lines cross. Each line is (point, direction)."""
    (p, r), (q, s) = line1, line2
    cross = r[0] * s[1] - r[1] * s[0]
    if abs(cross) < 1e-6:
        return None  # parallel lines never cross
    t = ((q - p)[0] * s[1] - (q - p)[1] * s[0]) / cross
    return p + t * r


def refine_corners(contour, corners):
    """Make the corners more precise. approxPolyDP gives rough corners, and
    real cards have ROUNDED corners. Instead we fit a straight line along the
    middle of each of the 4 edges, and intersect neighbouring lines to get
    the "virtual" sharp corner. This matters: 2 px of error here is several
    percent of centering later."""
    points = contour.reshape(-1, 2).astype(np.float32)
    lines = []
    for i in range(4):                      # side i goes from corner i to corner i+1
        start, end = corners[i], corners[(i + 1) % 4]   # % 4 wraps 3 -> 0
        direction = end - start
        length = np.linalg.norm(direction)
        normal = np.array([-direction[1], direction[0]]) / length
        offset = points - start
        dist_from_side = np.abs(offset @ normal)        # @ is matrix multiply / dot product
        position_along = (offset @ direction) / length ** 2   # 0 at start, 1 at end
        # Keep outline points close to this side and away from the corners.
        on_side = (dist_from_side < 0.03 * length) & (position_along > 0.1) & (position_along < 0.9)
        if on_side.sum() < 10:
            return corners                  # not enough points: keep the rough corners
        vx, vy, x0, y0 = cv2.fitLine(points[on_side], cv2.DIST_HUBER, 0, 0.01, 0.01).flatten()
        lines.append((np.array([x0, y0]), np.array([vx, vy])))

    refined = []
    for i in range(4):
        # Corner i sits between side i-1 and side i. (lines[-1] is the LAST item in Python.)
        point = intersect_lines(lines[i - 1], lines[i])
        if point is None:
            return corners
        refined.append(point)
    refined = np.array(refined, dtype=np.float32)

    # Safety check: if a corner moved a lot, something went wrong - keep the original.
    diagonal = distance(corners[0], corners[2])
    if np.max(np.linalg.norm(refined - corners, axis=1)) > 0.05 * diagonal:
        return corners
    return refined


def find_card(image):
    """Find the card in the photo. Returns a dictionary (like a C#
    Dictionary<string, object>) with the corners and some debug info,
    or None if no card was found."""
    small, scale = resize_for_detection(image)
    small_h, small_w = small.shape[:2]
    image_area = small_h * small_w
    best = None

    for method, mask in make_masks(small):
        # Outer outlines of every white blob in the mask.
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        for contour in contours:
            area = cv2.contourArea(contour)
            if area < 0.10 * image_area:
                continue                    # too small to be the card
            x, y, w, h = cv2.boundingRect(contour)
            if x <= 2 or y <= 2 or x + w >= small_w - 2 or y + h >= small_h - 2:
                continue                    # touches the photo edge: background, or card is cut off
            quad = contour_to_quad(contour)
            if quad is None:
                continue
            quad = order_corners(quad)
            if not looks_like_card(quad):
                continue
            quad = refine_corners(contour, quad)
            if best is None or area > best["area"]:
                best = {"area": area, "corners": quad, "method": method,
                        "mask": mask, "small": small}

    if best is None:
        return None
    # Back to full-photo coordinates. OpenCV puts pixel CENTRES on whole
    # numbers, so pixel 0 of the small image covers full pixels 0..(1/scale);
    # the +0.5 / -0.5 accounts for that. (Plain "/ scale" is off by ~1px.)
    best["corners_full"] = (best["corners"] + 0.5) / scale - 0.5
    return best


def warp_card(image, corners):
    """Perspective-warp the card so it fills a straight-on 750x1050 image."""
    tl, tr, br, bl = corners
    width = (distance(tl, tr) + distance(bl, br)) / 2
    height = (distance(tl, bl) + distance(tr, br)) / 2
    if width > height:
        # The card is lying sideways in the photo. Re-order the corners so
        # the long side becomes vertical (output is always portrait).
        corners = np.array([tr, br, bl, tl], dtype=np.float32)

    target = np.array([[0, 0],
                       [CARD_WIDTH_PX - 1, 0],
                       [CARD_WIDTH_PX - 1, CARD_HEIGHT_PX - 1],
                       [0, CARD_HEIGHT_PX - 1]], dtype=np.float32)
    matrix = cv2.getPerspectiveTransform(corners.astype(np.float32), target)
    return cv2.warpPerspective(image, matrix, (CARD_WIDTH_PX, CARD_HEIGHT_PX),
                               flags=cv2.INTER_CUBIC)


# =============================================================================
# STEP 2: Measure centering
# =============================================================================

def first_run(flags, run_length):
    """Index of the first place where `flags` is True run_length times in a
    row, or None. Example: first_run([F, T, F, T, T, T], 3) -> 3"""
    count = 0
    for i, flag in enumerate(flags):    # enumerate gives (index, value), like a for loop with i
        if flag:
            count += 1
            if count == run_length:
                return i - run_length + 1
        else:
            count = 0
    return None


def view_to_card_xy(k, row, depth):
    """Convert a point from a rotated view back to warped-card (x, y).
    See measure_side() for what k means."""
    w, h = CARD_WIDTH_PX, CARD_HEIGHT_PX
    if k == 0:   # left
        return depth, row
    if k == 1:   # top
        return w - 1 - row, depth
    if k == 2:   # right
        return w - 1 - depth, h - 1 - row
    return row, h - 1 - depth   # bottom


def measure_side(lab, k):
    """Measure one border's width.

    Trick to avoid writing the same code 4 times: rotate the card so the side
    we want is on the LEFT, then always scan left-to-right.
    np.rot90(image, k) rotates counter-clockwise k times:
        k=0 -> left side,  k=1 -> top,  k=2 -> right,  k=3 -> bottom

    For each scan line (a row of pixels) we walk inward from the edge until
    the colour stops matching the border colour. The border width is the
    MEDIAN of all scan lines, so a few bad lines (text, scratches) don't matter.
    """
    view = np.rot90(lab, k)
    rows, cols = view.shape[:2]
    first_row, last_row = int(rows * SCAN_START), int(rows * SCAN_END)

    # Learn the border colour from a thin strip just inside the edge.
    strip = view[first_row:last_row, EDGE_SKIP_PX:EDGE_SKIP_PX + REF_STRIP_PX]
    border_color = np.median(strip.reshape(-1, 3), axis=0)

    max_depth = int(cols * MAX_BORDER_FRACTION)
    depths = []
    hit_points = []   # for the debug image
    for row in range(first_row, last_row, 2):          # every 2nd row
        profile = view[row, EDGE_SKIP_PX:max_depth]    # pixels from the edge inward
        color_diff = np.linalg.norm(profile - border_color, axis=1)
        index = first_run(color_diff > COLOR_CHANGE_THRESHOLD, RUN_LENGTH)
        if index is not None:
            depth = EDGE_SKIP_PX + index
            depths.append(depth)
            hit_points.append(view_to_card_xy(k, row, depth))

    scan_count = len(range(first_row, last_row, 2))
    if len(depths) < 0.3 * scan_count:
        return None   # most lines never found an edge: no clear border (full-art card?)

    q25, median, q75 = np.percentile(depths, [25, 50, 75])
    return {"width": float(median),
            "spread": float(q75 - q25),       # big spread = unreliable measurement
            "found": len(depths),
            "scanned": scan_count,
            "hit_points": hit_points}


def measure_centering(warped):
    """Measure all 4 borders. Returns a dict of results, or None on failure."""
    blurred = cv2.GaussianBlur(warped, (5, 5), 0)
    # Lab colour space: distances in Lab roughly match how different colours LOOK.
    lab = cv2.cvtColor(blurred, cv2.COLOR_BGR2LAB).astype(np.float32)

    sides = {}
    for name, k in [("left", 0), ("top", 1), ("right", 2), ("bottom", 3)]:
        sides[name] = measure_side(lab, k)
        if sides[name] is None:
            return {"error": f"Could not find the inner edge of the {name} border."}

    left, right = sides["left"]["width"], sides["right"]["width"]
    top, bottom = sides["top"]["width"], sides["bottom"]["width"]
    left_pct = 100 * left / (left + right)
    top_pct = 100 * top / (top + bottom)

    warnings = []
    for name, side in sides.items():   # .items() gives (key, value) pairs
        if side["spread"] > 6:
            warnings.append(f"{name} border measurement is inconsistent "
                            f"(spread {side['spread']:.0f}px) - check the debug image")

    return {"sides": sides,
            "left_pct": left_pct, "top_pct": top_pct,
            # Worst split: 45/55 and 55/45 are equally bad, so take the bigger side.
            "worst_lr": max(left_pct, 100 - left_pct),
            "worst_tb": max(top_pct, 100 - top_pct),
            "warnings": warnings}


def centering_grade(worst_pct, is_front):
    """Look up the PSA grade for a worst-side percentage (e.g. 57.3 -> 9 on the front)."""
    for grade, front_limit, back_limit in PSA_CENTERING:
        limit = front_limit if is_front else back_limit
        if worst_pct <= limit:
            return grade
    return 1


# =============================================================================
# Debug images
# =============================================================================

def draw_outline_debug(found):
    """The shrunken photo with the detected card outline and corner labels."""
    image = found["small"].copy()
    corners = found["corners"]
    cv2.polylines(image, [corners.astype(np.int32)], True, (0, 255, 0), 2)
    for label, (x, y) in zip(["TL", "TR", "BR", "BL"], corners):   # zip pairs up two lists
        cv2.circle(image, (int(x), int(y)), 6, (0, 0, 255), -1)
        cv2.putText(image, label, (int(x) + 8, int(y) - 8),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 255), 2)
    return image


def draw_centering_debug(warped, result, title):
    """The warped card with each scan hit (cyan dots), the measured inner
    frame (red box), and the numbers in a panel underneath."""
    image = warped.copy()
    sides = result["sides"]

    for side in sides.values():
        for x, y in side["hit_points"]:
            cv2.circle(image, (int(x), int(y)), 2, (255, 255, 0), -1)

    left, right = sides["left"]["width"], sides["right"]["width"]
    top, bottom = sides["top"]["width"], sides["bottom"]["width"]
    cv2.rectangle(image,
                  (round(left), round(top)),
                  (round(CARD_WIDTH_PX - 1 - right), round(CARD_HEIGHT_PX - 1 - bottom)),
                  (0, 0, 255), 2)

    # White panel with text, stacked under the card (np.vstack = stack vertically).
    panel = np.full((150, CARD_WIDTH_PX, 3), 255, dtype=np.uint8)
    lines = [
        title,
        f"L {left:.1f}px  R {right:.1f}px  ->  L/R {result['left_pct']:.1f}/{100 - result['left_pct']:.1f}",
        f"T {top:.1f}px  B {bottom:.1f}px  ->  T/B {result['top_pct']:.1f}/{100 - result['top_pct']:.1f}",
        f"Centering grade: {result['grade']}",
    ]
    for i, text in enumerate(lines):
        cv2.putText(panel, text, (15, 32 + i * 34), cv2.FONT_HERSHEY_SIMPLEX, 0.75, (0, 0, 0), 2)
    return np.vstack([image, panel])


# =============================================================================
# Putting it together
# =============================================================================

def process_image(path, is_front, debug_dir):
    """Run steps 1 and 2 on one photo. Returns the centering grade, or None."""
    face = "FRONT" if is_front else "BACK"
    print(f"\n=== {face}: {path} ===")

    image = load_image(path)
    if image is None:
        print("  ERROR: could not read the image (missing file, or a format like .HEIC?)")
        return None

    stem = Path(path).stem          # file name without extension: "front.jpg" -> "front"
    prefix = debug_dir / f"{stem}_{face.lower()}"   # "/" joins paths with pathlib

    # --- Step 1: detect and warp ---
    found = find_card(image)
    if found is None:
        print("  ERROR: no card found. See the photo tips: plain contrasting background,")
        print("         whole card in frame with some space around it.")
        # Save what each mask looked like, to help figure out why.
        small, _ = resize_for_detection(image)
        for method, mask in make_masks(small):
            save_image(f"{prefix}_1_mask_{method}.jpg", mask)
        return None

    print(f"  Card found (method: {found['method']})")
    save_image(f"{prefix}_1_mask.jpg", found["mask"])
    save_image(f"{prefix}_2_outline.jpg", draw_outline_debug(found))

    warped = warp_card(image, found["corners_full"])
    save_image(f"{prefix}_3_warped.jpg", warped)

    # --- Step 2: centering ---
    result = measure_centering(warped)
    if "error" in result:
        print(f"  ERROR: {result['error']}")
        return None

    worst = max(result["worst_lr"], result["worst_tb"])
    result["grade"] = centering_grade(worst, is_front)

    sides = result["sides"]
    print(f"  Borders (px): left {sides['left']['width']:.1f}, right {sides['right']['width']:.1f}, "
          f"top {sides['top']['width']:.1f}, bottom {sides['bottom']['width']:.1f}")
    print(f"  Left/Right: {result['left_pct']:.1f}/{100 - result['left_pct']:.1f}")
    print(f"  Top/Bottom: {result['top_pct']:.1f}/{100 - result['top_pct']:.1f}")
    print(f"  Worst split: {worst:.1f}/{100 - worst:.1f}  ->  centering grade {result['grade']}")
    for warning in result["warnings"]:
        print(f"  WARNING: {warning}")

    save_image(f"{prefix}_4_centering.jpg", draw_centering_debug(warped, result, f"{face}: {stem}"))
    print(f"  Debug images: {prefix}_*.jpg")
    return result["grade"]


def main():
    parser = argparse.ArgumentParser(description="Card grader: detection + centering")
    parser.add_argument("--front", help="photo of the card front")
    parser.add_argument("--back", help="photo of the card back")
    parser.add_argument("--debug-dir", default="debug", help="folder for debug images")
    args = parser.parse_args()

    if not args.front and not args.back:
        parser.error("give at least one of --front or --back")

    debug_dir = Path(args.debug_dir)
    debug_dir.mkdir(parents=True, exist_ok=True)   # like Directory.CreateDirectory

    grades = []
    if args.front:
        grades.append(process_image(args.front, True, debug_dir))
    if args.back:
        grades.append(process_image(args.back, False, debug_dir))

    valid = [g for g in grades if g is not None]   # "list comprehension": a one-line Where()
    print()
    if len(valid) == len(grades):
        # Graders are strict: the overall centering grade is the worse of the two faces.
        print(f"OVERALL CENTERING GRADE: {min(valid)}")
    else:
        print("Could not grade every photo - see errors above.")


# This runs main() only when you run the file directly (not when another file
# imports it later, e.g. a website). Python's version of "static void Main".
if __name__ == "__main__":
    main()
