// IDLE의 Find / Replace 창 (Edit > Find..., Replace...). 다른 창을 막지 않는 작은 창이다.
import { escapeHtml } from "./highlight.js";

const state = { find: "", repl: "", regex: false, caseSens: false, word: false, wrap: true, up: false };
let current = null;

function pattern() {
  if (!state.find) return null;
  let src = state.regex ? state.find : state.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (state.word) src = `\\b${src}\\b`;
  try {
    return new RegExp(src, state.caseSens ? "g" : "gi");
  } catch {
    return null;
  }
}

// 다음(또는 이전) 일치 위치 [시작, 끝]
function locate(text, from, up) {
  const re = pattern();
  if (!re) return null;
  const all = [];
  let m;
  while ((m = re.exec(text))) {
    if (!m[0].length) { re.lastIndex++; continue; }
    all.push([m.index, m.index + m[0].length]);
  }
  if (!all.length) return null;
  if (up) {
    const prev = all.filter(([s]) => s < from);
    return prev.length ? prev[prev.length - 1] : state.wrap ? all[all.length - 1] : null;
  }
  return all.find(([s]) => s >= from) || (state.wrap ? all[0] : null);
}

export function findNext(editor) {
  const ta = editor.ta;
  const from = state.up ? ta.selectionStart : ta.selectionEnd;
  const hit = locate(ta.value, from, state.up);
  if (!hit) return false;
  ta.focus();
  ta.setSelectionRange(hit[0], hit[1]);
  editor.scrollToCaret();
  editor.reportCursor();
  return true;
}

// Find Again (Ctrl+G): 찾을 말이 없으면 Find 창을 연다
export function findAgain(editor) {
  if (!state.find) return openSearch(editor, false);
  return findNext(editor);
}

export function openSearch(editor, replace) {
  current?.remove();
  const sel = editor.ta.value.slice(editor.ta.selectionStart, editor.ta.selectionEnd);
  if (sel && !sel.includes("\n")) state.find = sel;
  const w = document.createElement("div");
  w.className = "dlg search";
  w.setAttribute("role", "dialog");
  const chk = (key, label) => `<label><input type="checkbox" data-k="${key}" ${state[key] ? "checked" : ""}> ${label}</label>`;
  w.innerHTML = `
    <div class="dlg-title">${replace ? "Replace Dialog" : "Find"}</div>
    <div class="search-body">
      <div class="search-fields">
        <label class="search-row"><span>Find:</span><input type="text" class="s-find" value="${escapeHtml(state.find)}"></label>
        ${replace ? `<label class="search-row"><span>Replace with:</span><input type="text" class="s-repl" value="${escapeHtml(state.repl)}"></label>` : ""}
        <div class="search-opts">
          <fieldset><legend>Options</legend>${chk("regex", "Regular expression")}${chk("caseSens", "Match case")}${chk("word", "Whole word")}${chk("wrap", "Wrap around")}</fieldset>
          <fieldset><legend>Direction</legend>
            <label><input type="radio" name="s-dir" value="up" ${state.up ? "checked" : ""}> Up</label>
            <label><input type="radio" name="s-dir" value="down" ${state.up ? "" : "checked"}> Down</label>
          </fieldset>
        </div>
      </div>
      <div class="search-btns">
        ${replace
          ? '<button type="button" data-a="find">Find</button><button type="button" data-a="replace">Replace</button><button type="button" data-a="replfind">Replace+Find</button><button type="button" data-a="all">Replace All</button>'
          : '<button type="button" data-a="find">Find Next</button>'}
        <button type="button" data-a="close">Close</button>
      </div>
    </div>`;
  const find = w.querySelector(".s-find");
  const repl = w.querySelector(".s-repl");
  const sync = () => {
    state.find = find.value;
    if (repl) state.repl = repl.value;
    w.querySelectorAll("input[data-k]").forEach((c) => { state[c.dataset.k] = c.checked; });
    state.up = w.querySelector('input[name="s-dir"][value="up"]').checked;
  };
  const miss = () => {
    find.classList.add("miss");
    setTimeout(() => find.classList.remove("miss"), 600);
  };
  const ta = editor.ta;
  const selected = () => {
    const re = pattern();
    if (!re) return false;
    const s = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    re.lastIndex = 0;
    const m = re.exec(s);
    return !!m && m.index === 0 && m[0].length === s.length && s.length > 0;
  };
  const replaceOne = () => {
    if (!selected()) return false;
    const s = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    const out = state.regex ? s.replace(pattern(), state.repl) : state.repl;
    const start = ta.selectionStart;
    editor.insert(out, start, ta.selectionEnd);
    ta.setSelectionRange(start, start + out.length);
    return true;
  };
  const actions = {
    find: () => { if (!findNext(editor)) miss(); },
    replace: () => { if (!replaceOne() && !findNext(editor)) miss(); },
    replfind: () => { replaceOne(); if (!findNext(editor)) miss(); },
    all: () => {
      const re = pattern();
      if (!re || !re.test(ta.value)) return miss();
      re.lastIndex = 0;
      const out = state.regex ? ta.value.replace(re, state.repl) : ta.value.replace(re, () => state.repl);
      editor.insert(out, 0, ta.value.length);
    },
    close: () => close(),
  };
  const close = () => {
    w.remove();
    current = null;
    document.removeEventListener("keydown", onKey, true);
    editor.focus();
  };
  const onKey = (e) => {
    if (!w.contains(document.activeElement)) return;
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "Enter" && e.target.tagName === "INPUT" && e.target.type === "text") {
      e.preventDefault();
      sync();
      actions.find();
    }
  };
  w.addEventListener("click", (e) => {
    const a = e.target.closest("button")?.dataset.a;
    if (!a) return;
    sync();
    actions[a]();
  });
  w.addEventListener("change", sync);
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(w);
  const r = editor.ta.getBoundingClientRect();
  w.style.left = Math.max(8, Math.min(r.right - w.offsetWidth - 12, window.innerWidth - w.offsetWidth - 8)) + "px";
  w.style.top = Math.max(8, r.top + 12) + "px";
  current = w;
  find.focus();
  find.select();
}
