/**
 * Windows process surfaces — detached background processes and visible
 * Windows Terminal panes. tmux.ts remains the Unix multiplexer backend;
 * surface.ts selects the appropriate surface.
 *
 * Per subagent (keyed by `proc:<id>` or `wt:<id>`):
 * - the launch script is written to `<scriptPath>` (same bash content the
 *   tmux path would type into a pane),
 * - background-process stdout/stderr stream to `<scriptPath>.log`,
 * - Windows Terminal panes display the live TUI; wrapper PID/exit sidecars
 *   let the parent stop and monitor the pane's process,
 * - live steering arrives via `<sessionFile>.steer` for process-managed
 *   surfaces (appended by the parent, polled by the child's subagent-done.ts).
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
  kind: "process" | "windows-terminal";
  name?: string;
  child: ChildProcess | null;
  scriptPath: string | null;
  wrapperPath: string | null;
  pidFile: string | null;
  logFile: string | null;
  exitFile: string | null;
  exitCode: number | null;
  launchStartedAt: number | null;
  spawnError?: string;
  logFd: number | null;
}

const procRecords = new Map<string, ProcRecord>();

/** True for process-managed surfaces (`proc:<id>` and `wt:<id>`). */
export function isProcessSurface(surface: string): boolean {
  return surface.startsWith("proc:") || surface.startsWith("wt:");
}

/** True for surfaces rendered in a Windows Terminal pane. */
export function isWindowsTerminalSurface(surface: string): boolean {
  return surface.startsWith("wt:");
}

function createSurfaceRecord(
  kind: ProcRecord["kind"],
  prefix: "proc:" | "wt:",
  name?: string,
): string {
  const id = Math.random().toString(16).slice(2, 10);
  const handle = `${prefix}${id}`;
  procRecords.set(handle, {
    id,
    handle,
    kind,
    name,
    child: null,
    scriptPath: null,
    wrapperPath: null,
    pidFile: null,
    logFile: null,
    exitFile: null,
    exitCode: null,
    launchStartedAt: null,
    logFd: null,
  });
  return handle;
}

/** Create a hidden process surface. */
export function createProcessSurface(): string {
  return createSurfaceRecord("process", "proc:");
}

/** Reserve a visible Windows Terminal surface; it opens when launched. */
export function createWindowsTerminalSurface(name: string): string {
  return createSurfaceRecord("windows-terminal", "wt:", name);
}

let bashCache: string | null | undefined;
let windowsTerminalCache: string | null | undefined;

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
  windowsTerminalCache = undefined;
}

/** Resolve wt.exe (including the Windows App Execution Alias). */
export function findWindowsTerminal(): string | null {
  if (windowsTerminalCache !== undefined) return windowsTerminalCache;
  if (process.platform !== "win32") return (windowsTerminalCache = null);

  const override = process.env.PI_SUBAGENT_WT_EXE?.trim();
  if (override) return (windowsTerminalCache = override);

  try {
    const result = spawnSync("where.exe", ["wt.exe"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    const candidate = (result.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (!result.error && result.status === 0 && candidate) {
      windowsTerminalCache = candidate;
      return candidate;
    }
  } catch {
    // The explicit override below remains available on unusual Windows setups.
  }

  windowsTerminalCache = null;
  return null;
}

/** Build the Windows Terminal CLI arguments for a side-by-side agent pane. */
export function buildWindowsTerminalArgs(params: {
  windowId: string;
  cwd: string;
  title: string;
  bash: string;
  wrapperPath: string;
  scriptPath: string;
}): string[] {
  const title = params.title.replace(/[\r\n]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").trim() || "Subagent";
  return [
    "-w", params.windowId,
    "split-pane", "-H",
    "--startingDirectory", params.cwd,
    "--title", title,
    "--suppressApplicationTitle",
    params.bash,
    params.wrapperPath,
    params.scriptPath,
    ";",
    "move-focus", "previous",
  ];
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
 * Launch a script in a visible Windows Terminal split pane. The wrapper writes
 * native PID and exit-code sidecars because wt.exe itself is only a dispatcher.
 */
export function runScriptInWindowsTerminal(
  surface: string,
  scriptPath: string,
  opts?: { cwd?: string; name?: string },
): string {
  let record = procRecords.get(surface);
  if (!record) {
    createProcessSurfaceRecord(surface);
    record = procRecords.get(surface)!;
  }
  const wrapperPath = `${scriptPath}.wt.sh`;
  const pidFile = `${wrapperPath}.pid`;
  const logFile = `${scriptPath}.log`;
  const exitFile = `${scriptPath}.exitcode`;
  record.kind = "windows-terminal";
  record.name = opts?.name ?? record.name;
  record.scriptPath = scriptPath;
  record.wrapperPath = wrapperPath;
  record.pidFile = pidFile;
  record.logFile = logFile;
  record.exitFile = exitFile;
  record.launchStartedAt = Date.now();
  record.exitCode = null;

  const header =
    `# Launched: ${new Date().toISOString()}\n# Surface: ${surface}\n# Script: ${scriptPath}\n` +
    `# Live terminal output is displayed in the Windows Terminal pane.\n`;
  const bash = findBash();
  const wt = findWindowsTerminal();
  if (!bash || !wt) {
    const msg = !bash
      ? "subagents: no usable Git/MSYS bash found for the Windows Terminal pane."
      : "subagents: wt.exe was not found. Start pi inside Windows Terminal or set PI_SUBAGENT_WT_EXE.";
    record.spawnError = msg;
    try {
      mkdirSync(dirname(scriptPath), { recursive: true });
      writeFileSync(logFile, `${header}${msg}\n`, "utf8");
    } catch {
      // Best effort.
    }
    markExited(record, 127);
    return scriptPath;
  }

  try {
    mkdirSync(dirname(scriptPath), { recursive: true });
    rmSync(exitFile, { force: true });
    rmSync(pidFile, { force: true });
    writeFileSync(logFile, header, "utf8");
    const wrapper = [
      "#!/usr/bin/env bash",
      "wrapper_path=$(cygpath -u \"${BASH_SOURCE[0]}\")",
      "script_path=$(cygpath -u \"$1\")",
      "windows_pid=$(ps -W -p \"$$\" | awk 'NR == 2 {print $4}')",
      "printf '%s\\n' \"${windows_pid:-$$}\" > \"${wrapper_path}.pid\"",
      "bash \"$script_path\"",
      "status=$?",
      "exit_path=\"${wrapper_path%.wt.sh}.exitcode\"",
      "printf '%s\\n' \"$status\" > \"$exit_path\"",
      "exit \"$status\"",
    ].join("\n") + "\n";
    writeFileSync(wrapperPath, wrapper, { mode: 0o755 });

    const args = buildWindowsTerminalArgs({
      windowId: process.env.PI_SUBAGENT_WT_WINDOW?.trim() || "0",
      cwd: opts?.cwd ?? process.cwd(),
      title: record.name ?? "Subagent",
      bash,
      wrapperPath,
      scriptPath,
    });
    const child = spawn(wt, args, {
      cwd: opts?.cwd ?? process.cwd(),
      env: process.env,
      windowsHide: true,
      stdio: "ignore",
    });
    record.child = child;
    child.on("error", (err) => {
      record!.spawnError = err?.message ?? String(err);
      markExited(record!, 127, `subagents: failed to start wt.exe: ${record!.spawnError}`);
    });
    child.on("exit", (code) => {
      if (record!.child === child) record!.child = null;
      // wt.exe is a short-lived command dispatcher. A zero exit means the
      // split request was accepted, not that the subagent has finished.
      if (code != null && code !== 0 && record!.exitCode == null) {
        markExited(record!, code, `subagents: wt.exe exited with code ${code}`);
      }
    });
    child.unref();
  } catch (err: any) {
    record.spawnError = err?.message ?? String(err);
    markExited(record, 127, `subagents: failed to open Windows Terminal pane: ${record.spawnError}`);
  }
  return scriptPath;
}

/**
 * Spawn a previously-written launch script as a detached background process.
 * Spawn failures are recorded so pollForExit reports a failure instead of hanging.
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
  const prefix = surface.startsWith("wt:") ? "wt:" : "proc:";
  const id = surface.startsWith(prefix) ? surface.slice(prefix.length) : surface;
  procRecords.set(surface, {
    id,
    handle: surface,
    kind: prefix === "wt:" ? "windows-terminal" : "process",
    child: null,
    scriptPath: null,
    wrapperPath: null,
    pidFile: null,
    logFile: null,
    exitFile: null,
    exitCode: null,
    launchStartedAt: null,
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
 * True while a process-managed surface is still running. WT panes use a PID
 * sidecar because the wt.exe command dispatcher exits immediately.
 */
export function isProcessAlive(surface: string): boolean {
  const record = procRecords.get(surface);
  if (!record || record.exitCode != null) return false;
  if (record.kind !== "windows-terminal") return true;
  if (getProcessExit(surface) != null) return false;

  if (record.pidFile && existsSync(record.pidFile)) {
    try {
      const pid = Number.parseInt(readFileSync(record.pidFile, "utf8").trim(), 10);
      if (!Number.isInteger(pid) || pid <= 0) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch (err: any) {
        return err?.code === "EPERM";
      }
    } catch {
      return false;
    }
  }

  // Allow time for wt.exe to dispatch the pane and for its wrapper to publish
  // a PID. A missing pane is reported as a failure after the startup grace.
  return record.launchStartedAt != null && Date.now() - record.launchStartedAt < 15_000;
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
    if (record.kind === "windows-terminal" && record.exitCode == null && record.pidFile) {
      try {
        const pid = Number.parseInt(readFileSync(record.pidFile, "utf8").trim(), 10);
        if (Number.isInteger(pid) && pid > 0) {
          if (process.platform === "win32") {
            spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
              stdio: "ignore",
              timeout: 5000,
              windowsHide: true,
            });
          } else {
            process.kill(pid, "SIGTERM");
          }
        }
      } catch {
        // Pane may already have exited or been closed manually.
      }
    }
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
