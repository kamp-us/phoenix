import {Field as BaseField} from "@base-ui/react/field";
import {Form as BaseForm} from "@base-ui/react/form";
import {Input as BaseInput} from "@base-ui/react/input";
import type * as React from "react";
import {bem} from "../../lib/bem";
import "./Form.css";

const styles = bem("kp-form", []);
const fieldStyles = bem("kp-field", ["label", "hint", "error"]);

/**
 * @component Form
 * @whenToUse The form shell (base-ui) — the outermost element for any input form,
 *   wiring native submit + validation. Compose the field family (`Field`, `Label`,
 *   `Hint`, `FieldError`, `Input`, `Textarea`) inside it rather than hand-rolling a
 *   `<form>`.
 * @slot children The form's fields and controls.
 */
export function Form({className = "", children, ...rest}: React.ComponentProps<typeof BaseForm>) {
	return (
		<BaseForm className={`${styles.root} ${className}`.trim()} {...rest}>
			{children}
		</BaseForm>
	);
}

/**
 * @component Field
 * @whenToUse The single-field grouping (base-ui) — wraps one `Label` + control +
 *   `Hint`/`FieldError`, wiring their aria relationships. Reach for it once per input
 *   inside a `Form` so label/error association is automatic.
 * @slot children The field's `Label`, control, and hint/error parts.
 */
export function Field({
	className = "",
	children,
	...rest
}: React.ComponentProps<typeof BaseField.Root>) {
	return (
		<BaseField.Root className={`kp-field ${className}`.trim()} {...rest}>
			{children}
		</BaseField.Root>
	);
}

/**
 * @component Label
 * @whenToUse The field label (base-ui) — the accessible name for its `Field`'s
 *   control. Reach for it inside every `Field`; it associates to the control
 *   automatically, so never substitute a bare `<label>` or placeholder text.
 * @slot children The label text.
 */
export function Label({children, ...rest}: React.ComponentProps<typeof BaseField.Label>) {
	return (
		<BaseField.Label className={fieldStyles.label} {...rest}>
			{children}
		</BaseField.Label>
	);
}

/**
 * @component Hint
 * @whenToUse The field helper text (base-ui) — a persistent description under a
 *   control, wired to `aria-describedby`. Reach for it for guidance that always
 *   shows; use `FieldError` for validation messages instead.
 * @slot children The hint text.
 */
export function Hint({children, ...rest}: React.ComponentProps<typeof BaseField.Description>) {
	return (
		<BaseField.Description className={fieldStyles.hint} {...rest}>
			{children}
		</BaseField.Description>
	);
}

/**
 * @component FieldError
 * @whenToUse The field validation message (base-ui) — the error line for its
 *   `Field`'s control, wired to the control and shown on invalid state. Reach for it
 *   for validation feedback; use `Hint` for always-on guidance.
 * @slot children The error text.
 */
export function FieldError({children, ...rest}: React.ComponentProps<typeof BaseField.Error>) {
	return (
		<BaseField.Error className={fieldStyles.error} {...rest}>
			{children}
		</BaseField.Error>
	);
}

/**
 * @component Input
 * @whenToUse The single-line text control (base-ui). Reach for it inside a `Field`
 *   for any one-line input; for multi-line text use `Textarea`.
 * @slot none A leaf control; no children slot.
 */
export function Input({className = "", ...rest}: React.ComponentProps<typeof BaseInput>) {
	return <BaseInput className={`kp-input ${className}`.trim()} {...rest} />;
}

/**
 * @component Textarea
 * @whenToUse The multi-line text control. Reach for it inside a `Field` for
 *   free-form text (a comment body, a definition); pass `mono` for code/preformatted
 *   input. For a single line use `Input`.
 * @slot none A leaf control; no children slot.
 */
export function Textarea({
	className = "",
	mono = false,
	...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
	/** Render in a monospace face for code/preformatted input. */
	mono?: boolean;
}) {
	const cls = `kp-textarea ${mono ? "kp-textarea--mono" : ""} ${className}`.trim();
	return <BaseField.Control render={<textarea className={cls} {...rest} />} />;
}
