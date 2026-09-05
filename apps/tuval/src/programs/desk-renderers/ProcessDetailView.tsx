/**
 * The one component both `engine-view` and `ps` mount in the desk inspector.
 *
 * It is not a program and it is not a region: it draws the inside of the region the shell already
 * owns (#7691), takes no key, holds no state, and reads nothing — every fact arrives as the
 * `ProcessDetail` value `./detail.ts` derived. Sharing it is the whole reason the two programs
 * cannot drift into showing different things about one selection.
 *
 * The semantics carry the meaning, not the paint. A `<dl>` because these are name/value pairs; the
 * lifecycle and the port directions are spelled out as words beside their glyph, because a state
 * carried only by an arrow or a fill is a state a screen-reader user never learns (ADR 0162,
 * pillar 4). The heading is the process id, so the region announces which process it is about.
 */

import type {ReactElement} from "react";
import type {PortLine, ProcessDetail} from "./detail.ts";
import "./process-detail.css";

export interface ProcessDetailViewProps {
	readonly detail: ProcessDetail;
}

/** The glyph is decoration beside the word; the word is what a reader gets either way. */
const arrow = (direction: PortLine["direction"]): string => (direction === "in" ? "→" : "←");

function PortList({ports}: {readonly ports: ReadonlyArray<PortLine>}): ReactElement {
	if (ports.length === 0) return <p className="tuval-detail-empty-ports">No declared ports.</p>;
	return (
		<ul className="tuval-detail-ports">
			{ports.map((port) => (
				<li key={port.name}>
					<span className="tuval-detail-port-name">{port.name}</span>
					<span className="tuval-detail-port-direction">
						<span aria-hidden="true">{arrow(port.direction)}</span> {port.direction}
					</span>
					<span className="tuval-detail-port-kind">{port.kind}</span>
				</li>
			))}
		</ul>
	);
}

export function ProcessDetailView({detail}: ProcessDetailViewProps): ReactElement {
	if (detail._tag === "NoSelection") {
		return (
			<div className="tuval-detail tuval-detail-placeholder" role="status">
				<p>No process selected. Pick one in the window to see its ports and state here.</p>
			</div>
		);
	}

	if (detail._tag === "SelectionGone") {
		return (
			<div className="tuval-detail tuval-detail-placeholder" role="status">
				<p>
					Process <code>{detail.processId}</code> has left the table.
				</p>
			</div>
		);
	}

	return (
		<div className="tuval-detail">
			<h2 className="tuval-detail-title">{detail.processId}</h2>
			<dl className="tuval-detail-fields">
				<dt>Program</dt>
				<dd>{detail.programId}</dd>
				<dt>Parent</dt>
				<dd>{detail.parentId === null ? "none — this is a root process" : detail.parentId}</dd>
				<dt>Lifecycle</dt>
				<dd>{detail.lifecycle}</dd>
				<dt>Revision</dt>
				<dd>{detail.revision}</dd>
				<dt>Ports</dt>
				<dd>
					<PortList ports={detail.ports} />
				</dd>
			</dl>
		</div>
	);
}
