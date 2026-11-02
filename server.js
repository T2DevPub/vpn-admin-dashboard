require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const fs = require('fs');
const path = require('path');
const ping = require('ping');
const net = require('net');

const app = express();

function checkTcpPort(ip, port) {
    return new Promise((resolve, reject) => {
        const socket = new net.Socket();
        socket.setTimeout(2500);

        socket.on('connect', () => {
            socket.destroy();
            resolve(true);
        });

        socket.on('timeout', () => {
            socket.destroy();
            reject(new Error('timeout'));
        });

        socket.on('error', () => {
            socket.destroy();
            reject(new Error('error'));
        });

        try {
            socket.connect(port, ip);
        } catch (e) {
            reject(e);
        }
    });
}

async function checkServerStatus(ip, port, protocol) {
    // OpenVPN Access Server typically exposes 443 and 943 for web UIs,
    // and 22 is SSH. We'll try them all concurrently.
    const portsToTry = [443, 943, 80, 22];

    if (port && protocol && protocol.toLowerCase() === 'tcp') {
        portsToTry.unshift(port); // prioritize their custom TCP port
    }

    try {
        // Promise.any resolves if AT LEAST ONE port connects successfully
        await Promise.any(portsToTry.map(p => checkTcpPort(ip, p)));
        return 'Online';
    } catch (e) {
        // AggregateError is thrown if ALL ports fail to connect
        return 'Down';
    }
}

// Background task to check server statuses every 60 seconds
setInterval(async () => {
    if (!db) return;
    try {
        const servers = await db.all(`SELECT id, ipAddress, port, protocol FROM servers`);
        for (const server of servers) {
            const status = await checkServerStatus(server.ipAddress, server.port, server.protocol);
            await db.run(`UPDATE servers SET status = ? WHERE id = ?`, [status, server.id]);
        }
    } catch (e) {
        console.error("Health check error:", e);
    }
}, 60000);

// Background task to increment bandwidth based on active users
setInterval(async () => {
    if (!db) return;
    try {
        const row = await db.get(`SELECT SUM(activeUsers) as total FROM servers`);
        const activeUsers = row ? (row.total || 0) : 0;
        if (activeUsers > 0) {
            // Assume each active user consumes roughly 5 MB per 10 seconds -> 0.005 GB
            const additionalGb = activeUsers * 0.005;
            await db.run(`UPDATE bandwidth_stats SET consumedGb = consumedGb + ? WHERE id = 'main'`, [additionalGb]);

            // Log daily bandwidth
            const today = new Date().toISOString().split('T')[0];
            await db.run(`INSERT OR IGNORE INTO daily_bandwidth (date, consumedGb) VALUES (?, 0)`, [today]);
            await db.run(`UPDATE daily_bandwidth SET consumedGb = consumedGb + ? WHERE date = ?`, [additionalGb, today]);
        }
    } catch (e) {}
}, 10000);

const port = process.env.PORT || 3000;

// Setup Multer for memory storage
const upload = multer({ storage: multer.memoryStorage() });

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'vpn-super-secret-key-123',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 } // 24 hours
}));

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'password';

// Database Schema Upgrades
async function upgradeSchema() {
  try {
      const serversInfo = await db.all(`PRAGMA table_info(servers)`);
      const hasActiveUsers = serversInfo.some(col => col.name === 'activeUsers');
      const hasStatus = serversInfo.some(col => col.name === 'status');
      const hasSkipCert = serversInfo.some(col => col.name === 'skipCertCheck');
      const hasServerType = serversInfo.some(col => col.name === 'serverType');

      if (!hasActiveUsers) {
          await db.exec(`ALTER TABLE servers ADD COLUMN activeUsers INTEGER DEFAULT 0`);
      }
      if (!hasStatus) {
          await db.exec(`ALTER TABLE servers ADD COLUMN status TEXT DEFAULT 'Online'`);
      }
      if (!hasSkipCert) {
          await db.exec(`ALTER TABLE servers ADD COLUMN skipCertCheck INTEGER DEFAULT 0`);
      }
      if (!hasServerType) {
          await db.exec(`ALTER TABLE servers ADD COLUMN serverType TEXT DEFAULT 'Standard'`);
      }

      const configInfo = await db.all(`PRAGMA table_info(app_config)`);
      const columnsToAdd = [
          'bannerAdUnitId', 'appOpenAdUnitId', 'interstitialAdUnitId', 'rewardedAdUnitId',
          'metaBannerAdUnitId', 'metaAppOpenAdUnitId', 'metaInterstitialAdUnitId', 'metaRewardedAdUnitId'
      ];

      for (const col of columnsToAdd) {
          if (!configInfo.some(c => c.name === col)) {
              await db.exec(`ALTER TABLE app_config ADD COLUMN ${col} TEXT`);
          }
      }
  } catch (e) {
      console.error("Schema upgrade error:", e);
  }
}

// --- Database Setup ---
let db;
async function setupDatabase() {
  const dbPath = path.join(__dirname, 'data');
  if (!fs.existsSync(dbPath)) fs.mkdirSync(dbPath);

  db = await open({
    filename: path.join(dbPath, 'vpn.sqlite'),
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      name TEXT,
      countryCode TEXT,
      flagEmoji TEXT,
      city TEXT,
      ipAddress TEXT,
      port INTEGER,
      protocol TEXT,
      pingMs INTEGER,
      loadPercent INTEGER,
      isPlusOnly INTEGER,
      ovpnConfig TEXT,
      vpnUsername TEXT,
      vpnPassword TEXT,
      activeUsers INTEGER DEFAULT 0,
      status TEXT DEFAULT 'Online',
      skipCertCheck INTEGER DEFAULT 0,
      serverType TEXT DEFAULT 'Standard'
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS active_sessions (
      sessionId TEXT PRIMARY KEY,
      serverId TEXT,
      countryCode TEXT,
      lastUpdate INTEGER
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS country_stats (
      countryCode TEXT PRIMARY KEY,
      activeUsers INTEGER DEFAULT 0
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS bandwidth_stats (
      id TEXT PRIMARY KEY,
      consumedGb REAL DEFAULT 0
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_bandwidth (
      date TEXT PRIMARY KEY,
      consumedGb REAL DEFAULT 0
    );
  `);

  // Ensure bandwidth row exists
  const bw = await db.get(`SELECT * FROM bandwidth_stats WHERE id = 'main'`);
  if (!bw) {
     await db.run(`INSERT INTO bandwidth_stats (id, consumedGb) VALUES ('main', 0)`);
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS app_config (
      id TEXT PRIMARY KEY,
      bannersEnabled INTEGER,
      interstitialOnConnect INTEGER,
      interstitialOnDisconnect INTEGER,
      appOpenAdsEnabled INTEGER,
      adNetworkProvider TEXT,
      bannerAdUnitId TEXT,
      appOpenAdUnitId TEXT,
      interstitialAdUnitId TEXT,
      rewardedAdUnitId TEXT,
      metaBannerAdUnitId TEXT,
      metaAppOpenAdUnitId TEXT,
      metaInterstitialAdUnitId TEXT,
      metaRewardedAdUnitId TEXT
    );
  `);

  await upgradeSchema();

  // Insert default config if none exists
  const configExists = await db.get(`SELECT * FROM app_config WHERE id = 'ads'`);
  if (!configExists) {
      await db.run(`INSERT INTO app_config (id, bannersEnabled, interstitialOnConnect, interstitialOnDisconnect, appOpenAdsEnabled, adNetworkProvider, bannerAdUnitId, appOpenAdUnitId, interstitialAdUnitId, rewardedAdUnitId, metaBannerAdUnitId, metaAppOpenAdUnitId, metaInterstitialAdUnitId, metaRewardedAdUnitId) VALUES ('ads', 1, 1, 1, 1, 'AdMob', '', '', '', '', '', '', '', '')`);
  }
}
setupDatabase();

// Auth Middleware
const requireAuth = (req, res, next) => {
  if (req.session.isAuthenticated) {
    next();
  } else {
    res.redirect('/login');
  }
};

// --- Routes ---

app.get('/', (req, res) => {
  res.redirect('/dashboard');
});

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.isAuthenticated = true;
    res.redirect('/dashboard');
  } else {
    res.render('login', { error: 'Invalid credentials' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// APIs for the Android App to read data without logging in
app.get('/api/servers', async (req, res) => {
  if(!db) return res.status(500).json({error: "Database starting"});
  const servers = await db.all(`SELECT * FROM servers`);
  // Convert sqlite integer booleans back to true/false for the app
  const mapped = servers.map(s => ({
      ...s,
      isPlusOnly: s.isPlusOnly === 1,
      skipCertCheck: s.skipCertCheck === 1
  }));
  res.json(mapped);
});

// App API to record a connection (now acts as a heartbeat)
app.post('/api/servers/:id/connect', async (req, res) => {
  if(!db) return res.status(500).json({error: "Database starting"});
  res.json({ success: true }); // Legacy endpoint, keep for backwards compatibility if needed
});

// App API to record a disconnection
app.post('/api/servers/:id/disconnect', async (req, res) => {
  if(!db) return res.status(500).json({error: "Database starting"});
  const sessionId = req.query.sessionId || req.body.sessionId;
  if (sessionId) {
      await db.run(`DELETE FROM active_sessions WHERE sessionId = ?`, sessionId);
  }
  res.json({ success: true });
});

// Real-time Heartbeat endpoint for active sessions
app.post('/api/servers/:id/heartbeat', async (req, res) => {
    if(!db) return res.status(500).json({error: "Database starting"});

    const serverId = req.params.id;
    const countryCode = req.query.userCountry || 'Unknown';
    const sessionId = req.query.sessionId || req.body.sessionId;

    if (!sessionId) return res.status(400).json({error: "Missing sessionId"});

    const now = Date.now();
    await db.run(`
        INSERT INTO active_sessions (sessionId, serverId, countryCode, lastUpdate)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(sessionId) DO UPDATE SET lastUpdate = excluded.lastUpdate, serverId = excluded.serverId
    `, [sessionId, serverId, countryCode, now]);

    res.json({ success: true });
});

// Dashboard Helper function to prune stale sessions
async function pruneAndGetSessionStats() {
    if (!db) return { totalActiveUsers: 0, servers: [], countryStats: [] };

    const cutoffTime = Date.now() - 35000; // Aggressive 35 second prune (assuming 15s heartbeats from app)
    await db.run(`DELETE FROM active_sessions WHERE lastUpdate < ?`, cutoffTime);

    const totalRow = await db.get(`SELECT count(*) as total FROM active_sessions`);
    const totalActiveUsers = totalRow ? totalRow.total : 0;

    const countryStats = await db.all(`
        SELECT countryCode, count(*) as activeUsers
        FROM active_sessions
        WHERE countryCode != 'Unknown' AND countryCode != ''
        GROUP BY countryCode
        ORDER BY activeUsers DESC
    `);

    // Join servers with active_sessions for per-server counts
    const servers = await db.all(`
        SELECT s.id, s.name, s.flagEmoji, s.countryCode, s.status, count(a.sessionId) as activeUsers
        FROM servers s
        LEFT JOIN active_sessions a ON s.id = a.serverId
        GROUP BY s.id
    `);

    return { totalActiveUsers, servers, countryStats };
}

app.get('/api/ads', async (req, res) => {
  if(!db) return res.status(500).json({error: "Database starting"});
  const config = await db.get(`SELECT * FROM app_config WHERE id = 'ads'`);
  res.json({
      bannersEnabled: config.bannersEnabled === 1,
      interstitialOnConnect: config.interstitialOnConnect === 1,
      interstitialOnDisconnect: config.interstitialOnDisconnect === 1,
      appOpenAdsEnabled: config.appOpenAdsEnabled === 1,
      adNetworkProvider: config.adNetworkProvider,
      bannerAdUnitId: config.bannerAdUnitId || "",
      appOpenAdUnitId: config.appOpenAdUnitId || "",
      interstitialAdUnitId: config.interstitialAdUnitId || "",
      rewardedAdUnitId: config.rewardedAdUnitId || "",
      metaBannerAdUnitId: config.metaBannerAdUnitId || "",
      metaAppOpenAdUnitId: config.metaAppOpenAdUnitId || "",
      metaInterstitialAdUnitId: config.metaInterstitialAdUnitId || "",
      metaRewardedAdUnitId: config.metaRewardedAdUnitId || ""
  });
});

// Dashboard (Stats only)
app.get('/dashboard', requireAuth, async (req, res) => {
  const { totalActiveUsers, servers } = await pruneAndGetSessionStats();
  res.render('dashboard', { totalActiveUsers, servers });
});

// Reset Active Users API
app.post('/api/admin/reset-users', requireAuth, async (req, res) => {
  if (!db) return res.status(500).json({error: "DB not configured"});
  await db.run(`DELETE FROM active_sessions`);
  res.json({ success: true });
});

// Servers Page
app.get('/servers', requireAuth, async (req, res) => {
  let servers = [];
  if (db) {
    servers = await db.all(`SELECT * FROM servers`);

    const { servers: activeServersMap } = await pruneAndGetSessionStats();

    servers = servers.map(s => {
        const activeData = activeServersMap.find(as => as.id === s.id);
        return {...s, isPlusOnly: s.isPlusOnly === 1, activeUsers: activeData ? activeData.activeUsers : 0 };
    });
  }
  res.render('servers', { servers });
});

app.get('/api/admin/dashboard-stats', requireAuth, async (req, res) => {
    if (!db) return res.status(500).json({error: "DB not configured"});

    const daysFilter = parseInt(req.query.days) || 1;

    const { totalActiveUsers, servers, countryStats } = await pruneAndGetSessionStats();

    let consumedGb = 0;
    if (daysFilter === 999) {
        // All time
        const bwRow = await db.get(`SELECT consumedGb FROM bandwidth_stats WHERE id = 'main'`);
        consumedGb = bwRow ? (bwRow.consumedGb || 0) : 0;
    } else {
        // Last X days
        const dateLimit = new Date(Date.now() - (daysFilter - 1) * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const bwRow = await db.get(`SELECT SUM(consumedGb) as total FROM daily_bandwidth WHERE date >= ?`, [dateLimit]);
        consumedGb = bwRow ? (bwRow.total || 0) : 0;
    }

    let bwDisplay = consumedGb.toFixed(2) + " GB";
    if (consumedGb > 1024) {
        bwDisplay = (consumedGb / 1024).toFixed(2) + " TB";
    }

    // Calculate synthetic upload/download split (e.g., 20% up, 80% down of total)
    const downloadGb = consumedGb * 0.8;
    const uploadGb = consumedGb * 0.2;

    let dlDisplay = downloadGb.toFixed(2) + " GB";
    if (downloadGb > 1024) dlDisplay = (downloadGb / 1024).toFixed(2) + " TB";

    let ulDisplay = uploadGb.toFixed(2) + " GB";
    if (uploadGb > 1024) ulDisplay = (uploadGb / 1024).toFixed(2) + " TB";

    res.json({
        totalActiveUsers,
        servers,
        bwDisplay,
        dlDisplay,
        ulDisplay,
        countryStats
    });
});

// Admin API to reset bandwidth
app.post('/api/admin/reset-bandwidth', requireAuth, async (req, res) => {
    if (!db) return res.status(500).json({error: "DB not configured"});
    try {
        await db.run(`UPDATE bandwidth_stats SET consumedGb = 0 WHERE id = 'main'`);
        await db.run(`DELETE FROM daily_bandwidth`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Admin API to download the uploaded .ovpn file
app.get('/admin/download-ovpn/:id', requireAuth, async (req, res) => {
  if (!db) return res.status(500).send("DB not configured");

  const server = await db.get(`SELECT name, countryCode, city, ovpnConfig FROM servers WHERE id = ?`, req.params.id);
  if (!server || !server.ovpnConfig) return res.status(404).send("Config not found");

  const filename = `${server.countryCode}_${server.city.replace(/\s+/g, '_')}.ovpn`;
  res.setHeader('Content-disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-type', 'application/x-openvpn-profile');
  res.send(server.ovpnConfig);
});

// Admin API to manually force a health check for a specific server
app.post('/admin/check-status/:id', requireAuth, async (req, res) => {
    if (!db) return res.status(500).json({error: "DB not configured"});

    const server = await db.get(`SELECT ipAddress, port FROM servers WHERE id = ?`, req.params.id);
    if (!server) return res.status(404).json({error: "Server not found"});

    try {
        const status = await checkServerStatus(server.ipAddress, server.port);
        await db.run(`UPDATE servers SET status = ? WHERE id = ?`, [status, req.params.id]);
        res.json({ status: status });
    } catch (err) {
        res.status(500).json({error: "Status check failed"});
    }
});

// Edit Server Page
app.get('/edit/:id', requireAuth, async (req, res) => {
  if (!db) return res.send("DB not configured");
  const doc = await db.get(`SELECT * FROM servers WHERE id = ?`, req.params.id);
  if (!doc) return res.status(404).send("Server not found");
  doc.isPlusOnly = doc.isPlusOnly === 1;
  doc.skipCertCheck = doc.skipCertCheck === 1;
  res.render('edit_server', { server: doc });
});

// Add Server Page
app.get('/add', requireAuth, (req, res) => {
  res.render('edit_server', { server: null });
});

// Save Server
app.post('/save', requireAuth, upload.single('ovpnFile'), async (req, res) => {
  if (!db) return res.send("DB not configured");

  const data = req.body;
  const isPlusOnly = data.isPlusOnly === 'on' ? 1 : 0;
  const skipCertCheck = data.skipCertCheck === 'on' ? 1 : 0;

  let ovpnConfig = data.existingOvpn || "";
  if (req.file) {
    ovpnConfig = req.file.buffer.toString('utf-8');
  }

  const serverData = {
    name: data.name,
    countryCode: data.countryCode,
    flagEmoji: getFlagEmoji(data.countryCode),
    city: data.city,
    ipAddress: data.ipAddress || "",
    port: parseInt(data.port) || 1194,
    protocol: data.protocol || "UDP",
    loadPercent: parseInt(data.loadPercent) || 40,
    isPlusOnly: isPlusOnly,
    skipCertCheck: skipCertCheck,
    serverType: data.serverType || "Standard",
    ovpnConfig: ovpnConfig,
    vpnUsername: data.vpnUsername || "",
    vpnPassword: data.vpnPassword || ""
  };

  const id = data.id || (data.countryCode.toLowerCase() + "_" + data.city.toLowerCase().replace(/\\s+/g, ""));

  const existing = await db.get(`SELECT id FROM servers WHERE id = ?`, id);

  if (existing) {
    await db.run(`UPDATE servers SET name=?, countryCode=?, flagEmoji=?, city=?, ipAddress=?, port=?, protocol=?, loadPercent=?, isPlusOnly=?, skipCertCheck=?, serverType=?, ovpnConfig=?, vpnUsername=?, vpnPassword=? WHERE id=?`,
      [serverData.name, serverData.countryCode, serverData.flagEmoji, serverData.city, serverData.ipAddress, serverData.port, serverData.protocol, serverData.loadPercent, serverData.isPlusOnly, serverData.skipCertCheck, serverData.serverType, serverData.ovpnConfig, serverData.vpnUsername, serverData.vpnPassword, id]);
  } else {
    await db.run(`INSERT INTO servers (id, name, countryCode, flagEmoji, city, ipAddress, port, protocol, loadPercent, isPlusOnly, skipCertCheck, serverType, ovpnConfig, vpnUsername, vpnPassword) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, serverData.name, serverData.countryCode, serverData.flagEmoji, serverData.city, serverData.ipAddress, serverData.port, serverData.protocol, serverData.loadPercent, serverData.isPlusOnly, serverData.skipCertCheck, serverData.serverType, serverData.ovpnConfig, serverData.vpnUsername, serverData.vpnPassword]);
  }

  res.redirect('/servers');
});

// Delete Server
app.get('/delete/:id', requireAuth, async (req, res) => {
  if (db) {
    await db.run(`DELETE FROM servers WHERE id = ?`, req.params.id);
  }
  res.redirect('/servers');
});

// Ad Management Page
app.get('/ads', requireAuth, async (req, res) => {
  if (!db) return res.send("DB not configured");

  const doc = await db.get(`SELECT * FROM app_config WHERE id = 'ads'`);
  const config = {
      bannersEnabled: doc.bannersEnabled === 1,
      interstitialOnConnect: doc.interstitialOnConnect === 1,
      interstitialOnDisconnect: doc.interstitialOnDisconnect === 1,
      appOpenAdsEnabled: doc.appOpenAdsEnabled === 1,
      adNetworkProvider: doc.adNetworkProvider,
      bannerAdUnitId: doc.bannerAdUnitId || "",
      appOpenAdUnitId: doc.appOpenAdUnitId || "",
      interstitialAdUnitId: doc.interstitialAdUnitId || "",
      rewardedAdUnitId: doc.rewardedAdUnitId || "",
      metaBannerAdUnitId: doc.metaBannerAdUnitId || "",
      metaAppOpenAdUnitId: doc.metaAppOpenAdUnitId || "",
      metaInterstitialAdUnitId: doc.metaInterstitialAdUnitId || "",
      metaRewardedAdUnitId: doc.metaRewardedAdUnitId || ""
  };

  res.render('ads', { config });
});

app.post('/ads', requireAuth, async (req, res) => {
  if (!db) return res.send("DB not configured");
  const data = req.body;

  const banners = data.bannersEnabled === 'on' ? 1 : 0;
  const iConnect = data.interstitialOnConnect === 'on' ? 1 : 0;
  const iDisconnect = data.interstitialOnDisconnect === 'on' ? 1 : 0;
  const appOpen = data.appOpenAdsEnabled === 'on' ? 1 : 0;
  const provider = data.adNetworkProvider || "AdMob";

  const bannerId = data.bannerAdUnitId || "";
  const appOpenId = data.appOpenAdUnitId || "";
  const interstitialId = data.interstitialAdUnitId || "";
  const rewardedId = data.rewardedAdUnitId || "";

  const metaBannerId = data.metaBannerAdUnitId || "";
  const metaAppOpenId = data.metaAppOpenAdUnitId || "";
  const metaInterstitialId = data.metaInterstitialAdUnitId || "";
  const metaRewardedId = data.metaRewardedAdUnitId || "";

  await db.run(`UPDATE app_config SET bannersEnabled=?, interstitialOnConnect=?, interstitialOnDisconnect=?, appOpenAdsEnabled=?, adNetworkProvider=?, bannerAdUnitId=?, appOpenAdUnitId=?, interstitialAdUnitId=?, rewardedAdUnitId=?, metaBannerAdUnitId=?, metaAppOpenAdUnitId=?, metaInterstitialAdUnitId=?, metaRewardedAdUnitId=? WHERE id='ads'`,
    [banners, iConnect, iDisconnect, appOpen, provider, bannerId, appOpenId, interstitialId, rewardedId, metaBannerId, metaAppOpenId, metaInterstitialId, metaRewardedId]);

  res.redirect('/ads');
});

function getFlagEmoji(countryCode) {
    if (!countryCode || countryCode.length !== 2) return "🌐";
    const codePoints = countryCode
        .toUpperCase()
        .split('')
        .map(char => 127397 + char.charCodeAt(0));
    return String.fromCodePoint(...codePoints);
}

app.listen(port, () => {
  console.log(`Dashboard running at http://localhost:${port}`);
});