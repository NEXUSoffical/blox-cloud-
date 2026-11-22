/**
 * BloxCloud Core API, Authentication & Billing Server
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');

const auth = require('./auth');
const billing = require('./billing');
const telemetry = require('./telemetry');
const matchmaker = require('./matchmaker');
const liveops = require('./liveops');
const marketplace = require('./marketplace');
const alerts = require('./alerts');
const db = require('./db');
const robloxGenerator = require('./robloxGenerator');

// In-memory cache for AI generated Roblox games (expires after 1 hour)
const generatedGamesCache = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of generatedGamesCache.entries()) {
        if (v.expiresAt < now) generatedGamesCache.delete(k);
    }
}, 5 * 60 * 1000).unref();

const app = express();
const port = process.env.PORT || 3001;

// Trust Render / reverse proxy so req.ip cannot be spoofed via raw X-Forwarded-For headers
app.set('trust proxy', 1);

app.use(cors());
// Keep the exact raw request bytes so webhook signatures can be verified correctly
app.use(express.json({
    limit: '256kb',
    verify: (req, res, buf) => { req.rawBody = buf; },
}));

// Standard security headers
app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'SAMEORIGIN');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

// -----------------------------------------------------------------------------
// SIMPLE IN-MEMORY RATE LIMITER (per trusted IP + key)
// -----------------------------------------------------------------------------
const rateBuckets = new Map();
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = Number(process.env.RATE_LIMIT_PER_MIN || 600);
setInterval(() => rateBuckets.clear(), RATE_WINDOW_MS);

app.use('/api/', (req, res, next) => {
    const keyId = req.headers['x-api-key'] || req.headers['x-public-key'] || '';
    const id = keyId + '|' + (req.ip || 'unknown');
    const count = (rateBuckets.get(id) || 0) + 1;
    rateBuckets.set(id, count);
    if (count > RATE_MAX) {
        return res.status(429).json({ error: 'Rate limit exceeded. Slow down requests.' });
    }
    next();
});

// Disable all caching
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
});

// Serve the Web Dashboard
const dashboardPath = path.resolve(__dirname, '../../dashboard/public');
app.use(express.static(dashboardPath, { etag: false, maxAge: 0 }));

// Documentation & Legal page routes
app.get('/docs', (req, res) => {
    res.sendFile('docs.html', { root: dashboardPath });
});

app.get(['/legal', '/terms', '/privacy'], (req, res) => {
    res.sendFile('legal.html', { root: dashboardPath });
});

app.get('/status', (req, res) => {
    res.sendFile('status.html', { root: dashboardPath });
});

// Path to Luau, Minecraft & Web/JS SDKs
const sdkPath = path.resolve(__dirname, '../../../sdk/BloxCloud.luau');
const minecraftSdkPath = path.resolve(__dirname, '../../../sdk/BloxCloudPlugin.java');
const webSdkPath = path.resolve(__dirname, '../../../sdk/BloxCloud.js');

// Auth middleware helper
function getAuthUser(req) {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return null;
    const token = authHeader.replace(/^Bearer\s+/i, '');
    return auth.getUserByToken(token);
}

// Dashboard routes: require a logged-in studio session
function requireSession(req, res, next) {
    const user = getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized: please log in.' });
    req.user = user;
    next();
}

// Game server (Roblox / Minecraft / Node backend) routes: require a valid secret studio API key.
// A logged-in dashboard session is also accepted so the dashboard can call the same endpoints.
function requireGameKey(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    if (apiKey) {
        const owner = auth.getUserByApiKey(apiKey);
        if (owner) {
            req.user = auth._getSafeUser(owner);
            req.isServerAuth = true;
            return next();
        }
        return res.status(401).json({ error: 'Invalid API key.' });
    }
    const user = getAuthUser(req);
    if (user) {
        req.user = user;
        req.isServerAuth = true;
        return next();
    }
    return res.status(401).json({ error: 'Unauthorized: missing x-api-key header.' });
}

// Player-scoped routes (matchmaking, marketplace): accepts secret x-api-key (server),
// dashboard session, OR a cryptographically signed x-player-token (browser/Web3 client).
function requireClientOrServerAuth(req, res, next) {
    const playerToken = req.headers['x-player-token'];
    if (playerToken) {
        const verified = auth.verifyPlayerToken(playerToken);
        if (verified) {
            req.user = verified.studio;
            req.player = { playerId: verified.playerId, username: verified.username };
            req.isServerAuth = false;
            return next();
        }
        return res.status(401).json({ error: 'Invalid or expired x-player-token.' });
    }
    return requireGameKey(req, res, next);
}

// Public-readable routes (LiveOps flags, marketplace listings): also accepts x-public-key (bc_pub_...)
function requirePublicReadOrServerAuth(req, res, next) {
    const pubKey = req.headers['x-public-key'];
    if (pubKey) {
        const owner = auth.getUserByPublicKey(pubKey);
        if (owner) {
            req.user = auth._getSafeUser(owner);
            req.isServerAuth = false;
            return next();
        }
        return res.status(401).json({ error: 'Invalid x-public-key.' });
    }
    return requireClientOrServerAuth(req, res, next);
}

// Platform-owner-only routes (e.g. full data reset)
function requireAdmin(req, res, next) {
    const user = getAuthUser(req);
    const admins = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    if (!user || !admins.includes(user.email.toLowerCase())) {
        return res.status(403).json({ error: 'Forbidden.' });
    }
    req.user = user;
    next();
}

// Create HTTP and WebSocket servers
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcastToDashboard(eventType, payload, studioId = null) {
    const message = JSON.stringify({ type: eventType, data: payload, timestamp: Date.now() });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            // Only send event to the studio dashboard that owns it
            if (!studioId || client.userId === studioId) {
                client.send(message);
            }
        }
    });
}

const originalCreateMatch = matchmaker.createMatch.bind(matchmaker);
matchmaker.createMatch = function(queueType, tickets, studioId = 'default') {
    const match = originalCreateMatch(queueType, tickets, studioId);
    broadcastToDashboard('MATCH_CREATED', match, studioId);
    return match;
};

// -----------------------------------------------------------------------------
// AUTHENTICATION ROUTES
// -----------------------------------------------------------------------------

app.post('/api/v1/auth/signup', async (req, res) => {
    const { email, password, username, studioName } = req.body;
    if (!email || !password) {
        return res.status(400).json({ success: false, error: 'Email and password are required.' });
    }

    try {
        const result = await auth.register(email, password, username, studioName);
        if (!result.success) return res.status(400).json(result);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, error: 'Internal server error during registration.' });
    }
});

app.post('/api/v1/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ success: false, error: 'Email and password are required.' });
    }

    try {
        const result = await auth.login(email, password);
        if (!result.success) return res.status(401).json(result);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, error: 'Internal server error during login.' });
    }
});

// Strict rate limiter for password reset endpoints (max 5 attempts per 15 minutes per IP)
const authResetBuckets = new Map();
setInterval(() => authResetBuckets.clear(), 15 * 60 * 1000).unref();
function rateLimitPasswordReset(req, res, next) {
    const ip = req.ip || 'unknown';
    const count = (authResetBuckets.get(ip) || 0) + 1;
    authResetBuckets.set(ip, count);
    if (count > 5) {
        return res.status(429).json({ success: false, error: 'Too many password reset requests. Please wait 15 minutes and try again.' });
    }
    next();
}

app.post('/api/v1/auth/forgot-password', rateLimitPasswordReset, async (req, res) => {
    const { email } = req.body || {};
    if (!email) {
        return res.status(400).json({ success: false, error: 'Email is required.' });
    }
    try {
        const result = await auth.requestPasswordReset(email);
        if (!result.success) {
            return res.status(result.status || 400).json({ success: false, error: result.error });
        }
        res.json({ success: true, message: result.message });
    } catch (e) {
        res.status(500).json({ success: false, error: 'Error initiating password reset.' });
    }
});

app.post('/api/v1/auth/reset-password', rateLimitPasswordReset, async (req, res) => {
    const { email, code, newPassword } = req.body || {};
    if (!email || !code || !newPassword) {
        return res.status(400).json({ success: false, error: 'Email, verification code, and new password are required.' });
    }
    try {
        const result = await auth.resetPassword(email, code, newPassword);
        if (!result.success) return res.status(400).json(result);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, error: 'Error resetting password.' });
    }
});

app.post('/api/v1/auth/logout', (req, res) => {
    const authHeader = req.headers['authorization'];
    if (authHeader) {
        const token = authHeader.replace(/^Bearer\s+/i, '');
        auth.logout(token);
    }
    res.json({ success: true });
});

app.get('/api/v1/auth/me', (req, res) => {
    const user = getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    res.json({ user });
});

app.post('/api/v1/auth/key/regenerate', (req, res) => {
    const user = getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const newKey = auth.regenerateApiKey(user.id);
    res.json({ success: true, apiKey: newKey });
});

// -----------------------------------------------------------------------------
// BILLING & SUBSCRIPTION ROUTES (STRIPE POWERED)
// -----------------------------------------------------------------------------

app.get('/api/v1/billing/plans', (req, res) => {
    res.json({ plans: billing.getPlans() });
});

// Create Stripe Checkout Session
app.post('/api/v1/billing/checkout-session', async (req, res) => {
    const user = getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { planId } = req.body;
    const origin = req.headers.origin || `${req.protocol}://${req.get('host')}`;

    const result = await billing.createCheckoutSession(user, planId, origin);
    if (result.free) {
        auth.updateUserPlan(user.id, 'FREE');
        broadcastToDashboard('SUBSCRIPTION_UPDATED', { userId: user.id, planId: 'FREE' }, user.id);
        return res.json({ success: true, user: auth._getSafeUser(db.findUserById(user.id)) });
    }

    res.json(result);
});

// Polar.sh Webhook Listener (Standard Webhooks specification)
const processedPolarWebhookIds = new Set();

app.post('/api/v1/billing/polar/webhook', (req, res) => {
    try {
        const secret = process.env.POLAR_WEBHOOK_SECRET || process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
        if (!secret) {
            console.error('[BloxCloud Polar] Webhook rejected: POLAR_WEBHOOK_SECRET is not set.');
            return res.status(503).json({ error: 'Webhook not configured' });
        }

        const rawBody = req.rawBody;
        if (!rawBody || !billing.verifyPolarWebhookSignature(rawBody, req.headers, secret)) {
            return res.status(401).json({ error: 'Invalid webhook signature' });
        }

        // Idempotency: ignore duplicate deliveries of the exact same webhook-id
        const webhookId = req.headers['webhook-id'];
        if (webhookId) {
            if (processedPolarWebhookIds.has(webhookId)) {
                return res.json({ received: true, duplicate: true });
            }
            processedPolarWebhookIds.add(webhookId);
            if (processedPolarWebhookIds.size > 1000) {
                const oldest = processedPolarWebhookIds.values().next().value;
                processedPolarWebhookIds.delete(oldest);
            }
        }

        const payload = req.body || {};
        const eventType = String(payload.type || '');
        const data = payload.data || {};
        const metadata = data.metadata || {};
        const customer = data.customer || {};
        const product = data.product || {};

        let userId = metadata.user_id || metadata.reference_id || customer.external_id || null;
        if (!userId && customer.email) {
            const byEmail = db.findUserByEmail(String(customer.email).trim().toLowerCase());
            if (byEmail) userId = byEmail.id;
        }

        if (userId) {
            const productName = product.name || data.product_name || '';
            const planId = billing.planIdFromProductName(productName);
            const subStatus = String(data.status || '').toLowerCase();

            const isEnded = eventType === 'subscription.revoked' ||
                (eventType === 'subscription.updated' && (subStatus === 'revoked' || subStatus === 'unpaid' || subStatus === 'incomplete_expired'));

            if (isEnded) {
                auth.updateUserPlan(userId, 'FREE');
                broadcastToDashboard('SUBSCRIPTION_UPDATED', { userId, planId: 'FREE' }, userId);
                console.log(`[BloxCloud Polar] User ${userId} subscription ended (${eventType}/${subStatus})`);
            } else if (eventType === 'subscription.canceled') {
                // Customer keeps access until current_period_end; downgrade happens on subscription.revoked
                console.log(`[BloxCloud Polar] User ${userId} cancelled; access continues until period end`);
            } else if (
                eventType === 'subscription.created' ||
                eventType === 'subscription.active' ||
                eventType === 'order.paid' ||
                (eventType === 'subscription.updated' && (subStatus === 'active' || subStatus === 'trialing'))
            ) {
                if (!planId) {
                    console.error(`[BloxCloud Polar] Unknown product "${productName}" in ${eventType}`);
                    return res.json({ received: true, ignored: true });
                }
                auth.updateUserPlan(userId, planId);
                const user = db.findUserById(userId);
                // Only record 1 invoice per billing event (Polar sends subscription.created, subscription.active,
                // subscription.updated, and order.paid together on checkout).
                if (user && (eventType === 'order.paid' || eventType === 'subscription.created')) {
                    const recentInvoices = billing.getUserInvoices(userId);
                    const hasRecent = recentInvoices.some(
                        inv => inv.planId === planId && Date.now() - (inv.timestamp || 0) < 5 * 60 * 1000
                    );
                    if (!hasRecent) {
                        billing.createSubscription(user, planId, 'POLAR');
                    }
                }
                broadcastToDashboard('SUBSCRIPTION_UPDATED', { userId, planId }, userId);
                console.log(`[BloxCloud Polar] User ${userId} upgraded to ${planId}`);
            }
        }

        res.json({ received: true });
    } catch (e) {
        console.error('[BloxCloud Polar Webhook Error]:', e);
        res.status(500).json({ error: e.message });
    }
});

// Plan changes are ONLY applied by the verified Polar.sh webhook above.
// This endpoint is kept solely for downgrading to the Free plan.
app.post('/api/v1/billing/subscribe', (req, res) => {
    const user = getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { planId } = req.body;
    if (planId !== 'FREE') {
        return res.status(403).json({ success: false, error: 'Paid plans can only be activated through Polar.sh checkout.' });
    }
    const subResult = billing.createSubscription(user, 'FREE', 'FREE_TIER');
    if (!subResult.success) {
        return res.status(400).json(subResult);
    }

    auth.updateUserPlan(user.id, planId);
    broadcastToDashboard('SUBSCRIPTION_UPDATED', { userId: user.id, planId }, user.id);
    res.json({ success: true, subscription: subResult, user: auth._getSafeUser(db.findUserById(user.id)) });
});

app.get('/api/v1/billing/invoices', (req, res) => {
    const user = getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    res.json({ invoices: billing.getUserInvoices(user.id) });
});

// -----------------------------------------------------------------------------
// SDK CODE & DOWNLOAD ENDPOINTS
// -----------------------------------------------------------------------------

app.get('/api/v1/sdk/code', (req, res) => {
    try {
        const code = fs.readFileSync(sdkPath, 'utf8');
        res.json({ code });
    } catch (err) {
        res.status(500).json({ error: 'Failed to read SDK source' });
    }
});

app.get('/api/v1/sdk/download', (req, res) => {
    try {
        res.download(sdkPath, 'BloxCloud.luau');
    } catch (err) {
        res.status(500).json({ error: 'Failed to download SDK' });
    }
});

app.get('/api/v1/sdk/minecraft/code', (req, res) => {
    try {
        const code = fs.readFileSync(minecraftSdkPath, 'utf8');
        res.json({ code });
    } catch (err) {
        res.status(500).json({ error: 'Failed to read Minecraft plugin source' });
    }
});

app.get('/api/v1/sdk/minecraft/download', (req, res) => {
    try {
        res.download(minecraftSdkPath, 'BloxCloudPlugin.java');
    } catch (err) {
        res.status(500).json({ error: 'Failed to download Minecraft plugin source' });
    }
});

// Pre-compiled drag-and-drop BloxCloud.jar built by GitHub Actions Maven workflow
app.get('/api/v1/sdk/minecraft/download-jar', (req, res) => {
    const localJar = path.resolve(__dirname, '../../../sdk/minecraft/target/BloxCloud.jar');
    if (fs.existsSync(localJar)) {
        return res.download(localJar, 'BloxCloud.jar');
    }
    res.redirect(302, 'https://github.com/NEXUSoffical/blox-cloud-/releases/download/minecraft-latest/BloxCloud.jar');
});

// Direct CDN script endpoint for HTML5, Three.js, Phaser & Web3/Crypto games
app.get('/sdk/web.js', (req, res) => {
    try {
        res.set('Content-Type', 'application/javascript; charset=utf-8');
        res.sendFile(webSdkPath);
    } catch (err) {
        res.status(500).send('// Failed to serve BloxCloud Web SDK');
    }
});

app.get('/api/v1/sdk/web/code', (req, res) => {
    try {
        const code = fs.readFileSync(webSdkPath, 'utf8');
        res.json({ code });
    } catch (err) {
        res.status(500).json({ error: 'Failed to read Web/JS SDK source' });
    }
});

app.get('/api/v1/sdk/web/download', (req, res) => {
    try {
        res.download(webSdkPath, 'BloxCloud.js');
    } catch (err) {
        res.status(500).json({ error: 'Failed to download Web/JS SDK' });
    }
});

// -----------------------------------------------------------------------------
// TELEMETRY & LIVE SERVER STATS (Stats Roblox Does Not Provide)
// -----------------------------------------------------------------------------

app.post('/api/v1/telemetry/heartbeat', requireGameKey, (req, res) => {
    const studioId = req.user.id;
    const plan = billing.getPlan(req.user.plan);
    const overview = telemetry.getOverview(studioId);
    const existingServer = overview.servers.find(s => s.jobId === req.body.jobId);
    if (!existingServer && plan.limits && overview.totalServers >= plan.limits.maxServers) {
        return res.status(402).json({
            error: `Plan limit reached: your ${plan.name} plan allows up to ${plan.limits.maxServers} concurrent live server nodes. Upgrade your plan for additional server capacity.`,
            code: 'PLAN_LIMIT_REACHED',
        });
    }
    const incomingPlayers = Number(req.body.playerCount) || 0;
    const otherPlayers = overview.totalLivePlayers - (existingServer ? existingServer.playerCount : 0);
    if (plan.limits && plan.limits.maxConcurrentPlayers && (otherPlayers + incomingPlayers) > plan.limits.maxConcurrentPlayers) {
        return res.status(402).json({
            error: `Plan limit reached: your ${plan.name} plan supports up to ${plan.limits.maxConcurrentPlayers} concurrent online players. Upgrade your plan for higher player capacity.`,
            code: 'PLAN_LIMIT_REACHED',
        });
    }
    const serverInfo = telemetry.recordHeartbeat(req.body, studioId);
    broadcastToDashboard('SERVER_HEARTBEAT', serverInfo, studioId);
    if (serverInfo && serverInfo.health === 'DEGRADED') {
        alerts.notifyServerDegraded(req.user, serverInfo);
    }
    res.json({ success: true, server: serverInfo });
});

app.post('/api/v1/telemetry/error', requireGameKey, (req, res) => {
    const studioId = req.user.id;
    const errorEntry = telemetry.recordError(req.body, studioId);
    broadcastToDashboard('SERVER_ERROR_RECORDED', errorEntry, studioId);
    alerts.notifyScriptError(req.user, errorEntry);
    res.json({ success: true, error: errorEntry });
});

app.post('/api/v1/telemetry/exploit-alert', requireGameKey, (req, res) => {
    const studioId = req.user.id;
    const alertEntry = telemetry.recordExploitAlert(req.body, studioId);
    broadcastToDashboard('EXPLOIT_ALERT_RECORDED', alertEntry, studioId);
    alerts.notifyExploitAlert(req.user, alertEntry);
    res.json({ success: true, alert: alertEntry });
});

app.get('/api/v1/telemetry/overview', requireSession, (req, res) => {
    const studioId = req.user.id;
    res.json(telemetry.getOverview(studioId));
});

// -----------------------------------------------------------------------------
// DISCORD SRE WEBHOOK ALERTS CONFIGURATION
// -----------------------------------------------------------------------------

app.post('/api/v1/settings/discord-webhook', requireSession, (req, res) => {
    const url = String((req.body && req.body.webhookUrl) || '').trim();
    if (url && !alerts.isValidDiscordWebhook(url)) {
        return res.status(400).json({
            success: false,
            error: 'Invalid Discord Webhook URL. Must start with https://discord.com/api/webhooks/...',
        });
    }
    auth.updateDiscordWebhook(req.user.id, url);
    res.json({ success: true, discordWebhookUrl: url });
});

app.post('/api/v1/settings/discord-webhook/test', requireSession, async (req, res) => {
    const url = String((req.body && req.body.webhookUrl) || req.user.discordWebhookUrl || '').trim();
    if (!alerts.isValidDiscordWebhook(url)) {
        return res.status(400).json({ success: false, error: 'Please save a valid Discord Webhook URL first.' });
    }
    const result = await alerts.sendDiscordEmbed(url, {
        title: `BloxCloud SRE Connected (${req.user.studioName})`,
        description: 'Your studio is now receiving real-time server degradation, runtime crash, and anti-dupe exploit alerts.',
        color: 0x06b6d4,
        fields: [
            { name: 'Plan', value: req.user.plan, inline: true },
            { name: 'Status', value: 'ACTIVE', inline: true },
        ],
    });
    if (!result.sent) {
        return res.status(502).json({ success: false, error: 'Discord rejected the webhook request. Double-check the URL.' });
    }
    res.json({ success: true });
});

// -----------------------------------------------------------------------------
// METRICS & OPERATIONS
// -----------------------------------------------------------------------------

const SERVER_STARTED_AT = new Date().toISOString();

app.get('/api/v1/health', (req, res) => {
    res.json({ status: 'HEALTHY', version: '1.0.0', uptime: process.uptime() });
});

app.get('/api/v1/status/public', (req, res) => {
    const hasPg = Boolean(process.env.DATABASE_URL);
    const hasResend = Boolean(process.env.RESEND_API_KEY);
    res.json({
        status: 'OPERATIONAL',
        version: '1.0.0',
        uptimeSeconds: Math.floor(process.uptime()),
        startedAt: SERVER_STARTED_AT,
        nodeVersion: process.version,
        database: {
            connected: true,
            mode: hasPg ? 'PostgreSQL Cloud' : 'Local Persistent JSON',
        },
        services: [
            { name: 'Core REST API & Telemetry Engine', status: 'OPERATIONAL', detail: 'Multi-tenant Roblox, Minecraft & Web3 ingestion' },
            { name: 'WebSocket Live Dashboard Sync', status: 'OPERATIONAL', detail: 'Real-time event streaming & emergency broadcasts' },
            { name: 'Cloud Database Persistence', status: 'OPERATIONAL', detail: hasPg ? 'Render Managed PostgreSQL (Serialized Writes)' : 'Local JSON Persistence' },
            { name: 'AI Game Studio (.rbxlx Compiler)', status: 'OPERATIONAL', detail: 'Procedural 3D world & Luau SDK generator' },
            { name: 'Transactional Email Security (Resend)', status: hasResend ? 'OPERATIONAL' : 'DEGRADED', detail: hasResend ? 'Verified domain password recovery active' : 'Awaiting RESEND_API_KEY configuration' },
            { name: 'Discord SRE & Exploit Alert Dispatcher', status: 'OPERATIONAL', detail: 'SSRF-validated webhook notifications with cooldowns' },
        ],
        timestamp: Date.now(),
    });
});

app.get('/api/v1/studio/export', requireSession, (req, res) => {
    const user = req.user;
    const studioId = user.id;
    const exportPayload = {
        exportedAt: new Date().toISOString(),
        platform: 'BloxCloud',
        schemaVersion: '1.0.0',
        studio: {
            id: user.id,
            username: user.username,
            studioName: user.studioName,
            email: user.email,
            plan: user.plan,
            createdAt: user.createdAt,
        },
        usage: {
            monthlyMatches: db.getMonthlyMatchCount(studioId),
            monthlyAiGenerations: db.getMonthlyGenerationCount(studioId),
        },
        liveOpsFlags: db.getFlags(studioId),
        marketplaceListings: db.getListings(studioId),
        transactionLedger: db.getLedger(studioId),
        invoices: db.getUserInvoices(studioId),
    };

    const dateStr = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="bloxcloud-studio-backup-${dateStr}.json"`);
    res.send(JSON.stringify(exportPayload, null, 2));
});

app.get('/api/v1/metrics', requireSession, (req, res) => {
    const studioId = req.user.id;
    const mmStats = matchmaker.getStats(studioId);
    const liveConfig = liveops.getAllConfig(studioId);
    const activeListings = marketplace.getListings(studioId);
    const txLedger = marketplace.getLedger(studioId);
    const telemetryOverview = telemetry.getOverview(studioId);

    res.json({
        totalMatchesCreated: mmStats.totalMatchesCreated,
        activeQueuedPlayers: mmStats.activeQueuedPlayers,
        queues: mmStats.queues,
        recentMatches: mmStats.recentMatches,
        liveConfig: liveConfig.config,
        flags: liveConfig.flags,
        activeBroadcast: liveConfig.activeBroadcast,
        totalActiveListings: activeListings.length,
        totalTransactions: txLedger.length,
        recentTransactions: txLedger.slice(0, 10),
        telemetry: telemetryOverview,
    });
});

app.post('/api/v1/reset', requireAdmin, (req, res) => {
    const studioId = req.body && req.body.studioId ? req.body.studioId : null;

    if (studioId) {
        matchmaker.clearStudio(studioId);
        telemetry.clearStudio(studioId);
        marketplace.clearStudio(studioId);
        db.resetLiveOpsAndMarket(studioId);
        broadcastToDashboard('DATA_RESET', {}, studioId);
        return res.json({ success: true, message: `Studio data for ${studioId} has been reset.` });
    }

    matchmaker.tickets.clear();
    matchmaker.matches.clear();
    matchmaker.queues = {};

    liveops.activeBroadcasts.clear();
    liveops.auditLog = [];

    telemetry.activeServers.clear();
    telemetry.errorLogs = [];
    telemetry.exploitAlerts = [];

    db.resetLiveOpsAndMarket();

    broadcastToDashboard('DATA_RESET', {});
    res.json({ success: true, message: 'All live data has been reset to zero.' });
});

// -----------------------------------------------------------------------------
// WEB / WEB3 CLIENT PLAYER SESSION TOKENS (Safe Browser Auth — No Secret Key Exposure)
// -----------------------------------------------------------------------------

// Pure browser / HTML5 / Web3 games authenticate with their public key (bc_pub_...)
// to obtain an HMAC-signed player session token scoped strictly to one playerId.
app.post('/api/v1/client/session', (req, res) => {
    const pubKey = req.headers['x-public-key'];
    const studioUser = auth.getUserByPublicKey(pubKey);
    if (!studioUser) {
        return res.status(401).json({ error: 'Invalid or missing x-public-key header.' });
    }
    const { playerId, username } = req.body || {};
    if (!playerId || String(playerId).trim().length < 2) {
        return res.status(400).json({ error: 'Valid playerId is required.' });
    }
    const cleanId = String(playerId).trim().slice(0, 128);
    const cleanName = String(username || cleanId).trim().slice(0, 64);
    const playerToken = auth.signPlayerToken(studioUser, cleanId, cleanName);
    res.json({ success: true, playerToken, playerId: cleanId, username: cleanName });
});

// Cryptographic Solana / Phantom Ed25519 Wallet Login (Step 1: Get 1-time Nonce Challenge)
app.post('/api/v1/client/web3-challenge', (req, res) => {
    const pubKey = req.headers['x-public-key'];
    const studioUser = auth.getUserByPublicKey(pubKey);
    if (!studioUser) {
        return res.status(401).json({ error: 'Invalid or missing x-public-key header.' });
    }
    const { walletAddress } = req.body || {};
    const result = auth.createWeb3Challenge(studioUser.id, walletAddress);
    if (!result.success) return res.status(400).json(result);
    res.json(result);
});

// Cryptographic Solana / Phantom Ed25519 Wallet Login (Step 2: Verify Signature -> Mint Player Token)
app.post('/api/v1/client/web3-verify', (req, res) => {
    const pubKey = req.headers['x-public-key'];
    const studioUser = auth.getUserByPublicKey(pubKey);
    if (!studioUser) {
        return res.status(401).json({ error: 'Invalid or missing x-public-key header.' });
    }
    const { walletAddress, signatureBase64, nonce } = req.body || {};
    const result = auth.verifySolanaChallenge(studioUser, walletAddress, signatureBase64, nonce);
    if (!result.success) return res.status(401).json(result);
    res.json(result);
});

// Backend-verified player token minting (Web3 servers verify wallet signature first, then mint token)
app.post('/api/v1/auth/player-token', requireGameKey, (req, res) => {
    const studioUser = db.findUserById(req.user.id);
    if (!studioUser) return res.status(404).json({ error: 'Studio not found.' });
    const { playerId, username, ttlSeconds } = req.body || {};
    if (!playerId) return res.status(400).json({ error: 'playerId is required.' });
    const ttlMs = Math.min(7 * 24 * 3600, Math.max(60, Number(ttlSeconds || 86400))) * 1000;
    const playerToken = auth.signPlayerToken(studioUser, playerId, username, ttlMs);
    res.json({ success: true, playerToken, playerId: String(playerId) });
});

// MATCHMAKING ENDPOINTS
app.post('/api/v1/matchmaking/queue', requireClientOrServerAuth, (req, res) => {
    const studioId = req.user.id;
    const body = req.body || {};
    // If called from a browser client (x-player-token), force identity to the signed token's playerId
    const userId = req.player ? req.player.playerId : body.userId;
    const username = req.player ? req.player.username : body.username;
    const { queueType, rating, partyMembers, region } = body;
    if (!userId || !username) {
        return res.status(400).json({ error: 'Missing userId or username' });
    }

    const plan = billing.getPlan(req.user.plan);
    const mmStats = matchmaker.getStats(studioId);
    if (plan.limits && mmStats.totalMatchesCreated >= plan.limits.maxMatchesPerMonth) {
        return res.status(402).json({
            error: `Plan limit reached: your ${plan.name} plan includes ${plan.limits.maxMatchesPerMonth} matches/month.`,
            code: 'PLAN_LIMIT_REACHED',
        });
    }

    const ticket = matchmaker.enqueue({ userId, username, queueType, rating, partyMembers, region }, studioId);
    broadcastToDashboard('PLAYER_QUEUED', { userId, username, queueType, rating }, studioId);
    res.json(ticket);
});

app.post('/api/v1/matchmaking/leave', requireClientOrServerAuth, (req, res) => {
    const studioId = req.user.id;
    const body = req.body || {};
    const userId = req.player ? req.player.playerId : body.userId;
    const ticketId = req.player ? undefined : body.ticketId;
    const success = matchmaker.dequeue(userId, ticketId, studioId);
    res.json({ success });
});

app.get('/api/v1/matchmaking/ticket/:ticketId', requireClientOrServerAuth, (req, res) => {
    const studioId = req.user.id;
    const ticket = matchmaker.getTicket(req.params.ticketId, studioId);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (req.player && String(ticket.userId) !== String(req.player.playerId)) {
        return res.status(403).json({ error: 'Forbidden: ticket belongs to another player.' });
    }
    res.json(ticket);
});

app.get('/api/v1/matchmaking/match/:matchId', requireClientOrServerAuth, (req, res) => {
    const studioId = req.user.id;
    const match = matchmaker.getMatch(req.params.matchId, studioId);
    if (!match) return res.status(404).json({ error: 'Match not found' });
    res.json(match);
});

// Coordinate a real Roblox TeleportService:ReserveServer() access code or WebRTC/room ID across matched servers/players
app.post('/api/v1/matchmaking/match/:matchId/server-code', requireClientOrServerAuth, (req, res) => {
    const studioId = req.user.id;
    const { robloxAccessCode } = req.body;
    const result = matchmaker.claimOrSetServerCode(req.params.matchId, robloxAccessCode, studioId);
    if (!result.success) {
        return res.status(result.error === 'MATCH_NOT_FOUND' ? 404 : 400).json(result);
    }
    broadcastToDashboard('MATCH_SERVER_READY', result.match, studioId);
    res.json(result);
});

app.get('/api/v1/matchmaking/stats', requireSession, (req, res) => {
    const studioId = req.user.id;
    res.json(matchmaker.getStats(studioId));
});

// LIVEOPS & FEATURE FLAGS
app.get('/api/v1/liveops/config', requirePublicReadOrServerAuth, (req, res) => {
    const studioId = req.user.id;
    res.json(liveops.getAllConfig(studioId));
});

app.post('/api/v1/liveops/config', requireSession, (req, res) => {
    const studioId = req.user.id;
    const { key, value, description } = req.body;
    if (!key || value === undefined) {
        return res.status(400).json({ error: 'Missing key or value' });
    }

    const plan = billing.getPlan(req.user.plan);
    const currentFlags = db.getFlags(studioId);
    const isExistingFlag = currentFlags.some(f => f.key === key);
    if (!isExistingFlag && plan.limits && currentFlags.length >= plan.limits.liveOpsFlags) {
        return res.status(402).json({
            error: `Plan limit reached: your ${plan.name} plan allows up to ${plan.limits.liveOpsFlags} feature flags. Upgrade your plan to add more.`,
            code: 'PLAN_LIMIT_REACHED',
        });
    }

    const result = liveops.setFlag(key, value, description || '', req.user.username || 'Studio Admin', studioId);
    broadcastToDashboard('CONFIG_CHANGED', result, studioId);
    res.json({ success: true, result, currentConfig: liveops.getAllConfig(studioId) });
});

app.delete('/api/v1/liveops/config/:key', requireSession, (req, res) => {
    const studioId = req.user.id;
    const deleted = liveops.deleteFlag(req.params.key, req.user.username || 'Studio Admin', studioId);
    broadcastToDashboard('FLAG_DELETED', { key: req.params.key }, studioId);
    res.json({ success: deleted });
});

app.post('/api/v1/liveops/broadcast', requireSession, (req, res) => {
    const studioId = req.user.id;
    const { message, durationSeconds, severity } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });

    const broadcast = liveops.broadcastBanner(message, durationSeconds || 60, severity || 'INFO', studioId);
    broadcastToDashboard('BROADCAST_SENT', broadcast, studioId);
    res.json({ success: true, broadcast });
});

app.post('/api/v1/liveops/broadcast/clear', requireSession, (req, res) => {
    const studioId = req.user.id;
    liveops.clearBroadcast(studioId);
    broadcastToDashboard('BROADCAST_CLEARED', {}, studioId);
    res.json({ success: true });
});

// MARKETPLACE & AUCTION HOUSE
app.post('/api/v1/marketplace/list', requireClientOrServerAuth, (req, res) => {
    const studioId = req.user.id;
    const body = req.body || {};
    const sellerId = req.player ? req.player.playerId : body.sellerId;
    const sellerName = req.player ? req.player.username : body.sellerName;
    const { itemId, itemData, price } = body;
    const numPrice = Math.floor(Number(price));
    if (!sellerId || !itemId || !Number.isFinite(numPrice) || numPrice <= 0) {
        return res.status(400).json({ error: 'Valid sellerId, itemId, and a positive integer price are required' });
    }

    const plan = billing.getPlan(req.user.plan);
    const activeListings = marketplace.getListings(studioId);
    if (plan.limits && activeListings.length >= plan.limits.maxActiveListings) {
        return res.status(402).json({
            error: `Plan limit reached: your ${plan.name} plan allows up to ${plan.limits.maxActiveListings} active marketplace listings.`,
            code: 'PLAN_LIMIT_REACHED',
        });
    }

    const listing = marketplace.listItem({ sellerId, sellerName, itemId, itemData, price: numPrice }, studioId);
    broadcastToDashboard('ITEM_LISTED', listing, studioId);
    res.json(listing);
});

app.post('/api/v1/marketplace/buy', requireClientOrServerAuth, (req, res) => {
    const studioId = req.user.id;
    const body = req.body || {};
    const buyerId = req.player ? req.player.playerId : body.buyerId;
    const buyerName = req.player ? req.player.username : body.buyerName;
    const { listingId } = body;
    if (!buyerId || !listingId) {
        return res.status(400).json({ error: 'buyerId and listingId required' });
    }

    const result = marketplace.buyItem(buyerId, buyerName, listingId, studioId);
    if (!result.success) {
        return res.status(400).json(result);
    }

    broadcastToDashboard('ITEM_BOUGHT', result, studioId);
    res.json(result);
});

app.get('/api/v1/marketplace/listings', requirePublicReadOrServerAuth, (req, res) => {
    const studioId = req.user.id;
    res.json({ listings: marketplace.getListings(studioId) });
});

app.get('/api/v1/marketplace/ledger', requireSession, (req, res) => {
    const studioId = req.user.id;
    res.json({ ledger: marketplace.getLedger(studioId) });
});

// -----------------------------------------------------------------------------
// AI GAME STUDIO GENERATOR (ROBLOX) — Plan-Gated & Auto-Connected
// -----------------------------------------------------------------------------
const MAX_GENERATED_GAMES_CACHE = 100;

app.post('/api/v1/generator/roblox/generate', requireSession, (req, res) => {
    try {
        const user = req.user;
        const plan = billing.getPlan(user.plan);
        const maxPerMonth = plan.limits.maxAiGamesPerMonth ?? 2;
        const usedThisMonth = db.getMonthlyGenerationCount(user.id);

        if (usedThisMonth >= maxPerMonth) {
            return res.status(403).json({
                success: false,
                code: 'PLAN_LIMIT_REACHED',
                error: `Monthly AI Game Studio limit reached (${usedThisMonth}/${maxPerMonth} on ${plan.name}). Upgrade to Pro (£24/mo for 15 games/mo) or Studio (£79/mo for unlimited games).`,
                generationsUsed: usedThisMonth,
                generationsLimit: Number.isFinite(maxPerMonth) ? maxPerMonth : -1,
            });
        }

        const { title, genre, theme, difficulty, stagesCount, monetization } = req.body || {};
        const studioName = user.studioName || user.username || 'Your Studio';

        const host = req.get('host') || 'bloxcloud.world';
        const isLocal = host.includes('localhost') || host.includes('127.0.0.1');
        const baseUrl = isLocal ? `http://${host}` : 'https://bloxcloud.world';

        const game = robloxGenerator.compileRobloxPlace({
            title: title || 'Cyberpunk Tower Obby',
            genre: genre || 'obby',
            theme: theme || 'cyberpunk',
            difficulty: difficulty || 'medium',
            stagesCount: Math.min(Math.max(Number(stagesCount) || 25, 5), 100),
            apiKey: user.apiKey,
            baseUrl,
            monetization: monetization || {}
        });

        // Cap in-memory cache size to prevent RAM exhaustion
        if (generatedGamesCache.size >= MAX_GENERATED_GAMES_CACHE) {
            const oldestKey = generatedGamesCache.keys().next().value;
            if (oldestKey) generatedGamesCache.delete(oldestKey);
        }

        const newUsedCount = db.incrementMonthlyGenerationCount(user.id);
        const gameId = crypto.randomBytes(16).toString('hex');
        generatedGamesCache.set(gameId, {
            ...game,
            studioId: user.id,
            createdAt: Date.now(),
            expiresAt: Date.now() + 60 * 60 * 1000 // 1 hour
        });

        res.json({
            success: true,
            gameId,
            title: game.title,
            gameSlug: game.gameSlug,
            genre: game.genre,
            theme: game.theme,
            studioName,
            dashboardConnected: game.dashboardConnected,
            generationsUsed: newUsedCount,
            generationsLimit: Number.isFinite(maxPerMonth) ? maxPerMonth : -1,
            fileSize: game.fileSize,
            downloadUrl: `/api/v1/generator/roblox/download/${gameId}`
        });
    } catch (err) {
        console.error('[BloxCloud Generator] Generation failed:', err);
        res.status(500).json({ success: false, error: err.message || 'Game generation failed' });
    }
});

app.get('/api/v1/generator/roblox/download/:id', (req, res) => {
    const game = generatedGamesCache.get(req.params.id);
    if (!game) {
        return res.status(404).send('Generated game file not found or expired. Please generate a new one.');
    }

    const filename = `${game.title.replace(/[^a-zA-Z0-9_-]/g, '_')}.rbxlx`;
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(game.xml);
});

// -----------------------------------------------------------------------------
// WEBSOCKET CONNECTION
// -----------------------------------------------------------------------------
wss.on('connection', (ws, req) => {
    // Only logged-in dashboard sessions may subscribe to the live feed
    let token = null;
    try {
        token = new URL(req.url, 'http://localhost').searchParams.get('token');
    } catch (e) { /* ignore */ }
    const user = auth.getUserByToken(token);
    if (!user) {
        ws.close(4401, 'Unauthorized');
        return;
    }
    // Tag the WebSocket with the studio/user ID
    ws.userId = user.id;

    ws.send(JSON.stringify({
        type: 'INITIAL_SNAPSHOT',
        data: {
            metrics: matchmaker.getStats(user.id),
            liveops: liveops.getAllConfig(user.id),
            listings: marketplace.getListings(user.id),
            ledger: marketplace.getLedger(user.id).slice(0, 10),
        },
        timestamp: Date.now(),
    }));
});

// Start Server
async function startServer() {
    try {
        await db.initCloud();
    } catch (err) {
        console.error('[BloxCloud] Cloud DB initialization warning:', err);
    }
    server.listen(port, () => {
        console.log(`[BloxCloud] API, Auth & Billing Server listening on http://localhost:${port}`);

        // Built-in 24/7 keep-alive pulse on Render so the instance never spins down after 15m idle
        if (process.env.RENDER || process.env.DATABASE_URL) {
            const keepAliveUrl = process.env.RENDER_EXTERNAL_URL
                ? `${process.env.RENDER_EXTERNAL_URL}/api/v1/health`
                : 'https://bloxcloud.world/api/v1/health';
            setInterval(() => {
                fetch(keepAliveUrl).catch(() => {});
            }, 10 * 60 * 1000).unref();
        }
    });
}

startServer();
