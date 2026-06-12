import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { load as loadVec } from 'sqlite-vec';
import type { DomainLensConfig, SchemaCache } from '../types.js';
import { loadModel } from './model.js';
import { scanSqlExamples, scanConstantsAndEnums } from '../extractors/codeScanner.js';

interface EmbedItem {
  source: string;
  type: 'skill' | 'schema' | 'sql_example' | 'constant';
  excerpt: string;
}

interface VecItemRow {
  hash: string;
}

function collectSkills(projectPath: string, items: EmbedItem[]): void {
  const skillsDir = path.join(projectPath, 'skills');
  for (const subdir of ['domain', 'rules']) {
    const dir = path.join(skillsDir, subdir);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      const filePath = path.join(dir, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      items.push({
        source: path.relative(projectPath, filePath),
        type: 'skill',
        excerpt: content,
      });
    }
  }
}

function collectSchema(projectPath: string, items: EmbedItem[]): void {
  const schemaPath = path.join(projectPath, '.domainlens', 'schemas', 'latest.json');
  if (!fs.existsSync(schemaPath)) return;
  const schema: SchemaCache = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
  for (const table of schema.tables) {
    for (const col of table.columns) {
      const comment = col.comment ? `, Comment: ${col.comment}` : '';
      const nullable = col.nullable ? ', nullable' : ', not null';
      items.push({
        source: `schema:${table.name}.${col.name}`,
        type: 'schema',
        excerpt: `Table: ${table.name}, Column: ${col.name}, Type: ${col.type}${nullable}${comment}`,
      });
    }
  }
}

export interface EmbedResult {
  indexed: number;
  skipped: number;
}

export async function embedAll(projectPath: string): Promise<EmbedResult> {
  const configPath = path.join(projectPath, '.domainlens', 'config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error('.domainlens/config.json not found. Run `domainlens init` first.');
  }
  const config: DomainLensConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  const dbPath = path.join(projectPath, '.domainlens', 'embeddings.db');
  const db = new Database(dbPath);
  loadVec(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS vec_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      excerpt TEXT NOT NULL,
      embedding BLOB NOT NULL,
      hash TEXT NOT NULL
    )
  `);

  const model = await loadModel();

  const items: EmbedItem[] = [];
  collectSkills(projectPath, items);
  collectSchema(projectPath, items);

  const sqlExamples = scanSqlExamples(config, projectPath);
  for (const ex of sqlExamples) {
    items.push({
      source: `${ex.file}:${ex.line}`,
      type: 'sql_example',
      excerpt: ex.sql,
    });
  }

  const { constants } = scanConstantsAndEnums(config, projectPath);
  for (const c of constants) {
    items.push({
      source: `${c.file}:${c.line}:${c.name}`,
      type: 'constant',
      excerpt: `${c.name} = ${c.value}`,
    });
  }

  const getBySource = db.prepare<[string], VecItemRow>('SELECT hash FROM vec_items WHERE source = ?');
  const insert = db.prepare(
    'INSERT INTO vec_items (source, type, excerpt, embedding, hash) VALUES (?, ?, ?, ?, ?)'
  );
  const update = db.prepare(
    'UPDATE vec_items SET type = ?, excerpt = ?, embedding = ?, hash = ? WHERE source = ?'
  );

  let indexed = 0;
  let skipped = 0;

  for (const item of items) {
    const hash = crypto.createHash('sha256').update(item.excerpt).digest('hex');
    const existing = getBySource.get(item.source);

    if (existing?.hash === hash) {
      skipped++;
      continue;
    }

    const result = await model(item.excerpt, { pooling: 'mean', normalize: true });
    const float32 = result.data as Float32Array;
    const embeddingBlob = Buffer.from(float32.buffer);

    if (existing) {
      update.run(item.type, item.excerpt, embeddingBlob, hash, item.source);
    } else {
      insert.run(item.source, item.type, item.excerpt, embeddingBlob, hash);
    }
    indexed++;
  }

  db.close();
  console.log(`  ✓ ${indexed} embeddings indexed, ${skipped} unchanged`);
  return { indexed, skipped };
}
