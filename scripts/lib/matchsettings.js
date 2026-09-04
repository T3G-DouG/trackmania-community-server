// matchsettings.js — MatchSettings-Dateien lesen/schreiben und Monatsnamen ableiten.

import { readFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';

// Per TM_MATCHSETTINGS_DIR uebersteuerbar (gleiches Muster wie TM_MAPS_DIR in
// controller/lib/mapVoting.js), damit ein Docker-Container/anderer Host nur eine
// Umgebungsvariable statt eines Codeeingriffs braucht.
export const MATCHSETTINGS_DIR = (process.env.TM_MATCHSETTINGS_DIR || 'C:/LAN/trackma2020/Server/UserData/Maps/MatchSettings').replace(/[\\/]+$/, '');

const MONATE = {
    januar: 1, februar: 2, maerz: 3, märz: 3, april: 4, mai: 5, juni: 6,
    juli: 7, august: 8, september: 9, oktober: 10, november: 11, dezember: 12,
};
const MONATSNAMEN = [
    null, 'Januar', 'Februar', 'Maerz', 'April', 'Mai', 'Juni',
    'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

/**
 * Monatskennung ("2026-08") -> Dateiname im Stil der bestehenden Dateien ("August26.txt").
 * @param {string} monat
 */
export function dateinameFuerMonat(monat) {
    const [jahr, monatNr] = monat.split('-');
    return `${MONATSNAMEN[Number(monatNr)]}${jahr.slice(2)}.txt`;
}

/**
 * Dateiname → Monatskennung.
 * "Juli26.txt" → "2026-07", "Fall2022.txt" → "season:Fall2022",
 * sonstige (Training, example) → null.
 */
export function monatAusDateiname(dateiname) {
    const name = basename(dateiname, '.txt');
    const m = name.toLowerCase().match(/^([a-zäö]+)(\d{2})$/);
    if (m && MONATE[m[1]]) {
        return `20${m[2]}-${String(MONATE[m[1]]).padStart(2, '0')}`;
    }
    if (/^(Spring|Summer|Fall|Winter)\d{4}$/i.test(name)) {
        return `season:${name}`;
    }
    return null;
}

/** Map-Dateipfad normalisieren für den Abgleich MatchSettings ⇄ Mongo (Slashes, Kleinschreibung). */
export function normalisierePfad(p) {
    return p.replace(/\\/g, '/').trim().toLowerCase();
}

/**
 * Erzeugt den MatchSettings-XML-Inhalt fuer einen Monat -- gleiches Muster
 * wie die bestehenden Dateien (TimeAttack, 900s Zeitlimit).
 * @param {string[]} mapDateien Map-Dateipfade relativ zu UserData/Maps (z.B. "Campaigns/Fall 2022/Fall 2022 - 07.Map.Gbx")
 * @returns {string}
 */
export function erzeugeMatchSettingsXml(mapDateien) {
    const mapZeilen = mapDateien.map((f) => `  <map><file>${f.replace(/\//g, '\\')}</file></map>`).join('\n');
    return `<?xml version="1.0" encoding="utf-8" ?>
<playlist>
  <gameinfos>
    <game_mode>0</game_mode>
    <script_name>Trackmania/TM_TimeAttack_Online</script_name>
  </gameinfos>
  <startindex>0</startindex>
  <mode_script_settings>
    <setting name="S_TimeLimit" type="integer" value="900"/>
  </mode_script_settings>

${mapZeilen}

</playlist>
`;
}

/**
 * Erzeugt MatchSettings-XML fuer eine Cup-Phase (TM_Rounds_Online) -- AP14b, siehe
 * docs/CUP-PLAN.md. Rein additiv, `erzeugeMatchSettingsXml` (TimeAttack, Monats-
 * wechsel) bleibt unangetastet. `punkteProRunde` ist die EIGENE Rundenpunkte-Tabelle
 * eines Cup-Turniers (`cupTurniere.config.punkteProRunde`) -- niemals die fixierte
 * Monats-Punkteformel aus `scripts/lib/punkte.js`.
 * @param {string[]} mapDateien Map-Dateipfade relativ zu UserData/Maps
 * @param {object} [optionen]
 * @param {string} [optionen.scriptName='Trackmania/TM_Rounds_Online']
 * @param {object} [optionen.modeSettings]
 * @param {number[]} [optionen.modeSettings.punkteProRunde=[10,6,4,3,2,1]] Platz 1..n einer Runde -> Punkte
 * @param {number} [optionen.modeSettings.rundenProMap=4] S_RoundsPerMap
 * @param {number} [optionen.modeSettings.finishTimeout=10] S_FinishTimeout (Sekunden Wartezeit nach dem Fuehrenden)
 * @param {number} [optionen.modeSettings.warmUpNb=0] S_WarmUpNb
 * @returns {string}
 */
export function erzeugeCupMatchSettingsXml(mapDateien, optionen = {}) {
    const scriptName = optionen.scriptName ?? 'Trackmania/TM_Rounds_Online';
    const modeSettings = optionen.modeSettings ?? {};
    const punkteProRunde = modeSettings.punkteProRunde ?? [10, 6, 4, 3, 2, 1];
    const rundenProMap = modeSettings.rundenProMap ?? 4;
    const finishTimeout = modeSettings.finishTimeout ?? 10;
    const warmUpNb = modeSettings.warmUpNb ?? 0;

    const mapZeilen = mapDateien.map((f) => `  <map><file>${f.replace(/\//g, '\\')}</file></map>`).join('\n');
    return `<?xml version="1.0" encoding="utf-8" ?>
<playlist>
  <gameinfos>
    <game_mode>0</game_mode>
    <script_name>${scriptName}</script_name>
  </gameinfos>
  <startindex>0</startindex>
  <mode_script_settings>
    <setting name="S_PointsLimit" type="integer" value="-1"/>
    <setting name="S_RoundsPerMap" type="integer" value="${rundenProMap}"/>
    <setting name="S_FinishTimeout" type="integer" value="${finishTimeout}"/>
    <setting name="S_PointsRepartition" type="text" value="${punkteProRunde.join(',')}"/>
    <setting name="S_WarmUpNb" type="integer" value="${warmUpNb}"/>
  </mode_script_settings>

${mapZeilen}

</playlist>
`;
}

/**
 * Alle MatchSettings-Dateien parsen.
 * @returns {Array<{datei:string, monat:string, mapDateien:string[]}>}
 *          mapDateien = normalisierte Map-Pfade; nur Dateien mit erkennbarem Monat/Season.
 */
export function leseAlleMatchSettings(dir = MATCHSETTINGS_DIR) {
    const ergebnis = [];
    for (const datei of readdirSync(dir)) {
        if (!datei.toLowerCase().endsWith('.txt')) continue;
        const monat = monatAusDateiname(datei);
        if (!monat) continue;
        const xml = readFileSync(join(dir, datei), 'utf8');
        const mapDateien = [...xml.matchAll(/<file>(.*?)<\/file>/gs)].map((m) =>
            normalisierePfad(m[1])
        );
        ergebnis.push({ datei, monat, mapDateien });
    }
    return ergebnis;
}
