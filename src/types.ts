export type DbType = 'postgres' | 'mysql';

export interface DomainLensConfig {
  db_url_env: string;
  db_type?: DbType;
  llm_key_env: string;
  llm_model: string;
  explorer_model?: string;
  agent_max_files?: number;
  agent_max_context_tokens?: number;
  agent_batch_size?: number;
  agent_strategy?: 'single' | 'multi';
  agent_parallel_sessions?: number;
  code_paths: string[];
  docs_paths: string[];
  rules_paths?: string[];
  ignore: string[];
  rules_batch_size?: number;
  watch_interval_seconds?: number;
  orm?: string;
  laravel_model_paths?: string[];
  laravel_base_models?: string[];
}

export interface Signal {
  type: string;
  value: string;
  file?: string;
}

export interface AgentConcept {
  concept: string;
  definition: string;
  signals: Signal[];
  states?: string[];
  business_rules?: string[];
  related_concepts?: string[];
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

export interface BusinessRule {
  name: string;
  description: string;
  trigger: string;
  conditions: string[];
  effect: string;
  enforced_in: string[];
  related_concepts: string[];
}

export interface SchemaCache {
  extracted_at: string;
  tables: TableInfo[];
  enums: EnumType[];
}
