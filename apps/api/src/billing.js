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
        billingInterval: 'month',
        limits: {
            maxMatchesPerMonth: 10000,
            queuesAllowed: ['Ranked_1v1'],
            liveOpsFlags: 3,
            auctionHouseEnabled: false,
        },
        features: [
            'Up to 10,000 matches / month',
            'Ranked 1v1 Skill Matchmaking',
            'Basic LiveOps Kill-Switches',
            'Community Discord Support',
        ],
    },
    PRO: {
        id: 'PRO',
        name: 'Studio Pro',
        price: 29,
        billingInterval: 'month',
        limits: {
            maxMatchesPerMonth: 250000,
            queuesAllowed: ['Ranked_1v1', 'Ranked_2v2', 'Ranked_3v3'],
            liveOpsFlags: 25,
            auctionHouseEnabled: true,
        },
        features: [
            'Up to 250,000 matches / month',
            '1v1, 2v2, 3v3 & Party Queues',
            'Unlimited LiveOps & Emergency Broadcasts',
            'Anti-Dupe Global Auction House',
            'Priority ELO Match Speed',
        ],
    },
    STUDIO: {
        id: 'STUDIO',
        name: 'Scale Studio',
        price: 99,
        billingInterval: 'month',
        limits: {
            maxMatchesPerMonth: 1500000,
            queuesAllowed: ['Ranked_1v1', 'Ranked_2v2', 'Ranked_3v3', 'Custom_Queues'],
            liveOpsFlags: 100,
            auctionHouseEnabled: true,
        },
        features: [
            'Up to 1,500,000 matches / month',
            'Custom Team Sizes & Tournament Queues',
            'Full Cross-Server Economy Ledger',
            'Sub-second ELO Search Expansion',
            'Dedicated Studio Priority Routing',
        ],
    },
    ENTERPRISE: {
        id: 'ENTERPRISE',
        name: 'Top Games Enterprise',
        price: 249,
        billingInterval: 'month',
        limits: {
            maxMatchesPerMonth: Infinity,
            queuesAllowed: ['All'],
            liveOpsFlags: Infinity,
            auctionHouseEnabled: true,
        },
        features: [
            'Unlimited Matches & Players',
            'Custom Algorithmic ELO Formulas',
            '99.9% Uptime Financial SLA',
            'Dedicated Private Redis Instances',
            'Direct Slack / Discord Engineer Line',
        ],
    },
};

class BillingManager {
    getPlans() {
        return PLANS;
    }

    getPlan(planId) {
        return PLANS[planId] || PLANS.FREE;
    }

    createSubscription(user, planId, paymentMethod = 'LEMON_SQUEEZY_CARD') {
        const plan = PLANS[planId];
        if (!plan) return { success: false, error: 'Invalid plan selected.' };

        const invoiceId = 'inv_' + crypto.randomUUID().slice(0, 8);
        const invoice = {
            id: invoiceId,
            userId: user.id,
            planId: plan.id,
            planName: plan.name,
            amount: plan.price,
            currency: 'USD',
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

        // Check if direct Lemon Squeezy checkout URL is configured for this plan
        const customUrl = process.env[`LEMONSQUEEZY_${planId}_URL`];
        if (customUrl) {
            const sep = customUrl.includes('?') ? '&' : '?';
            const checkoutUrl = `${customUrl}${sep}checkout[email]=${encodeURIComponent(user.email)}&checkout[custom][user_id]=${encodeURIComponent(user.id)}&checkout[custom][plan_id]=${encodeURIComponent(planId)}`;
            return { success: true, url: checkoutUrl };
        }

        // Check for Lemon Squeezy API configuration
        const apiKey = process.env.LEMONSQUEEZY_API_KEY;
        const storeId = process.env.LEMONSQUEEZY_STORE_ID;
        const variantId = process.env[`LEMONSQUEEZY_VARIANT_${planId}`];

        if (apiKey && storeId && variantId) {
            try {
                const response = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Accept': 'application/vnd.api+json',
                        'Content-Type': 'application/vnd.api+json',
                    },
                    body: JSON.stringify({
                        data: {
                            type: 'checkouts',
                            attributes: {
                                checkout_data: {
                                    email: user.email,
                                    custom: {
                                        user_id: user.id,
                                        plan_id: planId,
                                    },
                                },
                                product_options: {
                                    redirect_url: `${origin}/?status=success&plan=${planId}`,
                                },
                            },
                            relationships: {
                                store: { data: { type: 'stores', id: String(storeId) } },
                                variant: { data: { type: 'variants', id: String(variantId) } },
                            },
                        },
                    }),
                });

                const data = await response.json();
                if (data.data && data.data.attributes && data.data.attributes.url) {
                    return { success: true, url: data.data.attributes.url };
                } else {
                    console.error('[BloxCloud LemonSqueezy] API Error:', data);
                    return { success: false, error: data.errors ? data.errors[0].detail : 'Failed to create checkout' };
                }
            } catch (err) {
                console.error('[BloxCloud LemonSqueezy] Request failed:', err);
                return { success: false, error: err.message };
            }
        }

        // Lemon Squeezy not configured yet in Render Environment
        return {
            success: false,
            requiresConfig: true,
            provider: 'LEMON_SQUEEZY',
            plan,
            error: 'Lemon Squeezy credentials not configured yet in Render Environment Variables.',
        };
    }

    verifyWebhookSignature(rawBody, signature, secret) {
        if (!secret) return true;
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
