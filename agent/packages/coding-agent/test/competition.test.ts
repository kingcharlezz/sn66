import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { buildCompetitionSummary, postPatchAction } from "../src/core/competition/index.js";

describe("buildCompetitionSummary", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not treat prose like Followers/Following as an explicit file path", async () => {
		const repoDir = mkdtempSync(join(tmpdir(), "competition-summary-"));
		tempDirs.push(repoDir);
		mkdirSync(join(repoDir, "src/app/components"), { recursive: true });
		writeFileSync(join(repoDir, "src/app/components/ProfileView.tsx"), "export const ProfileView = () => null;\n");
		writeFileSync(
			join(repoDir, "src/app/components/NotificationsView.tsx"),
			"export const NotificationsView = () => null;\n",
		);
		writeFileSync(join(repoDir, "src/app/components/TrendingBar.tsx"), "export const TrendingBar = () => null;\n");

		const summary = await buildCompetitionSummary(
			`Enhance User Engagement with Spotify Embeds, Mood Playlists, and Profile Previews

Followers and Following list items in the Profile view should open a quick profile preview.
The Trending section should replace the YouTube tab with a Moods tab.
Notifications should poll every 30 seconds and show unread counts.`,
			repoDir,
		);

		expect(summary.highConfidence).toBe(false);
		expect(summary.likelyFiles).not.toContain("Followers/Following");
		expect(summary.likelyFiles.every((path: string) => path.includes(".tsx"))).toBe(true);
		expect(summary.likelyFiles.length).toBeGreaterThan(0);
	});

	it("resolves explicit filenames to real repo paths", async () => {
		const repoDir = mkdtempSync(join(tmpdir(), "competition-summary-"));
		tempDirs.push(repoDir);
		mkdirSync(join(repoDir, "src/app/components"), { recursive: true });
		writeFileSync(join(repoDir, "src/app/components/ProfileView.tsx"), "export const ProfileView = () => null;\n");

		const summary = await buildCompetitionSummary("Update ProfileView.tsx to open a preview dialog.", repoDir);

		expect(summary.highConfidence).toBe(true);
		expect(summary.likelyFiles).toEqual(["src/app/components/ProfileView.tsx"]);
	});

	it("prefers UI surface files over helper and backup files during prescan", async () => {
		const repoDir = mkdtempSync(join(tmpdir(), "competition-summary-"));
		tempDirs.push(repoDir);
		mkdirSync(join(repoDir, "src/app/components"), { recursive: true });
		mkdirSync(join(repoDir, "src/app/utils"), { recursive: true });
		mkdirSync(join(repoDir, "src/lib"), { recursive: true });
		mkdirSync(join(repoDir, "backup-v1-before-react/scripts"), { recursive: true });
		writeFileSync(join(repoDir, "src/app/components/FeedView.tsx"), "export const FeedView = () => null;\n");
		writeFileSync(
			join(repoDir, "src/app/components/NotificationsView.tsx"),
			"export const NotificationsView = () => null;\n",
		);
		writeFileSync(join(repoDir, "src/app/components/ProfileView.tsx"), "export const ProfileView = () => null;\n");
		writeFileSync(join(repoDir, "src/app/components/TrendingBar.tsx"), "export const TrendingBar = () => null;\n");
		writeFileSync(join(repoDir, "src/app/utils/spotify.ts"), "export const searchSpotify = async () => [];\n");
		writeFileSync(join(repoDir, "src/lib/spotify.ts"), "export const spotify = {};\n");
		writeFileSync(join(repoDir, "backup-v1-before-react/scripts/app.js"), "export const legacy = true;\n");

		const summary = await buildCompetitionSummary(
			`Enhance User Engagement with Spotify Embeds, Mood Playlists, and Profile Previews

The feed should toggle Spotify embeds, trending should add moods, profile lists should open previews, and notifications should show unread counts.`,
			repoDir,
		);

		expect(summary.likelyFiles.slice(0, 4)).toEqual(
			expect.arrayContaining([
				"src/app/components/FeedView.tsx",
				"src/app/components/NotificationsView.tsx",
				"src/app/components/ProfileView.tsx",
				"src/app/components/TrendingBar.tsx",
			]),
		);
		expect(summary.likelyFiles.slice(0, 4)).not.toContain("src/app/utils/spotify.ts");
		expect(summary.likelyFiles.slice(0, 4)).not.toContain("src/lib/spotify.ts");
		expect(summary.likelyFiles).not.toContain("backup-v1-before-react/scripts/app.js");
	});

	it("forces minimize when a broad task patch adds speculative support files", async () => {
		const repoDir = mkdtempSync(join(tmpdir(), "competition-summary-"));
		tempDirs.push(repoDir);
		mkdirSync(join(repoDir, "src/app/components"), { recursive: true });
		mkdirSync(join(repoDir, "src/lib"), { recursive: true });
		writeFileSync(join(repoDir, "src/app/components/TrendingBar.tsx"), "export const TrendingBar = () => null;\n");

		execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir, stdio: "ignore" });
		execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "ignore" });
		execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" });

		await buildCompetitionSummary(
			`Enhance User Engagement with Spotify Embeds, Mood Playlists, and Profile Previews

The trending section should add moods and expandable embeds.`,
			repoDir,
		);

		writeFileSync(
			join(repoDir, "src/app/components/TrendingBar.tsx"),
			"export const TrendingBar = () => 'updated';\n",
		);
		writeFileSync(join(repoDir, "src/lib/spotify.ts"), "export const spotify = { helper: true };\n");

		await expect(postPatchAction(repoDir)).resolves.toBe("minimize");
	});
});
