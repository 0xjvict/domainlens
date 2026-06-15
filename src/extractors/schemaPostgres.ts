import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';
import type { DomainLensConfig, SchemaCache, TableInfo, EnumType } from '../types.js';

const { Client } = pg;

export async function extractSchemaPostgres(
  config: DomainLensConfig,
  projectPath: string,
  force?: boolean
): Promise<SchemaCache | null> {
  const dbUrl = process.env[config.db_url_env];

  if (!dbUrl) {
    console.log(`⚠ Database unreachable — skipping schema extraction`);
    return loadExistingCache(projectPath);
  }

  const client = new Client({ connectionString: dbUrl, connectionTimeoutMillis: 10_000 });

  try {
    await client.connect();
  } catch (err) {
    console.log(`⚠ Database unreachable — skipping schema extraction`);
    console.error(`  ${err}`);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('invalid response') || msg.includes('4a')) {
      console.log('  Hint: this may be a MySQL server. Set db_type: "mysql" in .domainlens/config.json');
    }
    return loadExistingCache(projectPath);
  }

  try {
    if (!force) {
      const existing = loadExistingCache(projectPath);
      if (existing) {
        const fpResult = await client.query<{ table_schema: string; table_name: string; column_name: string; data_type: string; udt_name: string; referenced_table_name: string | null }>(
          `SELECT c.table_schema, c.table_name, c.column_name, c.data_type, c.udt_name,
                  ccu.table_name AS referenced_table_name
           FROM information_schema.columns c
           LEFT JOIN information_schema.key_column_usage kcu
             ON c.table_schema = kcu.table_schema
            AND c.table_name = kcu.table_name
            AND c.column_name = kcu.column_name
           LEFT JOIN information_schema.constraint_column_usage ccu
             ON ccu.constraint_name = kcu.constraint_name
            AND ccu.table_schema = kcu.table_schema
           WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
           ORDER BY c.table_schema, c.table_name, c.column_name`
        );
        const hash = crypto.createHash('sha256').update(JSON.stringify(fpResult.rows)).digest('hex');

        if (existing.schema_hash === hash) {
          console.log('  ✓ Schema unchanged — using cached schema');
          return existing;
        }
      }
    }

    const tables = await extractTables(client);
    const enums = await extractEnums(client);

    const fingerprintRows = tables.flatMap((t) =>
      t.columns.map((c) => ({
        table_schema: t.schema,
        table_name: t.name,
        column_name: c.name,
        data_type: c.type,
        udt_name: c.type,
        referenced_table_name: t.foreign_keys.find((fk) => fk.column === c.name)?.references_table ?? null,
      }))
    );
    fingerprintRows.sort((a, b) => a.table_name.localeCompare(b.table_name) || a.column_name.localeCompare(b.column_name));
    const hash = crypto.createHash('sha256').update(JSON.stringify(fingerprintRows)).digest('hex');

    const cache: SchemaCache = {
      extracted_at: new Date().toISOString(),
      tables,
      enums,
      schema_hash: hash,
    };

    const schemasDir = path.join(projectPath, '.domainlens', 'schemas');
    fs.mkdirSync(schemasDir, { recursive: true });
    fs.writeFileSync(
      path.join(schemasDir, 'latest.json'),
      JSON.stringify(cache, null, 2) + '\n',
      'utf-8'
    );

    return cache;
  } finally {
    await client.end();
  }
}

function loadExistingCache(projectPath: string): SchemaCache | null {
  const cachePath = path.join(projectPath, '.domainlens', 'schemas', 'latest.json');
  if (fs.existsSync(cachePath)) {
    return JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as SchemaCache;
  }
  return null;
}

async function extractTables(client: pg.Client): Promise<TableInfo[]> {
  const tablesResult = await client.query<{ table_name: string; table_schema: string }>(`
    SELECT table_name, table_schema
    FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      AND table_type = 'BASE TABLE'
    ORDER BY table_schema, table_name
  `);

  const raw = tablesResult.rows;
  if (raw.length === 0) return [];

  const columnsResult = await client.query<{
    table_name: string; table_schema: string;
    column_name: string; data_type: string; udt_name: string;
    is_nullable: string; column_default: string | null; col_description: string | null;
  }>(
    `SELECT c.table_name, c.table_schema,
            c.column_name, c.data_type, c.udt_name, c.is_nullable, c.column_default,
            pg_catalog.col_description(pgc.oid, c.ordinal_position::int) AS col_description
     FROM information_schema.columns c
     JOIN pg_catalog.pg_class pgc ON pgc.relname = c.table_name
     JOIN pg_catalog.pg_namespace pgn ON pgn.nspname = c.table_schema AND pgn.oid = pgc.relnamespace
     WHERE c.table_schema = ALL($1::text[])
     ORDER BY c.table_name, c.ordinal_position`,
    [raw.map((r) => r.table_schema)]
  );

  const schemas = [...new Set(raw.map((r) => r.table_schema))];

  const kcuResult = await client.query<{
    table_name: string; table_schema: string;
    column_name: string; constraint_type: string;
    foreign_table_name: string | null; foreign_column_name: string | null;
    constraint_name: string; ordinal_position: number;
  }>(
    `SELECT kcu.table_name, kcu.table_schema, kcu.column_name, tc.constraint_type,
            kcu.referenced_table_name AS foreign_table_name, kcu.referenced_column_name AS foreign_column_name,
            tc.constraint_name, kcu.ordinal_position
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     WHERE kcu.table_schema = ALL($1::text[])
       AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY', 'UNIQUE')
     ORDER BY kcu.table_name, tc.constraint_type, kcu.ordinal_position`,
    [schemas]
  );

  const indexResult = await client.query<{
    tablename: string; schemaname: string;
    indexname: string; indexdef: string;
  }>(
    `SELECT tablename, schemaname, indexname, indexdef
     FROM pg_indexes
     WHERE schemaname = ALL($1::text[])
     ORDER BY schemaname, tablename, indexname`,
    [schemas]
  );

  const checkResult = await client.query<{
    table_name: string; table_schema: string;
    constraint_name: string; check_clause: string;
  }>(
    `SELECT tc.table_name, tc.table_schema, tc.constraint_name, cc.check_clause
     FROM information_schema.table_constraints tc
     JOIN information_schema.check_constraints cc
       ON tc.constraint_name = cc.constraint_name AND tc.table_schema = cc.constraint_schema
     WHERE tc.table_schema = ALL($1::text[])
       AND tc.constraint_type = 'CHECK'`,
    [schemas]
  );

  const tables: TableInfo[] = [];
  for (const r of raw) {
    const tName = r.table_name;
    const tSchema = r.table_schema;

    const tableColumns = columnsResult.rows
      .filter((c) => c.table_name === tName && c.table_schema === tSchema)
      .map((c) => ({
        name: c.column_name,
        type: c.data_type === 'USER-DEFINED' ? c.udt_name : c.data_type,
        nullable: c.is_nullable === 'YES',
        default: c.column_default,
        comment: c.col_description,
      }));

    const pks = kcuResult.rows
      .filter((k) => k.table_name === tName && k.table_schema === tSchema && k.constraint_type === 'PRIMARY KEY')
      .map((k) => k.column_name);

    const fks = kcuResult.rows
      .filter((k) => k.table_name === tName && k.table_schema === tSchema && k.constraint_type === 'FOREIGN KEY')
      .map((k) => ({ column: k.column_name, references_table: k.foreign_table_name!, references_column: k.foreign_column_name!, constraint_name: k.constraint_name }));

    const indexes = indexResult.rows
      .filter((i) => i.tablename === tName && i.schemaname === tSchema)
      .map((i) => {
        const isUnique = i.indexdef.toUpperCase().includes('UNIQUE');
        const columnsMatch = i.indexdef.match(/\(([^)]+)\)/);
        const columns = columnsMatch ? columnsMatch[1].split(',').map((c) => c.trim().replace(/"/g, '')) : [];
        return { name: i.indexname, columns, unique: isUnique };
      });

    const checks = checkResult.rows
      .filter((c) => c.table_name === tName && c.table_schema === tSchema)
      .map((c) => ({ name: c.constraint_name, definition: c.check_clause }));

    const uniqueMap = new Map<string, string[]>();
    for (const k of kcuResult.rows.filter((k) => k.table_name === tName && k.table_schema === tSchema && k.constraint_type === 'UNIQUE')) {
      const existing = uniqueMap.get(k.constraint_name) ?? [];
      existing.push(k.column_name);
      uniqueMap.set(k.constraint_name, existing);
    }
    const uniqueConstraints = Array.from(uniqueMap.entries()).map(([name, columns]) => ({ name, columns }));

    tables.push({ name: tName, schema: tSchema, columns: tableColumns, primary_keys: pks, foreign_keys: fks, indexes, check_constraints: checks, unique_constraints: uniqueConstraints });
  }

  return tables;
}

async function extractEnums(client: pg.Client): Promise<EnumType[]> {
  const result = await client.query<{ typname: string; nspname: string; enumlabels: string[] }>(`
    SELECT
      t.typname,
      n.nspname,
      array_agg(e.enumlabel ORDER BY e.enumsortorder) AS enumlabels
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    GROUP BY t.typname, n.nspname
    ORDER BY n.nspname, t.typname
  `);

  return result.rows.map((r) => ({
    name: r.typname,
    schema: r.nspname,
    values: r.enumlabels,
  }));
}
