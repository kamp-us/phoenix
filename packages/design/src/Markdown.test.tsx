import {render, screen, waitFor, within} from "@testing-library/react";
import {beforeEach, describe, expect, it, vi} from "vitest";
import {Markdown} from "./Markdown";

/**
 * Mermaid lays out by measuring real text, and jsdom implements neither `getBBox` nor a 2D canvas
 * context — so no diagram can be drawn here and no palette can be resolved. What these tests hold
 * is therefore the wiring and both fallbacks: that a `mermaid` fence reaches mermaid at all, that
 * what it hands back lands in the block with the source still reachable, and that a fence it
 * refuses stays the code block it was with the reason on screen. The drawing itself is the
 * library's, and the rendered result is `review-ui`'s to judge.
 */
const mermaid = vi.hoisted(() => ({
	initialize: vi.fn(),
	parse: vi.fn(),
	render: vi.fn(),
}));

vi.mock("mermaid", () => ({default: mermaid}));

const MERMAID_FENCE = "```mermaid\ngraph TD;\n  a-->b;\n```";

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

	// A wide table has to scroll somewhere, and doing it on the table itself costs the table role in
	// Chrome and Safari. jsdom applies no CSS, so the structure is what a test can hold: the scroller
	// is a wrapper around the table, and it is focusable and named (#8012 criterion 9).
	it("puts a table's horizontal scroller on a named, focusable wrapper rather than the table", () => {
		render(<Markdown>{"| a | b |\n|---|---|\n| 1 | 2 |"}</Markdown>);

		const table = screen.getByRole("table");
		const scroller = screen.getByRole("region");
		expect(scroller.contains(table)).toBe(true);
		expect(table.parentElement).toBe(scroller);
		expect(scroller.tabIndex).toBe(0);
		expect(scroller.getAttribute("aria-label")).toBeTruthy();
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

	// A long code line makes the fence a horizontal scroller, and a scroller with no tab stop is
	// content a keyboard-only operator cannot read (WCAG 2.1.1). jsdom applies no CSS, so the
	// structure is what a test can hold — the same shape the table scroller carries.
	it("makes a fenced block a named, focusable scroll region", () => {
		render(<Markdown>{"```ts\nconst x = 1;\n```"}</Markdown>);

		const pre = screen.getByText("const x = 1;").parentElement;
		expect(pre?.tagName).toBe("PRE");
		expect(pre?.getAttribute("role")).toBe("region");
		expect(pre?.tabIndex).toBe(0);
		expect(pre?.getAttribute("aria-label")).toBeTruthy();
	});

	it("steps headings down from headingBase and clamps them at h6", () => {
		render(<Markdown headingBase={3}>{"# one\n\n## two\n\n##### five"}</Markdown>);

		expect(screen.getByRole("heading", {level: 3, name: "one"})).toBeDefined();
		expect(screen.getByRole("heading", {level: 4, name: "two"})).toBeDefined();
		expect(screen.getByRole("heading", {level: 6, name: "five"})).toBeDefined();
	});

	it("folds a lone newline into a space by default, the way markdown reads it", () => {
		const {container} = render(<Markdown>{"one\ntwo"}</Markdown>);

		expect(container.querySelector("br")).toBeNull();
		expect(container.querySelector("p")?.textContent).toBe("one\ntwo");
	});

	it("renders a lone newline as a break under breaks", () => {
		const {container} = render(<Markdown breaks>{"one\ntwo"}</Markdown>);

		const paragraph = container.querySelector("p");
		expect(paragraph?.querySelectorAll("br")).toHaveLength(1);
		expect(paragraph?.textContent).toBe("onetwo");
	});

	// `breaks` is read only under marked's `gfm`, and an options object replaces the defaults rather
	// than merging into them — so passing it alone would take GFM's own syntax down with it.
	it("keeps GFM syntax under breaks", () => {
		render(<Markdown breaks>{"| a | b |\n|---|---|\n| 1 | 2 |\n\n~~gone~~"}</Markdown>);

		expect(screen.getByRole("table")).toBeDefined();
		expect(screen.getByText("gone").tagName).toBe("DEL");
	});

	it("renders nothing but an empty block for empty source", () => {
		const {container} = render(<Markdown>{""}</Markdown>);

		expect(container.querySelector(".kp-markdown")?.textContent).toBe("");
	});
});

describe("Markdown, a mermaid fence", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mermaid.parse.mockResolvedValue({diagramType: "flowchart-v2"});
		mermaid.render.mockResolvedValue({
			diagramType: "flowchart-v2",
			svg: '<svg><g id="drawn" /></svg>',
		});
	});

	// The first paint is the fence, not an empty box: a transcript row is measured after it paints,
	// so the height the virtualizer records has to be a real one (#8128, ChatWindow's row contract).
	it("paints the fence source before the diagram is drawn", () => {
		const {container} = render(<Markdown>{MERMAID_FENCE}</Markdown>);

		expect(container.querySelector("svg")).toBeNull();
		expect(screen.getByText(/graph TD;/).className).toBe("language-mermaid");
	});

	it("hands the fence's source to mermaid and shows what it draws", async () => {
		const {container} = render(<Markdown>{MERMAID_FENCE}</Markdown>);

		await waitFor(() => expect(container.querySelector("svg")).not.toBeNull());
		expect(mermaid.render).toHaveBeenCalledWith(expect.any(String), "graph TD;\n  a-->b;");
		expect(container.querySelector("#drawn")).not.toBeNull();
	});

	// `role="img"` makes the SVG's own text presentational, so a named graphic plus a disclosure
	// holding the source is the whole assistive-tech reading of the diagram.
	it("names the diagram and keeps its source reachable in a disclosure", async () => {
		render(<Markdown>{MERMAID_FENCE}</Markdown>);

		const diagram = await screen.findByRole("img");
		expect(diagram.getAttribute("aria-label")).toBeTruthy();
		const disclosure = diagram.parentElement?.querySelector("details");
		expect(disclosure?.querySelector("summary")?.textContent).toBeTruthy();
		expect(within(disclosure as HTMLElement).getByText(/graph TD;/).tagName).toBe("CODE");
	});

	it("initializes mermaid at a security level that sanitizes what it returns", async () => {
		render(<Markdown>{MERMAID_FENCE}</Markdown>);

		await waitFor(() => expect(mermaid.initialize).toHaveBeenCalled());
		expect(mermaid.initialize.mock.calls[0]?.[0]).toMatchObject({
			securityLevel: "strict",
			startOnLoad: false,
		});
	});

	// A bad fence never renders an empty box and never throws out of the row it sits in.
	it("falls back to the code block with the reason visible when mermaid refuses the source", async () => {
		mermaid.parse.mockRejectedValue(new Error("Parse error on line 2"));

		const {container} = render(<Markdown>{"```mermaid\nnot a diagram\n```"}</Markdown>);

		expect(await screen.findByText(/Parse error on line 2/)).toBeDefined();
		expect(container.querySelector("svg")).toBeNull();
		expect(screen.getByText("not a diagram").className).toBe("language-mermaid");
		expect(mermaid.render).not.toHaveBeenCalled();
	});

	it("leaves a fence in any other language on the code path, untouched", () => {
		render(<Markdown>{"```ts\nconst x = 1;\n```"}</Markdown>);

		expect(mermaid.initialize).not.toHaveBeenCalled();
		expect(screen.getByText("const x = 1;").className).toBe("language-ts");
		expect(screen.queryByRole("img")).toBeNull();
	});
});
