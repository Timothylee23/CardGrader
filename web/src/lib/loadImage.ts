// loadImage.ts - turn a photo File into raw RGBA pixels (ImageData).

// iPhone photos are 12+ megapixels. We only warp the card to 750x1050, so
// 3000px on the long side is plenty and keeps memory sane on the phone.
const MAX_SIDE = 3000;

export async function fileToImageData(file: File): Promise<ImageData> {
  const url = URL.createObjectURL(file);
  try {
    // An <img> applies the photo's EXIF rotation for us, so portrait shots
    // come out the right way up. (iOS converts HEIC to JPEG for file inputs.)
    const img = new Image();
    img.src = url;
    await img.decode();

    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.round(img.naturalWidth * scale);
    const height = Math.round(img.naturalHeight * scale);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas not supported");
    ctx.drawImage(img, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height);
  } finally {
    URL.revokeObjectURL(url); // free the temporary URL
  }
}
