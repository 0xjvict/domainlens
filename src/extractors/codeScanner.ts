import fs from 'node:fs';
import path from 'node:path';
import type { DomainLensConfig } from '../types.js';

export interface SqlExample {
  file: string;
  line: number;
  sql: string;
}

export interface Constant {
  name: string;
  value: string;
  file: string;
  line: number;
}

export interface EnumSignal {
  name: string;
  values: string[];
  file: string;
  line: number;
}

export interface CodeScanResult {
  sqlExamples: SqlExample[];
  constants: Constant[];
  enums: EnumSignal[];
}

const SQL_PATTERN = /["'`]([^"'`]*(?:SELECT|INSERT|UPDATE|DELETE)[^"'`]*)["`']/gi;
const CONSTANT_PATTERN = /^[ \t]*([A-Z][A-Z0-9_]{2,})\s*=\s*([^\n,;{]+)/gm;
const ENUM_OBJECT_PATTERN =
  /(?:const|enum|type)\s+([A-Z][A-Za-z0-9_]+)\s*[=:]?\s*(?:\{|\()?[^{]*\{([^}]+)\}/g;
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.svg',
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
  '.bin',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.mp3',
  '.mp4',
  '.webm',
  '.ogg',
]);

export function scanSqlExamples(
  config: DomainLensConfig,
  projectPath: string = process.cwd()
): SqlExample[] {
  const results: SqlExample[] = [];

  for (const codePath of config.code_paths) {
    const fullPath = path.resolve(projectPath, codePath);
    if (fs.existsSync(fullPath)) {
      walkDirectory(fullPath, config.ignore, projectPath, (filePath) => {
        const examples = extractSqlFromFile(filePath, projectPath);
        results.push(...examples);
      });
    }
  }

  return results;
}

export function scanConstantsAndEnums(
  config: DomainLensConfig,
  projectPath: string = process.cwd()
): { constants: Constant[]; enums: EnumSignal[] } {
  const constants: Constant[] = [];
  const enums: EnumSignal[] = [];

  for (const codePath of config.code_paths) {
    const fullPath = path.resolve(projectPath, codePath);
    if (fs.existsSync(fullPath)) {
      walkDirectory(fullPath, config.ignore, projectPath, (filePath) => {
        const result = extractConstantsAndEnumsFromFile(filePath, projectPath);
        constants.push(...result.constants);
        enums.push(...result.enums);
      });
    }
  }

  return { constants, enums };
}

function walkDirectory(
  dirPath: string,
  ignoreList: string[],
  projectPath: string,
  callback: (filePath: string) => void
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
        callback(fullPath);
      }
    }
  }
}

function extractSqlFromFile(filePath: string, projectPath: string): SqlExample[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  if (content.includes('\0')) return [];

  const examples: SqlExample[] = [];
  const lines = content.split('\n');
  const relativeFile = path.relative(projectPath, filePath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const matches = [...line.matchAll(SQL_PATTERN)];
    for (const match of matches) {
      const sql = match[1].trim();
      if (sql.length > 10) {
        examples.push({ file: relativeFile, line: i + 1, sql });
      }
    }
  }

  return examples;
}

function extractConstantsAndEnumsFromFile(
  filePath: string,
  projectPath: string
): { constants: Constant[]; enums: EnumSignal[] } {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return { constants: [], enums: [] };
  }

  if (content.includes('\0')) return { constants: [], enums: [] };

  const relativeFile = path.relative(projectPath, filePath);
  const constants: Constant[] = [];
  const enums: EnumSignal[] = [];

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const constMatch = line.match(/^[ \t]*([A-Z][A-Z0-9_]{2,})\s*[=:]\s*([^\n,;{]+)/);
    if (constMatch) {
      const value = constMatch[2].trim().replace(/['"`;,]/g, '').trim();
      if (value.length > 0 && !value.startsWith('{') && !value.startsWith('(')) {
        constants.push({ name: constMatch[1], value, file: relativeFile, line: i + 1 });
      }
    }
  }

  ENUM_OBJECT_PATTERN.lastIndex = 0;
  let enumMatch: RegExpExecArray | null;
  while ((enumMatch = ENUM_OBJECT_PATTERN.exec(content)) !== null) {
    const enumName = enumMatch[1];
    const body = enumMatch[2];
    const values = [...body.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);

    if (values.length >= 2) {
      const lineNum =
        content.substring(0, enumMatch.index).split('\n').length;
      enums.push({ name: enumName, values, file: relativeFile, line: lineNum });
    }
  }

  return { constants, enums };
}
