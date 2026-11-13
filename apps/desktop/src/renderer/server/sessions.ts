// The conversations agents had in other apps, for the palette to find and bring in as threads.

import { useEffect, useState } from "react";
import type {
  OutsideSession,
  SessionListing,
  SessionPlace,
  Thread,
  ThreadOrigin,
} from "@dodocode/protocol";
import { server } from "./connection";

/** How long a listing is used as it is. Reading every agent's history takes a moment. */
const FRESH_MS = 30_000;

let last: { at: number; listing: SessionListing } | undefined;
let reading: Promise<SessionListing> | undefined;

const fresh = () => last !== undefined && Date.now() - last.at < FRESH_MS;

function readSessions(): Promise<SessionListing> {
  reading ??= server.call("sessions.list", {}).then(
    (listing) => {
      last = { at: Date.now(), listing };
      reading = undefined;
      return listing;
    },
    (error: unknown) => {
      reading = undefined;
      throw error;
    },
  );
  return reading;
}

/**
 * Every conversation there is to bring in. The last listing shows at once, and is read again
 * when it is old.
 */
export function useSessions(): { listing?: SessionListing; reading: boolean; error?: string } {
  const [state, setState] = useState<{ listing?: SessionListing; error?: string }>(() => ({
    listing: last?.listing,
  }));
  const [current, setCurrent] = useState(fresh);
  useEffect(() => {
    if (current) return;
    let live = true;
    readSessions().then(
      (listing) => {
        if (!live) return;
        setState({ listing });
        setCurrent(true);
      },
      (error: unknown) => {
        if (!live) return;
        setState((before) => ({ ...before, error: errorText(error) }));
        setCurrent(true);
      },
    );
    return () => {
      live = false;
    };
  }, [current]);
  return { ...state, reading: !current };
}

/** Where a conversation would go, brought in, once the server has looked. */
export function useSessionPlace(session: OutsideSession): { place?: SessionPlace; error?: string } {
  const [result, setResult] = useState<{ place?: SessionPlace; error?: string }>({});
  useEffect(() => {
    let live = true;
    server.call("sessions.inspect", { provider: session.provider, sessionId: session.id }).then(
      (place) => {
        if (live) setResult({ place });
      },
      (error: unknown) => {
        if (live) setResult({ error: errorText(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [session.provider, session.id]);
  return result;
}

/** Brings a conversation in as a thread, and remembers it is in, for the next listing. */
export async function bringIn(
  session: OutsideSession,
  mode: ThreadOrigin["mode"],
): Promise<Thread> {
  const thread = await server.call("sessions.import", {
    provider: session.provider,
    sessionId: session.id,
    mode,
  });
  if (last) {
    const sessions = last.listing.sessions.map((each) =>
      each.provider === session.provider && each.id === session.id
        ? { ...each, threadId: thread.id }
        : each,
    );
    last = { ...last, listing: { ...last.listing, sessions } };
  }
  return thread;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
