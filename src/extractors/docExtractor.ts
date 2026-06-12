import fs from 'node:fs';
import path from 'node:path';
import type { DomainLensConfig } from '../types.js';

export interface DocSection {
  file: string;
  heading: string;
  content: string;
}

export interface SqlBlock {
  file: string;
  sql: string;
}

export interface AdrFile {
  file: string;
  title: string;
}

export interface DocScanResult {
  sections: DocSection[];
  sqlBlocks: SqlBlock[];
  adrs: AdrFile[];
}

const BUSINESS_KEYWORDS = [
  'churn',
  'premium',
  'regra',
  'rule',
  'policy',
  'glossary',
  'decision',
];

const ADR_KEYWORDS = ['adr', 'decision', 'architecture'];

const DEFAULT_IGNORE = ['node_modules', '.git'];

export function extractDocs(
  config: DomainLensConfig,
  projectPath: string = process.cwd()
): DocScanResult {
  const sections: DocSection[] = [];
  const sqlBlocks: SqlBlock[] = [];
  const adrs: AdrFile[] = [];

  for (const docPath of config.docs_paths) {
    const fullPath = path.resolve(projectPath, docPath);
    if (!fs.existsSync(fullPath)) continue;

    const stat = fs.statSync(fullPath);
    if (stat.isFile() && fullPath.endsWith('.md')) {
      processMarkdownFile(fullPath, projectPath, sections, sqlBlocks, adrs);
    } else if (stat.isDirectory()) {
      walkMarkdownDir(fullPath, projectPath, DEFAULT_IGNORE, sections, sqlBlocks, adrs);
    }
  }

  return { sections, sqlBlocks, adrs };
}

function walkMarkdownDir(
  dirPath: string,
  projectPath: string,
  ignoreList: string[],
  sections: DocSection[],
  sqlBlocks: SqlBlock[],
  adrs: AdrFile[]
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (ignoreList.some((ig) => entry.name === ig)) continue;

    if (entry.isDirectory()) {
      walkMarkdownDir(fullPath, projectPath, ignoreList, sections, sqlBlocks, adrs);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      processMarkdownFile(fullPath, projectPath, sections, sqlBlocks, adrs);
    }
  }
}

function processMarkdownFile(
  filePath: string,
  projectPath: string,
  sections: DocSection[],
  sqlBlocks: SqlBlock[],
  adrs: AdrFile[]
): void {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return;
  }

  const relativeFile = path.relative(projectPath, filePath);
  const fileName = path.basename(filePath, '.md').toLowerCase();

  const h1Match = content.match(/^#\s+(.+)/m);
  const title = h1Match ? h1Match[1].trim() : fileName;

  if (
    ADR_KEYWORDS.some((kw) => fileName.includes(kw) || title.toLowerCase().includes(kw))
  ) {
    adrs.push({ file: relativeFile, title });
  }

  extractSqlBlocks(content, relativeFile, sqlBlocks);
  extractBusinessSections(content, relativeFile, sections);
}

function extractSqlBlocks(content: string, file: string, sqlBlocks: SqlBlock[]): void {
  const fencedSql = /```sql\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fencedSql.exec(content)) !== null) {
    const sql = match[1].trim();
    if (sql.length > 0) {
      sqlBlocks.push({ file, sql });
    }
  }
}

function extractBusinessSections(
  content: string,
  file: string,
  sections: DocSection[]
): void {
  const lines = content.split('\n');
  let currentHeading = '';
  let currentContent: string[] = [];

  const flush = () => {
    if (
      currentHeading &&
      currentContent.length > 0 &&
      BUSINESS_KEYWORDS.some(
        (kw) =>
          currentHeading.toLowerCase().includes(kw) ||
          currentContent.some((l) => l.toLowerCase().includes(kw))
      )
    ) {
      sections.push({
        file,
        heading: currentHeading,
        content: currentContent.join('\n').trim(),
      });
    }
  };

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,6}\s+(.+)/);
    if (headingMatch) {
      flush();
      currentHeading = headingMatch[1].trim();
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }
  flush();
}
