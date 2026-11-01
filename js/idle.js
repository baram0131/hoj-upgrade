// IDLE 화면(편집기 창 + Shell 창)과 실행 흐름.
import { Editor, computeIndent, scanOpen, stripComment } from "./editor.js";
import { Shell, countLines } from "./shell.js";
import { Runtime } from "./runtime.js";
import { escapeHtml } from "./highlight.js";
import { Assist, textareaTarget, shellTarget } from "./assist.js";
import { openSearch, findAgain } from "./search.js";

// 페이지를 옮겨 다녀도 Pyodide는 한 번만 불러온다.
let runtime = null;
let active = null;
let standaloneProgress = null;
function getRuntime() {
  if (!runtime) {
    const relay = (name) => (...args) => active?.[name]?.(...args);
    runtime = new Runtime({
      onReady: relay("onReady"),
      onFatal: relay("onFatal"),
      onOut: relay("onOut"),
      onInput: relay("onInput"),
      onProgress: (...args) => (standaloneProgress ? standaloneProgress(...args) : active?.onProgress?.(...args)),
    });
  }
  return runtime;
}

// IDLE 화면 없이 채점만 한다 (시험 모드에서 여러 문항을 한 번에 채점할 때).
// 화면에 붙은 Idle이 없을 때만 부른다.
export async function gradeCode(problem, code, onProgress) {
  const rt = getRuntime();
  while (!rt.ready) await new Promise((r) => setTimeout(r, 100));
  const perTest = (problem.time_limit || 0.4) * 1000;
  const limit = 3000 + perTest * (problem.tests?.length || 1);
  let timer;
  const timeout = new Promise((r) => { timer = setTimeout(() => r({ verdict: "tle" }), limit); });
  standaloneProgress = onProgress || null;
  let result;
  try {
    result = await Promise.race([rt.grade(code, problem), timeout]);
  } catch {
    result = { verdict: "error" };
  }
  clearTimeout(timer);
  standaloneProgress = null;
  if (result.verdict === "tle") rt.restart();
  return result;
}

// IDLE 3.12 메뉴 (웹에서 할 수 없는 것은 뺐다)
const editorMenus = (short) => [
  ["File", [["Open...", "Ctrl+O", "open"], null, ["Save", "Ctrl+S", "save"], ["Save As...", "Ctrl+Shift+S", "saveAs"]]],
  ["Edit", [["Undo", "Ctrl+Z", "undo"], ["Redo", "Ctrl+Shift+Z", "redo"], null,
    ["Select All", "Ctrl+A", "selectAll"], ["Cut", "Ctrl+X", "cut"], ["Copy", "Ctrl+C", "copy"], ["Paste", "Ctrl+V", "paste"], null,
    ["Find...", "Ctrl+F", "find"], ["Find Again", "Ctrl+G", "findAgain"], ["Replace...", "Ctrl+H", "replace"],
    ["Go to Line", "Alt+G", "goto"], null,
    ["Show Completions", "Ctrl+Space", "completions"], ["Show Call Tip", "Ctrl+Backslash", "calltip"],
    ["Show Surrounding Parens", "Ctrl+0", "parens"]]],
  ["Format", [["Indent Region", "Ctrl+]", "indent"], ["Dedent Region", "Ctrl+[", "dedent"],
    ["Comment Out Region", "Alt+3", "comment"], ["Uncomment Region", "Alt+4", "uncomment"], null,
    ["Untabify Region", "Alt+6", "untabify"], ["Strip Trailing Whitespace", "", "strip"]]],
  ["Run", [["Run Module", "F5", "run"], ["Check Module", "Alt+X", "check"], ["Python Shell", "", "focusShell"]]],
  ["Options", [["Show Line Numbers", "", "lineNumbers"]]],
  ["Window", [["IDLE Shell", "", "focusShell"], [short, "", "focusEditor"]]],
  ["Help", [["About IDLE", "", "about"], null, ["IDLE Help", "", "help"], ["Python Docs", "F1", "docs"]]],
];

const shellMenus = (short) => [
  ["File", [["Save As...", "Ctrl+Shift+S", "saveShell"]]],
  ["Edit", [["Copy", "Ctrl+C", "copy"], ["Paste", "Ctrl+V", "paste"], null,
    ["Show Completions", "Ctrl+Space", "shellCompletions"], ["Show Call Tip", "Ctrl+Backslash", "shellCalltip"]]],
  ["Shell", [["View Last Restart", "F6", "lastRestart"], ["Restart Shell", "Ctrl+F6", "restart"], null,
    ["Previous History", "Alt+P", "histPrev"], ["Next History", "Alt+N", "histNext"], null,
    ["Interrupt Execution", "Ctrl+C", "interrupt"]]],
  ["Debug", []],
  ["Options", []],
  ["Window", [["IDLE Shell", "", "focusShell"], [short, "", "focusEditor"]]],
  ["Help", [["About IDLE", "", "about"], null, ["IDLE Help", "", "help"], ["Python Docs", "F1", "docs"]]],
];

const LN_KEY = "hoj:lineNumbers";
function lineNumbersOn() {
  try { return localStorage.getItem(LN_KEY) !== "0"; } catch { return true; }
}


const KEYS = [
  ["실행", "run"], ["중단", "interrupt"], ["Tab", "tab"], ["내어쓰기", "dedent"],
  [":", ":"], ["(", "("], [")", ")"], ["[", "["], ["]", "]"], ['"', '"'], ["'", "'"],
  ["=", "="], ["<", "<"], [">", ">"], ["+", "+"], ["-", "-"], ["*", "*"], ["/", "/"],
  ["%", "%"], [",", ","], [".", "."], ["#", "#"], ["_", "_"],
];

function menuBar(menus, onAction) {
  const bar = document.createElement("div");
  bar.className = "win-menu";
  for (const [label, items] of menus) {
    const m = document.createElement("div");
    m.className = "menu";
    const b = document.createElement("button");
    b.type = "button";
    b.className = "menu-btn";
    b.textContent = label;
    m.appendChild(b);
    if (items.length) {
      const list = document.createElement("div");
      list.className = "menu-list";
      for (const it of items) {
        if (!it) {
          list.appendChild(Object.assign(document.createElement("div"), { className: "menu-sep" }));
          continue;
        }
        const [text, key, action] = it;
        const row = document.createElement("button");
        row.type = "button";
        row.className = "menu-item";
        row.dataset.action = action;
        row.innerHTML = `<span>${escapeHtml(text)}</span><span class="menu-key">${escapeHtml(key)}</span>`;
        row.addEventListener("mousedown", (e) => e.preventDefault());
        row.addEventListener("click", () => {
          closeMenus();
          onAction(action);
        });
        list.appendChild(row);
      }
      m.appendChild(list);
    }
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => {
      const open = m.classList.contains("open");
      closeMenus();
      if (!open && items.length) m.classList.add("open");
    });
    b.addEventListener("mouseenter", () => {
      if (document.querySelector(".menu.open") && !m.classList.contains("open")) {
        closeMenus();
        if (items.length) m.classList.add("open");
      }
    });
    bar.appendChild(m);
  }
  return bar;
}

function closeMenus() {
  document.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open"));
}
document.addEventListener("mousedown", (e) => {
  if (!e.target.closest(".menu")) closeMenus();
});

// IDLE 대화 상자 흉내 (그림자 없이 단순한 창)
export function dialog({ title, message, input = false, value = "", buttons = ["OK"] }) {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "dlg-back";
    back.innerHTML = `
      <div class="dlg" role="dialog" aria-label="${escapeHtml(title)}">
        <div class="dlg-title">${escapeHtml(title)}</div>
        <div class="dlg-body">
          <div class="dlg-msg">${escapeHtml(message)}</div>
          ${input ? `<input class="dlg-input" type="text" inputmode="numeric" value="${escapeHtml(value)}">` : ""}
        </div>
        <div class="dlg-btns">${buttons.map((b, i) => `<button type="button" data-i="${i}">${escapeHtml(b)}</button>`).join("")}</div>
      </div>`;
    document.body.appendChild(back);
    const field = back.querySelector(".dlg-input");
    const done = (i) => {
      back.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(i === 0 ? (input ? field.value : true) : null);
    };
    const onKey = (e) => {
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); done(0); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(1); }
    };
    document.addEventListener("keydown", onKey, true);
    back.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => done(+b.dataset.i)));
    (field || back.querySelector("button")).focus();
    field?.select();
  });
}

function charWidth(el) {
  const probe = document.createElement("span");
  probe.textContent = "0".repeat(20);
  probe.style.visibility = "hidden";
  probe.style.position = "absolute";
  el.appendChild(probe);
  const w = probe.getBoundingClientRect().width / 20;
  probe.remove();
  return w || 8;
}

export class Idle {
  constructor(host, { filename, storageKey, onChange, initial = "" }) {
    this.filename = filename;
    this.short = filename.split("\\").pop();
    this.storageKey = storageKey;
    this.onChangeCb = onChange;
    this.state = "loading";
    this.lastFocus = "editor";
    this.modified = false;
    this.readyWaiters = [];
    this.restarting = false;
    this.rt = getRuntime();

    host.innerHTML = `
      <div class="idle">
        <div class="win win-ed">
          <div class="win-title"></div>
          <div class="win-body ed-host"></div>
          <div class="win-status"><span class="st-pos"></span></div>
        </div>
        <div class="keybar" aria-label="입력 보조"></div>
        <div class="win win-sh">
          <div class="win-title">IDLE Shell</div>
          <div class="win-body sh-host"></div>
          <div class="win-status"><span class="st-pos"></span></div>
        </div>
      </div>`;
    const edWin = host.querySelector(".win-ed");
    const shWin = host.querySelector(".win-sh");
    edWin.insertBefore(menuBar(editorMenus(this.short), (a) => this.action(a)), edWin.children[1]);
    shWin.insertBefore(menuBar(shellMenus(this.short), (a) => this.action(a)), shWin.children[1]);
    this.edTitle = edWin.querySelector(".win-title");
    this.shTitle = shWin.querySelector(".win-title");
    const edPos = edWin.querySelector(".st-pos");
    const shPos = shWin.querySelector(".st-pos");
    const showPos = (el) => ({ line, col }) => { el.textContent = `Ln: ${line}   Col: ${col}`; };

    this.editor = new Editor(host.querySelector(".ed-host"), {
      onCursor: showPos(edPos),
      onChange: (v) => this.changed(v),
      onRun: () => this.run(),
      onCheck: () => this.checkModule(),
      onGoto: () => this.gotoLine(),
      onSave: () => this.save(),
      onKeyFirst: (e) => this.edAssist.key(e) || this.editorShortcut(e),
      onTyped: (data) => this.edAssist.typed(data),
    });
    this.edAssist = new Assist(textareaTarget(this.editor), this.rt);
    this.shAssist = new Assist(shellTarget(null), this.rt);
    this.editor.ta.addEventListener("focus", () => { this.lastFocus = "editor"; });
    this.editor.ta.addEventListener("blur", () => this.edAssist.hide());
    for (const ev of ["click", "keyup"]) this.editor.ta.addEventListener(ev, () => this.edAssist.moved());
    this.editor.ta.addEventListener("scroll", () => this.edAssist.hide());

    this.shell = new Shell(host.querySelector(".sh-host"), {
      onCursor: showPos(shPos),
      onSubmit: (mode, text) => this.shellSubmit(mode, text),
      onInterrupt: () => this.interrupt(),
      onRestart: () => this.restartShell(),
      onRun: () => this.run(),
      onFocus: () => { this.lastFocus = "shell"; },
      shouldFocus: () => this.lastFocus === "shell" || this.state === "input",
      assist: this.shAssist,
    });
    this.shAssist.t = shellTarget(this.shell);
    this.shell.host.addEventListener("scroll", () => this.shAssist.hide());

    this.buildKeybar(host.querySelector(".keybar"));
    this.lnItem = edWin.querySelector('.menu-item[data-action="lineNumbers"] span');
    this.setLineNumbers(lineNumbersOn());

    let saved = null;
    try { saved = localStorage.getItem(storageKey); } catch { saved = null; }
    if (saved == null) saved = initial;
    this.editor.value = saved;
    this.updateTitle();
    edPos.textContent = "Ln: 1   Col: 0";
    shPos.textContent = "Ln: 1   Col: 0";

    this.onKeyGlobal = (e) => {
      if (document.querySelector(".dlg-back")) return;
      if (e.key === "F5") { e.preventDefault(); this.run(); }
      else if (e.key === "F6" && e.ctrlKey) { e.preventDefault(); this.restartShell(); }
      else if (e.key === "F6") { e.preventDefault(); this.shell.viewLastRestart(); }
      else if (e.key === "F1") { e.preventDefault(); this.action("docs"); }
      else if (e.key === "Escape") closeMenus();
    };
    document.addEventListener("keydown", this.onKeyGlobal);

    active = this;
    if (this.rt.ready) {
      this.rt.reset();
      this.onReady(this.rt.version);
    } else {
      this.shell.write("Python을 불러오는 중입니다...", "note");
    }
  }

  destroy() {
    document.removeEventListener("keydown", this.onKeyGlobal);
    this.edAssist.hide();
    this.shAssist.hide();
    document.querySelector(".search")?.remove();
    if (active === this) active = null;
    if (this.state === "running" || this.state === "grading") this.rt.restart();
    else if (this.state === "input") this.rt.abortInput();
  }

  get version() {
    const m = /^Python (\S+)/.exec(this.rt.version || "");
    return m ? m[1] : "";
  }

  updateTitle() {
    const v = this.version ? ` (${this.version})` : "";
    this.edTitle.textContent = `${this.modified ? "*" : ""}${this.short} - ${this.filename}${v}`;
    this.shTitle.textContent = this.version ? `IDLE Shell ${this.version}` : "IDLE Shell";
  }

  changed(v) {
    try { localStorage.setItem(this.storageKey, v); } catch { /* 저장 공간 없음 */ }
    if (!this.modified) {
      this.modified = true;
      this.updateTitle();
    }
    this.onChangeCb?.(v);
  }

  save() {
    try { localStorage.setItem(this.storageKey, this.editor.value); } catch { /* 무시 */ }
    this.modified = false;
    this.updateTitle();
  }

  get code() { return this.editor.value; }
  set code(v) {
    this.editor.value = v;
    this.changed(v);
  }

  bar(tag) {
    const host = this.shell.host;
    const cw = charWidth(this.shell.out);
    const cols = Math.floor((host.clientWidth - 3 * cw - 28) / cw) || 80;
    const w = Math.min(80, cols - 1);
    const half = "=".repeat(Math.max(1, Math.floor((w - tag.length - 4) / 2)));
    return `${half} ${tag} ${half}`;
  }

  // ── 런타임 이벤트 ──
  onReady(version) {
    this.updateTitle();
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    if (this.restarting) {
      this.restarting = false;
      this.shell.endInput();
      this.shell.ensureNewline();
      this.shell.write(this.bar("RESTART: Shell") + "\n");
    } else {
      this.shell.clear();
      this.shell.write(`${version}\nType "help", "copyright", "credits" or "license()" for more information.\n`);
    }
    this.state = "idle";
    this.shell.prompt();
    waiters.forEach((f) => f());
    if (this.pendingRun) {
      this.pendingRun = false;
      this.run();
    }
  }

  onFatal(msg) {
    this.shell.clear();
    this.shell.write("Python을 불러오지 못했습니다. 인터넷 연결을 확인한 뒤 새로고침하세요.\n" + msg + "\n", "err");
  }

  onOut(text, stream) {
    const cls = stream === "stderr" ? "err" : "out";
    if (countLines(text) >= 50) this.shell.writeSqueezed(text, cls);
    else this.shell.write(text, cls);
  }

  onInput() {
    this.state = "input";
    this.shell.startInput("stdin");
  }

  onProgress(i, n) {
    this.progressCb?.(i, n);
  }

  waitReady() {
    if (this.rt.ready && this.state !== "loading") return Promise.resolve();
    return new Promise((r) => this.readyWaiters.push(r));
  }

  restartWorker() {
    this.restarting = true;
    this.state = "loading";
    this.shell.endInput();
    this.rt.restart();
    return this.waitReady();
  }

  // 실행 중인 프로그램을 끝내고 Shell을 >>> 상태로 만든다.
  async stopCurrent() {
    if (this.state === "input") {
      this.rt.abortInput();
      await this.job;
    } else if (this.state === "running") {
      await this.restartWorker();
    } else if (this.state === "loading") {
      await this.waitReady();
    }
  }

  setLineNumbers(on) {
    this.editor.lineNumbers = on;
    // IDLE처럼 메뉴 글자가 Show / Hide 로 바뀐다.
    if (this.lnItem) this.lnItem.textContent = on ? "Hide Line Numbers" : "Show Line Numbers";
    try { localStorage.setItem(LN_KEY, on ? "1" : "0"); } catch { /* 무시 */ }
  }

  // ── 동작 ──
  action(a) {
    const ed = this.editor;
    switch (a) {
      case "save": this.save(); break;
      case "undo": ed.focus(); document.execCommand("undo"); break;
      case "redo": ed.focus(); document.execCommand("redo"); break;
      case "selectAll": ed.focus(); ed.ta.select(); break;
      case "goto": this.gotoLine(); break;
      case "indent": ed.indentRegion(); break;
      case "dedent": ed.dedentRegion(); break;
      case "comment": ed.commentRegion(); break;
      case "uncomment": ed.uncommentRegion(); break;
      case "run": this.run(); break;
      case "check": this.checkModule(); break;
      case "restart": this.restartShell(); break;
      case "interrupt": this.interrupt(); break;
      case "lineNumbers": this.setLineNumbers(!this.editor.lineNumbers); break;
      case "help": location.hash = "#/help"; break;
      case "open": this.openFile(); break;
      case "saveAs": this.download(this.short, this.code); break;
      case "saveShell": this.download("shell.txt", this.shell.out.textContent); break;
      case "cut": ed.focus(); document.execCommand("cut"); break;
      case "copy": document.execCommand("copy"); break;
      case "paste": this.paste(); break;
      case "find": openSearch(ed, false); break;
      case "findAgain": findAgain(ed); break;
      case "replace": openSearch(ed, true); break;
      case "completions": ed.focus(); this.edAssist.complete(true); break;
      case "calltip": ed.focus(); this.edAssist.openTip(true); break;
      case "shellCompletions": this.shell.focus(); this.shAssist.complete(true); break;
      case "shellCalltip": this.shell.focus(); this.shAssist.openTip(true); break;
      case "parens": ed.focus(); ed.flashSurrounding(); break;
      case "untabify": this.untabify(); break;
      case "strip": ed.stripTrailing(); break;
      case "focusShell": this.lastFocus = "shell"; this.shell.focus(); break;
      case "focusEditor": ed.focus(); break;
      case "lastRestart": this.shell.viewLastRestart(); break;
      case "histPrev": case "histNext":
        this.shell.focus();
        this.shell.onKey(new KeyboardEvent("keydown", { altKey: true, code: a === "histPrev" ? "KeyP" : "KeyN" }));
        break;
      case "docs": window.open("https://docs.python.org/3.12/", "_blank", "noopener"); break;
      case "about": this.about(); break;
    }
  }

  // 편집기 전용 단축키 (IDLE 키 설정)
  editorShortcut(e) {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && !e.altKey && k === "f") this.action("find");
    else if (mod && !e.altKey && k === "g") this.action("findAgain");
    else if (mod && !e.altKey && k === "h") this.action("replace");
    else if (mod && !e.altKey && k === "o") this.action("open");
    else if (mod && e.shiftKey && k === "s") this.action("saveAs");
    else if (mod && (e.key === "0" || e.code === "Digit0")) this.action("parens");
    else if (e.altKey && e.code === "Digit6") this.action("untabify");
    else return false;
    return true;
  }

  async untabify() {
    const v = await dialog({ title: "Tab width", message: "Columns per tab? (2-16)", input: true, value: "8", buttons: ["OK", "Cancel"] });
    const n = parseInt(v, 10);
    if (n >= 2 && n <= 16) this.editor.untabifyRegion(n);
    this.editor.focus();
  }

  async paste() {
    const target = this.lastFocus === "shell" && this.shell.input ? this.shell : this.editor;
    try {
      const t = await navigator.clipboard.readText();
      if (target === this.editor) this.editor.insert(t);
      else this.shell.insertText(t.split("\n")[0]);
    } catch {
      target.focus();
    }
  }

  download(name, text) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  openFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".py,.txt,text/plain";
    input.addEventListener("change", async () => {
      const f = input.files[0];
      if (!f) return;
      const text = (await f.text()).replace(/\r\n/g, "\n");
      if (this.code.trim() && this.code !== text) {
        const ok = await dialog({ title: "Open", message: `편집기의 코드를 ${f.name} 파일 내용으로 바꿀까요?`, buttons: ["OK", "Cancel"] });
        if (!ok) return;
      }
      this.code = text;
      this.save();
      this.editor.focus();
    });
    input.click();
  }

  about() {
    const v = this.version || "3.12";
    dialog({
      title: "About IDLE",
      message: `IDLE\n\nPython's Integrated Development\nand Learning Environment\n\n` +
        `Python version:  ${v}\nTk version:  8.6.13\nIDLE version:  ${v}\n\n` +
        `HOJ에서 브라우저로 흉내 낸 IDLE입니다.`,
      buttons: ["Close"],
    });
  }

  async gotoLine() {
    const v = await dialog({
      title: "Go To Line",
      message: "Enter a positive integer\n('big' = end of file):",
      input: true,
      buttons: ["OK", "Cancel"],
    });
    if (v == null) { this.editor.focus(); return; }
    const n = v.trim().toLowerCase() === "big" ? Infinity : parseInt(v, 10);
    if (n > 0) this.editor.gotoLine(n);
    else this.editor.focus();
  }

  async syntaxOk() {
    const err = await this.rt.check(this.code, this.filename);
    if (!err) return true;
    await dialog({ title: err.type === "SyntaxError" || err.type === "IndentationError" || err.type === "TabError" ? "SyntaxError" : err.type, message: err.msg });
    this.editor.markError(err.lineno, err.offset);
    return false;
  }

  async checkModule() {
    if (this.state === "grading") return;
    this.save();
    if (!this.rt.ready) return;
    await this.stopCurrent();
    await this.syntaxOk();
  }

  async run() {
    if (this.state === "grading" || this.busyRun) return;
    this.save();
    if (!this.rt.ready || this.state === "loading") {
      if (!this.restarting) { this.pendingRun = true; return; }
    }
    this.busyRun = true;
    try {
      await this.stopCurrent();
      if (!(await this.syntaxOk())) return;
      const typed = this.shell.endInput();
      if (typed) this.shell.write(typed);
      this.shell.ensureNewline();
      this.shell.write(this.bar(`RESTART: ${this.filename}`) + "\n");
      this.state = "running";
      this.shellBuf = [];
      this.shell.startInput("pending");
      this.job = this.rt.run(this.code, this.filename);
    } finally {
      this.busyRun = false;
    }
    try {
      await this.job;
    } catch {
      return; // 워커를 새로 띄운 경우: onReady가 프롬프트를 보여 준다
    }
    this.state = "idle";
    this.shell.prompt();
  }

  // IDLE처럼 문장이 끝났는지는 바로 판단해서, 이어지는 줄은 즉시 들여쓴다.
  needsMore(lines) {
    const src = lines.join("\n");
    const last = lines[lines.length - 1];
    const { stack, inString } = scanOpen(src);
    if (stack.length || inString || /\\$/.test(last)) return true;
    if (stripComment(last).trimEnd().endsWith(":")) return true;
    const first = stripComment(lines[0]).trim();
    return lines.length > 1 && last.trim() !== "" && (first.endsWith(":") || first.startsWith("@"));
  }

  async shellSubmit(mode, text) {
    if (mode === "stdin") {
      if (this.state !== "input") return;
      this.state = "running";
      this.rt.reply(text);
      return;
    }
    if (this.state !== "idle") return;
    const buf = (this.shellBuf ||= []);
    // IDLE처럼 공백만 있는 줄은 빈 줄로 본다(Enter 두 번으로 블록 끝내기).
    buf.push(text.trim() ? text.replace(/\s+$/, "") : "");
    if (buf.length === 1 && buf[0] === "") {
      this.shellBuf = [];
      this.shell.prompt();
      return;
    }
    if (this.needsMore(buf)) {
      this.shell.more(" ".repeat(computeIndent(buf.join("\n"))));
      return;
    }
    const src = buf.join("\n");
    this.state = "running";
    let r;
    try {
      this.job = this.rt.shell(src);
      r = await this.job;
    } catch {
      this.shellBuf = [];
      return;
    }
    this.state = "idle";
    if (r === "more") {
      this.shell.more(" ".repeat(computeIndent(src)));
    } else {
      this.shellBuf = [];
      this.shell.prompt();
    }
  }

  async interrupt() {
    if (this.state === "input") {
      const typed = this.shell.endInput();
      this.shell.write(typed + "\n", "in");
      this.state = "running";
      this.rt.interruptInput();
    } else if (this.state === "running") {
      this.shell.flushNow();
      this.shell.ensureNewline();
      this.shell.write("KeyboardInterrupt\n", "err");
      await this.restartWorker();
    } else if (this.state === "idle") {
      const typed = this.shell.endInput();
      this.shell.write(typed + "\n");
      this.shell.write("KeyboardInterrupt\n", "err");
      this.shellBuf = [];
      this.shell.prompt();
    }
  }

  async restartShell() {
    if (this.state === "grading") return;
    if (this.state === "idle") {
      const typed = this.shell.endInput();
      if (typed) this.shell.write(typed);
      this.shell.ensureNewline();
      this.shell.write(this.bar("RESTART: Shell") + "\n");
      await this.rt.reset();
      this.shell.prompt();
    } else if (this.state === "input") {
      this.rt.abortInput();
      await this.job;
      await this.restartShell();
    } else if (this.state === "running") {
      await this.restartWorker();
    }
  }

  // 채점: 숨은 테스트 실행. 너무 오래 걸리면 워커를 다시 띄우고 시간 초과.
  async grade(problem, onProgress) {
    if (this.state === "grading") return null;
    this.save();
    if (!this.rt.ready || this.state === "loading") await this.waitReady();
    await this.stopCurrent();
    this.state = "grading";
    this.progressCb = onProgress;
    const perTest = (problem.time_limit || 0.4) * 1000;
    const limit = 3000 + perTest * (problem.tests?.length || 1);
    let timer;
    const timeout = new Promise((r) => { timer = setTimeout(() => r({ verdict: "tle" }), limit); });
    let result;
    try {
      result = await Promise.race([this.rt.grade(this.code, problem), timeout]);
    } catch {
      result = { verdict: "error" };
    }
    clearTimeout(timer);
    this.progressCb = null;
    if (result.verdict === "tle") {
      await this.restartWorker();
    } else {
      this.state = "idle";
    }
    return result;
  }

  buildKeybar(bar) {
    for (const [label, key] of KEYS) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      if (key === "run" || key === "interrupt") b.className = "kb-cmd";
      b.addEventListener("pointerdown", (e) => e.preventDefault());
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => this.key(key));
      bar.appendChild(b);
    }
  }

  key(k) {
    const toShell = this.lastFocus === "shell" && this.shell.input;
    if (k === "run") return this.run();
    if (k === "interrupt") return this.interrupt();
    if (toShell) {
      this.shell.insertText(k === "tab" ? "    " : k === "dedent" ? "" : k);
      return;
    }
    if (k === "tab") { this.editor.focus(); this.editor.tab(); }
    else if (k === "dedent") this.editor.dedentRegion();
    else this.editor.insert(k);
  }
}
