import type { TextureEncoder } from "./pipeline.ts";

/**
 * Browser texture encoder: decode with createImageBitmap, scale down on an OffscreenCanvas, re-encode as WebP with
 * convertToBlob. Runs in a worker. Colour conversion and alpha premultiplication are switched off so normal and
 * metallic-roughness maps keep their values.
 */
export const encodeWebpInBrowser: TextureEncoder = async (image, mimeType, maxSize, quality) => {
  const bitmap = await createImageBitmap(new Blob([image as BlobPart], { type: mimeType }), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  try {
    const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
    // A WebP that is already within size is kept as it is (re-encoding would only lose quality).
    if (mimeType === "image/webp" && scale === 1) return null;
    const w = Math.max(1, Math.round(bitmap.width * scale)), h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = await canvas.convertToBlob({ type: "image/webp", quality });
    if (blob.type !== "image/webp") return null; // the browser fell back to PNG: keep the original
    return { data: new Uint8Array(await blob.arrayBuffer()), mimeType: "image/webp" };
  } finally {
    bitmap.close();
  }
};
