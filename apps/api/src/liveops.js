/**
 * BloxCloud LiveOps & Feature Flags Engine (Persistent)
 */

const crypto = require('crypto');
const uuidv4 = () => crypto.randomUUID();
const db = require('./db');

class LiveOps {
    constructor() {
        this.activeBroadcast = null;
        this.auditLog = [];
    }

    getAllConfig() {
        const configObj = {};
        const flagsList = db.getFlags();

        for (const flag of flagsList) {
            configObj[flag.key] = flag.value;
        }

        return {
            config: configObj,
            flags: flagsList,
            activeBroadcast: this.activeBroadcast,
        };
    }

    getConfigValue(key, fallback = null) {
        const flags = db.getFlags();
        const flag = flags.find(f => f.key === key);
        return flag ? flag.value : fallback;
    }

    setFlag(key, value, description = '', changedBy = 'Developer') {
        const flags = db.getFlags();
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
        };

        db.saveFlag(flagData);

        const logEntry = {
            id: 'log_' + uuidv4().slice(0, 8),
            key,
            oldValue,
            newValue: value,
            changedBy,
            timestamp: Date.now(),
        };

        this.auditLog.unshift(logEntry);
        if (this.auditLog.length > 100) this.auditLog.pop();

        return { flag: flagData, log: logEntry };
    }

    deleteFlag(key, changedBy = 'Developer') {
        const flags = db.getFlags();
        const existing = flags.find(f => f.key === key);
        if (!existing) return false;

        db.deleteFlag(key);

        const logEntry = {
            id: 'log_' + uuidv4().slice(0, 8),
            key,
            oldValue: existing.value,
            newValue: null,
            action: 'DELETED',
            changedBy,
            timestamp: Date.now(),
        };

        this.auditLog.unshift(logEntry);
        return true;
    }

    broadcastBanner(message, durationSeconds = 60, severity = 'INFO') {
        this.activeBroadcast = {
            id: 'bc_' + uuidv4().slice(0, 8),
            message,
            severity,
            createdAt: Date.now(),
            expiresAt: Date.now() + durationSeconds * 1000,
        };
        return this.activeBroadcast;
    }

    clearBroadcast() {
        this.activeBroadcast = null;
    }

    getAuditLog() {
        return this.auditLog;
    }
}

module.exports = new LiveOps();
