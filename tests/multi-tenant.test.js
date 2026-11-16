/**
 * Multi-Tenancy Isolation Verification Test
 * Verifies that Studio A and Studio B are 100% isolated:
 * - Telemetry & Servers
 * - LiveOps Flags & Broadcasts
 * - Marketplace Listings & Trading
 * - Ranked Matchmaking Queues
 */
const API = process.env.API_BASE || 'http://localhost:3066/api/v1';

async function req(url, method = 'GET', body = null, headers = {}) {
    const res = await fetch(API + url, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runMultiTenantTest() {
    console.log('🧪 =========================================================');
    console.log('🧪 RUNNING BLOXCLOUD MULTI-TENANCY ISOLATION TEST SUITE');
    console.log('🧪 =========================================================\n');

    // 1. Create Studio A and Studio B
    const rand = Math.floor(Math.random() * 100000);
    const studioARes = await req('/auth/signup', 'POST', {
        email: `studio_alpha_${rand}@test.dev`,
        password: 'password123',
        username: 'StudioDev_Alpha',
        studioName: 'Alpha Game Studios'
    });
    const studioA = { token: studioARes.data.token, apiKey: studioARes.data.user.apiKey, id: studioARes.data.user.id };

    const studioBRes = await req('/auth/signup', 'POST', {
        email: `studio_bravo_${rand}@test.dev`,
        password: 'password123',
        username: 'StudioDev_Bravo',
        studioName: 'Bravo Interactive'
    });
    const studioB = { token: studioBRes.data.token, apiKey: studioBRes.data.user.apiKey, id: studioBRes.data.user.id };

    console.log(`✔ Created Studio A (ID: ${studioA.id})`);
    console.log(`✔ Created Studio B (ID: ${studioB.id})`);

    // TEST 1: Telemetry Isolation
    console.log('\n--- [TEST 1] TELEMETRY & SERVER ISOLATION ---');
    await req('/telemetry/heartbeat', 'POST', {
        jobId: 'ALPHA_SRV_PROD_1',
        playerCount: 42,
        serverFps: 59.9,
    }, { 'x-api-key': studioA.apiKey });

    const metricsA = await req('/metrics', 'GET', null, { Authorization: `Bearer ${studioA.token}` });
    const metricsB = await req('/metrics', 'GET', null, { Authorization: `Bearer ${studioB.token}` });

    console.log(`Studio A Dashboard Server Count: ${metricsA.data.telemetry.totalServers} (Players: ${metricsA.data.telemetry.totalLivePlayers})`);
    console.log(`Studio B Dashboard Server Count: ${metricsB.data.telemetry.totalServers} (Players: ${metricsB.data.telemetry.totalLivePlayers})`);

    if (metricsA.data.telemetry.totalServers === 1 && metricsB.data.telemetry.totalServers === 0) {
        console.log('✅ TEST 1 PASSED: Studio B sees ZERO servers from Studio A!');
    } else {
        console.error('❌ TEST 1 FAILED: Telemetry leaked across studios!');
        process.exit(1);
    }

    // TEST 2: LiveOps Feature Flags & Broadcast Isolation
    console.log('\n--- [TEST 2] LIVEOPS & FEATURE FLAGS ISOLATION ---');
    await req('/liveops/config', 'POST', {
        key: 'enable_x2_exp_event',
        value: true,
        description: 'Double EXP Weekend'
    }, { Authorization: `Bearer ${studioA.token}` });

    await req('/liveops/broadcast', 'POST', {
        message: 'Alpha Studio Server Maintenance in 10m!',
        durationSeconds: 60,
    }, { Authorization: `Bearer ${studioA.token}` });

    const configA = await req('/liveops/config', 'GET', null, { 'x-api-key': studioA.apiKey });
    const configB = await req('/liveops/config', 'GET', null, { 'x-api-key': studioB.apiKey });

    console.log('Studio A Flags:', Object.keys(configA.data.config));
    console.log('Studio B Flags:', Object.keys(configB.data.config));
    console.log('Studio A Broadcast:', configA.data.activeBroadcast?.message);
    console.log('Studio B Broadcast:', configB.data.activeBroadcast);

    if (configA.data.config.enable_x2_exp_event === true &&
        configB.data.config.enable_x2_exp_event === undefined &&
        configB.data.activeBroadcast === null) {
        console.log('✅ TEST 2 PASSED: Feature flags & broadcasts are 100% isolated!');
    } else {
        console.error('❌ TEST 2 FAILED: LiveOps config leaked across studios!');
        process.exit(1);
    }

    // TEST 3: Marketplace & Economy Isolation
    console.log('\n--- [TEST 3] MARKETPLACE & ECONOMY ISOLATION ---');
    const itemA = await req('/marketplace/list', 'POST', {
        sellerId: '1001',
        sellerName: 'AlphaTrader',
        itemId: 'alpha_celestial_sword',
        price: 9999,
    }, { 'x-api-key': studioA.apiKey });

    const listingsA = await req('/marketplace/listings', 'GET', null, { 'x-api-key': studioA.apiKey });
    const listingsB = await req('/marketplace/listings', 'GET', null, { 'x-api-key': studioB.apiKey });

    console.log(`Studio A active listings: ${listingsA.data.listings.length}`);
    console.log(`Studio B active listings: ${listingsB.data.listings.length}`);

    // Studio B tries to buy Studio A's item -> Must fail
    const illegalBuy = await req('/marketplace/buy', 'POST', {
        buyerId: '2001',
        buyerName: 'BravoBuyer',
        listingId: itemA.data.listingId,
    }, { 'x-api-key': studioB.apiKey });

    console.log(`Studio B buying Studio A item response: ${illegalBuy.data.error}`);

    if (listingsA.data.listings.length === 1 &&
        listingsB.data.listings.length === 0 &&
        illegalBuy.data.error === 'LISTING_NOT_FOUND') {
        console.log('✅ TEST 3 PASSED: Marketplace economies are 100% isolated!');
    } else {
        console.error('❌ TEST 3 FAILED: Marketplace items leaked across studios!');
        process.exit(1);
    }

    // TEST 4: Ranked Matchmaking Queue Partitioning
    console.log('\n--- [TEST 4] RANKED MATCHMAKING QUEUE PARTITIONING ---');
    // Player 1 queues in Studio A (Rating 1500)
    const qA1 = await req('/matchmaking/queue', 'POST', {
        userId: '101',
        username: 'AlphaWarrior',
        queueType: 'Ranked_1v1',
        rating: 1500,
    }, { 'x-api-key': studioA.apiKey });

    // Player 2 queues in Studio B with IDENTICAL rating 1500
    const qB1 = await req('/matchmaking/queue', 'POST', {
        userId: '201',
        username: 'BravoRacer',
        queueType: 'Ranked_1v1',
        rating: 1500,
    }, { 'x-api-key': studioB.apiKey });

    console.log('Queued AlphaWarrior (Studio A) and BravoRacer (Studio B) with identical 1500 ELO.');
    console.log('Waiting 2 seconds to ensure matchmaker DOES NOT pair them together...');
    await sleep(2000);

    const ticketA1 = await req(`/matchmaking/ticket/${qA1.data.ticketId}`, 'GET', null, { 'x-api-key': studioA.apiKey });
    const ticketB1 = await req(`/matchmaking/ticket/${qB1.data.ticketId}`, 'GET', null, { 'x-api-key': studioB.apiKey });

    console.log(`Studio A Player Status: ${ticketA1.data.status}`);
    console.log(`Studio B Player Status: ${ticketB1.data.status}`);

    if (ticketA1.data.status === 'QUEUED' && ticketB1.data.status === 'QUEUED') {
        console.log('✔ Cross-game match prevented! Players from different studios were NOT matched.');
    } else {
        console.error('❌ Matchmaker improperly matched players from different studios!');
        process.exit(1);
    }

    // Now Studio A queues a second player from Studio A (Rating 1520)
    console.log('Studio A queues second player "AlphaKnight" (ELO 1520)...');
    const qA2 = await req('/matchmaking/queue', 'POST', {
        userId: '102',
        username: 'AlphaKnight',
        queueType: 'Ranked_1v1',
        rating: 1520,
    }, { 'x-api-key': studioA.apiKey });

    await sleep(2000);
    const ticketA1_after = await req(`/matchmaking/ticket/${qA1.data.ticketId}`, 'GET', null, { 'x-api-key': studioA.apiKey });
    const ticketB1_after = await req(`/matchmaking/ticket/${qB1.data.ticketId}`, 'GET', null, { 'x-api-key': studioB.apiKey });

    console.log(`Studio A Player 1 Status: ${ticketA1_after.data.status} (Match ID: ${ticketA1_after.data.match?.matchId})`);
    console.log(`Studio B Player 1 Status: ${ticketB1_after.data.status}`);

    if (ticketA1_after.data.status === 'MATCHED' && ticketB1_after.data.status === 'QUEUED') {
        console.log('✅ TEST 4 PASSED: Studio A players matched each other; Studio B player remained safely in Studio B queue!');
    } else {
        console.error('❌ Matchmaking partitioning test failed!');
        process.exit(1);
    }

    console.log('\n=========================================================');
    console.log('🎉 ALL MULTI-TENANCY ISOLATION TESTS PASSED WITH 100% SUCCESS!');
    console.log('=========================================================\n');
}

runMultiTenantTest().catch(e => { console.error(e); process.exit(1); });
