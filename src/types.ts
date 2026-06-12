export interface DomainLensConfig {
  db_url_env: string;
  llm_key_env: string;
  llm_model: string;
  code_paths: string[];
  docs_paths: string[];
  ignore: string[];
  orm?: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  comment: string | null;
}

export interface ForeignKey {
  column: string;
  references_table: string;
  references_column: string;
  constraint_name: string;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface CheckConstraint {
  name: string;
  definition: string;
}

export interface UniqueConstraint {
  name: string;
  columns: string[];
}

export interface TableInfo {
  name: string;
  schema: string;
  columns: ColumnInfo[];
  primary_keys: string[];
  foreign_keys: ForeignKey[];
  indexes: IndexInfo[];
  check_constraints: CheckConstraint[];
  unique_constraints: UniqueConstraint[];
}

export interface EnumType {
  name: string;
  schema: string;
  values: string[];
}

export interface SchemaCache {
  extracted_at: string;
  tables: TableInfo[];
  enums: EnumType[];
}
