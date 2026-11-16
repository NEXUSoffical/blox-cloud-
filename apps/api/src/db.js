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
};

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
        this.data = this._load();
        if (!fs.existsSync(dbFile)) {
            this.save();
        }
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
        try {
            const tempFile = `${dbFile}.tmp`;
            fs.writeFileSync(tempFile, JSON.stringify(this.data, null, 2), 'utf8');
            fs.renameSync(tempFile, dbFile);
        } catch (e) {
            console.error('[BloxCloud DB] Failed to save database to disk:', e);
        }

        if (pgPool) {
            pgPool.query(
                `INSERT INTO bloxcloud_store (key, value, updated_at) 
                 VALUES ('root', $1, NOW()) 
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
                [JSON.stringify(this.data)]
            ).catch(err => console.error('[BloxCloud DB] PostgreSQL background save error:', err));
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
        return session ? session.userId : null;
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
