/**
 * fabrika's token meter — reconstruct one run's billed token spend from its transcript, offline.
 *
 * The formula is **specified, not chosen**: ADR 0112 §2 fixes billed spend as the sum of the four
 * `usage` components over every `assistant` message, because Claude Code persists only those
 * per-message components into a transcript and never its own `cost.total_tokens` aggregate.
 *
 *   billed = Σ (input_tokens + cache_creation_input_tokens
 *             + cache_read_input_tokens + output_tokens)
 *
 * ADR 0238 is why this exists here rather than being imported: fabrika re-implements what it needs
 * instead of reaching into v1, and duplication is the accepted price of keeping v1 deletable. The
 * two-rulers risk that duplication would otherwise carry is closed by a **shared committed
 * fixture** — `fixtures/one-ruler/transcript.jsonl` plus its expected figures, asserted by this
 * package's unit tier *and* by v1's `token-spend` tier, so both implementations are pinned to one
 * set of numbers rather than trusted to agree (#4777).
 *
 * `cache_read` stays visible on its own because it is the cumulative cached prefix re-reported every
 * turn: it dominates `billed` and grows with turn count, which is itself the context-bloat signal.
 * `exCacheRead` is the cross-run comparator that does not re-count it.
 *
 * Pure and total. A line that is not JSON, is not an assistant message, or carries no `usage` is
 * skipped rather than thrown on — a missed message undercounts, it never aborts a measurement.
 *
 * `classifyRunSpend` at the bottom is the other half of the same rule: what a transcript's spend
 * *is* when it cannot be reconstructed. It reads as a spend rule, not an eval one, so it lives here
 * with its own ingredients — every consumer (`eval/`, `spend read`) imports it from this one owner
 * (#5050).
 */

/** The four-component reconstruction of a run's billed token spend, plus its comparators. */
export interface StageSpend {
	/** Σ `input_tokens` over assistant messages. */
	readonly input: number;
	/** Σ `cache_creation_input_tokens` — the one-time prompt-prefix ingest. */
	readonly cacheCreate: number;
	/** Σ `cache_read_input_tokens` — the cached prefix re-read every turn (dominates `billed`). */
	readonly cacheRead: number;
	/** Σ `output_tokens` over assistant messages. */
	readonly output: number;
	/** `input + cacheCreate + cacheRead + output` — the headline billed total (ADR 0112 §2). */
	readonly billed: number;
	/** `input + cacheCreate + output` — the cross-run comparator (not re-counted per turn). */
	readonly exCacheRead: number;
	/** Count of `assistant` messages that carried a `usage` block (the billed turns). */
	readonly assistantTurns: number;
	/** The model id seen on the assistant messages, or `null` when none carried one. */
	readonly model: string | null;
}

interface UsageBlock {
	readonly input_tokens?: unknown;
	readonly cache_creation_input_tokens?: unknown;
	readonly cache_read_input_tokens?: unknown;
	readonly output_tokens?: unknown;
}

interface TranscriptMessage {
	readonly role?: unknown;
	readonly model?: unknown;
	readonly usage?: UsageBlock | null;
}

interface TranscriptEntry {
	readonly message?: TranscriptMessage | null;
}

/** A finite, non-negative number from an untrusted `usage` field, else 0. */
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/** Reconstruct a run's billed token spend from its transcript JSONL. */
export const reconstructSpend = (transcript: string): StageSpend => {
	let input = 0;
	let cacheCreate = 0;
	let cacheRead = 0;
	let output = 0;
	let assistantTurns = 0;
	let model: string | null = null;

	for (const line of transcript.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		let entry: TranscriptEntry;
		try {
			entry = JSON.parse(trimmed) as TranscriptEntry;
		} catch {
			continue;
		}
		const message = entry.message;
		if (message == null || message.role !== "assistant") continue;
		const usage = message.usage;
		if (usage == null || typeof usage !== "object") continue;

		input += num(usage.input_tokens);
		cacheCreate += num(usage.cache_creation_input_tokens);
		cacheRead += num(usage.cache_read_input_tokens);
		output += num(usage.output_tokens);
		assistantTurns += 1;
		if (typeof message.model === "string" && message.model.length > 0) {
			model = message.model; // last assistant model wins (stable across a single run)
		}
	}

	const billed = input + cacheCreate + cacheRead + output;
	const exCacheRead = input + cacheCreate + output;
	return {input, cacheCreate, cacheRead, output, billed, exCacheRead, assistantTurns, model};
};

/**
 * One run's token spend, as one of three distinct outcomes — never a nullable `StageSpend`, so a
 * zero can never be fabricated where a measurement is missing.
 *
 * `NoBilledTurns` is the third: a transcript that exists and parses cleanly but carries **zero**
 * billed assistant turns, which reconstructs to a genuine, well-formed zero indistinguishable from a
 * free run. That is not hypothetical — a `claude -p` run whose skill failed to resolve writes
 * exactly such a transcript, and `token-spend` reports all-zeros at exit 0 (measured on 2.1.220,
 * #4673 §6). Folding it into `Reconstructed` would put the fabricated zero back that this union
 * exists to keep out.
 */
export type RunSpend =
	| {readonly _tag: "Reconstructed"; readonly spend: StageSpend}
	| {readonly _tag: "NoBilledTurns"}
	| {readonly _tag: "TranscriptMissing"};

/** Resolve a transcript to one of the three `RunSpend` outcomes. Pure + total. */
export const classifyRunSpend = (transcript: string | null): RunSpend => {
	if (transcript === null) return {_tag: "TranscriptMissing"};
	const spend = reconstructSpend(transcript);
	return spend.assistantTurns === 0 ? {_tag: "NoBilledTurns"} : {_tag: "Reconstructed", spend};
};
