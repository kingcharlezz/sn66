// storm-v1
/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import {
	type AssistantMessage,
	type Context,
	EventStream,
	streamSimple,
	type ToolResultMessage,
	validateToolArguments,
} from "@mariozechner/pi-ai";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	StreamFn,
} from "./types.js";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * Parse search tool output into likely repo-relative file paths.
 */
function extractCandidatePathsFromSearchOutput(
	output: string,
	toolName: string,
	toolArgs?: Record<string, unknown>,
	max = 24,
): string[] {
	const paths: string[] = [];
	const seen = new Set<string>();
	for (const raw of output.split("\n")) {
		let line = raw.trim();
		if (!line || line.length > 280) continue;
		if (/^\[.*limit.*\]$/i.test(line)) continue;
		if (/^(find:|grep:|bash:|ls:)/i.test(line)) continue;
		if (line.startsWith("/usr/") || line.startsWith("/bin/") || line.startsWith("/etc/")) continue;
		if (/^total \d+$/i.test(line)) continue;
		line = line.replace(/^\.\//, "");
		if (toolName === "grep") {
			const match = line.match(/^(.+?)(?::|-)\d+(?::|-)/);
			if (!match?.[1]) continue;
			line = match[1];
		} else if (toolName === "ls") {
			const basePath = typeof toolArgs?.path === "string" && toolArgs.path.length > 0 ? toolArgs.path : ".";
			if (line.endsWith("/")) continue;
			line = basePath === "." ? line : `${basePath.replace(/\/$/, "")}/${line}`;
		}
		if (line.includes("node_modules") || line.includes("/.git/") || line === ".git") continue;
		const base = line.split("/").pop() ?? line;
		const knownRootFiles = /^(dockerfile|makefile|license|readme\.md|\.gitignore|\.env)$/i.test(base);
		const hasFileExt = /\.[A-Za-z0-9]{1,12}$/.test(line);
		const pathLike = /^[\w@./+,-]+$/.test(line) && line.length >= 2 && (line.includes("/") || hasFileExt || knownRootFiles);
		if (!pathLike) continue;
		if (seen.has(line)) continue;
		seen.add(line);
		paths.push(line);
		if (paths.length >= max) break;
	}
	return paths;
}

function mergeCandidatePaths(existing: string[], discovered: string[], max = 20): string[] {
	const merged: string[] = [];
	const seen = new Set<string>();
	for (const path of [...existing, ...discovered]) {
		const normalized = path.replace(/^\.\//, "");
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		merged.push(normalized);
		if (merged.length >= max) break;
	}
	return merged;
}

function hasReadPath(pathsAlreadyRead: Set<string>, targetPath: string): boolean {
	const normalized = targetPath.replace(/^\.\//, "");
	return (
		pathsAlreadyRead.has(targetPath) ||
		pathsAlreadyRead.has(normalized) ||
		pathsAlreadyRead.has(`./${normalized}`)
	);
}

function normalizeRepoPath(targetPath: string): string {
	return targetPath.replace(/^\.\//, "");
}

function findExistingSiblingVariant(targetPath: string): string | null {
	const normalized = normalizeRepoPath(targetPath);
	const absoluteTarget = path.resolve(process.cwd(), normalized);
	if (existsSync(absoluteTarget)) return null;
	const dirName = path.dirname(normalized);
	const absoluteDir = path.resolve(process.cwd(), dirName);
	if (!existsSync(absoluteDir)) return null;
	const targetBase = path.basename(normalized);
	const targetStem = targetBase.replace(/\.[^.]+$/, "").toLowerCase();
	let entries: string[];
	try {
		entries = readdirSync(absoluteDir);
	} catch {
		return null;
	}
	for (const entry of entries) {
		if (entry === targetBase) continue;
		if (entry.replace(/\.[^.]+$/, "").toLowerCase() !== targetStem) continue;
		return dirName === "." ? entry : `${dirName}/${entry}`;
	}
	return null;
}

function extractExplicitTaskFiles(messages: AgentMessage[]): Set<string> {
	const namedFiles = new Set<string>();
	for (const message of messages) {
		if (message.role !== "user") continue;
		for (const item of message.content) {
			if (typeof item === "string") continue;
			if (item.type !== "text") continue;
			for (const match of item.text.matchAll(/`([^`]{1,120})`/g)) {
				const token = match[1]?.trim();
				if (!token) continue;
				if (/(?:^|\/)[\w.-]+\.[A-Za-z0-9]{1,12}$/.test(token) || /^(README|CHANGELOG|LICENSE|Dockerfile|Makefile|Procfile|Jenkinsfile|Gemfile|\.[\w.-]+)$/.test(token)) {
					namedFiles.add(token);
					namedFiles.add(path.basename(token));
				}
			}
		}
	}
	return namedFiles;
}

function isHighRiskAuxiliaryPath(targetPath: string): boolean {
	const normalized = normalizeRepoPath(targetPath);
	const base = path.basename(normalized);
	if (["Dockerfile", "docker-compose.yml", "docker-compose.yaml", ".env", ".env.example", "package.json", "tsconfig.json", "README", "README.md"].includes(base)) {
		return true;
	}
	return normalized.endsWith(".md");
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<void> {
	let firstTurn = true;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	let upstreamRetries = 0;
	const UPSTREAM_RETRY_LIMIT = 100;

	const editFailMap = new Map<string, number>();
	const failNotified = new Set<string>();
	const EDIT_FAIL_CEILING = 2;
	const priorFailedAnchor = new Map<string, string>();

	let explorationCount = 0;
	let bashCount = 0;
	let hasProducedEdit = false;
	let emptyTurnRetries = 0;
	const EMPTY_TURN_MAX = 2;

	const loopStart = Date.now();
	let earlyNudgeSent = false;
	let urgentNudgeSent = false;
	let finalNudgeSent = false;
	const pathsAlreadyRead = new Set<string>();
	const pathReadCounts = new Map<string, number>();
	let rereadNudgeSent = false;
	let bashHeavyNudgeSent = false;
	const editedPaths = new Set<string>();
	const siblingVariantWriteWarnings = new Set<string>();
	const auxiliaryScopeWarnings = new Set<string>();
	const explicitTaskFiles = extractExplicitTaskFiles(currentContext.messages);

	let workPhase: "search" | "absorb" | "apply" = "search";
	let foundFiles: string[] = [];
	let absorbedFiles = new Set<string>();
	const EARLY_NUDGE_MS = 10_000;
	const URGENT_NUDGE_MS = 22_000;
	const LATE_NUDGE_MS = 55_000;
	const GRACEFUL_EXIT_MS = 170_000;
	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// Process pending messages (inject before next assistant response)
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// Stream assistant response
			const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFn);
			newMessages.push(message);

			if (message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			if (message.stopReason === "error") {
				if (upstreamRetries < UPSTREAM_RETRY_LIMIT) {
					upstreamRetries++;
					await emit({ type: "turn_end", message, toolResults: [] });
					pendingMessages.push({
						role: "user",
						content: [
							{
								type: "text",
								text: "Transient upstream failure occurred. Resume by calling a tool directly — avoid prose. Only file diffs count toward your evaluation score.",
							},
						],
						timestamp: Date.now(),
					});
					hasMoreToolCalls = false;
					continue;
				}
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			const toolCalls = message.content.filter((c) => c.type === "toolCall");
					// v71: fix EditEdits hallucination
					for (const tc of toolCalls) {
						if (tc.type === "toolCall" && (tc.name === "EditEdits" || tc.name === "editEdits")) {
							tc.name = "edit";
						}
					}
			hasMoreToolCalls = toolCalls.length > 0;

			if (hasMoreToolCalls) {
				const unreadEdit = toolCalls.find((tc) => {
					if (tc.type !== "toolCall" || tc.name !== "edit") return false;
					const targetPath = (tc.arguments as { path?: string } | undefined)?.path;
					return typeof targetPath === "string" && targetPath.length > 0 && !hasReadPath(pathsAlreadyRead, targetPath);
				});
				if (unreadEdit && pendingMessages.length === 0) {
					const targetPath = ((unreadEdit.arguments as { path?: string } | undefined)?.path ?? "").replace(/^\.\//, "");
					await emit({ type: "turn_end", message, toolResults: [] });
					pendingMessages.push({
						role: "user",
						content: [
							{
								type: "text",
								text: `You have not read \`${targetPath}\` in this session. Do not edit from memory. Call \`read\` on that exact file first, then retry the edit with fresh text.`,
							},
						],
						timestamp: Date.now(),
					});
					continue;
				}

				const suspiciousWrite = toolCalls.find((tc) => {
					if (tc.type !== "toolCall" || tc.name !== "write") return false;
					const targetPath = (tc.arguments as { path?: string } | undefined)?.path;
					if (typeof targetPath !== "string" || targetPath.length === 0) return false;
					if (siblingVariantWriteWarnings.has(targetPath)) return false;
					return !!findExistingSiblingVariant(targetPath);
				});
				if (suspiciousWrite && pendingMessages.length === 0) {
					const targetPath = ((suspiciousWrite.arguments as { path?: string } | undefined)?.path ?? "").replace(/^\.\//, "");
					const siblingPath = findExistingSiblingVariant(targetPath);
					if (siblingPath) {
						siblingVariantWriteWarnings.add(targetPath);
						await emit({ type: "turn_end", message, toolResults: [] });
						pendingMessages.push({
							role: "user",
							content: [
								{
									type: "text",
									text: `\`${targetPath}\` does not exist, but \`${siblingPath}\` already exists in the same directory. Do not create a sibling filename variant from memory. Read and edit \`${siblingPath}\` unless the task explicitly requires a brand new file.`,
								},
							],
							timestamp: Date.now(),
						});
						continue;
					}
				}

				const offScopeAuxiliaryEdit = toolCalls.find((tc) => {
					if (tc.type !== "toolCall" || (tc.name !== "edit" && tc.name !== "write")) return false;
					const targetPath = (tc.arguments as { path?: string } | undefined)?.path;
					if (typeof targetPath !== "string" || targetPath.length === 0) return false;
					if (auxiliaryScopeWarnings.has(targetPath)) return false;
					if (!isHighRiskAuxiliaryPath(targetPath)) return false;
					const normalized = normalizeRepoPath(targetPath);
					return !explicitTaskFiles.has(normalized) && !explicitTaskFiles.has(path.basename(normalized));
				});
				if (offScopeAuxiliaryEdit && pendingMessages.length === 0) {
					const targetPath = ((offScopeAuxiliaryEdit.arguments as { path?: string } | undefined)?.path ?? "").replace(/^\.\//, "");
					auxiliaryScopeWarnings.add(targetPath);
					await emit({ type: "turn_end", message, toolResults: [] });
					pendingMessages.push({
						role: "user",
						content: [
							{
								type: "text",
								text: `\`${targetPath}\` is an auxiliary config or documentation file that is not explicitly named in the task. Do not edit it by default. Only return to it if the task text or the code you just read makes that file clearly necessary.`,
							},
						],
						timestamp: Date.now(),
					});
					continue;
				}
			}

			if (!hasMoreToolCalls && emptyTurnRetries < EMPTY_TURN_MAX) {
				const tokenCapped = message.stopReason === "length";
				const idleStopped = message.stopReason === "stop" && !hasProducedEdit;
				if (tokenCapped || idleStopped) {
					emptyTurnRetries++;
					await emit({ type: "turn_end", message, toolResults: [] });
					pendingMessages.push({
						role: "user",
						content: [
							{
								type: "text",
								text: tokenCapped
									? "Output budget consumed without any tool invocation. Invoke \`find\`, \`grep\`, \`read\`, or \`edit\` now. Text output contributes nothing to your score."
									: "No file modifications detected. A blank diff receives zero points. Use \`find\` or \`grep\` to localize the file set, then \`read\` and \`edit\` the highest-confidence file immediately.",
							},
						],
						timestamp: Date.now(),
					});
					continue;
				}
			}

			const toolResults: ToolResultMessage[] = [];
			if (hasMoreToolCalls) {
				toolResults.push(...(await executeToolCalls(currentContext, message, config, signal, emit)));

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}

				for (let i = 0; i < toolResults.length; i++) {
					const tr = toolResults[i];
					const tc = toolCalls[i];
					if (!tc || tc.type !== "toolCall") continue;
					if (tc.name !== "edit") continue;
					const targetPath = (tc.arguments as { path?: string } | undefined)?.path;
					if (!targetPath || typeof targetPath !== "string") continue;
					if (tr.isError) {
						const count = (editFailMap.get(targetPath) ?? 0) + 1;
						editFailMap.set(targetPath, count);
						const anchorText = (tc.arguments as any)?.old_string ?? (tc.arguments as any)?.oldText ?? "";
						const prevAnchor = priorFailedAnchor.get(targetPath);
						if (anchorText && prevAnchor === anchorText && pendingMessages.length === 0) {
							pendingMessages.push({ role: "user", content: [{ type: "text", text: `Identical oldText failed twice on \`${targetPath}\`. Use \`read\` to get fresh contents before retrying.` }], timestamp: Date.now() });
						}
						priorFailedAnchor.set(targetPath, anchorText);
						if (count >= EDIT_FAIL_CEILING && !failNotified.has(targetPath)) {
							failNotified.add(targetPath);
							pendingMessages.push({
								role: "user",
								content: [
									{
										type: "text",
										text: `Edit attempts on \`${targetPath}\` have failed ${count} times. Your cached view is stale. Options:\n\n1. Switch to another file from the acceptance criteria you have not edited yet.\n2. Call \`read\` on this file to refresh, then use a compact oldText anchor (under 5 lines).\n3. Only use text you have just read — never paste from memory.`,
									},
								],
								timestamp: Date.now(),
							});
						}
					} else {
						editFailMap.set(targetPath, 0);
						priorFailedAnchor.delete(targetPath);
						hasProducedEdit = true;
						explorationCount = 0;
						editedPaths.add(targetPath);
						pendingMessages.push({
							role: "user",
							content: [
								{
									type: "text",
									text: `\`${targetPath}\` updated successfully. Does this satisfy the relevant acceptance criterion? Only continue into another file if the task explicitly names it or the file contents show the same behavior must change there.`,
								},
							],
							timestamp: Date.now(),
						});
					}
				}

				for (const tr of toolResults) {
					if (tr.toolName === "bash" && !tr.isError) {
						bashCount++;
						const output = tr.content?.map((c: any) => c.text ?? "").join("") ?? "";
						if (output.includes("ConnectionRefusedError") || output.includes("Connection refused") || output.includes("ECONNREFUSED")) {
							pendingMessages.push({ role: "user", content: [{ type: "text", text: "No services available in this environment. All network requests will fail. Proceed with \`read\` and \`edit\` only." }], timestamp: Date.now() });
							break;
						}
					}
				}

				if (workPhase === "search") {
					for (let i = 0; i < toolResults.length; i++) {
						const tr = toolResults[i];
						const tc = toolCalls[i];
						if ((tr.toolName === "bash" || tr.toolName === "find" || tr.toolName === "grep" || tr.toolName === "ls") && !tr.isError) {
							const output = tr.content?.map((c: any) => c.text ?? "").join("") ?? "";
							const toolArgs = tc && tc.type === "toolCall" ? (tc.arguments as Record<string, unknown>) : undefined;
							const paths = extractCandidatePathsFromSearchOutput(output, tr.toolName, toolArgs, 24);
							if (paths.length > 0) {
								foundFiles = mergeCandidatePaths(foundFiles, paths, 20);
								workPhase = "absorb";
								pendingMessages.push({
									role: "user",
									content: [{ type: "text", text: `Located ${foundFiles.length} candidate files. Read the highest-confidence files first before editing. Discovered files are candidates, not mandatory edits:\n${foundFiles.slice(0, 10).map((p: string) => `- ${p}`).join("\n")}` }],
									timestamp: Date.now(),
								});
							}
						}
					}
				} else if (workPhase === "absorb") {
					for (let i = 0; i < toolResults.length; i++) {
						const tr = toolResults[i];
						const tc = toolCalls[i];
						if (tr.toolName === "read" && !tr.isError && tc && tc.type === "toolCall" && tc.name === "read") {
							const path = (tc.arguments as any)?.path ?? "";
							if (path) absorbedFiles.add(path);
						}
						if (tr.toolName === "edit" && !tr.isError) {
							workPhase = "apply";
						}
					}
					const absorbLimit = Math.min(Math.max(3, foundFiles.length > 10 ? 6 : 3), 8);
					if (absorbedFiles.size >= absorbLimit && workPhase === "absorb" && pendingMessages.length === 0) {
						workPhase = "apply";
						pendingMessages.push({
							role: "user",
							content: [{ type: "text", text: `${absorbedFiles.size} files absorbed. Begin editing the highest-confidence target file now. Do not branch into loosely related files unless the task or the file contents require it.` }],
							timestamp: Date.now(),
						});
					}
				}

				for (let i = 0; i < toolResults.length; i++) {
					const tr = toolResults[i];
					const tc = toolCalls[i];
					if ((tr.toolName === "read" || tr.toolName === "find" || tr.toolName === "grep" || tr.toolName === "ls" || tr.toolName === "bash") && !tr.isError) {
						if (!hasProducedEdit) explorationCount++;
					}
					if (tr.toolName === "read" && !tr.isError && tc && tc.type === "toolCall") {
						const readPath = (tc.arguments as any)?.path;
						if (readPath && typeof readPath === "string") {
							pathsAlreadyRead.add(readPath);
							pathReadCounts.set(readPath, (pathReadCounts.get(readPath) ?? 0) + 1);
						}
					}
				}

				if (!bashHeavyNudgeSent && !hasProducedEdit && bashCount >= 3 && pendingMessages.length === 0) {
					bashHeavyNudgeSent = true;
					pendingMessages.push({
						role: "user",
						content: [
							{
								type: "text",
								text: `You have already used \`bash\` ${bashCount} times without editing. Stop shell-driven exploration. Use \`find\`, \`grep\`, \`ls\`, then \`read\` and \`edit\` to cover the task files.`,
							},
						],
						timestamp: Date.now(),
					});
				}

				if (!rereadNudgeSent && pendingMessages.length === 0) {
					for (const [rp, cnt] of pathReadCounts) {
						if (cnt >= 4) {
							rereadNudgeSent = true;
							const others = foundFiles.filter(
								(f: string) => !editedPaths.has(f) && f !== rp && !f.endsWith("/" + rp) && !rp.endsWith("/" + f)
							);
							pendingMessages.push({
								role: "user",
								content: [
									{
										type: "text",
										text: `You have read \`${rp}\` ${cnt} times. Stop re-reading it. ${others.length > 0 ? `Move to a different file you have not edited yet: ${others.slice(0, 4).map((f: string) => `\`${f}\``).join(", ")}.` : "Apply \`edit\` now or move on."}`,
									},
								],
								timestamp: Date.now(),
							});
							break;
						}
					}
				}

				const dynamicExploreCeiling = Math.max(3, Math.min(foundFiles.length + 1, 8));
				if (!hasProducedEdit && explorationCount >= dynamicExploreCeiling && pendingMessages.length === 0) {
					pendingMessages.push({
						role: "user",
						content: [
							{
								type: "text",
								text: `Context gathered (${explorationCount} search/read steps). Apply your first edit to the highest-priority target file now. Coverage beats an empty diff.`,
							},
						],
						timestamp: Date.now(),
					});
					explorationCount = 0;
				}

				if (!hasProducedEdit && pendingMessages.length === 0) {
					const elapsed = Date.now() - loopStart;
					const readList = pathsAlreadyRead.size > 0
						? `Previously read: ${[...pathsAlreadyRead].slice(0, 5).join(", ")}. `
						: "";
					if (!earlyNudgeSent && elapsed >= EARLY_NUDGE_MS) {
						earlyNudgeSent = true;
						pendingMessages.push({
							role: "user",
							content: [
								{
									type: "text",
									text: `${Math.round(elapsed/1000)}s elapsed without any edits. An empty diff scores zero. ${readList}Apply \`edit\` to the most relevant file now. Even one correct change contributes to your score.`,
								},
							],
							timestamp: Date.now(),
						});
					} else if (earlyNudgeSent && elapsed >= URGENT_NUDGE_MS && !urgentNudgeSent) {
						urgentNudgeSent = true;
						pendingMessages.push({
							role: "user",
							content: [
								{
									type: "text",
									text: `${Math.round(elapsed/1000)}s in with zero file modifications. Time may be running out. ${readList}Make an edit immediately or accept a zero score.`,
								},
							],
							timestamp: Date.now(),
						});
					}
				}

				if ((Date.now() - loopStart) >= GRACEFUL_EXIT_MS) {
					await emit({ type: "turn_end", message, toolResults });
					await emit({ type: "agent_end", messages: newMessages });
					return;
				}

				if (
					!hasProducedEdit &&
					!finalNudgeSent &&
					(Date.now() - loopStart) >= LATE_NUDGE_MS &&
					pendingMessages.length === 0
				) {
					finalNudgeSent = true;
					pendingMessages.push({
						role: "user",
						content: [
							{
								type: "text",
								text: "Over 50s without edits. Pick the clearest file from the task or keyword list and apply \`edit\` now — further discovery has diminishing returns.",
							},
						],
						timestamp: Date.now(),
					});
				}
			}

			await emit({ type: "turn_end", message, toolResults });

			pendingMessages = (await config.getSteeringMessages?.()) || [];
		}

			const followUpMessages = (await config.getFollowUpMessages?.()) || [];
			if (followUpMessages.length > 0) {
				pendingMessages = followUpMessages;
				continue;
			}

			// No more messages, exit
			break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	// Apply context transform if configured (AgentMessage[] → AgentMessage[])
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
	const llmMessages = await config.convertToLlm(messages);

	// Build LLM context
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};

	const streamFunction = streamFn || streamSimple;

	// Resolve API key (important for expiring tokens)
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		signal,
	});

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			case "done":
			case "error": {
				const finalMessage = await response.result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	const finalMessage = await response.result();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ToolResultMessage[]> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	if (config.toolExecution === "sequential") {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ToolResultMessage[]> {
	const results: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			results.push(await emitToolCallOutcome(toolCall, preparation.result, preparation.isError, emit));
		} else {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			results.push(
				await finalizeExecutedToolCall(
					currentContext,
					assistantMessage,
					preparation,
					executed,
					config,
					signal,
					emit,
				),
			);
		}
	}

	return results;
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ToolResultMessage[]> {
	const results: ToolResultMessage[] = [];
	const runnableCalls: PreparedToolCall[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			results.push(await emitToolCallOutcome(toolCall, preparation.result, preparation.isError, emit));
		} else {
			runnableCalls.push(preparation);
		}
	}

	const runningCalls = runnableCalls.map((prepared) => ({
		prepared,
		execution: executePreparedToolCall(prepared, signal, emit),
	}));

	for (const running of runningCalls) {
		const executed = await running.execution;
		results.push(
			await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				running.prepared,
				executed,
				config,
				signal,
				emit,
			),
		);
	}

	return results;
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
};

function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall);
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			if (beforeResult?.block) {
				return {
					kind: "immediate",
					result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
					isError: true,
				};
			}
		}
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
	const updateEvents: Promise<void>[] = [];

	try {
		const result = await prepared.tool.execute(
			prepared.toolCall.id,
			prepared.args as never,
			signal,
			(partialResult) => {
				updateEvents.push(
					Promise.resolve(
						emit({
							type: "tool_execution_update",
							toolCallId: prepared.toolCall.id,
							toolName: prepared.toolCall.name,
							args: prepared.toolCall.arguments,
							partialResult,
						}),
					),
				);
			},
		);
		await Promise.all(updateEvents);
		return { result, isError: false };
	} catch (error) {
		await Promise.all(updateEvents);
		return {
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ToolResultMessage> {
	let result = executed.result;
	let isError = executed.isError;

	if (config.afterToolCall) {
		const afterResult = await config.afterToolCall(
			{
				assistantMessage,
				toolCall: prepared.toolCall,
				args: prepared.args,
				result,
				isError,
				context: currentContext,
			},
			signal,
		);
		if (afterResult) {
			result = {
				content: afterResult.content ?? result.content,
				details: afterResult.details ?? result.details,
			};
			isError = afterResult.isError ?? isError;
		}
	}

	return await emitToolCallOutcome(prepared.toolCall, result, isError, emit);
}

function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function emitToolCallOutcome(
	toolCall: AgentToolCall,
	result: AgentToolResult<any>,
	isError: boolean,
	emit: AgentEventSink,
): Promise<ToolResultMessage> {
	await emit({
		type: "tool_execution_end",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		result,
		isError,
	});

	const toolResultMessage: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: result.content,
		details: result.details,
		isError,
		timestamp: Date.now(),
	};

	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
	return toolResultMessage;
}
