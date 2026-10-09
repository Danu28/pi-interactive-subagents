/**
 * Integration tests for the process backend (native Windows, no tmux).
 *
 * These tests exercise the real backend-agnostic `surface.ts` API
 * (`createSurface`, `sendLongCommand`, `readScreen`, `pollForExit`,
 * `closeSurface`) with `PI_SUBAGENT_BACKEND=process` forced for this file.
 * No LLM calls — fast and free.
 *
 * An opt-in test that launches a real `pi` agent sits behind
 * `PI_TEST_INTEGRATION_REAL=1` and is skipped by default.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSurface,
  sendLongCommand,
  readScreen,
  closeSurface,
  pollForExit,
  shellEscape,
  backendInUse,
} from "../../pi-extension/subagents/surface.ts";
import { findBash } from "../../pi-extension/subagents/process-backend.ts";
import { getAvailableBackends } from "./harness.ts";

// Force the process backend for this file (restored in after() below).
// surface.ts reads this env var dynamically, so setting it here — before any
// surface call — is enough even though imports are hoisted.
const PREV_BACKEND = process.env.PI_SUBAGENT_BACKEND;
process.env.PI_SUBAGENT_BACKEND = "process";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(TEST_DIR, "../..");
const EXTENSION_SOURCE = join(PROJECT_ROOT, "pi-extension", "subagents", "index.ts");

/** Model used by the opt-in real-pi test. Override with PI_TEST_MODEL env var. */
const TEST_MODEL = process.env.PI_TEST_MODEL ?? "anthropic/claude-haiku-4-5";

const NO_BASH = !findBash();
const bashSkip = NO_BASH ? "bash required" : false;
if (NO_BASH) {
  console.log("⚠️  no usable bash found — skipping process-lifecycle integration tests");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uniqueId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ── Process table helpers ──

interface ProcEntry {
  pid: number;
  ppid: number;
  cmd: string;
}

/**
 * Dump the process table: Windows via PowerShell Get-CimInstance
 * Win32_Process, POSIX via ps. One entry per process.
 */
function dumpProcesses(): ProcEntry[] {
  let out: string;
  if (process.platform === "win32") {
    out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $($_.CommandLine)\" }",
      ],
      { encoding: "utf8", timeout: 15000, windowsHide: true },
    );
  } else {
    out = execFileSync("ps", ["-e", "-o", "pid=,ppid=,args="], {
      encoding: "utf8",
      timeout: 15000,
    });
  }
  const rows: ProcEntry[] = [];
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s?(.*)$/);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] ?? "" });
  }
  return rows;
}

/** Transitive closure of `roots` (inclusive) following parent → child links. */
function descendantsOf(rows: ProcEntry[], roots: number[]): number[] {
  const byParent = new Map<number, number[]>();
  for (const r of rows) {
    const kids = byParent.get(r.ppid) ?? [];
    kids.push(r.pid);
    byParent.set(r.ppid, kids);
  }
  const seen = new Set<number>(roots);
  const stack = [...roots];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const kid of byParent.get(cur) ?? []) {
      if (!seen.has(kid)) {
        seen.add(kid);
        stack.push(kid);
      }
    }
  }
  return [...seen];
}

function isPidAlive(rows: ProcEntry[], pid: number): boolean {
  return rows.some((r) => r.pid === pid);
}

/** Poll pollForExit with a hard timeout so a hung backend fails, not hangs. */
async function pollWithTimeout(
  handle: string,
  opts: { interval: number; sessionFile?: string; sentinelFile?: string },
  timeoutMs = 15000,
) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await pollForExit(handle, ctrl.signal, opts);
  } finally {
    clearTimeout(timer);
  }
}

/** Poll readScreen until `pattern` appears (the script has started). */
async function waitForLog(handle: string, pattern: RegExp, timeoutMs = 10000): Promise<string> {
  const start = Date.now();
  let screen = "";
  while (Date.now() - start < timeoutMs) {
    screen = readScreen(handle, 20);
    if (pattern.test(screen)) return screen;
    await sleep(200);
  }
  throw new Error(`Timeout (${timeoutMs}ms) waiting for log ${pattern}.\nLast log:\n${screen.slice(-1000)}`);
}

// ── Suite ──

describe("process-lifecycle [process]", { timeout: 60_000 }, () => {
  const tempDirs: string[] = [];
  const surfaces: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-proc-integ-"));
    tempDirs.push(dir);
    return dir;
  }

  function track(handle: string): string {
    surfaces.push(handle);
    return handle;
  }

  function untrack(handle: string): void {
    const i = surfaces.indexOf(handle);
    if (i >= 0) surfaces.splice(i, 1);
  }

  after(() => {
    for (const handle of surfaces.splice(0)) {
      try {
        closeSurface(handle);
      } catch {}
    }
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
    if (PREV_BACKEND === undefined) delete process.env.PI_SUBAGENT_BACKEND;
    else process.env.PI_SUBAGENT_BACKEND = PREV_BACKEND;
  });

  it("has an available backend", () => {
    assert.ok(getAvailableBackends().length > 0, "expected at least one available backend");
    assert.equal(backendInUse(), "process", "this file forces the process backend");
  });

  it("requires bash", { skip: bashSkip }, () => {});

  it("runs a script, captures output and exit code", { skip: bashSkip }, async () => {
    const dir = makeTempDir();
    const handle = track(createSurface("proc-basic"));
    assert.ok(handle.startsWith("proc:"), `expected a process handle, got ${handle}`);

    const scriptPath = join(dir, "basic.sh");
    sendLongCommand(handle, "echo PROC_MARKER_123", { scriptPath });

    const result = await pollWithTimeout(handle, { interval: 50 });
    assert.equal(result.exitCode, 0, `expected exit code 0, got ${JSON.stringify(result)}`);

    const screen = readScreen(handle, 20);
    assert.ok(
      screen.includes("PROC_MARKER_123"),
      `Expected log to contain PROC_MARKER_123. Got:\n${screen}`,
    );

    closeSurface(handle);
    untrack(handle);
  });

  it("prefers the shell sentinel exit code", { skip: bashSkip }, async () => {
    const dir = makeTempDir();
    const handle = track(createSurface("proc-sentinel"));

    const scriptPath = join(dir, "sentinel.sh");
    sendLongCommand(handle, `(exit 7); echo '__SUBAGENT_DONE_'$?'__'`, { scriptPath });

    // The harness-recorded bash exit code is 0 (echo succeeded); the sentinel
    // carries the real exit code 7 and must win.
    const result = await pollWithTimeout(handle, { interval: 50 });
    assert.equal(result.exitCode, 7, `expected sentinel exit code 7, got ${JSON.stringify(result)}`);

    closeSurface(handle);
    untrack(handle);
  });

  it("surfaces the .exit sidecar error", { skip: bashSkip }, async () => {
    const dir = makeTempDir();
    const handle = track(createSurface("proc-sidecar"));

    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "test" }) + "\n", "utf8");
    writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "error", errorMessage: "boom" }), "utf8");

    const result = await pollWithTimeout(handle, { interval: 50, sessionFile });
    assert.equal(result.reason, "error");
    assert.equal(result.errorMessage, "boom");

    closeSurface(handle);
    untrack(handle);
  });

  it("kills the process tree on closeSurface", { skip: bashSkip }, async () => {
    const dir = makeTempDir();
    const token = `K${uniqueId()}`.replace(/[^a-zA-Z0-9]/g, "");

    const handle = track(createSurface("proc-kill"));
    const scriptPath = join(dir, `kill-${token}.sh`);
    // The grandchild is a forked bash subshell (suspended, so it burns no
    // CPU) — NOT an external sleep.exe: MSYS fork-copies keep correct Windows
    // PPIDs and the launcher's command line (which carries the token), while
    // external grandchildren get unreliable PPIDs that taskkill /T cannot
    // follow. The TERM trap covers POSIX, where closeSurface sends SIGTERM.
    const command = [
      "trap 'kill -KILL $(jobs -p) 2>/dev/null; exit 0' TERM",
      `echo "KILL_READY_${token}"`,
      "( kill -STOP $BASHPID 2>/dev/null; while :; do :; done ) &",
      "wait",
    ].join("\n");
    sendLongCommand(handle, command, { scriptPath });

    await waitForLog(handle, new RegExp(`KILL_READY_${token}`));

    // Record the launcher (script path carries the token) plus every
    // transitive descendant via the parent chain.
    let recorded: number[] = [];
    const start = Date.now();
    while (Date.now() - start < 15000) {
      const rows = dumpProcesses();
      const launchers = rows.filter((r) => r.cmd.includes(token)).map((r) => r.pid);
      recorded = [...new Set(descendantsOf(rows, launchers))];
      if (recorded.length >= 2) break; // launcher + subshell grandchild
      await sleep(250);
    }
    assert.ok(
      recorded.length >= 2,
      `expected launcher + grandchild processes for token ${token}, got ${recorded.length}`,
    );

    closeSurface(handle);
    untrack(handle);

    const deadline = Date.now() + 5000;
    let alive: number[] = recorded;
    while (Date.now() < deadline) {
      const rows = dumpProcesses();
      alive = recorded.filter((pid) => isPidAlive(rows, pid));
      if (alive.length === 0) break;
      await sleep(250);
    }
    assert.deepEqual(alive, [], `expected the whole process tree dead, survivors: ${alive}`);
  });

  it(
    "launches a real pi agent (opt-in)",
    {
      skip:
        process.env.PI_TEST_INTEGRATION_REAL === "1" && !NO_BASH
          ? false
          : "set PI_TEST_INTEGRATION_REAL=1 to run",
      timeout: 180_000,
    },
    async () => {
      const dir = makeTempDir();
      const handle = track(createSurface("proc-real-pi"));
      const scriptPath = join(dir, "real-pi.sh");
      const cmd =
        `pi -ne -e ${shellEscape(EXTENSION_SOURCE)} --model ${shellEscape(TEST_MODEL)} ` +
        `"Reply with PROC_REAL_OK and nothing else, then exit"; ` +
        `echo '__SUBAGENT_DONE_'$?'__'`;
      sendLongCommand(handle, cmd, { scriptPath });

      const result = await pollWithTimeout(handle, { interval: 500 }, 150000);
      assert.equal(result.exitCode, 0, `expected pi to exit 0, got ${JSON.stringify(result)}`);
      const screen = readScreen(handle, 50);
      assert.ok(
        screen.includes("PROC_REAL_OK"),
        `Expected agent output PROC_REAL_OK. Got:\n${screen.slice(-2000)}`,
      );

      closeSurface(handle);
      untrack(handle);
    },
  );
});
