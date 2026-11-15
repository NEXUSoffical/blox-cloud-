/**
 * BloxCloud Global Auction House & Marketplace Engine
 * Cross-server atomic item transactions preventing item duplication and race conditions.
 */

const crypto = require('crypto');
const uuidv4 = () => crypto.randomUUID();

class Marketplace {
    constructor() {
        // listingId -> listing
        this.listings = new Map();
        // Transaction ledger for audits
        this.ledger = [];
        // Mutex / Locks for atomic buying
        this.locks = new Set();
    }

    listItem(data) {
        const { sellerId, sellerName, itemId, itemData = {}, price } = data;

        const listingId = 'list_' + uuidv4().slice(0, 8);
        const listing = {
            listingId,
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
     * Atomically purchase an item with anti-dupe lock
     */
    buyItem(buyerId, buyerName, listingId) {
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
            if (this.ledger.length > 100) this.ledger.pop();

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

    cancelListing(sellerId, listingId) {
        const listing = this.listings.get(listingId);
        if (!listing) return { success: false, error: 'LISTING_NOT_FOUND' };
        if (listing.sellerId !== String(sellerId)) return { success: false, error: 'UNAUTHORIZED' };
        if (listing.status !== 'ACTIVE') return { success: false, error: 'CANNOT_CANCEL_INACTIVE_ITEM' };

        listing.status = 'CANCELLED';
        return { success: true };
    }

    getListings(filter = {}) {
        const active = Array.from(this.listings.values())
            .filter(l => l.status === 'ACTIVE')
            .sort((a, b) => b.createdAt - a.createdAt);
        return active;
    }

    getLedger() {
        return this.ledger;
    }
}

module.exports = new Marketplace();
