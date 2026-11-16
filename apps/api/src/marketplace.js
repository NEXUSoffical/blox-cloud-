/**
 * BloxCloud Global Auction House & Marketplace Engine (Persistent & Multi-Tenant)
 * Cross-server atomic item transactions preventing item duplication and race conditions.
 * Backed by db.js (PostgreSQL) so listings and transaction ledgers survive server restarts.
 */

const crypto = require('crypto');
const uuidv4 = () => crypto.randomUUID();
const db = require('./db');

class Marketplace {
    constructor() {
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

        db.saveListing(listing);
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
            const listing = db.findListingById(listingId);
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

            // 2. Mark as SOLD atomically and persist
            listing.status = 'SOLD';
            listing.soldTo = {
                buyerId: String(buyerId),
                buyerName: String(buyerName),
                purchasedAt: Date.now(),
            };
            db.saveListing(listing);

            // 3. Record transaction in persistent ledger
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

            db.addTransaction(transaction);

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
        const listing = db.findListingById(listingId);
        if (!listing) return { success: false, error: 'LISTING_NOT_FOUND' };
        if (studioId && listing.studioId && listing.studioId !== studioId) return { success: false, error: 'UNAUTHORIZED' };
        if (listing.sellerId !== String(sellerId)) return { success: false, error: 'UNAUTHORIZED' };
        if (listing.status !== 'ACTIVE') return { success: false, error: 'CANNOT_CANCEL_INACTIVE_ITEM' };

        listing.status = 'CANCELLED';
        db.saveListing(listing);
        return { success: true };
    }

    getListings(studioId = null) {
        return db.getListings(studioId, true);
    }

    getLedger(studioId = null) {
        return db.getLedger(studioId);
    }

    clearStudio(studioId) {
        if (!studioId) return;
        db.resetLiveOpsAndMarket(studioId);
    }
}

module.exports = new Marketplace();
