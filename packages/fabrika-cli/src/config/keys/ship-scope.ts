/**
 * `shipScope` — whether `ship scope` answers from the repository's main working tree.
 *
 * `mainWorkingTree` says what a shipper's own `ship scope` does when it stands in the main working
 * tree rather than a linked worktree: `refuse` stops on the primary-checkout code with nothing read,
 * `allow` reads the pull request and prints its scope from there.
 *
 * **The shipped default is `refuse`, which is the behaviour before this key existed.** The refusal
 * guards a driver whose checkout another seat can move mid-drive, and a repo that drives lanes from
 * linked worktrees still wants it. A repo that keeps one checkout, or ships by hand, has no second
 * tree to stand in, so it declares `allow` for itself.
 *
 * Never machine-local: the value lifts a refusal, and a local layer over one of those is an untracked
 * way to weaken it.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10034#issuecomment-5974043005
 */

import {isRecord} from "../../io/json.ts";
import type {Decoded, KeyGroup} from "../key-group.ts";

export const SHIP_SCOPE = "shipScope";

/** What a shipper's `ship scope` does in the main working tree: the refusal, or the read. */
export type MainWorkingTree = "refuse" | "allow";

const MAIN_WORKING_TREE_VALUES: ReadonlyArray<MainWorkingTree> = ["refuse", "allow"];

export interface ShipScopeSurface {
	readonly mainWorkingTree: MainWorkingTree;
}

/** The shipped surface — what a repo declaring nothing still gets: the refusal it has today. */
export const SHIPPED_SHIP_SCOPE: ShipScopeSurface = {mainWorkingTree: "refuse"};

/** The declaration that lifts the refusal, as a repo writes it — what the refusal itself names. */
export const SHIP_SCOPE_ALLOW_DECLARATION = `"${SHIP_SCOPE}": {"mainWorkingTree": "allow"}`;

const named = (path: string): string => `\`${SHIP_SCOPE}\`'s \`${path}\``;

const KNOWN: ReadonlyArray<string> = ["mainWorkingTree"];

const decodeMainWorkingTree = (raw: unknown): Decoded<MainWorkingTree> =>
	typeof raw === "string" &&
	(MAIN_WORKING_TREE_VALUES as ReadonlyArray<string>).includes(raw.trim())
		? {_tag: "Value", value: raw.trim() as MainWorkingTree}
		: {
				_tag: "Malformed",
				reason: `${named("mainWorkingTree")} is not one of ${MAIN_WORKING_TREE_VALUES.join(", ")}`,
			};

const decode = (raw: unknown): Decoded<ShipScopeSurface> => {
	if (!isRecord(raw)) return {_tag: "Malformed", reason: `\`${SHIP_SCOPE}\` is not an object`};
	const stray = Object.keys(raw).find((key) => !KNOWN.includes(key));
	if (stray !== undefined) {
		return {
			_tag: "Malformed",
			reason: `${named(stray)} is not a ship-scope setting — one of ${KNOWN.join(", ")}`,
		};
	}

	const mainWorkingTree =
		raw.mainWorkingTree === undefined
			? ({_tag: "Value", value: SHIPPED_SHIP_SCOPE.mainWorkingTree} as const)
			: decodeMainWorkingTree(raw.mainWorkingTree);
	if (mainWorkingTree._tag === "Malformed") return mainWorkingTree;

	return {_tag: "Value", value: {mainWorkingTree: mainWorkingTree.value}};
};

export const shipScopeKey: KeyGroup<ShipScopeSurface> = {
	key: SHIP_SCOPE,
	shippedDefault: SHIPPED_SHIP_SCOPE,
	decode,
	jsonSchema: {
		type: "object",
		description: "Whether `ship scope` answers from the repository's main working tree.",
		properties: {
			mainWorkingTree: {
				type: "string",
				description:
					"What a shipper's own `ship scope` does when it stands in the main working tree: `refuse` (exit 33 with nothing read — the shipped default, and the behaviour before this key) or `allow` (read the pull request and print its scope from there, for a repo that keeps one checkout or ships by hand).",
				enum: ["refuse", "allow"],
			},
		},
		additionalProperties: false,
	},
};
