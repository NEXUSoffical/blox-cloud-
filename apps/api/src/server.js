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
const db = require('./db');

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
// Keep the exact raw request bytes so webhook signatures can be verified correctly
app.use(express.json({
    limit: '256kb',
    verify: (req, res, buf) => { req.rawBody = buf; },
}));

// -----------------------------------------------------------------------------
// SIMPLE IN-MEMORY RATE LIMITER (per IP + API key)
// -----------------------------------------------------------------------------
const rateBuckets = new Map();
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = Number(process.env.RATE_LIMIT_PER_MIN || 600);
setInterval(() => rateBuckets.clear(), RATE_WINDOW_MS);

app.use('/api/', (req, res, next) => {
    const id = (req.headers['x-api-key'] || '') + '|' + (req.headers['x-forwarded-for'] || req.ip);
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

// Path to Luau SDK
const sdkPath = path.resolve(__dirname, '../../../sdk/BloxCloud.luau');

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

// Game server (Roblox SDK) routes: require a valid studio API key.
// A logged-in dashboard session is also accepted so the dashboard can call the same endpoints.
function requireGameKey(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    if (apiKey) {
        const owner = auth.getUserByApiKey(apiKey);
        if (owner) {
            req.user = auth._getSafeUser(owner);
            return next();
        }
        return res.status(401).json({ error: 'Invalid API key.' });
    }
    const user = getAuthUser(req);
    if (user) {
        req.user = user;
        return next();
    }
    return res.status(401).json({ error: 'Unauthorized: missing x-api-key header.' });
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
        broadcastToDashboard('SUBSCRIPTION_UPDATED', { userId: user.id, planId: 'FREE' });
        return res.json({ success: true, user: auth._getSafeUser(db.findUserById(user.id)) });
    }

    res.json(result);
});

// Lemon Squeezy Webhook Listener
app.post('/api/v1/billing/lemonsqueezy/webhook', (req, res) => {
    try {
        const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
        if (!secret) {
            console.error('[BloxCloud LemonSqueezy] Webhook rejected: LEMONSQUEEZY_WEBHOOK_SECRET is not set.');
            return res.status(503).json({ error: 'Webhook not configured' });
        }

        const signature = req.headers['x-signature'];
        const rawBody = req.rawBody;
        if (!rawBody || !billing.verifyWebhookSignature(rawBody, signature, secret)) {
            return res.status(401).json({ error: 'Invalid webhook signature' });
        }

        const payload = req.body;
        const eventName = payload.meta && payload.meta.event_name;
        const customData = payload.meta && payload.meta.custom_data;

        if (customData && customData.user_id) {
            const userId = customData.user_id;
            // Derive the plan from the product actually purchased (signed by Lemon Squeezy),
            // never from user-editable custom checkout data.
            const attrs = (payload.data && payload.data.attributes) || {};
            const productName = attrs.product_name || (attrs.first_order_item && attrs.first_order_item.product_name) || '';
            const planId = billing.planIdFromProductName(productName);
            if (!planId && !(eventName === 'subscription_cancelled' || eventName === 'subscription_expired')) {
                console.error(`[BloxCloud LemonSqueezy] Unknown product "${productName}" in ${eventName}`);
                return res.json({ received: true, ignored: true });
            }

            const subStatus = String(attrs.status || '').toLowerCase();
            const isEnded = eventName === 'subscription_expired' ||
                (eventName === 'subscription_updated' && (subStatus === 'expired' || subStatus === 'unpaid'));

            if (isEnded) {
                auth.updateUserPlan(userId, 'FREE');
                broadcastToDashboard('SUBSCRIPTION_UPDATED', { userId, planId: 'FREE' });
                console.log(`[BloxCloud LemonSqueezy] User ${userId} subscription ended (${eventName}/${subStatus})`);
            } else if (eventName === 'subscription_created' || eventName === 'order_created' || eventName === 'subscription_updated') {
                auth.updateUserPlan(userId, planId);
                const user = db.findUserById(userId);
                if (user) {
                    billing.createSubscription(user, planId, 'LEMON_SQUEEZY');
                }
                broadcastToDashboard('SUBSCRIPTION_UPDATED', { userId, planId });
                console.log(`[BloxCloud LemonSqueezy] User ${userId} upgraded to ${planId}`);
            } else if (eventName === 'subscription_cancelled') {
                // Customer keeps access until the paid period ends; downgrade happens on subscription_expired.
                console.log(`[BloxCloud LemonSqueezy] User ${userId} cancelled; access continues until period end`);
            }
        }

        res.json({ received: true });
    } catch (e) {
        console.error('[BloxCloud LemonSqueezy Webhook Error]:', e);
        res.status(500).json({ error: e.message });
    }
});

// Plan changes are ONLY applied by the verified Lemon Squeezy webhook above.
// This endpoint is kept solely for downgrading to the Free plan.
app.post('/api/v1/billing/subscribe', (req, res) => {
    const user = getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { planId } = req.body;
    if (planId !== 'FREE') {
        return res.status(403).json({ success: false, error: 'Paid plans can only be activated through Lemon Squeezy checkout.' });
    }
    const subResult = billing.createSubscription(user, 'FREE', 'FREE_TIER');
    if (!subResult.success) {
        return res.status(400).json(subResult);
    }

    auth.updateUserPlan(user.id, planId);
    broadcastToDashboard('SUBSCRIPTION_UPDATED', { userId: user.id, planId });
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

// -----------------------------------------------------------------------------
// TELEMETRY & LIVE SERVER STATS (Stats Roblox Does Not Provide)
// -----------------------------------------------------------------------------

app.post('/api/v1/telemetry/heartbeat', requireGameKey, (req, res) => {
    const studioId = req.user.id;
    const serverInfo = telemetry.recordHeartbeat(req.body, studioId);
    broadcastToDashboard('SERVER_HEARTBEAT', serverInfo, studioId);
    res.json({ success: true, server: serverInfo });
});

app.post('/api/v1/telemetry/error', requireGameKey, (req, res) => {
    const studioId = req.user.id;
    const errorEntry = telemetry.recordError(req.body, studioId);
    broadcastToDashboard('SERVER_ERROR_RECORDED', errorEntry, studioId);
    res.json({ success: true, error: errorEntry });
});

app.post('/api/v1/telemetry/exploit-alert', requireGameKey, (req, res) => {
    const studioId = req.user.id;
    const alertEntry = telemetry.recordExploitAlert(req.body, studioId);
    broadcastToDashboard('EXPLOIT_ALERT_RECORDED', alertEntry, studioId);
    res.json({ success: true, alert: alertEntry });
});

app.get('/api/v1/telemetry/overview', requireSession, (req, res) => {
    const studioId = req.user.id;
    res.json(telemetry.getOverview(studioId));
});

// -----------------------------------------------------------------------------
// METRICS & OPERATIONS
// -----------------------------------------------------------------------------

app.get('/api/v1/health', (req, res) => {
    res.json({ status: 'HEALTHY', version: '1.0.0', uptime: process.uptime() });
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

    marketplace.listings.clear();
    marketplace.ledger = [];

    telemetry.activeServers.clear();
    telemetry.errorLogs = [];
    telemetry.exploitAlerts = [];

    db.resetLiveOpsAndMarket();

    broadcastToDashboard('DATA_RESET', {});
    res.json({ success: true, message: 'All live data has been reset to zero.' });
});

// MATCHMAKING ENDPOINTS
app.post('/api/v1/matchmaking/queue', requireGameKey, (req, res) => {
    const studioId = req.user.id;
    const { userId, username, queueType, rating, partyMembers, region } = req.body;
    if (!userId || !username) {
        return res.status(400).json({ error: 'Missing userId or username' });
    }

    const ticket = matchmaker.enqueue({ userId, username, queueType, rating, partyMembers, region }, studioId);
    broadcastToDashboard('PLAYER_QUEUED', { userId, username, queueType, rating }, studioId);
    res.json(ticket);
});

app.post('/api/v1/matchmaking/leave', requireGameKey, (req, res) => {
    const studioId = req.user.id;
    const { userId, ticketId } = req.body;
    const success = matchmaker.dequeue(userId, ticketId, studioId);
    res.json({ success });
});

app.get('/api/v1/matchmaking/ticket/:ticketId', requireGameKey, (req, res) => {
    const studioId = req.user.id;
    const ticket = matchmaker.getTicket(req.params.ticketId, studioId);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    res.json(ticket);
});

app.get('/api/v1/matchmaking/stats', requireSession, (req, res) => {
    const studioId = req.user.id;
    res.json(matchmaker.getStats(studioId));
});

// LIVEOPS & FEATURE FLAGS
app.get('/api/v1/liveops/config', requireGameKey, (req, res) => {
    const studioId = req.user.id;
    res.json(liveops.getAllConfig(studioId));
});

app.post('/api/v1/liveops/config', requireSession, (req, res) => {
    const studioId = req.user.id;
    const { key, value, description } = req.body;
    if (!key || value === undefined) {
        return res.status(400).json({ error: 'Missing key or value' });
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
app.post('/api/v1/marketplace/list', requireGameKey, (req, res) => {
    const studioId = req.user.id;
    const { sellerId, sellerName, itemId, itemData, price } = req.body;
    if (!sellerId || !itemId || !price) {
        return res.status(400).json({ error: 'Missing required listing fields: sellerId, itemId, price' });
    }

    const listing = marketplace.listItem({ sellerId, sellerName, itemId, itemData, price }, studioId);
    broadcastToDashboard('ITEM_LISTED', listing, studioId);
    res.json(listing);
});

app.post('/api/v1/marketplace/buy', requireGameKey, (req, res) => {
    const studioId = req.user.id;
    const { buyerId, buyerName, listingId } = req.body;
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

app.get('/api/v1/marketplace/listings', requireGameKey, (req, res) => {
    const studioId = req.user.id;
    res.json({ listings: marketplace.getListings(studioId) });
});

app.get('/api/v1/marketplace/ledger', requireSession, (req, res) => {
    const studioId = req.user.id;
    res.json({ ledger: marketplace.getLedger(studioId) });
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
    });
}

startServer();
