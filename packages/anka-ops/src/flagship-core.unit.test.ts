/**
 * Pure-core unit tests: the env↔app decode, the effective-serving computation (the #1726
 * release-lever model: rules → no-match split → default), the serving-plan write model
 * (`--percent` / kill semantics), and the renderers. No IO, no CF — every case is a
 * deterministic transform.
 */
import {assert, describe, it} from "@effect/vitest";
import {
	computeEffectiveServing,
	computeServingPlan,
	decideLeverGuard,
	decodeEnv,
	decodeFlagState,
	distinctKeys,
	ENV_HELP,
	FlagEnvNotFound,
	FlagKeyNotFound,
	type FlagRule,
	FlagSetTargetInvalid,
	findAppForEnv,
	findNoMatchSplit,
	LeverGuardRefused,
	planNextState,
	type RawFlag,
	renderEffectiveServing,
	renderFlagDetail,
	renderFlagTable,
	renderServingPlan,
	selectStatesForKey,
} from "./flagship-core.ts";

describe("decodeEnv — Flagship app physical name → env", () => {
	it("decodes the prod app", () => {
		assert.strictEqual(decodeEnv("phoenix-phoenix-flags-prod-abc123"), "prod");
	});

	it("decodes a non-prod (preview) stage", () => {
		assert.strictEqual(decodeEnv("phoenix-phoenix-flags-pr-42-deadbe"), "pr-42");
	});

	it("returns undefined for a foreign / unrecognized app name", () => {
		assert.strictEqual(decodeEnv("some-other-account-app"), undefined);
	});

	it("returns undefined for a name with the prefix but no suffix segment", () => {
		assert.strictEqual(decodeEnv("phoenix-phoenix-flags-prod"), undefined);
	});
});

const flag = (over: Partial<RawFlag> = {}): RawFlag => ({
	key: "new-nav",
	enabled: true,
	defaultVariation: "off",
	variations: {on: true, off: false},
	rules: [],
	...over,
});

const splitRule = (percentage: number, over: Partial<FlagRule> = {}): FlagRule => ({
	conditions: [],
	priority: 1,
	serveVariation: "on",
	rollout: {percentage},
	...over,
});

const targetingRule = (priority = 0): FlagRule => ({
	conditions: [{attribute: "email", operator: "equals", value: "founder@kamp.us"}],
	priority,
	serveVariation: "on",
});

describe("computeEffectiveServing — rules → no-match split → default (#1726)", () => {
	it("a split-released flag serves on@100% even though defaultVariation is off", () => {
		const serving = computeEffectiveServing(flag({rules: [splitRule(100)]}));
		assert.deepStrictEqual(serving, {
			_tag: "Split",
			variation: "on",
			percentage: 100,
			otherRules: 0,
		});
	});

	it("a partial split reads as ramping at its percentage", () => {
		const serving = computeEffectiveServing(flag({rules: [splitRule(50)]}));
		assert.deepStrictEqual(serving, {
			_tag: "Split",
			variation: "on",
			percentage: 50,
			otherRules: 0,
		});
	});

	it("no split ⇒ the default serves", () => {
		const serving = computeEffectiveServing(flag());
		assert.deepStrictEqual(serving, {_tag: "Default", variation: "off", otherRules: 0});
	});

	it("a disabled flag serves its default even with a split rule present (SDK: disabled bypasses all rules)", () => {
		const serving = computeEffectiveServing(flag({enabled: false, rules: [splitRule(100)]}));
		assert.deepStrictEqual(serving, {_tag: "Default", variation: "off", otherRules: 1});
	});

	it("targeting rules are counted alongside the split", () => {
		const serving = computeEffectiveServing(flag({rules: [targetingRule(0), splitRule(100)]}));
		assert.deepStrictEqual(serving, {
			_tag: "Split",
			variation: "on",
			percentage: 100,
			otherRules: 1,
		});
	});

	it("the earliest-priority split wins when several conditions-empty rollout rules exist", () => {
		const serving = computeEffectiveServing(
			flag({rules: [splitRule(25, {priority: 5}), splitRule(75, {priority: 2})]}),
		);
		assert.strictEqual(serving._tag, "Split");
		if (serving._tag !== "Split") return;
		assert.strictEqual(serving.percentage, 75);
	});
});

describe("renderEffectiveServing", () => {
	it("renders a full split as on@100% (split)", () => {
		assert.strictEqual(
			renderEffectiveServing(computeEffectiveServing(flag({rules: [splitRule(100)]}))),
			"on@100% (split)",
		);
	});

	it("renders a partial split as on@N% (ramping)", () => {
		assert.strictEqual(
			renderEffectiveServing(computeEffectiveServing(flag({rules: [splitRule(50)]}))),
			"on@50% (ramping)",
		);
	});

	it("renders no split as <default> (default)", () => {
		assert.strictEqual(renderEffectiveServing(computeEffectiveServing(flag())), "off (default)");
	});

	it("notes targeting rules with a +N suffix", () => {
		assert.strictEqual(
			renderEffectiveServing(
				computeEffectiveServing(flag({rules: [targetingRule(0), splitRule(100)]})),
			),
			"on@100% (split) +1 targeting rules",
		);
	});
});

describe("findNoMatchSplit", () => {
	it("ignores targeting rules and conditions-empty rules with no rollout", () => {
		const noRollout: FlagRule = {conditions: [], priority: 0, serveVariation: "on"};
		assert.isUndefined(findNoMatchSplit([targetingRule(0), noRollout]));
	});
});

describe("planNextState — the serving write model", () => {
	it("Percent mints a no-match split after existing rules; defaultVariation stays the safe value", () => {
		const next = planNextState(flag({rules: [targetingRule(3)]}), {
			_tag: "Percent",
			percentage: 100,
		});
		assert.strictEqual(next.defaultVariation, "off");
		assert.strictEqual(next.rules.length, 2);
		assert.deepStrictEqual(next.rules[1], {
			conditions: [],
			priority: 4,
			serveVariation: "on",
			rollout: {percentage: 100},
		});
	});

	it("Percent replaces an existing split in place, preserving its priority and rollout attribute", () => {
		const existing = splitRule(100, {
			priority: 7,
			rollout: {percentage: 100, attribute: "targetingKey"},
		});
		const next = planNextState(flag({rules: [existing]}), {_tag: "Percent", percentage: 25});
		assert.strictEqual(next.rules.length, 1);
		assert.deepStrictEqual(next.rules[0], {
			conditions: [],
			priority: 7,
			serveVariation: "on",
			rollout: {percentage: 25, attribute: "targetingKey"},
		});
	});

	it("Kill clears the split AND sets defaultVariation off; targeting rules pass through", () => {
		const next = planNextState(
			flag({defaultVariation: "on", rules: [targetingRule(0), splitRule(100)]}),
			{_tag: "Kill"},
		);
		assert.strictEqual(next.defaultVariation, "off");
		assert.deepStrictEqual(next.rules, [targetingRule(0)]);
	});
});

describe("computeServingPlan — changed semantics off the RAW flag", () => {
	it("releasing an unreleased flag is a change", () => {
		const plan = computeServingPlan({
			key: "new-nav",
			env: "prod",
			flag: flag(),
			target: {_tag: "Percent", percentage: 100},
		});
		assert.isTrue(plan.changed);
	});

	it("a flag already split at the target percentage is a confirmed no-op", () => {
		const plan = computeServingPlan({
			key: "new-nav",
			env: "prod",
			flag: flag({rules: [splitRule(100)]}),
			target: {_tag: "Percent", percentage: 100},
		});
		assert.isFalse(plan.changed);
	});

	it("re-ramping an existing split to a different percentage is a change", () => {
		const plan = computeServingPlan({
			key: "new-nav",
			env: "prod",
			flag: flag({rules: [splitRule(100)]}),
			target: {_tag: "Percent", percentage: 50},
		});
		assert.isTrue(plan.changed);
	});

	it("Kill on a split-released flag is a change — the true kill switch (#1726)", () => {
		const plan = computeServingPlan({
			key: "new-nav",
			env: "prod",
			flag: flag({rules: [splitRule(100)]}),
			target: {_tag: "Kill"},
		});
		assert.isTrue(plan.changed);
	});

	it("Kill is a change while defaultVariation is not off, even with no split", () => {
		const plan = computeServingPlan({
			key: "new-nav",
			env: "prod",
			flag: flag({defaultVariation: "on"}),
			target: {_tag: "Kill"},
		});
		assert.isTrue(plan.changed);
	});

	it("Kill on an already-dead flag (no split, default off) is a confirmed no-op", () => {
		const plan = computeServingPlan({
			key: "new-nav",
			env: "prod",
			flag: flag(),
			target: {_tag: "Kill"},
		});
		assert.isFalse(plan.changed);
	});

	it("Kill sees a split lurking on a DISABLED flag as a change (changed is raw, not effective)", () => {
		const plan = computeServingPlan({
			key: "new-nav",
			env: "prod",
			flag: flag({enabled: false, rules: [splitRule(100)]}),
			target: {_tag: "Kill"},
		});
		assert.isTrue(plan.changed);
	});
});

describe("renderServingPlan", () => {
	it("renders a release as a current → target diff", () => {
		const line = renderServingPlan(
			computeServingPlan({
				key: "funnel-readout",
				env: "prod",
				flag: flag(),
				target: {_tag: "Percent", percentage: 100},
			}),
		);
		assert.match(line, /funnel-readout @ prod: off \(default\) → on@100% \(split\)/);
	});

	it("renders a ramp target as on@N% (ramping)", () => {
		const line = renderServingPlan(
			computeServingPlan({
				key: "funnel-readout",
				env: "prod",
				flag: flag(),
				target: {_tag: "Percent", percentage: 50},
			}),
		);
		assert.match(line, /→ on@50% \(ramping\)/);
	});

	it("renders a kill on a split-released flag as split → kill", () => {
		const line = renderServingPlan(
			computeServingPlan({
				key: "funnel-readout",
				env: "prod",
				flag: flag({rules: [splitRule(100)]}),
				target: {_tag: "Kill"},
			}),
		);
		assert.match(line, /on@100% \(split\) → off \(kill: split cleared, default off\)/);
	});

	it("renders a no-op plan as 'already … (no change)'", () => {
		const line = renderServingPlan(
			computeServingPlan({
				key: "beta",
				env: "prod",
				flag: flag({rules: [splitRule(100)]}),
				target: {_tag: "Percent", percentage: 100},
			}),
		);
		assert.match(line, /already on@100% \(split\) \(no change\)/);
	});
});

describe("decodeFlagState — resolve a flag's serving state in an env", () => {
	it("resolves the defaultVariation baseline and the effective serving", () => {
		const state = decodeFlagState("prod", flag({rules: [splitRule(100)]}));
		assert.strictEqual(state.key, "new-nav");
		assert.strictEqual(state.env, "prod");
		assert.strictEqual(state.enabled, true);
		assert.strictEqual(state.defaultVariation, "off");
		assert.strictEqual(state.defaultValue, false);
		assert.deepStrictEqual(state.serving, {
			_tag: "Split",
			variation: "on",
			percentage: 100,
			otherRules: 0,
		});
	});

	it("yields undefined default value when the named variation is absent (a malformed flag)", () => {
		const state = decodeFlagState(
			"prod",
			flag({defaultVariation: "ghost", variations: {on: true}}),
		);
		assert.strictEqual(state.defaultValue, undefined);
	});
});

describe("findAppForEnv — resolve the Flagship app serving an env", () => {
	const apps = [
		{id: "app-prod", name: "phoenix-phoenix-flags-prod-abc123"},
		{id: "app-pr9", name: "phoenix-phoenix-flags-pr-9-deadbe"},
		{id: "app-foreign", name: "some-other-account-app"},
	];

	it("finds the app whose decoded env matches", () => {
		assert.strictEqual(findAppForEnv(apps, "prod")?.id, "app-prod");
		assert.strictEqual(findAppForEnv(apps, "pr-9")?.id, "app-pr9");
	});

	it("returns undefined for an env no app serves (and never matches a foreign app)", () => {
		assert.isUndefined(findAppForEnv(apps, "staging"));
	});
});

describe("FlagEnvNotFound — the typed, legible not-found", () => {
	it("names the unknown env and lists the known ones", () => {
		const err = new FlagEnvNotFound({env: "staging", knownEnvs: ["prod", "pr-9"]});
		assert.match(err.message, /staging/);
		assert.match(err.message, /prod, pr-9/);
	});

	it("points at `flag list` so the failure path guides the operator, not just the up-front help", () => {
		const err = new FlagEnvNotFound({env: "production", knownEnvs: ["prod"]});
		assert.match(err.message, /flag list/);
	});
});

describe("ENV_HELP — the shared --env option help text (#1796)", () => {
	it("names the stable prod env and points at `flag list` for the runtime-open valid set", () => {
		assert.match(ENV_HELP, /prod/);
		assert.match(ENV_HELP, /flag list/);
	});
});

describe("FlagSetTargetInvalid — the flag set usage error", () => {
	it("names the reason and the valid forms", () => {
		const err = new FlagSetTargetInvalid({reason: "no target given"});
		assert.match(err.message, /no target given/);
		assert.match(err.message, /--percent N/);
	});
});

describe("decideLeverGuard — the ADR 0134 agent-invokable lever confirm", () => {
	it("ALLOWS a TTY-less caller (agent/CI shape) — the lever is agent-invokable (ADR 0134)", () => {
		assert.strictEqual(decideLeverGuard({isTTY: false, confirmResponse: "y"})._tag, "Allow");
	});

	it("ALLOWS with no TTY regardless of the confirm line — the confirm is TTY-only ergonomics", () => {
		assert.strictEqual(decideLeverGuard({isTTY: false, confirmResponse: "yes"})._tag, "Allow");
		assert.strictEqual(decideLeverGuard({isTTY: false, confirmResponse: "n"})._tag, "Allow");
		assert.strictEqual(decideLeverGuard({isTTY: false, confirmResponse: undefined})._tag, "Allow");
	});

	it("ALLOWS on a TTY with an affirmative y", () => {
		assert.strictEqual(decideLeverGuard({isTTY: true, confirmResponse: "y"})._tag, "Allow");
	});

	it("ALLOWS on a TTY with an affirmative yes (case/whitespace insensitive)", () => {
		assert.strictEqual(decideLeverGuard({isTTY: true, confirmResponse: "  YES "})._tag, "Allow");
		assert.strictEqual(decideLeverGuard({isTTY: true, confirmResponse: "Y"})._tag, "Allow");
	});

	it("REFUSES on a TTY with an explicit n", () => {
		assert.strictEqual(decideLeverGuard({isTTY: true, confirmResponse: "n"})._tag, "Refuse");
	});

	it("REFUSES on a TTY with empty input (the [y/N] default is deny)", () => {
		assert.strictEqual(decideLeverGuard({isTTY: true, confirmResponse: ""})._tag, "Refuse");
	});

	it("REFUSES on a TTY with EOF / no response (undefined) — the fail-safe direction", () => {
		const decision = decideLeverGuard({isTTY: true, confirmResponse: undefined});
		assert.strictEqual(decision._tag, "Refuse");
		if (decision._tag === "Refuse") {
			assert.match(decision.reason, /affirm/);
		}
	});

	it("REFUSES on a TTY with any non-affirmative token (not a substring match on 'yes')", () => {
		assert.strictEqual(decideLeverGuard({isTTY: true, confirmResponse: "yolo"})._tag, "Refuse");
		assert.strictEqual(decideLeverGuard({isTTY: true, confirmResponse: "y please"})._tag, "Refuse");
	});
});

describe("LeverGuardRefused — the interactive-confirm refusal message", () => {
	it("names the reason and points at the recoverable fix (re-run + affirm the confirm)", () => {
		const err = new LeverGuardRefused({
			reason: "the interactive confirmation was not affirmed (expected y/yes)",
		});
		assert.match(err.message, /the interactive confirmation was not affirmed/);
		assert.match(err.message, /y\/yes/);
	});
});

describe("selectStatesForKey — the per-key slice of flag list", () => {
	const rows = [
		decodeFlagState("prod", flag({key: "new-nav"})),
		decodeFlagState("pr-9", flag({key: "new-nav"})),
		decodeFlagState("prod", flag({key: "beta-banner", enabled: false})),
	];

	it("keeps only the rows for the named key, across every env", () => {
		const slice = selectStatesForKey(rows, "new-nav");
		assert.strictEqual(slice.length, 2);
		assert.deepStrictEqual(slice.map((r) => r.env).sort(), ["pr-9", "prod"]);
	});

	it("returns an empty slice for a key present in no env (the not-found trigger)", () => {
		assert.strictEqual(selectStatesForKey(rows, "ghost").length, 0);
	});
});

describe("distinctKeys — the known-flags hint", () => {
	it("lists each distinct key once, sorted", () => {
		const rows = [
			decodeFlagState("prod", flag({key: "new-nav"})),
			decodeFlagState("pr-9", flag({key: "new-nav"})),
			decodeFlagState("prod", flag({key: "beta-banner"})),
		];
		assert.deepStrictEqual(distinctKeys(rows), ["beta-banner", "new-nav"]);
	});

	it("is empty for no rows", () => {
		assert.deepStrictEqual(distinctKeys([]), []);
	});
});

describe("FlagKeyNotFound — the typed, legible env-less not-found", () => {
	it("names the unknown key and lists the known ones", () => {
		const err = new FlagKeyNotFound({key: "ghost", knownKeys: ["new-nav", "beta-banner"]});
		assert.match(err.message, /ghost/);
		assert.match(err.message, /new-nav, beta-banner/);
	});

	it("renders (none) when no flags exist at all", () => {
		const err = new FlagKeyNotFound({key: "ghost", knownKeys: []});
		assert.match(err.message, /\(none\)/);
	});
});

describe("renderFlagDetail — the single-flag --env view", () => {
	it("shows effective serving for a split-released flag (on, not the lying default)", () => {
		const detail = renderFlagDetail(
			"prod",
			flag({key: "authorship-loop", rules: [splitRule(100)]}),
		);
		assert.match(detail, /flag:\s+authorship-loop/);
		assert.match(detail, /env:\s+prod/);
		assert.match(detail, /enabled:\s+on/);
		assert.match(detail, /serves:\s+on@100% \(split\)/);
		assert.match(detail, /default:\s+off = false/);
		assert.match(detail, /off = false/);
		assert.match(detail, /on = true/);
	});

	it("shows the default as serving for an unreleased flag", () => {
		const detail = renderFlagDetail("pr-7", flag({enabled: false}));
		assert.match(detail, /enabled:\s+off/);
		assert.match(detail, /serves:\s+off \(default\)/);
	});

	it("shows (none) for the default value when the variation is absent (a malformed flag)", () => {
		const detail = renderFlagDetail(
			"prod",
			flag({defaultVariation: "ghost", variations: {on: true}}),
		);
		assert.match(detail, /default:\s+ghost = \(none\)/);
	});
});

describe("renderFlagTable", () => {
	it("reports the empty case", () => {
		assert.strictEqual(renderFlagTable([]), "no flags found");
	});

	it("renders effective serving per row — a split-released flag reads as on, sorted by key then env", () => {
		const table = renderFlagTable([
			decodeFlagState("prod", flag({key: "beta", rules: [splitRule(100)]})),
			decodeFlagState("pr-1", flag({key: "alpha"})),
		]);
		const lines = table.split("\n");
		assert.match(lines[0] ?? "", /FLAG\s+ENV\s+ENABLED\s+SERVES/);
		// alpha sorts before beta
		assert.match(lines[1] ?? "", /^alpha\s+pr-1\s+on\s+off \(default\)/);
		assert.match(lines[2] ?? "", /^beta\s+prod\s+on\s+on@100% \(split\)/);
	});
});
