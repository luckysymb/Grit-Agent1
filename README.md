# Grit-Agent1

Fork of the [pi-mono](https://github.com/badlogic/pi-mono) coding agent for **Bittensor subnet 66 (tau)** validation. Tooling matches **Cursor-style** names (`read_file`, `edit_file`, `codebase_search`, …). The tau harness scores **positional line-level** unified diffs; see [`agent/AGENTS.md`](agent/AGENTS.md) for the operating contract and **multi-file / acceptance-criteria** discipline.

## Quick start

```bash
cd agent && npm install && npm run build
```

Primary package: [`agent/packages/coding-agent`](agent/packages/coding-agent) (CLI invoked by solvers).

