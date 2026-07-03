/**
 * The bundle-assert bin — CI proof that the `apps/web` worker bundle excludes
 * Node-only modules (ADR 0118, #1502 AC2, #1836).
 *
 * Bundles the worker headlessly (`bundle.ts`), scans the module graph
 * (`detect.ts`), prints a human summary, writes the ADR 0054 §2 `Check` result to
 * `--output` (folded into the run-evidence manifest by `crabbox-manifest
 * --extra-checks`), and exits non-zero on a violation so the CI job goes red.
 *
 * Kept a thin bin over a pure core: all detection logic + its unit tests live in
 * `detect.ts`; this file only does IO, arg parsing, and process exit.
 *
 * Flags:
 *   --output <path>       where to write the Check JSON (default: stdout)
 *   --forbidden a,b,c     REPLACE the default forbidden set (extensible — AC4)
 *   --also a,b            ADD to the default forbidden set
 *   --allow mod           add a module to the tolerated allowlist (no reason recorded)
 */
import {writeFileSync} from "node:fs";
import path from "node:path";
import {bundleWorkerGraph} from "./bundle.ts";
import {
	type AllowlistEntry,
	DEFAULT_ALLOWLIST,
	DEFAULT_FORBIDDEN,
	detectNodeCore,
	toCheck,
} from "./detect.ts";

const argOf = (name: string): string | undefined => {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
};
const csv = (v: string | undefined): ReadonlyArray<string> =>
	v
		? v
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean)
		: [];

const main = async (): Promise<number> => {
	const webRoot = process.cwd().endsWith(`${path.sep}web`)
		? process.cwd()
		: path.join(process.cwd(), "apps/web");

	const forbiddenBase = argOf("forbidden") ? csv(argOf("forbidden")) : DEFAULT_FORBIDDEN;
	const forbidden = [...new Set([...forbiddenBase, ...csv(argOf("also"))])];
	const allowlist: ReadonlyArray<AllowlistEntry> = [
		...DEFAULT_ALLOWLIST,
		...csv(argOf("allow")).map((module) => ({module, reason: "added via --allow"})),
	];

	console.error(`[bundle-assert] bundling ${path.join(webRoot, "worker/index.ts")} …`);
	const graph = await bundleWorkerGraph(webRoot);
	const result = detectNodeCore(graph, {forbidden, allowlist});

	console.error(
		`[bundle-assert] scanned ${result.scanned.moduleIds} modules, ${result.scanned.externalImports} external imports`,
	);
	console.error(`[bundle-assert] forbidden set: ${forbidden.join(", ")}`);
	if (result.allowlisted.length > 0) {
		console.error(`[bundle-assert] present-but-allowlisted: ${result.allowlisted.join(", ")}`);
	}
	if (result.status === "pass") {
		console.error("[bundle-assert] PASS — no forbidden Node-only module in the worker bundle");
	} else {
		console.error("[bundle-assert] FAIL — worker bundle reaches forbidden Node-only module(s):");
		for (const o of result.offenders) {
			console.error(`  ✗ ${o.module}  (${o.via})  ${o.evidence}`);
		}
	}

	// The run-evidence manifest folds a single Check; keep it an array so
	// `crabbox-manifest --extra-checks` can accept object-or-array uniformly.
	const check = toCheck(result);
	const json = `${JSON.stringify([check], null, "\t")}\n`;
	const out = argOf("output");
	if (out) {
		writeFileSync(out, json);
		console.error(`[bundle-assert] wrote check → ${out}`);
	} else {
		process.stdout.write(json);
	}

	return result.status === "pass" ? 0 : 1;
};

main().then(
	(code) => process.exit(code),
	(err) => {
		console.error("[bundle-assert] ERROR — could not produce/scan the worker bundle:");
		console.error(err?.stack ?? String(err));
		process.exit(2);
	},
);
