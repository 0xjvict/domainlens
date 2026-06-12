import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import type { DomainLensConfig, SchemaCache, TableInfo, EnumType } from '../types.js';

const { Client } = pg;

export async function extractSchemaPostgres(
  config: DomainLensConfig,
  projectPath: string
): Promise<SchemaCache | null> {
  const dbUrl = process.env[config.db_url_env];

  if (!dbUrl) {
    console.log(`⚠ Database unreachable — skipping schema extraction`);
    return loadExistingCache(projectPath);
  }

  const client = new Client({ connectionString: dbUrl, connectionTimeoutMillis: 10_000 });

  try {
    await client.connect();
  } catch {
    console.log(`⚠ Database unreachable — skipping schema extraction`);
    return loadExistingCache(projectPath);
  }

  try {
    const tables = await extractTables(client);
    const enums = await extractEnums(client);

    const cache: SchemaCache = {
      extracted_at: new Date().toISOString(),
      tables,
      enums,
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

  const tables: TableInfo[] = [];

  for (const row of tablesResult.rows) {
    const table = await extractTableDetails(client, row.table_schema, row.table_name);
    tables.push(table);
  }

  return tables;
}

async function extractTableDetails(
  client: pg.Client,
  schema: string,
  tableName: string
): Promise<TableInfo> {
  const columnsResult = await client.query<{
    column_name: string;
    data_type: string;
    udt_name: string;
    is_nullable: string;
    column_default: string | null;
    col_description: string | null;
  }>(
    `
    SELECT
      c.column_name,
      c.data_type,
      c.udt_name,
      c.is_nullable,
      c.column_default,
      pg_catalog.col_description(pgc.oid, c.ordinal_position::int) AS col_description
    FROM information_schema.columns c
    JOIN pg_catalog.pg_class pgc ON pgc.relname = c.table_name
    JOIN pg_catalog.pg_namespace pgn ON pgn.nspname = c.table_schema AND pgn.oid = pgc.relnamespace
    WHERE c.table_schema = $1 AND c.table_name = $2
    ORDER BY c.ordinal_position
  `,
    [schema, tableName]
  );

  const pkResult = await client.query<{ column_name: string }>(
    `
    SELECT kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    WHERE tc.table_schema = $1
      AND tc.table_name = $2
      AND tc.constraint_type = 'PRIMARY KEY'
    ORDER BY kcu.ordinal_position
  `,
    [schema, tableName]
  );

  const fkResult = await client.query<{
    column_name: string;
    foreign_table_name: string;
    foreign_column_name: string;
    constraint_name: string;
  }>(
    `
    SELECT
      kcu.column_name,
      ccu.table_name AS foreign_table_name,
      ccu.column_name AS foreign_column_name,
      tc.constraint_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    WHERE tc.table_schema = $1
      AND tc.table_name = $2
      AND tc.constraint_type = 'FOREIGN KEY'
  `,
    [schema, tableName]
  );

  const indexResult = await client.query<{
    indexname: string;
    indexdef: string;
  }>(
    `
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = $1 AND tablename = $2
  `,
    [schema, tableName]
  );

  const checkResult = await client.query<{ constraint_name: string; check_clause: string }>(
    `
    SELECT tc.constraint_name, cc.check_clause
    FROM information_schema.table_constraints tc
    JOIN information_schema.check_constraints cc
      ON tc.constraint_name = cc.constraint_name AND tc.table_schema = cc.constraint_schema
    WHERE tc.table_schema = $1
      AND tc.table_name = $2
      AND tc.constraint_type = 'CHECK'
  `,
    [schema, tableName]
  );

  const uniqueResult = await client.query<{ constraint_name: string; column_name: string }>(
    `
    SELECT tc.constraint_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    WHERE tc.table_schema = $1
      AND tc.table_name = $2
      AND tc.constraint_type = 'UNIQUE'
    ORDER BY tc.constraint_name, kcu.ordinal_position
  `,
    [schema, tableName]
  );

  const uniqueConstraints = new Map<string, string[]>();
  for (const row of uniqueResult.rows) {
    const existing = uniqueConstraints.get(row.constraint_name) ?? [];
    existing.push(row.column_name);
    uniqueConstraints.set(row.constraint_name, existing);
  }

  const indexes = indexResult.rows.map((r) => {
    const isUnique = r.indexdef.toUpperCase().includes('UNIQUE');
    const columnsMatch = r.indexdef.match(/\(([^)]+)\)/);
    const columns = columnsMatch
      ? columnsMatch[1].split(',').map((c) => c.trim().replace(/"/g, ''))
      : [];
    return { name: r.indexname, columns, unique: isUnique };
  });

  return {
    name: tableName,
    schema,
    columns: columnsResult.rows.map((c) => ({
      name: c.column_name,
      type: c.data_type === 'USER-DEFINED' ? c.udt_name : c.data_type,
      nullable: c.is_nullable === 'YES',
      default: c.column_default,
      comment: c.col_description,
    })),
    primary_keys: pkResult.rows.map((r) => r.column_name),
    foreign_keys: fkResult.rows.map((r) => ({
      column: r.column_name,
      references_table: r.foreign_table_name,
      references_column: r.foreign_column_name,
      constraint_name: r.constraint_name,
    })),
    indexes,
    check_constraints: checkResult.rows.map((r) => ({
      name: r.constraint_name,
      definition: r.check_clause,
    })),
    unique_constraints: Array.from(uniqueConstraints.entries()).map(([name, columns]) => ({
      name,
      columns,
    })),
  };
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
