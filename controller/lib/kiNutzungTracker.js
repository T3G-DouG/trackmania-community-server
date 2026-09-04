// kiNutzungTracker.js — AP15c: DB-Anbindung fuer das kiNutzung-Tracking. kiClient.js
// bleibt bewusst DB-frei (siehe dortiger Kommentar) -- dieses Modul haengt sich per
// setzeNutzungsTracker() ein, genau wie laufzeitEinstellungen.js einmalig aus einem
// Plugin-Konstruktor mit dem mongoDb-Handle initialisiert wird (idempotent, mehrere
// Plugins duerfen das gefahrlos alle tun).
//
// Collection kiNutzung: ein Dokument je Tag (_id:"YYYY-MM-DD"),
// { features: { <feature>: { anfragen, inputTokens, outputTokens } } } -- reine
// $inc-Upserts, macht die bisher komplett verworfenen API-Kosten erstmals sichtbar
// (siehe docs/KI-ANALYSE-PLAN.md, Befund 1).

import { logger } from './utilities.js';

let db = null;

/** Einmalig beim ersten Plugin-Start aufzurufen (idempotent). */
export function initialisiereKiNutzungTracker(mongoDb) {
    if (db) return;
    db = mongoDb;
}

function heutigerSchluessel(datum = new Date()) {
    return datum.toISOString().slice(0, 10); // "YYYY-MM-DD" (UTC -- konsistent mit MongoDB-Zeitstempeln)
}

/**
 * Erfasst eine KI-Anfrage fuer ein Feature. Wirft nie -- ein Tracking-Fehler darf niemals
 * eine Rennleitung-/Nachrichten-KI-Antwort verhindern (kiClient.js ruft das nach dem
 * Aufloesen der eigentlichen Antwort auf, nie davor).
 * @param {string} feature z.B. 'rennleitung' | 'nachrichtenKi' | 'analyse'
 * @param {number} inputTokens
 * @param {number} outputTokens
 */
export async function erfasseNutzung(feature, inputTokens, outputTokens) {
    if (!db) return; // z.B. isoliertes Testskript ohne DB-Anbindung -- stiller No-Op
    try {
        await db.collection('kiNutzung').updateOne(
            { _id: heutigerSchluessel() },
            {
                $inc: {
                    [`features.${feature}.anfragen`]: 1,
                    [`features.${feature}.inputTokens`]: inputTokens ?? 0,
                    [`features.${feature}.outputTokens`]: outputTokens ?? 0,
                },
            },
            { upsert: true }
        );
    } catch (error) {
        logger('er', `kiNutzungTracker: Fehler beim Erfassen (Feature ${feature}): ${error.message}`);
    }
}

/** Liefert das heutige kiNutzung-Dokument (oder null, falls noch keine Nutzung/keine DB). */
export async function holeHeutigeNutzung() {
    if (!db) return null;
    return db.collection('kiNutzung').findOne({ _id: heutigerSchluessel() });
}
