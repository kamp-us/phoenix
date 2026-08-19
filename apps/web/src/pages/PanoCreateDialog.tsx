import * as React from "react";
import {Button} from "../components/ui/Button";
import {Dialog} from "../components/ui/Dialog";
import {Form, Input, Textarea} from "../components/ui/Form";
import {Tabs} from "../components/ui/Tabs";
import {prefillIfEmpty, useLinkMetadata} from "../lib/useLinkMetadata";

export function PanoCreateDialog({
	open,
	onOpenChange,
	onSubmit,
}: {
	open: boolean;
	onOpenChange: (v: boolean) => void;
	onSubmit?: (data: {mode: "link" | "text"; title: string; url?: string; text?: string}) => void;
}) {
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
			title="Yeni Pano Girdisi"
			description="pano'yu zenginleştir :)"
		>
			<Tabs
				variant="pill"
				value={mode}
				onValueChange={(value) => setMode(value as "link" | "text")}
				items={[
					{
						value: "link",
						label: "bağlantı",
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
									label="Başlık"
									required
									minLength={5}
									fullWidth
									hint="En az 5 karakter"
								/>
								<Input
									name="url"
									label="URL"
									type="url"
									required
									fullWidth
									onBlur={prefillFromUrl}
								/>
								<div className="kp-dialog-actions">
									<Button variant="tertiary" type="button" onClick={() => onOpenChange(false)}>
										vazgeç
									</Button>
									<Button variant="primary" type="submit">
										gönder
									</Button>
								</div>
							</Form>
						),
					},
					{
						value: "text",
						label: "yazı",
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
								<Input name="title" label="Başlık" required minLength={5} fullWidth />
								<Textarea name="text" label="Metin" rows={6} hint="markdown destekli" fullWidth />
								<div className="kp-dialog-actions">
									<Button variant="tertiary" type="button" onClick={() => onOpenChange(false)}>
										vazgeç
									</Button>
									<Button variant="primary" type="submit">
										gönder
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
