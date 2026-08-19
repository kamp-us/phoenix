/**
 * The §CP boundary exists in two files while `pipeline-cli` is still in the tree. This reds if they
 * diverge.
 *
 * The const was created (#2761) precisely to make a hand-copy unrepresentable: the boundary used to
 * live in ~10 places behind a byte-compare that missed three vitest fixtures, and a stale fixture
 * ran only in `merge_group` and silently ejected three green PRs (#2673). Porting `codeowners-cp`
 * off `pipeline-cli` (epic #5720) re-opens exactly that hole for as long as both packages exist:
 * `ci.yml`'s `skills` job reads the boundary through `pipeline-cli control-plane-paths` (via
 * `validate-gate-path-drift.sh`), `guard codeowners-cp check` reads it from the copy here, and
 * without this nothing would notice the two drifting apart.
 *
 * **Read as TEXT, deliberately.** Importing the other package's module would invent a dependency
 * edge between two workspace members that have none, and that edge would then have to be unpicked
 * by the child that deletes `pipeline-cli`. A regex over the file's bytes creates nothing to unpick.
 *
 * **This file dies with `packages/pipeline-cli/`.** Once that package is deleted the copy here
 * becomes the single source again and this pin has no second value to compare against — so it is
 * deleted in that commit, not carried forward as a test that skips.
 */
import {existsSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {CONTROL_PLANE_RE} from "./control-plane-re.ts";

const UPSTREAM = fileURLToPath(
	new URL(
		"../../../pipeline-cli/src/tools/control-plane-paths/control-plane-re.ts",
		import.meta.url,
	),
);

/** The declared string literal, unescaped the way the TS parser would. */
const declaredIn = (source: string): string | null => {
	const literal = /export const CONTROL_PLANE_RE\s*=\s*\r?\n?\s*"((?:[^"\\]|\\.)*)"/.exec(source);
	return literal?.[1] === undefined ? null : literal[1].replace(/\\(.)/g, "$1");
};

describe("the §CP boundary copy", () => {
	it("still matches pipeline-cli's, for as long as that package exists", () => {
		// A skip on absence is the point, not a hedge: once that package is deleted there is no second
		// copy to disagree with, and a hard failure there would red a tree that is finally correct.
		if (!existsSync(UPSTREAM)) return;
		const upstream = declaredIn(readFileSync(UPSTREAM, "utf8"));
		expect(upstream).not.toBeNull();
		expect(CONTROL_PLANE_RE).toBe(upstream);
	});

	it("reads its own declaration the same way, so a green above cannot be a broken parse", () => {
		const own = declaredIn(
			readFileSync(fileURLToPath(new URL("./control-plane-re.ts", import.meta.url)), "utf8"),
		);
		expect(own).toBe(CONTROL_PLANE_RE);
	});
});
