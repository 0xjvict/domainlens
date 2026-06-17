import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import type { DomainLensConfig } from '../types.js';
import type { Signal } from '../inferrer/heuristics.js';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

export function hasLlmKey(config: DomainLensConfig): boolean {
  return Boolean(process.env[config.llm_key_env]) || Boolean(config.llm_base_url);
}

export function makeClient(config: DomainLensConfig): OpenAI {
  return new OpenAI({
    baseURL: config.llm_base_url ?? OPENROUTER_BASE,
    apiKey: process.env[config.llm_key_env] ?? 'no-key',
  });
}

function getProjectContext(config: DomainLensConfig, projectPath: string): string {
  const contexts: string[] = [];

  if (config.db_type) {
    contexts.push(`Database: ${config.db_type}`);
  }

  const pkgPath = path.join(projectPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const stack: string[] = [];
      if (deps.react) stack.push('React');
      if (deps.next) stack.push('Next.js');
      if (deps.express) stack.push('Express');
      if (deps['@prisma/client']) stack.push('Prisma');
      if (deps.typeorm) stack.push('TypeORM');
      if (deps.sequelize) stack.push('Sequelize');
      if (deps.django) stack.push('Django');
      if (deps.laravel) stack.push('Laravel');
      if (stack.length > 0) contexts.push(`Stack: ${stack.join(', ')}`);
    } catch {
      // ignore
    }
  }

  return contexts.length > 0 ? contexts.join('; ') : 'unknown';
}

export interface DomainEnrichResult {
  content: string;
  tags: string[];
}

export async function enrichDomainConcept(
  concept: string,
  signals: Signal[],
  config: DomainLensConfig,
  projectPath: string = process.cwd()
): Promise<DomainEnrichResult | null> {
  if (!hasLlmKey(config)) return null;

  const projectContext = getProjectContext(config, projectPath);
  const signalSummary = signals
    .map((s) => `- [${s.type}] ${s.detail}`)
    .join('\n');

  const client = makeClient(config);

  const prompt = `You are a domain knowledge expert analyzing a software project.

Project context: ${projectContext}

Based ONLY on the signals detected below, document the domain concept "${concept}" using this EXACT structure (keep all section headers):

## Definition
[2-3 sentences explaining the business meaning in this specific project]

## States & Lifecycle
[Known states and what each transition means. If none detected: "Not identified."]

## Business Rules
[Inferred business rules as bullet points. If none detected: "Not identified."]

## Related Concepts
[Related entities/concepts found in the signals]

## Common Query Patterns
[Typical ways this concept is queried or filtered, with SQL if found in signals]

Detected signals:
${signalSummary}

Rules:
- Be specific to THIS project, not generic.
- Do not invent information not present in the signals.
- Keep all section headers exactly as shown above.
- Do not add extra sections.
- Suggest 3-5 domain tags (comma-separated) at the end, prefixed with "Tags:".`;

  try {
    const response = await client.chat.completions.create({
      model: config.llm_model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1500,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return null;

    return parseDomainEnrichResult(content.trim());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`⚠ LLM enrichment failed for "${concept}": ${message}`);
    return null;
  }
}

export async function enrichBusinessRule(
  ruleName: string,
  description: string,
  trigger: string,
  conditions: string[],
  effect: string,
  enforcedIn: string,
  relatedConcepts: string[],
  config: DomainLensConfig,
  projectPath: string = process.cwd()
): Promise<string | null> {
  if (!hasLlmKey(config)) return null;

  const projectContext = getProjectContext(config, projectPath);
  const client = makeClient(config);

  const ruleData = JSON.stringify({
    name: ruleName,
    description,
    trigger,
    conditions,
    effect,
    enforced_in: enforcedIn,
    related_concepts: relatedConcepts,
  }, null, 2);

  const prompt = `You are a business analyst documenting a business rule for a software project.

Project context: ${projectContext}

Using the extracted data below, document the business rule "${ruleName}" with this EXACT structure:

## Rule Description
[What this rule enforces in business terms — 1-2 sentences]

## Trigger
[When does this rule apply?]

## Conditions
[Bullet list of conditions that must be met]

## Effect
[What happens when this rule is triggered?]

## Where Enforced
[In code (file and method), in database (constraint name), or both]

Extracted data:
${ruleData}

Keep all section headers exactly as shown. Do not add extra sections.`;

  try {
    const response = await client.chat.completions.create({
      model: config.llm_model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1500,
    });

    const content = response.choices[0]?.message?.content;
    return content ? content.trim() : null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`⚠ LLM enrichment failed for business rule "${ruleName}": ${message}`);
    return null;
  }
}

function parseDomainEnrichResult(raw: string): DomainEnrichResult {
  const tagsLine = raw.split('\n').find((l) => l.trim().startsWith('Tags:'));
  let tags: string[] = [];
  let content = raw;

  if (tagsLine) {
    const tagsStr = tagsLine.replace('Tags:', '').trim();
    tags = tagsStr
      .split(',')
      .map((t) => t.trim().toLowerCase().replace(/\s+/g, '-'))
      .filter((t) => t.length > 0);
    content = raw.replace(tagsLine, '').trim();
  }

  return { content, tags };
}
