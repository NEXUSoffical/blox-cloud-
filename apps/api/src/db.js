/**
 * BloxCloud Persistent Database Engine
 * Persists all users, sessions, API keys, billing subscriptions, and liveops flags.
 * Supports both local file persistence and cloud PostgreSQL (DATABASE_URL).
 * Survives server restarts, crashes, reboots, and Render redeployments.
 */

const fs = require('fs');
const path = require('path');

const dataDir = path.resolve(__dirname, '../../../data');
const dbFile = path.resolve(dataDir, 'database.json');

// Ensure data directory exists
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const defaultSchema = {
    users: [],
    sessions: [],
    invoices: [],
    flags: [],
    listings: [],
    ledger: [],
    matchCounts: {},
};

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

let pgPool = null;
if (process.env.DATABASE_URL) {
    try {
        const { Pool } = require('pg');
        pgPool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false }
        });
        console.log('[BloxCloud DB] PostgreSQL DATABASE_URL detected, initializing cloud storage...');
    } catch (e) {
        console.error('[BloxCloud DB] Failed to load pg module or create pool:', e);
    }
}

class PersistentDB {
    constructor() {
        this._pgWriteChain = Promise.resolve();
        this.data = this._load();
        this._pruneStaleAndTestRecords();
        if (!fs.existsSync(dbFile)) {
            this.save();
        }
    }

    _currentMonthKey(studioId) {
        const now = new Date();
        const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
        return `${studioId}:${ym}`;
    }

    _pruneStaleAndTestRecords() {
        let changed = false;
        const now = Date.now();

        // 1. Remove automated test accounts (*@test.dev, *@t.dev) older than 5 minutes
        const testUserIds = new Set();
        const beforeUsers = (this.data.users || []).length;
        this.data.users = (this.data.users || []).filter(u => {
            const email = String(u.email || '').toLowerCase();
            const isTest = email.endsWith('@test.dev') || email.endsWith('@t.dev');
            if (isTest && (!u.createdAt || now - u.createdAt > 5 * 60 * 1000)) {
                testUserIds.add(u.id);
                return false;
            }
            return true;
        });
        if (this.data.users.length !== beforeUsers) changed = true;

        // 2. Remove expired sessions (> 30 days) or sessions for deleted test accounts
        const beforeSessions = (this.data.sessions || []).length;
        this.data.sessions = (this.data.sessions || []).filter(s => {
            if (testUserIds.has(s.userId)) return false;
            if (s.createdAt && now - s.createdAt > SESSION_TTL_MS) return false;
            return true;
        });
        if (this.data.sessions.length !== beforeSessions) changed = true;

        // 3. Remove legacy un-scoped flags (no studioId) or flags belonging to deleted test accounts
        const beforeFlags = (this.data.flags || []).length;
        this.data.flags = (this.data.flags || []).filter(f => f.studioId && !testUserIds.has(f.studioId));
        if (this.data.flags.length !== beforeFlags) changed = true;

        // 4. Remove listings/ledger belonging to deleted test accounts
        if (testUserIds.size > 0) {
            this.data.listings = (this.data.listings || []).filter(l => !testUserIds.has(l.studioId));
            this.data.ledger = (this.data.ledger || []).filter(tx => !testUserIds.has(tx.studioId));
        }

        return changed;
    }

    async initCloud() {
        if (!pgPool) return;
        try {
            await pgPool.query(`
                CREATE TABLE IF NOT EXISTS bloxcloud_store (
                    key VARCHAR(64) PRIMARY KEY,
                    value JSONB NOT NULL,
                    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                );
            `);
            const res = await pgPool.query("SELECT value FROM bloxcloud_store WHERE key = 'root'");
            if (res.rows.length > 0 && res.rows[0].value) {
                this.data = { ...defaultSchema, ...res.rows[0].value };
                if (this._pruneStaleAndTestRecords()) {
                    this.save();
                }
                console.log('[BloxCloud DB] Successfully synchronized database state from cloud PostgreSQL!');
            } else {
                await pgPool.query(
                    "INSERT INTO bloxcloud_store (key, value) VALUES ('root', $1) ON CONFLICT (key) DO NOTHING",
                    [JSON.stringify(this.data)]
                );
                console.log('[BloxCloud DB] Seeded initial database state to cloud PostgreSQL.');
            }
        } catch (e) {
            console.error('[BloxCloud DB] Error initializing PostgreSQL storage:', e);
        }
    }

    _load() {
        try {
            if (fs.existsSync(dbFile)) {
                const raw = fs.readFileSync(dbFile, 'utf8');
                return { ...defaultSchema, ...JSON.parse(raw) };
            }
        } catch (e) {
            console.error('[BloxCloud DB] Error loading database file, initializing clean:', e);
        }
        return { ...defaultSchema };
    }

    save() {
        const snapshot = JSON.stringify(this.data, null, 2);
        try {
            const tempFile = `${dbFile}.tmp`;
            fs.writeFileSync(tempFile, snapshot, 'utf8');
            fs.renameSync(tempFile, dbFile);
        } catch (e) {
            console.error('[BloxCloud DB] Failed to save database to disk:', e);
        }

        if (pgPool) {
            // Serialize PostgreSQL writes so concurrent updates never overwrite a newer snapshot
            this._pgWriteChain = this._pgWriteChain
                .then(() => pgPool.query(
                    `INSERT INTO bloxcloud_store (key, value, updated_at) 
                     VALUES ('root', $1, NOW()) 
                     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
                    [snapshot]
                ))
                .catch(err => console.error('[BloxCloud DB] PostgreSQL background save error:', err));
        }
    }

    // USER HELPERS
    findUserByEmail(email) {
        const clean = (email || '').trim().toLowerCase();
        return this.data.users.find(u => u.email === clean) || null;
    }

    findUserById(userId) {
        return this.data.users.find(u => u.id === userId) || null;
    }

    findUserByApiKey(apiKey) {
        return this.data.users.find(u => u.apiKey === apiKey) || null;
    }

    saveUser(user) {
        const idx = this.data.users.findIndex(u => u.id === user.id);
        if (idx !== -1) {
            this.data.users[idx] = user;
        } else {
            this.data.users.push(user);
        }
        this.save();
    }

    // SESSION HELPERS
    createSession(token, userId) {
        this.data.sessions = this.data.sessions.filter(s => s.token !== token);
        this.data.sessions.push({ token, userId, createdAt: Date.now() });
        this.save();
    }

    getUserIdByToken(token) {
        const session = this.data.sessions.find(s => s.token === token);
        if (!session) return null;
        if (session.createdAt && Date.now() - session.createdAt > SESSION_TTL_MS) {
            this.deleteSession(token);
            return null;
        }
        return session.userId;
    }

    // MONTHLY MATCH METERING (Persistent per studio & calendar month)
    incrementMonthlyMatchCount(studioId) {
        if (!studioId) return 0;
        if (!this.data.matchCounts || typeof this.data.matchCounts !== 'object') {
            this.data.matchCounts = {};
        }
        const key = this._currentMonthKey(studioId);
        this.data.matchCounts[key] = (Number(this.data.matchCounts[key]) || 0) + 1;
        this.save();
        return this.data.matchCounts[key];
    }

    getMonthlyMatchCount(studioId) {
        if (!studioId || !this.data.matchCounts) return 0;
        const key = this._currentMonthKey(studioId);
        return Number(this.data.matchCounts[key]) || 0;
    }

    deleteSession(token) {
        this.data.sessions = this.data.sessions.filter(s => s.token !== token);
        this.save();
    }

    // INVOICE HELPERS
    addInvoice(invoice) {
        this.data.invoices.unshift(invoice);
        this.save();
    }

    getUserInvoices(userId) {
        return this.data.invoices.filter(i => i.userId === userId);
    }

    // FLAG HELPERS (Multi-tenant scoped by studioId)
    getFlags(studioId = null) {
        if (!studioId) return this.data.flags;
        return this.data.flags.filter(f => f.studioId === studioId);
    }

    saveFlag(flag, studioId = null) {
        if (studioId) flag.studioId = studioId;
        const idx = this.data.flags.findIndex(f => f.key === flag.key && (!studioId || f.studioId === studioId));
        if (idx !== -1) {
            this.data.flags[idx] = flag;
        } else {
            this.data.flags.push(flag);
        }
        this.save();
    }

    deleteFlag(key, studioId = null) {
        this.data.flags = this.data.flags.filter(f => !(f.key === key && (!studioId || f.studioId === studioId)));
        this.save();
    }

    // MARKETPLACE HELPERS (Multi-tenant scoped by studioId)
    getListings(studioId = null, onlyActive = true) {
        if (!Array.isArray(this.data.listings)) this.data.listings = [];
        return this.data.listings
            .filter(l => (!onlyActive || l.status === 'ACTIVE') && (!studioId || l.studioId === studioId))
            .sort((a, b) => b.createdAt - a.createdAt);
    }

    findListingById(listingId) {
        if (!Array.isArray(this.data.listings)) this.data.listings = [];
        return this.data.listings.find(l => l.listingId === listingId) || null;
    }

    saveListing(listing) {
        if (!Array.isArray(this.data.listings)) this.data.listings = [];
        const idx = this.data.listings.findIndex(l => l.listingId === listing.listingId);
        if (idx !== -1) {
            this.data.listings[idx] = listing;
        } else {
            this.data.listings.push(listing);
        }
        this.save();
    }

    getLedger(studioId = null) {
        if (!Array.isArray(this.data.ledger)) this.data.ledger = [];
        if (!studioId) return this.data.ledger;
        return this.data.ledger.filter(tx => tx.studioId === studioId);
    }

    addTransaction(tx) {
        if (!Array.isArray(this.data.ledger)) this.data.ledger = [];
        this.data.ledger.unshift(tx);
        if (this.data.ledger.length > 500) this.data.ledger.pop();
        this.save();
    }

    // CLEAR / RESET (Scoped by studioId if provided)
    resetLiveOpsAndMarket(studioId = null) {
        if (studioId) {
            this.data.flags = this.data.flags.filter(f => f.studioId !== studioId);
            this.data.listings = this.data.listings.filter(l => l.studioId !== studioId);
            this.data.ledger = this.data.ledger.filter(tx => tx.studioId !== studioId);
        } else {
            this.data.flags = [];
            this.data.listings = [];
            this.data.ledger = [];
        }
        this.save();
    }
}

module.exports = new PersistentDB();
