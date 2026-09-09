/**
 * The process board in a real browser, without a kernel or a socket.
 *
 * jsdom has no layout, so every claim the board makes about paint — the nesting rail, the tile's
 * rhythm, where a long status line wraps — is unfalsifiable in the unit tier. This is the page the
 * design gate captures (`.fabrika.jsonc`'s `tuval-board` surface) and the page anyone can open with
 * `pnpm proof:board` from `apps/tuval`.
 *
 * The rows are a still life on purpose: a board that spawned a process on a timer would capture
 * differently on every run. What the entry animation does is the unit tier's
 * (`../process-board.unit.test.tsx`).
 */

import {Option} from "effect";
import {StrictMode} from "react";
import {createRoot} from "react-dom/client";
import {ProcessId} from "../../../process/process.ts";
import {ProgramId} from "../../../registry/program.ts";
import type {PortDeclaration, TableRow} from "../../../table/row.ts";
import {ProcessBoard} from "../ProcessBoard.tsx";
import "../../ui/tokens.css";
import "./proof.css";

const out = (kind: string): PortDeclaration => ({kind, direction: "out"});

const selfReporting = {
	"title@1": out("tuval/title/v1"),
	"status@1": out("tuval/status/v1"),
};

const row = (
	id: string,
	programId: string,
	fields: {
		readonly parent?: string;
		readonly title?: string;
		readonly status?: string;
		readonly ports?: Readonly<Record<string, PortDeclaration>>;
		readonly lifecycle?: "running" | "stopping";
	},
): TableRow => ({
	id: ProcessId.make(id),
	programId: ProgramId.make(programId),
	parentId:
		fields.parent === undefined ? Option.none() : Option.some(ProcessId.make(fields.parent)),
	ports: fields.ports ?? {},
	stateSummary: {lifecycle: fields.lifecycle ?? "running", revision: 4},
	title: fields.title === undefined ? Option.none() : Option.some(fields.title),
	status: fields.status === undefined ? Option.none() : Option.some(fields.status),
});

const rows: ReadonlyArray<TableRow> = [
	row("p-claude", "ai/claude", {
		title: "claude · fable · phoenix",
		status: "writing the tile model · 4 tools · $0.14",
		ports: selfReporting,
	}),
	row("p-child", "ai/claude", {
		parent: "p-claude",
		title: "claude · fable · phoenix/apps/tuval",
		status:
			"reading apps/tuval/src/shell/board and reporting back what the nesting rail does at three levels of depth",
		ports: selfReporting,
	}),
	row("p-grandchild", "demo/log", {parent: "p-child", ports: {"lines@1": out("tuval/log/v1")}}),
	row("p-counter", "demo/counter", {title: "count: 12", ports: {"title@1": out("tuval/title/v1")}}),
	row("p-shell", "tuval/shell", {lifecycle: "stopping"}),
];

const host = document.getElementById("proof");
if (host === null) throw new Error("the proof page has no #proof element");

createRoot(host).render(
	<StrictMode>
		<div className="tuval-surface tuval-board-page" data-scheme="dark">
			<ProcessBoard
				rows={rows}
				onOpen={(processId) => {
					globalThis.console.log(`open ${processId}`);
				}}
				reducedMotion={false}
			/>
			{/* The desk's seat, so the board is captured at the height it actually gets. */}
			<div className="tuval-surface proof-desk">
				<p className="proof-desk-note">The desk sits here.</p>
			</div>
		</div>
	</StrictMode>,
);
