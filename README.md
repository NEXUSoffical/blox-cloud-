# BloxCloud — The Ultimate Backend-as-a-Service for Roblox Games

**BloxCloud** is an enterprise-grade cloud platform and Luau SDK designed to solve the biggest architectural gaps in the Roblox developer ecosystem.

---

## ⚡ What BloxCloud Solves

| Problem on Roblox | What Roblox Fails To Provide | BloxCloud Solution |
| :--- | :--- | :--- |
| **Ranked Matchmaking** | Roblox only dumps players into random public servers. No skill/MMR matching. | **Global ELO/MMR Matchmaking Engine** (1v1, 2v2, 3v3) with party matching and auto-server teleportation. |
| **Emergency Incidents** | Disabling a broken/duped weapon requires updating and restarting all 20,000 player servers. | **LiveOps Remote Kill-Switches** that disable weapons or features in <100ms without server restarts. |
| **Cross-Server Trading** | Cross-server auction houses in Roblox suffer from severe race conditions and item duping. | **Global Auction House Engine** with atomic mutex locks preventing all item duplication. |
| **Global Communications** | Rate-limited `MessagingService` crashes under high volume. | **High-Speed WebSocket & REST Cloud** for global announcements and live telemetry. |

---

## 📂 Project Structure

```
blox-cloud/
├── apps/
│   ├── api/               # Fastify/Express + WebSocket engine & REST API
│   │   └── src/
│   │       ├── server.js       # Main server & WebSocket gateway
│   │       ├── matchmaker.js   # ELO queue algorithm with dynamic rating expansion
│   │       ├── liveops.js      # Feature flags, kill-switches, broadcasts
│   │       └── marketplace.js  # Atomic cross-server auction house ledger
│   └── dashboard/         # Real-time Web Portal for Roblox Studio owners
│       └── public/
│           └── index.html      # Responsive Dark-mode dashboard with live WebSocket sync
├── sdk/
│   └── BloxCloud.luau    # 1-file drop-in Luau module for Roblox Studio
└── tests/
    └── simulator.js       # Simulates 20 Roblox game servers & 100 players queueing
```

---

## 🚀 How to Run

### 1. Start the API & Dashboard Server
```bash
cd apps/api
node src/server.js
```
Open **`http://localhost:3001`** in Chrome to view the live dashboard!

### 2. Run the Roblox Server Simulation
In a separate terminal:
```bash
node tests/simulator.js
```
Watch 12 simulated Roblox players get paired by ELO, receive reserved server teleport codes, buy items from the auction house with anti-dupe protection, and receive emergency live broadcast alerts!

---

## 📦 Roblox Integration (1-Line Drop-in)

Drop `sdk/BloxCloud.luau` into `ReplicatedStorage`. In `ServerScriptService`:

```luau
local Nexus = require(game.ReplicatedStorage.BloxCloud).Init("YOUR_API_KEY", {
    baseUrl = "https://your-nexus-api.railway.app"
})

-- 1. Queue a player for Ranked 1v1
Nexus.Matchmaking:JoinQueue(player, "Ranked_1v1", { rating = 1200 })

-- 2. Teleport when match is found
Nexus.Matchmaking:OnMatchFound(function(player, match)
    print("Match found! Server Code: " .. match.reservedServerCode)
    TeleportService:TeleportToPrivateServer(PLACE_ID, match.reservedServerCode, { player })
end)

-- 3. Live Kill-Switch (Zero Server Restarts)
Nexus.LiveOps:OnConfigChange("disable_item_plasmagun", function(disabled)
    if disabled then
        print("Plasma Gun has been emergency disabled by Studio Admin!")
    end
end)
```

---

## 💰 Monetization & Business Model

* **Hobby / Indie ($0/mo)**: Up to 10,000 matches/month, basic feature flags.
* **Pro Tier ($29/mo)**: 250,000 matches/month, Global Auction House, LiveOps kill-switches.
* **Enterprise ($99 - $249/mo)**: Unlimited matches, custom ELO math, priority low-latency routing, dedicated SLA.
