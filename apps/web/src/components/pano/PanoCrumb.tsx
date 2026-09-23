import {Link} from "react-router";
import {useT} from "../../i18n";
import {Breadcrumbs} from "../layout/Breadcrumbs";
import "./PanoCrumb.css";

export function PanoCrumb({host, onClearTo = "/pano"}: {host: string; onClearTo?: string}) {
	const t = useT();
	return (
		<div className="kp-pano-crumb">
			<Breadcrumbs
				trail={[
					{key: "root", label: <Link to="/pano">{t("pano.crumb.root")}</Link>},
					{key: "site", label: t("pano.crumb.site")},
				]}
				current={{key: "host", label: <span className="host">{host}</span>}}
			/>
			<Link className="clear" to={onClearTo}>
				{t("layout.filter.clear")}
			</Link>
		</div>
	);
}
