import {describe, expect, it} from "vitest";
import {DIGEST_RE, type LedgerScope, scopeDigest, serializeScope} from "./digest.ts";
import type {ChildLedger} from "./model.ts";

const child = (overrides: Partial<ChildLedger> = {}): ChildLedger => ({
	number: 4301,
	labels: ["p1", "status:planned", "type:feature"],
	assignees: [],
	assigneesObserved: true,
	criteria: "found",
	criteriaCount: 3,
	stories: [1, 2],
	storiesValue: null,
	containment: "flag",
	...overrides,
});

const scope = (overrides: Partial<LedgerScope> = {}): LedgerScope => ({
	epic: 4300,
	children: [child()],
	epicStories: [1, 2],
	cycleDoc: "present",
	topology: {phases: [{phase: 1, members: ["#4301"]}], edges: []},
	dependenciesAbsent: false,
	...overrides,
});

describe("the digest is flip-neutral (the invariant the whole gate rests on)", () => {
	/**
	 * The only two labels `plan flip` writes are excluded from the serialization, so a digest taken at
	 * check time still binds after the flip. Delete either name from `FLIP_LABELS` and this reds — and
	 * in the field every clean verdict would bind a scope no floor had checked.
	 */
	it("does not move when a child flips from status:planned to status:triaged", () => {
		const before = scope();
		const after = scope({
			children: [child({labels: ["p1", "status:triaged", "type:feature"]})],
		});
		expect(scopeDigest(after)).toBe(scopeDigest(before));
	});

	it("does not move mid-write, while a child carries both labels", () => {
		const midWrite = scope({
			children: [child({labels: ["p1", "status:planned", "status:triaged", "type:feature"]})],
		});
		expect(scopeDigest(midWrite)).toBe(scopeDigest(scope()));
	});

	it("DOES move when any other label changes — the exclusion is two names, not a blanket", () => {
		const relabelled = scope({
			children: [child({labels: ["p0", "status:planned", "type:feature"]})],
		});
		expect(scopeDigest(relabelled)).not.toBe(scopeDigest(scope()));
	});
});

describe("serializeScope", () => {
	it("is canonical: one line per child ascending, then the epic line, no trailing newline", () => {
		const two = scope({children: [child({number: 4302}), child({number: 4301})]});
		const lines = serializeScope(two).split("\n");
		expect(lines[0]?.startsWith("#4301|")).toBe(true);
		expect(lines[1]?.startsWith("#4302|")).toBe(true);
		expect(lines[2]?.startsWith("epic=4300|")).toBe(true);
		expect(serializeScope(two).endsWith("\n")).toBe(false);
	});

	it("distinguishes an unobserved assignee slot from an observed-empty one", () => {
		const unobserved = serializeScope(
			scope({children: [child({assignees: null, assigneesObserved: false})]}),
		);
		expect(unobserved).toContain("assignees=?");
		expect(serializeScope(scope())).toContain("assignees=|");
	});

	it("distinguishes an absent story claim from an explicit `none`", () => {
		expect(serializeScope(scope({children: [child({stories: null})]}))).toContain("stories=?");
		expect(serializeScope(scope({children: [child({stories: []})]}))).toContain("stories=none");
	});

	it("carries the phase spine and the requires edges in separate fields", () => {
		const withEdge = scope({
			topology: {phases: [{phase: 1, members: ["#4301"]}], edges: [["#4302", "#4301"]]},
		});
		expect(serializeScope(withEdge)).toContain("deps=p1:#4301|edges=#4302>#4301");
	});
});

describe("scopeDigest", () => {
	it("is 12 lowercase hex — the shape `--digest` accepts", () => {
		expect(scopeDigest(scope())).toMatch(DIGEST_RE);
	});

	it("is stable across two computations of one scope", () => {
		expect(scopeDigest(scope())).toBe(scopeDigest(scope()));
	});
});
