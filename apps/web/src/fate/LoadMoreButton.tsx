import {Button} from "@kampus/design";
import {useState} from "react";

export function LoadMoreButton({
	loadNext,
	testId,
}: {
	loadNext: () => Promise<void>;
	testId?: string;
}) {
	const [loading, setLoading] = useState(false);
	return (
		<Button
			variant="tertiary"
			size="sm"
			type="button"
			disabled={loading}
			onClick={async () => {
				setLoading(true);
				try {
					await loadNext();
				} finally {
					setLoading(false);
				}
			}}
			data-testid={testId}
		>
			{loading ? "yükleniyor…" : "daha fazla"}
		</Button>
	);
}
