import { pipeline, env } from '@xenova/transformers';
import * as os from 'os';
import * as path from 'path';

export type EmbeddingPipeline = Awaited<ReturnType<typeof pipeline<'feature-extraction'>>>;

export async function loadModel(): Promise<EmbeddingPipeline> {
  const cacheDir = path.join(os.homedir(), '.domainlens', 'models');
  // env.cacheDir is mutable at runtime; the d.ts exposes it as a re-exported const
  (env as unknown as { cacheDir: string }).cacheDir = cacheDir;

  let downloading = false;

  const progressCallback = (info: Record<string, unknown>) => {
    if (info['status'] === 'download' && !downloading) {
      downloading = true;
      process.stdout.write(
        'Downloading embedding model (~80MB) to ~/.domainlens/models/ — this happens once.\n',
      );
    }
    if (info['status'] === 'progress' && downloading && typeof info['progress'] === 'number') {
      process.stdout.write(`\r  Progress: ${Math.round(info['progress'] as number)}%   `);
    }
  };

  const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
    progress_callback: progressCallback,
  });

  if (downloading) {
    process.stdout.write('\n');
  }

  return extractor;
}
