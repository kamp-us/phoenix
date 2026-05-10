import {Link} from "react-router";
import "./NotFoundPage.css";

/**
 * Generic 404 page. Used by `/u/<username>` (T14) when the profile query
 * returns null, by `/sozluk/<slug>` (T17) when the term is missing and the
 * viewer can't auto-create it, by `/pano/<idOrSlug>` (T17) when the post
 * query returns null, and by the catch-all router route for any path that
 * doesn't match a known feature.
 *
 * Three nav links: home, sozluk index, pano feed. Optional `title` /
 * `message` props let each call site speak in its own register without
 * forking the component.
 */
export function NotFoundPage({title, message}: {title?: string; message?: string}) {
	return (
		<div className="kp-not-found" data-testid="not-found-page">
			<div className="kp-not-found__inner">
				<h1>{title ?? "bulunamadı"}</h1>
				<p>{message ?? "aradığın sayfa burada değil. başka bir şeye bakmak ister misin?"}</p>
				<nav className="kp-not-found__links">
					<Link to="/">ana sayfa</Link>
					<Link to="/sozluk">sözlük</Link>
					<Link to="/pano">pano</Link>
				</nav>
			</div>
		</div>
	);
}
