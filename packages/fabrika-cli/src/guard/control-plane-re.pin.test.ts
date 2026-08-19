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
 *
 * **One branch is compared with, not against: `^packages/fabrika-cli/src/ci/` (ADR 0299, #6206).**
 * It landed on `main` in `pipeline-cli`'s copy while this epic's assembly branch was already cut, so
 * on the branch the two copies disagree by exactly that clause until the tail merges `main` forward.
 * Both sides are normalized by dropping it before the byte-compare, and the copy here is asserted to
 * carry it on its own line below — so every OTHER branch stays pinned byte for byte, and the clause
 * itself is still checked, just not against a copy that has not caught up. Once the merge lands both
 * sides carry it, the normalization is a no-op, and the compare is unchanged.
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

/** The ADR 0299 clause, in the runtime (unescaped) form both copies carry it in. */
const FABRIKA_CI_BRANCH = "^packages/fabrika-cli/src/ci/";

/** The boundary with the one merge-lagged branch removed, so the rest compares byte for byte. */
const withoutFabrikaCi = (value: string): string => value.split(`${FABRIKA_CI_BRANCH}|`).join("");

describe("the §CP boundary copy", () => {
	it("still matches pipeline-cli's, for as long as that package exists", () => {
		// A skip on absence is the point, not a hedge: once that package is deleted there is no second
		// copy to disagree with, and a hard failure there would red a tree that is finally correct.
		if (!existsSync(UPSTREAM)) return;
		const upstream = declaredIn(readFileSync(UPSTREAM, "utf8"));
		if (upstream === null) throw new Error(`${UPSTREAM} declares no CONTROL_PLANE_RE literal`);
		expect(withoutFabrikaCi(CONTROL_PLANE_RE)).toBe(withoutFabrikaCi(upstream));
	});

	it("carries the ADR 0299 fabrika-cli clause, whether or not upstream has caught up", () => {
		expect(CONTROL_PLANE_RE).toContain(`${FABRIKA_CI_BRANCH}|`);
	});

	it("reads its own declaration the same way, so a green above cannot be a broken parse", () => {
		const own = declaredIn(
			readFileSync(fileURLToPath(new URL("./control-plane-re.ts", import.meta.url)), "utf8"),
		);
		expect(own).toBe(CONTROL_PLANE_RE);
	});
});
