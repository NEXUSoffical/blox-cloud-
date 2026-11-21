/**
 * BloxCloud Authentication Engine (Persistent)
 * Uses db.js to persist all user accounts, passwords, API keys, and sessions across server restarts.
 */

const crypto = require('crypto');
const db = require('./db');

// Minimal Base58 decoder (Bitcoin/Solana alphabet) for zero-dependency Ed25519 wallet verification
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function decodeBase58(str) {
    if (!str || typeof str !== 'string') return null;
    const bytes = [0];
    for (let i = 0; i < str.length; i++) {
        const val = BASE58_ALPHABET.indexOf(str[i]);
        if (val === -1) return null;
        let carry = val;
        for (let j = 0; j < bytes.length; j++) {
            carry += bytes[j] * 58;
            bytes[j] = carry & 0xff;
            carry >>= 8;
        }
        while (carry > 0) {
            bytes.push(carry & 0xff);
            carry >>= 8;
        }
    }
    for (let i = 0; i < str.length && str[i] === '1'; i++) {
        bytes.push(0);
    }
    return Buffer.from(bytes.reverse());
}

// Ed25519 SubjectPublicKeyInfo (SPKI) DER prefix for a 32-byte raw public key
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

// One-time Web3 login challenges (nonce -> { studioId, walletAddress, message, expiresAt })
const web3Challenges = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of web3Challenges.entries()) {
        if (v.expiresAt < now) web3Challenges.delete(k);
    }
}, 60 * 1000).unref();

class AuthManager {
    _hashPassword(password, salt) {
        return new Promise((resolve, reject) => {
            crypto.scrypt(password, salt, 64, (err, derivedKey) => {
                if (err) reject(err);
                else resolve(derivedKey.toString('hex'));
            });
        });
    }

    async register(email, password, username, studioName) {
        const cleanEmail = (email || '').trim().toLowerCase();
        if (db.findUserByEmail(cleanEmail)) {
            return { success: false, error: 'An account with this email already exists.' };
        }

        if (!password || password.length < 6) {
            return { success: false, error: 'Password must be at least 6 characters.' };
        }

        const userId = 'usr_' + crypto.randomUUID().slice(0, 10);
        const salt = crypto.randomBytes(16).toString('hex');
        const passwordHash = await this._hashPassword(password, salt);
        const apiKey = 'bc_live_' + crypto.randomBytes(16).toString('hex');
        const publicKey = 'bc_pub_' + crypto.randomBytes(16).toString('hex');

        const user = {
            id: userId,
            email: cleanEmail,
            username: String(username || '').trim() || 'StudioDeveloper',
            studioName: String(studioName || '').trim() || 'Independent Studio',
            salt,
            passwordHash,
            apiKey,
            publicKey,
            plan: 'FREE',
            planStatus: 'ACTIVE',
            createdAt: Date.now(),
        };

        db.saveUser(user);

        // Create persistent session
        const sessionToken = crypto.randomBytes(32).toString('hex');
        db.createSession(sessionToken, userId);

        const safeUser = this._getSafeUser(user);
        return { success: true, user: safeUser, token: sessionToken };
    }

    async login(email, password) {
        const cleanEmail = (email || '').trim().toLowerCase();
        const user = db.findUserByEmail(cleanEmail);
        if (!user) {
            return { success: false, error: 'No account found with this email. Click "Create Account" above to register!' };
        }

        const hash = await this._hashPassword(password, user.salt);
        if (hash !== user.passwordHash) {
            return { success: false, error: 'Incorrect password. Please try again.' };
        }

        const sessionToken = crypto.randomBytes(32).toString('hex');
        db.createSession(sessionToken, user.id);

        return { success: true, user: this._getSafeUser(user), token: sessionToken };
    }

    logout(token) {
        db.deleteSession(token);
        return true;
    }

    getUserByToken(token) {
        if (!token) return null;
        const userId = db.getUserIdByToken(token);
        if (!userId) return null;
        const user = db.findUserById(userId);
        return user ? this._getSafeUser(user) : null;
    }

    getUserByApiKey(apiKey) {
        if (!apiKey) return null;
        return db.findUserByApiKey(apiKey) || null;
    }

    getUserByPublicKey(publicKey) {
        if (!publicKey) return null;
        return db.findUserByPublicKey(publicKey) || null;
    }

    /**
     * Mint an HMAC-SHA256 signed Player Session Token scoped strictly to (studioId, playerId).
     * Signed with the studio's secret apiKey so rotating the studio key invalidates old tokens.
     */
    signPlayerToken(studioUser, playerId, username, ttlMs = 24 * 60 * 60 * 1000) {
        const payload = {
            sid: studioUser.id,
            pid: String(playerId),
            usr: String(username || playerId).slice(0, 64),
            exp: Date.now() + ttlMs,
        };
        const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
        const sig = crypto
            .createHmac('sha256', studioUser.apiKey)
            .update(payloadB64)
            .digest('base64url');
        return `bcp_${payloadB64}.${sig}`;
    }

    /**
     * Verify a Player Session Token and return { studio, playerId, username } or null.
     */
    verifyPlayerToken(token) {
        if (!token || typeof token !== 'string' || !token.startsWith('bcp_')) return null;
        const raw = token.slice(4);
        const dotIdx = raw.indexOf('.');
        if (dotIdx === -1) return null;

        const payloadB64 = raw.slice(0, dotIdx);
        const providedSig = raw.slice(dotIdx + 1);
        let payload;
        try {
            payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
        } catch (e) {
            return null;
        }
        if (!payload || !payload.sid || !payload.pid || !payload.exp || Date.now() > payload.exp) {
            return null;
        }
        const studioUser = db.findUserById(payload.sid);
        if (!studioUser || !studioUser.apiKey) return null;

        const expectedSig = crypto
            .createHmac('sha256', studioUser.apiKey)
            .update(payloadB64)
            .digest('base64url');
        const a = Buffer.from(providedSig);
        const b = Buffer.from(expectedSig);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

        return {
            studio: this._getSafeUser(studioUser),
            playerId: payload.pid,
            username: payload.usr || payload.pid,
        };
    }

    regenerateApiKey(userId) {
        const user = db.findUserById(userId);
        if (!user) return null;

        const newKey = 'bc_live_' + crypto.randomBytes(16).toString('hex');
        user.apiKey = newKey;
        db.saveUser(user);

        return newKey;
    }

    updateUserPlan(userId, plan) {
        const user = db.findUserById(userId);
        if (!user) return false;
        user.plan = plan;
        user.planStatus = 'ACTIVE';
        db.saveUser(user);
        return true;
    }

    updateDiscordWebhook(userId, webhookUrl) {
        const user = db.findUserById(userId);
        if (!user) return false;
        user.discordWebhookUrl = webhookUrl ? String(webhookUrl).trim() : '';
        db.saveUser(user);
        return true;
    }

    /**
     * Create a one-time 5-minute nonce challenge for Solana/Phantom Ed25519 wallet authentication.
     */
    createWeb3Challenge(studioId, walletAddress) {
        const cleanWallet = String(walletAddress || '').trim();
        const rawPub = decodeBase58(cleanWallet);
        if (!rawPub || rawPub.length !== 32) {
            return { success: false, error: 'Invalid Solana wallet address (must be 32-byte Base58 public key).' };
        }
        const nonce = crypto.randomBytes(16).toString('hex');
        const expiresAt = Date.now() + 5 * 60 * 1000;
        const message = `Sign in to BloxCloud\nStudio: ${studioId}\nWallet: ${cleanWallet}\nNonce: ${nonce}`;
        web3Challenges.set(nonce, { studioId, walletAddress: cleanWallet, message, expiresAt });
        return { success: true, nonce, message, expiresAt };
    }

    /**
     * Cryptographically verify an Ed25519 signature from Phantom / Solana Wallet and consume the nonce.
     */
    verifySolanaChallenge(studioUser, walletAddress, signatureBase64, nonce) {
        const challenge = web3Challenges.get(nonce);
        if (!challenge) return { success: false, error: 'Invalid or expired challenge nonce.' };
        if (challenge.expiresAt < Date.now()) {
            web3Challenges.delete(nonce);
            return { success: false, error: 'Challenge expired. Request a new nonce.' };
        }
        if (challenge.studioId !== studioUser.id || challenge.walletAddress !== String(walletAddress || '').trim()) {
            return { success: false, error: 'Challenge does not match studio or wallet.' };
        }

        const rawPub = decodeBase58(challenge.walletAddress);
        if (!rawPub || rawPub.length !== 32) {
            return { success: false, error: 'Invalid wallet public key.' };
        }

        let sigBuf;
        try {
            sigBuf = Buffer.from(String(signatureBase64 || ''), 'base64');
        } catch (e) {
            return { success: false, error: 'Invalid base64 signature.' };
        }
        if (sigBuf.length !== 64) {
            return { success: false, error: 'Invalid Ed25519 signature length (expected 64 bytes).' };
        }

        let isValid = false;
        try {
            const spkiDer = Buffer.concat([ED25519_SPKI_PREFIX, rawPub]);
            const pubKeyObj = crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
            isValid = crypto.verify(null, Buffer.from(challenge.message, 'utf8'), pubKeyObj, sigBuf);
        } catch (e) {
            return { success: false, error: 'Signature verification failed: ' + e.message };
        }

        if (!isValid) {
            return { success: false, error: 'Cryptographic Ed25519 signature mismatch.' };
        }

        // One-time use: consume nonce to prevent replay attacks
        web3Challenges.delete(nonce);

        const shortName = `${challenge.walletAddress.slice(0, 4)}...${challenge.walletAddress.slice(-4)}`;
        const playerToken = this.signPlayerToken(studioUser, challenge.walletAddress, shortName);
        return {
            success: true,
            verified: true,
            walletAddress: challenge.walletAddress,
            username: shortName,
            playerToken,
        };
    }

    _getSafeUser(user) {
        // Lazily backfill publicKey for existing studio accounts
        if (!user.publicKey) {
            user.publicKey = 'bc_pub_' + crypto.randomBytes(16).toString('hex');
            db.saveUser(user);
        }
        return {
            id: user.id,
            email: user.email,
            username: user.username,
            studioName: user.studioName,
            apiKey: user.apiKey,
            publicKey: user.publicKey,
            discordWebhookUrl: user.discordWebhookUrl || '',
            plan: user.plan,
            planStatus: user.planStatus,
            createdAt: user.createdAt,
        };
    }
}

module.exports = new AuthManager();
