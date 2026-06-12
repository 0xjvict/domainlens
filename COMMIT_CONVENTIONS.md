# Commit Conventions

This project follows [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).

## Format

```
<type>(<optional scope>): <description>

[optional body]

[optional footer(s)]
```

## Types

| Type | Use for |
|------|---------|
| `feat` | New feature or capability |
| `fix` | Bug fix |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `test` | Adding or updating tests |
| `docs` | Documentation only |
| `chore` | Build, tooling, or dependency changes |
| `perf` | Performance improvements |

## Rules

- Use the **imperative mood** in the description: "add feature" not "added feature".
- Keep the first line under **72 characters**.
- Do **not** include Story IDs, ticket numbers, or PRD references in the commit message.
- Do **not** add `Co-Authored-By` lines or any attribution trailers.
- Do **not** include any text that identifies the commit as AI-generated.

## Examples

```
feat: add agent runner with tool use loop

fix: prevent double-embedding on incremental update

refactor: extract schema normalization into helper

chore: upgrade @huggingface/transformers to v4
```
