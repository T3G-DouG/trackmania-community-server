# Bekannte Einschränkungen

## Cup-Turniersystem (Beta)
Die Turnier-Engine (`controller/lib/cup/`) ist fertig und isoliert getestet
(Phasen-KO- und Knockout-Format). Was noch fehlt bzw. nicht produktionsreif ist:
- `website/cup.html` existiert, ist aber noch nicht in der Website-Navigation
  verlinkt.
- Der separate Cup-Controller-Prozess (`CUP_MODUS=true`, eigener Dedicated
  Server für Turniere) ist in `docker-compose.yml` noch nicht als eigener
  Service abgebildet — für Beta-Tests siehe SETUP.md Abschnitt 10.
- Die Telegram-Integration ist gegen einen echten laufenden Cup noch nicht
  live-verifiziert.

## MongoDB-Treiber-Version gespalten
Der Controller nutzt `mongodb@^3.7.4` (funktional stabil, aber End-of-Life),
die `scripts/`-CLI-Tools nutzen `mongodb@^7.5.0`. Ein Upgrade des Controllers
auf Treiber v7 ist ein sinnvolles künftiges Contribution-Ticket, war für dieses
Release aber ein zu großer, nicht mehr gegen einen Live-Betrieb testbarer
Eingriff in den Kernprozess.

## Kein eigener Scheduler-Container
Wiederkehrende Aufgaben (Monatswechsel, Backup) laufen nicht als eigener
Docker-Service, sondern über Host-Cron/Aufgabenplanung, die den laufenden
Controller-Container per `docker compose exec` anspricht (siehe SETUP.md
Schritt 9). Das hält das Erstrelease einfach; ein eingebauter Scheduler-Service
ist eine mögliche künftige Erweiterung.

## Dedicated Server nicht containerisierbar
`TrackmaniaServer.exe` ist proprietäre Ubisoft/Nadeo-Software für Windows und
kann nicht in diesem Docker-Compose-Paket enthalten sein. Er muss separat
betrieben werden; der Controller-Container erreicht ihn über das Netz
(`TM_SERVER_HOST`).

## KI-Analyse-Features
Vollständig funktionsfähig, aber bewusst standardmäßig deaktiviert (`KI_AUS=true`,
`NACHRICHTEN_KI_AUS=true`), da sie echte, kostenpflichtige Aufrufe an die
Anthropic-API machen. Aktivierung erfordert einen eigenen API-Key.
