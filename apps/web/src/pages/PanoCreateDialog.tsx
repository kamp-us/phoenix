import * as React from "react";
import {Button} from "../components/ui/Button";
import {Dialog} from "../components/ui/Dialog";
import {Form, Input, Textarea} from "../components/ui/Form";
import {Tabs} from "../components/ui/Tabs";
import {useT} from "../i18n";
import {prefillIfEmpty, useLinkMetadata} from "../lib/useLinkMetadata";

const TITLE_MIN = 5;

export function PanoCreateDialog({
	open,
	onOpenChange,
	onSubmit,
}: {
	open: boolean;
	onOpenChange: (v: boolean) => void;
	onSubmit?: (data: {mode: "link" | "text"; title: string; url?: string; text?: string}) => void;
}) {
	const t = useT();
	const [mode, setMode] = React.useState<"link" | "text">("link");
	const {fetchMetadata} = useLinkMetadata();

	async function prefillFromUrl(e: React.FocusEvent<HTMLInputElement>) {
		const form = e.currentTarget.form;
		const url = e.currentTarget.value;
		if (!form) return;
		const meta = await fetchMetadata(url);
		const titleInput = form.elements.namedItem("title");
		if (titleInput instanceof HTMLInputElement) {
			prefillIfEmpty(titleInput.value, meta.title, (v) => {
				titleInput.value = v;
			});
		}
	}

	return (
		<Dialog
			open={open}
			onOpenChange={onOpenChange}
			title={t("pano.createDialog.title")}
			description={t("pano.createDialog.description")}
		>
			<Tabs
				variant="pill"
				value={mode}
				onValueChange={(value) => setMode(value as "link" | "text")}
				items={[
					{
						value: "link",
						label: t("pano.mode.link"),
						content: (
							<Form
								onSubmit={(event) => {
									event.preventDefault();
									const data = new FormData(event.currentTarget);
									onSubmit?.({
										mode: "link",
										title: String(data.get("title") ?? ""),
										url: String(data.get("url") ?? ""),
									});
									onOpenChange(false);
								}}
							>
								<Input
									name="title"
									label={t("pano.createDialog.titleLabel")}
									required
									minLength={TITLE_MIN}
									fullWidth
									hint={t("pano.createDialog.titleHint", {min: TITLE_MIN})}
								/>
								<Input
									name="url"
									label={t("pano.field.url")}
									type="url"
									required
									fullWidth
									onBlur={prefillFromUrl}
								/>
								<div className="kp-dialog-actions">
									<Button variant="tertiary" type="button" onClick={() => onOpenChange(false)}>
										{t("pano.action.cancel")}
									</Button>
									<Button variant="primary" type="submit">
										{t("pano.action.submit")}
									</Button>
								</div>
							</Form>
						),
					},
					{
						value: "text",
						label: t("pano.mode.text"),
						content: (
							<Form
								onSubmit={(event) => {
									event.preventDefault();
									const data = new FormData(event.currentTarget);
									onSubmit?.({
										mode: "text",
										title: String(data.get("title") ?? ""),
										text: String(data.get("text") ?? ""),
									});
									onOpenChange(false);
								}}
							>
								<Input
									name="title"
									label={t("pano.createDialog.titleLabel")}
									required
									minLength={TITLE_MIN}
									fullWidth
								/>
								<Textarea
									name="text"
									label={t("pano.createDialog.textLabel")}
									rows={6}
									hint={t("pano.createDialog.textHint")}
									fullWidth
								/>
								<div className="kp-dialog-actions">
									<Button variant="tertiary" type="button" onClick={() => onOpenChange(false)}>
										{t("pano.action.cancel")}
									</Button>
									<Button variant="primary" type="submit">
										{t("pano.action.submit")}
									</Button>
								</div>
							</Form>
						),
					},
				]}
			/>
		</Dialog>
	);
}
