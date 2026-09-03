# Firebase einrichten für den MindConnect Mobile Relay

Diese Anleitung bringt die Firebase-Seite des Relays komplett zum Laufen:
ein Projekt, eine Realtime Database als Tunnel, Google-Login als Zugang, die
Security Rules, den Service-Account-Schlüssel für den Connector und die PWA
auf Firebase Hosting. Am Ende erreichst Du Deinen Agent-Server vom Handy —
ohne einen Port zuhause zu öffnen.

Was headless geht (CLI/Script) und was nur in der Console: **Projekt,
Web-App, RTDB-Instanz, Rules und Hosting** macht die Firebase CLI. **Google
als Anmeldeanbieter aktivieren** und **den Service-Account-Schlüssel
herunterladen** gehen nur in der Console (ein paar Klicks). Das Script
[`setup-firebase.sh`](setup-firebase.sh) erledigt den CLI-Teil und sagt Dir
genau, wann Du in die Console musst.

## Voraussetzungen

```bash
npm i -g firebase-tools    # oder: npx firebase-tools <cmd>
firebase login
```

## Schnellweg: das Script

```bash
cd relay/rtdb
./setup-firebase.sh mein-projekt-id europe-west1
```

Das Script legt (falls nötig) Web-App und RTDB-Instanz an, deployt die Rules
und die PWA und druckt am Ende die beiden Console-Schritte samt der fertigen
URLs. Danach nur noch die zwei Klicks unten (Google-Login + Schlüssel).

## Manueller Weg (Schritt für Schritt)

### 1. Projekt & Web-App

```bash
firebase projects:create mein-projekt-id        # oder ein bestehendes nehmen
firebase apps:create WEB "MindConnect PWA" --project mein-projekt-id
firebase apps:sdkconfig WEB --project mein-projekt-id   # zeigt die Web-Config
```

Die ausgegebene Config (`apiKey`, `projectId`, `databaseURL`,
`messagingSenderId`, `appId`) kommt in
[`../pwa/public/firebase-config.js`](../pwa/public/firebase-config.js).
`authDomain` **nicht** hart setzen — die PWA leitet sie aus der aufgerufenen
Domain ab (siehe Schritt 6).

### 2. Realtime Database

Die Default-Instanz will die CLI interaktiv anlegen:

```bash
firebase init database --project mein-projekt-id
# Region wählen (z. B. europe-west1), Rules-Datei bestätigen
```

Die Instanz-URL sieht so aus:
`https://mein-projekt-id-default-rtdb.europe-west1.firebasedatabase.app`

### 3. Security Rules deployen

Die codelose Ein-Nutzer-Variante gated den ganzen `tunnels/`-Baum auf eine
fest verdrahtete, verifizierte Google-Adresse — kein Pairing nötig
([`database.rules.json`](database.rules.json)). Trage Deine Adresse ein und:

```bash
firebase deploy --only database --project mein-projekt-id
```

> Mehrgeräte-Variante mit Pairing-Codes: siehe
> [`database.rules.multidevice.json`](database.rules.multidevice.json).

### 4. Google-Login aktivieren  ·  **Console**

[console.firebase.google.com](https://console.firebase.google.com) → Dein
Projekt → **Build → Authentication → Get started** → Reiter
**Sign-in method** → **Add new provider → Google** → aktivieren,
Support-E-Mail wählen, speichern.

Anonymous ginge auch, ist aber weniger sicher — mit Google kann sich nur ein
bekanntes Konto anmelden, und die Rules prüfen genau diese Adresse.

### 5. Service-Account-Schlüssel  ·  **Console**

**Projekteinstellungen → Dienstkonten → „Neuen privaten Schlüssel
generieren"** → JSON speichern (NICHT ins Repo!), z. B. unter
`~/.config/mc-relay/service-account.json`. Der Connector nutzt ihn, um am
Tunnel zu schreiben (er umgeht damit die Rules — das ist Absicht, die Rules
schützen nur die Geräteseite).

### 6. PWA deployen

```bash
cd ../pwa
firebase deploy --only hosting --project mein-projekt-id
```

Die PWA liegt dann unter `https://mein-projekt-id.web.app` und
`https://mein-projekt-id.firebaseapp.com`.

> **Wichtig zum Login-Flow:** `signInWithRedirect` speichert seinen Zustand
> auf `authDomain`. Wird die App von einer *anderen* Domain als `authDomain`
> geladen, partitioniert der Browser den Speicher weg → Endlos-Redirect. Die
> PWA leitet `authDomain` deshalb aus `location.hostname` ab, ist also immer
> „same-origin". Der Haken: der `/__/auth/handler` dieser Domain muss eine
> **registrierte OAuth-Redirect-URI** sein. `…firebaseapp.com` ist es ab
> Werk; die Default-`…web.app` und jede eigene Hosting-Site **nicht** — die
> brauchen den Schritt unten.

### 7. Eigene / zusätzliche Domain für den Login  ·  **Console** (optional)

Nur nötig, wenn der Login von einer anderen Domain als `…firebaseapp.com`
laufen soll (z. B. eine hübsche zweite Hosting-Site):

1. **Firebase Console → Authentication → Settings → Authorized domains** →
   die Domain hinzufügen (z. B. `mindconnect-remote.web.app`).
2. **Google Cloud Console → APIs & Services → Credentials** → den OAuth-2.0-
   Client **„Web client (auto created by Google Service)"** öffnen → unter
   **Authorized redirect URIs** hinzufügen:
   `https://<deine-domain>/__/auth/handler` → speichern, ein paar Minuten
   warten.

Ohne Schritt 2 antwortet Google mit **Fehler 400: redirect_uri_mismatch**
(„Zugriff blockiert: Die Anfrage dieser App ist ungültig").

## Der Connector

Sobald Rules und Schlüssel stehen, verbindet der Connector Deinen lokalen
Agent-Server mit dem Tunnel:

```bash
cd ../connector && npm install
SERVER_ID=home-1 \
  RTDB_URL=https://mein-projekt-id-default-rtdb.europe-west1.firebasedatabase.app \
  FIREBASE_SERVICE_ACCOUNT=~/.config/mc-relay/service-account.json \
  API_BASE=http://localhost:9092 node connector-rtdb.js
```

Oder — komfortabler — im **Admin-Launcher** unter dem Tab **Remote**
konfigurieren und starten (Java-Connector, siehe
[`../../javafx/mc-agent-remote-connector`](../../javafx/mc-agent-remote-connector)).

## Kosten

Der Spark-Free-Tier reicht für den Ein-Personen-Fall locker (RTDB 1 GB
Speicher, 10 GB Download/Monat, Hosting 10 GB). Kein Cloud Run, keine
laufenden Kosten. Identity Platform (die „große" Auth) bräuchte Billing —
der klassische Google-Anbieter aus Schritt 4 nicht.

## Checkliste

- [ ] Projekt + Web-App angelegt, Config in `pwa/public/firebase-config.js`
- [ ] RTDB-Instanz erstellt
- [ ] Deine E-Mail in `database.rules.json`, Rules deployt
- [ ] Google-Login aktiviert (Console)
- [ ] Service-Account-Schlüssel geladen (Console)
- [ ] PWA deployt
- [ ] (optional) Redirect-URI für eigene Domain registriert
- [ ] Connector läuft (CLI oder Launcher-Tab „Remote")
