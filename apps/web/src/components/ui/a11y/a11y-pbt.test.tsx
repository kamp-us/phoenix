/**
 * The property-based a11y promotion loop over the `ui/` primitives (#2175, ADR
 * 0162 pillar 4). For every classified primitive, `fast-check` generates
 * randomized VALID prop combinations, each rendered in jsdom and asserted against
 * the pillar-4 invariants — but only the invariants whose posture is `enforced`
 * (`posture.ts`) fail the gate; `warning`-posture invariants (contrast,
 * tap-target — jsdom cannot compute them) are reported, not enforced. Promoting a
 * warning to enforced is a one-line edit to `posture.ts`, the promotion loop.
 */
import {render} from "@testing-library/react";
import fc from "fast-check";
import {describe, expect, it} from "vitest";
import * as UI from "../index.ts";
import {runEnforcedInvariants} from "./check.ts";
import {POSTURE, postureOf} from "./posture.ts";
import {type PrimitiveSpec, REGISTRY} from "./registry.tsx";

/** How many randomized prop combinations to generate per primitive. */
const RUNS_PER_PRIMITIVE = 20;

const testable = (spec: PrimitiveSpec): spec is Exclude<PrimitiveSpec, {kind: "deferred"}> =>
	spec.kind !== "deferred";

describe("ui/ primitive a11y coverage (auto-covers new primitives)", () => {
	it("classifies every runtime export of ui/index.ts — a new primitive fails until classified", () => {
		// Runtime (value) exports only; `export type` is erased, so this is exactly
		// the set of primitives that render. The symmetric diff must be empty:
		// an unclassified new export, or a stale entry for a removed one, fails.
		const exported = Object.keys(UI).sort();
		const classified = Object.keys(REGISTRY).sort();
		const unclassified = exported.filter((n) => !(n in REGISTRY));
		const stale = classified.filter((n) => !(n in UI));
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
		// The warning-posture invariants jsdom cannot decide — surfaced once per
		// primitive so the warning rung is visible, not silently dropped.
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
