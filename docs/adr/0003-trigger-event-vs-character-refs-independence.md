# Phase.trigger_event_id and Event.character_refs are semantically independent

The codebase maintains TWO separate relationships between Phases and Events:

1. **Causation** — `CharacterPhase.trigger_event_id` records the Event that CAUSED the Character to enter this Phase. A single optional link from a Phase to an Event.
2. **Participation** — `Event.character_refs` lists all Characters present at the Event, each pinned to the Phase they were in at the time. A collection of `(character_id, phase_id)` pairs.

These are deliberately NOT connected by any DB constraint. A Phase may name a trigger Event whose `character_refs` do not include that Character (e.g. a remote assassination order triggering a Character's "vengeance" Phase — the Character was not physically present at the triggering Event). Conversely, an Event may record a Character's participation without that participation causing a Phase transition (e.g. a passerby at a battle who is unchanged by it).

Rejected alternative: enforce consistency via DB CHECK constraints or application-layer validation requiring trigger_event_id to appear in the corresponding Event's character_refs. This would block the legitimate "remote trigger" narrative pattern and complicate the data model without adding real value — the two relationships express different domain concepts (causation vs participation) that happen to share entity types.
