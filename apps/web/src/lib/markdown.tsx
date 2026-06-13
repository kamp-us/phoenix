import type * as React from "react";

/**
 * Bare-bones inline markdown — `code`, **strong** only, intentionally simple. A
 * real markdown renderer (react-markdown + sanitizer) replaces this when content
 * gets richer. Shared by sözlük definition bodies and pano post/comment bodies.
 */
export function renderMarkdownInline(src: string): React.ReactNode[] {
	const out: React.ReactNode[] = [];
	let i = 0;
	let buf = "";
	const flush = () => {
		if (buf) {
			out.push(buf);
			buf = "";
		}
	};
	while (i < src.length) {
		if (src[i] === "`") {
			const close = src.indexOf("`", i + 1);
			if (close > i) {
				flush();
				out.push(<code key={out.length}>{src.slice(i + 1, close)}</code>);
				i = close + 1;
				continue;
			}
		}
		if (src[i] === "*" && src[i + 1] === "*") {
			const close = src.indexOf("**", i + 2);
			if (close > i + 1) {
				flush();
				out.push(<strong key={out.length}>{src.slice(i + 2, close)}</strong>);
				i = close + 2;
				continue;
			}
		}
		buf += src[i];
		i++;
	}
	flush();
	return out;
}

export type MarkdownBlock = {kind: "text"; text: string} | {kind: "code"; text: string};

/**
 * Splits markdown into paragraphs and fenced code blocks. Used for definition
 * bodies on the sözlük term page; pano comment bodies use only the inline
 * helper above (no fenced blocks expected mid-thread).
 */
export function splitMarkdownBlocks(src: string): MarkdownBlock[] {
	const blocks: MarkdownBlock[] = [];
	const fence = /```([\s\S]*?)```/g;
	let last = 0;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex.exec pattern
	while ((m = fence.exec(src)) !== null) {
		if (m.index > last) {
			const text = src.slice(last, m.index).trim();
			if (text) {
				for (const para of text.split(/\n{2,}/)) {
					if (para.trim()) blocks.push({kind: "text", text: para.trim()});
				}
			}
		}
		blocks.push({kind: "code", text: (m[1] ?? "").replace(/^\n|\n$/g, "")});
		last = m.index + m[0].length;
	}
	if (last < src.length) {
		const text = src.slice(last).trim();
		if (text) {
			for (const para of text.split(/\n{2,}/)) {
				if (para.trim()) blocks.push({kind: "text", text: para.trim()});
			}
		}
	}
	return blocks;
}
