import fs from 'node:fs';
import path from 'node:path';
import type { DomainLensConfig, BusinessRule } from '../types.js';
import { enrichBusinessRule, hasLlmKey } from '../llm/openrouter.js';
import type { SkillGenOptions, SkillGenResult } from './domainSkills.js';

export async function generateBusinessRulesSkills(
  rules: BusinessRule[],
  config: DomainLensConfig,
  projectPath: string = process.cwd(),
  options: SkillGenOptions = {}
): Promise<SkillGenResult> {
  if (rules.length === 0) {
    return { created: 0, updated: 0, enriched: 0 };
  }

  const skillsDir = path.join(projectPath, 'skills', 'rules', 'business');

  if (!options.dryRun) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  let created = 0;
  let updated = 0;
  let enriched = 0;

  const canEnrich = !options.noEnrich && hasLlmKey(config);

  for (const rule of rules) {
    const skillPath = path.join(skillsDir, `${rule.name}.md`);
    const exists = fs.existsSync(skillPath);

    if (exists && !options.force) {
      const appendContent = buildDetectedChanges(rule);
      if (options.dryRun) {
        console.log(`[dry-run] Would append to ${skillPath}:\n${appendContent}`);
      } else {
        fs.appendFileSync(skillPath, appendContent, 'utf-8');
      }
      updated++;
    } else {
      let enrichedContent: string | null = null;

      if (canEnrich) {
        enrichedContent = await enrichBusinessRule(
          rule.name,
          rule.description,
          rule.trigger,
          rule.conditions,
          rule.effect,
          rule.enforced_in.join(', '),
          rule.related_concepts,
          config,
          projectPath
        );
        if (enrichedContent) {
          enriched++;
        }
      }

      const content = buildBusinessRuleSkill(rule, enrichedContent);
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

function buildBusinessRuleSkill(rule: BusinessRule, enrichedContent: string | null): string {
  const today = new Date().toISOString().split('T')[0];
  const source = enrichedContent ? 'ai-generated' : 'auto-generated';
  const tags = rule.related_concepts.map((c) => c.toLowerCase().replace(/\s+/g, '-'));

  const lines: string[] = [
    '---',
    `name: ${rule.name}`,
    `type: business_rule`,
    `tags: [${tags.join(', ')}]`,
    `source: ${source}`,
    `last_updated: ${today}`,
    `related_concepts: [${rule.related_concepts.join(', ')}]`,
    `enforced_in: [${rule.enforced_in.join(', ')}]`,
    '---',
  ];

  if (enrichedContent) {
    lines.push('', enrichedContent);
  } else {
    lines.push(
      '',
      '## Rule Description',
      rule.description || '<!-- TODO: fill in the rule description -->',
      '',
      '## Trigger',
      rule.trigger || '<!-- TODO -->',
      '',
      '## Conditions',
      ...(rule.conditions.length > 0
        ? rule.conditions.map((c) => `- ${c}`)
        : ['<!-- TODO -->']),
      '',
      '## Effect',
      rule.effect || '<!-- TODO -->',
      '',
      '## Where Enforced',
      ...rule.enforced_in.map((f) => `- ${f}`),
    );
  }

  lines.push('');
  return lines.join('\n');
}

function buildDetectedChanges(rule: BusinessRule): string {
  const today = new Date().toISOString().split('T')[0];
  const lines: string[] = [
    `\n## Detected Changes`,
    `<!-- Appended by domainlens discover on ${today} -->`,
  ];
  for (const f of rule.enforced_in) {
    lines.push(`- Updated enforcement: ${f}`);
  }
  lines.push('');
  return lines.join('\n');
}
