import { Link } from 'react-router';
import './PanoCrumb.css';

export function PanoCrumb({
	host,
	onClearTo = '/pano',
}: {
	host: string;
	onClearTo?: string;
}) {
	return (
		<div className="kp-pano-crumb">
			<Link to="/pano">pano</Link>
			<span className="sep">/</span>
			<span>site</span>
			<span className="sep">/</span>
			<span className="host">{host}</span>
			<Link className="clear" to={onClearTo}>
				× filtreyi kaldır
			</Link>
		</div>
	);
}
