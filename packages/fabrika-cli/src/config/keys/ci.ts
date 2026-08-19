/**
 * `ci` — what fabrika may assume about the repo's continuous-integration producer.
 *
 * Two sub-keys, one question each. `noProducer` says what a repo with **zero Actions workflows**
 * gets; `gateWorkflow` is the filename fabrika names when it points a reader at the gate that
 * supersedes an in-tree prediction.
 *
 * **Workflow existence is the whole test, and nothing here inspects what a workflow does.** The
 * founder ruled it that way (#5603, R17.1: "that's fine, only if workflows exist is fine dude") —
 * no job-name matching, no expected set, because any such set is a second place the repo's CI shape
 * is written down and a second place it drifts.
 *
 * **The shipped default is `refuse`, and that is today's behaviour, not a new strictness.** A repo
 * with no producer cannot evidence anything about a head, so a rollup over its empty enumeration is
 * vacuous (ADR 0092). A repo that knowingly runs no Actions workflows declares `degrade` for
 * itself; the default never quietly greens on the repo that simply forgot to set up CI.
 */

import type {Decoded, KeyGroup} from "../key-group.ts";

export const CI = "ci";

/** What a repo with zero workflows gets: refused, or answered with the no-producer fact. */
export type NoProducer = "refuse" | "degrade";

const NO_PRODUCER_VALUES: ReadonlyArray<NoProducer> = ["refuse", "degrade"];

export interface CiSurface {
	readonly noProducer: NoProducer;
	/** The CI gate's workflow filename, as `gh api actions/workflows/<file>` names it. */
	readonly gateWorkflow: string;
}

/** Phoenix's own CI surface — what a repo declaring nothing still gets. */
export const SHIPPED_CI: CiSurface = {noProducer: "refuse", gateWorkflow: "ci.yml"};

const named = (path: string): string => `\`${CI}\`'s \`${path}\``;

const asRecord = (raw: unknown): Record<string, unknown> | null =>
	typeof raw === "object" && raw !== null && !Array.isArray(raw)
		? (raw as Record<string, unknown>)
		: null;

const KNOWN: ReadonlyArray<string> = ["noProducer", "gateWorkflow"];

const decodeNoProducer = (raw: unknown): Decoded<NoProducer> =>
	typeof raw === "string" && (NO_PRODUCER_VALUES as ReadonlyArray<string>).includes(raw.trim())
		? {_tag: "Value", value: raw.trim() as NoProducer}
		: {
				_tag: "Malformed",
				reason: `${named("noProducer")} is not one of ${NO_PRODUCER_VALUES.join(", ")}`,
			};

/**
 * A bare workflow filename — the shape the Actions API addresses a workflow by.
 *
 * A path is refused rather than trimmed to its basename: `.github/workflows/ci.yml` would look
 * accepted and then be looked up as a workflow nobody has, and a silently-repaired declaration is
 * one the operator believes is configured and is not.
 */
const decodeGateWorkflow = (raw: unknown): Decoded<string> => {
	const value = typeof raw === "string" ? raw.trim() : "";
	if (value === "" || value.includes("/")) {
		return {
			_tag: "Malformed",
			reason: `${named("gateWorkflow")} is not a bare workflow filename — e.g. "ci.yml", not a path under .github/workflows`,
		};
	}
	return {_tag: "Value", value};
};

const decode = (raw: unknown): Decoded<CiSurface> => {
	const record = asRecord(raw);
	if (record === null) return {_tag: "Malformed", reason: `\`${CI}\` is not an object`};
	const stray = Object.keys(record).find((key) => !KNOWN.includes(key));
	if (stray !== undefined) {
		return {
			_tag: "Malformed",
			reason: `${named(stray)} is not a CI setting — one of ${KNOWN.join(", ")}`,
		};
	}

	const noProducer =
		record.noProducer === undefined
			? ({_tag: "Value", value: SHIPPED_CI.noProducer} as const)
			: decodeNoProducer(record.noProducer);
	if (noProducer._tag === "Malformed") return noProducer;

	const gateWorkflow =
		record.gateWorkflow === undefined
			? ({_tag: "Value", value: SHIPPED_CI.gateWorkflow} as const)
			: decodeGateWorkflow(record.gateWorkflow);
	if (gateWorkflow._tag === "Malformed") return gateWorkflow;

	return {
		_tag: "Value",
		value: {noProducer: noProducer.value, gateWorkflow: gateWorkflow.value},
	};
};

export const ciKey: KeyGroup<CiSurface> = {
	key: CI,
	shippedDefault: SHIPPED_CI,
	decode,
};
