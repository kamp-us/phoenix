import {Form, Input, Textarea} from "@kampus/design";
import type * as React from "react";
import {defineExhibit} from "../exhibit";

function FormDemo({mono}: {mono?: boolean}) {
	return (
		<Form style={{maxWidth: "22rem"}}>
			<Input
				name="baslik"
				label="Başlık"
				hint="Listelerde görünen ad."
				placeholder="Bir başlık girin"
				fullWidth
			/>
			<Textarea
				name="icerik"
				label="İçerik"
				rows={4}
				className={mono ? "kp-textarea--mono" : undefined}
				placeholder="Metni buraya yazın…"
				fullWidth
			/>
		</Form>
	);
}

export const formExhibit = defineExhibit<React.ComponentProps<typeof FormDemo>>({
	id: "form",
	title: "Form",
	summary: "Manti Input ve Textarea'nın kendi label, hint ve error alanları.",
	component: FormDemo,
	knobs: {
		mono: {kind: "boolean", label: "Monospace field", default: false},
	},
});
