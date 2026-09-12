# Agent memory — hands-on spikes (2026-09-09)

Companion to [`README.md`](README.md). Everything here ran in an isolated scratchpad (own venv, own Ollama on `127.0.0.1:11435`, own Docker container on `127.0.0.1:18283`). Nothing touched `:3100`, `~/.autonomos`, or the repo. No cloud API key was available, so every spike is **fully local** — which is itself a finding: it shows what each option can do with zero external dependencies.

Local stack: Ollama with `nomic-embed-text` (274 MB, 768-dim) for embeddings and `qwen2:7b` (4.4 GB) as the extraction LLM. Apple Silicon laptop.

## 1. The organic corpus (what Claude Code already wrote)

Measured on Terry's real Claude Code auto-memory directory for this repo, `~/.claude/projects/-Users-aterrylu-workspace-autonomOS/memory/`, read-only:

| Metric | Value |
|---|---|
| Fact files | 134 (+ `MEMORY.md` index) |
| Size on disk | 704 KB |
| `MEMORY.md` index | 129 lines, 19 KB, ~4.8k tokens — loaded into **every** Claude Code session in this cwd |
| Distinct writer sessions (`originSessionId`) | 44 |
| Orphans (file exists, not in index) | 5 |
| Index entries with no file | 0 |
| Type histogram | 75 project, 58 feedback, 1 reference (every file carries a type) |
| Oldest / newest file | 2026-03-27 / 2026-09-09 |
| Memory dirs across all projects on this box | 11 (one has 135 files, the next 22, four are empty temp-cwd dirs from test spawns) |

During this evaluation the index changed on disk mid-session: another running fleet agent appended a line. So the directory is **already a concurrent, multi-writer, fleet-shared store** for every Claude Code agent whose cwd is the main checkout — with no locking, no attribution beyond a session UUID, and a drifting index.

Other fleet-shared knowledge that exists organically: `CLAUDE.md` (31 KB, ~7.8k tokens, injected every session), `docs/DECISIONS.md` (96 ADRs, 463 KB — far too large to inject; retrieved by grep when an agent thinks to look), `docs/RESEARCH.md`, and TeamLead relaying Terry's rulings by message.

## 2. Custom path: sqlite-vec + FTS5 hybrid over the real corpus

Script: `hybrid_spike.py` (Python, `sqlite-vec` 0.1.9, SQLite FTS5, Ollama embeddings). Indexed all 135 files as `name + description + first 1500 chars of body`.

| Metric | Value |
|---|---|
| Embed 135 docs | 3.1 s total, 23 ms/doc |
| Index size | 3.7 MB (vectors dominate; FTS alone would be ~300 KB) |
| Query latency (BM25 + vector + RRF fusion) | 36–42 ms |

Eight realistic natural-language queries with a known gold file:

| Query | BM25 top-1 | Vector top-1 | Gold in top-3? |
|---|---|---|---|
| which port must I never bind | ✅ gold | ✅ gold | all three methods |
| how do I make nox review the PR again | ✗ (gold at #3) | ✅ gold | all three |
| codex unread badge stuck at zero | ✅ | ✅ | all three |
| what is the merge policy for PRs | ✗ (gold at #3) | ✅ | all three |
| focus tests pass in jsdom but fail in the browser | ✅ | ✅ | all three |
| how do we deploy to the remote box | ✅ | ✅ | all three |
| agents are killed when I pkill by flag | ✅ | ✅ | all three |
| terminal text is huge after switching displays | ✅ | ✅ | all three |

**Top-3 hit rate: BM25 8/8, vector 8/8, hybrid 8/8. Top-1: BM25 6/8, vector 8/8.**

Reading: at this corpus size and style (descriptive slugs + a one-line `description` in frontmatter), keyword search is *almost* enough and embeddings are a precision upgrade, not a requirement. A v1 custom memory can ship on FTS5 alone with zero model dependency, and add a local embedder later behind the same `recall` tool. The whole retrieval layer is ~120 lines of code.

## 3. mem0 OSS (v2.0.20), fully local

Script: `mem0_spike.py` / `mem0_search.py`. Config: Ollama LLM `qwen2:7b`, Ollama embedder, Qdrant in-process on-disk store, history SQLite in scratchpad. Six autonomOS facts added with `user_id="fleet"`, `agent_id="MemoryResearch"`.

| Metric | Value |
|---|---|
| Install | `uv pip install mem0ai ollama` (the `ollama` client is an undeclared extra — first run crashed with `ImportError`) |
| First `add` | 23.9 s (model cold-load) |
| Subsequent `add` | 1.4–2.5 s each (two LLM calls per add: extract, then ADD/UPDATE/DELETE decision) |
| `search` | 0.05–0.11 s |
| Memories produced from 6 adds | 9 (two facts were split into multiple memories; two near-duplicates appeared) |
| API drift | v2 rejects `search(query, user_id=…)`; requires `filters={"user_id": …}` — the README snippets I'd seen were stale |

What extraction did to the facts (verbatim):

- Input: *"Never bind, tunnel, or serve on local port 3100 — Terry's live autonomOS server runs there."*
  Stored: *"User advises against binding, tunneling, or serving on local port 3100 due to Terry's live autonomOS server usage."*
- Input: *"Always squash-merge PRs; never admin-merge, wait for CI."*
  Stored twice: *"User recommends always squashing PRs and waiting for CI before merging, never performing an admin merge."* and *"User emphasizes the importance of always squashing pull requests (PRs) and waiting for continuous integration…"*
- Contradiction test — added *"Actually prod moved back to pm2 last week; pm2 list should NOT be empty."* Result: `event: ADD`. The original *"transitioned from pm2 to launchd"* memory was **not** updated or deleted; both now coexist and `search("is pm2 supposed to be empty")` returns the stale one first (score 0.851).

Reading: the pipeline works offline, and search is fast. But the value of mem0 *is* the LLM extraction/consolidation step, and with a local 7B model that step rewrote imperative rules into third-person paraphrase, duplicated, and failed the one consolidation that matters (update-on-contradiction). A frontier model would do better — at a per-write API cost and a cloud round-trip on every `remember`. For a corpus of standing rules whose exact wording matters ("never bind :3100"), paraphrase is a liability, not a feature.

## 4. basic-memory (v0.22.1) over MCP, no API key

Script: `bm_spike.py` — drove `basic-memory mcp` (stdio) with the Python MCP client, `HOME` redirected to the scratchpad.

| Metric | Value |
|---|---|
| Tools exposed | 23 (write_note, read_note, search_notes, build_context, recent_activity, canvas, cloud_info, release_notes, …) |
| Init | 4.0 s on first run — it **downloaded an ONNX embedding model** (`qdrant/bge-small-en-v1.5-onnx-q`) from Hugging Face into `~/.basic-memory/fastembed_cache/`, plus wrote to `~/Library/Application Support/{fastmcp,Microsoft/DeveloperTools/.onnxruntime}` and `~/.cache/huggingface` |
| write_note / read_note / search_notes | 0.04–0.12 s |
| Search hit | *"which port must never be bound"* → the right note, score 0.68 |
| On-disk format | One markdown file per note with YAML frontmatter (`title`, `type`, `permalink`, `tags`); bullet lines like `- [rule] never bind port 3100 #ops` become typed **observations** and `[[wikilinks]]` become **relations**; a SQLite index sits beside the vault |

Reading: closest existing OSS to "the custom path, done by someone else". Markdown-first, Obsidian-compatible, provider-neutral via MCP, no key required. Costs: a Python/uv runtime per agent process, a surprise model download and HOME writes on first run, 23 tools in every agent's tool list (Codex and Gemini would prompt for each unless allowlisted), a `cloud_info` upsell tool, and a project model (one vault = one "project") that doesn't map to agent identity without convention. FastMCP 3.x is a moving target (it nagged about 4.0.3 during the run).

## 5. Reference MCP knowledge-graph memory server (`@modelcontextprotocol/server-memory`)

Script: `refmem_spike.py`. Tools: `create_entities`, `create_relations`, `add_observations`, `delete_*`, `read_graph`, `search_nodes`, `open_nodes`. Storage: one JSONL file (`MEMORY_FILE_PATH`).

- `search_nodes("port")` → found the entity. `search_nodes("which port must I never bind")` → **empty**. Search is a case-insensitive substring match over the whole query string, so anything phrased as a question misses.
- No scoping (one graph per file), no attribution, no timestamps.

Reading: a demo, not a product. Useful only as evidence that "an MCP memory server" is ~200 lines when it does nothing clever.

## 6. Letta server (Docker `letta/letta:latest`, 1.1 GB)

Booted with the documented Postgres volume + `OLLAMA_BASE_URL`. The container exited with code 64 and this banner:

> The retired Python Letta server is end-of-life and this image now contains Letta Code. This container still uses the old /var/lib/postgresql/data mount, which is not supported by the current App Server… follow the current self-hosting guide: https://docs.letta.com/self-hosting/

The current guide describes **Letta Code** (an `npm` CLI coding agent) plus an **App Server** (port 4500, state under `/root/.letta`, `LETTA_APP_SERVER_TOKEN`) deployed from a separate `letta-app-server-deployment` repo. That is an agent *runtime* with memory inside it, not a memory service for external agents. See the landscape notes for what survives of the memory-block model.

## 7. What the spikes settle

1. **Retrieval is not the hard part.** FTS5 over well-named markdown files already hits 8/8 on the real corpus; a local embedder adds top-1 precision for ~4 MB and 3 s of indexing. No cloud dependency is needed for recall.
2. **LLM extraction is the expensive, fragile part**, and it is the *only* thing the "memory platform" products add over a file store. With a weak model it paraphrases, duplicates and misses contradictions; with a strong model it costs an API call per write and a cloud round-trip. For rules whose wording is load-bearing, the agent's own summarization at write time (what Claude Code does today) is at least as good.
3. **Provider-neutral access via MCP is trivial for every option** — but each extra tool in the list is a Codex/Gemini approval prompt unless pre-approved, which argues for 2–3 tools, not 23.
4. **Letta is out** as a memory backend for external agents; the OSS server that would have made that possible is EOL.

## Cleanup

The isolated Ollama was stopped by PID, the Letta container and its 1.1 GB image were removed, and the scratchpad venv is session-local. The only residue is the pulled `nomic-embed-text` model in `~/.ollama/models` (274 MB), removable with `ollama rm nomic-embed-text`.
