/**
 * `/lab/atolye` — the public index of atölye, the in-product museum of craft (epic #2473).
 * Lists every exhibit the headless registry enumerates; each row deep-links to that exhibit's
 * detail route (#3093). The registry is the seam (`.patterns/atolye-exhibit-harness.md`) — a new
 * exhibit appears here by landing one `*.exhibit.tsx` + one registry line, never a route edit.
 *
 * Route/slug are ASCII English (`/lab/atolye`, matching this dir + the routes-are-English
 * convention); the visible brand copy stays Turkish (`atölye`, with the ö).
 */

import {Link} from "react-router";
import {listExhibits} from "./registry";
import "./AtolyeIndexPage.css";

export function AtolyeIndexPage() {
	const exhibits = listExhibits();
	return (
		<main className="kp-atolye" data-testid="lab-atolye-index">
			<div className="kp-atolye__inner">
				<header className="kp-atolye__masthead">
					<h1 className="kp-atolye__title">atölye</h1>
					<p className="kp-atolye__lead">
						The living showcase of our design system — each piece an exhibit alive with its own
						prop-knobs. Click an exhibit to tinker with its variants live.
					</p>
				</header>

				<ul className="kp-atolye__list" aria-label="exhibits">
					{exhibits.map((exhibit) => (
						<li key={exhibit.id} className="kp-atolye__item">
							<Link to={`/lab/atolye/${exhibit.id}`} className="kp-atolye__card">
								<span className="kp-atolye__card-title">{exhibit.title}</span>
								{exhibit.summary ? (
									<span className="kp-atolye__card-summary">{exhibit.summary}</span>
								) : null}
							</Link>
						</li>
					))}
				</ul>
			</div>
		</main>
	);
}
