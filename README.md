# DomainLens

**Domain knowledge layer for AI code agents.**

DomainLens extracts your database schema, business rules, source code patterns, and documentation into a searchable knowledge base — then exposes it to AI agents (Claude Code, Cursor, GitHub Copilot, etc.) via [MCP](https://modelcontextprotocol.io).

Stop your agent from hallucinating tables that don't exist or ignoring what "churned customer" actually means in your system.

---

## The Problem

Modern code agents frequently:

- Hallucinate tables, columns, or relationships that don't exist
- Ignore business rules encoded in your codebase (`CHURN_DAYS = 30`, `scope('premium')`)
- Miss domain conventions like soft deletes or naming patterns
- Can't answer "where is the customer email stored?" without reading every file

That knowledge exists — it's just scattered across your schema, source code, and docs. DomainLens collects it, structures it, and makes it instantly available to any agent.

---

## How It Works

```
Your project
  ├─ PostgreSQL schema       ─┐
  ├─ Source code (SQL,        ├─ domainlens discover ──→ skills/*.md + embeddings.db
  │   constants, enums, ORM) ─┘
  └─ Markdown docs           ─┘
                                        ↓
                              domainlens start (MCP server)
                                        ↓
                     Claude Code / Cursor / any MCP-compatible agent
```

1. **Extract** — deterministic scripts pull signals from your schema, code, and docs. No LLM hallucination of structure.
2. **Enrich** — an LLM fills in business definitions based on detected signals. Works with OpenRouter, any OpenAI-compatible endpoint, or no LLM at all (`--no-enrich`).
3. **Index** — embeddings are built locally with `all-MiniLM-L6-v2` and stored in SQLite.
4. **Serve** — an MCP stdio server exposes four tools agents can query at any time.

---

## Quick Start

```bash
npm install -g domainlens

cd your-project
domainlens init
```

Set your database URL and LLM key (optional — for enrichment):

```bash
export DATABASE_URL="postgresql://user:pass@localhost:5432/mydb"
export OPENROUTER_API_KEY="sk-or-..."   # or any key name you configure in llm_key_env
```

Run discovery:

```bash
domainlens discover
```

Wire up your agent:

```bash
domainlens mcp-config   # prints the snippet to paste into your agent config
```

---

## MCP Tools

Once the server is running, agents have access to four tools:

| Tool | Description |
|------|-------------|
| `search_schema` | Deterministic text search over your database schema. Accepts `table` and `column` filters. |
| `search_semantic` | Vector similarity search across skills, schema, SQL examples, and constants. Returns ranked excerpts. |
| `list_skills` | Lists all domain skills with metadata. Filter by `type` (`domain` \| `rules`). |
| `get_skill` | Returns the full content of a named skill file. |
| `get_concept` | Returns structured data for a domain concept: frontmatter, definition, states, business rules, and related concepts. |
| `get_relations` | Returns direct relations and cross-concept rules for a given concept from the knowledge map. |
| `get_rules_for_concept` | Finds all business rules that reference a given domain concept. |

Example agent interaction:

> "Where is customer churn defined?"
> → `search_semantic("churn")` → returns `skills/domain/churn.md` with the business definition, detected signals, and SQL examples.

---

## Skills

Skills are structured Markdown files that describe domain concepts and rules. They live in `skills/` and are **committed to git** — they are versioned documentation, not cache.

```markdown
---
name: churn
type: domain
tags: [customer, subscription]
source: ai-generated
last_updated: 2026-06-12
---

## Definition
A customer is considered churned when `churned_at` is not null,
typically set after 30 days of inactivity (CHURN_DAYS = 30).

## Detected Signals
- Column: `customers.churned_at`
- Constant: `CHURN_DAYS = 30`

## SQL Examples
```sql
SELECT * FROM customers WHERE churned_at IS NOT NULL
```
```

The `source` field tells the agent how much to trust the definition:

- `auto-generated` — skeleton with detected signals, no LLM definition yet
- `ai-generated` — enriched by LLM based on real code signals
- `human` — reviewed and edited by a developer (highest trust)

Change `source` to `human` after you review a skill.

---

## CLI Reference

| Command | Description |
|---------|-------------|
| `domainlens init` | Initialize `.domainlens/` config and directory structure |
| `domainlens init --yes` | Skip setup wizard and use defaults (non-interactive) |
| `domainlens discover` | Run full extraction and skill generation pipeline |
| `domainlens discover --agent` | Use AI agent to discover domain concepts (replaces scanner + heuristics) |
| `domainlens discover --embeddings` | Also build the semantic search index |
| `domainlens discover --no-enrich` | Skip LLM enrichment, write skeletons only |
| `domainlens discover --dry-run` | Preview what would be written without touching files |
| `domainlens discover --force` | Regenerate all skills from scratch |
| `domainlens discover --relations-only` | Regenerate `relations.md` from existing skills without re-running extraction |
| `domainlens watch` | Watch for file changes and incrementally update skills |
| `domainlens watch --no-enrich` | Watch mode without LLM enrichment |
| `domainlens start` | Start the MCP stdio server |
| `domainlens start --project <path>` | Start the server for a specific project path |
| `domainlens status` | Show project statistics (skills, schema, embeddings) |
| `domainlens skills list` | List all generated skills |
| `domainlens skills show <name>` | Print a skill's full content |
| `domainlens mcp-config` | Print the MCP config snippet for your agent |
| `domainlens models download` | Pre-download the embedding model (~80MB) |

---

## Configuration

`domainlens init` generates `.domainlens/config.json`:

```json
{
  "db_url_env": "DATABASE_URL",
  "llm_key_env": "OPENROUTER_API_KEY",
  "llm_model": "anthropic/claude-haiku-4-5",
  "code_paths": ["src/", "app/"],
  "docs_paths": ["docs/", "README.md"],
  "ignore": ["node_modules", ".git", "dist"]
}
```

- **`db_url_env`** — name of the env var holding your database connection string. The URL itself never goes in this file.
- **`llm_key_env`** — name of the env var holding your LLM API key.
- **`llm_model`** — model identifier passed to the LLM. Any model supported by the endpoint.
- **`llm_base_url`** — *(optional)* base URL for an OpenAI-compatible endpoint. Defaults to OpenRouter (`https://openrouter.ai/api/v1`). Set this to use a self-hosted model or another provider.
- **`explorer_model`** — *(optional)* separate model for the `--agent` discovery pass. Falls back to `llm_model` if not set.
- **`code_paths`** — directories scanned for SQL strings, constants, enums, and ORM models.
- **`watch_interval_seconds`** — *(optional)* polling interval for `domainlens watch`. Defaults to 10 seconds.
- **`agent_strategy`** — *(optional)* `"single"` or `"multi"`. Controls whether `--agent` uses one session or parallel sub-sessions. Defaults to `"single"`.

### What gets committed to git

```
skills/          ← commit this (versioned domain documentation)
.domainlens/config.json  ← commit this

# .gitignore entries added by `init`:
.domainlens/schemas/     ← don't commit (generated cache)
.domainlens/embeddings.db ← don't commit (generated index)
```

---

## ORM Support

DomainLens auto-detects your ORM and extracts model definitions, field types, relationships, and business scopes — without requiring any configuration.

| ORM | Detected via |
|-----|-------------|
| **Prisma** | `prisma/schema.prisma` |
| **Django ORM** | `**/models.py` with `class X(Model)` |
| **Laravel Eloquent** | `app/Models/*.php` with `extends Model` |

Raw SQL strings, business constants (`CHURN_DAYS = 30`), and enums are extracted for all other stacks via language-agnostic regex.

---

## Agent Configuration

### Claude Code

```bash
domainlens mcp-config
```

Paste the output into your Claude Code MCP config or project `CLAUDE.md`.

### Claude Desktop / Cursor

Add to your MCP config file:

```json
{
  "mcpServers": {
    "domainlens": {
      "command": "domainlens",
      "args": ["start", "--project", "/path/to/your/project"]
    }
  }
}
```

---

## Privacy

Everything runs locally:

- The embedding model (`all-MiniLM-L6-v2`, ~80MB) is cached in `~/.domainlens/models/` and shared across projects.
- Schema, embeddings, and skills stay on your machine.
- Database credentials never appear in config files — only the env var name.
- LLM enrichment sends detected *signals* (column names, constants) to OpenRouter. Use `--no-enrich` to skip this entirely.

---

## Requirements

- Node.js 18+
- PostgreSQL (for schema extraction — optional, proceeds without it if unreachable)

---

## License

MIT
