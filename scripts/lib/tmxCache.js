// tmxCache.js -- Liest/schreibt die von website/api.php angelegte Mongo-Collection
// "tmxMapInfo" als kanonischen, sprachuebergreifenden TMX-Cache (gleiches Schema:
// {_id:uid, geladenAm, gefunden, fehler, daten}). Node schreibt bewusst denselben
// vollen daten-Satz wie die PHP-Seite (siehe controller/lib/tmx.js::getMapInfoByUid),
// damit das Website-Widget durch einen Node-Schreibvorgang nicht auf ein reduziertes
// Schema degradiert wird.
//
// Bewusst ohne Abhaengigkeit zu nextcontrol.js/Plugins gehalten (wie mapVoting.js/
// kandidatenAuswahl.js), damit sich die Logik isoliert testen laesst.

import { TMX } from '../../controller/lib/tmx.js';

const TTL_FRISCH_MS = 7 * 24 * 60 * 60 * 1000; // Treffer/echter Nicht-Fund: 7 Tage
const TTL_FEHLER_MS = 60 * 60 * 1000;          // TMX-Ausfall (Negativ-Cache): 1 Stunde
const BATCH_GROESSE = 5;

/** Teilt ein Array in Haeppchen fester Groesse. */
function inBatches(liste, groesse) {
    const ergebnis = [];
    for (let i = 0; i < liste.length; i += groesse) ergebnis.push(liste.slice(i, i + groesse));
    return ergebnis;
}

/** Reduziert das volle TMX-daten-Objekt auf die fuers Scoring + die ausfuehrliche
 * Kandidaten-Beschreibung (erzeugeAusfuehrlicheBeschreibung()) benoetigten Felder. */
function projiziere(daten) {
    if (!daten) return null;
    return {
        tags: daten.tags ?? [],
        schwierigkeit: daten.schwierigkeit ?? null,
        laenge: daten.laenge ?? null,
        awards: daten.awards ?? null,
        hochgeladenAm: daten.hochgeladenAm ?? null,
    };
}

/**
 * Liefert fuer eine Liste von Map-UIDs TMX-Daten (Tags/Schwierigkeit/Laenge/Awards/Upload-Datum), cache-first
 * gegen die Collection "tmxMapInfo". Fehlende/abgelaufene Eintraege werden in kleinen
 * Batches nachgeladen und zurueckgeschrieben. Wirft NIE -- ein einzelner TMX-Fehler
 * fuehrt nur zu einem null-Eintrag fuer die betroffene UID, nie zum Abbruch.
 * @param {import('mongodb').Db} mongoDb
 * @param {String[]} uids
 * @param {Object} [optionen]
 * @param {(uid: String) => Promise<{gefunden:Boolean, fehler:Boolean, daten:Object|null}>} [optionen.holeTmxInfo] injizierbar fuer Tests
 * @param {() => Date} [optionen.jetzt] injizierbar fuer Tests
 * @param {Number} [optionen.batchGroesse]
 * @returns {Promise<Map<String, {tags:Array, schwierigkeit:Number|null, laenge:Number|null, awards:Number|null, hochgeladenAm:String|null}|null>>}
 */
export async function holeTmxDatenFuerUids(mongoDb, uids, optionen = {}) {
    const holeTmxInfo = optionen.holeTmxInfo ?? ((uid) => TMX.getMapInfoByUid(uid));
    const jetzt = optionen.jetzt ?? (() => new Date());
    const batchGroesse = optionen.batchGroesse ?? BATCH_GROESSE;

    const eindeutigeUids = [...new Set(uids.filter(Boolean))];
    const ergebnis = new Map();
    if (eindeutigeUids.length === 0) return ergebnis;

    const collection = mongoDb.collection('tmxMapInfo');
    const cacheDocs = await collection.find({ _id: { $in: eindeutigeUids } }).toArray();
    const cacheByUid = new Map(cacheDocs.map((d) => [d._id, d]));

    const nachzuladen = [];
    for (const uid of eindeutigeUids) {
        const doc = cacheByUid.get(uid);
        const frisch = doc && (jetzt().getTime() - new Date(doc.geladenAm).getTime()) < (doc.fehler ? TTL_FEHLER_MS : TTL_FRISCH_MS);
        if (frisch) {
            ergebnis.set(uid, doc.gefunden ? projiziere(doc.daten) : null);
        } else {
            nachzuladen.push(uid);
        }
    }

    for (const batch of inBatches(nachzuladen, batchGroesse)) {
        await Promise.all(batch.map(async (uid) => {
            let neuesErgebnis;
            try {
                neuesErgebnis = await holeTmxInfo(uid);
            } catch (error) {
                neuesErgebnis = { gefunden: false, fehler: true, daten: null }; // doppelte Absicherung, holeTmxInfo soll selbst nie werfen
            }

            const alterCacheDoc = cacheByUid.get(uid);
            // Stale-while-error: TMX gerade nicht erreichbar, aber ein alter Treffer vorhanden -> alte Daten weiter ausliefern
            if (neuesErgebnis.fehler && alterCacheDoc?.gefunden) {
                neuesErgebnis = { ...neuesErgebnis, gefunden: true, daten: alterCacheDoc.daten };
            }

            await collection.updateOne(
                { _id: uid },
                { $set: { geladenAm: jetzt(), gefunden: neuesErgebnis.gefunden, fehler: neuesErgebnis.fehler, daten: neuesErgebnis.daten } },
                { upsert: true }
            );

            ergebnis.set(uid, neuesErgebnis.gefunden ? projiziere(neuesErgebnis.daten) : null);
        }));
    }

    return ergebnis;
}
