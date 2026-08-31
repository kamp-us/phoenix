import {render, screen} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {ActorIdentity} from "./ActorIdentity";

describe("ActorIdentity — the shared actor row", () => {
	it("renders the resolved handle + karma with the surface's namespace", () => {
		render(
			<ActorIdentity
				authorId="a1"
				displayName="Ada Lovelace"
				username="ada"
				totalKarma={42}
				fallbackLabel="çaylak"
				identityClassName="kp-divan__identity"
				handleClassName="kp-divan__handle"
				karmaClassName="kp-divan__karma"
				karmaTestIdPrefix="divan-karma-"
			/>,
		);
		expect(screen.getByText("Ada Lovelace")).toBeTruthy();
		const karma = screen.getByTestId("divan-karma-a1");
		expect(karma.textContent).toContain("42");
	});

	it("carries the full label in a title, so a truncated handle stays readable", () => {
		const long = "Bir Hayli Uzun Bir Çaylak Görünen Adı";
		render(
			<ActorIdentity
				authorId="a3"
				displayName={long}
				username="uzun"
				totalKarma={0}
				fallbackLabel="çaylak"
				handleClassName="kp-divan__handle"
				karmaTestIdPrefix="divan-karma-"
			/>,
		);
		expect(screen.getByText(long).getAttribute("title")).toBe(long);
	});

	it("degrades to the fallback noun and hides karma when showKarma is false", () => {
		render(
			<ActorIdentity
				authorId="a2"
				displayName={null}
				username={null}
				totalKarma={0}
				fallbackLabel="çaylak"
				showKarma={false}
				karmaTestIdPrefix="divan-karma-"
			/>,
		);
		expect(screen.getByText("çaylak")).toBeTruthy();
		expect(screen.queryByTestId("divan-karma-a2")).toBeNull();
	});
});
