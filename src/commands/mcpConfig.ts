import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface McpConfigOptions {
  project?: string;
}

export function printMcpConfig(options: McpConfigOptions = {}): void {
  const projectPath = options.project ? path.resolve(options.project) : process.cwd();

  let binaryPath: string;
  try {
    binaryPath = fileURLToPath(import.meta.url);
    const distDir = path.dirname(binaryPath);
    binaryPath = path.resolve(distDir, '..', 'cli.js');
  } catch {
    binaryPath = process.argv[1];
  }

  if (!binaryPath) {
    binaryPath = 'domainlens';
  }

  const config = {
    mcpServers: {
      domainlens: {
        command: 'node',
        args: [binaryPath, 'start', '--project', projectPath],
      },
    },
  };

  console.log('Paste the following into your MCP config file:\n');
  console.log(JSON.stringify(config, null, 2));
}
