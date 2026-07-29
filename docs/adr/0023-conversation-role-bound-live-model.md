# Conversation is role-bound; model resolved live from AgentConfig

**Status**: accepted.

A Conversation is bound to exactly one AgentConfig (Explorer or Writer) for its entire lifetime. The `conversations` table carries an immutable `agent_config_name` column (value `"explorer"` or `"writer"`), set at creation and never updated. Switching role in the UI is an act of *starting a new Conversation* — it never mutates an existing one. This keeps each conversation's system prompt and tool set coherent end-to-end (Explorer and Writer carry different behavior bundles), and matches the convention of mainstream AI chat tools where a thread is bound to one assistant.

The model itself is **not** stored on the Conversation. It is resolved live at run time from the bound AgentConfig via `useResolvedModelConfig(spaceId, agentConfigName)` → `createLanguageModel`, both already built (ADR-0012). A Conversation therefore references a *role*, not a model snapshot: if the user later changes the Explorer model in Settings, subsequent turns of existing Explorer conversations automatically use the new model. The per-role *behavior* (system prompt, tools, maxSteps, sampling) is hardcoded in v1 as a code map keyed by `agentConfigName` — consistent with the existing AgentConfig design, which persists only the model binding while behavior lives in `AgentLoopOptions`.

Tradeoffs:

- The rejected alternative was allowing mid-conversation role switching. That would change the system prompt and tool set mid-thread, producing incoherent model behavior and a history generated under inconsistent assumptions. It would also force per-message role tracking in the schema.
- The rejected alternative was pinning a `model_id` snapshot on each Conversation. That would prevent users from benefiting from model upgrades on existing conversations and duplicate data already owned by AgentConfig. The live-resolution choice means a conversation's history may span a model change if the user upgrades mid-life; this is judged desirable (auto-upgrade) rather than a defect.
- Storing `agent_config_name` (not `agent_config_id`) is a deliberate cross-DB reference: the Conversation lives in `world.db`, the AgentConfig in `space.db` (ADR-0007). Names are stable, unique-seeded (`"explorer"`/`"writer"`), and not real foreign keys — a loose string reference, consistent with how the frontend already looks configs up by name.
