/**
 * The starting `.fabrika.jsonc` `status bootstrap fabrika-config` writes into a repo that has none.
 *
 * It names the four keys whose shipped default stops or narrows a lane, each **at that shipped
 * default**: the key names and values are read off the key modules, so the file states what the repo
 * already runs on and writing it changes no verb's answer. What it adds is the comments: which verb
 * a key holds back, and the shape of a first value.
 *
 * The text is fixed here for the reason a line surface's block is: a caller supplying it would let
 * two repos start from two different files.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10041#issuecomment-5983080892
 */
import type {KeyGroup} from "../config/key-group.ts";
import {CI, SHIPPED_CI} from "../config/keys/ci.ts";
import {codeValidatorsKey} from "../config/keys/code-validators.ts";
import {dependencyReconcilerKey} from "../config/keys/dependency-reconciler.ts";
import {uiSurfacesKey} from "../config/keys/ui-surfaces.ts";

const row = (key: string, value: unknown): string => `"${key}": ${JSON.stringify(value)}`;

/** One key at its shipped default, in the shape the file spells it rather than the decoded one. */
const shipped = <A>({key, shippedDefault, render}: KeyGroup<A>): string =>
	row(key, render === undefined ? shippedDefault : render(shippedDefault));

export const STARTER_CONFIG = `// fabrika's config for this repo. Every key is optional: one you leave out takes its shipped default.
// The keys below are written at their shipped defaults, so this file changes nothing until you edit it.
// \`fabrika status settings\` prints what every key resolves to and where the value came from.
{
	// The commands that compile and lint this repo's code, for example
	// [{"command": ["pnpm", "typecheck"]}, {"command": ["pnpm", "lint"]}] with your own script names.
	// While this list is empty, \`fabrika build check --surface code\` and \`fabrika lane integrate\` refuse.
	${shipped(codeValidatorsKey)},

	// The command that installs what the lockfile pins, for example
	// {"command": ["pnpm", "install", "--frozen-lockfile"]}.
	// No verb refuses without it. \`fabrika lane integrate\` skips the install, so a change that moves
	// the lockfile is validated against the old install and can fail there.
	${shipped(dependencyReconcilerKey)},

	// One row per app this repo renders, for example
	// [{"name": "web", "prefix": "src/", "mount": "/", "command": "pnpm dev --port {{port}}"}].
	// While this list is empty, \`fabrika ui render\` and \`fabrika ui evidence\` refuse, and a change to
	// a screen is reviewed as text only. Leave it empty for a repo that renders nothing.
	${shipped(uiSurfacesKey)},

	"${CI}": {
		// What a repo with no workflow of its own in .github/workflows/ gets: "refuse" or "degrade".
		// Under "refuse", \`fabrika review ci\` and \`fabrika ship checks\` refuse in such a repo.
		// Write "degrade" only for a repo that runs no Actions on purpose.
		${row("noProducer", SHIPPED_CI.noProducer)}
	}
}
`;
