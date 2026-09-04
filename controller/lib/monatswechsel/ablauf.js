// ablauf.js -- Geteilte Kernlogik des monatlichen Wechsels (archivieren, Ranking
// einfrieren, MatchSettings generieren, Server umschalten), extrahiert aus dem
// urspruenglich reinen CLI-Skript scripts/monatswechsel.js. Bewusst als reine,
// importierbare Funktion (kein Top-Level-await, kein process.exit, keine eigene
// Mongo-/XML-RPC-Verbindung) -- nutzbar sowohl vom duennen CLI-Wrapper
// (scripts/monatswechsel.js, eigene Verbindungen) als auch vom laufenden
// Controller (controller/plugins/monatswechselAutomatik.js, nutzt die bereits
// offene nextcontrol.mongoDb/nextcontrol.client-Verbindung -- KEINE zweite
// XML-RPC-Verbindung zu Port 5555 noetig).
//
// Wirft nie unbehandelt -- liefert immer ein strukturiertes Ergebnis
// { erfolgreich, schritt?, fehler?, monat?, ranking? }, damit Aufrufer (Wartungsmodus-
// Banner, Admin-UI) eine konkrete, nutzbare Fehlermeldung statt eines rohen
// Stacktraces bekommen. "schritt" benennt, wo es hakte -- siehe SCHRITTE unten.

import { writeFileSync } from 'fs';
import { join } from 'path';
import { berechneRanking } from '../../../scripts/lib/punkte.js';
import { leseAlleMatchSettings, erzeugeMatchSettingsXml, dateinameFuerMonat, MATCHSETTINGS_DIR } from '../../../scripts/lib/matchsettings.js';
import { jahresZyklusFuerMonat, fasseJahrZusammen, fasseAktivitaetZusammen, LEGACY_JAHR_LABEL, AKTIVITAET_SEIT_MONAT } from '../../../scripts/lib/jahreszyklus.js';
import { baueMapUidIndex, ermittleAktuellenMonat } from '../../../scripts/lib/mapindex.js';

/** Schritt-Codes, die ein fehlgeschlagener Ablauf im Ergebnis zurueckgeben kann. */
export const SCHRITTE = {
    EINGABE: 'eingabe',
    MONAT_UNBEKANNT: 'monatUnbekannt',
    IDEMPOTENZ: 'idempotenz',
    ARCHIV_VERIFIKATION: 'archivVerifikation',
    MATCHSETTINGS: 'matchsettings',
    SERVER_UMSCHALTUNG: 'serverUmschaltung',
    TELEGRAM: 'telegram',
};

/**
 * Fuehrt den kompletten Monatswechsel durch (oder nur die Vorschau, wenn `live:false`).
 * @param {object} optionen
 * @param {import('mongodb').Db} optionen.db
 * @param {{monat:string, maps:string[]}} optionen.naechsterMonat Eingabedaten (6 Map-Pfade + Zielmonat)
 * @param {boolean} [optionen.live] Ohne live: nur Vorschau, keine Schreibzugriffe/kein XML-RPC/kein Telegram-Versand
 * @param {string} [optionen.monatOverride] Ablaufenden Monat erzwingen statt automatisch zu erkennen
 * @param {boolean} [optionen.skipServer] XML-RPC-Umschaltung ueberspringen (nur DB)
 * @param {(methode:string, args:any[]) => Promise<any>} [optionen.query] Authentifizierte XML-RPC-Query-Funktion
 *   an den Dedicated Server -- Pflicht, sofern live && !skipServer (der Aufrufer bringt seine eigene,
 *   bereits verbundene/authentifizierte Verbindung mit, z.B. nextcontrol.client.query oder eine
 *   frisch aufgebaute gbxremote-Verbindung im CLI-Wrapper).
 * @param {(text:string) => Promise<any>} [optionen.telegramSenden] Sendet die Telegram-Ankuendigung;
 *   Pflicht, sofern live (Aufrufer entscheidet, welcher Telegram-Helfer/Bot genutzt wird).
 * @returns {Promise<{erfolgreich:boolean, schritt?:string, fehler?:string, monat?:string, ranking?:Array}>}
 */
export async function fuehreMonatswechselDurch({
    db,
    naechsterMonat,
    live = false,
    monatOverride = null,
    skipServer = false,
    query = null,
    telegramSenden = null,
}) {
    if (!naechsterMonat?.monat || !Array.isArray(naechsterMonat.maps) || naechsterMonat.maps.length !== 6) {
        return { erfolgreich: false, schritt: SCHRITTE.EINGABE, fehler: 'naechsterMonat muss { monat: "YYYY-MM", maps: [... 6 Pfade ...] } sein.' };
    }
    if (live && !skipServer && typeof query !== 'function') {
        throw new Error('fuehreMonatswechselDurch: live && !skipServer erfordert eine query-Funktion.');
    }
    if (live && typeof telegramSenden !== 'function') {
        throw new Error('fuehreMonatswechselDurch: live erfordert eine telegramSenden-Funktion.');
    }

    // -- 1. Ablaufenden Monat bestimmen --------------------------------------
    const aktuelleMaps = await db.collection('maps').find({}).toArray();
    const aktuelleRecords = await db.collection('records').find({}).toArray();
    const aktuellePlayers = await db.collection('players').find({}).toArray();

    let ablaufenderMonat = monatOverride;
    if (!ablaufenderMonat) {
        const matchSettings = leseAlleMatchSettings();
        const uidFuerMapDatei = baueMapUidIndex(aktuelleMaps);
        const liveUids = new Set(aktuelleMaps.map((m) => m.uid));
        const erg = ermittleAktuellenMonat(matchSettings, liveUids, uidFuerMapDatei);
        ablaufenderMonat = erg.monat;
        console.log(`Ablaufender Monat automatisch erkannt: ${ablaufenderMonat} (${erg.treffer}/6 Maps zugeordnet)`);
    } else {
        console.log(`Ablaufender Monat (Override): ${ablaufenderMonat}`);
    }
    if (!ablaufenderMonat) {
        return { erfolgreich: false, schritt: SCHRITTE.MONAT_UNBEKANNT, fehler: 'Konnte den ablaufenden Monat nicht automatisch bestimmen.' };
    }

    // -- 2. Ranking fuer den ablaufenden Monat berechnen ---------------------
    const archivPlayersVorher = await db.collection('archivPlayers').find({}).toArray();
    const spielerNamen = new Map();
    for (const p of archivPlayersVorher) spielerNamen.set(p.login, p.name);
    for (const p of aktuellePlayers) spielerNamen.set(p.login, p.name);
    const ranking = berechneRanking(aktuelleRecords, spielerNamen);

    // Gefahrene Strecken je Spieler an die Ranking-Eintraege haengen, damit die
    // Streckenmatrix des Monats im Archiv erhalten bleibt.
    const mapsProLogin = new Map();
    for (const r of aktuelleRecords) {
        if (!r.login || !r.map) continue;
        if (!mapsProLogin.has(r.login)) mapsProLogin.set(r.login, new Set());
        mapsProLogin.get(r.login).add(r.map);
    }
    for (const e of ranking) e.mapsGefahren = [...(mapsProLogin.get(e.login) ?? [])];

    // Aktivitaets-Snapshot: die Monats-Zaehler aus playerStats VOR dem Reset
    // sichern (auch Spieler, die verbunden waren, aber keinen Record gefahren
    // sind). Wird in Schritt 5 mit ins Monatsarchiv eingefroren.
    const statsAlle = await db.collection('playerStats').find({}).toArray();
    const aktivitaet = statsAlle
        .filter((s) => s.login && ((s.timePlayedMonat ?? 0) > 0 || (s.connectionsMonat ?? 0) > 0
            || (s.finishesMonat ?? 0) > 0 || (s.checkpointsMonat ?? 0) > 0))
        .map((s) => ({
            login: s.login,
            timePlayed: s.timePlayedMonat ?? 0,
            connections: s.connectionsMonat ?? 0,
            finishes: s.finishesMonat ?? 0,
            checkpoints: s.checkpointsMonat ?? 0,
        }));

    console.log(`\n${aktuelleRecords.length} Records auf ${aktuelleMaps.length} Maps, ${ranking.length} Spieler.`);
    console.log('Vorlaeufiges Ranking (Top 5):');
    ranking.slice(0, 5).forEach((s, i) => console.log(`  ${i + 1}. ${s.name} -- ${s.punkte} Punkte`));
    const aktSumme = aktivitaet.reduce((acc, a) => ({
        timePlayed: acc.timePlayed + a.timePlayed,
        connections: acc.connections + a.connections,
        finishes: acc.finishes + a.finishes,
        checkpoints: acc.checkpoints + a.checkpoints,
    }), { timePlayed: 0, connections: 0, finishes: 0, checkpoints: 0 });
    console.log(`Aktivitaets-Snapshot: ${aktivitaet.length} Spieler, ${aktSumme.timePlayed} min Spielzeit, `
        + `${aktSumme.finishes} Finishes, ${aktSumme.checkpoints} Checkpoints, ${aktSumme.connections} Verbindungen.`);

    // -- 3. Idempotenz-Guard gegen versehentlichen Doppellauf -----------------
    // MUSS vor dem Archivieren/der Archiv-Verifikation (Schritt 4) laufen: ist
    // dieser Monat bereits abgeschlossen (monthlyRankings existiert, records leer),
    // waeren "aktuelleRecords"/"aktuelleMaps" hier bereits leer -- die Archiv-
    // Verifikation wuerde das faelschlich als Datenverlust melden (0 Live vs. die
    // schon archivierten Zahlen), statt der eigentlich zutreffenden, freundlicheren
    // "bereits erledigt"-Meldung.
    const bereitsEingefroren = await db.collection('monthlyRankings').findOne({ monat: ablaufenderMonat });
    if (bereitsEingefroren && aktuelleRecords.length === 0) {
        return {
            erfolgreich: false,
            schritt: SCHRITTE.IDEMPOTENZ,
            monat: ablaufenderMonat,
            fehler: `monthlyRankings/${ablaufenderMonat} existiert bereits und "records" ist leer -- dieser Monat wurde offenbar schon abgeschlossen.`,
        };
    }

    // -- 4. Archivieren -------------------------------------------------------
    const archivedAt = new Date();
    console.log(`\n[Archivieren] ${aktuelleMaps.length} Maps, ${aktuelleRecords.length} Records, ${aktuellePlayers.length} Spieler -> Monat ${ablaufenderMonat}`);
    if (live) {
        for (const { _id, ...m } of aktuelleMaps) {
            await db.collection('archivMaps').replaceOne(
                { uid: m.uid, monat: ablaufenderMonat },
                { ...m, monat: ablaufenderMonat, archivedAt },
                { upsert: true }
            );
        }
        for (const { _id, ...r } of aktuelleRecords) {
            await db.collection('archivRecords').replaceOne(
                { login: r.login, map: r.map, monat: ablaufenderMonat },
                { ...r, monat: ablaufenderMonat, archivedAt },
                { upsert: true }
            );
        }
        for (const { _id, ...p } of aktuellePlayers) {
            await db.collection('archivPlayers').replaceOne(
                { login: p.login },
                { ...p, archivedAt },
                { upsert: true }
            );
        }

        // Verifikation: die soeben archivierten Zahlen MUESSEN den vorher gelesenen
        // Live-Zahlen entsprechen, BEVOR irgendetwas geleert wird (Schritt 5) -- sonst
        // Abbruch. Die Live-Daten (records/maps) sind an dieser Stelle noch komplett
        // unangetastet, ein erneuter Versuch ist also jederzeit gefahrlos moeglich.
        const archivRecordsCount = await db.collection('archivRecords').countDocuments({ monat: ablaufenderMonat });
        const archivMapsCount = await db.collection('archivMaps').countDocuments({ monat: ablaufenderMonat });
        if (archivRecordsCount !== aktuelleRecords.length || archivMapsCount !== aktuelleMaps.length) {
            return {
                erfolgreich: false,
                schritt: SCHRITTE.ARCHIV_VERIFIKATION,
                monat: ablaufenderMonat,
                fehler: `Archiv-Zahlen stimmen nicht mit den Live-Zahlen ueberein (Records: ${archivRecordsCount}/${aktuelleRecords.length}, Maps: ${archivMapsCount}/${aktuelleMaps.length}) -- records/maps wurden NICHT geleert.`,
            };
        }
        console.log(`[Archiv-Verifikation] OK -- ${archivRecordsCount} Records, ${archivMapsCount} Maps fuer ${ablaufenderMonat} bestaetigt.`);
    }

    // -- 5. Ranking + Aktivitaets-Snapshot einfrieren ---------------------------
    console.log(`[Ranking einfrieren] monthlyRankings/${ablaufenderMonat}: Sieger ${ranking[0]?.name ?? '(niemand gefahren)'} mit ${ranking[0]?.punkte ?? 0} Punkten`);

    // Aktivitaets-Snapshot nur ab AKTIVITAET_SEIT_MONAT archivieren (Betreiber-
    // Entscheidung 2026-07-18: vor dem Cutover gesammelte Aktivitaetsdaten werden
    // verworfen, unabhaengig davon, was in playerStats tatsaechlich steht -- Punkte/
    // Siege/Maps sind davon nicht betroffen). Fuer Monate davor wird das Dokument
    // ohne aktivitaet/aktivitaetErfasst geschrieben, genau wie bei den migrierten
    // Altmonaten.
    const aktivitaetGilt = /^\d{4}-\d{2}$/.test(ablaufenderMonat) && ablaufenderMonat >= AKTIVITAET_SEIT_MONAT;
    const freezeDoc = { monat: ablaufenderMonat, eintraege: ranking, frozenAt: archivedAt };
    if (aktivitaetGilt) {
        freezeDoc.aktivitaet = aktivitaet;
        freezeDoc.aktivitaetErfasst = true;
    } else {
        console.log(`  Aktivitaets-Snapshot wird NICHT archiviert (${ablaufenderMonat} liegt vor ${AKTIVITAET_SEIT_MONAT}).`);
    }
    if (live) {
        await db.collection('monthlyRankings').replaceOne({ monat: ablaufenderMonat }, freezeDoc, { upsert: true });
    }

    // -- 5b. Jahres-Zyklus abschliessen, falls dies der letzte Monat eines Jahres war --
    const zyklus = jahresZyklusFuerMonat(ablaufenderMonat);
    if (zyklus.jahr !== LEGACY_JAHR_LABEL && zyklus.ende === ablaufenderMonat) {
        console.log(`\n[Jahresarchiv] ${ablaufenderMonat} ist der letzte Monat von Jahr ${zyklus.jahr} -- fasse zusammen ...`);
        if (live) {
            const monateDesZyklus = await db.collection('monthlyRankings')
                .find({ monat: { $gte: zyklus.start, $lte: zyklus.ende } })
                .toArray();
            const jahresRanking = fasseJahrZusammen(monateDesZyklus);
            const jahresAktivitaet = fasseAktivitaetZusammen(monateDesZyklus);
            await db.collection('yearlyRankings').replaceOne(
                { jahr: zyklus.jahr },
                {
                    jahr: zyklus.jahr,
                    eintraege: jahresRanking,
                    aktivitaet: jahresAktivitaet.aktivitaet,
                    aktivitaetMonate: jahresAktivitaet.erfassteMonate,
                    monate: monateDesZyklus.map((m) => m.monat).sort(),
                    frozenAt: archivedAt,
                },
                { upsert: true }
            );
            console.log(`  Geschrieben: yearlyRankings/${zyklus.jahr} (Sieger: ${jahresRanking[0]?.name ?? '-'})`);
        } else {
            console.log('  (Vorschau -- wuerde yearlyRankings schreiben)');
        }
    }

    // -- 6. Aktuelle Collections leeren (Spieler bleiben) ----------------------
    console.log(`[Leeren] records + maps werden geleert (players bleibt erhalten)`);
    if (live) {
        await db.collection('records').deleteMany({});
        await db.collection('maps').deleteMany({});
    }

    // -- 6b. Monats-Zaehler zuruecksetzen (Lifetime-Werte bleiben unberuehrt) --
    console.log(`[Reset] playerStats Monats-Zaehler -> 0 (zuvor archiviert in monthlyRankings/${ablaufenderMonat}, Lifetime-Werte bleiben erhalten)`);
    if (live) {
        await db.collection('playerStats').updateMany({}, { $set: {
            timePlayedMonat: 0,
            connectionsMonat: 0,
            finishesMonat: 0,
            checkpointsMonat: 0,
        } });
    }

    // -- 7. Neue MatchSettings generieren ---------------------------------------
    const neuerDateiname = dateinameFuerMonat(naechsterMonat.monat);
    const xml = erzeugeMatchSettingsXml(naechsterMonat.maps);
    const zielPfad = join(MATCHSETTINGS_DIR, neuerDateiname);
    console.log(`\n[MatchSettings] Neuer Monat ${naechsterMonat.monat} -> ${neuerDateiname} (${naechsterMonat.maps.length} Maps):`);
    naechsterMonat.maps.forEach((m) => console.log(`  - ${m}`));
    if (live) {
        try {
            writeFileSync(zielPfad, xml, 'utf8');
            console.log(`  Geschrieben: ${zielPfad}`);
        } catch (error) {
            return { erfolgreich: false, schritt: SCHRITTE.MATCHSETTINGS, monat: ablaufenderMonat, fehler: `MatchSettings-Datei konnte nicht geschrieben werden: ${error.message}` };
        }
    } else {
        console.log(`  (Vorschau -- wuerde geschrieben nach ${zielPfad})`);
    }

    // -- 8. Server umschalten (LoadMatchSettings per XML-RPC) -------------------
    if (skipServer) {
        console.log('\n[Server] skipServer gesetzt, XML-RPC-Aufruf wird uebersprungen.');
    } else {
        const relativerPfad = `MatchSettings/${neuerDateiname}`;
        console.log(`\n[Server] LoadMatchSettings("${relativerPfad}")`);
        if (live) {
            try {
                await query('LoadMatchSettings', [relativerPfad]);
                console.log('  Server hat die neuen MatchSettings geladen.');
                // LoadMatchSettings ersetzt nur die Playlist fuer die NAECHSTE Karte -- die
                // aktuell laufende Karte (z.B. noch aus dem Vormonat) wird dadurch NICHT
                // unterbrochen (live beobachtet: Server blieb nach dem Monatswechsel auf der
                // alten August-Karte stehen). NextMap erzwingt den sofortigen Wechsel auf die
                // neue Rotation, gleiches Muster wie beim Cup-Phasenwechsel (cup.js).
                await query('NextMap', []);
                console.log('  Sofortiger Kartenwechsel per NextMap erzwungen.');
            } catch (error) {
                return { erfolgreich: false, schritt: SCHRITTE.SERVER_UMSCHALTUNG, monat: ablaufenderMonat, fehler: `LoadMatchSettings/NextMap fehlgeschlagen: ${error.message}` };
            }
        } else {
            console.log('  (Vorschau -- kein XML-RPC-Aufruf)');
        }
    }

    // -- 9. Telegram-Ankuendigung -------------------------------------------------
    // Vollstaendiger Endstand ALLER Spieler (nicht nur Top 3) -- Betreiber-Wunsch.
    const endstand = ranking.map((s, i) => {
        const medaille = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        return `${medaille} ${s.name} — ${s.punkte.toLocaleString('de-DE')} Punkte`;
    }).join('\n');
    const nachricht =
        `🏁 <b>Monatswechsel!</b>\n\n` +
        `📊 Endstand ${ablaufenderMonat}:\n${endstand || '(keine Zeiten gefahren)'}\n\n` +
        `🗺️ Neue Strecken für ${naechsterMonat.monat}:\n` +
        naechsterMonat.maps.map((m) => `- ${m.split('/').pop().replace('.Map.Gbx', '')}`).join('\n') +
        `\n\nViel Spaß! 🎉`;
    console.log('\n[Telegram]');
    if (live) {
        try {
            await telegramSenden(nachricht);
        } catch (error) {
            // Der Monatswechsel selbst ist zu diesem Zeitpunkt bereits vollstaendig
            // durchgelaufen (Archiv, Ranking, Server) -- ein Telegram-Fehler soll das
            // nicht als Gesamtfehlschlag melden, nur separat sichtbar sein.
            return { erfolgreich: false, schritt: SCHRITTE.TELEGRAM, monat: ablaufenderMonat, ranking, fehler: `Telegram-Ankuendigung fehlgeschlagen (Monatswechsel selbst war erfolgreich): ${error.message}` };
        }
    } else {
        console.log(`[Telegram Vorschau]\n${nachricht}\n`);
    }

    console.log(`\n${live ? 'Monatswechsel abgeschlossen.' : 'Vorschau abgeschlossen -- nichts wurde geschrieben.'}`);
    return { erfolgreich: true, monat: ablaufenderMonat, ranking };
}
