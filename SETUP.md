# Setup-Anleitung

Schritt-für-Schritt-Einrichtung eines eigenen Trackmania-Community-Servers mit
diesem Paket.

## 1. Docker installieren

[Docker Desktop](https://www.docker.com/products/docker-desktop/) (Windows/Mac)
oder Docker Engine + Docker Compose Plugin (Linux).

## 2. Repo klonen

```bash
git clone https://github.com/T3G-DouG/trackmania-community-server.git
cd trackmania-community-server
```

## 3. Trackmania Dedicated Server besorgen und starten

`TrackmaniaServer.exe` ist proprietär (Ubisoft/Nadeo) und **nicht Teil dieses
Repos**. Besorge dir eine Kopie über die offiziellen Trackmania-Kanäle und
richte einen Dedicated Server ein (Grundlagen dazu in der Trackmania-Community,
z. B. auf trackmania.io oder im offiziellen Discord).

Der Dedicated Server läuft **außerhalb** von Docker (auf demselben Rechner
oder im selben Netz wie die Container). Eine Beispiel-Config für ein separates
Cup-Turnier-Setup findest du in `scripts/vorlagen/dedicated_cfg.cup.txt` als
Ausgangspunkt — die Platzhalter (`__SERVER_IP__`, `__CUP_SUPERADMIN_PASSWORD__`,
`__CUP_ADMIN_PASSWORD__`) musst du mit echten Werten befüllen, **niemals** in
eine Datei innerhalb des Git-Repos eintragen.

Merke dir XML-RPC-Port und SuperAdmin-Passwort deines Servers — die brauchst
du in Schritt 5.

## 4. Telegram-Bot anlegen (optional, aber empfohlen)

1. Mit [@BotFather](https://t.me/BotFather) in Telegram einen neuen Bot
   erstellen, Token notieren.
2. Bot zu deiner Telegram-Gruppe hinzufügen.
3. Chat-ID der Gruppe ermitteln (z. B. über `@getidsbot` oder die Telegram-Bot-API).

## 5. secrets.env anlegen

Kopiere `secrets.env.example` an einen Ort **außerhalb** dieses Repo-Ordners
(z. B. daneben) und trage echte Werte ein:

```bash
cp secrets.env.example ../secrets.env
```

- `SUPERADMIN_PASSWORD` — das SuperAdmin-Passwort deines Dedicated Servers (Schritt 3)
- `ADMIN_LOGINS` — Trackmania-Account-Logins, die Admin-Rechte im Controller
  bekommen sollen (kommagetrennt, Login z. B. über trackmania.io/#/players ermitteln)
- `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID` — aus Schritt 4
- `ADMIN_DASHBOARD_PASSWORT_HASH` — eigenes Passwort fürs Website-Admin-Dashboard,
  als Hash: `php -r "echo password_hash('DEIN_PASSWORT', PASSWORD_DEFAULT);"`
- `ANTHROPIC_API_KEY` — nur nötig, wenn du das optionale KI-Analyse-Feature nutzen willst

## 6. .env anlegen

```bash
cp .env.example .env
```

Trage ein:
- `TM_SERVER_HOST` — wie dein Controller-Container den Dedicated Server erreicht
  (siehe Kommentar in `.env.example`)
- `TRACKMANIA_PORT` — XML-RPC-Port aus Schritt 3
- `TM_USERDATA_MAPS_DIR` — absoluter Pfad zum `UserData/Maps`-Ordner deines
  Dedicated Servers
- `SECRETS_FILE` — absoluter Pfad zur `secrets.env` aus Schritt 5
- `WEBSITE_PORT` — lokaler Port für die Website (Default 8080)

## 7. Starten

Optional vorab ein Smoke-Test ohne echten Dedicated Server und ohne echte
`.env`/`secrets.env` (baut beide Images, prueft dass Website + MongoDB
hochkommen und der Controller-Container ohne Code-/Abhaengigkeitsfehler bis
zum Verbindungsversuch kommt):

```bash
./verify-docker.sh
```

Dann echt starten:

```bash
docker compose up -d
```

Beim ersten Start baut Docker die Controller- und Website-Images (dauert
etwas). MongoDB legt seine Collections beim ersten Zugriff automatisch an.

## 8. Verifikations-Checkliste

- [ ] `docker compose logs controller` zeigt einen erfolgreichen Verbindungsaufbau
      zum Dedicated Server, keine Fehler
- [ ] Website unter `http://localhost:<WEBSITE_PORT>` erreichbar
- [ ] Eine Testfahrt auf dem Server erscheint kurz danach in der Live-Ansicht
      der Website
- [ ] Telegram-Bot antwortet auf `/start` in der Gruppe (falls eingerichtet)
- [ ] Admin-Dashboard unter `http://localhost:<WEBSITE_PORT>/admin-login.php`
      lässt sich mit dem in Schritt 5 gesetzten Passwort öffnen

## 9. Wiederkehrende Aufgaben einrichten (Host-Cron)

Einige Skripte sind für einen regelmäßigen Lauf gedacht, laufen aber bewusst
nicht als eigener Docker-Service (Einfachheit in dieser Version) — stattdessen
über die Aufgabenplanung/Cron des Host-Systems, ausgeführt im laufenden
Controller-Container:

```bash
# Monatswechsel (am Monatsanfang, siehe scripts/naechster-monat.example.json
# als Vorlage fuer scripts/naechster-monat.json)
docker compose exec controller node ../scripts/monatswechsel.js --input naechster-monat.json --live

# Taegliches Datenbank-Backup
docker compose exec controller node ../scripts/backup-db.js --db nextcontrol --out /pfad/im/container --tage 14
```

Windows: Aufgabenplanung mit einem Task, der obige Befehle periodisch ausführt.
Linux/Mac: `cron`.

## 10. Cup-Turniersystem nutzen (Beta, optional)

Siehe [KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md) für den aktuellen Stand.
Kurzfassung: `scripts/cup-anlegen.js` legt ein neues Turnier an
(`scripts/cup-vorlage.example.json` als Vorlage), `CUP_TELEGRAM_AKTIV=true`
in `.env` schaltet die `/cup`-Telegram-Befehle frei. Der eigentliche
Cup-Controller-Prozess (separater Dedicated Server, `CUP_MODUS=true`) ist in
dieser Version noch nicht in `docker-compose.yml` abgebildet — für Beta-Tests
gegen einen zweiten (Trainings-)Server manuell mit
`CUP_MODUS=true docker compose run --rm controller node .` experimentieren.
