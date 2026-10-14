/**
 * REST API v1 — authentication, setup, invites and account administration.
 *
 * This is the cutover replacement for the socket handlers the Vue frontend
 * used (better-auth-socket-handler, user-socket-handler,
 * user-invite-socket-handler and the login half of api-key-socket-handler).
 * Everything the dashboard needs to sign an operator in and manage accounts
 * lives here, over plain HTTP, so no session cookie or Socket.IO connection
 * is required.
 *
 * Two credential types, deliberately separate:
 * - Unauthenticated endpoints (setup status, password login, invite
 *   check/redeem) are rate limited and return tokens, never sessions. The
 *   dashboard stores the token and uses it as a bearer credential.
 * - Authenticated endpoints (me, users, invites) take the same bearer token
 *   through tokenAuth, so one auth model covers operators and agents.
 */

const express = require("express");
const { R } = require("redbean-node");
const { nanoid } = require("nanoid");
const { log } = require("../../src/util");
const { tokenAuth } = require("../auth");
const { apiCors } = require("../api-cors");
const passwordHash = require("../password-hash");
const { Settings } = require("../settings");
const { loginRateLimiter, inviteRateLimiter } = require("../rate-limiter");
const { checkPassword, getAuthSecret, migrateUser } = require("../better-auth");
const { needSetup, hasUser } = require("./better-auth-router");
const UserInvite = require("../model/user_invite");
const APIKey = require("../model/api_key");

const router = express.Router();

// Before the body parser and routes, so a preflight is answered here rather
// than 404ing before the headers are set.
router.use(apiCors);
router.use(express.json({ limit: "64kb" }));

/**
 * Send a consistent error body and stop.
 * @param {express.Response} res Express response
 * @param {number} status HTTP status code
 * @param {string} error Machine-readable error code
 * @param {string} message Human-readable explanation
 * @returns {void}
 */
function fail(res, status, error, message) {
    res.status(status).json({ ok: false, error, message });
}

/**
 * Whether the instance still needs first-run setup.
 * @param {express.Request} req Express request
 * @param {express.Response} res Express response
 * @returns {Promise<void>}
 */
router.get("/api/v1/auth/setup", async (req, res) => {
    try {
        res.json({ ok: true, setupNeeded: await needSetup() });
    } catch (e) {
        log.error("auth", `GET /auth/setup failed: ${e.message}`);
        fail(res, 500, "server_error", e.message);
    }
});

/**
 * Password login. Verifies the password and mints a full-access API token.
 *
 * The token is returned exactly once, in this response. The dashboard stores
 * it and uses it as its only credential from then on; no session cookie is
 * involved, which keeps the browser flow identical to an agent's.
 *
 * The dashboard's login form hides the username field, so `username` is
 * optional here: without one, the account is resolved only when the instance
 * has exactly one. Anything else (several accounts, or a legacy account that
 * still needs migrating) answers `username_required`, and the form reveals
 * the field. This keeps a password from ever being tried against multiple
 * accounts.
 *
 * 2FA: when the account has TOTP enabled the first call returns 401 with
 * `twoFactorRequired`, and the caller retries with the code. The code is
 * verified against the same secret and parameters the better-auth plugin
 * uses, so enrolling in the old UI and verifying here agree.
 * @param {express.Request} req Express request
 * @param {express.Response} res Express response
 * @returns {Promise<void>}
 */
router.post("/api/v1/auth/login", async (req, res) => {
    try {
        const remaining = await loginRateLimiter.removeTokens(1);
        if (remaining < 0) {
            fail(res, 429, "rate_limited", "Too frequently, try again later.");
            return;
        }

        const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
        const password = typeof req.body?.password === "string" ? req.body.password : "";
        const totp = typeof req.body?.totp === "string" ? req.body.totp.trim() : "";

        if (!password) {
            fail(res, 400, "bad_request", "`password` is required.");
            return;
        }

        let account = username;
        if (!account) {
            if (!(await hasUser())) {
                // A legacy `user`-table account migrates on first sign-in and
                // needs the username to match on, so password-only cannot be
                // used until it has signed in once.
                const legacy = await R.getRow("SELECT COUNT(*) AS count FROM `user`");
                if (Number(legacy.count) > 0) {
                    fail(res, 400, "username_required", "This instance still signs in with a username.");
                    return;
                }
                fail(res, 401, "unauthorized", "Invalid username or password.");
                return;
            }

            // Password-only sign-in only makes sense against a single account;
            // with several, the dashboard must ask for a username rather than
            // try the password against each one.
            const { count } = await R.getRow("SELECT COUNT(*) AS count FROM better_auth_user");
            if (Number(count) !== 1) {
                fail(res, 400, "username_required", "This instance has multiple accounts; sign in with a username.");
                return;
            }

            const sole = await R.findOne("better_auth_user", " 1 = 1 ");
            if (!sole?.username) {
                fail(res, 401, "unauthorized", "Invalid username or password.");
                return;
            }
            account = sole.username;
        }

        // Legacy `user`-table accounts migrate on first sign-in, mirroring the
        // better-auth before-hook. Only attempted when better-auth is empty.
        if (!(await hasUser())) {
            await migrateUser(account, password);
        }

        if (!(await checkPassword(account, password))) {
            // Same response as a missing account: no username oracle.
            fail(res, 401, "unauthorized", "Invalid username or password.");
            return;
        }

        const user = await R.findOne("better_auth_user", " username = ? ", [ account ]);
        if (!user) {
            fail(res, 401, "unauthorized", "Invalid username or password.");
            return;
        }

        if (user.banned) {
            fail(res, 403, "forbidden", "This account has been banned.");
            return;
        }

        const twoFactor = await R.findOne("better_auth_twoFactor", " userId = ? ", [ user.id ]);
        if (twoFactor && twoFactor.verified) {
            if (!totp) {
                res.status(401).json({
                    ok: false,
                    error: "two_factor_required",
                    message: "This account has two-factor authentication enabled. Retry with a `totp` code.",
                });
                return;
            }

            let secret;
            try {
                const { symmetricDecrypt } = require("better-auth/crypto");
                secret = await symmetricDecrypt({ key: getAuthSecret(), data: twoFactor.secret });
            } catch (e) {
                log.error("auth", `TOTP secret decrypt failed for ${account}: ${e.message}`);
                fail(res, 500, "server_error", "Could not verify the second factor.");
                return;
            }

            // Same parameters the plugin was configured with (defaults: 6
            // digits, 30s period), so codes enrolled anywhere verify here.
            const { createOTP } = require("@better-auth/utils/otp");
            const valid = await createOTP(secret, { digits: 6, period: 30 }).verify(totp);
            if (!valid) {
                fail(res, 401, "unauthorized", "Invalid two-factor code.");
                return;
            }
        }

        // Login tokens expire after 30 days: every sign-in mints a new one,
        // so permanent tokens would accumulate without bound. Agents that
        // need a long-lived credential mint a dedicated key with no expiry
        // through POST /api/v1/api-keys instead.
        const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000)
            .toISOString()
            .slice(0, 19)
            .replace("T", " ");

        const clearKey = nanoid(40);
        const bean = await APIKey.save({
            key: await passwordHash.generate(clearKey),
            name: `dashboard login ${new Date().toISOString().slice(0, 10)}`,
            active: true,
            expires,
            scopes: "read,write,publish",
        }, user.id);

        await Settings.set("apiKeysEnabled", true);

        log.info("auth", `Password login for ${account}, minted API key ${bean.id}`);

        res.json({
            ok: true,
            token: `uk${bean.id}_${clearKey}`,
            user: {
                id: user.id,
                username: user.username ?? null,
                name: user.name,
            },
        });
    } catch (e) {
        log.error("auth", `POST /auth/login failed: ${e.message}`);
        fail(res, 500, "server_error", e.message);
    }
});

/**
 * The token's own account. Lets the dashboard show who is signed in without
 * a second lookup.
 * @param {express.Request} req Express request
 * @param {express.Response} res Express response
 * @returns {Promise<void>}
 */
router.get("/api/v1/auth/me", tokenAuth("read"), async (req, res) => {
    try {
        const user = await R.findOne("better_auth_user", " id = ? ", [ req.apiUser ]);
        if (!user) {
            fail(res, 404, "not_found", "Account not found.");
            return;
        }

        res.json({
            ok: true,
            user: {
                id: user.id,
                username: user.username ?? null,
                name: user.name,
                banned: !!user.banned,
            },
            scopes: req.apiScopes,
        });
    } catch (e) {
        log.error("auth", `GET /auth/me failed: ${e.message}`);
        fail(res, 500, "server_error", e.message);
    }
});

/**
 * List every account. Flatline has no roles: any operator can list.
 * @param {express.Request} req Express request
 * @param {express.Response} res Express response
 * @returns {Promise<void>}
 */
router.get("/api/v1/users", tokenAuth("read"), async (req, res) => {
    try {
        const rows = await R.getAll(
            "SELECT id, name, email, username, createdAt, banned FROM better_auth_user ORDER BY createdAt"
        );

        res.json({
            ok: true,
            count: rows.length,
            users: rows.map((u) => ({
                id: u.id,
                name: u.name,
                email: u.email,
                username: u.username ?? null,
                createdAt: u.createdAt,
                banned: !!u.banned,
                isCurrent: u.id === req.apiUser,
            })),
        });
    } catch (e) {
        log.error("auth", `GET /users failed: ${e.message}`);
        fail(res, 500, "server_error", e.message);
    }
});

/**
 * Delete an account. Shared data is untouched; only the account and its
 * sessions, 2FA rows and invites go.
 *
 * Refuses the caller and the last remaining account, so the instance can
 * never be locked out through this endpoint.
 * @param {express.Request} req Express request
 * @param {express.Response} res Express response
 * @returns {Promise<void>}
 */
router.delete("/api/v1/users/:id", tokenAuth("write"), async (req, res) => {
    try {
        const userID = String(req.params.id ?? "");

        if (!userID) {
            fail(res, 400, "bad_request", "Invalid user id.");
            return;
        }

        if (userID === req.apiUser) {
            fail(res, 400, "bad_request", "You cannot remove your own account.");
            return;
        }

        const target = await R.findOne("better_auth_user", " id = ? ", [ userID ]);
        if (!target) {
            fail(res, 404, "not_found", "No such user.");
            return;
        }

        const { count } = await R.getRow("SELECT COUNT(*) AS count FROM better_auth_user");
        if (Number(count) <= 1) {
            fail(res, 400, "bad_request", "Cannot remove the only remaining account.");
            return;
        }

        // Done directly rather than through auth().api.removeUser(), which
        // re-checks a better-auth session a bearer token does not have.
        await R.exec("DELETE FROM better_auth_session WHERE userId = ?", [ userID ]);
        await R.exec("DELETE FROM better_auth_account WHERE userId = ?", [ userID ]);
        await R.exec("DELETE FROM better_auth_twoFactor WHERE userId = ?", [ userID ]);
        await R.exec("DELETE FROM better_auth_verification WHERE identifier = ?", [ target.email ]);
        await R.exec("DELETE FROM better_auth_apikey WHERE referenceId = ?", [ userID ]);
        await R.exec("DELETE FROM user_invite WHERE created_by = ?", [ userID ]);
        await R.exec("DELETE FROM better_auth_user WHERE id = ?", [ userID ]);

        log.info("auth", `Deleted user ${userID} via REST by ${req.apiUser}`);

        res.json({ ok: true, deleted: userID });
    } catch (e) {
        log.error("auth", `DELETE /users/:id failed: ${e.message}`);
        fail(res, 500, "server_error", e.message);
    }
});

/**
 * Ban or unban an account. A ban drops live sessions immediately.
 * @param {express.Request} req Express request
 * @param {express.Response} res Express response
 * @returns {Promise<void>}
 */
router.patch("/api/v1/users/:id", tokenAuth("write"), async (req, res) => {
    try {
        const userID = String(req.params.id ?? "");

        if (!userID) {
            fail(res, 400, "bad_request", "Invalid user id.");
            return;
        }

        if (userID === req.apiUser) {
            fail(res, 400, "bad_request", "You cannot ban your own account.");
            return;
        }

        if (typeof req.body?.banned !== "boolean") {
            fail(res, 400, "bad_request", "`banned` must be a boolean.");
            return;
        }

        const target = await R.findOne("better_auth_user", " id = ? ", [ userID ]);
        if (!target) {
            fail(res, 404, "not_found", "No such user.");
            return;
        }

        if (req.body.banned) {
            await R.exec("UPDATE better_auth_user SET banned = 1, banReason = ? WHERE id = ?", [
                "Banned from the Flatline users panel",
                userID,
            ]);
            await R.exec("DELETE FROM better_auth_session WHERE userId = ?", [ userID ]);
        } else {
            await R.exec("UPDATE better_auth_user SET banned = 0, banReason = NULL, banExpires = NULL WHERE id = ?", [ userID ]);
        }

        log.info("auth", `${req.body.banned ? "Banned" : "Unbanned"} user ${userID} via REST by ${req.apiUser}`);

        res.json({ ok: true, id: userID, banned: req.body.banned });
    } catch (e) {
        log.error("auth", `PATCH /users/:id failed: ${e.message}`);
        fail(res, 500, "server_error", e.message);
    }
});

/**
 * List the caller's own invite links.
 * @param {express.Request} req Express request
 * @param {express.Response} res Express response
 * @returns {Promise<void>}
 */
router.get("/api/v1/invites", tokenAuth("read"), async (req, res) => {
    try {
        const list = await UserInvite.listForUser(req.apiUser);
        const invites = list.map((invite) => invite.toJSON());

        res.json({ ok: true, count: invites.length, invites });
    } catch (e) {
        log.error("auth", `GET /invites failed: ${e.message}`);
        fail(res, 500, "server_error", e.message);
    }
});

/**
 * Mint a single-use invite link. The plaintext token is returned exactly
 * once, in this response.
 * @param {express.Request} req Express request
 * @param {express.Response} res Express response
 * @returns {Promise<void>}
 */
router.post("/api/v1/invites", tokenAuth("write"), async (req, res) => {
    try {
        const note = typeof req.body?.note === "string" ? req.body.note.slice(0, 255) : null;

        let expiryHours = UserInvite.DEFAULT_EXPIRY_HOURS;
        if (req.body?.expiryHours !== undefined) {
            const requested = Number(req.body.expiryHours);
            if (!Number.isInteger(requested) || requested < 1 || requested > 720) {
                fail(res, 400, "bad_request", "`expiryHours` must be an integer between 1 and 720.");
                return;
            }
            expiryHours = requested;
        }

        const { invite, token } = await UserInvite.create(req.apiUser, { note, expiryHours });

        log.info("auth", `Created user invite ${invite.id} via REST by ${req.apiUser}`);

        res.json({
            ok: true,
            inviteID: invite.id,
            token,
            expires: invite.expires,
        });
    } catch (e) {
        log.error("auth", `POST /invites failed: ${e.message}`);
        fail(res, 500, "server_error", e.message);
    }
});

/**
 * Revoke an unused invite minted by the caller.
 * @param {express.Request} req Express request
 * @param {express.Response} res Express response
 * @returns {Promise<void>}
 */
router.delete("/api/v1/invites/:id", tokenAuth("write"), async (req, res) => {
    try {
        if (!/^[0-9]+$/.test(String(req.params.id))) {
            fail(res, 400, "bad_request", "Invite id must be a positive integer.");
            return;
        }

        const revoked = await UserInvite.revoke(Number(req.params.id), req.apiUser);
        if (!revoked) {
            fail(res, 404, "not_found", "Invite not found, already used, or not yours.");
            return;
        }

        log.info("auth", `Revoked user invite ${req.params.id} via REST by ${req.apiUser}`);

        res.json({ ok: true, revoked: Number(req.params.id) });
    } catch (e) {
        log.error("auth", `DELETE /invites/:id failed: ${e.message}`);
        fail(res, 500, "server_error", e.message);
    }
});

/**
 * Check an invite's status without redeeming it, so the signup form can show
 * "expired" before the user types a password. Unauthenticated: the recipient
 * is not logged in yet.
 * @param {express.Request} req Express request
 * @param {express.Response} res Express response
 * @returns {Promise<void>}
 */
router.get("/api/v1/auth/invites/:token", async (req, res) => {
    try {
        const invite = await UserInvite.findByToken(String(req.params.token ?? ""));

        if (!invite) {
            fail(res, 404, "not_found", "This invite link is not valid.");
            return;
        }

        const status = invite.getStatus();
        if (status === "used") {
            fail(res, 410, "gone", "This invite link has already been used.");
            return;
        }
        if (status === "expired") {
            fail(res, 410, "gone", "This invite link has expired. Ask for a new one.");
            return;
        }

        res.json({ ok: true, status, expires: invite.expires, note: invite.note ?? null });
    } catch (e) {
        log.error("auth", `GET /auth/invites/:token failed: ${e.message}`);
        fail(res, 500, "server_error", e.message);
    }
});

/**
 * Redeem an invite: create the account it was minted for. Unauthenticated —
 * the token itself is the credential, so the endpoint is rate limited.
 *
 * Validation runs before consuming, so a taken username or weak password does
 * not burn a single-use link.
 * @param {express.Request} req Express request
 * @param {express.Response} res Express response
 * @returns {Promise<void>}
 */
router.post("/api/v1/auth/invites/:token/redeem", async (req, res) => {
    try {
        const remaining = await inviteRateLimiter.removeTokens(1);
        if (remaining < 0) {
            fail(res, 429, "rate_limited", "Too frequently, try again later.");
            return;
        }

        const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
        const password = typeof req.body?.password === "string" ? req.body.password : "";

        if (!username) {
            fail(res, 400, "bad_request", "`username` is required.");
            return;
        }
        if (password.length < 8) {
            fail(res, 400, "bad_request", "Password must be at least 8 characters.");
            return;
        }

        const existing = await R.findOne("better_auth_user", " username = ? ", [ username ]);
        if (existing) {
            fail(res, 409, "conflict", "That username is already taken.");
            return;
        }

        const invite = await UserInvite.findByToken(String(req.params.token ?? ""));
        if (!invite) {
            fail(res, 404, "not_found", "This invite link is not valid.");
            return;
        }
        if (invite.getStatus() === "used") {
            fail(res, 410, "gone", "This invite link has already been used.");
            return;
        }
        if (invite.getStatus() === "expired") {
            fail(res, 410, "gone", "This invite link has expired. Ask for a new one.");
            return;
        }

        // Same account-creation path as first-run setup, so username, email
        // and 2FA handling stay identical.
        const { auth } = require("../better-auth");
        const user = await auth().api.createUser({
            body: {
                name: username,
                email: `${username}@noreply.uptime-kuma.internal`,
                password,
                role: "admin",
                data: { username },
            },
        });

        // Consume last: if two redemptions race, the loser deletes the account
        // it just made rather than leaving an orphan behind.
        const consumed = await UserInvite.consume(invite.id, user.user.id);
        if (!consumed) {
            await R.exec("DELETE FROM better_auth_user WHERE id = ?", [ user.user.id ]);
            fail(res, 410, "gone", "This invite link has already been used.");
            return;
        }

        log.info("auth", `Redeemed user invite ${invite.id} as ${username} via REST`);

        res.json({ ok: true, username });
    } catch (e) {
        log.error("auth", `POST /auth/invites/:token/redeem failed: ${e.message}`);
        fail(res, 500, "server_error", e.message);
    }
});

module.exports = router;
