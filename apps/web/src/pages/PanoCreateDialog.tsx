import * as React from "react";
import {Button} from "../components/ui/Button";
import {Dialog} from "../components/ui/Dialog";
import {Field, FieldError, Form, Hint, Input, Label, Textarea} from "../components/ui/Form";
import {Tabs} from "../components/ui/Tabs";

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

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Popup>
				<Dialog.Head title="Yeni Pano Girdisi" description="pano'yu zenginleştir :)" />
				<Dialog.Body>
					<Tabs.Root
						variant="pill"
						value={mode}
						onValueChange={(v) => setMode(v as "link" | "text")}
					>
						<Tabs.List>
							<Tabs.Tab value="link">bağlantı</Tabs.Tab>
							<Tabs.Tab value="text">yazı</Tabs.Tab>
						</Tabs.List>
						<Tabs.Panel value="link" style={{paddingTop: "var(--s-3)"}}>
							<Form
								onSubmit={(e) => {
									e.preventDefault();
									const data = new FormData(e.currentTarget);
									onSubmit?.({
										mode: "link",
										title: String(data.get("title") ?? ""),
										url: String(data.get("url") ?? ""),
									});
									onOpenChange(false);
								}}
							>
								<Field name="title">
									<Label>Başlık</Label>
									<Input name="title" required minLength={5} />
									<FieldError match="tooShort">Başlık en az 5 karakterden oluşmalıdır</FieldError>
								</Field>
								<Field name="url">
									<Label>URL</Label>
									<Input name="url" type="url" required />
									<FieldError>URL düzgün değil</FieldError>
								</Field>
								<Dialog.Foot>
									<Dialog.Close render={<Button variant="tertiary">vazgeç</Button>} />
									<Button variant="primary" type="submit">
										gönder
									</Button>
								</Dialog.Foot>
							</Form>
						</Tabs.Panel>
						<Tabs.Panel value="text" style={{paddingTop: "var(--s-3)"}}>
							<Form
								onSubmit={(e) => {
									e.preventDefault();
									const data = new FormData(e.currentTarget);
									onSubmit?.({
										mode: "text",
										title: String(data.get("title") ?? ""),
										text: String(data.get("text") ?? ""),
									});
									onOpenChange(false);
								}}
							>
								<Field name="title">
									<Label>Başlık</Label>
									<Input name="title" required minLength={5} />
								</Field>
								<Field name="text">
									<Label>Metin</Label>
									<Textarea name="text" rows={6} />
									<Hint>markdown destekli</Hint>
								</Field>
								<Dialog.Foot>
									<Dialog.Close render={<Button variant="tertiary">vazgeç</Button>} />
									<Button variant="primary" type="submit">
										gönder
									</Button>
								</Dialog.Foot>
							</Form>
						</Tabs.Panel>
					</Tabs.Root>
				</Dialog.Body>
			</Dialog.Popup>
		</Dialog.Root>
	);
}
