// backfill-firstseen.js — Einmaliges Nachrüst-Skript: setzt players.firstSeen
// für Bestandsspieler, die vor der Einführung der Erstbesuch-Erkennung
// (controller/plugins/join.js) schon existierten.
//
// Ab jetzt setzt join.js firstSeen selbst (per $setOnInsert bei jedem neuen
// Login). Für alle vorher schon vorhandenen players-Dokumente fehlt das Feld
// -- dieses Skript schätzt es aus dem frühesten Auftauchen des Logins in
// archivRecords/monthlyRankings (chronologisch über scripts/lib/saison.js,
// damit Season-Token wie "season:Fall2020" korrekt einsortiert werden) und
// markiert die Schätzung mit firstSeenGeschaetzt:true. Spieler ganz ohne
// Archiv-Auftauchen (nur im laufenden, noch nicht archivierten Monat aktiv)
// bekommen firstSeen:null -- das unterscheidet "geprüft, unbekannt" von
// "noch nicht durch dieses Skript gelaufen" (Feld fehlt).
//
// Idempotent: nur players-Dokumente ohne firstSeen-Feld werden angefasst.
//
// Aufruf (Vorschau):   node backfill-firstseen.js --db nextcontrol_test
// Aufruf (echt):       node backfill-firstseen.js --db nextcontrol_test --live

import { MongoClient } from 'mongodb';
import { mongoUri } from './lib/mongo.js';
import { sortSchluesselFuerMonat } from './lib/saison.js';

const args = process.argv.slice(2);
function argWert(name, fallback) {
    const i = args.indexOf(`--${name}`);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const LIVE = args.includes('--live');
const DB_NAME = argWert('db', 'nextcontrol_test');

console.log(`Backfill players.firstSeen gegen DB "${DB_NAME}"${LIVE ? '  *** LIVE ***' : ' (Vorschau -- nichts wird geschrieben)'}\n`);

const client = new MongoClient(mongoUri());
await client.connect();
const db = client.db(DB_NAME);

/** Merged frühester sortSchluessel ("YYYY-MM") je Login aus einer Quelle in die Sammel-Map ein. */
function merge(fruehesterProLogin, login, monat) {
    if (!login || !monat) return;
    const sortSchluessel = sortSchluesselFuerMonat(monat);
    const bisher = fruehesterProLogin.get(login);
    if (!bisher || sortSchluessel < bisher) fruehesterProLogin.set(login, sortSchluessel);
}

try {
    const fruehesterProLogin = new Map();

    const archivRecords = await db.collection('archivRecords').find({}, { projection: { login: 1, monat: 1 } }).toArray();
    for (const r of archivRecords) merge(fruehesterProLogin, r.login, r.monat);

    const monthlyRankings = await db.collection('monthlyRankings').find({}, { projection: { monat: 1, eintraege: 1 } }).toArray();
    for (const doc of monthlyRankings) {
        for (const e of doc.eintraege ?? []) merge(fruehesterProLogin, e.login, doc.monat);
    }

    const kandidaten = await db.collection('players').find({ firstSeen: { $exists: false } }).toArray();
    if (kandidaten.length === 0) {
        console.log('Keine players-Dokumente ohne firstSeen -- nichts zu tun.');
    }

    let geschaetzt = 0, unbekannt = 0;
    for (const p of kandidaten) {
        const sortSchluessel = fruehesterProLogin.get(p.login);
        if (sortSchluessel) {
            const firstSeen = new Date(`${sortSchluessel}-01T00:00:00.000Z`);
            console.log(`${p.name ?? p.login}: firstSeen ≈ ${sortSchluessel} (geschätzt)`);
            if (LIVE) {
                await db.collection('players').updateOne({ login: p.login }, { $set: { firstSeen, firstSeenGeschaetzt: true } });
            }
            geschaetzt++;
        } else {
            console.log(`${p.name ?? p.login}: kein Archiv-Auftauchen -- firstSeen:null`);
            if (LIVE) {
                await db.collection('players').updateOne({ login: p.login }, { $set: { firstSeen: null } });
            }
            unbekannt++;
        }
    }

    console.log(`\nFertig: ${geschaetzt} geschätzt, ${unbekannt} unbekannt (firstSeen:null).${LIVE ? '' : ' (Vorschau -- --live zum Ausführen)'}`);
} finally {
    await client.close();
}
