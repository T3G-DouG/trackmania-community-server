// dossierKontext.js — AP15h: baut aus einem spielerDossiers-Dokument (AP15g) einen kompakten
// Faktenblock (≤ ~500 Zeichen) fuer die Rennleitung. PURE (kein DB-Zugriff, kein Date.now()) --
// der Aufrufer laedt das Dossier-Dokument bereits selbst (rennleitung.js). Liefert bei fehlendem
// oder inhaltlich leerem Dossier bewusst einen leeren String zurueck -- keine erfundenen Fakten,
// z.B. beim allerersten Besuch einer Person, deren Dossier noch (fast) nichts enthaelt.

import { stripFormatting, msToString } from '../utilities.js';

const MAX_LAENGE = 500;

/**
 * @param {object|null} dossier Dokument aus spielerDossiers (siehe controller/lib/analyse/dossier.js)
 * @param {{mapUid?: string}} [opts] mapUid: liefert bei Treffer die persoenliche Bestzeit auf GENAU dieser Strecke
 * @returns {string} Faktenblock (mehrere durch "; " getrennte Teilsaetze), oder '' wenn nichts Sinnvolles bekannt ist
 */
export function baueDossierKontext(dossier, opts = {}) {
    if (!dossier) return '';
    const zeilen = [];

    if (opts.mapUid && dossier.persoenlicheBests?.[opts.mapUid]) {
        const pb = dossier.persoenlicheBests[opts.mapUid];
        zeilen.push(`persönliche Bestzeit auf dieser Strecke: ${msToString(pb.zeit)}`);
    }

    if (dossier.kopfAnKopf?.length > 0) {
        const engste = [...dossier.kopfAnKopf].sort((a, b) => b.engeMonate - a.engeMonate)[0];
        zeilen.push(
            `liefert sich seit ${engste.engeMonate} Monat(en) enge Duelle mit ${stripFormatting(engste.gegnerName)} ` +
            `(aktueller Punkteabstand ${engste.aktuellerAbstand})`
        );
    }

    if (dossier.besteSaison?.punkte > 0 && dossier.aktuelleForm?.length > 0) {
        const aktuell = dossier.aktuelleForm[dossier.aktuelleForm.length - 1];
        if (aktuell.monat !== dossier.besteSaison.monat && (aktuell.punkte / dossier.besteSaison.punkte) >= 0.9) {
            zeilen.push(`fährt aktuell nah an die eigene bisher beste Phase heran (${dossier.besteSaison.monat})`);
        }
    }

    if (dossier.comebackNachMonaten) {
        zeilen.push(`erst kürzlich nach ${dossier.comebackNachMonaten} Monat(en) Pause zurückgekehrt`);
    }

    if (zeilen.length === 0) return '';
    const text = zeilen.join('; ');
    return text.length > MAX_LAENGE ? `${text.slice(0, MAX_LAENGE - 1)}…` : text;
}
