/**
 * `Markdown` — the shared read-only markdown block for agent output (founder ruling 2026-09-05 on
 * [#8012](https://github.com/kamp-us/phoenix/issues/8012)).
 *
 * Two things here are not obvious from the code.
 *
 * **No HTML string is ever produced, so none can be executed.** This renders `marked`'s *token
 * stream* to React elements and never calls `marked()` itself, so there is no `innerHTML` seam to
 * sanitize: an `<script>` in the source arrives as an `html` token and is rendered as the text it
 * is. Safety is a property of the shape rather than of a filter that has to be kept correct.
 *
 * **Everything paints on the first render, with one block that then grows.** Agent transcripts are
 * virtualized and measured after paint, so a block that swapped content in later — an
 * async-highlighted code fence, a remote image — would leave the measured row height stale. Lexing
 * is synchronous and images render as links, so the element tree is final the moment it mounts.
 * `MermaidBlock` is the exception, and it is measurable on both sides: it paints the fence, then
 * swaps the diagram in for a re-measure it can only get from a `ResizeObserver` (see that module).
 */

import {lexer, type MarkedToken, type Token, type Tokens} from "marked";
import {Fragment, type ReactElement, type ReactNode, useMemo} from "react";
import {CodeBlock} from "./CodeBlock";
import {useDesignT} from "./i18n";
import {MermaidBlock} from "./MermaidBlock";
import "./Markdown.css";

/**
 * marked's `Token` union carries an open `Tokens.Generic` member whose `type` is `string`, so a
 * `switch` on the discriminant never eliminates it and every field it narrows to degrades to `any`.
 * The lexer emits only the closed `MarkedToken` set unless an extension registers another, and this
 * module registers none — so the union is narrowed once here instead of at every field access.
 */
const closed = (token: Token): MarkedToken => token as MarkedToken;

/**
 * A markdown token has no identity of its own — two sibling list items may carry byte-identical
 * source — so position is the only key available, and a block re-renders whole in any case.
 */
const keyed = <T,>(items: readonly T[], render: (item: T) => ReactNode): ReactNode =>
	items.map((item, index) => <Fragment key={index}>{render(item)}</Fragment>);

/**
 * The one place a URL out of agent output becomes a live `href`. Everything outside the allow-list
 * — `javascript:`, `data:`, `vbscript:` — renders as text instead, so a link can never carry
 * execution into the page. Control characters and spaces go first, because the URL parser strips
 * them too: a scheme split by an embedded tab reads as a foreign one to a check that keeps them and
 * as `javascript:` to the browser, and that gap is the whole trick.
 */
const safeHref = (href: string): string | null => {
	const clean = [...href].filter((character) => character > " ").join("");
	if (clean === "") return null;
	const relative =
		clean.startsWith("#") ||
		clean.startsWith("/") ||
		clean.startsWith("./") ||
		clean.startsWith("../");
	if (relative) return clean;
	return /^(?:https?|mailto):/i.test(clean) ? clean : null;
};

/** The founder's ruling: agent links are real anchors and open in the browser. */
const Anchor = ({href, children}: {readonly href: string; readonly children: ReactNode}) => {
	const safe = safeHref(href);
	if (safe === null) return <>{children}</>;
	return (
		<a href={safe} target="_blank" rel="noreferrer">
			{children}
		</a>
	);
};

const inlines = (tokens: readonly Token[]): ReactNode =>
	keyed(tokens, (token) => <Inline token={closed(token)} />);

function Inline({token}: {readonly token: MarkedToken}): ReactNode {
	switch (token.type) {
		case "text":
			return token.tokens === undefined ? token.text : inlines(token.tokens);
		case "escape":
			return token.text;
		case "strong":
			return <strong>{inlines(token.tokens)}</strong>;
		case "em":
			return <em>{inlines(token.tokens)}</em>;
		case "del":
			return <del>{inlines(token.tokens)}</del>;
		case "codespan":
			return <code>{token.text}</code>;
		case "br":
			return <br />;
		case "link":
			return <Anchor href={token.href}>{inlines(token.tokens)}</Anchor>;
		// An `<img>` settles its own height after the network answers, which is exactly the late
		// layout shift a measured transcript row cannot absorb — so the image is offered as a link.
		case "image":
			return <Anchor href={token.href}>{token.text === "" ? token.href : token.text}</Anchor>;
		case "html":
			return token.text;
		default:
			return token.raw;
	}
}

/**
 * The scroller is the wrapper, never the `<table>`: `display: block` on a table drops its implicit
 * table role in Chrome and Safari, so the assistive-tech reading of an agent's table would be the
 * cost of making a wide one fit. The wrapper is focusable and named because a scroll container no
 * keyboard can reach is content a keyboard-only operator cannot read at all (WCAG 2.1.1).
 */
function TableBlock({token}: {readonly token: Tokens.Table}): ReactElement {
	const t = useDesignT();
	return (
		// biome-ignore lint/a11y/noNoninteractiveTabindex: the tab stop is the point — a scroll container no keyboard can focus is content a keyboard-only operator cannot reach at all (WCAG 2.1.1), and the accessible name keeps it from being an unexplained stop.
		<section className="kp-markdown__scroller" tabIndex={0} aria-label={t("ui.markdown.table")}>
			<table>
				<thead>
					<tr>
						{keyed(token.header, (cell) => (
							<th data-align={cell.align ?? undefined}>{inlines(cell.tokens)}</th>
						))}
					</tr>
				</thead>
				<tbody>
					{keyed(token.rows, (row) => (
						<tr>
							{keyed(row, (cell) => (
								<td data-align={cell.align ?? undefined}>{inlines(cell.tokens)}</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</section>
	);
}

/**
 * A fence's info string is everything after the backticks, and only its first word is the language
 * — ```` ```mermaid title="x" ```` is a mermaid fence, and `CodeBlock` already tags the class off
 * the whole string the way GFM does.
 */
const fenceLanguage = (token: Tokens.Code): string =>
	(token.lang ?? "").trim().split(/\s+/)[0] ?? "";

const blocks = (tokens: readonly Token[], headingBase: number): ReactNode =>
	keyed(tokens, (token) => <Block token={closed(token)} headingBase={headingBase} />);

function Block({
	token,
	headingBase,
}: {
	readonly token: MarkedToken;
	readonly headingBase: number;
}): ReactNode {
	switch (token.type) {
		case "space":
		case "def":
			return null;
		case "hr":
			return <hr />;
		case "heading": {
			const level = Math.min(6, headingBase + token.depth - 1);
			const Heading = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
			return <Heading>{inlines(token.tokens)}</Heading>;
		}
		case "paragraph":
			return <p>{inlines(token.tokens)}</p>;
		case "blockquote":
			return <blockquote>{blocks(token.tokens, headingBase)}</blockquote>;
		// A `mermaid` fence is the one language with a rendering of its own (#8128). Every other
		// fence, and a mermaid one before or after a failed parse, stays on `CodeBlock`.
		case "code":
			return fenceLanguage(token) === "mermaid" ? (
				<MermaidBlock token={token} />
			) : (
				<CodeBlock token={token} />
			);
		// A task marker stays the text it was written as. A real `<input type="checkbox">` would be
		// an unlabelled control in a read-only block, and its state would reach a screen reader only
		// by duplicating the item's own text as a name.
		case "checkbox":
			return token.raw;
		case "list": {
			const items = keyed(token.items, (item) => <li>{blocks(item.tokens, headingBase)}</li>);
			return token.ordered ? (
				<ol start={token.start === "" ? undefined : token.start}>{items}</ol>
			) : (
				<ul>{items}</ul>
			);
		}
		case "table":
			return <TableBlock token={token} />;
		// Raw HTML is content, not markup: it prints as the source it is (see the module docblock).
		case "html":
			return <p className="kp-markdown__raw">{token.text}</p>;
		case "text":
			return token.tokens === undefined ? token.text : inlines(token.tokens);
		default:
			return token.raw;
	}
}

/**
 * @component Markdown
 * @whenToUse Read-only display of markdown an agent produced — a chat transcript row, a tool
 *   result, any surface that shows model output. It is a renderer, not an editor: for authoring
 *   reach for the app's editor instead.
 * @slot children The markdown source. Not sanitized upstream and not required to be: raw HTML in it
 *   renders as text, never as markup.
 */
export function Markdown({
	children,
	className = "",
	headingBase = 1,
	breaks = false,
}: {
	readonly children: string;
	readonly className?: string;
	/**
	 * The level a top-level (`#`) markdown heading renders at, so a block nested inside a page's
	 * outline does not emit an `<h1>` under it. Deeper headings step down from here and clamp at 6.
	 */
	readonly headingBase?: number;
	/**
	 * Whether a lone newline inside a paragraph is a line break. Off by default, which is markdown's
	 * own reading and the one a document-shaped surface wants; a chat transcript turns it on,
	 * because a message is read as the lines it was typed on (#8244).
	 */
	readonly breaks?: boolean;
}): ReactElement {
	// `gfm` is restated because an options object replaces marked's defaults wholesale rather than
	// merging into them (`Lexer`'s `this.options = e || _defaults`), and `breaks` is read only under
	// `gfm` — passing `{breaks}` alone would silently drop tables and strikethrough.
	const tokens = useMemo(() => lexer(children, {gfm: true, breaks}), [children, breaks]);
	return <div className={`kp-markdown ${className}`.trim()}>{blocks(tokens, headingBase)}</div>;
}
