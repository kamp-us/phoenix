/**
 * `findCrewLeaks` — the pure match-class core for the pipeline-crew sanitization
 * sweep (#2357). Covers every personal-data class the crew contract bans (paths,
 * emails, tmux pane ids, real operator names, personal-memory refs) AND the
 * false-positive safety that makes the sweep pass on the shipped crew content: the
 * README's deliberately-fictional seam examples (`@robin`, `Robin Operator`,
 * `#crew-pings`, `${CLAUDE_PLUGIN_ROOT}`, relative `../../.decisions/...`) must NOT
 * be flagged, only real operator data is.
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

	describe("email class", () => {
		it("flags a real email address", () => {
			const leaks = findCrewLeaks("ping imperialwarrior@gmail.com on failure");
			expect(classes(leaks)).toContain("email");
			expect(matched(leaks)).toContain("imperialwarrior@gmail.com");
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

	describe("operator-name class (real-operator deny-list)", () => {
		it("flags the real operator identifiers", () => {
			for (const name of ["umut", "usirin", "cansirin", "imperialwarrior"]) {
				expect(classes(findCrewLeaks(`assign it to ${name}`))).toContain("operator-name");
			}
		});
		it("is case-insensitive", () => {
			expect(classes(findCrewLeaks("Umut approves §CP"))).toContain("operator-name");
		});
		it("does NOT flag fictional README example names (Robin Operator / Sam Approver)", () => {
			expect(classes(findCrewLeaks('"name": "Robin Operator"'))).not.toContain("operator-name");
			expect(classes(findCrewLeaks('"name": "Sam Approver"'))).not.toContain("operator-name");
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

	it("dedupes repeated identical hits and returns [] on clean text", () => {
		expect(findCrewLeaks("")).toEqual([]);
		expect(findCrewLeaks("a perfectly clean sentence with <placeholders>")).toEqual([]);
		const dup = findCrewLeaks("umut and umut again");
		expect(dup.filter((l) => l.class === "operator-name")).toHaveLength(1);
	});
});
