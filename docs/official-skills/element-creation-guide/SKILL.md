---
name: element-creation-guide
description: "Worldbook element authoring standards for creating or updating characters (with phases), locations, items, lore, and events. Every field is written as a standalone reference entry for future readers — aliases as in-story forms of address, the base/phase description boundary, phase appearance as a pure period portrait, phase description as a distilled persona of standing states, conversation style anchored by characteristic utterances, phase creation criteria, and trigger events; plus moderate tags and notes writable only on the author's explicit request. Activate this skill before writing or rewriting any worldbook entity field content."
---

# Element Authoring Guide

When creating or updating worldbook entities (character, location, item, lore, event), write every field to the standards below. The rules govern both creation and updates: when updating, treat the entity's current values as the baseline — change only the fields the task involves and pass the rest back unchanged (updates are full replacements, not diffs).

## Two principles for every field

**1. Fields are standalone reference entries.** Whatever you write is stored in the worldbook and read later — by the author browsing their world, and by agents on later tasks who can see the entity but never the source material or the conversation that produced it. Each field must therefore make complete sense on its own, like a page in a reference work about this world. Write for that future reader.

**2. The worldbook records what is true; the novel records what happens.** Source material shows things happening; your job is to record what those happenings leave true about the entity. Distill scenes into standing facts:

- A feat performed in a scene → an ability the character has.
- An ordeal endured → the mark it left on body, mind, or circumstances.
- A relationship played out through interaction → the standing relationship and its texture.

The happenings themselves already have their homes — Events record plot occurrences, Scenes carry the prose — so your fields complement them with the resulting state of the entity.

Observations about your source material — what it covers, what it leaves blank, where information is thin — and proposals for follow-up work (related entities worth creating next, settings the author may want to treat as fixed canon) are useful to the author: deliver them in your final report, where they answer the current task. Task-level information lives in the report and nowhere else; entity fields store worldbook content only.

## Authoring workflow

1. **Extract.** From the brief and its source material, gather the stable facts about the entity itself — its identity, nature, relations, and state in the relevant period.
2. **Distill.** Convert happenings into standing truths, as above. Ask what the material establishes as true of the entity, and record that.
3. **Write.** Compose each field as a complete, self-sufficient entry in your own words, at the quality of a well-kept reference work: faithful to the material, readable on its own. Cover what the material establishes — when it establishes little, a short entry is the faithful one, and the gaps go in your report.
4. **Check.** Reread each field as a future reader who has never seen the brief. Every sentence must carry its meaning without the brief at hand; anything that leans on it gets rewritten into a standing statement.

## General field rules (all element types)

### tags — moderate and precise

- Use only words directly related to the element itself, serving retrieval and categorization.
- Moderate and precise, typically 2–5: no synonym piling, no vague filler.

### notes — the author's private field, written only on request

- notes is the author's own scratch space on an entity — their remarks, their reminders to themselves. The author decides what goes there.
- Write into notes only when the brief explicitly asks for notes content; a brief that never mentions notes yields an entity with empty notes. Everything you might want to persist for the author's attention — reminders, follow-up work, to-create lists, canon-preservation warnings — goes into your final report instead, where the author reads it and decides what to do with it.
- When updating an existing entity, preserve its current notes unless the task explicitly asks to change them.

### description — plain text, focused on the element itself

- Focus on the element itself. Adjacent material has its own home: the plot events that occurred at a location belong to Events; the scenes set there belong to the novel.
- Plain text only: no markdown syntax whatsoever — no headings, bold, list markers, or code blocks.
- Use real line breaks; never write literal backslash-n characters into the text.
- Moderate and precise: write until the information suffices, no padding.
- When content spans multiple layers, describe it in paragraphs separated by blank lines.

## Characters and Phases

### Character.aliases — forms of address

- aliases collects the other names this character answers to in the story: nicknames, titles, honorifics, epithets, codenames — words another character, or the narration itself, would use to refer to them.
- Each alias is a name: a short term of address, exactly as the material spells it. The test: it works as something this character could be called — and searched for — by.
- The field is optional and often empty — a character known by a single name simply has no aliases, and an empty list is the correct answer there.

### Character.description — the cross-phase identity

- Write the character's stable core: who they are (identity, origin, station, affiliations), their essential nature, and the permanent relationships that define them (mentor, family, liege, nemesis).
- Aim for the effect of this character's page in a reference work: a reader who knows nothing else finishes it understanding who this person fundamentally is.
- Anything that varies by period — looks, state, abilities, circumstances — belongs to the phase covering that period, recorded once there.

### Phase creation — only on major transformation

- Create a new phase only when the character undergoes a major qualitative change: a turning point that reshapes identity, core values, or behavioral patterns (e.g., a devastating loss, a betrayal that reverses loyalties, a fundamental change of ability, station, or worldview).
- Ordinary growth, mood shifts, or changed circumstances stay within the current phase — if the character would still read as essentially the same persona in dialogue and behavior, update the current phase's fields in place.
- The test: "Would this character, at this point in the story, speak and act as a noticeably different persona?" If not, do not create a phase.

### Phase.appearance — the portrait of this period

- Describe what the character physically looks like during this phase, as a brief an illustrator could work from: build, face, hair, eyes, skin, bearing, age impression, clothing, adornments, distinguishing marks.
- Present this period's look fully and on its own terms. Phases are read independently — an event or scene references the character at one specific phase — so each portrait is complete within itself, in this period's own right.

### Phase.description — the persona of this period

- Describe the character as they exist during this phase, treating the phase as a standalone persona: station and role in life, temperament and personality, abilities and skills, standing relationships and their texture, way of living and circumstances.
- Write states as standing truths, in your own words — composed so a reader could portray this persona or check a draft against it without any other material at hand.
- Scene-level action (who did what, where, in which chapter) already lives in Events and Scene prose; this field holds the person those scenes add up to.

### Phase.conversationStyle — the voice of this period

- Capture how the character speaks in this phase, so a writer could draft new dialogue in this voice. Cover the variations that matter: tone and register by audience (elders, intimates, strangers) and by situation (courtesy, teasing, anger, refusal, distress), plus signature habits — sentence length, word choice, accent, verbal tics, pet phrases.
- Anchor each variation with the words themselves: one or two representative utterances in quotation marks — quoted from the source material when such lines exist, otherwise composed in the character's voice. A writer imitates a line far more faithfully than an adjective; description and utterance together are what make the voice reusable.

### Phase.triggerEventId — trigger event

- Semantics: the event that caused the character's transition into this phase.
- Optional, not required: set it only when the plot structure has a clear branch point or turning point; leave it unset for the initial phase.
- When set, it must reference an existing event's id — confirm with list_ / search_ first; never invent an id.
