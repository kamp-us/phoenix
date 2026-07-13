/**
 * The Sentry feature-flag attribution contract (#1821), shared verbatim by BOTH tiers. A
 * flag a request/session resolves becomes the Sentry tag `flag.<key>` with value
 * `"on"`/`"off"`, so a single flag's on-path error rate is isolable for the
 * dark→release→burn-in→graduate gate the flag lifecycle depends on (#1822 consumes this):
 * the graduation query is `flag.<key>:on` — e.g. `flag.phoenix-bildirim:on` counts errors
 * captured while `phoenix-bildirim` was on, and `flag.<key>:off` the comparison off-path.
 *
 * SDK-free on purpose. This pure naming contract is imported by the SPA tagger
 * (`src/lib/sentry.ts`, `@sentry/react`) AND the worker tagger (`worker/lib/sentry.ts`,
 * `@sentry/cloudflare`), so both tiers stamp an IDENTICAL `flag.<key>`:`on`/`off` shape and
 * the #1822 graduation query reads uniformly across client and worker — one definition, no
 * drift. Keys are the `flags/keys.ts` constants (non-PII), so tagging is orthogonal to the
 * ADR 0118 `dataCollection` PII scrub and touches none of it.
 */

/** The tag-key namespace: a resolved flag `key` maps to `flag.<key>`. */
export const FLAG_TAG_PREFIX = "flag.";

/**
 * The `(tagKey, tagValue)` a resolved flag maps to — pure, so the shared tag-naming contract
 * is unit-testable without either Sentry SDK and both tiers provably agree on the shape.
 */
export function flagTag(key: string, value: boolean): {tagKey: string; tagValue: "on" | "off"} {
	return {tagKey: `${FLAG_TAG_PREFIX}${key}`, tagValue: value ? "on" : "off"};
}
