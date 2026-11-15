/**
 * BloxCloud Billing & Subscription Manager with Stripe Payments
 */

const crypto = require('crypto');
const db = require('./db');
const Stripe = require('stripe');

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
    getStripe() {
        const key = process.env.STRIPE_SECRET_KEY;
        if (!key) return null;
        try {
            return new Stripe(key);
        } catch (e) {
            console.error('[BloxCloud Stripe] Init error:', e);
            return null;
        }
    }

    getPlans() {
        return PLANS;
    }

    getPlan(planId) {
        return PLANS[planId] || PLANS.FREE;
    }

    createSubscription(user, planId, paymentMethod = 'CARD_SUCCESS') {
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

        // Free tier does not require Stripe checkout
        if (plan.price === 0) {
            const sub = this.createSubscription(user, 'FREE', 'FREE_TIER');
            return { success: true, free: true, subscription: sub };
        }

        const stripe = this.getStripe();
        if (!stripe) {
            return {
                success: false,
                requiresConfig: true,
                error: 'STRIPE_SECRET_KEY is not configured in environment variables.',
                plan,
            };
        }

        try {
            const session = await stripe.checkout.sessions.create({
                payment_method_types: ['card'],
                line_items: [{
                    price_data: {
                        currency: 'usd',
                        product_data: {
                            name: `BloxCloud ${plan.name} Tier`,
                            description: plan.features.slice(0, 3).join(' • '),
                        },
                        unit_amount: plan.price * 100, // Cents
                        recurring: { interval: 'month' },
                    },
                    quantity: 1,
                }],
                mode: 'subscription',
                customer_email: user.email,
                client_reference_id: user.id,
                metadata: {
                    userId: user.id,
                    planId: planId,
                },
                success_url: `${origin}/?session_id={CHECKOUT_SESSION_ID}&plan=${planId}&status=success`,
                cancel_url: `${origin}/?status=cancelled`,
            });

            return {
                success: true,
                url: session.url,
                sessionId: session.id,
            };
        } catch (err) {
            console.error('[BloxCloud Stripe] Checkout creation error:', err);
            return { success: false, error: err.message };
        }
    }

    async verifyAndActivateSession(sessionId) {
        const stripe = this.getStripe();
        if (!stripe) return { success: false, error: 'Stripe not configured' };

        try {
            const session = await stripe.checkout.sessions.retrieve(sessionId);
            if (!session) return { success: false, error: 'Checkout session not found' };

            const userId = session.client_reference_id || (session.metadata && session.metadata.userId);
            const planId = session.metadata && session.metadata.planId;

            if (!userId || !planId) {
                return { success: false, error: 'Session metadata missing userId or planId' };
            }

            const user = db.findUserById(userId);
            if (!user) return { success: false, error: 'User not found' };

            // Record invoice
            const invoice = {
                id: 'inv_' + (session.payment_intent || session.subscription || crypto.randomUUID().slice(0, 8)),
                userId: user.id,
                planId: planId,
                planName: PLANS[planId] ? PLANS[planId].name : planId,
                amount: (session.amount_total || (PLANS[planId] ? PLANS[planId].price * 100 : 0)) / 100,
                currency: 'USD',
                status: 'PAID',
                paymentMethod: 'STRIPE_CARD',
                timestamp: Date.now(),
                nextBillingDate: Date.now() + 30 * 24 * 60 * 60 * 1000,
            };

            db.addInvoice(invoice);

            return {
                success: true,
                userId: user.id,
                planId,
                invoice,
            };
        } catch (err) {
            console.error('[BloxCloud Stripe] Verification error:', err);
            return { success: false, error: err.message };
        }
    }

    getUserInvoices(userId) {
        return db.getUserInvoices(userId);
    }
}

module.exports = new BillingManager();
