import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";
import {checkDrift, loadManifests, loadPackageManifest, type PackageManifest} from "./drift.ts";

const PUBLIC: PackageManifest = {publishConfig: {access: "public"}};
const PRIVATE: PackageManifest = {private: true, publishConfig: {access: "public"}};
const NO_CONFIG: PackageManifest = {};
const RESTRICTED: PackageManifest = {publishConfig: {access: "restricted"}};

describe("checkDrift (pure) — one verdict per variant", () => {
	it("ok: public + not private", () => {
		const report = checkDrift(["epic-ledger"], {"epic-ledger": PUBLIC});
		assert.deepStrictEqual(report.verdicts, [{name: "epic-ledger", status: "ok"}]);
		assert.isFalse(report.hasDrift);
	});

	it("private-but-required: private: true (even with public access)", () => {
		const report = checkDrift(["leak-guard"], {"leak-guard": PRIVATE});
		assert.deepStrictEqual(report.verdicts, [{name: "leak-guard", status: "private-but-required"}]);
		assert.isTrue(report.hasDrift);
	});

	it("missing-publishConfig: no publishConfig.access at all", () => {
		const report = checkDrift(["x"], {x: NO_CONFIG});
		assert.deepStrictEqual(report.verdicts, [{name: "x", status: "missing-publishConfig"}]);
		assert.isTrue(report.hasDrift);
	});

	it("missing-publishConfig: access present but not 'public'", () => {
		const report = checkDrift(["x"], {x: RESTRICTED});
		assert.deepStrictEqual(report.verdicts, [{name: "x", status: "missing-publishConfig"}]);
		assert.isTrue(report.hasDrift);
	});

	it("not-found: no manifest on disk (null)", () => {
		const report = checkDrift(["ghost"], {ghost: null});
		assert.deepStrictEqual(report.verdicts, [{name: "ghost", status: "not-found"}]);
		assert.isTrue(report.hasDrift);
	});

	it("not-found: required name absent from the packages map entirely", () => {
		const report = checkDrift(["ghost"], {});
		assert.deepStrictEqual(report.verdicts, [{name: "ghost", status: "not-found"}]);
		assert.isTrue(report.hasDrift);
	});

	it("mixed set: clean ones pass, the unpublishable one drifts; verdicts sorted by name", () => {
		const report = checkDrift(["epic-ledger", "decisions-index", "leak-guard"], {
			"epic-ledger": PUBLIC,
			"decisions-index": PUBLIC,
			"leak-guard": PRIVATE,
		});
		assert.deepStrictEqual(report.verdicts, [
			{name: "decisions-index", status: "ok"},
			{name: "epic-ledger", status: "ok"},
			{name: "leak-guard", status: "private-but-required"},
		]);
		assert.isTrue(report.hasDrift);
	});

	it("empty required set: clean, no drift", () => {
		const report = checkDrift([], {});
		assert.deepStrictEqual(report.verdicts, []);
		assert.isFalse(report.hasDrift);
	});
});

describe("loadPackageManifest / loadManifests (IO over a fixture packages dir)", () => {
	let dir: string;
	const writePkg = (name: string, manifest: unknown): void => {
		mkdirSync(join(dir, name), {recursive: true});
		writeFileSync(join(dir, name, "package.json"), JSON.stringify(manifest), "utf8");
	};

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "publish-guard-pkgs-"));
		writePkg("epic-ledger", {name: "@kampus/epic-ledger", publishConfig: {access: "public"}});
		writePkg("leak-guard", {name: "@kampus/leak-guard", private: true});
		// a package dir with an unparseable manifest reads as not-found, never a crash
		mkdirSync(join(dir, "broken"), {recursive: true});
		writeFileSync(join(dir, "broken", "package.json"), "{ not json", "utf8");
	});

	afterAll(() => {
		rmSync(dir, {recursive: true, force: true});
	});

	it("loads a real manifest's published fields", () => {
		const manifest = loadPackageManifest(dir, "epic-ledger");
		assert.isNotNull(manifest);
		assert.strictEqual(manifest?.private, undefined);
		assert.strictEqual(manifest?.publishConfig?.access, "public");
	});

	it("returns null for a missing package", () => {
		assert.isNull(loadPackageManifest(dir, "nope"));
	});

	it("returns null for an unparseable package.json", () => {
		assert.isNull(loadPackageManifest(dir, "broken"));
	});

	it("loadManifests + checkDrift end-to-end over the fixture tree", () => {
		const required = ["epic-ledger", "leak-guard", "nope"];
		const report = checkDrift(required, loadManifests(dir, required));
		assert.deepStrictEqual(report.verdicts, [
			{name: "epic-ledger", status: "ok"},
			{name: "leak-guard", status: "private-but-required"},
			{name: "nope", status: "not-found"},
		]);
		assert.isTrue(report.hasDrift);
	});
});
