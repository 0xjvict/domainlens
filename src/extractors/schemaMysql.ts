import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';
import type { DomainLensConfig, SchemaCache, TableInfo, EnumType } from '../types.js';

interface EnumColumnInfo {
  enumName: string;
  values: string[];
}

export async function extractSchemaMysql(
  config: DomainLensConfig,
  projectPath: string
): Promise<SchemaCache | null> {
  const dbUrl = process.env[config.db_url_env];

  if (!dbUrl) {
    console.log(`⚠ Database unreachable — skipping schema extraction`);
    return loadExistingCache(projectPath);
  }

  let connection: mysql.Connection | null = null;
  try {
    connection = await mysql.createConnection(dbUrl);
  } catch {
    console.log(`⚠ Database unreachable — skipping schema extraction`);
    return loadExistingCache(projectPath);
  }

  try {
    const [dbResult] = await connection.query<mysql.RowDataPacket[]>('SELECT DATABASE() AS db');
    const dbName: string | null = (dbResult as { db: string | null }[])[0]?.db ?? null;

    const enumColumns = await extractEnumColumns(connection, dbName);
    const enums: EnumType[] = enumColumns.map((ec) => ({
      name: ec.enumName,
      schema: dbName || '',
      values: ec.values,
    }));

    const tables = await extractTables(connection, dbName, enumColumns);

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
    if (connection) await connection.end();
  }
}

function loadExistingCache(projectPath: string): SchemaCache | null {
  const cachePath = path.join(projectPath, '.domainlens', 'schemas', 'latest.json');
  if (fs.existsSync(cachePath)) {
    return JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as SchemaCache;
  }
  return null;
}

async function extractEnumColumns(
  connection: mysql.Connection,
  dbName: string | null
): Promise<EnumColumnInfo[]> {
  const schemaClause = dbName ? 'WHERE table_schema = ?' : '';
  const params: string[] = dbName ? [dbName] : [];

  const [rows] = await connection.query<mysql.RowDataPacket[]>(
    `SELECT table_name, column_name, column_type
     FROM information_schema.columns
     ${schemaClause}
       AND column_type LIKE 'enum(%'`,
    params
  );

  const raw = rows as { table_name: string; column_name: string; column_type: string }[];
  return raw.map((r) => {
    const values = parseEnumValues(r.column_type);
    return {
      enumName: `${r.table_name}.${r.column_name}`,
      values,
    };
  });
}

function parseEnumValues(columnType: string): string[] {
  const match = columnType.match(/^enum\((.+)\)$/i);
  if (!match) return [];
  // Split by quoted commas: e.g. 'active','inactive','churned'
  const values: string[] = [];
  const re = /'((?:[^']|'')*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(match[1])) !== null) {
    values.push(m[1].replace(/''/g, "'"));
  }
  return values;
}

async function extractTables(
  connection: mysql.Connection,
  dbName: string | null,
  enumColumns: EnumColumnInfo[]
): Promise<TableInfo[]> {
  const schemaClause = dbName ? 'WHERE table_schema = ?' : 'WHERE table_schema = DATABASE()';
  const params: string[] = dbName ? [dbName] : [];

  const [rows] = await connection.query<mysql.RowDataPacket[]>(
    `SELECT table_name, table_schema
     FROM information_schema.tables
     ${schemaClause}
       AND table_type = 'BASE TABLE'
     ORDER BY table_schema, table_name`,
    params
  );

  const raw = rows as { table_name: string; table_schema: string }[];
  const tables: TableInfo[] = [];

  for (const r of raw) {
    const table = await extractTableDetails(connection, r.table_schema, r.table_name, enumColumns);
    tables.push(table);
  }

  return tables;
}

async function extractTableDetails(
  connection: mysql.Connection,
  schema: string,
  tableName: string,
  enumColumns: EnumColumnInfo[]
): Promise<TableInfo> {
  const [colRows] = await connection.query<mysql.RowDataPacket[]>(
    `SELECT
       column_name,
       data_type,
       column_type,
       is_nullable,
       column_default,
       column_comment AS col_description
     FROM information_schema.columns
     WHERE table_schema = ? AND table_name = ?
     ORDER BY ordinal_position`,
    [schema, tableName]
  );

  const columnsRaw = colRows as {
    column_name: string;
    data_type: string;
    column_type: string;
    is_nullable: string;
    column_default: string | null;
    col_description: string | null;
  }[];

  // PK
  const [pkRows] = await connection.query<mysql.RowDataPacket[]>(
    `SELECT kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
     WHERE tc.table_schema = ? AND tc.table_name = ?
       AND tc.constraint_type = 'PRIMARY KEY'
     ORDER BY kcu.ordinal_position`,
    [schema, tableName]
  );
  const pkRaw = pkRows as { column_name: string }[];

  // FK
  const [fkRows] = await connection.query<mysql.RowDataPacket[]>(
    `SELECT
       kcu.column_name,
       kcu.referenced_table_name AS foreign_table_name,
       kcu.referenced_column_name AS foreign_column_name,
       kcu.constraint_name
     FROM information_schema.key_column_usage kcu
     WHERE kcu.table_schema = ? AND kcu.table_name = ?
       AND kcu.referenced_table_name IS NOT NULL`,
    [schema, tableName]
  );
  const fkRaw = fkRows as {
    column_name: string;
    foreign_table_name: string;
    foreign_column_name: string;
    constraint_name: string;
  }[];

  // Indexes via SHOW INDEX
  const [idxRows] = await connection.query<mysql.RowDataPacket[]>(
    `SHOW INDEX FROM \`${tableName}\` WHERE Key_name != 'PRIMARY'`
  );
  const idxRaw = idxRows as {
    Key_name: string;
    Column_name: string;
    Non_unique: number;
    Seq_in_index: number;
  }[];

  const indexMap = new Map<string, { columns: string[]; unique: boolean }>();
  for (const r of idxRaw) {
    if (!indexMap.has(r.Key_name)) {
      indexMap.set(r.Key_name, { columns: [], unique: r.Non_unique === 0 });
    }
    indexMap.get(r.Key_name)!.columns.push(r.Column_name);
  }

  // CHECK
  const [checkRows] = await connection.query<mysql.RowDataPacket[]>(
    `SELECT tc.constraint_name, cc.check_clause
     FROM information_schema.table_constraints tc
     JOIN information_schema.check_constraints cc
       ON tc.constraint_name = cc.constraint_name AND tc.constraint_schema = cc.constraint_schema
     WHERE tc.table_schema = ? AND tc.table_name = ?
       AND tc.constraint_type = 'CHECK'`,
    [schema, tableName]
  );
  const checkRaw = checkRows as { constraint_name: string; check_clause: string }[];

  // UNIQUE
  const [uniqueRows] = await connection.query<mysql.RowDataPacket[]>(
    `SELECT tc.constraint_name, kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     WHERE tc.table_schema = ? AND tc.table_name = ?
       AND tc.constraint_type = 'UNIQUE'
     ORDER BY tc.constraint_name, kcu.ordinal_position`,
    [schema, tableName]
  );
  const uniqueRaw = uniqueRows as { constraint_name: string; column_name: string }[];

  const uniqueConstraints = new Map<string, string[]>();
  for (const r of uniqueRaw) {
    const existing = uniqueConstraints.get(r.constraint_name) ?? [];
    existing.push(r.column_name);
    uniqueConstraints.set(r.constraint_name, existing);
  }

  return {
    name: tableName,
    schema,
    columns: columnsRaw.map((c) => {
      let type = c.data_type;
      if (type === 'enum' || type === 'ENUM') {
        type = `enum(${c.column_type.match(/^enum\((.+)\)$/i)?.[1] ?? ''})`;
      }
      return {
        name: c.column_name,
        type,
        nullable: c.is_nullable === 'YES',
        default: c.column_default,
        comment: c.col_description,
      };
    }),
    primary_keys: pkRaw.map((r) => r.column_name),
    foreign_keys: fkRaw.map((r) => ({
      column: r.column_name,
      references_table: r.foreign_table_name,
      references_column: r.foreign_column_name,
      constraint_name: r.constraint_name,
    })),
    indexes: Array.from(indexMap.entries()).map(([name, info]) => ({
      name,
      columns: info.columns,
      unique: info.unique,
    })),
    check_constraints: checkRaw.map((r) => ({
      name: r.constraint_name,
      definition: r.check_clause,
    })),
    unique_constraints: Array.from(uniqueConstraints.entries()).map(([name, columns]) => ({
      name,
      columns,
    })),
  };
}
