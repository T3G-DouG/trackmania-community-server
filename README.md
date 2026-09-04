# Trackmania Community Server

[![Lizenz: GPL v3](https://img.shields.io/badge/Lizenz-GPLv3-blue.svg)](LICENSE)
[![Docker Compose](https://img.shields.io/badge/Deploy-Docker%20Compose-2496ED?logo=docker&logoColor=white)](docker-compose.yml)

Ein komplettes, selbst hostbares Paket für einen Trackmania (2020) Competition-/
Community-Server: ein Node.js-Controller (basierend auf
[nextcontrol](https://github.com/dassschaf/nextcontrol)) für Live-Auswertung,
Telegram-Bot und In-Game-Menüs, plus eine PHP-Website für Ranglisten, Archive
und Statistiken — alles gegen eine gemeinsame MongoDB-Datenbank, als
Docker-Compose-Paket startklar.

Entstanden aus einem laufenden, seit Jahren aktiven Community-Projekt.

## Features

### ✅ Kern (stabil, produktiv im Einsatz)
- **Punkte-/Hall-of-Fame-System**: fixierte Punkteformel je Kartenrang, Monats-
  und Jahresrangliste, dauerhafte Hall of Fame
- **Telegram-Bot**: Konto-Verknüpfung, Live-Benachrichtigungen bei neuen
  Rekorden, `/gap`, `/abo`, Admin-Befehle
- **Website** (10 Seiten): Live-Dashboard, Spielerstats, Monats-/Jahresarchiv,
  Hall of Fame, Voting, Analysen, Spielerprofile, Handout, Admin-Dashboard
- **Admin-Dashboard**: Laufzeit-Steuerung der Zusatzfeatures über ein eigenes
  Passwort (nicht das SuperAdmin-Passwort des Spielservers)
- **Karma-basiertes Map-Voting**: Spieler bewerten Karten in-game, Ende jedes
  Monats automatisches Telegram-Voting für die nächste Kartenauswahl
- **Live-Dashboard**: aktuelle Zeiten, Server-/Hardware-Status, Gaming-Log
- **Archiv-System**: lückenlose Monats-/Jahres-Historie, Streckenmatrix
- **In-Game-ManiaLink-Menü**: grafisches Hauptmenü inkl. Top-10-Anzeige direkt
  im Spiel

### 🧪 Beta (funktioniert, aber nicht vollständig ausgebaut)
- **Cup-Turniersystem**: Turnier-Engine (Phasen-KO, Knockout) ist fertig und
  isoliert getestet, Telegram-Integration vorhanden. Die zugehörige
  Website-Seite (`cup.html`) existiert, ist aber noch nicht in der Navigation
  verlinkt. Standardmäßig deaktiviert (`CUP_TELEGRAM_AKTIV=false`).

### 💰 Optional (eigene Kosten, standardmäßig deaktiviert)
- **KI-Analyse-Features**: automatischer wöchentlicher Analysebericht,
  KI-gestützte Renn-Kommentare und Spieler-Dossiers über die Anthropic-API.
  Braucht einen eigenen, kostenpflichtigen API-Key (`ANTHROPIC_API_KEY`) —
  standardmäßig komplett deaktiviert (`KI_AUS=true`).

## Voraussetzungen

- [Docker](https://www.docker.com/) + Docker Compose
- Ein **Trackmania (2020) Dedicated Server** (`TrackmaniaServer.exe`) —
  proprietäres Ubisoft/Nadeo-Binary, **nicht Teil dieses Repos** und nicht in
  Docker containerisierbar. Muss separat besorgt und auf demselben Rechner
  oder im selben Netz laufen; der Controller-Container erreicht ihn über
  `TM_SERVER_HOST`. Details zur Beschaffung/Einrichtung in den offiziellen
  Trackmania-Community-Ressourcen.

## Quick-Start

```bash
git clone https://github.com/T3G-DouG/trackmania-community-server.git
cd trackmania-community-server
cp .env.example .env
cp secrets.env.example /pfad/ausserhalb/des/repos/secrets.env
# .env und secrets.env ausfuellen (siehe SETUP.md)
docker compose up -d
```

Danach ist die Website unter `http://localhost:8080` erreichbar (Port über
`WEBSITE_PORT` in `.env` änderbar).

Ausführliche Schritt-für-Schritt-Anleitung: [SETUP.md](SETUP.md)
Referenz aller Konfigurationsvariablen: [CONFIGURATION.md](CONFIGURATION.md)
Bekannte Einschränkungen: [KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md)

## Screenshots

<!-- TODO: Screenshots einfügen -->

## Lizenz & Herkunft

GPL-3.0, siehe [LICENSE](LICENSE) und [NOTICE](NOTICE) für die Copyright-Zuordnung.
Der Controller basiert auf
[dassschaf/nextcontrol](https://github.com/dassschaf/nextcontrol) (GPL-3.0);
Website, Automatisierungsskripte und alle Erweiterungen des Controllers
(Punktesystem, Telegram-Bot, Archiv, Cup-System, KI-Analyse, Admin-Dashboard
u. v. m.) sind eigene Ergänzungen dieses Projekts.
