import {describe, expect, it} from "vitest";
import {
	type BundleGraph,
	CHECK_NAME,
	DEFAULT_ALLOWLIST,
	DEFAULT_FORBIDDEN,
	detectNodeCore,
	toCheck,
} from "./detect.ts";

const config = {forbidden: DEFAULT_FORBIDDEN, allowlist: DEFAULT_ALLOWLIST};

// The known-good bundle observed for the current worker (#1836 spike): the sentry
// tree-shakeable leaves are present but the node-core barrel is gone; node:child_process
// survives via @effect/platform-node (allowlisted).
const knownGood: BundleGraph = {
	moduleIds: [
		"/repo/node_modules/.pnpm/@sentry+effect@10/node_modules/@sentry/effect/build/esm/index.server.js",
		"/repo/node_modules/.pnpm/@effect+platform-node@1/node_modules/@effect/platform-node/dist/NodeCrypto.js",
		"/repo/apps/web/worker/index.ts",
	],
	externalImports: ["node:crypto", "node:child_process", "node:events", "cloudflare:workers"],
};

describe("detectNodeCore", () => {
	it("passes on the known-good bundle (node:child_process is allowlisted, no barrel)", () => {
		const r = detectNodeCore(knownGood, config);
		expect(r.status).toBe("pass");
		expect(r.offenders).toEqual([]);
		expect(r.allowlisted).toContain("node:child_process");
		expect(r.scanned.moduleIds).toBe(3);
	});

	it("fails when @sentry/node-core re-enters the module graph (the ADR 0118 regression)", () => {
		const regressed: BundleGraph = {
			moduleIds: [
				...knownGood.moduleIds,
				"/repo/node_modules/.pnpm/@sentry+node-core@10/node_modules/@sentry/node-core/build/esm/index.js",
			],
			externalImports: [...knownGood.externalImports, "node:worker_threads", "node:inspector"],
		};
		const r = detectNodeCore(regressed, config);
		expect(r.status).toBe("fail");
		const modules = r.offenders.map((o) => o.module);
		expect(modules).toContain("@sentry/node-core");
		expect(modules).toContain("node:inspector");
		// node:child_process is present but allowlisted — never an offender
		expect(modules).not.toContain("node:child_process");
	});

	it("fails on a bundled npm package (winston) via the module graph", () => {
		const g: BundleGraph = {
			moduleIds: ["/repo/node_modules/.pnpm/winston@3/node_modules/winston/lib/winston.js"],
			externalImports: [],
		};
		const r = detectNodeCore(g, config);
		expect(r.status).toBe("fail");
		const w = r.offenders.find((o) => o.module === "winston");
		expect(w?.via).toBe("module-graph");
	});

	it("fails on a forbidden node: builtin surviving as an external import", () => {
		const g: BundleGraph = {moduleIds: [], externalImports: ["node:inspector"]};
		const r = detectNodeCore(g, config);
		expect(r.status).toBe("fail");
		expect(r.offenders[0]?.via).toBe("external-import");
	});

	it("does not match a package by a substring collision (winston-transport ≠ winston)", () => {
		const g: BundleGraph = {
			moduleIds: ["/repo/node_modules/winston-transport/index.js"],
			externalImports: [],
		};
		// forbidden matches `/node_modules/winston/` — the trailing slash prevents the
		// `winston-transport` false positive.
		expect(detectNodeCore(g, config).status).toBe("pass");
	});

	it("honors an extended forbidden set (AC4 — not hardcoded to the defaults)", () => {
		const g: BundleGraph = {moduleIds: [], externalImports: ["node:vm"]};
		const extended = {forbidden: [...DEFAULT_FORBIDDEN, "node:vm"], allowlist: DEFAULT_ALLOWLIST};
		expect(detectNodeCore(g, extended).status).toBe("fail");
		// same graph passes under the default set (node:vm not forbidden by default)
		expect(detectNodeCore(g, config).status).toBe("pass");
	});
});

describe("toCheck", () => {
	it("maps a pass to exitCode 0 under the run-evidence check name", () => {
		const c = toCheck(detectNodeCore(knownGood, config));
		expect(c).toEqual({name: CHECK_NAME, status: "pass", exitCode: 0});
	});

	it("maps a fail to exitCode 1", () => {
		const g: BundleGraph = {moduleIds: [], externalImports: ["node:inspector"]};
		expect(toCheck(detectNodeCore(g, config)).exitCode).toBe(1);
	});
});
