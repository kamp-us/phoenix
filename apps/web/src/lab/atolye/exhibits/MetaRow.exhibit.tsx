import {MetaRow} from "@kampus/design";
import {defineExhibit} from "../exhibit";

function MetaRowDemo() {
	return (
		<MetaRow>
			<span className="author">ada</span>
			<MetaRow.Dot />
			<span>2 saat önce</span>
			<MetaRow.Dot />
			<span>4 yorum</span>
		</MetaRow>
	);
}

export const metaRowExhibit = defineExhibit<Record<string, never>>({
	id: "meta-row",
	title: "MetaRow",
	summary: "The shared dot-separated row for faint metadata like author · time · count.",
	component: MetaRowDemo,
	knobs: {},
});
