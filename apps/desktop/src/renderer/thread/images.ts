// Getting a pasted or dropped image ready to send. Providers refuse large images and shrink big
// ones anyway, so an image over the limits is scaled down here, before it is uploaded.

import type { ImageRef } from "@dodocode/protocol";
import { server } from "../server/connection";

/** The types the server keeps as they are. Other images are converted. */
const KEPT_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** About 5 MB once in base64, the most Claude takes for one image. */
const MAX_BYTES = 3_750_000;
/** The longest side an image keeps. Providers scale larger ones down to about this. */
const MAX_EDGE = 2048;
/** Larger files are not worth decoding. */
const MAX_INPUT_BYTES = 50 * 1024 * 1024;

/** A size that fits within `max` on its longest side, keeping the shape. Never scales up. */
export function fitWithin(
  width: number,
  height: number,
  max: number,
): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Scales the image down or converts it when it has to, then gives it to the server to keep. */
export async function uploadImage(file: File): Promise<ImageRef> {
  const { blob, name } = await prepareImage(file);
  const data = await toBase64(blob);
  return server.call("attachment.upload", { name, mime: blob.type, data });
}

async function prepareImage(file: File): Promise<{ blob: Blob; name: string }> {
  const name = file.name || "Pasted image";
  if (!file.type.startsWith("image/")) throw new Error(`${name} is not an image.`);
  if (file.size > MAX_INPUT_BYTES) throw new Error(`${name} is larger than 50 MB.`);

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`${name} could not be read as an image.`);
  }
  try {
    const size = fitWithin(bitmap.width, bitmap.height, MAX_EDGE);
    const fits = size.width === bitmap.width && size.height === bitmap.height;
    if (fits && file.size <= MAX_BYTES && KEPT_TYPES.has(file.type)) return { blob: file, name };

    const canvas = new OffscreenCanvas(size.width, size.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error(`${name} could not be resized.`);
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.9 });
    return { blob, name: name.replace(/\.[^.]+$/, "") + ".webp" };
  } finally {
    bitmap.close();
  }
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () =>
      resolve(String(reader.result).replace(/^data:[^,]*,/, "")),
    );
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error("Could not read the image.")),
    );
    reader.readAsDataURL(blob);
  });
}
