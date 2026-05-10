#!/usr/bin/env node
/**
 * One-off importer that ingests sözlük MDX files from the legacy monorepo
 * (~/code/github.com/kamp-us/monorepo/packages/sozluk-content/terms) into
 * the running Sozluk DO via /api/admin/sozluk/*.
 *
 * Each MDX file is one term: filename → slug, frontmatter `title` → title,
 * markdown body → ONE definition. Files with empty bodies are skipped.
 *
 * Authorship: legacy MDX has no author metadata, so every imported definition
 * is attributed to a synthetic `kampus` system author. Score defaults to 0.
 *
 * Usage:
 *   node --experimental-strip-types apps/web/scripts/import-sozluk.ts [path]
 *   node --experimental-strip-types apps/web/scripts/import-sozluk.ts --clear
 *   node --experimental-strip-types apps/web/scripts/import-sozluk.ts --base-url=https://...
 *
 * Or via the package script:
 *   pnpm sozluk:import [-- --clear --base-url=...]
 */

import {readdir, readFile} from "node:fs/promises";
import {homedir} from "node:os";
import {basename, join, resolve} from "node:path";

const DEFAULT_TERMS_DIR = join(
	homedir(),
	"code/github.com/kamp-us/monorepo/packages/sozluk-content/terms",
);
const DEFAULT_BASE_URL = "http://localhost:3000";
const SYSTEM_AUTHOR = {authorId: "kampus", authorName: "kampus"};

type Args = {
	termsDir: string;
	baseUrl: string;
	clear: boolean;
};

function parseArgs(argv: string[]): Args {
	let termsDir = DEFAULT_TERMS_DIR;
	let baseUrl = DEFAULT_BASE_URL;
	let clear = false;

	for (const arg of argv) {
		if (arg === "--clear") clear = true;
		else if (arg.startsWith("--base-url=")) baseUrl = arg.slice("--base-url=".length);
		else if (arg.startsWith("--")) {
			throw new Error(`Unknown flag: ${arg}`);
		} else {
			termsDir = resolve(arg);
		}
	}

	return {termsDir, baseUrl, clear};
}

type ParsedTerm = {
	slug: string;
	title: string;
	body: string;
};

/**
 * Tiny YAML frontmatter parser — just enough for the legacy MDX shape:
 *
 *   ---
 *   title: Foo - Bar
 *   tags:
 *     - foo
 *     - bar
 *   ---
 *
 * We only need `title`. Returns the title string (or null if missing) and the
 * remaining markdown body.
 */
function parseFrontmatter(raw: string): {title: string | null; body: string} {
	if (!raw.startsWith("---\n")) return {title: null, body: raw};
	const end = raw.indexOf("\n---", 4);
	if (end === -1) return {title: null, body: raw};

	const fm = raw.slice(4, end);
	const body = raw.slice(end + 4).replace(/^\n/, "");

	let title: string | null = null;
	for (const line of fm.split("\n")) {
		const m = line.match(/^title:\s*(.+?)\s*$/);
		if (m?.[1]) {
			title = m[1].replace(/^["']|["']$/g, "");
			break;
		}
	}

	return {title, body};
}

async function loadTerms(dir: string): Promise<ParsedTerm[]> {
	const entries = await readdir(dir);
	const out: ParsedTerm[] = [];

	for (const file of entries) {
		if (!file.endsWith(".mdx")) continue;
		const slug = basename(file, ".mdx");
		const raw = await readFile(join(dir, file), "utf8");
		const {title, body} = parseFrontmatter(raw);
		const trimmed = body.trim();
		if (!trimmed) continue; // skip empty-body terms — frontmatter-only stubs in the legacy repo
		out.push({slug, title: title ?? slug, body: trimmed});
	}

	out.sort((a, b) => a.slug.localeCompare(b.slug));
	return out;
}

async function postJson(url: string, body: unknown): Promise<unknown> {
	const res = await fetch(url, {
		method: "POST",
		headers: {"content-type": "application/json"},
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`POST ${url} → ${res.status}: ${text}`);
	}
	return res.json();
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	console.log(`source:   ${args.termsDir}`);
	console.log(`target:   ${args.baseUrl}`);

	const terms = await loadTerms(args.termsDir);
	console.log(`found:    ${terms.length} term(s) with non-empty bodies`);

	if (args.clear) {
		// Per-term DOs are addressed by slug; the clear endpoint walks the
		// slugs we tell it about. Pass every slug the source provides plus
		// the legacy "kampus" singleton for safety.
		const slugs = terms.map((t) => t.slug);
		const result = (await postJson(`${args.baseUrl}/api/admin/sozluk/clear`, {slugs})) as {
			terms: number;
			definitions: number;
		};
		console.log(`cleared:  ${result.terms} terms, ${result.definitions} definitions`);
	}

	let inserted = 0;
	let skipped = 0;
	for (const term of terms) {
		const result = (await postJson(`${args.baseUrl}/api/admin/sozluk/upsert-term`, {
			slug: term.slug,
			title: term.title,
			definitions: [{...SYSTEM_AUTHOR, body: term.body, score: 0}],
		})) as {termId: string; insertedDefinitions: number};

		if (result.insertedDefinitions > 0) {
			inserted++;
			console.log(`  + ${term.slug} (${result.insertedDefinitions} definition)`);
		} else {
			skipped++;
			console.log(`  = ${term.slug} (already up to date)`);
		}
	}

	console.log(`done:     ${inserted} inserted, ${skipped} skipped`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
