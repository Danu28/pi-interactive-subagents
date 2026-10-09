/**
 * Surface layer — the only terminal/process abstraction this extension uses.
 *
 * Surface backends:
 * - `tmux` (default wherever tmux is available): visible panes, keystroke
 *   steering, screen scraping. See tmux.ts.
 * - `windows-terminal` (auto-detected inside Windows Terminal): visible panes
 *   running Git Bash scripts with sidecar-based process tracking.
 * - `process` (fallback): detached background processes with file-based exit
 *   detection and inbox-file steering. See process-backend.ts.
 *
 * Backend selection: `PI_SUBAGENT_BACKEND=tmux|process|windows-terminal` can
 * force a backend; otherwise tmux wins, then Windows Terminal when detected,
 * then the background process fallback. Everything the extension does to a
 * subagent surface goes through this file so index.ts stays backend-agnostic
 * (and testable without a multiplexer running).
 */
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  isTmuxAvailable,
  muxSetupHint as tmuxSetupHint,
  createSurface as tmuxCreateSurface,
  sendCommand as tmuxSendCommand,
  sendLongCommand as tmuxSendLongCommand,
  readScreen as tmuxReadScreen,
  readScreenAsync as tmuxReadScreenAsync,
  closeSurface as tmuxCloseSurface,
  isTmuxSurfaceAlive,
  shellEscape,
  interpretExitSidecar,
} from "./tmux.ts";
import {
  isProcessSurface,
  createProcessSurface,
  createWindowsTerminalSurface,
  runScriptInBackground,
  runScriptInWindowsTerminal,
  getProcessExit,
  isProcessAlive,
  readProcessLog,
  closeProcessSurface,
  findBash,
  findWindowsTerminal,
  isWindowsTerminalSurface,
} from "./process-backend.ts";

export { shellEscape, isProcessSurface };
export type { PollResult } from "./tmux.ts";

export type Backend = "tmux" | "process" | "windows-terminal";

/** Which backend surfaces will use (honors PI_SUBAGENT_BACKEND). */
export function backendInUse(): Backend {
  const forced = (process.env.PI_SUBAGENT_BACKEND ?? "auto").trim().toLowerCase();
  if (forced === "tmux") return "tmux";
  if (forced === "process") return "process";
  if (forced === "windows-terminal") return "windows-terminal";
  if (isTmuxAvailable()) return "tmux";
  if (process.platform === "win32" && process.env.WT_SESSION && findWindowsTerminal()) {
    return "windows-terminal";
  }
  return "process";
}

/**
 * True when subagents can run: tmux is available, or the process backend will
 * be used (it only needs node + bash, validated at spawn with an actionable
 * error — see getBackendProblem).
 */
export function isMuxAvailable(): boolean {
  if (backendInUse() === "tmux") return isTmuxAvailable();
  return true;
}

export function muxSetupHint(): string {
  if (isTmuxAvailable()) return tmuxSetupHint();
  if (process.platform === "win32") {
    return "Windows Terminal panes are used when available; otherwise subagents run as background processes. Both require Git for Windows bash.";
  }
  return `Subagents require tmux. ${tmuxSetupHint()}`;
}

/**
 * Actionable problem with the selected backend, or null when ready to spawn.
 * The process backend needs a bash executable (same requirement pi itself has
 * on Windows for its bash tool).
 */
export function getBackendProblem(): string | null {
  const backend = backendInUse();
  if (backend === "windows-terminal" && !findWindowsTerminal()) {
    return "Cannot launch subagent pane: wt.exe was not found; set PI_SUBAGENT_WT_EXE or use the process backend.";
  }
  if (backend === "tmux") return null;
  if (!findBash()) {
    return (
      "Cannot launch subagent: no usable bash found. Install Git for Windows " +
      "(https://git-scm.com/download/win) — a WSL-only bash.exe is not enough — or set " +
      "PI_SUBAGENT_BASH to a Git Bash executable, then retry."
    );
  }
  return null;
}

/** True while the surface is still running (dead tmux panes are detected). */
export function isSurfaceAlive(surface: string): boolean {
  if (isProcessSurface(surface)) return isProcessAlive(surface);
  return isTmuxSurfaceAlive(surface);
}

/**
 * Create a surface for a subagent: a tmux or Windows Terminal pane, or a
 * background-process handle when no pane-capable terminal is available.
 */
export function createSurface(name: string): string {
  const backend = backendInUse();
  if (backend === "tmux") return tmuxCreateSurface(name);
  if (backend === "windows-terminal") return createWindowsTerminalSurface(name);
  return createProcessSurface();
}

/**
 * Send a command string to a surface and execute it. Process surfaces accept
 * no keystrokes — steer them via the session inbox instead (see
 * appendSteerMessage in process-backend.ts); this throws to catch misuse.
 */
export function sendCommand(surface: string, command: string): void {
  if (isProcessSurface(surface)) {
    throw new Error(
      "Process surfaces do not accept keystrokes. Steer the subagent via its session inbox instead.",
    );
  }
  tmuxSendCommand(surface, command);
}

/**
 * Send a long command to a surface by writing it to a script file first.
 * Terminal panes execute it visibly; process surfaces spawn it detached with
 * output captured to `<scriptPath>.log`. Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string; cwd?: string },
): string {
  if (isWindowsTerminalSurface(surface)) {
    return sendWindowsTerminalCommand(surface, command, options);
  }
  if (!isProcessSurface(surface)) {
    return tmuxSendLongCommand(surface, command, options);
  }
  const scriptPath =
    options?.scriptPath ??
    join(tmpdir(), "pi-subagent-scripts", `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`);
  mkdirSync(dirname(scriptPath), { recursive: true });
  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);
  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", { mode: 0o755 });
  runScriptInBackground(surface, scriptPath, { cwd: options?.cwd });
  return scriptPath;
}

function sendWindowsTerminalCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string; cwd?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(tmpdir(), "pi-subagent-scripts", `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`);
  mkdirSync(dirname(scriptPath), { recursive: true });
  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) scriptParts.push(options.scriptPreamble.trimEnd());
  scriptParts.push(command);
  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", { mode: 0o755 });
  runScriptInWindowsTerminal(surface, scriptPath, { cwd: options?.cwd });
  return scriptPath;
}

/** Read a surface's visible output (pane screen, or log tail for processes). */
export function readScreen(surface: string, lines = 50): string {
  if (isProcessSurface(surface)) return readProcessLog(surface, lines);
  return tmuxReadScreen(surface, lines);
}

/** Read a surface's visible output (async). */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  if (isProcessSurface(surface)) return readProcessLog(surface, lines);
  return tmuxReadScreenAsync(surface, lines);
}

/** Close a surface (kill pane / kill process, best effort). */
export function closeSurface(surface: string): void {
  if (isProcessSurface(surface)) {
    closeProcessSurface(surface);
    return;
  }
  tmuxCloseSurface(surface);
}

// ── Exit polling ──

export interface PollOptions {
  interval: number;
  sessionFile?: string;
  sentinelFile?: string;
  exitFile?: string;
  onTick?: (elapsed: number) => void;
}

function sleepAbortable(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("Aborted"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by the error path), the Claude sentinel file, then the
 * backend-specific signal: tmux screen sentinel, or the process exit
 * code / log-tail sentinel. Shared by both backends so crash detection and
 * error reporting behave the same everywhere.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: PollOptions,
): Promise<import("./tmux.ts").PollResult> {
  const start = Date.now();
  const procSurface = isProcessSurface(surface);

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by the error path)
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    if (procSurface) {
      // Prefer the shell sentinel: the launch script ends with
      // `...; echo '__SUBAGENT_DONE_'$?'__'`, so the recorded bash exit code
      // is always 0 and would mask a failing subagent. The sentinel carries the
      // real `pi` exit code. Only fall back to the recorded exit code when no
      // sentinel has been written yet (e.g. the process was killed).
      try {
        const tail = readProcessLog(surface, 5);
        const match = tail.match(/__SUBAGENT_DONE_(\d+)__/);
        if (match) {
          return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
        }
      } catch {
        // Log may not exist yet — keep waiting.
      }
      // Process exit code (harness-recorded, no screen needed).
      const code = getProcessExit(surface, options.exitFile);
      if (code != null) {
        return { reason: "sentinel", exitCode: code };
      }
      // The handle was released without an exit code (e.g. the parent process
      // forgot it after a restart). Resolve as a failure instead of polling a
      // surface that no longer exists forever.
      if (!isProcessAlive(surface)) {
        return {
          reason: "error",
          exitCode: 1,
          errorMessage: "Subagent surface closed before completion (process handle was released).",
        };
      }
    } else {
      // Slow path: read terminal screen for sentinel (crash detection)
      try {
        const screen = await tmuxReadScreenAsync(surface, 5);
        const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
        if (match) {
          return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
        }
      } catch {
        // Surface may have been destroyed — check if .exit file appeared in the meantime
        if (options.sessionFile) {
          try {
            const exitFile = `${options.sessionFile}.exit`;
            if (existsSync(exitFile)) {
              const data = JSON.parse(readFileSync(exitFile, "utf-8"));
              rmSync(exitFile, { force: true });
              return interpretExitSidecar(data);
            }
          } catch {}
        }
        // No sidecar and the pane is gone: the subagent can never complete, so
        // resolve now instead of looping forever on a dead pane.
        if (!isTmuxSurfaceAlive(surface)) {
          return {
            reason: "error",
            exitCode: 1,
            errorMessage: "Subagent surface closed before completion (pane was killed).",
          };
        }
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await sleepAbortable(signal, options.interval);
  }
}
