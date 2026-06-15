import fs from 'node:fs';
import path from 'node:path';
import type { DomainLensConfig, SchemaCache } from '../types.js';
import type { Signal } from '../inferrer/heuristics.js';
import type { Constant } from '../extractors/codeScanner.js';
import { enrichDomainConcept, hasLlmKey } from '../llm/openrouter.js';
import type { SkillGenOptions, SkillGenResult } from './domainSkills.js';

interface RuleSpec {
  name: string;
  tags: string[];
  ruleSectionHeader: string;
  signals: Signal[];
}

export async function generateRulesSkills(
  schema: SchemaCache | null,
  constants: Constant[],
  config: DomainLensConfig,
  projectPath: string = process.cwd(),
  options: SkillGenOptions = {}
): Promise<SkillGenResult> {
  const skillsDir = path.join(projectPath, 'skills', 'rules', 'technical');

  if (!options.dryRun) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  const rules = buildRuleSpecs(schema, constants);

  let created = 0;
  let updated = 0;
  let enriched = 0;

  const canEnrich = !options.noEnrich && hasLlmKey(config);

  for (const rule of rules) {
    const skillPath = path.join(skillsDir, `${rule.name}.md`);
    const exists = fs.existsSync(skillPath);

    if (exists && !options.force) {
      const newSignals = filterNewSignals(rule.signals, skillPath);
      if (newSignals.length > 0) {
        const appendContent = buildDetectedChanges(newSignals);
        if (options.dryRun) {
          console.log(`[dry-run] Would append to ${skillPath}:\n${appendContent}`);
        } else {
          fs.appendFileSync(skillPath, appendContent, 'utf-8');
        }
        updated++;
      }
    } else {
      let ruleDefinition = `<!-- TODO: fill in the rule definition for ${rule.name} -->`;
      let source = 'auto-generated';

      if (canEnrich && rule.signals.length > 0) {
        const result = await enrichDomainConcept(rule.name, rule.signals, config, projectPath);
        if (result) {
          ruleDefinition = result.content;
          source = 'ai-generated';
          enriched++;
        }
      }

      const content = buildRuleSkill(rule, ruleDefinition, source);

      if (options.dryRun) {
        console.log(`[dry-run] Would write ${skillPath}:\n${content}`);
      } else {
        fs.writeFileSync(skillPath, content, 'utf-8');
      }
      created++;
    }
  }

  return { created, updated, enriched };
}

function buildRuleSpecs(schema: SchemaCache | null, constants: Constant[]): RuleSpec[] {
  const rules: RuleSpec[] = [];

  const softDeleteSignals: Signal[] = [];
  const namingSignals: Signal[] = [];
  const performanceSignals: Signal[] = [];

  if (schema) {
    for (const table of schema.tables) {
      for (const column of table.columns) {
        if (column.name === 'deleted_at' || column.name === 'is_deleted') {
          softDeleteSignals.push({
            type: 'column',
            detail: `Column: \`${table.name}.${column.name}\` — soft-delete pattern detected`,
            source: table.name,
          });
        }

        if (column.name.endsWith('_at') || column.name.endsWith('_date')) {
          namingSignals.push({
            type: 'column',
            detail: `Column: \`${table.name}.${column.name}\` — timestamp naming convention`,
            source: table.name,
          });
        }
      }

      for (const idx of table.indexes) {
        if (idx.columns.length > 0) {
          performanceSignals.push({
            type: 'column',
            detail: `Index: \`${idx.name}\` on ${table.name}(${idx.columns.join(', ')})`,
            source: table.name,
          });
        }
      }
    }
  }

  for (const constant of constants) {
    const nameLower = constant.name.toLowerCase();
    if (nameLower.includes('threshold') || nameLower.includes('limit') || nameLower.includes('max') || nameLower.includes('min')) {
      performanceSignals.push({
        type: 'constant',
        detail: `Constant: \`${constant.name} = ${constant.value}\``,
        source: constant.file,
      });
    }
  }

  rules.push({
    name: 'naming-conventions',
    tags: ['naming', 'conventions', 'database'],
    ruleSectionHeader: '## Rule',
    signals: namingSignals,
  });

  rules.push({
    name: 'soft-delete',
    tags: ['soft-delete', 'database', 'data-retention'],
    ruleSectionHeader: '## Rule',
    signals: softDeleteSignals,
  });

  rules.push({
    name: 'performance',
    tags: ['performance', 'indexes', 'query'],
    ruleSectionHeader: '## Rule',
    signals: performanceSignals,
  });

  return rules;
}

function filterNewSignals(signals: Signal[], skillPath: string): Signal[] {
  const existingContent = fs.readFileSync(skillPath, 'utf-8');
  return signals.filter((s) => !existingContent.includes(s.detail));
}

function buildRuleSkill(rule: RuleSpec, ruleDefinition: string, source: string): string {
  const today = new Date().toISOString().split('T')[0];

  const lines: string[] = [
    '---',
    `name: ${rule.name}`,
    `type: technical_rule`,
    `tags: [${rule.tags.join(', ')}]`,
    `source: ${source}`,
    `last_updated: ${today}`,
    '---',
    '',
    '## Rule',
    ruleDefinition,
  ];

  if (rule.signals.length > 0) {
    lines.push('', '## Detected Signals');
    for (const signal of rule.signals) {
      lines.push(`- ${signal.detail}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

function buildDetectedChanges(newSignals: Signal[]): string {
  const today = new Date().toISOString().split('T')[0];
  const lines = [`\n## Detected Changes\n<!-- Appended by domainlens discover on ${today} -->`];
  for (const signal of newSignals) {
    lines.push(`- ${signal.detail}`);
  }
  lines.push('');
  return lines.join('\n');
}
