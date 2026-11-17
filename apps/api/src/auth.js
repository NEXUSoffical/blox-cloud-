/**
 * BloxCloud Authentication Engine (Persistent)
 * Uses db.js to persist all user accounts, passwords, API keys, and sessions across server restarts.
 */

const crypto = require('crypto');
const db = require('./db');

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

        const user = {
            id: userId,
            email: cleanEmail,
            username: String(username || '').trim() || 'StudioDeveloper',
            studioName: String(studioName || '').trim() || 'Independent Studio',
            salt,
            passwordHash,
            apiKey,
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
