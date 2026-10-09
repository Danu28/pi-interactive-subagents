/**
 * Process surface backend — runs subagents as detached background processes.
 *
 * Used automatically on platforms without tmux (notably native Windows, where
 * pi runs on Git Bash). tmux.ts remains the backend wherever tmux is
 * available; surface.ts picks between the two.
 *
 * Per subagent (keyed by surface handle `proc:<id>`):
 * - the launch script is written to `<scriptPath>` (same bash content the
 *   tmux path would type into a pane),
 * - stdout/stderr stream to `<scriptPath>.log` (readScreen reads its tail),
 * - the harness exit code is captured via the child handle and persisted to
 *   `<scriptPath>.exitcode` (pollForExit reads it — no terminal scraping),
 * - live steering arrives via the session inbox `<sessionFile>.steer`
 *   (appended by the parent, polled by the child's subagent-done.ts).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

export interface ProcRecord {
  id: string;
  handle: string;
  child: ChildProcess | null;
  scriptPath: string | null;
  logFile: string | null;
  exitFile: string | null;
  exitCode: number | null;
  spawnError?: string;
  logFd: number | null;
}

const procRecords = new Map<string, ProcRecord>();

/** True for handles owned by this backend (`proc:<id>`). */
export function isProcessSurface(surface: string): boolean {
  return surface.startsWith("proc:");
}

/** Create a surface handle. The process is spawned by runScriptInBackground. */
export function createProcessSurface(): string {
  const id = Math.random().toString(16).slice(2, 10);
  const handle = `proc:${id}`;
  procRecords.set(handle, {
    id,
    handle,
    child: null,
    scriptPath: null,
    logFile: null,
    exitFile: null,
    exitCode: null,
    logFd: null,
  });
  return handle;
}

let bashCache: string | null | undefined;

/**
 * True when `candidate` is an MSYS-family bash (Git Bash, MSYS2, Cygwin) that
 * understands native Windows paths. Notably rejects the WSL stub
 * (C:\Windows\System32\bash.exe), which answers `--version` with exit 0
 * but runs a Linux userspace that cannot open `C:\…` script paths.
 */
export function isMsysBash(candidate: string): boolean {
  try {
    const result = spawnSync(candidate, ["-c", "uname -s"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) return false;
    const sys = (result.stdout ?? "").trim().toLowerCase();
    return sys.includes("mingw") || sys.includes("msys") || sys.includes("cygwin");
  } catch {
    return false;
  }
}

/**
 * Resolve a bash executable for running launch scripts. Honors
 * PI_SUBAGENT_BASH, then well-known Git for Windows / MSYS2 / Cygwin
 * locations on win32, then PATH. On Windows every candidate must prove it is
 * an MSYS-family bash (see isMsysBash) — a bare `--version` check accepts
 * the WSL stub, which cannot run Windows-path scripts. Cached; null when
 * nothing usable is found.
 */
export function findBash(): string | null {
  if (bashCache !== undefined) return bashCache;
  const override = process.env.PI_SUBAGENT_BASH?.trim();
  const candidates: string[] = [];
  if (override) candidates.push(override);
  if (process.platform === "win32") {
    candidates.push(
      "C:/Program Files/Git/bin/bash.exe",
      "C:/Program Files (x86)/Git/bin/bash.exe",
      "C:/msys64/usr/bin/bash.exe",
      "C:/cygwin64/bin/bash.exe",
    );
  }
  candidates.push("bash", "/bin/bash");
  for (const candidate of candidates) {
    try {
      const result = spawnSync(candidate, ["--version"], { stdio: "ignore", timeout: 5000, windowsHide: true });
      if (result.error || result.status !== 0) continue;
      if (process.platform === "win32" && !isMsysBash(candidate)) continue;
      bashCache = candidate;
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  bashCache = null;
  return null;
}

/** Test hook: drop the cached bash lookup so tests start clean. */
export function resetFindBashCache(): void {
  bashCache = undefined;
}

function safeCloseLog(record: ProcRecord): void {
  if (record.logFd == null) return;
  const fd = record.logFd;
  record.logFd = null;
  try {
    closeSync(fd);
  } catch {
    // Best effort.
  }
}

function markExited(record: ProcRecord, code: number, note?: string): void {
  if (record.exitCode == null) {
    record.exitCode = code;
    if (record.exitFile) {
      try {
        writeFileSync(record.exitFile, `${code}\n`, "utf8");
      } catch {
        // Best effort — the in-memory code is still authoritative.
      }
    }
    if (note && record.logFile) {
      try {
        appendFileSync(record.logFile, `${note}\n`, "utf8");
      } catch {
        // Best effort.
      }
    }
  }
  safeCloseLog(record);
}

/**
 * Spawn a previously-written launch script as a detached background process.
 * Never throws: spawn failures are recorded as exit code 127 with details in
 * the log, so pollForExit surfaces a clear error instead of hanging.
 *
 * Returns the script path.
 */
export function runScriptInBackground(
  surface: string,
  scriptPath: string,
  opts?: { cwd?: string },
): string {
  let record = procRecords.get(surface);
  if (!record) {
    createProcessSurfaceRecord(surface);
    record = procRecords.get(surface)!;
  }
  record.scriptPath = scriptPath;
  record.logFile = `${scriptPath}.log`;
  record.exitFile = `${scriptPath}.exitcode`;
  try {
    rmSync(record.exitFile, { force: true });
  } catch {
    // Best effort.
  }
  const header =
    `# Launched: ${new Date().toISOString()}\n# Surface: ${surface}\n# Script: ${scriptPath}\n`;

  const bash = findBash();
  if (!bash) {
    const msg =
      "subagents: no usable bash found. Install Git for Windows (https://git-scm.com/download/win) " +
      "— a WSL-only bash.exe is not enough, subagents need Git/MSYS bash to run Windows-path scripts — " +
      "or set PI_SUBAGENT_BASH to a Git Bash executable, then retry.";
    record.spawnError = msg;
    try {
      mkdirSync(dirname(scriptPath), { recursive: true });
      writeFileSync(record.logFile, `${header}${msg}\n`, "utf8");
    } catch {
      // Best effort.
    }
    markExited(record, 127);
    return scriptPath;
  }

  try {
    mkdirSync(dirname(scriptPath), { recursive: true });
    // NOTE: the log must be opened with "w", not "a" — an append-mode
    // handle inherited on Windows silently swallows the child's stdout.
    const logFd = openSync(record.logFile, "w");
    record.logFd = logFd;
    try {
      writeSync(logFd, header, null, "utf8");
    } catch {
      // Best effort.
    }
    const child = spawn(bash, [scriptPath], {
      cwd: opts?.cwd ?? process.cwd(),
      env: process.env,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
    });
    record.child = child;
    child.on("error", (err) => {
      record!.spawnError = err?.message ?? String(err);
      markExited(record!, 127, `subagents: failed to start bash: ${record!.spawnError}`);
    });
    child.on("exit", (code) => {
      markExited(record!, code ?? 1);
    });
    child.unref();
  } catch (err: any) {
    record.spawnError = err?.message ?? String(err);
    markExited(record, 127, `subagents: failed to spawn: ${record.spawnError}`);
  }
  return scriptPath;
}

function createProcessSurfaceRecord(surface: string): void {
  const id = surface.startsWith("proc:") ? surface.slice("proc:".length) : surface;
  procRecords.set(surface, {
    id,
    handle: surface,
    child: null,
    scriptPath: null,
    logFile: null,
    exitFile: null,
    exitCode: null,
    logFd: null,
  });
}

/**
 * The harness exit code for a process surface, or null while still running.
 * Reads the in-memory record first, then the persisted `.exitcode` file.
 */
export function getProcessExit(surface: string, exitFile?: string | null): number | null {
  const record = procRecords.get(surface);
  if (record?.exitCode != null) return record.exitCode;
  const file = record?.exitFile ?? exitFile ?? null;
  if (file && existsSync(file)) {
    try {
      const code = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
      if (Number.isInteger(code)) {
        if (record) {
          record.exitCode = code;
          safeCloseLog(record);
        }
        return code;
      }
    } catch {
      // Treat as still running.
    }
  }
  return null;
}

/**
 * True while the process may still be running. Unknown (tmux-style) surfaces
 * are not ours — this only answers for `proc:` handles.
 */
export function isProcessAlive(surface: string): boolean {
  const record = procRecords.get(surface);
  if (!record) return false;
  return record.exitCode == null;
}

/** Read the tail of a process surface's log (readScreen equivalent). */
export function readProcessLog(surface: string, lines = 50): string {
  const record = procRecords.get(surface);
  if (!record?.logFile) return "";
  try {
    return readFileSync(record.logFile, "utf8").split("\n").slice(-Math.max(1, lines)).join("\n");
  } catch {
    return "";
  }
}

/** Kill the process (best effort, never throws) and forget the handle. */
export function closeProcessSurface(surface: string): void {
  const record = procRecords.get(surface);
  procRecords.delete(surface);
  if (!record) return;
  const child = record.child;
  try {
    if (child && child.exitCode == null && record.exitCode == null) {
      // Windows: kill the whole tree BEFORE the launcher dies. Terminating the
      // bash launcher first makes `taskkill /T` fail ("process not found") and
      // orphans the real pi grandchild.
      if (process.platform === "win32" && child.pid != null) {
        try {
          spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            timeout: 5000,
            windowsHide: true,
          });
        } catch {
          // Best effort.
        }
      }
      try {
        child.kill();
      } catch {
        // Best effort.
      }
    }
  } catch {
    // Never let cleanup break the watcher.
  }
  try {
    child?.unref?.();
  } catch {
    // Best effort.
  }
  safeCloseLog(record);
}

// ── Steer inbox ─────────────────────────────────────────────────────────────
// File-based live steering for process surfaces (which accept no keystrokes).
// The parent appends one JSON line per message; the child's subagent-done.ts
// polls for new lines and injects them via pi.sendUserMessage.

/** Path of the steer inbox for a subagent session file. */
export function steerInboxPath(sessionFile: string): string {
  return `${sessionFile}.steer`;
}

/** Append a steering message to a subagent's inbox. */
export function appendSteerMessage(sessionFile: string, message: string): void {
  const inbox = steerInboxPath(sessionFile);
  mkdirSync(dirname(inbox), { recursive: true });
  appendFileSync(inbox, JSON.stringify({ message, at: Date.now() }) + "\n", "utf8");
}

/** Only complete lines (ending in `\n`); ignores a torn trailing partial line. */
function completeSteerLines(raw: string): string[] {
  return raw.split("\n").slice(0, -1).filter((line) => line.trim());
}

/** Count non-blank inbox lines (a child records this at startup to skip history). */
export function countSteerInboxLines(sessionFile: string): number {
  try {
    const raw = readFileSync(steerInboxPath(sessionFile), "utf8");
    return completeSteerLines(raw).length;
  } catch {
    return 0;
  }
}

export function readSteerInboxEntriesAfter(
  sessionFile: string,
  fromLine: number,
): { entries: { message: string; line: number }[]; nextLine: number } {
  let raw: string;
  try {
    raw = readFileSync(steerInboxPath(sessionFile), "utf8");
  } catch {
    return { entries: [], nextLine: fromLine };
  }
  const lines = completeSteerLines(raw);
  const entries: { message: string; line: number }[] = [];
  for (let i = Math.max(0, fromLine); i < lines.length; i++) {
    try {
      const parsed = JSON.parse(lines[i]) as { message?: unknown };
      if (parsed && typeof parsed.message === "string" && parsed.message.trim()) {
        entries.push({ message: parsed.message, line: i });
      }
    } catch {
      // Skip malformed complete lines.
    }
  }
  return { entries, nextLine: lines.length };
}

/**
 * Read inbox messages appended after `fromLine` (a count from
 * countSteerInboxLines). Malformed lines are skipped. Returns the messages
 * and the new line count to pass as `fromLine` next time.
 */
export function readSteerInboxAfter(
  sessionFile: string,
  fromLine: number,
): { messages: string[]; nextLine: number } {
  const { entries, nextLine } = readSteerInboxEntriesAfter(sessionFile, fromLine);
  return { messages: entries.map((e) => e.message), nextLine };
}

export const __procTest__ = { procRecords };
