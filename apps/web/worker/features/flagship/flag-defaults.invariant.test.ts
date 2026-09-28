/**
 * The dark-ship default-is-the-safe-state invariant (ADR 0083) for every flag record
 * `resources.ts` exports: each `*_FLAG` ships `defaultVariation: "off"` over
 * `{off: false, on: true}`, so a flag reaches production dark and flipping it on stays the
 * human release act. The records are walked off the module, so a flag is covered the moment
 * it is declared. Inspected off the plain records, so no alchemy resource is constructed.
 */
import {describe, expect, it} from "vitest";
import * as resources from "./resources.ts";

const flagRecords = Object.entries(resources).filter(([name]) => name.endsWith("_FLAG"));

describe("every flag record ships its safe (off) state as the IaC default", () => {
	it("walks a non-empty set of flag records (the rows below cannot pass vacuously)", () => {
		expect(flagRecords).not.toHaveLength(0);
	});

	it.each(flagRecords)("%s: defaultVariation off, variations {off: false, on: true}", (_, flag) => {
		expect(flag).toMatchObject({defaultVariation: "off", variations: {off: false, on: true}});
	});
});
