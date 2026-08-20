import {Link} from "react-router";
import "./NotFoundPage.css";

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
