/**
 * The welcome moment's exit ask (#7044, epic #4304) — the soft, dismissible "ilk
 * katkını yaz" nudge (#4289). Presentation only: who sees it and what it points at is
 * `firstContribution.ts`'s call, and dismissal is the caller's to persist.
 */
import {Link} from "react-router";
import {Button} from "../ui/Button";
import type {FirstContributionNudge as Nudge} from "./firstContribution";
import "./FirstContributionNudge.css";

export interface FirstContributionNudgeProps {
	readonly nudge: Nudge;
	readonly onDismiss: () => void;
}

export function FirstContributionNudge({nudge, onDismiss}: FirstContributionNudgeProps) {
	const addEntry = nudge.kind === "add-entry";
	return (
		<section className="kp-first-katki" data-testid="first-contribution-nudge">
			<h2 className="kp-first-katki__heading">ilk katkını yaz</h2>
			<p className="kp-first-katki__line" data-testid="first-contribution-copy">
				{addEntry
					? `"${nudge.term}" başlığına bir entry ekleyerek başlayabilirsin.`
					: "sözlükte ilgini çeken bir başlık bul ve ilk entry'ni yaz."}
			</p>
			<div className="kp-first-katki__actions">
				<Link to={nudge.to} className="kp-first-katki__go" data-testid="first-contribution-go">
					{addEntry ? "entry ekle" : "sözlüğe göz at"}
				</Link>
				<Button
					type="button"
					variant="tertiary"
					className="kp-first-katki__dismiss"
					data-testid="first-contribution-dismiss"
					onClick={onDismiss}
				>
					şimdi değil
				</Button>
			</div>
		</section>
	);
}
