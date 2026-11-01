// IDLE의 편집 도우미
// - 함수 설명(calltip): "(" 를 치면 함수의 매개변수와 설명 첫 줄을 노란 상자로 보여 준다.
// - 자동 완성: 이름을 치다가 Tab, 또는 "." 뒤에서 잠깐 기다리면 목록이 뜬다.
// 편집기(textarea)와 Shell 입력칸(contenteditable) 모두에서 쓴다.
import { scanOpen } from "./editor.js";
import { KEYWORDS, BUILTINS } from "./highlight.js";

const ID_CHAR = /[\p{L}\p{N}_]/u;
const POPUP_WAIT = 2000; // IDLE 기본값: "." 뒤 2초
const FALLBACK = [...BUILTINS, ...[...KEYWORDS].filter((k) => !["True", "False", "None"].includes(k))].sort();

let ctx2d = null;
function textWidth(text, font) {
  ctx2d ||= document.createElement("canvas").getContext("2d");
  ctx2d.font = font;
  return ctx2d.measureText(text).width;
}

// 편집기 textarea
export function textareaTarget(editor) {
  const ta = editor.ta;
  return {
    get el() { return ta; },
    get text() { return ta.value; },
    get pos() { return ta.selectionStart; },
    hasSelection: () => ta.selectionStart !== ta.selectionEnd,
    rectAt(pos) {
      const cs = getComputedStyle(ta);
      const lh = parseFloat(cs.lineHeight) || 20;
      const v = ta.value;
      const start = v.lastIndexOf("\n", pos - 1) + 1;
      const line = v.slice(0, pos).split("\n").length;
      let before = "";
      for (const c of v.slice(start, pos)) before += c === "\t" ? " ".repeat(8 - (before.length % 8)) : c;
      const r = ta.getBoundingClientRect();
      const x = r.left + parseFloat(cs.paddingLeft) + textWidth(before, cs.font) - ta.scrollLeft;
      const y = r.top + parseFloat(cs.paddingTop) + (line - 1) * lh - ta.scrollTop;
      return { left: x, top: y, bottom: y + lh };
    },
    replace(from, to, text) { editor.insert(text, from, to); },
  };
}

// Shell 입력칸 (마지막 줄의 contenteditable span)
export function shellTarget(shell) {
  const span = () => shell.input;
  const locate = (offset) => {
    const el = span();
    el.normalize();
    let node = el.firstChild;
    if (!node) { node = document.createTextNode(""); el.appendChild(node); }
    return [node, Math.min(offset, node.length)];
  };
  return {
    get el() { return span(); },
    get text() { return span()?.textContent || ""; },
    get pos() {
      const el = span();
      const sel = window.getSelection();
      if (!el || !sel.rangeCount || !el.contains(sel.focusNode)) return el ? el.textContent.length : 0;
      const r = document.createRange();
      r.selectNodeContents(el);
      r.setEnd(sel.focusNode, sel.focusOffset);
      return r.toString().length;
    },
    hasSelection: () => !window.getSelection().isCollapsed,
    rectAt(pos) {
      const [node, off] = locate(pos);
      const r = document.createRange();
      r.setStart(node, off);
      r.setEnd(node, off);
      let rect = r.getClientRects()[0] || r.getBoundingClientRect();
      if (!rect || (!rect.height && !rect.left)) rect = span().getBoundingClientRect();
      return { left: rect.left, top: rect.top, bottom: rect.bottom || rect.top + 20 };
    },
    replace(from, to, text) {
      const [node] = locate(0);
      const r = document.createRange();
      r.setStart(node, Math.min(from, node.length));
      r.setEnd(node, Math.min(to, node.length));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      document.execCommand("insertText", false, text);
    },
  };
}

export class Assist {
  constructor(target, rt) {
    this.t = target;
    this.rt = rt;
    this.tip = null;     // { el, open }
    this.ac = null;      // { el, start, list, items, sel }
    this.popupTimer = 0;
    this.seq = 0;
  }

  get active() { return !!(this.tip || this.ac); }

  hide() {
    this.hideTip();
    this.hideList();
    clearTimeout(this.popupTimer);
  }

  // keydown에서 먼저 부른다. 처리했으면 true
  key(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (this.ac) {
      const k = e.key;
      if (k === "ArrowDown" || k === "ArrowUp" || k === "PageDown" || k === "PageUp") {
        const step = k === "PageDown" ? 8 : k === "PageUp" ? -8 : k === "ArrowDown" ? 1 : -1;
        this.select(Math.max(0, Math.min(this.ac.list.length - 1, (this.ac.sel < 0 ? 0 : this.ac.sel + step))));
        return true;
      }
      if ((k === "Tab" || k === "Enter") && !e.isComposing) {
        if (this.ac.sel >= 0) this.accept(this.ac.sel);
        else this.hideList();
        return true;
      }
      if (k === "Escape") { this.hideList(); return true; }
      if (k === "Home" || k === "End" || k === "ArrowLeft" || k === "ArrowRight") this.hideList();
    }
    if (e.key === "Escape" && this.tip) { this.hideTip(); return true; }
    if (mod && e.code === "Space") { this.complete(true); return true; }
    if (mod && (e.key === "\\" || e.code === "Backslash")) { this.openTip(true); return true; }
    if (e.key === "Tab" && !mod && !e.altKey && !e.shiftKey && !this.t.hasSelection()) {
      const v = this.t.text;
      const c = v[this.t.pos - 1];
      if (c && (ID_CHAR.test(c) || c === ".")) { this.complete(true); return true; }
    }
    return false;
  }

  // 글자를 입력한 뒤에 부른다. data: 입력한 글자
  typed(data) {
    clearTimeout(this.popupTimer);
    if (this.ac) this.refilter();
    if (data === "(") this.openTip(false);
    else if (data === ".") this.popupTimer = setTimeout(() => this.complete(false), POPUP_WAIT);
    this.moved();
  }

  // 커서가 움직이면 함수 설명을 계속 보여 줄지 확인한다.
  moved() {
    if (!this.tip) return;
    const v = this.t.text;
    const pos = this.t.pos;
    const open = this.tip.open;
    if (pos <= open || v[open] !== "(") return this.hideTip();
    const { stack } = scanOpen(v.slice(open, pos));
    if (!stack.length || stack[0] !== 0) this.hideTip();
  }

  // ── 함수 설명 ──
  async openTip(manual) {
    const v = this.t.text;
    const pos = this.t.pos;
    let open = pos - 1;
    if (manual || v[open] !== "(") {
      const { stack } = scanOpen(v.slice(0, pos));
      const opens = stack.filter((i) => v[i] === "(");
      if (!opens.length) return;
      open = opens[opens.length - 1];
    }
    const m = /([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*$/.exec(v.slice(Math.max(0, open - 200), open));
    if (!m) return;
    const seq = ++this.seq;
    const text = await this.rt.calltip(m[1]);
    if (seq !== this.seq || !text || !this.t.el) return;
    this.hideTip();
    const el = document.createElement("div");
    el.className = "calltip";
    el.textContent = text;
    document.body.appendChild(el);
    this.tip = { el, open };
    this.place(el, this.t.rectAt(open));
    this.moved();
  }

  hideTip() {
    if (!this.tip) return;
    this.tip.el.remove();
    this.tip = null;
  }

  place(el, rect) {
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = Math.min(rect.left, window.innerWidth - w - 4);
    let top = rect.bottom + 2;
    if (top + h > window.innerHeight - 4 && rect.top - h - 2 > 0) top = rect.top - h - 2;
    el.style.left = Math.max(4, left) + "px";
    el.style.top = top + "px";
  }

  // ── 자동 완성 ──
  word() {
    const v = this.t.text;
    const pos = this.t.pos;
    let start = pos;
    while (start > 0 && ID_CHAR.test(v[start - 1])) start--;
    let what = v.slice(start, pos);
    if (v[start - 1] === ".") {
      let s = start - 1;
      while (s > 0 && (ID_CHAR.test(v[s - 1]) || v[s - 1] === ".")) s--;
      const base = v.slice(s, start - 1);
      if (!base || !/^[A-Za-z_]/.test(base)) return null;
      what = base + "." + what;
    }
    return { start, pos, partial: v.slice(start, pos), what };
  }

  async complete(byKey) {
    clearTimeout(this.popupTimer);
    const w = this.word();
    if (!w || (!w.partial && !w.what.includes("."))) return;
    const seq = ++this.seq;
    const r = await this.rt.complete(w.what);
    if (seq !== this.seq) return;
    const [small, big] = r || (w.what.includes(".") ? [[], []] : [FALLBACK, FALLBACK]);
    const list = w.partial.startsWith("_") ? big : small;
    if (!list.length) return;
    const now = this.word();
    if (!now || now.start !== w.start) return;
    const matches = list.filter((x) => x.startsWith(now.partial));
    if (byKey && matches.length === 1) {
      this.t.replace(now.start, now.pos, matches[0]);
      return;
    }
    if (byKey && !matches.length) return;
    this.showList(now.start, list, small, big);
  }

  showList(start, list, small, big) {
    this.hideList();
    const el = document.createElement("div");
    el.className = "ac-list";
    el.setAttribute("role", "listbox");
    const items = list.map((name, i) => {
      const it = document.createElement("div");
      it.className = "ac-item";
      it.textContent = name;
      it.addEventListener("mousedown", (e) => { e.preventDefault(); this.select(i); });
      it.addEventListener("dblclick", () => this.accept(i));
      el.appendChild(it);
      return it;
    });
    el.addEventListener("mousedown", (e) => e.preventDefault());
    document.body.appendChild(el);
    this.ac = { el, start, list, items, sel: -1, small, big };
    this.place(el, this.t.rectAt(start));
    this.refilter();
  }

  refilter() {
    const ac = this.ac;
    const v = this.t.text;
    const pos = this.t.pos;
    if (pos < ac.start || !/^[\p{L}\p{N}_]*$/u.test(v.slice(ac.start, pos))) return this.hideList();
    const partial = v.slice(ac.start, pos);
    if (partial.startsWith("_") && ac.list !== ac.big) {
      const { start, small, big } = ac;
      return this.showList(start, big, small, big);
    }
    let i = ac.list.findIndex((x) => x.startsWith(partial));
    if (i < 0) i = ac.list.findIndex((x) => x.toLowerCase().startsWith(partial.toLowerCase()));
    this.select(i);
  }

  select(i) {
    const ac = this.ac;
    if (ac.sel >= 0) ac.items[ac.sel]?.classList.remove("sel");
    ac.sel = i;
    if (i < 0) return;
    const it = ac.items[i];
    it.classList.add("sel");
    const top = it.offsetTop;
    if (top < ac.el.scrollTop) ac.el.scrollTop = top;
    else if (top + it.offsetHeight > ac.el.scrollTop + ac.el.clientHeight) ac.el.scrollTop = top + it.offsetHeight - ac.el.clientHeight;
  }

  accept(i) {
    const { start, list } = this.ac;
    this.hideList();
    this.t.replace(start, this.t.pos, list[i]);
  }

  hideList() {
    if (!this.ac) return;
    this.ac.el.remove();
    this.ac = null;
  }
}
