import type * as React from "react";
import "./Footer.css";

export function Footer({children}: {children?: React.ReactNode}) {
	return (
		<footer className="kp-footer">
			{children ?? (
				<>
					<span className="brand">
						kamp<span className="dot">.</span>us
					</span>
					<span>· 2026</span>
					<span className="spacer" />
					<a href="/tuzuk">tüzük</a>
					<a href="https://github.com/kamp-us" target="_blank" rel="noreferrer">
						github
					</a>
					<a href="/rss.xml">rss</a>
				</>
			)}
		</footer>
	);
}
