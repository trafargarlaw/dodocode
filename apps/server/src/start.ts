// The server's entry, as the desktop app builds it. It starts the CPU profile, when one was asked
// for, before the rest of the server loads: a module's imports load before its first line runs,
// so a profile started in main.ts would leave out the time the server takes to load.

import { startProfile } from "./profile";

startProfile();
await import("./main");
