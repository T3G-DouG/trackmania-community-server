// datenLaden.js — AP15b: laedt die Rohdaten fuer kennzahlen.js aus MongoDB. Bewusst von
// der reinen Berechnung getrennt (Muster wie website/api.php: DB-Zugriff hier, Logik in
// kennzahlen.js) -- damit die Kennzahlen-Funktionen ohne DB testbar bleiben.
//
// Bekommt ein db-Handle uebergeben (kein eigener Connect) -- nutzbar sowohl aus einem
// Plugin (nc.mongoDb, spaeter AP15e) als auch aus einem Skript (scripts/analyse-lauf.js,
// spaeter AP15d), genau wie beim bestehenden Laufzeit-Einstellungen-Muster.

/**
 * @param {import('mongodb').Db} db
 * @returns {Promise<{monthlyRankings:Array, records:Array, alleRecordsMitMonat:Array, karmaEintraege:Array, spielerNamen:Map<string,string>, spielerFirstSeen:Map<string,Date|null>, wochenSnapshot:{takenAt:Date,rangliste:Array}|null, tagesberichteWoche:Array}>}
 */
export async function ladeAnalyseDaten(db) {
    const siebenTageHer = new Date();
    siebenTageHer.setDate(siebenTageHer.getDate() - 7);
    const siebenTageHerStr = siebenTageHer.toISOString().slice(0, 10);

    const [monthlyRankings, archivRecords, records, karmaEintraege, archivPlayers, players, wochenSnapshot, tagesberichteWoche] = await Promise.all([
        db.collection('monthlyRankings').find({}).toArray(),
        db.collection('archivRecords').find({}).toArray(),
        db.collection('records').find({}).toArray(),
        db.collection('karma').find({}).toArray(),
        db.collection('archivPlayers').find({}).toArray(),
        db.collection('players').find({}).toArray(),
        // Wiederverwendung des bestehenden woechentlichen Snapshots aus telegram.js
        // sendeWochenRueckblick() -- gibt der Aufsteiger/Absteiger-Analyse eine echte
        // Wochenbasis statt der sonst mitten im Monat unveraenderten Monatsbasis (siehe kennzahlen.js).
        db.collection('weeklySnapshots').findOne({ _id: 'aktuell' }),
        // Fuer berechneWochenAktivitaet() (AP17-Nachtrag) -- Tagesberichte existieren nur fuer
        // Tage MIT Aktivitaet (siehe telegram.js sendeTagesReport), daher hier bewusst kein
        // Mindest-Ergebnis-Check noetig.
        db.collection('tagesberichte').find({ datum: { $gte: siebenTageHerStr } }).sort({ datum: 1 }).toArray(),
    ]);

    // Namens-Lookup: aktuelle Namen (players) haben Vorrang vor archivierten (archivPlayers) --
    // dasselbe Muster wie spielerNamenIndex() in website/api.php.
    const spielerNamen = new Map();
    for (const p of archivPlayers) if (p.login) spielerNamen.set(p.login, p.name ?? p.login);
    for (const p of players) if (p.login) spielerNamen.set(p.login, p.name ?? p.login);

    // firstSeen (AP15a) existiert nur auf players (archivPlayers hat kein solches Feld) --
    // fuer Dossiers (AP15g) genutzt.
    const spielerFirstSeen = new Map();
    for (const p of players) if (p.login) spielerFirstSeen.set(p.login, p.firstSeen ?? null);

    const alleRecordsMitMonat = [
        ...archivRecords.map((r) => ({ login: r.login, map: r.map, time: r.time, monat: r.monat })),
        ...records.map((r) => ({ login: r.login, map: r.map, time: r.time, monat: 'live' })),
    ];

    return { monthlyRankings, records, alleRecordsMitMonat, karmaEintraege, spielerNamen, spielerFirstSeen, wochenSnapshot, tagesberichteWoche };
}
