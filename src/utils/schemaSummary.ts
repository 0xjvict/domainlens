import type { SchemaCache } from '../types.js';

export function buildSchemaSummary(schema: SchemaCache | null): string {
  if (!schema || schema.tables.length === 0) return '(no schema extracted)';

  const lines: string[] = [];
  for (const table of schema.tables) {
    const columns = table.columns
      .map((c) => {
        const fk = table.foreign_keys.find((f) => f.column === c.name);
        const suffix = fk ? ` → ${fk.references_table}` : '';
        return `    - ${c.name} (${c.type})${suffix}`;
      })
      .join('\n');
    lines.push(`- ${table.name}\n${columns}`);
  }
  return lines.join('\n');
}
