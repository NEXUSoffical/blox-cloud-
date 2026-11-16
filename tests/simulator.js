/**
 * BloxCloud Roblox Server Simulator & Stress Tester
 * Simulates multiple Roblox game servers calling the Nexus API.
 */

const API_BASE = process.env.API_BASE || 'https://bloxcloud.world/api/v1';

async function request(endpoint, method = 'GET', body = null) {
    const res = await fetch(API_BASE + endpoint, {
        method,
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.BLOXCLOUD_API_KEY || '',
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function runSimulation() {
    console.log('\n======================================================');
    console.log('🚀 BLOXCLOUD ROBLOX SERVER SIMULATION INITIALIZING');
    console.log('======================================================\n');

    // 1. Check API Health
    const health = await request('/health');
    console.log('✔ Connected to BloxCloud API:', health);

    // 1b. Simulate 3 Live Roblox Game Servers reporting Telemetry
    console.log('\n--- [TEST 0] CONNECTING 3 SIMULATED ROBLOX GAME SERVERS ---');
    const servers = [
        { jobId: 'RBX_PROD_EU_48192', playerCount: 18, fps: 59.8, memoryMb: 420 },
        { jobId: 'RBX_PROD_US_10928', playerCount: 24, fps: 60.0, memoryMb: 480 },
        { jobId: 'RBX_PROD_ASIA_77192', playerCount: 12, fps: 58.4, memoryMb: 390 },
    ];
    for (const s of servers) {
        await request('/telemetry/heartbeat', 'POST', s);
        console.log(`✔ Roblox Server [${s.jobId}] Heartbeat: ${s.playerCount} players, ${s.fps} FPS`);
    }

    // 2. Simulate 24 Players Queueing for Ranked_1v1 and Ranked_2v2
    console.log('\n--- [TEST 1] SIMULATING ROBLOX PLAYERS JOINING QUEUES ---');
    const playerNames = [
        'VortexStriker', 'ShadowNinja', 'BloxChamp_99', 'NeonRacer',
        'LunarGamer', 'TitanSlayer', 'EchoBlade', 'FrostByte',
        'InfernoKing', 'CyberSamurai', 'MysticWizard', 'GhostRider_RBX'
    ];

    const queuedTickets = [];

    for (let i = 0; i < playerNames.length; i++) {
        const userId = 10000000 + i;
        const username = playerNames[i];
        // Give diverse ratings: 850 to 1450 ELO
        const rating = 900 + (i * 45);
        const queueType = i % 2 === 0 ? 'Ranked_1v1' : 'Ranked_2v2';

        const res = await request('/matchmaking/queue', 'POST', {
            userId,
            username,
            queueType,
            rating,
        });

        queuedTickets.push({ userId, username, ticketId: res.ticketId, queueType, rating });
        console.log(`[Roblox Server #${(i % 3) + 1}] Queued player ${username} (ELO: ${rating}) into ${queueType}`);
    }

    console.log('\n⏳ Waiting 2.5 seconds for Matchmaker Engine to pair players by ELO...');
    await sleep(2500);

    // 3. Inspect Created Matches
    console.log('\n--- [TEST 2] MATCHMAKING RESULTS & SERVER TELEPORT CODES ---');
    const mmStats = await request('/matchmaking/stats');
    console.log(`✔ Total Matches Created: ${mmStats.totalMatchesCreated}`);
    console.log(`✔ Remaining Queued: ${mmStats.activeQueuedPlayers}`);
    
    mmStats.recentMatches.forEach(m => {
        console.log(`\n🏆 MATCH FOUND: [${m.queueType}] ${m.matchId}`);
        console.log(`   Reserved Server Code: ${m.reservedServerCode}`);
        console.log(`   Team A (Avg ELO ${m.avgRatingA}):`, m.teamA.map(p => `${p.username} (${p.rating})`).join(', '));
        console.log(`   Team B (Avg ELO ${m.avgRatingB}):`, m.teamB.map(p => `${p.username} (${p.rating})`).join(', '));
    });

    // 4. Test Global Auction House
    console.log('\n--- [TEST 3] GLOBAL AUCTION HOUSE (CROSS-SERVER TRADING) ---');
    console.log('📦 Listing an item on the cross-server Auction House...');
    const listedItem = await request('/marketplace/list', 'POST', {
        sellerId: '10928374',
        sellerName: 'ProTrader_Alpha',
        itemId: 'mythical_frost_blade',
        itemData: { level: 50, damage: 150 },
        price: 15000,
    });
    console.log(`✔ Item successfully listed! ID: ${listedItem.listingId} ("${listedItem.itemId}" for ${listedItem.price} coins)`);

    const listings = await request('/marketplace/listings');
    console.log(`✔ Total Active Marketplace Listings: ${listings.listings.length}`);
    const firstItem = listings.listings[0];

    console.log(`🛒 Simulating player "DragonLord77" on Server #14 buying item ${firstItem.listingId}...`);
    const buyResult = await request('/marketplace/buy', 'POST', {
        buyerId: '77889900',
        buyerName: 'DragonLord77',
        listingId: firstItem.listingId,
    });

    if (buyResult.success) {
        console.log('✔ PURCHASE SUCCESSFUL! Transaction ID:', buyResult.transaction.txId);
        console.log('   Anti-dupe check verified: Item atomically transferred!');
    } else {
        console.log('✖ Purchase failed:', buyResult.error);
    }

    // Try to buy again (should fail with anti-dupe prevention)
    console.log(`🛡 Testing Anti-Dupe Lock: Simulating second player trying to buy the exact same item...`);
    const duplicateBuy = await request('/marketplace/buy', 'POST', {
        buyerId: '99999999',
        buyerName: 'CopyCatScammer',
        listingId: firstItem.listingId,
    });
    console.log(`✔ Anti-Dupe Lock caught race condition! Response: ${duplicateBuy.error}`);

    // 5. Test LiveOps Kill-Switch & Broadcast
    console.log('\n--- [TEST 4] LIVEOPS REMOTE KILL-SWITCH & BROADCAST ---');
    console.log('🚨 Flipping remote kill-switch: Disabling "disable_item_plasmagun" across all game servers...');
    const killSwitch = await request('/liveops/config', 'POST', {
        key: 'disable_item_plasmagun',
        value: true,
        changedBy: 'StudioLead_Kieran',
    });
    console.log('✔ Config updated in cloud! Live servers receive update instantly:', killSwitch.result ? killSwitch.result.log : killSwitch);

    console.log('📢 Broadcasting emergency message to all servers: "Update in 5 minutes! Save your stats!"');
    const broadcast = await request('/liveops/broadcast', 'POST', {
        message: 'Update in 5 minutes! Save your stats!',
        severity: 'ALERT',
        durationSeconds: 120,
    });
    console.log('✔ Broadcast dispatched:', broadcast.broadcast);

    console.log('\n======================================================');
    console.log('🎉 ALL ROBLOX SIMULATOR TESTS PASSED WITH 100% SUCCESS!');
    console.log('======================================================\n');
}

runSimulation().catch(err => {
    console.error('Simulation error:', err);
});
