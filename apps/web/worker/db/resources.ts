/**
 * Resource declarations shared between the alchemy stack (`alchemy.run.ts`) and
 * the worker (`worker/index.ts`): the stack ensures the resource exists before
 * deploy, the worker `bind()`s it at runtime. Replaces the `wrangler.jsonc`
 * `d1_databases` / `migrations_dir` keys (ADR 0026).
 */
import type {Input} from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import {PANO_DRAFT_SAVE} from "../../src/flags/keys.ts";

/**
 * The single D1 database — canonical store for every product table (ADR 0009,
 * d1-direct). `migrationsTable: "drizzle_migrations"` matches drizzle-kit's own
 * table name so the applied-set bookkeeping stays compatible; alchemy applies
 * pending migrations on deploy.
 */
export const PhoenixDb = Cloudflare.D1Database("phoenix_db", {
	migrationsDir: "./worker/db/drizzle/migrations",
	migrationsTable: "drizzle_migrations",
});

/**
 * The Cloudflare Flagship app — the container the worker's feature flags live in
 * (epic #488). Alchemy provisions it on deploy and assigns the `appId`; there is
 * no dashboard step. The worker `bind()`s it in init (see `features/flagship/`)
 * to resolve a typed Effect-native `FlagshipClient`. Individual flags are not
 * declared here — they land in later children of the epic.
 */
export const Flagship = Cloudflare.FlagshipApp("phoenix_flags", {});

/**
 * The IaC-declared demo flag for targeting + percentage rollout (epic #488,
 * #511). Declared in-stack (not on the Flagship dashboard) so the rule is
 * reproducible and reviewable — see
 * [.patterns/feature-flags-targeting.md](../../../../.patterns/feature-flags-targeting.md)
 * for which flags are IaC vs dashboard-managed and the sanctioned rule taxonomy.
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

/**
 * The pano `taslak` (draft-save) dark-ship flag (#746) — the feature-flag
 * substrate's first real consumer (ADR 0091/0093). Declared in-stack default-OFF
 * so it reaches production dark; flipping it on is the human release act (ADR 0083).
 *
 * Per-flag metadata (the IaC ownership record `feature-flags-agent-workflow.md`
 * asks for):
 *   - owner:           pano
 *   - originating:     #746 (epic: feature-flag substrate, #488)
 *   - removal trigger: once draft-save graduates to 100% on, retire the flag and
 *                      delete its gate (the dark-ship is over).
 *
 * No targeting rules — a plain boolean kill-switch. `appId` is resolved at deploy
 * (see `demoTargetingFlag` for why it's a factory, not a module constant).
 */
/**
 * The flag config, exported as a plain object so the default-=-safe-state invariant
 * is unit-inspectable WITHOUT constructing the alchemy resource (#746). The factory
 * spreads it into `FlagshipFlag`; the test asserts `defaultVariation`/`variations.off`
 * here, the same record the deploy ships.
 */
export {PANO_DRAFT_SAVE};

export const PANO_DRAFT_SAVE_FLAG = {
	key: PANO_DRAFT_SAVE,
	description:
		"pano taslak (draft-save) dark-ship (#746). owner: pano. removal: retire once on at 100%.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

export const panoDraftSaveFlag = (appId: Input<string>) =>
	Cloudflare.FlagshipFlag("pano_draft_save", {appId, ...PANO_DRAFT_SAVE_FLAG});
