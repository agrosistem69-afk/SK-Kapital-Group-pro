<?php
// Обход блокировки базы данных: у некоторых интернет-провайдеров без VPN не открывается *.supabase.co.
// Тогда приложение шлёт запросы сюда, на skkg.ru, а этот файл пересылает их в нашу базу Supabase
// и возвращает ответ. Пересылаем только в наш проект и только в его разделы (вход, данные, файлы),
// поэтому чужие сайты через этот файл не открыть. Паролей и ключей здесь нет: они идут в запросе
// от приложения, как и при прямом подключении.
// Адрес: sb.php?u=/rest/v1/tasks%3Fselect%3D*  (u — путь и параметры запроса к базе).

$upstream = getenv('SB_UPSTREAM') ?: 'https://pgejlzsfofkgdsgwptfa.supabase.co';

$path = isset($_GET['u']) ? (string)$_GET['u'] : '';
if (!preg_match('#^/(auth|rest|storage|functions)/v1/[^\s\\\\]*$#', $path) || strpos($path, '..') !== false) {
    http_response_code(400);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'bad path';
    exit;
}
if (!function_exists('curl_init')) {
    http_response_code(501);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'curl is not available';
    exit;
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method === 'OPTIONS') { http_response_code(204); exit; }

// Заголовки, которые нужны базе. Authorization на части хостингов PHP не видит,
// поэтому приложение дублирует его в X-Sb-Authorization.
$pass = [
    'HTTP_APIKEY' => 'apikey',
    'HTTP_AUTHORIZATION' => 'Authorization',
    'REDIRECT_HTTP_AUTHORIZATION' => 'Authorization',
    'HTTP_X_SB_AUTHORIZATION' => 'Authorization',
    'CONTENT_TYPE' => 'Content-Type',
    'HTTP_CONTENT_TYPE' => 'Content-Type',
    'HTTP_PREFER' => 'Prefer',
    'HTTP_RANGE' => 'Range',
    'HTTP_RANGE_UNIT' => 'Range-Unit',
    'HTTP_ACCEPT' => 'Accept',
    'HTTP_ACCEPT_PROFILE' => 'Accept-Profile',
    'HTTP_CONTENT_PROFILE' => 'Content-Profile',
    'HTTP_X_CLIENT_INFO' => 'X-Client-Info',
    'HTTP_X_UPSERT' => 'x-upsert',
    'HTTP_CACHE_CONTROL' => 'Cache-Control',
    'HTTP_X_SUPABASE_API_VERSION' => 'X-Supabase-Api-Version',
];
$headers = [];
foreach ($pass as $key => $name) {
    if (isset($_SERVER[$key]) && $_SERVER[$key] !== '') $headers[strtolower($name)] = $name . ': ' . $_SERVER[$key];
}
$headers['expect'] = 'Expect:';

$ch = curl_init($upstream . $path);
curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);
curl_setopt($ch, CURLOPT_HTTPHEADER, array_values($headers));
curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 15);
curl_setopt($ch, CURLOPT_TIMEOUT, 300);
curl_setopt($ch, CURLOPT_FOLLOWLOCATION, false);
curl_setopt($ch, CURLOPT_ENCODING, '');
if (!in_array($method, ['GET', 'HEAD'], true)) {
    $body = file_get_contents('php://input');
    curl_setopt($ch, CURLOPT_POSTFIELDS, $body === false ? '' : $body);
}
if ($method === 'HEAD') curl_setopt($ch, CURLOPT_NOBODY, true);

// Ответ отдаём по мере получения, чтобы большие файлы (чертежи, PDF) не упирались в память хостинга.
$skip = ['transfer-encoding', 'connection', 'content-encoding', 'content-length', 'keep-alive', 'set-cookie', 'alt-svc', 'strict-transport-security'];
curl_setopt($ch, CURLOPT_HEADERFUNCTION, function ($ch, $line) use ($skip) {
    $len = strlen($line);
    $t = trim($line);
    if ($t === '') return $len;
    if (preg_match('#^HTTP/\S+\s+(\d+)#', $t, $m)) { http_response_code((int)$m[1]); return $len; }
    $p = strpos($t, ':');
    if ($p === false) return $len;
    $name = strtolower(trim(substr($t, 0, $p)));
    if (in_array($name, $skip, true) || strpos($name, 'access-control-') === 0) return $len;
    header($t, false);
    return $len;
});
curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($ch, $data) {
    echo $data;
    @flush();
    return strlen($data);
});
header('Cache-Control: no-store');
while (ob_get_level() > 0) ob_end_flush();

$ok = curl_exec($ch);
if ($ok === false && !headers_sent()) {
    http_response_code(502);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'upstream error';
}
curl_close($ch);
