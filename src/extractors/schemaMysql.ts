import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';
import type { DomainLensConfig, SchemaCache, TableInfo, EnumType } from '../types.js';

interface EnumColumnInfo {
  schema: string;
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
  } catch (err) {
    console.log(`⚠ Database unreachable — skipping schema extraction`);
    console.error(`  ${err}`);
    return loadExistingCache(projectPath);
  }

  try {
    const databases = await getDatabases(connection);

    const allTables: TableInfo[] = [];
    const allEnums: EnumType[] = [];

    for (const dbName of databases) {
      const enumColumns = await extractEnumColumns(connection, dbName);
      const enums: EnumType[] = enumColumns.map((ec) => ({
        name: ec.enumName,
        schema: ec.schema,
        values: ec.values,
      }));
      allEnums.push(...enums);

      const tables = await extractTables(connection, dbName, enumColumns);
      allTables.push(...tables);
    }

    const cache: SchemaCache = {
      extracted_at: new Date().toISOString(),
      tables: allTables,
      enums: allEnums,
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

async function getDatabases(connection: mysql.Connection): Promise<string[]> {
  const systemDbs = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
  const [rows] = await connection.query<mysql.RowDataPacket[]>('SHOW DATABASES');
  return (rows as { Database: string }[])
    .map((r) => r.Database)
    .filter((name) => !systemDbs.has(name));
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
  dbName: string
): Promise<EnumColumnInfo[]> {
  const [rows] = await connection.query<mysql.RowDataPacket[]>(
    `SELECT table_schema, table_name, column_name, column_type
     FROM information_schema.columns
     WHERE table_schema = ? AND column_type LIKE 'enum(%'`,
    [dbName]
  );

  const raw = rows as { table_schema: string; table_name: string; column_name: string; column_type: string }[];
  return raw.map((r) => {
    const values = parseEnumValues(r.column_type);
    return {
      schema: r.table_schema,
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
  dbName: string,
  enumColumns: EnumColumnInfo[]
): Promise<TableInfo[]> {
  const [rows] = await connection.query<mysql.RowDataPacket[]>(
    `SELECT table_name, table_schema
     FROM information_schema.tables
     WHERE table_schema = ? AND table_type = 'BASE TABLE'
     ORDER BY table_schema, table_name`,
    [dbName]
  );

  const raw = rows as { table_name: string; table_schema: string }[];
  if (raw.length === 0) return [];

  const schema = raw[0].table_schema;

  const [colRows] = await connection.query<mysql.RowDataPacket[]>(
    `SELECT table_name, column_name, data_type, column_type, is_nullable, column_default, column_comment AS col_description
     FROM information_schema.columns
     WHERE table_schema = ?
     ORDER BY table_name, ordinal_position`,
    [schema]
  );
  const allColumns = colRows as {
    table_name: string; column_name: string; data_type: string; column_type: string;
    is_nullable: string; column_default: string | null; col_description: string | null;
  }[];

  const [kcuRows] = await connection.query<mysql.RowDataPacket[]>(
    `SELECT kcu.table_name, kcu.column_name, tc.constraint_type,
            kcu.referenced_table_name, kcu.referenced_column_name, kcu.constraint_name,
            kcu.ordinal_position
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
      AND tc.table_name = kcu.table_name
     WHERE kcu.table_schema = ?
       AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY', 'UNIQUE')
     ORDER BY kcu.table_name, tc.constraint_type, kcu.ordinal_position`,
    [schema]
  );
  const kcuRaw = kcuRows as {
    table_name: string; column_name: string; constraint_type: string;
    referenced_table_name: string | null; referenced_column_name: string | null;
    constraint_name: string; ordinal_position: number;
  }[];

  const [idxRows] = await connection.query<mysql.RowDataPacket[]>(
    `SELECT table_name, index_name AS Key_name, column_name AS Column_name, non_unique AS Non_unique, seq_in_index AS Seq_in_index
     FROM information_schema.statistics
     WHERE table_schema = ? AND index_name != 'PRIMARY'
     ORDER BY table_name, index_name, seq_in_index`,
    [schema]
  );
  const idxRaw = idxRows as {
    table_name: string; Key_name: string; Column_name: string; Non_unique: number; Seq_in_index: number;
  }[];

  let checkRaw: { table_name: string; constraint_name: string; check_clause: string }[] = [];
  try {
    const [checkRows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT tc.table_name, tc.constraint_name, cc.check_clause
       FROM information_schema.table_constraints tc
       JOIN information_schema.check_constraints cc
         ON tc.constraint_name = cc.constraint_name AND tc.constraint_schema = cc.constraint_schema
       WHERE tc.table_schema = ? AND tc.constraint_type = 'CHECK'`,
      [schema]
    );
    checkRaw = checkRows as { table_name: string; constraint_name: string; check_clause: string }[];
  } catch {
    // CHECK constraints not available in this MySQL version; skip
  }

  const enumColSet = new Set(enumColumns.map((e) => `${e.schema}.${e.enumName}`));

  const tables: TableInfo[] = [];
  for (const r of raw) {
    const tName = r.table_name;
    const tableColumns = allColumns
      .filter((c) => c.table_name === tName)
      .map((c) => {
        let type = c.data_type;
        if (type === 'enum' || type === 'ENUM') {
          type = `enum(${c.column_type.match(/^enum\((.+)\)$/i)?.[1] ?? ''})`;
        }
        return { name: c.column_name, type, nullable: c.is_nullable === 'YES', default: c.column_default, comment: c.col_description };
      });

    const pks = kcuRaw.filter((k) => k.table_name === tName && k.constraint_type === 'PRIMARY KEY').map((k) => k.column_name);

    const fks = kcuRaw
      .filter((k) => k.table_name === tName && k.constraint_type === 'FOREIGN KEY')
      .map((k) => ({ column: k.column_name, references_table: k.referenced_table_name!, references_column: k.referenced_column_name!, constraint_name: k.constraint_name }));

    const indexMap = new Map<string, { columns: string[]; unique: boolean }>();
    for (const i of idxRaw.filter((i) => i.table_name === tName)) {
      if (!indexMap.has(i.Key_name)) indexMap.set(i.Key_name, { columns: [], unique: i.Non_unique === 0 });
      indexMap.get(i.Key_name)!.columns.push(i.Column_name);
    }
    const indexes = Array.from(indexMap.entries()).map(([name, info]) => ({ name, columns: info.columns, unique: info.unique }));

    const checks = checkRaw.filter((c) => c.table_name === tName).map((c) => ({ name: c.constraint_name, definition: c.check_clause }));

    const uniqueMap = new Map<string, string[]>();
    for (const k of kcuRaw.filter((k) => k.table_name === tName && k.constraint_type === 'UNIQUE')) {
      const existing = uniqueMap.get(k.constraint_name) ?? [];
      existing.push(k.column_name);
      uniqueMap.set(k.constraint_name, existing);
    }
    const uniqueConstraints = Array.from(uniqueMap.entries()).map(([name, columns]) => ({ name, columns }));

    tables.push({ name: tName, schema, columns: tableColumns, primary_keys: pks, foreign_keys: fks, indexes, check_constraints: checks, unique_constraints: uniqueConstraints });
  }

  return tables;
}
