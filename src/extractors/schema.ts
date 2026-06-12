import type { DbType, DomainLensConfig, SchemaCache } from '../types.js';
import { extractSchemaPostgres } from './schemaPostgres.js';
import { extractSchemaMysql } from './schemaMysql.js';

function inferDbType(config: DomainLensConfig): DbType {
  if (config.db_type) return config.db_type;

  const dbUrl = process.env[config.db_url_env];
  if (!dbUrl) return 'postgres';

  try {
    const protocol = new URL(dbUrl).protocol;
    if (protocol.startsWith('mysql')) return 'mysql';
  } catch {
    // invalid URL — fall through to default
  }
  return 'postgres';
}

export async function extractSchema(
  config: DomainLensConfig,
  projectPath: string = process.cwd()
): Promise<SchemaCache | null> {
  const dbType = inferDbType(config);

  if (dbType === 'mysql') {
    return extractSchemaMysql(config, projectPath);
  }

  return extractSchemaPostgres(config, projectPath);
}
