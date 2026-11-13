// The dodocode server. The desktop app starts it as a utility process; it can also run alone:
//   DODOCODE_DATA_DIR=... DODOCODE_TOKEN=... node --experimental-strip-types src/start.ts
// It listens on 127.0.0.1 only, and every request must carry the token, except for the pages the
// agent showed, which run sandboxed and must never see it.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CallFrame, ServerEvent, ServerFrame } from "@dodocode/protocol";
import { WebSocketServer, type WebSocket } from "ws";

import { App, type Client } from "./app";
import { stopProfile } from "./profile";
import { errorText, log } from "./util";
import { PAGE_HEIGHT_SCRIPT } from "./web-files";

interface ParentPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
}

/** Set when Electron runs this as a utility process. */
const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;

const dataDir = process.env.DODOCODE_DATA_DIR || join(homedir(), ".dodocode", "standalone");
const token = process.env.DODOCODE_TOKEN || randomBytes(24).toString("hex");
const requestedPort = Number(process.env.DODOCODE_PORT) || 0;

/** A WebSocket frame may hold a pasted image, base64 encoded. */
const MAX_FRAME = 64 * 1024 * 1024;
const HEARTBEAT_MS = 30_000;

mkdirSync(dataDir, { recursive: true });
const app = new App(dataDir);
app.start();

function tokenMatches(candidate: string | null): boolean {
  if (!candidate) return false;
  const given = Buffer.from(candidate);
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", "http://127.0.0.1");
}

// HTTP: attachments and image files, so the renderer can show images by URL, and the pages the
// agent showed.

/**
 * A page the agent showed runs in a sandbox of its own: its scripts run, but it has no origin,
 * so it can read nothing of the app's, and it never sees the token. Its id is all it takes to
 * load it, and only the server and the renderer know the ids.
 */
const PAGE_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Content-Security-Policy":
    "sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Serves `/views/<id>/<file>`: a page the agent showed, and what it loads from beside it. */
function servePage(response: ServerResponse, url: URL): void {
  const match = /^\/views\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (!match) {
    response.writeHead(404, PAGE_HEADERS).end();
    return;
  }
  let id: string;
  let rest: string | undefined;
  try {
    id = decodeURIComponent(match[1]!);
    rest = match[2] === undefined ? undefined : decodeURIComponent(match[2].slice(1));
  } catch {
    response.writeHead(400, PAGE_HEADERS).end();
    return;
  }
  // The page loads its files by paths relative to its own folder.
  if (rest === undefined) {
    response.writeHead(308, { ...PAGE_HEADERS, Location: `${url.pathname}/` }).end();
    return;
  }
  const file = app.pageFile(id, rest);
  if (!file || !isFile(file.path)) {
    response.writeHead(404, PAGE_HEADERS).end();
    return;
  }
  if (!file.page) {
    response.writeHead(200, { ...PAGE_HEADERS, "Content-Type": file.mime });
    createReadStream(file.path).pipe(response);
    return;
  }
  const html = readFileSync(file.path, "utf8");
  const end = html.search(/<\/body>/i);
  const body =
    end === -1
      ? html + PAGE_HEIGHT_SCRIPT
      : html.slice(0, end) + PAGE_HEIGHT_SCRIPT + html.slice(end);
  response.writeHead(200, { ...PAGE_HEADERS, "Content-Type": file.mime }).end(body);
}

function serveFile(
  response: ServerResponse,
  file: { path: string; mime: string } | undefined,
  cache: string,
): void {
  const headers = { "Access-Control-Allow-Origin": "*" };
  if (!file || !isFile(file.path)) {
    response.writeHead(404, headers).end();
    return;
  }
  response.writeHead(200, {
    ...headers,
    "Content-Type": file.mime,
    "Cache-Control": cache,
    "X-Content-Type-Options": "nosniff",
    // An SVG opened by itself runs no script.
    "Content-Security-Policy": "sandbox",
  });
  createReadStream(file.path).pipe(response);
}

function serveHttp(request: IncomingMessage, response: ServerResponse): void {
  const url = requestUrl(request);
  const headers = { "Access-Control-Allow-Origin": "*" };
  if (url.pathname === "/health") {
    response.writeHead(200, { ...headers, "Content-Type": "text/plain" }).end("ok");
    return;
  }
  if (request.method === "GET" && url.pathname.startsWith("/views/")) {
    servePage(response, url);
    return;
  }
  if (!tokenMatches(url.searchParams.get("token"))) {
    response.writeHead(401, headers).end();
    return;
  }
  const match = /^\/attachments\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && match) {
    const file = app.attachmentFile(decodeURIComponent(match[1]!));
    serveFile(response, file, "private, max-age=31536000, immutable");
    return;
  }
  if (request.method === "GET" && url.pathname === "/files") {
    // The file can change under the same path, as when the agent takes a screenshot again.
    serveFile(response, app.imageFile(url.searchParams.get("path") ?? ""), "no-cache");
    return;
  }
  response.writeHead(404, headers).end();
}

// WebSocket: calls and events.

const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
const alive = new WeakMap<WebSocket, boolean>();

function connect(socket: WebSocket): void {
  const send = (frame: ServerFrame) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
  };
  const client: Client = {
    open: new Set(),
    send: (event: ServerEvent) => send({ event }),
  };
  const disconnect = app.connect(client);
  alive.set(socket, true);
  socket.on("pong", () => alive.set(socket, true));
  socket.on("close", disconnect);
  socket.on("error", (error) => log("ws", "socket error", errorText(error)));
  socket.on("message", (data) => {
    let frame: CallFrame;
    try {
      frame = JSON.parse(data.toString()) as CallFrame;
    } catch {
      log("ws", "unreadable frame");
      return;
    }
    if (typeof frame.id !== "number" || typeof frame.method !== "string") return;
    const { id, method } = frame;
    const answer = (result: unknown) => send({ id, result: result ?? null });
    const fail = (error: unknown) => {
      log("ws", `${method} failed:`, errorText(error));
      send({ id, error: { message: errorText(error) } });
    };
    // A result that is ready goes out now, before any event, so the client can tell which
    // events it already holds (see App.call).
    let result: unknown;
    try {
      result = app.call(method, frame.params, client);
    } catch (error) {
      fail(error);
      return;
    }
    if (result instanceof Promise) result.then(answer, fail);
    else answer(result);
  });
}

const heartbeat = setInterval(() => {
  for (const socket of sockets.clients) {
    if (!alive.get(socket)) {
      socket.terminate();
      continue;
    }
    alive.set(socket, false);
    socket.ping();
  }
}, HEARTBEAT_MS);

const server = createServer(serveHttp);

server.on("upgrade", (request, socket, head) => {
  const url = requestUrl(request);
  if (url.pathname !== "/ws" || !tokenMatches(url.searchParams.get("token"))) {
    socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return;
  }
  sockets.handleUpgrade(request, socket, head, connect);
});

function listen(port: number): void {
  server.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE" && port !== 0) {
      log("server", `port ${port} is taken; using another`);
      listen(0);
      return;
    }
    log("server", "could not listen", errorText(error));
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    const actual = typeof address === "object" && address ? address.port : port;
    log("server", `listening on 127.0.0.1:${actual}`);
    if (parentPort) parentPort.postMessage({ type: "ready", port: actual });
    else process.stdout.write(`DODOCODE_READY ${JSON.stringify({ port: actual, token })}\n`);
  });
}

listen(requestedPort);

// Shutdown

let stopping = false;

async function shutdown(reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log("server", `stopping: ${reason}`);
  clearInterval(heartbeat);
  for (const socket of sockets.clients) socket.close(1001, "The server is stopping.");
  server.close();
  // A stop that hangs still ends the server, and still writes the profile.
  const forced = setTimeout(() => void stopProfile().finally(() => process.exit(0)), 5000);
  try {
    await app.dispose();
  } catch (error) {
    log("server", "could not stop cleanly", errorText(error));
  }
  await stopProfile();
  clearTimeout(forced);
  process.exit(0);
}

parentPort?.on("message", (event) => {
  const message = event.data as { type?: string } | undefined;
  if (message?.type === "shutdown") void shutdown("asked by the app");
});
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("disconnect", () => void shutdown("the app went away"));

// An agent's failure must not take down every other thread.
process.on("uncaughtException", (error) => log("server", "uncaught", error));
process.on("unhandledRejection", (reason) => log("server", "unhandled rejection", reason));
