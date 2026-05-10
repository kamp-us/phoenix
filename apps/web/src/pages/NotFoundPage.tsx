import {Link} from "react-router";

/**
 * Generic 404 page. Used by `/u/<username>` when `profile()` returns null
 * (T14). Future tasks (T17) will route term/post 404s through here too.
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
