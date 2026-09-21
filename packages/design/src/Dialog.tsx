import {type DialogProps, type DialogRenderProps, Dialog as MantiDialog} from "@manti-ui/react";
import {useId} from "react";
import "./Dialog.css";
import {useDesignT} from "./i18n";

export type {DialogProps, DialogSize} from "@manti-ui/react";

/**
 * @component Dialog
 * @whenToUse The Manti-backed modal surface for confirmations, forms and focused
 *   overlay tasks. Supply `title` for its accessible name and use the footer
 *   render prop when actions need the provided `close` callback.
 * @slot trigger Optional element that opens the dialog.
 * @slot children The dialog body.
 * @slot footer Optional action row, accepting Manti's dialog render props.
 */
export function Dialog({children, showCloseButton = true, id, ...rest}: DialogProps) {
	const t = useDesignT();
	const fallbackId = useId();
	const dialogId = id ?? fallbackId;

	if (!showCloseButton) {
		return (
			<MantiDialog id={dialogId} showCloseButton={false} {...rest}>
				{children}
			</MantiDialog>
		);
	}

	return (
		<MantiDialog id={dialogId} showCloseButton={false} {...rest}>
			{(props: DialogRenderProps) => (
				<>
					<DialogCloseButton dialogId={dialogId} label={t("ui.dialog.close")} close={props.close} />
					{typeof children === "function" ? children(props) : children}
				</>
			)}
		</MantiDialog>
	);
}

/**
 * Manti's own close button carries no accessible name and takes no label prop
 * (`@manti-ui/react@0.9.0`, `dist/index.js` Dialog: the `getCloseTriggerProps()` spread plus an
 * `aria-hidden` X, and `DialogProps` declares no `translations`), so phoenix suppresses it and
 * renders this one through the published `{close}` render prop.
 *
 * It is a raw `<button>` rather than phoenix's `Button` because Manti's Button merges its own
 * `data-part="root"` last and so overwrites the part hook below — measured in Chromium, where the
 * close button then lands in the flow instead of the dialog's corner.
 *
 * Two attributes reproduce what Zag emitted, and both are load-bearing:
 * - `data-scope`/`data-part` are the anatomy hooks every close-trigger style keys on, in
 *   `@manti-ui/styles` and in `Dialog.css` alike.
 * - the `dialog:<id>:close` id is what `@zag-js/dialog@1.43.0` `dialog.dom.mjs` resolves for
 *   `getCloseTriggerEl`, which an `alertdialog` focuses on open (`dialog.machine.mjs`). Without
 *   it an `alertdialog` would fall back to the first `[autofocus]` in its body.
 */
function DialogCloseButton({
	dialogId,
	label,
	close,
}: {
	dialogId: string;
	label: string;
	close: () => void;
}) {
	return (
		<button
			type="button"
			id={`dialog:${dialogId}:close`}
			data-scope="dialog"
			data-part="close-trigger"
			aria-label={label}
			onClick={close}
		>
			<svg
				width="16"
				height="16"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				aria-hidden="true"
			>
				<path d="M4 4 12 12M12 4 4 12" />
			</svg>
		</button>
	);
}
