/**
 * `FlagsContext` — the per-request flag evaluation context (epic #488, #508).
 *
 * Carries the request's identity for stable per-user bucketing, supplied per
 * request alongside `Auth` (ADR 0029) rather than captured at isolate scope —
 * the same identity an `Auth` session yields, lifted into flag evaluation so a
 * given user lands in a stable bucket across requests. Targeting/percentage
 * rules that consume it land in #511; this child supplies the seam.
 *
 * The domain shape (`userId`) is deliberately NOT alchemy's
 * `FlagshipEvaluationContext` — `toEvaluationContext` maps it at the boundary so
 * the provider's wire shape never leaks into the domain surface (the clean
 * OpenFeature seam, #506).
 */
import type {FlagshipEvaluationContext} from "alchemy/Cloudflare";
import {Context} from "effect";

/** The domain-facing per-request evaluation context. */
export interface FlagsContextValue {
	/** Stable identity for per-user bucketing; absent for an anonymous request. */
	readonly userId?: string;
}

export class FlagsContext extends Context.Service<FlagsContext, FlagsContextValue>()(
	"@kampus/FlagsContext",
) {}

/** The anonymous request context — no identity to bucket on. */
export const anonymousFlagsContext: FlagsContextValue = {};

/**
 * Map the domain context to the provider's evaluation-context wire shape. Kept
 * here, at the one boundary, so the alchemy/cf type stays out of the `Flags`
 * public surface — only `FlagsLive` calls it.
 */
export function toEvaluationContext(
	context: FlagsContextValue,
): FlagshipEvaluationContext | undefined {
	return context.userId === undefined ? undefined : {targetingKey: context.userId};
}
