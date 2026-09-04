/**
 * The welcome moment's exit ask (#7044, epic #4304) — the soft, dismissible "ilk
 * katkını yaz" nudge (#4289). Presentation only: who sees it and what it points at is
 * `firstContribution.ts`'s call, and dismissal is the caller's to persist.
 */
import {Button, Surface} from "@kampus/design";
import {Link} from "react-router";
import {useT} from "../../i18n";
import type {FirstContributionNudge as Nudge} from "./firstContribution";
import "./FirstContributionNudge.css";

export interface FirstContributionNudgeProps {
	readonly nudge: Nudge;
	readonly onDismiss: () => void;
}

export function FirstContributionNudge({nudge, onDismiss}: FirstContributionNudgeProps) {
	const t = useT();
	return (
		<Surface
			as="section"
			tone="raised"
			radius="sm"
			padding="md"
			border
			className="kp-first-katki"
			data-testid="first-contribution-nudge"
		>
			<h2 className="kp-first-katki__heading">{t("auth.firstContribution.heading")}</h2>
			<p className="kp-first-katki__line" data-testid="first-contribution-copy">
				{nudge.kind === "add-entry"
					? t("auth.firstContribution.addEntry", {term: nudge.term})
					: t("auth.firstContribution.browse", {sozlukNoun: t("auth.brand.sozluk")})}
			</p>
			<div className="kp-first-katki__actions">
				<Link to={nudge.to} className="kp-first-katki__go" data-testid="first-contribution-go">
					{nudge.kind === "add-entry"
						? t("auth.firstContribution.goAddEntry")
						: t("auth.firstContribution.goBrowse", {sozlukNoun: t("auth.brand.sozluk")})}
				</Link>
				<Button
					type="button"
					variant="tertiary"
					className="kp-first-katki__dismiss"
					data-testid="first-contribution-dismiss"
					onClick={onDismiss}
				>
					{t("auth.firstContribution.dismiss")}
				</Button>
			</div>
		</Surface>
	);
}
