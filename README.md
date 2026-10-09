# pi-interactive-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono), running in tmux panes (or background processes on Windows). Spawn a sub-agent, keep working in the main session, and get the result steered back when it finishes. Fully non-blocking.

**tmux-first fork with Windows support.** See [Acknowledgements](#acknowledgements) for the upstream project, which also supports cmux, zellij, and WezTerm.

## How it works

`subagent()` returns immediately. Where tmux is available, the sub-agent runs in its own tmux pane — a right split off the parent pi pane, so pane creation never steals keyboard focus. Without tmux (notably native Windows), it runs as a detached background process instead — same fire-and-forget flow, no visible pane. A live widget above the input tracks every running sub-agent, and when one finishes, its result is steered into the main session as a notification that triggers a new turn.

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  scout      active · bash 7m                 │
│ 00:45  scout-2    waiting 2m                       │
╰────────────────────────────────────────────────────╯
```

Spawn several in parallel — they run concurrently and steer results back independently as each finishes.

Panes are kept evenly sized: the extension re-applies an `even-horizontal` layout after every spawn and exit (debounced). The layout is a single constant, `SUBAGENT_TMUX_LAYOUT` in `pi-extension/subagents/tmux.ts` — change it to any named tmux layout (`main-vertical`, `tiled`, …).

If your shell startup is slow and launch commands get dropped before the prompt is ready, raise the delay:

```bash
export PI_SUBAGENT_SHELL_READY_DELAY_MS=2500   # default: 500
```

## Tools

| Tool | Description |
| --- | --- |
| `subagent` | Spawn a sub-agent on a dedicated surface — tmux pane where available, background process otherwise (async) |
| `subagent_message` | Message a sub-agent by name — steers it if running, resumes its session if finished |
| `subagent_status` | Inspect what running sub-agents are doing right now (live status + optional output tail) |
| `subagent_stop` | Stop (kill) one named sub-agent, or all of them |
| `subagents_list` | List available agent definitions |
| `ask_question` | *(sub-agent sessions only)* Ask the orchestrator a question and wait for the reply |

There is also a `/subagent <agent> <task>` command for spawning directly, and a
`/subagents` command (or **Ctrl+Alt+S**) to inspect and control running agents.

### Spawning

```typescript
subagent({ agent: "scout", task: "Analyze the auth module" });
subagent({ agent: "worker", name: "dark-mode", task: "Implement the dark mode toggle" });
```

| Parameter | Type | Default | Description |
| --------- | ---- | ------- | ----------- |
| `agent` | string | required | Which agent to spawn (must be known and permitted) |
| `task` | string | required | Task prompt |
| `name` | string | agent name | Display name for the pane and widget. Must be unique — duplicates are auto-suffixed (`scout`, `scout-2`, …) |
| `model` | string | agent's model | Override the model for this spawn |
| `cwd` | string | agent's `cwd` | Working directory (see [Role folders](#role-folders)) |

### Messaging

`subagent_message` is addressed **by name only**. Names are unique per session and persist after a sub-agent finishes, so the same name works either way:

```typescript
subagent_message({ name: "scout", message: "Also check the auth middleware" });
```

- **Running** — the message is typed into the live pane (newlines flattened) and picked up at the next turn boundary. The call returns immediately; the eventual completion still arrives as a steer message.
- **Finished** — the session is resumed with the message as the follow-up task, like a fresh spawn: fire-and-forget, always autonomous, result steered back later. The resumed run reclaims its original name.

Every spawn records name → session file in `artifacts/<sessionId>/subagent-registry.json`, so names stay addressable across pi restarts. A nested sub-agent that spawns children gets its own registry keyed by its own session id. Resume is refused with a clear error (listing known names) if the name isn't registered, the session file is gone, or the session predates sandboxed resume.

**Resume replays the original sandbox.** At spawn time the fully-resolved loadout — tool allowlist, backing extensions, model, thinking level, system prompt, spawn whitelist, cwd — is snapshotted to `<session>.loadout.json`. Resume rebuilds the exact same restricted process from that snapshot rather than relaunching unrestricted.

### ask_question

A sub-agent can ask its orchestrator a single freeform question when requirements are ambiguous or a decision materially affects the work. The session **stays open** (parked as `waiting`) instead of exiting; the parent is notified with the sub-agent's name, replies via `subagent_message({ name, message })`, and the reply arrives as the sub-agent's next turn. Parallel questions are supported — each waiting sub-agent has its own name.

If the reply arrives while the sub-agent is still mid-turn, it is absorbed into the current turn — either way the question is marked answered and the session exits normally when the work is done. If the parent never replies, the pane stays open until a human closes it. Only available inside sub-agent sessions.

### Controlling running sub-agents

You never have to guess what a sub-agent is doing, and you can always stop it:

- **Watch it.** The widget above the editor shows each agent's name, elapsed time, and live
  status — `active · bash 2m` (with the current tool), `waiting`, `starting`, or `stalled`.
  On tmux you can also read the pane directly; on the process backend the agent's output streams
  to its launch-script `.log`.
- **Ask the orchestrator.** "What is scout doing?" → the model calls `subagent_status`, which
  lists every running agent with its live status, and can include the tail of its output
  (`outputLines`).
- **Open the manager.** `/subagents` (or **Ctrl+Alt+S**) lists running agents; picking one lets you
  *View live output*, *Send a message*, or *Stop this sub-agent* (with confirmation).
- **Stop directly.** `/subagents stop <name>` stops one; `/subagents <name>` prints its status;
  the model can call `subagent_stop({ name })` or `subagent_stop({ all: true })` when you ask it to.

Stopping kills the surface immediately and reports a distinct **"stopped"** result (not a
completion), so neither you nor the orchestrator mistakes it for finished work. The session file is
kept, so a stopped agent can still be resumed later with `subagent_message`.

**Hung agents resolve on their own when their surface disappears.** If a tmux pane is killed
externally, or a background-process handle is released without an exit code, the watcher now
notices and reports a failure instead of polling forever. For genuinely stuck-but-alive agents you
can opt into an inactivity watchdog:

```bash
export PI_SUBAGENT_STALL_TIMEOUT_MS=600000   # auto-stop after 10m continuously stalled (default: off)
```

### Agent-to-agent communication

Communication is **hierarchical, not peer-to-peer** — there is no sibling-to-sibling or broadcast
channel:

- **Orchestrator → sub-agent:** `subagent_message({ name })` steers a running agent or resumes a
  finished one (delivered as a keystroke in tmux, or through a file inbox on the process backend).
- **Sub-agent → orchestrator:** `ask_question` (a single question; the agent parks as `waiting` for
  the reply) and its final assistant message, returned as the result.
- **Sub-agent → its own children:** an agent whose frontmatter grants `subagent_agents` (e.g.
  `worker`) can spawn and message those children by name, but only the agents on its allowlist.

Agents therefore cannot message their siblings, and nothing is shared between parallel agents except
through the orchestrator.

## Bundled agents

| Agent | Model | Tools | Role |
| ----- | ----- | ----- | ---- |
| **scout** | `openrouter/z-ai/glm-5.3` | `read`, `grep`, `find`, `ls` | Fast read-only codebase recon |
| **researcher** | `opencode-go/glm-5.3-flash` | `web_search`, `fetch_content`, `codemode` | Web research, synthesized into a sourced brief |
| **worker** | `opencode-go/muse-spark-1.3-contributor` | `read`, `write`, `edit`, `bash`, `powershell`, `web_search`, `fetch_content`, `codemode` + spawning | General implementer; may spawn `scout` and `researcher` |

All three are autonomous (`auto-exit: true`) and carry their identity in the system prompt (`system-prompt: append`).

## Custom agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). Discovery priority: **project > global > package-bundled** — a project-local file overrides a bundled agent with the same name.

```markdown
---
name: my-agent
description: Does something specific
model: openrouter/z-ai/glm-5.3
thinking: medium
tools: read, edit, write, safe_bash, web_search
session-mode: lineage-only
auto-exit: true
---

You are a specialized agent that does X...
```

### Frontmatter reference

| Field | Type | Description |
| ----- | ---- | ----------- |
| `name` | string | Agent name (used in `agent: "my-agent"`) |
| `description` | string | Shown in `subagents_list` |
| `model` | string | Default model |
| `thinking` | string | `minimal`, `low`, `medium`, or `high` |
| `tools` | string | Strict tool allowlist. Built-ins: `read`, `write`, `edit`, `bash`, `powershell`, `grep`, `find`, `ls`. Extension-backed: `web_search`, `fetch_content`, `get_search_content`, `source_check` (from the [`pi-web-access`](https://github.com/nicobailon/pi-web-access) package), and `safe_bash`. Only the extensions backing the listed tools are loaded into the child |
| `subagent_agents` | string | Comma-separated agent names this agent may spawn. **Presence of this field grants the spawning toolset** (`subagent`, `subagent_message`, `subagents_list`) and restricts spawn targets to the list. Omit it and the agent cannot spawn at all |
| `skills` | string | Comma-separated skill names to auto-load |
| `session-mode` | string | `standalone` (default), `lineage-only`, or `fork` — see below |
| `system-prompt` | string | `append` or `replace`: pass the body as the child's `--append-system-prompt` / `--system-prompt`. Omit and the body is prepended to the task prompt instead |
| `auto-exit` | boolean | Auto-shutdown when the agent finishes (see below) |
| `interactive` | boolean | Whether stall/recovery transitions wake the parent (see below) |
| `cwd` | string | Default working directory |
| `disable-model-invocation` | boolean | Hide from `subagents_list`; still spawnable by explicit name |
| `cli` | string | `claude` runs the agent via the Claude Code CLI instead of pi |

### session-mode

- `standalone` — fresh session, no lineage link to the caller (default)
- `lineage-only` — fresh session with `parentSession` linkage for discovery/fork UX, but no copied turns
- `fork` — child session seeded with the caller's conversation context

### auto-exit

With `auto-exit: true`, the session shuts down when the agent's turn ends — the agent just writes its final message and stops (there is no "done" tool). The last assistant message becomes the summary returned to the parent. Recommended for all autonomous agents.

Notes:

- **Manual input does not strand an auto-exit sub-agent.** If a human types into the pane, the session still closes once that turn completes normally — only an escape/abort leaves it open.
- **Auto-exit is suppressed while work is in flight:** the session parks as `waiting` instead of exiting when an `ask_question` is still unanswered, or when the agent's own child sub-agents are still running (a worker can stop after dispatching children and stays open until the last result returns).

### interactive

Controls whether `stalled`/`recovered` status transitions send a steer message to the parent session. Defaults to the inverse of `auto-exit`: autonomous agents get stall pings; user-driven agents stay quiet (the user is already working in that pane — the widget still updates). Set explicitly to override.

## Tool access control

Access is **whitelist-only**. Every sub-agent process is launched with `--no-extensions` (extension discovery disabled) and `--tools <allowlist>`; only the extensions backing the listed tools are loaded back in explicitly. There is no default toolset and no deny-list — an agent gets exactly what its frontmatter lists. The restriction survives resume via the loadout snapshot.

Spawns must name a known agent at **every** depth. A top-level session may spawn anything discoverable; a sub-agent may only spawn the agents in its `subagent_agents` list (enforced via `PI_SUBAGENT_ALLOWED`). There is no agentless spawn route, so a child can never escalate to a full-toolset profile by omitting its agent.

Extensions can register additional tools for sub-agents at runtime via `registerToolExtension(name, path)` on the `__pi_interactive_subagents` process global.

## Role folders

`cwd` starts a sub-agent in a directory with its own config, so role-specific setups (CLAUDE.md, skills, extensions) apply:

```
project/
└── agents/
    ├── game-designer/   ← CLAUDE.md, .pi/…
    └── sre/             ← CLAUDE.md, .pi/…
```

```typescript
subagent({ agent: "worker", cwd: "agents/sre", task: "Review the deployment pipeline" });
```

Set a per-agent default with `cwd:` in frontmatter.

## Status widget & configuration

The widget tracks each sub-agent from a runtime activity snapshot written by the child: `starting`, `active` (turn/provider/tool work), `waiting` (open for input or another stage), `stalled` (no valid snapshot for too long), or `running` (fallback). Sub-agent sessions also show their own tools widget — toggle it with `Ctrl+Alt+O`. Completion messages expand with `Ctrl+O`.

Status display is configured via `config.json` in the extension directory (copy `config.json.example`; it's gitignored):

```json
{
  "status": { "enabled": true }
}
```

## Requirements

- [pi](https://github.com/badlogic/pi-mono)
- [tmux](https://github.com/tmux/tmux) on macOS/Linux — or nothing extra on Windows

```bash
tmux new -A -s pi 'pi'
```

### Windows (no tmux needed)

On native Windows the extension uses a background-process backend automatically:
subagents spawn as detached processes (via Git Bash, the same bash pi itself
requires on Windows), completion is detected via files, and steering a running
subagent is delivered through a session inbox the child polls. No tmux install,
no WSL, no extra terminal setup.

Backend selection honors `PI_SUBAGENT_BACKEND=tmux|process` (default: tmux when
available, otherwise background processes). On the process backend, interactive
(non-`auto-exit`) agents are run to autonomous completion, since there is no
visible pane to drive or close — interaction still works via `ask_question`.

```powershell
# optional: pin a bash executable if it isn't on PATH
$env:PI_SUBAGENT_BASH = "C:\Program Files\Git\bin\bash.exe"
```

## Acknowledgements

Forked from [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents), which originated the subagent architecture, the multi-multiplexer surface layer, and the status widget; its supervision features were inspired by [RepoPrompt](https://repoprompt.com/).

## License

MIT
