# World isolation — no cross-World references at any layer

A World is a closed universe. There is no mechanism — at the schema, query, or UI layer — to reference an entity (Character, Location, Item, Lore, Event, Novel, Chapter, Scene) in one World from another World. Worlds that need to share content must duplicate it.

This is a deliberate scoping decision enabled by the two-database architecture (see ADR-0001), not a technical limitation to be worked around. It allows each World to be:

- Backed up or exported independently (one file per World)
- Reasoned about as a self-contained fictional universe
- Refactored (renamed, restructured) without cascading effects on other Worlds

Tradeoff: MCU-style "shared universe" crossovers where the same Character appears in multiple Worlds are not supported. Users wanting this must copy the Character into each World and accept that updates will not sync. If cross-World references become a real product requirement later, this decision would need to be revisited — likely via a new "shared entity" concept rather than relaxing the isolation.
