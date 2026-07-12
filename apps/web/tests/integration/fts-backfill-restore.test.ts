/**
 * fts-backfill as the D1-restore FTS rebuild path (#2754) — the restore-scenario
 * complement to `fts-backfill.test.ts` (#645). That test proves ONE deleted FTS
 * row is re-findable; this one proves the whole D1-restore condition: BOTH FTS
 * virtual tables emptied (a restore drops the virtual tables and recreates them
 * bare — D1 can't export them, ADR 0080), base `term_record` / `post_record` rows
 * intact, then a single `fts-backfill run` reconstructs the entire index from
 * those base rows alone.
 *
 * Why this scenario needs its own dedicated stage: it truncates `term_search` /
 * `post_search` wholesale, which would clobber a sibling file's corpus on a shared
 * stage. `integrationStack` gives it an isolated D1 (ADR 0104), so the wipe is
 * scoped to this file's rows.
 *
 * What it pins beyond #645, closing #2754's acceptance criteria against the REAL
 * D1 FTS5 engine (≠ `node:sqlite`'s, so an integration-tier fact per ADR 0082):
 *   - row counts: the bin reports ≥1 term AND ≥1 post re-indexed;
 *   - exact MATCH: a full folded token finds the rebuilt term and post;
 *   - prefix MATCH: a 3–4 char prefix finds them too — proving the `prefix='2 3 4'`
 *     index (`0002_search_fts.sql`) is reconstructed from base rows, not just the
 *     full-token postings.
 * The pre-backfill empty-search assertion is the non-vacuity guard: a post-run hit
 * can only be the backfill's doing, never a surviving index row.
 */
import {execFile} from "node:child_process";
import {join} from "node:path";
import {promisify} from "node:util";
import {beforeAll, describe, expect, it} from "vitest";
import {integrationStack} from "./_integration.ts";

const execFileAsync = promisify(execFile);

// The shipped production CLI entrypoint, run exactly as the one-time data-op runs
// it (`node src/bin.ts run`). `apps/web/tests/integration/` → repo root is four up.
const BIN_PATH = join(import.meta.dirname, "../../../../packages/fts-backfill/src/bin.ts");

const h = integrationStack(import.meta.url);

const STAMP = Date.now();

const TERM_SLUG = `fts2754-${STAMP}-sisli`;
// Turkish-diacritic titles whose folded token streams differ from the literal and
// share NO folded token with each other, so a term query never masks a post hit.
const TERM_TITLE = "Şişli Büyük Buluşma"; // folds → "sisli buyuk bulusma"
const POST_TITLE = "Kadıköy Yazılım Şenliği"; // folds → "kadikoy yazilim senligi"

// Exact = a full folded token; prefix = a 3–4 char incomplete prefix of one.
const TERM_EXACT = "sisli";
const TERM_PREFIX = "sis";
const POST_EXACT = "yazilim";
const POST_PREFIX = "kadi";

let author: {userId: string; cookie: string};
let postId: string;

interface Conn<N> {
	items: Array<{node: N}>;
}

const searchTermSlugs = async (query: string): Promise<string[]> => {
	const res = await h.fate({kind: "list", name: "searchTerms", args: {query}, select: ["slug"]});
	expect(res.ok, `searchTerms(${query}) failed`).toBe(true);
	if (!res.ok) return [];
	return (res.data as Conn<{slug: string}>).items.map((e) => e.node.slug);
};

const searchPostIds = async (query: string): Promise<string[]> => {
	const res = await h.fate(
		{kind: "list", name: "searchPosts", args: {query}, select: ["id"]},
		{cookie: author.cookie},
	);
	expect(res.ok, `searchPosts(${query}) failed`).toBe(true);
	if (!res.ok) return [];
	return (res.data as Conn<{id: string}>).items.map((e) => e.node.id);
};

beforeAll(async () => {
	author = await h.signUp(`${TERM_SLUG}-author@test.local`, "hunter2hunter2", "anka");
	// Seed both a term and a post through the PUBLIC dual-write, so each base row
	// lands with its FTS row — the exact state a healthy DB is in before a restore.
	await h.seedTerm({
		slug: TERM_SLUG,
		title: TERM_TITLE,
		definitions: [{authorName: "anka", body: "Şişli gövde"}],
	});
	const submit = await h.fate(
		{
			kind: "mutation",
			name: "post.submit",
			input: {title: POST_TITLE, tags: [{kind: "tartışma"}]},
			select: ["id"],
		},
		{cookie: author.cookie},
	);
	expect(submit.ok).toBe(true);
	if (!submit.ok) throw new Error(`seedPost failed: ${submit.error.code}`);
	postId = (submit.data as {id: string}).id;

	// The restore condition: wipe BOTH FTS virtual tables wholesale (base rows kept),
	// reproducing a D1 restore that recreated the search tables empty.
	await h.execD1("DELETE FROM term_search", []);
	await h.execD1("DELETE FROM post_search", []);
});

describe("fts-backfill rebuilds the whole FTS index from restored base rows (#2754)", () => {
	it("reconstructs term_search + post_search from base rows alone (row counts + exact + prefix MATCH)", async () => {
		// Non-vacuity: with both FTS tables emptied, nothing matches.
		expect(await searchTermSlugs(TERM_EXACT)).not.toContain(TERM_SLUG);
		expect(await searchPostIds(POST_EXACT)).not.toContain(postId);

		// Run the REAL shipped bin against this stage's D1 — the D1-restore step-3
		// rebuild path #2703's runbook cites. A non-zero exit throws and fails here.
		const {accountId, databaseId} = await h.d1Target();
		const {stdout} = await execFileAsync(
			process.execPath,
			[BIN_PATH, "run", "--database-id", databaseId, "--account-id", accountId],
			{env: process.env},
		);

		// Row counts: the bin reports how many of each kind it re-indexed; the seeded
		// term + post are among them (it scans the whole corpus, so assert ≥ 1 each).
		const terms = stdout.match(/re-indexed (\d+) term/);
		const posts = stdout.match(/(\d+) post/);
		expect(terms, `no term count in bin output:\n${stdout}`).not.toBeNull();
		expect(posts, `no post count in bin output:\n${stdout}`).not.toBeNull();
		expect(Number(terms?.[1])).toBeGreaterThanOrEqual(1);
		expect(Number(posts?.[1])).toBeGreaterThanOrEqual(1);

		// Exact MATCH: a full folded token finds each rebuilt row.
		expect(await searchTermSlugs(TERM_EXACT)).toContain(TERM_SLUG);
		expect(await searchPostIds(POST_EXACT)).toContain(postId);

		// Prefix MATCH: a 3–4 char prefix finds them too, proving the `prefix='2 3 4'`
		// index was rebuilt from the base rows, not just the full-token postings.
		expect(await searchTermSlugs(TERM_PREFIX)).toContain(TERM_SLUG);
		expect(await searchPostIds(POST_PREFIX)).toContain(postId);
	});
});
