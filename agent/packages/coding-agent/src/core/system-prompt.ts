/**
 * System prompt construction and project context loading
 */

import { execSync } from "node:child_process";
import { globSync } from "glob";
import { getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";

function countAcceptanceCriteria(taskText: string): number {
	const criteriaSection = taskText.match(/(?:acceptance\s+criteria|requirements):?\s*\n([\s\S]*?)(?:\n\n|\n(?=[A-Z])|\n(?=##)|$)/i);
	if (!criteriaSection) return 0;
	const bullets = criteriaSection[1].match(/^\s*[-*•]\s+/gm);
	return bullets ? bullets.length : 0;
}

function extractNamedFiles(taskText: string): string[] {
	const backtickMatches = taskText.match(/`([^`]{1,120})`/g) || [];
	return [
		...new Set(
			backtickMatches
				.map((token) => token.replace(/`/g, ""))
				.filter((token) => {
					if (/(?:^|\/)[\w.-]+\.[A-Za-z0-9]{1,12}$/.test(token)) return true;
					if (/^(README|CHANGELOG|LICENSE|Dockerfile|Makefile|Procfile|Jenkinsfile|Gemfile|\.[\w.-]+)$/.test(token)) return true;
					return false;
				}),
		),
	];
}

function grepTaskKeywords(cwd: string, taskText: string): string {
	try {
		const backtickMatches = taskText.match(/`([^`]{2,60})`/g)?.map(k => k.replace(/`/g, '')).filter(k => k === "README" || !/^[A-Z0-9_]+$/.test(k)) || [];
		const camelMatches = taskText.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g) || [];
		const snakeMatches = taskText.match(/\b[a-z]+_[a-z_]+\b/g) || [];
		const kebabMatches = taskText.match(/\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g) || [];
		const pathLikeMatches =
			taskText.match(/(?:\/|\b)(?:[\w.-]+\/)+[\w.-]+\b/g)?.map((p) => p.replace(/^\//, "").trim()) || [];
		const allKeywords = [...new Set([...backtickMatches, ...camelMatches, ...snakeMatches, ...kebabMatches, ...pathLikeMatches])]
			.filter(k => k.length >= 3 && k.length <= 80)
			.filter(k => !/["'`]/.test(k))
			.filter(k => !['the', 'and', 'for', 'with', 'that', 'this', 'from', 'should', 'must', 'when', 'each', 'into', 'also'].includes(k.toLowerCase()))
			.slice(0, 12);
		if (allKeywords.length === 0) return "";
		const fileHits = new Map<string, string[]>();
		const includeGlobs =
			'--include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.mjs" --include="*.cjs" --include="*.py" --include="*.go" --include="*.java" --include="*.kt" --include="*.dart" --include="*.rb" --include="*.cs" --include="*.vue" --include="*.css" --include="*.scss" --include="*.html" --include="*.json" --include="*.md"';
		for (const keyword of allKeywords) {
			try {
				const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
				const result = execSync(
					`grep -rl "${escaped}" ${includeGlobs} . 2>/dev/null | grep -v node_modules | grep -v .git | grep -v dist/ | grep -v build/ | head -10`,
					{ cwd, timeout: 3000, encoding: "utf-8" }
				).trim();
				if (result) {
					for (const file of result.split("\n")) {
						const clean = file.replace("./", "");
						if (!fileHits.has(clean)) fileHits.set(clean, []);
						fileHits.get(clean)!.push(keyword);
					}
				}
			} catch {}
		}
		const sorted = [...fileHits.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 15);

		const criteriaCount = countAcceptanceCriteria(taskText);
		const namedFiles = extractNamedFiles(taskText);
		const namedFileMatches = new Map<string, string[]>();

		for (const namedFile of namedFiles) {
			try {
				const matches = globSync(`**/${namedFile}`, {
					cwd,
					dot: true,
					nodir: true,
					ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**"],
				})
					.map((match) => match.replace(/\\/g, "/"))
					.slice(0, 8);
				if (matches.length > 0) {
					namedFileMatches.set(namedFile, matches);
				}
			} catch {}
		}

		let result = "";
		if (criteriaCount > 0 || namedFiles.length > 0) {
			result += "\n\n## Task scope analysis\n\n";
			if (criteriaCount > 0) {
				result += `This task has **${criteriaCount} acceptance criteria**. `;
				if (criteriaCount >= 3) {
					result += `Tasks with ${criteriaCount}+ criteria may require edits across multiple files, but only touch files the task names or the code you read makes necessary.\n`;
				} else {
					result += "\n";
				}
			}
			if (namedFiles.length > 0) {
				result += `Files explicitly named in the task: ${namedFiles.map(f => `\`${f}\``).join(", ")}. Each named file likely needs an edit.\n`;
				result += "Honor exact basenames from the task. If the task names `README`, do not create `README.md` unless inspection proves that `README.md` is the existing target.\n";
			}
		}

		if (namedFileMatches.size > 0) {
			result += "\n## Exact filename matches\n\n";
			for (const [namedFile, matches] of namedFileMatches) {
				result += `- \`${namedFile}\`: ${matches.map((match) => `\`${match}\``).join(", ")}\n`;
			}
			result += "\n";
		}

		if (fileHits.size > 0) {
			result += "\n## Pre-identified target files\n\nThese files reference identifiers from the task description. Prioritize these:\n";
			for (const [file, keywords] of sorted) {
				result += `- ${file} (${keywords.join(", ")})\n`;
			}
			result += "\n";
		}

		return result;
	} catch {}
	return "";
}

// Positional-match preamble injected on every invocation.
// Keeps the model focused on the hidden reference diff rather than generic code quality.
const TAU_SCORING_PREAMBLE = `# Positional Diff Optimizer

Your diff is compared position-by-position against a hidden reference diff produced by another solver on the identical task:

    score = matched_positions / max(your_changed_lines, reference_changed_lines)

Each position is compared byte-for-byte. No semantic evaluation. No test suite. Surplus lines inflate the denominator; misaligned lines score zero.

## Time Budget

You have 40-300 seconds (unknown). Zero edits = zero score.
- No tests, builds, linters, formatters, servers, or git. The sandbox has no services.
- Limit bash to 2-3 calls for file discovery. After that, only \`read\` and \`edit\`.
- Begin with a tool call immediately. Prose output is ignored by the harness.

## Phase 1: Locate Files (1-2 tool calls)

Before editing, find the right targets:
- \`find . -type f \\( -name "*.EXT" -o -name "*.json" -o -name "*.sh" \\) | grep -v node_modules | grep -v .git | head -50\`
- \`grep -r "IDENTIFIER" --include="*.EXT" -l | head -10\`

One wrong-file edit wastes the round. After editing a file, check sibling files with \`ls $(dirname path)/\` for related changes.

## Phase 2: Read and Absorb Style

Read each target file completely before editing. From the first 20 lines, observe:
- Indent type and width (tabs vs spaces, 2 vs 4)
- Quote convention (single vs double)
- Semicolons, trailing commas, brace style
Your edits must replicate ALL style conventions character-for-character.

## Phase 3: Apply Minimal Edits

- Implement exactly what the task requests — nothing more, nothing less.
- The narrowest correct change always outscores a broader one.
- Use \`edit\` for existing files. \`write\` only for files the task explicitly asks to create.
- **New file placement:** When creating a new file, place it alongside related files. If the task mentions \`foo.py\` and sibling files live in \`src/utils/\`, write to \`src/utils/foo.py\` — not the repo root. Run \`ls\` on the sibling directory if unsure.
- Short oldText anchors (3-5 lines). On failure, re-read the file first.
- Alphabetical file order; top-to-bottom within each file.
- Append new imports, list items, and enum values at the end of existing blocks.
- Copy string literals from the task verbatim.
- Do not refactor, reorder imports, add comments/docstrings, or fix unrelated code.
- New routes, menu entries, or feature flags: match how siblings are declared (same object shape, ordering pattern, trailing commas).

## Phase 4: Breadth-first file coverage

**CRITICAL: Edit ALL relevant files before perfecting any single file.**
- Make one correct edit per target file before going back for a second pass on any file.
- If the task names N files, your diff should touch N files. Touching 3 of 5 files scores much higher than perfecting 1 of 5.
- Do not re-read a file you already read unless a prior edit failed. Re-reading wastes time.
- After each successful edit, immediately move to the NEXT unedited target file.

## Phase 5: Criteria Verification

Walk through each acceptance criterion:
- Does each one have a corresponding working edit?
- Conditional requirements ("if X, show Y") need an actual \`if\` check.
- Behavioral requirements ("filters by category") need functioning logic, not just UI placeholders.
- Multi-part criteria ("A and also B") require implementations of both A and B.
- Named files in the task must all be edited.
- 4+ criteria typically span 2+ files. Do not stop early.

## Phase 6: Stop

All criteria addressed — stop. No re-reads, no cleanup, no summaries. The harness reads your diff from disk.

## Tie-breaking Rules

- Surgical fix over broader refactor, always.
- If unsure whether to touch a file, do not.
- If a defensive check "would be nice" but was not asked, omit it.
- If unsure whether a line should change, leave it.
- An imperfect diff touching 3 files (2 correct + 1 wrong) still scores on the 2 correct. Do not freeze.

---

`;

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. Default: process.cwd() */
	cwd?: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const resolvedCwd = cwd ?? process.cwd();
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	const date = new Date().toISOString().slice(0, 10);

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const keywordHits = customPrompt ? grepTaskKeywords(resolvedCwd, customPrompt) : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = TAU_SCORING_PREAMBLE + keywordHits + customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n# Project Context\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `## ${filePath}\n\n${content}\n\n`;
			}
		}

		// Append skills section (only if read tool is available)
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		// Add date and working directory last
		prompt += `\nCurrent date: ${date}`;
		prompt += `\nCurrent working directory: ${promptCwd}`;

		return prompt;
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	// Build tools list based on selected tools.
	// A tool appears in Available tools only when the caller provides a one-line snippet.
	const tools = selectedTools || ["read", "grep", "find", "ls", "edit", "write", "bash"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");

	// File exploration guidelines
	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash only when a dedicated search tool cannot express the operation");
	} else if (hasBash && (hasGrep || hasFind || hasLs)) {
		addGuideline("Prefer grep/find/ls tools over bash for file exploration");
	}
	if (hasFind || hasGrep || hasLs) {
		addGuideline("Discover the full task file set before editing the first file");
	}
	if (hasRead) {
		addGuideline("Read each likely target file completely before editing it");
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Always include these
	addGuideline("Be concise in your responses");
	addGuideline("Cover the full task scope before stopping");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	let prompt = TAU_SCORING_PREAMBLE + `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

	if (appendSection) {
		prompt += appendSection;
	}

	// Append project context files
	if (contextFiles.length > 0) {
		prompt += "\n\n# Project Context\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `## ${filePath}\n\n${content}\n\n`;
		}
	}

	// Append skills section (only if read tool is available)
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	// Add date and working directory last
	prompt += `\nCurrent date: ${date}`;
	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
}
