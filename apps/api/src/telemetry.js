/**
 * BloxCloud Live Game Telemetry & Server Diagnostics Engine
 * Tracks live server health (FPS, Memory, Ping), script crash errors, and exploit alerts.
 * Features Roblox does NOT natively provide globally across all servers.
 */

const crypto = require('crypto');

class TelemetryManager {
    constructor() {
        // jobId -> server info
        this.activeServers = new Map();
        // Array of recent unhandled script errors
        this.errorLogs = [];
        // Array of recent security / exploit flags
        this.exploitAlerts = [];

        // Clean up dead servers every 15 seconds (servers that stopped sending heartbeats)
        setInterval(() => this._cleanupStaleServers(), 15000);
    }

    recordHeartbeat(data) {
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

    recordError(data) {
        const { jobId, message, stack, scriptName, errorType = 'RUNTIME_ERROR' } = data;
        const errorEntry = {
            id: 'err_' + crypto.randomUUID().slice(0, 8),
            jobId: jobId || 'Unknown_Server',
            message: message || 'Unknown script error',
            stack: stack || '',
            scriptName: scriptName || 'Script',
            errorType,
            timestamp: Date.now(),
        };

        this.errorLogs.unshift(errorEntry);
        if (this.errorLogs.length > 50) this.errorLogs.pop();
        return errorEntry;
    }

    recordExploitAlert(data) {
        const { jobId, userId, username, anomalyType, details } = data;
        const alertEntry = {
            id: 'sec_' + crypto.randomUUID().slice(0, 8),
            jobId: jobId || 'Unknown_Server',
            userId: String(userId),
            username: username || 'Unknown_User',
            anomalyType: anomalyType || 'PHYSICS_ANOMALY', // 'SPEED_HACK', 'TELEPORT_NOCLIP', 'REMOTE_SPAM'
            details: details || 'Suspicious velocity detected.',
            timestamp: Date.now(),
        };

        this.exploitAlerts.unshift(alertEntry);
        if (this.exploitAlerts.length > 50) this.exploitAlerts.pop();
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

    getOverview() {
        this._cleanupStaleServers();
        const servers = Array.from(this.activeServers.values());

        const totalServers = servers.length;
        const totalLivePlayers = servers.reduce((sum, s) => sum + s.playerCount, 0);
        const avgFps = totalServers > 0
            ? (servers.reduce((sum, s) => sum + s.serverFps, 0) / totalServers).toFixed(1)
            : '60.0';
        const avgMemory = totalServers > 0
            ? Math.round(servers.reduce((sum, s) => sum + s.serverMemoryMb, 0) / totalServers)
            : 0;

        return {
            totalServers,
            totalLivePlayers,
            avgFps: Number(avgFps),
            avgMemoryMb: avgMemory,
            servers,
            recentErrors: this.errorLogs.slice(0, 10),
            recentExploits: this.exploitAlerts.slice(0, 10),
        };
    }
}

module.exports = new TelemetryManager();
