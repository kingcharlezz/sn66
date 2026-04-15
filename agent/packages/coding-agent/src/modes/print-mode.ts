/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `pi -p "prompt"` - text output
 * - `pi --mode json "prompt"` - JSON event stream
 */

import type { AssistantMessage, ImageContent } from "@mariozechner/pi-ai";
import type { AgentSessionRuntimeHost } from "../core/agent-session-runtime.js";
import { postPatchAction } from "../core/competition/index.js";
import { flushRawStdout, writeRawStdout } from "../core/output-guard.js";

const RESCUE_PROMPT = `No patch landed yet.
Make one small concrete patch now.
Localize quickly, edit the most likely file, run one cheap sanity check, and stop.`;

const MINIMIZE_PROMPT = `The current patch is wider than necessary.
Reduce it to the smallest plausible diff that still solves the task.
Preserve pre-existing user edits, drop speculative changes, revert helper/type/support-file churn, revert backup or legacy-tree edits, keep existing component structure, and favor line edits over large JSX or state rewrites. Do not minimize by dropping an explicitly named task surface entirely if a small local edit still covers it. Run one cheap check and stop.`;

const REPAIR_PROMPT = `A cheap syntax check failed on the changed files.
Repair only the syntax or parse issue without widening the patch.
Re-run the relevant cheap check and stop.`;

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(runtimeHost: AgentSessionRuntimeHost, options: PrintModeOptions): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	let exitCode = 0;
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	const queuedMessages = [...messages];

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		await session.bindExtensions({
			commandContextActions: {
				waitForIdle: () => session.agent.waitForIdle(),
				newSession: async (newSessionOptions) => {
					const result = await runtimeHost.newSession(newSessionOptions);
					if (!result.cancelled) {
						await rebindSession();
					}
					return result;
				},
				fork: async (entryId) => {
					const result = await runtimeHost.fork(entryId);
					if (!result.cancelled) {
						await rebindSession();
					}
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, navigateOptions) => {
					const result = await session.navigateTree(targetId, {
						summarize: navigateOptions?.summarize,
						customInstructions: navigateOptions?.customInstructions,
						replaceInstructions: navigateOptions?.replaceInstructions,
						label: navigateOptions?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath) => {
					const result = await runtimeHost.switchSession(sessionPath);
					if (!result.cancelled) {
						await rebindSession();
					}
					return result;
				},
				reload: async () => {
					await session.reload();
				},
			},
			onError: (err) => {
				console.error(`Extension error (${err.extensionPath}): ${err.error}`);
			},
		});

		unsubscribe?.();
		unsubscribe = session.subscribe((event) => {
			if (mode === "json") {
				writeRawStdout(`${JSON.stringify(event)}\n`);
			}
		});
	};

	try {
		if (mode === "json") {
			const header = session.sessionManager.getHeader();
			if (header) {
				writeRawStdout(`${JSON.stringify(header)}\n`);
			}
		}

		await rebindSession();

		const repoDir = session.sessionManager.getCwd();
		const taskPrompt = initialMessage ?? queuedMessages.shift() ?? (initialImages ? "" : undefined);
		if (taskPrompt !== undefined) {
			await session.prompt(taskPrompt, { images: initialImages });
		}

		let action = taskPrompt !== undefined ? await postPatchAction(repoDir) : "done";
		if (action === "rescue") {
			await session.prompt(RESCUE_PROMPT);
			action = await postPatchAction(repoDir);
		}
		if (action === "minimize") {
			await session.prompt(MINIMIZE_PROMPT);
			action = await postPatchAction(repoDir);
		}
		if (action === "repair") {
			await session.prompt(REPAIR_PROMPT);
		}

		const finalAction = taskPrompt !== undefined ? await postPatchAction(repoDir) : "done";
		const state = session.state;
		const lastMessage = state.messages[state.messages.length - 1];
		const assistantMsg = lastMessage?.role === "assistant" ? (lastMessage as AssistantMessage) : undefined;

		if (assistantMsg && (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted")) {
			exitCode = 1;
			if (mode === "text") {
				console.error(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
			}
		} else if (finalAction === "rescue") {
			exitCode = 1;
			if (mode === "text") {
				console.error("No patch landed.");
			}
		}

		if (mode === "text") {
			if (assistantMsg && exitCode === 0) {
				for (const content of assistantMsg.content) {
					if (content.type === "text") {
						writeRawStdout(`${content.text}\n`);
					}
				}
			}
		}

		return exitCode;
	} finally {
		unsubscribe?.();
		await runtimeHost.dispose();
		await flushRawStdout();
	}
}
