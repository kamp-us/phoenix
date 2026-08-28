import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {execCapture} from "../io/exec.ts";
import {isObjectName} from "../io/git.ts";
import {canonicalOriginUrl, parseSourceManifest, type SourceManifest} from "./source-model.ts";

export {canonicalOriginUrl} from "./source-model.ts";

export interface SourceEvidence {
	readonly origin: string;
	readonly commit: string;
	readonly package: string;
	readonly version: string;
	readonly inspected: {
		readonly source: string;
		readonly tests: string;
		readonly docs: string;
	};
}

export type SourceInspection =
	| {readonly _tag: "Evidence"; readonly evidence: SourceEvidence}
	| {readonly _tag: "Refused"; readonly reason: string};

const refused = (reason: string): SourceInspection => ({_tag: "Refused", reason});

const packageRoot = (manifestPath: string): string => {
	const slash = manifestPath.lastIndexOf("/");
	return slash < 0 ? "" : manifestPath.slice(0, slash);
};

const under = (path: string, root: string): boolean => root === "" || path.startsWith(`${root}/`);
const isTest = (path: string): boolean =>
	/(^|\/)(test|tests|__tests__)(\/|$)/i.test(path) || /\.(test|spec)\.[^/]+$/i.test(path);
const isDocs = (path: string): boolean =>
	/(^|\/)(docs?|examples?)(\/|$)/i.test(path) || /(^|\/)(readme|contributing)\.md$/i.test(path);
const isSource = (path: string, root: string): boolean =>
	under(path, root) &&
	/(^|\/)(src|source|lib)\//i.test(path.slice(root === "" ? 0 : root.length + 1)) &&
	!isTest(path);

const readAtCommit = (root: string, commit: string, path: string) =>
	execCapture("git", ["-C", root, "show", `${commit}:${path}`]);

export const inspectSourceRepository = (
	repoPath: string,
	packageName: string | null,
): Effect.Effect<SourceInspection, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const rootRead = yield* execCapture("git", ["-C", repoPath, "rev-parse", "--show-toplevel"]);
		if (!rootRead.ok || rootRead.stdout.trim() === "") {
			return refused(
				`cannot resolve the supplied path as a readable Git checkout: ${rootRead.reason}`,
			);
		}
		const root = rootRead.stdout.trim();
		const headRead = yield* execCapture("git", [
			"-C",
			root,
			"rev-parse",
			"--verify",
			"HEAD^{commit}",
		]);
		const commit = headRead.stdout.trim();
		if (!headRead.ok || !isObjectName(commit)) {
			return refused(
				`cannot derive a full HEAD commit: ${headRead.reason || "git returned no object name"}`,
			);
		}
		const originRead = yield* execCapture("git", ["-C", root, "remote", "get-url", "origin"]);
		if (!originRead.ok) return refused(`cannot read an origin remote: ${originRead.reason}`);
		const origin = canonicalOriginUrl(originRead.stdout);
		if (origin === null) return refused("the origin remote is absent, local, or unparseable");

		const filesRead = yield* execCapture("git", [
			"-C",
			root,
			"ls-tree",
			"-r",
			"-z",
			"--name-only",
			commit,
		]);
		if (!filesRead.ok) return refused(`cannot enumerate source at HEAD: ${filesRead.reason}`);
		const files = filesRead.stdout.split("\0").filter((path) => path !== "");
		const manifestPaths = files.filter(
			(path) => path === "package.json" || path.endsWith("/package.json"),
		);
		if (manifestPaths.length === 0) return refused("the checkout has no tracked package.json");

		const manifests: SourceManifest[] = [];
		for (const path of manifestPaths) {
			const read = yield* readAtCommit(root, commit, path);
			if (!read.ok) return refused(`cannot read ${path} at HEAD: ${read.reason}`);
			const manifest = parseSourceManifest(path, read.stdout);
			if (manifest !== null) manifests.push(manifest);
		}
		const candidates =
			packageName === null
				? manifests.filter((manifest) => !manifest.private)
				: manifests.filter((manifest) => manifest.name === packageName);
		if (candidates.length === 0) {
			return refused(
				packageName === null
					? "no versioned public package can be derived from the checkout"
					: `package ${packageName} has no unique versioned manifest in the checkout`,
			);
		}
		if (candidates.length !== 1) {
			return refused(
				packageName === null
					? `package selection is ambiguous across ${candidates.length} versioned public manifests; pass --source-package`
					: `package ${packageName} is ambiguous across ${candidates.length} manifests`,
			);
		}
		const selected = candidates[0];
		if (selected === undefined) return refused("package selection produced no manifest");
		const rootPrefix = packageRoot(selected.path);
		const source = files.find((path) => isSource(path, rootPrefix));
		if (source === undefined)
			return refused(`package ${selected.name} has no tracked source files`);
		const tests =
			files.find((path) => under(path, rootPrefix) && isTest(path)) ??
			files.find((path) => isTest(path));
		if (tests === undefined) return refused("the checkout has no tracked tests");
		const docs =
			files.find((path) => under(path, rootPrefix) && isDocs(path)) ??
			files.find((path) => isDocs(path));
		if (docs === undefined) return refused("the checkout has no tracked docs or examples");

		for (const path of [source, tests, docs]) {
			const read = yield* readAtCommit(root, commit, path);
			if (!read.ok) return refused(`cannot read ${path} at HEAD: ${read.reason}`);
		}
		return {
			_tag: "Evidence",
			evidence: {
				origin,
				commit,
				package: selected.name,
				version: selected.version,
				inspected: {source, tests, docs},
			},
		};
	});

export const sourceEvidenceLine = (evidence: SourceEvidence): string =>
	`> Source checkout evidence: ${evidence.origin} at \`${evidence.commit}\`; package \`${evidence.package}@${evidence.version}\`; inspected \`${evidence.inspected.source}\`, \`${evidence.inspected.tests}\`, and \`${evidence.inspected.docs}\`.`;
