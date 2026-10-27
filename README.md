# VPN Admin Dashboard

A lightweight, self-hosted Node.js dashboard for managing VPN Servers and Ad Configurations for your Android VPN app via Firebase Firestore.

## Features
- **No Firebase Auth needed:** Uses simple environment-variable-based username/password login.
- **Server Management:** Add/Edit VPN servers. Includes automatic flag emoji generation based on ISO country codes.
- **.ovpn Uploads:** Directly upload `.ovpn` files. The dashboard extracts the text into memory and saves it directly to Firestore without cluttering disk space.
- **Ad Management:** Remotely toggle Banner, App Open, and Interstitial ads, and route between AdMob and Meta Audience Network without app updates.

## Local Setup

1. Run `npm install`
2. Get your Firebase Service Account key (from Firebase Console > Project Settings > Service Accounts > Generate new private key).
3. Save the downloaded JSON file into the root of this folder and name it `serviceAccountKey.json`.
4. Create a `.env` file (optional, for local testing):
   ```env
   ADMIN_USER=admin
   ADMIN_PASS=password
   SESSION_SECRET=some-random-string
   ```
5. Run `node server.js`
6. Visit `http://localhost:3000`

## Deployment to Coolify

This app is designed to be easily deployed on Coolify using Nixpacks.

1. Push this folder to a GitHub/GitLab repository.
2. In Coolify, create a new **Application** and link your repository.
3. **Important Configuration:** In the Coolify Environment Variables settings for your app, you must add the contents of your `serviceAccountKey.json` so the app can connect to Firebase.
   - To do this securely without checking the JSON file into git, you can stringify the JSON and set it as an env var (e.g., `FIREBASE_SERVICE_ACCOUNT='{ "type": "service_account"...}'`) and modify `server.js` to parse it, OR just let Coolify build it directly if you are okay with a private repo.
4. Set your `ADMIN_USER`, `ADMIN_PASS`, and `SESSION_SECRET` in the Coolify environment variables.
5. Deploy!
