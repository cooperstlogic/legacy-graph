import Fastify, { FastifyInstance, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import cookie from '@fastify/cookie';
import compress from '@fastify/compress';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import * as path from 'path';
import { GraphEngine } from './core/GraphEngine';
import { TransactionManager } from './core/TransactionManager';
import { GeocodingService } from './core/GeocodingService';
import { JobManager } from './core/JobManager';
import { loadAuthConfig, registerAuthGuard } from './api/middleware/auth';
import { systemRoutes } from './api/routes/system';
import { authRoutes } from './api/routes/auth';
import { searchRoutes } from './api/routes/search';
import { peopleRoutes } from './api/routes/people';
import { gedcomRoutes } from './api/routes/gedcom';
import { storiesRoutes } from './api/routes/stories';
import { assetsRoutes } from './api/routes/assets';
import { geocodingRoutes } from './api/routes/geocoding';
import { mapRoutes } from './api/routes/map';
import type { AppServices } from './api/types';

export interface ServerConfig {
    logger?: boolean;
    dataDir: string;
    port?: number;
    /** If false, createServer returns immediately while hydration runs in background (503 until ready).
     *  Defaults to true for backward compatibility (server blocks until graph is hydrated). */
    awaitHydration?: boolean;
    /** Path to GeoNames SQLite database. Falls back to GEONAMES_DB env var or ~/.legacy-graph/geonames.db */
    geonamesDb?: string;
    /** Per-client API rate limit (default 600 requests per minute). */
    rateLimit?: { max: number; timeWindow: string | number };
    /** Fastify `trustProxy`: set when behind a reverse proxy so `request.ip` is the real client. */
    trustProxy?: FastifyServerOptions['trustProxy'];
}

export const DEFAULT_RATE_LIMIT = { max: 600, timeWindow: '1 minute' } as const;

export async function createServer(config: ServerConfig): Promise<FastifyInstance> {
    // Typed up front: an inline union-typed trustProxy steers inference to the HTTP/2 overload
    const options: FastifyServerOptions = {
        logger: config.logger ?? true,
        trustProxy: config.trustProxy ?? false,
    };
    const server = Fastify(options);

    await server.register(cors, { origin: true });
    await server.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
    await server.register(cookie);
    await server.register(compress, { global: true, encodings: ['br', 'gzip'] });
    // Applies to every route registered after this. Keyed per user when authenticated
    // (the auth guard's onRequest hook runs before the route-level limiter), else per IP,
    // so users sharing an office NAT or a reverse proxy don't share a bucket.
    // Static assets are exempt: a thumbnail grid fetches dozens at once.
    await server.register(rateLimit, {
        ...(config.rateLimit ?? DEFAULT_RATE_LIMIT),
        keyGenerator: (request) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- set by the auth guard
            const username = (request as any).user?.username as string | undefined;
            return username ? `user:${username}` : `ip:${request.ip}`;
        },
        allowList: (request) => request.url.startsWith('/assets/'),
        errorResponseBuilder: (_request, context) => ({
            statusCode: context.statusCode,
            error: `Too many requests, retry in ${context.after}`,
            code: 'RATE_LIMITED',
        }),
    });

    const authConfig = await loadAuthConfig(config.dataDir);
    if (authConfig) {
        registerAuthGuard(server, authConfig);
        console.log('[Server] Authentication enabled');
    } else {
        console.log('[Server] No auth config found — authentication disabled');
    }

    const graphEngine = new GraphEngine(config.dataDir);

    const hydrationPromise = graphEngine.hydrateInBackground().then(async () => {
        console.log('[Server] GraphEngine hydrated successfully');
        await graphEngine.startWatcher();
    }).catch(error => {
        console.error('[Server] Failed to hydrate GraphEngine:', error);
    });

    if (config.awaitHydration !== false) {
        await hydrationPromise;
    }

    const txManager = new TransactionManager(config.dataDir, {
        onFileWritten: (absolutePath: string) => {
            graphEngine.registerSelfWrite(absolutePath);
        }
    });

    const geocodingService = new GeocodingService(config.dataDir, {
        dbPath: config.geonamesDb,
    });

    const jobManager = new JobManager();

    // Decorate server with services so route plugins can access them
    const appServices: AppServices = { graphEngine, txManager, authConfig, dataDir: config.dataDir, geocodingService, jobManager };
    server.decorate('appServices', appServices);

    // 503 Loading Gate (spec 2.3C)
    server.addHook('onRequest', async (request, reply) => {
        if (graphEngine.hydrationState !== 'ready') {
            const url = request.url;
            if (url === '/api/system/status' ||
                url === '/api/system/hydration/stream' ||
                url === '/api/auth/login' ||
                url === '/api/auth/logout') {
                return;
            }
            return reply.status(503).send({
                error: 'Graph is loading',
                code: 'HYDRATION_IN_PROGRESS'
            });
        }
    });

    server.addHook('onClose', async () => {
        await graphEngine.close();
        await txManager.destroy();
    });

    // Register route plugins
    await server.register(systemRoutes);
    await server.register(authRoutes);
    await server.register(searchRoutes);
    await server.register(peopleRoutes);
    await server.register(gedcomRoutes);
    await server.register(storiesRoutes);
    await server.register(assetsRoutes);
    await server.register(geocodingRoutes);
    await server.register(mapRoutes);

    // Phase 3.9.3 Static Asset Delivery Performance
    await server.register(fastifyStatic, {
        root: path.resolve(config.dataDir, 'assets'),
        prefix: '/assets/',
        acceptRanges: true,
        etag: true,
        cacheControl: true,
        maxAge: 31536000000, // 365 days in ms
        immutable: true,
        // @fastify/static v10 passes a FastifyReply here (v9 passed the raw
        // ServerResponse), so use reply.header() rather than res.setHeader().
        setHeaders: (reply) => {
            reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        }
    });

    return server;
}

export async function closeServer(server: FastifyInstance): Promise<void> {
    await server.close();
}
