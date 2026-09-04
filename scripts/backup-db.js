// backup-db.js -- Taegliches DB-Backup. Reine Mongo-Treiber-API + EJSON,
// kein mongodump-Binary noetig (Projekt-Konvention, siehe refresh-testdb.js).
//
// Schreibt pro Collection eine EJSON-Datei (erhaelt ObjectId/Date verlustfrei)
// in <out>/<db>-<Zeitstempel>/<collection>.json und loescht danach Backup-Ordner
// aelter als --tage Tage.
//
// Aufruf (Test-DB, Standard):
//   node backup-db.js
// Echt gegen die Live-DB (erst nach Bestaetigung):
//   node backup-db.js --db nextcontrol --out C:\LAN\trackma2020\backups_db --tage 14

import { MongoClient } from 'mongodb';
import { mongoUri } from './lib/mongo.js';
import { EJSON } from 'bson';
import { mkdirSync, writeFileSync, readdirSync, statSync, rmSync } from 'fs';
import { join } from 'path';

const args = process.argv.slice(2);
function argWert(name, fallback) {
    const i = args.indexOf(`--${name}`);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const DB_NAME = argWert('db', 'nextcontrol_test');
const OUT_DIR = argWert('out', join(process.cwd(), 'backups'));
const TAGE = Number(argWert('tage', '14'));

const zeitstempel = new Date().toISOString().replace(/[:.]/g, '-');
const zielOrdner = join(OUT_DIR, `${DB_NAME}-${zeitstempel}`);

console.log(`Backup von DB "${DB_NAME}" nach "${zielOrdner}" …\n`);

const client = new MongoClient(mongoUri());
await client.connect();

try {
    const db = client.db(DB_NAME);
    const collections = await db.listCollections().toArray();

    mkdirSync(zielOrdner, { recursive: true });

    for (const { name } of collections) {
        const docs = await db.collection(name).find({}).toArray();
        writeFileSync(join(zielOrdner, `${name}.json`), EJSON.stringify(docs, null, 2), 'utf8');
        console.log(`  ${name}: ${docs.length} Dokumente`);
    }

    console.log(`\nBackup abgeschlossen: ${collections.length} Collections.`);

    // ── Rotation: Backup-Ordner aelter als --tage Tage entfernen ────────────
    const grenze = Date.now() - TAGE * 24 * 60 * 60 * 1000;
    let entfernt = 0;
    let vorhanden;
    try {
        vorhanden = readdirSync(OUT_DIR, { withFileTypes: true });
    } catch {
        vorhanden = [];
    }
    for (const eintrag of vorhanden) {
        if (!eintrag.isDirectory() || !eintrag.name.startsWith(`${DB_NAME}-`)) continue;
        const pfad = join(OUT_DIR, eintrag.name);
        if (statSync(pfad).mtimeMs < grenze) {
            rmSync(pfad, { recursive: true, force: true });
            entfernt++;
            console.log(`  Rotation: entfernt ${eintrag.name}`);
        }
    }
    console.log(`Rotation abgeschlossen: ${entfernt} alte Backup-Ordner entfernt (Grenze: ${TAGE} Tage).`);
} finally {
    await client.close();
}
