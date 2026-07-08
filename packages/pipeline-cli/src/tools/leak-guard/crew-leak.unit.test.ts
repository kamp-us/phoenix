/**
 * `findCrewLeaks` — the pure match-class core for the pipeline-crew sanitization
 * sweep (#2357). Covers every GENERIC personal-data class the crew contract bans
 * (paths, emails, tmux pane ids, personal-memory refs) AND the false-positive safety
 * that makes the sweep pass on the shipped crew content: the README's deliberately
 * fictional seam examples (`@robin`, `#crew-pings`, `${CLAUDE_PLUGIN_ROOT}`, relative
 * `../../.decisions/...`) must NOT be flagged. Fixtures use FAKE data only
 * (`alice@example.com`, `/Users/alice`) — no real identifier appears anywhere here.
 * There is intentionally NO operator-name class: a bare first name in prose is not
 * caught, by founder ruling (see crew-leak.ts docblock).
 */
import {describe, expect, it} from "@effect/vitest";
import {type CrewLeak, findCrewLeaks, type LeakClass} from "./crew-leak.ts";

const classes = (leaks: ReadonlyArray<CrewLeak>): ReadonlyArray<LeakClass> =>
	leaks.map((l) => l.class);
const matched = (leaks: ReadonlyArray<CrewLeak>): ReadonlyArray<string> =>
	leaks.map((l) => l.matched);

describe("findCrewLeaks — match classes", () => {
	describe("path class (machine-local / home / absolute)", () => {
		it("flags /Users/<name>", () => {
			const leaks = findCrewLeaks("see /Users/alice/code/x for the file");
			expect(classes(leaks)).toContain("path");
			expect(matched(leaks)).toContain("/Users/alice");
		});
		it("flags /home/<name>", () => {
			expect(classes(findCrewLeaks("path /home/bob/.config"))).toContain("path");
		});
		it("flags ~/.claude, ~/.usirin, ~/.agent", () => {
			expect(classes(findCrewLeaks("cd ~/.claude"))).toContain("path");
			expect(classes(findCrewLeaks("cd ~/.usirin"))).toContain("path");
			expect(classes(findCrewLeaks("cd ~/.agent"))).toContain("path");
		});
		it("flags ~/code/ sibling clones", () => {
			expect(classes(findCrewLeaks("~/code/github.com/x/y"))).toContain("path");
		});
		it("flags /vault/ paths", () => {
			expect(classes(findCrewLeaks("stored at /vault/notes"))).toContain("path");
		});
		it("does NOT flag the plugin-root env var or relative ../../.decisions paths", () => {
			// Built by concatenation so the ${...} stays a literal, not a template string.
			const pluginRoot = `cp "$${"{CLAUDE_PLUGIN_ROOT}"}/crew.config.template.jsonc" .claude/crew.config.jsonc`;
			expect(findCrewLeaks(pluginRoot)).toEqual([]);
			expect(findCrewLeaks("see ADR ../../.decisions/0062-repo-as-config-plugin.md")).toEqual([]);
		});
		it("does NOT flag a benign ~/.config (not a named machine-local dir)", () => {
			expect(findCrewLeaks("edit ~/.config/foo")).toEqual([]);
		});
	});

	describe("email class (generic any-email regex)", () => {
		it("flags any email address", () => {
			const leaks = findCrewLeaks("ping alice@example.com on failure");
			expect(classes(leaks)).toContain("email");
			expect(matched(leaks)).toContain("alice@example.com");
		});
		it("flags a differently-shaped email (subdomain + plus tag)", () => {
			expect(matched(findCrewLeaks("route to ops+ci@mail.example.co.uk"))).toContain(
				"ops+ci@mail.example.co.uk",
			);
		});
		it("does NOT flag an npm scope (@kampus) or a fictional handle (@robin)", () => {
			expect(classes(findCrewLeaks("install pipeline-crew@kampus"))).not.toContain("email");
			expect(classes(findCrewLeaks('"handle": "@robin"'))).not.toContain("email");
		});
	});

	describe("tmux-id class", () => {
		it("flags a tmux pane id (%N)", () => {
			const leaks = findCrewLeaks("ping the triage pane %11 at dispatch");
			expect(classes(leaks)).toContain("tmux-id");
			expect(matched(leaks)).toContain("%11");
		});
		it("does NOT flag hex url-encoding (%2F) or a bare percent", () => {
			expect(classes(findCrewLeaks("path%2Fsegment and 100% done"))).not.toContain("tmux-id");
		});
	});

	describe("memory-ref class (personal auto-memory)", () => {
		it("flags MEMORY.md", () => {
			expect(classes(findCrewLeaks("recorded in MEMORY.md"))).toContain("memory-ref");
		});
		it("flags a /memory/ path segment", () => {
			expect(classes(findCrewLeaks("~/.claude/projects/x/memory/kunye.md"))).toContain(
				"memory-ref",
			);
		});
		it("flags an auto-memory slug", () => {
			expect(classes(findCrewLeaks("see feedback_credential_share_then_rotate"))).toContain(
				"memory-ref",
			);
			expect(classes(findCrewLeaks("reference_ea_ping_sound_sosumi"))).toContain("memory-ref");
		});
		it("does NOT flag an ordinary single-segment identifier", () => {
			expect(classes(findCrewLeaks("the reference_doc link"))).not.toContain("memory-ref");
		});
	});

	it("does NOT flag a bare first name in prose (no operator-name class, by ruling)", () => {
		expect(findCrewLeaks("assign the review to Robin, then Sam approves")).toEqual([]);
	});

	it("dedupes repeated identical hits and returns [] on clean text", () => {
		expect(findCrewLeaks("")).toEqual([]);
		expect(findCrewLeaks("a perfectly clean sentence with <placeholders>")).toEqual([]);
		const dup = findCrewLeaks("ping alice@example.com and alice@example.com again");
		expect(dup.filter((l) => l.class === "email")).toHaveLength(1);
	});
});
