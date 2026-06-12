import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter, parseTags } from '../utils/frontmatter.js';

export interface SkillsOptions {
  project?: string;
}

export function listSkills(options: SkillsOptions = {}): void {
  const projectPath = options.project ? path.resolve(options.project) : process.cwd();
  const skillsDir = path.join(projectPath, 'skills');

  const rows: { name: string; type: string; tags: string; source: string }[] = [];

  for (const subdir of ['domain', 'rules']) {
    const dir = path.join(skillsDir, subdir);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');
      const fm = parseFrontmatter(content);
      rows.push({
        name: fm.name || file.replace('.md', ''),
        type: fm.type || subdir,
        tags: parseTags(fm.tags).join(', ') || '—',
        source: fm.source || 'unknown',
      });
    }
  }

  if (rows.length === 0) {
    console.log('No skills found. Run `domainlens discover` to generate skills.');
    return;
  }

  const nameLabel = 'Name';
  const typeLabel = 'Type';
  const tagsLabel = 'Tags';
  const sourceLabel = 'Source';

  const nameW = Math.max(0, ...rows.map((r) => r.name.length), nameLabel.length);
  const typeW = Math.max(0, ...rows.map((r) => r.type.length), typeLabel.length);
  const tagsW = Math.max(0, ...rows.map((r) => r.tags.length), tagsLabel.length);

  const sep = `  ${'─'.repeat(nameW)} ─ ${'─'.repeat(typeW)} ─ ${'─'.repeat(tagsW)} ─ ${'─'.repeat(sourceLabel.length)}`;

  console.log(`  ${nameLabel.padEnd(nameW)} ┆ ${typeLabel.padEnd(typeW)} ┆ ${tagsLabel.padEnd(tagsW)} ┆ ${sourceLabel}`);
  console.log(sep);
  for (const r of rows) {
    console.log(
      `  ${r.name.padEnd(nameW)} ┆ ${r.type.padEnd(typeW)} ┆ ${r.tags.padEnd(tagsW)} ┆ ${r.source}`,
    );
  }
}

export function showSkill(name: string, options: SkillsOptions = {}): void {
  const projectPath = options.project ? path.resolve(options.project) : process.cwd();
  const skillsDir = path.join(projectPath, 'skills');
  const searchName = name.toLowerCase();

  for (const subdir of ['domain', 'rules']) {
    const dir = path.join(skillsDir, subdir);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      if (file.replace(/\.md$/, '').toLowerCase() === searchName) {
        console.log(fs.readFileSync(path.join(dir, file), 'utf-8').trimEnd());
        return;
      }
    }
  }

  console.error(`Skill '${name}' not found. Run 'domainlens discover' to generate skills.`);
  process.exit(1);
}

