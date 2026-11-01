"""배포할 파일만 _site/ 에 모은다.  python3 tools/dist.py

저장소에는 있어도 사이트로는 공개하지 않을 것:
- 정보수행.pdf 같은 원본 자료, tools/, tests/, README.md

pyodide/ 폴더가 있으면 함께 넣는다(.github/workflows/pages.yml이 받아 둔다).
그러면 CDN이 막힌 학교망에서도 파이썬이 동작한다.

JS, CSS, 파이썬, 문제 파일 주소에는 ?v=버전을 붙인다. 버전은 파일 내용으로 만들어서,
배포 후 새로고침 한 번이면 브라우저 캐시 대신 새 파일을 받는다.
"""
import hashlib
import json
import pathlib
import re
import shutil

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "_site"

PUBLIC = ["index.html", ".nojekyll", "css", "js", "py/runner.py", "py/checker.py", "py/python-license.txt", "pyodide"]
PRIVATE_KEYS = set()  # 정답 코드(solution)는 문제 화면의 "정답 코드"에서 보여 주므로 공개한다


def copy(rel):
    src = ROOT / rel
    if not src.exists():
        return
    dst = OUT / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    if src.is_dir():
        shutil.copytree(src, dst, ignore=shutil.ignore_patterns("__pycache__", "*.d.ts"))
    else:
        shutil.copy2(src, dst)


def add_version():
    """배포할 파일 내용으로 버전을 만들고, 파일을 불러오는 주소마다 ?v=버전을 붙인다."""
    h = hashlib.sha256()
    for f in sorted(OUT.rglob("*")):
        if f.is_file() and "pyodide" not in f.parts:
            h.update(str(f.relative_to(OUT)).encode())
            h.update(f.read_bytes())
    v = h.hexdigest()[:10]

    def rewrite(rel, pairs):
        path = OUT / rel
        text = path.read_text(encoding="utf-8")
        for pattern, repl in pairs:
            text, n = re.subn(pattern, repl, text)
            if not n:
                raise SystemExit(f"{rel}: 버전을 붙일 곳을 찾지 못함 ({pattern})")
        path.write_text(text, encoding="utf-8")

    rewrite("index.html", [(r'href="css/style\.css"', f'href="css/style.css?v={v}"'),
                           (r'src="js/app\.js"', f'src="js/app.js?v={v}"')])
    for js in sorted((OUT / "js").glob("*.js")):
        text = js.read_text(encoding="utf-8")
        text = re.sub(r'from "(\./[\w.-]+\.js)"', rf'from "\1?v={v}"', text)
        js.write_text(text, encoding="utf-8")
    rewrite("js/runtime.js", [(r'new URL\("\./worker\.js"', f'new URL("./worker.js?v={v}"')])
    rewrite("js/worker.js", [(r'"\.\./py/" \+ name,', f'"../py/" + name + "?v={v}",')])
    rewrite("js/app.js", [(r'fetch\(path, \{ cache: "no-cache" \}\)', f'fetch(path + "?v={v}", {{ cache: "no-cache" }})')])
    return v


def main():
    shutil.rmtree(OUT, ignore_errors=True)
    OUT.mkdir()
    for rel in PUBLIC:
        copy(rel)
    index = json.loads((ROOT / "problems/index.json").read_text(encoding="utf-8"))
    files = [ROOT / "problems/index.json"]
    for sid in index["sets"]:
        meta_path = ROOT / "problems" / sid / "set.json"
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        files.append(meta_path)
        files += [ROOT / "problems" / sid / f"{pid}.json" for pid in meta["problems"]]
    for f in files:
        data = json.loads(f.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            data = {k: v for k, v in data.items() if k not in PRIVATE_KEYS}
        dst = OUT / f.relative_to(ROOT)
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    v = add_version()
    n = sum(1 for p in OUT.rglob("*") if p.is_file())
    print(f"_site/ 에 {n}개 파일 (버전 {v})")


if __name__ == "__main__":
    main()
