# ADR-0042: Shell tool consent becomes a config-gated opt-in with auto-execution

**Status**: accepted. Supersedes [ADR-0041](./0041-agent-shell-execution-tool.md) §2 (the `consentLevel: "always"` decision) only. Every other ADR-0041 decision (execution layer, abort plumbing, timeout/output caps, IPC contract, logging) is unchanged.

## Context

ADR-0041 shipped the shell tool with `consentLevel: "always"`: every call stops at the ADR-0025 approval gate, and the user must click through a banner showing the raw command string. The intent was maximum caution. Per-call consent cannot be softened by `autoExecuteDangerousTools`, and the banner gives the user a final look at exactly what will run.

Two considerations break that position:

1. **The real threat is prompt injection, and a banner does not stop it.** The agents read worldbuilding and novel text: Character descriptions, Scene prose, imported Lore. That text can steer the model into requesting destructive commands, complete with plausible-sounding justifications. When an attacker controls what the model reads, per-call consent degrades into the user rubber-stamping a command the model has already been manipulated into wanting. Long sessions make it worse: most shell calls are legitimate, so the odd malicious one hides inside approval fatigue.
2. **The decision that matters is standing policy, not per-call judgment.** Whether this Space's agent should be able to run commands at all is a question about the user's machine, answered once with full context. Whether command number 47 "looks fine" is a question the user is poorly positioned to answer and will answer reflexively.

So the control moves up a level: an explicit, default-off, risk-acknowledged opt-in on the AgentConfig, replacing per-call consent.

## Decision

### 1. New per-AgentConfig flag `shellToolEnabled`

A boolean on AgentConfig, persisted Space-scoped in `space.db` (ADR-0012): new column `shell_tool_enabled INTEGER NOT NULL DEFAULT 0` on `agent_configs`, so existing Spaces migrate to OFF. Flipped via a dedicated `update_agent_config_shell_tool` command (single-flag, so enabling the shell never round-trips the rest of the config through the full-replacement update path). On the TS side the flag threads into the `ToolContext` alongside `autoExecuteDangerousTools`, and both role tool registrations (explorer and writer) consult it.

### 2. OFF: not registered at all

When the flag is off, the shell tool is absent from the tool set. The model never sees it: there is no banner to rubber-stamp, and no tool name for injected text to even refer to. Absence at registration time is a strictly stronger guarantee than any runtime consent level.

### 3. ON: registered with `consentLevel: "auto"`

When the flag is on, the shell tool registers with `consentLevel: "auto"` and executes without any approval prompt. This explicitly overrides ADR-0041 §2. Registration covers both the **explorer** and **writer** roles, each gated by its own AgentConfig's flag; the namer role never carries the tool. (ADR-0041 scoped v1 registration to explorer only, least privilege; extending it to the writer is exactly the one-line-per-builder spread ADR-0041 anticipated.)

(The `ConsentLevel` glossary associates `auto` with read-only tools. Here it is used in its mechanical sense only: no gate. The real gate has moved to registration time.)

### 4. UI: toggle plus risk-acknowledgment dialog

The toggle lives in the AgentConfig settings dialog, on the Explorer and Writer configs (hidden for the namer). Turning it ON requires confirming a risk-warning dialog that states plainly:

- **Prompt injection**: the worldbuilding and novel text the agent reads can manipulate it into running commands you did not intend.
- **Full user privilege**: commands run with your OS user's rights. The timeout and output caps bound duration and noise, not damage.
- **World isolation escape**: per ADR-0004, a command can touch anything you can, inside or outside the Space directory.

### 5. Why auto-execute once enabled (no half-gate)

An enabled-but-still-prompting design would recreate the rubber-stamp problem while adding back the friction: the same user who just acknowledged the risk would re-approve every call. Per-call consent adds no security value above the acknowledgment already given at enable time. What remains after enable, all unchanged from ADR-0041:

- **Hard timeout**: 120s default, 600s max; `timeoutMs` is clamped on both sides, Rust enforces independently.
- **Output truncation**: 30,000 chars, head+tail with elision marker; pre-truncation length reported to the model.
- **Kill path**: the user's Stop button aborts the run and fires `shell_kill(runId)`.
- **Execution logging**: full metadata (`run_id`, `space_id`, `exit_code`, `timed_out`, `killed`, `duration_ms`, `truncated`) at INFO; command output is never logged.

## Consequences

**Positive:** the strongest default available (the tool is invisible to the model unless explicitly armed); zero per-call friction for users who opt in; the risk conversation happens once, in a dialog that can actually explain the threat model, instead of per call in a banner that cannot.

**Negative / accepted risks:** once enabled, nothing per-call stands between an injected command and execution. Defense rests on the timeout, output caps, kill path, and the user watching the run. The flag is a standing decision made by the same fallible human the banner was aimed at.

**Inert, not removed:** the consent banner's shell-specific rendering becomes an inert path (a `consentLevel: "auto"` tool never triggers the ADR-0025 gate). It is kept rather than deleted, minimal diff; it would come back to life if the consent level is ever revisited.

**Lifecycle:** Agent construction is cached per conversation (ADR-0024), so toggling the flag takes effect for new conversations and reopened Space windows. Same lifecycle as `autoExecuteDangerousTools`.

**Unchanged:** ADR-0041's execution layer (`deno_task_shell`, one-shot sessions, env inheritance), abort plumbing (`ToolCallOptions`), timeout and output caps, frozen IPC contract, and logging. Only the §2 consent decision is superseded.

## References

- ADR-0041 (shell execution tool; §2 superseded by this ADR, the rest unchanged), ADR-0025 (execute-blocking consent gate, no longer triggered once the tool is enabled), ADR-0012 (Space-scoped AI configuration, where the flag persists), ADR-0004 (World isolation, which the shell tool deliberately escapes).
