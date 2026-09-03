// Template — copy to firebase-config.js (git-ignored) and fill in your own
// project's values: `firebase apps:sdkconfig WEB --project <project-id>`.
// Firebase web-app config (Console → project settings → your apps).
// Needed for the RTDB transport (rtdb-client.js) and — with the vapidKey —
// for push (build-order step 4). As long as this stays null the PWA runs
// fine over the WS relay, just without Firebase.
// authDomain must equal the ORIGIN the app is served from — same-origin keeps
// signInWithRedirect's stored state from being partitioned away (no redirect
// loop). Deriving it from location.hostname means every hosting domain is
// self-hosting: mindconnect-remote.web.app, the default …web.app, or
// …firebaseapp.com all work without swapping this file. The catch: that
// origin's /__/auth/handler must be a registered OAuth redirect URI —
// …firebaseapp.com is out of the box; a new site needs it added once in the
// Google Cloud console (APIs & Services → Credentials → the auto-created Web
// client → add https://<domain>/__/auth/handler).
const authDomain = (typeof location !== 'undefined' && location.hostname)
    ? location.hostname
    : '<project-id>.firebaseapp.com';

export const firebaseConfig = {
  apiKey: '<web-api-key>',
  authDomain,
  projectId: '<project-id>',
  databaseURL: 'https://<project-id>-default-rtdb.<region>.firebasedatabase.app',
  messagingSenderId: '<messaging-sender-id>',
  appId: '<app-id>',
};

// The home server's id in the RTDB tunnel. Codeless setup: no pairing, so
// the PWA needs to know which server to talk to. One home server → one id.
export const rtdbServerId = 'home-1';

// Web-Push VAPID key (Console → Cloud Messaging → web configuration).
export const vapidKey = null;

// For local testing against `firebase emulators:start` in ../../rtdb —
// leave null in production.
export const emulators = null;
// export const emulators = { auth: 'localhost:19099', database: 'localhost:19090' };
