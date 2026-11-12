// Paths to files on the server's machine, as the agent writes them in Markdown: an image it
// embedded, or a link to a screenshot it took.

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;

/**
 * The absolute path a Markdown URL names, such as `C:\shots\home.png`, `/tmp/home.png` or
 * `file:///tmp/home.png`. Unset for a web address, or a path relative to somewhere unknown.
 */
export function localPath(url: string): string | undefined {
  let path = url.trim();
  // Markdown percent-encodes what a URL can't hold, such as a backslash or a space.
  try {
    path = decodeURIComponent(path);
  } catch {
    // A lone `%` stays as it is.
  }
  if (/^file:/i.test(path)) {
    path = path.replace(/^file:\/*/i, "/");
    // `file:///C:/x` names `C:/x`.
    if (/^\/[a-z]:[\\/]/i.test(path)) path = path.slice(1);
  }
  if (/^[a-z]:[\\/]/i.test(path)) return path;
  // Not `//host/x`, which is a web address without its scheme.
  if (path.startsWith("/") && !path.startsWith("//")) return path;
  return undefined;
}

/** The image file a Markdown URL names, or unset when it names anything else. */
export function localImage(url: string): string | undefined {
  const path = localPath(url);
  return path && IMAGE_EXTENSION.test(path) ? path : undefined;
}
