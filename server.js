require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const fs = require('fs');
const path = require('path');

const app = express();
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
      vpnPassword TEXT
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS app_config (
      id TEXT PRIMARY KEY,
      bannersEnabled INTEGER,
      interstitialOnConnect INTEGER,
      interstitialOnDisconnect INTEGER,
      appOpenAdsEnabled INTEGER,
      adNetworkProvider TEXT
    );
  `);

  // Insert default config if none exists
  const configExists = await db.get(`SELECT * FROM app_config WHERE id = 'ads'`);
  if (!configExists) {
    await db.run(`INSERT INTO app_config (id, bannersEnabled, interstitialOnConnect, interstitialOnDisconnect, appOpenAdsEnabled, adNetworkProvider) VALUES ('ads', 1, 1, 1, 1, 'AdMob')`);
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
  const mapped = servers.map(s => ({...s, isPlusOnly: s.isPlusOnly === 1}));
  res.json(mapped);
});

app.get('/api/ads', async (req, res) => {
  if(!db) return res.status(500).json({error: "Database starting"});
  const config = await db.get(`SELECT * FROM app_config WHERE id = 'ads'`);
  res.json({
      bannersEnabled: config.bannersEnabled === 1,
      interstitialOnConnect: config.interstitialOnConnect === 1,
      interstitialOnDisconnect: config.interstitialOnDisconnect === 1,
      appOpenAdsEnabled: config.appOpenAdsEnabled === 1,
      adNetworkProvider: config.adNetworkProvider
  });
});

// Dashboard (Server List)
app.get('/dashboard', requireAuth, async (req, res) => {
  let servers = [];
  if (db) {
    servers = await db.all(`SELECT * FROM servers`);
    servers = servers.map(s => ({...s, isPlusOnly: s.isPlusOnly === 1}));
  }
  res.render('dashboard', { servers });
});

// Edit Server Page
app.get('/edit/:id', requireAuth, async (req, res) => {
  if (!db) return res.send("DB not configured");
  const doc = await db.get(`SELECT * FROM servers WHERE id = ?`, req.params.id);
  if (!doc) return res.status(404).send("Server not found");
  doc.isPlusOnly = doc.isPlusOnly === 1;
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

  let ovpnConfig = data.existingOvpn || "";
  if (req.file) {
    ovpnConfig = req.file.buffer.toString('utf-8');
  }

  const serverData = {
    name: data.name,
    countryCode: data.countryCode,
    flagEmoji: getFlagEmoji(data.countryCode),
    city: data.city,
    ipAddress: data.ipAddress,
    port: parseInt(data.port) || 1194,
    protocol: data.protocol || "UDP",
    pingMs: parseInt(data.pingMs) || 35,
    loadPercent: parseInt(data.loadPercent) || 40,
    isPlusOnly: isPlusOnly,
    ovpnConfig: ovpnConfig,
    vpnUsername: data.vpnUsername || "",
    vpnPassword: data.vpnPassword || ""
  };

  const id = data.id || (data.countryCode.toLowerCase() + "_" + data.city.toLowerCase().replace(/\\s+/g, ""));

  const existing = await db.get(`SELECT id FROM servers WHERE id = ?`, id);

  if (existing) {
    await db.run(`UPDATE servers SET name=?, countryCode=?, flagEmoji=?, city=?, ipAddress=?, port=?, protocol=?, pingMs=?, loadPercent=?, isPlusOnly=?, ovpnConfig=?, vpnUsername=?, vpnPassword=? WHERE id=?`,
      [serverData.name, serverData.countryCode, serverData.flagEmoji, serverData.city, serverData.ipAddress, serverData.port, serverData.protocol, serverData.pingMs, serverData.loadPercent, serverData.isPlusOnly, serverData.ovpnConfig, serverData.vpnUsername, serverData.vpnPassword, id]);
  } else {
    await db.run(`INSERT INTO servers (id, name, countryCode, flagEmoji, city, ipAddress, port, protocol, pingMs, loadPercent, isPlusOnly, ovpnConfig, vpnUsername, vpnPassword) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, serverData.name, serverData.countryCode, serverData.flagEmoji, serverData.city, serverData.ipAddress, serverData.port, serverData.protocol, serverData.pingMs, serverData.loadPercent, serverData.isPlusOnly, serverData.ovpnConfig, serverData.vpnUsername, serverData.vpnPassword]);
  }

  res.redirect('/dashboard');
});

// Delete Server
app.get('/delete/:id', requireAuth, async (req, res) => {
  if (db) {
    await db.run(`DELETE FROM servers WHERE id = ?`, req.params.id);
  }
  res.redirect('/dashboard');
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
      adNetworkProvider: doc.adNetworkProvider
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

  await db.run(`UPDATE app_config SET bannersEnabled=?, interstitialOnConnect=?, interstitialOnDisconnect=?, appOpenAdsEnabled=?, adNetworkProvider=? WHERE id='ads'`,
    [banners, iConnect, iDisconnect, appOpen, provider]);

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