import fs from 'node:fs';
import path from 'node:path';
import type { DomainLensConfig, BusinessRule } from '../types.js';
import { makeClient } from '../llm/client.js';

const BUSINESS_KEYWORDS = [
  'must', 'should', 'valid', 'invalid', 'approve', 'reject',
  'allow', 'forbid', 'require', 'eligible', 'qualif', 'permit',
  'grant', 'deny', 'cannot', 'is_allowed', 'is_eligible',
  'threshold', 'limit', 'policy', 'restriction', 'constraint',
  'entitled', 'entitlement', 'maximum', 'minimum', 'cap',
  'ceiling', 'floor', 'banned', 'blocked', 'restricted',
  'only if', 'unless', 'except', 'condition', 'prerequisite',
  'precondition', 'mandatory', 'compulsory', 'optional',
  'waive', 'override', 'overrule', 'escalate', 'notify',
];

const CONDITIONAL_PATTERN = /\b(?:if|else\s+if|switch|case\s+\w+|return\s+\w+\s*\?)\b/gi;
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg',
  '.pdf', '.zip', '.tar', '.gz', '.bin', '.exe',
  '.dll', '.so', '.dylib', '.woff', '.woff2', '.ttf', '.eot',
  '.mp3', '.mp4', '.webm', '.ogg',
]);

export interface BusinessRuleCandidate {
  filePath: string;
  relativePath: string;
  content: string;
  score: number;
}

export function detectCandidates(config: DomainLensConfig, projectPath: string): BusinessRuleCandidate[] {
  const paths = config.rules_paths ?? ['src/services/', 'src/validators/', 'src/policies/'];
  const candidates: BusinessRuleCandidate[] = [];

  for (const rulePath of paths) {
    const fullPath = path.resolve(projectPath, rulePath);
    if (!fs.existsSync(fullPath)) continue;

    walkDirectory(fullPath, config.ignore, projectPath, (filePath, relativePath) => {
      const score = scoreFile(filePath);
      if (score > 0) {
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          candidates.push({ filePath, relativePath, content, score });
        } catch {
          // skip unreadable files
        }
      }
    });
  }

  return candidates.sort((a, b) => b.score - a.score);
}

function walkDirectory(
  dirPath: string,
  ignoreList: string[],
  projectPath: string,
  callback: (filePath: string, relativePath: string) => void
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const relativePath = path.relative(projectPath, fullPath);

    if (ignoreList.some((ig) => relativePath.startsWith(ig) || entry.name === ig)) {
      continue;
    }

    if (entry.isDirectory()) {
      walkDirectory(fullPath, ignoreList, projectPath, callback);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!BINARY_EXTENSIONS.has(ext)) {
        callback(fullPath, relativePath);
      }
    }
  }
}

function scoreFile(filePath: string): number {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return 0;
  }

  if (content.includes('\0') || content.length === 0) return 0;

  const lines = content.split('\n');
  let conditionalCount = 0;
  let businessKeywordCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (CONDITIONAL_PATTERN.test(trimmed)) {
      conditionalCount++;
    }
    const lower = trimmed.toLowerCase();
    for (const kw of BUSINESS_KEYWORDS) {
      if (lower.includes(kw)) {
        businessKeywordCount++;
        break;
      }
    }
  }

  if (conditionalCount < 2) return 0;

  return conditionalCount * businessKeywordCount;
}

function extractKeywords(content: string): string[] {
  const found = new Set<string>();
  const lower = content.toLowerCase();
  for (const kw of BUSINESS_KEYWORDS) {
    if (lower.includes(kw)) {
      found.add(kw);
    }
  }
  return [...found];
}

export async function extractBusinessRules(
  candidates: BusinessRuleCandidate[],
  config: DomainLensConfig,
  batchSize: number = 5
): Promise<BusinessRule[]> {
  const apiKey = process.env[config.llm_key_env];
  if ((!apiKey && !config.llm_base_url) || candidates.length === 0) return [];

  const allRules: BusinessRule[] = [];

  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const batchRules = await extractBatch(batch, config);
    allRules.push(...batchRules);
  }

  return mergeDuplicateRules(allRules);
}

async function extractBatch(
  batch: BusinessRuleCandidate[],
  config: DomainLensConfig
): Promise<BusinessRule[]> {
  const fileSummaries = batch
    .map((c) => {
      const keywords = extractKeywords(c.content);
      const lines = c.content.split('\n');
      const conditionalLines: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (CONDITIONAL_PATTERN.test(lines[i])) {
          const start = Math.max(0, i - 1);
          const end = Math.min(lines.length, i + 4);
          const context = lines.slice(start, end).map((l) => l.trim()).filter(Boolean).join('\n  ');
          conditionalLines.push(`  Line ${i + 1}: ${context}`);
        }
      }
      return {
        file: c.relativePath,
        keywords,
        conditionals: conditionalLines.slice(0, 15),
      };
    });

  const client = makeClient(config);

  const prompt = `You are a business analyst extracting business rules from source code.

For each file below, identify any BUSINESS RULES encoded in the code. A business rule is a
statement that defines or constrains some aspect of the business. Look for:
- Validation logic (what is/is not allowed)
- Approval/rejection workflows
- Eligibility checks
- Pricing or fee calculations
- Threshold enforcement
- Policy restrictions
- Conditional flows that encode business decisions

Return a JSON object with a "rules" array. Each rule must have:
- name: a short kebab-case identifier (e.g., "max-credit-limit")
- description: 1 sentence explaining the rule
- trigger: when this rule applies
- conditions: array of strings describing conditions
- effect: what happens when conditions are met
- enforced_in: array with the file path(s) where this rule is found
- related_concepts: array of domain concept names this rule relates to

File data:
${JSON.stringify(fileSummaries, null, 2)}

Respond ONLY with valid JSON in this format:
{"rules": [{"name": "...", "description": "...", "trigger": "...", "conditions": ["..."], "effect": "...", "enforced_in": ["..."], "related_concepts": ["..."]}]}`;

  try {
    const response = await client.chat.completions.create({
      model: config.llm_model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2000,
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return [];

    const parsed = JSON.parse(content);
    const rules = parsed.rules ?? parsed;
    if (!Array.isArray(rules)) return [];

    return rules.map(normalizeBusinessRule);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`⚠ Business rule batch extraction failed: ${message}`);
    return [];
  }
}

function normalizeBusinessRule(raw: Record<string, unknown>): BusinessRule {
  return {
    name: String(raw.name ?? 'unnamed-rule'),
    description: String(raw.description ?? ''),
    trigger: String(raw.trigger ?? ''),
    conditions: Array.isArray(raw.conditions) ? raw.conditions.map(String) : [],
    effect: String(raw.effect ?? ''),
    enforced_in: Array.isArray(raw.enforced_in) ? raw.enforced_in.map(String) : [],
    related_concepts: Array.isArray(raw.related_concepts) ? raw.related_concepts.map(String) : [],
  };
}

function mergeDuplicateRules(rules: BusinessRule[]): BusinessRule[] {
  const map = new Map<string, BusinessRule>();

  for (const rule of rules) {
    const key = rule.name.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const existing = map.get(key);
    if (existing) {
      const seen = new Set(existing.enforced_in);
      for (const f of rule.enforced_in) {
        if (!seen.has(f)) {
          existing.enforced_in.push(f);
          seen.add(f);
        }
      }
    } else {
      map.set(key, { ...rule });
    }
  }

  return [...map.values()];
}
