/**
 * BloxCloud Billing & Subscription Manager with Lemon Squeezy Payments (Merchant of Record)
 */

const crypto = require('crypto');
const db = require('./db');

const PLANS = {
    FREE: {
        id: 'FREE',
        name: 'Indie / Free',
        price: 0,
        currency: 'GBP',
        billingInterval: 'month',
        limits: {
            maxServers: 5,
            maxMatchesPerMonth: 10000,
            liveOpsFlags: 5,
            maxActiveListings: 10,
        },
        features: [
            'Up to 5 live servers & 10,000 matches/mo',
            'Ranked ELO Skill Matchmaking',
            'Up to 5 LiveOps Feature Flags',
            'Up to 10 Active Auction Listings',
        ],
    },
    PRO: {
        id: 'PRO',
        name: 'Studio Pro',
        price: 24,
        currency: 'GBP',
        billingInterval: 'month',
        limits: {
            maxServers: 25,
            maxMatchesPerMonth: 250000,
            liveOpsFlags: 50,
            maxActiveListings: 250,
        },
        features: [
            'Up to 25 live servers & 250,000 matches/mo',
            '1v1, 2v2, 3v3 & Party Queues',
            'Up to 50 LiveOps Flags & Broadcasts',
            'Up to 250 Active Auction Listings',
            'Priority ELO Match Speed',
        ],
    },
    STUDIO: {
        id: 'STUDIO',
        name: 'Scale Studio',
        price: 79,
        currency: 'GBP',
        billingInterval: 'month',
        limits: {
            maxServers: 100,
            maxMatchesPerMonth: 1500000,
            liveOpsFlags: 250,
            maxActiveListings: 2500,
        },
        features: [
            'Up to 100 live servers & 1.5M matches/mo',
            'Custom Team Sizes & Tournament Queues',
            'Up to 2,500 Active Auction Listings',
            'Sub-second ELO Search Expansion',
            'Dedicated Studio Priority Routing',
        ],
    },
    ENTERPRISE: {
        id: 'ENTERPRISE',
        name: 'Top Games Enterprise',
        price: 199,
        currency: 'GBP',
        billingInterval: 'month',
        limits: {
            maxServers: Infinity,
            maxMatchesPerMonth: Infinity,
            liveOpsFlags: Infinity,
            maxActiveListings: Infinity,
        },
        features: [
            'Unlimited Servers, Matches & Listings',
            'Custom Algorithmic ELO Formulas',
            '99.9% Uptime Financial SLA',
            'Dedicated Private Cloud Capacity',
            'Direct Discord Engineer Support',
        ],
    },
};

const DEFAULT_CHECKOUT_URLS = {
    PRO: process.env.POLAR_PRO_URL || '',
    STUDIO: process.env.POLAR_STUDIO_URL || '',
    ENTERPRISE: process.env.POLAR_ENTERPRISE_URL || '',
};

class BillingManager {
    getPlans() {
        return PLANS;
    }

    getPlan(planId) {
        return PLANS[planId] || PLANS.FREE;
    }

    createSubscription(user, planId, paymentMethod = 'POLAR_CHECKOUT') {
        const plan = PLANS[planId];
        if (!plan) return { success: false, error: 'Invalid plan selected.' };

        const invoiceId = 'inv_' + crypto.randomUUID().slice(0, 8);
        const invoice = {
            id: invoiceId,
            userId: user.id,
            planId: plan.id,
            planName: plan.name,
            amount: plan.price,
            currency: plan.currency || 'GBP',
            status: 'PAID',
            paymentMethod: plan.price === 0 ? 'FREE_TIER' : paymentMethod,
            timestamp: Date.now(),
            nextBillingDate: Date.now() + 30 * 24 * 60 * 60 * 1000,
        };

        db.addInvoice(invoice);

        return {
            success: true,
            invoice,
            plan,
        };
    }

    async createCheckoutSession(user, planId, origin) {
        const plan = PLANS[planId];
        if (!plan) return { success: false, error: 'Invalid plan selected.' };

        // Free tier requires no checkout
        if (plan.price === 0) {
            const sub = this.createSubscription(user, 'FREE', 'FREE_TIER');
            return { success: true, free: true, subscription: sub };
        }

        // 1. Direct Polar.sh Checkout Link (e.g. https://buy.polar.sh/polar_cl_xxx)
        const customUrl = process.env[`POLAR_${planId}_URL`] || DEFAULT_CHECKOUT_URLS[planId];
        if (customUrl) {
            const sep = customUrl.includes('?') ? '&' : '?';
            const metadata = JSON.stringify({ user_id: user.id, plan_id: planId });
            const checkoutUrl = `${customUrl}${sep}customer_email=${encodeURIComponent(user.email)}&customer_name=${encodeURIComponent(user.username || '')}&reference_id=${encodeURIComponent(user.id)}&metadata=${encodeURIComponent(metadata)}`;
            return { success: true, url: checkoutUrl };
        }

        // 2. Polar.sh REST API Checkout Session (if POLAR_ACCESS_TOKEN + POLAR_PRODUCT_<PLAN> are set)
        const accessToken = process.env.POLAR_ACCESS_TOKEN;
        const productId = process.env[`POLAR_PRODUCT_${planId}`];
        if (accessToken && productId) {
            try {
                const response = await fetch('https://api.polar.sh/v1/checkouts/', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        products: [productId],
                        customer_email: user.email,
                        customer_name: user.username || undefined,
                        external_customer_id: user.id,
                        metadata: {
                            user_id: user.id,
                            plan_id: planId,
                        },
                        success_url: `${origin}/?status=success&plan=${planId}`,
                    }),
                });
                const data = await response.json();
                if (data && data.url) {
                    return { success: true, url: data.url };
                }
                console.error('[BloxCloud Polar] API Error:', data);
                return { success: false, error: data.detail || 'Failed to create Polar checkout session' };
            } catch (err) {
                console.error('[BloxCloud Polar] Request failed:', err);
                return { success: false, error: err.message };
            }
        }

        // Polar checkout links not configured yet
        return {
            success: false,
            requiresConfig: true,
            provider: 'POLAR',
            plan,
            error: 'Polar.sh checkout link not configured for this plan yet.',
        };
    }

    planIdFromProductName(productName) {
        const name = String(productName || '').trim().toLowerCase();
        if (!name) return null;
        for (const plan of Object.values(PLANS)) {
            if (plan.price > 0 && plan.name.toLowerCase() === name) return plan.id;
        }
        if (name.includes('enterprise')) return 'ENTERPRISE';
        if (name.includes('scale') || name === 'studio') return 'STUDIO';
        if (name.includes('pro')) return 'PRO';
        return null;
    }

    /**
     * Verifies Standard Webhooks (used by Polar.sh: webhook-id, webhook-timestamp, webhook-signature)
     */
    verifyPolarWebhookSignature(rawBody, headers, secret) {
        if (!secret || !rawBody) return false;
        const msgId = headers['webhook-id'];
        const msgTimestamp = headers['webhook-timestamp'];
        const msgSignature = headers['webhook-signature'];
        if (!msgId || !msgTimestamp || !msgSignature) return false;

        // Reject replays older than 5 minutes
        const tsNum = Number(msgTimestamp);
        if (Number.isFinite(tsNum)) {
            const ageSec = Math.abs(Math.floor(Date.now() / 1000) - tsNum);
            if (ageSec > 300) return false;
        }

        const rawStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
        const signedContent = `${msgId}.${msgTimestamp}.${rawStr}`;

        const candidateSecrets = [Buffer.from(secret, 'utf8')];
        if (secret.startsWith('whsec_')) {
            const stripped = secret.slice(6);
            candidateSecrets.unshift(Buffer.from(stripped, 'base64'));
            candidateSecrets.push(Buffer.from(stripped, 'utf8'));
        } else {
            candidateSecrets.push(Buffer.from(secret, 'base64'));
        }

        const sigParts = String(msgSignature).split(' ');
        for (const part of sigParts) {
            const [ver, b64Sig] = part.split(',');
            if (ver !== 'v1' || !b64Sig) continue;
            const sigBuf = Buffer.from(b64Sig, 'base64');
            for (const keyBuf of candidateSecrets) {
                if (!keyBuf || keyBuf.length === 0) continue;
                const digest = crypto.createHmac('sha256', keyBuf).update(signedContent).digest();
                if (digest.length === sigBuf.length && crypto.timingSafeEqual(digest, sigBuf)) {
                    return true;
                }
            }
        }
        return false;
    }

    verifyWebhookSignature(rawBody, signature, secret) {
        if (!secret || !signature) return false;
        const hmac = crypto.createHmac('sha256', secret);
        const digest = Buffer.from(hmac.update(rawBody).digest('hex'), 'utf8');
        const sig = Buffer.from(signature || '', 'utf8');
        return digest.length === sig.length && crypto.timingSafeEqual(digest, sig);
    }

    getUserInvoices(userId) {
        return db.getUserInvoices(userId);
    }
}

module.exports = new BillingManager();
