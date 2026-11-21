/**
 * BloxCloud Real-Time Discord SRE & Security Webhook Dispatcher
 * Sends rate-limited rich embeds to a studio's Discord channel on server degradation,
 * unhandled script crashes, and anti-dupe / exploit alerts.
 */

const cooldowns = new Map();
const DEFAULT_COOLDOWN_MS = 60 * 1000;

function isValidDiscordWebhook(url) {
    if (!url || typeof url !== 'string') return false;
    const trimmed = url.trim();
    return /^https:\/\/(discord\.com|discordapp\.com|canary\.discord\.com|ptb\.discord\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(trimmed);
}

async function sendDiscordEmbed(webhookUrl, embed, cooldownKey = null, cooldownMs = DEFAULT_COOLDOWN_MS) {
    if (!isValidDiscordWebhook(webhookUrl)) return { sent: false, reason: 'INVALID_WEBHOOK' };

    if (cooldownKey) {
        const now = Date.now();
        const last = cooldowns.get(cooldownKey) || 0;
        if (now - last < cooldownMs) {
            return { sent: false, reason: 'COOLDOWN' };
        }
        cooldowns.set(cooldownKey, now);
    }

    try {
        const res = await fetch(webhookUrl.trim(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: 'BloxCloud SRE',
                embeds: [
                    {
                        ...embed,
                        footer: { text: 'BloxCloud LiveOps & Security Engine • bloxcloud.world' },
                        timestamp: new Date().toISOString(),
                    },
                ],
            }),
        });
        return { sent: res.ok, status: res.status };
    } catch (err) {
        console.error('[BloxCloud Discord Alert Error]:', err.message);
        return { sent: false, reason: err.message };
    }
}

function notifyServerDegraded(studioUser, serverInfo) {
    if (!studioUser || !studioUser.discordWebhookUrl) return;
    const metricLabel = serverInfo.engine === 'MINECRAFT' ? 'TPS' : 'FPS';
    const metricVal = serverInfo.engine === 'MINECRAFT' && serverInfo.serverTps != null
        ? serverInfo.serverTps
        : serverInfo.serverFps;

    sendDiscordEmbed(
        studioUser.discordWebhookUrl,
        {
            title: `Server Health Degraded: ${serverInfo.jobId}`,
            color: 0xf59e0b, // Amber
            fields: [
                { name: 'Engine', value: String(serverInfo.engine || 'ROBLOX'), inline: true },
                { name: metricLabel, value: String(metricVal), inline: true },
                { name: 'Memory', value: `${serverInfo.serverMemoryMb} MB`, inline: true },
                { name: 'Players', value: String(serverInfo.playerCount), inline: true },
                { name: 'Region', value: String(serverInfo.region || 'GLOBAL'), inline: true },
            ],
        },
        `degraded:${studioUser.id}:${serverInfo.jobId}`,
        120 * 1000
    );
}

function notifyScriptError(studioUser, errorEntry) {
    if (!studioUser || !studioUser.discordWebhookUrl) return;
    sendDiscordEmbed(
        studioUser.discordWebhookUrl,
        {
            title: `Runtime Error on ${errorEntry.jobId || 'Game Server'}`,
            description: `\`\`\`\n${String(errorEntry.message || 'Unknown error').slice(0, 800)}\n\`\`\``,
            color: 0xef4444, // Red
            fields: [
                { name: 'Script', value: String(errorEntry.scriptName || 'Server'), inline: true },
                { name: 'Severity', value: String(errorEntry.severity || 'ERROR'), inline: true },
            ],
        },
        `error:${studioUser.id}:${String(errorEntry.message || '').slice(0, 60)}`,
        60 * 1000
    );
}

function notifyExploitAlert(studioUser, alertEntry) {
    if (!studioUser || !studioUser.discordWebhookUrl) return;
    sendDiscordEmbed(
        studioUser.discordWebhookUrl,
        {
            title: `Security / Exploit Alert: ${alertEntry.type || alertEntry.reason || 'Suspicious Activity'}`,
            color: 0xdc2626, // Crimson
            fields: [
                { name: 'Player', value: `${alertEntry.username || 'Unknown'} (${alertEntry.userId || 'N/A'})`, inline: true },
                { name: 'Server', value: String(alertEntry.jobId || 'N/A'), inline: true },
            ],
        },
        `exploit:${studioUser.id}:${alertEntry.userId || 'anon'}:${alertEntry.type || 'alert'}`,
        30 * 1000
    );
}

module.exports = {
    isValidDiscordWebhook,
    sendDiscordEmbed,
    notifyServerDegraded,
    notifyScriptError,
    notifyExploitAlert,
};
