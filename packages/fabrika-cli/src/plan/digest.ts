/**
 * The scope digest: the first 12 lowercase hex of the SHA-256 of a canonical serialization of the
 * inputs the floor read.
 *
 * **The flip is digest-neutral by construction, and this file is where that invariant lives.** The
 * only two labels `plan flip` writes — `status:planned` and `status:triaged` — are excluded from the
 * child serialization, so a digest taken at check time still binds after the flip and a verdict
 * posted afterwards attests the scope the floor actually scanned. Without the exclusion the digest
 * would be invalidated by the very write it guards, and every clean verdict would bind a scope no
 * floor had checked. Neither label is a floor trigger either: `MISSING_LABEL` requires *a* `status:`
 * prefix, which both satisfy, and `NEEDS_TRIAGE_LABEL` names `status:needs-triage`, which the flip
 * never writes.
 *
 * The digest is threaded explicitly and never remembered: `plan check` prints it, and the two
 * mutating verbs require it as `--digest` and recompute from a fresh read. That is the TOCTOU answer
 * — the gap between deciding and writing is closed by re-deciding, not by trusting a cached decision.
 */

import {createHash} from "node:crypto";
import {PLANNED, TRIAGED} from "../labels.ts";
import type {ChildLedger, Ledger} from "./model.ts";

/** Everything the digest is taken over — the ledger minus the digest it is about to carry. */
export type LedgerScope = Omit<Ledger, "digest">;

/** The two labels the flip writes, excluded from the serialization. See the module docblock. */
export const FLIP_LABELS: ReadonlyArray<string> = [PLANNED, TRIAGED];

export const DIGEST_LENGTH = 12;

/** 12 lowercase hex — the one shape `--digest` accepts, so a mistyped value refuses before any read. */
export const DIGEST_RE = /^[0-9a-f]{12}$/;

const ascending = (values: ReadonlyArray<string>): string => [...values].sort().join(",");

const childLine = (child: ChildLedger): string => {
	const labels = ascending(child.labels.filter((label) => !FLIP_LABELS.includes(label)));
	const assignees = child.assigneesObserved ? ascending(child.assignees ?? []) : "?";
	const ac = child.criteria === "found" ? String(child.criteriaCount) : "?";
	const stories =
		child.stories === null
			? "?"
			: child.stories.length === 0
				? "none"
				: ascending(child.stories.map(String));
	return `#${child.number}|labels=${labels}|assignees=${assignees}|ac=${ac}|stories=${stories}|containment=${child.containment ?? "?"}`;
};

const epicLine = (ledger: LedgerScope): string => {
	const stories = ledger.epicStories.length === 0 ? "" : ledger.epicStories.map(String).join(",");
	const deps = [...ledger.topology.phases]
		.map((phase) => `p${phase.phase}:${phase.members.join(",")}`)
		.sort()
		.join(";");
	const edges = ledger.topology.edges
		.map(([dependent, prerequisite]) => `${dependent}>${prerequisite}`)
		.sort()
		.join(";");
	return `epic=${ledger.epic}|stories=${stories}|cycleDoc=${ledger.cycleDoc}|deps=${deps}|edges=${edges}`;
};

/** The canonical serialization: one line per child ascending, then the epic line, joined by `\n`. */
export const serializeScope = (ledger: LedgerScope): string =>
	[
		...[...ledger.children].sort((a, b) => a.number - b.number).map(childLine),
		epicLine(ledger),
	].join("\n");

export const scopeDigest = (ledger: LedgerScope): string =>
	createHash("sha256").update(serializeScope(ledger), "utf8").digest("hex").slice(0, DIGEST_LENGTH);
