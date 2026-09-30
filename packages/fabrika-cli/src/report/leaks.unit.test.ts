import {describe, expect, it} from "vitest";
import {isBareAtReference, renderLeaks, scanBody} from "./leaks.ts";

describe("scanBody", () => {
	it("classifies the three shapes and keeps the class root in the mask", () => {
		const body = ["~/notes/todo.md", "/Users/someone/code/x.ts", "/var/folders/ab/cd/T/y"].join(
			"\n",
		);
		const scan = scanBody(body);
		expect(scan.leaks.map((l) => l.class)).toEqual([
			"home-relative",
			"absolute home root",
			"temp root",
		]);
		expect(scan.redacted.split("\n")).toEqual([
			"~/<redacted>",
			"/Users/<redacted>",
			"/var/folders/<redacted>",
		]);
	});

	it("does not fold the temp roots together — which root it came from IS the evidence", () => {
		const scan = scanBody("/tmp/a /private/tmp/b /private/var/c /var/folders/d/e");
		expect(scan.redacted).toBe(
			"/tmp/<redacted> /private/tmp/<redacted> /private/var/<redacted> /var/folders/<redacted>",
		);
	});

	it("replaces the LONGER root first, so /private/tmp never degrades to /tmp", () => {
		const scan = scanBody("see /private/tmp/session/body.md");
		expect(scan.leaks).toHaveLength(1);
		expect(scan.redacted).toBe("see /private/tmp/<redacted>");
	});

	it("drops the leaf filename — a filename can itself identify a person or a machine", () => {
		expect(scanBody("/Users/someone/Desktop/invoice-someone.pdf").redacted).toBe(
			"/Users/<redacted>",
		);
	});

	it("carves out the two machine-agnostic claude config leaves, by exact leaf", () => {
		const scan = scanBody("~/.claude.json and ~/.claude/settings.json");
		expect(scan.leaks).toEqual([]);
		expect(scan.redacted).toBe("~/.claude.json and ~/.claude/settings.json");
	});

	it("still matches a deeper descent or a longer name under the carved-out leaf", () => {
		const scan = scanBody("~/.claude/settings.local.json ~/.claude/projects/x");
		expect(scan.leaks).toHaveLength(2);
		expect(scan.redacted).toBe("~/<redacted> ~/<redacted>");
	});

	it("reports the 1-based line of each hit", () => {
		const scan = scanBody(["clean", "clean", "/tmp/x/y"].join("\n"));
		expect(scan.leaks).toEqual([{line: 3, class: "temp root", text: "/tmp/x/y"}]);
		expect(renderLeaks(scan.leaks)).toEqual(["  line 3, temp root"]);
	});

	it("leaves prose alone: a bare root with no segment is not a path", () => {
		const scan = scanBody("the /tmp directory, a ~ in a table, and /home on its own");
		expect(scan.leaks).toEqual([]);
		expect(scan.redacted).toBe("the /tmp directory, a ~ in a table, and /home on its own");
	});

	it("does not swallow the sentence punctuation that follows a path", () => {
		expect(scanBody("it lives at /tmp/session/body.md.").redacted).toBe(
			"it lives at /tmp/<redacted>.",
		);
	});

	it("leaves a repo-relative path untouched — the Pointers section is repo-relative by contract", () => {
		const body = "packages/fabrika-cli/src/report/leaks.ts and src/worker/http/retry.ts";
		expect(scanBody(body)).toEqual({leaks: [], redacted: body});
	});

	/**
	 * `build check`'s COMMITTED-file scan moved off this function onto `build/doc-leaks.ts`,
	 * which is deliberately looser on three shapes. This body surface is ungated — no CI stands
	 * behind an issue body — so it keeps refusing all three, and these pin that it still does.
	 */
	describe("still refuses everything the committed-file scanner now lets through", () => {
		it("takes a home marker inside a fenced code block", () => {
			const body = ["```bash", "grep -nE '(~/|/Users/|/home/)' -- .", "```"].join("\n");
			expect(scanBody(body).leaks).toEqual([
				{line: 2, class: "home-relative", text: "~/|/Users/|/home"},
			]);
		});

		it("takes a scratch root a doc may legitimately cite", () => {
			expect(scanBody("scratch lands under /tmp/fabrika-build/x").leaks).toEqual([
				{line: 1, class: "temp root", text: "/tmp/fabrika-build/x"},
			]);
		});

		it("has no self-exempt list — the shapes are refused whoever writes them", () => {
			expect(scanBody("the Lineage bullets name ~/code/github.com/o/r").leaks).toHaveLength(1);
		});
	});
});

describe("scanBody's tilde-slash path-alias shapes", () => {
	it.each([
		["a double-quoted `from` specifier", `import {Button} from "~/components/Button";`],
		["a single-quoted `from` specifier", "export * from '~/lib/utils';"],
		["a side-effect `import` specifier", `import "~/styles/globals.css";`],
		["an `import(` specifier", "const Page = await import( '~/app/page' );"],
		["a `require(` specifier", `const cfg = require("~/config");`],
		["a type-only `from` specifier", `import type {Props} from "~/types";`],
		["a default-plus-named `from` specifier", `import React, {useState} from "~/lib/react";`],
		["a `from` closing a multi-line clause", `} from "~/components/Button";`],
		["a backticked import line in prose", "the repro is `import {cn} from '~/lib/utils'` there"],
		["a double-quoted `paths` key", `    "~/*": ["./src/*"],`],
		["a single-quoted `paths` key", "{'~/components/*' : ['./src/components/*']}"],
	])("passes %s", (_name, body) => {
		expect(scanBody(body)).toEqual({leaks: [], redacted: body});
	});

	it.each([
		["a bare path in prose", "the alias ~/lib/utils resolves to src"],
		["a backticked path in prose", "the alias `~/lib/utils` resolves to src"],
		["a quoted home path after no import keyword", `open "~/Documents/notes.txt" first`],
		["a quoted `/*` string with no following colon", `glob "~/src/*" matched nothing`],
		[
			"a double-quoted path after prose `from`",
			`I loaded the config from "~/.config/app/settings.json"`,
		],
		[
			"a single-quoted path after prose `from`",
			"copied it from '~/Documents/client-acme/notes.txt'",
		],
		["a quoted path after prose `import`", `then I import "~/Downloads/data.csv" by hand`],
		[
			"a quoted path after a prose clause opening on `import`",
			`import the file from "~/Documents/x.txt"`,
		],
	])("still refuses %s", (_name, body) => {
		expect(scanBody(body).leaks).toEqual([
			expect.objectContaining({line: 1, class: "home-relative"}),
		]);
	});

	it("refuses a specifier whose closing quote does not match its opening one", () => {
		expect(scanBody(`import x from "~/lib/x';`).leaks).toHaveLength(1);
	});

	it("masks only the home path on a line that also carries an exempt specifier", () => {
		const specifier = `import {cn} from "~/lib/utils";`;
		const scan = scanBody(`${specifier} // copied from ~/Documents/notes.txt`);
		expect(scan.leaks).toEqual([{line: 1, class: "home-relative", text: "~/Documents/notes.txt"}]);
		expect(scan.redacted).toBe(`${specifier} // copied from ~/<redacted>`);
	});
});

describe("scanBody's email shape", () => {
	it("refuses an address and masks it whole, domain included", () => {
		const scan = scanBody("mail first.last+tag@mail.company.io, then retry");
		expect(scan.leaks).toEqual([{line: 1, class: "email", text: "first.last+tag@mail.company.io"}]);
		expect(scan.redacted).toBe("mail <redacted email>, then retry");
	});

	it.each([
		["a role trailer", "Co-Authored-By: Bot <noreply@anthropic.com>"],
		["an SSH remote", "origin git@github.com:o/r.git (fetch)"],
		["a reserved test domain", "owner@example.test and a@b.invalid and docs@example.com"],
		["a versioned patch file", "patches/alchemy@2.0.0-beta.59.patch"],
		["a screenshot filename", "catalog@desktop.png"],
		["an @mention", "@usirin said so"],
		["a scoped package", "@effect/platform@4.0.0"],
	])("passes %s", (_name, body) => {
		expect(scanBody(body)).toEqual({leaks: [], redacted: body});
	});

	it("masks a path whole before the address inside it is read", () => {
		const scan = scanBody("/Users/someone/mail/a@b.io.txt");
		expect(scan.leaks.map((l) => l.class)).toEqual(["absolute home root"]);
	});
});

describe("scanBody with declared leakNames", () => {
	const names = {privateRepos: ["acme/secret"], identifiers: ["Jane Roe"]};

	it("passes the bare slug — naming the repo is allowed", () => {
		const body = "the acme/secret repo has the same bug; see acme/secret-tools#4 too";
		expect(scanBody(body, names)).toEqual({leaks: [], redacted: body});
	});

	it("refuses a link to the repo, with or without a scheme, and masks it whole", () => {
		const scan = scanBody(
			"see https://github.com/acme/secret/blob/main/a.ts, github.com/Acme/Secret.git and (https://www.github.com/acme/secret).",
			names,
		);
		expect(scan.leaks.map((l) => l.class)).toEqual([
			"private repo link",
			"private repo link",
			"private repo link",
		]);
		expect(scan.redacted).toBe(
			"see <redacted private repo link>, <redacted private repo link> and (<redacted private repo link>).",
		);
	});

	it("refuses an issue reference and keeps the name while dropping the number", () => {
		const scan = scanBody("tracked in acme/secret#482.", names);
		expect(scan.leaks).toEqual([
			{line: 1, class: "private repo reference", text: "acme/secret#482"},
		]);
		expect(scan.redacted).toBe("tracked in acme/secret#<redacted>.");
	});

	it("does not read a longer repo name as the declared one", () => {
		const body = "github.com/acme/secret-tools and acme/secrets#3 and xacme/secret#3";
		expect(scanBody(body, names).leaks).toEqual([]);
	});

	it("refuses every occurrence of a declared identifier, case-insensitively", () => {
		const scan = scanBody("Jane Roe asked; JANE ROE agreed", names);
		expect(scan.leaks.map((l) => l.class)).toEqual(["named identifier", "named identifier"]);
		expect(scan.redacted).toBe("<redacted> asked; <redacted> agreed");
	});

	it("treats a declared name as literal text, not a pattern", () => {
		const scan = scanBody("a.b and axb", {privateRepos: [], identifiers: ["a.b"]});
		expect(scan.redacted).toBe("<redacted> and axb");
	});
});

describe("isBareAtReference", () => {
	it("catches the composed body having never arrived (#3086)", () => {
		expect(isBareAtReference("@/tmp/body.md")).toBe(true);
		expect(isBareAtReference("  \n@~/notes/body.md\n")).toBe(true);
	});

	it("is not fooled by an @mention or an email in prose", () => {
		expect(isBareAtReference("@usirin said the retry helper drops the reason")).toBe(false);
		expect(isBareAtReference("## Summary\nsee @/tmp/x later")).toBe(false);
	});
});
