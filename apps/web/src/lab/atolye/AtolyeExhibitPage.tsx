/**
 * An unknown slug renders an in-page atölye not-found, never the global 404, so a dead deep-link
 * cannot crash the harness. The route/slug stay ASCII English (routes-are-English convention)
 * while the visible brand copy stays Turkish (`atölye`, with the ö).
 */

import {Link, useParams} from "react-router";
import {ExhibitStage} from "./ExhibitStage";
import type {AnyExhibit} from "./exhibit";
import {getExhibit} from "./registry";
import {useUrlKnobs} from "./useUrlKnobs";
import "./AtolyeExhibitPage.css";

export function AtolyeExhibitPage() {
	const {exhibit: slug} = useParams<{exhibit: string}>();
	const exhibit = slug ? getExhibit(slug) : undefined;
	if (!exhibit) return <ExhibitNotFound slug={slug} />;
	return <ExhibitDetail exhibit={exhibit} />;
}

// A distinct component so the knob hooks only run on the resolved-exhibit branch — never
// conditionally, and never against a missing schema on the not-found branch.
function ExhibitDetail({exhibit}: {exhibit: AnyExhibit}) {
	const knobs = useUrlKnobs(exhibit.knobs);
	return (
		<main className="kp-atolye" data-testid="lab-atolye-detail">
			<div className="kp-atolye__inner">
				<header className="kp-atolye-detail__masthead">
					<Link to="/lab/atolye" className="kp-atolye-detail__back">
						← atölye
					</Link>
					<h1 className="kp-atolye__title">{exhibit.title}</h1>
					{exhibit.summary ? <p className="kp-atolye__lead">{exhibit.summary}</p> : null}
				</header>
				<ExhibitStage exhibit={exhibit} knobs={knobs} />
			</div>
		</main>
	);
}

function ExhibitNotFound({slug}: {slug?: string}) {
	return (
		<main className="kp-atolye" data-testid="lab-atolye-not-found">
			<div className="kp-atolye__inner">
				<header className="kp-atolye-detail__masthead">
					<Link to="/lab/atolye" className="kp-atolye-detail__back">
						← atölye
					</Link>
					<h1 className="kp-atolye__title">exhibit not found</h1>
					<p className="kp-atolye__lead">
						There's no exhibit called{" "}
						{slug ? <code className="kp-atolye-detail__slug">{slug}</code> : "that"}. Want to browse
						the pieces on display?
					</p>
				</header>
			</div>
		</main>
	);
}
