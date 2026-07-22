# AI provider configuration is Space-scoped, not global

A Space's AI provider credentials (API keys) and Agent model preferences live in that Space's `space.db` (per ADR-0007 tier 2), in dedicated `provider_credentials` and `agents` tables. They are NOT global `Settings`.

This diverges from an earlier plan recorded in `src/types/setting.ts` (v0.1.0 prototype comment): "model config (provider / modelName / apiKey / baseUrl) will migrate from `.env` to Setting later." We deliberately chose per-Space scope instead, for three reasons:

1. **Isolation** — a Space is the outer isolation boundary (CONTEXT.md); a Space's API keys must never be visible to another Space, and routing them through the global `settings` KV in `meta.db` would violate the two-tier isolation invariant. Per ADR-0007, anything that must not cross Space boundaries lives inside `space.db`.
2. **Multi-context use** — a user may keep one Space for personal writing (personal OpenAI key) and another for a paid collaboration (shared Anthropic key); per-Space scope makes this natural and avoids a "which Space pays for which key" coupling.
3. **Deletion hygiene** — deleting a Space cascades to its `spaces/{id}/` directory (per the delete cascade in `commands::space::do_delete_space`), which includes its `space.db`. Credentials vanish cleanly with the Space. A global table would require an explicit cleanup step on Space delete, which is easy to forget and a vector for orphaned secrets.

The cost is UX: a user with N Spaces must enter the same provider key N times. For a single-user novel-writing app where most users have one or two Spaces, this is acceptable. If multi-Space churn becomes a real pain, a "copy credentials from another Space" affordance is an additive UI feature, not a schema migration.
