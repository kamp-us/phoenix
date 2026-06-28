/**
 * `token-spend` core — reconstruct a pipeline stage's token spend from its sub-agent
 * transcript, offline (issue #1382, epic #1356).
 *
 * Each pipeline-stage sub-agent run is individually attributable: it gets its own
 * transcript at `<parent-session-id>/subagents/agent-<agent-id>.jsonl`. Claude Code does
 * NOT persist its `cost.total_tokens` aggregate *into* that transcript — only the
 * per-message `usage` components are stored — so the per-stage total must be
 * reconstructed by summing the four `usage` components over every `assistant` message:
 *
 *   billed = Σ (input_tokens + cache_creation_input_tokens
 *             + cache_read_input_tokens + output_tokens)
 *
 * This is the exact `jq` reconstruction documented in
 * `.patterns/token-economics-measurement.md` §2, turned into a pure, total core so a
 * one-command reporter replaces the hand-run `jq`. The headline figure renders through
 * `spawn-guard`'s existing `formatSessionCost` (the same per-session shape the statusline
 * draws) — reused read-only here, not re-minted.
 *
 * `cache_read` is kept visible separately on purpose: it is the cumulative cached prefix
 * re-reported every turn, so it dominates `billed` and balloons with turn count — that
 * domination is itself the context-bloat signal a lever targets. `ex-cache-read`
 * (input + cache_create + output) is the cross-run comparator that does not re-count per
 * turn (pattern §2).
 *
 * Pure and total: `reconstructSpend(text)` over the raw transcript never throws — a line
 * that isn't JSON, isn't an assistant message, or carries no `usage` is skipped, never a
 * crash (fail-open: a missed message just undercounts, never aborts the report).
 */
import {formatSessionCost, type SessionCostInput} from "../spawn-guard/spawn-guard.ts";

/** The four-component reconstruction of a stage's billed token spend, plus its comparators. */
export interface StageSpend {
	/** Σ `input_tokens` over assistant messages. */
	readonly input: number;
	/** Σ `cache_creation_input_tokens` — the one-time prompt-prefix ingest. */
	readonly cacheCreate: number;
	/** Σ `cache_read_input_tokens` — the cached prefix re-read every turn (dominates `billed`). */
	readonly cacheRead: number;
	/** Σ `output_tokens` over assistant messages. */
	readonly output: number;
	/** `input + cacheCreate + cacheRead + output` — the headline billed total. */
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

/**
 * Reconstruct a stage's billed token spend from its transcript JSONL by summing the four
 * `usage` components over every `assistant` message (pattern §2). Total — skips any line
 * that isn't JSON, isn't an assistant message, or carries no `usage`.
 */
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
			continue; // not a JSON line — skip, never throw
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
 * The `SessionCostInput` for `formatSessionCost`'s headline. The transcript does not
 * persist `cost.total_cost_usd` (only per-message token `usage`), so cost is omitted and
 * the billed-token total is the headline figure — the same shape the statusline renders.
 */
export const toSessionCostInput = (spend: StageSpend): SessionCostInput => ({
	totalCostUsd: null,
	totalTokens: spend.billed,
	model: spend.model,
});

/** Group a token count with thousands separators for the human-readable breakdown. */
const grouped = (n: number): string => n.toLocaleString("en-US");

/**
 * Render the full per-stage report: the `formatSessionCost` headline (model · billed
 * tokens) over the four-component breakdown, with `cache_read` kept on its own line +
 * labelled as the per-turn context-bloat signal, and `ex-cache-read` as the cross-run
 * comparator (pattern §2). Pure — the command shell only does the file IO + the print.
 */
export const formatStageSpend = (spend: StageSpend): string => {
	const headline = formatSessionCost(toSessionCostInput(spend));
	const lines = [
		headline,
		`  input:          ${grouped(spend.input)}`,
		`  cache_create:   ${grouped(spend.cacheCreate)}`,
		`  cache_read:     ${grouped(spend.cacheRead)}  (re-read every turn — context-bloat signal)`,
		`  output:         ${grouped(spend.output)}`,
		`  billed:         ${grouped(spend.billed)}`,
		`  ex-cache-read:  ${grouped(spend.exCacheRead)}  (cross-run comparator)`,
		`  assistant turns: ${grouped(spend.assistantTurns)}`,
	];
	return lines.join("\n");
};
