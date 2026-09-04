## Chat-Kommandos
Dieses Dokument listet (fast) alle Chat-Kommandos, wie sie aktuell von NextControl unterstützt werden. Es spiegelt eventuell nicht zu 100% den tatsächlichen Stand der Plugins wider.

#### Allgemeine Kommandos
Kommandos werden generell per Chat-Nachricht ausgeführt: `/kommando parameter1 parameter2 ...`.

| Kommando | Parameter | Beschreibung |
|---------|------------|-------------|
| liste | maps {filter/nichts} | Zeigt (und merkt sich) eine Liste aller Karten, die zum Filter passen (oder alle, wenn keiner angegeben ist) |
| liste | players {db/online/nichts} | Zeigt (und merkt sich) eine Liste der online Spieler (Standard, wenn kein Parameter angegeben) oder der in der Datenbank gespeicherten Spieler |
| liste | show {typ} {n} | Zeigt die n-te Seite der zuletzt abgefragten Liste. Gültige Listen sind maps, players.
| jukebox | n | Reiht die n-te Karte aus deiner letzten Kartenliste in die Jukebox ein. Erfordert vorheriges `/liste maps`. |
| rekorde | - | Zeigt die Streckenrekorde. |

Das Kommando `/liste` ist das universelle Werkzeug für Karten- und Spielerabfragen und speichert die jeweilige Liste, bis eine neue Liste derselben Kategorie abgefragt wird oder der Spieler den Server verlässt.
Listen unterschiedlicher Kategorien werden unabhängig voneinander gespeichert, eine Spielerliste überschreibt also nicht die zuvor abgefragte Kartenliste.
Zusätzlich werden die Listen für jeden Spieler einzeln gespeichert, sodass sich unterschiedliche Abfragen zweier Spieler nicht gegenseitig beeinflussen.

#### Admin-Kommandos
Admin-Kommandos werden per Chat-Nachricht in der Form `/admin kommando parameter1 parameter2 ...` ausgeführt, im Gegensatz zu den allgemeinen Kommandos.
Das eigentliche Kommando ist also nicht `/admin`, sondern das, was danach folgt.

| Kommando | Parameter | Beschreibung |
|---------|------------|-------------|
| hinzufuegen | {local/url/tmx} {Quelle} | Fügt eine Strecke zur Kartenliste hinzu und speichert die Kartenliste. Bei local den Dateipfad *relativ* zu /path/to/server/UserData/Maps/ angeben. Bei url die vollständige URL in den Chat einfügen. Bei tmx die ID der Strecke auf TMX angeben. |
| skip | - | Überspringt die aktuelle Strecke. |
| neustart | - | Startet die aktuelle Strecke neu. |
| beenden | - | Beendet NextControl. |
| jukebox | {n/clear} | Mit Parameter *n* wird die n-te Karte aus der Kartenliste an die Spitze der Jukebox gesetzt. Mit Parameter *clear* wird die Jukebox geleert. |
| modus | save | Speichert die aktuellen MatchSettings in eine Datei. |
| modus | keep | Behält die aktuellen temporären Spielmodus-Einstellungen bei, damit sie beim Streckenwechsel nicht verworfen werden |
| modus | reset | Setzt die aktuell auf dem Server angewendeten Spielmodus-Einstellungen zurück |
| modus | read | Liest die MatchSettings-Datei erneut ein. |
| verlaengern | {zeit} | Verlängert die Zeit der aktuell gespielten Strecke um die angegebene Zahl (in Sekunden) oder standardmäßig um 300 Sekunden. Einstellungen werden beim Streckenwechsel zurückgesetzt, sofern sie nicht ausdrücklich beibehalten werden sollen. Erfordert einen Spielmodus mit Zeitverlängerung (z. B. Time Attack) |
| modserzwingen | {url/save/read/reset/enable/disable} | Um einen Mod zu erzwingen, einfach die URL zum Mod als Parameter angeben. enable/disable schalten die Mod-Überschreibung einer Karte ein/aus. save/read speichern bzw. lesen die Einstellungen aus der Einstellungsdatei (`/settings/forceMods.json`) |
