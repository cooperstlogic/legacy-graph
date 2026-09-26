// src/core/BootLoader.ts
import fg from 'fast-glob';
import pLimit from 'p-limit';
import * as fs from 'fs/promises';
import * as path from 'path';
import { loadYaml } from './yaml';
import { PersonSchema, Person } from '../schemas/PersonSchema';

export class BootLoader {
    private rootDir: string;

    constructor(rootDir: string) {
        this.rootDir = rootDir;
    }

    async loadAll(): Promise<{ data: Person; filePath: string }[]> {
        // 1. Glob: fetch all yaml paths
        // fast-glob requires forward slashes even on Windows
        const pattern = path.join(this.rootDir, '*.yaml').replace(/\\/g, '/');
        const files = await fg(pattern);

        console.log(`[BootLoader] Found ${files.length} files in ${this.rootDir}`);

        // 2. Pipeline: Limit concurrency to 50
        const limit = pLimit(50);

        const promises = files.map((file) =>
            limit(async () => {
                try {
                    // Read File Stream
                    const content = await fs.readFile(file, 'utf8');

                    // Parse YAML
                    const raw = loadYaml(content);

                    // Validate Zod Schema
                    const data = PersonSchema.parse(raw);

                    // Validate Assets (Fsck)
                    if (data.assets && data.assets.length > 0) {
                        await this.validateAssets(data.assets, file);
                    }

                    return { data, filePath: file };
                } catch (err: unknown) {
                    console.warn(`[BootLoader] Failed to load ${file}: ${err instanceof Error ? err.message : String(err)}`);
                    return null;
                }
            })
        );

        // Wait for all to finish
        const results = await Promise.all(promises);
        return results.filter((r): r is { data: Person; filePath: string } => r !== null);
    }

    private async validateAssets(assets: string[], sourceFile: string): Promise<void> {
        // Assume assets are in a sibling directory "../assets" relative to rootDir
        // rootDir is likely ".../people", so assets is ".../assets"
        // But BootLoader is generic for "people", "stories" etc? 
        // Actually BootLoader is instantiated with ".../people". 
        // Asset root should be `path.join(this.rootDir, '../assets')` ??
        // Let's assume standard layout:
        // /data/people
        // /data/assets
        
        const assetDir = path.resolve(this.rootDir, '../assets');

        for (const asset of assets) {
            const assetPath = path.join(assetDir, asset);
            try {
                await fs.access(assetPath);
            } catch {
                console.warn(`[AssetIntegrity] Missing asset referenced in ${path.basename(sourceFile)}: ${asset}`);
            }
        }
    }
}
