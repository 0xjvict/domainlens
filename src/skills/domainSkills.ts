import fs from 'node:fs';
import path from 'node:path';
import type { DomainLensConfig } from '../types.js';
import type { DomainConcept, Signal } from '../inferrer/heuristics.js';
import { enrichDomainConcept, hasLlmKey } from '../llm/openrouter.js';

export interface SkillGenOptions {
  dryRun?: boolean;
  force?: boolean;
  noEnrich?: boolean;
}

export interface SkillGenResult {
  created: number;
  updated: number;
  enriched: number;
}

export async function generateDomainSkills(
  concepts: DomainConcept[],
  config: DomainLensConfig,
  projectPath: string = process.cwd(),
  options: SkillGenOptions = {}
): Promise<SkillGenResult> {
  const skillsDir = path.join(projectPath, 'skills', 'domain');

  if (!options.dryRun) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  let created = 0;
  let updated = 0;
  let enriched = 0;

  const canEnrich = !options.noEnrich && hasLlmKey(config);
  if (!options.noEnrich && !canEnrich) {
    console.log(`⚠ env var $${config.llm_key_env} not set — falling back to skeleton mode (use --no-enrich to suppress this)`);
  }

  for (const concept of concepts) {
    const skillPath = path.join(skillsDir, `${concept.concept}.md`);
    const exists = fs.existsSync(skillPath);

    if (exists && !options.force) {
      const newSignals = filterNewSignals(concept.signals, skillPath);
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
      let enrichedContent: string;
      let tags: string[] = [];
      let source: string;

      if (concept.definition) {
        enrichedContent = concept.definition;
        source = 'ai-generated';
      } else if (canEnrich) {
        const result = await enrichDomainConcept(concept.concept, concept.signals, config, projectPath);
        if (result) {
          enrichedContent = result.content;
          tags = result.tags;
          source = 'ai-generated';
          enriched++;
        } else {
          enrichedContent = '';
          source = 'auto-generated';
        }
      } else {
        enrichedContent = '';
        source = 'auto-generated';
      }

      const content = buildDomainSkill(concept, enrichedContent, tags, source);

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

function filterNewSignals(signals: Signal[], skillPath: string): Signal[] {
  const existingContent = fs.readFileSync(skillPath, 'utf-8');
  return signals.filter((s) => !existingContent.includes(s.detail));
}

function buildDomainSkill(
  concept: DomainConcept,
  enrichedContent: string,
  tags: string[],
  source: string
): string {
  const today = new Date().toISOString().split('T')[0];

  if (tags.length === 0) {
    tags = deriveTagsFromSignals(concept.signals);
  }

  const sqlExamples = concept.signals.filter((s) => s.type === 'sql_example');

  const lines: string[] = [
    '---',
    `name: ${concept.concept}`,
    `type: domain`,
    `tags: [${tags.join(', ')}]`,
    `source: ${source}`,
    `last_updated: ${today}`,
    '---',
  ];

  if (enrichedContent) {
    lines.push('', enrichedContent);
  } else {
    lines.push(
      '',
      '## Definition',
      '<!-- TODO: fill in the business definition of this concept -->',
      '',
      '## States & Lifecycle',
      '<!-- TODO -->',
      '',
      '## Business Rules',
      '<!-- TODO -->',
      '',
      '## Related Concepts',
      '<!-- TODO -->',
      '',
      '## Common Query Patterns',
      '<!-- TODO -->',
    );
  }

  lines.push('', '## Detected Signals');
  for (const signal of concept.signals.filter((s) => s.type !== 'sql_example')) {
    lines.push(`- ${signal.detail}`);
  }

  if (sqlExamples.length > 0) {
    lines.push('', '## SQL Examples');
    for (const ex of sqlExamples) {
      const sql = ex.detail.replace(/^SQL: `/, '').replace(/`$/, '').replace(/`\.\.\.$/, '...');
      lines.push('```sql', sql, '```');
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

function deriveTagsFromSignals(signals: Signal[]): string[] {
  const tags = new Set<string>();
  for (const signal of signals) {
    if (signal.source) {
      const base = path
        .basename(signal.source)
        .replace(/\.[^.]+$/, '')
        .toLowerCase();
      if (base.length > 2 && !base.includes('.')) {
        tags.add(base);
      }
    }
  }
  return [...tags].slice(0, 3);
}
