"use client";

import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  ImageNotFound01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "cn";

import { Button } from "@dodocode/ui/components/button";
import { Kbd } from "@dodocode/ui/components/kbd";
import { Spinner } from "@dodocode/ui/components/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@dodocode/ui/components/tooltip";

type LightboxImage = { src: string; alt: string };
type Size = { width: number; height: number };

/** How far past its own size an image grows to fill the window. Further, and it blurs. */
const MAX_SCALE = 2;

/**
 * Images over the whole window, one at a time and as large as the window allows. The arrows, or
 * the arrow keys, step through them; Escape, the close button or a click beside the image closes.
 */
function Lightbox({
  images,
  index,
  onIndexChange,
  open,
  onOpenChange,
}: {
  images: LightboxImage[];
  index: number;
  onIndexChange: (index: number) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const popup = React.useRef<HTMLDivElement>(null);
  const image = images[index];
  const hasPrevious = index > 0;
  const hasNext = index < images.length - 1;
  const step = (by: number) => {
    const next = index + by;
    if (next >= 0 && next < images.length) onIndexChange(next);
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop
          data-slot="lightbox-overlay"
          className="fixed inset-0 isolate z-50 bg-black/85 duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
        />
        <DialogPrimitive.Popup
          ref={popup}
          // Focus starts on the viewer, not on a button, so no tooltip opens with it.
          initialFocus={popup}
          data-slot="lightbox"
          className="fixed inset-0 z-50 text-white outline-none duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          onKeyDown={(event) => {
            if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            step(event.key === "ArrowLeft" ? -1 : 1);
          }}
          onClick={(event) => {
            // A click beside the image closes it, as a click outside a dialog does.
            if (!(event.target as Element).closest("button, img")) onOpenChange(false);
          }}
        >
          <DialogPrimitive.Title className="sr-only">{image?.alt || "Image"}</DialogPrimitive.Title>
          {image && <LightboxStage images={images} index={index} />}
          <LightboxButton
            label="Close"
            keys="Esc"
            className="top-3 right-3"
            onClick={() => onOpenChange(false)}
          >
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
          </LightboxButton>
          {hasPrevious && (
            <LightboxButton
              label="Previous"
              keys="←"
              side="right"
              className="top-[calc(50%-1.125rem)] left-3"
              onClick={() => step(-1)}
            >
              <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
            </LightboxButton>
          )}
          {hasNext && (
            <LightboxButton
              label="Next"
              keys="→"
              side="left"
              className="top-[calc(50%-1.125rem)] right-3"
              onClick={() => step(1)}
            >
              <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} />
            </LightboxButton>
          )}
          {images.length > 1 && (
            <p
              aria-live="polite"
              className="absolute inset-x-0 bottom-4 text-center text-[13px] text-white/75 tabular-nums"
            >
              {index + 1} / {images.length}
            </p>
          )}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * The space the image fills: the window, less room for the buttons around it. The image on show
 * stays until the next one has loaded and decoded, so stepping swaps one for the other with
 * nothing blank between. The ones either side load ahead, so stepping to them is instant.
 */
function LightboxStage({ images, index }: { images: LightboxImage[]; index: number }) {
  const stage = React.useRef<HTMLDivElement>(null);
  const [box, setBox] = React.useState<Size | null>(null);
  React.useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    // Measured now, before the first paint; the observer follows the window from there.
    setBox({ width: element.clientWidth, height: element.clientHeight });
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setBox({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Each image's size once it is ready to paint, or null when it would not load.
  const [sizes, setSizes] = React.useState<ReadonlyMap<string, Size | null>>(() => new Map());
  const requested = React.useRef(new Set<string>());
  React.useEffect(() => {
    for (const nearby of [images[index], images[index - 1], images[index + 1]]) {
      if (!nearby || requested.current.has(nearby.src)) continue;
      requested.current.add(nearby.src);
      void loadImage(nearby.src).then((size) =>
        setSizes((ready) => new Map(ready).set(nearby.src, size)),
      );
    }
  }, [images, index]);

  const image = images[index];
  const [shown, setShown] = React.useState<LightboxImage | null>(null);
  if (image && image !== shown && sizes.has(image.src)) setShown(image);
  const size = shown && sizes.get(shown.src);
  const slow = useAfter(shown !== image, 300);

  return (
    <div ref={stage} className="absolute inset-x-16 inset-y-14 grid place-items-center">
      {shown && box && size && (
        <img
          src={shown.src}
          alt={shown.alt}
          draggable={false}
          style={fitImage(size, box)}
          className="col-start-1 row-start-1 rounded-lg object-contain shadow-2xl shadow-black/50 select-none"
        />
      )}
      {shown && size === null && (
        <div className="col-start-1 row-start-1 flex flex-col items-center gap-2 text-sm text-white/75">
          <HugeiconsIcon icon={ImageNotFound01Icon} strokeWidth={1.5} className="size-8" />
          This image could not be loaded
        </div>
      )}
      {slow && (
        <span className="col-start-1 row-start-1 rounded-full bg-black/60 p-2">
          <Spinner className="size-6 text-white/75" />
        </span>
      )}
    </div>
  );
}

/** Loads and decodes an image, so it paints the moment it is shown, and gives its size. */
async function loadImage(src: string): Promise<Size | null> {
  const image = new Image();
  image.src = src;
  try {
    await image.decode();
  } catch {
    // Decoding can fail on an image that did load; only one with no pixels is missing.
    if (!image.complete || !image.naturalWidth) return null;
  }
  return { width: image.naturalWidth, height: image.naturalHeight };
}

/** True once `active` has held for `ms`, so what is quick shows no sign of waiting at all. */
function useAfter(active: boolean, ms: number): boolean {
  const [late, setLate] = React.useState(false);
  React.useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setLate(true), ms);
    return () => {
      clearTimeout(timer);
      setLate(false);
    };
  }, [active, ms]);
  return active && late;
}

/** The image's size in the box: as large as fits, keeping its shape, at most `MAX_SCALE` times. */
function fitImage(natural: Size, box: Size): Size {
  // An SVG without a size of its own takes the whole box.
  if (!natural.width || !natural.height) return box;
  const scale = Math.min(box.width / natural.width, box.height / natural.height, MAX_SCALE);
  return {
    width: Math.round(natural.width * scale),
    height: Math.round(natural.height * scale),
  };
}

function LightboxButton({
  label,
  keys,
  side = "bottom",
  className,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "aria-label"> & {
  label: string;
  keys: string;
  side?: "top" | "bottom" | "left" | "right";
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-lg"
            aria-label={label}
            className={cn(
              "absolute rounded-full bg-white/10 text-white hover:bg-white/20 hover:text-white focus-visible:border-white/40 focus-visible:ring-white/30 dark:hover:bg-white/20 [&_svg:not([class*='size-'])]:size-5",
              className,
            )}
            {...props}
          />
        }
      />
      <TooltipContent side={side}>
        {label}
        <Kbd>{keys}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}

export { Lightbox, type LightboxImage };
