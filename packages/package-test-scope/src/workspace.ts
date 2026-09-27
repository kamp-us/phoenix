/**
 * Pure readers for the workspace shape: the member roots `pnpm-workspace.yaml` declares
 * and one member's manifest. Each throws on a shape it cannot read, so the bin fails
 * safe to the full run instead of scoping against a partial graph.
 */
import type {Member} from "./scope.ts";

const LIST_ITEM = /^\s+-\s+(['"]?)([^'"#\s]+)\1\s*(?:#.*)?$/;
const MEMBER_GLOB = /^([a-z0-9._-]+)\/\*$/;

/**
 * The parent directories of the `packages:` globs, e.g. `packages/*` → `packages`.
 * Only the one-level `<dir>/*` form is read; any other glob throws.
 */
export const parseWorkspaceRoots = (yaml: string): ReadonlyArray<string> => {
	const lines = yaml.split(/\r?\n/);
	const start = lines.findIndex((line) => /^packages:\s*(?:#.*)?$/.test(line));
	if (start === -1) throw new Error("pnpm-workspace.yaml has no top-level `packages:` list");
	const roots: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (line.trim() === "" || /^\s*#/.test(line)) continue;
		const item = LIST_ITEM.exec(line);
		if (item === null) break;
		const glob = item[2] ?? "";
		const root = MEMBER_GLOB.exec(glob)?.[1];
		if (root === undefined) throw new Error(`unsupported workspace glob ${JSON.stringify(glob)}`);
		roots.push(root);
	}
	if (roots.length === 0) throw new Error("pnpm-workspace.yaml `packages:` list is empty");
	return roots;
};

const DEPENDENCY_FIELDS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** One member from its repo-relative `dir` and the text of its `package.json`. */
export const parseMember = (dir: string, manifest: string): Member => {
	const parsed: unknown = JSON.parse(manifest);
	if (!isRecord(parsed) || typeof parsed.name !== "string" || parsed.name === "") {
		throw new Error(`${dir}/package.json has no name`);
	}
	const dependencies: string[] = [];
	for (const field of DEPENDENCY_FIELDS) {
		const block = parsed[field];
		if (block === undefined) continue;
		if (!isRecord(block)) throw new Error(`${dir}/package.json ${field} is not an object`);
		dependencies.push(...Object.keys(block));
	}
	const scripts = parsed.scripts;
	return {
		name: parsed.name,
		dir,
		dependencies,
		hasTest: isRecord(scripts) && typeof scripts.test === "string",
	};
};
