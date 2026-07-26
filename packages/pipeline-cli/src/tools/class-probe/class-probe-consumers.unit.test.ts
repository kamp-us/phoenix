import {readdirSync, readFileSync} from "node:fs";
import {dirname, join, relative} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";

// Regression coverage for #4231: `class-probe`'s stdin branch REFUSES with exit 4 on a failed read
// (#4010) and prints NOTHING, so a consumer that captures only stdout converts the refusal into an
// empty namespace set — and an empty required set makes every per-namespace check vacuously true.
// The consumers live in markdown (agent/skill bash fences), so the only place this can be pinned
// mechanically is here: scan the LIVE corpus, not a fixture, the same way class-probe.unit.test.ts
// pins the §CLASS probes off the on-disk contract.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const CORPUS_ROOT = join(REPO_ROOT, "claude-plugins/kampus-pipeline");

const RUNNABLE_LANGS = new Set(["bash", "sh", "shell", "zsh"]);
const FENCE = /^\s*(?:```|~~~)\s*(\w*)/;
/** Blockquoted fences are runnable too — an agent copies a `> `-prefixed snippet the same way. */
const unquote = (line: string): string => line.replace(/^(\s*>)+\s?/, "");
const COMMENT_ONLY = /^\s*#/;
/** The consumer under test: the namespace-set read whose empty stdout is indistinguishable from a refusal. */
const NAMESPACE_READ = "class-probe classify --namespaces";

const markdownFiles = (dir: string): ReadonlyArray<string> =>
	readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) return markdownFiles(full);
		return entry.isFile() && entry.name.endsWith(".md") ? [full] : [];
	});

interface Site {
	readonly file: string;
	readonly line: number;
	/** The logical statement, backslash-continuations joined. */
	readonly text: string;
}

/** Every runnable-fence statement that reads the namespace set, with `\`-continuations joined. */
const namespaceReadSites = (file: string, content: string): ReadonlyArray<Site> => {
	const sites: Site[] = [];
	const lines = content.split("\n");
	let openLang: string | null = null;
	for (let i = 0; i < lines.length; i++) {
		const raw = unquote(lines[i] ?? "");
		const fence = raw.match(FENCE);
		if (fence !== null) {
			openLang = openLang === null ? (fence[1] ?? "").toLowerCase() : null;
			continue;
		}
		if (openLang === null || !RUNNABLE_LANGS.has(openLang)) continue;
		if (COMMENT_ONLY.test(raw)) continue;
		let text = raw;
		let j = i;
		while (text.trimEnd().endsWith("\\") && j + 1 < lines.length) {
			j++;
			text = `${text.trimEnd().slice(0, -1)} ${unquote(lines[j] ?? "").trim()}`;
		}
		if (text.includes(NAMESPACE_READ)) sites.push({file, line: i + 1, text});
		i = j;
	}
	return sites;
};

const SITES = markdownFiles(CORPUS_ROOT).flatMap((file) =>
	namespaceReadSites(relative(REPO_ROOT, file), readFileSync(file, "utf8")),
);

describe("class-probe namespace-set consumers observe the probe's exit status (#4231)", () => {
	// §ZS / ADR 0092: a scan that found nothing is a broken scan, not a pass — without this the whole
	// suite goes green the moment the fence parser or the corpus path regresses.
	it("scans a non-empty corpus", () => {
		expect(markdownFiles(CORPUS_ROOT).length).toBeGreaterThan(0);
		expect(SITES.length).toBeGreaterThanOrEqual(3);
	});

	it.each(
		SITES.map((s) => [`${s.file}:${s.line}`, s] as const),
	)("%s captures the probe into a variable", (_id, site) => {
		expect(site.text).toMatch(/^\s*[A-Za-z_]\w*="\$\(/);
	});

	it.each(
		SITES.map((s) => [`${s.file}:${s.line}`, s] as const),
	)("%s puts nothing after the probe inside the capture — `pipefail` is off (#4146), so a trailing stage's 0 would mask exit 4", (_id, site) => {
		const afterProbe = site.text.slice(site.text.indexOf(NAMESPACE_READ) + NAMESPACE_READ.length);
		const insideCapture = afterProbe.slice(0, afterProbe.indexOf(')"'));
		expect(insideCapture).not.toContain("|");
	});

	it.each(
		SITES.map((s) => [`${s.file}:${s.line}`, s] as const),
	)("%s reads the capture's exit status rather than discarding it", (_id, site) => {
		const afterProbe = site.text.slice(site.text.indexOf(NAMESPACE_READ) + NAMESPACE_READ.length);
		const tail = afterProbe.slice(afterProbe.indexOf(')"') + 2);
		// Either the status is stashed (`; RC=$?`) for an explicit branch, or the statement bails inline.
		expect(tail).toMatch(/^\s*(;\s*[A-Za-z_]\w*=\$\?|\|\|)/);
	});

	it.each(
		SITES.map((s) => [`${s.file}:${s.line}`, s] as const),
	)("%s refuses on a non-zero status somewhere below the capture", (_id, site) => {
		const stashed = site.text.match(/;\s*([A-Za-z_]\w*)=\$\?/);
		if (stashed === null) return; // the inline-`||` form carries its own refusal
		const body = readFileSync(join(REPO_ROOT, site.file), "utf8");
		const rc = stashed[1] as string;
		expect(body).toMatch(new RegExp(`\\[\\s*"\\$${rc}"\\s*-ne\\s*0\\s*\\]`));
	});

	// The third outcome: a success exit that names ZERO namespaces is still UNKNOWN, never
	// "no namespaces required" — it must be refused separately from the exit-status refusal, so the
	// two stay distinguishable in the transcript.
	it.each(
		[...new Set(SITES.map((s) => s.file))].map((f) => [f] as const),
	)("%s also refuses a zero-length namespace set", (file) => {
		expect(readFileSync(join(REPO_ROOT, file), "utf8")).toMatch(/zero scope/i);
	});
});
