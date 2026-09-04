// mapVoting.js — Datei-Scan-Hilfsfunktionen für die AP10-Map-Abstimmung.
// Bewusst ohne Abhängigkeit zu nextcontrol.js, damit dies isoliert testbar
// ist (ein Import von telegram.js selbst würde den kompletten Server
// hochfahren, siehe docs/SYSTEM.md AP10).

import { readdirSync } from 'fs';
import { join } from 'path';

// Per TM_MAPS_DIR uebersteuerbar, damit der Cutover auf Server_latest (siehe
// docs/SYSTEM.md) nur eine Umgebungsvariable braucht statt eines Codeeingriffs.
export const MAPS_DIR = (process.env.TM_MAPS_DIR || 'C:/LAN/trackma2020/Server/UserData/Maps').replace(/[\\/]+$/, '');

/** Alle .Map.Gbx-Dateien unter einem Ordner rekursiv auflisten (Pfad relativ zu MAPS_DIR, mit Backslashes). */
export function listeMapDateien(ordner, mapsDir = MAPS_DIR) {
    mapsDir = mapsDir.replace(/[\\/]+$/, '');
    const ergebnis = [];
    function durchsuche(pfad) {
        let eintraege;
        try { eintraege = readdirSync(pfad, { withFileTypes: true }); } catch { return; }
        for (const e of eintraege) {
            const voll = join(pfad, e.name);
            if (e.isDirectory()) durchsuche(voll);
            else if (e.name.toLowerCase().endsWith('.map.gbx')) {
                ergebnis.push(voll.slice(mapsDir.length + 1).replace(/\//g, '\\'));
            }
        }
    }
    durchsuche(join(mapsDir, ordner));
    return ergebnis;
}

/**
 * Alle .Map.Gbx-Dateien im GESAMTEN Maps-Ordner rekursiv auflisten (nicht nur
 * Campaigns + My Maps), damit neu hinzugefuegte Maps -- egal in welchem
 * Unterordner (z.B. "Downloaded" oder direkt im Root) -- automatisch als
 * Kandidaten fuer die Monatsabstimmung erkannt werden (siehe telegram.js,
 * starteMapAbstimmung()). "MatchSettings" wird ausgeschlossen, da dort nur
 * Playlist-XML-Dateien liegen, keine Maps.
 * @param {string} mapsDir Basisverzeichnis (Standard: MAPS_DIR)
 * @param {string[]} ausgeschlossen Top-Level-Ordnernamen, die uebersprungen werden (case-insensitiv)
 */
export function listeAlleMapDateien(mapsDir = MAPS_DIR, ausgeschlossen = ['MatchSettings']) {
    mapsDir = mapsDir.replace(/[\\/]+$/, '');
    const ausgeschlossenLower = new Set(ausgeschlossen.map((s) => s.toLowerCase()));
    const ergebnis = [];
    function durchsuche(pfad, istTopLevel) {
        let eintraege;
        try { eintraege = readdirSync(pfad, { withFileTypes: true }); } catch { return; }
        for (const e of eintraege) {
            if (istTopLevel && e.isDirectory() && ausgeschlossenLower.has(e.name.toLowerCase())) continue;
            const voll = join(pfad, e.name);
            if (e.isDirectory()) durchsuche(voll, false);
            else if (e.name.toLowerCase().endsWith('.map.gbx')) {
                ergebnis.push(voll.slice(mapsDir.length + 1).replace(/\//g, '\\'));
            }
        }
    }
    durchsuche(mapsDir, true);
    return ergebnis;
}
