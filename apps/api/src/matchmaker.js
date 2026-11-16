/**
 * BloxCloud Matchmaking & ELO Engine (Multi-Tenant)
 * Handles skill-based matching, party grouping, and rating expansion over time.
 * Strictly partitioned by studioId so different games never match players against each other.
 */

const crypto = require('crypto');
const uuidv4 = () => crypto.randomUUID();

class Matchmaker {
    constructor() {
        // queueKey (`${studioId}:${queueType}`) -> Array of tickets
        this.queues = {};
        // ticketId -> ticket object
        this.tickets = new Map();
        // matchId -> match object
        this.matches = new Map();

        // Start matching loop (every 1 second)
        this.interval = setInterval(() => this.processQueues(), 1000);
    }

    /**
     * Add player or party to queue, scoped by studioId
     */
    enqueue(data, studioId = 'default') {
        const { userId, username, queueType = 'Ranked_1v1', rating = 1000, partyMembers = [userId], region = 'auto' } = data;

        // Check if player already in queue for this studio
        for (const [tId, ticket] of this.tickets.entries()) {
            if (ticket.studioId === studioId && ticket.userId === String(userId) && ticket.status === 'QUEUED') {
                return { ticketId: tId, status: 'ALREADY_QUEUED' };
            }
        }

        const ticketId = 'tkt_' + uuidv4().slice(0, 8);
        const ticket = {
            ticketId,
            studioId,
            userId: String(userId),
            username,
            queueType,
            rating: Number(rating) || 1000,
            partyMembers,
            region,
            createdAt: Date.now(),
            status: 'QUEUED',
            matchId: null,
        };

        const queueKey = `${studioId}:${queueType}`;
        if (!this.queues[queueKey]) {
            this.queues[queueKey] = [];
        }

        this.queues[queueKey].push(ticket);
        this.tickets.set(ticketId, ticket);

        return { ticketId, status: 'QUEUED', rating: ticket.rating };
    }

    /**
     * Remove player from queue
     */
    dequeue(userId, ticketId, studioId = null) {
        let ticket = null;
        if (ticketId && this.tickets.has(ticketId)) {
            ticket = this.tickets.get(ticketId);
            if (studioId && ticket.studioId !== studioId) ticket = null;
        } else {
            for (const t of this.tickets.values()) {
                if (t.userId === String(userId) && t.status === 'QUEUED' && (!studioId || t.studioId === studioId)) {
                    ticket = t;
                    break;
                }
            }
        }

        if (ticket && ticket.status === 'QUEUED') {
            ticket.status = 'CANCELLED';
            const queueKey = `${ticket.studioId}:${ticket.queueType}`;
            const queue = this.queues[queueKey];
            if (queue) {
                const idx = queue.findIndex(t => t.ticketId === ticket.ticketId);
                if (idx !== -1) queue.splice(idx, 1);
            }
            return true;
        }
        return false;
    }

    getTicket(ticketId, studioId = null) {
        const ticket = this.tickets.get(ticketId);
        if (!ticket) return null;
        if (studioId && ticket.studioId !== studioId) return null;
        return ticket;
    }

    /**
     * Matchmaking process loop
     */
    processQueues() {
        const now = Date.now();

        for (const [queueKey, queue] of Object.entries(this.queues)) {
            const parts = queueKey.split(':');
            const queueStudioId = parts.length > 1 ? parts[0] : 'default';
            const queueType = parts.length > 1 ? parts[1] : parts[0];

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
                    this.createMatch(queueType, candidateGroup, queueStudioId);
                    // Remove matched players from queue
                    queue.splice(i, requiredPlayers);
                } else {
                    i++;
                }
            }
        }
    }

    createMatch(queueType, tickets, studioId = 'default') {
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
            studioId,
            queueType,
            teamA: teamA.map(t => ({ userId: t.userId, username: t.username, rating: t.rating })),
            teamB: teamB.map(t => ({ userId: t.userId, username: t.username, rating: t.rating })),
            avgRatingA,
            avgRatingB,
            reservedServerCode: 'BLOX_SRV_' + uuidv4().slice(0, 8).toUpperCase(),
            createdAt: Date.now(),
        };

        this.matches.set(matchId, match);

        // Mark tickets as MATCHED
        for (const t of tickets) {
            t.status = 'MATCHED';
            t.matchId = matchId;
            t.match = match;
        }

        return match;
    }

    getStats(studioId = null) {
        const allMatches = Array.from(this.matches.values());
        const filteredMatches = studioId ? allMatches.filter(m => m.studioId === studioId) : allMatches;

        const allTickets = Array.from(this.tickets.values());
        const activeQueued = allTickets.filter(t => t.status === 'QUEUED' && (!studioId || t.studioId === studioId)).length;

        const queuesCount = {
            'Ranked_1v1': 0,
            'Ranked_2v2': 0,
            'Ranked_3v3': 0,
        };

        for (const [key, q] of Object.entries(this.queues)) {
            if (!studioId || key.startsWith(`${studioId}:`)) {
                const qType = key.includes(':') ? key.split(':')[1] : key;
                queuesCount[qType] = (queuesCount[qType] || 0) + q.length;
            }
        }

        return {
            totalMatchesCreated: filteredMatches.length,
            activeQueuedPlayers: activeQueued,
            queues: queuesCount,
            recentMatches: filteredMatches.slice(-10).reverse(),
        };
    }

    clearStudio(studioId) {
        if (!studioId) return;
        for (const key of Object.keys(this.queues)) {
            if (key.startsWith(`${studioId}:`)) delete this.queues[key];
        }
        for (const [tId, t] of this.tickets.entries()) {
            if (t.studioId === studioId) this.tickets.delete(tId);
        }
        for (const [mId, m] of this.matches.entries()) {
            if (m.studioId === studioId) this.matches.delete(mId);
        }
    }
}

module.exports = new Matchmaker();
