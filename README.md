# HOJ (Hanbaek Online Judge)

고등학교 정보 수행평가 연습용 파이썬 채점 사이트입니다. 서버 없이 GitHub Pages에서 동작하며, 파이썬은 브라우저 안에서 Pyodide로 실행합니다.

## 배포

저장소 **Settings → Pages → Source**를 **GitHub Actions**로 바꾸세요. 그다음부터 `main`에 올리면
`.github/workflows/pages.yml`이 테스트와 문제 검사를 마친 뒤 자동으로 배포합니다.

- 사이트에는 `tools/dist.py`가 고른 파일만 올라갑니다. `정보수행.pdf` 같은 자료, `tools/`, `tests/`는 저장소에만 있습니다.
- 문제 JSON의 정답 코드(`solution`)는 문제 화면의 **정답 코드** 섹션과 시험 결과에서 보여 주므로 사이트에 올라갑니다.
- JS·CSS·파이썬·문제 파일 주소에는 `?v=버전`(파일 내용으로 만든 값)이 붙습니다. 배포 후 새로고침 한 번이면 새 파일을 받습니다.
- Pyodide도 사이트에 함께 올립니다. 학교망에서 CDN(jsdelivr)이 막혀도 파이썬이 동작합니다.
- 채점용 테스트의 입출력은 브라우저에서 채점해야 하므로 사이트에 올라갑니다.

로컬에서 확인할 때는 아래처럼 실행한 뒤 http://localhost:8000 을 여세요. (`pyodide/` 폴더가 없으면 CDN에서 받습니다.)

```
python3 -m http.server 8000
```

수정한 뒤에는 테스트를 돌려 보세요.

```
python3 tests/test_runner.py     # 실행·채점·조건 검사 테스트
python3 tools/build.py           # 문제 출력값 채우기 + 정답 코드 검사
```

## 폴더 구조

```
index.html          화면 틀
css/style.css
js/                 app.js(페이지), idle.js(IDLE 화면), editor.js, shell.js, highlight.js, runtime.js, worker.js
py/runner.py        실행·채점 (Pyodide 워커에서 동작)
py/checker.py       문제 조건 검사 (ast)
problems/
  index.json        문제집 목록 {"sets": ["practice", "variant-1", ...]}
  <세트>/set.json   {"title", "group", "level", "description", "problems": ["1", "2", "3"]}
  <세트>/<문항>.json
tools/build.py      문제 데이터 검사 + 정답 출력 채우기 (--check: CI용)
tools/dist.py       배포할 파일만 _site/에 모으기
tests/              채점기 테스트
```

## 문제 세트 추가하기

1. `problems/<새 세트>/` 폴더를 만들고 `set.json`과 문항 JSON을 넣으세요.
2. `problems/index.json`의 `sets`에 폴더 이름을 추가하세요.
3. `python3 tools/build.py`를 실행하세요. 정답 코드(`solution`)를 실행해서 `examples`, `tests`의 `output`을 채우고, 정답 코드가 조건 검사와 채점을 통과하는지 확인합니다.

### set.json

- `exam_minutes`: 시험 모드 시간(분), 기본 45
- `password`: 비공개 세트의 비밀번호를 SHA-256으로 바꾼 값(16진수). 넣으면 비밀번호를 입력해야 열립니다.
  `python3 -c "import hashlib;print(hashlib.sha256(b'비밀번호').hexdigest())"`로 만드세요.
  브라우저에서만 확인하므로 문제 파일 자체는 주소를 알면 볼 수 있습니다.
  비밀번호를 바꾸면 예전 비밀번호로 열어 둔 브라우저도 다음 새로고침 때 다시 비밀번호를 묻습니다.

- `group`: 첫 화면에서 묶어 보여 줄 이름 (예: "변형 문제")
- `level`: 난이도 1(쉬움) · 2(보통) · 3(어려움) · 4(매우 어려움). 표시만 하고, 순서는 `problems/index.json`에 적힌 순서를 따릅니다.

### 문항 JSON (수행평가 형식)

```json
{
  "title": "놀이기구 탑승",
  "type": "다중 조건문",
  "score": 7,
  "heading": "다중 조건문을 이용한 문제 해결 프로그램 작성하기",
  "description": "키와 나이를 입력하면 ... 작성하세요.",
  "conditions": [
    "놀이기구 키 제한: **110cm 이상** 탑승 가능",
    {"text": "놀이기구 이용 금액", "table": [["나이", "금액"], ["7~13세", "6000원"]]},
    {"text": "**input 함수**를 이용한 입력", "items": ["① ...", "※ 참고 문장"]}
  ],
  "result_title": "실행 결과(예시)",
  "examples": [{"stdin": ["110", "6"]}],
  "tests": [{"stdin": ["110", "6"]}, {"stdin": ["150", "14"]}],
  "checks": [
    {"type": "assign", "name": "height", "from": "int_input", "desc": "키를 입력받아 변수 height에 정수로 저장"}
  ],
  "solution": ["height = int(input(\"키 입력: \"))", "..."]
}
```

- `conditions`의 묶음에 `"hint"`를 넣으면 그 줄 끝에 **힌트** 버튼이 생깁니다(시험 모드에서는 숨김).
  예: `{"text": "**input 함수**를 이용한 입력", "items": [...], "hint": "input()으로 받은 값은 문자열이라서 ..."}`
- `conditions`의 `**굵게**`와 `` `코드` ``만 서식으로 처리합니다. 항목은 문자열(한 줄) 또는 `text`/`table`/`items` 묶음입니다.
- `examples`는 지문의 [실행 결과(예시)] 칸, `tests`는 채점용 테스트입니다. `output`은 build.py가 채웁니다.
- 출력 비교는 각 줄 끝 공백과 마지막 빈 줄을 무시하고, 소수는 아주 작은 오차(1e-9)까지 같다고 봅니다
  (`23.437499999999996`과 `23.4375`는 같음, 정수 `7`과 `7.0`은 다름). 입력값은 IDLE처럼 `키 입력: 110` 형태로 출력에 포함됩니다.

### 일반 문제 형식

`conditions`가 없으면 문제 / 입력 / 출력 / 실행 결과 / 힌트 순서의 일반 지문으로 보여 줍니다.
`statement`, `input`, `output`, `hint`는 간단한 표기를 씁니다: 빈 줄로 문단, `- ` 목록, `| a | b |` 표, ```` ``` ```` 코드 블록.

```json
{
  "title": "큰 수 돌려주기",
  "type": "함수",
  "statement": "두 수 중 큰 수를 돌려주는 함수 `bigger(a, b)`를 작성하세요.",
  "starter": ["def bigger(a, b):", "    pass"],
  "tests": [{"after": ["print(bigger(3, 5))"]}],
  "checks": [{"type": "def", "name": "bigger", "args": 2, "returns": true}],
  "solution": ["def bigger(a, b):", "    return a if a > b else b"]
}
```

| 키 | 뜻 |
|---|---|
| `starter` | 편집기에 처음 들어 있는 코드 |
| `tests[].after` | 학생 코드를 실행한 뒤 이어서 실행할 코드 (함수 채점) |
| `compare` | 출력 비교 방법 `{"float_tol": 1e-9, "ignore_space": false, "ignore_case": false, "ignore_blank_lines": false}` (`float_tol: 0`이면 소수도 그대로 비교) |
| `time_limit` | 테스트 하나당 시간 제한(초), 기본 0.4 |
| `score`, `type` | 없어도 됩니다 |

### 조건 검사 (`checks`)

조건을 지키지 않으면 `조건 미충족 (desc)`로 표시됩니다. 위에서부터 순서대로 검사합니다.

| type | 옵션 | 뜻 |
|---|---|---|
| `assign` | `name`, `from`: `any` / `input` / `int_input` / `subscript`(+`list`, `depth`) / `uses`(+`names`) | 변수에 값을 대입했는지. 중간 변수, `a, b = ...` 풀어 넣기, `map(int, input().split())`도 인정 |
| `if_elif_else` | `elif`(최소 개수), `else`(false면 else 없어도 됨), `in_for` | if~elif~else 구조 |
| `nested_for` | `outer`, `inner`, `outer_range`, `inner_range` (`[1, 5]` = `range(1, 5)`) | 이중 for문 |
| `for` | `var`, `range`, `over`(반복할 리스트 이름) | for문 |
| `print_end` | `value` | `print(..., end=...)` 사용 |
| `loop_print` | `depth`, `max_args` | 값을 출력하는 print가 모두 반복문 depth겹 안에 있고 값은 max_args개 이하 (도형 문제 우회 방지) |
| `max_str_len` | `max` | 모든 문자열이 max 글자 이하 (출력 모양 하드코딩 방지) |
| `list2d` | `name`, `value` | 2차원 리스트 저장. value가 없으면 build.py가 정답 코드의 값으로 채움 (`180`과 `"180"`은 같게 봄) |
| `subscript` | `list`, `depth` | 리스트 인덱스 접근 |
| `call` / `forbid_call` | `name`, `min` | 함수(메서드 포함) 사용 / 사용 금지 |
| `node` / `forbid_node` | `node`(ast 이름: `While`, `ListComp`, `Return`, `Break` …), `min` | 문법 요소 사용 / 사용 금지 |
| `def` | `name`, `args`, `returns` | 함수 정의 |
| `import` / `forbid_import` | `name` (forbid_import에서 생략하면 모든 import 금지) | 모듈 import |
| `max_lines` | `max` | 코드 줄 수 제한 |

## 채점 결과

맞았습니다!! · 틀렸습니다(몇 번째 테스트인지 표시) · 조건 미충족 · 런타임 에러 · 문법 에러 · 시간 초과 · 출력 초과

## 시험 모드

문제집 화면 아래 **시험 모드** 버튼으로 시작합니다. 시간 안에 모든 문항을 풀고, 시간이 끝나거나 **시험 끝내기**를 누르면
한꺼번에 채점합니다. 시험 중에는 제출·힌트·정답 코드를 쓸 수 없고, 맞았습니다를 받은 문항만 배점만큼 점수를 줍니다.
결과 화면에서 내 코드와 정답 코드를 나란히 비교할 수 있고, 점수 기록은 브라우저에 남습니다.

## input() 처리

- 채점: 입력값을 미리 넣어 두고 그대로 실행합니다.
- F5 실행과 Shell: 최상위 코드의 `input()`은 Shell에서 바로 입력을 기다립니다. 함수, 제너레이터 식, 클래스 안의
  `input()`(그리고 `help()`, `license()`)은 입력이 필요해지면 그때까지 받은 입력을 넣고 처음부터 다시 실행합니다.
  이미 보인 출력은 다시 보이지 않고 random 값도 같게 유지되며, `except:`로 감싸도 동작합니다.
  Shell에서는 그 문장만 다시 실행하므로, 입력 전에 전역 변수를 바꾸는 문장은 두 번 실행될 수 있습니다.

## IDLE과 같게 맞춘 것

- 시작 문구는 Windows용 Python 3.12.7과 같고, `exit`/`quit` 안내도 Windows와 같습니다(Ctrl-Z plus Return).
- `help`, `help(객체)`, `help()`(help> 모드), `copyright`, `credits`, `license()`(페이지 넘김) 지원.
  license 원문은 `py/python-license.txt` (CPython 3.12.7 LICENSE).
- Shell 왼쪽 칸에 `>>>`, `...` 표시, 50줄 이상의 출력은 Squeezed text 버튼(더블클릭으로 펼침, 오른쪽 클릭으로 copy/view).
- 함수 설명(calltip), 자동 완성(Tab, Ctrl+Space, 점 뒤 2초), 괄호 짝 표시, Home 키, 줄 번호.
- 메뉴: Open/Save As(파일로 내려받기), Cut/Copy/Paste, Find/Find Again/Replace, Show Completions/Call Tip/Surrounding Parens,
  Untabify, Strip Trailing Whitespace, View Last Restart(F6), Previous/Next History, About IDLE, Python Docs(F1).
