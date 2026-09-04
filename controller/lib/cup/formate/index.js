// index.js -- Cup-Turniersystem (Beta-Feature): Registry der Turnier-Formate.
// Neues Format = neue Datei nach demselben Interface (initVerlauf, verarbeiteRunde,
// istPhaseZuEnde, ermittleAusscheider, rangliste, wiederholePhase, entferneSpieler,
// holeSpielerZurueck) + Eintrag hier, sonst nichts.

import { phasenKo } from './phasenKo.js';
import { knockout } from './knockout.js';

export const CUP_FORMATE = {
    [phasenKo.id]: phasenKo,
    [knockout.id]: knockout,
};

/**
 * @param {string} formatId "phasenko" | "knockout"
 * @returns {object} Format-Implementierung
 */
export function holeFormat(formatId) {
    const format = CUP_FORMATE[formatId];
    if (!format) throw new Error(`Unbekanntes Cup-Format: "${formatId}"`);
    return format;
}
