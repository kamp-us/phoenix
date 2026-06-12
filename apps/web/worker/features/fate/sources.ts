/**
 * fate source entries — the features' `Fate.source` entries, composed for the
 * fate-effect server config.
 *
 * fate is pure transport (ADR 0016): it never queries D1. Per-feature sources
 * live in their owning feature (`features/<feature>/sources.ts`); this file
 * composes them into the ARRAY form `FateServer.config` takes. The serving
 * path (the interpreter's walk, `.patterns/fate-effect-interpreter.md`)
 * resolves byId loads from these entries directly by `typeName`; the oracle
 * baseline (`compileFateSources`, `.patterns/fate-effect-compiler.md`) builds
 * fate's `{getSource, registry}` from the same entries: one registry Map keyed
 * by each entry's `definition` OBJECT (fate looks executors up by identity, so
 * the entries hold the features' exported definition objects, never copies).
 *
 * Every feature is migrated (`.patterns/fate-effect-sources.md`), so every
 * entry is a `Fate.source` value — except `Contribution`, the capability-less
 * `Fate.syntheticSource` entry (the entity is view-reachable through
 * `Profile.contributions` but has no fetch path by design — see
 * `features/pasaport/sources.ts`).
 *
 * Sources carry **no** `connection` executor or `orderBy` contract: every
 * connection — root *and* nested — is delivered by a custom resolver in
 * `queries.ts` / `lists.ts` calling the service keyset method directly
 * (ADR 0019). The keyset `ORDER BY` lives in the service; the view
 * `list(view, {orderBy})` mirrors it. See `.patterns/fate-connections.md` and
 * `.patterns/fate-effect-sources.md`.
 */
import {commentSource, postSource, tagSource} from "../pano/sources.ts";
import {contributionSource, profileSource, userSource} from "../pasaport/sources.ts";
import {definitionSource, termSource} from "../sozluk/sources.ts";

/** The composed source entries (registry order preserved from the original wiring). */
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
