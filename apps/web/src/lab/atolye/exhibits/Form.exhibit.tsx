import type * as React from "react";
import {Field, Form, Hint, Input, Label, Textarea} from "../../../components/ui/Form";
import {defineExhibit} from "../exhibit";

function FormDemo({mono}: {mono?: boolean}) {
	return (
		<Form style={{maxWidth: "22rem"}}>
			<Field name="baslik">
				<Label>Başlık</Label>
				<Input placeholder="Bir başlık girin" />
				<Hint>Listelerde görünen ad.</Hint>
			</Field>
			<Field name="icerik">
				<Label>İçerik</Label>
				<Textarea rows={4} mono={mono} placeholder="Metni buraya yazın…" />
			</Field>
		</Form>
	);
}

export const formExhibit = defineExhibit<React.ComponentProps<typeof FormDemo>>({
	id: "form",
	title: "Form",
	summary: "Etiket, ipucu ve hata slotlu alanlar — base-ui Field/Input/Textarea üstünde.",
	component: FormDemo,
	knobs: {
		mono: {kind: "boolean", label: "Tek aralıklı alan", default: false},
	},
});
