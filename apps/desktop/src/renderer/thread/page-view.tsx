import { useEffect, useRef, useState } from "react";
import type { ViewItem } from "@dodocode/protocol";
import {
  ArrowUpRight01Icon,
  BrowserIcon,
  Maximize02Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@dodocode/ui/components/button";
import { Dialog, DialogContent, DialogTitle } from "@dodocode/ui/components/dialog";
import { Tip } from "../keys";
import { server } from "../server/connection";

// A web page the agent showed, such as a mock-up or a chart, running in the thread. It runs in a
// sandbox with no origin: its scripts run, but they reach nothing of the app's.

const SANDBOX = "allow-scripts allow-forms allow-modals allow-popups allow-downloads";
/** How tall a page starts, before it says how tall it is. */
const START_HEIGHT = 420;
const MIN_HEIGHT = 80;
/** A taller page scrolls inside its frame, so the thread stays readable. */
const MAX_HEIGHT = 720;

export function PageView({ item }: { item: ViewItem }) {
  const url = server.viewUrl(item.viewId);
  // Loading the page again picks up what changed in its file since.
  const [loads, setLoads] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);

  return (
    <figure className="flex flex-col overflow-hidden rounded-xl border bg-card">
      <figcaption className="flex min-w-0 items-center gap-2 border-b py-1 pr-1 pl-3">
        <HugeiconsIcon
          icon={BrowserIcon}
          strokeWidth={1.8}
          className="size-4 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 truncate text-[13px] font-medium">{item.title}</span>
        {item.path && (
          <span
            className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground"
            title={item.path}
          >
            {item.path}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center">
          {item.path && (
            <Tip label="Load it again, with what changed in its file">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Reload the page"
                className="text-muted-foreground"
                onClick={() => setLoads((count) => count + 1)}
              >
                <HugeiconsIcon icon={RefreshIcon} strokeWidth={1.8} />
              </Button>
            </Tip>
          )}
          <Tip label="Make it bigger">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Make the page bigger"
              className="text-muted-foreground"
              onClick={() => setExpanded(true)}
            >
              <HugeiconsIcon icon={Maximize02Icon} strokeWidth={1.8} />
            </Button>
          </Tip>
          <Tip label="Open in your browser">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Open the page in your browser"
              className="text-muted-foreground"
              disabled={!url}
              onClick={() => window.open(url, "_blank")}
            >
              <HugeiconsIcon icon={ArrowUpRight01Icon} strokeWidth={1.8} />
            </Button>
          </Tip>
        </div>
      </figcaption>
      {url && <PageFrame key={loads} url={url} title={item.title} fit />}
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent
          ref={dialog}
          // Focus inside the page would keep Escape from closing the dialog.
          initialFocus={dialog}
          className="flex h-[calc(100vh-4rem)] w-[calc(100vw-4rem)] flex-col gap-2 p-2 sm:max-w-[calc(100vw-4rem)]"
        >
          <DialogTitle className="truncate pr-10 pl-1 text-[13px] font-medium">
            {item.title}
          </DialogTitle>
          {url && (
            <div className="min-h-0 flex-1 overflow-hidden rounded-lg border">
              <PageFrame key={loads} url={url} title={item.title} />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </figure>
  );
}

/** The page in its frame. Fitted, the frame grows with the page, up to a point. */
function PageFrame({ url, title, fit }: { url: string; title: string; fit?: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(START_HEIGHT);

  useEffect(() => {
    if (!fit) return;
    const onMessage = (event: MessageEvent) => {
      // Only this frame's page says how tall it is.
      if (event.source !== frame.current?.contentWindow) return;
      const value = (event.data as { dodocodePageHeight?: unknown } | null)?.dodocodePageHeight;
      if (typeof value !== "number" || !Number.isFinite(value)) return;
      setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(value))));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [fit]);

  return (
    <iframe
      ref={frame}
      src={url}
      title={title}
      sandbox={SANDBOX}
      loading="lazy"
      style={fit ? { height } : undefined}
      className="block h-full w-full border-0 bg-white"
    />
  );
}
