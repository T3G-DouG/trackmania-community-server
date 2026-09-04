<?php
// admin-login.php -- Login-Seite für das Admin-Dashboard. Eigenes Passwort
// (secrets.env: ADMIN_DASHBOARD_PASSWORT_HASH), NICHT das SuperAdmin-Passwort des
// Spielservers -- die Website ist typischerweise öffentlich erreichbar.

require_once __DIR__ . '/lib/adminAuth.php';
starteAdminSession();

$config = require __DIR__ . '/config.php';

if ($_SERVER['REQUEST_METHOD'] === 'GET' && istAdminEingeloggt()) {
    header('Location: admin.html');
    exit;
}

$fehler = null;

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $manager = new MongoDB\Driver\Manager($config['mongodb']['uri']);
    $db = $config['mongodb']['database'];

    $sperre = adminLoginGesperrt($manager, $db);
    if ($sperre['gesperrt']) {
        $fehler = "Zu viele Fehlversuche -- gesperrt für noch ca. {$sperre['verbleibendeMinuten']} Min.";
    } elseif (empty($config['admin']['passwort_hash'])) {
        $fehler = 'Admin-Passwort ist noch nicht eingerichtet (ADMIN_DASHBOARD_PASSWORT_HASH fehlt in secrets.env).';
    } elseif (password_verify($_POST['passwort'] ?? '', $config['admin']['passwort_hash'])) {
        adminLoginErfolgReset($manager, $db);
        session_regenerate_id(true);
        $_SESSION['admin_eingeloggt'] = true;
        header('Location: admin.html');
        exit;
    } else {
        adminLoginFehlversuchZaehlen($manager, $db);
        $fehler = 'Falsches Passwort.';
    }
}
?>
<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Admin-Login · Trackmania Competition Server</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600;700&family=Barlow:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/theme.css?v=2">
<style>
    body { display:flex; align-items:center; justify-content:center; min-height:100vh; }
    .login-box { background:var(--bg-card); border:1px solid var(--border2); border-radius:16px; padding:36px 32px; width:100%; max-width:360px; }
    .login-box h1 { font-size:20px; color:#fff; margin-bottom:6px; }
    .login-box p.sub { color:var(--text-dim); font-size:13px; margin-bottom:22px; line-height:1.5; }
    .login-box input[type=password] {
        width:100%; padding:12px 14px; border-radius:10px; border:1px solid var(--border2);
        background:var(--bg-surface); color:#fff; font-size:14px; margin-bottom:16px; box-sizing:border-box;
    }
    .login-box button {
        width:100%; padding:12px; border-radius:10px; border:none; background:var(--accent);
        color:#08120e; font-weight:700; font-size:14px; cursor:pointer;
    }
    .login-box button:hover { filter:brightness(1.08); }
    .login-fehler {
        background:rgba(201,107,94,0.12); border:1px solid rgba(201,107,94,0.4); color:#f0a99e;
        padding:10px 14px; border-radius:8px; font-size:13px; margin-bottom:16px; line-height:1.4;
    }
</style>
</head>
<body>
<div class="login-box">
    <h1>🔒 Admin-Dashboard</h1>
    <p class="sub">Steuerung der KI-Features (Rennleitung, Nachrichten-KI). Nur für den Betreiber.</p>
    <?php if ($fehler): ?><div class="login-fehler"><?= htmlspecialchars($fehler) ?></div><?php endif; ?>
    <form method="post">
        <input type="password" name="passwort" placeholder="Admin-Passwort" autofocus required>
        <button type="submit">Anmelden</button>
    </form>
</div>
</body>
</html>
