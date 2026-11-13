import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
} from "react";
import { flushSync } from "react-dom";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ComputerIcon,
  MinusSignIcon,
  Moon02Icon,
  PlusSignIcon,
  Sun03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "cn";

import { Button } from "@dodocode/ui/components/button";
import { Kbd } from "@dodocode/ui/components/kbd";
import { ToggleGroup, ToggleGroupItem } from "@dodocode/ui/components/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@dodocode/ui/components/tooltip";
import { setTheme, useTheme } from "@dodocode/ui/hooks/use-theme";
import { mix, oklch, toCss, type Rgb } from "@dodocode/ui/lib/color";
import { addColor, moveColor, removeColor } from "@dodocode/ui/lib/linked-colors";
import {
  MAX_COLORS,
  PRESETS,
  findPreset,
  stepPreset,
  wallpaperColor,
  type Appearance,
  type ColorScheme,
  type Preset,
  type ThemeSettings,
  type WallpaperColor,
} from "@dodocode/ui/lib/theme";

const APPEARANCES: readonly Appearance[] = ["system", "light", "dark"];
const PER_PAGE = 7;
const PAGES = Math.ceil(PRESETS.length / PER_PAGE);
// Full strength sits this far towards the field's edge, so handles never touch it.
const FIELD_REACH = 0.9;
const toDegrees = (radians: number) => ((((radians * 180) / Math.PI) % 360) + 360) % 360;
const toUnit = (value: number) => Math.min(1, Math.max(0, value));

const pageOf = (preset: Preset | undefined) =>
  preset ? Math.floor(PRESETS.indexOf(preset) / PER_PAGE) : undefined;

/** Picks the theme: appearance, wallpaper colours, presets, intensity and gradient angle. */
export function ThemePicker({
  className,
  keys,
  open = true,
}: {
  className?: string;
  /** Labels for the keys that step through the presets, shown in their buttons' tooltips. */
  keys?: { previousPreset?: string; nextPreset?: string };
  /** False while the picker is kept, hidden, to open again quickly. It draws nothing then. */
  open?: boolean;
}) {
  const { settings, theme } = useTheme();
  const preset = findPreset(settings);
  const [page, setPage] = useState(() => pageOf(preset) ?? 0);
  // A preset picked from elsewhere, such as with a key, brings its page into view.
  const [shownPreset, setShownPreset] = useState(preset);
  if (preset !== shownPreset) {
    setShownPreset(preset);
    setPage((current) => pageOf(preset) ?? current);
  }
  // It opens on the chosen preset's page, as it did when each opening built it afresh, not on
  // the page it was left at.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setPage(pageOf(preset) ?? 0);
  }
  const count = settings.colors.length;

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-center justify-between">
        <ToggleGroup
          aria-label="Appearance"
          size="sm"
          spacing={0}
          value={[settings.appearance]}
          onValueChange={(value) => {
            const next = APPEARANCES.find((appearance) => appearance === value[0]);
            // Pressing the chosen one again unpresses it: keep the appearance as it is.
            if (next) setAppearance(next);
          }}
          className="rounded-lg bg-muted p-0.5"
        >
          {(
            [
              ["system", "Match the system", ComputerIcon],
              ["light", "Light", Sun03Icon],
              ["dark", "Dark", Moon02Icon],
            ] as const
          ).map(([value, label, icon]) => (
            <Tip key={value} label={label}>
              <ToggleGroupItem
                value={value}
                aria-label={label}
                className="rounded-md! aria-pressed:bg-background aria-pressed:shadow-sm"
              >
                <HugeiconsIcon icon={icon} strokeWidth={1.8} />
              </ToggleGroupItem>
            </Tip>
          ))}
        </ToggleGroup>

        <div className="flex items-center rounded-lg bg-muted p-0.5">
          <Tip label="Fewer colours">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Fewer colours"
              disabled={count <= 1}
              onClick={() => setColors(removeColor(settings.colors))}
              className="hover:bg-background"
            >
              <HugeiconsIcon icon={MinusSignIcon} strokeWidth={2} />
            </Button>
          </Tip>
          <span className="min-w-5 text-center text-sm font-medium tabular-nums">
            {count}
            <span className="sr-only"> colours</span>
          </span>
          <Tip label={count >= MAX_COLORS ? `Up to ${MAX_COLORS} colours` : "More colours"}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="More colours"
              disabled={count >= MAX_COLORS}
              onClick={() => setColors(addColor(settings.colors))}
              className="hover:bg-background"
            >
              <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
            </Button>
          </Tip>
        </div>
      </div>

      <ColorField settings={settings} scheme={theme.scheme} open={open} onChange={setColors} />

      <div>
        <div className="flex items-center gap-1">
          <Tip label="Previous presets" keys={keys?.previousPreset} keysLabel="Previous preset">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Previous presets"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            >
              <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
            </Button>
          </Tip>
          <div className="flex flex-1 justify-between">
            {PRESETS.slice(page * PER_PAGE, (page + 1) * PER_PAGE).map((choice) => (
              <Tip key={choice.name} label={choice.name}>
                <button
                  type="button"
                  aria-label={choice.name}
                  aria-pressed={choice === preset}
                  onClick={() => applyPreset(choice)}
                  className="size-7 rounded-lg outline-2 outline-offset-2 outline-transparent transition-[outline-color] focus-visible:outline-ring aria-pressed:outline-foreground"
                >
                  <Swatch preset={choice} scheme={theme.scheme} open={open} />
                </button>
              </Tip>
            ))}
          </div>
          <Tip label="More presets" keys={keys?.nextPreset} keysLabel="Next preset">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="More presets"
              disabled={page === PAGES - 1}
              onClick={() => setPage(page + 1)}
            >
              <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} />
            </Button>
          </Tip>
        </div>
        <div className="mt-1.5 flex justify-between px-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{preset?.name ?? "Custom"}</span>
          <span className="tabular-nums">
            {page + 1} / {PAGES}
          </span>
        </div>
      </div>

      <div className="flex items-end gap-3">
        <IntensitySlider
          value={settings.intensity}
          colors={settings.colors}
          onChange={(intensity) => setTheme((current) => ({ ...current, intensity }))}
        />
        <AngleDial
          value={settings.angle}
          onChange={(angle) => setTheme((current) => ({ ...current, angle }))}
        />
      </div>
    </div>
  );
}

/** A short label for a control, and the keys that do something like it when there are some. */
function Tip({
  label,
  keys,
  keysLabel,
  children,
}: {
  label: string;
  keys?: string;
  /** What the keys do, when it is not what the label says. */
  keysLabel?: string;
  children: ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent>
        {label}
        {keys && (
          <span className="inline-flex items-center gap-1.5 opacity-80">
            {keysLabel && <span>· {keysLabel}</span>}
            <Kbd>{keys}</Kbd>
          </span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

function setColors(colors: readonly WallpaperColor[]): void {
  setTheme((current) => ({ ...current, colors }));
}

/** Moves to the next or previous preset, for the keys that step through them. */
export function stepThemePreset(step: 1 | -1): void {
  crossFade(() =>
    setTheme((current) => {
      const preset = stepPreset(current, step);
      return {
        appearance: current.appearance,
        colors: preset.colors,
        intensity: preset.intensity,
        angle: preset.angle,
      };
    }),
  );
}

/** Takes a preset's colours, intensity and angle, and keeps the appearance. */
function applyPreset(preset: Preset): void {
  crossFade(() =>
    setTheme((current) => ({
      appearance: current.appearance,
      colors: preset.colors,
      intensity: preset.intensity,
      angle: preset.angle,
    })),
  );
}

/** Changes the appearance with the same cross-fade the picker uses. */
export function setAppearance(appearance: Appearance): void {
  crossFade(() => setTheme((current) => ({ ...current, appearance })));
}

// The first colour leads: dragging it carries the others round the wheel and in and out with it,
// so the palette keeps its shape. Any other colour moves alone. A press on the bare field brings
// the lead there.
function ColorField({
  settings,
  scheme,
  open,
  onChange,
}: {
  settings: ThemeSettings;
  scheme: ColorScheme;
  open: boolean;
  onChange: (colors: readonly WallpaperColor[]) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const dots = useRef<HTMLCanvasElement>(null);
  // The colour being dragged, and every colour as it was when the drag started.
  const drag = useRef<Drag | null>(null);
  // The field and dots drawn last. A hidden picker draws none, and draws on opening only what
  // changed.
  const drawn = useRef<string | undefined>(undefined);
  const dotsDrawn = useRef<string | undefined>(undefined);

  useEffect(() => {
    const field = `${scheme} ${settings.intensity}`;
    if (!open || drawn.current === field) return;
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    context.putImageData(fieldImage(scheme, settings.intensity), 0, 0);
    drawn.current = field;
  }, [scheme, settings.intensity, open]);

  useEffect(() => {
    const element = dots.current;
    // The field's size is fixed, so the dots change only with the scheme and the pixel density.
    // Checked before measuring, which would make the browser lay out the page there and then.
    const grid = `${scheme} ${devicePixelRatio}`;
    if (!open || dotsDrawn.current === grid || !element?.clientWidth) return;
    drawDots(element);
    dotsDrawn.current = grid;
  }, [scheme, open]);

  const moveTo = (event: PointerEvent<HTMLDivElement>, { index, start }: Drag) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const to = pointToColor(
      (event.clientX - rect.left) / rect.width,
      (event.clientY - rect.top) / rect.height,
    );
    onChange(moveColor(start, index, to));
  };

  const nudge = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const color = settings.colors[index];
    if (!color) return;
    const step = event.shiftKey ? 4 : 1;
    const moves: Partial<Record<string, [hue: number, strength: number]>> = {
      ArrowLeft: [-5 * step, 0],
      ArrowRight: [5 * step, 0],
      ArrowUp: [0, 0.05 * step],
      ArrowDown: [0, -0.05 * step],
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    const to = { hue: color.hue + move[0], strength: color.strength + move[1] };
    onChange(moveColor(settings.colors, index, to));
  };

  return (
    <div
      className="relative h-44 cursor-crosshair touch-none overflow-hidden rounded-xl"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const handle = (event.target as HTMLElement).closest<HTMLElement>("[data-handle]");
        const current = {
          index: handle ? Number(handle.dataset.handle) : 0,
          start: settings.colors,
        };
        drag.current = current;
        event.currentTarget.setPointerCapture(event.pointerId);
        if (!handle) moveTo(event, current);
      }}
      // A drag lasts while the field holds the pointer. The field lets go of it on a pointerup or
      // a cancel, and without either when the picker closes mid-drag: a move after that is no drag.
      onPointerMove={(event) => {
        if (drag.current && event.currentTarget.hasPointerCapture(event.pointerId)) {
          moveTo(event, drag.current);
        }
      }}
      onLostPointerCapture={() => (drag.current = null)}
    >
      <canvas
        ref={canvas}
        width={FIELD_WIDTH}
        height={FIELD_HEIGHT}
        className="absolute inset-0 size-full"
      />
      <canvas
        ref={dots}
        aria-hidden
        className="pointer-events-none absolute inset-0 size-full text-foreground"
      />
      {settings.colors.map((color, i) => {
        const turn = ((color.hue - 90) * Math.PI) / 180;
        const reach = 50 * FIELD_REACH * color.strength;
        const lead = i === 0;
        const role = lead && settings.colors.length > 1 ? ", moves the others with it" : "";
        return (
          <button
            // The colours have no identity of their own: the first one is always colour 1.
            // oxlint-disable-next-line react/no-array-index-key
            key={i}
            type="button"
            data-handle={i}
            aria-label={`Colour ${i + 1}${role}: hue ${Math.round(color.hue)}°, strength ${Math.round(color.strength * 100)}%`}
            onKeyDown={(event) => nudge(event, i)}
            style={{
              left: `${50 + reach * Math.cos(turn)}%`,
              top: `${50 + reach * Math.sin(turn)}%`,
              background: toCss(oklch(0.7, color.strength * 0.16, color.hue)),
            }}
            className={cn(
              "absolute size-4.5 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-[2.5px] border-white shadow-[0_1px_4px_rgb(0_0_0/0.35)] outline-none focus-visible:ring-3 focus-visible:ring-ring/60 active:cursor-grabbing",
              lead && "z-10 size-7 border-[3px]",
            )}
          />
        );
      })}
    </div>
  );
}

interface Drag {
  index: number;
  start: readonly WallpaperColor[];
}

// Every pixel costs a gamut search, and the field is a smooth blend: it is worked out at a quarter
// of its width and height on screen, and stretched.
const FIELD_WIDTH = 69;
const FIELD_HEIGHT = 44;
// Fields already drawn, so reopening the picker or stepping the intensity back draws nothing.
const fields = new Map<string, ImageData>();
const KEPT_FIELDS = 8;

/** Every colour the wallpaper can take, as it will look: hue around, strength outwards. */
function fieldImage(scheme: ColorScheme, intensity: number): ImageData {
  const key = `${scheme} ${intensity}`;
  const kept = fields.get(key);
  if (kept) {
    // Map order is age: move this one to the young end.
    fields.delete(key);
    fields.set(key, kept);
    return kept;
  }
  const image = new ImageData(FIELD_WIDTH, FIELD_HEIGHT);
  let i = 0;
  for (let y = 0; y < FIELD_HEIGHT; y++) {
    for (let x = 0; x < FIELD_WIDTH; x++) {
      const point = pointToColor((x + 0.5) / FIELD_WIDTH, (y + 0.5) / FIELD_HEIGHT);
      const [red, green, blue] = wallpaperColor(point, intensity, scheme);
      image.data[i++] = red;
      image.data[i++] = green;
      image.data[i++] = blue;
      image.data[i++] = 255;
    }
  }
  fields.set(key, image);
  const oldest = fields.keys().next();
  if (fields.size > KEPT_FIELDS && !oldest.done) fields.delete(oldest.value);
  return image;
}

// The swatches and the field's dots are drawn on the CPU into canvases, which the page shows as
// pictures. Drawn by CSS, as gradients and a pattern, each needs the GPU to prepare a shader the
// first time it shows, and on a fresh install the picker's first opening waited about 100ms for
// those.

// The field's dots, as `radial-gradient(currentColor 1px, transparent 1.3px)` tiled every 7px at
// 8% opacity drew them: one in the middle of each square, solid out to 1px, gone by 1.3px.
const DOT_GAP = 7;
const DOT_SOLID = 1;
const DOT_EDGE = 1.3;
const DOT_ALPHA = 0.08;

/** The grid of faint dots over the field, in the canvas's text colour. */
function drawDots(canvas: HTMLCanvasElement): void {
  const scale = devicePixelRatio;
  const width = Math.round(canvas.clientWidth * scale);
  const height = Math.round(canvas.clientHeight * scale);
  canvas.width = width;
  canvas.height = height;
  // Read back often, a canvas stays on the CPU, where drawing it needs no shader.
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return;
  // Each pixel's opacity, from how far its middle is from the nearest dot's, as the gradient
  // works it out. A path's edges would come out softer than the CSS dots were.
  const image = context.createImageData(width, height);
  for (let y = 0; y < height; y++) {
    const dy = (((y + 0.5) / scale) % DOT_GAP) - DOT_GAP / 2;
    if (Math.abs(dy) >= DOT_EDGE) continue;
    for (let x = 0; x < width; x++) {
      const dx = (((x + 0.5) / scale) % DOT_GAP) - DOT_GAP / 2;
      if (Math.abs(dx) >= DOT_EDGE) continue;
      const solid = (DOT_EDGE - Math.sqrt(dx * dx + dy * dy)) / (DOT_EDGE - DOT_SOLID);
      const opacity = Math.max(0, Math.min(1, solid)) * DOT_ALPHA;
      image.data[(y * width + x) * 4 + 3] = Math.round(opacity * 255);
    }
  }
  context.putImageData(image, 0, 0);
  // Then the colour, kept only where the dots are.
  context.globalCompositeOperation = "source-in";
  context.fillStyle = getComputedStyle(canvas).color;
  context.fillRect(0, 0, width, height);
}

/** A point in the field, from 0 to 1 on each axis, as a colour: hue around, strength outwards. */
function pointToColor(x: number, y: number): WallpaperColor {
  const dx = (x - 0.5) / (0.5 * FIELD_REACH);
  const dy = (y - 0.5) / (0.5 * FIELD_REACH);
  return { hue: toDegrees(Math.atan2(dy, dx) + Math.PI / 2), strength: toUnit(Math.hypot(dx, dy)) };
}

function IntensitySlider({
  value,
  colors,
  onChange,
}: {
  value: number;
  colors: readonly WallpaperColor[];
  onChange: (value: number) => void;
}) {
  const gradient = `intensity-${useId().replace(/[^\w-]/g, "")}`;
  const knob = 4 + value * 192;
  let wave = "M4 18";
  for (let x = 6; x <= knob; x += 2)
    wave += ` L${x} ${(18 + 7 * Math.sin((x - 4) / 6.2)).toFixed(2)}`;
  const percent = Math.round(value * 100);

  const fromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    onChange(toUnit((event.clientX - rect.left - rect.width * 0.02) / (rect.width * 0.96)));
  };

  return (
    <div className="min-w-0 flex-1">
      <div
        role="slider"
        tabIndex={0}
        aria-label="Intensity"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${percent}%`}
        onKeyDown={(event) => {
          const next = stepValue(event, value, 0.05, 0.2, 0, 1);
          if (next !== undefined) onChange(next);
        }}
        {...dragHandlers(fromPointer)}
        className="cursor-ew-resize touch-none rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <svg
          viewBox="0 0 200 36"
          preserveAspectRatio="none"
          aria-hidden
          className="block h-9 w-full overflow-visible"
        >
          <defs>
            <linearGradient id={gradient} gradientUnits="userSpaceOnUse" x1="4" x2="196">
              {colors.map((color, i) => (
                <stop
                  // oxlint-disable-next-line react/no-array-index-key
                  key={i}
                  offset={colors.length === 1 ? 0 : i / (colors.length - 1)}
                  stopColor={toCss(oklch(0.7, color.strength * 0.16, color.hue))}
                />
              ))}
            </linearGradient>
          </defs>
          <path
            d={`M${knob} 18 L196 18`}
            className="stroke-border"
            strokeWidth={3}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            fill="none"
          />
          <path
            d={wave}
            stroke={`url(#${gradient})`}
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            fill="none"
          />
          <rect
            x={knob - 4}
            y={5}
            width={8}
            height={26}
            rx={4}
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
            className="fill-popover stroke-border"
          />
        </svg>
      </div>
      <div className="mt-0.5 flex justify-between text-xs text-muted-foreground">
        <span>Intensity</span>
        <span className="tabular-nums">{percent}%</span>
      </div>
    </div>
  );
}

function AngleDial({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const turn = (value * Math.PI) / 180;

  const fromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const angle = toDegrees(
      Math.atan2(
        event.clientX - (rect.left + rect.width / 2),
        -(event.clientY - (rect.top + rect.height / 2)),
      ),
    );
    onChange((Math.round(angle / 5) * 5) % 360);
  };

  return (
    <div className="flex w-12 flex-col items-center">
      <div
        role="slider"
        tabIndex={0}
        aria-label="Gradient angle"
        aria-valuemin={0}
        aria-valuemax={359}
        aria-valuenow={Math.round(value)}
        aria-valuetext={`${Math.round(value)}°`}
        onKeyDown={(event) => {
          const next = stepValue(event, value, 5, 45, 0, 355);
          if (next !== undefined) onChange(next);
        }}
        {...dragHandlers(fromPointer)}
        className="relative size-9 cursor-grab touch-none rounded-full border-[2.5px] border-border outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <span
          className="absolute size-1.75 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary-ink"
          style={{ left: `${50 + 33 * Math.sin(turn)}%`, top: `${50 - 33 * Math.cos(turn)}%` }}
        />
      </div>
      <span className="mt-0.5 text-xs text-muted-foreground tabular-nums">
        {Math.round(value)}°
      </span>
    </div>
  );
}

/** Pointer handlers that follow a drag that starts on the element. */
function dragHandlers(onMove: (event: PointerEvent<HTMLDivElement>) => void) {
  return {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      onMove(event);
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) onMove(event);
    },
  };
}

/** The slider value after an arrow, Page Up/Down, Home or End key, or undefined for other keys. */
function stepValue(
  event: KeyboardEvent,
  value: number,
  step: number,
  bigStep: number,
  min: number,
  max: number,
): number | undefined {
  const next: Partial<Record<string, number>> = {
    ArrowRight: value + step,
    ArrowUp: value + step,
    ArrowLeft: value - step,
    ArrowDown: value - step,
    PageUp: value + bigStep,
    PageDown: value - bigStep,
    Home: min,
    End: max,
  };
  const result = next[event.key];
  if (result === undefined) return undefined;
  event.preventDefault();
  return Math.min(max, Math.max(min, result));
}

/** A preset's colours, a little lighter than the dark wallpaper so presets are easy to tell apart. */
function swatchColors(preset: Preset, scheme: ColorScheme): Rgb[] {
  return preset.colors.map((color) =>
    oklch(scheme === "dark" ? 0.5 : 0.84, color.strength * preset.intensity * 0.13, color.hue),
  );
}

// The canvas mixes a gradient's colours in sRGB: stops this close, each mixed in OKLab, draw it
// the way CSS's `in oklab` does.
const STOPS_BETWEEN_COLORS = 8;

/** A preset's swatch, drawn when the picker is open and the swatch is not drawn yet. */
function Swatch({ preset, scheme, open }: { preset: Preset; scheme: ColorScheme; open: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawn = useRef<string | undefined>(undefined);
  // Before the frame is painted, so a page of presets never shows empty for a frame.
  useLayoutEffect(() => {
    const element = canvas.current;
    // Checked before measuring, which would make the browser lay out the page there and then.
    const swatch = `${preset.name} ${scheme} ${devicePixelRatio}`;
    if (!open || drawn.current === swatch || !element?.clientWidth) return;
    drawSwatch(element, swatchColors(preset, scheme), preset.angle);
    drawn.current = swatch;
  }, [preset, scheme, open]);
  return <canvas ref={canvas} aria-hidden className="block size-full rounded-[inherit]" />;
}

/** Colours as `linear-gradient(<angle>deg in oklab, ...)` draws them, with a faint edge. */
function drawSwatch(canvas: HTMLCanvasElement, colors: readonly Rgb[], angle: number): void {
  const scale = devicePixelRatio;
  const size = Math.round(canvas.clientWidth * scale);
  canvas.width = size;
  canvas.height = size;
  // Read back often, a canvas stays on the CPU, where drawing it needs no shader.
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const [first] = colors;
  if (!context || !first) return;
  if (colors.length === 1) {
    context.fillStyle = toCss(first);
  } else {
    // CSS's gradient line runs through the middle at the angle, and reaches the far corners.
    const turn = (angle * Math.PI) / 180;
    const half = (size * (Math.abs(Math.sin(turn)) + Math.abs(Math.cos(turn)))) / 2;
    const [dx, dy] = [Math.sin(turn) * half, -Math.cos(turn) * half];
    const middle = size / 2;
    const gradient = context.createLinearGradient(
      middle - dx,
      middle - dy,
      middle + dx,
      middle + dy,
    );
    const stops = STOPS_BETWEEN_COLORS * (colors.length - 1);
    for (let i = 0; i <= stops; i++) {
      const at = (i / stops) * (colors.length - 1);
      const from = Math.min(Math.floor(at), colors.length - 2);
      const color = mix(colors[from] ?? first, colors[from + 1] ?? first, at - from);
      gradient.addColorStop(i / stops, toCss(color));
    }
    context.fillStyle = gradient;
  }
  context.fillRect(0, 0, size, size);
  // The edge, a one-pixel line just inside the swatch's rounded outline.
  const radius = Number.parseFloat(getComputedStyle(canvas).borderTopLeftRadius) * scale;
  context.strokeStyle = "rgb(0 0 0 / 0.08)";
  context.lineWidth = scale;
  context.beginPath();
  context.roundRect(
    scale / 2,
    scale / 2,
    size - scale,
    size - scale,
    Math.max(0, radius - scale / 2),
  );
  context.stroke();
}

/** Changes the theme with a short cross-fade, unless the person asked for less motion. */
function crossFade(change: () => void): void {
  if (
    typeof document.startViewTransition !== "function" ||
    matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    change();
    return;
  }
  document.startViewTransition(() => flushSync(change));
}
