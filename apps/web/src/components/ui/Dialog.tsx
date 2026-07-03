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
	title: React.ReactNode;
	description?: React.ReactNode;
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
				<BaseDialog.Close className={styles.close} aria-label="kapat">
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

export const Dialog = {Root, Trigger, Close, Popup, Head, Body, Foot};
