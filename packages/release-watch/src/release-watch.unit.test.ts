import {assert, describe, it} from "@effect/vitest";
import {issueText, type OpenIssue, planReleaseWatch, watchMarker} from "./release-watch.ts";

const tea = (spec: string) => ({name: "@demlik/tea", spec});

const standing = (number: number, pinned: string, latest: string): OpenIssue => ({
	number,
	...issueText("@demlik/tea", pinned, latest),
});

describe("planReleaseWatch", () => {
	it("writes nothing when the pin equals latest", () => {
		const [verdict] = planReleaseWatch([{pin: tea("0.19.0"), latest: "0.19.0"}], []);
		assert.deepStrictEqual(verdict, {
			_tag: "Current",
			name: "@demlik/tea",
			pinned: "0.19.0",
			latest: "0.19.0",
			reason: "same",
		});
	});

	it("files an issue naming the package, the pin and latest when latest is newer", () => {
		const [verdict] = planReleaseWatch([{pin: tea("0.19.0"), latest: "0.20.0"}], []);
		assert.strictEqual(verdict?._tag, "File");
		if (verdict?._tag !== "File") return;
		assert.include(verdict.issue.title, "@demlik/tea");
		assert.include(verdict.issue.body, "`0.19.0`");
		assert.include(verdict.issue.body, "`0.20.0`");
		assert.include(verdict.issue.body, watchMarker("@demlik/tea"));
	});

	it("compares by semver, so 0.10.0 is newer than 0.9.0", () => {
		const [verdict] = planReleaseWatch([{pin: tea("0.9.0"), latest: "0.10.0"}], []);
		assert.strictEqual(verdict?._tag, "File");
	});

	it("updates the open issue for that package instead of filing a second one", () => {
		const [verdict] = planReleaseWatch(
			[{pin: tea("0.19.0"), latest: "0.21.0"}],
			[standing(42, "0.19.0", "0.20.0")],
		);
		assert.strictEqual(verdict?._tag, "Update");
		if (verdict?._tag !== "Update") return;
		assert.strictEqual(verdict.issueNumber, 42);
		assert.include(verdict.issue.body, "`0.21.0`");
	});

	it("writes nothing when the open issue already says exactly this", () => {
		const [verdict] = planReleaseWatch(
			[{pin: tea("0.19.0"), latest: "0.20.0"}],
			[standing(42, "0.19.0", "0.20.0")],
		);
		assert.deepStrictEqual(verdict, {
			_tag: "AlreadyFiled",
			name: "@demlik/tea",
			pinned: "0.19.0",
			latest: "0.20.0",
			issueNumber: 42,
		});
	});

	it("ignores an open issue that carries another package's marker", () => {
		const other: OpenIssue = {number: 7, ...issueText("@demlik/other", "1.0.0", "1.1.0")};
		const [verdict] = planReleaseWatch([{pin: tea("0.19.0"), latest: "0.20.0"}], [other]);
		assert.strictEqual(verdict?._tag, "File");
	});

	it("writes nothing when latest is older than the pin", () => {
		const [verdict] = planReleaseWatch([{pin: tea("0.19.0"), latest: "0.18.0"}], []);
		assert.strictEqual(verdict?._tag === "Current" && verdict.reason, "pin-ahead");
	});

	it("writes nothing when latest is a prerelease, newer or of the pin itself", () => {
		const verdicts = planReleaseWatch(
			[
				{pin: tea("0.19.0"), latest: "0.20.0-beta.1"},
				{pin: tea("0.19.0"), latest: "0.19.0-rc.1"},
			],
			[],
		);
		for (const verdict of verdicts) {
			assert.strictEqual(verdict._tag === "Current" && verdict.reason, "prerelease-latest");
		}
	});

	it("does not compare a catalog spec that is a range rather than one version", () => {
		const [verdict] = planReleaseWatch([{pin: tea("^0.19.0"), latest: "0.20.0"}], []);
		assert.deepStrictEqual(verdict, {_tag: "Unpinned", name: "@demlik/tea", spec: "^0.19.0"});
	});
});
