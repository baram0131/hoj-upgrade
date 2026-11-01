// IDLE Shell: 출력은 색깔별 span으로 쌓고, 입력은 마지막 줄의 편집 가능한 span에서 받는다.
import { highlight } from "./highlight.js";
import { fixSmartQuotes, noAutoFix } from "./editor.js";

const MAX_CHARS = 400000;
const SQUEEZE_LINES = 50; // IDLE Squeezer: 한 번에 50줄 이상 출력하면 버튼으로 접는다

// 80칸 기준으로 줄바꿈까지 센 줄 수 (IDLE count_lines_with_wrapping)
export function countLines(text, width = 80) {
  let n = 0;
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    let len = 0;
    for (const c of line) len += c === "\t" ? 8 - (len % 8) : 1;
    n += Math.max(1, Math.ceil(len / width));
  }
  return n;
}
const HAS_SMART = /[“”‘’„′″—…]/;

export class Shell {
  constructor(host, opts = {}) {
    this.opts = opts;
    this.host = host;
    host.classList.add("sh");
    host.innerHTML = '<pre class="sh-out"></pre>';
    this.out = host.querySelector("pre");
    this.queue = [];
    this.flushing = false;
    this.input = null;
    this.mode = null;
    this.lastChar = "\n";
    this.size = 0;
    this.history = [];
    this.histPos = 0;

    host.addEventListener("mouseup", () => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && host.contains(sel.anchorNode)) return;
      this.focus();
    });
  }

  // 출력 쓰기. cls: out(파랑) err(빨강) con(갈색, 프롬프트) in(검정, 입력값) null(검정)
  write(text, cls = null) {
    if (!text) return;
    this.queue.push([text, cls, false]);
    this.lastChar = text[text.length - 1];
    if (!this.flushing) {
      this.flushing = true;
      requestAnimationFrame(() => this.flush());
    }
  }

  // 긴 출력은 "Squeezed text (N lines)." 버튼으로 (더블클릭하면 펼침)
  writeSqueezed(text, cls) {
    this.queue.push([text, cls, "squeeze"]);
    this.lastChar = text[text.length - 1];
    if (!this.flushing) {
      this.flushing = true;
      requestAnimationFrame(() => this.flush());
    }
  }

  squeezeButton(text, cls) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "squeezed";
    const n = countLines(text);
    b.textContent = `Squeezed text (${n} lines).`;
    b.title = "Double-click to expand, right-click for more options.";
    const expand = () => {
      const span = document.createElement("span");
      span.dataset.cls = "x";
      if (cls) span.className = "s-" + cls;
      span.textContent = text.endsWith("\n") ? text : text + "\n";
      b.replaceWith(span);
    };
    b.addEventListener("dblclick", expand);
    if (matchMedia("(pointer: coarse)").matches) b.addEventListener("click", expand);
    b.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      squeezeMenu(e.clientX, e.clientY, [
        ["copy", () => navigator.clipboard?.writeText(text)],
        ["view", () => viewText(text)],
      ]);
    });
    return b;
  }

  writeHtml(html, plain) {
    this.queue.push([html, null, true]);
    this.lastChar = plain[plain.length - 1] || this.lastChar;
    if (!this.flushing) {
      this.flushing = true;
      requestAnimationFrame(() => this.flush());
    }
  }

  flush() {
    this.flushing = false;
    const q = this.queue;
    this.queue = [];
    if (!q.length) return;
    const atBottom = this.isAtBottom();
    const before = this.input;
    for (const [text, cls, isHtml] of q) {
      let node;
      if (isHtml === "squeeze") {
        node = this.squeezeButton(text, cls);
        // IDLE처럼 버튼 다음 줄부터 이어서 쓴다
        this.out.insertBefore(node, before);
        if (text.endsWith("\n")) this.out.insertBefore(document.createTextNode("\n"), before);
        continue;
      } else if (isHtml) {
        node = document.createElement("span");
        node.innerHTML = text;
      } else {
        const prev = before ? before.previousSibling : this.out.lastChild;
        if (prev && prev.nodeType === 1 && prev.dataset.cls === String(cls)) {
          prev.firstChild.appendData(text);
          this.size += text.length;
          continue;
        }
        node = document.createElement("span");
        node.dataset.cls = String(cls);
        if (cls) node.className = "s-" + cls;
        node.appendChild(document.createTextNode(text));
      }
      this.size += text.length;
      this.out.insertBefore(node, before);
    }
    while (this.size > MAX_CHARS && this.out.firstChild && this.out.firstChild !== this.input) {
      this.size -= this.out.firstChild.textContent.length;
      this.out.removeChild(this.out.firstChild);
    }
    if (atBottom) this.scrollBottom();
    this.reportCursor();
  }

  flushNow() {
    if (this.queue.length) this.flush();
  }

  isAtBottom() {
    const h = this.host;
    return h.scrollHeight - h.scrollTop - h.clientHeight < 40;
  }

  scrollBottom() {
    this.host.scrollTop = this.host.scrollHeight;
  }

  ensureNewline() {
    if (this.lastChar !== "\n") this.write("\n");
  }

  clear() {
    this.queue = [];
    this.out.textContent = "";
    this.input = null;
    this.size = 0;
    this.lastChar = "\n";
  }

  // IDLE 3.12처럼 >>> 와 ... 는 왼쪽 칸(사이드바)에 표시한다.
  prompt() {
    this.ensureNewline();
    this.write(">>>", "con");
    this.startInput("cmd");
  }

  more(indent) {
    this.write("...", "con");
    this.startInput("cmd", indent);
  }

  // mode: cmd(>>> 명령) | stdin(input() 응답)
  // pending: 실행 결과를 기다리는 동안 미리 친 글자를 받아 두는 칸
  startInput(mode, initial = "") {
    this.flushNow();
    const carry = this.input && this.mode === "pending" ? this.input.textContent : "";
    this.endInput();
    initial += carry;
    const span = document.createElement("span");
    span.className = "sh-in";
    try { span.contentEditable = "plaintext-only"; } catch { /* 지원하지 않는 브라우저 */ }
    if (span.contentEditable !== "plaintext-only") span.contentEditable = "true";
    noAutoFix(span);
    span.setAttribute("role", "textbox");
    span.setAttribute("aria-label", "Shell 입력");
    span.textContent = initial;
    span.addEventListener("keydown", (e) => this.onKey(e));
    span.addEventListener("beforeinput", (e) => {
      if (e.inputType === "insertText" && e.data && HAS_SMART.test(e.data)) {
        e.preventDefault();
        document.execCommand("insertText", false, fixSmartQuotes(e.data));
      } else if (e.inputType === "insertParagraph" || e.inputType === "insertLineBreak") {
        e.preventDefault();
      }
    });
    span.addEventListener("input", (e) => {
      if (HAS_SMART.test(span.textContent)) {
        span.textContent = fixSmartQuotes(span.textContent);
        this.caretToEnd();
      }
      this.reportCursor();
      this.opts.assist?.typed(e.data || "");
    });
    span.addEventListener("blur", () => this.opts.assist?.hide());
    span.addEventListener("paste", (e) => {
      e.preventDefault();
      const t = (e.clipboardData?.getData("text/plain") || "").replace(/\r?\n[\s\S]*$/, "");
      document.execCommand("insertText", false, fixSmartQuotes(t));
    });
    span.addEventListener("keyup", () => this.reportCursor());
    span.addEventListener("focus", () => this.opts.onFocus?.());
    this.out.appendChild(span);
    this.input = span;
    this.mode = mode;
    this.histPos = this.history.length;
    this.scrollBottom();
    if (this.opts.shouldFocus?.()) this.focus();
    this.reportCursor();
  }

  endInput() {
    this.opts.assist?.hide();
    if (!this.input) return "";
    const text = this.input.textContent;
    this.input.remove();
    this.input = null;
    this.mode = null;
    return text;
  }

  focus() {
    if (!this.input) return;
    this.input.focus({ preventScroll: true });
    this.caretToEnd();
  }

  caretToEnd() {
    if (!this.input) return;
    const r = document.createRange();
    r.selectNodeContents(this.input);
    r.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  insertText(t) {
    if (!this.input) return;
    if (document.activeElement !== this.input) this.focus();
    document.execCommand("insertText", false, t);
  }

  reportCursor() {
    if (!this.opts.onCursor) return;
    const text = this.out.textContent;
    let line = 1;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
    const last = text.slice(text.lastIndexOf("\n") + 1);
    this.opts.onCursor({ line, col: last.length });
  }

  submit() {
    if (!this.input || this.mode === "pending") return;
    const mode = this.mode;
    const text = this.endInput();
    if (mode === "cmd") {
      if (text.trim()) this.history.push(text);
      this.writeHtml(highlight(text) + "\n", text + "\n");
    } else {
      this.write(text + "\n", "in");
    }
    this.startInput("pending");
    this.opts.onSubmit?.(mode, text);
  }

  onKey(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (this.opts.assist?.key(e)) {
      e.preventDefault();
      return;
    }
    if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      this.submit();
    } else if (e.key === "Tab" && !mod) {
      e.preventDefault();
      document.execCommand("insertText", false, "    ");
    } else if (e.ctrlKey && e.code === "KeyC") {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      e.preventDefault();
      this.opts.onInterrupt?.();
    } else if (e.altKey && (e.code === "KeyP" || e.code === "KeyN") && this.mode === "cmd") {
      e.preventDefault();
      if (!this.history.length) return;
      this.histPos += e.code === "KeyP" ? -1 : 1;
      this.histPos = Math.max(0, Math.min(this.histPos, this.history.length));
      this.input.textContent = this.history[this.histPos] ?? "";
      this.caretToEnd();
    } else if (e.key === "F6" && e.ctrlKey) {
      e.preventDefault();
      this.opts.onRestart?.();
    } else if (e.key === "F5") {
      e.preventDefault();
      this.opts.onRun?.();
    }
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) setTimeout(() => this.opts.assist?.moved());
  }

  // Shell > View Last Restart
  viewLastRestart() {
    const spans = [...this.out.children].filter((n) => n.textContent.includes("RESTART:"));
    const last = spans[spans.length - 1];
    if (!last) return;
    const top = last.offsetTop - this.host.offsetTop;
    this.host.scrollTop = Math.max(0, last.offsetTop - 4);
    return top;
  }
}

function squeezeMenu(x, y, items) {
  document.querySelector(".sq-menu")?.remove();
  const m = document.createElement("div");
  m.className = "menu-list sq-menu";
  for (const [label, fn] of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "menu-item";
    b.textContent = label;
    b.addEventListener("click", () => { m.remove(); fn(); });
    m.appendChild(b);
  }
  m.style.cssText = `display:block;position:fixed;left:${x}px;top:${y}px;min-width:120px`;
  document.body.appendChild(m);
  setTimeout(() => document.addEventListener("mousedown", function off(e) {
    if (!m.contains(e.target)) { m.remove(); document.removeEventListener("mousedown", off); }
  }));
}

// 접힌 출력 보기 (IDLE의 view: 읽기 전용 창)
function viewText(text) {
  const back = document.createElement("div");
  back.className = "dlg-back";
  back.innerHTML = '<div class="dlg dlg-view" role="dialog"><div class="dlg-title">Squeezed Output Viewer</div><pre></pre><div class="dlg-btns"><button type="button">Close</button></div></div>';
  back.querySelector("pre").textContent = text;
  const close = () => back.remove();
  back.querySelector("button").addEventListener("click", close);
  back.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  document.body.appendChild(back);
  back.querySelector("button").focus();
}
