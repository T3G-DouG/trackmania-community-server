// dossierRefresh.js — AP15g: DB-Anbindung fuer dossier.js (bewusst getrennt von der puren
// Berechnung, Muster wie berichtLauf.js zu kennzahlen.js). Schreibt/liest die Collection
// `spielerDossiers`. Wirft NIE unbehandelt (kein globaler unhandledRejection-Handler im
// Controller, siehe errungenschaften.js) -- jede Exportfunktion faengt DB-Fehler selbst ab.

import { logger } from '../utilities.js';
import { ladeAnalyseDaten } from './datenLaden.js';
import { baueDossier } from './dossier.js';

const COLLECTION = 'spielerDossiers';

/** Baut + speichert das Dossier eines einzelnen Logins. Wirft bei DB-Fehlern (Aufrufer entscheidet). */
async function schreibeDossier(db, login, daten) {
    const dossier = baueDossier(login, daten);
    const aktualisiertAm = new Date();
    await db.collection(COLLECTION).replaceOne(
        { _id: login },
        { _id: login, ...dossier, aktualisiertAm },
        { upsert: true }
    );
    return { ...dossier, aktualisiertAm };
}

/**
 * Aktualisiert die Dossiers ALLER bekannten Spieler (players + archivPlayers). Fuer den
 * naechtlichen Tick (AP15e). Ein Fehler bei einem einzelnen Login bricht die anderen nicht ab.
 * @param {import('mongodb').Db} db
 * @returns {Promise<{aktualisiert: number, fehlgeschlagen: number}>}
 */
export async function aktualisiereAlleDossiers(db) {
    const daten = await ladeAnalyseDaten(db);
    let aktualisiert = 0, fehlgeschlagen = 0;
    for (const login of daten.spielerNamen.keys()) {
        try {
            await schreibeDossier(db, login, daten);
            aktualisiert++;
        } catch (error) {
            fehlgeschlagen++;
            logger('er', `dossierRefresh: Dossier fuer ${login} fehlgeschlagen: ${error.message}`);
        }
    }
    return { aktualisiert, fehlgeschlagen };
}

/**
 * Aktualisiert das Dossier EINES Logins, sofern es fehlt oder aelter als `maxAlterMs` ist --
 * fuer den on-demand-Refresh in rennleitung.js onPlayerConnect.
 * @param {import('mongodb').Db} db
 * @param {string} login
 * @param {number} [maxAlterMs] Default 24h
 * @returns {Promise<object>} das (ggf. unveraendert gelassene) Dossier-Dokument
 */
export async function holeDossierFallsAktuellGenug(db, login, maxAlterMs = 24 * 60 * 60 * 1000) {
    const vorhanden = await db.collection(COLLECTION).findOne({ _id: login });
    if (vorhanden && Date.now() - new Date(vorhanden.aktualisiertAm).getTime() < maxAlterMs) {
        return vorhanden;
    }
    const daten = await ladeAnalyseDaten(db);
    return schreibeDossier(db, login, daten);
}

/**
 * True, wenn der naechtliche Dossier-Refresh (~04:00) jetzt faellig ist -- DB-basiert (juengstes
 * `aktualisiertAm` ueber alle Dossiers), kein In-Memory-Zustand, ueberlebt jeden Neustart
 * (Muster wie automatikTakt.js).
 * @param {import('mongodb').Db} db
 * @param {Date} [jetzt]
 */
export async function istNaechtlicherRefreshFaellig(db, jetzt = new Date()) {
    if (jetzt.getHours() !== 4) return false;
    const neuester = await db.collection(COLLECTION)
        .find({}, { projection: { aktualisiertAm: 1 } })
        .sort({ aktualisiertAm: -1 })
        .limit(1)
        .toArray();
    if (neuester.length === 0) return true;
    const stundenSeitLetztemRefresh = (jetzt.getTime() - new Date(neuester[0].aktualisiertAm).getTime()) / (60 * 60 * 1000);
    return stundenSeitLetztemRefresh >= 20; // grosszuegige Marge unter 24h, damit ein 04:xx-Tick nie ausfaellt
}
