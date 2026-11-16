/**
 * BloxCloud Live Game Telemetry & Server Diagnostics Engine (Multi-Tenant)
 * Tracks live server health (FPS, Memory, Ping), script crash errors, and exploit alerts
 * strictly scoped to each studioId.
 */

const crypto = require('crypto');

class TelemetryManager {
    constructor() {
        // jobId -> server info (with studioId)
        this.activeServers = new Map();
        // Array of recent unhandled script errors
        this.errorLogs = [];
        // Array of recent security / exploit flags
        this.exploitAlerts = [];

        // Clean up dead servers every 15 seconds (servers that stopped sending heartbeats)
        setInterval(() => this._cleanupStaleServers(), 15000);
    }

    recordHeartbeat(data, studioId = null) {
        const {
            jobId,
            placeId = 'Universe_Place',
            playerCount = 0,
            serverFps = 60,
            serverMemoryMb = 450,
            serverPing = 35,
            region = 'US-East',
            uptimeSeconds = 0,
        } = data;

        if (!jobId) return false;

        const serverInfo = {
            jobId,
            placeId,
            studioId,
            playerCount: Number(playerCount) || 0,
            serverFps: Number(serverFps) || 60,
            serverMemoryMb: Math.round(Number(serverMemoryMb) || 450),
            serverPing: Math.round(Number(serverPing) || 35),
            region,
            uptimeSeconds: Math.round(Number(uptimeSeconds) || 0),
            lastHeartbeat: Date.now(),
            // Health assessment
            health: (serverFps < 40 || serverMemoryMb > 1500) ? 'DEGRADED' : 'HEALTHY',
        };

        this.activeServers.set(jobId, serverInfo);
        return serverInfo;
    }

    recordError(data, studioId = null) {
        const { jobId, message, stack, scriptName, errorType = 'RUNTIME_ERROR' } = data;
        const errorEntry = {
            id: 'err_' + crypto.randomUUID().slice(0, 8),
            jobId: jobId || 'Unknown_Server',
            studioId,
            message: message || 'Unknown script error',
            stack: stack || '',
            scriptName: scriptName || 'Script',
            errorType,
            timestamp: Date.now(),
        };

        this.errorLogs.unshift(errorEntry);
        if (this.errorLogs.length > 200) this.errorLogs.pop();
        return errorEntry;
    }

    recordExploitAlert(data, studioId = null) {
        const { jobId, userId, username, anomalyType, details } = data;
        const alertEntry = {
            id: 'sec_' + crypto.randomUUID().slice(0, 8),
            jobId: jobId || 'Unknown_Server',
            studioId,
            userId: String(userId),
            username: username || 'Unknown_User',
            anomalyType: anomalyType || 'PHYSICS_ANOMALY',
            details: details || 'Suspicious velocity detected.',
            timestamp: Date.now(),
        };

        this.exploitAlerts.unshift(alertEntry);
        if (this.exploitAlerts.length > 200) this.exploitAlerts.pop();
        return alertEntry;
    }

    _cleanupStaleServers() {
        const now = Date.now();
        // Remove servers silent for > 45 seconds
        for (const [jobId, server] of this.activeServers.entries()) {
            if (now - server.lastHeartbeat > 45000) {
                this.activeServers.delete(jobId);
            }
        }
    }

    getOverview(studioId = null) {
        this._cleanupStaleServers();
        let servers = Array.from(this.activeServers.values());
        if (studioId) {
            servers = servers.filter(s => s.studioId === studioId);
        }

        const totalServers = servers.length;
        const totalLivePlayers = servers.reduce((sum, s) => sum + s.playerCount, 0);
        const avgFps = totalServers > 0
            ? (servers.reduce((sum, s) => sum + s.serverFps, 0) / totalServers).toFixed(1)
            : '60.0';
        const avgMemory = totalServers > 0
            ? Math.round(servers.reduce((sum, s) => sum + s.serverMemoryMb, 0) / totalServers)
            : 0;

        const errors = studioId
            ? this.errorLogs.filter(e => e.studioId === studioId)
            : this.errorLogs;

        const exploits = studioId
            ? this.exploitAlerts.filter(a => a.studioId === studioId)
            : this.exploitAlerts;

        return {
            totalServers,
            totalLivePlayers,
            avgFps: Number(avgFps),
            avgMemoryMb: avgMemory,
            servers,
            recentErrors: errors.slice(0, 10),
            recentExploits: exploits.slice(0, 10),
        };
    }

    clearStudio(studioId) {
        if (!studioId) return;
        for (const [jobId, s] of this.activeServers.entries()) {
            if (s.studioId === studioId) this.activeServers.delete(jobId);
        }
        this.errorLogs = this.errorLogs.filter(e => e.studioId !== studioId);
        this.exploitAlerts = this.exploitAlerts.filter(a => a.studioId !== studioId);
    }
}

module.exports = new TelemetryManager();
