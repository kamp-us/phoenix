/**
 * The Flagship flag-IaC surface — the `Flagship` app and every flag declaration,
 * homed beside their evaluator (`Flags.ts`/`Flagship.ts`) instead of in
 * `db/resources.ts` (ADR 0081, epic #488). The alchemy stack (`alchemy.run.ts`)
 * `bind()`s the app and yields the flag factories; the worker `bind()`s the app
 * in init. Declared in-stack (not on the Flagship dashboard) so each rule is
 * reproducible and reviewable — see
 * [.patterns/feature-flags-targeting.md](../../../../../.patterns/feature-flags-targeting.md)
 * for which flags are IaC vs dashboard-managed and the sanctioned rule taxonomy.
 */
import type {Input} from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import {
	PANO_DRAFT_SAVE,
	PHOENIX_AUTHORSHIP_LOOP,
	PHOENIX_FUNNEL_READOUT,
} from "../../../src/flags/keys.ts";
import {AUDIT_ENVIRONMENT} from "../../environment.ts";

/**
 * The Cloudflare Flagship app — the container the worker's feature flags live in
 * (epic #488). Alchemy provisions it on deploy and assigns the `appId`; there is
 * no dashboard step. The worker `bind()`s it in init (see `Flagship.ts`) to
 * resolve a typed Effect-native `FlagshipClient`.
 */
export const Flagship = Cloudflare.Flagship.App("phoenix_flags", {});

/**
 * The IaC-declared demo flag for targeting + percentage rollout (epic #488,
 * #511).
 *
 * Two rules, evaluated in ascending `priority` (first match wins):
 *   1. an attribute-targeting rule — any request whose `roles` carries the
 *      `internal` role gets `on` outright (the named-subset release);
 *   2. a consistent-hash percentage rollout — 25% of the remaining users, bucketed
 *      stably on `targetingKey` (the request's `userId`), get `on`.
 * Everyone else falls through to `defaultVariation: "off"`.
 *
 * `appId` is the app's server-generated id, available only once the app resource
 * is yielded in the stack — hence a factory the stack calls with `app.appId`
 * (an alchemy `Input<string>`/`Output`, resolved at deploy), not a module-scope
 * constant (the app attribute isn't resolved at import).
 */
export const DEMO_TARGETING_FLAG_KEY = "phoenix-flags-targeting-demo";
export const DEMO_TARGETING_INTERNAL_ROLE = "internal";

export const demoTargetingFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("phoenix_flags_targeting_demo", {
		appId,
		key: DEMO_TARGETING_FLAG_KEY,
		description:
			"Epic #488/#511 demo: internal-role targeting + 25% consistent-hash rollout on userId.",
		defaultVariation: "off",
		variations: {off: false, on: true},
		rules: [
			{
				priority: 1,
				conditions: [
					{
						attribute: "roles",
						operator: "contains",
						value: `|${DEMO_TARGETING_INTERNAL_ROLE}|`,
					},
				],
				serveVariation: "on",
			},
			{
				priority: 2,
				conditions: [],
				serveVariation: "on",
				rollout: {percentage: 25},
			},
		],
	});

export {PANO_DRAFT_SAVE, PHOENIX_AUTHORSHIP_LOOP, PHOENIX_FUNNEL_READOUT};

/**
 * The pano `taslak` (draft-save) dark-ship flag config (#746) — the feature-flag
 * substrate's first real consumer (ADR 0091/0093). Default-OFF so it reaches
 * production dark; flipping it on is the human release act (ADR 0083).
 *
 * Exported as a plain object so the default-=-safe-state invariant is
 * unit-inspectable WITHOUT constructing the alchemy resource (#746): the factory
 * spreads it into `FlagshipFlag`; the test asserts `defaultVariation`/
 * `variations.off` here, the same record the deploy ships.
 *
 * Per-flag metadata (the IaC ownership record `feature-flags-agent-workflow.md`
 * asks for):
 *   - owner:           pano
 *   - originating:     #746 (epic: feature-flag substrate, #488)
 *   - removal trigger: once draft-save graduates to 100% on, retire the flag and
 *                      delete its gate (the dark-ship is over).
 */
export const PANO_DRAFT_SAVE_FLAG = {
	key: PANO_DRAFT_SAVE,
	description:
		"pano taslak (draft-save) dark-ship (#746). owner: pano. removal: retire once on at 100%.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

/**
 * No targeting rules — a plain boolean kill-switch. `appId` is resolved at deploy
 * (see `demoTargetingFlag` for why it's a factory, not a module constant).
 */
export const panoDraftSaveFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("pano_draft_save", {appId, ...PANO_DRAFT_SAVE_FLAG});

/**
 * The earned-authorship loop (çaylak→yazar) dark-ship flag config (#1204, epic
 * #1202). The SINGLE seam the whole authorship-loop epic gates behind: each
 * subsequent child wraps its surface (sözlük/pano/pasaport resolvers + the UI)
 * behind this one key rather than inventing its own gate. Default-OFF so the loop
 * reaches production dark — with it off, the product behaves exactly as today
 * (public read, existing member|moderator semantics); flipping it on is the human
 * release act (ADR 0083). This child is the contract/seam only — it gates no
 * existing surface (the loop's surfaces don't exist yet), it just provides the
 * readable key.
 *
 * Exported as a plain object so the default-=-safe-state invariant is
 * unit-inspectable WITHOUT constructing the alchemy resource (mirrors
 * `PANO_DRAFT_SAVE_FLAG`, #746): the factory spreads it into `FlagshipFlag`; the
 * test asserts `defaultVariation`/`variations.off` on this same record.
 *
 * Per-flag metadata (the IaC ownership record the lifecycle pattern asks for —
 * see `.patterns/feature-flags-schema-lifecycle.md`):
 *   - owner:           sozluk (the çaylak→yazar tier system's home product)
 *   - originating:     #1204 (epic: earned-authorship loop, #1202)
 *   - removal trigger: once the authorship loop is on at 100% and stable for one
 *                      release, retire the flag and inline the now-permanent path.
 */
export const AUTHORSHIP_LOOP_FLAG = {
	key: PHOENIX_AUTHORSHIP_LOOP,
	description:
		"earned-authorship loop (çaylak→yazar) dark-ship (#1204, epic #1202). owner: sozluk. removal: retire once on at 100% and stable.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

/**
 * The environment-targeting force-on rule for the authorship loop (#1511, epic
 * #1510 — the rite-audit harness gating prerequisite). The dedicated audit stage's
 * non-interactive force-on seam: a single rule that serves `on` IFF the request's
 * `environment` attribute equals the `audit` deploy class (sourced from the
 * `ENVIRONMENT` config by `makeRequestFlagsContext`, mapped from the `audit` stage
 * by `environmentForStage`). So a stage deployed with `ENVIRONMENT=audit` reads the
 * flag on with zero human interaction.
 *
 * Prod-never is STRUCTURAL, not a convention: a `production` deploy carries
 * `environment: "production"`, and `equals "audit"` cannot match it; the only stage
 * that maps to `audit` is the dedicated `audit` stage (`environmentForStage` maps
 * `prod`→`production`, every other stage→`preview`), so no env value or config can
 * make this rule fire in production. Per-PR `preview` stages carry
 * `environment: "preview"` and never match either. The flag's `defaultVariation`
 * stays `off`, so everything outside the audit class is the unchanged dark-ship safe
 * state (ADR 0083) — this rule adds ZERO production behavior change.
 *
 * Single-sourced as a typed constant so the audit-only / prod-never invariant is
 * unit-inspectable (`authorship-loop-force-on.invariant.test.ts`) off the SAME
 * record the factory ships. The `: FlagshipFlagRule[]` annotation contextually types
 * the `equals` operator literal against the operator union (per
 * `.patterns/feature-flags-targeting.md`'s sanctioned taxonomy).
 */
export const AUTHORSHIP_LOOP_RULES: Cloudflare.Flagship.FlagRule[] = [
	{
		priority: 1,
		conditions: [{attribute: "environment", operator: "equals", value: AUDIT_ENVIRONMENT}],
		serveVariation: "on",
	},
];

/**
 * The audit-only force-on rule (`AUTHORSHIP_LOOP_RULES`) layered over the default-off
 * dark-ship config. `appId` is resolved at deploy (see `demoTargetingFlag` for why
 * it's a factory, not a module constant).
 */
export const authorshipLoopFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("phoenix_authorship_loop", {
		appId,
		...AUTHORSHIP_LOOP_FLAG,
		rules: AUTHORSHIP_LOOP_RULES,
	});

/**
 * The conversion-funnel readout dark-ship flag config (#1589) — the founder/mod
 * tier-count surface gates behind this key. Default-OFF so the readout reaches
 * production dark; flipping it on is the human release act (ADR 0083). Its own key
 * (not `phoenix-authorship-loop`) so the funnel destination has an independent
 * lifecycle.
 *
 * Exported as a plain object so the default-=-safe-state invariant is
 * unit-inspectable WITHOUT constructing the alchemy resource (mirrors
 * `PANO_DRAFT_SAVE_FLAG`, #746).
 *
 * Per-flag metadata (the IaC ownership record `feature-flags-schema-lifecycle.md`
 * asks for):
 *   - owner:           funnel (the conversion-readout founder/mod surface)
 *   - originating:     #1589 (the çaylak→yazar conversion readout)
 *   - removal trigger: once the funnel readout graduates to on at 100% and stable
 *                      for one release, retire the flag and inline the surface.
 */
export const FUNNEL_READOUT_FLAG = {
	key: PHOENIX_FUNNEL_READOUT,
	description:
		"conversion-funnel readout dark-ship (#1589). owner: funnel. removal: retire once on at 100% and stable.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

/**
 * A plain boolean kill-switch, no targeting rules. `appId` is resolved at deploy
 * (see `demoTargetingFlag` for why it's a factory, not a module constant).
 */
export const funnelReadoutFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("phoenix_funnel_readout", {appId, ...FUNNEL_READOUT_FLAG});
