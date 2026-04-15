import type { AssistantMessage, ImageContent } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
const competitionMocks = vi.hoisted(() => ({
	postPatchAction: vi.fn(async () => "done" as const),
}));

vi.mock("../src/core/competition/index.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		postPatchAction: competitionMocks.postPatchAction,
	};
});

import { runPrintMode } from "../src/modes/print-mode.js";

type EmitEvent = { type: string };

type FakeExtensionRunner = {
	hasHandlers: (eventType: string) => boolean;
	emit: ReturnType<typeof vi.fn<(event: EmitEvent) => Promise<void>>>;
};

type FakeSession = {
	sessionManager: { getHeader: () => object | undefined; getCwd: () => string };
	agent: { waitForIdle: () => Promise<void> };
	state: { messages: AssistantMessage[] };
	extensionRunner: FakeExtensionRunner;
	bindExtensions: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	reload: ReturnType<typeof vi.fn>;
};

type FakeRuntimeHost = {
	session: FakeSession;
	newSession: ReturnType<typeof vi.fn>;
	fork: ReturnType<typeof vi.fn>;
	switchSession: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
};

function createAssistantMessage(options?: {
	text?: string;
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
}): AssistantMessage {
	return {
		role: "assistant",
		content: options?.text ? [{ type: "text", text: options.text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options?.stopReason ?? "stop",
		errorMessage: options?.errorMessage,
		timestamp: Date.now(),
	};
}

function createRuntimeHost(assistantMessage: AssistantMessage): FakeRuntimeHost {
	const extensionRunner: FakeExtensionRunner = {
		hasHandlers: (eventType: string) => eventType === "session_shutdown",
		emit: vi.fn(async () => {}),
	};

	const state = { messages: [assistantMessage] };

	const session: FakeSession = {
		sessionManager: {
			getHeader: () => undefined,
			getCwd: () => "/tmp/repo",
		},
		agent: { waitForIdle: async () => {} },
		state,
		extensionRunner,
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
		prompt: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
	};

	return {
		session,
		newSession: vi.fn(async () => undefined),
		fork: vi.fn(async () => ({ selectedText: "" })),
		switchSession: vi.fn(async () => undefined),
		dispose: vi.fn(async () => {
			await session.extensionRunner.emit({ type: "session_shutdown" });
		}),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	competitionMocks.postPatchAction.mockReset();
	competitionMocks.postPatchAction.mockResolvedValue("done");
});

describe("runPrintMode", () => {
	it("emits session_shutdown in text mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc" }];

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "Say done",
			initialImages: images,
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("Say done", { images });
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown" });
	});

	it("emits session_shutdown in json mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["hello"],
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("hello", { images: undefined });
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown" });
	});

	it("returns non-zero in json mode on assistant error", async () => {
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "provider failure" }),
		);

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			initialMessage: "Fix it",
		});

		expect(exitCode).toBe(1);
	});

	it("emits session_shutdown and returns non-zero on assistant error", async () => {
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "provider failure" }),
		);
		const { session } = runtimeHost;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("provider failure");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown" });
	});

	it("runs the rescue, minimize, and repair follow-up loop once", async () => {
		competitionMocks.postPatchAction
			.mockResolvedValueOnce("rescue")
			.mockResolvedValueOnce("minimize")
			.mockResolvedValueOnce("repair");

		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			initialMessage: "Fix the bug",
		});

		expect(exitCode).toBe(0);
		expect(session.prompt.mock.calls.map(([message]) => message)).toEqual([
			"Fix the bug",
			`No patch landed yet.
Make one small concrete patch now.
Localize quickly, edit the most likely file, run one cheap sanity check, and stop.`,
			`The current patch is wider than necessary.
Reduce it to the smallest plausible diff that still solves the task.
Preserve pre-existing user edits, drop speculative changes, revert helper/type/support-file churn, revert backup or legacy-tree edits, keep existing component structure, and favor line edits over large JSX or state rewrites. Do not minimize by dropping an explicitly named task surface entirely if a small local edit still covers it. Run one cheap check and stop.`,
			`A cheap syntax check failed on the changed files.
Repair only the syntax or parse issue without widening the patch.
Re-run the relevant cheap check and stop.`,
		]);
	});

	it("returns non-zero when no patch lands after the rescue loop", async () => {
		competitionMocks.postPatchAction.mockResolvedValue("rescue");

		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			initialMessage: "Fix the bug",
		});

		expect(exitCode).toBe(1);
	});
});
