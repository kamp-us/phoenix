/**
 * The çaylak marker's surface coverage (#6427, epic #4306): every place the #6425 wire field
 * is delivered renders it, and renders it through `SandboxMarker` rather than a hand-rolled
 * ternary — a new surface that selects the field but forgets the badge is the drift this
 * pins. A source scan, like `badge-variant-contract`: it holds even for the surfaces whose
 * live render needs a fate transport to mount.
 */
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";

const sourceRoot = join(import.meta.dirname, "../..");

/**
 * The pano feed row, post detail, comment node, sözlük entry — plus the profile
 * contribution row, the fifth surface #6464 brought onto the split.
 */
const surfaces = [
	"components/pano/PanoPostCard.tsx",
	"components/pano/PanoPostHeader.tsx",
	"components/pano/CommentTreeNode.tsx",
	"components/sozluk/DefinitionCard.tsx",
	"components/profile/ContributionRow.tsx",
];

const read = (path: string) => readFileSync(join(sourceRoot, path), "utf8");

describe("çaylak marker surface coverage (#6427)", () => {
	it("selects the #6425 wire field on every surface's view", () => {
		const missing = surfaces.filter((path) => !/\bsandboxedInPlace:\s*true\b/.test(read(path)));
		expect(missing).toEqual([]);
	});

	it("renders the marker through SandboxMarker on every surface", () => {
		const missing = surfaces.filter((path) => !/<SandboxMarker\b/.test(read(path)));
		expect(missing).toEqual([]);
	});

	it("leaves no surface picking the badges itself", () => {
		const offenders = surfaces.filter((path) => /<(ReviewBadge|CaylakBadge)\b/.test(read(path)));
		expect(offenders).toEqual([]);
	});
});
