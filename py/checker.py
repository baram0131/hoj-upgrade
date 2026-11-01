"""문제 JSON의 "checks"를 ast로 검사한다.

각 조건은 {"type": ..., "desc": ...} 형태이며, 통과하지 못하면 desc가
"조건 미충족 (desc)"로 표시된다. 사용할 수 있는 type은 README.md 참고.

변수 검사는 중간 변수를 거쳐도 인정한다.
  m = height / 100        bmi = weight / m ** 2   -> bmi는 height, weight를 이용함
  row = a[n - 1]          height = row[2]         -> a를 두 겹 인덱싱함
  num, name, h, w = a[n - 1]                      -> a를 두 겹 인덱싱함
"""
import ast

CHECKS = {}


def check(name):
    def deco(fn):
        CHECKS[name] = fn
        return fn
    return deco


# ── 공통 도우미 ──

def _set_parents(tree):
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            child._hoj_parent = node


def _parents(node):
    cur = getattr(node, "_hoj_parent", None)
    while cur is not None:
        yield cur
        cur = getattr(cur, "_hoj_parent", None)


def _inside(node, kinds):
    return any(isinstance(p, kinds) for p in _parents(node))


def _loop_depth(node):
    return sum(1 for p in _parents(node) if isinstance(p, (ast.For, ast.While)))


def _target_names(node):
    targets = []
    if isinstance(node, ast.Assign):
        targets = node.targets
    elif isinstance(node, (ast.AnnAssign, ast.AugAssign)):
        targets = [node.target]
    names = set()
    for t in targets:
        for n in ast.walk(t):
            if isinstance(n, ast.Name):
                names.add(n.id)
    return names


def _is_call(node, name):
    return (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
            and node.func.id == name)


def _call_name(node):
    """f(...) -> 'f', a.append(...) -> 'append', 그 밖에는 None"""
    if not isinstance(node, ast.Call):
        return None
    if isinstance(node.func, ast.Name):
        return node.func.id
    if isinstance(node.func, ast.Attribute):
        return node.func.attr
    return None


def _names_in(node):
    return {n.id for n in ast.walk(node) if isinstance(n, ast.Name)}


def _input_funcs(tree):
    """input()을 부르는 사용자 함수 이름들"""
    cache = getattr(tree, "_hoj_input_funcs", None)
    if cache is None:
        cache = {n.name for n in ast.walk(tree)
                 if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
                 and any(_is_call(m, "input") for m in ast.walk(n))}
        tree._hoj_input_funcs = cache
    return cache


def _has_input(tree, node):
    funcs = _input_funcs(tree) | {"input"}
    return any(isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in funcs
               for n in ast.walk(node))


def _assigned(tree):
    """변수 이름 -> [(대입한 식, 풀어서 넣었는지)]. a, b = ... 와 for x in ... 도 포함."""
    cache = getattr(tree, "_hoj_assigned", None)
    if cache is not None:
        return cache
    cache = {}

    def add(target, value, unpack):
        if isinstance(target, ast.Starred):
            target = target.value
        if isinstance(target, ast.Name):
            cache.setdefault(target.id, []).append((value, unpack))
        elif isinstance(target, (ast.Tuple, ast.List)):
            for t in target.elts:
                add(t, value, True)

    for n in ast.walk(tree):
        if isinstance(n, ast.Assign):
            for t in n.targets:
                add(t, n.value, False)
        elif isinstance(n, (ast.AnnAssign, ast.AugAssign)) and n.value is not None:
            add(n.target, n.value, False)
        elif isinstance(n, ast.NamedExpr):
            add(n.target, n.value, False)
        elif isinstance(n, (ast.For, ast.comprehension)):
            add(n.target, n.iter, True)
    tree._hoj_assigned = cache
    return cache


def _deps(tree, node, seen=None):
    """식이 (중간 변수를 거쳐서라도) 기대는 변수 이름들"""
    seen = set() if seen is None else seen
    out = set()
    for name in _names_in(node):
        out.add(name)
        if name in seen:
            continue
        seen.add(name)
        for v, _ in _assigned(tree).get(name, []):
            out |= _deps(tree, v, seen)
    return out


def _is_int_input(tree, value):
    """int(input(...)), int(input().strip()), s = input() 뒤 int(s), map(int, input().split())"""
    if (_is_call(value, "map") and len(value.args) == 2
            and isinstance(value.args[0], ast.Name) and value.args[0].id == "int"):
        return _has_input(tree, value.args[1])
    if _is_call(value, "list") and value.args:
        return _is_int_input(tree, value.args[0])
    if not (_is_call(value, "int") and value.args):
        return False
    arg = value.args[0]
    if _has_input(tree, arg):
        return True
    if isinstance(arg, ast.Name):
        return any(_has_input(tree, v) for v, _ in _assigned(tree).get(arg.id, []))
    return False


def _subscript_chain(node):
    depth = 0
    while isinstance(node, ast.Subscript):
        depth += 1
        node = node.value
    return depth, node


def _sub_depth(tree, node, list_name, seen=None):
    """식 안에서 list_name을 몇 겹 인덱싱했는지 (중간 변수 포함). list_name이 None이면 아무 리스트."""
    seen = set() if seen is None else seen
    best = 0
    for n in ast.walk(node):
        if isinstance(n, ast.Subscript):
            d, root = _subscript_chain(n)
        elif isinstance(n, ast.Name):
            d, root = 0, n
        else:
            continue
        if not isinstance(root, ast.Name):
            continue
        if d and (list_name is None or root.id == list_name):
            best = max(best, d)
            continue
        if root.id == list_name or root.id in seen:
            continue
        seen.add(root.id)
        for v, unpack in _assigned(tree).get(root.id, []):
            inner = _sub_depth(tree, v, list_name, seen)
            if inner:
                best = max(best, inner + d + (1 if unpack else 0))
        seen.discard(root.id)
    return best


_SAFE_NODES = (ast.Expression, ast.Constant, ast.BinOp, ast.UnaryOp,
               ast.operator, ast.unaryop)


def _const_value(node):
    """1, 4+1, -1 같은 숫자 식만 계산한다. 계산할 수 없으면 None."""
    if not all(isinstance(n, _SAFE_NODES) for n in ast.walk(node)):
        return None
    try:
        return eval(compile(ast.Expression(node), "<range>", "eval"),
                    {"__builtins__": {}})
    except Exception:
        return None


def _range_matches(iter_node, spec):
    if spec is None:
        return True
    if not (_is_call(iter_node, "range") and 1 <= len(iter_node.args) <= 3):
        return False
    args = [_const_value(a) for a in iter_node.args]
    if any(not isinstance(a, int) for a in args):
        return False
    return list(range(*args)) == list(range(*spec))


def _for_name(node):
    return node.target.id if isinstance(node.target, ast.Name) else None


def _print_calls(tree):
    return [n for n in ast.walk(tree) if _is_call(n, "print")]


def _cell(x):
    """2차원 리스트 비교용: 180 과 "180" 은 같게 본다."""
    return str(x).strip()


# ── 조건 ──

@check("assign")
def _assign(tree, c):
    """변수 name에 값을 대입했는지. from: any | input | int_input | subscript | uses"""
    name = c["name"]
    kind = c.get("from", "any")
    for v, unpack in _assigned(tree).get(name, []):
        if kind == "any":
            return True
        if kind == "input" and _has_input(tree, v):
            return True
        if kind == "int_input" and _is_int_input(tree, v):
            return True
        if kind == "subscript":
            d = _sub_depth(tree, v, c.get("list")) + (1 if unpack else 0)
            if d >= c.get("depth", 2):
                return True
        if kind == "uses" and set(c.get("names", [])) <= _deps(tree, v):
            return True
    return False


@check("if_elif_else")
def _if_elif_else(tree, c):
    """if ~ elif ~ else 구조. elif: 최소 elif 개수, else: false면 else 없어도 됨,
    in_for: 반복문 안에 있어야 하는지"""
    need = c.get("elif", 1)
    need_else = c.get("else", True)
    in_loop = c.get("in_for", False)
    for n in ast.walk(tree):
        if not isinstance(n, ast.If):
            continue
        # 다른 if의 elif로 붙은 if는 따로 세지 않는다
        parent = getattr(n, "_hoj_parent", None)
        if (isinstance(parent, ast.If) and parent.orelse == [n]
                and n.col_offset == parent.col_offset):
            continue
        cur, elifs = n, 0
        while (len(cur.orelse) == 1 and isinstance(cur.orelse[0], ast.If)
               and cur.orelse[0].col_offset == n.col_offset):
            cur = cur.orelse[0]
            elifs += 1
        if (elifs >= need and (cur.orelse or not need_else)
                and (not in_loop or _inside(n, (ast.For, ast.While)))):
            return True
    return False


@check("nested_for")
def _nested_for(tree, c):
    """이중 for문. outer/inner: 반복 변수 이름, outer_range/inner_range: range 인자"""
    outer, inner = c.get("outer"), c.get("inner")
    for n in ast.walk(tree):
        if not isinstance(n, ast.For):
            continue
        if outer and _for_name(n) != outer:
            continue
        if not _range_matches(n.iter, c.get("outer_range")):
            continue
        for m in ast.walk(n):
            if m is n or not isinstance(m, ast.For):
                continue
            if inner and _for_name(m) != inner:
                continue
            if _range_matches(m.iter, c.get("inner_range")):
                return True
    return False


@check("for")
def _for(tree, c):
    """for문. var: 반복 변수, range: range 인자, over: 반복할 리스트 이름"""
    for n in ast.walk(tree):
        if not isinstance(n, ast.For):
            continue
        if c.get("var") and _for_name(n) != c["var"]:
            continue
        if not _range_matches(n.iter, c.get("range")):
            continue
        if c.get("over") and not (isinstance(n.iter, ast.Name) and n.iter.id == c["over"]):
            continue
        return True
    return False


@check("print_end")
def _print_end(tree, c):
    """print(..., end=...) 사용. value를 주면 end 값까지 비교"""
    for call in _print_calls(tree):
        for kw in call.keywords:
            if kw.arg != "end":
                continue
            if "value" not in c:
                return True
            if isinstance(kw.value, ast.Constant) and kw.value.value == c["value"]:
                return True
    return False


@check("loop_print")
def _loop_print(tree, c):
    """값을 출력하는 print는 모두 반복문 depth겹 안에 있고, 출력할 값은 max_args개 이하.
    (빈 print()는 어디서나 허용) 도형을 한 번에 출력하는 우회를 막는다."""
    depth = c.get("depth", 2)
    max_args = c.get("max_args", 1)
    for call in _print_calls(tree):
        if not call.args:
            continue
        if any(isinstance(a, ast.Starred) for a in call.args) or len(call.args) > max_args:
            return False
        if _loop_depth(call) < depth:
            return False
    return True


@check("max_str_len")
def _max_str_len(tree, c):
    """코드 안의 모든 문자열이 max 글자 이하인지 (출력 모양 하드코딩 방지)"""
    limit = c["max"]
    for n in ast.walk(tree):
        if isinstance(n, ast.Constant) and isinstance(n.value, str):
            if len(n.value) > limit:
                return False
    return True


@check("list2d")
def _list2d(tree, c):
    """name = [[...], [...]] 형태의 2차원 리스트. value를 주면 데이터까지 비교
    (숫자를 문자열로 저장해도 같은 값으로 본다)"""
    name = c["name"]
    want = [[_cell(x) for x in row] for row in c["value"]] if "value" in c else None
    for n in ast.walk(tree):
        if not isinstance(n, ast.Assign) or name not in _target_names(n):
            continue
        v = n.value
        if not (isinstance(v, ast.List) and v.elts
                and all(isinstance(e, (ast.List, ast.Tuple)) for e in v.elts)):
            continue
        if want is None:
            return True
        try:
            data = [[_cell(x) for x in row] for row in ast.literal_eval(v)]
        except Exception:
            continue
        if data == want:
            return True
    return False


@check("subscript")
def _subscript(tree, c):
    """리스트 인덱스 접근. list: 리스트 이름, depth: [ ][ ] 개수"""
    return _sub_depth(tree, tree, c.get("list")) >= c.get("depth", 1)


@check("call")
def _call(tree, c):
    """함수 name을 min번 이상 호출 (a.append() 같은 메서드도 됨)"""
    count = sum(1 for n in ast.walk(tree) if _call_name(n) == c["name"])
    return count >= c.get("min", 1)


@check("forbid_call")
def _forbid_call(tree, c):
    """함수 name을 사용하지 않음"""
    return not any(_call_name(n) == c["name"] for n in ast.walk(tree))


@check("node")
def _node(tree, c):
    """문법 요소 사용. node: While, For, ListComp, FunctionDef, Return, Break 등 ast 이름, min: 최소 개수"""
    kind = getattr(ast, c["node"])
    return sum(1 for n in ast.walk(tree) if isinstance(n, kind)) >= c.get("min", 1)


@check("forbid_node")
def _forbid_node(tree, c):
    """문법 요소 사용 금지. 예: {"node": "While"}"""
    kind = getattr(ast, c["node"])
    return not any(isinstance(n, kind) for n in ast.walk(tree))


@check("def")
def _def(tree, c):
    """함수 정의. name, args: 매개변수 개수, returns: return 값이 있어야 하는지"""
    for n in ast.walk(tree):
        if not isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if c.get("name") and n.name != c["name"]:
            continue
        if "args" in c and len(n.args.posonlyargs) + len(n.args.args) != c["args"]:
            continue
        if c.get("returns") and not any(isinstance(m, ast.Return) and m.value is not None
                                        for m in ast.walk(n)):
            continue
        return True
    return False


def _imports(tree):
    names = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Import):
            names |= {a.name.split(".")[0] for a in n.names}
        elif isinstance(n, ast.ImportFrom) and n.module:
            names.add(n.module.split(".")[0])
    return names


@check("import")
def _import(tree, c):
    """모듈 name을 import"""
    return c["name"] in _imports(tree)


@check("forbid_import")
def _forbid_import(tree, c):
    """모듈 import 금지. name을 생략하면 모든 import 금지"""
    names = _imports(tree)
    return not names if "name" not in c else c["name"] not in names


@check("max_lines")
def _max_lines(tree, c):
    """빈 줄과 주석을 뺀 코드가 max줄 이하"""
    lines = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.stmt):
            lines.add(n.lineno)
    return len(lines) <= c["max"]


def run_checks(tree, checks):
    """처음으로 통과하지 못한 조건의 desc를 돌려준다. 모두 통과하면 None."""
    _set_parents(tree)
    for c in checks:
        fn = CHECKS.get(c.get("type"))
        if fn is None:
            raise ValueError("알 수 없는 조건 type: %r" % c.get("type"))
        if not fn(tree, c):
            return c.get("desc", c["type"])
    return None
