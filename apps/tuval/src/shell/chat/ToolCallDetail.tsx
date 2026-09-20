/**
 * What one tool call shows once it is open, shared by the standalone `ToolRow` and by a call inside
 * a run. The blocks it renders are already deduped against the row's visible label
 * (`tool-detail.ts`, `callDisclosure`), so this decides nothing about content — it only draws it.
 *
 * An edit renders through `@kampus/design`'s `Diff`, which is what the design law names for a
 * before/after text diff, and which arrives in its own chunk (`EditDiff.tsx`). It is therefore the
 * one block here that paints after the row's first frame. The row is re-measured with no
 * cooperation from this component: the virtualizer observes each row node it is handed, so a border
 * box that changes after the first measure is re-measured
 * (`.patterns/markdown-async-block.md`, "the lazy-chunk case").
 */

import {lazy, type ReactElement, Suspense} from "react";
import type {CallDisclosure} from "./tool-detail.ts";

const EditDiff = lazy(() => import("./EditDiff.tsx"));

export function ToolCallDetail({disclosure}: {readonly disclosure: CallDisclosure}): ReactElement {
	return (
		<>
			{disclosure.edit === null ? null : (
				<div className="tuval-chat-tool-detail">
					<p className="tuval-chat-tool-label">edit · {disclosure.edit.path}</p>
					<Suspense fallback={<p className="tuval-chat-tool-label">loading the diff…</p>}>
						<EditDiff
							path={disclosure.edit.path}
							before={disclosure.edit.before}
							after={disclosure.edit.after}
						/>
					</Suspense>
				</div>
			)}
			{disclosure.blocks.map((block) => (
				<div key={block.label} className="tuval-chat-tool-detail">
					<p className="tuval-chat-tool-label">{block.label}</p>
					<pre className="tuval-chat-pre">{block.text}</pre>
				</div>
			))}
			{disclosure.omitted === null ? null : (
				<p className="tuval-chat-omission">{disclosure.omitted}</p>
			)}
		</>
	);
}
