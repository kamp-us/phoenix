/**
 * The `flag` verb group's pure adapter core — the operator-verb → cf-utils-lever mapping, and
 * nothing else. The serving-plan math, the renderers, the read/write clients, and the typed
 * not-found errors all live in `@kampus/cf-utils` (`flag.ts`/`flagship.ts`, #1726); this module
 * only names the operator language over them (`open`/`close`/`graduate`) so the mapping is the
 * one new, fully-unit-tested piece. It re-derives no split percentages.
 */

import type {FlagState, ServeTarget} from "@kampus/cf-utils";
import * as Schema from "effect/Schema";

/**
 * The env graduation is evaluated against. Retirement is a prod fact — the cycle's trigger
 * (`product-development-cycle.md` §Retirement) is "100% and stable for one release", which is
 * about the real release surface, not a preview stage. So `graduate` reads the flag's prod row.
 */
export const GRADUATE_ENV = "prod";

/**
 * The two live-flip operator verbs and their cf-utils lever. `open` releases the flag on via the
 * no-match 100% split (≡ cf-utils `set on`, never a `defaultVariation` flip — #1726); `close`
 * kills it (clears the split AND sets the default off — the true kill switch, cf-utils `set off`).
 */
export type ReleaseVerb = "open" | "close";

export const releaseVerbToTarget = (verb: ReleaseVerb): ServeTarget =>
	verb === "open" ? {_tag: "Percent", percentage: 100} : {_tag: "Kill"};

/**
 * The graduate decision. `Eligible` ⇒ prod serves the flag fully open (`on@100%` split), so it is
 * at the retirement trigger and the chore may be filed; `Ineligible` ⇒ not fully open (or absent
 * in prod), carrying the reason so `graduate` refuses loudly rather than silently filing a chore
 * for a flag that is still ramping. Stability-over-one-release is the operator's assertion (a
 * single read can't observe it), so the machine check is "fully open in prod".
 */
export type GraduateDecision =
	| {readonly _tag: "Eligible"; readonly key: string}
	| {readonly _tag: "Ineligible"; readonly key: string; readonly reason: string};

/**
 * Decide graduation from the flag's per-env rows (the `selectStatesForKey` slice of `flag list`).
 * Eligible only when the prod row exists and its effective serving is a full (100%) no-match split.
 */
export const decideGraduate = (input: {
	readonly key: string;
	readonly states: ReadonlyArray<FlagState>;
}): GraduateDecision => {
	const prod = input.states.find((s) => s.env === GRADUATE_ENV);
	if (prod === undefined) {
		return {
			_tag: "Ineligible",
			key: input.key,
			reason: `not defined in "${GRADUATE_ENV}" — a flag graduates from its prod serving state`,
		};
	}
	const serving = prod.serving;
	if (serving._tag !== "Split" || serving.percentage < 100) {
		const at =
			serving._tag === "Split"
				? `ramping at ${serving.percentage}%`
				: `serving the default (${serving.variation})`;
		return {
			_tag: "Ineligible",
			key: input.key,
			reason: `${GRADUATE_ENV} is ${at}, not fully open — retire only a 100%-stable flag`,
		};
	}
	return {_tag: "Eligible", key: input.key};
};

/**
 * The retirement chore's title + body, filed via the `report` skill idiom (`status:needs-triage`,
 * type-blind — triage classifies it `type:chore`). The body names the concrete removal work the
 * cycle's §Retirement + step 7 of the feature-flags workflow prescribe, so `write-code` can drain
 * it: delete the declaration, the `getBoolean` read + dead `else`, and inline the now-permanent path.
 */
export const renderRetirementChore = (
	key: string,
): {readonly title: string; readonly body: string} => ({
	title: `retire the graduated \`${key}\` feature flag`,
	body: [
		`The \`${key}\` flag is fully open (100% no-match split) and stable — the retirement`,
		`trigger in [product-development-cycle.md](product-development-cycle.md) §Retirement.`,
		`Filed by \`anka-ops flag graduate ${key}\`.`,
		"",
		"Retire it per step 7 of",
		"[.patterns/feature-flags-agent-workflow.md](.patterns/feature-flags-agent-workflow.md):",
		"",
		`- Delete the \`${key}\` flag declaration.`,
		`- Delete its \`getBoolean\` read and the now-dead \`else\` branch.`,
		"- Inline the now-permanent code path.",
		"",
		"Once merged, retire the live flag in Flagship (`anka-ops flag close` then delete).",
	].join("\n"),
});

/**
 * No Flagship serving state graduation could evaluate — `graduate` refuses fully-open verification.
 * A typed `E`-channel fault so an ineligible flag exits loud with the reason, never silently files
 * a chore or flips anything. (The unknown-key case reuses cf-utils' `FlagKeyNotFound` upstream.)
 */
export class FlagNotGraduable extends Schema.TaggedErrorClass<FlagNotGraduable>()(
	"@kampus/anka-ops/FlagNotGraduable",
	{
		key: Schema.String,
		reason: Schema.String,
	},
) {
	override get message(): string {
		return `flag "${this.key}" is not graduable: ${this.reason}`;
	}
}
