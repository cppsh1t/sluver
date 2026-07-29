# Chat conversations are World-scoped (persisted in world.db)

**Status**: accepted.

AI conversation history — the persisted multi-turn chats a user has with the Explorer/Writer agents — lives in each World's own SQLite file (`worlds/{id}.db`), not in the Space-level `space.db`. This mirrors how every other World-scoped entity (Characters, Events, Scenes, …) is persisted per ADR-0001 / ADR-0004: tables in world.db carry no `world_id` column, and World isolation is physical (a chat about World A's worldbook is structurally invisible to World B, even within the same Space).

The decisive split is between *configuration* and *content*. AI configuration (provider credentials, AgentConfig model bindings) is Space-scoped in `space.db` (ADR-0012) because it is shared across Worlds. Conversation *content* is World-scoped because every chat is fundamentally about one World — the World-level chat in the left nav, and the future per-chapter chat (a chapter belongs to a novel belongs to a world). Placing content in `space.db` would require a `world_id` column plus a world-isolation filter on every query, which is precisely the anti-pattern ADR-0001 eliminated. The `SessionRecord.meta` opaque field carries the within-world context handle: `{ kind: "world" }` for the World-level chat, `{ kind: "chapter", chapterId }` for the future per-chapter chat — the chapter FK never crosses a DB boundary.

Tradeoffs:

- The rejected alternative was persisting conversations in `space.db` (superficially "consistent" with ADR-0012). That conflates configuration sharing with content isolation, and would require a `world_id` column + world filter on every conversation query — the exact pattern ADR-0001 removed. It would also need a Space-level assistant (not tied to any World) to justify the design, which is not a current requirement.
- The two conversation tables are duplicated into every world.db file. This is already true for all World-scoped tables and is the established cost of physical World isolation, not a new one.
- The pure Agent runtime library (ADR-0019) is unaware of this decision — it talks to an opaque `SessionStore`. The World-scoped `SessionStore` concrete implementation is an app-layer concern, constructed with the current World's DB connection.
