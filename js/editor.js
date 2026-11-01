// IDLE 편집기: textarea 위에 색칠한 pre를 겹쳐 보여준다.
import { highlight } from "./highlight.js";

const INDENT = 4;
const SMART = { "“": '"', "”": '"', "‘": "'", "’": "'", "„": '"', "′": "'", "″": '"' };
const SMART_RE = /[\u201C\u201D\u2018\u2019\u201E\u2032\u2033\u2014\u2026]/g;
const HAS_SMART = /[\u201C\u201D\u2018\u2019\u201E\u2032\u2033\u2014\u2026]/;

export function fixSmartQuotes(s) {
  return s.replace(SMART_RE, (c) => (c === "—" ? "--" : c === "…" ? "..." : SMART[c]));
}

export function noAutoFix(el) {
  el.setAttribute("autocapitalize", "off");
  el.setAttribute("autocorrect", "off");
  el.setAttribute("autocomplete", "off");
  el.setAttribute("spellcheck", "false");
  el.setAttribute("data-gramm", "false");
}

// 문자열, 주석을 건너뛰며 아직 닫히지 않은 괄호를 찾는다.
// inString: 닫히지 않은 삼중 따옴표 문자열 안에서 끝났는지
export function scanOpen(text) {
  const stack = [];
  let inString = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "#") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = text.startsWith(c.repeat(3), i);
      const q = triple ? c.repeat(3) : c;
      i += q.length;
      let closed = false;
      while (i < n) {
        if (text[i] === "\\") { i += 2; continue; }
        if (text.startsWith(q, i)) { i += q.length; closed = true; break; }
        if (!triple && text[i] === "\n") break;
        i++;
      }
      if (triple && !closed) inString = true;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") stack.push(i);
    else if ((c === ")" || c === "]" || c === "}") && stack.length) stack.pop();
    i++;
  }
  return { stack, inString };
}

// text[open]의 괄호와 짝이 되는 닫는 괄호 위치 (문자열, 주석은 건너뜀). 없으면 -1
export function matchForward(text, open) {
  let depth = 0;
  let i = open;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "#") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = text.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      i += q.length;
      while (i < n && !text.startsWith(q, i)) {
        if (text[i] === "\\") i++;
        else if (q.length === 1 && text[i] === "\n") break;
        i++;
      }
      i += q.length;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

export function stripComment(line) {
  // 문자열 안의 #은 무시하고 주석만 떼어 낸다.
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === "\\") i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}

const leading = (s) => s.match(/^[ \t]*/)[0];
const width = (ws) => ws.replace(/\t/g, " ".repeat(8)).length;

// 커서 앞까지의 코드(before)를 보고 다음 줄 들여쓰기 칸 수를 정한다 (IDLE 규칙).
export function computeIndent(before) {
  const { stack } = scanOpen(before);
  if (stack.length) {
    const b = stack[stack.length - 1];
    const bLineStart = before.lastIndexOf("\n", b - 1) + 1;
    let bLineEnd = before.indexOf("\n", b);
    if (bLineEnd < 0) bLineEnd = before.length;
    const rest = stripComment(before.slice(b + 1, bLineEnd));
    if (rest.trim() === "") return width(leading(before.slice(bLineStart))) + INDENT;
    return b - bLineStart + 1 + (rest.length - rest.trimStart().length);
  }
  const line = before.slice(before.lastIndexOf("\n") + 1);
  let indent = width(leading(line));
  const code = stripComment(line).trimEnd();
  if (code.endsWith(":")) indent += INDENT;
  else if (/^\s*(return|pass|break|continue|raise)\b/.test(code)) indent = Math.max(0, indent - INDENT);
  return indent;
}

export class Editor {
  constructor(host, opts = {}) {
    this.opts = opts;
    this.errorAt = -1;
    host.classList.add("ed");
    host.innerHTML = '<div class="ed-ln" aria-hidden="true"><pre></pre></div>' +
      '<pre class="ed-hl" aria-hidden="true"><code></code></pre><textarea class="ed-ta" wrap="off"></textarea>';
    this.host = host;
    this.code = host.querySelector("code");
    this.ln = host.querySelector(".ed-ln pre");
    this.lineCount = 0;
    this.ta = host.querySelector("textarea");
    noAutoFix(this.ta);
    this.ta.setAttribute("aria-label", "편집기");

    this.ta.addEventListener("beforeinput", (e) => this.onBeforeInput(e));
    this.ta.addEventListener("input", (e) => this.onInput(e));
    this.ta.addEventListener("keydown", (e) => {
      // 자동 완성 창, 단축키 등은 idle.js가 먼저 처리한다.
      if (this.opts.onKeyFirst?.(e)) { e.preventDefault(); e.stopPropagation(); return; }
      this.onKey(e);
    });
    this.ta.addEventListener("scroll", () => this.syncScroll());
    for (const ev of ["keyup", "click", "focus", "select", "mouseup"]) {
      this.ta.addEventListener(ev, () => this.reportCursor());
    }
    document.addEventListener("selectionchange", () => {
      if (document.activeElement === this.ta) this.reportCursor();
    });
  }

  get value() { return this.ta.value; }
  set value(v) {
    this.ta.value = v;
    this.errorAt = -1;
    this.render();
    this.reportCursor();
  }

  focus() { this.ta.focus(); }

  render() {
    // 마지막 줄 높이를 맞추기 위해 개행 하나를 더 둔다.
    this.code.innerHTML = highlight(this.ta.value, this.errorAt, this.mark) + "\n";
    this.renderLines();
    this.syncScroll();
  }

  // 줄 번호 (IDLE: Options > Show Line Numbers)
  renderLines() {
    let n = 1;
    const v = this.ta.value;
    for (let i = 0; i < v.length; i++) if (v.charCodeAt(i) === 10) n++;
    if (n === this.lineCount) return;
    this.lineCount = n;
    let s = "";
    for (let i = 1; i <= n; i++) s += i + "\n";
    this.ln.textContent = s;
    this.host.style.setProperty("--digits", Math.max(2, String(n).length));
  }

  set lineNumbers(on) { this.host.classList.toggle("ed-show-ln", on); }
  get lineNumbers() { return this.host.classList.contains("ed-show-ln"); }

  syncScroll() {
    this.code.style.transform = `translate(${-this.ta.scrollLeft}px, ${-this.ta.scrollTop}px)`;
    this.ln.style.transform = `translateY(${-this.ta.scrollTop}px)`;
  }

  cursor() {
    const pos = this.ta.selectionEnd;
    const before = this.ta.value.slice(0, pos);
    const line = before.split("\n").length;
    const col = pos - (before.lastIndexOf("\n") + 1);
    return { line, col };
  }

  reportCursor() {
    this.opts.onCursor?.(this.cursor());
  }

  // 되돌리기(Ctrl+Z)가 유지되도록 execCommand로 넣는다.
  insert(text, from = this.ta.selectionStart, to = this.ta.selectionEnd) {
    const ta = this.ta;
    ta.focus();
    ta.setSelectionRange(from, to);
    let ok = false;
    const before = ta.value.length;
    try {
      ok = text ? document.execCommand("insertText", false, text)
        : from === to || document.execCommand("delete", false);
    } catch { ok = false; }
    const expected = before - (to - from) + text.length;
    if (!ok || ta.value.length !== expected || ta.value.slice(from, from + text.length) !== text) {
      ta.setRangeText(text, from, to, "end");
      this.onInput();
    }
  }

  onBeforeInput(e) {
    if (e.inputType === "insertText" && e.data && HAS_SMART.test(e.data)) {
      e.preventDefault();
      this.insert(fixSmartQuotes(e.data));
    }
  }

  onInput(e) {
    const ta = this.ta;
    if (HAS_SMART.test(ta.value)) {
      const pos = ta.selectionEnd;
      const head = fixSmartQuotes(ta.value.slice(0, pos));
      ta.value = head + fixSmartQuotes(ta.value.slice(pos));
      ta.setSelectionRange(head.length, head.length);
    }
    this.errorAt = -1;
    this.mark = null;
    if (e?.data && /[)\]}]$/.test(e.data)) this.flashMatch(ta.selectionStart - 1);
    this.render();
    this.reportCursor();
    this.opts.onChange?.(ta.value);
    this.opts.onTyped?.(e?.data || "");
  }

  // IDLE처럼 닫는 괄호를 치면 짝이 되는 괄호까지를 잠깐 회색으로 보여 준다.
  flashMatch(closeAt) {
    const v = this.ta.value;
    const close = v[closeAt];
    const { stack } = scanOpen(v.slice(0, closeAt));
    if (!stack.length) return;
    const open = stack[stack.length - 1];
    if ({ ")": "(", "]": "[", "}": "{" }[close] !== v[open]) return;
    this.showMark(open, closeAt + 1);
  }

  // 커서를 둘러싼 괄호 (Edit > Show Surrounding Parens)
  flashSurrounding() {
    const v = this.ta.value;
    const pos = this.ta.selectionStart;
    const { stack } = scanOpen(v.slice(0, pos));
    if (!stack.length) return;
    const open = stack[stack.length - 1];
    const end = matchForward(v, open);
    if (end >= 0) this.showMark(open, end + 1);
  }

  showMark(from, to) {
    clearTimeout(this.markTimer);
    this.mark = [from, to];
    this.render();
    this.markTimer = setTimeout(() => { this.mark = null; this.render(); }, 500);
  }

  // Format > Strip Trailing Whitespace
  stripTrailing() {
    const v = this.ta.value;
    const out = v.split("\n").map((l) => l.replace(/[ \t]+$/, "")).join("\n").replace(/\n+$/, "\n");
    if (out !== v) {
      const pos = Math.min(this.ta.selectionStart, out.length);
      this.insert(out, 0, v.length);
      this.ta.setSelectionRange(pos, pos);
    }
  }

  // Format > Untabify Region
  untabifyRegion(cols = 8) {
    this.replaceLines((l) => {
      let out = "";
      for (const c of l) out += c === "\t" ? " ".repeat(cols - (out.length % cols)) : c;
      return out;
    });
  }

  // IDLE의 Home: 처음에는 들여쓰기 다음으로, 한 번 더 누르면 줄 맨 앞으로
  home(extend) {
    const ta = this.ta;
    const pos = ta.selectionDirection === "backward" ? ta.selectionStart : ta.selectionEnd;
    const { start } = this.lineBounds(pos);
    const first = start + leading(ta.value.slice(start, this.lineBounds(pos).end)).length;
    const target = pos === first ? start : first;
    if (extend) {
      const anchor = ta.selectionDirection === "backward" ? ta.selectionEnd : ta.selectionStart;
      if (target < anchor) ta.setSelectionRange(target, anchor, "backward");
      else ta.setSelectionRange(anchor, target, "forward");
    } else {
      ta.setSelectionRange(target, target);
    }
    this.reportCursor();
  }

  lineBounds(pos) {
    const v = this.ta.value;
    const start = v.lastIndexOf("\n", pos - 1) + 1;
    let end = v.indexOf("\n", pos);
    if (end < 0) end = v.length;
    return { start, end };
  }

  // 선택 영역이 걸친 줄 전체 범위
  selectedLines() {
    const { selectionStart: s, selectionEnd: e0 } = this.ta;
    let e = e0;
    if (e > s && this.ta.value[e - 1] === "\n") e--;
    const start = this.lineBounds(s).start;
    const end = this.lineBounds(e).end;
    return { start, end, lines: this.ta.value.slice(start, end).split("\n") };
  }

  replaceLines(fn) {
    const { start, end, lines } = this.selectedLines();
    const text = lines.map(fn).join("\n");
    this.insert(text, start, end);
    this.ta.setSelectionRange(start, start + text.length);
  }

  indentRegion() { this.replaceLines((l) => " ".repeat(INDENT) + l); }

  dedentRegion() {
    this.replaceLines((l) => {
      const ws = leading(l);
      const w = width(ws);
      const target = Math.max(0, Math.floor((w - 1) / INDENT) * INDENT);
      return w ? " ".repeat(target) + l.slice(ws.length) : l;
    });
  }

  commentRegion() { this.replaceLines((l) => "##" + l); }
  uncommentRegion() { this.replaceLines((l) => l.replace(/^(\s*)##?/, "$1")); }

  tab() {
    const ta = this.ta;
    const { selectionStart: s, selectionEnd: e } = ta;
    if (s !== e && ta.value.slice(s, e).includes("\n")) return this.indentRegion();
    const col = s - this.lineBounds(s).start;
    this.insert(" ".repeat(INDENT - (col % INDENT)));
  }

  newline() {
    const ta = this.ta;
    const v = ta.value;
    let pos = ta.selectionStart;
    let endSel = ta.selectionEnd;
    const { start, end } = this.lineBounds(pos);
    const lineBefore = v.slice(start, pos);
    // IDLE처럼 커서 앞뒤의 공백은 지운다(공백만 있는 줄은 들여쓰기 유지).
    const onlyWs = lineBefore.trim() === "";
    let from = pos;
    if (!onlyWs) while (from > start && (v[from - 1] === " " || v[from - 1] === "\t")) from--;
    while (endSel < end && (v[endSel] === " " || v[endSel] === "\t")) endSel++;

    const indent = computeIndent(v.slice(0, from));
    this.insert("\n" + " ".repeat(indent), from, endSel);
  }

  backspace(e) {
    const ta = this.ta;
    const { selectionStart: s, selectionEnd: en } = ta;
    if (s !== en) return false;
    const { start } = this.lineBounds(s);
    const before = ta.value.slice(start, s);
    if (!before.endsWith(" ")) return false;
    const col = before.length;
    const target = Math.floor((col - 1) / INDENT) * INDENT;
    let from = s;
    while (from > start + target && ta.value[from - 1] === " ") from--;
    if (s - from <= 1) return false;
    e.preventDefault();
    this.insert("", from, s);
    return true;
  }

  gotoLine(n) {
    const lines = this.ta.value.split("\n");
    n = Math.max(1, Math.min(n, lines.length));
    let pos = 0;
    for (let i = 0; i < n - 1; i++) pos += lines[i].length + 1;
    this.ta.focus();
    this.ta.setSelectionRange(pos, pos);
    this.scrollToCaret();
    this.reportCursor();
  }

  scrollToCaret() {
    const { line, col } = this.cursor();
    const lh = parseFloat(getComputedStyle(this.ta).lineHeight) || 19;
    const y = (line - 1) * lh;
    const ta = this.ta;
    if (y < ta.scrollTop) ta.scrollTop = y;
    else if (y + lh * 2 > ta.scrollTop + ta.clientHeight) ta.scrollTop = y - ta.clientHeight + lh * 2;
    if (col === 0) ta.scrollLeft = 0;
    this.syncScroll();
  }

  // 문법 에러 위치 표시 (lineno, offset은 파이썬 SyntaxError 값)
  markError(lineno, offset) {
    const lines = this.ta.value.split("\n");
    if (offset === 0) { lineno += 1; offset = 1; }
    lineno = Math.max(1, Math.min(lineno, lines.length));
    let pos = 0;
    for (let i = 0; i < lineno - 1; i++) pos += lines[i].length + 1;
    pos += Math.max(0, Math.min(offset - 1, lines[lineno - 1].length));
    this.errorAt = pos;
    this.render();
    this.ta.focus();
    this.ta.setSelectionRange(pos, pos);
    this.scrollToCaret();
    this.reportCursor();
  }

  onKey(e) {
    const k = e.key;
    const mod = e.ctrlKey || e.metaKey;
    if (k === "Tab" && !mod && !e.altKey) {
      e.preventDefault();
      if (e.shiftKey) this.dedentRegion();
      else this.tab();
    } else if (k === "Enter" && !mod && !e.altKey && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      this.newline();
    } else if (k === "Backspace" && !mod && !e.altKey) {
      this.backspace(e);
    } else if (mod && (k === "]" || e.code === "BracketRight")) {
      e.preventDefault();
      this.indentRegion();
    } else if (mod && (k === "[" || e.code === "BracketLeft")) {
      e.preventDefault();
      this.dedentRegion();
    } else if (e.altKey && e.code === "Digit3") {
      e.preventDefault();
      this.commentRegion();
    } else if (e.altKey && e.code === "Digit4") {
      e.preventDefault();
      this.uncommentRegion();
    } else if (e.altKey && e.code === "KeyG") {
      e.preventDefault();
      this.opts.onGoto?.();
    } else if (e.altKey && e.code === "KeyX") {
      e.preventDefault();
      this.opts.onCheck?.();
    } else if (mod && e.code === "KeyS") {
      e.preventDefault();
      this.opts.onSave?.();
    } else if (k === "F5") {
      e.preventDefault();
      this.opts.onRun?.();
    } else if (k === "Home" && !mod && !e.altKey) {
      e.preventDefault();
      this.home(e.shiftKey);
    }
  }
}
