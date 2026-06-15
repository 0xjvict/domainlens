import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import type { DomainLensConfig, SchemaCache } from '../types.js';
import { scanSqlExamples, scanConstantsAndEnums } from '../extractors/codeScanner.js';

export interface StatusOptions {
  project?: string;
}

export function runStatus(options: StatusOptions = {}): void {
  const projectPath = options.project ? path.resolve(options.project) : process.cwd();
  const configPath = path.join(projectPath, '.domainlens', 'config.json');

  console.log(`DomainLens — project: ${projectPath}`);

  let config: DomainLensConfig | null = null;
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }

  // Skills
  const domainDir = path.join(projectPath, 'skills', 'domain');
  const technicalDir = path.join(projectPath, 'skills', 'rules', 'technical');
  const businessDir = path.join(projectPath, 'skills', 'rules', 'business');
  const domainCount = countMdFiles(domainDir);
  const technicalCount = countMdFiles(technicalDir);
  const businessCount = countMdFiles(businessDir);
  const mapPath = path.join(projectPath, 'skills', 'domain', 'relations.md');
  const relationsStatus = fs.existsSync(mapPath) ? '✓' : '—';
  console.log(`  Skills:     ${domainCount} domain, ${businessCount} business_rules, ${technicalCount} technical_rules, ${relationsStatus} domain_map`);

  // Schema
  const schemaPath = path.join(projectPath, '.domainlens', 'schemas', 'latest.json');
  if (fs.existsSync(schemaPath)) {
    const schema: SchemaCache = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
    const colCount = schema.tables.reduce((sum, t) => sum + t.columns.length, 0);
    const extractedAt = schema.extracted_at
      ? new Date(schema.extracted_at).toLocaleString('en-US', {
          month: 'numeric',
          day: 'numeric',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '—';
    console.log(`  Schema:     ${schema.tables.length} tables, ${colCount} columns (last: ${extractedAt})`);
  } else {
    console.log('  Schema:     not generated');
  }

  // Embeddings
  const dbPath = path.join(projectPath, '.domainlens', 'embeddings.db');
  if (fs.existsSync(dbPath)) {
    const stat = fs.statSync(dbPath);
    const lastEmbed = new Date(stat.mtime).toLocaleString('en-US', {
      month: 'numeric',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    try {
      const db = new Database(dbPath);
      const row = db.prepare('SELECT COUNT(*) AS cnt FROM vec_items').get() as { cnt: number };
      db.close();
      console.log(`  Embeddings: ${(row?.cnt ?? 0).toLocaleString()} vectors (last: ${lastEmbed})`);
    } catch {
      console.log('  Embeddings: 0 vectors (last: —)');
    }
  } else {
    console.log('  Embeddings: not generated');
  }

  // Code index
  if (config) {
    try {
      const sqlCount = scanSqlExamples(config, projectPath).length;
      const { constants, enums } = scanConstantsAndEnums(config, projectPath);
      console.log(`  Code index: ${sqlCount} SQL examples, ${constants.length} constants, ${enums.length} enums`);
    } catch {
      console.log('  Code index: —');
    }
  } else {
    console.log('  Code index: —');
  }

  // Config
  if (config) {
    const modelInfo = config.llm_model ? ` (${config.llm_model})` : '';
    console.log(`  Config:     .domainlens/config.json ✓${modelInfo}`);
  } else {
    console.log('  Config:     not found');
  }

  // Model cache
  const modelCacheDir = path.join(os.homedir(), '.domainlens', 'models', 'all-MiniLM-L6-v2');
  if (fs.existsSync(modelCacheDir)) {
    console.log(`  Model:      ~/.domainlens/models/all-MiniLM-L6-v2 ✓`);
  } else if (fs.existsSync(path.join(os.homedir(), '.domainlens', 'models'))) {
    console.log(`  Model:      not cached (run 'domainlens models download')`);
  } else {
    console.log(`  Model:      not cached (run 'domainlens models download')`);
  }
}

function countMdFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).length;
}
