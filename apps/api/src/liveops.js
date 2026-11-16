/**
 * BloxCloud LiveOps & Feature Flags Engine (Persistent & Multi-Tenant)
 * Scoped by studioId so each studio manages only their own flags and broadcasts.
 */

const crypto = require('crypto');
const uuidv4 = () => crypto.randomUUID();
const db = require('./db');

class LiveOps {
    constructor() {
        // studioId -> active broadcast object
        this.activeBroadcasts = new Map();
        this.auditLog = [];
    }

    getAllConfig(studioId = null) {
        const configObj = {};
        const flagsList = db.getFlags(studioId);

        for (const flag of flagsList) {
            configObj[flag.key] = flag.value;
        }

        const activeBroadcast = studioId ? (this.activeBroadcasts.get(studioId) || null) : null;

        return {
            config: configObj,
            flags: flagsList,
            activeBroadcast,
        };
    }

    getConfigValue(key, studioId = null, fallback = null) {
        const flags = db.getFlags(studioId);
        const flag = flags.find(f => f.key === key);
        return flag ? flag.value : fallback;
    }

    setFlag(key, value, description = '', changedBy = 'Developer', studioId = null) {
        const flags = db.getFlags(studioId);
        const existing = flags.find(f => f.key === key);
        const oldValue = existing ? existing.value : undefined;
        const type = typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : 'string';

        const flagData = {
            key,
            value,
            type,
            description: description || (existing ? existing.description : ''),
            updatedAt: Date.now(),
            changedBy,
            studioId,
        };

        db.saveFlag(flagData, studioId);

        const logEntry = {
            id: 'log_' + uuidv4().slice(0, 8),
            key,
            oldValue,
            newValue: value,
            changedBy,
            studioId,
            timestamp: Date.now(),
        };

        this.auditLog.unshift(logEntry);
        if (this.auditLog.length > 100) this.auditLog.pop();

        return { flag: flagData, log: logEntry };
    }

    deleteFlag(key, changedBy = 'Developer', studioId = null) {
        const flags = db.getFlags(studioId);
        const existing = flags.find(f => f.key === key);
        if (!existing) return false;

        db.deleteFlag(key, studioId);

        const logEntry = {
            id: 'log_' + uuidv4().slice(0, 8),
            key,
            oldValue: existing.value,
            newValue: null,
            action: 'DELETED',
            changedBy,
            studioId,
            timestamp: Date.now(),
        };

        this.auditLog.unshift(logEntry);
        return true;
    }

    broadcastBanner(message, durationSeconds = 60, severity = 'INFO', studioId = null) {
        const broadcast = {
            id: 'bc_' + uuidv4().slice(0, 8),
            message,
            severity,
            createdAt: Date.now(),
            expiresAt: Date.now() + durationSeconds * 1000,
            studioId,
        };
        if (studioId) {
            this.activeBroadcasts.set(studioId, broadcast);
        }
        return broadcast;
    }

    clearBroadcast(studioId = null) {
        if (studioId) {
            this.activeBroadcasts.delete(studioId);
        } else {
            this.activeBroadcasts.clear();
        }
    }

    getAuditLog(studioId = null) {
        if (!studioId) return this.auditLog;
        return this.auditLog.filter(l => l.studioId === studioId);
    }
}

module.exports = new LiveOps();
