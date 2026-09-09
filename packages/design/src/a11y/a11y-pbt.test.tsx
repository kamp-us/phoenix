/** The property-based a11y suite — see `.patterns/property-based-a11y.md`. */
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {render} from "@testing-library/react";
import fc from "fast-check";
import {describe, expect, it} from "vitest";
import * as DiffEntry from "../Diff.tsx";
import * as UI from "../index.ts";
import {runEnforcedInvariants} from "./check.ts";
import {POSTURE, postureOf} from "./posture.ts";
import {type PrimitiveSpec, REGISTRY} from "./registry.tsx";

const RUNS_PER_PRIMITIVE = 20;

const testable = (spec: PrimitiveSpec): spec is Exclude<PrimitiveSpec, {kind: "deferred"}> =>
	spec.kind !== "deferred";

/**
 * The component entries the package publishes beside its barrel. A component sits on its own entry
 * so a consumer can code-split it — `Diff` pulls `@pierre/diffs` and Shiki, and a barrel edge is one
 * no bundler can cut (#8613) — and being off the barrel changes nothing about owing this gate. So
 * the covered set below is the union rather than the barrel alone.
 */
const SUBPATH_ENTRIES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
	"./Diff": DiffEntry,
};

/**
 * The same entries read off `package.json`, so the map above is checked rather than trusted: a new
 * subpath entry nobody adds there reds here instead of quietly leaving its component uncovered.
 * `.` is the barrel and anything under `src/a11y/` is this suite's own harness, not a primitive.
 */
const publishedComponentEntries = (): ReadonlyArray<string> => {
	const manifest = JSON.parse(
		readFileSync(fileURLToPath(import.meta.resolve("../../package.json")), "utf8"),
	) as {readonly exports: Readonly<Record<string, string>>};
	return Object.entries(manifest.exports)
		.filter(
			([name, target]) =>
				name !== "." && /\.tsx?$/.test(target) && !target.startsWith("./src/a11y/"),
		)
		.map(([name]) => name)
		.sort();
};

describe("ui/ primitive a11y coverage (auto-covers new primitives)", () => {
	it("names every component entry the package publishes beside the barrel", () => {
		expect(publishedComponentEntries()).toEqual(Object.keys(SUBPATH_ENTRIES).sort());
	});

	it("classifies every runtime export of @kampus/design — a new primitive fails until classified", () => {
		// Runtime (value) exports only; `export type` is erased, so this is exactly
		// the set of primitives that render. The symmetric diff must be empty:
		// an unclassified new export, or a stale entry for a removed one, fails.
		const covered = new Set(
			[UI, ...Object.values(SUBPATH_ENTRIES)].flatMap((entry) => Object.keys(entry)),
		);
		const exported = [...covered].sort();
		const classified = Object.keys(REGISTRY).sort();
		const unclassified = exported.filter((name) => !(name in REGISTRY));
		const stale = classified.filter((name) => !covered.has(name));
		expect({unclassified, stale}).toEqual({unclassified: [], stale: []});
	});
});

describe("enforced-invariant teeth (the gate is not vacuous)", () => {
	it("flags a nameless button as an accessible-name violation", async () => {
		const {container} = render(<button type="button" />);
		const spec: PrimitiveSpec = {
			kind: "interactive",
			selector: "button",
			arb: fc.constant(<div />),
		};
		const violations = await runEnforcedInvariants(container, spec);
		expect(violations.some((v) => v.id === "accessible-name")).toBe(true);
	});

	it("passes a named button clean", async () => {
		const {container} = render(<button type="button">Kaydet</button>);
		const spec: PrimitiveSpec = {
			kind: "interactive",
			selector: "button",
			arb: fc.constant(<div />),
		};
		const violations = await runEnforcedInvariants(container, spec);
		expect(violations).toEqual([]);
	});
});

for (const [name, spec] of Object.entries(REGISTRY)) {
	if (!testable(spec)) continue;
	describe(`${name} — property-based a11y (${spec.kind})`, () => {
		const warned = Object.values(POSTURE)
			.filter((m) => m.posture === "warning")
			.map((m) => m.id);
		it(`holds every ENFORCED pillar-4 invariant across ${RUNS_PER_PRIMITIVE} prop combinations`, async () => {
			await fc.assert(
				fc.asyncProperty(spec.arb, async (element) => {
					const {container, unmount} = render(element);
					try {
						const violations = await runEnforcedInvariants(container, spec);
						const enforced = violations.filter((v) => postureOf(v.id) === "enforced");
						if (enforced.length > 0) {
							throw new Error(
								`${name}: enforced a11y invariant(s) violated:\n` +
									enforced.map((v) => `  [${v.id}] ${v.detail}`).join("\n"),
							);
						}
					} finally {
						unmount();
					}
					return true;
				}),
				{numRuns: RUNS_PER_PRIMITIVE},
			);
			// Report (never fail on) the warning-posture invariants — the promotion
			// candidates a real-browser pass would decide.
			if (warned.length > 0) {
				console.warn(
					`a11y[warning] ${name}: ${warned.join(", ")} not verified in jsdom — promotion candidates (ADR 0162 pillar 4).`,
				);
			}
		});
	});
}
