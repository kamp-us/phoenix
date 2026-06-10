/**
 * fate source entries — the features' `Fate.source` entries, composed for the
 * fate-effect server config.
 *
 * fate is pure transport (ADR 0016): it never queries D1. Per-feature sources
 * live in their owning feature (`features/<feature>/sources.ts`); this file
 * composes them into the ARRAY form `FateServer.config` takes. The compile
 * step (`FateExecutor`, `.patterns/fate-effect-compiler.md`) builds fate's
 * `{getSource, registry}` from these entries: one registry Map keyed by each
 * entry's `definition` OBJECT (fate looks executors up by identity, so the
 * entries hold the features' exported definition objects, never copies), and
 * `getSource` resolving a view to the same keyed object by `typeName`.
 *
 * Every feature is migrated (`.patterns/fate-effect-sources.md`), so every
 * entry is a `Fate.source` value — except `Contribution`, the hand-built
 * capability-less `AnyFateSourceEntry` (the entity is view-reachable through
 * `Profile.contributions` but has no fetch path by design — see
 * `features/pasaport/sources.ts`).
 *
 * Sources carry **no** `connection` executor or `orderBy` contract: every
 * connection — root *and* nested — is delivered by a custom resolver in
 * `queries.ts` / `lists.ts` calling the service keyset method directly
 * (ADR 0019). The keyset `ORDER BY` lives in the service; the view
 * `list(view, {orderBy})` mirrors it. See `.patterns/fate-connections.md` and
 * `.patterns/fate-sources.md`.
 */
import {commentSource, postSource, tagSource} from "../pano/sources.ts";
import {contributionSource, profileSource, userSource} from "../pasaport/sources.ts";
import {definitionSource, termSource} from "../sozluk/sources.ts";

/**
 * The composed source entries, in the registry order the bridge's hand-built
 * Map used.
 */
export const sources = [
	userSource,
	definitionSource,
	termSource,
	postSource,
	commentSource,
	tagSource,
	profileSource,
	contributionSource,
] as const;
