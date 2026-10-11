"""Выкладывает собранные HTML-листы в Supabase (bucket `drawings` + таблица `drawings`).

Запускается сборщиком в офисе после конвертации DWG -> HTML.
Нужны переменные окружения (на сборщике или в секретах GitHub Actions, НЕ в коде):
    SUPABASE_URL           https://<проект>.supabase.co
    SUPABASE_SERVICE_KEY   service_role ключ (Settings -> API). Даёт полный доступ, хранить только на сборщике.

Использование:
    python upload_drawings.py manifest.json

manifest.json — список собранных листов:
    [{"project_id": "<uuid проекта в SKKG Pro>", "section": "Озеленение",
      "sheet": "11.1 Сводный посадочный план", "html": "out/1197-04_11-1.html"}]

Лист загружается заново, только если HTML изменился (сравнение по SHA-256).
"""
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
import urllib.error
import urllib.parse
import urllib.request

URL = os.environ["SUPABASE_URL"].rstrip("/")
KEY = os.environ["SUPABASE_SERVICE_KEY"]
BUCKET = "drawings"
HEADERS = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}


def request(method, path, body=None, headers=None):
    req = urllib.request.Request(URL + path, data=body, method=method, headers={**HEADERS, **(headers or {})})
    with urllib.request.urlopen(req) as resp:
        data = resp.read()
        return json.loads(data) if data else None


def slug(text):
    text = re.sub(r"[^A-Za-z0-9._-]+", "-", text.encode("ascii", "ignore").decode()).strip("-")
    return text or "sheet"


def existing(project_id, sheet):
    q = urllib.parse.urlencode({"select": "id,file_path,source_hash", "project_id": f"eq.{project_id}", "sheet": f"eq.{sheet}"})
    rows = request("GET", f"/rest/v1/drawings?{q}")
    return rows[0] if rows else None


def upload(item):
    html = open(item["html"], "rb").read()
    digest = hashlib.sha256(html).hexdigest()
    row = existing(item["project_id"], item["sheet"])
    if row and row["source_hash"] == digest:
        print(f"без изменений: {item['sheet']}")
        return
    file_path = row["file_path"] if row else f"{item['project_id']}/{slug(item['sheet'])}-{digest[:8]}.html"
    request("POST", f"/storage/v1/object/{BUCKET}/{urllib.parse.quote(file_path)}", html,
            {"Content-Type": "text/html; charset=utf-8", "x-upsert": "true"})
    record = {"project_id": item["project_id"], "section": item.get("section", ""), "sheet": item["sheet"],
              "file_path": file_path, "source_hash": digest, "updated_at": datetime.now(timezone.utc).isoformat()}
    request("POST", "/rest/v1/drawings?on_conflict=file_path", json.dumps(record).encode(),
            {"Content-Type": "application/json", "Prefer": "resolution=merge-duplicates"})
    print(f"обновлён: {item['sheet']}")


def main():
    items = json.load(open(sys.argv[1], encoding="utf-8"))
    failed = 0
    for item in items:
        try:
            upload(item)
        except (urllib.error.URLError, OSError, KeyError) as e:
            failed += 1
            print(f"ОШИБКА {item.get('sheet')}: {e}", file=sys.stderr)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
