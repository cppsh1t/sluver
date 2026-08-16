# Sluver

A desktop worldbuilding & novel-writing application. A **Space** is the outer isolation boundary and may contain multiple **Worlds**; each World is a fully isolated fiction project whose Characters, Locations, Items, Lore, Events, and Novels never reference or appear in other Worlds, even within the same Space, and no data crosses between Spaces. Within a World, Novels contain Chapters and Scenes that reference back into the worldbuilding material.

## Language

### Container

**Space**:
The top-level container and outer isolation boundary. Owns its own World registry, an optional password, and a reserved `config` module for future Space-scoped settings (deliberately empty for now — distinct in nature from global `Settings`). Optionally password-protected: a protected Space's content is obscured behind an in-page authentication overlay until its password is verified — the tab stays open in a *locked* state (not a separate pre-entry gate). Re-authentication is required when the app returns from the system tray (see ADR-0008). Identity is by `id` (UUID v7); `name` is a display label unique across the Space registry. Multiple Spaces may be open simultaneously, each presented as a tab.
_Avoid_: Workspace, Vault, Account, Profile, Collection, Project

**World**:
A single fiction project contained within a Space — no longer the top-level boundary (that role belongs to Space). Holds all Characters, Locations, Items, Lore, Events, and Novels as a closed universe — nothing crosses between Worlds, even within the same Space. Identity is by `id` (UUID v7); `name` is a display label unique within its Space.
_Avoid_: Project, Universe, Campaign, Setting

### The Worldbook

**Worldbook**:
The complete body of worldbuilding material in a World — its Characters, Events, Locations, Items, and Lore. Everything the author defines as true about the world, as distinct from the Novels (prose) written from it. The conceptual boundary between "what exists in the world" and "what is narrated."
_Avoid_: Codex, Compendium, Encyclopedia, Wiki, Bestiary

**Character**:
A single individual in a World — typically a person, but also any autonomous being that participates in the plot (e.g. an active deity). The atomic unit of agency: only Characters can participate in Events and appear in Scenes. Has a lifecycle composed of **zero or more** Phases that mark distinct segments of their personal journey. A Character with zero Phases is a valid stub; because participation in Events and Scenes is pinned to a specific Phase (see CharacterRef), a zero-Phase Character cannot participate until at least one Phase is defined.
_Avoid_: NPC, Actor, Role, Person, Persona, Figure

**CharacterPhase** (canonical short form: **Phase**):
A segment of a Character's life defined by their emotional or circumstantial state. Each Phase has a short `name` — the label for this period (e.g. "Before the Fall", "In Exile") — plus its own `appearance` (physical description in this period), `description` (a free-form note of what defines this period), and `conversationStyle` (how the character speaks and behaves in dialogue during this period). MAY name a `triggerEventId` — the Event that caused the Character to enter this Phase.
_Avoid_: Stage, LifeStage, Version, Era, State, Milestone, Arc

**Event**:
Something that happens in a World — optionally over a time range (`startAt` / `endAt`), optionally at a Location. Has a participation set (`characterRefs`) listing the Characters involved, each pinned to the Phase they were in at the time.
_Avoid_: Incident, Occurrence, Action, Happening

**CharacterRef**:
An appearance of a Character at a specific Phase. The atomic unit of participation in an Event or Scene; always a pair `{ characterId, phaseId }` where the pair — not the `characterId` alone — is the identity. The same Character MAY appear multiple times in the same Event or Scene with different Phases (e.g. flashback, timeskip, parallel timelines); each pair is a distinct appearance, never a duplicate.
_Avoid_: CharacterLink, CharacterMention

**Location**:
A place within a World. Can anchor Events and Scenes to where they happen.
_Avoid_: Place, Setting, Scene, Area, Zone

**Item**:
A physical object within a World that can appear in Scenes.
_Avoid_: Object, Artifact, Thing, Prop, Relic

**Lore**:
Supplementary setting material within the Worldbook — history, culture, magic systems, cosmology, mythology, organizations, or any background knowledge the author wants to record. Never participates in story action and is not referenced by Events, but can be referenced by Scenes as background context. (An organization that needs to "act" in the story is modeled as individual Characters plus a Lore entry describing the org itself; purely mythological deities live here, active deities live as Characters.)
_Avoid_: Background, Wiki Entry, Encyclopedia Entry, Setting Note

### Novels

**Novel**:
A prose work within a World. An ordered collection of Chapters. Has a `title`, `description`, and `tags`.
_Avoid_: Book, Story, Manuscript

**Chapter**:
An ordered subdivision of a Novel. An ordered collection of Scenes. Has a `title` and `summary` — the chapter's outline or purpose, not the prose itself.
_Avoid_: Section, Part

**Scene**:
The leaf unit of prose in a Novel — the only entity that carries narrative text (`content`, plain text). Optionally anchored to a time range and a Location. References the Characters (at specific Phases), Items, and Events that appear in it, plus the Lore entries that provide its background context.
_Avoid_: Sequence, Beat, Moment, Setup, Fragment

### Notes

**Notes**:
The author's portable note system within a World — a tree-organized workspace of free-form markdown documents for outlines, foreshadowing, inspiration, and other working material that is neither worldbook truth nor novel prose. Distinct from the Worldbook (a note may record a rejected or superseded idea — notes are subjective, disposable working material, not "what is true in the world") and from Novels (notes are never narrative). Belongs wholly to its World and travels with it on export/import. The Agent must not touch Notes unprompted — note tools are used only on the user's explicit request.
_Avoid_: Memo, Wiki, Journal, Knowledge Base, Scratchpad

**Note**:
A single markdown document within Notes — the atomic unit of the note system. Carries a display label and markdown content. Lives in exactly one Folder or at the tree root. Identity is by `id` (UUID v7); the display label is unique among siblings.
_Avoid_: Document, Page, File, Entry

**Folder**:
A pure container node in the Notes tree — structure only, no content of its own. May contain Folders and Notes, nesting arbitrarily deep. Identity is by `id` (UUID v7); the display label is unique among siblings.
_Avoid_: Directory, Category, Group, Notebook

### Views

**Timeline**:
The derived, read-only chronological projection of a World's Events and Scenes — a view computed at render time, never persisted or authored. Only Events and Scenes (the entities carrying in-world time) appear as timeline content; Characters, Locations, Items, and Lore appear solely as context on those nodes (who participated, where it happened), never as standalone timeline items. Exposed to the UI as a **uniform character-swimlane grid** (one row per Character; entries as equal-width cards on a shared chronological-order axis — non-proportional, so a one-day event and a millennial span stay equally readable; multi-character events auto-align vertically across their participant lanes without connectors) and to the Agent as the `timeline_lookup` tool. Both surfaces show every Event and Scene at its own `startAt` — there is no visual absorption or deduplication; a Scene's narration of an Event is carried as an annotation, not by folding the Event into the Scene's node. See ADR-0034.
_Avoid_: Chronology, Story Arc, History, Annals

### World configuration

**World config**:
A World's own control surface — distinct from global `Settings` and from `Space config`. Lives in the `world_config` KV table inside that World's `world.db`, mirroring the `space_config` pattern one layer down. Currently holds only the `TimeMapper`; reserved for future World-scoped settings.
_Avoid_: World settings, World preferences

**TimeMapper**:
A per-World, user-authored JavaScript function that renders an ISO timestamp into a world-time display string — the bridge between the database's ISO storage and the World's fictional time. Pure output: maps ISO → string, never the reverse. Stored as JS source under `world_config.time_mapper`. When no mapper is saved, the **default template** applies (`YYYY-MM-DD HH:mm:ss`, host local time — the same seed shown in the mapper editor); saving custom code overrides it. When the mapper is broken (compile/runtime failure, or the 50ms worker watchdog fires) or the client is not yet bound to a World, times fall back to raw ISO.
_Avoid_: TimeFormatter, Calendar, Chronology, WorldClock, TimeSystem

### Application layer

**Setting** (plural: **Settings**):
Global application preferences that apply regardless of which Space is open: UI language (`locale`), color scheme (`theme`), and accent color (`color`). Live above the Space layer — they also govern the Space-select screen, the password gate, and the tray menu. Distinct from per-Space `config`.
_Avoid_: Config, Preferences, Options

**Space config**:
A Space's own control surface — its identity, access control, AI provider credentials, AgentConfig model preferences, and lifecycle management (rename, password, deletion) — as distinct from global `Settings`. The term `config` is reserved for this Space-level use; do not use it for global `Settings`.
_Avoid_: Space settings, Space preferences

**Agent**:
The stateful, consumer-facing AI conversational wrapper — the runtime that owns conversation memory, drives an `AgentLoop` per turn, and auto-persists message deltas via an injected `SessionStore`. One `Agent` instance is bound to one session for its lifetime (identity = `sessionId`). Constructed via the async factory `Agent.open({ loop, store, sessionId })`, which loads history from the store. Each `agent.run(text)` appends a user message, drives the loop, and persists the response delta. Stateless across sessions — switching conversations means constructing a new `Agent`.
_Avoid_: Assistant, Bot, Runner, Executor, Conversation, Chat

**AgentLoop**:
The pure stateless single-run tool-calling executor — a manually-driven step loop over the AI SDK v7 `streamText` (ADR-0017). Constructed from an `AgentLoopOptions` bag (model, system prompt, tools, step budget, sampling params). One `.run()` call = one complete tool-calling loop (possibly multi-step). No conversation memory — the caller supplies the full message thread each call and receives the accumulated result. The stateless primitive that `Agent` wraps; also usable standalone for one-shot execution (summarization, batch generation). All terminations resolve (ADR-0018, revised) — `handle.result` never rejects.
_Avoid_: Agent, Loop, Runner, StepDriver

**AgentConfig**:
A named AI configuration slot within a Space — the persistent definition of an AgentLoop's model and behavior. Carries the bound model (chosen from the Space's configured providers) and the `autoExecuteDangerousTools` flag (whether configurable-level tools auto-execute without user approval); the rest of the behavior bundle (system prompt, tools, parameters) is hardcoded in code via `AgentLoopOptions`. Two AgentConfigs are predefined per Space — **Explorer** and **Writer** — both seeded into `space.db` on Space creation; users pick a model for each but cannot create or delete AgentConfigs in v1.
_Avoid_: Assistant, Persona, Bot, Role

**ConsentLevel**:
The safety classification declared on each agent tool definition, governing whether the user must explicitly approve a tool call before it executes. Three levels: **auto** — read-only operations (list, get, count) execute without asking; **configurable** — create operations execute without asking only if the agent's `autoExecuteDangerousTools` flag is enabled, otherwise require approval; **always** — edit, delete, and reorder operations always require explicit approval regardless of configuration. Declared per-tool in the tool definition; not derivable from operation type alone.
_Avoid_: PermissionLevel, ApprovalLevel, TrustLevel, DangerLevel, RiskLevel

**Conversation**:
A persisted, World-scoped multi-turn chat history between the user and an Agent (bound to an AgentConfig). The user-facing, typed counterpart of the library's `SessionRecord` (ADR-0020) — the pure library is domain-agnostic and calls it a "Session"; the app layer wraps and types it as a Conversation. Contains an ordered list of **Messages**. World-scoped per ADR-0022 — a Conversation belongs to exactly one World and is physically invisible to other Worlds (it lives in that World's `world.db`). Conversations come in two scopes, distinguished by `meta.kind`: **World-level** (`kind: "world"`, listed in the World's Chat page) and **chapter-scoped** (`kind: "chapter"` with a `chapterId`, shown inside that chapter's editor). Both scopes are one-to-many — a World holds many World-level Conversations, and a Chapter holds many chapter-scoped Conversations. The UI feature label is "Chat" — "Chat" is a UI affordance over Conversations, not a domain term.
_Avoid_: Chat, Thread, Session, Dialogue

**Message**:
A single turn within a Conversation — the app-layer, typed counterpart of the library's `SessionMessage` (ADR-0020). Carries role (user / assistant / tool), content, identity (`id`), timestamp, and — for assistant messages — optional token-usage metadata recording what that turn cost (ADR-0030). The atomic unit of a Conversation's history.
_Avoid_: ChatMessage, StoredMessage, MessageRecord

**Plan**:
A persisted, Conversation-scoped working agenda authored by the Agent via the `plan` tool — an ordered TODO list that implicitly guides the Agent's subsequent turns within that Conversation. At most one **active Plan** per Conversation; calling the `plan` tool replaces the prior Plan wholesale (last-write-wins). Persistence is per-Conversation (lives in `conversations.meta.plan`); the Plan survives app restarts and Conversation switches. The Plan is **NOT** a Message — it is never appended to the persisted thread; instead it is re-injected into the Derived Model Input on every subsequent turn (see ADR-0028). Each Plan item carries a status of `pending` (not yet started), `in_progress` (an item the Agent has started but not yet finished), or `done` (completed).
_Avoid_: TodoList, Scratchpad, Agenda, Outline, Checklist

**Grep**:
The Agent's single match-centric retrieval tool — searches a substring query across all author-written text fields of the 8 entity types (including CharacterPhase fields) and returns Match Groups as occurrence evidence, optionally narrowed to selected entity types. Distinct from the per-entity `search_*` tools, which are entity discovery returning entity summaries: grep answers "where does this text occur?", not "which entities match?". Read-only (consent auto); available to both Explorer and Writer. Matching is case-insensitive for ASCII only, mirroring the search_* behavior. (See ADR-0035.)
_Avoid_: search_all, find_mentions, global_search

**Match Group**:
The unit of grep results — all occurrences of the query within one (entity, field) pair, carrying the occurrence count, a small number of Snippets, and redundant entity identity (title or name; the owning character's id and name for phase hits) so the model can act without a follow-up get_* call. Groups are served 50 per page (a truncated flag reports further pages; the model walks a stable offset across the deterministic ordering) and ordered by occurrence count descending with a deterministic tie-break. Phase hits are their own entity type whose id is directly usable against the entity's own fields.
_Avoid_: Hit, Match, Result, Entry

**Snippet**:
Three-part occurrence evidence inside a Match Group — the text before, the matched text itself, and the text after, each side truncated to a short fixed length. No marker glyphs; the parts are structured fields, not a concatenated string, so characters that occur in prose can never be mistaken for delimiters.
_Avoid_: Fragment, Excerpt, Quote

**Launcher**:
The app's anchor window outside any Space — the OS window whose label is the statically configured `"main"` (`tauri.conf.json`), rendering the Space picker / landing UI where Spaces are selected and created. Distinct from Space windows in two ways: it hides to tray on close (keeping the process alive) rather than being destroyed, and closing all Space windows does NOT auto-show it — the user returns to it via the tray menu or by relaunching the app (which auto-reopens `lastOpenedSpaceId`). Identity is its fixed label `"main"` (single instance).
_Avoid_: Dashboard, Home, Welcome screen, Hub, Shell

### AI Runtime

**SessionMessage**:
A persisted conversation message — a `ModelMessage` enriched with identity (`id`, UUID v7), session binding (`sessionId`), and timestamp (`createdAt`). The atomic unit of conversation history. The session layer converts freely between `SessionMessage` (persisted, UI-ready) and `ModelMessage` (SDK-internal) by adding or stripping the three metadata fields.
_Avoid_: ChatMessage, StoredMessage, MessageRecord

### Message layers

**Persisted Thread**:
The append-only, never-transformed conversation history owned by an Agent — the single source of truth for what was actually said in a Conversation. Physically `Agent.messages: SessionMessage[]`, mirrored row-for-row in the `messages` table. The user-visible message list renders this layer verbatim; the model NEVER sees it directly. (See ADR-0028.)
_Avoid_: Source Thread, Conversation Thread, Message History

**Derived Model Input**:
The `ModelMessage[]` array actually passed to `AgentLoop.run` on each turn — a pure function of the Persisted Thread, recomputed from scratch every run. Composed by the derivation pipeline (Plan reminder injection, tool-call compaction). Never persisted. Never shown to the user. (See ADR-0028.)
_Avoid_: Live Input, Effective Messages, Model Context

**Run Delta**:
The `responseMessages` slice returned by `AgentLoop` at run resolution — the model's new contributions for this turn. Appended verbatim to the Persisted Thread (no reverse-transform). Carries text, reasoning, tool-call, and tool-result parts exactly as the model produced them. (See ADR-0028.)
_Avoid_: Response Delta, Turn Output

**Context Compaction** (informally: **Context mode**):
A per-role-configurable pipeline transform (ADR-0031) that replaces aged tool-call + tool-result pairs in the Derived Model Input with short **Stubs**, while leaving the Persisted Thread untouched. Fires at `Agent.run()` entry; a tool pair is compacted when its containing user-turn's age (0-indexed from the current turn) is at least the role's configured `turnAge` (default 3). The model can expand any Stub back to its original input and output via the `context_read` tool, which reads from the Persisted Thread through `ToolContext.threadLookup`. Per-role opt-in (lives on `AgentConfig.contextCompaction`); roles with short conversations (e.g. Explorer) typically disable it to preserve prompt cache hit rate. Distinct from the future **semantic compaction** (Phase 2, deferred) — semantic compaction requires an LLM call and therefore cannot be a Derived Input pipeline transform under ADR-0028 invariant 2.
_Avoid_: Summarization, Compression, Eviction, Pruning

**Stub**:
The short text replacement produced by **Context Compaction** for an aged tool-call + tool-result pair. Format: `[tool_call {toolCallId}] {toolName} → {status}` where status is `succeeded`, `failed`, or `denied` (the last from `ToolDeniedError` at the consent gate, ADR-0025). Lives only in the Derived Model Input — the Persisted Thread retains the original content verbatim. Self-contained (carries the `toolCallId` the model needs to call `context_read`), but does not embed the tool's arguments or output (pull-on-demand per Pi ch.8 §八.3, not push).
_Avoid_: Summary, Marker, Placeholder, Reference, Snippet

## Conventions

**Name uniqueness**: Within each scope, the `name` or `title` field is unique — `Space.name` across the Space registry; `World.name` within its Space; `Character.name`, `Location.name`, `Item.name`, `Lore.name`, `Event.name`, `Novel.title` within their World; `CharacterPhase.name` within their Character; `Chapter.title` within their Novel; `Scene.title` within their Chapter. Identity is always by `id` (UUID v7); the display label is scoped-unique.

**Isolation (two-tier)**: The app enforces isolation at two nested boundaries. (1) **Space isolation** — Spaces share no data at any layer (schema, query, UI); each Space's World registry, password, and config are invisible to other Spaces. (2) **World isolation** — within a Space, Worlds share no data; there is no cross-World reference at any layer. Worlds that need to share content must duplicate it; Spaces that need to share content must duplicate it.

**Position uniqueness**: Within each ordered collection, the `position` field is unique to its parent — `CharacterPhase.position` within their Character, `Chapter.position` within their Novel, `Scene.position` within their Chapter. Ordering is mutable via `reorder_*` commands.

**Time storage (ISO as truth source)**: `Event.startAt` / `Scene.startAt` are stored exclusively as ISO 8601 strings. World-specific time representations are a display-layer concern, rendered at read time by the World's `TimeMapper` (if configured) — they never participate in storage, input parsing, or the data model. Input remains ISO via the native `datetime-local` picker; the TimeMapper is strictly `(iso: string) => string`. When no mapper is configured or it fails, times display as raw ISO.
