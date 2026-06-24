# Arbeitsisolation

Für jede neue Implementierungsaufgabe ist vor dem ersten Datei-Edit ein
dediziertes Git-Worktree mit einem eigenen Branch `codex/<kurze-aufgabe>` zu
verwenden. Arbeite ausschließlich innerhalb dieses Worktrees.

Vor dem Anlegen oder Verwenden eines Worktrees ist `git status -sb` zu prüfen.
Bereits vorhandene Änderungen dürfen weder verändert noch versehentlich
gestaget oder committed werden. Bei einem nicht sauberen Ziel-Worktree ist der
Nutzer über die Änderungen zu informieren, bevor fortgefahren wird.

Für reine Analyse-, Recherche- oder Statusaufgaben ist kein neues Worktree
erforderlich. Nach einem gemergten PR das zugehörige Worktree nur auf
Anweisung des Nutzers entfernen.
