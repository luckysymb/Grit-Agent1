/**
 * `file_search` — fuzzy path match; many results for monorepo discovery (tau).
 */

import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import { existsSync } from "fs";
import { ensureTool } from "../../utils/tools-manager.js";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.js";
import { asRecord, firstString } from "./flexible-tool-args.js";
import { resolveToCwd } from "./path-utils.js";
import { str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const MAX_RESULTS = 160;
/** Same pruning as grep_search / codebase_search offline passes — skip huge trees. */
const OFFLINE_SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"out",
	".next",
	"target",
	"coverage",
	".turbo",
	"__pycache__",
]);
const MAX_LISTED_FILES = 200_000;

/**
 * When `fd` is missing or fails (offline Docker, broken binary), list files by walking the tree.
 */
async function collectFilePathsOffline(repoRoot: string, signal: AbortSignal | undefined): Promise<string[]> {
	const relPaths: string[] = [];

	async function walk(dir: string): Promise<void> {
		if (signal?.aborted) {
			throw new Error("aborted");
		}
		if (relPaths.length >= MAX_LISTED_FILES) {
			return;
		}
		let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (signal?.aborted) {
				throw new Error("aborted");
			}
			const full = path.join(dir, e.name);
			if (e.isDirectory()) {
				if (OFFLINE_SKIP_DIRS.has(e.name)) continue;
				await walk(full);
			} else if (e.isFile()) {
				const rel = path.relative(repoRoot, full).replace(/\\/g, "/");
				if (!rel || rel.startsWith("..")) continue;
				relPaths.push(rel);
				if (relPaths.length >= MAX_LISTED_FILES) {
					return;
				}
			}
		}
	}

	await walk(repoRoot);
	return relPaths;
}

const fileSearchSchema = Type.Object({
	query: Type.String({ description: "Fuzzy filename to search for" }),
	explanation: Type.Optional(
		Type.String({
			description: "One sentence explanation as to why this tool is being used, and how it contributes to the goal.",
		}),
	),
});

export type FileSearchToolInput = Static<typeof fileSearchSchema>;

function prepareFileSearchArguments(raw: unknown): FileSearchToolInput {
	const o = asRecord(raw);
	const query =
		firstString(o, ["query", "q", "search", "pattern", "filename", "name", "file", "path"]) ?? "";
	const explanation =
		firstString(o, ["explanation", "reason", "purpose"]) ?? "Fuzzy path search for discovery.";
	return { query, explanation };
}

function scorePathSingle(rel: string, token: string): number {
	const lower = rel.toLowerCase();
	const qq = token.toLowerCase();
	if (!qq.length) return 0;
	if (lower.includes(qq)) return 100 + qq.length;
	let s = 0;
	for (const ch of qq) {
		const idx = lower.indexOf(ch, s);
		if (idx === -1) return -1;
		s = idx + 1;
	}
	return 50;
}

/** Score path against full query and path segments (dashboard, sessionModel, etc.). */
function scorePath(rel: string, q: string): number {
	const trimmed = q.trim();
	if (!trimmed) return 0;
	const parts = trimmed
		.split(/[/\\\s,_-]+/g)
		.map((p) => p.trim())
		.filter((p) => p.length >= 2);
	if (parts.length <= 1) {
		const one = scorePathSingle(rel, parts[0] ?? trimmed);
		return one;
	}
	let sum = 0;
	let ok = 0;
	for (const p of parts) {
		const sc = scorePathSingle(rel, p);
		if (sc >= 0) {
			sum += sc;
			ok++;
		}
	}
	if (ok === 0) return -1;
	return sum / ok + (ok > 1 ? 25 : 0);
}

export function createFileSearchToolDefinition(cwd: string): ToolDefinition<typeof fileSearchSchema, undefined> {
	return {
		name: "file_search",
		label: "file_search",
		description:
			"Fuzzy search over file paths (substring / character-order score; multi-token queries boost paths matching several segments). Up to 160 results. Call once per important path segment from the task (package names, layer directories, filename stems) to enumerate plausible files before editing.",
		parameters: fileSearchSchema,
		prepareArguments: prepareFileSearchArguments,
		async execute(
			_toolCallId,
			args: { query: string; explanation?: string },
			signal: AbortSignal | undefined,
			_onUpdate,
			_ctx: ExtensionContext,
		) {
			const root = resolveToCwd(".", cwd);
			if (!existsSync(root)) throw new Error("workspace not found");

			let paths: string[] = [];
			let header = "";

			const fdPath = await ensureTool("fd", true);
			if (fdPath) {
				const r = spawnSync(fdPath, [".", "--type", "f", "--color=never", "--hidden", "--max-results", "200000"], {
					cwd: root,
					encoding: "utf-8",
					maxBuffer: 50 * 1024 * 1024,
				});
				if (!r.error && r.status === 0) {
					const out = r.stdout?.trim() || "";
					paths = out
						.split("\n")
						.map((line) => line.trim())
						.filter(Boolean)
						.map((abs) => path.relative(cwd, abs).replace(/\\/g, "/"))
						.filter((rel) => !rel.startsWith(".."));
				} else {
					const reason = r.error?.message ?? (r.status !== null ? `exit ${r.status}` : "spawn failed");
					header = `[file_search: fd failed (${reason}) — using built-in filesystem walk.]\n`;
					paths = await collectFilePathsOffline(root, signal);
				}
			} else {
				header =
					"[file_search: fd is unavailable (offline or not installed) — using built-in filesystem walk; install `fd` for speed.]\n";
				paths = await collectFilePathsOffline(root, signal);
			}

			const ranked = paths
				.map((rel) => ({ rel, sc: scorePath(rel, args.query) }))
				.filter((x) => x.sc >= 0)
				.sort((a, b) => b.sc - a.sc)
				.slice(0, MAX_RESULTS);

			if (ranked.length === 0) {
				return { content: [{ type: "text" as const, text: `${header}No matching file paths.` }], details: undefined };
			}
			return {
				content: [{ type: "text" as const, text: header + ranked.map((x) => x.rel).join("\n") }],
				details: undefined,
			};
		},
		renderCall(args, theme, context) {
			const q = str(args?.query);
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(theme.fg("toolTitle", theme.bold("file_search")) + " " + theme.fg("accent", q ?? "?"));
			return text;
		},
	};
}

export function createFileSearchTool(cwd: string): AgentTool {
	return wrapToolDefinition(createFileSearchToolDefinition(cwd));
}

export const fileSearchToolDefinition = createFileSearchToolDefinition(process.cwd());
export const fileSearchTool = wrapToolDefinition(fileSearchToolDefinition);
