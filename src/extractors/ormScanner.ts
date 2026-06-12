import fs from 'node:fs';
import path from 'node:path';
import type { DomainLensConfig } from '../types.js';

export type OrmType = 'prisma' | 'django' | 'laravel';

export interface OrmSignal {
  type: 'orm_model' | 'orm_field' | 'orm_enum' | 'orm_scope';
  name: string;
  value: string;
  file: string;
  line: number;
}

export interface OrmScanResult {
  orm: OrmType | null;
  signals: OrmSignal[];
}

const DETECT_IGNORE = new Set([
  'node_modules',
  '.git',
  'dist',
  '__pycache__',
  '.venv',
  'venv',
  'vendor',
  '.idea',
  '.claude',
  '.domainlens',
]);

export function detectOrm(projectRoot: string): OrmType | null {
  // Prisma: schema.prisma exists at prisma/schema.prisma or schema.prisma
  if (
    fs.existsSync(path.join(projectRoot, 'prisma', 'schema.prisma')) ||
    fs.existsSync(path.join(projectRoot, 'schema.prisma'))
  ) {
    return 'prisma';
  }

  // Django: any models.py file containing class.*Model
  if (findFileWithPattern(projectRoot, 'models.py', /class.*Model/, DETECT_IGNORE)) {
    return 'django';
  }

  // Laravel: app/Models/*.php containing 'extends Model'
  const laravelDir = path.join(projectRoot, 'app', 'Models');
  if (fs.existsSync(laravelDir)) {
    for (const file of readdirSafe(laravelDir)) {
      if (!file.endsWith('.php')) continue;
      const content = readFileSafe(path.join(laravelDir, file));
      if (content && /extends\s+Model/.test(content)) return 'laravel';
    }
  }

  return null;
}

export function scanOrm(
  projectRoot: string,
  config: DomainLensConfig,
  ormOverride?: OrmType
): OrmScanResult {
  const orm = ormOverride ?? detectOrm(projectRoot);
  if (!orm) return { orm: null, signals: [] };

  const signals =
    orm === 'prisma'
      ? scanPrisma(projectRoot, config.ignore)
      : orm === 'django'
        ? scanDjango(projectRoot, config.ignore)
        : scanLaravel(projectRoot, config.ignore);

  return { orm, signals };
}

function scanPrisma(projectRoot: string, ignoreList: string[]): OrmSignal[] {
  void ignoreList; // schema.prisma is a single known file, not walked
  const signals: OrmSignal[] = [];

  const schemaPaths = [
    path.join(projectRoot, 'prisma', 'schema.prisma'),
    path.join(projectRoot, 'schema.prisma'),
  ].filter((p) => fs.existsSync(p));

  for (const filePath of schemaPaths) {
    const content = readFileSafe(filePath);
    if (!content) continue;

    const relFile = path.relative(projectRoot, filePath);
    const lines = content.split('\n');

    let currentModel: string | null = null;
    let currentEnum: string | null = null;
    let enumValues: string[] = [];
    let enumStartLine = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;
      const trimmed = line.trim();

      const modelMatch = line.match(/^model\s+(\w+)\s*\{/);
      if (modelMatch) {
        currentModel = modelMatch[1];
        currentEnum = null;
        signals.push({
          type: 'orm_model',
          name: currentModel,
          value: currentModel,
          file: relFile,
          line: lineNum,
        });
        continue;
      }

      const enumMatch = line.match(/^enum\s+(\w+)\s*\{/);
      if (enumMatch) {
        currentEnum = enumMatch[1];
        currentModel = null;
        enumValues = [];
        enumStartLine = lineNum;
        continue;
      }

      if (trimmed === '}') {
        if (currentEnum && enumValues.length >= 2) {
          signals.push({
            type: 'orm_enum',
            name: currentEnum,
            value: enumValues.join(', '),
            file: relFile,
            line: enumStartLine,
          });
        }
        currentModel = null;
        currentEnum = null;
        continue;
      }

      if (currentModel && trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('@@')) {
        const fieldMatch = trimmed.match(/^(\w+)\s+([\w\[\]?]+)/);
        if (fieldMatch && fieldMatch[1] !== 'model' && fieldMatch[1] !== 'enum') {
          const isRelation = line.includes('@relation');
          signals.push({
            type: 'orm_field',
            name: `${currentModel}.${fieldMatch[1]}`,
            value: isRelation ? `${fieldMatch[2]} @relation` : fieldMatch[2],
            file: relFile,
            line: lineNum,
          });
        }
      }

      if (currentEnum && trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('@')) {
        const valueMatch = trimmed.match(/^(\w+)/);
        if (valueMatch) enumValues.push(valueMatch[1]);
      }
    }
  }

  return signals;
}

function scanDjango(projectRoot: string, ignoreList: string[]): OrmSignal[] {
  const signals: OrmSignal[] = [];
  const ignoreSet = new Set([...DETECT_IGNORE, ...ignoreList]);
  const modelFiles = findFilesNamed(projectRoot, 'models.py', ignoreSet);

  for (const filePath of modelFiles) {
    const content = readFileSafe(filePath);
    if (!content || !/class.*Model/.test(content)) continue;

    const relFile = path.relative(projectRoot, filePath);
    const lines = content.split('\n');
    let currentClass: string | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // New top-level class definition
      if (line.match(/^class\s/)) {
        const classMatch = line.match(/^class\s+(\w+)\s*\([\w., ]*Model[\w., ]*\)\s*:/);
        if (classMatch) {
          currentClass = classMatch[1];
          signals.push({
            type: 'orm_model',
            name: currentClass,
            value: currentClass,
            file: relFile,
            line: lineNum,
          });
        } else {
          currentClass = null;
        }
        continue;
      }

      if (!currentClass) continue;

      // Field definition: 4-space indent + name = models.FieldType(
      const fieldMatch = line.match(/^    (\w+)\s*=\s*models\.(\w+)\s*\(/);
      if (fieldMatch) {
        signals.push({
          type: 'orm_field',
          name: `${currentClass}.${fieldMatch[1]}`,
          value: fieldMatch[2],
          file: relFile,
          line: lineNum,
        });
        continue;
      }

      // Choices tuple: NAME_CHOICES = [
      const choicesMatch = line.match(/^    (\w+_CHOICES)\s*=\s*\[/);
      if (choicesMatch) {
        const choiceValues: string[] = [];
        let j = i + 1;
        while (j < lines.length) {
          const cl = lines[j];
          if (/^\s*\]/.test(cl)) break;
          const valMatch = cl.match(/\(\s*['"]([^'"]+)['"]/);
          if (valMatch) choiceValues.push(valMatch[1]);
          j++;
        }
        if (choiceValues.length >= 2) {
          signals.push({
            type: 'orm_enum',
            name: choicesMatch[1],
            value: choiceValues.join(', '),
            file: relFile,
            line: lineNum,
          });
        }
      }
    }
  }

  return signals;
}

function scanLaravel(projectRoot: string, ignoreList: string[]): OrmSignal[] {
  const signals: OrmSignal[] = [];
  const laravelDir = path.join(projectRoot, 'app', 'Models');
  if (!fs.existsSync(laravelDir)) return signals;

  const phpFiles = readdirSafe(laravelDir)
    .filter((f) => f.endsWith('.php'))
    .map((f) => path.join(laravelDir, f))
    .filter((f) => {
      const rel = path.relative(projectRoot, f);
      return !ignoreList.some((ig) => rel.startsWith(ig));
    });

  for (const filePath of phpFiles) {
    const content = readFileSafe(filePath);
    if (!content || !/extends\s+Model/.test(content)) continue;

    const relFile = path.relative(projectRoot, filePath);
    const lines = content.split('\n');
    let currentClass: string | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      const classMatch = line.match(/class\s+(\w+)\s+extends\s+Model/);
      if (classMatch) {
        currentClass = classMatch[1];
        signals.push({
          type: 'orm_model',
          name: currentClass,
          value: currentClass,
          file: relFile,
          line: lineNum,
        });
        continue;
      }

      if (!currentClass) continue;

      // $fillable array
      if (line.includes('$fillable')) {
        let fillableContent = '';
        let j = i;
        while (j < lines.length) {
          fillableContent += lines[j];
          if (fillableContent.includes(']')) break;
          j++;
        }
        const fieldMatches = [...fillableContent.matchAll(/['"]([^'"]+)['"]/g)];
        for (const m of fieldMatches) {
          signals.push({
            type: 'orm_field',
            name: `${currentClass}.${m[1]}`,
            value: m[1],
            file: relFile,
            line: lineNum,
          });
        }
        continue;
      }

      // Scope methods: scopeX(
      const scopeMatch = line.match(/function\s+scope([A-Z]\w*)\s*\(/);
      if (scopeMatch) {
        signals.push({
          type: 'orm_scope',
          name: scopeMatch[1],
          value: `scope on ${currentClass}`,
          file: relFile,
          line: lineNum,
        });
      }
    }
  }

  return signals;
}

function readFileSafe(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return content.includes('\0') ? null : content;
  } catch {
    return null;
  }
}

function readdirSafe(dirPath: string): string[] {
  try {
    return fs.readdirSync(dirPath);
  } catch {
    return [];
  }
}

function findFileWithPattern(
  dir: string,
  filename: string,
  pattern: RegExp,
  ignoreSet: Set<string>
): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (ignoreSet.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (findFileWithPattern(fullPath, filename, pattern, ignoreSet)) return true;
    } else if (entry.isFile() && entry.name === filename) {
      const content = readFileSafe(fullPath);
      if (content && pattern.test(content)) return true;
    }
  }

  return false;
}

function findFilesNamed(dir: string, filename: string, ignoreSet: Set<string>): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (ignoreSet.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      results.push(...findFilesNamed(fullPath, filename, ignoreSet));
    } else if (entry.isFile() && entry.name === filename) {
      results.push(fullPath);
    }
  }

  return results;
}
