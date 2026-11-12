// The files the server hands out over HTTP besides attachments: image files on its machine that
// the agent pointed at, and what a page the agent showed loads from beside it.

import { extname, isAbsolute, relative, resolve, sep } from "node:path";

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

/** What a page loads from beside it. Anything else, such as a `.env` file, is not served. */
const PAGE_TYPES: Record<string, string> = {
  ...IMAGE_TYPES,
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

/** The type of an image file, by its extension. Unset for anything that is not an image. */
export function imageType(path: string): string | undefined {
  return IMAGE_TYPES[extname(path).toLowerCase()];
}

/** The type of a file a page may load, by its extension. */
export function pageFileType(path: string): string | undefined {
  return PAGE_TYPES[extname(path).toLowerCase()];
}

/**
 * The file a page's URL path names in its folder. Unset when it would leave the folder, or
 * goes into a hidden file or folder.
 */
export function fileInFolder(folder: string, path: string): string | undefined {
  if (!path || path.includes("\0")) return undefined;
  const full = resolve(folder, path);
  const inside = relative(folder, full);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) return undefined;
  if (inside.split(sep).some((part) => part.startsWith("."))) return undefined;
  return full;
}

/**
 * Appended to a page the agent showed: it tells the window how tall the page is, so its frame
 * fits it.
 */
export const PAGE_HEIGHT_SCRIPT = `<script>(() => {
  const post = () => {
    const height = Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0,
    );
    parent.postMessage({ dodocodePageHeight: Math.ceil(height) }, "*");
  };
  const observer = new ResizeObserver(post);
  observer.observe(document.documentElement);
  if (document.body) observer.observe(document.body);
  addEventListener("load", post);
  post();
})();</script>`;
