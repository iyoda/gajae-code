import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..", "..");
const BINARY_FIRST_INSTALLER_REF = "v0.15.3";
const TAGGED_INSTALLER_URL = /https:\/\/raw\.githubusercontent\.com\/Yeachan-Heo\/gajae-code\/(v[^/]+)\/scripts\/install\.(?:sh|ps1)/g;
const STALE_INSTALLER_URL = "/v0.15.0/scripts/install.";

const coreInstallerDocs = [
	"README.md",
	"docs/install.md",
	"docs/terminal-app-integrations.md",
] as const;
const expectedLocalizedInstallerDocs = ["README.ko.md", "README.ja.md", "README.zh-CN.md"] as const;
const installerDocs = [...coreInstallerDocs, ...expectedLocalizedInstallerDocs];

describe("installer documentation contract", () => {
	test("uses the approved immutable installer release in every core and localized guide", async () => {
		for (const documentPath of installerDocs) {
			const content = await Bun.file(path.join(repoRoot, documentPath)).text();
			const taggedUrls = [...content.matchAll(TAGGED_INSTALLER_URL)];

			expect(content).not.toContain(STALE_INSTALLER_URL);
			expect(taggedUrls.length).toBeGreaterThan(0);
			for (const taggedUrl of taggedUrls) {
				expect(taggedUrl[1]).toBe(BINARY_FIRST_INSTALLER_REF);
			}
		}
	});
});
