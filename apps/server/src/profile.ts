// Samples the server's CPU while DODOCODE_CPU_PROFILE names a file, and writes the samples there as
// a .cpuprofile when the server stops, for `perfq` (tools/perfq) to read. The desktop app sets it
// when it records a performance trace (apps/desktop/src/main/tracing.ts).

import { writeFileSync } from "node:fs";
import { Session } from "node:inspector";
import { errorText, log } from "./util";

const path = process.env.DODOCODE_CPU_PROFILE;
/** Microseconds between samples, as the renderer's profiler takes them. */
const SAMPLE_INTERVAL_US = 1000;

let session: Session | undefined;

/** Starts sampling, if a profile was asked for. A session in the same thread answers at once. */
export function startProfile(): void {
  if (!path) return;
  session = new Session();
  session.connect();
  session.post("Profiler.enable");
  session.post("Profiler.setSamplingInterval", { interval: SAMPLE_INTERVAL_US });
  session.post("Profiler.start");
}

/** Stops sampling and writes the profile. */
export function stopProfile(): Promise<void> {
  const current = session;
  if (!current || !path) return Promise.resolve();
  session = undefined;
  return new Promise((resolve) => {
    current.post("Profiler.stop", (error, result) => {
      if (error) log("profile", "could not stop the profiler", errorText(error));
      else writeFileSync(path, JSON.stringify(result.profile));
      current.disconnect();
      resolve();
    });
  });
}
