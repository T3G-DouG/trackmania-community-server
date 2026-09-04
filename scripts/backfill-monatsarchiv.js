// backfill-monatsarchiv.js — Einmaliges Nachrüst-Skript: trägt in bestehende
// monthlyRankings-Dokumente die gefahrenen Strecken je Spieler
// (eintraege[].mapsGefahren) nach, rekonstruiert aus archivRecords.
//
// Die Aktivitäts-Zähler (Spielzeit/Finishes/Checkpoints/Verbindungen) sind für
// Alt-Monate NICHT rekonstruierbar — "aktivitaet"/"aktivitaetErfasst" werden
// hier bewusst NIE gesetzt; die Website zeigt dafür "Vor den Aufzeichnungen".
//
// Idempotent: Monate, deren Einträge bereits mapsGefahren haben, werden
// übersprungen. Punkte/Siege/Namen werden byte-identisch übernommen.
//
// Aufruf (Vorschau):   node backfill-monatsarchiv.js --db nextcontrol_test
// Aufruf (echt):       node backfill-monatsarchiv.js --db nextcontrol_test --live
// Einzelner Monat:     node backfill-monatsarchiv.js --monat 2026-05 --live

import { MongoClient } from 'mongodb';
import { mongoUri } from './lib/mongo.js';
import { berechneRanking } from './lib/punkte.js';

const args = process.argv.slice(2);
function argWert(name, fallback) {
    const i = args.indexOf(`--${name}`);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const LIVE = args.includes('--live');
const DB_NAME = argWert('db', 'nextcontrol_test');
const MONAT_FILTER = argWert('monat', null);

console.log(`Backfill mapsGefahren gegen DB "${DB_NAME}"${LIVE ? '  *** LIVE ***' : ' (Vorschau -- nichts wird geschrieben)'}\n`);

const client = new MongoClient(mongoUri());
await client.connect();
const db = client.db(DB_NAME);

let angereichert = 0, uebersprungen = 0, warnungen = 0;

try {
    const filter = MONAT_FILTER ? { monat: MONAT_FILTER } : {};
    const monate = await db.collection('monthlyRankings').find(filter).sort({ monat: 1 }).toArray();
    if (monate.length === 0) {
        console.log(MONAT_FILTER ? `Kein monthlyRankings-Dokument für Monat "${MONAT_FILTER}".` : 'Keine monthlyRankings-Dokumente vorhanden.');
    }

    for (const doc of monate) {
        const eintraege = doc.eintraege ?? [];

        if (eintraege.length > 0 && eintraege.every((e) => Array.isArray(e.mapsGefahren))) {
            console.log(`${doc.monat}: übersprungen (bereits angereichert).`);
            uebersprungen++;
            continue;
        }

        const records = await db.collection('archivRecords').find({ monat: doc.monat }).toArray();
        if (records.length === 0) {
            if (eintraege.length > 0) {
                console.warn(`${doc.monat}: WARNUNG -- keine archivRecords für diesen Monat, aber ${eintraege.length} Ranking-Einträge. Nicht rekonstruierbar, übersprungen.`);
                warnungen++;
            } else {
                console.log(`${doc.monat}: übersprungen (keine Einträge, keine Records).`);
            }
            uebersprungen++;
            continue;
        }

        // Gefahrene Maps je Login sammeln
        const mapsProLogin = new Map();
        for (const r of records) {
            if (!r.login || !r.map) continue;
            if (!mapsProLogin.has(r.login)) mapsProLogin.set(r.login, new Set());
            mapsProLogin.get(r.login).add(r.map);
        }

        // Plausibilität: Records müssen zum eingefrorenen Ranking passen
        const neuBerechnet = berechneRanking(records);
        const punkteNeu = new Map(neuBerechnet.map((e) => [e.login, e.punkte]));
        for (const e of eintraege) {
            if (punkteNeu.get(e.login) !== e.punkte) {
                console.warn(`${doc.monat}: WARNUNG -- Punkte-Abweichung für ${e.name} (eingefroren ${e.punkte}, aus archivRecords ${punkteNeu.get(e.login) ?? 0}). mapsGefahren wird trotzdem aus den Records übernommen.`);
                warnungen++;
            }
        }

        // Nur mapsGefahren ergänzen, alle anderen Felder unangetastet
        const neueEintraege = eintraege.map((e) => ({ ...e, mapsGefahren: [...(mapsProLogin.get(e.login) ?? [])] }));

        const zusammenfassung = neueEintraege.map((e) => `${e.name}: ${e.mapsGefahren.length}`).join(', ');
        console.log(`${doc.monat}: ${records.length} Records -> mapsGefahren (${zusammenfassung})`);
        if (LIVE) {
            await db.collection('monthlyRankings').updateOne({ monat: doc.monat }, { $set: { eintraege: neueEintraege } });
        }
        angereichert++;
    }

    console.log(`\nFertig: ${angereichert} angereichert, ${uebersprungen} übersprungen, ${warnungen} Warnungen.${LIVE ? '' : ' (Vorschau -- --live zum Ausführen)'}`);
} finally {
    await client.close();
}
