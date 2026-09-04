// erzeuge-map-beschreibungen.js -- Erzeugt fuer alle bisher NIE gespielten Strecken
// (Campaigns + My Maps) eine automatische Kurzbeschreibung + Metadaten und cacht sie
// in der Collection "mapBeschreibungen". telegram.js liest daraus beim Monats-Voting,
// damit das Voting nicht jedes Mal alle Kandidaten per XML-RPC abfragen muss
// und neue Kandidaten sofort eine Beschreibung haben, statt live auf GetMapInfo zu warten.
//
// Idempotent: bereits gecachte Dateien werden uebersprungen (Grundlage: normalisierter
// Dateipfad). Erneuter Lauf ergaenzt nur neu hinzugekommene Maps.
//
// Aufruf (Vorschau, zeigt nur die ersten Ergebnisse, schreibt nichts):
//   node erzeuge-map-beschreibungen.js --xmlrpc-port 5556
// Echt ausfuehren (schreibt in die DB):
//   node erzeuge-map-beschreibungen.js --db nextcontrol_test --xmlrpc-port 5556 --live

import { MongoClient } from 'mongodb';
import { mongoUri } from './lib/mongo.js';
import gbxremote from 'gbxremote';
import { listeMapDateien } from '../controller/lib/mapVoting.js';
import { normalisierePfad } from './lib/matchsettings.js';
import { erzeugeKurzbeschreibung } from './lib/kandidatenAuswahl.js';
import { secrets } from '../controller/lib/secrets.js';

const args = process.argv.slice(2);
function argWert(name, fallback) {
    const i = args.indexOf(`--${name}`);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const LIVE = args.includes('--live');
const DB_NAME = argWert('db', 'nextcontrol_test');
const XMLRPC_PORT = Number(argWert('xmlrpc-port', '5555'));

console.log(`Map-Beschreibungen erzeugen gegen DB "${DB_NAME}", XML-RPC Port ${XMLRPC_PORT}${LIVE ? '  *** LIVE ***' : ' (Vorschau -- nichts wird geschrieben)'}\n`);

const mongoClient = new MongoClient(mongoUri());
await mongoClient.connect();
const db = mongoClient.db(DB_NAME);

try {
    // -- 1. Bereits gespielte Dateien ausschliessen (wie starteMapAbstimmung() in telegram.js) --
    const gespielteDateien = new Set();
    for (const doc of await db.collection('maps').find({}).toArray()) {
        if (doc.file) gespielteDateien.add(normalisierePfad(doc.file));
    }
    for (const doc of await db.collection('archivMaps').find({}).toArray()) {
        if (doc.file) gespielteDateien.add(normalisierePfad(doc.file));
    }

    const alleKandidaten = [...listeMapDateien('Campaigns'), ...listeMapDateien('My Maps')];
    const nieGespielt = alleKandidaten.filter((f) => !gespielteDateien.has(normalisierePfad(f)));

    // -- 2. Bereits gecachte Dateien ueberspringen (idempotent) --
    const bereitsGecacht = new Set(
        (await db.collection('mapBeschreibungen').find({}, { projection: { file: 1 } }).toArray()).map((d) => d.file)
    );
    const zuErledigen = nieGespielt.filter((f) => !bereitsGecacht.has(normalisierePfad(f)));

    console.log(`${nieGespielt.length} nie gespielte Kandidaten insgesamt, ${zuErledigen.length} noch ohne Cache-Eintrag.\n`);

    if (zuErledigen.length === 0) {
        console.log('Nichts zu tun.');
    } else {
        // -- 3. Per XML-RPC GetMapInfo verbinden und alle fehlenden Kandidaten abfragen --
        const client = await verbinde(XMLRPC_PORT);

        let erledigt = 0, fehler = 0;
        const neueEintraege = [];
        for (const datei of zuErledigen) {
            try {
                const struct = await client.query('GetMapInfo', [datei]);
                const meta = {
                    file: normalisierePfad(datei),
                    uid: struct.UId,
                    name: struct.Name,
                    author: struct.Author,
                    authorNickname: struct.AuthorNickname,
                    envi: struct.Environnement,
                    mood: struct.Mood,
                    style: struct.MapStyle || '',
                    isMultilap: Boolean(struct.LapRace),
                    medals: { bronze: struct.BronzeTime, silver: struct.SilverTime, gold: struct.GoldTime, author: struct.AuthorTime },
                };
                meta.beschreibung = erzeugeKurzbeschreibung(meta);
                meta.erzeugtAm = new Date();
                neueEintraege.push(meta);
                erledigt++;
                if (erledigt <= 15 || !LIVE) console.log(`  ${meta.name} — ${meta.beschreibung}`);
            } catch (error) {
                fehler++;
                console.log(`  Fehler bei ${datei}: ${error.message}`);
            }
        }
        client.terminate?.();

        console.log(`\n${erledigt} Beschreibungen erzeugt, ${fehler} Fehler.`);

        if (LIVE && neueEintraege.length > 0) {
            for (const eintrag of neueEintraege) {
                await db.collection('mapBeschreibungen').replaceOne({ file: eintrag.file }, eintrag, { upsert: true });
            }
            console.log(`${neueEintraege.length} Eintraege in "mapBeschreibungen" gespeichert.`);
        }
    }

    console.log(`\n${LIVE ? 'Fertig.' : 'Vorschau abgeschlossen -- nichts wurde geschrieben (--live zum Ausführen).'}`);
} finally {
    await mongoClient.close();
}

process.exit(0);

/** Verbindet sich per XML-RPC mit dem Dedicated Server (Authentifizierung wie monatswechsel.js). */
function verbinde(port) {
    return new Promise((resolve, reject) => {
        const client = gbxremote.createClient(port);
        client.on('error', (e) => reject(new Error(`Verbindung zum Server (Port ${port}) fehlgeschlagen: ${e.message}`)));
        client.on('connect', async () => {
            try {
                await client.query('SetApiVersion', ['2019-03-02']);
                await client.query('Authenticate', ['SuperAdmin', secrets.SUPERADMIN_PASSWORD]);
                resolve(client);
            } catch (e) {
                reject(e);
            }
        });
    });
}
