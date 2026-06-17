# DomainLens

**Camada de conhecimento de domínio para agentes de IA.**

DomainLens extrai o schema do seu banco de dados, regras de negócio, padrões do código-fonte e documentação — e expõe esse conhecimento para agentes de IA (Claude Code, Cursor, GitHub Copilot, etc.) via [MCP](https://modelcontextprotocol.io).

Chega de agente inventando tabelas que não existem ou ignorando o que "cliente churned" significa no seu sistema.

---

## O Problema

Agentes de código modernos frequentemente:

- Alucinam tabelas, colunas ou relacionamentos inexistentes
- Ignoram regras de negócio codificadas no projeto (`CHURN_DAYS = 30`, `scope('premium')`)
- Desconhecem convenções como soft deletes ou padrões de nomenclatura
- Não conseguem responder "onde fica o e-mail do cliente?" sem ler todos os arquivos

Esse conhecimento existe — só está espalhado entre o schema, o código-fonte e a documentação. O DomainLens coleta, estrutura e disponibiliza tudo isso para qualquer agente instantaneamente.

---

## Como Funciona

```
Seu projeto
  ├─ Schema PostgreSQL        ─┐
  ├─ Código-fonte (SQL,        ├─ domainlens discover ──→ skills/*.md + embeddings.db
  │   constantes, enums, ORM) ─┘
  └─ Documentação Markdown    ─┘
                                        ↓
                              domainlens start (servidor MCP)
                                        ↓
                     Claude Code / Cursor / qualquer agente MCP
```

1. **Extrai** — scripts determinísticos coletam sinais do schema, código e docs. Sem alucinação de estrutura por LLM.
2. **Enriquece** — um LLM preenche definições de negócio com base nos sinais detectados. Funciona com OpenRouter, qualquer endpoint compatível com OpenAI, ou sem LLM nenhum (`--no-enrich`).
3. **Indexa** — embeddings são gerados localmente com `all-MiniLM-L6-v2` e armazenados em SQLite.
4. **Serve** — um servidor MCP stdio expõe quatro ferramentas que os agentes podem consultar a qualquer momento.

---

## Início Rápido

```bash
npm install -g domainlens

cd seu-projeto
domainlens init
```

Configure suas credenciais (LLM é opcional — para enriquecimento):

```bash
export DATABASE_URL="postgresql://usuario:senha@localhost:5432/meudb"
export OPENROUTER_API_KEY="sk-or-..."   # ou qualquer nome configurado em llm_key_env
```

Execute a descoberta:

```bash
domainlens discover
```

Configure o seu agente:

```bash
domainlens mcp-config   # imprime o snippet para colar na config do seu agente
```

---

## Ferramentas MCP

Com o servidor rodando, os agentes têm acesso a quatro ferramentas:

| Ferramenta | Descrição |
|------------|-----------|
| `search_schema` | Busca textual determinística no schema do banco. Aceita filtros por `table` e `column`. |
| `search_semantic` | Busca vetorial por similaridade em skills, schema, exemplos SQL e constantes. Retorna excerpts ranqueados. |
| `list_skills` | Lista todas as skills de domínio com metadados. Filtra por `type` (`domain` \| `rules`). |
| `get_skill` | Retorna o conteúdo completo de uma skill pelo nome. |
| `get_concept` | Retorna dados estruturados de um conceito de domínio: frontmatter, definição, estados, regras de negócio e conceitos relacionados. |
| `get_relations` | Retorna relações diretas e regras entre conceitos para um dado conceito do mapa de conhecimento. |
| `get_rules_for_concept` | Encontra todas as regras de negócio que referenciam um dado conceito de domínio. |

Exemplo de interação com o agente:

> "Onde está definido o conceito de churn de cliente?"
> → `search_semantic("churn")` → retorna `skills/domain/churn.md` com a definição de negócio, sinais detectados e exemplos SQL.

---

## Skills

Skills são arquivos Markdown estruturados que descrevem conceitos de domínio e regras. Ficam em `skills/` e são **commitadas no git** — são documentação versionada, não cache.

```markdown
---
name: churn
type: domain
tags: [customer, subscription]
source: ai-generated
last_updated: 2026-06-12
---

## Definition
Um cliente é considerado churned quando `churned_at` não é nulo,
geralmente definido após 30 dias de inatividade (CHURN_DAYS = 30).

## Detected Signals
- Column: `customers.churned_at`
- Constant: `CHURN_DAYS = 30`

## SQL Examples
```sql
SELECT * FROM customers WHERE churned_at IS NOT NULL
```
```

O campo `source` indica ao agente o nível de confiança da definição:

- `auto-generated` — skeleton com sinais detectados, sem definição de negócio ainda
- `ai-generated` — enriquecida por LLM com base em sinais reais do código
- `human` — revisada e editada por um desenvolvedor (maior confiança)

Altere `source` para `human` após revisar uma skill.

---

## Referência de Comandos

| Comando | Descrição |
|---------|-----------|
| `domainlens init` | Inicializa a estrutura `.domainlens/` e o arquivo de configuração |
| `domainlens init --yes` | Pula o wizard e usa os valores padrão (não-interativo) |
| `domainlens discover` | Executa o pipeline completo de extração e geração de skills |
| `domainlens discover --agent` | Usa agente de IA para descobrir conceitos de domínio (substitui scanner + heurísticas) |
| `domainlens discover --embeddings` | Também constrói o índice de busca semântica |
| `domainlens discover --no-enrich` | Pula o enriquecimento LLM, gera apenas skeletons |
| `domainlens discover --dry-run` | Pré-visualiza o que seria escrito sem tocar nos arquivos |
| `domainlens discover --force` | Regenera todas as skills do zero |
| `domainlens discover --relations-only` | Regenera `relations.md` a partir das skills existentes sem re-executar a extração |
| `domainlens watch` | Monitora mudanças de arquivos e atualiza skills incrementalmente |
| `domainlens watch --no-enrich` | Modo watch sem enriquecimento LLM |
| `domainlens start` | Inicia o servidor MCP stdio |
| `domainlens start --project <path>` | Inicia o servidor para um projeto específico |
| `domainlens status` | Exibe estatísticas do projeto (skills, schema, embeddings) |
| `domainlens skills list` | Lista todas as skills geradas |
| `domainlens skills show <nome>` | Exibe o conteúdo completo de uma skill |
| `domainlens mcp-config` | Imprime o snippet MCP para colar na config do seu agente |
| `domainlens models download` | Pré-baixa o modelo de embeddings (~80MB) |

---

## Configuração

O `domainlens init` gera `.domainlens/config.json`:

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

- **`db_url_env`** — nome da variável de ambiente com a connection string do banco. A URL nunca fica neste arquivo.
- **`llm_key_env`** — nome da variável de ambiente com a chave de API do LLM.
- **`llm_model`** — identificador do modelo passado ao LLM. Qualquer modelo suportado pelo endpoint.
- **`llm_base_url`** — *(opcional)* URL base de um endpoint compatível com OpenAI. Padrão: OpenRouter (`https://openrouter.ai/api/v1`). Use para modelos self-hosted ou outros providers.
- **`explorer_model`** — *(opcional)* modelo separado para o passo de descoberta com `--agent`. Usa `llm_model` se não configurado.
- **`code_paths`** — diretórios escaneados para SQL, constantes, enums e modelos ORM.
- **`watch_interval_seconds`** — *(opcional)* intervalo de polling para `domainlens watch`. Padrão: 10 segundos.
- **`agent_strategy`** — *(opcional)* `"single"` ou `"multi"`. Controla se `--agent` usa uma sessão ou sub-sessões paralelas. Padrão: `"single"`.

### O que vai para o git

```
skills/                       ← commite isso (documentação de domínio versionada)
.domainlens/config.json       ← commite isso

# Entradas adicionadas ao .gitignore pelo `init`:
.domainlens/schemas/          ← não commite (cache gerado)
.domainlens/embeddings.db     ← não commite (índice gerado)
```

---

## Suporte a ORM

O DomainLens detecta automaticamente o ORM do projeto e extrai definições de modelos, tipos de campos, relacionamentos e scopes de negócio — sem nenhuma configuração adicional.

| ORM | Detectado via |
|-----|---------------|
| **Prisma** | `prisma/schema.prisma` |
| **Django ORM** | `**/models.py` com `class X(Model)` |
| **Laravel Eloquent** | `app/Models/*.php` com `extends Model` |

Para outros stacks, strings SQL embutidas, constantes de negócio (`CHURN_DAYS = 30`) e enums são extraídos via regex language-agnostic.

---

## Configuração do Agente

### Claude Code

```bash
domainlens mcp-config
```

Cole a saída na config MCP do Claude Code ou no `CLAUDE.md` do projeto.

### Claude Desktop / Cursor

Adicione ao seu arquivo de config MCP:

```json
{
  "mcpServers": {
    "domainlens": {
      "command": "domainlens",
      "args": ["start", "--project", "/caminho/para/seu/projeto"]
    }
  }
}
```

---

## Privacidade

Tudo roda localmente:

- O modelo de embeddings (`all-MiniLM-L6-v2`, ~80MB) fica em cache em `~/.domainlens/models/` e é compartilhado entre projetos.
- Schema, embeddings e skills ficam na sua máquina.
- Credenciais do banco nunca aparecem nos arquivos de config — apenas o nome da variável de ambiente.
- O enriquecimento via LLM envia apenas os *sinais detectados* (nomes de colunas, constantes) para o OpenRouter. Use `--no-enrich` para pular isso completamente.

---

## Requisitos

- Node.js 18+
- PostgreSQL (para extração de schema — opcional, continua sem ele se inacessível)

---

## Licença

MIT
