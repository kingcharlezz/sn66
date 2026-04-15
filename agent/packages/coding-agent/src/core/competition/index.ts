import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import * as Diff from "diff";
import { execCommand } from "../exec.js";

type PostPatchDecision = "done" | "rescue" | "minimize" | "repair";

interface CompetitionSummary {
	text: string;
	highConfidence: boolean;
	broadPatchExpected: boolean;
	likelyFiles: string[];
	focusTokens: string[];
	explicitPaths: string[];
	coverageFiles: string[];
}

interface FileSnapshot {
	exists: boolean;
	content: string;
	status: string;
}

interface RepoBaseline {
	gitAvailable: boolean;
	broadPatchExpected: boolean;
	dirtyFiles: Map<string, FileSnapshot>;
	focusTokens: string[];
	likelyFiles: string[];
	explicitPaths: string[];
}

interface DeltaFile {
	path: string;
	baseline?: FileSnapshot;
	current?: FileSnapshot;
}

interface PatchScopeAnalysis {
	addedOrDeletedCount: number;
	backupOrGeneratedCount: number;
	irrelevantFileCount: number;
	supportFileChurnCount: number;
}

const repoBaselines = new Map<string, RepoBaseline>();

const STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"by",
	"do",
	"for",
	"from",
	"hard",
	"if",
	"in",
	"into",
	"is",
	"it",
	"its",
	"make",
	"mode",
	"new",
	"no",
	"not",
	"of",
	"on",
	"or",
	"our",
	"out",
	"path",
	"repo",
	"run",
	"same",
	"section",
	"seconds",
	"should",
	"specific",
	"specifically",
	"that",
	"the",
	"then",
	"this",
	"to",
	"updated",
	"use",
	"user",
	"users",
	"with",
	"within",
	"your",
	"active",
	"application",
	"allowing",
	"browser",
	"clicking",
	"correctly",
	"directly",
	"displays",
	"display",
	"each",
	"every",
	"experience",
	"feature",
	"features",
	"improve",
	"internal",
	"items",
	"more",
	"open",
	"other",
	"player",
	"tab",
	"dialog",
	"using",
	"view",
	"when",
	"will",
]);

const BACKUP_OR_GENERATED_PATH = /(^|\/)(backup[^/]*|legacy|dist|build|coverage|vendor|node_modules|generated|tmp|temp|out)(\/|$)/i;
const SUPPORT_PATH = /(^|\/)(lib|utils?|types?|services?|hooks)(\/|$)/i;
const UI_SURFACE_PATH = /(^|\/)(components?|views?|pages?|screens?)(\/|$)/i;
const UI_SURFACE_NAME = /(view|dialog|modal|panel|sheet|bar|card|feed|profile|notification|trending|preview)/i;
const UI_PRIMITIVE_PATH = /\/components\/ui\//i;
const SUPPORT_HINT = /\b(api|backend|client|database|hook|lib|service|schema|store|type|types|util|utils)\b/i;
const DECLARATION_PATH = /\.d\.ts$/i;
const SQL_PATH = /\.sql$/i;

export async function buildCompetitionSummary(
	taskPrompt: string,
	repoDir: string = process.cwd(),
): Promise<CompetitionSummary> {
	const broadPatchExpected = promptImpliesBroadPatch(taskPrompt);
	const repoFiles = await listRepoFiles(repoDir);
	const explicitPaths = resolveExplicitPaths(taskPrompt, repoFiles);
	const focusTokens = extractSearchTokens(taskPrompt);
	const likelyFiles = explicitPaths.length > 0 ? explicitPaths : findLikelyFiles(repoFiles, taskPrompt, focusTokens);
	const coverageFiles = selectCoverageFiles(likelyFiles, focusTokens);
	const highConfidence = explicitPaths.length > 0 || (!broadPatchExpected && likelyFiles.length === 1);

	const summary: CompetitionSummary = {
		text: [
			`Patch scope: ${broadPatchExpected ? "broad allowed only if required by task" : "default to narrow patch"}`,
			`Localization confidence: ${highConfidence ? "high" : "low"}`,
			`Likely files: ${likelyFiles.length > 0 ? likelyFiles.join(", ") : "none surfaced; localize with grep/find/ls"}`,
		].join("\n"),
		highConfidence,
		broadPatchExpected,
		likelyFiles,
		focusTokens,
		explicitPaths,
		coverageFiles,
	};

	repoBaselines.set(repoDir, await captureBaseline(repoDir, summary));
	return summary;
}

export function buildCompetitionPrompt(taskPrompt: string, summary: CompetitionSummary): string {
	const likelyFilesLine =
		summary.likelyFiles.length > 0
			? `- start with these likely files: ${summary.likelyFiles.join(", ")}`
			: `- start with grep/find/ls to localize the smallest viable edit`;
	const coverageLine =
		summary.coverageFiles.length > 1
			? `- required surface pass before stopping: inspect and cover these named surfaces with the smallest local edit that satisfies the task: ${summary.coverageFiles.join(", ")}`
			: "";

	return `Primary objective:
Produce the smallest plausible patch most likely to match the baseline coding agent.

Rules:
- prefer the smallest correct diff
- patch existing files in place before considering any new file
- do not refactor, rename, or reformat unrelated code
- in an existing file, prefer surgical line edits over rewriting imports, state, JSX layout, or data flow
- do not create or delete helper libraries, typings, or alternate implementations unless an edited file proves they are required
- do not touch backup, legacy, dist, build, vendor, or generated trees unless the task names them
- inspect likely files first
- prefer existing nearby patterns and copy the closest implementation instead of rebuilding it
- if the task explicitly names multiple surfaces, keep one small targeted edit per required surface instead of stopping after a subset
- do not widen the patch once a plausible fix exists
- after one plausible patch and one cheap sanity check, stop

Search/edit order:
1. use grep / find / ls to localize
2. read the most likely files and only the closest existing helper if blocked
3. form one patch plan internally
4. edit literals, handlers, and small JSX fragments in place across the named surfaces
5. widen to one additional file only if a direct blocker appears
6. run one cheap validation pass
7. stop

Prescan summary:
${summary.text}
${summary.likelyFiles.length > 0 ? `- stay within these files unless a direct blocker proves another file is required: ${summary.likelyFiles.join(", ")}` : likelyFilesLine}
${coverageLine}

Task:
${taskPrompt}`;
}

export function chooseCompetitionThinking(summary: CompetitionSummary): ThinkingLevel {
	return summary.highConfidence ? "off" : "low";
}

export async function postPatchAction(repoDir: string): Promise<PostPatchDecision> {
	const baseline =
		repoBaselines.get(repoDir) ??
		(await captureBaseline(repoDir, {
			text: "",
			highConfidence: false,
			broadPatchExpected: false,
			likelyFiles: [],
			focusTokens: [],
			explicitPaths: [],
			coverageFiles: [],
		}));
	repoBaselines.set(repoDir, baseline);

	if (!baseline.gitAvailable) {
		return "done";
	}

	const deltaFiles = await collectDeltaFiles(repoDir, baseline);
	if (deltaFiles.length === 0) {
		return "rescue";
	}

	const changedLines = await countChangedLines(repoDir, deltaFiles);
	const scope = analyzePatchScope(deltaFiles, baseline);
	const wideDiff = deltaFiles.length > 3 || changedLines > 80;
	const runawayDiff = deltaFiles.length > 6 || changedLines > 240;
	if (
		runawayDiff ||
		(!baseline.broadPatchExpected && wideDiff) ||
		scope.backupOrGeneratedCount > 0 ||
		scope.addedOrDeletedCount > 1 ||
		scope.supportFileChurnCount > 0 ||
		scope.irrelevantFileCount >= 3
	) {
		return "minimize";
	}

	return (await hasSyntaxBreak(repoDir, deltaFiles)) ? "repair" : "done";
}

function promptImpliesBroadPatch(taskPrompt: string): boolean {
	const acceptanceCriteriaCount = taskPrompt.match(/^\s*-\s+/gm)?.length ?? 0;
	return (
		/\b(refactor|rename|migrate|sweep|across|every|all files|entire|global|whole repo|whole codebase|multiple files|additionally|furthermore|finally)\b/i.test(
			taskPrompt,
		) || acceptanceCriteriaCount >= 6
	);
}

function extractExplicitPaths(taskPrompt: string): string[] {
	return [...new Set(taskPrompt.match(/(?:[\w.-]+\/)+[\w./-]+|[\w.-]+\.(?:ts|tsx|js|mjs|cjs|py|json|sh|md|yaml|yml)/g) ?? [])];
}

function resolveExplicitPaths(taskPrompt: string, repoFiles: string[]): string[] {
	const normalizedRepoFiles = new Map(repoFiles.map((path) => [path.toLowerCase(), path]));
	const resolved: string[] = [];

	for (const rawMatch of extractExplicitPaths(taskPrompt)) {
		const candidate = rawMatch.replace(/^\.?\//, "").trim();
		if (!candidate || !/\.[a-z0-9]+$/i.test(candidate)) {
			continue;
		}

		const exact = normalizedRepoFiles.get(candidate.toLowerCase());
		if (exact) {
			resolved.push(exact);
			continue;
		}

		const suffixMatches = repoFiles.filter((path) => {
			const lowerPath = path.toLowerCase();
			const lowerCandidate = candidate.toLowerCase();
			return lowerPath === lowerCandidate || lowerPath.endsWith(`/${lowerCandidate}`);
		});
		if (suffixMatches.length === 1) {
			resolved.push(suffixMatches[0]);
		}
	}

	return [...new Set(resolved)].slice(0, 8);
}

function extractSearchTokens(taskPrompt: string): string[] {
	const explicitSegments = extractExplicitPaths(taskPrompt).flatMap((path) =>
		path
			.split(/[/.\\_-]+/)
			.map((part) => part.trim().toLowerCase())
			.filter(Boolean),
	);
	const words = taskPrompt
		.toLowerCase()
		.split(/[^a-z0-9_/-]+/)
		.map((part) => part.replace(/^[._/-]+|[._/-]+$/g, "").trim())
		.filter((part) => part.length >= 3);

	const counts = new Map<string, number>();
	for (const token of [...explicitSegments, ...words].filter((part) => !STOPWORDS.has(part))) {
		counts.set(token, (counts.get(token) ?? 0) + 1);
	}

	return [...counts.entries()]
		.sort((left, right) => right[1] - left[1] || right[0].length - left[0].length || left[0].localeCompare(right[0]))
		.map(([token]) => token)
		.slice(0, 36);
}

function findLikelyFiles(repoFiles: string[], taskPrompt: string, tokens: string[]): string[] {
	if (tokens.length === 0) {
		return [];
	}

	const scored = repoFiles
		.map((path) => ({ path, score: scorePath(path, tokens, taskPrompt) }))
		.filter((entry) => entry.score > 0)
		.sort((left, right) => right.score - left.score || left.path.length - right.path.length)
		.slice(0, 8)
		.map((entry) => entry.path);

	return [...new Set(scored)];
}

function selectCoverageFiles(likelyFiles: string[], tokens: string[]): string[] {
	const coverage: string[] = [];
	const addMatch = (predicate: (path: string) => boolean): void => {
		const match = likelyFiles.find((path) => predicate(path) && !coverage.includes(path));
		if (match) {
			coverage.push(match);
		}
	};

	if (tokens.some((token) => token.includes("feed"))) {
		addMatch((path) => /feed/i.test(path));
	}
	if (tokens.some((token) => token.includes("trending") || token.includes("mood") || token.includes("playlist"))) {
		addMatch((path) => /trending/i.test(path));
	}
	if (tokens.some((token) => token.includes("notification") || token.includes("unread") || token.includes("badge"))) {
		addMatch((path) => /notifications/i.test(path));
	}
	if (tokens.some((token) => token.includes("profile") || token.includes("followers") || token.includes("following") || token.includes("preview"))) {
		addMatch((path) => /profileview/i.test(path) || /profile\/?view/i.test(path));
	}
	if (tokens.some((token) => token.includes("actor_id") || token.includes("from_user_id") || token.includes("metadata") || token.includes("track_id"))) {
		addMatch((path) => /database\.(ts|js)$/i.test(path));
	}

	for (const path of likelyFiles) {
		if (coverage.length >= 5) {
			break;
		}
		if (!coverage.includes(path) && !/profilepreviewdialog|editprofiledialog|supabase\.(ts|js)$/i.test(path)) {
			coverage.push(path);
		}
	}

	return coverage.slice(0, 5);
}

async function listRepoFiles(repoDir: string): Promise<string[]> {
	const gitFiles = await execCommand("git", ["ls-files"], repoDir, { timeout: 2_000 });
	if (gitFiles.code === 0) {
		return gitFiles.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
	}

	const foundFiles = await execCommand("find", [".", "-maxdepth", "5", "-type", "f"], repoDir, { timeout: 2_000 });
	if (foundFiles.code !== 0) {
		return [];
	}

	return foundFiles.stdout
		.split("\n")
		.map((line) => line.replace(/^\.\//, "").trim())
		.filter(Boolean);
}

function scorePath(path: string, tokens: string[], taskPrompt: string): number {
	const lowerPath = path.toLowerCase();
	const base = basename(lowerPath);
	const baseNoExt = base.replace(/\.[^.]+$/, "");
	const baseSegments = splitIdentifier(basename(path).replace(/\.[^.]+$/, ""));
	let score = 0;

	for (const token of tokens) {
		const strongMatchScore = token.length >= 5 ? 10 : 5;
		const partialMatchScore = token.length >= 5 ? 6 : 2;
		const pathMatchScore = token.length >= 5 ? 3 : 1;

		if (base === token || baseNoExt === token || baseSegments.includes(token)) {
			score += strongMatchScore;
			continue;
		}
		if (base.includes(token) || baseSegments.some((segment) => segment.length >= 4 && segment.includes(token))) {
			score += partialMatchScore;
			continue;
		}
		if (lowerPath.includes(token)) {
			score += pathMatchScore;
		}
	}

	for (const ext of taskPrompt.match(/\.(ts|tsx|js|mjs|cjs|py|json|sh)\b/g) ?? []) {
		if (lowerPath.endsWith(ext.toLowerCase())) {
			score += 2;
		}
	}

	if (/(test|spec)/i.test(taskPrompt) && /(test|spec)/.test(lowerPath)) {
		score += 2;
	}

	if (UI_SURFACE_PATH.test(lowerPath)) {
		score += 4;
	}
	if (UI_SURFACE_NAME.test(baseNoExt)) {
		score += 4;
	}
	if (UI_PRIMITIVE_PATH.test(lowerPath)) {
		score -= 8;
	}
	if (/\/src\/app\//.test(lowerPath)) {
		score += 2;
	}
	if (SUPPORT_PATH.test(lowerPath) && !SUPPORT_HINT.test(taskPrompt)) {
		score -= 6;
	}
	if (/\b[a-z]+_[a-z0-9_]+\b/.test(taskPrompt) && /(^|\/)(database|supabase)\.(ts|js)$/i.test(lowerPath)) {
		score += 18;
	}
	if (DECLARATION_PATH.test(lowerPath)) {
		score -= 12;
	}
	if (SQL_PATH.test(lowerPath) && !/\b(sql|migration|schema|table|column|supabase|query)\b/i.test(taskPrompt)) {
		score -= 10;
	}
	if (BACKUP_OR_GENERATED_PATH.test(lowerPath)) {
		score -= 14;
	}

	return Math.max(score, 0);
}

function splitIdentifier(value: string): string[] {
	return value
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((segment) => segment.length >= 3);
}

async function captureBaseline(repoDir: string, summary: CompetitionSummary): Promise<RepoBaseline> {
	const dirtyStatuses = await getDirtyFileStatuses(repoDir);
	if (!dirtyStatuses) {
		return {
			gitAvailable: false,
			broadPatchExpected: summary.broadPatchExpected,
			dirtyFiles: new Map(),
			focusTokens: summary.focusTokens,
			likelyFiles: summary.likelyFiles,
			explicitPaths: summary.explicitPaths,
		};
	}

	const dirtyFiles = new Map<string, FileSnapshot>();
	for (const [path, status] of dirtyStatuses) {
		dirtyFiles.set(path, {
			status,
			...(await readWorkingTreeFile(repoDir, path)),
		});
	}

	return {
		gitAvailable: true,
		broadPatchExpected: summary.broadPatchExpected,
		dirtyFiles,
		focusTokens: summary.focusTokens,
		likelyFiles: summary.likelyFiles,
		explicitPaths: summary.explicitPaths,
	};
}

async function getDirtyFileStatuses(repoDir: string): Promise<Map<string, string> | undefined> {
	const status = await execCommand("git", ["status", "--porcelain=v1", "--untracked-files=all"], repoDir, {
		timeout: 2_000,
	});
	if (status.code !== 0) {
		return undefined;
	}

	const files = new Map<string, string>();
	for (const line of status.stdout.split("\n")) {
		if (!line) continue;
		const rawPath = line.slice(3).trim();
		const path = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) ?? rawPath : rawPath;
		files.set(path, line.slice(0, 2));
	}

	return files;
}

async function readWorkingTreeFile(repoDir: string, relativePath: string): Promise<{ exists: boolean; content: string }> {
	const fullPath = join(repoDir, relativePath);
	if (!existsSync(fullPath)) {
		return { exists: false, content: "" };
	}

	try {
		return { exists: true, content: await readFile(fullPath, "utf8") };
	} catch {
		return { exists: true, content: "" };
	}
}

async function collectDeltaFiles(repoDir: string, baseline: RepoBaseline): Promise<DeltaFile[]> {
	const currentStatuses = await getDirtyFileStatuses(repoDir);
	if (!currentStatuses) {
		return [];
	}

	const currentFiles = new Map<string, FileSnapshot>();
	for (const [path, status] of currentStatuses) {
		currentFiles.set(path, {
			status,
			...(await readWorkingTreeFile(repoDir, path)),
		});
	}

	const deltaFiles = new Map<string, DeltaFile>();
	for (const [path, current] of currentFiles) {
		const start = baseline.dirtyFiles.get(path);
		if (!start || start.exists !== current.exists || start.content !== current.content || start.status !== current.status) {
			deltaFiles.set(path, { path, baseline: start, current });
		}
	}

	for (const [path, start] of baseline.dirtyFiles) {
		if (!currentFiles.has(path)) {
			deltaFiles.set(path, { path, baseline: start, current: { exists: false, content: "", status: "" } });
		}
	}

	return [...deltaFiles.values()];
}

function analyzePatchScope(deltaFiles: DeltaFile[], baseline: RepoBaseline): PatchScopeAnalysis {
	const analysis: PatchScopeAnalysis = {
		addedOrDeletedCount: 0,
		backupOrGeneratedCount: 0,
		irrelevantFileCount: 0,
		supportFileChurnCount: 0,
	};

	for (const file of deltaFiles) {
		const addedOrDeleted = file.baseline?.exists !== file.current?.exists;
		if (addedOrDeleted) {
			analysis.addedOrDeletedCount += 1;
			if (SUPPORT_PATH.test(file.path) && !isExplicitPath(file.path, baseline.explicitPaths)) {
				analysis.supportFileChurnCount += 1;
			}
		}

		if (BACKUP_OR_GENERATED_PATH.test(file.path) && !isExplicitPath(file.path, baseline.explicitPaths)) {
			analysis.backupOrGeneratedCount += 1;
		}

		if (!isPromptRelevantPath(file.path, baseline)) {
			analysis.irrelevantFileCount += 1;
		}
	}

	return analysis;
}

function isExplicitPath(path: string, explicitPaths: string[]): boolean {
	const lowerPath = path.toLowerCase();
	return explicitPaths.some((candidate) => candidate.toLowerCase() === lowerPath);
}

function isPromptRelevantPath(path: string, baseline: RepoBaseline): boolean {
	const lowerPath = path.toLowerCase();
	if (baseline.likelyFiles.some((candidate) => candidate.toLowerCase() === lowerPath)) {
		return true;
	}

	const segments = lowerPath.split(/[^a-z0-9]+/).filter(Boolean);
	return baseline.focusTokens.some((token) =>
		segments.some((segment) => segment === token || segment.includes(token) || (token.length >= 5 && token.includes(segment))),
	);
}

async function countChangedLines(repoDir: string, deltaFiles: DeltaFile[]): Promise<number> {
	let changedLines = 0;

	for (const file of deltaFiles) {
		if (file.baseline) {
			changedLines += diffLineCount(file.baseline.content, file.current?.content ?? "");
			continue;
		}

		const status = file.current?.status ?? "";
		if (status.startsWith("??") || !(await existsInHead(repoDir, file.path))) {
			changedLines += diffLineCount("", file.current?.content ?? "");
			continue;
		}

		const numstat = await execCommand("git", ["diff", "--numstat", "--", file.path], repoDir, { timeout: 2_000 });
		const parsed = parseNumstat(numstat.stdout);
		if (parsed !== undefined) {
			changedLines += parsed;
			continue;
		}

		const headContent = await readHeadFile(repoDir, file.path);
		changedLines += diffLineCount(headContent, file.current?.content ?? "");
	}

	return changedLines;
}

function parseNumstat(stdout: string): number | undefined {
	const line = stdout.split("\n").find((entry) => entry.trim().length > 0);
	if (!line) {
		return 0;
	}

	const [added, removed] = line.split("\t");
	const addedCount = Number.parseInt(added, 10);
	const removedCount = Number.parseInt(removed, 10);

	if (Number.isNaN(addedCount) || Number.isNaN(removedCount)) {
		return undefined;
	}

	return addedCount + removedCount;
}

function diffLineCount(before: string, after: string): number {
	return Diff.diffLines(before, after).reduce((total, part) => {
		if (!part.added && !part.removed) {
			return total;
		}
		return total + (part.count ?? countLines(part.value));
	}, 0);
}

function countLines(value: string): number {
	if (value.length === 0) {
		return 0;
	}
	return value.split("\n").length - (value.endsWith("\n") ? 1 : 0);
}

async function existsInHead(repoDir: string, relativePath: string): Promise<boolean> {
	const result = await execCommand("git", ["cat-file", "-e", `HEAD:${relativePath.replace(/\\/g, "/")}`], repoDir, {
		timeout: 2_000,
	});
	return result.code === 0;
}

async function readHeadFile(repoDir: string, relativePath: string): Promise<string> {
	const result = await execCommand("git", ["show", `HEAD:${relativePath.replace(/\\/g, "/")}`], repoDir, {
		timeout: 2_000,
	});
	return result.code === 0 ? result.stdout : "";
}

async function hasSyntaxBreak(repoDir: string, deltaFiles: DeltaFile[]): Promise<boolean> {
	for (const file of deltaFiles) {
		if (!file.current?.exists) {
			continue;
		}

		const fullPath = join(repoDir, file.path);
		const extension = extname(file.path).toLowerCase();
		let command: string | undefined;
		let args: string[] = [];

		switch (extension) {
			case ".py":
				command = "python3";
				args = ["-m", "py_compile", fullPath];
				break;
			case ".js":
			case ".mjs":
			case ".cjs":
				command = "node";
				args = ["--check", fullPath];
				break;
			case ".json":
				command = "python3";
				args = ["-m", "json.tool", fullPath];
				break;
			case ".sh":
				command = "bash";
				args = ["-n", fullPath];
				break;
		}

		if (!command) {
			continue;
		}

		const result = await execCommand(command, args, repoDir, { timeout: 5_000 });
		if (result.code !== 0) {
			return true;
		}
	}

	return false;
}
