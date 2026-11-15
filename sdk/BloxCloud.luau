--[[
    BloxCloud Luau SDK (v1.1.0)
    The Ultimate Backend-as-a-Service for Roblox Games
    
    Modules included:
    - BloxCloud.Matchmaking (Cross-Server ELO / MMR & Party Queue)
    - BloxCloud.LiveOps (Live Config, Instant Kill-switches & Global Broadcasts)
    - BloxCloud.Marketplace (Cross-Server Global Auction House with Atomic Anti-Dupe)
    - BloxCloud.Telemetry (Real-time Global Server Health, Error Sentry & Anti-Exploit Alerts)
--]]

local HttpService = game:GetService("HttpService")
local TeleportService = game:GetService("TeleportService")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local StatsService = game:GetService("Stats")
local ScriptContext = game:GetService("ScriptContext")

local BloxCloud = {}
BloxCloud.__index = BloxCloud

-- Global internal state
local _config = {
    apiKey = "",
    baseUrl = "http://localhost:3001",
    gameId = "game_default",
    pollingInterval = 3,
    telemetryInterval = 15,
}

local _liveConfig = {}
local _configListeners = {}
local _broadcastListeners = {}
local _matchListeners = {}
local _activePlayerQueues = {}
local _serverJobId = game.JobId ~= "" and game.JobId or ("DEV_INSTANCE_" .. tostring(math.random(10000, 99999)))

-- Helper: Safe HTTP Request
local function makeRequest(endpoint, method, payload)
    local url = _config.baseUrl .. endpoint
    local headers = {
        ["Content-Type"] = "application/json",
        ["x-api-key"] = _config.apiKey,
        ["x-game-id"] = _config.gameId,
    }

    local requestOptions = {
        Url = url,
        Method = method or "GET",
        Headers = headers,
    }

    if payload then
        requestOptions.Body = HttpService:JSONEncode(payload)
    end

    local success, response = pcall(function()
        return HttpService:RequestAsync(requestOptions)
    end)

    if not success then
        return nil, "Network error: " .. tostring(response)
    end

    if response.StatusCode >= 200 and response.StatusCode < 300 then
        local decodeSuccess, decoded = pcall(function()
            return HttpService:JSONDecode(response.Body)
        end)
        if decodeSuccess then
            return decoded, nil
        else
            return response.Body, nil
        end
    else
        return nil, "API Error: " .. response.Body
    end
end

--------------------------------------------------------------------------------
-- 1. INITIALIZATION & LIFECYCLE
--------------------------------------------------------------------------------
function BloxCloud.Init(apiKey, options)
    assert(RunService:IsServer(), "[BloxCloud] Init must only be called from a Server script!")
    assert(apiKey and type(apiKey) == "string", "[BloxCloud] An API key string is required!")

    _config.apiKey = apiKey
    if options then
        if options.baseUrl then _config.baseUrl = options.baseUrl end
        if options.gameId then _config.gameId = options.gameId end
        if options.pollingInterval then _config.pollingInterval = options.pollingInterval end
    end

    print("----------------------------------------------------------------")
    print(" ⚡ [BloxCloud] Connected to Cloud Server: " .. _config.baseUrl)
    print(" 🎮 Server Instance ID: " .. _serverJobId)
    print("----------------------------------------------------------------")

    -- Start background heartbeat and telemetry monitors
    BloxCloud._StartHeartbeat()
    BloxCloud.Telemetry._StartTelemetryLoop()
    BloxCloud.Telemetry._HookErrorSentry()

    return BloxCloud
end

--------------------------------------------------------------------------------
-- 2. TELEMETRY & SERVER HEALTH (Stats Roblox Does NOT Provide)
--------------------------------------------------------------------------------
BloxCloud.Telemetry = {}

function BloxCloud.Telemetry.SendHeartbeat()
    local memMb = 0
    pcall(function()
        memMb = math.floor(StatsService:GetTotalMemoryUsageMb() + 0.5)
    end)

    local fps = 60
    pcall(function()
        fps = math.floor(workspace:GetRealPhysicsFPS() + 0.5)
    end)

    local payload = {
        jobId = _serverJobId,
        placeId = tostring(game.PlaceId),
        playerCount = #Players:GetPlayers(),
        serverFps = fps,
        serverMemoryMb = memMb,
        uptimeSeconds = math.floor(workspace.DistributedGameTime),
    }

    makeRequest("/api/v1/telemetry/heartbeat", "POST", payload)
end

function BloxCloud.Telemetry:ReportExploit(player, anomalyType, details)
    assert(player and player:IsA("Player"), "Valid Player required")
    local payload = {
        jobId = _serverJobId,
        userId = tostring(player.UserId),
        username = player.Name,
        anomalyType = anomalyType or "PHYSICS_ANOMALY",
        details = details or "Suspicious movement speed exceeded limits.",
    }
    warn(string.format("[BloxCloud Security] Exploiter Alert Flagged: %s (%s) - %s", player.Name, anomalyType, details))
    makeRequest("/api/v1/telemetry/exploit-alert", "POST", payload)
end

function BloxCloud.Telemetry.ReportError(message, stack, scriptName)
    local payload = {
        jobId = _serverJobId,
        message = tostring(message),
        stack = tostring(stack),
        scriptName = tostring(scriptName),
        errorType = "RUNTIME_EXCEPTION",
    }
    makeRequest("/api/v1/telemetry/error", "POST", payload)
end

function BloxCloud.Telemetry._StartTelemetryLoop()
    task.spawn(function()
        -- Send immediate first heartbeat
        BloxCloud.Telemetry.SendHeartbeat()

        while true do
            task.wait(_config.telemetryInterval)
            pcall(function()
                BloxCloud.Telemetry.SendHeartbeat()
            end)
        end
    end)
end

function BloxCloud.Telemetry._HookErrorSentry()
    pcall(function()
        ScriptContext.Error:Connect(function(message, stack, scriptInstance)
            local scriptName = scriptInstance and scriptInstance:GetFullName() or "UnknownScript"
            task.spawn(function()
                BloxCloud.Telemetry.ReportError(message, stack, scriptName)
            end)
        end)
    end)
end

--------------------------------------------------------------------------------
-- 3. LIVEOPS & FEATURE FLAGS (Kill-switches, Events, Broadcasts)
--------------------------------------------------------------------------------
BloxCloud.LiveOps = {}

function BloxCloud.LiveOps:GetConfig(key, defaultValue)
    if _liveConfig[key] ~= nil then
        return _liveConfig[key]
    end
    return defaultValue
end

function BloxCloud.LiveOps:OnConfigChange(key, callback)
    if not _configListeners[key] then
        _configListeners[key] = {}
    end
    table.insert(_configListeners[key], callback)
end

function BloxCloud.LiveOps:OnBroadcast(callback)
    table.insert(_broadcastListeners, callback)
end

function BloxCloud.LiveOps:FetchLatest()
    local data, err = makeRequest("/api/v1/liveops/config", "GET")
    if data and data.config then
        for k, v in pairs(data.config) do
            local oldVal = _liveConfig[k]
            if oldVal ~= v then
                _liveConfig[k] = v
                if _configListeners[k] then
                    for _, listener in ipairs(_configListeners[k]) do
                        task.spawn(listener, v, oldVal)
                    end
                end
            end
        end
    end
    return _liveConfig
end

--------------------------------------------------------------------------------
-- 4. MATCHMAKING & ELO ENGINE (Cross-Server Queues & Teleportation)
--------------------------------------------------------------------------------
BloxCloud.Matchmaking = {}

function BloxCloud.Matchmaking:JoinQueue(player, queueType, playerStats)
    assert(player and player:IsA("Player"), "Valid Player instance required")
    queueType = queueType or "Ranked_1v1"
    playerStats = playerStats or {}

    local payload = {
        userId = tostring(player.UserId),
        username = player.Name,
        queueType = queueType,
        rating = playerStats.rating or 1000,
        partyMembers = playerStats.partyMembers or { tostring(player.UserId) },
        region = playerStats.region or "auto",
    }

    local result, err = makeRequest("/api/v1/matchmaking/queue", "POST", payload)
    if result and result.ticketId then
        _activePlayerQueues[player.UserId] = {
            ticketId = result.ticketId,
            queueType = queueType,
            status = "QUEUED",
        }
        return true, result
    else
        return false, err
    end
end

function BloxCloud.Matchmaking:LeaveQueue(player)
    assert(player and player:IsA("Player"), "Valid Player instance required")
    local queueData = _activePlayerQueues[player.UserId]
    if not queueData then return true end

    local payload = {
        userId = tostring(player.UserId),
        ticketId = queueData.ticketId,
    }

    _activePlayerQueues[player.UserId] = nil
    local result, err = makeRequest("/api/v1/matchmaking/leave", "POST", payload)
    return result ~= nil
end

function BloxCloud.Matchmaking:OnMatchFound(callback)
    table.insert(_matchListeners, callback)
end

--------------------------------------------------------------------------------
-- 5. GLOBAL AUCTION HOUSE (Cross-Server Economy & Anti-Dupe)
--------------------------------------------------------------------------------
BloxCloud.Marketplace = {}

function BloxCloud.Marketplace:ListGlobalItem(player, itemId, itemData, priceInCoins)
    assert(player and player:IsA("Player"), "Valid Player instance required")
    local payload = {
        sellerId = tostring(player.UserId),
        sellerName = player.Name,
        itemId = itemId,
        itemData = itemData,
        price = priceInCoins,
    }

    local result, err = makeRequest("/api/v1/marketplace/list", "POST", payload)
    if result and result.listingId then
        return true, result
    else
        return false, err
    end
end

function BloxCloud.Marketplace:BuyGlobalItem(buyerPlayer, listingId)
    assert(buyerPlayer and buyerPlayer:IsA("Player"), "Valid Player instance required")
    local payload = {
        buyerId = tostring(buyerPlayer.UserId),
        buyerName = buyerPlayer.Name,
        listingId = listingId,
    }

    local result, err = makeRequest("/api/v1/marketplace/buy", "POST", payload)
    if result and result.success then
        return true, result.item
    else
        return false, err
    end
end

function BloxCloud.Marketplace:GetActiveListings()
    local result, err = makeRequest("/api/v1/marketplace/listings", "GET")
    if result and result.listings then
        return result.listings
    end
    return {}
end

--------------------------------------------------------------------------------
-- 6. INTERNAL BACKGROUND HEARTBEAT & EVENT DISPATCH
--------------------------------------------------------------------------------
function BloxCloud._StartHeartbeat()
    task.spawn(function()
        while true do
            task.wait(_config.pollingInterval)

            -- 1. Poll LiveOps Updates
            pcall(function()
                BloxCloud.LiveOps:FetchLatest()
            end)

            -- 2. Check Match Status for queued players
            for userId, data in pairs(_activePlayerQueues) do
                if data.ticketId then
                    task.spawn(function()
                        local res, _ = makeRequest("/api/v1/matchmaking/ticket/" .. data.ticketId, "GET")
                        if res and res.status == "MATCHED" and res.match then
                            _activePlayerQueues[userId] = nil
                            local player = Players:GetPlayerByUserId(tonumber(userId))
                            if player then
                                for _, listener in ipairs(_matchListeners) do
                                    task.spawn(listener, player, res.match)
                                end
                            end
                        end
                    end)
                end
            end
        end
    end)
end

return BloxCloud
