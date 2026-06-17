import fs from 'node:fs';
import path from 'node:path';
import type { DomainLensConfig, SchemaCache } from '../types.js';
import type { Signal, SignalType } from '../inferrer/heuristics.js';
import { buildSchemaSummary } from '../utils/schemaSummary.js';
import { makeClient, hasLlmKey } from './client.js';

export interface MergedConcept {
  concept: string;
  definition?: string;
  signals: Signal[];
  source: 'auto-generated' | 'ai-inferred';
}

interface PreScanInput {
  config: DomainLensConfig;
  schema: SchemaCache | null;
  projectPath: string;
  existingConceptNames: string[];
}

export async function preScanConcepts(input: PreScanInput): Promise<string[]> {
  if (!hasLlmKey(input.config)) return [];

  const fileTree = buildFileTree(input.projectPath, input.config.code_paths, input.config.ignore);
  const schemaSummary = buildSchemaSummary(input.schema);
  const existingConcepts = input.existingConceptNames.join(', ') || '(none)';

  const client = makeClient(input.config);

  const prompt = `You are a domain analyst reviewing a software project.

Given the project structure below and the database schema, identify ALL business
concepts present in this system — including concepts that are NOT directly
represented as a database table (implicit concepts).

Project file tree:
${fileTree}

Database schema (tables and columns):
${schemaSummary}

Already documented concepts (skip these):
${existingConcepts}

Return a JSON array of concept names only. Focus on business concepts
(e.g., "RecurringOrder", "ChurnedCustomer", "PremiumTier"), not technical
infrastructure (e.g., "DatabaseConnection", "HttpMiddleware").

Respond ONLY with a valid JSON array of strings. Example:
["RecurringOrder", "ChurnedCustomer", "PremiumTier", "RefundPolicy"]`;

  try {
    const response = await client.chat.completions.create({
      model: input.config.llm_model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 300,
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return [];

    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) return parsed;
    if (parsed.concepts && Array.isArray(parsed.concepts)) return parsed.concepts;
    if (parsed.names && Array.isArray(parsed.names)) return parsed.names;

    return [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`⚠ LLM pre-scan failed: ${message}`);
    return [];
  }
}

function buildFileTree(projectPath: string, codePaths: string[], ignore: string[]): string {
  const lines: string[] = [];

  for (const codePath of codePaths) {
    const fullPath = path.join(projectPath, codePath);
    if (!fs.existsSync(fullPath)) continue;

    lines.push(`${codePath}/`);
    walkDirectory(fullPath, codePath, ignore, lines, 1, 3);
  }

  return lines.join('\n') || '(empty project)';
}

function walkDirectory(
  dirPath: string,
  relativeBase: string,
  ignore: string[],
  lines: string[],
  depth: number,
  maxDepth: number
): void {
  if (depth > maxDepth) return;

  let entries: string[];
  try {
    entries = fs.readdirSync(dirPath);
  } catch {
    return;
  }

  for (const entry of entries.sort()) {
    if (ignore.some((i) => entry === i || entry.endsWith(i))) continue;

    const fullPath = path.join(dirPath, entry);
    const relativePath = path.join(relativeBase, entry);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      lines.push(`${'  '.repeat(depth)}${entry}/`);
      walkDirectory(fullPath, relativePath, ignore, lines, depth + 1, maxDepth);
    } else {
      const extensions = ['.ts', '.js', '.php', '.py', '.go', '.java', '.rb', '.rs', '.sql'];
      if (extensions.some((ext) => entry.endsWith(ext))) {
        lines.push(`${'  '.repeat(depth)}${entry}`);
      }
    }
  }
}

export function mergeConcepts(
  heuristicConcepts: { concept: string; definition?: string; signals: Signal[] }[],
  llmConceptNames: string[]
): MergedConcept[] {
  const heuristicMap = new Map<string, { concept: string; definition?: string; signals: Signal[] }>();
  for (const c of heuristicConcepts) {
    heuristicMap.set(normalize(c.concept), c);
  }

  const seen = new Set<string>();
  const result: MergedConcept[] = [];

  for (const hc of heuristicConcepts) {
    const key = normalize(hc.concept);
    seen.add(key);
    result.push({ concept: hc.concept, definition: hc.definition, signals: hc.signals, source: 'auto-generated' });
  }

  for (const llmName of llmConceptNames) {
    const key = normalize(llmName);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      concept: llmName,
      signals: [],
      source: 'ai-inferred',
    });
  }

  return result;
}

function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}
