// IDLE 기본 색상 규칙을 따르는 파이썬 문법 색칠.
// 키워드: 주황, 내장 이름: 보라, 문자열: 초록, 주석: 빨강, def/class 이름: 파랑

export const KEYWORDS = new Set(
  ("False None True and as assert async await break class continue def del elif else " +
   "except finally for from global if import in is lambda nonlocal not or pass raise " +
   "return try while with yield").split(" ")
);

// IDLE은 builtins 모듈의 이름(예외 클래스 포함)을 모두 보라색으로 칠한다.
export const BUILTINS = new Set(
  ("abs aiter all anext any ascii bin bool breakpoint bytearray bytes callable chr " +
   "classmethod compile complex copyright credits delattr dict dir divmod enumerate eval " +
   "exec exit filter float format frozenset getattr globals hasattr hash help hex id input " +
   "int isinstance issubclass iter len license list locals map max memoryview min next " +
   "object oct open ord pow print property quit range repr reversed round set setattr " +
   "slice sorted staticmethod str sum super tuple type vars zip " +
   "ArithmeticError AssertionError AttributeError BaseException BaseExceptionGroup " +
   "BlockingIOError BrokenPipeError BufferError BytesWarning ChildProcessError " +
   "ConnectionAbortedError ConnectionError ConnectionRefusedError ConnectionResetError " +
   "DeprecationWarning EOFError Ellipsis EncodingWarning EnvironmentError Exception " +
   "ExceptionGroup FileExistsError FileNotFoundError FloatingPointError FutureWarning " +
   "GeneratorExit IOError ImportError ImportWarning IndentationError IndexError " +
   "InterruptedError IsADirectoryError KeyError KeyboardInterrupt LookupError MemoryError " +
   "ModuleNotFoundError NameError NotADirectoryError NotImplemented NotImplementedError " +
   "OSError OverflowError PendingDeprecationWarning PermissionError ProcessLookupError " +
   "RecursionError ReferenceError ResourceWarning RuntimeError RuntimeWarning " +
   "StopAsyncIteration StopIteration SyntaxError SyntaxWarning SystemError SystemExit " +
   "TabError TimeoutError TypeError UnboundLocalError UnicodeDecodeError " +
   "UnicodeEncodeError UnicodeError UnicodeTranslateError UnicodeWarning UserWarning " +
   "ValueError Warning ZeroDivisionError").split(" ")
);

const END = "(?![\\s\\S])";
const TOKEN = new RegExp(
  [
    "(#[^\\n]*)",
    "((?:\\b[rRbBfFuU]{1,2})?(?:" +
      `"""[\\s\\S]*?(?:"""|${END})|'''[\\s\\S]*?(?:'''|${END})|` +
      `"(?:[^"\\\\\\n]|\\\\[\\s\\S])*(?:"|(?=\\n)|${END})|` +
      `'(?:[^'\\\\\\n]|\\\\[\\s\\S])*(?:'|(?=\\n)|${END})` +
    "))",
    "([\\p{L}_][\\p{L}\\p{N}_]*)",
  ].join("|"),
  "gu"
);

export function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

// [{start, end, cls}] 목록을 돌려준다.
export function tokenize(text) {
  const out = [];
  let afterDef = false;
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    if (m[1] !== undefined) {
      out.push({ start, end, cls: "c" });
    } else if (m[2] !== undefined) {
      out.push({ start, end, cls: "s" });
      afterDef = false;
    } else {
      const w = m[3];
      if (afterDef) {
        out.push({ start, end, cls: "d" });
        afterDef = false;
      } else if (KEYWORDS.has(w)) {
        out.push({ start, end, cls: "k" });
        afterDef = w === "def" || w === "class";
      } else if (BUILTINS.has(w) && text[start - 1] !== ".") {
        out.push({ start, end, cls: "b" });
      }
    }
  }
  return out;
}

// errorAt: 빨간 배경으로 표시할 글자 위치(없으면 -1)
// mark: [시작, 끝] 범위를 회색 배경으로 (IDLE의 괄호 짝 표시)
export function highlight(text, errorAt = -1, mark = null) {
  const tokens = tokenize(text);
  let html = "";
  let pos = 0;
  const piece = (from, to, cls) => {
    if (to <= from) return;
    if (mark && mark[0] < to && mark[1] > from && (mark[0] > from || mark[1] < to)) {
      const a = Math.max(from, mark[0]);
      const b = Math.min(to, mark[1]);
      piece(from, a, cls);
      piece(a, b, cls);
      piece(b, to, cls);
      return;
    }
    if (mark && from >= mark[0] && to <= mark[1]) {
      const saved = mark;
      mark = null;
      html += '<span class="hl-paren">';
      piece(from, to, cls);
      html += "</span>";
      mark = saved;
      return;
    }
    if (errorAt >= from && errorAt < to) {
      piece(from, errorAt, cls);
      const ch = text[errorAt] === "\n" ? " " : text[errorAt];
      html += `<span class="hl-err">${escapeHtml(ch)}</span>`;
      if (text[errorAt] === "\n") html += "\n";
      piece(errorAt + 1, to, cls);
      return;
    }
    const s = escapeHtml(text.slice(from, to));
    html += cls ? `<span class="hl-${cls}">${s}</span>` : s;
  };
  for (const t of tokens) {
    piece(pos, t.start, null);
    piece(t.start, t.end, t.cls);
    pos = t.end;
  }
  piece(pos, text.length, null);
  if (errorAt >= text.length) html += '<span class="hl-err"> </span>';
  return html;
}
