import { createServer, closeServer } from './server';

if (!process.env.DATA_DIR) {
    console.error('[Boot] FATAL: DATA_DIR environment variable is not set. Please set DATA_DIR to the path of your data directory.');
    process.exit(1);
}
const dataDir = process.env.DATA_DIR;
const port = parseInt(process.env.PORT || '3000', 10);
const geonamesDb = process.env.GEONAMES_DB;
// Behind a reverse proxy, set TRUST_PROXY (e.g. "true", a hop count, or a CIDR list)
// so rate limits apply per real client instead of to the proxy's IP.
const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
const rateLimitMax = process.env.RATE_LIMIT_MAX ? parseInt(process.env.RATE_LIMIT_MAX, 10) : undefined;

function parseTrustProxy(value: string | undefined): boolean | number | string | undefined {
    if (value === undefined || value === '') return undefined;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return /^\d+$/.test(value) ? parseInt(value, 10) : value;
}

async function bootstrap() {
    console.log(`[Boot] Starting LegacyGraph server...`);
    console.log(`[Boot] Data Directory: ${dataDir}`);

    try {
        const server = await createServer({
            dataDir,
            port,
            geonamesDb,
            trustProxy,
            ...(rateLimitMax && { rateLimit: { max: rateLimitMax, timeWindow: '1 minute' } }),
            awaitHydration: false // Run hydration in background while server accepts early connections
        });

        await server.listen({ port, host: '0.0.0.0' });
        console.log(`[Boot] Server listening on http://0.0.0.0:${port}`);

        // Graceful Shutdown Handlers (Phase 3.9.2)
        const shutdown = async (signal: string) => {
            console.log(`\n[Boot] Received ${signal}. Initiating graceful shutdown...`);

            try {
                // server.close() is synchronous for accepting new connections, but awaits existing ones
                // Our onClose hook inside server.ts will automatically trap this and execute
                // GraphEngine.stopWatcher() and TransactionManager.destroy() to flush any debounced commits.
                await closeServer(server);
                console.log(`[Boot] Graceful shutdown complete. Exiting cleanly.`);
                process.exit(0);
            } catch (err) {
                console.error(`[Boot] Error during shutdown:`, err);
                process.exit(1);
            }
        };

        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));

    } catch (err) {
        console.error('[Boot] Bootstrap failed:', err);
        process.exit(1);
    }
}

bootstrap();
