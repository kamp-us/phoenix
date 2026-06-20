/**
 * `@kampus/publish-guard` core — derive the set of `@kampus/*` packages the
 * kampus-pipeline plugin *consumes and must publish*, by reading a real
 * consumption signal off the skills tree (epic #803, child #807, #976).
 *
 * This derivation IS the single source of truth for "which packages must be
 * published" — there is no second hand-maintained manifest to drift (epic #803
 * Resolved questions). But a raw `@kampus/<slug>` text token is only a *proxy*
 * for the real invariant ("a package a foreign install must resolve from npm"),
 * and the proxy is wrong in both directions (#976):
 *
 *  - **Too broad.** An incidental mention — a CI check name like
 *    `cleanup (web, @kampus/web, true)` quoted in prose — extracts `@kampus/web`,
 *    which is the `apps/web` app worker (never published). Treating it as
 *    required-published fail-closes the gate on documentation text.
 *  - **Wrong key.** A skill that runs `node packages/<pkg>/src/bin.ts` with no
 *    `pnpm dlx @kampus/<pkg>@latest` fallback breaks in every foreign install,
 *    yet carries no `@kampus/<pkg>` token to match.
 *
 * So the required-published set keys on a real signal, not any free-text token:
 * `requiredPackages(skillsDir, packagesDir)` is the text-derived `@kampus/<slug>`
 * set **intersected with the slugs that actually resolve to an existing
 * `packages/<slug>/package.json`** — a slug mapping to `apps/<slug>` (or to no
 * package at all) is never required-published. And `unpublishedInvocationBreaks`
 * surfaces the other direction: a bare-path invocation with no published
 * fallback, the foreign-repo break the token-scan can't see.
 *
 * The pure halves (`extractKampusRefs`, `extractUnpublishedInvocations`) are
 * IO-free and fixture-tested. The IO halves walk the tree and fold per-file
 * results into one sorted, deduped set, deterministic over a fixed tree (no
 * network, no clock).
 */
import {readdirSync, readFileSync, statSync} from "node:fs";
import {join} from "node:path";

// `@kampus/<slug>` where slug is a lowercase npm package name segment. Matches
// every textual occurrence — it is the raw proxy, filtered downstream against
// the real `packages/<slug>` set in `requiredPackages`.
const KAMPUS_REF = /@kampus\/([a-z0-9-]+)/g;

// A skill running a package from source by repo path: `node packages/<pkg>/src/bin*`
// (`bin.ts`, `bin.check.ts`, …). This path does NOT exist in a foreign install, so
// the invocation needs a published `pnpm dlx @kampus/<pkg>` fallback to be portable.
const BARE_PATH_INVOCATION = /node\s+packages\/([a-z0-9-]+)\/src\/bin[a-z0-9.-]*/g;
// `pnpm dlx @kampus/<pkg>` (with or without `@latest`) — the published fallback that
// makes a bare-path invocation portable to a repo that has no `packages/` checkout.
const DLX_FALLBACK = /pnpm\s+dlx\s+@kampus\/([a-z0-9-]+)/g;

/** Every distinct `@kampus/<name>` slug referenced in `text` (just the `<name>`). */
export const extractKampusRefs = (text: string): ReadonlyArray<string> => {
	if (!text) return [];
	const seen = new Set<string>();
	for (const match of text.matchAll(KAMPUS_REF)) {
		const name = match[1];
		if (name) seen.add(name);
	}
	return [...seen].sort();
};

/**
 * The `<pkg>` slugs `text` invokes by bare repo path (`node packages/<pkg>/src/bin*`)
 * **without** a co-located `pnpm dlx @kampus/<pkg>` published fallback — the foreign-repo
 * break (#976/#975). Scoped per text (per skill file): a fallback in the *same* file
 * makes that invocation portable; a fallback in a *different* skill does not, since a
 * foreign install runs each skill independently.
 */
export const extractUnpublishedInvocations = (text: string): ReadonlyArray<string> => {
	if (!text) return [];
	const fallbacks = new Set<string>();
	for (const match of text.matchAll(DLX_FALLBACK)) {
		const name = match[1];
		if (name) fallbacks.add(name);
	}
	const broken = new Set<string>();
	for (const match of text.matchAll(BARE_PATH_INVOCATION)) {
		const name = match[1];
		if (name && !fallbacks.has(name)) broken.add(name);
	}
	return [...broken].sort();
};

/** Recursively collect every file path under `dir` (files only, dirs descended). */
const walkFiles = (dir: string): ReadonlyArray<string> => {
	let entries: ReadonlyArray<string>;
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		const full = join(dir, entry);
		let isDir: boolean;
		try {
			isDir = statSync(full).isDirectory();
		} catch {
			continue;
		}
		if (isDir) files.push(...walkFiles(full));
		else files.push(full);
	}
	return files;
};

/** True iff `packagesDir/<slug>/package.json` exists and is readable. */
const isRealPackage = (packagesDir: string, slug: string): boolean => {
	try {
		statSync(join(packagesDir, slug, "package.json"));
		return true;
	} catch {
		return false;
	}
};

/**
 * The sorted, deduped required-published set: every `@kampus/<slug>` referenced
 * anywhere under `skillsDir` **that resolves to an existing `packages/<slug>`**.
 * The `packages/<slug>` intersection is the real consumption signal — it drops an
 * incidental mention of an `apps/<slug>` worker (`@kampus/web`) or of a slug that
 * is no package at all, so documentation text never fail-closes the gate (#976).
 * A missing/unreadable skills dir yields `[]` (the caller decides whether an empty
 * derived set is itself a problem — `bin.ts check` treats it as clean).
 */
export const requiredPackages = (skillsDir: string, packagesDir: string): ReadonlyArray<string> => {
	const seen = new Set<string>();
	for (const file of walkFiles(skillsDir)) {
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const name of extractKampusRefs(text)) {
			if (isRealPackage(packagesDir, name)) seen.add(name);
		}
	}
	return [...seen].sort();
};

/**
 * The sorted, deduped set of `<pkg>` slugs invoked by bare repo path with no
 * published `pnpm dlx` fallback anywhere they're invoked — the foreign-repo breaks
 * (#976/#975). Folds `extractUnpublishedInvocations` per file: a slug is a break
 * iff at least one skill file invokes it by path without a co-located fallback.
 * A missing/unreadable dir yields `[]`.
 */
export const unpublishedInvocationBreaks = (skillsDir: string): ReadonlyArray<string> => {
	const broken = new Set<string>();
	for (const file of walkFiles(skillsDir)) {
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const name of extractUnpublishedInvocations(text)) broken.add(name);
	}
	return [...broken].sort();
};
