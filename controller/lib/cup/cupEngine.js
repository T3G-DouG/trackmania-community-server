// cupEngine.js -- Cup-Turniersystem (Beta-Feature, siehe README): Turnier-Engine
// als reine State-Machine. BEWUSST OHNE nextcontrol-Import (Testbarkeitsregel,
// bestehendes Muster in controller/lib/errungenschaftenLogik.js) -- reine
// Funktionen auf Plain-Data (`cupTurniere`-Dokumentstruktur). Der
// Aufrufer (controller/plugins/cup.js) fuehrt die zurueckgegebenen
// Aktionen aus (Server-/Telegram-Kommandos) und persistiert den neuen Turnierzustand
// unveraendert in `cupTurniere`. Diese Datei selbst schreibt nie in eine Datenbank.
//
// Zustandsautomat: angekuendigt -> anmeldung -> laeuft -> siegerehrung -> beendet
// (+ abgebrochen von ueberall; pausiert als Flag waehrend laeuft).

import { holeFormat } from './formate/index.js';

export const CUP_STATUS = {
    ANGEKUENDIGT: 'angekuendigt',
    ANMELDUNG: 'anmeldung',
    LAEUFT: 'laeuft',
    SIEGEREHRUNG: 'siegerehrung',
    BEENDET: 'beendet',
    ABGEBROCHEN: 'abgebrochen',
};

export const MINDEST_TEILNEHMER = 3;

/**
 * Erzeugt ein neues, leeres cupTurniere-Dokument im Status "angekuendigt".
 * Reine Hilfsfunktion fuer Aufrufer (z.B. scripts/cup-anlegen.js) --
 * die Engine selbst verlangt keine bestimmte Erzeugungsart.
 * @param {{name:string, format:string, maps:string[], punkteProRunde?:number[], formatConfig:object, geplanterStart?:string}} eingabe
 */
export function erzeugeTurnier(eingabe, jetzt = new Date()) {
    holeFormat(eingabe.format); // wirft bei unbekanntem Format sofort, statt erst beim Start
    return {
        name: eingabe.name,
        format: eingabe.format,
        status: CUP_STATUS.ANGEKUENDIGT,
        pausiert: false,
        erstelltAm: jetzt.toISOString(),
        geplanterStart: eingabe.geplanterStart ?? null,
        abgeschlossenAm: null,
        config: {
            maps: eingabe.maps ?? [],
            punkteProRunde: eingabe.punkteProRunde ?? [10, 6, 4, 3, 2, 1],
            formatConfig: eingabe.formatConfig,
        },
        teilnehmer: [],
        verlauf: null,
        endstand: null,
        ereignisLog: [{ zeit: jetzt.toISOString(), text: `Turnier "${eingabe.name}" angelegt (Format: ${eingabe.format}).` }],
    };
}

function kopie(x) {
    return structuredClone(x);
}

function logEintrag(turnier, jetzt, text) {
    turnier.ereignisLog.push({ zeit: jetzt.toISOString(), text });
}

/**
 * Zentrale Reducer-Funktion: verarbeitet ein Ereignis gegen den aktuellen
 * Turnierzustand und liefert den neuen Zustand + auszufuehrende Aktionen. Mutiert
 * niemals das uebergebene `turnierEingabe`-Objekt.
 * @param {object} turnierEingabe cupTurniere-Dokument
 * @param {object} ereignis {typ, ...}
 * @param {Date} [jetzt]
 * @returns {{turnier: object, aktionen: Array<object>}}
 */
export function verarbeiteEreignis(turnierEingabe, ereignis, jetzt = new Date()) {
    const turnier = kopie(turnierEingabe);

    switch (ereignis.typ) {
        case 'anmeldungEroeffnen': return anmeldungEroeffnen(turnier, jetzt);
        case 'anmelden': return anmelden(turnier, ereignis, jetzt);
        case 'abmelden': return abmelden(turnier, ereignis, jetzt);
        case 'start': return starten(turnier, jetzt, false);
        case 'rundenErgebnis': return rundenErgebnis(turnier, ereignis, jetzt);
        case 'spielerGetrennt': return spielerGetrennt(turnier, ereignis, jetzt);
        case 'spielerVerbunden': return spielerVerbunden(turnier, ereignis, jetzt);
        case 'siegerehrungAbgeschlossen': return siegerehrungAbgeschlossen(turnier, jetzt);
        case 'admin': {
            // Admin-Kommandos (pause/weiter/phaseWiederholen/...) haben
            // in admin() mehrere stille No-op-Waechter (falscher Status etc.) -- ohne
            // dieses Signal meldete die Telegram-Bruecke faelschlich "Erledigt", obwohl
            // die Engine intern gar nichts getan hat. Erkennung ueber ereignisLog-Laenge:
            // jeder erfolgreiche admin()-Zweig haengt genau einen Eintrag an, jeder
            // No-op-Zweig kehrt vorher zurueck.
            const vorLaenge = turnier.ereignisLog.length;
            const ergebnis = admin(turnier, ereignis, jetzt);
            return { ...ergebnis, ohneWirkung: ergebnis.turnier.ereignisLog.length === vorLaenge };
        }
        default:
            return { turnier, aktionen: [] };
    }
}

function anmeldungEroeffnen(turnier, jetzt) {
    if (turnier.status !== CUP_STATUS.ANGEKUENDIGT) return { turnier, aktionen: [] };
    turnier.status = CUP_STATUS.ANMELDUNG;
    logEintrag(turnier, jetzt, 'Anmeldung eroeffnet.');
    return { turnier, aktionen: [{ typ: 'ansage', text: `📢 Anmeldung fuer "${turnier.name}" ist eroeffnet!`, kanal: 'telegram' }] };
}

function anmelden(turnier, ereignis, jetzt) {
    if (turnier.status !== CUP_STATUS.ANMELDUNG) return { turnier, aktionen: [] };
    const { login, name, quelle } = ereignis;
    if (turnier.teilnehmer.some((t) => t.login === login)) return { turnier, aktionen: [] }; // idempotent
    turnier.teilnehmer.push({ login, name, angemeldetAm: jetzt.toISOString(), quelle: quelle ?? 'unbekannt' });
    logEintrag(turnier, jetzt, `${name} hat sich angemeldet (${turnier.teilnehmer.length} Teilnehmer).`);
    return { turnier, aktionen: [] };
}

function abmelden(turnier, ereignis, jetzt) {
    if (turnier.status !== CUP_STATUS.ANMELDUNG) return { turnier, aktionen: [] };
    const vorher = turnier.teilnehmer.length;
    turnier.teilnehmer = turnier.teilnehmer.filter((t) => t.login !== ereignis.login);
    if (turnier.teilnehmer.length !== vorher) {
        logEintrag(turnier, jetzt, `Teilnehmer abgemeldet (${turnier.teilnehmer.length} verbleiben).`);
    }
    return { turnier, aktionen: [] };
}

function starten(turnier, jetzt, erzwungen) {
    if (turnier.status !== CUP_STATUS.ANMELDUNG) return { turnier, aktionen: [] };
    if (!erzwungen && turnier.teilnehmer.length < MINDEST_TEILNEHMER) {
        logEintrag(turnier, jetzt, `Start abgelehnt: mindestens ${MINDEST_TEILNEHMER} Teilnehmer noetig (aktuell ${turnier.teilnehmer.length}).`);
        return { turnier, aktionen: [] };
    }
    const format = holeFormat(turnier.format);
    turnier.status = CUP_STATUS.LAEUFT;
    turnier.pausiert = false;
    turnier.verlauf = format.initVerlauf(turnier);
    logEintrag(turnier, jetzt, `Turnier gestartet${erzwungen ? ' (erzwungen)' : ''} mit ${turnier.teilnehmer.length} Teilnehmern.`);
    const aktionen = [
        { typ: 'ansage', text: `🏆 Das Turnier "${turnier.name}" startet!`, kanal: 'beide' },
        { typ: 'ladeMatchSettings', phaseIndex: turnier.verlauf.phaseIndex },
    ];
    return { turnier, aktionen };
}

function rundenErgebnis(turnier, ereignis, jetzt) {
    if (turnier.status !== CUP_STATUS.LAEUFT || turnier.pausiert) return { turnier, aktionen: [] };
    const format = holeFormat(turnier.format);
    let ergebnisse = [...(ereignis.ergebnisse ?? [])];

    // Getrennte Spieler, die nicht im uebermittelten Ergebnis auftauchen, bekommen
    // automatisch den letzten Platz dieser Runde (Regel: bei Verbindungsabbruch zaehlt
    // die Runde als letzter Platz, bei Rueckkehr ist der Spieler wieder aktiv) -- gilt
    // fuer beide Formate gleich, daher hier zentral statt in jedem Format einzeln.
    const genannteLogins = new Set(ergebnisse.map((e) => e.login));
    const fehlendeGetrennte = turnier.verlauf.getrennt.filter(
        (login) => turnier.verlauf.aktivTeilnehmer.includes(login) && !genannteLogins.has(login)
    );
    if (fehlendeGetrennte.length) {
        const schlechtesterPlatz = turnier.verlauf.aktivTeilnehmer.length;
        for (const login of fehlendeGetrennte) ergebnisse.push({ login, platz: schlechtesterPlatz });
    }

    const resultat = format.verarbeiteRunde(turnier, ergebnisse, jetzt);
    turnier.verlauf = resultat.verlauf;
    turnier.verlauf.ausgeschieden.push(...resultat.ausgeschieden);

    const aktionen = [...resultat.aktionen];
    for (const a of resultat.ausgeschieden) {
        aktionen.push({ typ: 'forceSpectator', login: a.login });
        aktionen.push({ typ: 'ansage', text: `${a.name} scheidet aus (Platz ${a.endPlatz}).`, kanal: 'ingame' });
        logEintrag(turnier, jetzt, `${a.name} scheidet aus (Platz ${a.endPlatz}).`);
    }

    if (resultat.turnierAbgeschlossen) {
        const endstand = format.rangliste(turnier);
        turnier.status = CUP_STATUS.SIEGEREHRUNG;
        turnier.endstand = endstand;
        turnier.abgeschlossenAm = jetzt.toISOString();
        const sieger = endstand.find((e) => e.platz === 1);
        logEintrag(turnier, jetzt, `Turnier beendet. Sieger: ${sieger?.name ?? '?'}.`);
        aktionen.push({ typ: 'turnierBeendet', endstand });
    } else if (resultat.phaseAbgeschlossen) {
        logEintrag(turnier, jetzt, `Phase abgeschlossen, naechste Phase (Index ${resultat.naechstePhaseIndex}) beginnt.`);
        aktionen.push({ typ: 'ladeMatchSettings', phaseIndex: resultat.naechstePhaseIndex });
    } else {
        aktionen.push({ typ: 'naechsteMap' });
    }

    return { turnier, aktionen };
}

function spielerGetrennt(turnier, ereignis, jetzt) {
    if (turnier.status !== CUP_STATUS.LAEUFT) return { turnier, aktionen: [] };
    if (!turnier.verlauf.aktivTeilnehmer.includes(ereignis.login)) return { turnier, aktionen: [] };
    if (!turnier.verlauf.getrennt.includes(ereignis.login)) {
        turnier.verlauf.getrennt.push(ereignis.login);
        logEintrag(turnier, jetzt, `${ereignis.login} hat die Verbindung verloren.`);
    }
    return { turnier, aktionen: [] };
}

function spielerVerbunden(turnier, ereignis, jetzt) {
    if (turnier.status !== CUP_STATUS.LAEUFT) return { turnier, aktionen: [] };
    const warGetrennt = turnier.verlauf.getrennt.includes(ereignis.login);
    turnier.verlauf.getrennt = turnier.verlauf.getrennt.filter((l) => l !== ereignis.login);
    if (warGetrennt) logEintrag(turnier, jetzt, `${ereignis.login} ist zurueck.`);
    return { turnier, aktionen: [] };
}

function siegerehrungAbgeschlossen(turnier, jetzt) {
    if (turnier.status !== CUP_STATUS.SIEGEREHRUNG) return { turnier, aktionen: [] };
    turnier.status = CUP_STATUS.BEENDET;
    logEintrag(turnier, jetzt, 'Siegerehrung abgeschlossen, Turnier archiviert.');
    return { turnier, aktionen: [] };
}

function admin(turnier, ereignis, jetzt) {
    const { kommando, login } = ereignis;
    const format = turnier.verlauf ? holeFormat(turnier.format) : null;

    switch (kommando) {
        case 'startErzwingen':
            return starten(turnier, jetzt, true);

        case 'pause': {
            if (turnier.status !== CUP_STATUS.LAEUFT || turnier.pausiert) return { turnier, aktionen: [] };
            turnier.pausiert = true;
            logEintrag(turnier, jetzt, 'Turnier pausiert (Admin).');
            return { turnier, aktionen: [{ typ: 'ansage', text: '⏸️ Turnier pausiert.', kanal: 'beide' }] };
        }

        case 'weiter': {
            if (turnier.status !== CUP_STATUS.LAEUFT || !turnier.pausiert) return { turnier, aktionen: [] };
            turnier.pausiert = false;
            logEintrag(turnier, jetzt, 'Turnier fortgesetzt (Admin).');
            return { turnier, aktionen: [{ typ: 'ansage', text: '▶️ Turnier geht weiter.', kanal: 'beide' }] };
        }

        case 'phaseWiederholen': {
            if (turnier.status !== CUP_STATUS.LAEUFT || !format) return { turnier, aktionen: [] };
            turnier.verlauf = format.wiederholePhase(turnier);
            logEintrag(turnier, jetzt, 'Aktuelle Phase wird wiederholt (Admin).');
            return {
                turnier,
                aktionen: [
                    { typ: 'ansage', text: '🔁 Die aktuelle Phase wird wiederholt.', kanal: 'beide' },
                    { typ: 'ladeMatchSettings', phaseIndex: turnier.verlauf.phaseIndex },
                ],
            };
        }

        case 'spielerEntfernen': {
            if (turnier.status !== CUP_STATUS.LAEUFT || !format) return { turnier, aktionen: [] };
            turnier.verlauf = format.entferneSpieler(turnier, login);
            logEintrag(turnier, jetzt, `Spieler ${login} manuell entfernt (Admin).`);
            return { turnier, aktionen: [{ typ: 'forceSpectator', login }] };
        }

        case 'spielerReinholen': {
            if (turnier.status !== CUP_STATUS.LAEUFT || !format) return { turnier, aktionen: [] };
            turnier.verlauf = format.holeSpielerZurueck(turnier, login);
            logEintrag(turnier, jetzt, `Spieler ${login} manuell zurueckgeholt (Admin).`);
            return { turnier, aktionen: [] };
        }

        case 'abbruch': {
            turnier.status = CUP_STATUS.ABGEBROCHEN;
            turnier.abgeschlossenAm = jetzt.toISOString();
            logEintrag(turnier, jetzt, 'Turnier abgebrochen (Admin).');
            return { turnier, aktionen: [{ typ: 'ansage', text: '⛔ Das Turnier wurde abgebrochen.', kanal: 'beide' }] };
        }

        default:
            return { turnier, aktionen: [] };
    }
}
