/** Renders a child's derived pickable/blocked/not-triaged verdict (story 5). */
import type {Pickability} from "../lib/epic.ts";
import "./PickabilityTag.css";

export function PickabilityTag({pickability}: {pickability: Pickability}) {
	if (pickability.kind === "pickable") {
		return <span className="db-pick db-pick--pickable">pickable</span>;
	}
	if (pickability.kind === "blocked") {
		return (
			<span className="db-pick db-pick--blocked" title={pickability.reason}>
				blocked · {pickability.reason}
			</span>
		);
	}
	return (
		<span className="db-pick db-pick--not-triaged" title={pickability.reason}>
			{pickability.reason}
		</span>
	);
}
