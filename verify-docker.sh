#!/usr/bin/env bash
# verify-docker.sh -- eigenstaendiger Smoke-Test des Docker-Compose-Pakets.
# Braucht KEINEN echten Trackmania-Dedicated-Server: prueft nur, dass beide
# Images sauber bauen, MongoDB + Website hochkommen und der Controller-
# Container ohne Code-/Abhaengigkeitsfehler bis zum XML-RPC-Verbindungsversuch
# kommt (der Verbindungsversuch selbst schlaegt ohne echten Server erwartbar
# fehl -- das ist hier kein Fehlerfall, siehe Ausgabe unten).
#
# Aufruf: ./verify-docker.sh
# Voraussetzung: Docker + Docker Compose, aus dem Repo-Root ausgefuehrt.
set -uo pipefail
cd "$(dirname "$0")"

FEHLER=0
schritt() { echo; echo "=== $1 ==="; }
fail() { echo "FEHLGESCHLAGEN: $1"; FEHLER=1; }

schritt "0. Docker verfuegbar?"
if ! docker info >/dev/null 2>&1; then
    echo "Docker-Daemon nicht erreichbar. Docker Desktop starten bzw. Docker-Dienst pruefen."
    exit 1
fi
docker --version
docker compose version

# Wegwerf-.env/secrets.env fuer den reinen Build-/Boot-Test -- echte Werte
# sind fuer diesen Smoke-Test nicht noetig (kein echter Server, keine echten
# Telegram-Nachrichten).
schritt "1. Test-Konfiguration anlegen (temporaer, wird am Ende geloescht)"
TMP_MAPS_DIR="$(mktemp -d)"
TMP_SECRETS="$(mktemp)"
cat > "$TMP_SECRETS" <<'EOF'
SUPERADMIN_PASSWORD=test
ADMIN_LOGINS=
TELEGRAM_TOKEN=
TELEGRAM_CHAT_ID=
ADMIN_DASHBOARD_PASSWORT_HASH=
EOF
cat > .env.verify <<EOF
MONGO_DB=nextcontrol_verify
TM_SERVER_HOST=127.0.0.1
TRACKMANIA_PORT=5555
TM_USERDATA_MAPS_DIR=$TMP_MAPS_DIR
SECRETS_FILE=$TMP_SECRETS
WEBSITE_PORT=18080
KI_AUS=true
NACHRICHTEN_KI_AUS=true
CUP_TELEGRAM_AKTIV=false
EOF
echo "OK ($TMP_MAPS_DIR, $TMP_SECRETS)"

COMPOSE="docker compose --env-file .env.verify -p trackmania-verify"

aufraeumen() {
    schritt "Aufraeumen"
    $COMPOSE down -v --remove-orphans >/dev/null 2>&1
    rm -f .env.verify "$TMP_SECRETS"
    rm -rf "$TMP_MAPS_DIR"
    echo "OK"
}
trap aufraeumen EXIT

schritt "2. docker compose config (Syntax-/Interpolations-Check)"
if ! $COMPOSE config >/dev/null; then
    fail "docker compose config"
fi

schritt "3. Images bauen (controller + website)"
if ! $COMPOSE build; then
    fail "docker compose build"
fi

schritt "4. mongo + website hochfahren, Website-Erreichbarkeit pruefen"
if $COMPOSE up -d mongo website; then
    sleep 5
    if command -v curl >/dev/null 2>&1; then
        if curl -sf "http://localhost:18080/index.html" >/dev/null; then
            echo "Website antwortet."
        else
            fail "Website antwortet nicht unter http://localhost:18080/index.html"
        fi
    else
        echo "(curl nicht verfuegbar, ueberspringe HTTP-Check -- Container-Logs pruefen)"
    fi
    $COMPOSE logs --tail 30 website
else
    fail "docker compose up mongo website"
fi

schritt "5. controller starten (Verbindungsversuch OHNE echten Server erwartet zu scheitern)"
$COMPOSE up -d controller
sleep 5
LOGS="$($COMPOSE logs controller 2>&1)"
echo "$LOGS" | tail -30
if echo "$LOGS" | grep -qi "Cannot find module\|SyntaxError\|MODULE_NOT_FOUND"; then
    fail "Controller-Container hat einen Code-/Abhaengigkeitsfehler (siehe Log oben) -- das ist ein echtes Problem."
elif echo "$LOGS" | grep -qi "Could not connect to server\|ECONNREFUSED\|ETIMEDOUT"; then
    echo "Controller startet sauber und versucht die Verbindung zum Dedicated Server -- "
    echo "erwartetes Scheitern, da hier kein echter Server laeuft. Das ist KEIN Fehler dieses Tests."
else
    echo "Hinweis: Log-Muster nicht eindeutig erkannt -- Log oben manuell pruefen."
fi

echo
if [ "$FEHLER" -eq 0 ]; then
    echo "=== ERGEBNIS: Docker-Paket baut und bootet sauber. ==="
    echo "Fuer einen vollen End-to-End-Test (echte Zeiten, Telegram) zusaetzlich"
    echo "gegen einen echten (Trainings-)Dedicated-Server mit echten .env/secrets.env-Werten testen."
else
    echo "=== ERGEBNIS: Es gab Fehler, siehe FEHLGESCHLAGEN-Zeilen oben. ==="
fi
exit $FEHLER
