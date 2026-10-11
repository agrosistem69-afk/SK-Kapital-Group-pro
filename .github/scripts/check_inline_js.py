"""Проверяет синтаксис встроенных <script> в HTML-файлах через `node --check`."""
import html.parser
import pathlib
import subprocess
import sys
import tempfile


class Scripts(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.blocks, self._buf, self._inside = [], [], False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "script" and "src" not in a and a.get("type", "text/javascript") in ("text/javascript", "module", ""):
            self._inside, self._buf, self._line = True, [], self.getpos()[0]

    def handle_endtag(self, tag):
        if tag == "script" and self._inside:
            self.blocks.append((self._line, "".join(self._buf)))
            self._inside = False

    def handle_data(self, data):
        if self._inside:
            self._buf.append(data)


failed = 0
for path in sys.argv[1:]:
    p = Scripts()
    p.feed(pathlib.Path(path).read_text(encoding="utf-8"))
    for line, code in p.blocks:
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as f:
            f.write(code)
        r = subprocess.run(["node", "--check", f.name], capture_output=True, text=True)
        if r.returncode:
            failed += 1
            print(f"{path}: ошибка в <script> со строки {line}\n{r.stderr}")
    print(f"{path}: проверено встроенных скриптов: {len(p.blocks)}")
sys.exit(1 if failed else 0)
