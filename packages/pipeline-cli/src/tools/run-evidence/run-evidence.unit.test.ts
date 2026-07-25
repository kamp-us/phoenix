import {assert, describe, it} from "@effect/vitest";
import {
	classifyBundle,
	type ManifestSummary,
	type Observation,
	type Probe,
	type ProducerRun,
	renderReportLine,
	resolveProducerRun,
} from "./run-evidence.ts";

const HEAD = "05de8f09aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "c7e6549cbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const run = (over: Partial<ProducerRun> = {}): ProducerRun => ({
	id: 30144746535,
	headSha: HEAD,
	status: "completed",
	conclusion: "success",
	createdAt: "2026-07-25T04:57:44Z",
	...over,
});

const manifest = (over: Partial<ManifestSummary> = {}): ManifestSummary => ({
	commit: HEAD,
	schemaVersion: 1,
	checks: [
		{name: "unit", status: "pass"},
		{name: "bundle-node-core-free", status: "pass"},
	],
	tests: {total: 2362, passed: 2362, failed: 0, skipped: 0, failingSuites: []},
	...over,
});

const probe = (observation: Observation, runsAtHead: number | null = 1): Probe => ({
	queriedSha: HEAD,
	runsAtHead,
	observation,
});

describe("resolveProducerRun — only an EXACT head match is evidence for this commit", () => {
	it("ignores a run from an earlier push", () => {
		const resolved = resolveProducerRun([run({id: 1, headSha: OTHER})], HEAD);
		assert.strictEqual(resolved, null);
	});

	it("takes the newest run at the head, breaking a created_at tie on the run id", () => {
		const resolved = resolveProducerRun(
			[
				run({id: 1, createdAt: "2026-07-25T03:00:00Z"}),
				run({id: 3, createdAt: "2026-07-25T05:00:00Z"}),
				run({id: 9, createdAt: "2026-07-25T05:00:00Z"}),
				run({id: 7, headSha: OTHER, createdAt: "2026-07-25T06:00:00Z"}),
			],
			HEAD,
		);
		assert.strictEqual(resolved?.id, 9);
	});
});

// The regression the tool exists for: three non-success paths that a binary lookup narrated
// identically as "absent for this head SHA" (#3991, PRs #3913 and #3951).
describe("classifyBundle — PRESENT", () => {
	it("a validated, head-bound manifest is present, and carries the run + artifact ids", () => {
		const reading = classifyBundle(
			probe({_tag: "ManifestRead", run: run(), artifactId: 8615655601, manifest: manifest()}),
		);
		assert.strictEqual(reading.state, "present");
		assert.strictEqual(reading.reason, "validated");
		assert.strictEqual(reading.evidence.runId, 30144746535);
		assert.strictEqual(reading.evidence.artifactId, 8615655601);
		assert.strictEqual(reading.manifest?.tests.passed, 2362);
	});

	it("the report line cites the run, the artifact, the checks and the test counts", () => {
		const line = renderReportLine(
			classifyBundle(
				probe({_tag: "ManifestRead", run: run(), artifactId: 8615655601, manifest: manifest()}),
			),
		);
		assert.include(line, "PRESENT");
		assert.include(line, "producer run 30144746535");
		assert.include(line, "artifact 8615655601");
		assert.include(line, "checks 2/2 pass");
		assert.include(line, "tests 2362/2362 passed");
	});
});

describe("classifyBundle — PENDING is never reported as ABSENT", () => {
	// The #3913 instance: the verdict posted 11 minutes BEFORE the producer's only run at that head
	// was created. Zero runs at a head a producer serves is "not published yet", not "missing".
	it("a producer that has not run at this head yet is pending", () => {
		const reading = classifyBundle(probe({_tag: "NoRunAtHead"}, 0));
		assert.strictEqual(reading.state, "pending");
		assert.strictEqual(reading.reason, "no-run-at-head-yet");
	});

	it("a run at the head that has not completed is pending", () => {
		const reading = classifyBundle(
			probe({_tag: "RunNotCompleted", run: run({status: "in_progress", conclusion: null})}),
		);
		assert.strictEqual(reading.state, "pending");
		assert.strictEqual(reading.reason, "run-not-completed");
		assert.strictEqual(reading.evidence.runStatus, "in_progress");
	});

	it("the report line says PENDING and states outright that it is not ABSENT", () => {
		const line = renderReportLine(classifyBundle(probe({_tag: "NoRunAtHead"}, 0)));
		assert.include(line, "PENDING");
		assert.include(line, "PENDING is not ABSENT");
		assert.notInclude(line, "ABSENT for");
	});
});

describe("classifyBundle — ABSENT is claimed only on positive evidence", () => {
	it("a repo with no producer workflow has no bundle to miss", () => {
		const reading = classifyBundle(probe({_tag: "ProducerWorkflowAbsent"}, null));
		assert.strictEqual(reading.state, "absent");
		assert.strictEqual(reading.reason, "no-producer-workflow");
	});

	it("a COMPLETED run that published no artifact is genuinely absent", () => {
		const reading = classifyBundle(probe({_tag: "ArtifactMissing", run: run()}));
		assert.strictEqual(reading.state, "absent");
		assert.strictEqual(reading.reason, "run-completed-without-artifact");
		assert.include(renderReportLine(reading), "ABSENT");
	});

	it("an expired artifact is absent, and names the artifact it lost", () => {
		const reading = classifyBundle(
			probe({_tag: "ArtifactExpired", run: run(), artifactId: 8615655601}),
		);
		assert.strictEqual(reading.state, "absent");
		assert.strictEqual(reading.reason, "artifact-expired");
		assert.strictEqual(reading.evidence.artifactId, 8615655601);
	});
});

describe("classifyBundle — UNKNOWN is a failed read, distinctly reported", () => {
	const unreadable: ReadonlyArray<readonly [string, Observation]> = [
		["producer-unreadable", {_tag: "ProducerUnreadable", cause: "gh exited 1 — HTTP 503"}],
		["runs-unreadable", {_tag: "RunsUnreadable", cause: "gh exited 1 — HTTP 502"}],
		[
			"artifacts-unreadable",
			{_tag: "ArtifactsUnreadable", run: run(), cause: "gh exited 1 — HTTP 503"},
		],
		[
			"download-unreadable",
			{_tag: "DownloadUnreadable", run: run(), artifactId: 1, cause: "gh exited 1 — HTTP 503"},
		],
		[
			"archive-unreadable",
			{
				_tag: "ArchiveUnreadable",
				run: run(),
				artifactId: 1,
				cause: "not a ZIP archive — 169-byte payload",
			},
		],
		[
			"manifest-unreadable",
			{_tag: "ManifestUnreadable", run: run(), artifactId: 1, cause: "response was not JSON"},
		],
	];

	for (const [reason, observation] of unreadable) {
		it(`${reason} resolves unknown, not absent`, () => {
			const reading = classifyBundle(probe(observation));
			assert.strictEqual(reading.state, "unknown");
			assert.strictEqual(reading.reason, reason);
			const line = renderReportLine(reading);
			assert.include(line, "UNKNOWN");
			assert.include(line, "UNKNOWN is not ABSENT");
			assert.include(line, reason);
		});
	}

	it("a runs list that could not be read reports its count as unreadable, not as zero", () => {
		const reading = classifyBundle(
			probe({_tag: "RunsUnreadable", cause: "gh exited 1 — HTTP 502"}, null),
		);
		assert.strictEqual(reading.evidence.runsAtHead, null);
		assert.include(renderReportLine(reading), "unreadable `run-evidence` run(s) at head");
	});

	it("a stale manifest (commit != head) is unknown — validated before it is interpreted", () => {
		const reading = classifyBundle(
			probe({
				_tag: "ManifestRead",
				run: run(),
				artifactId: 1,
				manifest: manifest({commit: OTHER}),
			}),
		);
		assert.strictEqual(reading.state, "unknown");
		assert.strictEqual(reading.reason, "manifest-commit-mismatch");
		assert.isNull(reading.manifest);
	});

	it("an unsupported schemaVersion is unknown, never read as evidence", () => {
		const reading = classifyBundle(
			probe({
				_tag: "ManifestRead",
				run: run(),
				artifactId: 1,
				manifest: manifest({schemaVersion: 99}),
			}),
		);
		assert.strictEqual(reading.state, "unknown");
		assert.strictEqual(reading.reason, "unsupported-schema-version");
	});
});

describe("every reading carries checkable lookup evidence", () => {
	it("the queried head is always in the line, so the claim is falsifiable from the comment", () => {
		const observations: ReadonlyArray<Observation> = [
			{_tag: "ManifestRead", run: run(), artifactId: 1, manifest: manifest()},
			{_tag: "NoRunAtHead"},
			{_tag: "ArtifactMissing", run: run()},
			{_tag: "RunsUnreadable", cause: "HTTP 503"},
		];
		for (const observation of observations) {
			const line = renderReportLine(classifyBundle(probe(observation)));
			assert.include(line, "05de8f09");
		}
	});
});
