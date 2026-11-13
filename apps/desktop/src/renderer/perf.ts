// Spans for performance traces. Each one is a performance.measure(), which a trace the app records
// (DODOCODE_TRACE, see src/main/tracing.ts) holds under its name, for `perfq spans` to read. They
// do nothing unless the app records one.
//
// Names are `<kind>:<what>`, so perfq can group them:
//   call:<method>   a server call, from sending it to its answer
//   event:<type>    applying one event the server pushed
//   feed:<name>     loading a feed's snapshot, until the frame that shows it
//   startup         from the window opening to the first frame with the app's data
//
// Marks named `interaction:<what>` name each click and key press, for `perfq slow` (see below).

// Tests run the modules that import this one without a window, and record nothing.
const tracing = typeof window !== "undefined" && window.dodocode.tracing;

const done = () => {};

function measure(name: string, start: number): void {
  performance.measure(name, { start, end: performance.now() });
  // The trace keeps the span; the page's own list of them would grow for as long as it runs.
  performance.clearMeasures(name);
}

/** Starts a span. Call the function it returns when the work ends. */
export function startSpan(name: string): () => void {
  if (!tracing) return done;
  const start = performance.now();
  return () => measure(name, start);
}

/** Like `startSpan`, but the span ends once the next frame is drawn, so it covers rendering. */
export function startShownSpan(name: string): () => void {
  if (!tracing) return done;
  const start = performance.now();
  return () => afterNextFrame(() => measure(name, start));
}

let started = false;

/** Ends the `startup` span, the first time it is called. */
export function markStartup(): void {
  if (!tracing || started) return;
  started = true;
  afterNextFrame(() => measure("startup", 0));
}

/** A task queued from a frame callback runs once that frame is drawn. */
function afterNextFrame(callback: () => void): void {
  requestAnimationFrame(() => setTimeout(callback, 0));
}

// Names each click and key press for `perfq slow`: a mark, `interaction:<what>`, at the event's
// own time, which perfq matches to Chrome's timing of that interaction in the trace. It keeps what
// was clicked and which key or shortcut was pressed, never the characters typed.
if (tracing) {
  for (const type of ["pointerdown", "keydown"] as const) {
    addEventListener(type, markInteraction, { capture: true, passive: true });
  }
}

function markInteraction(event: Event): void {
  const name = `interaction:${describeInteraction(event)}`;
  performance.mark(name, { startTime: event.timeStamp });
  performance.clearMarks(name);
}

/** `click button "Board"`, `key Ctrl+K in page`, `typing in textarea "Message"`. */
function describeInteraction(event: Event): string {
  if (event instanceof KeyboardEvent) {
    const key = shortcut(event);
    // A shortcut does the same wherever the focus happens to be.
    if (key && (event.ctrlKey || event.metaKey || event.altKey)) return `key ${key}`;
    const what = describeTarget(event.target);
    return key ? `key ${key} in ${what}` : `typing in ${what}`;
  }
  const what = describeTarget(event.target);
  const click = event instanceof MouseEvent && event.button === 2 ? "right-click" : "click";
  return `${click} ${what}`;
}

type KeyPress = Pick<
  KeyboardEvent,
  "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing" | "getModifierState"
>;

/** The key and its modifiers (`Ctrl+K`, `Shift+Enter`), or nothing for a key that types text. */
export function shortcut(event: KeyPress): string | undefined {
  // AltGr types characters, and Windows reports it as Ctrl+Alt.
  const typing =
    event.isComposing ||
    event.key === "Process" ||
    event.key === "Dead" ||
    event.getModifierState("AltGraph");
  if (typing) return undefined;
  const mods: string[] = [];
  if (event.ctrlKey) mods.push("Ctrl");
  if (event.metaKey) mods.push("Meta");
  if (event.altKey) mods.push("Alt");
  const printable = event.key.length === 1;
  if (printable && mods.length === 0) return undefined;
  if (event.shiftKey && !printable) mods.push("Shift");
  return [...mods, printable ? event.key.toUpperCase() : event.key].join("+");
}

const CONTROL =
  "button, a[href], input, textarea, select, [role], [contenteditable=''], [contenteditable='true'], [data-slot]";
const LABEL_LENGTH = 40;

/** The control an event landed on: its kind, and its label when it has one that is not typed text. */
function describeTarget(target: EventTarget | null): string {
  if (!(target instanceof Element)) return "page";
  const control = target.closest(CONTROL) ?? target;
  const kind =
    control.getAttribute("data-slot") ??
    control.getAttribute("role") ??
    control.tagName.toLowerCase();
  // A quote in the label would end the quoted name early.
  const label = labelOf(control).replace(/\s+/g, " ").replaceAll('"', "'").trim();
  if (!label) return kind;
  const short = label.length > LABEL_LENGTH ? `${label.slice(0, LABEL_LENGTH - 1)}…` : label;
  return `${kind} "${short}"`;
}

function labelOf(element: Element): string {
  const named =
    element.getAttribute("aria-label") ??
    element.getAttribute("title") ??
    element.getAttribute("placeholder");
  if (named !== null) return named;
  // A control's text names it. A container's text is the page's content.
  const editable =
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLElement && element.isContentEditable);
  return element.matches("button, a[href], [role]") && !editable ? textStart(element) : "";
}

/** The start of an element's text. It stops early: the timing counts the time spent here. */
function textStart(element: Element): string {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let text = "";
  while (text.length <= LABEL_LENGTH && walker.nextNode()) {
    text += ` ${walker.currentNode.textContent ?? ""}`;
  }
  return text;
}
