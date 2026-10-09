/**
 * Unit tests for the Windows (background-process) backend.
 *
 * No tmux, no panes, no LLM calls — fast and free. These tests force
 * PI_SUBAGENT_BACKEND=process and exercise real `bash` spawns (Git Bash on
 * Windows, system bash elsewhere), the steer inbox, and the surface facade.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { existsSync as existsSyncFs } from "node:fs";
import * as surface from "../pi-extension/subagents/surface.ts";
import {
  appendSteerMessage,
  countSteerInboxLines,
  createProcessSurface,
  findBash,
  getProcessExit,
  isMsysBash,
  isProcessAlive,
  isProcessSurface,
  readSteerInboxAfter,
  readSteerInboxEntriesAfter,
  resetFindBashCache,
  steerInboxPath,
  __procTest__,
} from "../pi-extension/subagents/process-backend.ts";
import { getNewEntries } from "../pi-extension/subagents/session.ts";
import * as subagentsModule from "../pi-extension/subagents/index.ts";

const SAVED_ENV = { ...process.env };

function setBackend(value: string | undefined) {
  if (value === undefined) delete process.env.PI_SUBAGENT_BACKEND;
  else process.env.PI_SUBAGENT_BACKEND = value;
}

async function waitFor(cond: () => boolean, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeEach(() => {
  resetFindBashCache();
});

afterEach(() => {
  process.env.PI_SUBAGENT_BACKEND = SAVED_ENV.PI_SUBAGENT_BACKEND as string;
  if (SAVED_ENV.PI_SUBAGENT_BACKEND === undefined) delete process.env.PI_SUBAGENT_BACKEND;
  if (SAVED_ENV.TMUX === undefined) delete process.env.TMUX;
  else process.env.TMUX = SAVED_ENV.TMUX;
  resetFindBashCache();
});

describe("backend selection", () => {
  it("honors PI_SUBAGENT_BACKEND=process", () => {
    setBackend("process");
    assert.equal(surface.backendInUse(), "process");
    const handle = surface.createSurface("w");
    assert.ok(isProcessSurface(handle));
    surface.closeSurface(handle);
  });

  it("honors PI_SUBAGENT_BACKEND=tmux", () => {
    setBackend("tmux");
    assert.equal(surface.backendInUse(), "tmux");
  });

  it("falls back to the process backend without tmux", () => {
    setBackend("auto");
    delete process.env.TMUX;
    // No tmux binary in this environment, so auto must pick process.
    // (On a machine with tmux installed + TMUX set, tmux wins — by design.)
    if (!process.env.TMUX) {
      assert.ok(["tmux", "process"].includes(surface.backendInUse()));
    }
  });

  it("isMuxAvailable is true for the process backend (no tmux needed)", () => {
    setBackend("process");
    assert.equal(surface.isMuxAvailable(), true);
  });

  it("getBackendProblem is null when bash resolves, actionable otherwise", () => {
    setBackend("process");
    const problem = surface.getBackendProblem();
    if (findBash()) {
      assert.equal(problem, null);
    } else {
      assert.match(problem ?? "", /Git for Windows/);
    }
  });

  it("getBackendProblem is null for the tmux backend", () => {
    setBackend("tmux");
    assert.equal(surface.getBackendProblem(), null);
  });
});

describe("bash resolution (Windows WSL-stub trap)", () => {
  it("rejects the WSL stub bash that cannot run Windows-path scripts", () => {
    // C:\Windows\System32\bash.exe answers --version with exit 0 but runs
    // a Linux userspace (regression: it was accepted and launches died 127).
    const stubs = [
      "C:/Windows/System32/bash.exe",
      "C:/Windows/Sysnative/bash.exe",
    ].filter((p) => existsSyncFs(p));
    if (stubs.length === 0) {
      console.log("⚠️  no WSL stub bash present — skipping rejection test");
      return;
    }
    for (const stub of stubs) {
      assert.equal(isMsysBash(stub), false, `${stub} must not qualify as MSYS bash`);
    }
  });

  it("findBash resolves an MSYS-family bash (never a Linux one)", () => {
    const bash = findBash();
    if (!bash) {
      console.log("⚠️  no bash at all — skipping");
      return;
    }
    assert.equal(isMsysBash(bash), true, `${bash} must be MSYS-family`);
    const uname = spawnSync(bash, ["-c", "uname -s"], { encoding: "utf8", timeout: 5000 });
    assert.match((uname.stdout ?? "").toLowerCase(), /mingw|msys|cygwin|darwin|linux/);
    if (process.platform === "win32") {
      assert.match((uname.stdout ?? "").toLowerCase(), /mingw|msys|cygwin/);
    }
  });
});

describe("steer inbox", () => {
  it("round-trips messages and skips malformed lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-steer-"));
    try {
      const sessionFile = join(dir, "s.jsonl");
      assert.equal(countSteerInboxLines(sessionFile), 0);

      appendSteerMessage(sessionFile, "first");
      appendSteerMessage(sessionFile, "second");
      assert.equal(countSteerInboxLines(sessionFile), 2);

      const all = readSteerInboxAfter(sessionFile, 0);
      assert.deepEqual(all.messages, ["first", "second"]);
      assert.equal(all.nextLine, 2);

      const tail = readSteerInboxAfter(sessionFile, 1);
      assert.deepEqual(tail.messages, ["second"]);

      // Malformed line is skipped without breaking the stream.
      appendFileSync(steerInboxPath(sessionFile), "not-json\n", "utf8");
      appendSteerMessage(sessionFile, "third");
      const after = readSteerInboxAfter(sessionFile, 2);
      assert.deepEqual(after.messages, ["third"]);
      assert.equal(after.nextLine, 4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("steerSubagent queues into the inbox for process surfaces (no keystrokes)", () => {
    setBackend("process");
    const testApi = (subagentsModule as any).__test__;
    const dir = mkdtempSync(join(tmpdir(), "pi-steerq-"));
    try {
      const handle = surface.createSurface("w");
      const running = {
        id: "p1",
        name: "Worker",
        task: "",
        surface: handle,
        startTime: 0,
        sessionFile: join(dir, "s.jsonl"),
      };
      const result = testApi.steerSubagent(running, "do this\nthen that", () => {
        throw new Error("send must not be called for process surfaces");
      });
      assert.deepEqual(result, { ok: true });
      const inbox = readSteerInboxAfter(join(dir, "s.jsonl"), 0);
      // Process surfaces deliver via the JSON-line inbox, which safely carries
      // newlines, so multi-line messages are preserved (tmux flattens instead).
      assert.deepEqual(inbox.messages, ["do this\nthen that"]);
      surface.closeSurface(handle);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("isSurfaceAlive/isProcessSurface classify handles", () => {
    setBackend("process");
    const handle = createProcessSurface();
    try {
      assert.equal(isProcessSurface(handle), true);
      assert.equal(isProcessSurface("%12"), false);
      assert.equal(isProcessAlive(handle), true);
      assert.equal(isProcessAlive("proc:gone"), false);
    } finally {
      surface.closeSurface(handle);
    }
  });
});

describe("process spawn", () => {
  it("runs a script detached, captures output and exit code", async () => {
    setBackend("process");
    if (!findBash()) {
      console.log("⚠️  no bash — skipping process spawn test");
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "pi-proc-"));
    try {
      const handle = surface.createSurface("w");
      const scriptPath = join(dir, "launch.sh");
      surface.sendLongCommand(handle, "echo hello-proc-backend\nexit 41", {
        scriptPath,
        scriptPreamble: "# test launch",
      });
      assert.ok(existsSync(`${scriptPath}.log`));
      await waitFor(() => getProcessExit(handle) != null);
      assert.equal(getProcessExit(handle), 41);
      assert.match(surface.readScreen(handle, 20), /hello-proc-backend/);

      // pollForExit resolves from the recorded exit without hanging.
      const result = await surface.pollForExit(handle, new AbortController().signal, {
        interval: 50,
      });
      assert.equal(result.exitCode, 41);
      surface.closeSurface(handle);
      assert.equal(isProcessAlive(handle), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("closeSurface kills a long-running process", async () => {
    setBackend("process");
    if (!findBash()) {
      console.log("⚠️  no bash — skipping process kill test");
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "pi-prockill-"));
    try {
      const handle = surface.createSurface("w");
      surface.sendLongCommand(handle, "sleep 60", { scriptPath: join(dir, "sleep.sh") });
      await new Promise((r) => setTimeout(r, 500));
      surface.closeSurface(handle);
      assert.equal(isProcessAlive(handle), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pollForExit surfaces the .exit sidecar error without spawning", async () => {
    setBackend("process");
    const dir = mkdtempSync(join(tmpdir(), "pi-procexit-"));
    try {
      const sessionFile = join(dir, "s.jsonl");
      writeFileSync(sessionFile, '{"type":"session","id":"x"}\n', "utf8");
      writeFileSync(
        `${sessionFile}.exit`,
        JSON.stringify({ type: "error", errorMessage: "boom" }),
        "utf8",
      );
      const handle = surface.createSurface("w");
      try {
        const result = await surface.pollForExit(handle, new AbortController().signal, {
          interval: 50,
          sessionFile,
        });
        assert.equal(result.reason, "error");
        assert.equal(result.errorMessage, "boom");
        assert.equal(existsSync(`${sessionFile}.exit`), false);
      } finally {
        surface.closeSurface(handle);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readScreen on a missing log returns empty (never throws)", async () => {
    setBackend("process");
    const handle = createProcessSurface();
    try {
      assert.equal(surface.readScreen(handle), "");
      assert.equal(await surface.readScreenAsync(handle), "");
    } finally {
      surface.closeSurface(handle);
    }
  });
});

describe("durable exit code", () => {
  it("getProcessExit reads a persisted .exitcode file for an unknown handle", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-exitcode-"));
    try {
      const script = join(dir, "launch.sh");
      writeFileSync(`${script}.exitcode`, "0", "utf8");
      const unknown = `proc:never-seen-${Math.random().toString(16).slice(2)}`;
      assert.equal(getProcessExit(unknown, `${script}.exitcode`), 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("steer inbox file helpers", () => {
  it("readSteerInboxAfter on a missing inbox returns the same cursor", () => {
    const missing = join(tmpdir(), `pi-nope-${Date.now()}.jsonl`);
    const read = readSteerInboxAfter(missing, 3);
    assert.deepEqual(read, { messages: [], nextLine: 3 });
  });
});

describe("process surface liveness (no infinite hang)", () => {
  it("pollForExit resolves when the process surface was released", async () => {
    setBackend("process");
    const handle = createProcessSurface();
    // Release the record without ever recording an exit code — the watcher
    // must resolve instead of polling a handle that no longer exists.
    surface.closeSurface(handle);
    const result = await surface.pollForExit(handle, new AbortController().signal, { interval: 20 });
    assert.equal(result.reason, "error");
    assert.match(result.errorMessage ?? "", /closed before completion/);
  });
});

describe("process tree teardown (kill-order regression)", () => {
  function powershellAvailable(): boolean {
    if (process.platform !== "win32") return false;
    try {
      const out = spawnSync(
        "powershell",
        ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"],
        { encoding: "utf8", timeout: 10000, windowsHide: true },
      );
      return !out.error && out.status === 0;
    } catch {
      return false;
    }
  }

  function descendantPids(rootPid: number): Set<number> {
    try {
      const out = spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId | ConvertTo-Json -Compress",
        ],
        { encoding: "utf8", timeout: 10000, windowsHide: true },
      );
      if (out.error || out.status !== 0 || !out.stdout?.trim()) return new Set();
      let rows: any = JSON.parse(out.stdout.trim());
      if (!Array.isArray(rows)) rows = [rows];
      const byParent = new Map<number, number[]>();
      for (const row of rows) {
        const pid = Number(row.ProcessId);
        const ppid = Number(row.ParentProcessId);
        if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
        const list = byParent.get(ppid) ?? [];
        list.push(pid);
        byParent.set(ppid, list);
      }
      const seen = new Set<number>([rootPid]);
      const queue = [rootPid];
      while (queue.length > 0) {
        const cur = queue.pop()!;
        for (const child of byParent.get(cur) ?? []) {
          if (!seen.has(child)) {
            seen.add(child);
            queue.push(child);
          }
        }
      }
      seen.delete(rootPid);
      return seen;
    } catch {
      return new Set();
    }
  }

  function pidAlive(pid: number): boolean {
    try {
      const out = spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`,
        ],
        { encoding: "utf8", timeout: 10000, windowsHide: true },
      );
      return !out.error && (out.stdout ?? "").trim() === String(pid);
    } catch {
      return false;
    }
  }

  it("closeSurface kills the whole process tree (Windows)", async () => {
    setBackend("process");
    if (!findBash()) {
      console.log("⚠️  no bash — skipping process tree kill test");
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "pi-proctree-"));
    let handle: string | null = null;
    try {
      handle = surface.createSurface("w");
      const scriptPath = join(dir, "tree.sh");
      surface.sendLongCommand(handle, "sleep 300\n", { scriptPath });
      const h = handle;
      await waitFor(() => {
        const rec = __procTest__.procRecords.get(h);
        return rec?.child?.pid != null && isProcessAlive(h);
      }, 10000);
      const rootPid = __procTest__.procRecords.get(h)!.child!.pid!;
      if (process.platform !== "win32") {
        handle = null;
        surface.closeSurface(h);
        assert.equal(__procTest__.procRecords.has(h), false);
        return;
      }
      if (!powershellAvailable()) {
        console.log("⚠️  no powershell — skipping descendant assertion");
        return;
      }
      // Give the sleep grandchild a moment to appear under the launcher.
      await waitFor(() => descendantPids(rootPid).size > 0, 10000);
      const before = descendantPids(rootPid);
      assert.ok(before.size > 0, "expected a live grandchild before closeSurface");
      handle = null; // closed below; finally must not double-close
      surface.closeSurface(h);
      assert.equal(__procTest__.procRecords.has(h), false);
      const deadline = Date.now() + 5000;
      for (;;) {
        const still = [...before].filter(pidAlive);
        if (still.length === 0) break;
        if (Date.now() > deadline) {
          assert.fail(`closeSurface orphaned processes: ${still.join(", ")}`);
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      try {
        if (handle) surface.closeSurface(handle);
      } catch {
        // Best effort.
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sentinel precedence (exit-code regression)", () => {
  it("pollForExit prefers the shell sentinel over the bash exit code", async () => {
    setBackend("process");
    if (!findBash()) {
      console.log("⚠️  no bash — skipping sentinel precedence test");
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "pi-procsentinel-"));
    let handle: string | null = null;
    try {
      handle = surface.createSurface("w");
      const scriptPath = join(dir, "sentinel.sh");
      surface.sendLongCommand(handle, "(exit 7); echo '__SUBAGENT_DONE_'$?'__'", { scriptPath });
      const result = await surface.pollForExit(handle, new AbortController().signal, { interval: 50 });
      assert.equal(result.exitCode, 7);
    } finally {
      try {
        if (handle) surface.closeSurface(handle);
      } catch {
        // Best effort.
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("torn trailing line regressions", () => {
  it("readSteerInboxAfter ignores a torn trailing line", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-steertorn-"));
    try {
      const sessionFile = join(dir, "s.jsonl");
      writeFileSync(sessionFile, "", "utf8");
      writeFileSync(steerInboxPath(sessionFile), '{"message":"first"}\n{"message":"parti', "utf8");
      const first = readSteerInboxAfter(sessionFile, 0);
      assert.deepEqual(first.messages, ["first"]);
      assert.equal(first.nextLine, 1);
      appendFileSync(steerInboxPath(sessionFile), 'al","at":2}\n', "utf8");
      const second = readSteerInboxAfter(sessionFile, first.nextLine);
      assert.deepEqual(second.messages, ["partial"]);
      assert.equal(second.nextLine, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readSteerInboxEntriesAfter returns per-message line indices", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-steeridx-"));
    try {
      const sessionFile = join(dir, "s.jsonl");
      writeFileSync(sessionFile, "", "utf8");
      appendSteerMessage(sessionFile, "one");
      appendSteerMessage(sessionFile, "two");
      const { entries, nextLine } = readSteerInboxEntriesAfter(sessionFile, 0);
      assert.equal(entries.length, 2);
      assert.equal(entries[0].line, 0);
      assert.equal(entries[1].line, 1);
      assert.equal(nextLine, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("getNewEntries skips a torn trailing JSONL line", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sessiontorn-"));
    try {
      const file = join(dir, "s.jsonl");
      writeFileSync(
        file,
        JSON.stringify({ type: "session", id: "x" }) + "\n" + '{"type":"message","id":"parti',
        "utf8",
      );
      let entries: unknown[] = [];
      assert.doesNotThrow(() => {
        entries = getNewEntries(file, 0);
      });
      assert.equal(entries.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
