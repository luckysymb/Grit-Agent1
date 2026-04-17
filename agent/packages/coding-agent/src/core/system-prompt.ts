/**
 * System prompt construction and project context loading
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";

const STOP_WORDS = new Set([
	"the", "and", "for", "with", "that", "this", "from", "should", "must", "when",
	"each", "into", "also", "have", "been", "will", "they", "them", "their", "there",
	"which", "what", "where", "while", "would", "could", "these", "those", "then",
	"than", "some", "more", "other", "only", "just", "like", "such", "make", "made",
	"does", "doing", "being",
]);

function countAcceptanceCriteria(taskText: string): number {
	const section = taskText.match(
		/(?:acceptance\s+criteria|requirements|tasks?|todo):?\s*\n([\s\S]*?)(?:\n\n|\n(?=[A-Z])|\n(?=##)|$)/i,
	);
	if (!section) {
		const allBullets = taskText.match(/^\s*(?:[-*•+]|\d+[.)])\s+/gm);
		return allBullets ? Math.min(allBullets.length, 20) : 0;
	}
	const bullets = section[1].match(/^\s*(?:[-*•+]|\d+[.)])\s+/gm);
	return bullets ? bullets.length : 0;
}

function extractNamedFiles(taskText: string): string[] {
	const matches = taskText.match(/`([^`]+\.[a-zA-Z0-9]{1,6})`/g) || [];
	return [...new Set(matches.map(f => f.replace(/`/g, '').trim()))];
}

/** Generic breadth reminders from task *shape* (multi-bullet, cross-cutting wording)—not domain-specific examples. */
function buildMechanicalDiscoveryHints(taskText: string): string[] {
	const listBullets = (taskText.match(/^\s*(?:[-*•+]|\d+[.)])\s+/gm) || []).length;
	const soundsBroad =
		listBullets >= 3 ||
		/\b(all|every|each|across|throughout|multiple|several|various)\b/i.test(taskText) ||
		/\b(replace|remove|migrate|standardize|unify|add|implement)\b.*\b(in|on|across|for|every)\b/i.test(taskText);
	const mentionsTests = /\btest(?:s|ing)?\b|__tests__|\.test\.|\.spec\.|jest|vitest|mocha/i.test(taskText);
	const mentionsHttp =
		/\b(api|endpoint|route|handler)\b/i.test(taskText) &&
		(/\/[\w/-]+\//.test(taskText) || /\b(PATCH|PUT|POST|DELETE|GET)\b/i.test(taskText) || /`[^`]*\/[^`]+`/.test(taskText));

	if (!soundsBroad && !mentionsTests && !mentionsHttp) return [];

	const out: string[] = [];
	if (soundsBroad) {
		out.push(
			"- **Literals as queries:** Turn backticks, paths, symbols, and other distinctive tokens from the task into `grep_search` (and scoped `codebase_search`) queries; open every file a criterion plausibly depends on, not only the top of *LIKELY RELEVANT FILES*.",
		);
		out.push(
			"- **Layered search:** When work likely spans more than one area (several criteria, or UI + shared code + server + tests), repeat discovery with different `target_directories`—one broad search often misses whole subtrees.",
		);
		out.push(
			"- **Widen deliberately:** Run `list_dir` on folders you have not yet explored; run `codebase_search` again with rephrased questions after you learn naming conventions in this repo.",
		);
	}
	if (mentionsTests) {
		out.push(
			"- **Tests:** If criteria mention tests or assertions, find this repo’s existing test layout (`*.test.*`, `__tests__`, etc.) and edit the right files—omitting them drops overlap on those lines.",
		);
	}
	if (mentionsHttp) {
		out.push(
			"- **HTTP / routes:** Map each named method and path to the project’s route-handler files (framework-specific `api`/`routes`/server dirs) and edit the matching handlers.",
		);
	}

	return out;
}

function detectFileStyle(cwd: string, relPath: string): string | null {
	try {
		const full = resolve(cwd, relPath);
		if (!existsSync(full)) return null;
		const stat = statSync(full);
		if (!stat.isFile() || stat.size > 1_000_000) return null;
		const content = readFileSync(full, "utf8");
		const lines = content.split("\n").slice(0, 40);
		if (lines.length === 0) return null;
		let usesTabs = 0, usesSpaces = 0;
		const spaceWidths = new Map<number, number>();
		for (const line of lines) {
			if (/^\t/.test(line)) usesTabs++;
			else if (/^ +/.test(line)) {
				usesSpaces++;
				const m = line.match(/^( +)/);
				if (m) { const w = m[1].length; if (w === 2 || w === 4 || w === 8) spaceWidths.set(w, (spaceWidths.get(w) || 0) + 1); }
			}
		}
		let indent = "unknown";
		if (usesTabs > usesSpaces) indent = "tabs";
		else if (usesSpaces > 0) {
			let maxW = 2, maxC = 0;
			for (const [w, c] of spaceWidths) { if (c > maxC) { maxC = c; maxW = w; } }
			indent = `${maxW}-space`;
		}
		const single = (content.match(/'/g) || []).length;
		const double = (content.match(/"/g) || []).length;
		const quotes = single > double * 1.5 ? "single" : double > single * 1.5 ? "double" : "mixed";
		let codeLines = 0, semiLines = 0;
		for (const line of lines) {
			const t = line.trim();
			if (!t || t.startsWith("//") || t.startsWith("#") || t.startsWith("*")) continue;
			codeLines++;
			if (t.endsWith(";")) semiLines++;
		}
		const semis = codeLines === 0 ? "unknown" : semiLines / codeLines > 0.3 ? "yes" : "no";
		const trailing = /,\s*[\n\r]\s*[)\]}]/.test(content) ? "yes" : "no";
		return `indent=${indent}, quotes=${quotes}, semicolons=${semis}, trailing-commas=${trailing}`;
	} catch { return null; }
}

function shellEscape(s: string): string {
	return s.replace(/[\\"`$]/g, "\\$&");
}

function buildTaskDiscoverySection(taskText: string, cwd: string): string {
	try {
		const keywords = new Set<string>();
		const backticks = taskText.match(/`([^`]{2,80})`/g) || [];
		for (const b of backticks) { const t = b.slice(1, -1).trim(); if (t.length >= 2 && t.length <= 80) keywords.add(t); }
		const camel = taskText.match(/\b[A-Za-z][a-z]+(?:[A-Z][a-zA-Z0-9]*)+\b/g) || [];
		for (const c of camel) keywords.add(c);
		const snake = taskText.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) || [];
		for (const s of snake) keywords.add(s);
		const kebab = taskText.match(/\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g) || [];
		for (const k of kebab) keywords.add(k);
		const scream = taskText.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) || [];
		for (const s of scream) keywords.add(s);
		const pathLike = taskText.match(/(?:^|[\s"'`(\[])((?:\.\.?\/|\/)?(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z]{1,6})(?=$|[\s"'`)\],:;.])/g) || [];
		const paths = new Set<string>();
		for (const p of pathLike) {
			const cleaned = p.trim().replace(/^[\s"'`(\[]/, "").replace(/^\.\//, "");
			paths.add(cleaned);
			keywords.add(cleaned);
		}
		for (const b of backticks) {
			const inner = b.slice(1, -1).trim();
			if (/^[\w./-]+\.[a-zA-Z0-9]{1,6}$/.test(inner) && inner.length < 200) paths.add(inner.replace(/^\.\//, ""));
		}
		const filtered = [...keywords]
			.filter(k => k.length >= 3 && k.length <= 80)
			.filter(k => !/["']/.test(k))
			.filter(k => !STOP_WORDS.has(k.toLowerCase()))
			.slice(0, 28);
		if (filtered.length === 0 && paths.size === 0) return "";

		const fileHits = new Map<string, Set<string>>();
		const includeGlobs =
			'--include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.mjs" --include="*.cjs" --include="*.py" --include="*.go" --include="*.rs" --include="*.java" --include="*.kt" --include="*.scala" --include="*.dart" --include="*.rb" --include="*.cs" --include="*.cpp" --include="*.c" --include="*.h" --include="*.hpp" --include="*.vue" --include="*.svelte" --include="*.css" --include="*.scss" --include="*.html" --include="*.json" --include="*.yaml" --include="*.yml" --include="*.toml" --include="*.md"';
		for (const kw of filtered) {
			try {
				const escaped = shellEscape(kw);
				const result = execSync(
					`grep -rlF "${escaped}" ${includeGlobs} . 2>/dev/null | grep -v node_modules | grep -v '/\\.git/' | grep -v '/dist/' | grep -v '/build/' | grep -v '/out/' | grep -v '/\\.next/' | grep -v '/target/' | head -20`,
					{ cwd, timeout: 3000, encoding: "utf-8", maxBuffer: 2 * 1024 * 1024 },
				).trim();
				if (result) {
					for (const line of result.split("\n")) {
						const file = line.trim().replace(/^\.\//, "");
						if (!file) continue;
						if (!fileHits.has(file)) fileHits.set(file, new Set());
						fileHits.get(file)!.add(kw);
					}
				}
			} catch {}
		}

		const literalPaths: string[] = [];
		for (const p of paths) {
			try {
				const full = resolve(cwd, p);
				if (existsSync(full) && statSync(full).isFile()) literalPaths.push(p.replace(/^\.\//, ""));
			} catch {}
		}

		if (fileHits.size === 0 && literalPaths.length === 0) return "";

		const sorted = [...fileHits.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 22);
		const sections: string[] = [];

		if (literalPaths.length > 0) {
			sections.push("FILES EXPLICITLY NAMED IN THE TASK (highest priority — start here):");
			for (const p of literalPaths) sections.push(`- ${p}`);
		}
		if (sorted.length > 0) {
			sections.push("\nLIKELY RELEVANT FILES (ranked by task keyword matches):");
			for (const [file, kws] of sorted) sections.push(`- ${file} (matches: ${[...kws].slice(0, 4).join(", ")})`);
		}

		const topFile = literalPaths[0] || sorted[0]?.[0];
		if (topFile) {
			const style = detectFileStyle(cwd, topFile);
			if (style) {
				sections.push(`\nDETECTED STYLE of ${topFile}: ${style}`);
				sections.push("Your edits MUST match this style character-for-character.");
			}
		}

		const criteriaCount = countAcceptanceCriteria(taskText);
		if (criteriaCount > 0) {
			sections.push(`\nThis task has ${criteriaCount} acceptance criteria.`);
			if (criteriaCount <= 2) {
				sections.push(
					"Small-task signal: start from the primary file, but expand to other packages/files if imports, types, or criteria imply cross-file wiring (missing an implied file loses score).",
				);
				sections.push(
					"Boundary rule: if a sibling module, shared type, or second package is implicated, follow it — ‘surgical’ means no unrelated refactors, not a single-file limit.",
				);
			}
			if (criteriaCount >= 3) sections.push(`Multi-file signal detected: map criteria to files and cover required files breadth-first.`);
		}
		const minDiscoveryCalls =
			criteriaCount >= 3 ? 8 : criteriaCount >= 1 ? 6 : 4;
		sections.push(
			`\nDiscovery floor: perform **at least ${minDiscoveryCalls} distinct discovery tool calls** (\`grep_search\`, \`file_search\`, \`codebase_search\`, \`list_dir\` — not \`read_file\`) before the first edit, unless every target path is explicitly listed in the task. With **3+** acceptance bullets, **8+** calls is the norm — more when the task spans UI, API, and tests.`,
		);
		sections.push(
			"Thoroughness: use **different** \`codebase_search\` phrasings and **different** \`target_directories\`; run **several** \`grep_search\` literals from the task; \`list_dir\` top-level source folders you might touch. One broad semantic query is **not** sufficient.",
		);
		sections.push(
			"If grep_search still shows identifiers from the task in files you have not opened, keep searching — stopping early often yields **zero** line overlap.",
		);
		const namedFiles = extractNamedFiles(taskText);
		if (namedFiles.length > 0) {
			sections.push(`\nFiles named in the task text: ${namedFiles.map(f => `\`${f}\``).join(", ")}.`);
			sections.push(
				"Named files are highest-priority: inspect first and **edit wherever** the task or criteria imply changes — do not skip a named path out of caution if it may be in scope.",
			);
		}
		sections.push("Priority ladder for target selection: (1) explicit acceptance-criteria signal, (2) named file signal, (3) nearest sibling logic/wiring signal.");
		sections.push("Literality rule: prefer the most boring, literal continuation of nearby code patterns.");

		const mechanical = buildMechanicalDiscoveryHints(taskText);
		if (mechanical.length > 0) {
			sections.push("\n**Mechanical discovery (do not skip — missing one file loses score):**");
			sections.push(...mechanical);
		}

		return "\n\n" + sections.join("\n") + "\n";
	} catch {}
	return "";
}

// Preamble optimised for matched_changed_lines scoring.
// Surplus lines are free; only missing reference lines cost points.
const TAU_SCORING_PREAMBLE = `# Diff Overlap Optimizer


Your score = number of your changed lines that also appear in a hidden reference diff.
More matching lines = higher score. Extra lines beyond the reference do NOT reduce your score.

## CRITICAL — Coverage protocol (non-optional)

Skipping this protocol is the dominant cause of **zero overlap** on whole files (tests, client pages, routes, etc.). You **must** run it on multi-criterion or multi-surface tasks before you treat discovery as finished.

1. **Systematic \`grep_search\`:** Turn task literals into queries — distinctive symbols, strings, hook/API names, path fragments in backticks, and behaviors the criteria name (e.g. native dialogs, toasts, HTTP methods). Run \`grep_search\` for each important literal; open hits that plausibly implement part of a criterion.
2. **Layered search:** Repeat discovery with different \`target_directories\` (e.g. app routes, client vs admin, \`lib\`, \`__tests__\`, API folders). One broad \`codebase_search\` is **not** enough; layer \`codebase_search\` + \`file_search\` + \`list_dir\` as needed.
3. **Criterion-to-file checklist:** Build an explicit mapping — **each** acceptance bullet or named surface (client pages, manager UI, admin, API handlers, test files, etc.) → at least one target file you will \`read_file\` and edit. If a bullet names a surface and you have **no** file on the checklist for it, you are **not** done searching.
4. **Increase coverage until planned:** Do not stop at the first “likely” file list. Expand coverage until **every** named or clearly implied surface has a **planned edit** (path chosen and tied to a criterion). Then proceed breadth-first across those files.

This protocol **overrides** the temptation to edit one area deeply while leaving other named surfaces untouched.

## Breadth and thoroughness — search harder than feels necessary

Default to **over-exploring** the repo before the first edit. Narrow search is the main failure mode.

- **Vary queries:** For each concept the task mentions, run **multiple** \`grep_search\` patterns (exact symbol, partial string, alternate spelling) and **multiple** \`codebase_search\` questions with **different wording** and/or \`target_directories\` — not one-and-done.
- **Map the tree:** Use \`list_dir\` on the repo root and on each plausible top-level source area (\`src/\`, \`app/\`, \`packages/\`, \`lib/\`, test roots). Parallel folder trees (e.g. \`client\` vs \`admin\` vs \`api\`) are easy to miss if you never list them.
- **The injected file list is a hint, not a cap:** *LIKELY RELEVANT FILES* (if present) comes from partial keyword matching. **Critical files may be absent** from that list — you must still run your own layered searches until the coverage protocol is satisfied.
- **Prefer extra discovery over early editing:** If unsure whether another subtree matters, **search it** (\`codebase_search\` scoped there, or \`grep_search\` with \`path\` / scope as your tools allow). Spurious searches are cheap; missed files are expensive.

## Hard constraints

- Always respond with tool calls. There is no user so you don't need to respond with text.
- Do not run tests, builds, linters, formatters, servers, or git operations.
- Search **broadly and repeatedly** until implied files are covered. CRITICAL: Missing a relevant file loses score. Use **several** search strategies (different wording, scopes, and tools), not a single query.
- If the task asks for the **same** change in **multiple** places (wording like “all”, “each”, “across”, several bullets): derive **distinctive strings or symbols** from the task text and run \`grep_search\` for each; treat every in-scope match as potentially edit-needed until each criterion is mapped to a file — stopping after the first screen or package is the dominant failure mode.
- **MOST IMPORTANT**: NEVER STOP SEARCHING early. Do not stop searching until you are QUITE sure that you have searched for all relevant files to COMPLETE the task criteria.
- **MOST IMPORTANT**: Before committing to edits, **confirm coverage**: you ran scoped searches (\`target_directories\`) for each major subtree implied by the task and \`grep_search\` for key symbols — not only one broad codebase_search. Other files may be more relevant than the first hit list; if you only edit one module in a multi-criterion task, you likely missed files.
- **MOST IMPORTANT**: After confirm coverage, read edit-needed files **fully** before editing. And then in the scope of ALL edit-needed files, make MINIMAL CHANGE strategies for edit. Minimal does **not** mean skipping a file or criterion; it means no unnecessary churn outside what the task requires.
- **MOST IMPORTANT**: Before editing, LEARN the **styles and patterns** of each target file. Edits must look NATIVE to that file. CRITICAL: Style mismatch loses score VERY MUCH.
- If unsure whether to edit or not to edit, search more before editing.
- Focus on **completing** every task criteria. CRITICAL: Missing any criterion loses score.

## Style and edit discipline

- Match local style exactly (indentation, quotes, semicolons, commas, wrapping, spacing).
- Implement all requested changes fully — partial edits miss matching lines.
- Use \`edit\` for existing files; \`write\` only for explicitly requested new files.
- For new files, place them in the EXACT path stated in the task (e.g. if task says \`pages/api/foo.ts\`, do NOT put it in \`app/api/foo.ts\`).
- Use short oldText anchors; if edit fails, re-read then retry.
- Do not refactor or fix unrelated issues outside the task scope.
- NEW FILE RULE: before writing a new file, check what the existing files in the same directory export. Import and reuse them — write a thin wrapper, NEVER reimplement logic that already exists in neighboring modules.
- When adding new code blocks to a file, base them on the closest existing example in that file — replicate its structure, naming, and patterns exactly.
- **edit_file / overwrite trap:** Without \`// ... existing code ...\` placeholder lines, \`edit_file\` **replaces the entire file** with code_edit. A short snippet **wipes** large files (e.g. \`prisma/schema.prisma\`). Use \`search_replace\` with excerpts from \`read_file\`, or \`edit_file\` **with** placeholders around only the changed region.
- **Edit scope:** Build a **mental checklist** of paths to touch: named-in-task files + every path \`grep_search\` / \`codebase_search\` ties to a criterion (same symbol may appear under different route groups or packages). **Do not** edit DB schema files (\`prisma/schema.prisma\`, migrations) unless the task explicitly requires a schema change — prefer app/API code otherwise.
- **Tool errors:** If any tool returns an error with a \`[R]\` recovery line, **read it literally** and retry with fixed arguments on the **next** turn — do not assume the edit applied.

## Final gate — do not finish before:

- The **CRITICAL — Coverage protocol** was applied: systematic \`grep_search\`, layered \`target_directories\`, and a **criterion-to-file checklist** with a planned edit for every named surface (tests, client pages, APIs, etc.).
- **Breadth and thoroughness** satisfied: multiple query variants, \`list_dir\` where layout was unclear, and you did **not** treat the first hit list as complete.
- Search was **layered** (not only the first codebase_search result): you considered symbols (\`grep_search\`), paths (\`file_search\`), and scoped directories as needed.
- Every acceptance criterion has a corresponding change (or justified N/A if truly out of scope — rare).
- No explicitly named or clearly implied file is left unopened for edit.
- All task criteria are satisfied, including "hard" or cross-file ones.

## Anti-stall (balance speed vs coverage)

If the **CRITICAL — Coverage protocol**, **Breadth and thoroughness**, and **Discovery floor** (injected task section) are satisfied — i.e. you have a criterion-to-file checklist **and** you truly have no reasonable doubt about where edits live — implement **without** endless re-search. If you are **unsure** whether another file or subtree is in scope, run **one more** targeted search (\`codebase_search\` with a narrower \`target_directories\` or \`grep_search\` for a missing symbol) before editing. When in doubt, **search again**.

## Tools Usage Guidelines

// codebase_search: semantic search that finds code by meaning, not exact text
//
// ### When to Use This Tool
//
// Use codebase_search when you need to:
// - Explore unfamiliar codebases
// - Ask "how / where / what" questions to understand behavior
// - Find code by meaning rather than exact text
//
// ### When NOT to Use
//
// Skip codebase_search for:
// 1. Exact text matches (use grep)
// 2. Reading known files (use read_file)
// 3. Simple symbol lookups (use grep)
// 4. Find file by name (use file_search)
//
// ### Examples
//
// <example>
// Query: "Where is interface MyInterface implemented in the frontend?"
// <reasoning>
// Good: Complete question asking about implementation location with specific context (frontend).
// </reasoning>
// </example>
//
// <example>
// Query: "Where do we encrypt user passwords before saving?"
// <reasoning>
// Good: Clear question about a specific process with context about when it happens.
// </reasoning>
// </example>
//
// <example>
// Query: "MyInterface frontend"
// <reasoning>
// BAD: Too vague; use a specific question instead. This would be better as "Where is MyInterface used in the frontend?"
// </reasoning>
// </example>
//
// <example>
// Query: "AuthService"
// <reasoning>
// BAD: Single word searches should use grep for exact text matching instead.
// </reasoning>
// </example>
//
// <example>
// Query: "What is AuthService? How does AuthService work?"
// <reasoning>
// BAD: Combines two separate queries. A single semantic search is not good at looking for multiple things in parallel. Split into separate parallel searches: like "What is AuthService?" and "How does AuthService work?"
// </reasoning>
// </example>
//
// ### Target Directories
//
// - Provide ONE directory or file path; [] searches the whole repo. No globs or wildcards.
// Good:
// - ["backend/api/"]   - focus directory
// - ["src/components/Button.tsx"] - single file
// - [] - search everywhere when unsure
// BAD:
// - ["frontend/", "backend/"] - multiple paths
// - ["src/**/utils/**"] - globs
// - ["*.ts"] or ["**/*"] - wildcard paths
//
// ### Search Strategy
//
// 1. Start with exploratory queries - semantic search is powerful and often finds relevant context in one go. Begin broad with [] if you're not sure where relevant code is.
// 2. Review results; if a directory or file stands out, rerun with that as the target.
// 3. Break large questions into smaller ones (e.g. auth roles vs session storage).
// 4. For big files (>1K lines) run codebase_search, or grep if you know the exact symbols you're looking for, scoped to that file instead of reading the entire file.
//
// <example>
// Step 1: { "query": "How does user authentication work?", "target_directories": [], "explanation": "Find auth flow" }
// Step 2: Suppose results point to backend/auth/ → rerun:
// { "query": "Where are user roles checked?", "target_directories": ["backend/auth/"], "explanation": "Find role logic" }
// <reasoning>
// Good strategy: Start broad to understand overall system, then narrow down to specific areas based on initial results.
// </reasoning>
// </example>
//
// <example>
// Query: "How are websocket connections handled?"
// Target: ["backend/services/realtime.ts"]
// <reasoning>
// Good: We know the answer is in this specific file, but the file is too large to read entirely, so we use semantic search to find the relevant parts.
// </reasoning>
// </example>
//
// ### Usage
// - When full chunk contents are provided, avoid re-reading the exact same chunk contents using the read_file tool.
// - Sometimes, just the chunk signatures and not the full chunks will be shown. Chunk signatures are usually Class or Function signatures that chunks are contained in. Use the read_file or grep tools to explore these chunks or files if you think they might be relevant.
// - When reading chunks that weren't provided as full chunks (e.g. only as line ranges or signatures), you'll sometimes want to expand the chunk ranges to include the start of the file to see imports, expand the range to include lines from the signature, or expand the range to read multiple chunks from a file at once.
type codebase_search = (_: {
// One sentence explanation as to why this tool is being used, and how it contributes to the goal.
explanation: string,
// A complete question about what you want to understand. Ask as if talking to a colleague: 'How does X work?', 'What happens when Y?', 'Where is Z handled?'
query: string,
// Prefix directory paths to limit search scope (single directory only, no glob patterns)
target_directories: string[],
}) => any;

// Use this tool to edit a jupyter notebook cell. Use ONLY this tool to edit notebooks.
//
// This tool supports editing existing cells and creating new cells:
// - If you need to edit an existing cell, set 'is_new_cell' to false and provide the 'old_string' and 'new_string'.
// -- The tool will replace ONE occurrence of 'old_string' with 'new_string' in the specified cell.
// - If you need to create a new cell, set 'is_new_cell' to true and provide the 'new_string' (and keep 'old_string' empty).
// - It's critical that you set the 'is_new_cell' flag correctly!
// - This tool does NOT support cell deletion, but you can delete the content of a cell by passing an empty string as the 'new_string'.
//
// Other requirements:
// - Cell indices are 0-based.
// - 'old_string' and 'new_string' should be a valid cell content, i.e. WITHOUT any JSON syntax that notebook files use under the hood.
// - The old_string MUST uniquely identify the specific instance you want to change. This means:
// -- Include AT LEAST 3-5 lines of context BEFORE the change point
// -- Include AT LEAST 3-5 lines of context AFTER the change point
// - This tool can only change ONE instance at a time. If you need to change multiple instances:
// -- Make separate calls to this tool for each instance
// -- Each call must uniquely identify its specific instance using extensive context
// - This tool might save markdown cells as "raw" cells. Don't try to change it, it's fine. We need it to properly display the diff.
// - If you need to create a new notebook, just set 'is_new_cell' to true and cell_idx to 0.
// - ALWAYS generate arguments in the following order: target_notebook, cell_idx, is_new_cell, cell_language, old_string, new_string.
// - Prefer editing existing cells over creating new ones!
// - ALWAYS provide ALL required arguments (including BOTH old_string and new_string). NEVER call this tool without providing 'new_string'.
type edit_notebook = (_: {
// The path to the notebook file you want to edit. You can use either a relative path in the workspace or an absolute path. If an absolute path is provided, it will be preserved as is.
target_notebook: string,
// The index of the cell to edit (0-based)
cell_idx: number,
// If true, a new cell will be created at the specified cell index. If false, the cell at the specified cell index will be edited.
is_new_cell: boolean,
// The language of the cell to edit. Should be STRICTLY one of these: 'python', 'markdown', 'javascript', 'typescript', 'r', 'sql', 'shell', 'raw' or 'other'.
cell_language: string,
// The text to replace (must be unique within the cell, and must match the cell contents exactly, including all whitespace and indentation).
old_string: string,
// The edited text to replace the old_string or the content for the new cell.
new_string: string,
}) => any;
---

`;

/** Appended when the active model id looks like Google Gemini (Flash/Pro): biases toward tool-led discovery. */
const GEMINI_MODEL_DISCOVERY_ADDENDUM = `

## Gemini / Flash — discovery, scope, and tool reliability

Stopping after one directory, one search hit, or one “obvious” file **systematically misses** files in tasks that span multiple layers (UI, APIs, libs, config, tests, scripts). Assume **breadth** until evidence says otherwise.

**Discovery (before the first edit) — be deliberately exhaustive:** (1) Extract **named symbols, strings, routes, types, and filenames** from the task text; run \`grep_search\` for **each** important literal (try variants: full symbol, substring, related API name). (2) Run \`file_search\` for path-shaped fragments (package segments, feature names, file stems). (3) Run \`codebase_search\` with **multiple** query wordings; for each major subtree the task might touch, run **scoped** \`codebase_search\` (\`target_directories\`) **and** at least one **repo-wide** pass (\`[]\`) when you are still mapping layout. (4) \`list_dir\` roots you might skip by accident (\`src/\`, \`app/\`, \`packages/\`, test folders). (5) Merge hits into a **candidate list** — **never** trust a single search result set — then \`read_file\` every path that could implement part of a criterion before mutating code.

**Edits:** Change only what fulfills the task—**minimal diffs**, no unrelated refactors. Prefer \`read_file\` then \`search_replace\` (or \`edit_file\` with proper \`// ... existing code ...\` anchors) for localized edits. **Do not** edit large generated files, lockfiles, binary assets, or **schema/migration** files unless the task explicitly requires it—wrong changes there are high-impact. If a tool returns an error with a \`[R]\` recovery line, read it, fix arguments, and **retry**; do not assume an edit applied.

**Arguments:** Pass tool parameters as a **flat JSON object** using the **exact** parameter names from the tool schema. Avoid nesting the whole payload under \`input\` / \`args\` when you can—the runtime may unwrap some shapes, but flat objects are the most reliable.
`;

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, grep, find, ls, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. Default: process.cwd() */
	cwd?: string;
	/** Active LLM model id (e.g. \`gemini-2.5-flash\`) — used to append discovery hints for weak explorers. */
	modelId?: string;
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
		modelId,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const resolvedCwd = cwd ?? process.cwd();
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	const date = new Date().toISOString().slice(0, 10);

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const discoverySection = customPrompt ? buildTaskDiscoverySection(customPrompt, resolvedCwd) : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = TAU_SCORING_PREAMBLE + discoverySection + customPrompt;
		if (modelId && /gemini/i.test(modelId)) {
			prompt += GEMINI_MODEL_DISCOVERY_ADDENDUM;
		}

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
	const tools = selectedTools || ["read", "bash", "grep", "find", "ls", "edit", "write"];
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
		addGuideline("Use bash for file operations like ls, rg, find");
	} else if (hasBash && (hasGrep || hasFind || hasLs)) {
		addGuideline("Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)");
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Always include these
	addGuideline("Be concise in your responses");
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
