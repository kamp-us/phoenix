/**
 * The harness hook envelope — the JSON object Claude Code writes to a hook's stdin.
 *
 * Every fabrika hook meets the harness here and nowhere else, so this is the one module that says
 * what an envelope *is*. The four fields it requires are not a guess and not a doc summary: they are
 * the keys present in **both** captured envelopes committed beside this file
 * (`__fixtures__/PROVENANCE.md`), which is what ADR 0180 makes the ground truth. Everything else the
 * harness sends is per-event and stays untyped here — a hook that needs `tool_input` reads it off
 * {@link Envelope.fields}, and the golden test is where the per-event key sets are pinned.
 *
 * The read is **total and three-way**: an envelope, a proven non-envelope, or an unread fd 0. Those
 * are three different claims and none of them may collapse into another (ADR 0092) — the shape v1's
 * fd-0 reader already learned the hard way (`../io/stdin.ts`).
 */

/** The fields every captured envelope carries, whatever event produced it. */
export const REQUIRED_FIELDS = ["hook_event_name", "session_id", "transcript_path", "cwd"] as const;

export interface Envelope {
	/** `hook_event_name` — which harness event fired. */
	readonly event: string;
	readonly session: string;
	readonly cwd: string;
	/** Every key the harness actually sent, in arrival order. The per-event half of the shape. */
	readonly fields: ReadonlyArray<string>;
	/**
	 * The parsed envelope itself. The per-event fields stay untyped here on purpose — a hook that
	 * needs one (`tool_input.model`, say) reads it off this record and states its own shape, so this
	 * module never grows an event-by-event schema it cannot capture evidence for.
	 */
	readonly payload: Record<string, unknown>;
}

export type EnvelopeRead =
	| {readonly _tag: "Envelope"; readonly envelope: Envelope}
	/** fd 0 was read in full and held no bytes. */
	| {readonly _tag: "Empty"}
	/** Bytes arrived and are provably not an envelope. */
	| {readonly _tag: "Malformed"; readonly reason: string; readonly evidence: string}
	/** fd 0 could not be read at all. Nothing is proven about the envelope. */
	| {readonly _tag: "Unknown"; readonly reason: string};

/** The first 120 bytes of what arrived, for a refusal that names the offending input. */
const evidenceOf = (text: string): string => {
	const oneLine = text.replaceAll(/\s+/g, " ").trim();
	return oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine;
};

const stringField = (record: Record<string, unknown>, key: string): string | undefined =>
	typeof record[key] === "string" ? record[key] : undefined;

/** Classify the bytes on a hook's stdin. Total: every input lands on exactly one variant. */
export const classifyEnvelope = (text: string): EnvelopeRead => {
	if (text.trim() === "") return {_tag: "Empty"};

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return {
			_tag: "Malformed",
			reason: `not JSON (${error instanceof Error ? error.message : String(error)})`,
			evidence: evidenceOf(text),
		};
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return {
			_tag: "Malformed",
			reason: "the top level is not a JSON object",
			evidence: evidenceOf(text),
		};
	}

	const record = parsed as Record<string, unknown>;
	const missing = REQUIRED_FIELDS.filter((key) => stringField(record, key) === undefined);
	if (missing.length > 0) {
		return {
			_tag: "Malformed",
			reason: `missing string field${missing.length === 1 ? "" : "s"} ${missing.join(", ")}`,
			evidence: evidenceOf(text),
		};
	}

	return {
		_tag: "Envelope",
		envelope: {
			event: record.hook_event_name as string,
			session: record.session_id as string,
			cwd: record.cwd as string,
			fields: Object.keys(record),
			payload: record,
		},
	};
};
