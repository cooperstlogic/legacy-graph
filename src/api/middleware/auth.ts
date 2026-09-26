// src/api/middleware/auth.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { loadYaml } from '../../core/yaml';
import { AuthConfig, AuthConfigSchema } from '../../schemas/AuthSchema';

// Routes that do NOT require authentication
const PUBLIC_ROUTES: Array<{ method: string; url: string }> = [
    { method: 'POST', url: '/api/auth/login' },
    { method: 'GET', url: '/api/system/status' },
    { method: 'GET', url: '/api/system/hydration/stream' },
];

function isPublicRoute(method: string, url: string): boolean {
    return PUBLIC_ROUTES.some(
        route => route.method === method && url.startsWith(route.url)
    );
}

/**
 * Load and validate auth config from /_meta/auth.yaml.
 * Returns null if the file doesn't exist (auth disabled).
 */
export async function loadAuthConfig(dataDir: string): Promise<AuthConfig | null> {
    const authPath = path.join(dataDir, '_meta', 'auth.yaml');
    try {
        const raw = await fs.readFile(authPath, 'utf-8');
        const parsed = loadYaml(raw);
        return AuthConfigSchema.parse(parsed);
    } catch (err: unknown) {
        if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
            return null; // No auth file — auth disabled
        }
        throw new Error(`Invalid auth config at ${authPath}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
}

/**
 * Authenticate a user against the auth config.
 * Returns the username if valid, null otherwise.
 */
export async function authenticateUser(
    authConfig: AuthConfig,
    username: string,
    password: string
): Promise<string | null> {
    const user = authConfig.users.find(u => u.username === username);
    if (!user) return null;

    const valid = await bcrypt.compare(password, user.password_hash);
    return valid ? user.username : null;
}

/**
 * Issue a JWT token for the given username.
 */
export function issueToken(authConfig: AuthConfig, username: string): string {
    return jwt.sign(
        { username },
        authConfig.jwt_secret,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- jwt.sign expiresIn accepts string but types require number|undefined
        { expiresIn: authConfig.session_expiry as any }
    );
}

/**
 * Verify a JWT token. Returns the decoded payload or null if invalid/expired.
 */
export function verifyToken(
    authConfig: AuthConfig,
    token: string
): { username: string } | null {
    try {
        const decoded = jwt.verify(token, authConfig.jwt_secret) as { username: string };
        return decoded;
    } catch {
        return null;
    }
}

/**
 * Register the auth guard as a Fastify onRequest hook.
 * If authConfig is null, auth is disabled and all routes are public.
 */
export function registerAuthGuard(
    server: FastifyInstance,
    authConfig: AuthConfig | null
): void {
    if (!authConfig) return; // Auth disabled — no guard

    server.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
        if (isPublicRoute(request.method, request.url)) {
            return; // Skip auth for public routes
        }

        const token = request.cookies?.token;

        if (!token) {
            return reply.status(401).send({
                error: 'Authentication required',
                code: 'UNAUTHORIZED'
            });
        }

        const decoded = verifyToken(authConfig, token);
        if (!decoded) {
            return reply.status(401).send({
                error: 'Invalid or expired token',
                code: 'INVALID_TOKEN'
            });
        }

        // Attach user info to request for downstream use
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Fastify request decoration for auth user
        (request as any).user = decoded;
    });
}
