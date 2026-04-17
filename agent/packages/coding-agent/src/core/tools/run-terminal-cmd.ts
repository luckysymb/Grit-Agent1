/**
 * `run_terminal_cmd` — matches tau/Cursor_Tools.json (command + is_background required).
 */
import { createWriteStream, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Container, Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import { truncateToVisualLines } from "../../modes/interactive/components/visual-truncate.js";
import { waitForChildProcess } from "../../utils/child-process.js";
import { getShellConfig, getShellEnv, killProcessTree } from "../../utils/shell.js";
import type { ExtensionContext, ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { getTextOutput, invalidArgText, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail } from "./truncate.js";

const runTerminalCmdSchema = Type.Object({
	command: Type.String({ description: "The terminal command to execute" }),
	is_background: Type.Boolean({ description: "Whether the command should be run in the background" }),
	explanation: Type.Optional(
		Type.String({
			description: "One sentence explanation as to why this command needs to be run and how it contributes to the goal.",
		}),
	),
});

export type RunTerminalCmdToolInput = Static<typeof runTerminalCmdSchema>;

const BASH_PREVIEW_LINES = 5;

export interface RunTerminalCmdToolDetails {
	truncation?: { truncated: boolean; outputLines: number; maxBytes: number };
	fullOutputPath?: string;
}

export function createRunTerminalCmdToolDefinition(cwd: string): ToolDefinition<typeof runTerminalCmdSchema, RunTerminalCmdToolDetails | undefined> {
	return {
		name: "run_terminal_cmd",
		label: "run_terminal_cmd",
		description:
			"Run a shell command in the workspace directory. When is_background is true, the process is detached and only start status is returned.",
		parameters: runTerminalCmdSchema,
		async execute(
			_toolCallId,
			args: { command: string; is_background: boolean; explanation?: string },
			signal: AbortSignal | undefined,
			_onUpdate,
			_ctx: ExtensionContext,
		) {
			if (!existsSync(cwd)) {
				throw new Error(`Working directory does not exist: ${cwd}`);
			}
			const { shell, args: shellArgs } = getShellConfig();
			const cmd = args.command;
			if (args.is_background) {
				const child = spawn(shell, [...shellArgs, cmd], {
					cwd,
					detached: true,
					stdio: "ignore",
					env: getShellEnv(),
				});
				child.unref();
				return {
					content: [
						{
							type: "text",
							text: `Background command started (pid ${child.pid ?? "?"}). Output is not captured.`,
						},
					],
					details: undefined,
				};
			}

			return new Promise((resolve, reject) => {
				const child = spawn(shell, [...shellArgs, cmd], {
					cwd,
					detached: true,
					env: getShellEnv(),
					stdio: ["ignore", "pipe", "pipe"],
				});
				let tempPath: string | undefined;
				let tempStream: ReturnType<typeof createWriteStream> | undefined;
				let total = 0;
				const chunks: Buffer[] = [];
				let chunkBytes = 0;
				const onAbort = () => {
					if (child.pid) killProcessTree(child.pid);
				};
				signal?.addEventListener("abort", onAbort, { once: true });

				const handleData = (data: Buffer) => {
					total += data.length;
					if (chunkBytes < DEFAULT_MAX_BYTES * 2) {
						chunks.push(data);
						chunkBytes += data.length;
					} else if (!tempStream) {
						tempPath = join(tmpdir(), `pi-cmd-${randomBytes(8).toString("hex")}.log`);
						tempStream = createWriteStream(tempPath);
						for (const c of chunks) tempStream.write(c);
						chunks.length = 0;
						tempStream.write(data);
					} else {
						tempStream.write(data);
					}
				};
				child.stdout?.on("data", handleData);
				child.stderr?.on("data", handleData);

				waitForChildProcess(child)
					.then((code) => {
						signal?.removeEventListener("abort", onAbort);
						if (signal?.aborted) {
							reject(new Error("Operation aborted"));
							return;
						}
						void tempStream?.end();
						let text: string;
						if (tempPath) {
							text = `[Output exceeded memory buffer; full log: ${tempPath}]\n`;
						} else {
							text = Buffer.concat(chunks).toString("utf-8");
						}
						const tail = truncateTail(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
						const details: RunTerminalCmdToolDetails = {};
						if (tail.truncated) {
							details.truncation = {
								truncated: true,
								outputLines: tail.outputLines,
								maxBytes: DEFAULT_MAX_BYTES,
							};
						}
						if (tempPath) details.fullOutputPath = tempPath;
						const exitNote = `\n[exit code ${code}]`;
						resolve({
							content: [{ type: "text", text: tail.content + exitNote }],
							details: details.truncation || details.fullOutputPath ? details : undefined,
						});
					})
					.catch(reject);
			});
		},
		renderCall(args, themeArg, context) {
			const command = str(args?.command);
			const invalidArg = invalidArgText(themeArg);
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				themeArg.fg("toolTitle", themeArg.bold("run_terminal_cmd")) +
					" " +
					(command === null ? invalidArg : themeArg.fg("accent", command.slice(0, 120))) +
					themeArg.fg("muted", args?.is_background ? " (background)" : ""),
			);
			return text;
		},
		renderResult(result, options, themeArg, context) {
			const output = getTextOutput(result as any, context.showImages).trim();
			const component = new Container();
			if (output) {
				const styled = output.split("\n").map((line) => themeArg.fg("toolOutput", line)).join("\n");
				if (options.expanded) {
					component.addChild(new Text(`\n${styled}`, 0, 0));
				} else {
					const preview = truncateToVisualLines(styled, BASH_PREVIEW_LINES, 120);
					component.addChild(
						new Text(
							`\n${preview.visualLines.join("\n")}${preview.skippedCount ? `\n${themeArg.fg("muted", `... (${preview.skippedCount} lines,`)} ${keyHint("app.tools.expand", "expand")})` : ""}`,
							0,
							0,
						),
					);
				}
			}
			const d = (result as { details?: RunTerminalCmdToolDetails }).details;
			if (d?.truncation?.truncated) {
				component.addChild(
					new Text(`\n${themeArg.fg("warning", `[Truncated: ${formatSize(d.truncation.maxBytes)}]`)}`, 0, 0),
				);
			}
			return component;
		},
	};
}

export function createRunTerminalCmdTool(cwd: string): AgentTool {
	return wrapToolDefinition(createRunTerminalCmdToolDefinition(cwd));
}

export const runTerminalCmdToolDefinition = createRunTerminalCmdToolDefinition(process.cwd());
export const runTerminalCmdTool = wrapToolDefinition(runTerminalCmdToolDefinition);
