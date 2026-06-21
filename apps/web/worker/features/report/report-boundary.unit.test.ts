/**
 * Report feature-boundary pins — `Report` is a shared low-level service over the
 * three content targets, so it sits below the feature directories and must import
 * none of them. Unlike `Vote`, it owns no inverted contract (no `KarmaBump`), so
 * `ReportLive` requires exactly the `Drizzle` seam. These pins enforce both via
 * (1) an import sweep over the `report/` SERVICE modules and (2) a type-level pin
 * on `ReportLive`'s requirements.
 *
 * The sweep excludes the wire/gate-layer modules (`mutations.ts`, `lists.ts`,
 * `Moderator.ts`, `views.ts`) and the test files: the `report.submit`/`report.resolve`
 * resolvers translate the service's `ReportTargetNotFound` into the per-feature
 * not-found errors and (for resolve) dispatch act-on-target to the sibling content
 * services, and `Moderator.ts` reads the caller's role through `Pasaport` (ADR 0098 §2)
 * — so the wire/gate layer MUST reach sibling features, exactly as `pano/`/`sozluk/`
 * own their vote mutation files. The boundary that matters is the SERVICE
 * (`Report.ts`) staying feature-clean (`ReportLive` requires only `Drizzle`); the
 * wire/gate layer composing over the features is the point of the layer.
 *
 * Type pins use expectTypeOf, not `@ts-expect-error` — the effect LSP plugin's
 * TS377003 escapes the directive (recurring finding; the `vote/` precedent).
 */
import {readdirSync, readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import type {Layer} from "effect";
import {describe, expect, expectTypeOf, it} from "vitest";
import type {Drizzle} from "../../db/Drizzle.ts";
import type {Report, ReportLive} from "./Report.ts";

const reportDir = dirname(fileURLToPath(import.meta.url));

// Sibling feature directories `report/` must never import from. `fate/` is the
// composition layer that imports report (never the reverse), so a `report/ →
// fate/` edge would be a cycle — it stays forbidden too.
const FORBIDDEN_SEGMENTS = ["pasaport", "sozluk", "pano", "stats", "fate", "fate-live", "vote"];

// The wire/gate layer composes OVER the features by design (see the file
// docblock), so it is exempt from the service-clean sweep: `mutations.ts`/`lists.ts`
// dispatch act-on-target + translate errors, `Moderator.ts` reads role via Pasaport,
// and `fate-module.ts` is the type-only aggregator of this feature's fate contribution
// (its `import type` from `../fate/module.ts` is the registration edge, not a cycle).
const WIRE_LAYER = new Set([
	"mutations.ts",
	"lists.ts",
	"Moderator.ts",
	"views.ts",
	"fate-module.ts",
]);

describe("report/ service module imports are feature-clean", () => {
	const files = readdirSync(reportDir).filter(
		(f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !WIRE_LAYER.has(f),
	);

	it.each(files)("%s imports no sibling feature directory", (file) => {
		const source = readFileSync(join(reportDir, file), "utf8");
		const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
		const offending = specifiers.filter((spec) =>
			FORBIDDEN_SEGMENTS.some((seg) => spec.includes(`/${seg}/`)),
		);
		expect(offending, `${file} imports a sibling feature directory`).toEqual([]);
	});
});

describe("Report's public surface is feature-clean (type pin)", () => {
	it("ReportLive requires exactly the db seam (Drizzle) and nothing else", () => {
		expectTypeOf<typeof ReportLive>().toEqualTypeOf<Layer.Layer<Report, never, Drizzle>>();
	});
});
