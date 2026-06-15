import type { SchemaCache } from '../types.js';
import type { SqlExample, Constant, EnumSignal } from '../extractors/codeScanner.js';
import type { DocSection } from '../extractors/docExtractor.js';
import type { OrmSignal } from '../extractors/ormScanner.js';

export type SignalType =
  | 'column'
  | 'constant'
  | 'enum'
  | 'doc_section'
  | 'sql_example'
  | 'orm_model'
  | 'orm_field'
  | 'orm_enum'
  | 'orm_scope';

export interface Signal {
  type: SignalType;
  detail: string;
  source?: string;
}

export interface DomainConcept {
  concept: string;
  definition?: string;
  signals: Signal[];
  skipEnrich?: boolean;
}

export interface InferrerInput {
  schema: SchemaCache | null;
  sqlExamples: SqlExample[];
  constants: Constant[];
  enums: EnumSignal[];
  docSections: DocSection[];
  ormSignals?: OrmSignal[];
}

export function inferConcepts(input: InferrerInput): DomainConcept[] {
  const conceptMap = new Map<string, Signal[]>();

  const addSignal = (concept: string, signal: Signal) => {
    const key = normalizeConcept(concept);
    if (!key) return;
    if (!conceptMap.has(key)) {
      conceptMap.set(key, []);
    }
    conceptMap.get(key)!.push(signal);
  };

  if (input.schema) {
    for (const table of input.schema.tables) {
      for (const column of table.columns) {
        const concepts = conceptsFromColumnName(column.name, table.name);
        for (const concept of concepts) {
          addSignal(concept, {
            type: 'column',
            detail: `Column: \`${table.name}.${column.name}\`${column.comment ? ` — ${column.comment}` : ''}`,
            source: table.name,
          });
        }
      }
    }

    for (const enumType of input.schema.enums) {
      const concept = toSnakeCase(enumType.name);
      addSignal(concept, {
        type: 'enum',
        detail: `Enum: \`${enumType.name}\` = [${enumType.values.map((v) => `"${v}"`).join(', ')}]`,
        source: enumType.name,
      });
    }
  }

  for (const constant of input.constants) {
    const concept = conceptFromConstantName(constant.name);
    if (concept) {
      addSignal(concept, {
        type: 'constant',
        detail: `Constant: \`${constant.name} = ${constant.value}\``,
        source: constant.file,
      });
    }
  }

  for (const enumSig of input.enums) {
    const concept = toSnakeCase(stripClassAffixes(enumSig.name));
    addSignal(concept, {
      type: 'enum',
      detail: `Enum: \`${enumSig.name}\` = [${enumSig.values.map((v) => `"${v}"`).join(', ')}]`,
      source: enumSig.file,
    });
  }

  for (const section of input.docSections) {
    const concept = conceptFromHeading(section.heading);
    if (concept) {
      addSignal(concept, {
        type: 'doc_section',
        detail: `Doc section: "${section.heading}" in ${section.file}`,
        source: section.file,
      });
    }
  }

  for (const sqlEx of input.sqlExamples) {
    const concepts = conceptsFromSql(sqlEx.sql);
    for (const concept of concepts) {
      addSignal(concept, {
        type: 'sql_example',
        detail: `SQL: \`${sqlEx.sql.substring(0, 100)}${sqlEx.sql.length > 100 ? '...' : ''}\``,
        source: sqlEx.file,
      });
    }
  }

  for (const sig of input.ormSignals ?? []) {
    if (sig.type === 'orm_model') {
      const concept = toSnakeCase(stripClassAffixes(sig.name));
      addSignal(concept, {
        type: 'orm_model',
        detail: `ORM model: \`${sig.name}\``,
        source: sig.file,
      });
    } else if (sig.type === 'orm_field') {
      const [modelName, fieldName] = sig.name.includes('.')
        ? sig.name.split('.', 2)
        : [sig.name, sig.name];
      const concepts = conceptsFromColumnName(fieldName, modelName.toLowerCase());
      for (const concept of concepts) {
        addSignal(concept, {
          type: 'orm_field',
          detail: `ORM field: \`${sig.name}\` (${sig.value})`,
          source: sig.file,
        });
      }
    } else if (sig.type === 'orm_enum') {
      const concept = toSnakeCase(stripClassAffixes(sig.name));
      addSignal(concept, {
        type: 'orm_enum',
        detail: `ORM enum: \`${sig.name}\` = [${sig.value}]`,
        source: sig.file,
      });
    } else if (sig.type === 'orm_scope') {
      const concept = toSnakeCase(sig.name);
      addSignal(concept, {
        type: 'orm_scope',
        detail: `Business rule (scope): \`${sig.name}\` — ${sig.value}`,
        source: sig.file,
      });
    }
  }

  const result: DomainConcept[] = [];
  for (const [concept, signals] of conceptMap) {
    if (signals.length > 0) {
      result.push({ concept, signals });
    }
  }

  return result.sort((a, b) => b.signals.length - a.signals.length);
}

const CLASS_SUFFIXES = [
  'Repositories', 'Repository',
  'Controllers', 'Controller',
  'Services', 'Service',
  'Managers', 'Manager',
  'Handlers', 'Handler',
  'Observers', 'Observer',
  'Providers', 'Provider',
  'Listeners', 'Listener',
  'Factories', 'Factory',
  'Builders', 'Builder',
  'Mappers', 'Mapper',
  'Facades', 'Facade',
  'Commands', 'Command',
  'Actions', 'Action',
  'Events', 'Event',
  'Models', 'Model',
  'Enums', 'Enum',
  'Entities', 'Entity',
  'Interfaces', 'Interface',
  'Traits', 'Trait',
  'Jobs', 'Job',
  'Middleware',
  'Dto', 'DTO',
];

const CLASS_PREFIXES = ['Abstract', 'Base'];

function stripClassAffixes(name: string): string {
  let result = name;

  for (const prefix of CLASS_PREFIXES) {
    if (result.startsWith(prefix) && result.length > prefix.length) {
      result = result.slice(prefix.length);
      break;
    }
  }

  for (const suffix of CLASS_SUFFIXES) {
    if (result.endsWith(suffix) && result.length > suffix.length) {
      result = result.slice(0, -suffix.length);
      break;
    }
  }

  return result || name;
}

function normalizeConcept(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function toSnakeCase(name: string): string {
  return name
    .replace(/([A-Z])/g, (_, letter, offset) => (offset > 0 ? '_' : '') + letter.toLowerCase())
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function conceptsFromColumnName(columnName: string, tableName: string): string[] {
  const concepts: string[] = [];

  const suffixes = ['_at', '_id', '_count', '_date', '_time', '_status', '_type', '_flag'];
  let base = columnName;
  for (const suffix of suffixes) {
    if (columnName.endsWith(suffix)) {
      base = columnName.slice(0, -suffix.length);
      break;
    }
  }

  if (base && base !== columnName) {
    concepts.push(base);
  }

  if (columnName.includes('_')) {
    const parts = columnName.split('_');
    if (parts.length >= 2) {
      concepts.push(parts[0]);
    }
  }

  const tableBase = tableName.endsWith('s') ? tableName.slice(0, -1) : tableName;
  if (!concepts.includes(tableBase) && tableBase !== base) {
    concepts.push(tableBase);
  }

  return [...new Set(concepts.filter((c) => c.length > 2))];
}

function conceptFromConstantName(name: string): string | null {
  const parts = name.toLowerCase().split('_');
  if (parts.length === 0) return null;

  if (parts.length >= 2) {
    return parts.slice(0, -1).join('_');
  }
  return parts[0];
}

function conceptFromHeading(heading: string): string | null {
  const clean = heading
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .trim();
  if (!clean) return null;

  const firstWord = clean.split(/\s+/)[0];
  return firstWord.length > 2 ? firstWord : null;
}

function conceptsFromSql(sql: string): string[] {
  const concepts: string[] = [];
  const tableMatches = sql.match(/(?:FROM|JOIN|INTO|UPDATE)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi);
  if (tableMatches) {
    for (const match of tableMatches) {
      const tableName = match.split(/\s+/)[1].toLowerCase();
      if (tableName && tableName.length > 2) {
        const base = tableName.endsWith('s') ? tableName.slice(0, -1) : tableName;
        concepts.push(base);
      }
    }
  }
  return [...new Set(concepts)];
}
