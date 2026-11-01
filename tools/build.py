"""문제 데이터 검사 + 출력값 채우기.

    python3 tools/build.py            # 출력값을 채워서 저장
    python3 tools/build.py --check    # 저장하지 않고, 채운 결과가 지금 파일과 다르면 실패 (CI용)

- problems/index.json 에 적힌 세트를 모두 읽는다.
- 각 문항의 solution(정답 코드)이 문법·조건 검사를 통과하는지 확인한다.
- examples / tests 의 output을 solution을 실행한 결과로 채워 넣는다.
- list2d 조건에 value가 없으면 solution의 리스트 값으로 채운다(데이터까지 검사).
- 마지막으로 solution을 채점해서 '맞았습니다'가 나오는지 확인한다.
"""
import asyncio
import ast
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "py"))

import runner  # noqa: E402
from checker import run_checks  # noqa: E402


CHECK = "--check" in sys.argv
CHANGED = []


def dump(path, data):
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    if path.read_text(encoding="utf-8") == text:
        return
    CHANGED.append(path)
    if not CHECK:
        path.write_text(text, encoding="utf-8")


def fill_list2d(tree, checks):
    for c in checks:
        if c.get("type") != "list2d" or "value" in c:
            continue
        for n in ast.walk(tree):
            if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == c["name"] for t in n.targets):
                c["value"] = [list(row) for row in ast.literal_eval(n.value)]


async def build_problem(path):
    p = json.loads(path.read_text(encoding="utf-8"))
    sol = runner.solution_text(p)
    tree = ast.parse(sol)
    fill_list2d(tree, p.get("checks", []))
    failed = run_checks(tree, p.get("checks", []))
    if failed:
        raise SystemExit(f"{path}: 정답 코드가 조건을 통과하지 못함 → {failed}")

    for key in ("examples", "tests"):
        for case in p.get(key, []):
            out, err = await runner.run_capture(sol, case.get("stdin", []), after=runner._lines(case.get("after")))
            if err:
                raise SystemExit(f"{path}: 정답 코드 실행 에러 {err} (입력 {case.get('stdin')})")
            case["output"] = out

    result = json.loads(await runner.grade(sol, json.dumps(p, ensure_ascii=False)))
    if result["verdict"] != "ac":
        raise SystemExit(f"{path}: 정답 코드 채점 결과 {result}")
    dump(path, p)
    return p


async def main():
    index = json.loads((ROOT / "problems" / "index.json").read_text(encoding="utf-8"))
    total = 0
    for set_id in index["sets"]:
        set_dir = ROOT / "problems" / set_id
        meta = json.loads((set_dir / "set.json").read_text(encoding="utf-8"))
        if meta.get("level") not in (None, 1, 2, 3, 4):
            raise SystemExit(f"{set_id}/set.json: level은 1(쉬움), 2(보통), 3(어려움), 4(매우 어려움) 중 하나")
        for pid in meta["problems"]:
            p = await build_problem(set_dir / f"{pid}.json")
            print(f"  {set_id}/{pid}  {p['title']}  (테스트 {len(p.get('tests', []))}개)")
            total += 1
    if CHECK and CHANGED:
        raise SystemExit("build.py를 실행하지 않은 문제 파일: " + ", ".join(str(p.relative_to(ROOT)) for p in CHANGED))
    print(f"완료: {total}문항")


if __name__ == "__main__":
    asyncio.run(main())
