import { pipeline, env } from '@huggingface/transformers';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type EmbeddingPipeline = Awaited<ReturnType<typeof pipeline<'feature-extraction'>>>;

let cached: EmbeddingPipeline | null = null;

export async function loadModel(): Promise<EmbeddingPipeline> {
  if (cached) return cached;
  const cacheDir = path.join(os.homedir(), '.domainlens', 'models');
  env.cacheDir = cacheDir;

  // v4 emits 'download' events even for cache hits; gate UI on actual absence of model files.
  const modelDir = path.join(cacheDir, 'Xenova', 'all-MiniLM-L6-v2');
  const needsDownload = !fs.existsSync(modelDir);
  let downloading = false;

  const progressCallback = (info: Record<string, unknown>) => {
    if (!needsDownload) return;
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

  cached = extractor;
  return cached;
}
