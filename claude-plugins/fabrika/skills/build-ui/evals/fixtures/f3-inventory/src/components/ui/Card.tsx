/** @component Card
 *  @whenToUse any grouped block of related content on a raised surface
 *  @slot title @slot body @slot footer */
export function Card(props: {
	title?: React.ReactNode;
	children: React.ReactNode;
	footer?: React.ReactNode;
}) {
	return (
		<section className="kp-card">
			{props.title ? <header className="kp-card-title">{props.title}</header> : null}
			<div className="kp-card-body">{props.children}</div>
			{props.footer ? <footer className="kp-card-footer">{props.footer}</footer> : null}
		</section>
	);
}
