/**
 * Report feature-boundary pins — `Report` is a shared low-level service over the
 * three content targets, so it sits below the feature directories and must import
 * none of them. Unlike `Vote`, it owns no inverted contract (no `KarmaBump`), so
 * `ReportLive` requires exactly the `Drizzle` seam. The type-level pin enforces
 * that boundary by asserting what `ReportLive` REQUIRES (its `R` channel) — the
 * service's actual requirement, refactor-proof: a sibling-feature import that
 * widened `R` would fail the pin.
 *
 * The pin scopes to the SERVICE (`Report.ts`); the wire/gate layer
 * (`mutations.ts`, `lists.ts`, `Moderator.ts`, `views.ts`, `fate-module.ts`)
 * composes OVER the features by design and is not part of `ReportLive`'s `R` —
 * the `report.submit`/`report.resolve` resolvers translate the service's
 * `ReportTargetNotFound` into the per-feature not-found errors and dispatch
 * act-on-target to the sibling content services, `Moderator.ts` reads the
 * caller's role through `Pasaport` (ADR 0098 §2), and `fate-module.ts` aggregates
 * this feature's fate contribution. The boundary that matters is that the service
 * stays feature-clean; the wire/gate layer reaching siblings is the point of the
 * layer, exactly as `pano/`/`sozluk/` own their vote mutation files.
 *
 * Type pins use expectTypeOf, not `@ts-expect-error` — the effect LSP plugin's
 * TS377003 escapes the directive (recurring finding; the `vote/` precedent).
 */
import type {Layer} from "effect";
import {describe, expectTypeOf, it} from "vitest";
import type {Drizzle} from "../../db/Drizzle.ts";
import type {Report, ReportLive} from "./Report.ts";

describe("Report's public surface is feature-clean (type pin)", () => {
	it("ReportLive requires exactly the db seam (Drizzle) and nothing else", () => {
		expectTypeOf<typeof ReportLive>().toEqualTypeOf<Layer.Layer<Report, never, Drizzle>>();
	});
});
