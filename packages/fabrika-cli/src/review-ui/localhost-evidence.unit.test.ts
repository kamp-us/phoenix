import {assert, describe, it} from "@effect/vitest";
import {
	BROWSER_ERROR_TEXT_CAP,
	declarationDigest,
	parseCiCaptureManifest,
	parseLocalhostDeclarations,
} from "./localhost-evidence.ts";

const HEAD = "03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c";
const AUTHORITY_HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH = "a".repeat(64);

const declarations = {
	schemaVersion: 1,
	harnesses: [
		{
			id: "tuval",
			workflow: ".github/workflows/review-ui-localhost-evidence.yml",
			check: "review-ui localhost evidence / tuval",
			event: "pull_request_target",
			artifact: "review-ui-localhost-tuval",
			captureCommand: ["pnpm", "--filter", "tuval", "test"],
			serverCommand: ["node", "server.mjs", "4173"],
			containerPort: 4173,
			readinessPattern: "ready (http://127.0.0.1:[0-9]+)",
			captureReadySelector: ".react-flow__node",
			surfaces: [{id: "desktop", route: "/", state: "desktop", width: 1280, height: 800}],
		},
	],
};

const manifest = {
	schemaVersion: 1,
	source: "github-actions",
	repository: "kamp-us/phoenix",
	pr: 7190,
	head: HEAD,
	harness: "tuval",
	declarationSha256: declarationDigest(JSON.stringify(declarations)),
	producer: {
		workflow: ".github/workflows/review-ui-localhost-evidence.yml",
		check: "review-ui localhost evidence / tuval",
		event: "pull_request_target",
		runId: 42,
		artifact: "review-ui-localhost-tuval",
		authorityHead: AUTHORITY_HEAD,
	},
	captures: [
		{
			surface: "desktop",
			path: "captures/desktop.png",
			width: 1280,
			height: 800,
			sha256: HASH,
			pageErrors: {rows: [], more: 0},
			errorCoverage: {pageerror: "readable", consoleError: "readable"},
		},
	],
};

describe("localhost evidence authority", () => {
	it("accepts only a positive governed declaration with fixed producer and command identities", () => {
		assert.strictEqual(
			parseLocalhostDeclarations(JSON.stringify(declarations))._tag,
			"Declarations",
		);
		assert.strictEqual(
			parseLocalhostDeclarations(JSON.stringify({...declarations, harnesses: []}))._tag,
			"Malformed",
		);
		assert.strictEqual(
			parseLocalhostDeclarations(
				JSON.stringify({
					...declarations,
					harnesses: [{...declarations.harnesses[0], event: "pull_request"}],
				}),
			)._tag,
			"Malformed",
		);
	});

	it("accepts the versioned exact-head CI manifest and rejects abbreviated or builder authority", () => {
		assert.strictEqual(parseCiCaptureManifest(JSON.stringify(manifest))._tag, "Manifest");
		assert.strictEqual(
			parseCiCaptureManifest(JSON.stringify({...manifest, head: HEAD.slice(0, 8)}))._tag,
			"Malformed",
		);
		assert.strictEqual(
			parseCiCaptureManifest(JSON.stringify({...manifest, source: "builder"}))._tag,
			"Malformed",
		);
		assert.strictEqual(
			parseCiCaptureManifest(
				JSON.stringify({
					...manifest,
					producer: {...manifest.producer, authorityHead: HEAD.slice(0, 8)},
				}),
			)._tag,
			"Malformed",
		);
	});

	it("rejects arbitrary members, missing captures, and unreadable browser-error evidence", () => {
		assert.strictEqual(
			parseCiCaptureManifest(
				JSON.stringify({
					...manifest,
					captures: [{...manifest.captures[0], path: "../../builder.png"}],
				}),
			)._tag,
			"Malformed",
		);
		assert.strictEqual(
			parseCiCaptureManifest(JSON.stringify({...manifest, captures: []}))._tag,
			"Malformed",
		);
		assert.strictEqual(
			parseCiCaptureManifest(
				JSON.stringify({
					...manifest,
					captures: [manifest.captures[0], {...manifest.captures[0], path: "captures/mobile.png"}],
				}),
			)._tag,
			"Malformed",
		);
		assert.strictEqual(
			parseCiCaptureManifest(
				JSON.stringify({
					...manifest,
					captures: [
						{
							...manifest.captures[0],
							errorCoverage: {pageerror: "unreadable", consoleError: "readable"},
						},
					],
				}),
			)._tag,
			"Malformed",
		);
	});

	it("bounds page and console evidence to three rows plus a count", () => {
		const tooMany = {
			...manifest,
			captures: [
				{
					...manifest.captures[0],
					pageErrors: {
						rows: Array.from({length: 4}, (_, index) => ({
							kind: index % 2 === 0 ? "pageerror" : "console.error",
							text: `error ${index}`,
						})),
						more: 0,
					},
				},
			],
		};
		assert.strictEqual(parseCiCaptureManifest(JSON.stringify(tooMany))._tag, "Malformed");

		const oversizedRow = {
			...manifest,
			captures: [
				{
					...manifest.captures[0],
					pageErrors: {
						rows: [{kind: "console.error", text: "x".repeat(BROWSER_ERROR_TEXT_CAP + 1)}],
						more: 0,
					},
				},
			],
		};
		assert.strictEqual(parseCiCaptureManifest(JSON.stringify(oversizedRow))._tag, "Malformed");
	});
});
