import {assert, describe, it} from "@effect/vitest";
import {
	decideRefUpdate,
	decideTransaction,
	GUARDED_REF,
	type OriginFacts,
	type RefUpdate,
	ZERO_OID,
} from "./ref-guard.ts";

const OID_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OID_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OID_ORIGIN = "cccccccccccccccccccccccccccccccccccccccc";

const update = (over: Partial<RefUpdate> = {}): RefUpdate => ({
	oldOid: OID_A,
	newOid: OID_B,
	refName: GUARDED_REF,
	...over,
});

const facts = (over: Partial<OriginFacts> = {}): OriginFacts => ({
	originMainOid: OID_ORIGIN,
	originIsAncestorOfNew: false,
	...over,
});

describe("decideRefUpdate — off the guarded ref (out of scope, always allow)", () => {
	it("a feature branch update is allowed regardless of origin facts", () => {
		const d = decideRefUpdate(update({refName: "refs/heads/umut/some-branch"}), facts());
		assert.strictEqual(d.kind, "allow");
	});

	it("a tag update is allowed", () => {
		const d = decideRefUpdate(update({refName: "refs/tags/v1"}), facts());
		assert.strictEqual(d.kind, "allow");
	});

	it("a remote-tracking origin/main update is allowed (not refs/heads/main)", () => {
		const d = decideRefUpdate(update({refName: "refs/remotes/origin/main"}), facts());
		assert.strictEqual(d.kind, "allow");
	});
});

describe("decideRefUpdate — refs/heads/main fast-forward cases (allow)", () => {
	it("already in sync: new tip == origin/main → allow", () => {
		const d = decideRefUpdate(
			update({newOid: OID_ORIGIN}),
			facts({originMainOid: OID_ORIGIN, originIsAncestorOfNew: true}),
		);
		assert.strictEqual(d.kind, "allow");
	});

	it("fast-forward-ahead: origin/main is an ancestor of the new tip → allow (the merge --ff-only flow)", () => {
		const d = decideRefUpdate(
			update({newOid: OID_B}),
			facts({originMainOid: OID_ORIGIN, originIsAncestorOfNew: true}),
		);
		assert.strictEqual(d.kind, "allow");
	});

	it("a create (old all-zeroes) that is a fast-forward of origin/main → allow", () => {
		const d = decideRefUpdate(
			update({oldOid: ZERO_OID, newOid: OID_B}),
			facts({originMainOid: OID_ORIGIN, originIsAncestorOfNew: true}),
		);
		assert.strictEqual(d.kind, "allow");
	});
});

describe("decideRefUpdate — refs/heads/main divergence (the #2143 refuse)", () => {
	it("non-fast-forward: origin/main is NOT an ancestor of the new tip → refuse", () => {
		const d = decideRefUpdate(
			update({newOid: OID_B}),
			facts({originMainOid: OID_ORIGIN, originIsAncestorOfNew: false}),
		);
		assert.strictEqual(d.kind, "refuse");
		assert.include(d.reason, "DIVERGING");
	});

	it("a force-move create (old all-zeroes) onto a diverged commit → refuse", () => {
		const d = decideRefUpdate(
			update({oldOid: ZERO_OID, newOid: OID_B}),
			facts({originMainOid: OID_ORIGIN, originIsAncestorOfNew: false}),
		);
		assert.strictEqual(d.kind, "refuse");
	});

	it("an indeterminate ancestry probe is passed as false → refuse (fail-closed: cannot prove ff)", () => {
		// The boundary passes originIsAncestorOfNew=false when the merge-base probe failed;
		// on the guarded ref that must refuse rather than silently allow a possible divergence.
		const d = decideRefUpdate(update({newOid: OID_B}), facts({originIsAncestorOfNew: false}));
		assert.strictEqual(d.kind, "refuse");
	});
});

describe("decideRefUpdate — refs/heads/main delete (refuse)", () => {
	it("deleting main (new all-zeroes) → refuse, regardless of origin facts", () => {
		const d = decideRefUpdate(update({newOid: ZERO_OID}), facts({originIsAncestorOfNew: true}));
		assert.strictEqual(d.kind, "refuse");
		assert.include(d.reason, "DELETE");
	});
});

describe("decideRefUpdate — origin/main unresolvable (the one fail-open on the guarded ref)", () => {
	it("no origin/main (fresh clone before fetch) → allow (nothing to diverge from)", () => {
		const d = decideRefUpdate(update({newOid: OID_B}), facts({originMainOid: null}));
		assert.strictEqual(d.kind, "allow");
	});

	it("a delete still refuses even when origin/main is unresolvable (delete gates before origin-absent)", () => {
		const d = decideRefUpdate(update({newOid: ZERO_OID}), facts({originMainOid: null}));
		assert.strictEqual(d.kind, "refuse");
	});
});

describe("decideRefUpdate — totality", () => {
	it("every (ref-scope × delete × origin-present × ancestry) combination maps to a kind", () => {
		const refNames = [GUARDED_REF, "refs/heads/feature"];
		const newOids = [OID_B, ZERO_OID];
		const origins: Array<string | null> = [OID_ORIGIN, null];
		const ancestry = [true, false];
		const kinds = new Set(["allow", "refuse"]);
		for (const refName of refNames) {
			for (const newOid of newOids) {
				for (const originMainOid of origins) {
					for (const originIsAncestorOfNew of ancestry) {
						const d = decideRefUpdate(update({refName, newOid}), {
							originMainOid,
							originIsAncestorOfNew,
						});
						assert.isTrue(kinds.has(d.kind));
					}
				}
			}
		}
	});
});

describe("decideTransaction — all-or-nothing over a batch", () => {
	it("empty batch → allow", () => {
		assert.strictEqual(decideTransaction([]).kind, "allow");
	});

	it("all-allow batch → allow", () => {
		const d = decideTransaction([
			{kind: "allow", reason: "a"},
			{kind: "allow", reason: "b"},
		]);
		assert.strictEqual(d.kind, "allow");
	});

	it("any refuse in the batch → refuse the whole transaction, surfacing the first refuse reason", () => {
		const d = decideTransaction([
			{kind: "allow", reason: "a"},
			{kind: "refuse", reason: "the guarded divergence"},
			{kind: "refuse", reason: "second"},
		]);
		assert.strictEqual(d.kind, "refuse");
		assert.strictEqual(d.reason, "the guarded divergence");
	});
});
