/**
 * BloxCloud Authentication Engine
 * Secure user registration, scrypt password hashing, and session management using Node.js crypto.
 */

const crypto = require('crypto');

class AuthManager {
    constructor() {
        // userId -> user object
        this.users = new Map();
        // email -> userId
        this.emailIndex = new Map();
        // token -> userId
        this.sessions = new Map();
        // apiKey -> userId
        this.apiKeys = new Map();
    }

    _hashPassword(password, salt) {
        return new Promise((resolve, reject) => {
            crypto.scrypt(password, salt, 64, (err, derivedKey) => {
                if (err) reject(err);
                else resolve(derivedKey.toString('hex'));
            });
        });
    }

    async register(email, password, username, studioName) {
        const cleanEmail = email.trim().toLowerCase();
        if (this.emailIndex.has(cleanEmail)) {
            return { success: false, error: 'An account with this email already exists.' };
        }

        if (!password || password.length < 6) {
            return { success: false, error: 'Password must be at least 6 characters.' };
        }

        const userId = 'usr_' + crypto.randomUUID().slice(0, 10);
        const salt = crypto.randomBytes(16).toString('hex');
        const passwordHash = await this._hashPassword(password, salt);
        const apiKey = 'bc_live_' + crypto.randomBytes(16).toString('hex');

        const user = {
            id: userId,
            email: cleanEmail,
            username: username.trim() || 'StudioDeveloper',
            studioName: studioName.trim() || 'Independent Studio',
            salt,
            passwordHash,
            apiKey,
            plan: 'FREE', // 'FREE' | 'PRO' | 'STUDIO' | 'ENTERPRISE'
            planStatus: 'ACTIVE',
            createdAt: Date.now(),
        };

        this.users.set(userId, user);
        this.emailIndex.set(cleanEmail, userId);
        this.apiKeys.set(apiKey, userId);

        // Create initial session
        const sessionToken = crypto.randomBytes(32).toString('hex');
        this.sessions.set(sessionToken, userId);

        const safeUser = this._getSafeUser(user);
        return { success: true, user: safeUser, token: sessionToken };
    }

    async login(email, password) {
        const cleanEmail = email.trim().toLowerCase();
        const userId = this.emailIndex.get(cleanEmail);
        if (!userId) {
            return { success: false, error: 'Invalid email or password.' };
        }

        const user = this.users.get(userId);
        if (!user) {
            return { success: false, error: 'User not found.' };
        }

        const hash = await this._hashPassword(password, user.salt);
        if (hash !== user.passwordHash) {
            return { success: false, error: 'Invalid email or password.' };
        }

        const sessionToken = crypto.randomBytes(32).toString('hex');
        this.sessions.set(sessionToken, userId);

        return { success: true, user: this._getSafeUser(user), token: sessionToken };
    }

    logout(token) {
        if (this.sessions.has(token)) {
            this.sessions.delete(token);
            return true;
        }
        return false;
    }

    getUserByToken(token) {
        if (!token) return null;
        const userId = this.sessions.get(token);
        if (!userId) return null;
        const user = this.users.get(userId);
        return user ? this._getSafeUser(user) : null;
    }

    getUserByApiKey(apiKey) {
        if (!apiKey) return null;
        const userId = this.apiKeys.get(apiKey);
        if (!userId) return null;
        return this.users.get(userId) || null;
    }

    regenerateApiKey(userId) {
        const user = this.users.get(userId);
        if (!user) return null;

        // Remove old key index
        this.apiKeys.delete(user.apiKey);

        // Generate new key
        const newKey = 'bc_live_' + crypto.randomBytes(16).toString('hex');
        user.apiKey = newKey;
        this.apiKeys.set(newKey, userId);

        return newKey;
    }

    updateUserPlan(userId, plan) {
        const user = this.users.get(userId);
        if (!user) return false;
        user.plan = plan;
        user.planStatus = 'ACTIVE';
        return true;
    }

    _getSafeUser(user) {
        return {
            id: user.id,
            email: user.email,
            username: user.username,
            studioName: user.studioName,
            apiKey: user.apiKey,
            plan: user.plan,
            planStatus: user.planStatus,
            createdAt: user.createdAt,
        };
    }
}

module.exports = new AuthManager();
