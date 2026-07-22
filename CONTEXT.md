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
A segment of a Character's life defined by their emotional or circumstantial state. Each Phase has a short `name` — the label for this period (e.g. "Before the Fall", "In Exile") — plus its own `appearance` (physical description in this period) and `changes` (a free-form note of what defines this period). MAY name a `triggerEventId` — the Event that caused the Character to enter this Phase.
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
Supplementary setting material within the Worldbook — history, culture, magic systems, cosmology, mythology, organizations, or any background knowledge the author wants to record. Standalone by design: never participates in Events or Scenes. (An organization that needs to "act" in the story is modeled as individual Characters plus a Lore entry describing the org itself; purely mythological deities live here, active deities live as Characters.)
_Avoid_: Background, Wiki Entry, Encyclopedia Entry, Setting Note

### Novels

**Novel**:
A prose work within a World. An ordered collection of Chapters. Has a `title`, `description`, and `tags`.
_Avoid_: Book, Story, Manuscript

**Chapter**:
An ordered subdivision of a Novel. An ordered collection of Scenes. Has a `title` and `summary` — the chapter's outline or purpose, not the prose itself.
_Avoid_: Section, Part

**Scene**:
The leaf unit of prose in a Novel — the only entity that carries narrative text (`content`, plain text). Optionally anchored to a time range and a Location. References the Characters (at specific Phases), Items, and Events that appear in it.
_Avoid_: Sequence, Beat, Moment, Setup, Fragment

### Application layer

**Setting** (plural: **Settings**):
Global application preferences that apply regardless of which Space is open: UI language (`locale`), color scheme (`theme`), and accent color (`color`). Live above the Space layer — they also govern the Space-select screen, the password gate, and the tray menu. Distinct from per-Space `config`.
_Avoid_: Config, Preferences, Options

**Space config**:
A Space's own control surface — its identity, access control, AI provider credentials, Agent model preferences, and lifecycle management (rename, password, deletion) — as distinct from global `Settings`. The term `config` is reserved for this Space-level use; do not use it for global `Settings`.
_Avoid_: Space settings, Space preferences

**Agent**:
A named AI configuration slot within a Space. Each Agent binds exactly one AI model chosen from the Space's configured providers; future versions will extend an Agent with behavior (system prompt, tools, parameters). Two Agents are predefined per Space — **Explorer** and **Writer** — both seeded into `space.db` on Space creation; users pick a model for each but cannot create or delete Agents in v1.
_Avoid_: Assistant, Persona, Bot, Role

**Launcher**:
The app's anchor window outside any Space — the OS window whose label is the statically configured `"main"` (`tauri.conf.json`), rendering the Space picker / landing UI where Spaces are selected and created. Distinct from Space windows in two ways: it hides to tray on close (keeping the process alive) rather than being destroyed, and closing all Space windows does NOT auto-show it — the user returns to it via the tray menu or by relaunching the app (which auto-reopens `lastOpenedSpaceId`). Identity is its fixed label `"main"` (single instance).
_Avoid_: Dashboard, Home, Welcome screen, Hub, Shell

## Conventions

**Name uniqueness**: Within each scope, the `name` or `title` field is unique — `Space.name` across the Space registry; `World.name` within its Space; `Character.name`, `Location.name`, `Item.name`, `Lore.name`, `Event.name`, `Novel.title` within their World; `CharacterPhase.name` within their Character; `Chapter.title` within their Novel; `Scene.title` within their Chapter. Identity is always by `id` (UUID v7); the display label is scoped-unique.

**Isolation (two-tier)**: The app enforces isolation at two nested boundaries. (1) **Space isolation** — Spaces share no data at any layer (schema, query, UI); each Space's World registry, password, and config are invisible to other Spaces. (2) **World isolation** — within a Space, Worlds share no data; there is no cross-World reference at any layer. Worlds that need to share content must duplicate it; Spaces that need to share content must duplicate it.

**Position uniqueness**: Within each ordered collection, the `position` field is unique to its parent — `CharacterPhase.position` within their Character, `Chapter.position` within their Novel, `Scene.position` within their Chapter. Ordering is mutable via `reorder_*` commands.
