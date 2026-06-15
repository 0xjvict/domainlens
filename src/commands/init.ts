import fs from 'node:fs';
import path from 'node:path';
import * as readline from 'node:readline';

// Config field reference:
//   db_url_env              — env var name holding the database URL
//   db_type                 — 'postgres' | 'mysql' (auto-detected if unset)
//   llm_key_env             — env var name for the LLM API key
//   llm_model               — model for enrichment and extraction
//   explorer_model          — model for agent exploration (defaults to llm_model)
//   agent_max_files         — max files for agent to explore per batch
//   agent_max_context_tokens — max tokens per agent session
//   agent_batch_size        — files per sub-agent in multi-session mode (default: 40)
//   agent_strategy          — 'single' | 'multi' exploration strategy (default: 'multi')
//   agent_parallel_sessions — concurrent sub-agent sessions (default: 3)
//   code_paths              — directories to scan for code signals
//   docs_paths              — paths to scan for documentation
//   rules_paths             — paths to scan for business rule candidates
//   ignore                  — globs to exclude from scanning
//   rules_batch_size        — files per batch for LLM rule extraction
//   watch_interval_seconds  — polling interval for domainlens watch
//   orm                     — override ORM auto-detection
//   laravel_model_paths     — paths to scan for Laravel models
//   laravel_base_models     — Laravel base model classes
const DEFAULT_CONFIG = {
  db_url_env: 'DATABASE_URL',
  db_type: 'postgres',
  llm_key_env: 'OPENROUTER_API_KEY',
  llm_model: 'anthropic/claude-haiku-4-5',
  explorer_model: 'anthropic/claude-sonnet-4-6',
  agent_max_files: 150,
  agent_max_context_tokens: 100000,
  agent_batch_size: 40,
  agent_strategy: 'multi',
  agent_parallel_sessions: 3,
  code_paths: ['src/', 'app/'],
  docs_paths: ['docs/', 'README.md'],
  rules_paths: ['src/services/', 'src/validators/', 'src/policies/'],
  ignore: ['node_modules', '.git', 'dist'],
  rules_batch_size: 10,
  watch_interval_seconds: 30,
};

const GITIGNORE_ENTRIES = ['.domainlens/schemas/', '.domainlens/embeddings.db', '.domainlens/file-concept-map.json'];

interface InitOptions {
  yes?: boolean;
}

export async function runInit(projectPath: string = process.cwd(), options?: InitOptions): Promise<void> {
  const domainlensDir = path.join(projectPath, '.domainlens');
  const schemasDir = path.join(domainlensDir, 'schemas');
  const embeddingsDir = path.join(domainlensDir, 'embeddings');
  const configPath = path.join(domainlensDir, 'config.json');
  const gitignorePath = path.join(projectPath, '.gitignore');

  if (!fs.existsSync(domainlensDir)) {
    fs.mkdirSync(domainlensDir, { recursive: true });
  }
  if (!fs.existsSync(schemasDir)) {
    fs.mkdirSync(schemasDir, { recursive: true });
  }
  if (!fs.existsSync(embeddingsDir)) {
    fs.mkdirSync(embeddingsDir, { recursive: true });
  }

  if (!fs.existsSync(configPath)) {
    if (options?.yes) {
      writeDefaultConfig(configPath);
    } else {
      await runWizard(configPath, projectPath);
    }
  } else {
    console.log('✓ .domainlens/config.json already exists — skipping');
  }

  updateGitignore(gitignorePath);

  console.log('\nRun domainlens mcp-config to get the MCP snippet for your agent');
}

function writeDefaultConfig(configPath: string): void {
  fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf-8');
  console.log('✓ Created .domainlens/config.json');
}

async function runWizard(configPath: string, projectPath: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const prompt = (query: string): Promise<string> =>
    new Promise((resolve) => rl.question(query, resolve));

  const defaultDbType = detectDefaultDbType();
  const dbType = await prompt(`Database type (postgres/mysql/none) [${defaultDbType}]: `);
  const finalDbType = dbType.trim() || defaultDbType;

  const dbUrlEnv = await prompt(`Env var name for database URL [${DEFAULT_CONFIG.db_url_env}]: `);
  const finalDbUrlEnv = dbUrlEnv.trim() || DEFAULT_CONFIG.db_url_env;

  const llmKeyEnv = await prompt(`Env var name for LLM API key [${DEFAULT_CONFIG.llm_key_env}]: `);
  const finalLlmKeyEnv = llmKeyEnv.trim() || DEFAULT_CONFIG.llm_key_env;

  const detectedPaths = detectCodePaths(projectPath);
  const defaultPaths = detectedPaths.length > 0 ? detectedPaths.join(', ') : DEFAULT_CONFIG.code_paths.join(', ');
  const codePathsRaw = await prompt(`Code paths to scan (comma-separated) [${defaultPaths}]: `);
  const finalCodePaths = codePathsRaw.trim()
    ? codePathsRaw.split(',').map((p) => p.trim()).filter(Boolean)
    : (detectedPaths.length > 0 ? detectedPaths : [...DEFAULT_CONFIG.code_paths]);

  rl.close();

  const config = {
    ...DEFAULT_CONFIG,
    db_type: finalDbType === 'none' ? undefined : (finalDbType as typeof DEFAULT_CONFIG.db_type),
    db_url_env: finalDbUrlEnv,
    llm_key_env: finalLlmKeyEnv,
    code_paths: finalCodePaths,
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  console.log('✓ Created .domainlens/config.json');
  console.log('\nSummary:');
  console.log(`  Database type:   ${finalDbType}`);
  console.log(`  DB URL env var:  ${finalDbUrlEnv}`);
  console.log(`  LLM key env var: ${finalLlmKeyEnv}`);
  console.log(`  Code paths:      ${finalCodePaths.join(', ')}`);
}

function detectDefaultDbType(): string {
  const dbUrl = process.env[DEFAULT_CONFIG.db_url_env];
  if (dbUrl?.startsWith('mysql://')) return 'mysql';
  if (dbUrl?.startsWith('postgres://') || dbUrl?.startsWith('postgresql://')) return 'postgres';
  return DEFAULT_CONFIG.db_type;
}

function detectCodePaths(projectPath: string): string[] {
  const candidates = ['src/', 'app/', 'lib/'];
  return candidates.filter((dir) => fs.existsSync(path.join(projectPath, dir)));
}

function updateGitignore(gitignorePath: string): void {
  let existing = '';
  if (fs.existsSync(gitignorePath)) {
    existing = fs.readFileSync(gitignorePath, 'utf-8');
  }

  const lines = existing.split('\n');
  const toAdd = GITIGNORE_ENTRIES.filter((entry) => !lines.some((l) => l.trim() === entry));

  if (toAdd.length > 0) {
    const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(gitignorePath, existing + separator + toAdd.join('\n') + '\n', 'utf-8');
    console.log(`✓ Added ${toAdd.join(', ')} to .gitignore`);
  } else {
    console.log('✓ .gitignore already has DomainLens entries — skipping');
  }
}
