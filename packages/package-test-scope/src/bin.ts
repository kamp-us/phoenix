/**
 * `package-test-scope` bin — the IO shell around the pure core, run by ci.yml's
 * `changes` job (issue #10023). Exits 0 always: it emits a scope, and the
 * `packages unit tests` job runs it.
 *
 * ZERO runtime dependencies on purpose: the `changes` job runs this with only
 * checkout + setup-node + node, no `pnpm install`, hence plain Node and no Effect.
 *
 * Inputs: `GITHUB_EVENT_NAME`, `SCOPE_BASE` (the pinned diff base SHA, empty when
 * unresolved) and `CHANGED_FILES_FILE` (`git diff --name-only -z` output; unset when
 * the diff failed). Any read failure emits the full run.
 */
import {appendFileSync, readdirSync, readFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

import {decideScope, type Member, type Scope, selects} from "./scope.ts";
import {parseMember, parseWorkspaceRoots} from "./workspace.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The package whose outside-author proof step follows its suite (#9654). */
const TUVAL_SDK = "@kampus/tuval-sdk";

const readMembers = (): ReadonlyArray<Member> => {
	const roots = parseWorkspaceRoots(readFileSync(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8"));
	const members: Member[] = [];
	for (const root of roots) {
		for (const entry of readdirSync(join(REPO_ROOT, root), {withFileTypes: true})) {
			if (!entry.isDirectory()) continue;
			const dir = `${root}/${entry.name}`;
			let manifest: string;
			try {
				manifest = readFileSync(join(REPO_ROOT, dir, "package.json"), "utf8");
			} catch (err) {
				// A directory with no manifest is not a workspace member.
				if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw err;
			}
			members.push(parseMember(dir, manifest));
		}
	}
	return members;
};

const readChangedFiles = (): ReadonlyArray<string> | null => {
	const path = process.env.CHANGED_FILES_FILE;
	if (path === undefined || path === "") return null;
	return readFileSync(path, "utf8")
		.split("\0")
		.filter((file) => file !== "");
};

const decide = (): Scope => {
	try {
		return decideScope({
			event: process.env.GITHUB_EVENT_NAME ?? "",
			base: process.env.SCOPE_BASE ?? "",
			changedFiles: readChangedFiles(),
			members: readMembers(),
		});
	} catch (err) {
		return {kind: "full", reason: `the scope inputs could not be read (${(err as Error).message})`};
	}
};

const scope = decide();
const lines = [
	`packages_scope=${scope.kind}`,
	`packages_selection=${scope.kind === "scoped" ? scope.packages.join(" ") : ""}`,
	`packages_scope_reason=${scope.reason.replace(/[\r\n]+/g, " ")}`,
	`tuval_sdk_proof=${selects(scope, TUVAL_SDK)}`,
];
console.log(`packages unit tests scope: ${scope.kind} — ${scope.reason}`);
if (scope.kind === "scoped") console.log(`selected: ${scope.packages.join(", ")}`);
const output = process.env.GITHUB_OUTPUT;
if (output !== undefined && output !== "") appendFileSync(output, `${lines.join("\n")}\n`);
else for (const line of lines) console.log(line);
