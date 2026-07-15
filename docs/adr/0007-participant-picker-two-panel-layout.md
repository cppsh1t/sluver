# Participant picker uses two-panel layout (character grid + phase list)

When adding participants (CharacterRefs) to an Event, the user must select **both** a Character and a specific Phase of that Character — a `CharacterRef` is a composite `{ characterId, phaseId }` pair (ADR-0002). The previous UI was a narrow (`w-80`) popover with a sequential two-step flow: pick character → pick phase → close → reopen for the next participant.

The participant picker is now a **two-panel dialog**:

- **Left panel**: searchable grid of `CharacterCard` instances in `focused` mode. Clicking a card focuses that character (populates the right panel); the card is **not** toggle-selected — the selection unit is the `{ character, phase }` pair, not the character alone.
- **Right panel**: the focused character's phase list. Each row shows the phase name (bold), appearance (`line-clamp-2`), and changes (`line-clamp-2`) — enough detail to distinguish phases. Already-selected pairs show a checkmark. Multi-select; selections persist across character switches.
- **Footer**: `"Add N participants"` button commits all new selections in a single full-replacement mutation (one `update_event` call), replacing the previous pattern of N separate mutations for N adds.

## Why two-panel over the alternatives

- **A. Inline phase chips on each character card** — rejected. Phase names compete for horizontal space with character identity info (name, aliases, tags). Characters with many phases overflow the card width, and the phase-event association is hard to scan when phases are compressed into chips.
- **B. Expand-on-click (inline)** — rejected. Grid reflow when a card expands disrupts spatial memory; the user loses track of where other characters are after an expansion.
- **C. Two-panel (chosen)** — the right panel has room for phase details (appearance, changes) that are essential for distinguishing phases. The left grid stays stable while browsing phases. This is the same mental model as a master-detail browser.

The other entity pickers (Location, trigger Event) are single-select with no sub-selection — they use a simpler single-panel card grid in the same dialog shell.

## Consequences

- The participant picker dialog is wider (`max-w-4xl`) than single-panel pickers (`max-w-2xl`).
- Batch commit reduces mutation churn: N participant adds = 1 mutation instead of N.
- `CharacterCard` gains a `focused` visual state (ring, no checkmark) distinct from `selected` (ring + checkmark), because in the participant grid the character is being browsed, not selected.
- Selected participants on the Event detail page are rendered as `ParticipantCard` — a composite card showing the Phase (primary) with its parent Character as context, not as a `CharacterCard` with a highlighted stepper step.
