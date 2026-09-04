<?php
// admin-logout.php -- beendet die Admin-Dashboard-Session (AP16).

require_once __DIR__ . '/lib/adminAuth.php';
starteAdminSession();

$_SESSION = [];
session_destroy();

header('Location: admin-login.php');
