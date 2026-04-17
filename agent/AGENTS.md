# Agent instructions (Tau harness)

The tau run compares your diff to a reference using **matched_changed_lines** (see `TAU_SCORING_PREAMBLE` in `packages/coding-agent/src/core/system-prompt.ts`). Surplus lines do not reduce the score; missing reference lines do.

**Canonical behavior** is defined in **`packages/coding-agent/src/core/system-prompt.ts`**: tau scoring preamble, injected task discovery (likely files, criteria count, discovery floor, mechanical hints), optional **Gemini** addendum, `[R]` tool-error recovery, style rules, **Final gate**, and anti-stall guidance. If this file ever disagrees with that prompt, **follow the system prompt**.

This document only adds what the code does not spell out: **Cursor/tau tool names** and a few **wording clarifications**.

---

## Runtime shape (what you actually see)

With a task loaded, the harness typically builds:

`TAU_SCORING_PREAMBLE` → **task discovery block** (from `buildTaskDiscoverySection`) → **task text** → (optional) **Gemini discovery addendum** → project context / date / cwd.

Treat the **injected discovery section** as authoritative for “which files to open first” and breadth signals.

---

## CRITICAL — Coverage protocol (same as system prompt)

**Omitting this loses score on entire files** (tests, client routes, APIs). On multi-criterion or multi-surface tasks you **must**:

1. **Systematic `grep_search`** — Use task literals (symbols, strings, backticked paths, named behaviors) as search queries; open plausible hits.
2. **Layered search** — Repeat with different `target_directories` (client vs admin vs `lib` vs `__tests__` vs API). One broad `codebase_search` is insufficient.
3. **Criterion-to-file checklist** — Map **each** acceptance bullet or named surface to at least one file you will edit. If a bullet names a surface and nothing on your list covers it, keep searching.
4. **Planned edits for every named surface** — Do not stop after the first subtree; expand until every surface the task implies has a file on the checklist, then edit **breadth-first** across them.

Full wording lives under **CRITICAL — Coverage protocol** in `packages/coding-agent/src/core/system-prompt.ts` (`TAU_SCORING_PREAMBLE`).

Also read **`## Breadth and thoroughness`** in the same preamble: vary `grep`/`codebase_search` queries, `list_dir` source roots, and treat injected *LIKELY RELEVANT FILES* as a **hint, not a cap**.

If the repo has **`packages/`** (monorepo), the injected block may include **MONOREPO** rules — follow them; server/core packages are often missed if you only edit one UI package.

**Discovery floor (injected per task):** Expect **at least 4–8+** distinct discovery tool calls before the first edit (higher when there are many acceptance bullets or UI+API+tests). The task block may spell out the exact minimum and a **thoroughness** line — follow it.

---

## Harness tool mapping

Do not assume generic `edit` / `oldText` APIs. This stack uses at least:

| Intent | Tool | Notes |
|--------|------|--------|
| Read | `read_file` | `target_file`; optional line range or `should_read_entire_file` |
| Line-level replace | `search_replace` | `file_path`, `old_string`, `new_string` — copy exact text from `read_file` |
| Region / sketch replace | `edit_file` | `target_file`, `instructions`, `code_edit` — **must** use `// ... existing code ...` (or language-appropriate) placeholders so you do not replace an entire large file with a short snippet |
| Discover | `grep_search`, `file_search`, `codebase_search`, `list_dir` | Layer searches; `grep_search` optional `path` for subtree sweeps; scope `codebase_search` with `target_directories`; large caps — still run multiple calls with varied queries |
| Create new file | Per task + tool schema | Put new files exactly where the task says; follow **NEW FILE RULE** in the system prompt (reuse neighbors, thin wrappers) |

**Overwrite trap:** Without placeholders, `edit_file` can replace the **whole** file — same warning as in `system-prompt.ts` (**Style and edit discipline**). Prefer `search_replace` for small edits, or `edit_file` with explicit placeholder segments.

**`search_replace`:** Use anchors copied from `read_file`; if the harness exposes first-match-only vs replace-all, follow the tool description.

---

## What to do (defer to system prompt for detail)

- **CRITICAL — Coverage protocol** (above): systematic grep + layered search + criterion-to-file checklist; non-optional for multi-surface tasks.
- **Breadth:** Same file — search **more broadly than feels necessary**; multiple phrasings, `list_dir`, repo-wide `codebase_search` when layout is still unclear.
- **Discovery:** Hard constraints + **Discovery floor** + **Final gate** in `system-prompt.ts` — multiple tool types, scoped passes, `grep_search` for task literals until coverage is credible.
- **Execution order:** Breadth across required files before polishing one file (same idea as **Anti-stall** + breadth-first scoring in the prompt).
- **Style:** Match the file’s existing style; misaligned lines score as zero overlap (**Style and edit discipline**).
- **Scope:** Minimal change per criterion; no unrelated refactors, comments-only edits, or “cleanup” (**Hard constraints** / **Style and edit discipline**).
- **Verification:** No tests, builds, linters, formatters, servers, or git unless the harness explicitly allows it (**Hard constraints**).
- **Tool failures:** Read `[R]` lines and retry with corrected arguments on the next turn — do not assume an edit applied.

---

## Task-text clarifications (not duplicated in code)

These are wording traps the prompt does not always repeat:

- **Rename vs delete:** “Remove section X” deletes the block. “Rename X to Y” / “Change labels from X to Y” keeps the structure and updates bindings, text, imports, and tags consistently.
- **Single file, many criteria:** If every bullet maps to one file, walk the file top-to-bottom and satisfy **all** bullets — not only the first section.

---

## Ambiguity

Prefer the **priority ladder** in the task discovery block: acceptance-criteria signal → named paths → sibling/wiring. Prefer **surgical** changes over broad refactors when the system prompt allows either. When a criterion clearly applies but a line is borderline, implementing the criterion is usually safer than skipping (omission loses more than surplus).
