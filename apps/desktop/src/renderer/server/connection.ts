// The window's link to the dodocode server: one WebSocket that carries the window's calls and
// the events the server pushes. When the socket drops it connects again, asking the main process
// each time where the server is, since a server that restarted may listen somewhere else.
//
// The server answers a call that finishes at once before it sends any other event. So a result
// holds every event the window got before the answer, and none it gets after: a collection can
// load a snapshot and drop the events that arrived while it waited.

import { useSyncExternalStore } from "react";
import {
  attachmentPath,
  imageFilePath,
  viewPath,
  type Method,
  type Params,
  type Result,
  type ServerEvent,
  type ServerFrame,
} from "@dodocode/protocol";
import type { ServerInfo } from "../../preload/bridge";

/** `connecting` until the first socket opens; `reconnecting` after one dropped. */
export type ConnectionState = "connecting" | "open" | "reconnecting";

/** Rejects a call whose socket dropped before the server answered. */
export class Disconnected extends Error {
  constructor() {
    super("The connection to the dodocode server dropped.");
    this.name = "Disconnected";
  }
}

const RETRY_MIN_MS = 200;
const RETRY_MAX_MS = 4000;
/** How long a call made while the socket is down waits for it to open. */
const CALL_WAIT_MS = 15_000;

interface PendingCall {
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
}

class Connection {
  state: ConnectionState = "connecting";
  /** Where the server is, once known. Attachments load from its address. */
  info: ServerInfo | undefined;
  private socket: WebSocket | undefined;
  private started = false;
  private retries = 0;
  private nextId = 1;
  private calls = new Map<number, PendingCall>();
  /** Calls made while the socket was down, sent when it opens. */
  private waiting = new Set<() => void>();
  private eventListeners = new Set<(event: ServerEvent) => void>();
  private openListeners = new Set<() => void>();
  private stateListeners = new Set<() => void>();

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.connect();
  }

  /** Calls a method on the server. Made while the socket is down, it waits for it to open. */
  call<M extends Method>(method: M, params: Params<M>): Promise<Result<M>> {
    return new Promise<Result<M>>((resolve, reject) => {
      let timer: number | undefined;
      const send = () => {
        this.waiting.delete(send);
        window.clearTimeout(timer);
        const socket = this.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          reject(new Disconnected());
          return;
        }
        const id = this.nextId++;
        this.calls.set(id, { resolve: resolve as (result: unknown) => void, reject });
        socket.send(JSON.stringify({ id, method, params }));
      };
      if (this.state === "open") {
        send();
        return;
      }
      this.waiting.add(send);
      timer = window.setTimeout(() => {
        this.waiting.delete(send);
        reject(new Error("The dodocode server is not answering."));
      }, CALL_WAIT_MS);
    });
  }

  /** Listens to every event the server pushes. Returns a function that stops listening. */
  onEvent(listener: (event: ServerEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Runs now if the socket is open, and again each time a new one opens. */
  whenOpen(listener: () => void): () => void {
    this.openListeners.add(listener);
    if (this.state === "open") listener();
    return () => this.openListeners.delete(listener);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  };

  getState = (): ConnectionState => this.state;

  /** Where an attachment's bytes load from, or an empty string before the server is known. */
  attachmentUrl(id: string): string {
    const info = this.info;
    if (!info) return "";
    return `${info.httpUrl}${attachmentPath(id)}?token=${encodeURIComponent(info.token)}`;
  }

  /** Where an image file on the server's machine loads from, as `attachmentUrl`. */
  imageFileUrl(path: string): string {
    const info = this.info;
    if (!info) return "";
    return `${info.httpUrl}${imageFilePath(path)}&token=${encodeURIComponent(info.token)}`;
  }

  /** Where a page the agent showed loads from. It takes no token: see `viewPath`. */
  viewUrl(id: string): string {
    const info = this.info;
    return info ? `${info.httpUrl}${viewPath(id)}` : "";
  }

  private async connect(): Promise<void> {
    let info: ServerInfo;
    try {
      info = await window.dodocode.serverInfo();
    } catch {
      this.retry();
      return;
    }
    this.info = info;
    const socket = new WebSocket(`${info.url}?token=${encodeURIComponent(info.token)}`);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.retries = 0;
      this.setState("open");
      for (const send of Array.from(this.waiting)) send();
      for (const listener of Array.from(this.openListeners)) listener();
    });

    socket.addEventListener("message", (message: MessageEvent<string>) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(message.data) as ServerFrame;
      } catch {
        return;
      }
      if ("event" in frame) {
        for (const listener of Array.from(this.eventListeners)) {
          try {
            listener(frame.event);
          } catch (error) {
            console.error("An event listener failed.", error);
          }
        }
        return;
      }
      const call = this.calls.get(frame.id);
      if (!call) return;
      this.calls.delete(frame.id);
      if ("error" in frame) call.reject(new Error(frame.error.message));
      else call.resolve(frame.result);
    });

    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      const calls = [...this.calls.values()];
      this.calls.clear();
      for (const call of calls) call.reject(new Disconnected());
      if (this.state === "open") this.setState("reconnecting");
      this.retry();
    });
  }

  private retry(): void {
    const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** this.retries);
    this.retries += 1;
    window.setTimeout(() => void this.connect(), delay);
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    for (const listener of Array.from(this.stateListeners)) listener();
  }
}

export const server = new Connection();

export function useConnectionState(): ConnectionState {
  return useSyncExternalStore(server.subscribe, server.getState);
}
