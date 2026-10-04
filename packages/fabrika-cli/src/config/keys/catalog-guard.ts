/**
 * `catalogGuard` — whether this repo runs `guard catalog-guard check`.
 *
 * `catalog-guard` enforces one convention: every dependency in a workspace `package.json` comes
 * from the pnpm `catalog:` or a `workspace:` reference. A repo that never adopted a pnpm catalog
 * reds on it in every `build check`, on dependencies no lane touched. This key is that repo's way
 * out: `off` and the guard judges no manifest.
 *
 * The guard reads the key and nothing else decides. It never probes `pnpm-workspace.yaml` to work
 * out whether the rule applies, so a repo that does use a catalog may still turn the guard off.
 *
 * **It ships `on`**, which is the guard's behaviour before the key existed, and the only default
 * under which an adopter ever sees the failure message that names this key.
 *
 * **Declared and absent stay apart.** Only a declared `off` turns the guard off. An absent file or
 * key resolves to `on`, so nobody turns it off by writing no config, and a value that does not
 * decode or a file nobody could read is the guard's UNKNOWN, never `off`.
 *
 * The key governs `catalog-guard` alone. It is not a list of guards and no other guard reads it.
 *
 * Not machine-local: a key that turns a gate off in an untracked file is a change no review reads.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9639#issuecomment-5852554214
 * @ruling https://github.com/kamp-us/phoenix/issues/10477#issuecomment-5983523126
 */

import type {Decoded, KeyGroup} from "../key-group.ts";

export const CATALOG_GUARD = "catalogGuard";

/** Whether `catalog-guard` judges this repo's manifests. */
export type CatalogGuardSwitch = "on" | "off";

const SWITCH_VALUES: ReadonlyArray<CatalogGuardSwitch> = ["on", "off"];

/** What a repo declaring nothing gets: the guard runs. */
export const SHIPPED_CATALOG_GUARD: CatalogGuardSwitch = "on";

const decode = (raw: unknown): Decoded<CatalogGuardSwitch> =>
	typeof raw === "string" && (SWITCH_VALUES as ReadonlyArray<string>).includes(raw)
		? {_tag: "Value", value: raw as CatalogGuardSwitch}
		: {
				_tag: "Malformed",
				reason: `\`${CATALOG_GUARD}\` is not one of ${SWITCH_VALUES.map((v) => `"${v}"`).join(", ")}`,
			};

export const catalogGuardKey: KeyGroup<CatalogGuardSwitch> = {
	key: CATALOG_GUARD,
	shippedDefault: SHIPPED_CATALOG_GUARD,
	decode,
	jsonSchema: {
		type: "string",
		description:
			"Whether `fabrika guard catalog-guard check` judges this repo: `on` (the shipped default — every dependency in a workspace package.json must be a `catalog:` or `workspace:` reference) or `off` (the guard judges no manifest, exits 0 saying so, and `build check` lists it under `skipped`). Turn it off in a repo that does not use a pnpm catalog. It governs catalog-guard and no other guard.",
		enum: ["on", "off"],
	},
};
