import {render, screen, within} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {Markdown} from "./Markdown";

describe("Markdown", () => {
	it("renders blocks as elements, not as source", () => {
		render(
			<Markdown>
				{[
					"## Heading",
					"",
					"A **bold** word, an *emphasised* one and `code`.",
					"",
					"> quoted",
					"",
					"---",
				].join("\n")}
			</Markdown>,
		);

		expect(screen.getByRole("heading", {level: 2, name: "Heading"})).toBeDefined();
		expect(screen.getByText("bold").tagName).toBe("STRONG");
		expect(screen.getByText("emphasised").tagName).toBe("EM");
		expect(screen.getByText("code").tagName).toBe("CODE");
		expect(screen.getByText("quoted").closest("blockquote")).not.toBeNull();
		expect(screen.getByRole("separator")).toBeDefined();
	});

	it("renders a table with its header cells and alignment", () => {
		render(<Markdown>{"| a | b |\n|:-:|--:|\n| 1 | 2 |"}</Markdown>);

		const table = screen.getByRole("table");
		expect(within(table).getByRole("columnheader", {name: "a"}).dataset.align).toBe("center");
		expect(within(table).getByRole("cell", {name: "2"}).dataset.align).toBe("right");
	});

	it("renders ordered and unordered lists, honouring an ordered list's start", () => {
		render(<Markdown>{"- one\n- two\n\n3. three\n4. four"}</Markdown>);

		const [unordered, ordered] = screen.getAllByRole("list");
		expect(unordered?.tagName).toBe("UL");
		expect(ordered?.tagName).toBe("OL");
		expect(ordered?.getAttribute("start")).toBe("3");
	});

	it("keeps a task list's state as its source marker", () => {
		render(<Markdown>{"- [x] done\n- [ ] todo"}</Markdown>);

		const [done, todo] = screen.getAllByRole("listitem");
		expect(done?.textContent).toBe("[x] done");
		expect(todo?.textContent).toBe("[ ] todo");
	});

	it("opens a link in the browser without leaking the referrer", () => {
		render(<Markdown>{"[kamp.us](https://kamp.us/x)"}</Markdown>);

		const link = screen.getByRole("link", {name: "kamp.us"});
		expect(link.getAttribute("href")).toBe("https://kamp.us/x");
		expect(link.getAttribute("target")).toBe("_blank");
		expect(link.getAttribute("rel")).toBe("noreferrer");
	});

	it.each([
		["javascript:alert(1)", "a script URL"],
		["JaVaScRiPt:alert(1)", "a script URL in mixed case"],
		[" javascript:alert(1)", "a script URL behind leading whitespace"],
		["data:text/html,<script>alert(1)</script>", "a data URL"],
		["vbscript:msgbox(1)", "a vbscript URL"],
	])("renders %s as text because it is %s, never as an anchor", (href) => {
		render(<Markdown>{`[click](${href})`}</Markdown>);

		expect(screen.queryByRole("link")).toBeNull();
		expect(screen.getByText("click")).toBeDefined();
	});

	it.each([
		"https://kamp.us",
		"mailto:x@kamp.us",
		"/sozluk",
		"#section",
	])("keeps %s as a live href", (href) => {
		render(<Markdown>{`[go](${href})`}</Markdown>);

		expect(screen.getByRole("link", {name: "go"}).getAttribute("href")).toBe(href);
	});

	it("prints raw HTML as text, so nothing in the source becomes markup", () => {
		const {container} = render(
			<Markdown>
				{"<script>alert(1)</script>\n\nan <b>inline</b> tag\n\n<img src=x onerror=y>"}
			</Markdown>,
		);

		expect(container.querySelector("script")).toBeNull();
		expect(container.querySelector("b")).toBeNull();
		expect(container.querySelector("img")).toBeNull();
		expect(container.textContent).toContain("<script>alert(1)</script>");
		expect(container.textContent).toContain("<b>inline</b>");
	});

	it("renders an image as a link, so no late-loading box changes the block's height", () => {
		const {container} = render(<Markdown>{"![a cat](https://kamp.us/cat.png)"}</Markdown>);

		expect(container.querySelector("img")).toBeNull();
		expect(screen.getByRole("link", {name: "a cat"}).getAttribute("href")).toBe(
			"https://kamp.us/cat.png",
		);
	});

	it("renders a fenced block as pre/code tagged with its language", () => {
		render(<Markdown>{"```ts\nconst x = 1;\n```"}</Markdown>);

		const code = screen.getByText("const x = 1;");
		expect(code.tagName).toBe("CODE");
		expect(code.className).toBe("language-ts");
		expect(code.parentElement?.tagName).toBe("PRE");
	});

	it("steps headings down from headingBase and clamps them at h6", () => {
		render(<Markdown headingBase={3}>{"# one\n\n## two\n\n##### five"}</Markdown>);

		expect(screen.getByRole("heading", {level: 3, name: "one"})).toBeDefined();
		expect(screen.getByRole("heading", {level: 4, name: "two"})).toBeDefined();
		expect(screen.getByRole("heading", {level: 6, name: "five"})).toBeDefined();
	});

	it("renders nothing but an empty block for empty source", () => {
		const {container} = render(<Markdown>{""}</Markdown>);

		expect(container.querySelector(".kp-markdown")?.textContent).toBe("");
	});
});
