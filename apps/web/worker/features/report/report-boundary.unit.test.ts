/**
 * `Report` sits below the feature directories and must import none of them, so the pin
 * asserts what `ReportLive` REQUIRES: a sibling-feature import that widened `R` fails it.
 * The pin scopes to the SERVICE only — the wire/gate layer composes OVER the features by
 * design.
 *
 * Type pins use `expectTypeOf`, not `@ts-expect-error`: the effect LSP plugin's TS377003
 * escapes the directive.
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
