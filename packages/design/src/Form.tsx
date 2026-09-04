import {Input, Textarea} from "@manti-ui/react";
import type * as React from "react";
import "./Form.css";

/**
 * @component Input
 * @whenToUse The Manti single-line field. Pass its `label` directly and use
 *   `hint` or `error` so Manti owns the field's accessible relationships.
 * @slot none A leaf field control with its label and messages supplied as props.
 */
/**
 * @component Textarea
 * @whenToUse The Manti multi-line field for free-form content. Pass its `label`
 *   directly; use `kp-textarea--mono` only for code or preformatted input.
 * @slot none A leaf field control with its label and messages supplied as props.
 */
export type {InputProps, InputVariant, TextareaProps, TextareaVariant} from "@manti-ui/react";
export {Input, Textarea};

/**
 * @component Form
 * @whenToUse The native form shell around Manti's field-owning Input and Textarea
 *   components. Use it for submit semantics without introducing another field state layer.
 * @slot children The Manti fields and form actions.
 */
export function Form({
	className = "",
	children,
	...rest
}: React.FormHTMLAttributes<HTMLFormElement>) {
	return (
		<form className={`kp-form ${className}`.trim()} {...rest}>
			{children}
		</form>
	);
}
