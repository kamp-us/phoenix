/**
 * The lazy boundary around `@kampus/design`'s `Diff`, and the only reason this module exists.
 *
 * `Diff` pulls `@pierre/diffs` and Shiki: wiring it in statically put **+143,566 B gzip** on the
 * desk's entry chunk, measured on #8620 by forcing a reference to it from the page entry. Nothing a
 * reader sees before opening a tool call may cost that, so the reference lives behind a `React.lazy`
 * import of this file instead — a module the bundler can put in a chunk of its own.
 *
 * The import is the package's `./Diff` subpath and not its barrel: the barrel is already in the
 * entry chunk, so a dynamic import through it puts `Diff` back where it started — measured, not
 * assumed (the entry moved 0 B). The deep path is the only edge the bundler can cut.
 *
 * A default export because that is what `lazy` resolves; nothing else imports this directly.
 */

import {Diff} from "@kampus/design/Diff";
import type {ReactElement} from "react";

export default function EditDiff({
	path,
	before,
	after,
}: {
	readonly path: string;
	readonly before: string;
	readonly after: string;
}): ReactElement {
	return <Diff path={path} before={before} after={after} />;
}
