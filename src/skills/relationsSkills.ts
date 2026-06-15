import fs from 'node:fs';
import path from 'node:path';

interface ConceptInfo {
  name: string;
  tags: string[];
  summary: string;
  relatedConcepts: string[];
}

interface RuleInfo {
  name: string;
  tags: string[];
  relatedConcepts: string[];
  description: string;
}

export async function generateRelationsMap(
  projectPath: string = process.cwd(),
  options: { dryRun?: boolean; force?: boolean } = {}
): Promise<boolean> {
  const domainDir = path.join(projectPath, 'skills', 'domain');
  const businessDir = path.join(projectPath, 'skills', 'rules', 'business');
  const relationsPath = path.join(domainDir, 'relations.md');

  const domainFiles = readMdFiles(domainDir).filter((f) => path.basename(f) !== 'relations.md');
  const businessFiles = readMdFiles(businessDir);

  if (domainFiles.length === 0) {
    if (options.dryRun) {
      console.log('[dry-run] No domain skills found — relations.md would be skipped');
    }
    console.log('  No domain skills exist yet — skipping relations generation');
    return false;
  }

  const existingContent = fs.existsSync(relationsPath) ? fs.readFileSync(relationsPath, 'utf-8') : '';
  const existingFm = parseFrontmatter(existingContent);
  if (existingFm.source === 'human') {
    console.log('  relations.md has source: human — skipping regeneration');
    return false;
  }

  const concepts: ConceptInfo[] = domainFiles.map(parseConceptFile).filter(Boolean) as ConceptInfo[];
  const rules: RuleInfo[] = businessFiles.map(parseRuleFile).filter(Boolean) as RuleInfo[];

  const domainMap = buildDomainMapSection(concepts);
  const conceptRelations = buildConceptRelationsSection(concepts, rules);
  const crossConceptRules = buildCrossConceptRulesSection(rules);
  const entryPoints = buildEntryPointsSection(concepts, rules);

  const today = new Date().toISOString().split('T')[0];

  const lines: string[] = [
    '---',
    `name: relations`,
    `type: domain_map`,
    'source: auto-generated',
    `last_updated: ${today}`,
    '---',
    '',
    '# Domain Knowledge Map',
    '',
    '## Domain Map',
    '',
    ...domainMap,
    '',
    '## Concept Relations',
    '',
    ...conceptRelations,
    '',
    '## Cross-Concept Rules',
    '',
    ...crossConceptRules,
    '',
    '## Entry Points',
    '',
    ...entryPoints,
    '',
  ];

  const content = lines.join('\n');

  if (options.dryRun) {
    console.log(`[dry-run] Would write ${relationsPath}`);
    console.log(content);
  } else {
    fs.mkdirSync(path.dirname(relationsPath), { recursive: true });
    fs.writeFileSync(relationsPath, content, 'utf-8');
  }

  return true;
}

function readMdFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.join(dir, f));
}

function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const fm: Record<string, unknown> = {};
  const arrayRe = /^\[([\s\S]*?)\]$/;

  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value: string | string[] = line.slice(colonIdx + 1).trim();

    const arrMatch = value.match(arrayRe);
    if (arrMatch) {
      value = arrMatch[1].split(',').map((s) => s.trim()).filter(Boolean);
    }

    fm[key] = value;
  }

  return fm;
}

function parseConceptFile(filePath: string): ConceptInfo | null {
  const content = fs.readFileSync(filePath, 'utf-8');
  const fm = parseFrontmatter(content);

  const name = String(fm.name ?? '');
  if (!name) return null;

  const tags = Array.isArray(fm.tags) ? fm.tags as string[] : [];

  const body = content.replace(/^---[\s\S]*?---\n?/, '');

  const definition = extractSection(body, 'Definition');
  const summary = definition ? definition.split('\n')[0].trim() : '';

  const relatedSection = extractSection(body, 'Related Concepts');
  const relatedFromContent = parseListSection(relatedSection);

  const relatedConcepts = [...new Set([
    ...relatedFromContent,
    ...relatedFromContent,
  ])];

  return { name, tags, summary, relatedConcepts };
}

function parseRuleFile(filePath: string): RuleInfo | null {
  const content = fs.readFileSync(filePath, 'utf-8');
  const fm = parseFrontmatter(content);

  const name = String(fm.name ?? '');
  if (!name) return null;

  const tags = Array.isArray(fm.tags) ? fm.tags as string[] : [];
  const relatedConcepts = Array.isArray(fm.related_concepts) ? fm.related_concepts as string[] : [];

  const body = content.replace(/^---[\s\S]*?---\n?/, '');
  const descriptionSection = extractSection(body, 'Rule Description');
  const description = descriptionSection
    ? descriptionSection.split('\n')[0].trim()
    : '';

  return { name, tags, relatedConcepts, description };
}

function extractSection(body: string, sectionName: string): string {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`## ${escaped}\\n([\\s\\S]*?)(?=\\n## |\\n---|$)`);
  const match = body.match(regex);
  return match ? match[1].trim() : '';
}

function parseListSection(content: string): string[] {
  if (!content) return [];
  return content
    .split('\n')
    .map((l) => l.replace(/^[-*]\s*/, '').trim())
    .filter((l) => l.length > 0 && !l.startsWith('<!--'));
}

function buildDomainMapSection(concepts: ConceptInfo[]): string[] {
  const lines: string[] = [];
  lines.push('| Concept | Type | Tags | Summary |');
  lines.push('|---------|------|------|---------|');

  const sorted = [...concepts].sort((a, b) => a.name.localeCompare(b.name));
  for (const c of sorted) {
    const tagStr = c.tags.slice(0, 3).join(', ');
    const summary = c.summary.length > 80 ? c.summary.slice(0, 77) + '...' : c.summary;
    lines.push(`| ${c.name} | domain | ${tagStr} | ${summary} |`);
  }

  return lines;
}

function buildConceptRelationsSection(concepts: ConceptInfo[], rules: RuleInfo[]): string[] {
  const lines: string[] = [];

  const sorted = [...concepts].sort((a, b) => a.name.localeCompare(b.name));
  for (const c of sorted) {
    const related: string[] = [...c.relatedConcepts];

    for (const rule of rules) {
      if (rule.relatedConcepts.includes(c.name)) {
        for (const rc of rule.relatedConcepts) {
          if (rc !== c.name && !related.includes(rc)) {
            related.push(rc);
          }
        }
      }
    }

    for (const other of concepts) {
      if (other.name === c.name) continue;
      const sharedTags = c.tags.filter((t) => other.tags.includes(t));
      if (sharedTags.length > 0 && !related.includes(other.name)) {
        related.push(other.name);
      }
    }

    if (related.length > 0) {
      lines.push(`### ${c.name}`);
      for (const r of [...new Set(related)]) {
        lines.push(`- ${r}`);
      }
      lines.push('');
    }
  }

  return lines.length > 0 ? lines : ['_No relations identified yet._'];
}

function buildCrossConceptRulesSection(rules: RuleInfo[]): string[] {
  const lines: string[] = [];
  const crossConcept = rules.filter((r) => r.relatedConcepts.length >= 2);

  if (crossConcept.length === 0) {
    return ['_No cross-concept rules identified yet._'];
  }

  for (const r of crossConcept) {
    lines.push(`### ${r.name}`);
    if (r.description) {
      lines.push(`- **Description:** ${r.description}`);
    }
    lines.push(`- **Related concepts:** ${r.relatedConcepts.join(', ')}`);
    lines.push('');
  }

  return lines;
}

function buildEntryPointsSection(concepts: ConceptInfo[], rules: RuleInfo[]): string[] {
  const connectionCount = new Map<string, number>();

  for (const c of concepts) {
    connectionCount.set(c.name, 0);
  }

  for (const c of concepts) {
    for (const rc of c.relatedConcepts) {
      if (connectionCount.has(rc)) {
        connectionCount.set(rc, (connectionCount.get(rc) ?? 0) + 1);
      }
      connectionCount.set(c.name, (connectionCount.get(c.name) ?? 0) + 1);
    }
  }

  for (const rule of rules) {
    for (const rc of rule.relatedConcepts) {
      if (connectionCount.has(rc)) {
        connectionCount.set(rc, (connectionCount.get(rc) ?? 0) + 1);
      }
    }
  }

  const sorted = [...connectionCount.entries()]
    .sort((a, b) => b[1] - a[1]);

  if (sorted.length === 0) {
    return ['_No entry points identified yet._'];
  }

  const lines: string[] = [
    'The following concepts have the most connections and are good starting points:',
    '',
  ];

  for (const [name, count] of sorted.slice(0, 5)) {
    lines.push(`- **${name}** (${count} connections)`);
  }

  lines.push('');
  return lines;
}
