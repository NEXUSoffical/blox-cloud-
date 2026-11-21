// apps/api/src/robloxGenerator.js
// Autonomous Roblox Game Generator (.rbxlx Place File Compiler)
// Generates fully playable 3D worlds, procedural maps, Luau scripts, UI, and pre-wired BloxCloud dashboard connection.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let cachedBloxCloudSdk = null;
function getBloxCloudLuauSdk() {
    if (cachedBloxCloudSdk) return cachedBloxCloudSdk;
    try {
        const sdkPath = path.join(__dirname, '../../../sdk/BloxCloud.luau');
        cachedBloxCloudSdk = fs.readFileSync(sdkPath, 'utf8');
    } catch (e) {
        console.warn('[BloxCloud Generator] Could not read sdk/BloxCloud.luau:', e.message);
        cachedBloxCloudSdk = '-- BloxCloud SDK fallback\nreturn { Init = function() end }\n';
    }
    return cachedBloxCloudSdk;
}

function escapeCdata(code) {
    return String(code || '').replace(/\]\]>/g, ']]]]><![CDATA[>');
}

let referentCounter = 1000;
function getRef(prefix = 'RBX') {
    referentCounter++;
    return `${prefix}_${referentCounter}`;
}

function escapeXml(unsafe) {
    if (typeof unsafe !== 'string') unsafe = String(unsafe || '');
    return unsafe.replace(/[<>&'"]/g, c => {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '\'': return '&apos;';
            case '"': return '&quot;';
        }
    });
}

function colorToUint8(r, g, b) {
    return ((r & 0xFF) << 16) | ((g & 0xFF) << 8) | (b & 0xFF);
}

// Themes defining colors and lighting atmospheres
const THEMES = {
    cyberpunk: {
        name: 'Cyberpunk Neon',
        ambient: { r: 15, g: 25, b: 50 },
        outdoorAmbient: { r: 20, g: 40, b: 80 },
        skyColor: { r: 5, g: 10, b: 25 },
        platformColor: colorToUint8(14, 165, 233), // Cyan neon
        platformMaterial: 288, // SmoothPlastic or Neon
        hazardColor: colorToUint8(244, 63, 94), // Neon Rose/Red
        checkpointColor: colorToUint8(16, 185, 129), // Emerald
        fogColor: { r: 10, g: 30, b: 60 },
        fogEnd: 400
    },
    lava: {
        name: 'Volcanic Inferno',
        ambient: { r: 40, g: 15, b: 10 },
        outdoorAmbient: { r: 80, g: 25, b: 15 },
        skyColor: { r: 30, g: 5, b: 5 },
        platformColor: colorToUint8(75, 85, 99), // Basalt Slate
        platformMaterial: 800, // Slate
        hazardColor: colorToUint8(249, 115, 22), // Molten Orange
        checkpointColor: colorToUint8(234, 179, 8), // Amber gold
        fogColor: { r: 50, g: 15, b: 10 },
        fogEnd: 300
    },
    skyworld: {
        name: 'Heavenly Skyworld',
        ambient: { r: 90, g: 110, b: 140 },
        outdoorAmbient: { r: 180, g: 210, b: 240 },
        skyColor: { r: 135, g: 206, b: 250 },
        platformColor: colorToUint8(240, 249, 255), // Cloud White
        platformMaterial: 288,
        hazardColor: colorToUint8(239, 68, 68),
        checkpointColor: colorToUint8(59, 130, 246), // Sky Blue
        fogColor: { r: 190, g: 220, b: 250 },
        fogEnd: 600
    }
};

/**
 * Builds standard Roblox BasePart XML
 */
function buildPartXml({ name, size, position, colorUint8, material = 288, anchored = true, canCollide = true, shape = 1 }) {
    const ref = getRef('PART');
    return `
		<Item class="Part" referent="${ref}">
			<Properties>
				<string name="Name">${escapeXml(name)}</string>
				<CoordinateFrame name="CFrame">
					<X>${position.x}</X><Y>${position.y}</Y><Z>${position.z}</Z>
					<R00>1</R00><R01>0</R01><R02>0</R02>
					<R10>0</R10><R11>1</R11><R12>0</R12>
					<R20>0</R20><R21>0</R21><R22>1</R22>
				</CoordinateFrame>
				<Vector3 name="size">
					<X>${size.x}</X><Y>${size.y}</Y><Z>${size.z}</Z>
				</Vector3>
				<bool name="Anchored">${anchored}</bool>
				<bool name="CanCollide">${canCollide}</bool>
				<Color3uint8 name="Color3uint8">${colorUint8}</Color3uint8>
				<token name="Material">${material}</token>
				<token name="shape">${shape}</token>
			</Properties>
		</Item>`;
}

/**
 * Generates an Obby / Platformer 3D Map & Mechanics
 */
function generateObbyData(theme, stagesCount = 30) {
    const parts = [];
    const t = THEMES[theme] || THEMES.cyberpunk;

    // Start Lobby
    parts.push(buildPartXml({
        name: 'LobbyPlatform',
        size: { x: 30, y: 2, z: 30 },
        position: { x: 0, y: 0, z: 0 },
        colorUint8: colorToUint8(30, 41, 59),
        material: 288
    }));

    // Spawn Location
    parts.push(`
		<Item class="SpawnLocation" referent="${getRef('SPAWN')}">
			<Properties>
				<string name="Name">SpawnLocation</string>
				<CoordinateFrame name="CFrame">
					<X>0</X><Y>2</Y><Z>0</Z>
					<R00>1</R00><R01>0</R01><R02>0</R02>
					<R10>0</R10><R11>1</R11><R12>0</R12>
					<R20>0</R20><R21>0</R21><R22>1</R22>
				</CoordinateFrame>
				<Vector3 name="size"><X>8</X><Y>1</Y><Z>8</Z></Vector3>
				<bool name="Anchored">true</bool>
				<bool name="Neutral">true</bool>
				<Color3uint8 name="Color3uint8">${colorToUint8(16, 185, 129)}</Color3uint8>
			</Properties>
		</Item>`);

    // Procedural Stages Generation
    let currentX = 0;
    let currentY = 2;
    let currentZ = 20;

    for (let stage = 1; stage <= stagesCount; stage++) {
        // Stage Checkpoint Pad
        parts.push(buildPartXml({
            name: `Checkpoint_${stage}`,
            size: { x: 10, y: 1, z: 10 },
            position: { x: currentX, y: currentY, z: currentZ },
            colorUint8: t.checkpointColor,
            material: 288
        }));

        currentZ += 12;

        // Sequence of 3-5 procedural jump blocks
        const jumps = 3 + (stage % 3);
        for (let j = 1; j <= jumps; j++) {
            const offsetX = (Math.sin(j + stage) * 8);
            const stepZ = currentZ + (j * 11);
            const stepY = currentY + (j % 2 === 0 ? 1 : 0);

            // Platform
            parts.push(buildPartXml({
                name: `Step_${stage}_${j}`,
                size: { x: 5, y: 1, z: 5 },
                position: { x: currentX + offsetX, y: stepY, z: stepZ },
                colorUint8: t.platformColor,
                material: 288
            }));

            // Optional Hazard (Laser / Lava Brick)
            if (j % 2 === 1) {
                parts.push(buildPartXml({
                    name: `KillHazard`,
                    size: { x: 7, y: 0.5, z: 1 },
                    position: { x: currentX + offsetX, y: stepY + 1.2, z: stepZ },
                    colorUint8: t.hazardColor,
                    material: 288,
                    canCollide: false
                }));
            }
        }

        currentZ += (jumps * 11) + 10;
        currentY += 2;
    }

    // Goal Trophy at the End
    parts.push(buildPartXml({
        name: `GoalVictoryPad`,
        size: { x: 24, y: 2, z: 24 },
        position: { x: currentX, y: currentY, z: currentZ },
        colorUint8: colorToUint8(234, 179, 8), // Gold
        material: 288
    }));

    return parts.join('\n');
}

/**
 * Generates Battle Arena 3D Map
 */
function generateArenaData(theme) {
    const parts = [];
    const t = THEMES[theme] || THEMES.cyberpunk;

    // Main Arena Circle Floor
    parts.push(buildPartXml({
        name: 'ArenaFloor',
        size: { x: 120, y: 3, z: 120 },
        position: { x: 0, y: 0, z: 0 },
        colorUint8: colorToUint8(15, 23, 42),
        material: 288
    }));

    // Neon Perimeter Boundary Walls
    const wallHeight = 16;
    parts.push(buildPartXml({ name: 'WallNorth', size: { x: 120, y: wallHeight, z: 3 }, position: { x: 0, y: wallHeight/2, z: 60 }, colorUint8: t.platformColor }));
    parts.push(buildPartXml({ name: 'WallSouth', size: { x: 120, y: wallHeight, z: 3 }, position: { x: 0, y: wallHeight/2, z: -60 }, colorUint8: t.platformColor }));
    parts.push(buildPartXml({ name: 'WallEast', size: { x: 3, y: wallHeight, z: 120 }, position: { x: 60, y: wallHeight/2, z: 0 }, colorUint8: t.platformColor }));
    parts.push(buildPartXml({ name: 'WallWest', size: { x: 3, y: wallHeight, z: 120 }, position: { x: -60, y: wallHeight/2, z: 0 }, colorUint8: t.platformColor }));

    // Center Power Pedestal
    parts.push(buildPartXml({
        name: 'CenterShrine',
        size: { x: 18, y: 4, z: 18 },
        position: { x: 0, y: 2, z: 0 },
        colorUint8: colorToUint8(234, 179, 8),
        material: 288
    }));

    // 4 Corner Cover Towers
    const corners = [{ x: 35, z: 35 }, { x: -35, z: 35 }, { x: 35, z: -35 }, { x: -35, z: -35 }];
    corners.forEach((c, idx) => {
        parts.push(buildPartXml({
            name: `TowerCover_${idx+1}`,
            size: { x: 10, y: 20, z: 10 },
            position: { x: c.x, y: 10, z: c.z },
            colorUint8: t.platformColor,
            material: 288
        }));
    });

    // Spawn Area
    parts.push(`
		<Item class="SpawnLocation" referent="${getRef('SPAWN')}">
			<Properties>
				<string name="Name">SpawnLocation</string>
				<CoordinateFrame name="CFrame">
					<X>0</X><Y>5</Y><Z>-45</Z>
					<R00>1</R00><R01>0</R01><R02>0</R02>
					<R10>0</R10><R11>1</R11><R12>0</R12>
					<R20>0</R20><R21>0</R21><R22>1</R22>
				</CoordinateFrame>
				<Vector3 name="size"><X>14</X><Y>1</Y><Z>14</Z></Vector3>
				<bool name="Anchored">true</bool>
				<bool name="Neutral">true</bool>
				<Color3uint8 name="Color3uint8">${colorToUint8(16, 185, 129)}</Color3uint8>
			</Properties>
		</Item>`);

    return parts.join('\n');
}

/**
 * Generates Simulator / Clicker 3D Map
 */
function generateSimulatorData(theme) {
    const parts = [];
    const t = THEMES[theme] || THEMES.cyberpunk;

    // Grass/Plaza Ground
    parts.push(buildPartXml({
        name: 'SimulatorBase',
        size: { x: 100, y: 2, z: 100 },
        position: { x: 0, y: 0, z: 0 },
        colorUint8: colorToUint8(30, 41, 59),
        material: 288
    }));

    // Rebirth Gate
    parts.push(buildPartXml({
        name: 'RebirthGateArchLeft',
        size: { x: 3, y: 16, z: 3 },
        position: { x: -10, y: 8, z: 40 },
        colorUint8: colorToUint8(168, 85, 247)
    }));
    parts.push(buildPartXml({
        name: 'RebirthGateArchRight',
        size: { x: 3, y: 16, z: 3 },
        position: { x: 10, y: 8, z: 40 },
        colorUint8: colorToUint8(168, 85, 247)
    }));
    parts.push(buildPartXml({
        name: 'RebirthGateTop',
        size: { x: 23, y: 3, z: 3 },
        position: { x: 0, y: 16, z: 40 },
        colorUint8: colorToUint8(168, 85, 247)
    }));

    // Coin Nodes in Field
    for (let i = 0; i < 12; i++) {
        const angle = (i / 12) * Math.PI * 2;
        const rad = 25;
        parts.push(buildPartXml({
            name: `CoinNode_${i+1}`,
            size: { x: 4, y: 4, z: 4 },
            position: { x: Math.cos(angle) * rad, y: 3, z: Math.sin(angle) * rad },
            colorUint8: colorToUint8(234, 179, 8),
            shape: 2 // Cylinder / Sphere
        }));
    }

    // Spawn
    parts.push(`
		<Item class="SpawnLocation" referent="${getRef('SPAWN')}">
			<Properties>
				<string name="Name">SpawnLocation</string>
				<CoordinateFrame name="CFrame">
					<X>0</X><Y>2</Y><Z>-30</Z>
					<R00>1</R00><R01>0</R01><R02>0</R02>
					<R10>0</R10><R11>1</R11><R12>0</R12>
					<R20>0</R20><R21>0</R21><R22>1</R22>
				</CoordinateFrame>
				<Vector3 name="size"><X>10</X><Y>1</Y><Z>10</Z></Vector3>
				<bool name="Anchored">true</bool>
				<bool name="Neutral">true</bool>
				<Color3uint8 name="Color3uint8">${colorToUint8(16, 185, 129)}</Color3uint8>
			</Properties>
		</Item>`);

    return parts.join('\n');
}

/**
 * Builds Luau Game Script with full auto-connected BloxCloud Dashboard SDK
 */
function buildGameManagerScript(title, genre, apiKey, baseUrl, gameSlug, monetization) {
    const safeLuaTitle = String(title || 'BloxCloud Game').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const safeLuaKey = String(apiKey || 'bc_live_demo_key').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const safeLuaUrl = String(baseUrl || 'https://bloxcloud.world').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const safeLuaSlug = String(gameSlug || 'ai_game').replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    return `--[[
    BloxCloud AI Generated Game Engine (Auto-Connected to Live Dashboard)
    Game: ${safeLuaTitle}
    Genre: ${genre}
    Dashboard: ${safeLuaUrl}
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local MarketplaceService = game:GetService("MarketplaceService")

-- 1. AUTO-CONNECT TO BLOXCLOUD DASHBOARD (Telemetry, Error Sentry, LiveOps, Broadcasts, Anti-Exploit)
local BloxCloud = require(script.Parent:WaitForChild("BloxCloud"))
local STUDIO_API_KEY = "${safeLuaKey}"
local BLOXCLOUD_URL = "${safeLuaUrl}"
local GAME_ID = "${safeLuaSlug}"

local broadcastEvent = ReplicatedStorage:WaitForChild("BloxCloudBroadcast")

if STUDIO_API_KEY ~= "" and STUDIO_API_KEY ~= "bc_live_demo_key" then
    BloxCloud.Init(STUDIO_API_KEY, {
        baseUrl = BLOXCLOUD_URL,
        gameId = GAME_ID,
        pollingInterval = 5,
    })
else
    warn("[BloxCloud] Running with demo API key. Sign in at " .. BLOXCLOUD_URL .. " before generating to auto-link your live dashboard!")
end

-- Dynamic LiveOps Config (Controlled live from your BloxCloud Dashboard!)
local liveCoinMultiplier = tonumber(BloxCloud.LiveOps:GetConfig("coin_multiplier", 1)) or 1
local liveBaseWalkSpeed = tonumber(BloxCloud.LiveOps:GetConfig("walk_speed", 16)) or 16

BloxCloud.LiveOps:OnConfigChange("coin_multiplier", function(newVal)
    liveCoinMultiplier = tonumber(newVal) or 1
    print("[BloxCloud LiveOps] Updated coin_multiplier -> " .. tostring(liveCoinMultiplier))
end)

BloxCloud.LiveOps:OnConfigChange("walk_speed", function(newVal)
    liveBaseWalkSpeed = tonumber(newVal) or 16
    for _, p in ipairs(Players:GetPlayers()) do
        local hum = p.Character and p.Character:FindFirstChild("Humanoid")
        if hum then
            hum.WalkSpeed = liveBaseWalkSpeed
        end
    end
end)

-- Global Broadcast Receiver (Pushes dashboard announcements straight to all players' screens)
BloxCloud.LiveOps:OnBroadcast(function(broadcast)
    if broadcast and broadcast.message then
        broadcastEvent:FireAllClients(broadcast.message, broadcast.severity or "INFO", broadcast.duration or 15)
    end
end)

-- Monetization Config
local GAMEPASS_DOUBLE_SPEED = ${monetization.doubleSpeedId || 0}
local GAMEPASS_VIP = ${monetization.vipId || 0}
local DEVPRODUCT_SKIP_LEVEL = ${monetization.skipLevelId || 0}

-- Initialize Player Stats
Players.PlayerAdded:Connect(function(player)
    local leaderstats = Instance.new("Folder")
    leaderstats.Name = "leaderstats"
    leaderstats.Parent = player

    local stage = Instance.new("IntValue")
    stage.Name = "Stage"
    stage.Value = 1
    stage.Parent = leaderstats

    local coins = Instance.new("IntValue")
    coins.Name = "Coins"
    coins.Value = 0
    coins.Parent = leaderstats

    player.CharacterAdded:Connect(function(character)
        local humanoid = character:WaitForChild("Humanoid", 10)
        local root = character:WaitForChild("HumanoidRootPart", 10)
        if not humanoid then return end

        humanoid.WalkSpeed = liveBaseWalkSpeed

        -- Check Gamepass for Double Speed
        if GAMEPASS_DOUBLE_SPEED > 0 then
            pcall(function()
                if MarketplaceService:UserOwnsGamePassAsync(player.UserId, GAMEPASS_DOUBLE_SPEED) then
                    humanoid.WalkSpeed = liveBaseWalkSpeed * 2
                end
            end)
        end

        -- Respawn at Checkpoint
        local currentStage = stage.Value
        local cp = workspace:FindFirstChild("Checkpoint_" .. currentStage)
        if cp and root then
            root.CFrame = cp.CFrame + Vector3.new(0, 3, 0)
        end
    end)
end)

-- Lightweight Anti-Exploit Monitor (Streams speedhack alerts to BloxCloud Dashboard & Discord)
task.spawn(function()
    local flaggedCooldown = {}
    while true do
        task.wait(5)
        for _, player in ipairs(Players:GetPlayers()) do
            local char = player.Character
            local root = char and char:FindFirstChild("HumanoidRootPart")
            if root then
                local horizSpeed = Vector3.new(root.AssemblyLinearVelocity.X, 0, root.AssemblyLinearVelocity.Z).Magnitude
                local maxAllowed = (liveBaseWalkSpeed * 2) + 35
                if horizSpeed > maxAllowed and (not flaggedCooldown[player.UserId] or os.clock() - flaggedCooldown[player.UserId] > 30) then
                    flaggedCooldown[player.UserId] = os.clock()
                    BloxCloud.Telemetry:ReportExploit(player, "SPEED_HACK", string.format("Velocity %.1f exceeded threshold %.1f", horizSpeed, maxAllowed))
                end
            end
        end
    end
end)

-- Kill Hazard, Coin Nodes & Checkpoint Collisions
for _, part in ipairs(workspace:GetDescendants()) do
    if part:IsA("BasePart") then
        if part.Name == "KillHazard" then
            part.Touched:Connect(function(hit)
                local char = hit.Parent
                local hum = char and char:FindFirstChild("Humanoid")
                if hum and hum.Health > 0 then
                    hum.Health = 0
                end
            end)
        elseif string.match(part.Name, "^Checkpoint_(%d+)$") then
            local stageNum = tonumber(string.match(part.Name, "^Checkpoint_(%d+)$"))
            part.Touched:Connect(function(hit)
                local char = hit.Parent
                local player = Players:GetPlayerFromCharacter(char)
                if player then
                    local lstats = player:FindFirstChild("leaderstats")
                    local pStage = lstats and lstats:FindFirstChild("Stage")
                    if pStage and pStage.Value < stageNum then
                        pStage.Value = stageNum
                        local pCoins = lstats:FindFirstChild("Coins")
                        if pCoins then
                            pCoins.Value = pCoins.Value + math.floor(10 * liveCoinMultiplier)
                        end
                    end
                end
            end)
        elseif string.match(part.Name, "^CoinNode_(%d+)$") then
            local debounce = false
            part.Touched:Connect(function(hit)
                if debounce then return end
                local char = hit.Parent
                local player = Players:GetPlayerFromCharacter(char)
                if player then
                    debounce = true
                    local lstats = player:FindFirstChild("leaderstats")
                    local pCoins = lstats and lstats:FindFirstChild("Coins")
                    if pCoins then
                        pCoins.Value = pCoins.Value + math.floor(5 * liveCoinMultiplier)
                    end
                    part.Transparency = 0.8
                    task.wait(3)
                    part.Transparency = 0
                    debounce = false
                end
            end)
        end
    end
end

print("[BloxCloud AI Engine] Live dashboard connected for: " .. "${safeLuaTitle}")
`;
}

/**
 * Builds StarterGui ScreenGui with HUD and Live Dashboard Broadcast Banner
 */
function buildStarterGuiXml(title, genre) {
    const guiRef = getRef('GUI');
    const frameRef = getRef('FRAME');
    const bannerRef = getRef('BANNER');
    const clientScript = `
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local broadcastEvent = ReplicatedStorage:WaitForChild("BloxCloudBroadcast")
local banner = script.Parent:WaitForChild("BroadcastBanner")
local label = banner:WaitForChild("BroadcastLabel")

broadcastEvent.OnClientEvent:Connect(function(message, severity, duration)
    label.Text = "[ANNOUNCEMENT] " .. tostring(message)
    banner.Visible = true
    task.delay(tonumber(duration) or 12, function()
        banner.Visible = false
    end)
end)
`;

    return `
	<Item class="StarterGui" referent="RBXSTARTERGUI">
		<Properties>
			<string name="Name">StarterGui</string>
			<bool name="ResetPlayerGuiOnSpawn">false</bool>
		</Properties>
		<Item class="ScreenGui" referent="${guiRef}">
			<Properties>
				<string name="Name">BloxCloudHUD</string>
				<bool name="IgnoreGuiInset">false</bool>
				<bool name="ResetOnSpawn">false</bool>
			</Properties>
			<Item class="Frame" referent="${frameRef}">
				<Properties>
					<string name="Name">TopBar</string>
					<UDim2 name="Position"><XS>0.5</XS><XO>-150</XO><YS>0.02</YS><YO>0</YO></UDim2>
					<UDim2 name="Size"><XS>0</XS><XO>300</XO><YS>0</YS><YO>45</YO></UDim2>
					<Color3uint8 name="BackgroundColor3">${colorToUint8(15, 23, 42)}</Color3uint8>
					<float name="BackgroundTransparency">0.2</float>
					<token name="BorderSizePixel">0</token>
				</Properties>
				<Item class="TextLabel" referent="${getRef('TITLE')}">
					<Properties>
						<string name="Name">TitleLabel</string>
						<UDim2 name="Size"><XS>1</XS><XO>0</XO><YS>1</YS><YO>0</YO></UDim2>
						<string name="Text">${escapeXml(title)}</string>
						<Color3uint8 name="TextColor3">${colorToUint8(56, 189, 248)}</Color3uint8>
						<float name="TextSize">18</float>
						<token name="Font">16</token>
						<float name="BackgroundTransparency">1</float>
					</Properties>
				</Item>
			</Item>
			<Item class="Frame" referent="${bannerRef}">
				<Properties>
					<string name="Name">BroadcastBanner</string>
					<bool name="Visible">false</bool>
					<UDim2 name="Position"><XS>0.5</XS><XO>-240</XO><YS>0.12</YS><YO>0</YO></UDim2>
					<UDim2 name="Size"><XS>0</XS><XO>480</XO><YS>0</YS><YO>42</YO></UDim2>
					<Color3uint8 name="BackgroundColor3">${colorToUint8(185, 28, 28)}</Color3uint8>
					<float name="BackgroundTransparency">0.1</float>
					<token name="BorderSizePixel">0</token>
				</Properties>
				<Item class="TextLabel" referent="${getRef('BCAST_LBL')}">
					<Properties>
						<string name="Name">BroadcastLabel</string>
						<UDim2 name="Size"><XS>1</XS><XO>-16</XO><YS>1</YS><YO>0</YO></UDim2>
						<UDim2 name="Position"><XS>0</XS><XO>8</XO><YS>0</YS><YO>0</YO></UDim2>
						<string name="Text">Live Broadcast</string>
						<Color3uint8 name="TextColor3">${colorToUint8(255, 255, 255)}</Color3uint8>
						<float name="TextSize">15</float>
						<token name="Font">16</token>
						<float name="BackgroundTransparency">1</float>
					</Properties>
				</Item>
			</Item>
			<Item class="LocalScript" referent="${getRef('BCAST_CLIENT')}">
				<Properties>
					<string name="Name">BloxCloudBroadcastClient</string>
					<ProtectedString name="Source"><![CDATA[${escapeCdata(clientScript)}]]></ProtectedString>
				</Properties>
			</Item>
		</Item>
	</Item>`;
}

/**
 * Primary Generator Function
 * Compiles a complete valid .rbxlx XML document ready for Roblox Studio
 */
function compileRobloxPlace({
    title = 'Cyberpunk Tower Obby',
    genre = 'obby',
    theme = 'cyberpunk',
    difficulty = 'medium',
    stagesCount = 25,
    apiKey = 'bc_live_demo',
    baseUrl = 'https://bloxcloud.world',
    monetization = {}
}) {
    const safeTitle = (title || 'AI Generated Roblox Game').trim();
    const gameSlug = safeTitle.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'ai_game';
    const t = THEMES[theme] || THEMES.cyberpunk;

    // Generate 3D Map parts based on genre
    let mapPartsXml = '';
    if (genre === 'arena') {
        mapPartsXml = generateArenaData(theme);
    } else if (genre === 'simulator') {
        mapPartsXml = generateSimulatorData(theme);
    } else {
        mapPartsXml = generateObbyData(theme, stagesCount);
    }

    // Build Luau Scripts & Embedded BloxCloud SDK
    const bloxCloudSdkSource = getBloxCloudLuauSdk();
    const serverScript = buildGameManagerScript(safeTitle, genre, apiKey, baseUrl, gameSlug, monetization);
    const starterGuiXml = buildStarterGuiXml(safeTitle, genre);

    // Complete .rbxlx XML Place File
    const rbxlxXml = `<?xml version="1.0" encoding="utf-8"?>
<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">
	<External>null</External>
	<External>nil</External>
	<Item class="Workspace" referent="RBXWORKSPACE">
		<Properties>
			<string name="Name">Workspace</string>
			<bool name="FilteringEnabled">true</bool>
		</Properties>
		<Item class="Camera" referent="RBXCAMERA">
			<Properties>
				<string name="Name">Camera</string>
				<CoordinateFrame name="CFrame">
					<X>0</X><Y>25</Y><Z>45</Z>
					<R00>1</R00><R01>0</R01><R02>0</R02>
					<R10>0</R10><R11>0.92</R11><R12>-0.39</R12>
					<R20>0</R20><R21>0.39</R21><R22>0.92</R22>
				</CoordinateFrame>
			</Properties>
		</Item>
		<Item class="Terrain" referent="RBXTERRAIN">
			<Properties>
				<string name="Name">Terrain</string>
			</Properties>
		</Item>
		${mapPartsXml}
	</Item>
	<Item class="Lighting" referent="RBXLIGHTING">
		<Properties>
			<string name="Name">Lighting</string>
			<Color3 name="Ambient">
				<R>${t.ambient.r / 255}</R><G>${t.ambient.g / 255}</G><B>${t.ambient.b / 255}</B>
			</Color3>
			<Color3 name="OutdoorAmbient">
				<R>${t.outdoorAmbient.r / 255}</R><G>${t.outdoorAmbient.g / 255}</G><B>${t.outdoorAmbient.b / 255}</B>
			</Color3>
			<Color3 name="FogColor">
				<R>${t.fogColor.r / 255}</R><G>${t.fogColor.g / 255}</G><B>${t.fogColor.b / 255}</B>
			</Color3>
			<float name="FogEnd">${t.fogEnd}</float>
			<float name="Brightness">2</float>
			<string name="TimeOfDay">14:00:00</string>
		</Properties>
	</Item>
	<Item class="ReplicatedStorage" referent="RBXREPLICATEDSTORAGE">
		<Properties>
			<string name="Name">ReplicatedStorage</string>
		</Properties>
		<Item class="RemoteEvent" referent="${getRef('REMOTEEVENT')}">
			<Properties>
				<string name="Name">BloxCloudBroadcast</string>
			</Properties>
		</Item>
	</Item>
	<Item class="ServerScriptService" referent="RBXSERVERSCRIPTSERVICE">
		<Properties>
			<string name="Name">ServerScriptService</string>
		</Properties>
		<Item class="ModuleScript" referent="${getRef('SDK_MOD')}">
			<Properties>
				<string name="Name">BloxCloud</string>
				<ProtectedString name="Source"><![CDATA[${escapeCdata(bloxCloudSdkSource)}]]></ProtectedString>
			</Properties>
		</Item>
		<Item class="Script" referent="${getRef('SCRIPT')}">
			<Properties>
				<string name="Name">BloxCloudGameManager</string>
				<ProtectedString name="Source"><![CDATA[${escapeCdata(serverScript)}]]></ProtectedString>
			</Properties>
		</Item>
	</Item>
	<Item class="StarterPlayer" referent="RBXSTARTERPLAYER">
		<Properties>
			<string name="Name">StarterPlayer</string>
		</Properties>
	</Item>
	${starterGuiXml}
</roblox>`;

    return {
        title: safeTitle,
        gameSlug,
        genre,
        theme,
        dashboardConnected: Boolean(apiKey && apiKey !== 'bc_live_demo' && apiKey !== 'bc_live_demo_key'),
        xml: rbxlxXml,
        fileSize: Buffer.byteLength(rbxlxXml, 'utf8')
    };
}

module.exports = {
    compileRobloxPlace,
    THEMES
};
