# Konfigurationsreferenz

Alle Umgebungsvariablen aus `.env.example` und `secrets.env.example`.

## `.env` (docker-compose.yml)

| Variable | Zweck | Default | Pflicht |
|---|---|---|---|
| `MONGO_DB` | Mongo-Datenbankname | `nextcontrol` | Nein |
| `TM_SERVER_HOST` | Host/IP, unter der der Controller-Container den Dedicated Server erreicht | `host.docker.internal` | Ja |
| `TRACKMANIA_PORT` | XML-RPC-Port des Dedicated Servers | `5555` | Nein |
| `TM_USERDATA_MAPS_DIR` | Absoluter Host-Pfad zum `UserData/Maps`-Ordner deines Dedicated Servers | — | Ja |
| `SECRETS_FILE` | Absoluter Host-Pfad zur `secrets.env` | — | Ja |
| `WEBSITE_PORT` | Lokaler Port für die Website | `8080` | Nein |
| `KI_AUS` | KI-Analyse-Features (wöchentlicher Bericht) deaktivieren | `true` | Nein |
| `NACHRICHTEN_KI_AUS` | KI-gestützte Renn-Kommentare deaktivieren | `true` | Nein |
| `CUP_TELEGRAM_AKTIV` | `/cup`-Telegram-Befehle freischalten (Beta-Feature) | `false` | Nein |

## `secrets.env` (niemals im Repo, siehe SETUP.md Schritt 5)

| Variable | Zweck | Pflicht |
|---|---|---|
| `SUPERADMIN_PASSWORD` | SuperAdmin-Passwort des Dedicated Servers | Ja |
| `ADMIN_LOGINS` | Kommagetrennte Trackmania-Logins mit Controller-Admin-Rechten | Ja (sonst keine Admins) |
| `TELEGRAM_TOKEN` | Bot-Token von @BotFather | Ja, für Telegram-Features |
| `TELEGRAM_CHAT_ID` | Chat-ID der Telegram-Gruppe | Ja, für Telegram-Features |
| `TELEGRAM_TOKEN_TEST` | Zweiter Bot-Token für Testläufe (`TELEGRAM_TEST_BOT=true`) | Nein |
| `ADMIN_DASHBOARD_PASSWORT_HASH` | `password_hash()`-Wert fürs Website-Admin-Dashboard | Ja, für das Admin-Dashboard |
| `ANTHROPIC_API_KEY` | API-Key für das optionale KI-Analyse-Feature | Nein (nur bei `KI_AUS=false`) |

## Weitere, seltener benötigte Variablen

Diese haben sinnvolle Defaults und müssen normalerweise nicht gesetzt werden;
nützlich für Entwicklung/Tests oder Sonderfälle.

| Variable | Zweck | Default |
|---|---|---|
| `MONGO_HOST` | Mongo-Host (wird von docker-compose.yml automatisch auf `mongo` gesetzt) | `localhost` |
| `TM_MAPS_DIR` | Pfad zum Maps-Ordner im Controller-Container | `/data/maps` (via docker-compose.yml) |
| `TM_MATCHSETTINGS_DIR` | Pfad zum MatchSettings-Ordner im Controller-Container | `/data/maps/MatchSettings` (via docker-compose.yml) |
| `TRACKMANIA_SECRETS_PATH` | Pfad zur secrets.env im Container | `/run/secrets/secrets.env` (via docker-compose.yml) |
| `TELEGRAM_TEST_BOT` | `true` = nutzt `TELEGRAM_TOKEN_TEST` statt `TELEGRAM_TOKEN` | `false` |
| `TELEGRAM_DRY_RUN` | `true` = Telegram-Nachrichten nur loggen, nicht senden | `false` |
| `KI_ANALYSE_MODELL` | Anthropic-Modell für die KI-Analyse | siehe `controller/settings.js` |
| `KI_DRY_RUN` | `true` = KI-Analyse simulieren statt echte API-Calls | `false` |
| `NACHRICHTEN_KI_MAX_PRO_STUNDE` | Obergrenze für KI-Renn-Kommentare pro Stunde | `300` |
| `CUP_MODUS` | Startet den Controller im separaten Cup-Modus (eigener Prozess) | `false` |
| `TM_NAECHSTER_MONAT_PFAD` | Pfad zur `naechster-monat.json` überschreiben | relativ zum Repo |
