#!/usr/bin/env bash
# Sets up the Firebase side of the MindConnect Mobile Relay as far as the CLI
# allows: web app, Realtime Database instance, security rules, PWA hosting.
# Two steps stay manual (the CLI can't do them) — the script prints them at
# the end: enabling Google sign-in and downloading the service-account key.
#
# Usage:  ./setup-firebase.sh <project-id> [region]
# Example ./setup-firebase.sh my-mindconnect europe-west1
set -euo pipefail

PROJECT="${1:-}"
REGION="${2:-europe-west1}"
FB="npx -y firebase-tools"

if [[ -z "$PROJECT" ]]; then
  echo "Usage: $0 <project-id> [region]" >&2
  exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
PWA_DIR="$HERE/../pwa"

echo "▶ Projekt: $PROJECT   Region: $REGION"
$FB projects:list >/dev/null   # forces a login check

# 1. Web app (idempotent-ish: skip if one already exists)
if ! $FB apps:list --project "$PROJECT" 2>/dev/null | grep -q WEB; then
  echo "▶ Web-App anlegen …"
  $FB apps:create WEB "MindConnect PWA" --project "$PROJECT"
else
  echo "▶ Web-App existiert bereits — überspringe."
fi

echo "▶ Web-Config (in pwa/public/firebase-config.js eintragen):"
$FB apps:sdkconfig WEB --project "$PROJECT" || true

# 2. Realtime Database instance
if ! $FB database:instances:list --project "$PROJECT" 2>/dev/null | grep -q "$PROJECT-default-rtdb"; then
  echo "▶ RTDB-Instanz anlegen (interaktiv — Region $REGION wählen) …"
  ( cd "$HERE" && $FB init database --project "$PROJECT" --interactive )
else
  echo "▶ RTDB-Instanz existiert bereits — überspringe."
fi

# 3. Security rules
echo "▶ Security Rules deployen …"
( cd "$HERE" && $FB deploy --only database --project "$PROJECT" )

# 4. PWA hosting
echo "▶ PWA deployen …"
( cd "$PWA_DIR" && $FB deploy --only hosting --project "$PROJECT" )

cat <<EOF

────────────────────────────────────────────────────────────────────
✅ CLI-Teil fertig. Jetzt noch zwei Schritte in der Console:

1) Google-Login aktivieren:
   https://console.firebase.google.com/project/$PROJECT/authentication/providers
   → Sign-in method → Add new provider → Google → aktivieren → speichern

2) Service-Account-Schlüssel laden:
   https://console.firebase.google.com/project/$PROJECT/settings/serviceaccounts/adminsdk
   → „Neuen privaten Schlüssel generieren" → JSON speichern (NICHT ins Repo),
     z. B.  ~/.config/mc-relay/service-account.json

PWA:  https://$PROJECT.web.app
RTDB: https://$PROJECT-default-rtdb.$REGION.firebasedatabase.app

Danach Deine E-Mail in database.rules.json eintragen (falls noch nicht),
erneut  firebase deploy --only database  — und den Connector starten.
Details: SETUP.md
────────────────────────────────────────────────────────────────────
EOF
