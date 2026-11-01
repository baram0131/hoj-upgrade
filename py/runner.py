"""Pyodide 워커에서 실행되는 IDLE/채점 런타임.

F5 실행: 최상위 코드의 input(...)은 ast로 await _input(...)으로 바꿔서
Shell에서 직접 입력을 기다린다. 함수, 제너레이터 식, 클래스 안의 input()처럼
await로 바꿀 수 없는 곳은 '다시 실행' 방식으로 처리한다. 입력이 필요해지면
지금까지 받은 입력을 미리 넣고 프로그램을 처음부터 다시 실행하되,
이미 보여 준 출력은 다시 보여 주지 않는다. random은 매번 같은 seed로 맞춘다.

채점: 입력값을 미리 넣어 두므로 변환 없이 그대로 실행한다.
"""
import ast
import builtins
import codeop
import inspect
import json
import linecache
import math
import random
import re
import sys
import traceback

try:
    import js  # Pyodide 워커 안에서만 존재
except ImportError:  # 로컬(tools/build.py)에서 import할 때
    js = None

from checker import run_checks

TLA = ast.PyCF_ALLOW_TOP_LEVEL_AWAIT
LIVE_LIMIT = 1_000_000     # Shell에 보낼 최대 글자 수
GRADE_LIMIT = 200_000      # 채점 시 최대 출력 글자 수
_INTERNAL = {__file__, sys.modules["checker"].__file__}


class OutputLimit(BaseException):
    pass


class _Abort(BaseException):
    """F5로 다시 실행할 때 입력 대기 중이던 프로그램을 조용히 끝낸다."""


class _State:
    sink = None
    sent = 0
    over = False
    skip = 0     # 다시 실행할 때 이미 보여 준 글자 수
    seen = 0     # 이번 실행에서 지금까지 나온 글자 수


_state = _State()


def _live_sink(stream, text):
    if _session[0] is not None and _session[0].pending:
        return
    start = _state.seen
    _state.seen += len(text)
    if _state.seen <= _state.skip:
        return
    if start < _state.skip:
        text = text[_state.skip - start:]
    if _state.over:
        return
    _state.sent += len(text)
    if _state.sent > LIVE_LIMIT:
        _state.over = True
        js.jsEmit("stderr", "\n[출력이 너무 많아 Shell 표시를 멈췄습니다.]\n")
        return
    js.jsEmit(stream, text)


class _Stream:
    def __init__(self, name):
        self.name = name

    def write(self, s):
        if not isinstance(s, str):
            raise TypeError("write() argument must be str, not %s" % type(s).__name__)
        if s and _state.sink is not None:
            _state.sink(self.name, s)
        return len(s)

    def writelines(self, lines):
        for line in lines:
            self.write(line)

    def flush(self):
        pass

    def isatty(self):
        return False

    def writable(self):
        return True

    @property
    def encoding(self):
        return "utf-8"


if js is not None:
    sys.stdout = _Stream("stdout")
    sys.stderr = _Stream("stderr")
    _state.sink = _live_sink


def _catches_all(h):
    return h.type is None or any(isinstance(n, ast.Name) and n.id == "BaseException"
                                 for n in ast.walk(h.type))


def _guard_try(node):
    """except: / except BaseException: 앞에 'except _hoj_need: raise'를 넣어서
    다시 실행 신호(_NeedInput)를 학생 코드가 삼키지 않게 한다."""
    if any(_catches_all(h) for h in node.handlers):
        guard = ast.ExceptHandler(type=ast.Name(id="_hoj_need", ctx=ast.Load()), name=None,
                                  body=[ast.Raise(exc=None, cause=None)])
        node.handlers.insert(0, ast.copy_location(guard, node.handlers[0]))
    return node


class _GuardTry(ast.NodeTransformer):
    """함수/클래스 안까지 모든 try에 _guard_try를 적용한다."""

    def visit_Try(self, node):
        self.generic_visit(node)
        return _guard_try(node)


class _InputToAwait(ast.NodeTransformer):
    def visit_FunctionDef(self, node):
        return node  # 함수 안의 input은 바꾸지 않는다

    # 아래 안쪽은 await를 쓸 수 없으므로 그대로 두고 '다시 실행' 방식으로 입력을 받는다.
    visit_AsyncFunctionDef = visit_FunctionDef
    visit_Lambda = visit_FunctionDef
    visit_GeneratorExp = visit_FunctionDef
    visit_ClassDef = visit_FunctionDef

    def visit_Call(self, node):
        self.generic_visit(node)
        if isinstance(node.func, ast.Name) and node.func.id == "input":
            call = ast.Call(func=ast.Name(id="_input", ctx=ast.Load()),
                            args=node.args, keywords=node.keywords)
            return ast.copy_location(ast.Await(value=call), node)
        return node


def _register(filename, src):
    linecache.cache[filename] = (len(src), None, src.splitlines(True), filename)


def _compile(src, filename, mode="exec"):
    tree = ast.parse(src, filename, mode)
    tree = _GuardTry().visit(tree)
    tree = _InputToAwait().visit(tree)
    ast.fix_missing_locations(tree)
    return compile(tree, filename, mode, flags=TLA, dont_inherit=True)


async def _exec(code, g):
    r = eval(code, g)
    if inspect.iscoroutine(r):
        await r


class _NeedInput(BaseException):
    """await로 바꾸지 못한 input()이 아직 받지 않은 입력을 요구할 때."""


class _Session:
    """input() 상태. answers: 받은 입력(순서대로), pos: 이번 실행에서 쓴 개수.
    live: Shell에서 직접 입력받을 수 있는지(채점은 False)."""

    def __init__(self, answers=None, live=True):
        self.answers = list(answers or [])
        self.pos = 0
        self.live = live
        self.interrupt = False  # 다음 입력에서 KeyboardInterrupt
        self.pending = False    # 입력이 필요해져서 다시 실행을 기다리는 중
        self.mark = 0           # 그때까지 나온 출력 글자 수

    def take(self, prompt):
        sys.stdout.write(str(prompt))
        if self.pos < len(self.answers):
            v = self.answers[self.pos]
            self.pos += 1
            if not self.live:
                sys.stdout.write(v + "\n")  # 채점: IDLE처럼 입력값을 출력에 남긴다
            return v, True
        if self.interrupt:
            self.interrupt = False
            raise KeyboardInterrupt
        if not self.live:
            raise EOFError("EOF when reading a line")
        return None, False

    def got(self, v):
        self.answers.append(v)
        self.pos += 1


_session = [None]


def _sync_input(prompt=""):
    s = _session[0]
    if s is None:
        raise RuntimeError("input()을 사용할 수 없습니다.")
    if s.pending:
        raise _NeedInput
    v, ok = s.take(prompt)
    if ok:
        return v
    s.pending = True
    s.mark = _state.seen
    raise _NeedInput


async def _async_input(prompt=""):
    s = _session[0]
    v, ok = s.take(prompt)
    if ok:
        return v
    v = await js.jsRequestInput()
    if v is None:
        raise KeyboardInterrupt
    if not isinstance(v, str):
        raise _Abort
    s.got(v)
    return v


builtins.input = _sync_input


def _new_globals(filename):
    g = {"__name__": "__main__", "__builtins__": builtins,
         "_input": _async_input, "input": _sync_input, "_hoj_need": _NeedInput}
    if filename and not filename.startswith("<"):
        g["__file__"] = filename
    return g


def _internal(filename):
    return filename in _INTERNAL or "_pyodide" in filename or "/pyodide/" in filename


def _clean(te, seen):
    if te is None or id(te) in seen:
        return
    seen.add(id(te))
    te.stack = traceback.StackSummary.from_list(
        [f for f in te.stack if not _internal(f.filename)])
    _clean(te.__cause__, seen)
    _clean(te.__context__, seen)


def _format_exc(e):
    te = traceback.TracebackException(type(e), e, e.__traceback__, compact=True)
    _clean(te, set())
    return "".join(te.format())


def _begin_live(skip=0):
    _state.sink = _live_sink
    _state.sent = 0 if not skip else _state.sent
    _state.over = False if not skip else _state.over
    _state.skip = skip
    _state.seen = 0


_shell = {"globals": None, "n": 0}


# Windows용 공식 파이썬의 시작 문구 (시험장 IDLE과 같게 보이도록)
_WIN_BUILDS = {
    "3.12.7": "tags/v3.12.7:0b05ead, Oct  1 2024, 03:06:41",
}


def version():
    import platform
    v = platform.python_version()
    build = _WIN_BUILDS.get(v, "tags/v%s" % v)
    return "Python %s (%s) [MSC v.1941 64 bit (AMD64)] on win32" % (v, build)


def _setup_builtins():
    """exit, quit, license를 Windows 파이썬과 같게 맞춘다."""
    import os
    import _sitebuiltins
    builtins.exit = _sitebuiltins.Quitter("exit", "Ctrl-Z plus Return")
    builtins.quit = _sitebuiltins.Quitter("quit", "Ctrl-Z plus Return")
    here = os.path.dirname(os.path.abspath(__file__))
    if os.path.exists(os.path.join(here, "python-license.txt")):
        builtins.license = _sitebuiltins._Printer(
            "license", "See https://www.python.org/psf/license/", ["python-license.txt"], [here])


# ── 편집기 도우미: 함수 설명(calltip)과 자동 완성. idlelib의 방식을 따른다. ──

_MAX_COLS = 85
_MAX_LINES = 5
_NAME_EXPR = re.compile(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*")


def _namespace():
    return {**sys.modules, **builtins.__dict__, **(_shell["globals"] or {})}


def _get_entity(expr):
    if not _NAME_EXPR.fullmatch(expr):
        return None, False
    try:
        return eval(expr, _namespace()), True
    except BaseException:
        return None, False


def _get_argspec(ob):
    import textwrap
    import types
    try:
        ob_call = ob.__call__
    except BaseException:
        return ""
    fob = ob_call if isinstance(ob_call, types.MethodType) else ob
    try:
        argspec = str(inspect.signature(fob))
    except Exception as err:
        msg = str(err)
        if msg.startswith("invalid method signature"):
            return "invalid method signature"
        argspec = ""
    if isinstance(fob, type) and argspec == "()":
        argspec = "See source or doc"
    lines = (textwrap.wrap(argspec, _MAX_COLS, subsequent_indent="    ")
             if len(argspec) > _MAX_COLS else [argspec] if argspec else [])
    doc = inspect.getdoc(ob)
    if doc:
        for line in doc.split("\n", _MAX_LINES)[:_MAX_LINES]:
            line = line.strip()
            if not line:
                break
            if len(line) > _MAX_COLS:
                line = line[:_MAX_COLS - 3] + "..."
            lines.append(line)
    return "\n".join(lines) or "See source or doc"


def calltip(expr):
    ob, ok = _get_entity(expr)
    return _get_argspec(ob) if ok else ""


def completions(what):
    """what: 'pri' 또는 'math.sq' -> JSON [자주 보이는 목록, 전체 목록]"""
    import keyword
    if "." in what:
        ob, ok = _get_entity(what.rsplit(".", 1)[0])
        if not ok:
            return json.dumps([[], []])
        try:
            big = sorted(set(dir(ob)))
            small = sorted(ob.__all__) if "__all__" in big else [x for x in big if x[:1] != "_"]
        except BaseException:
            return json.dumps([[], []])
    else:
        names = set(builtins.__dict__) | set(_shell["globals"] or {})
        names |= {k for k in keyword.kwlist if k not in ("True", "False", "None")}
        big = sorted(names)
        small = [x for x in big if x[:1] != "_"]
    return json.dumps([small, big])


def check_syntax(src, filename):
    """문법 에러가 없으면 빈 문자열, 있으면 JSON(msg, lineno, offset)."""
    try:
        compile(src, filename, "exec", dont_inherit=True)
        return ""
    except (SyntaxError, ValueError, OverflowError) as e:
        return json.dumps({
            "type": type(e).__name__,
            "msg": getattr(e, "msg", None) or str(e),
            "lineno": getattr(e, "lineno", None) or 1,
            "offset": getattr(e, "offset", None) or 0,
        })


async def _replay(attempt):
    """attempt()를 실행한다. await로 바꾸지 못한 input()이 입력을 요구하면, 입력을 받은 뒤
    지금까지 받은 입력을 미리 넣고 처음부터 다시 실행한다. 이미 보여 준 출력은 다시 보이지 않는다."""
    session = _Session()
    seed = random.randrange(1 << 30)
    skip = 0
    try:
        while True:
            _begin_live(skip)
            session.pos = 0
            session.pending = False
            _session[0] = session
            random.seed(seed)
            error = None
            try:
                await attempt()
            except _Abort:
                return
            except _NeedInput:
                pass
            except SystemExit as e:
                error = e
            except BaseException as e:
                error = e
            if session.pending:
                skip = session.mark
                session.pending = False
                v = await js.jsRequestInput()
                if v is None:
                    session.interrupt = True
                elif not isinstance(v, str):
                    return
                else:
                    session.answers.append(v)
                continue
            if isinstance(error, SystemExit):
                # IDLE처럼 exit("메시지")의 메시지만 보여 주고 >>> 로 돌아간다.
                ob = error.args[0] if error.args else None
                if not isinstance(ob, (type(None), int)):
                    sys.stderr.write("SystemExit: %s\n" % ob)
            elif error is not None:
                sys.stderr.write(_format_exc(error))
            return
    finally:
        _session[0] = None


async def run_program(src, filename):
    """F5: 새 이름 공간에서 프로그램을 실행한다. 실행 후 Shell은 그 이름 공간을 이어 쓴다."""
    _register(filename, src)
    try:
        code = _compile(src, filename)
    except BaseException as e:
        _begin_live()
        sys.stderr.write(_format_exc(e))
        return

    async def attempt():
        g = _new_globals(filename)
        _shell["globals"] = g
        await _exec(code, g)

    await _replay(attempt)


def reset_shell():
    _shell["globals"] = None


async def shell_run(src):
    """Shell 입력(여러 줄일 수 있음)을 실행한다. 문장이 끝나지 않았으면 'more'.
    함수 안의 input(), help(), license()처럼 입력이 필요하면 그 문장만 다시 실행한다."""
    _begin_live()
    try:
        code = codeop.compile_command(src, "<pyshell>", "single")
    except (SyntaxError, OverflowError, ValueError) as e:
        sys.stderr.write("%s: %s\n" % (type(e).__name__, getattr(e, "msg", None) or e))
        return "done"
    if code is None:
        return "more"
    if not src.strip():
        return "done"
    filename = "<pyshell#%d>" % _shell["n"]
    _shell["n"] += 1
    _register(filename, src + "\n")
    if _shell["globals"] is None:
        _shell["globals"] = _new_globals(None)
    try:
        code = _compile(src + "\n", filename, "single")
    except BaseException as e:
        sys.stderr.write(_format_exc(e))
        return "done"
    g = _shell["globals"]
    await _replay(lambda: _exec(code, g))
    return "done"


async def run_capture(src, stdin, limit=GRADE_LIMIT, after=None):
    """미리 넣은 입력으로 실행하고 (출력, 에러 이름)을 돌려준다.
    입력값은 IDLE처럼 출력에 '키 입력: 110' 형태로 남긴다.
    after: 학생 코드를 실행한 뒤 같은 이름 공간에서 이어서 실행할 코드(함수 채점용)."""
    out = []
    size = [0]

    def sink(stream, text):
        if stream != "stdout":
            return
        size[0] += len(text)
        if size[0] > limit:
            raise OutputLimit
        out.append(text)

    prev_sink, prev_out, prev_session = _state.sink, sys.stdout, _session[0]
    _state.sink = sink
    _session[0] = _Session([str(v) for v in stdin], live=False)
    if js is None:
        sys.stdout = _Stream("stdout")
    random.seed(0)
    try:
        g = _new_globals("<hoj>")
        exec(compile(src, "<hoj>", "exec", dont_inherit=True), g)
        if after:
            exec(compile(after, "<test>", "exec", dont_inherit=True), g)
        return "".join(out), None
    except OutputLimit:
        return "".join(out), "OutputLimit"
    except SystemExit:
        return "".join(out), None
    except BaseException as e:
        return "".join(out), type(e).__name__
    finally:
        _state.sink = prev_sink
        sys.stdout = prev_out
        _session[0] = prev_session


_NUM = re.compile(r"[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?")


def _split_nums(line):
    """'BMI: 23.4' -> (['BMI: ', ''], ['23.4'])"""
    return _NUM.split(line), _NUM.findall(line)


def _num_close(a, b, tol):
    if a == b:
        return True
    if tol <= 0 or not ("." in a or "e" in a.lower()) or not ("." in b or "e" in b.lower()):
        return False  # 정수끼리는 그대로 비교 (7 과 7.0 은 다름)
    try:
        return math.isclose(float(a), float(b), rel_tol=tol, abs_tol=tol)
    except ValueError:
        return False


def normalize(s, opts=None):
    opts = opts or {}
    lines = [line.rstrip() for line in s.replace("\r\n", "\n").split("\n")]
    if opts.get("ignore_space"):
        lines = [" ".join(line.split()) for line in lines]
    if opts.get("ignore_case"):
        lines = [line.lower() for line in lines]
    if opts.get("ignore_blank_lines"):
        lines = [line for line in lines if line]
    while lines and lines[-1] == "":
        lines.pop()
    return lines


def same_output(out, expected, opts=None):
    """줄 끝 공백과 마지막 빈 줄은 무시하고 비교한다.
    소수는 아주 작은 오차(기본 1e-9)까지 같다고 본다. 예: 23.437499999999996 == 23.4375"""
    opts = opts or {}
    a, b = normalize(out, opts), normalize(expected, opts)
    if a == b:
        return True
    tol = opts.get("float_tol", 1e-9)
    if len(a) != len(b) or tol <= 0:
        return False
    for x, y in zip(a, b):
        if x == y:
            continue
        (tx, nx), (ty, ny) = _split_nums(x), _split_nums(y)
        if tx != ty or len(nx) != len(ny):
            return False
        if not all(_num_close(p, q, tol) for p, q in zip(nx, ny)):
            return False
    return True


def _lines(v):
    """문자열 또는 줄 목록을 코드 문자열로."""
    if not v:
        return v or None
    return "\n".join(v) + "\n" if isinstance(v, list) else v


def solution_text(p):
    return _lines(p.get("solution")) or ""


async def grade(src, problem_json):
    p = json.loads(problem_json)
    try:
        tree = ast.parse(src)
        compile(src, "<hoj>", "exec", dont_inherit=True)
    except (SyntaxError, ValueError, OverflowError) as e:
        line = getattr(e, "lineno", None)
        msg = getattr(e, "msg", None) or str(e)
        return json.dumps({"verdict": "syntax",
                           "detail": "%d번째 줄: %s" % (line, msg) if line else msg})

    failed = run_checks(tree, p.get("checks", []))
    if failed:
        return json.dumps({"verdict": "condition", "detail": failed})

    tests = p.get("tests", [])
    for i, t in enumerate(tests):
        if js is not None:
            js.jsProgress(i, len(tests))
        stdin = t.get("stdin", [])
        after = _lines(t.get("after"))
        out, err = await run_capture(src, stdin, after=after)
        if err == "OutputLimit":
            return json.dumps({"verdict": "ole"})
        if err:
            return json.dumps({"verdict": "runtime", "detail": err})
        expected = t.get("output")
        if expected is None:
            expected, _ = await run_capture(solution_text(p), stdin, after=after)
        if not same_output(out, expected, p.get("compare")):
            return json.dumps({"verdict": "wrong", "detail": "%d번째 테스트" % (i + 1)})
    return json.dumps({"verdict": "ac"})


if js is not None:
    _setup_builtins()
