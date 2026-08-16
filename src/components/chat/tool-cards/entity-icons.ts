/**
 * Entity-type → hugeicons glyph map for the chat tool-card previews.
 *
 * Mirrors the icons used by the canonical CRUD cards in
 * `src/components/worldbook/` (character/location/item/lore/event/novel share
 * the exact glyphs; chapter/scene/phase have no dedicated list-card icon so a
 * sensible representative glyph is chosen). Kept in a leaf module so both
 * {@link EntityPreview} and {@link ToolBody} import the same mapping.
 */

import {
  AlignLeftIcon,
  BookOpen01Icon,
  BookOpen02Icon,
  Calendar03Icon,
  Layers02Icon,
  MapPinIcon,
  NotebookIcon,
  Package02Icon,
  Time04Icon,
  UserMultiple02Icon,
} from "@hugeicons/core-free-icons";

import type { EntityType } from "../tool-summary";

/** The shared icon-object type across all hugeicons glyphs. */
type IconDef = typeof UserMultiple02Icon;

export const ENTITY_ICONS: Record<EntityType, IconDef> = {
  character: UserMultiple02Icon,
  location: MapPinIcon,
  item: Package02Icon,
  lore: BookOpen02Icon,
  event: Calendar03Icon,
  novel: BookOpen01Icon,
  chapter: Layers02Icon,
  scene: AlignLeftIcon,
  phase: Time04Icon,
  // Notes tree (ADR-0038): no CRUD card yet, so a representative glyph.
  note: NotebookIcon,
};
