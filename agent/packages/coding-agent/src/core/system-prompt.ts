/**
 * System prompt construction and project context loading
 */

import { execSync } from "node:child_process";
import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
	const criteriaCount = countAcceptanceCriteria(taskText);
	const listBullets = (taskText.match(/^\s*(?:[-*•+]|\d+[.)])\s+/gm) || []).length;
	const soundsBroad =
		listBullets >= 3 ||
		/\b(all|every|each|across|throughout|multiple|several|various)\b/i.test(taskText) ||
		/\b(replace|remove|migrate|standardize|unify|add|implement)\b.*\b(in|on|across|for|every)\b/i.test(taskText);
	const mentionsTests = /\btest(?:s|ing)?\b|__tests__|\.test\.|\.spec\.|jest|vitest|mocha/i.test(taskText);
	/** Task explicitly asks to change test/spec/snapshot files (not merely mentioning "testing"). */
	const mentionsTestUpdate =
		/\b(update|add|fix|expand|revise|refresh|write|create|adjust)\b[\s\S]{0,120}\b(test\s+files?|tests?|specs?|spec\s+files?|snapshots?|\.test\.|\.spec\.|__tests__)/i.test(
			taskText,
		) ||
		/\b(test\s+files?|tests?|specs?)\b[\s\S]{0,120}\b(update|add|fix|expand|revise|must|should|needs?\s+to|missing)/i.test(taskText) ||
		/\b(tests?|specs?)\s+(must|should|need\s+to)\s+be\s+(updated|added|fixed|changed)/i.test(taskText) ||
		/\b(add|write|create)\b[\s\S]{0,100}\b(unit\s+)?tests?\b/i.test(taskText);
	const mentionsHttp =
		/\b(api|endpoint|route|handler)\b/i.test(taskText) &&
		(/\/[\w/-]+\//.test(taskText) || /\b(PATCH|PUT|POST|DELETE|GET)\b/i.test(taskText) || /`[^`]*\/[^`]+`/.test(taskText));
	const mentionsDocs =
		/\b(update|add\s+to|revise|refresh|expand|sync|reflect)\b[\s\S]{0,120}\b(readme|changelog|documentation|\bdocs\b|\.md\b)/i.test(
			taskText,
		) ||
		/\b(readme|changelog|documentation)\b[\s\S]{0,120}\b(update|updat(?:e|ing|ed)|revise|revis(?:e|ing)|add|refresh|expand|reflect|document)/i.test(
			taskText,
		) ||
		/\b(readme|changelog|documentation|\bdocs\b)[\s\S]{0,120}\b(must|should|needs?\s+to)\s+be\s+updated/i.test(taskText) ||
		/\bdoc(?:umentation)?\s+(?:must|should|needs?\s+to\s+be)\s+(?:be\s+)?updated/i.test(taskText);

	if (!soundsBroad && !mentionsTests && !mentionsTestUpdate && !mentionsHttp && !mentionsDocs && criteriaCount < 1)
		return [];

	const out: string[] = [];
	if (criteriaCount >= 1) {
		out.push(
			"- **Bullet-to-file checklist:** Before the first edit, map **each** acceptance bullet to at least one file you will `read_file` (and edit if needed). Unmapped bullets mean unfinished discovery.",
		);
	}
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
	if (mentionsTestUpdate) {
		out.push(
			"- **Tests (mandatory):** If the task asks to update, add, or fix **tests or specs** (`*.test.*`, `*.spec.*`, `__tests__/`, snapshots, e2e), find and **edit those files** — requested test work is **required**, not optional after production code.",
		);
	} else if (mentionsTests) {
		out.push(
			"- **Tests:** If criteria mention tests or assertions, find this repo’s existing test layout (`*.test.*`, `__tests__`, etc.) and edit the right files—omitting them drops overlap on those lines.",
		);
	}
	if (mentionsHttp) {
		out.push(
			"- **HTTP / routes:** Map each named method and path to the project’s route-handler files (framework-specific `api`/`routes`/server dirs) and edit the matching handlers.",
		);
	}
	if (mentionsDocs) {
		out.push(
			"- **Documentation:** If the task asks to update or add docs (README, CHANGELOG, `docs/`, guides, `.md` / `.rst`), find and **edit those files** — requested documentation work is **mandatory**, not optional after code changes.",
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

/**
 * Basename globs for bootstrap `grep -rlF` in task discovery (keyword → likely source files).
 * Extensionless build files are listed by exact name where common.
 */
const TASK_DISCOVERY_INCLUDE_PATTERNS: readonly string[] = [
	// JS / TS
	"*.ts",
	"*.tsx",
	"*.mts",
	"*.cts",
	"*.js",
	"*.jsx",
	"*.mjs",
	"*.cjs",
	// Systems / JVM / .NET
	"*.c",
	"*.h",
	"*.cpp",
	"*.hpp",
	"*.cs",
	"*.java",
	"*.kt",
	"*.scala",
	"*.go",
	"*.rs",
	"*.php",
	"*.swift",
	"*.m",
	"*.mm",
	// Python / Ruby / Dart
	"*.py",
	"*.rb",
	"*.dart",
	// Elixir / Erlang / F# / Haskell / Clojure
	"*.ex",
	"*.exs",
	"*.erl",
	"*.hrl",
	"*.fs",
	"*.fsx",
	"*.fsi",
	"*.hs",
	"*.lhs",
	"*.clj",
	"*.cljs",
	"*.edn",
	// Julia / Lua / Perl / R
	"*.jl",
	"*.lua",
	"*.pl",
	"*.pm",
	"*.r",
	"*.R",
	// Zig / Nim / Solidity / SQL
	"*.zig",
	"*.nim",
	"*.sol",
	"*.sql",
	// Web UI / templates / styles
	"*.vue",
	"*.svelte",
	"*.astro",
	"*.hbs",
	"*.ejs",
	"*.pug",
	"*.mjml",
	"*.css",
	"*.scss",
	"*.html",
	// Data / config / markup (JSON, notebooks, CSV — task keywords often land in these)
	"*.json",
	"*.ipynb",
	"*.csv",
	"*.yaml",
	"*.yml",
	"*.toml",
	"*.xml",
	"*.md",
	"*.rst",
	"*.ini",
	"*.cfg",
	"*.conf",
	"*.env",
	// API / schema / infra / shell
	"*.graphql",
	"*.gql",
	"*.proto",
	"*.tf",
	"*.tfvars",
	"*.sh",
	"*.bash",
	"*.zsh",
	"*.ps1",
	// Extensionless (exact basename match via grep --include)
	"Containerfile",
	"Dockerfile",
	"Jenkinsfile",
	"Makefile",
	"makefile",
];

/** When the repo is a monorepo, models often edit one package and miss server/core/utils — inject explicit breadth rules. */
function appendMonorepoPackagesDiscovery(cwd: string, taskText: string, sections: string[]): void {
	try {
		const pkgRoot = resolve(cwd, "packages");
		if (!existsSync(pkgRoot) || !statSync(pkgRoot).isDirectory()) return;
		const entries = readdirSync(pkgRoot, { withFileTypes: true }) as Dirent[];
		const names = entries
			.filter((d: Dirent) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
			.map((d: Dirent) => d.name)
			.sort((a: string, b: string) => a.localeCompare(b))
			.slice(0, 48);
		if (names.length === 0) return;
		sections.push("\n**MONOREPO — `packages/` detected:**");
		sections.push(`- Package roots: ${names.map((n: string) => `\`${n}\``).join(", ")}.`);
		sections.push(
			"- **Critical:** Feature work (dashboard, trace, browser, tools) usually spans **multiple packages** (UI + core/server + shared utils). Do **not** stop after edits in a single package — map each acceptance criterion to a package and verify wiring (imports, registries, WebSocket/tooling) across them.",
		);
		sections.push(
			"- **Mandatory passes:** `list_dir` on `packages` and on each package that plausibly touches the task; `grep_search` / `codebase_search` with `target_directories` set to **each** relevant package (e.g. dashboard UI vs playwright-core tools), plus at least one repo-wide `codebase_search` with `[]` if layout is still unclear.",
		);
		sections.push(
			"- **Symbols:** Run `grep_search` for shared identifiers from the task (`DashboardClient`, channel/registry names, WebSocket) **per package subtree** using the `path` argument when the tool supports it — one package’s hits are not exhaustive.",
		);
		const namesLower = names.map((n: string) => n.toLowerCase());
		if (
			/\bdashboard\b|websocket|react\.?context|browser session/i.test(taskText) &&
			namesLower.some((n) => n.includes("dashboard")) &&
			namesLower.some((n) => n.includes("playwright"))
		) {
			sections.push(
				"- **UI vs server split:** Tasks that describe **dashboard UI** (grid, sessions, screencast, tabs) *and* **server/tools** behavior almost always require edits under **`packages/dashboard`** (or equivalent) **and** under **`packages/playwright-core`** (or equivalent). Editing only one side yields **zero** overlap on all files in the other package — plan and edit **both** before stopping.",
			);
		}
	} catch {}
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
			.slice(0, 20);
		if (filtered.length === 0 && paths.size === 0) return "";

		const fileHits = new Map<string, Set<string>>();
		const includeGlobs =
			'--include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.mjs" --include="*.cjs" --include="*.py" --include="*.go" --include="*.rs" --include="*.java" --include="*.kt" --include="*.scala" --include="*.dart" --include="*.rb" --include="*.cs" --include="*.cpp" --include="*.c" --include="*.h" --include="*.hpp" --include="*.vue" --include="*.svelte" --include="*.css" --include="*.scss" --include="*.html" --include="*.json" --include="*.yaml" --include="*.yml" --include="*.toml" --include="*.md"';
		for (const kw of filtered) {
			try {
				const escaped = shellEscape(kw);
				const result = execSync(
					`grep -rlF "${escaped}" ${includeGlobs} . 2>/dev/null | grep -v node_modules | grep -v '/\\.git/' | grep -v '/dist/' | grep -v '/build/' | grep -v '/out/' | grep -v '/\\.next/' | grep -v '/target/' | head -12`,
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

		// v139: search by FILENAME too (like cursor's glob)
		const filenameHits = new Map<string, Set<string>>();
		for (const kw of filtered) {
			if (kw.includes("/") || kw.includes(" ") || kw.length > 40) continue;
			try {
				const nameResult = execSync(
					`find . -type f -iname "*${shellEscape(kw)}*" -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" -not -path "*/build/*" -not -path "*/.next/*" | head -10`,
					{ cwd, timeout: 2000, encoding: "utf-8", maxBuffer: 1024 * 1024 },
				).trim();
				if (nameResult) {
					for (const line of nameResult.split("\n")) {
						const file = line.trim().replace(/^\.\//, "");
						if (!file) continue;
						if (!filenameHits.has(file)) filenameHits.set(file, new Set());
						filenameHits.get(file)!.add(kw);
						// Also add to main fileHits
						if (!fileHits.has(file)) fileHits.set(file, new Set());
						fileHits.get(file)!.add(kw + " (filename)");
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

		const sorted = [...fileHits.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 15);
		const sections: string[] = [];

		sections.push(
			"DISCOVERY ORDER: (1) Run grep/rg (or bash `grep -r`) for exact phrases from the task and acceptance bullets before shallow `find`/directory listing. (2) Prefer the path that appears for multiple phrases. (3) Use find/ls only for gaps.",
		);

		if (literalPaths.length > 0) {
			sections.push("\nFILES EXPLICITLY NAMED IN THE TASK (highest priority — start here):");
			for (const p of literalPaths) sections.push(`- ${p}`);
		}

		// Show filename matches separately (high priority)
		const sortedFilename = [...filenameHits.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 8);
		const shownFiles = new Set(literalPaths);
		const newFilenameHits = sortedFilename.filter(([f]) => !shownFiles.has(f));
		if (newFilenameHits.length > 0) {
			sections.push("\nFILES MATCHING BY NAME (high priority — likely need edits):");
			for (const [file, kws] of newFilenameHits) { sections.push(`- ${file} (name matches: ${[...kws].slice(0, 3).join(", ")})`); shownFiles.add(file); }
		}

		// Content hits excluding already shown
		const contentOnly = sorted.filter(([f]) => !shownFiles.has(f));
		if (contentOnly.length > 0) {
			sections.push("\nFILES CONTAINING TASK KEYWORDS:");
			for (const [file, kws] of contentOnly) sections.push(`- ${file} (matches: ${[...kws].slice(0, 4).join(", ")})`);
		} else if (sorted.length > 0) {
			sections.push("\nLIKELY RELEVANT FILES (ranked by task keyword matches):");
			for (const [file, kws] of sorted) sections.push(`- ${file} (matches: ${[...kws].slice(0, 4).join(", ")})`);
		}

		if (sorted.length > 0) {
			const top = sorted[0];
			const second = sorted[1];
			const topCount = top[1].size;
			const secondCount = second ? second[1].size : 0;
			if (topCount >= 3 && (second === undefined || topCount >= secondCount * 2)) {
				sections.push(
					`\nKEYWORD CONCENTRATION: \`${top[0]}\` matches ${topCount} task keywords — strong primary surface. Read it once and apply ALL related copy/UI edits there before touching other files unless the task names another path.`,
				);
			}
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
			const topMatches = sorted.length > 0 ? sorted[0][1].size : 0;
			const secondMatches = sorted.length > 1 ? sorted[1][1].size : 0;
			const concentrated =
				sorted.length > 0 &&
				topMatches >= 3 &&
				(sorted.length === 1 || topMatches >= secondMatches * 2);
			if (criteriaCount <= 2) {
				sections.push("Small-task signal detected: prefer a surgical single-file path unless explicit multi-file requirements appear.");
				sections.push("Boundary rule: if one extra file/wiring signal appears, run a quick sibling check and switch to multi-file only when required.");
			} else if (concentrated) {
				sections.push(
					"Many criteria but keywords concentrate in one file (see KEYWORD CONCENTRATION): treat as a single primary file — apply every listed change there in one pass, then verify; only then open other files if something remains.",
				);
			} else if (criteriaCount >= 3) {
				sections.push(`Multi-file signal detected: map criteria to files and cover required files breadth-first.`);
			}
		}
		sections.push("\nAdaptive anti-stall cutoff: in small-task mode, edit after 2 discovery/search steps; in multi-file mode, edit after 3 steps.");
		const namedFiles = extractNamedFiles(taskText);
		if (namedFiles.length > 0) {
			sections.push(`\nFiles named in the task text: ${namedFiles.map(f => `\`${f}\``).join(", ")}.`);
			sections.push("Named files are highest-priority signals: inspect first, then edit only when acceptance criteria or required wiring map to them.");
		}
		sections.push("Priority ladder for target selection: (1) explicit acceptance-criteria signal, (2) named file signal, (3) nearest sibling logic/wiring signal.");
		sections.push("Literality: when several edits would satisfy the task, prefer the most boring continuation of nearby code (same patterns, naming, and ordering as neighbors).");

		return "\n\n" + sections.join("\n") + "\n";
	} catch {}
	return "";
}

// Preamble optimised for matched_changed_lines scoring.
// Surplus lines are free; only missing reference lines cost points.
const TAU_SCORING_PREAMBLE = `# Diff Overlap Optimizer


Your score = number of your changed lines that also appear in a hidden reference diff.
More matching lines = higher score. Extra lines beyond the reference do NOT reduce your score.

## Agent file-discovery protocol (mandatory reasoning sequence)

On any non-trivial task, follow this **ordered** sequence before treating discovery as complete. Skipping an earlier step because a later tool returned hits is a common failure mode.

1. **Parse → checklist:** From the task text and acceptance criteria, list concrete **obligations** (behavior, types, routes, UI, server, tests, docs). Each item must eventually map to **at least one** file you will \`read_file\` (or to a rare, explicit N/A).

2. **Harvest anchors:** Extract **search-grade** anchors — symbols, unique strings, HTTP paths, error messages, backticked paths, framework-specific names. Prose without anchors is not enough to prove coverage.

3. **Map layout (never guess paths):** \`list_dir\` from the workspace root, then each top-level source area the repo uses (\`src/\`, \`app/\`, \`packages/\`, \`lib/\`, test roots, \`docs/\`). In monorepos, list **each** package you might touch before assuming a folder exists.

4. **Exact literal coverage — \`grep_search\`:** For **each** important anchor, run \`grep_search\` (literal or regex as appropriate). Use optional \`path\` for **per-subtree** sweeps. **Union** hit paths that could satisfy a criterion — “all files to edit” for symbol-level work usually means **every** in-scope path that still matches a forbidden pattern or that must implement a required pattern.

5. **Path-shaped clues — \`file_search\`:** For stems and fragments from the task or from imports you have seen, run \`file_search\`.

6. **Behavior / wiring gaps — \`codebase_search\`:** When anchors are weak or you need “where / how / what”, run \`codebase_search\` with a **concrete** \`query\`, a one-sentence \`explanation\`, and **varied** \`target_directories\` (repo-wide **and** scoped). Treat output as **candidates** — confirm with \`read_file\` or \`grep_search\`.

7. **Dependency trace:** From any confirmed file, follow **imports**, shared types, re-exports, sibling modules, API boundaries, and colocated tests/docs until cross-cutting checklist items have owners.

8. **Closure (“all files”):** Re-\`grep_search\` for patterns the task must **eliminate** or **establish** repo-wide (or per subtree) until no in-scope file violates the criterion. If any checklist row still has **no** mapped file, discovery is **incomplete**.

9. **Edit order:** **Breadth-first** — touch every checklist file (read + plan) before iterating deep fixes in a single file.

10. **Edit safety (\`search_replace\` / \`edit_file\`):** Immediately before **each** \`search_replace\`, \`read_file\` that same file and build \`old_string\` **verbatim** from the **latest** output (never from memory or an older read). Use the **shortest** snippet that still matches **uniquely** once in the file (often 3–8 lines with local context); if the tool errors on 0 or multiple matches, re-read and narrow or widen \`old_string\` — **never** paste large duplicated blocks or merged fragments into \`old_string\`. For **large** TSX/JSX/React components (or any file where a single typo could duplicate half the tree), prefer \`edit_file\` with \`// ... existing code ...\` around **only** the changed region instead of a huge \`search_replace\`.

This protocol is how you find **exact** locations and **all** files that matter.

## Hard constraints

- Always respond with tool calls. There is no user so you don't need to respond with text.
- Do not run tests, builds, linters, formatters, servers, or git operations.
- Search **broadly and repeatedly** until implied files are covered. CRITICAL: Missing a relevant file loses score. Use **several** search strategies (different wording, scopes, and tools), not a single query.
- If the task asks for the **same** change in **multiple** places (wording like “all”, “each”, “across”, several bullets): derive **distinctive strings or symbols** from the task text and run \`grep_search\` for each; treat every in-scope match as potentially edit-needed until each criterion is mapped to a file — stopping after the first screen or package is the dominant failure mode.
- **MOST IMPORTANT**: NEVER STOP SEARCHING early. Do not stop searching until you are QUITE sure that you have searched for all relevant files to COMPLETE the task criteria.
- **MOST IMPORTANT**: Before committing to edits, **confirm coverage**: you ran scoped searches (\`target_directories\`) for each major subtree implied by the task and \`grep_search\` for key symbols — not only one broad codebase_search. Other files may be more relevant than the first hit list; if you only edit one module in a multi-criterion task, you likely missed files.
- **MOST IMPORTANT**: After confirm coverage, read edit-needed files **fully** before editing. And then in the scope of ALL edit-needed files, make MINIMAL CHANGE strategies for edit. Minimal does **not** mean skipping a file or criterion; it means no unnecessary churn outside what the task requires.
- **MOST IMPORTANT**: Before editing, LEARN the **styles and patterns** of each target file. Edits must look NATIVE to that file. CRITICAL: Style mismatch loses score VERY MUCH.
- If unsure whether to edit or not to edit, search more before editing. And then if still unsure, just edit it.
- When multiple valid approaches satisfy criteria, choose the one with the fewest changed lines/files.
- Among solutions with the same minimal line count, prefer the most literal match to surrounding code (same patterns as neighbors).
- Focus on **completing** every task criteria. CRITICAL: Missing any criterion loses score.
- **Documentation:** When the task asks to update or add **documentation** (README, CHANGELOG, \`docs/\`, guides, \`.md\` / \`.rst\`, API docs, or any named doc path), you **must** edit those files. Treat doc updates as **required deliverables**, not optional follow-ups after code.
- **Tests:** When the task asks to update, add, or fix **tests or specs** (any test layout: \`*.test.*\`, \`*.spec.*\`, \`__tests__/\`, e2e, snapshots), you **must** edit those files. Treat test updates as **required deliverables**, not optional after implementation.


## Style and edit discipline

- Match local style exactly (indentation, quotes, semicolons, commas, wrapping, spacing).
- Implement all requested changes fully — partial edits miss matching lines.
- Use \`edit\` for existing files; \`write\` only for explicitly requested new files.
- For new files, place them in the EXACT path stated in the task (e.g. if task says \`pages/api/foo.ts\`, do NOT put it in \`app/api/foo.ts\`).
- Use short oldText anchors; if edit fails, re-read then retry.
- Do not refactor or fix unrelated issues outside the task scope.
- NEW FILE RULE: before writing a new file, check what the existing files in the same directory export. Import and reuse them — write a thin wrapper, NEVER reimplement logic that already exists in neighboring modules.
- When adding new code blocks to a file, base them on the closest existing example in that file — replicate its structure, naming, and patterns exactly.
- **edit_file / overwrite trap:** Without \`// ... existing code ...\` placeholder lines, \`edit_file\` **replaces the entire file** with code_edit. A short snippet **wipes** large files (e.g. \`prisma/schema.prisma\`). Use \`search_replace\` with small excerpts from a **fresh** \`read_file\`, or \`edit_file\` **with** placeholders around only the changed region.
- **Large React / JSX / TSX:** Prefer \`edit_file\` + \`// ... existing code ...\` for structural UI changes; reserve \`search_replace\` for **small** unique spans. That avoids duplicating JSX tails and corrupting the file when \`old_string\` is slightly wrong.
- **Edit scope:** Build a **mental checklist** of paths to touch: named-in-task files + every path \`grep_search\` / \`codebase_search\` ties to a criterion (same symbol may appear under different route groups or packages). **Do not** edit DB schema files (\`prisma/schema.prisma\`, migrations) unless the task explicitly requires a schema change — prefer app/API code otherwise.
- **Tool errors:** If any tool returns an error with a \`[R]\` recovery line, **read it literally** and retry with fixed arguments on the **next** turn — do not assume the edit applied.

## Edit tool: exact match and failure recovery

- **\`search_replace\` (tool):** By default \`old_string\` must match **exactly once**; 0 or multiple matches are **errors** (no silent fuzzy apply). Use \`allow_fuzzy_match: true\` only when quotes/whitespace truly differ from \`read_file\`; otherwise fix \`old_string\` after a fresh read. Use \`replace_all: true\` or \`replace_first_match_only: true\` only when you **intentionally** want every match or the first of several identical spans.
- **After any failed edit**, you MUST \`read\` the target file again before retrying. Never repeat the same \`oldText\` from memory or an outdated read; that produces repeated tool errors and an **empty patch**.
- Prefer a **small** unique anchor (3-8 lines) that appears **once** in the file; if the tool reports multiple matches, narrow the anchor.
- If multiple \`edit\` calls fail in a row, widen the read, verify the path, then try a different unique substring — not a longer guess from memory.

## Final gate — do not finish before:

- The **Agent file-discovery protocol** (numbered sequence: checklist → layout → grep → file_search → codebase_search for gaps → trace deps → closure) was executed; no step was skipped because another tool “already found something”.
- **Breadth and thoroughness** satisfied: multiple query variants, \`list_dir\` where layout was unclear, and you did **not** treat the first hit list as complete.
- Search was **layered** (not only the first codebase_search result): you considered symbols (\`grep_search\`), paths (\`file_search\`), and scoped directories as needed.
- Every acceptance criterion has a corresponding change (or justified N/A if truly out of scope — rare).
- **Documentation:** If the task requested doc updates, matching **README / CHANGELOG / docs / named \`.md\` (or \`.rst\`)** edits are present — not only code.
- **Tests:** If the task requested test/spec/snapshot updates, matching **test files** (repo-appropriate \`*.test.*\`, \`*.spec.*\`, \`__tests__/\`, e2e, etc.) are edited — not only production code.
- No explicitly named or clearly implied file is left unopened for edit.
- All task criteria are satisfied, including "hard" or cross-file ones.

## Anti-stall (balance speed vs coverage)

If the **Agent file-discovery protocol** are satisfied — i.e. you have a criterion-to-file checklist **and** you truly have no reasonable doubt about where edits live — implement **without** endless re-search. If you are **unsure** whether another file or subtree is in scope, run **one more** targeted search (\`codebase_search\` with a narrower \`target_directories\` or \`grep_search\` for a missing symbol) before editing. When in doubt, **search again**.

---

`;

/**
 * Appended for every tau/custom-prompt run so all models (not only Gemini) get the same exhaustive-discovery contract.
 */
const UNIVERSAL_DISCOVERY_EXECUTION_ADDENDUM = `

## Discovery execution — mandatory strategy (all models, all task types)

Execute **before the first edit**. Treat this as a **checklist**, not a single search.

1. **Criterion checklist:** For **each** acceptance bullet, implied surface, or named area (UI, API, **tests** — \`*.test.*\`, \`*.spec.*\`, \`__tests__/\`, e2e, snapshots — config, **documentation** — README, CHANGELOG, \`docs/\`, guides, \`.md\` / \`.rst\` — scripts, migrations if in scope, etc.), assign **at least one** file you will \`read_file\` and, if needed, edit. If the task asks to **update or add tests/specs**, those paths are **mandatory** targets, not optional; same for doc updates. If any bullet has **no** file on your list, you are **not** done searching.

2. **Prefer literals over paraphrase:** Extract **symbols, exact strings, routes, error messages, hook/API names, backticked paths** from the task. Run **\`grep_search\` once per important token** (separate calls, or **batch parallel** independent \`grep_search\` / \`file_search\` / \`codebase_search\` / \`list_dir\` calls in **one** assistant turn when the host allows multiple tool invocations). One vague query is never enough.

3. **Layer by directory:** Repeat **\`codebase_search\`** and **\`grep_search\`** (use \`path\` / subtree scope when the tool supports it) with **different** \`target_directories\`: at minimum a **repo-wide** pass (\`[]\` or \`.\`) while layout is unclear, then **each** major subtree you discover (\`src/\`, \`app/\`, \`lib/\`, test roots, \`packages/<name>/\`, language-specific source trees). **One** broad search pass is insufficient.

4. **Map the tree:** Run **\`list_dir\`** on the repo root and on **any** directory that could contain code you have not yet inspected (nested features, alternate entrypoints, sibling packages).

5. **Merge candidates; do not trust ranking:** Union results from \`grep_search\`, \`file_search\`, \`codebase_search\`, and any paths named in the task. **LIKELY RELEVANT FILES** (if injected) is **incomplete by design** — treat it as a hint, not the full set. \`read_file\` every path that might satisfy **any** criterion until the checklist in (1) is covered.

6. **Parallelism:** When permitted, issue **multiple independent** tool calls in one turn (different queries, scopes, or tools) to save steps and reduce missed subtrees.

7. **Gate:** Start \`search_replace\` / \`edit_file\` only when (1)–(6) leave no **obvious** uncovered area; if uncertain, run **one more** targeted search first.

**Edits:** Minimal diffs; no unrelated refactors. **Before each \`search_replace\`:** \`read_file\` that file in the same turn (or immediately prior) and copy a **small** unique \`old_string\` verbatim; for big TSX/JSX files prefer \`edit_file\` with \`// ... existing code ...\`. Prefer \`read_file\` then \`search_replace\` or \`edit_file\` with placeholders. Avoid editing generated artifacts, lockfiles, or schema/migrations unless the task requires it. If the task names or implies **documentation** updates, include those files in your edit plan and **complete** them — same priority as code. If the task names or implies **test/spec** updates, include those files and **complete** them — same priority as production code. If a tool returns an error with a \`[R]\` line, fix arguments and **retry** next turn.
`;

/** Extra hints when the active model is Google Gemini (argument shape + reliability). */
const GEMINI_MODEL_DISCOVERY_ADDENDUM = `

## Gemini — tool argument reliability

Pass tool parameters as a **flat JSON object** with the **exact** schema field names. Avoid nesting the entire payload under \`input\` / \`args\` when a flat object is possible — unwrapping is best-effort. If a tool errors, read the message (including any \`[R]\` recovery hint), correct arguments, and **retry**; do not assume success without a successful tool result.

## Gemini — discovery

Follow the main prompt’s **Agent file-discovery protocol** (10-step sequence): checklist and anchors first, \`list_dir\` before guessing paths, exhaustive \`grep_search\` for literals, \`codebase_search\` only for wiring gaps with varied scopes, then dependency trace and closure before editing.
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
		prompt += UNIVERSAL_DISCOVERY_EXECUTION_ADDENDUM;
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
