/**
 * The run ledger: an append-only JSONL event log, and the two counters derived from it.
 *
 * **Where it lives binds the implementation.**
 * `<epic-tree-root>/.fabrika-epic/<epic>-<claim-nonce>/ledger.jsonl` — tree-resident and
 * **claim-nonce-keyed, never session-keyed**: the session id is constant across sibling subagents, so
 * a write collision under it is invisible to the victim (#4516). It is never committed; `epic open`
 * registers the directory in the tree's git exclude so conductor state cannot enter the epic's PR.
 *
 * **Events, with state derived at read time and never stored.** A line is
 * `{seq, at, event, slice, detail, sha}` over a closed event set. Anything else the file might hold —
 * an off-enum event, a broken line, a `seq` regression — is state the model of the run cannot name,
 * and is refused (`21`) rather than guessed past. Storing no derived state is what leaves the open
 * event-log-vs-state-machine question (#4891 Q1) settleable later as a new derivation over this input.
 *
 * The append is read-modify-write rather than `O_APPEND`: the writer re-reads the whole file to prove
 * the tail, and the lane guard makes the run single-writer, so there is one read of the file per
 * append either way.
 */
import {isRecord, parseJson} from "../io/json.ts";

/** The closed event vocabulary. A line outside it is unnameable state, never a skipped line. */
export const EPIC_EVENTS = [
	"run-opened",
	"slice-dispatched",
	"dispatch-dead",
	"slice-landed",
	"verdict-recorded",
	"retry-injected",
	"breaker-tripped",
	"pr-opened",
	"run-halted",
] as const;

export type EpicEvent = (typeof EPIC_EVENTS)[number];

export const isEpicEvent = (value: string): value is EpicEvent =>
	(EPIC_EVENTS as ReadonlyArray<string>).includes(value);

/** The events that name a slice rather than the run. */
export const SLICE_SCOPED: ReadonlyArray<EpicEvent> = [
	"slice-dispatched",
	"dispatch-dead",
	"slice-landed",
	"verdict-recorded",
	"retry-injected",
	"breaker-tripped",
];

/** The events whose writer self-captures the tree's HEAD at append time. */
export const SHA_CAPTURING: ReadonlyArray<EpicEvent> = ["slice-dispatched", "slice-landed"];

/**
 * How many `verdict-recorded(FAIL)` → `retry-injected` cycles a slice may run, and how many dead
 * dispatches it may absorb. Two axes, **never summed**: a crashed dispatch and a failing
 * implementation are different problems and a shared counter hides whichever is rarer (ADR 0130).
 *
 * The fail axis counts the **FAIL that opens the cycle**, not the retry that closes it, so the count
 * is right the moment the verdict lands rather than one dispatch later — which is what makes
 * `failAttempts: 1` the reading of a slice whose first FAIL is recorded and whose retry is still to
 * come.
 */
export const FAIL_AXIS_CAP = 2;
export const DEAD_AXIS_CAP = 2;

/** Which breaker a slice tripped. Named on stderr so a caller knows which problem it has. */
export type BreakerAxis = "fail" | "dead";

export interface LedgerLine {
	readonly seq: number;
	readonly at: string;
	readonly event: EpicEvent;
	readonly slice: string | null;
	readonly detail: string | null;
	/** Self-captured by the writer on `slice-dispatched` / `slice-landed`; `null` elsewhere. */
	readonly sha: string | null;
}

export type LedgerRead =
	| {readonly _tag: "Ledger"; readonly lines: ReadonlyArray<LedgerLine>}
	/** The file reads, and holds state that cannot be named — `21`, never a guess. */
	| {readonly _tag: "Unnameable"; readonly detail: string};

const fieldOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * Parse the ledger's bytes. Total: every non-conforming file lands on `Unnameable` with the detail a
 * refusal quotes, and no line is ever skipped — a dropped line is a run whose history silently
 * shrank.
 */
export const parseLedger = (text: string): LedgerRead => {
	const lines: LedgerLine[] = [];
	let previous = 0;
	for (const [index, raw] of text.split("\n").entries()) {
		if (raw.trim() === "") continue;
		const number = index + 1;
		const parsed = parseJson(raw);
		if (!isRecord(parsed)) {
			return {_tag: "Unnameable", detail: `line ${number} is not a JSON object`};
		}
		const {seq, at, event, slice, detail, sha} = parsed;
		if (typeof seq !== "number" || !Number.isInteger(seq)) {
			return {_tag: "Unnameable", detail: `line ${number} carries no integer seq`};
		}
		if (typeof event !== "string" || !isEpicEvent(event)) {
			return {_tag: "Unnameable", detail: `event "${String(event)}" at seq ${seq}`};
		}
		if (seq <= previous) {
			return {_tag: "Unnameable", detail: `seq ${seq} follows seq ${previous} at line ${number}`};
		}
		previous = seq;
		lines.push({
			seq,
			at: typeof at === "string" ? at : "",
			event,
			slice: fieldOrNull(slice),
			detail: fieldOrNull(detail),
			sha: fieldOrNull(sha),
		});
	}
	return {_tag: "Ledger", lines};
};

/** One line's bytes. Key order is fixed so a hand-read of the file is stable across appends. */
export const renderLine = (line: LedgerLine): string =>
	`${JSON.stringify({
		seq: line.seq,
		at: line.at,
		event: line.event,
		slice: line.slice,
		detail: line.detail,
		sha: line.sha,
	})}\n`;

/** The seq the next append takes — the tail's plus one, `1` on an empty ledger. */
export const nextSeq = (lines: ReadonlyArray<LedgerLine>): number => (lines.at(-1)?.seq ?? 0) + 1;

/** Every line naming `slice`, in order. */
export const forSlice = (
	lines: ReadonlyArray<LedgerLine>,
	slice: string,
): ReadonlyArray<LedgerLine> => lines.filter((line) => line.slice === slice);

export interface SliceCounters {
	readonly failAttempts: number;
	readonly deadAttempts: number;
}

/** The two axes, counted independently. A caller that sums them has re-fused what ADR 0130 split. */
export const countersFor = (lines: ReadonlyArray<LedgerLine>, slice: string): SliceCounters => ({
	failAttempts: forSlice(lines, slice).filter(
		(line) => line.event === "verdict-recorded" && polarityOf(line) === "FAIL",
	).length,
	deadAttempts: forSlice(lines, slice).filter((line) => line.event === "dispatch-dead").length,
});

/** The axis a slice's breaker has tripped, or `null` while both are under cap. */
export const trippedAxis = (counters: SliceCounters): BreakerAxis | null => {
	if (counters.failAttempts >= FAIL_AXIS_CAP) return "fail";
	if (counters.deadAttempts >= DEAD_AXIS_CAP) return "dead";
	return null;
};

/**
 * The polarity a `verdict-recorded` line carries, read out of the marker its `detail` holds.
 *
 * The marker is composed by `wire/verdict-marker.ts`; this reads only the polarity token, because a
 * consumer that needs the whole marker imports that module's total `read` rather than a second parse.
 */
export const polarityOf = (line: LedgerLine): "PASS" | "FAIL" | null => {
	const match = /:\s*(PASS|FAIL)\s+@/.exec(line.detail ?? "");
	return match?.[1] === "PASS" || match?.[1] === "FAIL" ? match[1] : null;
};

/** The SHA a `verdict-recorded` line's marker binds. */
export const boundShaOf = (line: LedgerLine): string | null => {
	const match = /@\s*([0-9a-f]{7,40})\b/.exec(line.detail ?? "");
	return match?.[1] ?? null;
};

/** The run key: `<epic>-<claim-nonce>`, never the session id (#4516). */
export const runKey = (epic: number, nonce: string): string => `${epic}-${nonce}`;

/** The run’s directory inside the epic tree. */
export const runDir = (treeRoot: string, key: string): string =>
	`${treeRoot.replace(/\/+$/, "")}/.fabrika-epic/${key}`;

export const ledgerPathIn = (dir: string): string => `${dir}/ledger.jsonl`;

/** Where a slice verdict's body is stored beside the event that indexes it. */
export const verdictBodyPath = (dir: string, slice: string, commit: string): string =>
	`${dir}/verdicts/${slice}-${commit}.md`;

/** The per-slice handoff-note path: `build scratch`'s key, extended one level per slice (#4516). */
export const handoffPath = (tmpRoot: string, key: string, slice: string): string =>
	`${tmpRoot.replace(/\/+$/, "")}/fabrika-epic/${key}/${slice}/handoff.md`;

/** The one line the git exclude carries, so conductor state can never enter the epic's PR. */
export const EXCLUDE_ENTRY = ".fabrika-epic/";
