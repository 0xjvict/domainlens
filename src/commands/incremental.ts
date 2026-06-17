import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { DomainLensConfig } from '../types.js';
import type { Signal } from '../inferrer/heuristics.js';
import { readFileConceptMap } from '../utils/fileConceptMap.js';
import { parseFrontmatter, parseTags } from '../utils/frontmatter.js';
import { enrichDomainConcept, enrichBusinessRule, hasLlmKey } from '../llm/client.js';
import { generateRelationsMap } from '../skills/relationsSkills.js';

interface ChangedFile {
  path: string;
  status: 'modified' | 'added' | 'deleted';
}

interface AffectedConcept {
  name: string;
  type: 'domain' | 'business_rule';
  sourceFiles: string[];
  deleted: boolean;
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
    .map((l) => l.replace(/^-\s*/, '').trim())
    .filter((l) => l.length > 0 && !l.startsWith('<!--'));
}

function detectChangedFiles(projectPath: string): ChangedFile[] {
  try {
    const stdout = execSync('git rev-parse --show-toplevel', {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const root = path.resolve(stdout.trim());

    if (path.resolve(projectPath) !== root) {
      console.log('  ⚠ Git root differs from project path — incremental rebuild requires projectPath to be the git root. Run `domainlens discover` manually.');
      return [];
    }

    const modified = execSync('git diff HEAD --name-only', {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((f) => ({ path: f, status: 'modified' as const }));

    const untracked = execSync('git ls-files --others --exclude-standard', {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((f) => ({ path: f, status: 'added' as const }));

    const allFiles = new Map<string, ChangedFile>();
    for (const f of modified) allFiles.set(f.path, f);
    for (const f of untracked) {
      if (!allFiles.has(f.path)) allFiles.set(f.path, f);
    }

    return [...allFiles.values()];
  } catch {
    return [];
  }
}

function isGitAvailable(projectPath: string): boolean {
  try {
    execSync('git --version', { encoding: 'utf-8', stdio: 'ignore' });
    execSync('git rev-parse --git-dir', {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function findAffectedConcepts(
  changedFiles: ChangedFile[],
  projectPath: string
): AffectedConcept[] {
  const map = readFileConceptMap(projectPath);
  const concepts = new Map<string, AffectedConcept>();
  const changedPaths = new Set(changedFiles.map((f) => f.path));
  const deletedPaths = new Set(
    changedFiles.filter((f) => f.status === 'deleted').map((f) => f.path)
  );

  for (const [filePath, entry] of Object.entries(map.files)) {
    if (!changedPaths.has(filePath)) continue;
    for (const c of entry.concepts) {
      if (c.type !== 'domain' && c.type !== 'business_rule') continue;
      const key = `${c.name}:${c.type}`;
      if (!concepts.has(key)) {
        concepts.set(key, {
          name: c.name,
          type: c.type as 'domain' | 'business_rule',
          sourceFiles: [],
          deleted: false,
        });
      }
      const ac = concepts.get(key)!;
      ac.sourceFiles.push(filePath);
      if (deletedPaths.has(filePath)) ac.deleted = true;
    }
  }

  return [...concepts.values()];
}

function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function replaceOrAppendSection(filePath: string, newSection: string): void {
  const existing = readFileSafe(filePath);
  if (existing === null) return;

  const idx = existing.indexOf('\n## Detected Changes');
  if (idx === -1) {
    fs.appendFileSync(filePath, newSection, 'utf-8');
    return;
  }

  const nextSection = existing.indexOf('\n## ', idx + 1);
  const end = nextSection === -1 ? existing.length : nextSection;
  const before = existing.slice(0, idx);
  const after = existing.slice(end);
  fs.writeFileSync(filePath, before + newSection + after, 'utf-8');
}

function appendDetectedChanges(filePath: string, content: string, label: string): void {
  const today = new Date().toISOString().split('T')[0];
  const lines: string[] = [];
  lines.push('');
  lines.push('## Detected Changes');
  lines.push(`<!-- ${label} on ${today} -->`);
  lines.push(content);
  lines.push('');
  replaceOrAppendSection(filePath, lines.join('\n'));
}

function appendDeletedSource(filePath: string): void {
  const today = new Date().toISOString().split('T')[0];
  const lines: string[] = [];
  lines.push('');
  lines.push('## Detected Changes');
  lines.push(`<!-- source file deleted on ${today} -->`);
  lines.push('- Source file deleted — this concept may need manual review');
  lines.push('');
  replaceOrAppendSection(filePath, lines.join('\n'));
}

export async function runIncrementalRebuild(
  projectPath: string,
  config: DomainLensConfig,
  options: { noEnrich?: boolean; dryRun?: boolean; embeddings?: boolean } = {}
): Promise<boolean> {
  if (!isGitAvailable(projectPath)) {
    console.log('  ⚠ Git is not available in this environment.');
    console.log('    Incremental rebuild requires git. Run `domainlens discover` for a full re-scan.');
    return false;
  }

  const changedFiles = detectChangedFiles(projectPath);
  if (changedFiles.length === 0) {
    console.log('  No changes detected.');
    return false;
  }

  const affectedConcepts = findAffectedConcepts(changedFiles, projectPath);
  if (affectedConcepts.length > 0) {
    console.log(`  ${changedFiles.length} file(s) changed, ${affectedConcepts.length} concept(s) affected`);
    for (const c of affectedConcepts) {
      for (const sf of c.sourceFiles) {
        const deleted = c.deleted && c.sourceFiles.some((f) => {
          const cf = changedFiles.find((cf) => cf.path === f);
          return cf?.status === 'deleted';
        });
        console.log(`    ${deleted ? '✗' : '~'} ${sf} → ${c.name} (${c.type})`);
      }
    }
  } else {
    console.log(`  ${changedFiles.length} file(s) changed — no concepts affected`);
    return false;
  }

  const canEnrich = !options.noEnrich && hasLlmKey(config);
  let anyUpdated = false;

  for (const ac of affectedConcepts) {
    if (ac.deleted) {
      console.log(`    ⚠ Source file deleted for concept: ${ac.name}`);
      anyUpdated = true;
      continue;
    }

    if (!canEnrich) {
      console.log(`    → ${ac.name} (${ac.type}) — skipped (no LLM key or --no-enrich)`);
      continue;
    }

    if (ac.type === 'domain') {
      console.log(`    → ${ac.name} (domain) — re-enriching`);
      if (options.dryRun) {
        console.log(`      [dry-run] Would update skills/domain/${ac.name}.md`);
        continue;
      }
      const skillPath = path.join(projectPath, 'skills', 'domain', `${ac.name}.md`);
      const skillContent = readFileSafe(skillPath);
      if (!skillContent) {
        console.log(`      ⚠ Skill file not found: ${skillPath}`);
        continue;
      }

      const signals = ac.sourceFiles.map((file) => ({
        type: 'doc_section' as const,
        detail: `Related file updated: ${file}`,
        source: file,
      })) as Signal[];

      const result = await enrichDomainConcept(ac.name, signals, config, projectPath);
      if (result) {
        appendDetectedChanges(skillPath, result.content, 'Re-enriched by incremental rebuild');
        console.log(`      ✓ Updated`);
        anyUpdated = true;
      } else {
        console.log(`      ⚠ Enrichment failed`);
      }
    } else if (ac.type === 'business_rule') {
      console.log(`    → ${ac.name} (business_rule) — re-enriching`);
      if (options.dryRun) {
        console.log(`      [dry-run] Would update skills/rules/business/${ac.name}.md`);
        continue;
      }
      const skillPath = path.join(projectPath, 'skills', 'rules', 'business', `${ac.name}.md`);
      const skillContent = readFileSafe(skillPath);
      if (!skillContent) {
        console.log(`      ⚠ Skill file not found: ${skillPath}`);
        continue;
      }

      const fm = parseFrontmatter(skillContent);
      const body = skillContent.replace(/^---[\s\S]*?---\n?/, '');
      const description = extractSection(body, 'Rule Description');
      const trigger = extractSection(body, 'Trigger');
      const conditions = parseListSection(extractSection(body, 'Conditions'));
      const effect = extractSection(body, 'Effect');
      const enforcedIn = parseTags(fm.enforced_in).join(', ') || 'unknown';
      const relatedConcepts = parseTags(fm.related_concepts);

      const ruleContent = await enrichBusinessRule(
        ac.name,
        description,
        trigger,
        conditions,
        effect,
        enforcedIn,
        relatedConcepts,
        config,
        projectPath
      );

      if (ruleContent) {
        appendDetectedChanges(skillPath, ruleContent, 'Re-enriched by incremental rebuild');
        console.log(`      ✓ Updated`);
        anyUpdated = true;
      } else {
        console.log(`      ⚠ Enrichment failed`);
      }
    }
  }

  for (const ac of affectedConcepts) {
    if (!ac.deleted) continue;
    const skillPath = ac.type === 'domain'
      ? path.join(projectPath, 'skills', 'domain', `${ac.name}.md`)
      : path.join(projectPath, 'skills', 'rules', 'business', `${ac.name}.md`);
    if (fs.existsSync(skillPath)) {
      if (options.dryRun) {
        console.log(`      [dry-run] Would append 'source file deleted' to ${skillPath}`);
      } else {
        appendDeletedSource(skillPath);
        console.log(`      ✓ Appended 'source file deleted'`);
      }
    }
  }

  if (anyUpdated) {
    console.log('▶ Regenerating relations map...');
    if (options.dryRun) {
      console.log('  [dry-run] Would regenerate relations.md');
    } else {
      await generateRelationsMap(projectPath, { dryRun: options.dryRun });
    }
  }

  if (options.embeddings) {
    console.log('▶ Re-embedding...');
    const { embedAll } = await import('../embeddings/embed.js');
    await embedAll(projectPath);
  }

  return anyUpdated;
}
