/**
 * BloxCloud Universal JavaScript / TypeScript SDK (v1.0.0)
 * For HTML5, Three.js, Phaser, Unity WebGL, Telegram Mini-Games & Web3 / Crypto Games
 *
 * Works in:
 *  - Browser (<script src="https://bloxcloud.world/sdk/web.js"></script>)
 *  - ES Modules / Bundlers (Vite, Webpack, Next.js)
 *  - Node.js / Bun Game Servers (Express, Socket.io, Colyseus)
 *
 * Docs: https://bloxcloud.world/docs
 */

(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.BloxCloud = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    class BloxCloud {
        /**
         * @param {Object} config
         * @param {string} config.apiKey - Your BloxCloud Studio API key (from dashboard)
         * @param {string} [config.baseUrl='https://bloxcloud.world'] - BloxCloud API URL
         * @param {string} [config.serverId] - Unique identifier for this game instance/room
         * @param {string} [config.region='GLOBAL'] - Server region (e.g. EU, US-EAST, ASIA)
         * @param {boolean} [config.debug=false] - Enable verbose console logging
         */
        constructor(config = {}) {
            if (!config.apiKey) {
                throw new Error('[BloxCloud] Missing required "apiKey" in constructor.');
            }
            this.apiKey = config.apiKey;
            this.baseUrl = (config.baseUrl || 'https://bloxcloud.world').replace(/\/+$/, '');
            this.serverId = config.serverId || ('web-' + Math.random().toString(36).slice(2, 10));
            this.region = config.region || 'GLOBAL';
            this.debug = Boolean(config.debug);

            this._telemetryTimer = null;
            this._liveopsTimer = null;
            this._cachedConfig = { config: {}, flags: [], activeBroadcast: null };
            this._lastBroadcastId = null;

            // Attach modular namespaces
            this.matchmaking = {
                enqueue: (params) => this._enqueueMatch(params),
                leave: (params) => this._leaveMatch(params),
                getTicket: (ticketId) => this._getTicket(ticketId),
                getMatch: (matchId) => this._getMatch(matchId),
                waitForMatch: (ticketId, opts) => this._waitForMatch(ticketId, opts),
                claimRoomCode: (matchId, roomCode) => this._claimRoomCode(matchId, roomCode),
            };

            this.marketplace = {
                listItem: (params) => this._listItem(params),
                buyItem: (params) => this._buyItem(params),
                getListings: () => this._getListings(),
            };

            this.liveops = {
                getConfig: () => this._fetchLiveOps(),
                getFlag: (key, defaultValue) => this._getFlag(key, defaultValue),
                startPolling: (opts) => this._startLiveOpsPolling(opts),
                stopPolling: () => this._stopLiveOpsPolling(),
            };

            this.web3 = {
                detectPlayerIdentity: () => this._detectWeb3Identity(),
            };
        }

        _log(...args) {
            if (this.debug) {
                console.log('[BloxCloud]', ...args);
            }
        }

        async _request(method, endpoint, body = null) {
            const url = `${this.baseUrl}${endpoint}`;
            const headers = {
                'Content-Type': 'application/json',
                'x-api-key': this.apiKey,
            };

            const options = { method, headers };
            if (body !== null && method !== 'GET') {
                options.body = JSON.stringify(body);
            }

            const res = await fetch(url, options);
            let data = null;
            try {
                data = await res.json();
            } catch (e) {
                data = { error: `HTTP ${res.status}` };
            }

            if (!res.ok) {
                const err = new Error(data.error || `BloxCloud request failed (${res.status})`);
                err.status = res.status;
                err.code = data.code || null;
                err.response = data;
                throw err;
            }
            return data;
        }

        // =========================================================================
        // 1. TELEMETRY, HEARTBEATS & ANTI-CHEAT REPORTING
        // =========================================================================

        /**
         * Send a single server/instance heartbeat to BloxCloud telemetry.
         */
        async sendHeartbeat(stats = {}) {
            const isBrowser = typeof window !== 'undefined';
            let memoryMb = stats.memoryMb;
            if (memoryMb === undefined) {
                if (isBrowser && performance && performance.memory) {
                    memoryMb = Math.round(performance.memory.usedJSHeapSize / (1024 * 1024));
                } else if (typeof process !== 'undefined' && process.memoryUsage) {
                    memoryMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
                } else {
                    memoryMb = 64;
                }
            }

            const payload = {
                jobId: stats.serverId || this.serverId,
                placeId: stats.gameId || (isBrowser ? window.location.hostname : 'web-game-server'),
                playerCount: Number(stats.playerCount ?? 1),
                maxPlayers: Number(stats.maxPlayers ?? 100),
                fps: Number(stats.fps ?? 60),
                memoryMb: Number(memoryMb),
                pingMs: Number(stats.pingMs ?? 25),
                region: stats.region || this.region,
                engine: 'WEB',
            };

            this._log('Sending heartbeat:', payload);
            return this._request('POST', '/api/v1/telemetry/heartbeat', payload);
        }

        /**
         * Automatically send periodic heartbeats to keep live fleet analytics updated.
         */
        startTelemetry(options = {}) {
            this.stopTelemetry();
            const intervalMs = Math.max(5000, Number(options.intervalMs || 15000));

            const pulse = () => {
                const stats = {
                    playerCount: typeof options.getPlayerCount === 'function' ? options.getPlayerCount() : 1,
                    maxPlayers: options.maxPlayers || 100,
                    fps: typeof options.getFps === 'function' ? options.getFps() : 60,
                    pingMs: typeof options.getPingMs === 'function' ? options.getPingMs() : 25,
                    gameId: options.gameId,
                };
                this.sendHeartbeat(stats).catch((err) => this._log('Heartbeat warning:', err.message));
            };

            pulse();
            this._telemetryTimer = setInterval(pulse, intervalMs);
            if (this._telemetryTimer.unref) this._telemetryTimer.unref();
        }

        stopTelemetry() {
            if (this._telemetryTimer) {
                clearInterval(this._telemetryTimer);
                this._telemetryTimer = null;
            }
        }

        /**
         * Report a runtime exception or game crash to the BloxCloud error console.
         */
        async reportError(message, stack = '', severity = 'ERROR') {
            return this._request('POST', '/api/v1/telemetry/error', {
                jobId: this.serverId,
                message: String(message),
                stack: String(stack || ''),
                severity,
            });
        }

        /**
         * Report suspicious client tampering, DevTools score spoofing, or dupe attempts.
         */
        async reportExploit(playerId, playerName, reason, details = {}) {
            return this._request('POST', '/api/v1/telemetry/exploit-alert', {
                jobId: this.serverId,
                userId: String(playerId),
                username: String(playerName || playerId),
                type: reason,
                details,
            });
        }

        // =========================================================================
        // 2. CROSS-SERVER ELO MATCHMAKING & 1v1 WAGER ROOMS
        // =========================================================================

        async _enqueueMatch({ userId, username, queueType = '1v1_RANKED', rating = 1000, region, partyMembers = [] }) {
            return this._request('POST', '/api/v1/matchmaking/queue', {
                userId: String(userId),
                username: String(username || userId),
                queueType,
                rating: Number(rating),
                region: region || this.region,
                partyMembers,
            });
        }

        async _leaveMatch({ userId, ticketId }) {
            return this._request('POST', '/api/v1/matchmaking/leave', {
                userId: userId ? String(userId) : undefined,
                ticketId,
            });
        }

        async _getTicket(ticketId) {
            return this._request('GET', `/api/v1/matchmaking/ticket/${encodeURIComponent(ticketId)}`);
        }

        async _getMatch(matchId) {
            return this._request('GET', `/api/v1/matchmaking/match/${encodeURIComponent(matchId)}`);
        }

        /**
         * Coordinate a shared room code (WebRTC Peer ID, Socket.io room, or Colyseus roomId)
         * using first-writer-wins atomic locking across matched players.
         */
        async _claimRoomCode(matchId, roomCode) {
            return this._request('POST', `/api/v1/matchmaking/match/${encodeURIComponent(matchId)}/server-code`, {
                robloxAccessCode: String(roomCode),
            });
        }

        /**
         * Poll a matchmaking ticket until a match is found or timeout expires.
         */
        async _waitForMatch(ticketId, { pollIntervalMs = 2000, timeoutMs = 120000, onUpdate } = {}) {
            const startedAt = Date.now();
            while (Date.now() - startedAt < timeoutMs) {
                const ticket = await this._getTicket(ticketId);
                if (typeof onUpdate === 'function') onUpdate(ticket);

                if (ticket.status === 'MATCHED' && ticket.matchId) {
                    const match = await this._getMatch(ticket.matchId);
                    return { ticket, match };
                }
                if (ticket.status === 'CANCELLED' || ticket.status === 'EXPIRED') {
                    throw new Error(`Matchmaking ticket ended with status: ${ticket.status}`);
                }
                await new Promise((r) => setTimeout(r, pollIntervalMs));
            }
            throw new Error('Matchmaking timed out waiting for opponent.');
        }

        // =========================================================================
        // 3. ANTI-DUPE OFF-CHAIN MARKETPLACE & TRADING
        // =========================================================================

        async _listItem({ sellerId, sellerName, itemId, itemData = {}, price }) {
            return this._request('POST', '/api/v1/marketplace/list', {
                sellerId: String(sellerId),
                sellerName: String(sellerName || sellerId),
                itemId: String(itemId),
                itemData,
                price: Math.floor(Number(price)),
            });
        }

        async _buyItem({ buyerId, buyerName, listingId }) {
            return this._request('POST', '/api/v1/marketplace/buy', {
                buyerId: String(buyerId),
                buyerName: String(buyerName || buyerId),
                listingId: String(listingId),
            });
        }

        async _getListings() {
            const data = await this._request('GET', '/api/v1/marketplace/listings');
            return data.listings || [];
        }

        // =========================================================================
        // 4. LIVEOPS FEATURE FLAGS & GLOBAL BROADCASTS
        // =========================================================================

        async _fetchLiveOps() {
            const data = await this._request('GET', '/api/v1/liveops/config');
            this._cachedConfig = data;
            return data;
        }

        _getFlag(key, defaultValue = undefined) {
            if (this._cachedConfig && this._cachedConfig.config && key in this._cachedConfig.config) {
                return this._cachedConfig.config[key];
            }
            return defaultValue;
        }

        _startLiveOpsPolling({ intervalMs = 15000, onConfigChange, onBroadcast } = {}) {
            this._stopLiveOpsPolling();
            const poll = async () => {
                try {
                    const prevJson = JSON.stringify(this._cachedConfig.config || {});
                    const next = await this._fetchLiveOps();
                    const nextJson = JSON.stringify(next.config || {});

                    if (prevJson !== nextJson && typeof onConfigChange === 'function') {
                        onConfigChange(next.config, next.flags);
                    }

                    if (next.activeBroadcast && next.activeBroadcast.id !== this._lastBroadcastId) {
                        this._lastBroadcastId = next.activeBroadcast.id;
                        if (typeof onBroadcast === 'function') {
                            onBroadcast(next.activeBroadcast);
                        }
                    }
                } catch (err) {
                    this._log('LiveOps poll warning:', err.message);
                }
            };

            poll();
            this._liveopsTimer = setInterval(poll, Math.max(5000, Number(intervalMs)));
            if (this._liveopsTimer.unref) this._liveopsTimer.unref();
        }

        _stopLiveOpsPolling() {
            if (this._liveopsTimer) {
                clearInterval(this._liveopsTimer);
                this._liveopsTimer = null;
            }
        }

        // =========================================================================
        // 5. WEB3 / CRYPTO & TELEGRAM MINI-GAME IDENTITY HELPER
        // =========================================================================

        /**
         * Automatically detects connected Solana (Phantom), EVM (MetaMask), or Telegram Mini-App
         * player identity so Web3 games can authenticate players in one line.
         */
        _detectWeb3Identity() {
            if (typeof window === 'undefined') {
                return { provider: 'server', userId: this.serverId, username: this.serverId };
            }

            // 1. Telegram WebApp Mini-Game
            if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initDataUnsafe && window.Telegram.WebApp.initDataUnsafe.user) {
                const tgUser = window.Telegram.WebApp.initDataUnsafe.user;
                return {
                    provider: 'telegram',
                    userId: `tg_${tgUser.id}`,
                    username: tgUser.username || tgUser.first_name || `tg_${tgUser.id}`,
                };
            }

            // 2. Solana / Phantom Wallet
            if (window.solana && window.solana.isConnected && window.solana.publicKey) {
                const pubKey = window.solana.publicKey.toString();
                return {
                    provider: 'solana',
                    userId: pubKey,
                    username: `${pubKey.slice(0, 4)}...${pubKey.slice(-4)}`,
                };
            }

            // 3. EVM / MetaMask Wallet
            if (window.ethereum && window.ethereum.selectedAddress) {
                const addr = window.ethereum.selectedAddress;
                return {
                    provider: 'evm',
                    userId: addr.toLowerCase(),
                    username: `${addr.slice(0, 6)}...${addr.slice(-4)}`,
                };
            }

            // 4. Guest Browser Session
            let guestId = null;
            try {
                guestId = localStorage.getItem('bloxcloud_guest_id');
                if (!guestId) {
                    guestId = 'guest_' + Math.random().toString(36).slice(2, 10);
                    localStorage.setItem('bloxcloud_guest_id', guestId);
                }
            } catch (e) {
                guestId = 'guest_' + Math.random().toString(36).slice(2, 10);
            }
            return { provider: 'guest', userId: guestId, username: guestId };
        }
    }

    return BloxCloud;
}));
