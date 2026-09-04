// sentence bank
import { Settings } from '../settings.js';

const prefix = '~~'

const   info    = '$ff0' + prefix + ' $z$s$fff',
        warning = '$fa0' + prefix + ' $z$s$fff',
        error   = '$f00' + prefix + ' $z$s$fff',
        priv = '$0af' + prefix + ' $z$s$fff';

export const Sentences = {

    startupFinished: info + 'NextControl wurde erfolgreich gestartet.',
    shuttingDown: info + 'NextControl wird beendet...',

    playerConnect: info + '$ff0%player%$z$s$fff hat den Server betreten.',
    adminConnect: info + 'Admin $ff0%player%$z$s$fff hat den Server betreten.',
    playerDisconnect: info + '$ff0%player%$z$s$fff hat den Server verlassen.',

    playerNotAdmin: warning + 'Du hast keine Rechte, um Admin-Kommandos auszuführen!',

    errorMessage: error + '%error%',

    admin : {
        restart: info + '$ff0%name%$z$s$fff startet die aktuelle Strecke neu.',
        skip: info + '$ff0%name%$z$s$fff überspringt die aktuelle Strecke.',
        replay: info + '$ff0%name%$z$s$fff reiht die aktuelle Strecke zur Wiederholung ein.',
        extend: info + '$ff0%name%$z$s$fff verlängert die Zeit der aktuellen Strecke.',

        added: info + '$ff0%name%$z$s$fff hat $ff0%map%$z$s$fff zur Streckenliste hinzugefügt.',
        addedTmx: info + '$ff0%name%$z$s$fff hat $ff0%map%$z$s$fff von $7f7TMX$fff zur Streckenliste hinzugefügt.',
        addedUrl: info + '$ff0%name%$z$s$fff hat $ff0%map%$z$s$fff von einer URL zur Streckenliste hinzugefügt.',
        addedLocal: info + '$ff0%name%$z$s$fff hat die lokale Strecke $ff0%map%$z$s$fff zur Streckenliste hinzugefügt.',
        addTmxFailedInvalidID : warning + 'Ungültige ID.',
        addLocalFailedInvalidPth : warning + 'Ungültiger Pfad.',
        invalidParams: warning + 'Ungültige Parameter.',

        removed: info + '$ff0%name%$z$s$fff hat $ff0%map%$z$s$fff aus der Streckenliste entfernt.',

        extended: info + '$ff0%name%$z$s$fff hat die Zeit der aktuellen Strecke um $ff0%time%$fff Sekunden verlängert.',
        cannotExtend: error + 'Dieser Spielmodus unterstützt keine Zeitverlängerung.',
        extendError: error + 'Beim Verlängern der Zeit ist ein Fehler aufgetreten. Bitte die Logs prüfen.',
        settingsSaved: priv + 'Einstellungen erfolgreich gespeichert.',
        settingsRead: priv + 'Einstellungen erfolgreich eingelesen.',
        settingsReset: priv + 'Einstellungen erfolgreich zurückgesetzt.',
        settingsSet: priv + 'Eine Einstellung wurde erfolgreich geändert.',
        settingsKept: priv + 'Einstellungen werden beim Streckenwechsel nicht auf Standard zurückgesetzt.',

        forceMod: {
            applied: priv + 'Mod erfolgreich angewendet, Änderungen sind ab der nächsten Strecke sichtbar.',
            reset: priv + 'Ab der nächsten Strecke werden wieder die Standard-Mods angezeigt.',
            overrideOn: priv + 'Mod-Erzwingung für Strecken aktiviert.',
            overrideOff: priv + 'Mod-Erzwingung für Strecken deaktiviert.',
            saved: priv + 'Einstellungen in Datei gespeichert.',
            read: priv + 'Einstellungen aus Datei eingelesen.',
            invalid: warning + 'Ungültige Parameter. Gültige Parameter sind: save, read, enable, disable, reset und eine URL zu einem Mod.'
        },


        requiresList: warning + 'Du benötigst zuerst eine Liste von %type%, bevor du das tun kannst.'
    },

    jukebox : {
        hasQueued: info + '$ff0%name%$z$s$fff hat $ff0%map%$z$s$fff in die Jukebox aufgenommen.',
        nextMapIs: info + 'Nächste Strecke ist $ff0%map%$z$s$fff, gewünscht von $ff0%name%$fff$z$s.',
        leftSkipWish: info + 'Jukebox-Strecke $ff0%map%$z$s$fff übersprungen, da $ff0%name%$z$s$fff den Server verlassen hat.',
        priorityAdd: info + '$ff0%name%$z$s$fff hat $ff0%map%$z$s$fff als nächste Strecke gesetzt.',
        cleared: info + '$ff0%name%$z$s$fff hat die Jukebox geleert.',

        requiresList: warning + 'Um eine Strecke in die Jukebox zu geben, zuerst $i/liste maps$i nutzen, um eine Liste von Strecken zu erhalten.',
        requiresId: warning + 'Um eine Strecke in die Jukebox zu geben, muss die Nummer der gewünschten Strecke aus deiner letzten Streckenliste angegeben werden.',
        invalidNumber: warning + 'Ungültige Streckennummer.',
        invalidIndex: warning + 'Ungültige Streckennummer: Mit deiner aktuellen Streckenliste kannst du nur Strecken von $ff0#%lo%$fff bis $ff0#%hi%$fff auswählen.'
    },

    lists : {
        header: priv + '$ff0%type%$fff-Liste: Seite $ff0%pg%$fff von $ff0%pages%$fff:',
        playerItem: '#$ff0%id%$fff: %name%$z$s$fff (%login%)',
        mapItem: '#$ff0%id%$fff: %name%$z$s$fff',

        showInvalidParams: warning + 'Ungültige Parameter. Stattdessen /liste show <liste> <seite> nutzen. Gültige Listen sind "maps" und "players".'
    },

    localRecords: {
        noneYet: info + 'Noch keine Streckenrekorde auf $ff0%map%$z$s$fff %when%!',
        listBegin: info + 'Streckenrekorde auf $ff0%map%$z$s$fff %when%: ',
        listItem: '$z$s$ff0#%pos%$fff: %name% ($ff0%time%$fff)',
        before: 'vor dieser Runde',
        after: 'nach dieser Runde',
        rightnow: 'gerade eben',

        equalled: info + '$ff0%player%$z$s$fff hat soeben den $ff0%pos%$z$s$fff Streckenrekord egalisiert ($ff0%time%$fff$z$s)!',
        improved: info + '$ff0%player%$z$s$fff hat sich auf den $ff0%pos%$z$s$fff Streckenrekord verbessert ($ff0%time%$fff, $0af%imp%$fff)!',
        claimed: info + '$ff0%player%$z$s$fff hat sich den $ff0%pos%$z$s$fff Streckenrekord gesichert ($ff0%time%$fff$z$s)!'
    },

    karma : {
        currentKarma: info + 'Karma von $ff0%map%$z$s$fff: $ff0%avg%$fff/10 (%stimmen% Stimmen)',
        nochKeineStimmen: info + 'Für $ff0%map%$z$s$fff gibt es noch keine Karma-Bewertung. Mit /karma <1-10> bewerten!',
        voteErfolgreich: priv + 'Danke! Deine Bewertung ($ff0%score%$fff/10) für $ff0%map%$fff wurde gespeichert.',
        voteErfolgreichManialink: priv + 'Danke! Deine Bewertung ($ff0%score%$fff/10) wurde gespeichert.',
        ungueltigeEingabe: warning + 'Ungültige Bewertung. Bitte eine Zahl von 1 bis 10 angeben, z.B. /karma 8',
        rundenendeAnsage: info + 'Karma von $ff0%map%$z$s$fff: $ff0%avg%$fff/10 (%stimmen% Stimmen)'
    },

    system: {
        datenbankAussetzer: warning + 'Kurzer Datenbank-Aussetzer erkannt! Zeiten der letzten Minuten wurden evtl. nicht gespeichert -- bitte kurz neu verbinden (Server verlassen & wieder beitreten), um sicherzugehen.'
    },

    errungenschaften: {
        freigeschaltet: info + '$ff0%player%$z$s$fff hat das Abzeichen $ff0%icon% %badge%$z$s$fff freigeschaltet!',
        eigeneUebersicht: priv + 'Du hast $ff0%anzahl%$fff von $ff0%gesamt%$fff Abzeichen freigeschaltet. Zuletzt: %letzte%',
        eigeneUebersichtLeer: priv + 'Du hast noch keine Abzeichen freigeschaltet. Auf der Website gibt es die volle Übersicht!',
    },

    hof: {
        rangwechsel: info + '$ff0🏛 HALL OF FAME! $z$s$fff%text%',
    },

};
