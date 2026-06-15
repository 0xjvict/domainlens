import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { load as loadVec } from 'sqlite-vec';
import type { SchemaCache } from '../types.js';
import { parseFrontmatter, parseTags } from '../utils/frontmatter.js';
import { toSkillFilename } from '../utils/filename.js';

function extractSection(body: string, sectionName: string): string {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`## ${escaped}\\n([\\s\\S]*?)(?=\\n## |\\n---|$)`);
  const match = body.match(regex);
  return match ? match[1].trim() : '';
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8')
) as { version: string };

export function createServer(projectPath: string): McpServer {
  const server = new McpServer(
    { name: 'domainlens', version },
    { capabilities: { tools: {} } },
  );

  server.tool(
    'search_schema',
    'Search database schema for tables and columns. Case-insensitive substring matching.',
    {
      table: z.string().optional(),
      column: z.string().optional(),
    },
    async (args) => {
      const schemaPath = path.join(projectPath, '.domainlens', 'schemas', 'latest.json');

      if (!fs.existsSync(schemaPath)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'No schema found. Run `domainlens discover` first.',
              }),
            },
          ],
        };
      }

      const schema: SchemaCache = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));

      const tableFilter = args.table?.toLowerCase();
      const columnFilter = args.column?.toLowerCase();

      const filtered = schema.tables
        .filter((t) => !tableFilter || t.name.toLowerCase().includes(tableFilter))
        .map((t) => {
          const columns = columnFilter
            ? t.columns.filter((c) => c.name.toLowerCase().includes(columnFilter))
            : t.columns;
          return { ...t, columns };
        })
        .filter((t) => t.columns.length > 0);

      const grouped: Record<string, typeof filtered> = {};
      for (const t of filtered) {
        const db = t.schema;
        if (!grouped[db]) grouped[db] = [];
        grouped[db].push(t);
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(grouped, null, 2) }],
      };
    },
  );

  server.tool(
    'search_semantic',
    'Search domain knowledge using natural language. Queries embeddings via semantic similarity.',
    {
      query: z.string(),
      limit: z.number().optional().default(5),
    },
    async (args) => {
      const dbPath = path.join(projectPath, '.domainlens', 'embeddings.db');

      if (!fs.existsSync(dbPath)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error:
                  'No embeddings found. Run `domainlens discover --embeddings` to generate embeddings first.',
              }),
            },
          ],
        };
      }

      const db = new Database(dbPath);
      loadVec(db);

      try {
        const rowCount = db.prepare('SELECT COUNT(*) AS cnt FROM vec_items').get() as {
          cnt: number;
        };

        if (!rowCount || rowCount.cnt === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error:
                    'No embeddings found. Run `domainlens discover --embeddings` to generate embeddings first.',
                }),
              },
            ],
          };
        }

        const { loadModel } = await import('../embeddings/model.js');
        const model = await loadModel();

        const result = await model(args.query, { pooling: 'mean', normalize: true });
        const float32 = result.data;
        if (!(float32 instanceof Float32Array)) {
          throw new Error(`Expected Float32Array from model output`);
        }
        const queryEmbedding = Buffer.from(float32.buffer);

        const rows = db
          .prepare<[Buffer, number], { source: string; type: string; excerpt: string; score: number }>(
            `SELECT source, type, excerpt, vec_distance_cosine(embedding, ?) AS score
             FROM vec_items
             ORDER BY score ASC
             LIMIT ?`,
          )
          .all(queryEmbedding, args.limit ?? 5);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(rows, null, 2),
            },
          ],
        };
      } finally {
        db.close();
      }
    },
  );

  server.tool(
    'list_skills',
    'List all domain and rules skill files with metadata from frontmatter.',
    {
      type: z.enum(['domain', 'rules']).optional(),
      limit: z.number().optional().default(50),
    },
    async (args) => {
      const skillsDir = path.join(projectPath, 'skills');
      const dirs: string[] = [];

      if (args.type) {
        dirs.push(path.join(skillsDir, args.type));
      } else {
        dirs.push(path.join(skillsDir, 'domain'), path.join(skillsDir, 'rules'));
      }

      const results: { name: string; type: string; tags: string[]; source: string }[] = [];

      for (const dir of dirs) {
        if (!fs.existsSync(dir)) continue;
        for (const file of fs.readdirSync(dir)) {
          if (!file.endsWith('.md')) continue;
          const content = fs.readFileSync(path.join(dir, file), 'utf-8');
          const fm = parseFrontmatter(content);
          results.push({
            name: fm.name || file.replace('.md', ''),
            type: fm.type || path.basename(dir),
            tags: parseTags(fm.tags),
            source: fm.source || 'unknown',
          });
        }
      }

      const limit = args.limit ?? 50;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(results.slice(0, limit), null, 2) }],
      };
    },
  );

  server.tool(
    'get_skill',
    'Get the full Markdown content of a domain or rules skill by name.',
    {
      name: z.string(),
    },
    async (args) => {
      const sanitizedName = toSkillFilename(args.name);
      const searchName = sanitizedName.toLowerCase();
      const skillsDir = path.join(projectPath, 'skills');

      for (const subdir of ['domain', 'rules']) {
        const dir = path.join(skillsDir, subdir);
        if (!fs.existsSync(dir)) continue;
        for (const file of fs.readdirSync(dir)) {
          if (!file.endsWith('.md')) continue;
          const nameWithoutExt = file.replace(/\.md$/, '');
          if (nameWithoutExt.toLowerCase() === searchName) {
            const content = fs.readFileSync(path.join(dir, file), 'utf-8');
            return {
              content: [{ type: 'text' as const, text: content }],
            };
          }
        }
      }

      for (const subdir of ['domain', 'rules']) {
        const dir = path.join(skillsDir, subdir);
        if (!fs.existsSync(dir)) continue;
        for (const file of fs.readdirSync(dir)) {
          if (!file.endsWith('.md')) continue;
          const content = fs.readFileSync(path.join(dir, file), 'utf-8');
          const fm = parseFrontmatter(content);
          if (fm.name && fm.name.toLowerCase() === searchName) {
            return {
              content: [{ type: 'text' as const, text: content }],
            };
          }
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: `Skill '${args.name}' not found. Run 'domainlens discover' to generate skills.`,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    'get_concept',
    'Get a domain concept with frontmatter and parsed sections. Returns structured data or { found: false } if not found.',
    {
      name: z.string(),
    },
    async (args) => {
      const sanitizedName = toSkillFilename(args.name);
      const searchName = sanitizedName.toLowerCase();
      const domainDir = path.join(projectPath, 'skills', 'domain');

      if (!fs.existsSync(domainDir)) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ name: args.name, found: false }) }],
        };
      }

      const parseConceptFile = (file: string) => {
        const content = fs.readFileSync(path.join(domainDir, file), 'utf-8');
        const fm = parseFrontmatter(content);
        const body = content.replace(/^---[\s\S]*?---\n?/, '');

        const sections: Record<string, string> = {};
        for (const sectionName of ['Definition', 'States & Lifecycle', 'Business Rules', 'Related Concepts', 'Common Query Patterns']) {
          const section = extractSection(body, sectionName);
          if (section) {
            sections[sectionName] = section;
          }
        }

        return {
          name: fm.name || file.replace('.md', ''),
          type: fm.type || 'domain',
          source: fm.source || 'unknown',
          tags: parseTags(fm.tags),
          sections,
        };
      };

      for (const file of fs.readdirSync(domainDir)) {
        if (!file.endsWith('.md') || file === 'relations.md') continue;
        const nameWithoutExt = file.replace(/\.md$/, '');
        if (nameWithoutExt.toLowerCase() === searchName) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(parseConceptFile(file), null, 2) }],
          };
        }
      }

      for (const file of fs.readdirSync(domainDir)) {
        if (!file.endsWith('.md') || file === 'relations.md') continue;
        const content = fs.readFileSync(path.join(domainDir, file), 'utf-8');
        const fm = parseFrontmatter(content);
        if (fm.name && fm.name.toLowerCase() === searchName) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(parseConceptFile(file), null, 2) }],
          };
        }
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ name: args.name, found: false }) }],
      };
    },
  );

  server.tool(
    'get_rules_for_concept',
    'Find business rules that reference a given domain concept. Filters by related_concepts in frontmatter.',
    {
      concept: z.string(),
      limit: z.number().optional().default(10),
    },
    async (args) => {
      const businessDir = path.join(projectPath, 'skills', 'rules', 'business');
      const searchConcept = toSkillFilename(args.concept).toLowerCase();

      if (!fs.existsSync(businessDir)) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify([]) }],
        };
      }

      const results: Record<string, unknown>[] = [];

      for (const file of fs.readdirSync(businessDir)) {
        if (!file.endsWith('.md')) continue;
        const content = fs.readFileSync(path.join(businessDir, file), 'utf-8');
        const fm = parseFrontmatter(content);
        const relatedConcepts = parseTags(fm.related_concepts);

        if (!relatedConcepts.some((c) => c.toLowerCase() === searchConcept)) continue;

        const body = content.replace(/^---[\s\S]*?---\n?/, '');
        const sections: Record<string, string> = {};
        for (const sectionName of ['Rule Description', 'Trigger', 'Conditions', 'Effect', 'Where Enforced']) {
          const section = extractSection(body, sectionName);
          if (section) {
            sections[sectionName] = section;
          }
        }

        results.push({
          name: fm.name || file.replace('.md', ''),
          type: fm.type || 'business_rule',
          tags: parseTags(fm.tags),
          source: fm.source || 'unknown',
          related_concepts: relatedConcepts,
          enforced_in: parseTags(fm.enforced_in),
          sections,
        });

        if (results.length >= (args.limit ?? 10)) break;
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
      };
    },
  );

  server.tool(
    'get_relations',
    'Get relations for a specific concept from the knowledge map. Filters relations.md for concept-specific connections.',
    {
      concept: z.string(),
    },
    async (args) => {
      const relationsPath = path.join(projectPath, 'skills', 'domain', 'relations.md');
      const searchConcept = args.concept.toLowerCase();

      if (!fs.existsSync(relationsPath)) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ concept: args.concept, direct_relations: [], cross_concept_rules: [] }, null, 2),
          }],
        };
      }

      const content = fs.readFileSync(relationsPath, 'utf-8');
      const sections = content.split(/\n(?=## )/);

      const result: {
        concept: string;
        direct_relations: string[];
        cross_concept_rules: { name: string; description: string }[];
      } = {
        concept: args.concept,
        direct_relations: [],
        cross_concept_rules: [],
      };

      for (const section of sections) {
        if (section.startsWith('## Concept Relations')) {
          const regex = /### (.+?)\n([\s\S]*?)(?=\n### |\n## |$)/;
          let match;
          while ((match = regex.exec(section)) !== null) {
            const conceptName = match[1].trim();
            if (conceptName.toLowerCase() === searchConcept) {
              result.direct_relations = match[2]
                .split('\n')
                .map((l) => l.replace(/^-\s*/, '').trim())
                .filter((l) => l.length > 0 && !l.startsWith('<!--'));
              break;
            }
          }
        } else if (section.startsWith('## Cross-Concept Rules')) {
          const regex = /### (.+?)\n([\s\S]*?)(?=\n### |\n## |$)/g;
          let match;
          while ((match = regex.exec(section)) !== null) {
            const ruleName = match[1].trim();
            const ruleContent = match[2];
            if (ruleContent.toLowerCase().includes(searchConcept)) {
              const descMatch = ruleContent.match(/\*\*Description:\*\*\s*(.+)/);
              result.cross_concept_rules.push({
                name: ruleName,
                description: descMatch ? descMatch[1].trim() : '',
              });
            }
          }
        }
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  return server;
}

export async function startServer(projectPath: string): Promise<void> {
  const { loadModel } = await import('../embeddings/model.js');
  await loadModel().catch(() => { /* model not cached yet — will load on first search_semantic call */ });

  const server = createServer(projectPath);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
