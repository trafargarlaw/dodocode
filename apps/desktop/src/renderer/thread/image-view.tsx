import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import type { ImageRef } from "@dodocode/protocol";
import { ImageNotFound01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Lightbox, type LightboxImage } from "@dodocode/ui/components/lightbox";
import { cn } from "@dodocode/ui/lib/utils";
import { server } from "../server/connection";

// Images in the thread: the ones the person sent, the ones a tool gave back, and image files the
// agent pointed at. Any of them opens over the window, in a viewer that steps through them all.

/** Opens the viewer on the image with this address. */
const GalleryContext = createContext<((src: string) => void) | null>(null);

/**
 * Holds the images inside it in one viewer. Opening any of them steps through all of them, in
 * the order they sit in the thread, each address once.
 */
export function ImageGallery({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const [images, setImages] = useState<LightboxImage[]>([]);
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(false);

  const show = (src: string) => {
    const found = root.current ? imagesIn(root.current) : [];
    const at = found.findIndex((image) => image.src === src);
    setImages(at === -1 ? [{ src, alt: "" }] : found);
    setIndex(Math.max(at, 0));
    setOpen(true);
  };

  return (
    <GalleryContext value={show}>
      <div ref={root} className="contents">
        {children}
      </div>
      <Lightbox
        images={images}
        index={index}
        onIndexChange={setIndex}
        open={open}
        onOpenChange={setOpen}
      />
    </GalleryContext>
  );
}

/**
 * The images in the thread, read from the page so they come in the order they show. The thread
 * keeps every message on the page, so none are missed.
 */
function imagesIn(root: HTMLElement): LightboxImage[] {
  const seen = new Set<string>();
  const images: LightboxImage[] = [];
  for (const element of root.querySelectorAll<HTMLElement>("[data-gallery-src]")) {
    const src = element.dataset.gallerySrc;
    if (!src || seen.has(src)) continue;
    seen.add(src);
    images.push({ src, alt: element.dataset.galleryAlt ?? "" });
  }
  return images;
}

/** What an image needs to open in the viewer: the click, and the attributes the viewer reads. */
function useGalleryItem(src: string, alt: string) {
  const show = useContext(GalleryContext);
  if (!show) throw new Error("A thread image has to sit inside an ImageGallery.");
  return {
    onClick: () => show(src),
    "data-gallery-src": src,
    "data-gallery-alt": alt,
  };
}

/** Images the server keeps, as thumbnails. */
export function Images({
  images,
  align = "end",
  className,
}: {
  images: ImageRef[];
  align?: "start" | "end";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap gap-2",
        align === "end" ? "justify-end" : "justify-start",
        className,
      )}
    >
      {images.map((image) => (
        <Thumbnail key={image.id} src={server.attachmentUrl(image.id)} name={image.name} />
      ))}
    </div>
  );
}

/**
 * An image file on the server's machine, which the agent embedded or linked to. It sits in the
 * agent's words, so it is inline. When the file is not there, its path shows instead.
 */
export function LocalImage({ path, alt }: { path: string; alt: string }) {
  const [missing, setMissing] = useState(false);
  if (missing) {
    return (
      <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-dashed px-2 py-1 align-middle text-[0.9em] text-muted-foreground">
        <HugeiconsIcon icon={ImageNotFound01Icon} strokeWidth={1.8} className="size-4 shrink-0" />
        <span className="min-w-0 truncate font-mono text-[0.9em]" title={path}>
          {path}
        </span>
      </span>
    );
  }
  return (
    <Thumbnail
      src={server.imageFileUrl(path)}
      name={alt || basename(path)}
      title={path}
      large
      onMissing={() => setMissing(true)}
    />
  );
}

/**
 * A link to an image file on the server's machine. It stays a link, so its sentence holds
 * together, with a small preview before it, and opens the image in the viewer.
 */
export function LocalImageLink({ path, children }: { path: string; children: ReactNode }) {
  const [missing, setMissing] = useState(false);
  const src = server.imageFileUrl(path);
  const gallery = useGalleryItem(src, basename(path));
  if (missing) {
    return (
      <span title={`${path} is not there`} className="text-muted-foreground">
        <HugeiconsIcon
          icon={ImageNotFound01Icon}
          strokeWidth={1.8}
          className="mr-1 inline size-[1.1em] align-[-0.2em]"
        />
        {children}
      </span>
    );
  }
  return (
    <button
      type="button"
      {...gallery}
      title={path}
      className="inline cursor-zoom-in rounded-sm font-medium text-primary underline decoration-primary/40 underline-offset-2 outline-none hover:decoration-primary focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <img
        src={src}
        alt=""
        onError={() => setMissing(true)}
        className="mr-1 inline-block h-[1.3em] max-w-[2.6em] rounded-[3px] border object-cover align-[-0.3em]"
      />
      {children}
    </button>
  );
}

function Thumbnail({
  src,
  name,
  title,
  large,
  onMissing,
}: {
  src: string;
  name: string;
  /** What hovering it says, when not its name. */
  title?: string;
  /** Shown bigger, as an image the agent wants seen rather than a pasted one. */
  large?: boolean;
  onMissing?: () => void;
}) {
  const gallery = useGalleryItem(src, name);
  return (
    <button
      type="button"
      {...gallery}
      title={title ?? name}
      aria-label={`View ${name}`}
      className="inline-block max-w-full cursor-zoom-in overflow-hidden rounded-xl border bg-muted/30 align-middle outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <img
        src={src}
        alt={name}
        loading="lazy"
        onError={onMissing}
        className={cn("block object-contain", large ? "max-h-96 max-w-full" : "max-h-48 max-w-64")}
      />
    </button>
  );
}

function basename(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}
