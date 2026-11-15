/**
 * BloxCloud Matchmaking & ELO Engine
 * Handles skill-based matching, party grouping, and rating expansion over time.
 */

const crypto = require('crypto');
const uuidv4 = () => crypto.randomUUID();

class Matchmaker {
    constructor() {
        // queueType -> Array of tickets
        this.queues = {
            'Ranked_1v1': [],
            'Ranked_2v2': [],
            'Ranked_3v3': [],
        };
        // ticketId -> ticket object
        this.tickets = new Map();
        // matchId -> match object
        this.matches = new Map();
        // Stats
        this.stats = {
            totalMatchesCreated: 0,
            activeQueuedPlayers: 0,
        };

        // Start matching loop (every 1 second)
        this.interval = setInterval(() => this.processQueues(), 1000);
    }

    /**
     * Add player or party to queue
     */
    enqueue(data) {
        const { userId, username, queueType = 'Ranked_1v1', rating = 1000, partyMembers = [userId], region = 'auto' } = data;

        // Check if player already in queue
        for (const [tId, ticket] of this.tickets.entries()) {
            if (ticket.userId === userId && ticket.status === 'QUEUED') {
                return { ticketId: tId, status: 'ALREADY_QUEUED' };
            }
        }

        const ticketId = 'tkt_' + uuidv4().slice(0, 8);
        const ticket = {
            ticketId,
            userId,
            username,
            queueType,
            rating: Number(rating) || 1000,
            partyMembers,
            region,
            createdAt: Date.now(),
            status: 'QUEUED',
            matchId: null,
        };

        if (!this.queues[queueType]) {
            this.queues[queueType] = [];
        }

        this.queues[queueType].push(ticket);
        this.tickets.set(ticketId, ticket);
        this.updateStats();

        return { ticketId, status: 'QUEUED', rating: ticket.rating };
    }

    /**
     * Remove player from queue
     */
    dequeue(userId, ticketId) {
        let ticket = null;
        if (ticketId && this.tickets.has(ticketId)) {
            ticket = this.tickets.get(ticketId);
        } else {
            for (const t of this.tickets.values()) {
                if (t.userId === userId && t.status === 'QUEUED') {
                    ticket = t;
                    break;
                }
            }
        }

        if (ticket && ticket.status === 'QUEUED') {
            ticket.status = 'CANCELLED';
            const queue = this.queues[ticket.queueType];
            if (queue) {
                const idx = queue.findIndex(t => t.ticketId === ticket.ticketId);
                if (idx !== -1) queue.splice(idx, 1);
            }
            this.updateStats();
            return true;
        }
        return false;
    }

    getTicket(ticketId) {
        return this.tickets.get(ticketId) || null;
    }

    /**
     * Matchmaking process loop
     */
    processQueues() {
        const now = Date.now();

        for (const [queueType, queue] of Object.entries(this.queues)) {
            const teamSize = queueType === 'Ranked_1v1' ? 1 : queueType === 'Ranked_2v2' ? 2 : 3;
            const requiredPlayers = teamSize * 2;

            if (queue.length < requiredPlayers) continue;

            // Sort queue by rating
            queue.sort((a, b) => a.rating - b.rating);

            // Find closest matches with rating expansion window
            let i = 0;
            while (i <= queue.length - requiredPlayers) {
                const candidateGroup = queue.slice(i, i + requiredPlayers);
                
                // Calculate wait time in seconds for oldest player
                const oldestTime = Math.min(...candidateGroup.map(t => t.createdAt));
                const waitSeconds = (now - oldestTime) / 1000;

                // Expand rating tolerance: Base 100 ELO, +30 ELO every 2 seconds in queue, max 400
                const allowedDiff = Math.min(400, 100 + Math.floor(waitSeconds / 2) * 30);
                const minRating = candidateGroup[0].rating;
                const maxRating = candidateGroup[candidateGroup.length - 1].rating;

                if (maxRating - minRating <= allowedDiff) {
                    // Match found!
                    this.createMatch(queueType, candidateGroup);
                    // Remove matched players from queue
                    queue.splice(i, requiredPlayers);
                } else {
                    i++;
                }
            }
        }

        this.updateStats();
    }

    createMatch(queueType, tickets) {
        const matchId = 'match_' + uuidv4().slice(0, 10);
        
        // Split into balanced teams (Team A: 1st, 4th... Team B: 2nd, 3rd... for snake balance)
        const teamA = [];
        const teamB = [];

        tickets.forEach((ticket, idx) => {
            if (idx % 2 === 0) teamA.push(ticket);
            else teamB.push(ticket);
        });

        const avgRatingA = Math.round(teamA.reduce((sum, t) => sum + t.rating, 0) / teamA.length);
        const avgRatingB = Math.round(teamB.reduce((sum, t) => sum + t.rating, 0) / teamB.length);

        const match = {
            matchId,
            queueType,
            teamA: teamA.map(t => ({ userId: t.userId, username: t.username, rating: t.rating })),
            teamB: teamB.map(t => ({ userId: t.userId, username: t.username, rating: t.rating })),
            avgRatingA,
            avgRatingB,
            reservedServerCode: 'BLOX_SRV_' + uuidv4().slice(0, 8).toUpperCase(),
            createdAt: Date.now(),
        };

        this.matches.set(matchId, match);
        this.stats.totalMatchesCreated++;

        // Mark tickets as MATCHED
        for (const t of tickets) {
            t.status = 'MATCHED';
            t.matchId = matchId;
            t.match = match;
        }

        return match;
    }

    updateStats() {
        let count = 0;
        for (const q of Object.values(this.queues)) {
            count += q.length;
        }
        this.stats.activeQueuedPlayers = count;
    }

    getStats() {
        return {
            ...this.stats,
            queues: Object.fromEntries(Object.entries(this.queues).map(([k, v]) => [k, v.length])),
            recentMatches: Array.from(this.matches.values()).slice(-10).reverse(),
        };
    }
}

module.exports = new Matchmaker();
