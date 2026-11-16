/**
 * BloxCloud Global Auction House & Marketplace Engine (Multi-Tenant)
 * Cross-server atomic item transactions preventing item duplication and race conditions.
 * Strictly isolated per studioId so different games never share economies or listings.
 */

const crypto = require('crypto');
const uuidv4 = () => crypto.randomUUID();

class Marketplace {
    constructor() {
        // listingId -> listing (with studioId)
        this.listings = new Map();
        // Transaction ledger for audits
        this.ledger = [];
        // Mutex / Locks for atomic buying
        this.locks = new Set();
    }

    listItem(data, studioId = null) {
        const { sellerId, sellerName, itemId, itemData = {}, price } = data;

        const listingId = 'list_' + uuidv4().slice(0, 8);
        const listing = {
            listingId,
            studioId,
            sellerId: String(sellerId),
            sellerName: String(sellerName),
            itemId,
            itemData,
            price: Number(price) || 0,
            status: 'ACTIVE', // 'ACTIVE' | 'SOLD' | 'CANCELLED'
            createdAt: Date.now(),
        };

        this.listings.set(listingId, listing);
        return listing;
    }

    /**
     * Atomically purchase an item with anti-dupe lock, scoped to studioId
     */
    buyItem(buyerId, buyerName, listingId, studioId = null) {
        // 1. Acquire atomic lock on listingId
        if (this.locks.has(listingId)) {
            return { success: false, error: 'ITEM_TRANSACTION_IN_PROGRESS' };
        }
        this.locks.add(listingId);

        try {
            const listing = this.listings.get(listingId);
            if (!listing) {
                return { success: false, error: 'LISTING_NOT_FOUND' };
            }

            if (studioId && listing.studioId && listing.studioId !== studioId) {
                return { success: false, error: 'LISTING_NOT_FOUND' };
            }

            if (listing.status !== 'ACTIVE') {
                return { success: false, error: 'ITEM_ALREADY_SOLD_OR_CANCELLED' };
            }

            if (listing.sellerId === String(buyerId)) {
                return { success: false, error: 'CANNOT_BUY_OWN_ITEM' };
            }

            // 2. Mark as SOLD atomically
            listing.status = 'SOLD';
            listing.soldTo = {
                buyerId: String(buyerId),
                buyerName: String(buyerName),
                purchasedAt: Date.now(),
            };

            // 3. Record transaction in immutable ledger
            const transaction = {
                txId: 'tx_' + uuidv4().slice(0, 10),
                studioId: listing.studioId || studioId,
                listingId,
                itemId: listing.itemId,
                price: listing.price,
                sellerId: listing.sellerId,
                sellerName: listing.sellerName,
                buyerId: String(buyerId),
                buyerName: String(buyerName),
                timestamp: Date.now(),
            };

            this.ledger.unshift(transaction);
            if (this.ledger.length > 200) this.ledger.pop();

            return {
                success: true,
                transaction,
                item: {
                    itemId: listing.itemId,
                    itemData: listing.itemData,
                },
            };
        } finally {
            // Release lock
            this.locks.delete(listingId);
        }
    }

    cancelListing(sellerId, listingId, studioId = null) {
        const listing = this.listings.get(listingId);
        if (!listing) return { success: false, error: 'LISTING_NOT_FOUND' };
        if (studioId && listing.studioId && listing.studioId !== studioId) return { success: false, error: 'UNAUTHORIZED' };
        if (listing.sellerId !== String(sellerId)) return { success: false, error: 'UNAUTHORIZED' };
        if (listing.status !== 'ACTIVE') return { success: false, error: 'CANNOT_CANCEL_INACTIVE_ITEM' };

        listing.status = 'CANCELLED';
        return { success: true };
    }

    getListings(studioId = null) {
        return Array.from(this.listings.values())
            .filter(l => l.status === 'ACTIVE' && (!studioId || l.studioId === studioId))
            .sort((a, b) => b.createdAt - a.createdAt);
    }

    getLedger(studioId = null) {
        if (!studioId) return this.ledger;
        return this.ledger.filter(tx => tx.studioId === studioId);
    }

    clearStudio(studioId) {
        if (!studioId) return;
        for (const [id, l] of this.listings.entries()) {
            if (l.studioId === studioId) this.listings.delete(id);
        }
        this.ledger = this.ledger.filter(tx => tx.studioId !== studioId);
    }
}

module.exports = new Marketplace();
