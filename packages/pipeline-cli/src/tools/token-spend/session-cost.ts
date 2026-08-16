/**
 * The per-session cost/token renderer `token-spend` draws its headline with. Lived in the
 * retired spawn-guard tool (issue #744) as the statusline renderer; moved here when that
 * guard was deleted (#5539) — `token-spend` was its one remaining consumer.
 */
export interface SessionCostInput {
	/** Total session cost in USD, as Claude Code reports it (e.g. `cost.total_cost_usd`). */
	readonly totalCostUsd?: number | null;
	/** Total session tokens (input + output) where the harness exposes them. */
	readonly totalTokens?: number | null;
	/** The active model id, if the payload carries it. */
	readonly model?: string | null;
}

const fmtUsd = (usd: number): string => {
	// Sub-cent spend reads as $0.00; show 4 dp under a cent so an early session isn't "free".
	const dp = usd > 0 && usd < 0.01 ? 4 : 2;
	return `$${usd.toFixed(dp)}`;
};

const fmtTokens = (tokens: number): string => {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tok`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K tok`;
	return `${tokens} tok`;
};

/**
 * Render the per-session cost/token figure. Tolerates a missing cost or token field (an
 * early session, or a payload that omits one) — it shows what it has and falls back to a
 * stable placeholder rather than a crash or a blank line.
 */
export const formatSessionCost = (input: SessionCostInput): string => {
	const parts: string[] = [];
	const cost = input.totalCostUsd;
	if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
		parts.push(fmtUsd(cost));
	}
	const tokens = input.totalTokens;
	if (typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0) {
		parts.push(fmtTokens(Math.round(tokens)));
	}
	const figure = parts.length > 0 ? parts.join(" · ") : "cost n/a";
	const model = input.model?.trim();
	return model != null && model.length > 0 ? `${model} · ${figure}` : figure;
};
