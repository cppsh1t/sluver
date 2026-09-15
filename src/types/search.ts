import { z } from "zod";

/**
 * Search pagination — the shared page shape of the 8 entity-centric
 * `search_*` commands (characters, locations, items, lore, events,
 * novels, chapters, scenes).
 *
 * Each `search_*` command returns ONE PAGE of a deterministically
 * ordered result set — the same pagination semantics as `grep`
 * (ADR-0035 §5): deterministic ORDER BY name/title makes offset pages
 * stable, and the page size is fixed at 50. `truncated` is
 * `(offset + page_len) < totalCount`, so the model always knows whether
 * matches exist beyond the returned page (this fixes the earlier
 * silent-truncation defect where 50 rows arrived with no signal that
 * anything had been cut).
 */

/**
 * Schema factory — instantiate with an entity's summary schema to get
 * that entity's page schema, e.g.
 * `summaryPageSchema(characterSummarySchema)`.
 */
export const summaryPageSchema = <S extends z.ZodType>(resultSchema: S) =>
  z.object({
    /** One page of matching summaries, ordered by name/title — up to 50 entries. */
    results: z.array(resultSchema),
    /** FULL match count before pagination — may exceed `results.length`. */
    totalCount: z.number().int(),
    /**
     * `true` when more matches exist BEYOND this page
     * (`offset + results.length < totalCount`) — fetch the next page by
     * passing an increased `offset`.
     */
    truncated: z.boolean(),
  });

/**
 * One page of a paginated `search_*` result set, generic over the entity
 * summary type. Inferred from `summaryPageSchema` (single source of
 * truth, mirroring how `GrepResult` derives from `grepResultSchema`).
 */
export type SummaryPage<T> = z.infer<
  ReturnType<typeof summaryPageSchema<z.ZodType<T>>>
>;
