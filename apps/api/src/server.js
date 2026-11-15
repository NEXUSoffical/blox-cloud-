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
app.use(express.json());

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

// Create HTTP and WebSocket servers
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcastToDashboard(eventType, payload) {
    const message = JSON.stringify({ type: eventType, data: payload, timestamp: Date.now() });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

const originalCreateMatch = matchmaker.createMatch.bind(matchmaker);
matchmaker.createMatch = function(queueType, tickets) {
    const match = originalCreateMatch(queueType, tickets);
    broadcastToDashboard('MATCH_CREATED', match);
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

// Verify & Activate Session after Stripe Redirect
app.post('/api/v1/billing/verify-session', async (req, res) => {
    const user = getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

    const result = await billing.verifyAndActivateSession(sessionId);
    if (!result.success) {
        return res.status(400).json(result);
    }

    auth.updateUserPlan(user.id, result.planId);
    broadcastToDashboard('SUBSCRIPTION_UPDATED', { userId: user.id, planId: result.planId });
    res.json({ success: true, user: auth._getSafeUser(db.findUserById(user.id)), invoice: result.invoice });
});

// Direct plan activation / testing fallback
app.post('/api/v1/billing/subscribe', (req, res) => {
    const user = getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { planId, paymentMethod } = req.body;
    const subResult = billing.createSubscription(user, planId, paymentMethod || 'CREDIT_CARD_VISA');
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

app.post('/api/v1/telemetry/heartbeat', (req, res) => {
    const serverInfo = telemetry.recordHeartbeat(req.body);
    broadcastToDashboard('SERVER_HEARTBEAT', serverInfo);
    res.json({ success: true, server: serverInfo });
});

app.post('/api/v1/telemetry/error', (req, res) => {
    const errorEntry = telemetry.recordError(req.body);
    broadcastToDashboard('SERVER_ERROR_RECORDED', errorEntry);
    res.json({ success: true, error: errorEntry });
});

app.post('/api/v1/telemetry/exploit-alert', (req, res) => {
    const alertEntry = telemetry.recordExploitAlert(req.body);
    broadcastToDashboard('EXPLOIT_ALERT_RECORDED', alertEntry);
    res.json({ success: true, alert: alertEntry });
});

app.get('/api/v1/telemetry/overview', (req, res) => {
    res.json(telemetry.getOverview());
});

// -----------------------------------------------------------------------------
// METRICS & OPERATIONS
// -----------------------------------------------------------------------------

app.get('/api/v1/health', (req, res) => {
    res.json({ status: 'HEALTHY', version: '1.0.0', uptime: process.uptime() });
});

app.get('/api/v1/metrics', (req, res) => {
    const mmStats = matchmaker.getStats();
    const liveConfig = liveops.getAllConfig();
    const activeListings = marketplace.getListings();
    const txLedger = marketplace.getLedger();
    const telemetryOverview = telemetry.getOverview();

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

app.post('/api/v1/reset', (req, res) => {
    matchmaker.tickets.clear();
    matchmaker.matches.clear();
    for (const q of Object.keys(matchmaker.queues)) matchmaker.queues[q] = [];
    matchmaker.stats.totalMatchesCreated = 0;
    matchmaker.stats.activeQueuedPlayers = 0;

    liveops.flags.clear();
    liveops.activeBroadcast = null;
    liveops.auditLog = [];

    marketplace.listings.clear();
    marketplace.ledger = [];

    telemetry.activeServers.clear();
    telemetry.errorLogs = [];
    telemetry.exploitAlerts = [];

    broadcastToDashboard('DATA_RESET', {});
    res.json({ success: true, message: 'All live data has been reset to zero.' });
});

// MATCHMAKING ENDPOINTS
app.post('/api/v1/matchmaking/queue', (req, res) => {
    const { userId, username, queueType, rating, partyMembers, region } = req.body;
    if (!userId || !username) {
        return res.status(400).json({ error: 'Missing userId or username' });
    }

    const ticket = matchmaker.enqueue({ userId, username, queueType, rating, partyMembers, region });
    broadcastToDashboard('PLAYER_QUEUED', { userId, username, queueType, rating });
    res.json(ticket);
});

app.post('/api/v1/matchmaking/leave', (req, res) => {
    const { userId, ticketId } = req.body;
    const success = matchmaker.dequeue(userId, ticketId);
    res.json({ success });
});

app.get('/api/v1/matchmaking/ticket/:ticketId', (req, res) => {
    const ticket = matchmaker.getTicket(req.params.ticketId);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    res.json(ticket);
});

app.get('/api/v1/matchmaking/stats', (req, res) => {
    res.json(matchmaker.getStats());
});

// LIVEOPS & FEATURE FLAGS
app.get('/api/v1/liveops/config', (req, res) => {
    res.json(liveops.getAllConfig());
});

app.post('/api/v1/liveops/config', (req, res) => {
    const { key, value, description, changedBy } = req.body;
    if (!key || value === undefined) {
        return res.status(400).json({ error: 'Missing key or value' });
    }

    const result = liveops.setFlag(key, value, description || '', changedBy || 'Studio Admin');
    broadcastToDashboard('CONFIG_CHANGED', result);
    res.json({ success: true, result, currentConfig: liveops.getAllConfig() });
});

app.delete('/api/v1/liveops/config/:key', (req, res) => {
    const deleted = liveops.deleteFlag(req.params.key, 'Studio Admin');
    broadcastToDashboard('FLAG_DELETED', { key: req.params.key });
    res.json({ success: deleted });
});

app.post('/api/v1/liveops/broadcast', (req, res) => {
    const { message, durationSeconds, severity } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });

    const broadcast = liveops.broadcastBanner(message, durationSeconds || 60, severity || 'INFO');
    broadcastToDashboard('BROADCAST_SENT', broadcast);
    res.json({ success: true, broadcast });
});

app.post('/api/v1/liveops/broadcast/clear', (req, res) => {
    liveops.clearBroadcast();
    broadcastToDashboard('BROADCAST_CLEARED', {});
    res.json({ success: true });
});

// MARKETPLACE & AUCTION HOUSE
app.post('/api/v1/marketplace/list', (req, res) => {
    const { sellerId, sellerName, itemId, itemData, price } = req.body;
    if (!sellerId || !itemId || !price) {
        return res.status(400).json({ error: 'Missing required listing fields: sellerId, itemId, price' });
    }

    const listing = marketplace.listItem({ sellerId, sellerName, itemId, itemData, price });
    broadcastToDashboard('ITEM_LISTED', listing);
    res.json(listing);
});

app.post('/api/v1/marketplace/buy', (req, res) => {
    const { buyerId, buyerName, listingId } = req.body;
    if (!buyerId || !listingId) {
        return res.status(400).json({ error: 'buyerId and listingId required' });
    }

    const result = marketplace.buyItem(buyerId, buyerName, listingId);
    if (!result.success) {
        return res.status(400).json(result);
    }

    broadcastToDashboard('ITEM_BOUGHT', result);
    res.json(result);
});

app.get('/api/v1/marketplace/listings', (req, res) => {
    res.json({ listings: marketplace.getListings() });
});

app.get('/api/v1/marketplace/ledger', (req, res) => {
    res.json({ ledger: marketplace.getLedger() });
});

// -----------------------------------------------------------------------------
// WEBSOCKET CONNECTION
// -----------------------------------------------------------------------------
wss.on('connection', (ws) => {
    ws.send(JSON.stringify({
        type: 'INITIAL_SNAPSHOT',
        data: {
            metrics: matchmaker.getStats(),
            liveops: liveops.getAllConfig(),
            listings: marketplace.getListings(),
            ledger: marketplace.getLedger().slice(0, 10),
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
