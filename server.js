require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const admin = require('firebase-admin');

// Initialize Firebase Admin (You'll need your service account json)
// For local testing without a file, we wrap this in a try-catch.
try {
  const serviceAccount = require('./serviceAccountKey.json');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
} catch(e) {
  console.log("Firebase Admin not initialized. Please add serviceAccountKey.json");
}

const db = admin.firestore ? admin.firestore() : null;

const app = express();
const port = process.env.PORT || 3000;

// Setup Multer for memory storage (for processing .ovpn uploads without saving to disk)
const upload = multer({ storage: multer.memoryStorage() });

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Basic session setup for simple auth
app.use(session({
  secret: process.env.SESSION_SECRET || 'vpn-super-secret-key-123',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 } // 24 hours
}));

// Hardcoded Admin Credentials (set in .env for production)
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'password';

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

// Login
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

// Dashboard (Server List)
app.get('/dashboard', requireAuth, async (req, res) => {
  let servers = [];
  if (db) {
    const snapshot = await db.collection('vpn_servers').get();
    servers = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  }
  res.render('dashboard', { servers });
});

// Edit Server Page
app.get('/edit/:id', requireAuth, async (req, res) => {
  if (!db) return res.send("Firebase not configured");
  const doc = await db.collection('vpn_servers').doc(req.params.id).get();
  if (!doc.exists) return res.status(404).send("Server not found");
  res.render('edit_server', { server: { id: doc.id, ...doc.data() } });
});

// Add Server Page
app.get('/add', requireAuth, (req, res) => {
  res.render('edit_server', { server: null });
});

// Save Server
app.post('/save', requireAuth, upload.single('ovpnFile'), async (req, res) => {
  if (!db) return res.send("Firebase not configured");

  const data = req.body;
  const isPlusOnly = data.isPlusOnly === 'on';

  // Extract file content if uploaded
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
    vpnUsername: data.vpnUsername,
    vpnPassword: data.vpnPassword
  };

  if (data.id) {
    await db.collection('vpn_servers').doc(data.id).update(serverData);
  } else {
    // Generate simple ID if none provided
    const id = data.countryCode.toLowerCase() + "_" + data.city.toLowerCase().replace(/\\s+/g, "");
    await db.collection('vpn_servers').doc(id).set(serverData);
  }

  res.redirect('/dashboard');
});

// Delete Server
app.get('/delete/:id', requireAuth, async (req, res) => {
  if (db) {
    await db.collection('vpn_servers').doc(req.params.id).delete();
  }
  res.redirect('/dashboard');
});

// Ad Management Page
app.get('/ads', requireAuth, async (req, res) => {
  if (!db) return res.send("Firebase not configured");

  let config = {
      bannersEnabled: true,
      interstitialOnConnect: true,
      interstitialOnDisconnect: true,
      appOpenAdsEnabled: true,
      adNetworkProvider: "AdMob"
  };

  const doc = await db.collection('app_config').doc('ads').get();
  if (doc.exists) {
      config = { ...config, ...doc.data() };
  }

  res.render('ads', { config });
});

app.post('/ads', requireAuth, async (req, res) => {
  if (!db) return res.send("Firebase not configured");
  const data = req.body;

  const config = {
      bannersEnabled: data.bannersEnabled === 'on',
      interstitialOnConnect: data.interstitialOnConnect === 'on',
      interstitialOnDisconnect: data.interstitialOnDisconnect === 'on',
      appOpenAdsEnabled: data.appOpenAdsEnabled === 'on',
      adNetworkProvider: data.adNetworkProvider || "AdMob"
  };

  await db.collection('app_config').doc('ads').set(config, { merge: true });
  res.redirect('/ads');
});

// Helper for Flags
function getFlagEmoji(countryCode) {
    if (!countryCode || countryCode.length !== 2) return "🌐";
    const codePoints = countryCode
        .toUpperCase()
        .split('')
        .map(char => 127397 + char.charCodeAt(0));
    return String.fromCodePoint(...codePoints);
}

app.listen(port, () => {
  console.log(\`Dashboard running at http://localhost:\${port}\`);
});
