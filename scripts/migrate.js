// migrate.js — Einmalige Migration: Archiv-Daten monats-zuordenbar machen und
// Monats-Rankings (monthlyRankings) aus der Historie berechnen.
//
// Standard-Ziel ist die TEST-DB. Gegen die echte DB nur mit --live (Cutover).
//   node migrate.js                 → nextcontrol_test
//   node migrate.js --live          → nextcontrol (nur beim Cutover!)
//
// Idempotent: mehrfache Läufe ändern nichts mehr.

import { MongoClient } from 'mongodb';
import { mongoUri } from './lib/mongo.js';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { berechneRanking } from './lib/punkte.js';
import { leseAlleMatchSettings, normalisierePfad } from './lib/matchsettings.js';

const LIVE = process.argv.includes('--live');
const DB_NAME = LIVE ? 'nextcontrol' : 'nextcontrol_test';
const projektRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const client = new MongoClient(mongoUri());
await client.connect();
const db = client.db(DB_NAME);
console.log(`Migration gegen DB "${DB_NAME}"${LIVE ? '  *** LIVE ***' : ' (Test)'}\n`);

try {
    // ── 1. Map→Monat-Mapping aus den MatchSettings-Dateien ──────────────────
    const matchSettings = leseAlleMatchSettings();
    const alleMaps = [
        ...(await db.collection('maps').find({}).toArray()),
        ...(await db.collection('archivMaps').find({}).toArray()),
    ];
    const uidNachDatei = new Map(); // normalisierter Dateipfad → uid
    const uidNachBasename = new Map(); // nur Dateiname → uid (Fallback; null bei Kollision)
    const nameNachUid = new Map();
    for (const m of alleMaps) {
        nameNachUid.set(m.uid, m.name);
        if (!m.file) continue;
        const pfad = normalisierePfad(m.file);
        uidNachDatei.set(pfad, m.uid);
        // Fallback über den reinen Dateinamen — Mongo kennt z.T. andere Ordner
        // (z.B. Campaigns\CurrentQuarterly\…) als die MatchSettings.
        const base = pfad.split('/').pop();
        uidNachBasename.set(base, uidNachBasename.has(base) && uidNachBasename.get(base) !== m.uid ? null : m.uid);
    }
    const uidFuerMapDatei = (mapDatei) =>
        uidNachDatei.get(mapDatei) ?? uidNachBasename.get(mapDatei.split('/').pop()) ?? null;

    const monateNachUid = new Map(); // uid → Set<monat>
    const unaufgeloest = new Map(); // MatchSettings-Datei → Anzahl nicht auflösbarer Maps
    for (const ms of matchSettings) {
        for (const mapDatei of ms.mapDateien) {
            const uid = uidFuerMapDatei(mapDatei);
            if (!uid) {
                unaufgeloest.set(ms.datei, (unaufgeloest.get(ms.datei) ?? 0) + 1);
                continue;
            }
            if (!monateNachUid.has(uid)) monateNachUid.set(uid, new Set());
            monateNachUid.get(uid).add(ms.monat);
        }
    }

    // Aktuellen (laufenden) Monat bestimmen: der Monat, dessen MatchSettings die
    // Maps der Live-Collection `maps` enthält — Archiv-Records können nicht aus
    // dem laufenden Monat stammen.
    const liveUids = new Set((await db.collection('maps').find({}).toArray()).map((m) => m.uid));
    let aktuellerMonat = null;
    let besteTreffer = 0;
    for (const ms of matchSettings) {
        const treffer = ms.mapDateien.filter((f) => liveUids.has(uidFuerMapDatei(f))).length;
        if (treffer > besteTreffer) {
            besteTreffer = treffer;
            aktuellerMonat = ms.monat;
        }
    }
    console.log(`Aktueller (laufender) Monat: ${aktuellerMonat} (${besteTreffer}/6 Live-Maps zugeordnet)`);

    // Monat je uid wählen: echte Monate vor Seasons, neuester zuerst,
    // laufender Monat ausgeschlossen. Mehrdeutigkeiten werden je Map einmal protokolliert.
    const mehrdeutig = new Map(); // uid → {name, kandidaten, gewaehlt}
    const monatFuerUid = (uid) => {
        const kandidaten = [...(monateNachUid.get(uid) ?? [])].filter((m) => m !== aktuellerMonat);
        if (kandidaten.length === 0) return null;
        const echte = kandidaten.filter((m) => !m.startsWith('season:')).sort().reverse();
        const gewaehlt = echte[0] ?? kandidaten.sort().reverse()[0];
        if (kandidaten.length > 1 && !mehrdeutig.has(uid)) {
            mehrdeutig.set(uid, { name: nameNachUid.get(uid), kandidaten, gewaehlt });
        }
        return gewaehlt;
    };

    // ── 2. Archiv-Collections um monat + archivedAt ergänzen (idempotent) ───
    const archivedAt = new Date();
    // "unbekannt" gilt als noch nicht zugeordnet — so greifen verbesserte
    // Zuordnungsregeln auch bei einem erneuten Lauf.
    const nochOffen = { $or: [{ monat: { $exists: false } }, { monat: 'unbekannt' }] };
    let mapsGesetzt = 0;
    for (const m of await db.collection('archivMaps').find(nochOffen).toArray()) {
        const monat = monatFuerUid(m.uid);
        await db.collection('archivMaps').updateOne(
            { _id: m._id },
            { $set: { monat: monat ?? 'unbekannt', archivedAt } }
        );
        mapsGesetzt++;
    }

    let recordsGesetzt = 0;
    const uidsOhneMonat = new Map();
    for (const r of await db.collection('archivRecords').find(nochOffen).toArray()) {
        const monat = monatFuerUid(r.map);
        if (!monat) uidsOhneMonat.set(r.map, (uidsOhneMonat.get(r.map) ?? 0) + 1);
        await db.collection('archivRecords').updateOne(
            { _id: r._id },
            { $set: { monat: monat ?? 'unbekannt', archivedAt } }
        );
        recordsGesetzt++;
    }
    // archivPlayers: Spieler sind monatsunabhängig — nur archivedAt.
    await db.collection('archivPlayers').updateMany(
        { archivedAt: { $exists: false } },
        { $set: { archivedAt } }
    );
    console.log(`archivMaps: ${mapsGesetzt} neu bestempelt, archivRecords: ${recordsGesetzt} neu bestempelt`);

    // ── 3. monthlyRankings berechnen ─────────────────────────────────────────
    const spielerNamen = new Map();
    for (const p of await db.collection('archivPlayers').find({}).toArray())
        spielerNamen.set(p.login, p.name);
    for (const p of await db.collection('players').find({}).toArray())
        spielerNamen.set(p.login, p.name); // aktuelle Namen gewinnen

    const archivRecords = await db.collection('archivRecords').find({}).toArray();
    const proMonat = new Map();
    for (const r of archivRecords) {
        const monat = r.monat ?? 'unbekannt';
        if (!proMonat.has(monat)) proMonat.set(monat, []);
        proMonat.get(monat).push(r);
    }

    let rankingsNeu = 0;
    for (const [monat, records] of [...proMonat.entries()].sort()) {
        const eintraege = berechneRanking(records, spielerNamen);
        const vorhanden = await db.collection('monthlyRankings').findOne({ monat });
        if (vorhanden && JSON.stringify(vorhanden.eintraege) === JSON.stringify(eintraege)) continue;
        await db.collection('monthlyRankings').replaceOne(
            { monat },
            { monat, eintraege, frozenAt: vorhanden?.frozenAt ?? new Date() },
            { upsert: true }
        );
        rankingsNeu++;
        console.log(
            `  ${monat}: ${records.length} Records, Sieger: ${eintraege[0]?.name} (${eintraege[0]?.punkte} Pkt.)`
        );
    }
    console.log(`monthlyRankings: ${rankingsNeu} Monate geschrieben/aktualisiert\n`);

    // ── 4. Hall-of-Fame-Validierung (Algorithmus der alten Website) ─────────
    const liveRecords = await db.collection('records').find({}).toArray();
    const hof = berechneRanking([...archivRecords, ...liveRecords], spielerNamen);
    console.log('Hall of Fame (Archiv + aktueller Monat) — mit alter Website abgleichen:');
    for (const [i, s] of hof.entries()) {
        console.log(
            `  ${String(i + 1).padStart(2)}. ${s.name.padEnd(20)} ${String(s.punkte).padStart(6)} Pkt.  Maps: ${String(s.mapsGespielt).padStart(3)}  Siege: ${String(s.siege).padStart(3)}`
        );
    }

    // ── 5. Bericht schreiben ─────────────────────────────────────────────────
    const ohneMonat = await db.collection('archivRecords').countDocuments({ monat: 'unbekannt' });
    const zeilen = [
        '# Migrations-Bericht / Mehrdeutigkeiten',
        '',
        `Lauf: ${new Date().toISOString()} gegen DB \`${DB_NAME}\``,
        `Aktueller (ausgeschlossener) Monat: ${aktuellerMonat}`,
        '',
        `## Mehrdeutige Map-Zuordnungen (${mehrdeutig.size} Maps) — bitte prüfen`,
        'Normalfall: Monats-Maps stammen aus alten Season-Kampagnen und stehen daher zusätzlich',
        'in einer Season-Datei. Der echte Monat gewinnt — nur ungewöhnliche Fälle sind relevant.',
        '',
        ...[...mehrdeutig.entries()].map(
            ([uid, m]) => `- **${m.name}** (\`${uid}\`): Kandidaten ${m.kandidaten.join(', ')} → gewählt **${m.gewaehlt}**`
        ),
        '',
        `## Nicht auflösbare MatchSettings-Einträge (Maps ohne Mongo-Eintrag, i.d.R. nie gefahren)`,
        ...[...unaufgeloest.entries()].map(([datei, n]) => `- ${datei}: ${n} Maps`),
        '',
        `## archivRecords ohne Monatszuordnung: ${ohneMonat}`,
        ...(ohneMonat > 0
            ? [...uidsOhneMonat.entries()].map(
                  ([uid, n]) => `- ${nameNachUid.get(uid) ?? '?'} (\`${uid}\`): ${n} Records`
              )
            : []),
        '',
    ];
    const berichtPfad = join(projektRoot, 'migration-ambiguities.md');
    writeFileSync(berichtPfad, zeilen.join('\n'), 'utf8');
    console.log(`\nBericht: ${berichtPfad}`);
    console.log(`archivRecords ohne Monat: ${ohneMonat}, mehrdeutige Maps: ${mehrdeutig.size}, MS-Dateien mit fehlenden Maps: ${unaufgeloest.size}`);
} finally {
    await client.close();
}
