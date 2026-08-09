/** @component Button
 *  @whenToUse any click-triggered action */
export function Button(props: {children: React.ReactNode; onClick?: () => void}) {
	return (
		<button type="button" className="kp-button" onClick={props.onClick}>
			{props.children}
		</button>
	);
}
