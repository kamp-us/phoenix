/**
 * The Sentry feature-flag attribution contract (#1821): a resolved flag becomes the tag
 * `flag.<key>` = `"on"`/`"off"`, which is what makes the graduation query
 * `flag.<key>:on` isolate a single flag's on-path error rate (#1822).
 *
 * SDK-free on purpose — both the SPA tagger and the worker tagger import this one
 * definition, so the two tiers cannot drift into different tag shapes. Keys are the
 * non-PII `flags/keys.ts` constants, so this is orthogonal to the ADR 0118 PII scrub.
 */

export const FLAG_TAG_PREFIX = "flag.";

// Pure, so the naming contract is unit-testable without either Sentry SDK.
export function flagTag(key: string, value: boolean): {tagKey: string; tagValue: "on" | "off"} {
	return {tagKey: `${FLAG_TAG_PREFIX}${key}`, tagValue: value ? "on" : "off"};
}
