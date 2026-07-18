import {Dialog as BaseDialog} from "@base-ui/react/dialog";
import * as React from "react";
import {bem} from "../../lib/bem";
import "./Dialog.css";

const styles = bem("kp-dialog", [
	"backdrop",
	"popup",
	"head",
	"title",
	"description",
	"body",
	"foot",
	"close",
]);

export const Root = BaseDialog.Root;
export const Trigger = BaseDialog.Trigger;
export const Close = BaseDialog.Close;

export function Backdrop(props: React.ComponentProps<typeof BaseDialog.Backdrop>) {
	return <BaseDialog.Backdrop className={styles.backdrop} {...props} />;
}

export function Popup({children, ...rest}: React.ComponentProps<typeof BaseDialog.Popup>) {
	return (
		<BaseDialog.Portal>
			<Backdrop />
			<BaseDialog.Popup className={styles.popup} {...rest}>
				{children}
			</BaseDialog.Popup>
		</BaseDialog.Portal>
	);
}

export function Head({
	title,
	description,
	showClose = true,
}: {
	/** The dialog heading; wired to `aria-labelledby` by base-ui. */
	title: React.ReactNode;
	/** Optional supporting line under the title; wired to `aria-describedby`. */
	description?: React.ReactNode;
	/** Render the trailing close (×) affordance. */
	showClose?: boolean;
}) {
	return (
		<header className={styles.head}>
			<div>
				{/* biome-ignore lint/a11y/useHeadingContent: heading text is supplied via children, not the render element */}
				<BaseDialog.Title className={styles.title} render={<h2 />}>
					{title}
				</BaseDialog.Title>
				{description ? (
					<BaseDialog.Description className={styles.description}>
						{description}
					</BaseDialog.Description>
				) : null}
			</div>
			{showClose ? (
				<BaseDialog.Close className={styles.close} aria-label="Kapat">
					×
				</BaseDialog.Close>
			) : null}
		</header>
	);
}

export function Body({children}: {children: React.ReactNode}) {
	// Render nothing when there's no real content: a padded body with the foot's
	// border-top would otherwise draw a hollow banded strip (e.g. a confirm dialog
	// whose body only renders on error). toArray drops null/false/undefined children.
	if (React.Children.toArray(children).length === 0) return null;
	return <div className={styles.body}>{children}</div>;
}

export function Foot({children}: {children: React.ReactNode}) {
	return <footer className={styles.foot}>{children}</footer>;
}

/**
 * @component Dialog
 * @whenToUse The modal-dialog compound (base-ui). Compose from its parts for any
 *   modal (confirm, form, detail overlay); `Head`'s `title` supplies the accessible
 *   name via `aria-labelledby`, so reach for `Head` rather than a bare heading.
 * @slot Root The open/close state provider wrapping trigger + popup.
 * @slot Trigger The element that opens the dialog.
 * @slot Popup The portalled, backdropped modal surface.
 * @slot Head The title/description/close header region.
 * @slot Body The scrollable content region (renders nothing when empty).
 * @slot Foot The action row (footer).
 * @slot Close An element that dismisses the dialog.
 */
export const Dialog = {Root, Trigger, Close, Popup, Head, Body, Foot};
