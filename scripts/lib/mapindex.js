// mapindex.js -- Baut einen Index Map-Dateipfad -> uid aus Mongo-Map-Dokumenten
// und findet darüber den "aktuellen" Monat (den, dessen MatchSettings-Datei am
// besten zu den gerade aktiven Maps passt). Geteilte Logik für migrate.js und
// monatswechsel.js.

import { normalisierePfad } from './matchsettings.js';

/**
 * @param {Array<{uid:string, file?:string}>} mapsDocs
 * @returns {(mapDatei:string) => string|null} uidFuerMapDatei(pfad)
 */
export function baueMapUidIndex(mapsDocs) {
    const uidNachDatei = new Map();
    const uidNachBasename = new Map();
    for (const m of mapsDocs) {
        if (!m.file) continue;
        const pfad = normalisierePfad(m.file);
        uidNachDatei.set(pfad, m.uid);
        const base = pfad.split('/').pop();
        uidNachBasename.set(base, uidNachBasename.has(base) && uidNachBasename.get(base) !== m.uid ? null : m.uid);
    }
    return (mapDatei) => uidNachDatei.get(mapDatei) ?? uidNachBasename.get(mapDatei.split('/').pop()) ?? null;
}

/**
 * Ermittelt, welche MatchSettings-Datei am besten zu den aktuell aktiven
 * Live-Maps passt (= der laufende Monat).
 * @param {Array<{datei:string, monat:string, mapDateien:string[]}>} matchSettings
 * @param {Set<string>} liveUids
 * @param {(mapDatei:string) => string|null} uidFuerMapDatei
 * @returns {{monat: string|null, treffer: number}}
 */
export function ermittleAktuellenMonat(matchSettings, liveUids, uidFuerMapDatei) {
    let monat = null;
    let besteTreffer = 0;
    for (const ms of matchSettings) {
        const treffer = ms.mapDateien.filter((f) => liveUids.has(uidFuerMapDatei(f))).length;
        if (treffer > besteTreffer) {
            besteTreffer = treffer;
            monat = ms.monat;
        }
    }
    return { monat, treffer: besteTreffer };
}
