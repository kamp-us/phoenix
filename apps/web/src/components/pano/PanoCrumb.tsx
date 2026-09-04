import {Link} from "react-router";
import {useT} from "../../i18n";
import "./PanoCrumb.css";

export function PanoCrumb({host, onClearTo = "/pano"}: {host: string; onClearTo?: string}) {
	const t = useT();
	return (
		<div className="kp-pano-crumb">
			<Link to="/pano">{t("pano.crumb.root")}</Link>
			<span className="sep">/</span>
			<span>{t("pano.crumb.site")}</span>
			<span className="sep">/</span>
			<span className="host">{host}</span>
			<Link className="clear" to={onClearTo}>
				{t("layout.filter.clear")}
			</Link>
		</div>
	);
}
