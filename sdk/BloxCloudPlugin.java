package world.bloxcloud.plugin;

import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.entity.Player;
import org.bukkit.plugin.java.JavaPlugin;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.BiConsumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * BloxCloud Official Minecraft SDK & LiveOps Plugin (Paper / Spigot / Purpur / Velocity)
 *
 * Connects any Minecraft server or multi-server proxy network to https://bloxcloud.world:
 *  1. Real-time Server TPS, Memory (MB) & Player Telemetry
 *  2. Zero-Downtime Remote Kill-Switches & Global Network Broadcasts
 *  3. Cross-Server ELO Matchmaking with Velocity / BungeeCord Arena Transfers
 *  4. Cross-Server Global Auction House with Atomic Anti-Dupe Locks
 */
public class BloxCloudPlugin extends JavaPlugin {

    private static BloxCloudPlugin instance;
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .build();

    private String apiKey = "";
    private String baseUrl = "https://bloxcloud.world";
    private String serverId = "MC_NODE_1";
    private String region = "EU-West";

    private final Map<String, Boolean> liveFlags = new ConcurrentHashMap<>();
    private final Map<String, BiConsumer<Boolean, Boolean>> flagListeners = new ConcurrentHashMap<>();
    private final Map<UUID, String> activeTickets = new ConcurrentHashMap<>();
    private String lastBroadcastId = "";
    private long startTimeMs = System.currentTimeMillis();

    public static BloxCloudPlugin get() {
        return instance;
    }

    @Override
    public void onEnable() {
        instance = this;
        saveDefaultConfig();

        this.apiKey = getConfig().getString("api-key", "YOUR_API_KEY");
        this.baseUrl = getConfig().getString("base-url", "https://bloxcloud.world");
        this.serverId = getConfig().getString("server-id", "MC_" + Bukkit.getPort());
        this.region = getConfig().getString("region", "US-East");
        this.startTimeMs = System.currentTimeMillis();

        // Register Velocity / BungeeCord plugin messaging channel for cross-server arena transfers
        getServer().getMessenger().registerOutgoingPluginChannel(this, "BungeeCord");

        getLogger().info("================================================================");
        getLogger().info(" ⚡ [BloxCloud] Connected Minecraft Node: " + this.serverId);
        getLogger().info(" 🌐 Cloud Endpoint: " + this.baseUrl);
        getLogger().info("================================================================");

        // 1. Telemetry Heartbeat Loop (every 15 seconds = 300 ticks)
        Bukkit.getScheduler().runTaskTimerAsynchronously(this, this::sendHeartbeat, 20L, 300L);

        // 2. LiveOps Flags, Broadcasts & Matchmaking Poll Loop (every 4 seconds = 80 ticks)
        Bukkit.getScheduler().runTaskTimerAsynchronously(this, () -> {
            fetchLiveOpsConfig();
            pollMatchmakingTickets();
        }, 40L, 80L);
    }

    // -------------------------------------------------------------------------
    // 1. TELEMETRY & TPS DIAGNOSTICS
    // -------------------------------------------------------------------------
    public void sendHeartbeat() {
        int players = Bukkit.getOnlinePlayers().size();
        long usedMemMb = (Runtime.getRuntime().totalMemory() - Runtime.getRuntime().freeMemory()) / (1024 * 1024);
        long uptimeSec = (System.currentTimeMillis() - startTimeMs) / 1000;

        // Read recent 1m TPS on Paper/Purpur (defaults to 20.0 on standard Spigot)
        double tps = 20.0;
        try {
            double[] recentTps = (double[]) Bukkit.getServer().getClass().getMethod("getTPS").invoke(Bukkit.getServer());
            if (recentTps != null && recentTps.length > 0) {
                tps = Math.min(20.0, Math.round(recentTps[0] * 10.0) / 10.0);
            }
        } catch (Exception ignored) {}

        String json = String.format(
                "{\"jobId\":\"%s\",\"engine\":\"MINECRAFT\",\"playerCount\":%d,\"serverTps\":%.1f,\"serverFps\":%.1f,\"serverMemoryMb\":%d,\"region\":\"%s\",\"uptimeSeconds\":%d}",
                escapeJson(serverId), players, tps, tps, usedMemMb, escapeJson(region), uptimeSec
        );
        postAsync("/api/v1/telemetry/heartbeat", json);
    }

    public void reportError(String message, String stackTrace, String pluginOrClass) {
        String json = String.format(
                "{\"jobId\":\"%s\",\"message\":\"%s\",\"stack\":\"%s\",\"scriptName\":\"%s\"}",
                escapeJson(serverId), escapeJson(message), escapeJson(stackTrace), escapeJson(pluginOrClass)
        );
        postAsync("/api/v1/telemetry/error", json);
    }

    public void reportExploit(Player player, String anomalyType, String details) {
        String json = String.format(
                "{\"jobId\":\"%s\",\"userId\":\"%s\",\"username\":\"%s\",\"anomalyType\":\"%s\",\"details\":\"%s\"}",
                escapeJson(serverId), player.getUniqueId(), escapeJson(player.getName()), escapeJson(anomalyType), escapeJson(details)
        );
        postAsync("/api/v1/telemetry/exploit-alert", json);
    }

    // -------------------------------------------------------------------------
    // 2. LIVEOPS FEATURE FLAGS, KILL-SWITCHES & GLOBAL BROADCASTS
    // -------------------------------------------------------------------------
    public boolean getFlag(String key, boolean defaultValue) {
        return liveFlags.getOrDefault(key, defaultValue);
    }

    public void onFlagChange(String key, BiConsumer<Boolean, Boolean> listener) {
        flagListeners.put(key, listener);
    }

    private void fetchLiveOpsConfig() {
        String body = getSync("/api/v1/liveops/config");
        if (body == null) return;

        // Parse boolean flags from {"config":{"flag_name":true,...}}
        Matcher configBlock = Pattern.compile("\"config\"\\s*:\\s*\\{([^}]*)}").matcher(body);
        if (configBlock.find()) {
            Matcher kv = Pattern.compile("\"([^\"]+)\"\\s*:\\s*(true|false)").matcher(configBlock.group(1));
            while (kv.find()) {
                String k = kv.group(1);
                boolean newVal = Boolean.parseBoolean(kv.group(2));
                Boolean oldVal = liveFlags.put(k, newVal);
                if (oldVal == null || oldVal != newVal) {
                    BiConsumer<Boolean, Boolean> cb = flagListeners.get(k);
                    if (cb != null) {
                        Bukkit.getScheduler().runTask(this, () -> cb.accept(newVal, oldVal != null && oldVal));
                    }
                }
            }
        }

        // Check for active emergency broadcast
        Matcher bcId = Pattern.compile("\"activeBroadcast\"\\s*:\\s*\\{[^}]*\"id\"\\s*:\\s*\"([^\"]+)\"[^}]*\"message\"\\s*:\\s*\"([^\"]+)\"").matcher(body);
        if (bcId.find()) {
            String id = bcId.group(1);
            String msg = bcId.group(2);
            if (!id.equals(lastBroadcastId)) {
                lastBroadcastId = id;
                Bukkit.getScheduler().runTask(this, () -> {
                    String formatted = ChatColor.translateAlternateColorCodes('&', "&c&l[BLOXCLOUD ALERT] &f" + msg);
                    Bukkit.broadcastMessage(formatted);
                    for (Player p : Bukkit.getOnlinePlayers()) {
                        p.sendTitle(ChatColor.RED + "" + ChatColor.BOLD + "NETWORK ALERT", ChatColor.WHITE + msg, 10, 70, 20);
                    }
                });
            }
        }
    }

    // -------------------------------------------------------------------------
    // 3. CROSS-SERVER ELO MATCHMAKING & VELOCITY / BUNGEECORD TRANSFER
    // -------------------------------------------------------------------------
    public void joinQueue(Player player, String queueType, int eloRating) {
        String json = String.format(
                "{\"userId\":\"%s\",\"username\":\"%s\",\"queueType\":\"%s\",\"rating\":%d}",
                player.getUniqueId(), escapeJson(player.getName()), escapeJson(queueType), eloRating
        );
        String resp = postSync("/api/v1/matchmaking/queue", json);
        if (resp != null) {
            Matcher m = Pattern.compile("\"ticketId\"\\s*:\\s*\"([^\"]+)\"").matcher(resp);
            if (m.find()) {
                activeTickets.put(player.getUniqueId(), m.group(1));
                player.sendMessage(ChatColor.AQUA + "[BloxCloud] Joined " + queueType + " queue (ELO: " + eloRating + ")");
            }
        }
    }

    private void pollMatchmakingTickets() {
        for (Map.Entry<UUID, String> entry : activeTickets.entrySet()) {
            UUID uuid = entry.getKey();
            String ticketId = entry.getValue();
            String resp = getSync("/api/v1/matchmaking/ticket/" + ticketId);
            if (resp != null && resp.contains("\"status\":\"MATCHED\"")) {
                activeTickets.remove(uuid);
                Matcher codeMatcher = Pattern.compile("\"reservedServerCode\"\\s*:\\s*\"([^\"]+)\"").matcher(resp);
                String targetServer = codeMatcher.find() ? codeMatcher.group(1) : getConfig().getString("default-arena-server", "arena-1");
                Bukkit.getScheduler().runTask(this, () -> {
                    Player p = Bukkit.getPlayer(uuid);
                    if (p != null && p.isOnline()) {
                        p.sendMessage(ChatColor.GREEN + "⚔ Match Found! Sending you to arena server: " + targetServer);
                        sendPlayerToProxyServer(p, targetServer);
                    }
                });
            }
        }
    }

    public void sendPlayerToProxyServer(Player player, String targetServerName) {
        try {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            DataOutputStream out = new DataOutputStream(b);
            out.writeUTF("Connect");
            out.writeUTF(targetServerName);
            player.sendPluginMessage(this, "BungeeCord", b.toByteArray());
        } catch (Exception e) {
            getLogger().warning("Failed to transfer player across Velocity/BungeeCord proxy: " + e.getMessage());
        }
    }

    // -------------------------------------------------------------------------
    // 4. GLOBAL AUCTION HOUSE (ATOMIC ANTI-DUPE)
    // -------------------------------------------------------------------------
    public String listGlobalItem(Player seller, String itemId, int priceCoins) {
        String json = String.format(
                "{\"sellerId\":\"%s\",\"sellerName\":\"%s\",\"itemId\":\"%s\",\"price\":%d}",
                seller.getUniqueId(), escapeJson(seller.getName()), escapeJson(itemId), priceCoins
        );
        return postSync("/api/v1/marketplace/list", json);
    }

    public boolean buyGlobalItem(Player buyer, String listingId) {
        String json = String.format(
                "{\"buyerId\":\"%s\",\"buyerName\":\"%s\",\"listingId\":\"%s\"}",
                buyer.getUniqueId(), escapeJson(buyer.getName()), escapeJson(listingId)
        );
        String resp = postSync("/api/v1/marketplace/buy", json);
        return resp != null && resp.contains("\"success\":true");
    }

    // -------------------------------------------------------------------------
    // HTTP HELPERS
    // -------------------------------------------------------------------------
    private void postAsync(String endpoint, String jsonBody) {
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl + endpoint))
                .timeout(Duration.ofSeconds(5))
                .header("Content-Type", "application/json")
                .header("x-api-key", apiKey)
                .POST(HttpRequest.BodyPublishers.ofString(jsonBody))
                .build();
        http.sendAsync(req, HttpResponse.BodyHandlers.ofString());
    }

    private String postSync(String endpoint, String jsonBody) {
        try {
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + endpoint))
                    .timeout(Duration.ofSeconds(5))
                    .header("Content-Type", "application/json")
                    .header("x-api-key", apiKey)
                    .POST(HttpRequest.BodyPublishers.ofString(jsonBody))
                    .build();
            HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
            return res.statusCode() < 300 ? res.body() : null;
        } catch (Exception e) {
            return null;
        }
    }

    private String getSync(String endpoint) {
        try {
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + endpoint))
                    .timeout(Duration.ofSeconds(5))
                    .header("x-api-key", apiKey)
                    .GET()
                    .build();
            HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
            return res.statusCode() < 300 ? res.body() : null;
        } catch (Exception e) {
            return null;
        }
    }

    private static String escapeJson(String s) {
        return s == null ? "" : s.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
