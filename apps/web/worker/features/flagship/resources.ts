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
import {PANO_DRAFT_SAVE} from "../../../src/flags/keys.ts";

/**
 * The Cloudflare Flagship app — the container the worker's feature flags live in
 * (epic #488). Alchemy provisions it on deploy and assigns the `appId`; there is
 * no dashboard step. The worker `bind()`s it in init (see `Flagship.ts`) to
 * resolve a typed Effect-native `FlagshipClient`.
 */
export const Flagship = Cloudflare.FlagshipApp("phoenix_flags", {});

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
	Cloudflare.FlagshipFlag("phoenix_flags_targeting_demo", {
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

export {PANO_DRAFT_SAVE};

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
	Cloudflare.FlagshipFlag("pano_draft_save", {appId, ...PANO_DRAFT_SAVE_FLAG});
