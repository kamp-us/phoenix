/**
 * The in-process half: every verb's outcome — its code, its stdout bytes and the state words it
 * keeps apart — driven over scripted reads rather than a real filesystem or a real GitHub.
 *
 * The property under test throughout is the three-state law: a proven negative is an exit-`0` token,
 * an unread source is `unknown`, and the two never collapse.
 */
import {Effect, Layer} from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {describe, expect, it} from "vitest";
import {audienceLabel, type BoardVocabulary, statusList, typeLabel} from "../config/board.ts";
import {SURFACE_REGISTRY} from "../config/keys/surface-dispositions.ts";
import * as report from "../exit-codes.ts";
import {fakeFs, fakeHttp, fakeSeams, fakeShell, type HttpReply} from "../fakes.test-support.ts";
import {ok} from "../io/git.ts";
import {latestPublishedVersion} from "../io/npm.ts";
import type {StdinRead} from "../io/stdin.ts";
import {AWAITING_RELEASE, DEFAULT_STATUS_NAMES, PLANNED, STATUSES} from "../labels.ts";
import {coderTemplateText} from "../lane/fixtures.test-support.ts";
import {DEFAULT_STALE_MINUTES} from "../lane/stale.ts";
import {runStale} from "../lane/stale-verb.ts";
import {DEFAULT_CHORES_ROOT, DEFAULT_LANES_ROOT} from "../lane/store.ts";
import {
	AUDIENCES,
	PRIORITIES,
	parkedFacets,
	STANDING_LANES,
	TYPES,
	triagedFacets,
} from "../triage/facets.ts";
import {ANSWER} from "../verb.ts";
import {type BoardRead, type Bucket, boardState, runBoard} from "./board-verb.ts";
import {
	BUILDABLE_SURFACES,
	CLAUDE_MD_MARKER,
	CLAUDE_MD_SECTION,
	FABRIKA_IGNORE_ROW,
	findSurface,
	ISSUE_SHAPE_MARKERS,
	knownIds,
	LABEL_DESCRIPTION,
	MARKER_COLOR,
	roadmapCount,
	runBootstrap,
	SETTINGS_PATCH,
	TAXONOMY,
	taxonomy as taxonomyFor,
} from "./bootstrap-verb.ts";
import {
	NOT_BUILDABLE,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {noAsOf, oneLine, readNow} from "./fields.ts";
import {runMenu} from "./menu-verb.ts";
import {
	badFieldRefusal,
	boardField,
	lanesField,
	menuField,
	readoutField,
	runOpen,
	settingsField,
} from "./open-verb.ts";
import {ARTIFACT_TITLE, digestComment, issueNumberOf, runReadout} from "./readout-verb.ts";
import {
	IN_REPO_ROSTER,
	PLUGIN_MANIFEST,
	parseFrontmatter,
	type RosterRead,
	type RosterSkill,
	type RosterSources,
	readRoster,
	resolveRosterPath,
	skillFrom,
} from "./roster.ts";

const AS_OF = readNow("2026-08-09T14:22:03Z");

const skill = (name: string, text: string): RosterSkill => skillFrom(name, text);

const resolvedRoster = (skills: ReadonlyArray<RosterSkill>): RosterRead => ({
	_tag: "Resolved",
	path: "/abs/claude-plugins/fabrika/skills",
	display: "claude-plugins/fabrika/skills",
	tier: "repo",
	skills,
	unreadableFrontmatter: skills.filter((s) => !s.frontmatterReadable).length,
});

describe("the roster row", () => {
	it("reads the frontmatter's description and the invocation axis", () => {
		const row = skill(
			"front-door",
			"---\nname: front-door\ndisable-model-invocation: true\ndescription: The front door.\n---\n",
		);
		expect(row.invocation).toBe("/fabrika:front-door");
		expect(row.invocationAxis).toBe("user");
		expect(row.description).toBe("The front door.");
	});

	it("defaults the axis to model when the flag is absent", () => {
		expect(skill("build", "---\nname: build\ndescription: d\n---\n").invocationAxis).toBe("model");
	});

	/** A dropped row is a skill the reader will never know exists — the false absence of #4105. */
	it("emits a row saying so when the frontmatter cannot be parsed, rather than dropping it", () => {
		const row = skill("broken", "# no frontmatter at all\n");
		expect(parseFrontmatter("# no frontmatter at all\n")).toBeNull();
		expect(row.description).toBe("unknown (frontmatter unreadable)");
		expect(row.frontmatterReadable).toBe(false);
	});
});

/**
 * The rung order, and the one rung that answers in the shape #5775 reported: the CLI running out of
 * a phoenix checkout while the cwd is a repo that carries no roster of its own.
 */
describe("the roster's resolution ladder", () => {
	const CHECKOUT = "/home/dev/phoenix";
	const MODULE_DIR = `${CHECKOUT}/packages/fabrika-cli/src/status`;
	const FOREIGN = "/home/dev/demlik";
	const SKILL_TEXT = "---\nname: build\ndescription: d\n---\n";

	const CACHE = "/home/dev/.claude/plugins/cache";
	const manifest = (name: string) => JSON.stringify({name});

	const tree = (over: Parameters<typeof fakeFs>[0]) => fakeFs(over);

	/** Every rung's inputs, so a case names only the one it is about. */
	const sources = (over: Partial<RosterSources>): RosterSources => ({
		explicit: null,
		pluginRootEnv: null,
		pluginCache: null,
		moduleDir: MODULE_DIR,
		cwd: FOREIGN,
		...over,
	});

	/** One cached plugin version, as Claude Code lays the cache out: marketplace/plugin/version. */
	const cached = (version: string, declared: string, markers: ReadonlyArray<string> = []) => {
		const root = `${CACHE}/kampus/fabrika/${version}`;
		return {
			root,
			files: {
				[`${root}/${PLUGIN_MANIFEST}`]: manifest(declared),
				...Object.fromEntries(markers.map((marker) => [`${root}/${marker}`, "1786000000000"])),
			},
			directories: [`${root}/skills`],
		};
	};

	const cacheTree = (versions: ReadonlyArray<ReturnType<typeof cached>>, over = {}) =>
		tree({
			dirs: {
				[CACHE]: ["kampus"],
				[`${CACHE}/kampus`]: ["fabrika"],
				[`${CACHE}/kampus/fabrika`]: versions.map((v) => v.root.split("/").pop() as string),
			},
			files: Object.assign({}, ...versions.map((v) => v.files)),
			directories: versions.flatMap((v) => v.directories),
			...over,
		});

	const resolve = (sources: RosterSources, fs: ReturnType<typeof fakeFs>) =>
		Effect.runPromise(Effect.provide(resolveRosterPath(sources), fs.layer));

	const read = (sources: RosterSources, fs: ReturnType<typeof fakeFs>) =>
		Effect.runPromise(Effect.provide(readRoster(sources), fs.layer));

	const checkoutRoster = `${CHECKOUT}/${IN_REPO_ROSTER}`;

	it("resolves the CLI's own checkout when the cwd is a repo carrying no roster", async () => {
		const resolved = await resolve(sources({}), tree({directories: [checkoutRoster]}));
		expect(resolved?.tier).toBe("checkout");
		expect(resolved?.path).toBe(checkoutRoster);
	});

	/** `display` is what a session transcript keeps; an absolute path there is a machine-local leak. */
	it("prints the checkout rung as a repo-relative path, never the absolute one", async () => {
		const resolved = await resolve(sources({}), tree({directories: [checkoutRoster]}));
		expect(resolved?.display).toBe(IN_REPO_ROSTER);
		expect(resolved?.display.startsWith("/")).toBe(false);
	});

	it("keeps the cwd's own roster ahead of the checkout's when both are there", async () => {
		const resolved = await resolve(
			sources({}),
			tree({directories: [checkoutRoster, `${FOREIGN}/${IN_REPO_ROSTER}`]}),
		);
		expect(resolved?.tier).toBe("repo");
		expect(resolved?.path).toBe(`${FOREIGN}/${IN_REPO_ROSTER}`);
	});

	/**
	 * The `plugin` rung's one live shape: a CLI vendored *inside* a plugin tree. Neither shape
	 * fabrika itself ships in packages it that way, so this is the consumer case the rung is kept
	 * for, constructed here rather than left as coverage nothing exercises (#6448).
	 */
	it("keeps a CLI bundled inside a plugin ahead of both implicit checkout rungs", async () => {
		const installed = "/vendored/fabrika";
		const resolved = await resolve(
			sources({moduleDir: `${installed}/cli/src/status`}),
			tree({
				directories: [checkoutRoster],
				files: {[`${installed}/${PLUGIN_MANIFEST}`]: manifest("fabrika")},
			}),
		);
		expect(resolved?.tier).toBe("plugin");
		expect(resolved?.path).toBe(`${installed}/skills`);
		expect(resolved?.display).toBe("fabrika/skills");
	});

	/**
	 * The marketplace shape, where the CLI is a global npm package outside the plugin cache: no walk
	 * from the module or the cwd can reach the roster, so the cache rung is the only answer (#6448).
	 */
	it("resolves the installed plugin out of Claude Code's cache when no walk can reach it", async () => {
		const live = cached("602283e56c60", "fabrika");
		const resolved = await resolve(
			sources({pluginCache: CACHE}),
			cacheTree([cached("0dd9a537e17c", "fabrika", [".orphaned_at", ".in_use"]), live]),
		);
		expect(resolved?.tier).toBe("cache");
		expect(resolved?.path).toBe(`${live.root}/skills`);
	});

	/** The cache path carries a content hash that changes on every update — never print one. */
	it("prints the cache rung by the manifest's declared name, never the hashed path", async () => {
		const resolved = await resolve(
			sources({pluginCache: CACHE}),
			cacheTree([cached("602283e56c60", "fabrika")]),
		);
		expect(resolved?.display).toBe("fabrika/skills");
		expect(resolved?.display.includes("602283e56c60")).toBe(false);
	});

	/** A cache holds every plugin the machine has installed; only fabrika's own roster is fabrika's. */
	it("skips a cached plugin whose manifest declares another name", async () => {
		const resolved = await resolve(
			sources({pluginCache: CACHE}),
			cacheTree([cached("aaaaaaaaaaaa", "some-other-plugin")]),
		);
		expect(resolved).toBeNull();
	});

	/**
	 * The cache sits below both walking rungs: a phoenix developer has an installed plugin *and* a
	 * checkout, and reading the published roster there would render something the working tree does
	 * not have — the dev shape #5775 was fixed to serve.
	 */
	it("keeps the CLI's own checkout ahead of the installed plugin's cache", async () => {
		const resolved = await resolve(
			sources({pluginCache: CACHE}),
			cacheTree([cached("602283e56c60", "fabrika")], {
				directories: [checkoutRoster, `${CACHE}/kampus/fabrika/602283e56c60/skills`],
			}),
		);
		expect(resolved?.tier).toBe("checkout");
		expect(resolved?.path).toBe(checkoutRoster);
	});

	/** `.in_use` is the tiebreak the harness itself writes; the ordering must not be the hash's. */
	it("prefers a cached version a live session holds when two are unorphaned", async () => {
		const held = cached("zzzzzzzzzzzz", "fabrika", [".in_use"]);
		const resolved = await resolve(
			sources({pluginCache: CACHE}),
			cacheTree([cached("aaaaaaaaaaaa", "fabrika"), held]),
		);
		expect(resolved?.path).toBe(`${held.root}/skills`);
	});

	/** A half-written cache entry is not a roster: it must not claim one and then fail the read. */
	it("skips a cached version carrying no skills directory", async () => {
		const resolved = await resolve(
			sources({pluginCache: CACHE}),
			cacheTree([{...cached("602283e56c60", "fabrika"), directories: []}]),
		);
		expect(resolved).toBeNull();
	});

	/** The harness's own answer where it exists — and it does not exist for a plain Bash call. */
	it("takes $CLAUDE_PLUGIN_ROOT ahead of the cache when the harness set one", async () => {
		const injected = "/plugins/fabrika-head";
		const resolved = await resolve(
			sources({pluginRootEnv: injected, pluginCache: CACHE}),
			cacheTree([cached("602283e56c60", "fabrika")], {
				files: {[`${injected}/${PLUGIN_MANIFEST}`]: manifest("fabrika")},
			}),
		);
		expect(resolved?.tier).toBe("env");
		expect(resolved?.path).toBe(`${injected}/skills`);
	});

	/** A variable pointing nowhere is not an answer; the ladder below it still has to run. */
	it("falls through when $CLAUDE_PLUGIN_ROOT names a directory holding no plugin manifest", async () => {
		const live = cached("602283e56c60", "fabrika");
		const resolved = await resolve(
			sources({pluginRootEnv: "/plugins/gone", pluginCache: CACHE}),
			cacheTree([live]),
		);
		expect(resolved?.tier).toBe("cache");
		expect(resolved?.path).toBe(`${live.root}/skills`);
	});

	it("still keeps an explicitly-passed path ahead of the env rung", async () => {
		const injected = "/plugins/fabrika-head";
		const resolved = await resolve(
			sources({explicit: "/mine/skills", pluginRootEnv: injected}),
			tree({files: {[`${injected}/${PLUGIN_MANIFEST}`]: manifest("fabrika")}}),
		);
		expect(resolved?.tier).toBe("explicit");
		expect(resolved?.path).toBe("/mine/skills");
	});

	/** The `menu` and `config` fields the front door exists to answer — the defect #6448 reported. */
	it("renders the marketplace shape's roster rather than the unknown #6448 reported", async () => {
		const live = cached("602283e56c60", "fabrika");
		const out = await read(
			sources({pluginCache: CACHE}),
			cacheTree([live], {
				dirs: {
					[CACHE]: ["kampus"],
					[`${CACHE}/kampus`]: ["fabrika"],
					[`${CACHE}/kampus/fabrika`]: ["602283e56c60"],
					[`${live.root}/skills`]: ["build"],
				},
				directories: [`${live.root}/skills`, `${live.root}/skills/build`],
				files: {
					...live.files,
					[`${live.root}/skills/build/SKILL.md`]: SKILL_TEXT,
				},
			}),
		);
		expect(out._tag).toBe("Resolved");
		if (out._tag !== "Resolved") return;
		expect(out.tier).toBe("cache");
		expect(out.skills.map((s) => s.name)).toEqual(["build"]);
		expect(runMenu({roster: out, asOf: AS_OF, json: false}).code).toBe(ANSWER);
	});

	it("reads the checkout roster's skills rather than reporting the target repo bare", async () => {
		const out = await read(
			sources({}),
			tree({
				directories: [checkoutRoster, `${checkoutRoster}/build`],
				dirs: {[checkoutRoster]: ["build"]},
				files: {[`${checkoutRoster}/build/SKILL.md`]: SKILL_TEXT},
			}),
		);
		expect(out._tag).toBe("Resolved");
		if (out._tag !== "Resolved") return;
		expect(out.tier).toBe("checkout");
		expect(out.skills.map((s) => s.name)).toEqual(["build"]);
	});

	/** A resolved roster holding nothing is a fact at exit 0 — the added rung must not change that. */
	it("keeps a resolved-but-empty checkout roster `empty`, never unknown", async () => {
		const out = await read(
			sources({}),
			tree({directories: [checkoutRoster], dirs: {[checkoutRoster]: []}}),
		);
		expect(out._tag).toBe("Resolved");
		const menu = runMenu({roster: out, asOf: AS_OF, json: false});
		expect(menu.code).toBe(ANSWER);
		expect(menu.stdout).toBe("menu\tempty\t0\t2026-08-09T14:22:03Z\n");
	});

	/** An explicit path is the caller's claim; no implicit rung may rescue it. */
	it("still seats an explicitly-passed absent --skills-dir on AbsentExplicit", async () => {
		const out = await read(
			sources({explicit: "/nope"}),
			tree({directories: [checkoutRoster], dirs: {[checkoutRoster]: ["build"]}}),
		);
		expect(out._tag).toBe("AbsentExplicit");
		expect(runMenu({roster: out, asOf: AS_OF, json: false}).code).toBe(7);
	});

	it("still fails when no rung answers", async () => {
		const out = await read(sources({}), tree({}));
		expect(out._tag).toBe("Failed");
		if (out._tag !== "Failed") return;
		expect(out.reason).toBe("no roster resolved — pass --skills-dir");
	});
});

describe("status menu", () => {
	it("renders a resolved roster at exit 0, one line per skill", () => {
		const out = runMenu({
			roster: resolvedRoster([skill("build", "---\nname: build\ndescription: d\n---\n")]),
			asOf: AS_OF,
			json: false,
		});
		expect(out.code).toBe(ANSWER);
		expect(out.stdout).toBe(
			"menu\tready\t1\t2026-08-09T14:22:03Z\nskill\tbuild\t/fabrika:build\tmodel\td\n",
		);
	});

	/** An implicitly-resolved roster holding zero skills is a FACT, not a refusal. */
	it("renders an empty roster as `empty` at exit 0, never silence", () => {
		const out = runMenu({roster: resolvedRoster([]), asOf: AS_OF, json: false});
		expect(out.code).toBe(ANSWER);
		expect(out.stdout).toBe("menu\tempty\t0\t2026-08-09T14:22:03Z\n");
	});

	it("seats an explicitly-passed absent path on 7 and an unreadable roster on 11 — never one code", () => {
		const seven = runMenu({
			roster: {_tag: "AbsentExplicit", path: "/nope", display: "/nope"},
			asOf: AS_OF,
			json: false,
		});
		const eleven = runMenu({
			roster: {_tag: "Failed", path: "/x", display: "x", reason: "EACCES"},
			asOf: AS_OF,
			json: false,
		});
		expect(seven.code).toBe(ZERO_SCOPE);
		expect(eleven.code).toBe(PRECONDITION_UNKNOWN);
		expect(seven.code).not.toBe(eleven.code);
		expect(seven.stdout).toBe("");
		expect(eleven.stdout).toBe("");
	});
});

describe("status board", () => {
	const counted = (name: string, count: number): Bucket => ({
		name,
		count,
		selector: `labels=${name}`,
		detail: null,
		asOf: AS_OF,
	});
	const absentLabel = (name: string): Bucket => ({
		name,
		count: null,
		selector: `labels=${name}`,
		detail: "label absent",
		asOf: noAsOf,
	});

	/** A zero count means the label exists and nothing carries it; an absent label is unaskable. */
	it("renders an absent label as `unknown`, never as 0", () => {
		const read: BoardRead = {
			_tag: "Read",
			repo: "acme/storefront",
			buckets: [absentLabel("needs-triage"), counted("in-flight", 0)],
		};
		expect(boardState(read.buckets)).toBe("unknown");
		const out = runBoard({read, json: false});
		expect(out.code).toBe(ANSWER);
		expect(out.stdout).toContain(
			"bucket\tneeds-triage\tunknown\tlabels=needs-triage\tlabel absent\tunknown",
		);
		expect(out.stdout).toContain("bucket\tin-flight\t0\t");
	});

	it("refuses on 11 when the repository could not be read at all", () => {
		const out = runBoard({
			read: {_tag: "Failed", repo: "acme/storefront", reason: "EAI_AGAIN"},
			json: false,
		});
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("never 0");
	});
});

describe("status readout", () => {
	it("takes the MOST RECENTLY UPDATED comment carrying the heading, so staleness cannot hide", () => {
		const picked = digestComment([
			{body: "## Governance readout\nold", updatedAt: "2026-08-01T00:00:00Z"},
			{body: "## Governance readout\nnew", updatedAt: "2026-08-09T00:00:00Z"},
			{body: "unrelated", updatedAt: "2026-08-10T00:00:00Z"},
		]);
		expect(picked?.body).toContain("new");
	});

	it("resolves no digest comment to null rather than to an empty one", () => {
		expect(digestComment([{body: "unrelated", updatedAt: "2026-08-10T00:00:00Z"}])).toBeNull();
	});

	it("reads only a positive integer as an issue number", () => {
		expect(issueNumberOf("9412")).toBe(9412);
		expect(issueNumberOf("abc")).toBeNull();
		expect(issueNumberOf("0")).toBeNull();
		expect(issueNumberOf("-3")).toBeNull();
	});

	/** An unbuilt decoder is a failed read, not a proven-empty artifact (#5199). */
	it("refuses on 11 with the unregistered-format reason, and never reports `absent`", () => {
		const out = runReadout({read: {_tag: "NoFormat"}, json: false});
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("is not registered");
		expect(out.stderr.join("\n")).toContain("never absent");
	});

	it("renders a proven-absent artifact as `absent` at exit 0 — a fact the caller acts on", () => {
		const out = runReadout({read: {_tag: "NoArtifact", repo: "acme/storefront"}, json: false});
		expect(out.code).toBe(ANSWER);
		expect(out.stdout).toBe("readout\tabsent\t0\tacme/storefront\tunknown\n");
	});
});

describe("status bootstrap", () => {
	it("refuses an id outside the registry on 12, naming what IS buildable", () => {
		expect(findSurface("merge-queue")).toBeUndefined();
		expect(knownIds()).toBe(
			"design-manifest, roadmap-focus, gitignore-row, claude-md-section, label-taxonomy, issue-shape-markers, readout-artifact, settings-patch, dep-pin",
		);
	});

	it("carries exactly nine ids", () => {
		expect(BUILDABLE_SURFACES).toHaveLength(9);
		expect(NOT_BUILDABLE).toBe(12);
	});

	/**
	 * Buildability and disposition are separate axes over the same surface, so a surface can be
	 * buildable here and carry any disposition there — but it cannot be buildable and carry none.
	 * `roadmap-focus` shipped exactly that way and the gap reached a review round (#6301).
	 */
	it("names no surface the disposition registry has never heard of", () => {
		const registered = new Set(SURFACE_REGISTRY.map((surface) => surface.id));
		for (const surface of BUILDABLE_SURFACES) expect(registered.has(surface.id)).toBe(true);
	});

	it("builds every issue-shape marker the ideation skills mint issues with", () => {
		expect(ISSUE_SHAPE_MARKERS.map((label) => label.name)).toEqual([
			"wayfinding:map",
			"prototyping:spike",
			"grilling:session",
		]);
	});

	it("mints every marker at one fixed colour and in the marker description grammar", () => {
		for (const label of ISSUE_SHAPE_MARKERS) {
			expect(label.color).toBe(MARKER_COLOR);
			expect(label.description).toMatch(
				/^issue-shape marker: a .+ \(not a pipeline state, not pickable\)$/,
			);
		}
		expect(MARKER_COLOR).toBe("1D76DB");
	});

	it("keeps the markers a surface of their own — no taxonomy label is a marker", () => {
		const taxonomy = new Set(TAXONOMY.map((label) => label.name));
		for (const label of ISSUE_SHAPE_MARKERS) expect(taxonomy.has(label.name)).toBe(false);
		expect(TAXONOMY.every((label) => label.color === null)).toBe(true);
	});
});

describe("the .fabrika/ gitignore row", () => {
	const bootstrap = (files: Record<string, string | null>) => {
		const fs = fakeFs({files});
		return Effect.runPromise(
			Effect.provide(
				runBootstrap({
					surfaceId: "gitignore-row",
					path: null,
					json: true,
					repoRoot: "/repo",
					configSource: {_tag: "Absent"},
					repo: ok("o/r"),
					stdin: Effect.succeed({_tag: "NoStdin"} as StdinRead),
				}),
				Layer.mergeAll(fs.layer, fakeShell([]).layer),
			),
		).then((outcome) => ({outcome, written: fs.written}));
	};

	it("appends the row to an existing .gitignore and leaves every prior line intact", async () => {
		const {outcome, written} = await bootstrap({"/repo/.gitignore": "node_modules\ndist\n"});
		expect(outcome.code).toBe(ANSWER);
		expect(JSON.parse(outcome.stdout)).toEqual({
			outcome: "created",
			surfaceId: "gitignore-row",
			target: ".gitignore",
			readback: "ok",
		});
		const after = written.get("/repo/.gitignore") ?? "";
		expect(after.startsWith("node_modules\ndist\n")).toBe(true);
		expect(after).toContain(FABRIKA_IGNORE_ROW);
	});

	it("writes the row into a repo carrying no .gitignore at all", async () => {
		const {outcome, written} = await bootstrap({});
		expect(outcome.code).toBe(ANSWER);
		expect(written.get("/repo/.gitignore")).toContain(FABRIKA_IGNORE_ROW);
	});

	// The collision guard is the row, not the file: a `.gitignore` is a file many tools contribute to.
	it("is idempotent — a row already there is exists at exit 0 and nothing is written", async () => {
		const {outcome, written} = await bootstrap({"/repo/.gitignore": "dist\n/.fabrika/\n"});
		expect(outcome.code).toBe(ANSWER);
		expect(JSON.parse(outcome.stdout).outcome).toBe("exists");
		expect(written.size).toBe(0);
	});

	it("never truncates a file it could not read — an unreadable target is UNKNOWN, not empty", async () => {
		const fs = fakeFs({files: {"/repo/.gitignore": "dist\n"}, unreadable: ["/repo/.gitignore"]});
		const outcome = await Effect.runPromise(
			Effect.provide(
				runBootstrap({
					surfaceId: "gitignore-row",
					path: null,
					json: true,
					repoRoot: "/repo",
					configSource: {_tag: "Absent"},
					repo: ok("o/r"),
					stdin: Effect.succeed({_tag: "NoStdin"} as StdinRead),
				}),
				Layer.mergeAll(fs.layer, fakeShell([]).layer),
			),
		);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(fs.written.size).toBe(0);
	});
});

/**
 * #7008: the canonical operator-first section, appended under ADR 0334's append-if-absent arm. The
 * template is the single source — the drift it kills is one consumer repo's hand-edited section
 * moving on while another's stands still.
 */
describe("the CLAUDE.md work-flows-through-fabrika section", () => {
	const bootstrap = (files: Record<string, string | null>) => {
		const fs = fakeFs({files});
		return Effect.runPromise(
			Effect.provide(
				runBootstrap({
					surfaceId: "claude-md-section",
					path: null,
					json: true,
					repoRoot: "/repo",
					configSource: {_tag: "Absent"},
					repo: ok("o/r"),
					stdin: Effect.succeed({_tag: "NoStdin"} as StdinRead),
				}),
				Layer.mergeAll(fs.layer, fakeShell([]).layer),
			),
		).then((outcome) => ({outcome, written: fs.written}));
	};

	it("opens on the marker heading, so the collision guard can never drift off the template", () => {
		expect(CLAUDE_MD_SECTION.startsWith(`${CLAUDE_MD_MARKER}\n`)).toBe(true);
	});

	it("appends the section once to a present CLAUDE.md and leaves the prior bytes intact", async () => {
		const before = "# acme\n\nHow this repo is built.\n";
		const {outcome, written} = await bootstrap({"/repo/CLAUDE.md": before});
		expect(outcome.code).toBe(ANSWER);
		expect(JSON.parse(outcome.stdout)).toEqual({
			outcome: "created",
			surfaceId: "claude-md-section",
			target: "CLAUDE.md",
			readback: "ok",
		});
		const after = written.get("/repo/CLAUDE.md") ?? "";
		expect(after.startsWith(before)).toBe(true);
		expect(after).toContain(CLAUDE_MD_MARKER);
	});

	it("creates CLAUDE.md whole — exactly the canonical section — where none exists", async () => {
		const {outcome, written} = await bootstrap({});
		expect(outcome.code).toBe(ANSWER);
		expect(written.get("/repo/CLAUDE.md")).toBe(`${CLAUDE_MD_SECTION}\n`);
	});

	it("is idempotent — a second invocation reports exists and writes nothing", async () => {
		const {outcome, written} = await bootstrap({
			"/repo/CLAUDE.md": `# acme\n\n${CLAUDE_MD_SECTION}\n`,
		});
		expect(outcome.code).toBe(ANSWER);
		expect(JSON.parse(outcome.stdout).outcome).toBe("exists");
		expect(written.size).toBe(0);
	});

	it("recognises a hand-adapted section by its heading alone and rewrites none of it", async () => {
		const adapted = `# acme\n\n${CLAUDE_MD_MARKER}\n\nThis repo adopts no ADRs; decisions land as enforcement.\n`;
		const {outcome, written} = await bootstrap({"/repo/CLAUDE.md": adapted});
		expect(outcome.code).toBe(ANSWER);
		expect(JSON.parse(outcome.stdout).outcome).toBe("exists");
		expect(written.size).toBe(0);
	});
});

/**
 * #5778: `roadmap-focus` writes a machine-read file — `triage homes` joins milestones through its
 * `#<n>` cells — and a byte-match read-back reads the same over a roadmap that parses to nothing.
 * The counts make an inert draft visible at the moment it is written; they gate nothing, and the
 * other file surface's bytes do not move.
 */
describe("the settings-patch surface", () => {
	const SETTINGS = "/repo/.claude/settings.json";

	const bootstrapWith = (
		files: Record<string, string | null>,
		unreadable: ReadonlyArray<string> = [],
	) => {
		const fs = fakeFs({files, unreadable});
		return Effect.runPromise(
			Effect.provide(
				runBootstrap({
					surfaceId: "settings-patch",
					path: null,
					json: true,
					repoRoot: "/repo",
					configSource: {_tag: "Absent"},
					repo: ok("o/r"),
					stdin: Effect.succeed({_tag: "NoStdin"} as StdinRead),
				}),
				Layer.mergeAll(fs.layer, fakeShell([]).layer),
			),
		).then((outcome) => ({outcome, written: fs.written}));
	};

	it("merges both declared keys into a present file and preserves every unknown key", async () => {
		const {outcome, written} = await bootstrapWith({
			[SETTINGS]: JSON.stringify({
				hooks: {PreToolUse: [{matcher: "Bash"}]},
				enabledPlugins: {"other@market": true},
			}),
		});
		expect(outcome.code).toBe(ANSWER);
		expect(JSON.parse(outcome.stdout)).toMatchObject({
			outcome: "created",
			target: ".claude/settings.json",
		});
		const merged = JSON.parse(written.get(SETTINGS) ?? "");
		expect(merged.hooks).toEqual({PreToolUse: [{matcher: "Bash"}]});
		expect(merged.enabledPlugins).toEqual({"other@market": true, "fabrika@kampus": true});
		expect(merged.extraKnownMarketplaces.kampus.source).toEqual({
			source: "github",
			repo: "kamp-us/phoenix",
		});
	});

	it("flips a fabrika entry that is already present but switched off", async () => {
		const {written} = await bootstrapWith({
			[SETTINGS]: JSON.stringify({enabledPlugins: {"fabrika@kampus": false}}),
		});
		expect(JSON.parse(written.get(SETTINGS) ?? "").enabledPlugins).toEqual({
			"fabrika@kampus": true,
		});
	});

	// The parse failure is the one fact that makes the refusal actionable — a bare exit 11 would send
	// the caller hunting through the whole file for what JSON rejected.
	it("refuses a target that does not parse as JSON, naming the file and the parse failure", async () => {
		const {outcome, written} = await bootstrapWith({[SETTINGS]: "{not json"});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		const stderr = outcome.stderr.join("\n");
		expect(stderr).toContain(".claude/settings.json does not parse as a JSON object");
		// The reason is the engine's own wording, which moves between Node releases — pin the shape,
		// never the sentence: the file, then its parse failure, then the no-write guarantee.
		expect(stderr).toMatch(/does not parse as a JSON object: .+ — nothing was written\.$/);
		expect(written.size).toBe(0);
	});

	it("refuses a target whose top level is not an object, writing nothing", async () => {
		const {outcome, written} = await bootstrapWith({[SETTINGS]: "[1, 2]"});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("an array, not a JSON object");
		expect(written.size).toBe(0);
	});

	/** Idempotency is absolute (ADR 0334): key-order differences are not a delta to rewrite. */
	it("reads an adopted file as `exists`, whatever order its keys spell, and writes nothing", async () => {
		const {outcome, written} = await bootstrapWith({
			[SETTINGS]: JSON.stringify({
				enabledPlugins: {"fabrika@kampus": true},
				extraKnownMarketplaces: {
					kampus: {autoUpdate: true, source: {repo: "kamp-us/phoenix", source: "github"}},
				},
				permissions: {allow: ["Bash"]},
			}),
		});
		expect(outcome.code).toBe(ANSWER);
		expect(JSON.parse(outcome.stdout).outcome).toBe("exists");
		expect(written.size).toBe(0);
	});

	it("creates the file whole when it is absent", async () => {
		const {outcome, written} = await bootstrapWith({});
		expect(outcome.code).toBe(ANSWER);
		expect(JSON.parse(outcome.stdout)).toEqual({
			outcome: "created",
			surfaceId: "settings-patch",
			target: ".claude/settings.json",
			readback: "ok",
		});
		expect(JSON.parse(written.get(SETTINGS) ?? "")).toEqual(SETTINGS_PATCH);
		expect(outcome.stderr).toEqual([
			"status bootstrap: created .claude/settings.json for settings-patch, read-back conformed.",
		]);
	});

	it("never writes over a file it could not read — an unreadable target is UNKNOWN, not absent", async () => {
		const fs = fakeFs({files: {[SETTINGS]: "{}"}, unreadable: [SETTINGS]});
		const outcome = await Effect.runPromise(
			Effect.provide(
				runBootstrap({
					surfaceId: "settings-patch",
					path: null,
					json: true,
					repoRoot: "/repo",
					configSource: {_tag: "Absent"},
					repo: ok("o/r"),
					stdin: Effect.succeed({_tag: "NoStdin"} as StdinRead),
				}),
				Layer.mergeAll(fs.layer, fakeShell([]).layer),
			),
		);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(fs.written.size).toBe(0);
	});
});

/**
 * dep-pin is the JSON key-merge arm over `package.json`, with the version read live from the npm
 * registry (#7007): the pin is only ever as current as the registry's answer, so an unreachable or
 * malformed answer refuses instead of pinning a guess. No package manager ever spawns and no
 * lockfile is read or written — the exact install command is printed instead (#6995 R1.3).
 */
describe("the dep-pin surface", () => {
	const MANIFEST = "/repo/package.json";
	/** `encodeURIComponent` spells the scoped name `%40kampus%2Ffabrika-cli`. */
	const REGISTRY = /GET https:\/\/registry\.npmjs\.org\/%40kampus%2Ffabrika-cli\/latest/;
	const RELEASE = (version: string): HttpReply => ({status: 200, body: JSON.stringify({version})});

	const bootstrapWith = (
		files: Record<string, string | null>,
		script: ReadonlyArray<readonly [RegExp, HttpReply]> = [[REGISTRY, RELEASE("0.5.0")]],
	) => {
		const seams = fakeSeams(script);
		const fs = fakeFs({files});
		return Effect.runPromise(
			Effect.provide(
				runBootstrap({
					surfaceId: "dep-pin",
					path: null,
					json: true,
					repoRoot: "/repo",
					configSource: {_tag: "Absent"},
					repo: ok("o/r"),
					stdin: Effect.succeed({_tag: "NoStdin"} as StdinRead),
				}),
				Layer.mergeAll(seams.layer, fs.layer),
			),
		).then((outcome) => ({outcome, written: fs.written, seams}));
	};

	it("pins the row at the registry's current release into a present manifest, preserving every other key", async () => {
		const {outcome, written} = await bootstrapWith({
			[MANIFEST]: JSON.stringify({
				name: "adopting-repo",
				private: true,
				scripts: {build: "tsc"},
				dependencies: {express: "^4.21.0"},
			}),
		});
		expect(outcome.code).toBe(ANSWER);
		expect(JSON.parse(outcome.stdout)).toEqual({
			outcome: "created",
			surfaceId: "dep-pin",
			target: "package.json",
			readback: "ok",
		});
		const merged = JSON.parse(written.get(MANIFEST) ?? "");
		expect(merged.dependencies).toEqual({express: "^4.21.0", "@kampus/fabrika-cli": "0.5.0"});
		// Everything dep-pin did not declare survives the re-serialize verbatim.
		expect(merged.name).toBe("adopting-repo");
		expect(merged.private).toBe(true);
		expect(merged.scripts).toEqual({build: "tsc"});
	});

	it("prints the exact install command on the same notice channel — the lockfile handoff", async () => {
		const {outcome} = await bootstrapWith({[MANIFEST]: '{"dependencies":{}}'});
		expect(outcome.code).toBe(ANSWER);
		expect(outcome.stderr).toContain(
			"status bootstrap: the lockfile stays yours — install with: pnpm add --save-exact @kampus/fabrika-cli@0.5.0",
		);
	});

	it("creates the manifest whole when it is absent", async () => {
		const {outcome, written} = await bootstrapWith({});
		expect(outcome.code).toBe(ANSWER);
		expect(JSON.parse(outcome.stdout)).toMatchObject({outcome: "created", target: "package.json"});
		expect(JSON.parse(written.get(MANIFEST) ?? "")).toEqual({
			dependencies: {"@kampus/fabrika-cli": "0.5.0"},
		});
	});

	// The npm read carries the same client-side bound as every GitHub exchange (#7048's standard):
	// a stalled body stream — headers arrive, bytes never do — must become data, not a hung verb.
	it("bounds a stalled npm registry body stream into the loud unreachable refusal", async () => {
		const before = process.env.FABRIKA_NPM_HTTP_TIMEOUT_SECONDS;
		try {
			process.env.FABRIKA_NPM_HTTP_TIMEOUT_SECONDS = "1";
			const request = HttpClientRequest.get(
				"https://registry.npmjs.org/@kampus%2Ffabrika-cli/latest",
			);
			const http = Layer.succeed(HttpClient.HttpClient)(
				HttpClient.make(() =>
					Effect.succeed(
						HttpClientResponse.fromWeb(request, new Response(new ReadableStream({start() {}}))),
					),
				),
			);
			const started = Date.now();
			const result = await Effect.runPromise(
				Effect.provide(latestPublishedVersion("@kampus/fabrika-cli"), http),
			);
			expect(result._tag).toBe("Failure");
			if (result._tag === "Failure") {
				expect(result.reason).toMatch(
					/^GET https:\/\/registry\.npmjs\.org\/%40kampus%2Ffabrika-cli\/latest exceeded its 1s client-side bound after \d+\.\ds$/,
				);
			}
			expect(Date.now() - started).toBeLessThan(10_000);
		} finally {
			if (before === undefined) delete process.env.FABRIKA_NPM_HTTP_TIMEOUT_SECONDS;
			else process.env.FABRIKA_NPM_HTTP_TIMEOUT_SECONDS = before;
		}
	});

	// The version is never a constant here: a re-run reads the registry again, so a stale row moves
	// forward to whatever npm publishes next rather than being declared already-adopted.
	it("moves a stale pin forward to the current release", async () => {
		const {outcome, written} = await bootstrapWith({
			[MANIFEST]: JSON.stringify({dependencies: {"@kampus/fabrika-cli": "0.4.1"}}),
		});
		expect(JSON.parse(outcome.stdout).outcome).toBe("created");
		expect(JSON.parse(written.get(MANIFEST) ?? "").dependencies["@kampus/fabrika-cli"]).toBe(
			"0.5.0",
		);
	});

	/** Idempotency is absolute (ADR 0334): a manifest already at the current release writes nothing. */
	it("reports a present, current row as exists at exit 0 and writes nothing", async () => {
		const {outcome, written} = await bootstrapWith({
			[MANIFEST]: JSON.stringify({
				name: "adopting-repo",
				dependencies: {"@kampus/fabrika-cli": "0.5.0"},
			}),
		});
		expect(outcome.code).toBe(ANSWER);
		expect(JSON.parse(outcome.stdout).outcome).toBe("exists");
		expect(written.size).toBe(0);
	});

	// The no-package-manager law (#6995 R1.3): every shell call is a violation; the only request the
	// verb may issue is the registry read; a lockfile in the tree must not even be touched.
	it("spawns no package manager, touches no lockfile — the registry GET is its whole footprint", async () => {
		const {written, seams} = await bootstrapWith({
			[MANIFEST]: '{"dependencies":{}}',
			"/repo/pnpm-lock.yaml": "lockfileVersion: '9.0'",
		});
		expect(seams.calls).toEqual([]);
		for (const line of seams.requests) expect(line).toMatch(REGISTRY);
		expect([...written.keys()]).toEqual([MANIFEST]);
	});

	it("refuses a manifest that does not parse as JSON, writing nothing", async () => {
		const {outcome, written} = await bootstrapWith({[MANIFEST]: "{not json"});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("package.json does not parse as a JSON object");
		expect(written.size).toBe(0);
	});

	it("refuses a manifest whose top level is not an object, writing nothing", async () => {
		const {outcome, written} = await bootstrapWith({[MANIFEST]: "[]"});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("an array, not a JSON object");
		expect(written.size).toBe(0);
	});

	it("refuses loudly when the registry cannot be reached — never pins a guessed version", async () => {
		const seams = fakeSeams([]);
		const http = fakeHttp([], undefined, [/registry\.npmjs\.org/]);
		const fs = fakeFs({files: {[MANIFEST]: "{}"}});
		const outcome = await Effect.runPromise(
			Effect.provide(
				runBootstrap({
					surfaceId: "dep-pin",
					path: null,
					json: true,
					repoRoot: "/repo",
					configSource: {_tag: "Absent"},
					repo: ok("o/r"),
					stdin: Effect.succeed({_tag: "NoStdin"} as StdinRead),
				}),
				Layer.mergeAll(seams.layer, http.layer, fs.layer),
			),
		);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		const stderr = outcome.stderr.join("\n");
		expect(stderr).toContain("cannot resolve @kampus/fabrika-cli's current release from npm");
		expect(stderr).toContain("could not be reached");
		expect(stderr).toContain("nothing pinned, nothing written");
		expect(fs.written.size).toBe(0);
	});

	it("refuses when the registry answers non-200, naming the status", async () => {
		const {outcome, written} = await bootstrapWith({[MANIFEST]: "{}"}, [
			[REGISTRY, {status: 404, body: '{"error":"Not Found"}'}],
		]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("answered 404");
		expect(written.size).toBe(0);
	});

	it("refuses a 200 body that names no version", async () => {
		const {outcome, written} = await bootstrapWith({[MANIFEST]: "{}"}, [
			[REGISTRY, {status: 200, body: '{"name":"@kampus/fabrika-cli"}'}],
		]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("names no version");
		expect(written.size).toBe(0);
	});
});

/**
 * #5778: `roadmap-focus` writes a machine-read file — `triage homes` joins milestones through its
 * `#<n>` cells — and a byte-match read-back reads the same over a roadmap that parses to nothing.
 * The counts make an inert draft visible at the moment it is written; they gate nothing, and the
 * other file surface's bytes do not move.
 */
describe("the roadmap-focus row count", () => {
	const write = (content: string, surfaceId = "roadmap-focus") => {
		const fs = fakeFs({files: {}});
		return Effect.runPromise(
			Effect.provide(
				runBootstrap({
					surfaceId,
					path: null,
					json: true,
					repoRoot: "/repo",
					configSource: {_tag: "Absent"},
					repo: ok("o/r"),
					stdin: Effect.succeed({_tag: "Text", text: content} as StdinRead),
				}),
				Layer.mergeAll(fs.layer, fakeShell([]).layer),
			),
		);
	};

	const PARSING = [
		"# Roadmap",
		"",
		"## Arcs",
		"",
		"| Arc | Milestone | State |",
		"|---|---|---|",
		"| Geçit | #46 | active |",
		"| Sözlük | #47 | next |",
		"",
		"## Campaigns",
		"",
		"| Campaign | Milestone | State |",
		"|---|---|---|",
		"| fabrika everywhere | #48 | active |",
		"",
	].join("\n");

	// What drafting by inference produces: the milestone's TITLE where the parser wants `#<n>`.
	const INERT = [
		"# Roadmap",
		"",
		"## Arcs",
		"",
		"| Arc | Milestone | State |",
		"|---|---|---|",
		"| Geçit | Sözlük — search and discovery | active |",
		"",
	].join("\n");

	it("reports what parsed, and a roadmap that parses to nothing is still created", async () => {
		const outcome = await write(INERT);
		expect(outcome.code).toBe(ANSWER);
		expect(JSON.parse(outcome.stdout)).toEqual({
			outcome: "created",
			surfaceId: "roadmap-focus",
			target: "ROADMAP.md",
			readback: "ok",
			arcs: 0,
			campaigns: 0,
		});
		expect(outcome.stderr).toEqual([
			"status bootstrap: created ROADMAP.md for roadmap-focus, read-back conformed — 0 arcs, 0 campaigns.",
		]);
	});

	it("counts the rows a parsing roadmap joins, singular at one", async () => {
		const outcome = await write(PARSING);
		expect(JSON.parse(outcome.stdout)).toMatchObject({arcs: 2, campaigns: 1});
		expect(outcome.stderr).toEqual([
			"status bootstrap: created ROADMAP.md for roadmap-focus, read-back conformed — 2 arcs, 1 campaign.",
		]);
		expect(roadmapCount(PARSING).clause).toBe("2 arcs, 1 campaign");
	});

	// #6296: bootstrap must scaffold where the READERS look. A repo declaring `roadmapFile` and
	// getting `ROADMAP.md` written ends up with two files, one of them inert and unremarked.
	it("scaffolds at the path `roadmapFile` names", async () => {
		const fs = fakeFs({
			files: {"/repo/.fabrika.jsonc": JSON.stringify({roadmapFile: "docs/PLAN.md"})},
		});
		const outcome = await Effect.runPromise(
			Effect.provide(
				runBootstrap({
					surfaceId: "roadmap-focus",
					path: null,
					json: true,
					repoRoot: "/repo",
					configSource: {_tag: "Absent"},
					repo: ok("o/r"),
					stdin: Effect.succeed({_tag: "Text", text: PARSING} as StdinRead),
				}),
				Layer.mergeAll(fs.layer, fakeShell([]).layer),
			),
		);
		expect(JSON.parse(outcome.stdout)).toMatchObject({target: "docs/PLAN.md"});
		expect([...fs.written.keys()]).toEqual(["/repo/docs/PLAN.md"]);
	});

	it("leaves the other file surface's bytes and notice exactly as they were", async () => {
		const outcome = await write("# Design system manifest\n", "design-manifest");
		expect(JSON.parse(outcome.stdout)).toEqual({
			outcome: "created",
			surfaceId: "design-manifest",
			target: "design-system-manifest.md",
			readback: "ok",
		});
		expect(outcome.stderr).toEqual([
			"status bootstrap: created design-system-manifest.md for design-manifest, read-back conformed.",
		]);
	});
});

/**
 * #5776: the read-back re-scanned the eventually-consistent issues *list*, so a correct first
 * creation reported `READBACK_MISMATCH`. Every case here scripts that list to stay empty after the
 * write — the branch is proven only when the outcome no longer depends on it.
 */
describe("the readout-artifact read-back reads the created issue by number", () => {
	const LIST = /GET .*\/repos\/o\/r\/issues\?state=open/;
	const CREATE = /POST .*\/repos\/o\/r\/issues$/;
	const READBACK = /GET .*\/repos\/o\/r\/issues\/3$/;
	const CREATED: HttpReply = {
		status: 201,
		body: JSON.stringify({number: 3, html_url: "https://github.com/o/r/issues/3"}),
	};

	const artifact = (overrides: Readonly<Record<string, unknown>> = {}): HttpReply => ({
		status: 200,
		body: JSON.stringify({
			number: 3,
			title: ARTIFACT_TITLE,
			body: "",
			state: "open",
			labels: [],
			html_url: "https://github.com/o/r/issues/3",
			...overrides,
		}),
	});

	const run = (readback: HttpReply) => {
		const seams = fakeSeams([
			[LIST, {status: 200, body: "[]"}],
			[CREATE, CREATED],
			[READBACK, readback],
		]);
		const fs = fakeFs({files: {}});
		return Effect.runPromise(
			Effect.provide(
				runBootstrap({
					surfaceId: "readout-artifact",
					path: null,
					json: true,
					repoRoot: "/repo",
					configSource: {_tag: "Absent"},
					repo: ok("o/r"),
					stdin: Effect.succeed({_tag: "NoStdin"} as StdinRead),
				}),
				Layer.mergeAll(seams.layer, fs.layer),
			),
		).then((outcome) => ({outcome, calls: seams.requests}));
	};

	it("reports created off the issue's own resource, never a second list read", async () => {
		const {outcome, calls} = await run(artifact());
		expect(outcome.code).toBe(ANSWER);
		expect(JSON.parse(outcome.stdout)).toEqual({
			outcome: "created",
			surfaceId: "readout-artifact",
			target: "o/r#3",
			readback: "ok",
		});
		expect(calls.filter((line) => LIST.test(line))).toHaveLength(1);
		expect(calls.filter((line) => READBACK.test(line))).toHaveLength(1);
	});

	it("spends READBACK_MISMATCH only on a proven 404", async () => {
		const {outcome} = await run({status: 404, body: '{"message":"Not Found"}'});
		expect(outcome.code).toBe(READBACK_MISMATCH);
	});

	it("reads an unreadable re-read as WRITE_UNKNOWN, never as a mismatch", async () => {
		const {outcome} = await run({status: 502, body: "{}"});
		expect(outcome.code).toBe(WRITE_UNKNOWN);
	});

	it("proves the artifact, not merely that the number resolves", async () => {
		const wrongTitle = await run(artifact({title: "Something else"}));
		expect(wrongTitle.outcome.code).toBe(READBACK_MISMATCH);
		const closed = await run(artifact({state: "closed"}));
		expect(closed.outcome.code).toBe(READBACK_MISMATCH);
	});
});

/**
 * #5772: the taxonomy carried five of the sixteen names the verbs write, so a bootstrapped repo hit
 * `#4285`'s correct refusal on the first `triage apply`. These bind the derivation, not the current
 * spelling — widen `TYPES` or `AUDIENCES` and a restated copy of this set fails here.
 */
describe("the bootstrap taxonomy is derived from the vocabularies the verbs write", () => {
	const names = new Set(TAXONOMY.map((label) => label.name));

	/** Every label any facet keep set can produce, over the whole vocabulary cross-product. */
	const keepable = (): ReadonlyArray<string> => {
		const tables = [
			parkedFacets(),
			...TYPES.flatMap((type) =>
				PRIORITIES.flatMap((priority) =>
					AUDIENCES.flatMap((readyFor) =>
						[null, ...STANDING_LANES].map((lane) =>
							triagedFacets({type, priority, readyFor, lane}),
						),
					),
				),
			),
		];
		return [...new Set(tables.flatMap((facets) => facets.flatMap((facet) => facet.keep)))];
	};

	it("mints every label a facet keep set can produce, bar the per-repo standing lanes", () => {
		// The lanes are the one deliberate exclusion: a lane is the host repo's own home vocabulary,
		// declared in its ROADMAP, not a pipeline state every repo is born with.
		const outside = keepable().filter((label) => !names.has(label));
		expect(outside.slice().sort()).toEqual([...STANDING_LANES].sort());
	});

	it("mints one label per member of TYPES and of AUDIENCES, and no thirteenth", () => {
		for (const type of TYPES) expect(names.has(`type:${type}`)).toBe(true);
		for (const audience of AUDIENCES) expect(names.has(`ready-for:${audience}`)).toBe(true);
		expect([...names].filter((name) => name.startsWith("type:"))).toHaveLength(TYPES.length);
		expect([...names].filter((name) => name.startsWith("ready-for:"))).toHaveLength(
			AUDIENCES.length,
		);
	});

	it("mints the lifecycle statuses no facet produces — plan flip's and ship release's", () => {
		for (const status of STATUSES) expect(names.has(status)).toBe(true);
		expect(names.has(PLANNED)).toBe(true);
		expect(names.has(AWAITING_RELEASE)).toBe(true);
	});

	it("carries sixteen labels, each named once", () => {
		expect(TAXONOMY).toHaveLength(16);
		expect(names.size).toBe(TAXONOMY.length);
	});

	it("equals the set computed off the four facet lists, in order", () => {
		expect(TAXONOMY).toEqual(
			[
				...statusList(DEFAULT_STATUS_NAMES),
				...PRIORITIES,
				...TYPES.map(typeLabel),
				...AUDIENCES.map(audienceLabel),
			].map((name) => ({name, description: LABEL_DESCRIPTION, color: null})),
		);
	});

	it("follows the board it is handed, never the shipped default", () => {
		// #6451: published 0.3.0 restated five names while source derived sixteen, and every
		// assertion above still passed on the restatement because it happened to spell the default
		// right. A board whose names phoenix does not use is what a restatement cannot fake.
		const declared: BoardVocabulary = {
			statuses: {
				needsTriage: "state:raw",
				triaged: "state:ready",
				needsInfo: "state:asked",
				planned: "state:planned",
				awaitingRelease: "state:shipping",
			},
			types: ["defect"],
			priorities: ["sev1"],
			audiences: ["human"],
			standingLanes: ["lane:whatever"],
		};
		expect(taxonomyFor(declared).map((label) => label.name)).toEqual([
			"state:raw",
			"state:ready",
			"state:asked",
			"state:planned",
			"state:shipping",
			"sev1",
			"type:defect",
			"ready-for:human",
		]);
	});
});

describe("status open is TOTAL — every unreadable source is a field state, never a refusal", () => {
	it("renders five fields at exit 0 when EVERY source failed", () => {
		const fields = [
			menuField({_tag: "Failed", path: "/x", display: "x", reason: "EACCES"}, AS_OF),
			settingsField(
				[{key: "governedRoots", provenance: "unknown", detail: "EACCES"}],
				".fabrika.jsonc",
				AS_OF,
			),
			boardField({_tag: "Failed", repo: "acme/storefront", reason: "EAI_AGAIN"}),
			readoutField({_tag: "NoFormat"}),
			lanesField(
				{code: 11, stdout: "", stderr: ["fabrika lane stale: cannot list .fabrika/lanes"]},
				[DEFAULT_LANES_ROOT, DEFAULT_CHORES_ROOT],
				AS_OF,
			),
		];
		const out = runOpen({fields, json: false, scope: "roster x; repo acme/storefront"});
		expect(out.code).toBe(ANSWER);
		expect(out.stdout.split("\n")[0]).toBe("open\t5");
		expect(out.stdout.split("\n").filter((l) => l.startsWith("field\t"))).toHaveLength(5);
		for (const field of fields) expect(field.state).toBe("unknown");
	});

	it("renders a resolved-but-empty roster as `empty`, not `unknown`", () => {
		expect(menuField(resolvedRoster([]), AS_OF).state).toBe("empty");
	});

	// A surface registering zero keys is unread, not resolved: ADR 0092's zero-scope seat as a field.
	it("renders a settings surface carrying no keys as `unknown`", () => {
		expect(settingsField([], ".fabrika.jsonc", AS_OF).state).toBe("unknown");
	});

	it("has exactly one refusal seat, and it is the off-vocabulary `--field`", () => {
		const out = badFieldRefusal("nope");
		expect(out.code).toBe(report.CLASSIFIED);
		expect(out.stdout).toBe("");
	});

	it("never prints an absolute machine-local path as a field's source", () => {
		const source = menuField(resolvedRoster([]), AS_OF).source;
		expect(source).toBe("claude-plugins/fabrika/skills");
		expect(source.startsWith("/")).toBe(false);
	});
});

describe("the lanes field renders `lane stale`'s sweep, never a second staleness implementation", () => {
	const NOW = "2026-08-17T12:00:00.000Z";
	const ROOTS = [DEFAULT_LANES_ROOT, DEFAULT_CHORES_ROOT];
	const minutesAgo = (n: number): string => new Date(Date.parse(NOW) - n * 60_000).toISOString();
	const logLine = (at: string): string =>
		`${JSON.stringify({task: "issue", event: "ISSUE.WIP", at})}\n`;

	const laneTree = (lanes: ReadonlyArray<{lane: string; log?: string; workflow?: string}>) => {
		const files: Record<string, string> = {};
		for (const {lane, log, workflow} of lanes) {
			files[`${DEFAULT_LANES_ROOT}/${lane}/workflow.json`] = workflow ?? coderTemplateText();
			if (log !== undefined) files[`${DEFAULT_LANES_ROOT}/${lane}/events.jsonl`] = log;
		}
		return fakeFs({
			files,
			dirs: {[DEFAULT_LANES_ROOT]: lanes.map((entry) => entry.lane)},
			directories: [DEFAULT_LANES_ROOT],
		});
	};

	const sweep = (fs: ReturnType<typeof fakeFs>) =>
		Effect.runPromise(
			Effect.provide(
				runStale({roots: ROOTS, olderThanMinutes: DEFAULT_STALE_MINUTES, now: NOW, claims: null}),
				fs.layer,
			),
		);

	it("renders no lanes on disk as the proven negative `empty`, not a fault", async () => {
		const field = lanesField(await sweep(fakeFs({})), ROOTS, AS_OF);
		expect(field.state).toBe("empty");
		expect(field.detail).toBe("no lanes on disk");
		expect(field.source).toBe(`${DEFAULT_LANES_ROOT},${DEFAULT_CHORES_ROOT}`);
	});

	it("renders zero stale lanes over live ones as `empty`, echoing the verb's own threshold", async () => {
		const field = lanesField(
			await sweep(laneTree([{lane: "5908", log: logLine(minutesAgo(5))}])),
			ROOTS,
			AS_OF,
		);
		expect(field.state).toBe("empty");
		expect(field.detail).toBe(`1 lane(s), none silent past ${DEFAULT_STALE_MINUTES}m`);
	});

	it("renders a silent lane as `stale`, naming the lane and its age", async () => {
		const field = lanesField(
			await sweep(laneTree([{lane: "5908", log: logLine(minutesAgo(76))}])),
			ROOTS,
			AS_OF,
		);
		expect(field.state).toBe("stale");
		expect(field.detail).toContain("1 stale: 5908 (76m)");
		expect(field.asOf).toBe(AS_OF);
	});

	it("renders an unreadable lane record as `unknown` with its reason, never flattened to clean", async () => {
		const field = lanesField(
			await sweep(laneTree([{lane: "5908", workflow: "not json", log: logLine(minutesAgo(5))}])),
			ROOTS,
			AS_OF,
		);
		expect(field.state).toBe("unknown");
		expect(field.detail).toContain("1 lane(s) unreadable: 5908");
		expect(field.asOf).toBe(noAsOf);
	});

	it("renders the sweep's refusal — an unlistable root — as `unknown` with the refusal's reason", async () => {
		const fs = fakeFs({
			dirs: {[DEFAULT_LANES_ROOT]: null},
			directories: [DEFAULT_LANES_ROOT],
		});
		const outcome = await sweep(fs);
		expect(outcome.code).not.toBe(ANSWER);
		const field = lanesField(outcome, ROOTS, AS_OF);
		expect(field.state).toBe("unknown");
		expect(field.detail).toContain(`cannot list ${DEFAULT_LANES_ROOT}`);
	});

	it("renders an answer that is not the documented object as `unknown`, never zero lanes", () => {
		const field = lanesField({code: ANSWER, stdout: "not json\n", stderr: []}, ROOTS, AS_OF);
		expect(field.state).toBe("unknown");
		expect(field.detail).toContain("a failed read, not zero lanes");
	});
});

describe("the tab-separated field discipline", () => {
	it("strips tabs and newlines out of prose before it is joined into a row", () => {
		expect(oneLine("a\tb\nc", 120)).toBe("a b c");
	});

	it("clamps after reproducing the raw text, so a truncated detail stays attributable", () => {
		expect(oneLine("x".repeat(200), 120)).toHaveLength(120);
	});
});
