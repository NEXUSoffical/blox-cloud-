/**
 * BloxCloud LiveOps & Feature Flags Engine
 * Allows dynamic remote toggles, emergency kill-switches, and live broadcasts without server restarts.
 */

const crypto = require('crypto');
const uuidv4 = () => crypto.randomUUID();

class LiveOps {
    constructor() {
        // Dynamic flags dictionary: key -> { key, value, type, description, updatedAt, changedBy }
        this.flags = new Map();

        // Active emergency broadcasts
        this.activeBroadcast = null;

        // Change audit log
        this.auditLog = [];
    }

    getAllConfig() {
        const configObj = {};
        const flagsList = [];

        for (const [k, v] of this.flags.entries()) {
            configObj[k] = v.value;
            flagsList.push(v);
        }

        return {
            config: configObj,
            flags: flagsList,
            activeBroadcast: this.activeBroadcast,
        };
    }

    getConfigValue(key, fallback = null) {
        const flag = this.flags.get(key);
        return flag ? flag.value : fallback;
    }

    setFlag(key, value, description = '', changedBy = 'Developer') {
        const existing = this.flags.get(key);
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

        this.flags.set(key, flagData);

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
        if (!this.flags.has(key)) return false;
        const existing = this.flags.get(key);
        this.flags.delete(key);

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
            severity, // 'INFO' | 'WARNING' | 'ALERT'
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
