// erzeuge-legacy-jahresarchiv.js — Einmaliges Bootstrap-Skript: fasst den
// kompletten VOR August 2026 migrierten Datenbestand (archivRecords) als
// festen Alt-Jahrgang "2025/26" in yearlyRankings zusammen, damit die
// Hall of Fame künftig einheitlich aus Jahres-Einträgen besteht (statt
// direkt aus archivRecords berechnet zu werden).
//
// Aufruf (Vorschau):     node erzeuge-legacy-jahresarchiv.js --db nextcontrol_test
// Aufruf (echt, nach Cutover-Freigabe): node erzeuge-legacy-jahresarchiv.js --db nextcontrol --live

import { MongoClient } from 'mongodb';
import { mongoUri } from './lib/mongo.js';
import { berechneRanking } from './lib/punkte.js';
import { LEGACY_JAHR_LABEL } from './lib/jahreszyklus.js';

const args = process.argv.slice(2);
function argWert(name, fallback) {
    const i = args.indexOf(`--${name}`);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const LIVE = args.includes('--live');
const DB_NAME = argWert('db', 'nextcontrol_test');

console.log(`Legacy-Jahresarchiv "${LEGACY_JAHR_LABEL}" gegen DB "${DB_NAME}"${LIVE ? '  *** LIVE ***' : ' (Vorschau)'}\n`);

const client = new MongoClient(mongoUri());
await client.connect();
const db = client.db(DB_NAME);

try {
    const namen = {};
    for (const p of await db.collection('archivPlayers').find({}).toArray()) namen[p.login] = p.name;
    for (const p of await db.collection('players').find({}).toArray()) namen[p.login] = p.name;

    const records = await db.collection('archivRecords').find({}).toArray();
    const ranking = berechneRanking(records, namen);

    console.log(`${records.length} archivierte Records, ${ranking.length} Spieler.`);
    console.log('Top 5:');
    ranking.slice(0, 5).forEach((s, i) => console.log(`  ${i + 1}. ${s.name} -- ${s.punkte} Punkte`));

    if (LIVE) {
        const vorhanden = await db.collection('yearlyRankings').findOne({ jahr: LEGACY_JAHR_LABEL });
        if (vorhanden) {
            console.log(`\nEintrag für "${LEGACY_JAHR_LABEL}" existiert bereits -- wird nicht überschrieben (erst manuell löschen, falls Neuaufbau gewünscht).`);
        } else {
            await db.collection('yearlyRankings').insertOne({
                jahr: LEGACY_JAHR_LABEL,
                eintraege: ranking,
                quelle: 'archivRecords (Datenbestand vor Systemumstellung, Bootstrap)',
                frozenAt: new Date(),
            });
            console.log(`\nGeschrieben: yearlyRankings/${LEGACY_JAHR_LABEL}`);
        }
    } else {
        console.log('\n(Vorschau -- nichts geschrieben, --live zum Ausführen)');
    }
} finally {
    await client.close();
}
