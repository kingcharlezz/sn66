import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";

const mocks = vi.hoisted(() => ({
	state: {
		hookSessionDir: undefined as string | undefined,
		capturedSessionDir: undefined as string | undefined,
		capturedTools: undefined as string[] | undefined,
		capturedThinking: undefined as string | undefined,
		competitionHighConfidence: true,
	},
	createAgentSession: vi.fn(async (options: any) => {
		mocks.state.capturedSessionDir = options.sessionManager?.getSessionDir();
		mocks.state.capturedTools = options.tools?.map((tool: { name: string }) => tool.name);
		mocks.state.capturedThinking = options.thinkingLevel;
		return {
			session: {
				model: { id: "test-model", provider: "test", reasoning: true },
				thinkingLevel: options.thinkingLevel ?? "off",
				setThinkingLevel: vi.fn(),
			},
			modelFallbackMessage: undefined,
		};
	}),
	runPrintMode: vi.fn(async () => 0),
	selectSession: vi.fn(),
}));

vi.mock("../src/core/sdk.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		createAgentSession: mocks.createAgentSession,
	};
});

vi.mock("../src/modes/index.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		runPrintMode: mocks.runPrintMode,
	};
});

vi.mock("../src/cli/session-picker.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		selectSession: mocks.selectSession,
	};
});

vi.mock("../src/core/resource-loader.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		DefaultResourceLoader: class {
			async reload(): Promise<void> {}

			getExtensions() {
				const handlers = new Map();
				if (mocks.state.hookSessionDir) {
					handlers.set("session_directory", [async () => ({ sessionDir: mocks.state.hookSessionDir })]);
				}
				return {
					extensions: [{ path: "/mock-extension.ts", handlers, flags: new Map() }],
					errors: [],
					runtime: {
						pendingProviderRegistrations: [],
						flagValues: new Map(),
					},
				};
			}
		},
	};
});

vi.mock("../src/core/competition/index.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		buildCompetitionSummary: vi.fn(async () => ({
			text: "mock summary",
			highConfidence: mocks.state.competitionHighConfidence,
			broadPatchExpected: false,
			likelyFiles: ["agent/packages/coding-agent/src/main.ts"],
			focusTokens: ["main", "prompt"],
			explicitPaths: [],
			coverageFiles: ["agent/packages/coding-agent/src/main.ts"],
		})),
		buildCompetitionPrompt: vi.fn((message: string) => `wrapped::${message}`),
		chooseCompetitionThinking: vi.fn((summary: { highConfidence: boolean }) =>
			summary.highConfidence ? "off" : "low",
		),
	};
});

describe("sessionDir precedence", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let originalCwd: string;
	let originalAgentDir: string | undefined;
	let originalExitCode: typeof process.exitCode;
	let originalIsTTY: boolean | undefined;

	beforeEach(() => {
		vi.resetModules();
		mocks.state.hookSessionDir = "./hook-sessions";
		mocks.state.capturedSessionDir = undefined;
		mocks.state.capturedTools = undefined;
		mocks.state.capturedThinking = undefined;
		mocks.state.competitionHighConfidence = true;
		mocks.createAgentSession.mockClear();
		mocks.runPrintMode.mockClear();
		mocks.selectSession.mockReset();

		tempDir = join(tmpdir(), `pi-session-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".pi"), { recursive: true });

		originalCwd = process.cwd();
		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalExitCode = process.exitCode;
		originalIsTTY = process.stdin.isTTY;
		process.exitCode = undefined;
		process.env[ENV_AGENT_DIR] = agentDir;
		process.chdir(projectDir);
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	});

	afterEach(() => {
		process.chdir(originalCwd);
		process.exitCode = originalExitCode;
		Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("prefers settings sessionDir over the session_directory hook for new sessions", async () => {
		writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ sessionDir: "./settings-sessions" }));

		const { main } = await import("../src/main.js");
		await main(["--print", "test prompt"]);

		expect(mocks.state.capturedSessionDir).toBe("./settings-sessions");
		expect(mocks.runPrintMode).toHaveBeenCalledOnce();
	});

	it("prefers CLI --session-dir over settings and the session_directory hook", async () => {
		writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ sessionDir: "./settings-sessions" }));

		const { main } = await import("../src/main.js");
		await main(["--print", "--session-dir", "./cli-sessions", "test prompt"]);

		expect(mocks.state.capturedSessionDir).toBe("./cli-sessions");
		expect(mocks.runPrintMode).toHaveBeenCalledOnce();
	});

	it("uses settings sessionDir ahead of the session_directory hook for --resume", async () => {
		writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ sessionDir: "./settings-sessions" }));

		const { SessionManager } = await import("../src/core/session-manager.js");
		const listSpy = vi.spyOn(SessionManager, "list");
		mocks.selectSession.mockImplementation(async (listCurrent: (onProgress: () => void) => Promise<unknown>) => {
			await listCurrent(() => {});
			return join(projectDir, "picked-session.jsonl");
		});

		const { main } = await import("../src/main.js");
		await main(["--print", "--resume"]);

		expect(listSpy).toHaveBeenCalledWith(expect.any(String), "./settings-sessions", expect.any(Function));
		expect(mocks.state.capturedSessionDir).toBe("./settings-sessions");
		expect(mocks.runPrintMode).toHaveBeenCalledOnce();
	});

	it("hardwires the competition toolset, rewrites the prompt, and uses low thinking when prescan is uncertain", async () => {
		mocks.state.competitionHighConfidence = false;

		const { main } = await import("../src/main.js");
		await main(["--print", "--no-tools", "test prompt"]);

		expect(mocks.state.capturedTools).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);
		expect(mocks.state.capturedThinking).toBe("low");
		expect(mocks.runPrintMode).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ initialMessage: "wrapped::test prompt" }),
		);
	});

	it("uses off thinking when prescan confidence is high", async () => {
		mocks.state.competitionHighConfidence = true;

		const { main } = await import("../src/main.js");
		await main(["--print", "test prompt"]);

		expect(mocks.state.capturedThinking).toBe("off");
	});
});
