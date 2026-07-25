/**
 * `scratchpad` filesystem boundary — allocate and re-derive the per-run namespace the
 * pure core (`scratchpad.ts`) decides. Plain `node:fs`, mirroring the `worktree-sweep` /
 * `main-sync` shape, so the tool's requirement stays at the Node platform ceiling the
 * registry provides.
 *
 * Every function returns a `Resolved` — a refusal is a value here, never a throw and
 * never a fallback to a shared path.
 */
import {existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {
	classifyOwnership,
	fail,
	foreignNamespaceError,
	formatOwner,
	type Namespace,
	type NamespaceInput,
	OWNER_FILE,
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

const isEexist = (cause: unknown): boolean =>
	typeof cause === "object" && cause !== null && (cause as {code?: unknown}).code === "EEXIST";

const unavailable = (namespace: Namespace, cause: unknown): Resolved<Namespace> =>
	fail({
		_tag: "NamespaceUnavailable",
		path: namespace.path,
		message: `could not allocate the per-run scratch namespace: ${String(cause)}`,
	});

/**
 * Clear what a previous, unclaimed occupant left behind — never the stamp, which is this
 * run's live claim. Only reached by the run that WON the claim, so there is no concurrent
 * peer whose files this could delete.
 */
const clearLeftovers = (namespace: Namespace): void => {
	for (const entry of readdirSync(namespace.path)) {
		if (entry === OWNER_FILE) continue;
		rmSync(`${namespace.path}/${entry}`, {recursive: true, force: true});
	}
};

/**
 * OPEN — the run's first write of scratch state. Claims the namespace and stamps it as ours.
 *
 * The claim is ONE exclusive create: the stamp is written with `wx` (`O_CREAT | O_EXCL`), so
 * the kernel — not a preceding existence check — picks the single winner among concurrent
 * opens, and the `EEXIST` it raises IS the refusal. This is the shape Node's own `fs` docs
 * prescribe (the "write (RECOMMENDED)" example), against the check-then-act they name as a
 * race. The earlier `existsSync` → classify → `rmSync` + write sequence had a real window
 * between the check and the act: eight concurrent opens on one session and slug each
 * concluded they owned it, five reporting success, which put #3718's silent cross-run read
 * back in reach on precisely the case the stamp was added to close.
 */
export const openNamespace = (
	input: NamespaceInput,
	now: () => Date = () => new Date(),
): Resolved<Namespace> => {
	const resolved = resolveNamespace(input);
	if (!resolved.ok) return resolved;
	const namespace = resolved.value;
	try {
		mkdirSync(namespace.path, {recursive: true});
	} catch (cause) {
		return unavailable(namespace, cause);
	}
	try {
		writeFileSync(namespace.ownerFile, formatOwner(namespace.identity, now().toISOString()), {
			flag: "wx",
		});
	} catch (cause) {
		if (!isEexist(cause)) return unavailable(namespace, cause);
		// The claim is already held. Whose?
		const owner = readOwner(namespace);
		if (owner === null)
			return fail({
				_tag: "NamespaceUnavailable",
				path: namespace.path,
				message:
					"the namespace carries a claim whose owner stamp cannot be read — refusing rather than assuming it is ours.",
			});
		if (classifyOwnership(owner, namespace.identity) === "foreign")
			return fail(foreignNamespaceError(namespace.path, owner, namespace.identity));
		// Held by this same run: a re-open returns it AS IS. Clearing here would be the one
		// destructive path left — a peer this run cannot distinguish from itself would delete
		// state the claim holder had already written.
		return ok(namespace);
	}
	try {
		clearLeftovers(namespace);
	} catch (cause) {
		return unavailable(namespace, cause);
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
