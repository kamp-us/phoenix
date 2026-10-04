import {describe, expect, it} from "vitest";
import type {StatusNames} from "../config/board.ts";
import {DEFAULT_STATUS_NAMES} from "../labels.ts";
import {DIGEST_RE, type LedgerScope, scopeDigest, serializeScope} from "./digest.ts";
import type {ChildLedger} from "./model.ts";

/** The board a repo that declared nothing runs on — every case below but the renamed one. */
const digest = (ledger: LedgerScope) => scopeDigest(ledger, DEFAULT_STATUS_NAMES);
const serialize = (ledger: LedgerScope) => serializeScope(ledger, DEFAULT_STATUS_NAMES);

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
	epicCriteria: [],
	cycleDoc: "present",
	topology: {phases: [{phase: 1, members: ["#4301"]}], edges: []},
	dependenciesAbsent: false,
	...overrides,
});

describe("the digest is flip-neutral (the invariant the whole gate rests on)", () => {
	/**
	 * The only two labels `plan flip` writes are excluded from the serialization, so a digest taken at
	 * check time still binds after the flip. Drop either role from `flipLabels` and this reds — and
	 * in the field every clean verdict would bind a scope no floor had checked.
	 */
	it("does not move when a child flips from status:planned to status:triaged", () => {
		const before = scope();
		const after = scope({
			children: [child({labels: ["p1", "status:triaged", "type:feature"]})],
		});
		expect(digest(after)).toBe(digest(before));
	});

	it("does not move mid-write, while a child carries both labels", () => {
		const midWrite = scope({
			children: [child({labels: ["p1", "status:planned", "status:triaged", "type:feature"]})],
		});
		expect(digest(midWrite)).toBe(digest(scope()));
	});

	/**
	 * A repo that renamed the two statuses flips between the renamed labels, so those are the pair
	 * the digest has to leave out — and the shipped names are ordinary labels on that board.
	 */
	it("leaves out the board's own planned and triaged labels when a repo renamed them", () => {
		const renamed: StatusNames = {
			...DEFAULT_STATUS_NAMES,
			planned: "state:planned",
			triaged: "state:ready",
		};
		const labelled = (...labels: ReadonlyArray<string>) =>
			scopeDigest(scope({children: [child({labels: [...labels]})]}), renamed);
		expect(labelled("p1", "state:ready")).toBe(labelled("p1", "state:planned"));
		expect(labelled("p1", "status:triaged")).not.toBe(labelled("p1", "status:planned"));
	});

	it("DOES move when any other label changes — the exclusion is two names, not a blanket", () => {
		const relabelled = scope({
			children: [child({labels: ["p0", "status:planned", "type:feature"]})],
		});
		expect(digest(relabelled)).not.toBe(digest(scope()));
	});
});

describe("the epic's own acceptance criteria bind the digest", () => {
	it("does not move for an epic carrying none — an old plan's approval stays current", () => {
		const epicLine = serialize(scope()).split("\n").at(-1) ?? "";
		expect(epicLine.startsWith("epic=4300|")).toBe(true);
		expect(epicLine.includes("|ac=")).toBe(false);
	});

	it("moves when a criterion is reworded — the texts are serialized, not their count", () => {
		const one = scope({epicCriteria: ["the tail wires every child"]});
		const reworded = scope({epicCriteria: ["the tail wires every child, in order"]});
		expect(digest(reworded)).not.toBe(digest(one));
	});

	it("moves when a criterion is added, and again when it is removed", () => {
		const bare = scope();
		const one = scope({epicCriteria: ["the tail wires every child"]});
		expect(digest(one)).not.toBe(digest(bare));
		expect(digest(scope({epicCriteria: ["a", "b"]}))).not.toBe(digest(one));
	});
});

describe("serializeScope", () => {
	it("is canonical: one line per child ascending, then the epic line, no trailing newline", () => {
		const two = scope({children: [child({number: 4302}), child({number: 4301})]});
		const lines = serialize(two).split("\n");
		expect(lines[0]?.startsWith("#4301|")).toBe(true);
		expect(lines[1]?.startsWith("#4302|")).toBe(true);
		expect(lines[2]?.startsWith("epic=4300|")).toBe(true);
		expect(serialize(two).endsWith("\n")).toBe(false);
	});

	it("distinguishes an unobserved assignee slot from an observed-empty one", () => {
		const unobserved = serialize(
			scope({children: [child({assignees: null, assigneesObserved: false})]}),
		);
		expect(unobserved).toContain("assignees=?");
		expect(serialize(scope())).toContain("assignees=|");
	});

	it("distinguishes an absent story claim from an explicit `none`", () => {
		expect(serialize(scope({children: [child({stories: null})]}))).toContain("stories=?");
		expect(serialize(scope({children: [child({stories: []})]}))).toContain("stories=none");
	});

	it("carries the phase spine and the requires edges in separate fields", () => {
		const withEdge = scope({
			topology: {phases: [{phase: 1, members: ["#4301"]}], edges: [["#4302", "#4301"]]},
		});
		expect(serialize(withEdge)).toContain("deps=p1:#4301|edges=#4302>#4301");
	});
});

describe("scopeDigest", () => {
	it("is 12 lowercase hex — the shape `--digest` accepts", () => {
		expect(digest(scope())).toMatch(DIGEST_RE);
	});

	it("is stable across two computations of one scope", () => {
		expect(digest(scope())).toBe(digest(scope()));
	});
});
