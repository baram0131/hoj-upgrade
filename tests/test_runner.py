"""runner.py / checker.py 테스트.  python3 tests/test_runner.py

F5 실행은 브라우저(js 모듈)를 흉내 내서 확인한다. Shell에 보이는 화면(출력 + 입력한 값)이
일반 파이썬을 터미널에서 실행했을 때와 같아야 한다.
"""
import ast
import asyncio
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "py"))

import runner  # noqa: E402
from checker import run_checks  # noqa: E402


class FakeJS:
    def __init__(self, answers):
        self.answers = list(answers)
        self.screen = []

    def jsEmit(self, stream, text):
        self.screen.append(text)

    def jsProgress(self, i, n):
        pass

    async def jsRequestInput(self):
        if not self.answers:
            return {"abort": True}  # 문자열이 아니면 중단
        v = self.answers.pop(0)
        if v is not None:
            self.screen.append(v + "\n")  # Shell이 입력한 값을 보여 준다
        return v


def live(src, answers, shell=None):
    """shell: Shell(>>>)에 차례로 입력할 문장 목록 (F5 실행 뒤)"""
    fake = FakeJS(answers)
    old_out, old_err = sys.stdout, sys.stderr
    runner.js = fake
    sys.stdout, sys.stderr = runner._Stream("stdout"), runner._Stream("stderr")
    runner._state.sink = runner._live_sink
    try:
        if src is not None:
            asyncio.run(runner.run_program(src, "t.py"))
        else:
            runner.reset_shell()
        for line in shell or []:
            fake.screen.append(">>> " + line + "\n")
            asyncio.run(runner.shell_run(line))
    finally:
        sys.stdout, sys.stderr = old_out, old_err
        runner.js = None
    return "".join(fake.screen)


FAILS = []


def eq(name, got, want):
    if got != want:
        FAILS.append(name)
        print("FAIL", name, "\n  got: ", repr(got), "\n  want:", repr(want))
    else:
        print("ok  ", name)


def test_live():
    eq("최상위 input", live('a = input("a: ")\nprint(a * 2)', ["x"]), "a: x\nxx\n")
    eq("제너레이터 식", live("print(sum(int(input()) for _ in range(3)))", ["1", "2", "3"]),
       "1\n2\n3\n6\n")
    eq("함수 안 input", live('def f():\n    return int(input("n: "))\nprint("시작")\nprint(f() + f())',
                            ["2", "5"]), "시작\nn: 2\nn: 5\n7\n")
    eq("별칭", live("r = input\nprint(r('> '))", ["hi"]), "> hi\nhi\n")
    eq("클래스", live("class A:\n    x = input()\nprint(A.x)", ["c"]), "c\nc\n")
    eq("except: 로 삼키기",
       live('def g():\n    while True:\n        try:\n            return int(input("수: "))\n'
            '        except:\n            print("다시")\nprint(g())', ["a", "4"]),
       "수: a\n다시\n수: 4\n4\n")
    eq("random 유지",
       live("import random\nx = random.randint(1, 10**9)\n"
            "def ask():\n    return input()\nask()\nprint(x == x)\nask()\nprint('끝')",
            ["1", "2"]).count("True"), 1)
    src = "import random\nprint(random.randint(1, 10**9))\ndef ask():\n    return input()\nask()\n"
    out = live(src, ["1"]).split("\n")
    eq("random 다시 실행해도 같은 값", len(out), 3)
    eq("에러 메시지", live("def f():\n    return int(input())\nf()", ["a"]).splitlines()[-1],
       "ValueError: invalid literal for int() with base 10: 'a'")
    eq("Shell 함수 input", live("def f():\n    return input('n: ')", ["7"], ["print(f() * 2)"]),
       ">>> print(f() * 2)\nn: 7\n77\n")
    scr = live(None, ["print", "q"], ["help()"])
    eq("help() 대화식", ("help> print" in scr, "Prints the values" in scr, "now leaving help" in scr), (True, True, True))
    eq("help", live(None, [], ["help"]).splitlines()[-1],
       "Type help() for interactive help, or help(object) for help about object.")
    runner._setup_builtins()
    eq("exit 안내", live(None, [], ["exit"]).splitlines()[-1], "Use exit() or Ctrl-Z plus Return to exit")
    scr = live(None, ["", "q"], ["license()"])
    if sys.version_info < (3, 13):  # 3.13부터는 license()가 페이지를 넘기지 않는다 (사이트는 3.12)
        eq("license() 넘기기", scr.count("Hit Return for more"), 2)
    eq("exit('안녕')", live("exit('안녕')", []), "SystemExit: 안녕\n")
    eq("calltip", runner.calltip("print").splitlines()[0], "(*args, sep=' ', end='\\n', file=None, flush=False)")
    eq("completions", "sqrt" in json.loads(runner.completions("math.sq"))[0] if __import__("math") else 0, True)
    eq("Ctrl+C", live("def f():\n    return input()\nf()", [None]).splitlines()[-1], "KeyboardInterrupt")


def grade(src, p):
    return json.loads(asyncio.run(runner.grade(src, json.dumps(p, ensure_ascii=False))))


def load(path):
    return json.loads((ROOT / "problems" / path).read_text(encoding="utf-8"))


def test_grade():
    p = load("practice/3.json")
    base = runner.solution_text(p)
    eq("BMI 다른 식(실수 오차)", grade(base.replace("(height/100)**2", "(height/100*height/100)"), p)["verdict"], "ac")
    eq("BMI 중간 변수", grade(base.replace("bmi = weight / (height/100)**2",
                                       "m = height / 100\nbmi = weight / m**2"), p)["verdict"], "ac")
    eq("BMI 언패킹", grade(base.replace("height = a[n-1][2]\nweight = a[n-1][3]",
                                     "num, name, height, weight = a[n-1]"), p)["verdict"], "ac")
    eq("BMI 반올림은 틀림", grade(base.replace('print("BMI:", bmi)', 'print("BMI:", round(bmi, 2))'), p)["verdict"],
       "wrong")
    eq("데이터 다르면 조건 미충족", grade(base.replace('"김구", 180, 80', '"김구", 181, 80'), p)["verdict"], "condition")
    eq("정수 7 과 7.0 은 다름", runner.same_output("7\n", "7.0\n"), False)
    eq("소수 오차 허용", runner.same_output("x: 0.30000000000000004 cm\n", "x: 0.3 cm\n"), True)
    eq("공백 다르면 틀림", runner.same_output("* *\n", "*  *\n"), False)

    p = load("practice/1.json")
    sol = runner.solution_text(p)
    eq("map(int, split)", grade(sol.replace('height = int(input("키 입력: "))\nage = int(input("나이 입력: "))',
                                         'height = int(input("키 입력: "))\nage = int(input("나이 입력: ").strip())'),
                                p)["verdict"], "ac")
    eq("함수 안 input 채점", grade("def get(m):\n    return int(input(m))\nheight = int(input('키 입력: '))\n"
                                "age = get('나이 입력: ')\n" + sol.split("\n\n", 1)[1], p)["verdict"], "condition")
    gen = "def ask(m):\n    return input(m)\n" + sol.replace('int(input(', 'int(ask(')
    eq("함수 안 input 출력", grade(gen, p)["verdict"], "ac")

    p = load("practice/2.json")
    out = p["tests"][0]["output"]
    cheat = ("for row in range(1,5):\n    for col in range(1,6):\n        if 0:\n            print('*', end=' ')\n"
             "        elif 0:\n            pass\n        else:\n            pass\n"
             + "".join("print(%s, sep='')\n" % ",".join(repr(c) for c in line) for line in out.splitlines()))
    eq("도형 우회 막힘", grade(cheat, p)["verdict"], "condition")
    eq("도형 정답", grade(runner.solution_text(p), p)["verdict"], "ac")
    alt = runner.solution_text(p).replace("range(1, 5)", "range(1, 4 + 1)")
    eq("range(1, 4+1)", grade(alt, p)["verdict"], "ac")


def test_checks():
    def ok(src, c):
        return run_checks(ast.parse(src), [dict(c, desc="x")]) is None
    eq("int_input map", ok("a, b = map(int, input().split())", {"type": "assign", "name": "b", "from": "int_input"}), True)
    eq("int_input 두 줄", ok("a = input()\na = int(a)", {"type": "assign", "name": "a", "from": "int_input"}), True)
    eq("int_input 아님", ok("a = int('3')", {"type": "assign", "name": "a", "from": "int_input"}), False)
    eq("while", ok("i = 0\nwhile i < 3:\n    i += 1", {"type": "node", "node": "While"}), True)
    eq("forbid while", ok("while 0: pass", {"type": "forbid_node", "node": "While"}), False)
    eq("def 인자", ok("def f(a, b):\n    return a + b", {"type": "def", "name": "f", "args": 2}), True)
    eq("def return", ok("def f(a):\n    print(a)", {"type": "def", "name": "f", "returns": True}), False)
    eq("import 금지", ok("import math", {"type": "forbid_import", "name": "math"}), False)
    eq("method call", ok("a = []\na.append(1)", {"type": "call", "name": "append"}), True)
    eq("for 반복", ok("for i in range(10):\n    pass", {"type": "for", "var": "i", "range": [10]}), True)
    eq("list2d 문자열 숫자", ok('a = [["1", "kim"]]', {"type": "list2d", "name": "a", "value": [[1, "kim"]]}), True)


if __name__ == "__main__":
    test_live()
    test_grade()
    test_checks()
    print("\n실패 %d개" % len(FAILS) if FAILS else "\n모두 통과")
    sys.exit(1 if FAILS else 0)
