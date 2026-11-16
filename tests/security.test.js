/**
 * Security regression test: verifies auth on game/dashboard endpoints and billing lockdown.
 * Usage: API_BASE=http://localhost:3055/api/v1 node tests/security.test.js
 */
const crypto = require('crypto');
const API = process.env.API_BASE || 'http://localhost:3055/api/v1';
const SECRET = process.env.LEMONSQUEEZY_WEBHOOK_SECRET || '';
let failures = 0;

async function call(path, { method = 'GET', body, headers = {}, raw } = {}) {
    const res = await fetch(API + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: raw !== undefined ? raw : (body ? JSON.stringify(body) : undefined),
    });
    let data = null;
    try { data = await res.json(); } catch (e) {}
    return { status: res.status, data };
}
function check(name, cond, extra = '') {
    console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
    if (!cond) failures++;
}

(async () => {
    const email = `sec_${Date.now()}@test.dev`;
    const signup = await call('/auth/signup', { method: 'POST', body: { email, password: 'secret123', username: 'SecTester', studioName: 'Sec Studio' } });
    const token = signup.data.token, apiKey = signup.data.user.apiKey, userId = signup.data.user.id;
    const session = { Authorization: `Bearer ${token}` };

    console.log('\n--- Unauthenticated access must be rejected ---');
    for (const [m, p, b] of [
        ['POST', '/liveops/config', { key: 'x', value: true }],
        ['DELETE', '/liveops/config/x'],
        ['POST', '/liveops/broadcast', { message: 'hacked' }],
        ['POST', '/reset'],
        ['GET', '/metrics'],
        ['POST', '/telemetry/heartbeat', { jobId: 'fake' }],
        ['POST', '/matchmaking/queue', { userId: '1', username: 'x' }],
        ['POST', '/marketplace/buy', { buyerId: '1', listingId: 'x' }],
    ]) {
        const r = await call(p, { method: m, body: b });
        check(`${m} ${p} without credentials`, r.status === 401 || r.status === 403, `got ${r.status}`);
    }
    const bad = await call('/telemetry/heartbeat', { method: 'POST', body: { jobId: 'x' }, headers: { 'x-api-key': 'bc_live_wrong' } });
    check('Invalid API key rejected', bad.status === 401, `got ${bad.status}`);

    console.log('\n--- Valid credentials must work ---');
    const hb = await call('/telemetry/heartbeat', { method: 'POST', body: { jobId: 'SEC_TEST_JOB' }, headers: { 'x-api-key': apiKey } });
    check('Heartbeat with valid API key', hb.status === 200, `got ${hb.status}`);
    const cfg = await call('/liveops/config', { headers: { 'x-api-key': apiKey } });
    check('SDK can read live config with API key', cfg.status === 200, `got ${cfg.status}`);
    const flag = await call('/liveops/config', { method: 'POST', body: { key: 'sec_test_flag', value: true }, headers: session });
    check('Dashboard session can set flag', flag.status === 200, `got ${flag.status}`);
    const flagViaKey = await call('/liveops/config', { method: 'POST', body: { key: 'sec_test_flag', value: false }, headers: { 'x-api-key': apiKey } });
    check('Game API key cannot change flags (dashboard only)', flagViaKey.status === 401, `got ${flagViaKey.status}`);
    await call('/liveops/config/sec_test_flag', { method: 'DELETE', headers: session });
    const reset = await call('/reset', { method: 'POST', headers: session });
    check('Normal user cannot reset platform data', reset.status === 403, `got ${reset.status}`);

    console.log('\n--- Billing lockdown ---');
    const sub = await call('/billing/subscribe', { method: 'POST', body: { planId: 'ENTERPRISE' }, headers: session });
    check('Cannot self-activate ENTERPRISE via /billing/subscribe', sub.status === 403, `got ${sub.status}`);
    const me1 = await call('/auth/me', { headers: session });
    check('Plan still FREE after attempt', me1.data.user.plan === 'FREE', me1.data.user.plan);

    const fakeEvent = JSON.stringify({ meta: { event_name: 'subscription_created', custom_data: { user_id: userId, plan_id: 'ENTERPRISE' } }, data: { attributes: { product_name: 'Top Games Enterprise', status: 'active' } } });
    const unsigned = await call('/billing/lemonsqueezy/webhook', { method: 'POST', raw: fakeEvent, headers: { 'X-Signature': 'deadbeef' } });
    check('Forged/unsigned webhook rejected', unsigned.status === 401 || unsigned.status === 503, `got ${unsigned.status}`);
    const me2 = await call('/auth/me', { headers: session });
    check('Plan still FREE after forged webhook', me2.data.user.plan === 'FREE', me2.data.user.plan);

    if (SECRET) {
        // Customer pays for Studio Pro but tampers plan_id=ENTERPRISE in the checkout URL
        const tampered = JSON.stringify({ meta: { event_name: 'subscription_created', custom_data: { user_id: userId, plan_id: 'ENTERPRISE' } }, data: { attributes: { product_name: 'Studio Pro', status: 'active' } } });
        const sig = crypto.createHmac('sha256', SECRET).update(tampered).digest('hex');
        const signed = await call('/billing/lemonsqueezy/webhook', { method: 'POST', raw: tampered, headers: { 'X-Signature': sig } });
        check('Correctly signed webhook accepted (raw body HMAC)', signed.status === 200, `got ${signed.status}`);
        const me3 = await call('/auth/me', { headers: session });
        check('Plan comes from purchased product, not tampered plan_id', me3.data.user.plan === 'PRO', me3.data.user.plan);

        const cancelled = JSON.stringify({ meta: { event_name: 'subscription_cancelled', custom_data: { user_id: userId } }, data: { attributes: { product_name: 'Studio Pro', status: 'cancelled' } } });
        await call('/billing/lemonsqueezy/webhook', { method: 'POST', raw: cancelled, headers: { 'X-Signature': crypto.createHmac('sha256', SECRET).update(cancelled).digest('hex') } });
        const me4 = await call('/auth/me', { headers: session });
        check('Cancelled sub keeps access until period end', me4.data.user.plan === 'PRO', me4.data.user.plan);

        const expired = JSON.stringify({ meta: { event_name: 'subscription_expired', custom_data: { user_id: userId } }, data: { attributes: { product_name: 'Studio Pro', status: 'expired' } } });
        await call('/billing/lemonsqueezy/webhook', { method: 'POST', raw: expired, headers: { 'X-Signature': crypto.createHmac('sha256', SECRET).update(expired).digest('hex') } });
        const me5 = await call('/auth/me', { headers: session });
        check('Expired sub downgrades to FREE', me5.data.user.plan === 'FREE', me5.data.user.plan);
    }

    console.log(`\n${failures === 0 ? '🎉 ALL SECURITY CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}`);
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
