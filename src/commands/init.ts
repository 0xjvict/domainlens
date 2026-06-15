import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_CONFIG = {
  db_url_env: 'DATABASE_URL',
  db_type: 'postgres',
  llm_key_env: 'OPENROUTER_API_KEY',
  llm_model: 'anthropic/claude-haiku-4-5',
  explorer_model: 'anthropic/claude-sonnet-4-6',
  agent_max_files: 150,
  agent_max_context_tokens: 100000,
  code_paths: ['src/', 'app/'],
  docs_paths: ['docs/', 'README.md'],
  rules_paths: ['src/services/', 'src/validators/', 'src/policies/'],
  ignore: ['node_modules', '.git', 'dist'],
  rules_batch_size: 10,
  watch_interval_seconds: 30,
};

const GITIGNORE_ENTRIES = ['.domainlens/schemas/', '.domainlens/embeddings.db', '.domainlens/file-concept-map.json'];

export function runInit(projectPath: string = process.cwd()): void {
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
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf-8');
    console.log('✓ Created .domainlens/config.json');
  } else {
    console.log('✓ .domainlens/config.json already exists — skipping');
  }

  updateGitignore(gitignorePath);

  console.log('\nRun domainlens mcp-config to get the MCP snippet for your agent');
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
