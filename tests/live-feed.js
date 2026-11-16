/**
 * BloxCloud Continuous Live Server Simulator
 * Keeps 3 worldwide game servers actively sending heartbeats, FPS, and player counts every 10 seconds.
 */
const API_BASE = process.env.API_BASE || 'https://bloxcloud.world/api/v1';

async function request(endpoint, method = 'GET', body = null) {
    try {
        const res = await fetch(API_BASE + endpoint, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.BLOXCLOUD_API_KEY || '',
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        return await res.json();
    } catch (e) {
        console.error(`Fetch error [${endpoint}]:`, e.message);
        return null;
    }
}

const servers = [
    { jobId: 'RBX_PROD_EU_48192', region: 'EU-Frankfurt', playerCount: 18, baseFps: 59.5, baseMem: 420 },
    { jobId: 'RBX_PROD_US_10928', region: 'US-Virginia', playerCount: 24, baseFps: 60.0, baseMem: 485 },
    { jobId: 'RBX_PROD_ASIA_77192', region: 'AP-Tokyo', playerCount: 14, baseFps: 58.2, baseMem: 395 },
];

let tick = 0;

async function sendHeartbeats() {
    tick++;
    for (const s of servers) {
        // Minor natural fluctuations
        const fpsJitter = (Math.random() * 1.2 - 0.6);
        const memJitter = Math.floor(Math.random() * 10 - 5);
        const playerDelta = Math.floor(Math.random() * 3 - 1);
        s.playerCount = Math.max(8, Math.min(30, s.playerCount + playerDelta));

        await request('/telemetry/heartbeat', 'POST', {
            jobId: s.jobId,
            region: s.region,
            playerCount: s.playerCount,
            serverFps: Number((s.baseFps + fpsJitter).toFixed(1)),
            serverMemoryMb: s.baseMem + memJitter,
            serverPing: Math.floor(25 + Math.random() * 15),
            uptimeSeconds: tick * 10,
        });
    }
    console.log(`[${new Date().toLocaleTimeString()}] ✔ Streamed heartbeat for 3 live Roblox servers to bloxcloud.world`);
}

// Initial pulse + loop every 10s
sendHeartbeats();
setInterval(sendHeartbeats, 10000);
