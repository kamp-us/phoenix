/**
 * `scratchpad` filesystem boundary — allocate and re-derive the per-run namespace the
 * pure core (`scratchpad.ts`) decides. Plain `node:fs`, mirroring the `worktree-sweep` /
 * `main-sync` shape, so the tool's requirement stays at the Node platform ceiling the
 * registry provides.
 *
 * Every function returns a `Resolved` — a refusal is a value here, never a throw and
 * never a fallback to a shared path.
 */
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {
	classifyOwnership,
	fail,
	foreignNamespaceError,
	formatOwner,
	type Namespace,
	type NamespaceInput,
	ok,
	parseOwner,
	type Resolved,
	resolveNamespace,
	validateLeafName,
} from "./scratchpad.ts";

/** Read the owner stamp of an already-existing namespace; `null` when there is none to read. */
const readOwner = (namespace: Namespace) => {
	if (!existsSync(namespace.ownerFile)) return null;
	try {
		return parseOwner(readFileSync(namespace.ownerFile, "utf8"));
	} catch {
		return null;
	}
};

/**
 * OPEN — the run's first write of scratch state. Allocates the namespace fresh (clearing
 * leftovers from an earlier run of the same slug in the same session, so a re-run never
 * reads its predecessor's files) and stamps it as ours.
 *
 * An existing namespace owned by ANOTHER run is refused, not clobbered: that refusal is
 * the structural half of the fix — the silent cross-run overwrite (#3718) becomes a loud,
 * typed `ForeignNamespace`.
 */
export const openNamespace = (
	input: NamespaceInput,
	now: () => Date = () => new Date(),
): Resolved<Namespace> => {
	const resolved = resolveNamespace(input);
	if (!resolved.ok) return resolved;
	const namespace = resolved.value;
	if (existsSync(namespace.path)) {
		const owner = readOwner(namespace);
		if (owner !== null && classifyOwnership(owner, namespace.identity) === "foreign")
			return fail(foreignNamespaceError(namespace.path, owner, namespace.identity));
	}
	try {
		rmSync(namespace.path, {recursive: true, force: true});
		mkdirSync(namespace.path, {recursive: true});
		writeFileSync(namespace.ownerFile, formatOwner(namespace.identity, now().toISOString()));
	} catch (cause) {
		return fail({
			_tag: "NamespaceUnavailable",
			path: namespace.path,
			message: `could not allocate the per-run scratch namespace: ${String(cause)}`,
		});
	}
	return ok(namespace);
};

/**
 * RE-DERIVE — every later Bash call. Recomputes the same path and asserts it is still
 * there and still ours. It deliberately does NOT create anything: an absent namespace
 * means the opening step never ran in THIS run, and answering that with a fresh empty
 * directory is how a read of your own earlier state silently becomes a read of nothing.
 */
export const resolveOwnNamespace = (input: NamespaceInput): Resolved<Namespace> => {
	const resolved = resolveNamespace(input);
	if (!resolved.ok) return resolved;
	const namespace = resolved.value;
	if (!existsSync(namespace.path))
		return fail({
			_tag: "NamespaceMissing",
			path: namespace.path,
			message:
				"the per-run scratch namespace does not exist — run `scratchpad open --slug <slug>` in THIS run before re-deriving.",
		});
	const owner = readOwner(namespace);
	if (owner !== null && classifyOwnership(owner, namespace.identity) === "foreign")
		return fail(foreignNamespaceError(namespace.path, owner, namespace.identity));
	if (owner === null)
		return fail({
			_tag: "NamespaceMissing",
			path: namespace.path,
			message:
				"the namespace carries no owner stamp — it was not allocated by `scratchpad open`, so it cannot be proven to hold THIS run's state.",
		});
	return ok(namespace);
};

/** A named file inside this run's namespace — the path every scratch write should use. */
export const resolveOwnFile = (input: NamespaceInput, name: string): Resolved<string> => {
	const leaf = validateLeafName(name);
	if (!leaf.ok) return leaf;
	const namespace = resolveOwnNamespace(input);
	if (!namespace.ok) return namespace;
	return ok(`${namespace.value.path}/${leaf.value}`);
};
