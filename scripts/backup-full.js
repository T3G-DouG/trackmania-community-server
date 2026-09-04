// backup-full.js -- Vollstaendiges Crash-Backup nach C:\BackupSync\Trackmania.
// Sichert alles, was fuer eine Wiederherstellung noetig ist UND nicht schon
// per Git/GitHub gesichert ist (controller/, scripts/, website/, docs/ also
// nicht Teil dieses Skripts). Der Zielordner wird von einem anderen Rechner
// gespiegelt -- ueberlebt also auch einen Totalausfall dieses Rechners.
//
// Zwei Arten von Inhalten:
//  1. MongoDB (nextcontrol + nextcontrol_test): taeglich neuer, rotierender
//     EJSON-Dump ueber das bestehende backup-db.js (AP12) -- mit Historie,
//     falls ein Datenverlust/eine Korruption erst spaeter auffaellt.
//  2. Dateien (Server-Config, Maps, Replays, Secrets, SSL-Zertifikate, alte
//     Live-Website): robocopy-Spiegelung (/MIR) des jeweils aktuellen Stands --
//     keine Historie noetig, das sind keine sich unbemerkt korrumpierenden
//     Datenbanken. Grosse, jederzeit neu ladbare Nadeo-Binaries (server.exe,
//     trackma2020.eti, Campaigns, das Trackmania-Spiel selbst unter "local")
//     werden bewusst ausgelassen.
//
// Aufruf: node backup-full.js
// Taeglicher Lauf: siehe backup-full.bat + Windows-Taskplaner "Trackmania-Backup" (06:00 Uhr).
//
// Nur Lesezugriffe auf das Live-System (CLAUDE.md-Ausnahme) -- es wird nirgends
// in nextcontrol oder unter C:\LAN\trackma2020\ / C:\xampp\htdocs\trackmania\
// geschrieben, nur daraus gelesen bzw. nach C:\BackupSync\Trackmania kopiert.

import { execFileSync, spawnSync } from 'child_process';
import { mkdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ZIEL = 'C:\\BackupSync\\Trackmania';
const LOG_DATEI = join(ZIEL, 'backup.log');

mkdirSync(ZIEL, { recursive: true });

function log(zeile) {
    const eintrag = `[${new Date().toISOString()}] ${zeile}`;
    console.log(eintrag);
    appendFileSync(LOG_DATEI, eintrag + '\n', 'utf8');
}

const fehlgeschlagen = [];

function schritt(name, fn) {
    try {
        log(`Start: ${name}`);
        fn();
        log(`OK: ${name}`);
    } catch (e) {
        log(`FEHLER bei "${name}": ${e.message}`);
        fehlgeschlagen.push(name);
    }
}

function robocopyMirror(quelle, zielUnterordner, extraArgs = []) {
    const ziel = join(ZIEL, 'dateien', zielUnterordner);
    const ergebnis = spawnSync(
        'robocopy',
        [quelle, ziel, '/MIR', '/R:2', '/W:2', '/NFL', '/NDL', '/NP', ...extraArgs],
        { stdio: 'inherit' }
    );
    // robocopy-Exitcodes 0-7 sind Erfolg (Bitmaske aus "kopiert"/"extra Dateien
    // geloescht"/"Mismatch"), erst ab 8 ist es ein echter Fehler.
    if (ergebnis.status >= 8) {
        throw new Error(`robocopy-Exitcode ${ergebnis.status} (${quelle} -> ${ziel})`);
    }
}

// ── 1. MongoDB (EJSON-Dump + Rotation ueber das bestehende backup-db.js) ───
for (const db of ['nextcontrol', 'nextcontrol_test']) {
    schritt(`MongoDB "${db}"`, () => {
        execFileSync('node', ['backup-db.js', '--db', db, '--out', join(ZIEL, 'mongodb'), '--tage', '14'], {
            cwd: SCRIPT_DIR,
            stdio: 'inherit',
        });
    });
}

// ── 2. Dateien (robocopy-Spiegelung, jeweils aktueller Stand) ──────────────
const dateiQuellen = [
    ['C:\\LAN\\trackma2020\\Server\\UserData\\Config', 'server-config'],
    ['C:\\LAN\\trackma2020\\Server\\UserData\\Maps\\MatchSettings', 'match-settings'],
    ['C:\\LAN\\trackma2020\\Server\\UserData\\Maps\\My Maps', 'eigene-maps'],
    ['C:\\LAN\\trackma2020\\Server\\UserData\\Maps\\TMX', 'tmx-cache'],
    ['C:\\LAN\\trackma2020\\Server\\UserData\\Replays', 'replays'],
    ['C:\\LAN\\trackma2020\\Server\\nextcontrol-master', 'nextcontrol-master-referenz'],
    ['C:\\LAN\\trackma2020\\ssl', 'ssl'],
    ['C:\\LAN\\trackma2020\\win-acme', 'win-acme'],
    ['C:\\LAN\\trackma2020\\backups_webroot', 'backups_webroot'],
    ['C:\\xampp\\htdocs\\trackmania', 'website-live'],
];

for (const [quelle, zielUnterordner] of dateiQuellen) {
    schritt(`Dateien: ${zielUnterordner}`, () => robocopyMirror(quelle, zielUnterordner));
}

// secrets.env + lose Root-Dateien (Monats-Batches, game_start.cmd, ...) --
// alle grossen/nachladbaren Sachen (Server, Server_latest, local, ssl, ...)
// liegen als eigene Unterordner auf derselben Ebene und werden ausgeschlossen.
schritt('Dateien: trackma2020-Root (lose Dateien, inkl. secrets.env)', () => {
    robocopyMirror('C:\\LAN\\trackma2020', 'trackma2020-root', [
        '/XF', '*.eti', '*.exe', '*.7z',
        '/XD',
        'C:\\LAN\\trackma2020\\Server',
        'C:\\LAN\\trackma2020\\Server_latest',
        'C:\\LAN\\trackma2020\\local',
        'C:\\LAN\\trackma2020\\.sync',
        'C:\\LAN\\trackma2020\\backups_webroot',
        'C:\\LAN\\trackma2020\\ssl',
        'C:\\LAN\\trackma2020\\win-acme',
    ]);
});

// ── Abschluss ───────────────────────────────────────────────────────────
if (fehlgeschlagen.length) {
    log(`Backup mit ${fehlgeschlagen.length} Fehler(n) beendet: ${fehlgeschlagen.join(', ')}`);
    process.exitCode = 1;
} else {
    log('Backup vollstaendig und ohne Fehler abgeschlossen.');
}
