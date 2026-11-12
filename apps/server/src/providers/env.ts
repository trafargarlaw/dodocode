import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** Variables that must not reach an agent's process. */
const WITHHELD = [
  // A parent Claude Code session sets these; a child that sees them joins that session.
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_EFFORT",
  "CLAUDE_PID",
  "CLAUDE_AGENT_SDK_VERSION",
  // Electron sets this for the server. Any Electron app the agent starts would run as Node.
  "ELECTRON_RUN_AS_NODE",
  "DODOCODE_TOKEN",
  "DODOCODE_DATA_DIR",
  "DODOCODE_PORT",
];

export function agentEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !WITHHELD.includes(name)) env[name] = value;
  }
  return env;
}

/** Finds an executable on PATH, trying Windows' extensions in order. */
export function findOnPath(name: string, extraDirs: string[] = []): string | undefined {
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  const dirs = [...(process.env.PATH ?? "").split(delimiter), ...extraDirs].filter(Boolean);
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = join(dir, name + extension);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export const HOME_BIN = join(homedir(), ".local", "bin");
