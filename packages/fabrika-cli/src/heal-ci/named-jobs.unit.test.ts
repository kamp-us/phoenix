import {describe, expect, it} from "vitest";
import {parse} from "yaml";
import {displayNameOf, isFailedJob, tieKeys} from "./named-jobs.ts";

const WORKFLOW = parse(
	[
		"jobs:",
		"  e2e: {runs-on: ubuntu-latest}",
		"  packages-tests:",
		"    name: packages unit tests",
		"  shard:",
		"    name: shard ${{ matrix.n }}",
		"  lint:",
		"    strategy: {matrix: {node: [22, 24]}}",
		"  reuse:",
		"    uses: ./.github/workflows/other.yml",
		"  dup-a:",
		"    name: same",
		"  dup-b:",
		"    name: same",
	].join("\n"),
);

const job = (id: number, name: string, conclusion: string | null = "failure") => ({
	id,
	name,
	status: "completed",
	conclusion,
});

describe("displayNameOf — the display name GitHub gives a job key", () => {
	it("is the key when the job declares no name, and the literal name when it does", () => {
		expect(displayNameOf(WORKFLOW, "e2e")).toEqual({_tag: "Named", name: "e2e"});
		expect(displayNameOf(WORKFLOW, "packages-tests")).toEqual({
			_tag: "Named",
			name: "packages unit tests",
		});
	});

	it("refuses every name the platform composes at run time, rather than guessing it", () => {
		for (const key of ["shard", "lint", "reuse", "absent"]) {
			expect(displayNameOf(WORKFLOW, key)._tag).toBe("Untied");
		}
		expect(displayNameOf(null, "e2e")._tag).toBe("Untied");
	});
});

describe("tieKeys — exactly one job of the run, or no tie", () => {
	it("ties a key through its display name and leaves an ambiguous or missing one untied", () => {
		const jobs = [job(1, "packages unit tests"), job(2, "same"), job(3, "same")];
		const {tied, untied} = tieKeys(["packages-tests", "dup-a", "e2e"], WORKFLOW, jobs);
		expect(tied).toEqual([{key: "packages-tests", job: jobs[0]}]);
		expect(untied).toEqual([
			{key: "dup-a", reason: '2 jobs named "same" ran in the roll-up\'s workflow run'},
			{key: "e2e", reason: 'no job named "e2e" ran in the roll-up\'s workflow run'},
		]);
	});
});

describe("isFailedJob", () => {
	it("is a completed job that neither passed nor was skipped", () => {
		expect(isFailedJob(job(1, "a", "failure"))).toBe(true);
		expect(isFailedJob(job(1, "a", "cancelled"))).toBe(true);
		expect(isFailedJob(job(1, "a", "skipped"))).toBe(false);
		expect(isFailedJob(job(1, "a", "success"))).toBe(false);
	});
});
