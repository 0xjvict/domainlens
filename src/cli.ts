#!/usr/bin/env node
import { Command } from 'commander';
import { runInit } from './commands/init.js';
import { runDiscover } from './commands/discover.js';
import { loadModel } from './embeddings/model.js';

const program = new Command();

program
  .name('domainlens')
  .description('AI-native domain knowledge layer for code agents')
  .version('0.1.0');

program
  .command('init')
  .description('Initialize DomainLens in the current project')
  .action(() => {
    runInit();
  });

program
  .command('discover')
  .description('Extract schema, code, and docs; generate skill files')
  .option('--dry-run', 'Preview what would be written without touching the filesystem')
  .option('--force', 'Regenerate all skills from scratch, overwriting existing files')
  .option('--no-enrich', 'Skip LLM enrichment and write skeleton skills only')
  .option('--embeddings', 'Also run the embedding pipeline after skill generation')
  .option('--project <path>', 'Path to the project (default: current directory)')
  .action((opts) => {
    runDiscover({
      dryRun: opts.dryRun,
      force: opts.force,
      noEnrich: opts.enrich === false,
      embeddings: opts.embeddings,
      project: opts.project,
    }).catch((err: unknown) => {
      console.error('Error:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
  });

const modelsCmd = program.command('models').description('Manage embedding models');

modelsCmd
  .command('download')
  .description('Pre-download and cache the embedding model (~80MB, happens once)')
  .action(async () => {
    await loadModel();
    console.log('Embedding model ready.');
  });

program
  .command('start')
  .description('Start the MCP stdio server for AI agent integration')
  .option('--project <path>', 'Path to the project (default: current directory)')
  .action(async (opts) => {
    const { startServer } = await import('./mcp/server.js');
    const projectPath = opts.project ? opts.project : process.cwd();
    process.stderr.write('DomainLens MCP server started (stdio)\n');
    await startServer(projectPath);
  });

program
  .command('status')
  .description('Show project statistics summary')
  .option('--project <path>', 'Path to the project (default: current directory)')
  .action(async (opts) => {
    const { runStatus } = await import('./commands/status.js');
    runStatus({ project: opts.project });
  });

const skillsCmd = program.command('skills').description('List and inspect generated skills');

skillsCmd
  .command('list')
  .description('List all generated skills in a table')
  .option('--project <path>', 'Path to the project (default: current directory)')
  .action(async (opts) => {
    const { listSkills } = await import('./commands/skills.js');
    listSkills({ project: opts.project });
  });

skillsCmd
  .command('show <name>')
  .description('Show the full Markdown content of a skill')
  .option('--project <path>', 'Path to the project (default: current directory)')
  .action(async (name, opts) => {
    const { showSkill } = await import('./commands/skills.js');
    showSkill(name, { project: opts.project });
  });

program
  .command('mcp-config')
  .description('Print MCP configuration JSON for your AI agent')
  .option('--project <path>', 'Path to the project (default: current directory)')
  .action(async (opts) => {
    const { printMcpConfig } = await import('./commands/mcpConfig.js');
    printMcpConfig({ project: opts.project });
  });

program.parse(process.argv);
