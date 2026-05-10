#!/usr/bin/env node
/**
 * One-off importer that seeds the per-post `PanoPost` Agents from the
 * in-worker SEED_POSTS array. Mirrors `import-sozluk.ts` but the source data
 * lives next to the worker (no MDX), so the script is just an HTTP trigger
 * for the dev-only `/api/admin/pano/seed` endpoint.
 *
 * Usage:
 *   node --experimental-strip-types apps/web/scripts/import-pano.ts
 *   node --experimental-strip-types apps/web/scripts/import-pano.ts --clear --post-ids=p_a,p_b
 *   node --experimental-strip-types apps/web/scripts/import-pano.ts --base-url=https://...
 *
 * Or via the package script:
 *   pnpm pano:import [-- --clear --post-ids=p_a,p_b]
 */

const DEFAULT_BASE_URL = "http://localhost:3000";

type Args = {
	baseUrl: string;
	clear: boolean;
	postIds: string[];
};

function parseArgs(argv: string[]): Args {
	let baseUrl = DEFAULT_BASE_URL;
	let clear = false;
	let postIds: string[] = [];

	for (const arg of argv) {
		if (arg === "--clear") clear = true;
		else if (arg.startsWith("--base-url=")) baseUrl = arg.slice("--base-url=".length);
		else if (arg.startsWith("--post-ids=")) {
			postIds = arg
				.slice("--post-ids=".length)
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
		} else if (arg.startsWith("--")) {
			throw new Error(`Unknown flag: ${arg}`);
		}
	}

	return {baseUrl, clear, postIds};
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
	console.log(`target:   ${args.baseUrl}`);

	const result = (await postJson(`${args.baseUrl}/api/admin/pano/seed`, {
		clear: args.clear,
		postIds: args.postIds,
	})) as {inserted: number; postIds: string[]; cleared: {posts: number}};

	console.log(`inserted: ${result.inserted} post(s)`);
	console.log(`postIds:  ${result.postIds.join(", ")}`);
	if (args.clear) console.log(`cleared:  ${result.cleared.posts} post(s)`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
