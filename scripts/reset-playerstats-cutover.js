// reset-playerstats-cutover.js -- EINMALIGES Cutover-Skript.
//
// Betreiber-Entscheidung 2026-07-18: Die vor dem Cutover gesammelten Live-
// Aktivitaetsdaten (Spielzeit/Verbindungen/Finishes/Checkpoints -- sowohl die
// Lifetime-Akkumulatoren des ALTEN nextcontrol-master-Plugins als auch die
// Monats-Zaehler des neuen Controllers) werden beim Umzug verworfen. Erst ab
// dem Umzug und dem Start der Saison 26/27 sollen Aktivitaetsdaten im
// Datensatz erscheinen (siehe AKTIVITAET_SEIT_MONAT in scripts/lib/jahreszyklus.js).
//
// WICHTIG: Punkte/Siege/Maps-Historie ist davon NICHT betroffen -- die lebt
// in records/archivRecords/monthlyRankings/yearlyRankings (migriert durch
// das Migrationsskript) und bleibt vollstaendig und durchgaengig erhalten. Dieses Skript
// ruehrt NUR die Collection "playerStats" an.
//
// Setzt fuer ALLE Spieler zurueck: wins, timePlayed, connections, finishes,
// checkpoints (Lifetime) sowie timePlayedMonat/connectionsMonat/finishesMonat/
// checkpointsMonat (Monat) auf 0. Der Login bleibt erhalten (kein Datensatz
// wird geloescht), damit playerStats-Dokumente fuer bestehende Spieler nicht
// neu angelegt werden muessen.
//
// Aufruf (Vorschau):     node reset-playerstats-cutover.js --db nextcontrol_test
// Aufruf (echt, beim Cutover): node reset-playerstats-cutover.js --db nextcontrol --live

import { MongoClient } from 'mongodb';
import { mongoUri } from './lib/mongo.js';

const args = process.argv.slice(2);
function argWert(name, fallback) {
    const i = args.indexOf(`--${name}`);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const LIVE = args.includes('--live');
const DB_NAME = argWert('db', 'nextcontrol_test');

console.log(`Aktivitaets-Reset (Cutover) gegen DB "${DB_NAME}"${LIVE ? '  *** LIVE ***' : ' (Vorschau -- nichts wird geschrieben)'}\n`);

const client = new MongoClient(mongoUri());
await client.connect();
const db = client.db(DB_NAME);

try {
    const alle = await db.collection('playerStats').find({}).toArray();
    if (!alle.length) {
        console.log('Keine playerStats-Dokumente vorhanden -- nichts zu tun.');
    } else {
        const aktive = alle.filter((s) => (s.wins ?? 0) || (s.timePlayed ?? 0) || (s.connections ?? 0)
            || (s.finishes ?? 0) || (s.checkpoints ?? 0) || (s.timePlayedMonat ?? 0) || (s.connectionsMonat ?? 0)
            || (s.finishesMonat ?? 0) || (s.checkpointsMonat ?? 0));
        console.log(`${alle.length} Spieler in playerStats, ${aktive.length} davon mit vorhandenen Aktivitaetswerten:`);
        for (const s of aktive) {
            console.log(`  ${s.login}: wins=${s.wins ?? 0} timePlayed=${s.timePlayed ?? 0} connections=${s.connections ?? 0} `
                + `finishes=${s.finishes ?? 0} checkpoints=${s.checkpoints ?? 0} `
                + `(Monat: ${s.timePlayedMonat ?? 0}/${s.connectionsMonat ?? 0}/${s.finishesMonat ?? 0}/${s.checkpointsMonat ?? 0})`);
        }
        if (LIVE) {
            const ergebnis = await db.collection('playerStats').updateMany({}, { $set: {
                wins: 0, timePlayed: 0, connections: 0, finishes: 0, checkpoints: 0,
                timePlayedMonat: 0, connectionsMonat: 0, finishesMonat: 0, checkpointsMonat: 0,
            } });
            console.log(`\nZurueckgesetzt: ${ergebnis.modifiedCount} von ${alle.length} Dokumenten.`);
        }
    }
    console.log(`\n${LIVE ? 'Reset abgeschlossen.' : 'Vorschau abgeschlossen -- nichts wurde geschrieben (--live zum Ausführen).'}`);
    console.log('Hinweis: records/archivRecords/monthlyRankings/yearlyRankings (Punkte/Siege/Maps) wurden NICHT angefasst.');
} finally {
    await client.close();
}
