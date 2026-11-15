/**
 * BloxCloud Billing & Subscription Manager (Persistent)
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

    createSubscription(user, planId, paymentMethod = 'CARD_MOCK_SUCCESS') {
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

    getUserInvoices(userId) {
        return db.getUserInvoices(userId);
    }
}

module.exports = new BillingManager();
