import {MetaRow} from "../../../components/ui/MetaRow";
import {defineExhibit} from "../exhibit";

// A composed row (author · time · count) so the shared child treatment and the
// `MetaRow.Dot` separator are shown together; MetaRow's own props are all layout
// (`as`) or ReactNode children, so there are no knobs — the row is fixed content.
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
	title: "Üstveri Satırı",
	summary: "Yazar · zaman · sayı gibi soluk üstverinin nokta ayraçlı ortak satırı.",
	component: MetaRowDemo,
	knobs: {},
});
