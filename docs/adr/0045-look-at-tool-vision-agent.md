# ADR-0045: `look_at` tool backed by a dedicated vision agent

**Status**: accepted.

## Context

Two blind spots follow from ADR-0044:

1. **Downgrade markers describe images the model cannot see.** When a conversation's bound model lacks image input (catalog-confirmed, ADR-0044 §7), every image attachment the user sends becomes a TextPart marker: `[image attachment: "sunset.png" — image content NOT delivered: the bound model does not accept image input]`. The model learns that *something* was attached, but cannot answer "what's in this mood board?" or "read the map I sent". The marker was designed as a forward contract: it deliberately carries the **filename** so a future tool could resolve it.
2. **`web_fetch` surfaces images as URLs, not pixels.** Its markdown body preserves inline `![alt](url)` entries and a `mainImage` field, exactly the harvest points for entity portraits or reference art. A text-only chat model can pass those URLs to `set_<entity>_image_from_url`, but it cannot *look* at them, so "does this portrait match the character's description?" is unanswerable.

The obvious fix, "bind a vision-capable chat model", is not a fix for everyone: text-only models are cheaper and often the deliberate daily driver, and vision ability should not force a model change (ADR-0023 keeps the chat model a live, per-conversation choice).

## Decision

### 1. A seeded non-conversational `vision` agent role

A fourth AgentConfig named `"vision"`, seeded exactly like `namer` (ADR-0040): `SPACE_MIGRATION_010` `INSERT OR IGNORE` for pre-existing Spaces (fixed UUID v7 literal; far-future `created_at` so `do_list_agent_configs`' `ORDER BY created_at` keeps the auxiliary role after the primary ones regardless of Space age), plus the same defaults in `do_create_space`'s seed loop (`model_id NULL`). Key properties, all inherited from the `namer` precedent:

- **Not a chat role.** Never added to `ROLE_BEHAVIOR`, never in the conversation role picker. It binds to no conversation and carries no behavior bundle.
- **Configured = enabled.** Its Settings card shows the model binding only (auto-execute, compaction, and system-prompt override are meaningless for a one-shot call and hidden for this role). `model_id NULL` means `look_at` is not registered at all, silently. Configuring a model is the opt-in gate; there is no separate enable flag.

### 2. The `look_at` tool

Registered on **both** `explorer` and `writer` roles (`snake_case` name, `consentLevel: "auto"`, matching `web_fetch`: read-only, no world mutation, cost accepted) — but only when the Space's `vision` AgentConfig has a resolvable model. Gating happens at **registration time**, so a cached conversation (ADR-0024) keeps its toolset snapshot until the conversation runtime is recreated; configuring or clearing the vision model takes effect on the next conversation (re)creation, the same lifecycle as skill enablement.

Inputs:

- `filename` — the exact filename from a downgrade marker, or the name under which the user attached an image. **The filename is the model-facing contract**: attachment ids are minted at dehydrate time and never reach the model (ADR-0044 §7), so filename is the only address the model can quote. Collisions (same filename attached more than once) resolve **newest-first**: the live thread is scanned from the end, so "the map I just sent" wins over last month's map with the same name.
- `url` — a direct image URL, e.g. harvested from `web_fetch`'s inline markdown or `mainImage`.
- Exactly one of `filename` / `url` (schema-enforced), plus an optional `question` focus so one image can be interrogated selectively across multiple calls.

### 3. Execution: one-shot `generateText` in a pure module (`src/lib/ai/look-at.ts`)

`namer`'s execution shape (ADR-0040), transplanted: a pure module calls `generateText` once — no tools, no `AgentLoop`, no session, no persistence. ADR-0019 purity holds: the module has no React, no IPC, no logger; the vision model is resolved live from the `vision` AgentConfig at call time (ADR-0023-style role-bound live resolution, injected from the provider layer), so changing the vision model takes effect on the next `look_at` call without restarting anything.

The image reaches the model as an AI SDK v7 `FilePart`, by one of two routes:

- **Attachment route (zero IPC):** a new `attachmentLookup` on `ToolContext` (the `threadLookup` precedent: a narrow pure interface, implemented in the conversation-runtime layer via the agentRef pattern) scans the live `Agent.messages` for user image FileParts matching `filename` newest-first. Those parts already hold hydrated data URLs (ADR-0044 §3: hydration at the session-store boundary), so the bytes are passed through as-is. No `list_message_attachments` / `get_message_attachment` round-trips — the runtime thread is by construction the freshest copy of what the user sent. This refines ADR-0044 §7's anticipation of an IPC-based lookup; the substrate commands remain for hydration and tests.
- **URL route (zero download):** the URL is passed through as the `FilePart` data string. Installed providers declare image URL support server-side via the LanguageModel spec's `supportedUrls` (`image/*` patterns for http(s)), so the provider fetches or forwards the URL natively; the client never downloads image bytes it cannot inspect anyway.

**Abort and failure split:** `ToolCallOptions.abortSignal` (ADR-0041 §3) threads into `generateText`. An aborted call re-throws — it is a run-level termination, and ADR-0018's run() resolve semantics apply upstream. Every *recoverable* failure (no matching filename in the thread, unresolvable vision config, provider error, non-image URL) is caught and returned as an error-shaped result the chat model can act on: report to the user, retry with the other input mode, or move on. A thrown tool error is reserved for denial and abort; the model should never see a crash for a bad filename.

### 4. Prompting: teach the marker → tool move

The teaching rides the same registration-time gate as the tool itself: at Agent construction, when `visionConfig` is bound, an `<image_access>` block is appended to the effective system prompt (after any user override, exactly like the `<available_skills>` catalog of ADR-0043 §3); when the Space has not opted in, the block is absent — the prompt never advertises a tool that cannot run. The block teaches the pairing: when you see an `[image attachment: …]` marker or an image URL and need to know what it shows, call `look_at`. Without the teaching, the marker is an apology, not an affordance; with it, the downgrade path (ADR-0044 §7) closes into a loop — the chat model stays cheap and text-only, the vision model is a per-call resource.

## Consequences

- **Positive:** text-model conversations become vision-*capable* without rebinding; both attachment markers and web URLs become addressable; the tool is absent (not disabled, absent) wherever the Space has not opted in, so prompts never advertise a tool that cannot run.
- **Cost:** every call spends tokens on the vision model, auto-consented like `web_fetch`. The cost control is structural: leave `vision` unconfigured and no call is possible.
- **Cache:** a conversation created before configuring `vision` keeps its registration snapshot until its runtime is recreated (ADR-0024 consistency); there is no eager toolset invalidation.
- **Filename ambiguity:** newest-first resolution is a heuristic, not a guarantee — two same-named images in one message resolve by part order. The marker carries no position, so the contract stops at filename; richer addressing would leak attachment ids to the model.
- **Vision model receives no conversation context** beyond the optional `question` and the image: descriptions are stateless and cheap, but the chat model must do any synthesis itself.

## References

- ADR-0044 (attachments, downgrade markers whose filename is the `look_at` contract), ADR-0040 (`namer`: the seeded non-conversational role, configured = enabled, one-shot `generateText` precedent), ADR-0019 (purity boundary the look-at module keeps), ADR-0023 (live model resolution from AgentConfig), ADR-0024 (conversation runtime cache, registration-snapshot lifecycle), ADR-0025 (consent gate, `auto` level), ADR-0041 §3 (`ToolCallOptions { abortSignal }`), ADR-0018 (abort resolves the run).
