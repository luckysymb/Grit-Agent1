/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

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

/** Map Gemini / IDE-shaped tool names to registered Cursor/tau names before lookup. */
const NORMALIZED_TOOL_NAME_ALIASES: Record<string, string> = {
	EditEdits: "edit_file",
	editEdits: "edit_file",
	edit: "edit_file",
	Edit: "edit_file",
	editFile: "edit_file",
	EditFile: "edit_file",
	readFile: "read_file",
	ReadFile: "read_file",
	listDir: "list_dir",
	ListDir: "list_dir",
	list_directory: "list_dir",
	grep: "grep_search",
	Grep: "grep_search",
	grepSearch: "grep_search",
	GrepSearch: "grep_search",
	fileSearch: "file_search",
	FileSearch: "file_search",
	codebaseSearch: "codebase_search",
	CodebaseSearch: "codebase_search",
	searchReplace: "search_replace",
	SearchReplace: "search_replace",
	runTerminalCmd: "run_terminal_cmd",
	RunTerminalCmd: "run_terminal_cmd",
	run_terminal_command: "run_terminal_cmd",
	deleteFile: "delete_file",
	DeleteFile: "delete_file",
	writeFile: "edit_file",
	WriteFile: "edit_file",
	strReplace: "search_replace",
	StrReplace: "search_replace",
	str_replace: "search_replace",
	replace_in_file: "search_replace",
	ReplaceInFile: "search_replace",
	readFileContents: "read_file",
	get_file_contents: "read_file",
	terminal_command: "run_terminal_cmd",
	TerminalCommand: "run_terminal_cmd",
};

/** One-line hint so streamed logs do not inflate duplicate [R] counts. */
function augmentToolFailureMessage(toolName: string, message: string): string {
	const m = message.toLowerCase();
	let hint = "";
	if (m.includes("validation failed")) {
		hint = "Use flat JSON with exact schema keys; non-empty required strings.";
	} else if (m.includes("tool ") && m.includes("not found")) {
		hint = `Valid tools: read_file, search_replace, edit_file, grep_search, codebase_search, file_search, list_dir, run_terminal_cmd, delete_file, edit_notebook. Got "${toolName}".`;
	} else if (m.includes("old_string") && (m.includes("times") || m.includes("unique"))) {
		hint =
			"search_replace: narrow old_string to a unique span (once), or set replace_all: true / replace_first_match_only: true.";
	} else if (m.includes("old_string") && m.includes("not found")) {
		hint =
			"read_file file_path; copy old_string verbatim from output. If only quotes/whitespace differ, allow_fuzzy_match: true once.";
	} else if (m.includes("not found in file")) {
		hint = "Re-read_file; copy old_string from output without line-number columns.";
	} else if (m.includes("refusing full-file overwrite") || (toolName === "edit_file" && m.includes("edit_file:"))) {
		hint = "Use search_replace or edit_file with // ... existing code ... anchors.";
	} else if (m.includes("identical") || m.includes("must differ")) {
		hint = "new_string must differ from old_string.";
	} else if (m.includes("aborted")) {
		hint = "Retry if the task is not finished.";
	} else {
		hint = "Fix args per message; copy file text verbatim.";
	}
	return `${message}\n[R] ${hint}`;
}

function normalizeGeminiToolName(name: string): string {
	let n = name.trim();
	const prefixed = n.match(/^(?:functions?|tools?)[./](.+)$/i);
	if (prefixed?.[1]) {
		n = prefixed[1].trim();
	}
	return NORMALIZED_TOOL_NAME_ALIASES[n] ?? n;
}

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

/** `read` (pi) and `read_file` (tau) both load a file into context. */
function isReadLikeTool(name: string): boolean {
	return name === "read" || name === "read_file";
}

/** `bash` (pi) and `run_terminal_cmd` (Cursor/tau). */
function isShellLikeTool(name: string): boolean {
	return name === "bash" || name === "run_terminal_cmd";
}

/** Tools that may shell out to fd/rg — offline/minimal images can fail and need bash fallback. */
function isRipgrepBackedSearchTool(name: string): boolean {
	return name === "grep_search" || name === "file_search" || name === "codebase_search" || name === "grep" || name === "find";
}

function toolResultErrorText(tr: ToolResultMessage): string {
	return tr.content?.map((c) => (c as { text?: string }).text ?? "").join("") ?? "";
}

function toolCallRecordArgs(tc: AgentToolCall): Record<string, unknown> {
	const a = tc.arguments;
	return a && typeof a === "object" && !Array.isArray(a) ? (a as Record<string, unknown>) : {};
}

/** Tools that only explore the repo — still need a follow-up mutation (`search_replace`, `edit_file`, etc.) to score. */
function isDiscoveryTool(name: string): boolean {
	return (
		isReadLikeTool(name) ||
		isShellLikeTool(name) ||
		name === "ls" ||
		name === "list_dir" ||
		name === "grep" ||
		name === "grep_search" ||
		name === "find" ||
		name === "file_search" ||
		name === "codebase_search" ||
		name === "reapply"
	);
}

function readPathFromToolCall(tc: AgentToolCall): string {
	const a = tc.arguments as Record<string, unknown> | undefined;
	if (!a) return "";
	const p =
		a.target_file ??
		a.path ??
		a.file_path ??
		a.relative_workspace_path ??
		a.directory ??
		a.dir;
	return typeof p === "string" ? p : "";
}

/** Pi legacy `edit` plus Cursor/tau tools from `coding-agent` `allTools`. */
function isMutationEditTool(name: string): boolean {
	return (
		name === "edit" ||
		name === "edit_file" ||
		name === "search_replace" ||
		name === "write" ||
		name === "delete_file" ||
		name === "edit_notebook"
	);
}

function mutationTargetPathFromToolCall(tc: AgentToolCall): string {
	const a = tc.arguments as Record<string, unknown> | undefined;
	if (!a) return "";
	const p = a.file_path ?? a.path ?? a.target_file ?? a.target_notebook;
	return typeof p === "string" ? p : "";
}

function failedEditAnchorFromToolCall(tc: AgentToolCall): string {
	const a = tc.arguments as Record<string, unknown> | undefined;
	if (!a) return "";
	const s = a.old_string ?? a.oldText;
	return typeof s === "string" ? s : "";
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
	let totalExplorationSteps = 0;
	let hasProducedEdit = false;
	let emptyTurnRetries = 0;
	const EMPTY_TURN_MAX = 7;
	const ZERO_DIFF_AFTER_EMPTY_TURNS = 2;
	/** Last files successfully read (read / read_file); used when the model returns empty turns. */
	let recentReadPaths: string[] = [];

	const loopStart = Date.now();
	let earlyNudgeSent = false;
	let urgentNudgeSent = false;
	let finalNudgeSent = false;
	const pathsAlreadyRead = new Set<string>();
	const pathReadCounts = new Map<string, number>();
	let lastRereadNudgeAt = 0;
	const editedPaths = new Set<string>();
	const pathEditCounts = new Map<string, number>();
	let consecutiveEditsOnSameFile = 0;
	let lastEditedFile = "";

	let workPhase: "search" | "absorb" | "apply" = "search";
	let foundFiles: string[] = [];
	let absorbedFiles = new Set<string>();

	// Parse expected files from system prompt discovery sections
	const parseExpectedFiles = (text: string): string[] => {
		const files: string[] = [];
		const seen = new Set<string>();
		const sectionPatterns = [
			/FILES EXPLICITLY NAMED IN THE TASK[^\n]*\n((?:[-*]\s+\S[^\n]*\n)+)/,
			/LIKELY RELEVANT FILES[^\n]*\n((?:[-*]\s+\S[^\n]*\n)+)/,
			/Pre-identified target files[^\n]*\n((?:[-*]\s+\S[^\n]*\n)+)/,
		];
		for (const re of sectionPatterns) {
			const match = text.match(re);
			if (!match) continue;
			const lineRe = /^[-*]\s+(\S[^(]*?)(?:\s+\(|\s*$)/gm;
			let m: RegExpExecArray | null;
			while ((m = lineRe.exec(match[1])) !== null) {
				const file = m[1].trim();
				if (file && !seen.has(file)) { seen.add(file); files.push(file); }
			}
		}
		return files;
	};

	// Extract expected files from system prompt or initial messages
	const systemPromptText = currentContext.systemPrompt || "";
	let expectedFiles: string[] = parseExpectedFiles(systemPromptText);
	if (expectedFiles.length === 0) {
		for (const msg of currentContext.messages) {
			if (!("content" in msg) || !Array.isArray(msg.content)) continue;
			for (const block of msg.content as any[]) {
				if (block?.type === "text" && typeof block.text === "string") {
					const parsed = parseExpectedFiles(block.text);
					if (parsed.length > 0) { expectedFiles = parsed; break; }
				}
			}
			if (expectedFiles.length > 0) break;
		}
	}
	if (expectedFiles.length > 0) {
		foundFiles = [...expectedFiles];
		workPhase = "absorb";
	}
	let coverageRetries = 0;
	const MAX_COVERAGE_RETRIES = 2;

	const missingExpectedFiles = (): string[] => {
		if (expectedFiles.length === 0) return [];
		const missing: string[] = [];
		for (const f of expectedFiles) {
			const norm = f.replace(/^\.\//, "");
			let touched = false;
			for (const e of editedPaths) {
				const en = e.replace(/^\.\//, "");
				if (en === norm || en.endsWith("/" + norm) || norm.endsWith("/" + en)) { touched = true; break; }
			}
			if (!touched) missing.push(f);
		}
		return missing;
	};
	const EARLY_NUDGE_MS = 10_000;
	const URGENT_NUDGE_MS = 22_000;
	const FORCE_EDIT_MS = 45_000;
	const LATE_NUDGE_MS = 55_000;
	const GRACEFUL_EXIT_MS = 170_000;
	let multiFileHintSent = false;
	let reviewPassDone = false;
	let forceEdit45Sent = false;

	// Optional: merge git diff paths vs base ref into discovery targets (King / v142).
	try {
		const { spawnSync: gitSpawn } = await import("node:child_process");
		const gitCwd = process.cwd();
		const runGit = (args: string[]) => {
			try {
				const r = gitSpawn("git", args, { cwd: gitCwd, timeout: 3000, encoding: "utf-8" });
				return r.status === 0 ? (r.stdout || "").trim() : "";
			} catch {
				return "";
			}
		};
		const head = runGit(["rev-parse", "HEAD"]);
		const refs = runGit(["for-each-ref", "--format=%(objectname)%09%(refname)"]);
		if (head && refs) {
			let refSha = "";
			for (const line of refs.split("\n")) {
				const [sha, name] = line.split("\t");
				if (sha && sha !== head && name && (name.includes("/main") || name.includes("/master"))) {
					refSha = sha;
					break;
				}
			}
			if (!refSha) {
				for (const line of refs.split("\n")) {
					const [sha, name] = line.split("\t");
					if (sha && sha !== head && name) {
						refSha = sha;
						break;
					}
				}
			}
			if (refSha) {
				const dt = runGit(["diff-tree", "--raw", "--no-renames", "-r", head, refSha]);
				const changedPaths: string[] = [];
				for (const dl of dt.split("\n")) {
					const dm = dl.match(/^:\d+ \d+ [0-9a-f]+ [0-9a-f]+ ([AMD])\t(.+)$/);
					if (!dm) continue;
					if (dm[1] === "A" || dm[1] === "M") changedPaths.push(dm[2]);
				}
				if (changedPaths.length > 0 && changedPaths.length <= 20) {
					const norm = (s: string) => s.replace(/^\.\//, "");
					let toMerge = changedPaths;
					if (expectedFiles.length > 0) {
						toMerge = changedPaths.filter((p) => {
							const np = norm(p);
							return expectedFiles.some((e) => {
								const ne = norm(e);
								return np === ne || np.endsWith("/" + ne) || ne.endsWith("/" + np);
							});
						});
					}
					if (toMerge.length > 0) {
						const merged = new Set([...foundFiles, ...toMerge, ...expectedFiles]);
						foundFiles = [...merged];
						expectedFiles = [...merged];
						workPhase = "absorb";
					}
				}
			}
		}
	} catch {
		/* not a git repo or git unavailable */
	}

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
			// Gemini often uses IDE-shaped or wrong tool names; normalize before lookup.
			for (const tc of toolCalls) {
				(tc as { name: string }).name = normalizeGeminiToolName(tc.name);
			}
			hasMoreToolCalls = toolCalls.length > 0;

			if (!hasMoreToolCalls && emptyTurnRetries < EMPTY_TURN_MAX) {
				const tokenCapped = message.stopReason === "length";
				const idleStopped = message.stopReason === "stop" && !hasProducedEdit;
				if (tokenCapped || idleStopped) {
					emptyTurnRetries++;
					const primaryPath =
						recentReadPaths[0] ||
						(pathsAlreadyRead.size > 0 ? [...pathsAlreadyRead][0] : "") ||
						(foundFiles[0] ?? "");
					const concreteEditHint =
						!tokenCapped && primaryPath
							? ` Call \`search_replace\` on \`${primaryPath}\` with \`old_string\` copied verbatim from \`read_file\`, or use \`edit_file\` with \`// ... existing code ...\` placeholders. Discovery-only turns score zero.`
							: "";
					await emit({ type: "turn_end", message, toolResults: [] });
					if (
						idleStopped &&
						!tokenCapped &&
						pathsAlreadyRead.size > 0 &&
						emptyTurnRetries >= ZERO_DIFF_AFTER_EMPTY_TURNS
					) {
						emptyTurnRetries = 0;
						const topFile = foundFiles[0] || primaryPath || "";
						pendingMessages.push({
							role: "user",
							content: [
								{
									type: "text",
									text: `You are about to finish with ZERO edits. This guarantees a loss. You read \`${topFile}\`. Apply \`search_replace\` or \`edit_file\` to it now — even a partial change scores more than nothing.`,
								},
							],
							timestamp: Date.now(),
						});
					} else {
						pendingMessages.push({
							role: "user",
							content: [
								{
									type: "text",
									text: tokenCapped
										? "Output budget consumed without any tool invocation. Invoke \`read_file\`, \`search_replace\`, or \`edit_file\` now. Text output contributes nothing to your score."
										: `No file modifications detected. A blank diff receives zero points.${concreteEditHint} Do not reply with prose only — your next message must include a \`search_replace\`, \`edit_file\`, or \`delete_file\` tool call if the task requires it.`,
								},
							],
							timestamp: Date.now(),
						});
					}
					continue;
				}
			}

			// Forced coverage: model about to stop with edits but expected files still untouched
			if (!hasMoreToolCalls && hasProducedEdit && coverageRetries < MAX_COVERAGE_RETRIES) {
				const missing = missingExpectedFiles();
				if (missing.length > 0) {
					coverageRetries++;
					await emit({ type: "turn_end", message, toolResults: [] });
					const list = missing.slice(0, 5).map((f) => `\`${f}\``).join(", ");
					pendingMessages.push({
						role: "user",
						content: [{ type: "text", text: `Before stopping: these discovered target files have NOT been edited yet: ${list}. Read each and decide if it needs a change. Missing a required file forfeits all matched lines for it.` }],
						timestamp: Date.now(),
					});
					hasMoreToolCalls = false;
					continue;
				}
			}

			const toolResults: ToolResultMessage[] = [];
			if (hasMoreToolCalls) {
				toolResults.push(...(await executeToolCalls(currentContext, message, config, signal, emit)));
				emptyTurnRetries = 0;

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}

				for (let i = 0; i < toolResults.length; i++) {
					const tr = toolResults[i];
					const tc = toolCalls[i];
					if (!tc || tc.type !== "toolCall") continue;
					if (!isMutationEditTool(tc.name)) continue;
					const targetPath = mutationTargetPathFromToolCall(tc);
					if (!targetPath || typeof targetPath !== "string") continue;
					if (tr.isError) {
						const count = (editFailMap.get(targetPath) ?? 0) + 1;
						editFailMap.set(targetPath, count);
						const anchorText = failedEditAnchorFromToolCall(tc);
						const errText = toolResultErrorText(tr);
						const prevAnchor = priorFailedAnchor.get(targetPath);
						if (errText.includes("2 occurrences") || errText.includes("3 occurrences")) {
							pendingMessages.push({
								role: "user",
								content: [
									{
										type: "text",
										text: `Edit failed: anchor matches multiple locations in \`${targetPath}\`. Widen \`old_string\`/\`oldText\` with more surrounding lines so it is unique, or use \`search_replace\` \`replace_all\` when appropriate. Use \`read_file\` for exact context.`,
									},
								],
								timestamp: Date.now(),
							});
						} else if (errText.includes("must have required property") || errText.includes("Validation failed")) {
							pendingMessages.push({
								role: "user",
								content: [
									{
										type: "text",
										text: `Edit schema error on \`${targetPath}\`. Use flat JSON with exact keys for this tool (\`search_replace\`: file_path, old_string, new_string; \`edit_file\`: target_file, instructions, code_edit). Re-read the tool definition and retry.`,
									},
								],
								timestamp: Date.now(),
							});
						} else if (
							(errText.includes("Could not find") ||
								errText.includes("not found in file") ||
								errText.includes("Old string not found")) &&
							!pathsAlreadyRead.has(targetPath) &&
							pendingMessages.length === 0
						) {
							pendingMessages.push({
								role: "user",
								content: [
									{
										type: "text",
										text: `Edit failed on \`${targetPath}\` — your anchor does not match the file. Call \`read_file\` on \`${targetPath}\` first, then copy the exact text into \`old_string\`/\`oldText\`.`,
									},
								],
								timestamp: Date.now(),
							});
						} else if (anchorText && prevAnchor === anchorText && pendingMessages.length === 0) {
							pendingMessages.push({ role: "user", content: [{ type: "text", text: `Identical old_string/oldText failed twice on \`${targetPath}\`. Use \`read_file\` to get fresh contents before retrying.` }], timestamp: Date.now() });
						}
						priorFailedAnchor.set(targetPath, anchorText);
						if (count >= EDIT_FAIL_CEILING && !failNotified.has(targetPath)) {
							failNotified.add(targetPath);
							pendingMessages.push({
								role: "user",
								content: [
									{
										type: "text",
										text: `Edit attempts on \`${targetPath}\` have failed ${count} times. Your cached view is stale. Options:\n\n1. Switch to another file from the acceptance criteria you have not edited yet.\n2. Call \`read_file\` on this file to refresh, then use \`search_replace\` with a compact \`old_string\` (under 5 lines) or \`edit_file\` with correct placeholders.\n3. Only use text you have just read — never paste from memory.`,
									},
								],
								timestamp: Date.now(),
							});
						}
					} else {
						editFailMap.set(targetPath, 0);
						priorFailedAnchor.delete(targetPath);
						const firstEdit = !hasProducedEdit;
						hasProducedEdit = true;
						explorationCount = 0;
						totalExplorationSteps = 0;
						const normTarget = targetPath.replace(/^\.\//, "");
						editedPaths.add(targetPath);
						editedPaths.add(normTarget);
						editedPaths.add("./" + normTarget);
						pathEditCounts.set(normTarget, (pathEditCounts.get(normTarget) ?? 0) + 1);
						if (normTarget === lastEditedFile) {
							consecutiveEditsOnSameFile++;
						} else {
							consecutiveEditsOnSameFile = 1;
							lastEditedFile = normTarget;
						}
						const uneditedTargets = foundFiles.filter(
							(f: string) => {
								const nf = f.replace(/^\.\//, "");
								return !editedPaths.has(f) && !editedPaths.has(nf) && !editedPaths.has("./" + nf);
							}
						);
						let breadthHint = "";
						if (consecutiveEditsOnSameFile >= 3 && uneditedTargets.length > 0) {
							breadthHint = ` STOP editing \`${normTarget}\` — you have made ${consecutiveEditsOnSameFile} consecutive edits on it. ${uneditedTargets.length} file(s) still need ANY edit: ${uneditedTargets.slice(0, 6).map((f: string) => `\`${f}\``).join(", ")}. Move to the next file NOW. One edit per file scores far higher than many edits on one file.`;
						} else if (uneditedTargets.length > 0) {
							breadthHint = ` ${uneditedTargets.length} target file(s) still need edits: ${uneditedTargets.slice(0, 6).map((f: string) => `\`${f}\``).join(", ")}. Move to the next unedited file — breadth across files scores higher than depth in one file.`;
						}
						let siblingHint = "";
						try {
							const { spawnSync: sibSpawn } = await import("node:child_process");
							const dir = normTarget.includes("/") ? normTarget.substring(0, normTarget.lastIndexOf("/")) : ".";
							const ext = normTarget.includes(".") ? normTarget.substring(normTarget.lastIndexOf(".")) : "";
							const lsResult = sibSpawn("ls", [dir], { cwd: process.cwd(), timeout: 1000, encoding: "utf-8" });
							if (lsResult.status === 0 && lsResult.stdout) {
								const siblings = lsResult.stdout
									.trim()
									.split("\n")
									.map((f: string) => (dir === "." ? f : `${dir}/${f}`))
									.filter((f: string) => !editedPaths.has(f) && !editedPaths.has(f.replace(/^\.\//, "")));
								const related = siblings
									.filter((f: string) => {
										const name = f.split("/").pop() || "";
										return (
											name.includes(".test.") ||
											name.includes(".spec.") ||
											name.includes("_test.") ||
											name.includes(".freezed.") ||
											name.includes(".g.") ||
											name.includes(".generated.") ||
											(ext.length > 0 && f.endsWith(ext))
										);
									})
									.slice(0, 5);
								if (related.length > 0) {
									for (const rf of related) {
										if (!foundFiles.includes(rf)) foundFiles.push(rf);
									}
									siblingHint = ` Siblings: ${related.map((f: string) => `\`${f}\``).join(", ")}.`;
								}
							}
						} catch {
							/* ignore sibling listing failures */
						}
						pendingMessages.push({
							role: "user",
							content: [
								{
									type: "text",
									text: `\`${targetPath}\` updated successfully.${breadthHint}${siblingHint}`,
								},
							],
							timestamp: Date.now(),
						});
						if (
							firstEdit &&
							!multiFileHintSent &&
							(foundFiles.length >= 4 || pathsAlreadyRead.size >= 4)
						) {
							multiFileHintSent = true;
							pendingMessages.push({
								role: "user",
								content: [
									{
										type: "text",
										text: "You touched several candidate paths. If any acceptance criterion still maps to a file you have not edited, continue there before stopping — ties favor complete coverage.",
									},
								],
								timestamp: Date.now(),
							});
						}
					}
				}

				for (const tr of toolResults) {
					if (isShellLikeTool(tr.toolName) && !tr.isError) {
						const output = tr.content?.map((c: any) => c.text ?? "").join("") ?? "";
						if (output.includes("ConnectionRefusedError") || output.includes("Connection refused") || output.includes("ECONNREFUSED")) {
							pendingMessages.push({ role: "user", content: [{ type: "text", text: "No services available in this environment. All network requests will fail. Proceed with \`read_file\`, \`search_replace\`, and \`edit_file\` only." }], timestamp: Date.now() });
							break;
						}
					}
				}

				for (let gi = 0; gi < toolResults.length; gi++) {
					const tr = toolResults[gi];
					const gtc = toolCalls[gi];
					if (!gtc || gtc.type !== "toolCall" || !isRipgrepBackedSearchTool(tr.toolName) || !tr.isError) continue;
					const errG = toolResultErrorText(tr);
					if (
						!errG.includes("fd is not available") &&
						!errG.includes("ripgrep") &&
						!errG.includes("not available") &&
						!errG.toLowerCase().includes("offline")
					) {
						continue;
					}
					const args = toolCallRecordArgs(gtc);
					let bashCmd = "";
					if (tr.toolName === "file_search") {
						const q = (typeof args.query === "string" && args.query) || "*";
						const safe = String(q).replace(/"/g, '\\"');
						bashCmd = `find . -type f -iname "*${safe}*" -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" | head -30`;
					} else if (tr.toolName === "codebase_search") {
						const rawQ = (typeof args.query === "string" && args.query) || "";
						const q = rawQ.split("\n")[0].slice(0, 120).replace(/"/g, '\\"');
						const dirs = args.target_directories;
						const scope =
							Array.isArray(dirs) && dirs.length > 0 && typeof dirs[0] === "string" ? dirs[0] : ".";
						bashCmd = `grep -rnl --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist -F "${q}" ${scope} | head -25`;
					} else {
						const pattern =
							(typeof args.query === "string" && args.query) ||
							(typeof args.pattern === "string" && args.pattern) ||
							"";
						const searchPath = (typeof args.path === "string" && args.path) || ".";
						const include =
							typeof args.include_pattern === "string" && args.include_pattern
								? `--include="${String(args.include_pattern).replace(/"/g, '\\"')}"`
								: "";
						const safePat = String(pattern).replace(/"/g, '\\"');
						bashCmd = `grep -rnl ${include} --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist "${safePat}" ${searchPath} | head -20`;
					}
					pendingMessages.push({
						role: "user",
						content: [
							{
								type: "text",
								text: `The ${tr.toolName} tool failed in this environment. Use \`run_terminal_cmd\` (or legacy \`bash\`) instead:\n\`\`\`\n${bashCmd}\n\`\`\`\nRun this now.`,
							},
						],
						timestamp: Date.now(),
					});
				}

				if (workPhase === "search") {
					for (const tr of toolResults) {
						if (isShellLikeTool(tr.toolName) && !tr.isError) {
							const output = tr.content?.map((c: any) => c.text ?? "").join("") ?? "";
							const paths = output.split("\n").filter((l: string) => l.trim().match(/\.\w+$/)).map((l: string) => l.trim());
							if (paths.length > 0) {
								foundFiles = paths.slice(0, 20);
								workPhase = "absorb";
								pendingMessages.push({
									role: "user",
									content: [{ type: "text", text: `Located ${foundFiles.length} candidate files. Read each file you intend to modify before making any edit:\n${foundFiles.slice(0, 10).map((p: string) => `- ${p}`).join("\n")}` }],
									timestamp: Date.now(),
								});
							}
						}
					}
				} else if (workPhase === "absorb") {
					for (let i = 0; i < toolResults.length; i++) {
						const tr = toolResults[i];
						const tc = toolCalls[i];
						if (!tc || tc.type !== "toolCall") continue;
						if (isReadLikeTool(tr.toolName) && !tr.isError) {
							const path = readPathFromToolCall(tc);
							if (path) absorbedFiles.add(path);
						}
						if (isMutationEditTool(tr.toolName) && !tr.isError) {
							workPhase = "apply";
						}
					}
					const absorbLimit = Math.min(Math.max(3, foundFiles.length > 10 ? 6 : 3), 8);
					if (absorbedFiles.size >= absorbLimit && workPhase === "absorb" && pendingMessages.length === 0) {
						workPhase = "apply";
						pendingMessages.push({
							role: "user",
							content: [{ type: "text", text: `${absorbedFiles.size} files absorbed. Begin editing the first target file now — invoke \`search_replace\` or \`edit_file\` directly. Proceed through remaining files until every acceptance criterion is covered.` }],
							timestamp: Date.now(),
						});
					}
				}

				for (let i = 0; i < toolResults.length; i++) {
					const tr = toolResults[i];
					const tc = toolCalls[i];
					if (isDiscoveryTool(tr.toolName) && !tr.isError) {
						if (!hasProducedEdit) {
							explorationCount++;
							totalExplorationSteps++;
						}
					}
					if (isReadLikeTool(tr.toolName) && !tr.isError && tc && tc.type === "toolCall") {
						const readPath = readPathFromToolCall(tc);
						if (readPath) {
							pathsAlreadyRead.add(readPath);
							pathReadCounts.set(readPath, (pathReadCounts.get(readPath) ?? 0) + 1);
							recentReadPaths = [readPath, ...recentReadPaths.filter((p) => p !== readPath)].slice(0, 5);
						}
					}
				}

				const now = Date.now();
				if (now - lastRereadNudgeAt >= 5_000 && pendingMessages.length === 0) {
					for (const [rp, cnt] of pathReadCounts) {
						if (cnt >= 3) {
							lastRereadNudgeAt = now;
							const normRp = rp.replace(/^\.\//, "");
							const others = foundFiles.filter((f: string) => {
								const normF = f.replace(/^\.\//, "");
								return normF !== normRp && !editedPaths.has(f) && !editedPaths.has(normF) && !editedPaths.has("./" + normF);
							});
							pendingMessages.push({
								role: "user",
								content: [
									{
										type: "text",
										text: `You have read \`${rp}\` ${cnt} times — stop re-reading it. ${others.length > 0 ? `Move to a file you have not edited yet: ${others.slice(0, 5).map((f: string) => `\`${f}\``).join(", ")}.` : "Apply \`search_replace\` or \`edit_file\` on a different file or stop."}`,
									},
								],
								timestamp: Date.now(),
							});
							break;
						}
					}
				}

				const dynamicExploreCeiling = Math.max(3, Math.min(foundFiles.length + 1, 6));
				if (!hasProducedEdit && explorationCount >= dynamicExploreCeiling && pendingMessages.length === 0) {
					pendingMessages.push({
						role: "user",
						content: [
							{
								type: "text",
								text: `Context gathered (${explorationCount} discovery tool calls). Apply your first \`search_replace\`/\`edit_file\` to the highest-priority target file now. A partial patch always outscores an empty diff.`,
							},
						],
						timestamp: Date.now(),
					});
					explorationCount = 0;
				}

				if (
					!hasProducedEdit &&
					totalExplorationSteps >= 5 &&
					pendingMessages.length === 0 &&
					foundFiles.length > 0
				) {
					const primary = foundFiles[0].replace(/^\.\//, "");
					pendingMessages.push({
						role: "user",
						content: [
							{
								type: "text",
								text: `Discovery stall: ${totalExplorationSteps} read/search/list steps with no successful mutation yet. Top-ranked target is \`${primary}\` — \`read_file\` if needed, then \`search_replace\` or \`edit_file\` immediately. Avoid more broad listing.`,
							},
						],
						timestamp: Date.now(),
					});
					totalExplorationSteps = 0;
				}
			}

			// Time caps and nudges must run even when the model returned **no** tool calls; otherwise
			// idle/stop turns skip early/late nudges and graceful exit (benchmarks see no agent_end / stall).
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
								text: `${Math.round(elapsed/1000)}s elapsed without any edits. An empty diff scores zero. ${readList}Apply \`search_replace\` or \`edit_file\` to the most relevant file now. Even one correct change contributes to your score.`,
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
				if (!forceEdit45Sent && elapsed >= FORCE_EDIT_MS && pathsAlreadyRead.size > 0) {
					forceEdit45Sent = true;
					const topFile = foundFiles[0] || [...pathsAlreadyRead][0] || "";
					if (topFile) {
						pendingMessages.push({
							role: "user",
							content: [
								{
									type: "text",
									text: `CRITICAL: ${Math.round(elapsed / 1000)}s elapsed with ZERO successful mutations. An empty diff scores zero. You have read \`${topFile}\`. Call \`search_replace\` or \`edit_file\` on it now — do NOT spend more turns on discovery only.`,
								},
							],
							timestamp: Date.now(),
						});
					}
				}
			}

			if (hasProducedEdit && pendingMessages.length === 0) {
				const elapsed = Date.now() - loopStart;
				const uniqueEdited = new Set([...editedPaths].map(p => p.replace(/^\.\//, "")));
				const uneditedFound = foundFiles.filter((f: string) => {
					const nf = f.replace(/^\.\//, "");
					return !uniqueEdited.has(nf);
				});
				if (uneditedFound.length > 0 && elapsed > 30_000 && uniqueEdited.size <= 2) {
					pendingMessages.push({
						role: "user",
						content: [{
							type: "text",
							text: `30s+ elapsed and you have only edited ${uniqueEdited.size} file(s). ${uneditedFound.length} discovered target(s) remain: ${uneditedFound.slice(0, 8).map((f: string) => `\`${f}\``).join(", ")}. Read and edit each one before going back to files you already edited.`,
						}],
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
							text: "Over 50s without edits. Pick the clearest file from the task or keyword list and apply \`search_replace\` or \`edit_file\` now — further discovery has diminishing returns.",
						},
					],
					timestamp: Date.now(),
				});
			}

			await emit({ type: "turn_end", message, toolResults });

			const steeringBatch = (await config.getSteeringMessages?.()) || [];
			if (steeringBatch.length > 0) {
				pendingMessages.push(...steeringBatch);
			}
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			pendingMessages = followUpMessages;
			continue;
		}

		// Review pass: if finished quickly and edits were made, check for missed files
		const reviewElapsed = Date.now() - loopStart;
		if (!reviewPassDone && hasProducedEdit && reviewElapsed < 60_000) {
			reviewPassDone = true;
			workPhase = "search";
			const uneditedTargets = foundFiles.filter(
				(f: string) => {
					const nf = f.replace(/^\.\//, "");
					return !editedPaths.has(f) && !editedPaths.has(nf) && !editedPaths.has("./" + nf);
				}
			);
			const hint = uneditedTargets.length > 0
				? `Unedited discovered files: ${uneditedTargets.slice(0, 5).map((f: string) => `\`${f}\``).join(", ")}. Read and edit them.`
				: `Re-read the task acceptance criteria. If the task named exact old strings or labels, run \`grep_search\` (or \`run_terminal_cmd\` with \`grep -r\`) for any that remain. Are there files or criteria you missed? If yes, discover and edit them. If all criteria are covered, reply "done".`;
			pendingMessages = [{
				role: "user",
				content: [{ type: "text", text: `REVIEW: You edited ${editedPaths.size} file(s): ${[...editedPaths].slice(0, 8).join(", ")}. ${hint}` }],
				timestamp: Date.now(),
			}];
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
	/** One promise per tool call index — preserves assistant source order (immediate + prepared interleaved). */
	const resultPromises: Promise<ToolResultMessage>[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			resultPromises.push(
				Promise.resolve(await emitToolCallOutcome(toolCall, preparation.result, preparation.isError, emit)),
			);
		} else {
			resultPromises.push(
				executePreparedToolCall(preparation, signal, emit).then((executed) =>
					finalizeExecutedToolCall(
						currentContext,
						assistantMessage,
						preparation,
						executed,
						config,
						signal,
						emit,
					),
				),
			);
		}
	}

	return Promise.all(resultPromises);
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
			result: createErrorToolResult(
				augmentToolFailureMessage(toolCall.name, `Tool "${toolCall.name}" not found`),
			),
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
		const raw = error instanceof Error ? error.message : String(error);
		return {
			kind: "immediate",
			result: createErrorToolResult(augmentToolFailureMessage(tool.name, raw)),
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
		const raw = error instanceof Error ? error.message : String(error);
		return {
			result: createErrorToolResult(augmentToolFailureMessage(prepared.toolCall.name, raw)),
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
