import { isHyperlinkEnabled } from "../../tui/hyperlink";

export interface OAuthUrlCopyLeaseHost {
	beginOAuthUrlForCopy(url: string): () => void;
}

export interface OAuthUrlCopyLease {
	replace(url: string): void;
	release(): void;
}

export function buildOAuthLoginAnchor(url: string, label: string = url, hyperlinks = isHyperlinkEnabled()): string {
	return hyperlinks ? `\x1b]8;;${url}\x07${label}\x1b]8;;\x07` : label;
}

export function createOAuthUrlCopyLease(host: OAuthUrlCopyLeaseHost): OAuthUrlCopyLease {
	let releaseCurrent: (() => void) | undefined;
	let released = false;

	return {
		replace(url: string): void {
			if (released) return;
			releaseCurrent?.();
			releaseCurrent = host.beginOAuthUrlForCopy(url);
		},
		release(): void {
			if (released) return;
			released = true;
			releaseCurrent?.();
			releaseCurrent = undefined;
		},
	};
}
