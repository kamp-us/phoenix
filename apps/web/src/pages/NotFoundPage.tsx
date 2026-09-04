import {Link} from "react-router";
import {useT} from "../i18n";
import "./NotFoundPage.css";

export function NotFoundPage({title, message}: {title?: string; message?: string}) {
	const t = useT();
	return (
		<div className="kp-not-found" data-testid="not-found-page">
			<div className="kp-not-found__inner">
				<h1>{title ?? t("notFound.title")}</h1>
				<p>{message ?? t("notFound.message")}</p>
				<nav className="kp-not-found__links">
					<Link to="/">{t("notFound.link.home")}</Link>
					<Link to="/sozluk">{t("notFound.link.sozluk")}</Link>
					<Link to="/pano">{t("notFound.link.pano")}</Link>
				</nav>
			</div>
		</div>
	);
}
