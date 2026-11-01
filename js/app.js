import { Idle, gradeCode } from "./idle.js";
import { highlight, escapeHtml as esc } from "./highlight.js";

const main = document.getElementById("main");
let currentIdle = null;

// ── 데이터 ──
const cache = new Map();
function getJSON(path) {
  if (!cache.has(path)) {
    cache.set(path, fetch(path, { cache: "no-cache" }).then((r) => {
      if (!r.ok) throw new Error(`${path} (${r.status})`);
      return r.json();
    }));
  }
  return cache.get(path);
}
const loadIndex = () => getJSON("problems/index.json");
const loadSet = (sid) => getJSON(`problems/${sid}/set.json`);
const loadProblem = (sid, pid) => getJSON(`problems/${sid}/${pid}.json`);

// ── 제출 기록 (브라우저에만 저장) ──
const SUBS = "hoj:submissions";
function getSubs() {
  try { return JSON.parse(localStorage.getItem(SUBS)) || []; } catch { return []; }
}
function saveSubs(list) {
  try { localStorage.setItem(SUBS, JSON.stringify(list.slice(-500))); } catch { /* 무시 */ }
}
// 제출 번호는 지운 기록과 겹치지 않도록 따로 센다.
function nextSubId(list) {
  let last = list.reduce((m, s) => Math.max(m, s.id || 0), 0);
  try { last = Math.max(last, Number(localStorage.getItem("hoj:subseq")) || 0); } catch { /* 무시 */ }
  try { localStorage.setItem("hoj:subseq", String(last + 1)); } catch { /* 무시 */ }
  return last + 1;
}
function addSub(sub) {
  const list = getSubs();
  sub.id = nextSubId(list);
  list.push(sub);
  saveSubs(list);
  return sub;
}
function updateSub(sub) {
  const list = getSubs();
  const i = list.findIndex((s) => s.id === sub.id);
  if (i >= 0) list[i] = sub;
  saveSubs(list);
}
function removeSub(id) {
  saveSubs(getSubs().filter((s) => s.id !== id));
}
// 채점 도중 페이지를 떠난 기록은 지운다.
saveSubs(getSubs().filter((s) => s.verdict !== "judging"));

function problemStatus(sid, pid) {
  const subs = getSubs().filter((s) => s.set === sid && s.pid === pid && s.verdict !== "judging");
  if (!subs.length) return null;
  return subs.some((s) => s.verdict === "ac") ? "ac" : "wrong";
}
const codeKey = (sid, pid) => `hoj:code:${sid}/${pid}`;

// ── 비공개 세트: set.json의 password(SHA-256)와 브라우저에서 비교한다 ──
const unlockKey = (sid) => `hoj:unlock:${sid}`;
// 비밀번호가 바뀌면 예전에 연 기록은 지우고 다시 묻는다. (안내 문구는 새로고침해도 남도록 sessionStorage에)
const staleKey = (sid) => `hoj:stale:${sid}`;
const staleUnlock = {
  has(sid) { try { return sessionStorage.getItem(staleKey(sid)) === "1"; } catch { return false; } },
  add(sid) { try { sessionStorage.setItem(staleKey(sid), "1"); } catch { /* 무시 */ } },
  delete(sid) { try { sessionStorage.removeItem(staleKey(sid)); } catch { /* 무시 */ } },
};
function isLocked(s, sid) {
  if (!s.password) return false;
  let saved = null;
  try { saved = localStorage.getItem(unlockKey(sid)) || sessionStorage.getItem(unlockKey(sid)); } catch { saved = null; }
  if (saved === s.password) return false;
  if (saved) {
    try { localStorage.removeItem(unlockKey(sid)); sessionStorage.removeItem(unlockKey(sid)); } catch { /* 무시 */ }
    staleUnlock.add(sid);
  }
  return true;
}
async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── 결과 표시 ──
const VERDICT = {
  ac: "맞았습니다!!",
  wrong: "틀렸습니다",
  condition: "조건 미충족",
  runtime: "런타임 에러",
  syntax: "문법 에러",
  tle: "시간 초과",
  ole: "출력 초과",
  judging: "채점 중",
  error: "채점 오류",
};
function verdictHtml(s, progress) {
  let text = VERDICT[s.verdict] || s.verdict;
  if (s.verdict === "judging" && progress != null) text += ` (${progress}%)`;
  const detail = s.detail ? ` <span class="v-detail">(${esc(s.detail)})</span>` : "";
  return `<span class="v v-${s.verdict}">${esc(text)}</span>${detail}`;
}
function bytes(code) { return new TextEncoder().encode(code).length; }
function when(t) {
  const d = (Date.now() - t) / 1000;
  if (d < 60) return `${Math.max(1, Math.floor(d))}초 전`;
  if (d < 3600) return `${Math.floor(d / 60)}분 전`;
  if (d < 86400) return `${Math.floor(d / 3600)}시간 전`;
  const x = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`;
}

// **굵게**, `코드` 만 지원하는 간단한 표기
function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

const LEVELS = { 1: "쉬움", 2: "보통", 3: "어려움", 4: "매우 어려움" };
function levelHtml(level) {
  return LEVELS[level] ? `<span class="lv lv-${level}">${LEVELS[level]}</span>` : "";
}

// 일반 문제 지문: 빈 줄로 문단, "- " 목록, "| a | b |" 표, ``` 코드 블록
function md(src) {
  const lines = (Array.isArray(src) ? src.join("\n") : String(src || "")).split("\n");
  let html = "";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const code = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) code.push(lines[i]);
      i++;
      html += `<pre class="source">${highlight(code.join("\n"))}</pre>`;
    } else if (/^\s*- /.test(line)) {
      html += "<ul class=\"md-list\">";
      for (; i < lines.length && /^\s*- /.test(lines[i]); i++) html += `<li>${inline(lines[i].replace(/^\s*- /, ""))}</li>`;
      html += "</ul>";
    } else if (line.startsWith("|")) {
      const rows = [];
      for (; i < lines.length && lines[i].startsWith("|"); i++) {
        rows.push(lines[i].replace(/^\||\|$/g, "").split("|").map((x) => x.trim()));
      }
      html += renderConditions([{ table: rows }]);
    } else if (!line.trim()) {
      i++;
    } else {
      const para = [];
      for (; i < lines.length && lines[i].trim() && !/^(\s*- |\||```)/.test(lines[i]); i++) para.push(inline(lines[i]));
      html += `<p>${para.join("<br>")}</p>`;
    }
  }
  return html;
}

function setTitle(t) {
  document.title = t ? `${t} - HOJ` : "HOJ";
}

function setNav(name) {
  document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === name));
}

// ── 문제 지문 ──
// withHints: 조건 묶음에 hint가 있으면 [힌트] 버튼을 붙인다 (시험 모드에서는 끔)
function renderConditions(conds, withHints = false) {
  const rows = conds.map((c) => {
    if (typeof c === "string") return `<div class="c-line">- ${inline(c)}</div>`;
    let h = "";
    const hint = withHints && c.hint;
    if (c.text) {
      h += `<div class="c-line">- ${inline(c.text)}${hint ? ' <button type="button" class="hint-btn">힌트</button>' : ""}</div>`;
    }
    if (c.table) {
      const [head, ...body] = c.table;
      h += `<table class="c-table"><thead><tr>${head.map((x) => `<th>${inline(x)}</th>`).join("")}</tr></thead>
        <tbody>${body.map((r) => `<tr>${r.map((x) => `<td>${inline(x)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    }
    for (const it of c.items || []) {
      h += `<div class="c-item${it.startsWith("※") ? " c-note" : ""}">${inline(it)}</div>`;
    }
    if (hint) h += `<div class="hint" hidden><b>힌트</b> ${inline(c.hint)}</div>`;
    return `<div class="c-group">${h}</div>`;
  });
  return rows.join("");
}

// 실행 결과: 출력은 파랑, 입력한 값은 검정 (IDLE과 같은 색)
function renderRun(output, stdin) {
  let html = "";
  let pos = 0;
  for (const v of stdin) {
    const needle = v + "\n";
    let i = output.indexOf(needle, pos);
    while (i > pos && output[i - 1] === "\n") i = output.indexOf(needle, i + 1);
    if (i < 0) break;
    html += `<span class="o">${esc(output.slice(pos, i))}</span><span class="i">${esc(needle)}</span>`;
    pos = i + needle.length;
  }
  html += `<span class="o">${esc(output.slice(pos).replace(/\n$/, ""))}</span>`;
  return html;
}

function statementHtml(p, no, { hints = true } = {}) {
  const examples = (p.examples || []).map((ex) => `<pre class="run">${renderRun(ex.output || "", ex.stdin || [])}</pre>`).join("");
  const runs = examples ? `
        <div class="box">
          <div class="box-title">${esc(p.result_title || "실행 결과(예시)")}</div>
          <div class="box-body runs" style="--n:${p.examples.length}">${examples}</div>
        </div>` : "";
  if (!p.conditions) {
    // 일반 문제: 문제 / 입력 / 출력 / 실행 결과 / 힌트
    const part = (title, body) => body ? `
      <section class="sec">
        <div class="headline"><h2>${title}</h2></div>
        <div class="statement md">${md(body)}</div>
      </section>` : "";
    return part("문제", p.statement) + part("입력", p.input) + part("출력", p.output) +
      (runs ? `<section class="sec"><div class="statement">${runs}</div></section>` : "") + (hints ? part("힌트", p.hint) : "");
  }
  return `
    <section class="sec">
      <div class="headline"><h2>문제</h2></div>
      <div class="statement">
        <p class="st-head">${esc(no)}. ${esc(p.heading)}</p>
        <p class="st-desc">- ${inline(p.description)}</p>
        <div class="box">
          <div class="box-title">문제 조건</div>
          <div class="box-body">${renderConditions(p.conditions, hints)}</div>
        </div>
        <div class="box">
          <div class="box-title">${esc(p.result_title || "실행 결과(예시)")}</div>
          <div class="box-body runs" style="--n:${p.examples.length}">${examples}</div>
        </div>
      </div>
    </section>`;
}

main.addEventListener("click", (e) => {
  const btn = e.target.closest(".hint-btn");
  if (!btn) return;
  const box = btn.closest(".c-group").querySelector(".hint");
  box.hidden = !box.hidden;
  btn.textContent = box.hidden ? "힌트" : "힌트 닫기";
});

function solutionText(p) {
  return Array.isArray(p.solution) ? p.solution.join("\n") : (p.solution || "");
}

// ── 페이지 ──
function page(html, wide = false) {
  document.body.classList.toggle("wide", wide);
  main.innerHTML = html;
  window.scrollTo(0, 0);
}

function errorPage(msg) {
  setTitle("오류");
  page(`<div class="container"><h1 class="page-title">페이지를 찾을 수 없습니다</h1><p class="muted">${esc(msg)}</p><p><a href="#/">문제집으로 돌아가기</a></p></div>`);
}

async function homePage() {
  setTitle("");
  setNav("sets");
  const index = await loadIndex();
  const sets = await Promise.all(index.sets.map(async (sid, order) => ({ sid, order, ...(await loadSet(sid)) })));
  // problems/index.json에 적힌 순서대로 보여 준다
  const groups = [];
  for (const s of sets) {
    const g = s.group || "문제집";
    let item = groups.find((x) => x.name === g);
    if (!item) groups.push(item = { name: g, sets: [] });
    item.sets.push(s);
  }
  const body = groups.map((g) => {
    const hasLevel = g.sets.some((s) => s.level);
    const rows = g.sets.map((s) => {
      const solved = s.problems.filter((pid) => problemStatus(s.sid, pid) === "ac").length;
      const cls = solved && solved === s.problems.length ? "t-ac" : "";
      const desc = isLocked(s, s.sid) ? "비밀번호가 필요합니다" : (s.description || "");
      return `<tr>
        <td><a href="#/set/${esc(s.sid)}" class="${cls}">${esc(s.title)}</a>
          <div class="muted sub-desc">${esc(desc)}</div></td>
        <td class="muted col-desc">${esc(desc)}</td>
        ${hasLevel ? `<td class="c">${levelHtml(s.level)}</td>` : ""}
        <td class="c">${s.problems.length}</td>
        <td class="c">${solved ? `<span class="${cls || ""}">${solved}</span>` : "0"}</td>
      </tr>`;
    }).join("");
    return `
      <section class="sec">
        ${groups.length > 1 ? `<div class="headline"><h2>${esc(g.name)}</h2></div>` : ""}
        <table class="table">
          <thead><tr><th class="w-set">문제집</th><th class="col-desc">내용</th>${hasLevel ? '<th class="c w80">난이도</th>' : ""}<th class="c w80">문제</th><th class="c w80">맞은 문제</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
  }).join("");
  page(`
    <div class="container">
      <h1 class="page-title">문제집</h1>
      ${body}
    </div>`);
}

function lockPage(s, sid) {
  setTitle(s.title);
  page(`
    <div class="container">
      <h1 class="page-title">${esc(s.title)}</h1>
      <form class="lock-form">
        <label for="pw">비밀번호</label>
        <input id="pw" type="password" autocomplete="off" inputmode="numeric">
        <button type="submit" class="btn btn-primary">확인</button>
        <span class="lock-msg">${staleUnlock.has(sid) ? "비밀번호가 바뀌었습니다. 새 비밀번호를 입력하세요." : ""}</span>
      </form>
    </div>`);
  const form = main.querySelector(".lock-form");
  const input = form.querySelector("#pw");
  input.focus();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    let hash = "";
    try { hash = await sha256(input.value); } catch { hash = ""; }
    if (hash === s.password) {
      try { localStorage.setItem(unlockKey(sid), hash); } catch { /* 무시 */ }
      staleUnlock.delete(sid);
      route();
    } else {
      form.querySelector(".lock-msg").textContent = "비밀번호가 틀렸습니다.";
      input.select();
    }
  });
}

async function setPage(sid) {
  setNav("sets");
  const s = await loadSet(sid);
  if (isLocked(s, sid)) return lockPage(s, sid);
  setTitle(s.title);
  const probs = await Promise.all(s.problems.map(async (pid) => ({ pid, ...(await loadProblem(sid, pid)) })));
  const rows = probs.map((p) => {
    const st = problemStatus(sid, p.pid);
    const cls = st === "ac" ? "t-ac" : st === "wrong" ? "t-wrong" : "";
    const res = st ? `<span class="v v-${st}">${st === "ac" ? "맞았습니다" : "틀렸습니다"}</span>` : "";
    return `<tr>
      <td class="c">${esc(p.pid)}</td>
      <td><a href="#/problem/${esc(sid)}/${esc(p.pid)}" class="${cls}">${esc(p.title)}</a></td>
      <td>${esc(p.type || "")}</td>
      <td class="c">${p.score ?? ""}</td>
      <td class="c">${res}</td>
    </tr>`;
  }).join("");
  page(`
    <div class="container">
      <h1 class="page-title">${esc(s.title)} ${s.level ? `<small class="title-lv">${levelHtml(s.level)}</small>` : ""}</h1>
      ${s.description ? `<p class="lead">${esc(s.description)}</p>` : ""}
      <table class="table">
        <thead><tr><th class="c w80">번호</th><th>제목</th><th>유형</th><th class="c w80">배점</th><th class="c w120">결과</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p><a class="btn" href="#/exam/${esc(sid)}">시험 모드 (${examMinutes(s)}분)</a></p>
    </div>`);
}

function subRows(subs, withProblem) {
  if (!subs.length) {
    return `<tr><td colspan="${withProblem ? 5 : 4}" class="c muted">제출 기록이 없습니다.</td></tr>`;
  }
  return subs.slice().reverse().map((s) => `
    <tr data-sub="${s.id}">
      <td class="c">${s.id}</td>
      ${withProblem ? `<td><a href="#/problem/${esc(s.set)}/${esc(s.pid)}">${esc(s.setTitle)} ${esc(s.pid)}번</a></td>` : ""}
      <td class="res">${verdictHtml(s)}</td>
      <td class="c"><a href="#/source/${s.id}">${s.len} B</a></td>
      <td class="c muted">${when(s.time)}</td>
    </tr>`).join("");
}

async function problemPage(sid, pid) {
  setNav("sets");
  const [s, p] = await Promise.all([loadSet(sid), loadProblem(sid, pid)]);
  if (isLocked(s, sid)) return location.replace(`#/set/${sid}`);
  setTitle(`${s.title} ${pid}번`);
  const mySubs = () => getSubs().filter((x) => x.set === sid && x.pid === pid);
  const tabs = s.problems.map((id) =>
    `<li class="${id === pid ? "active" : ""}"><a href="#/problem/${esc(sid)}/${esc(id)}">${esc(id)}번</a></li>`).join("");

  page(`
    <div class="container wide">
      <ul class="tabs">${tabs}<li class="tab-set"><a href="#/set/${esc(sid)}">${esc(s.title)}</a></li></ul>
      <h1 class="prob-title">${esc(p.title)} <span class="prob-badge"></span></h1>
      <table class="table info">
        <thead><tr><th>유형</th>${p.score != null ? "<th>배점</th>" : ""}${s.level ? "<th>난이도</th>" : ""}<th>제출</th><th>맞았습니다</th></tr></thead>
        <tbody><tr><td>${esc(p.type || "-")}</td>${p.score != null ? `<td>${p.score}점</td>` : ""}${s.level ? `<td>${levelHtml(s.level)}</td>` : ""}<td class="n-sub"></td><td class="n-ac"></td></tr></tbody>
      </table>
      <div class="prob-grid">
        <div class="prob-text">
          ${statementHtml(p, pid)}
          ${solutionText(p) ? `
          <section class="sec">
            <div class="headline"><h2>정답 코드</h2><button type="button" class="btn btn-sm" id="show-sol">보기</button></div>
            <pre class="source sol-code" hidden>${highlight(solutionText(p))}</pre>
          </section>` : ""}
        </div>
        <div class="prob-ide">
          <div class="ide-host"></div>
          <div class="submit-row">
            <button type="button" class="btn" id="run" title="F5">▶ 실행</button>
            <button type="button" class="btn btn-primary" id="submit">제출</button>
            <span class="last-result"></span>
            <button type="button" class="btn btn-reset" id="reset">초기화</button>
          </div>
        </div>
      </div>
      <section class="sec">
        <div class="headline"><h2>채점 현황</h2></div>
        <table class="table subs">
          <thead><tr><th class="c w80">제출 번호</th><th>결과</th><th class="c w100">코드 길이</th><th class="c w140">제출한 시간</th></tr></thead>
          <tbody></tbody>
        </table>
      </section>
    </div>`, true);

  main.querySelector("#show-sol")?.addEventListener("click", (e) => {
    const code = main.querySelector(".sol-code");
    code.hidden = !code.hidden;
    e.target.textContent = code.hidden ? "보기" : "숨기기";
  });

  const filename = `C:\\Users\\HOJ\\Desktop\\${pid}.py`;
  const starter = Array.isArray(p.starter) ? p.starter.join("\n") + "\n" : (p.starter || "");
  currentIdle = new Idle(main.querySelector(".ide-host"), { filename, storageKey: codeKey(sid, pid), initial: starter });

  const tbody = main.querySelector(".subs tbody");
  const lastResult = main.querySelector(".last-result");
  const refresh = () => {
    const subs = mySubs().filter((x) => x.verdict !== "judging");
    tbody.innerHTML = subRows(mySubs(), false);
    main.querySelector(".n-sub").textContent = subs.length;
    main.querySelector(".n-ac").textContent = subs.filter((x) => x.verdict === "ac").length;
    const st = problemStatus(sid, pid);
    const badge = main.querySelector(".prob-badge");
    badge.className = "prob-badge" + (st ? ` v v-${st}` : "");
    badge.textContent = st === "ac" ? "맞았습니다" : st === "wrong" ? "틀렸습니다" : "";
  };
  refresh();

  const submitBtn = main.querySelector("#submit");
  const runBtn = main.querySelector("#run");
  runBtn.addEventListener("click", () => currentIdle.run());
  // 다음 문제 (맞았을 때 안내)
  const idx = s.problems.indexOf(pid);
  const nextPid = idx >= 0 && idx < s.problems.length - 1 ? s.problems[idx + 1] : null;
  submitBtn.addEventListener("click", async () => {
    const idle = currentIdle;
    const code = idle.code;
    if (!code.trim()) {
      lastResult.innerHTML = '<span class="muted">코드를 작성한 뒤 제출하세요.</span>';
      return;
    }
    submitBtn.disabled = true;
    runBtn.disabled = true;
    const sub = addSub({ set: sid, pid, setTitle: s.title, title: p.title, verdict: "judging",
      len: bytes(code), time: Date.now(), code });
    refresh();
    const row = () => tbody.querySelector(`tr[data-sub="${sub.id}"] .res`);
    const show = (pct) => {
      const html = verdictHtml(sub, pct);
      if (row()) row().innerHTML = html;
      lastResult.innerHTML = html;
    };
    show(0);
    const result = await idle.grade(p, (i, n) => show(Math.floor((i / n) * 100)));
    if (currentIdle !== idle || !result) {
      removeSub(sub.id);
      submitBtn.disabled = false;
      runBtn.disabled = false;
      return;
    }
    submitBtn.disabled = false;
    runBtn.disabled = false;
    sub.verdict = result.verdict;
    sub.detail = result.detail || "";
    updateSub(sub);
    refresh();
    lastResult.innerHTML = verdictHtml(sub) + (sub.verdict === "ac" && nextPid
      ? ` <a class="next" href="#/problem/${esc(sid)}/${esc(nextPid)}">다음 문제 →</a>` : "");
  });

  main.querySelector("#reset").addEventListener("click", () => {
    if (!currentIdle.code || currentIdle.code === starter || confirm("작성한 코드를 모두 지우시겠습니까?")) {
      currentIdle.code = starter;
      currentIdle.editor.focus();
    }
  });
}

function statusPage() {
  setTitle("채점 현황");
  setNav("status");
  page(`
    <div class="container">
      <h1 class="page-title">채점 현황</h1>
      <table class="table">
        <thead><tr><th class="c w80">제출 번호</th><th>문제</th><th>결과</th><th class="c w100">코드 길이</th><th class="c w140">제출한 시간</th></tr></thead>
        <tbody>${subRows(getSubs().filter((s) => s.verdict !== "judging"), true)}</tbody>
      </table>
    </div>`);
}

function sourcePage(id) {
  const s = getSubs().find((x) => x.id === Number(id));
  if (!s) return errorPage("제출 기록이 없습니다.");
  setTitle(`제출 ${s.id}`);
  setNav("status");
  page(`
    <div class="container">
      <h1 class="page-title">제출 ${s.id}</h1>
      <table class="table">
        <thead><tr><th>문제</th><th>결과</th><th class="c w100">코드 길이</th><th class="c w140">제출한 시간</th></tr></thead>
        <tbody><tr>
          <td><a href="#/problem/${esc(s.set)}/${esc(s.pid)}">${esc(s.setTitle)} ${esc(s.pid)}번 ${esc(s.title || "")}</a></td>
          <td>${verdictHtml(s)}</td><td class="c">${s.len} B</td><td class="c muted">${when(s.time)}</td>
        </tr></tbody>
      </table>
      <pre class="source">${highlight(s.code)}</pre>
      <p><button type="button" class="btn" id="load">편집기로 불러오기</button></p>
    </div>`);
  main.querySelector("#load").addEventListener("click", () => {
    const key = codeKey(s.set, s.pid);
    let cur = "";
    try { cur = localStorage.getItem(key) || ""; } catch { cur = ""; }
    if (cur && cur !== s.code && !confirm("편집기에 있는 코드를 이 코드로 바꾸시겠습니까?")) return;
    try { localStorage.setItem(key, s.code); } catch { /* 무시 */ }
    location.hash = `#/problem/${s.set}/${s.pid}`;
  });
}

function helpPage() {
  setTitle("사용법");
  setNav("help");
  const keys = [
    ["F5", "프로그램을 실행합니다. (Run Module)"],
    ["Alt+X", "문법 검사만 합니다. (Check Module)"],
    ["Alt+G", "입력한 줄로 이동합니다. (Go to Line)"],
    ["Ctrl+S", "저장합니다. 코드는 입력할 때마다 브라우저에 자동 저장됩니다."],
    ["Tab", "이름을 치다가 누르면 자동 완성 목록이 뜹니다. 줄 앞에서는 공백 4칸(들여쓰기)을 넣습니다."],
    ["Ctrl+Space", "자동 완성 목록을 띄웁니다. 점(.) 뒤에서 2초 기다려도 뜹니다. ↑↓로 고르고 Tab/Enter로 넣습니다."],
    ["Ctrl+\\", "함수 설명(calltip)을 다시 보여 줍니다. 함수 이름 뒤에 ( 를 치면 저절로 뜹니다."],
    ["Ctrl+F / Ctrl+G / Ctrl+H", "찾기 / 다시 찾기 / 바꾸기"],
    ["Ctrl+0", "커서를 둘러싼 괄호를 보여 줍니다. 닫는 괄호를 치면 짝이 되는 괄호까지 잠깐 회색으로 표시됩니다."],
    ["Home", "들여쓰기 다음으로 이동하고, 한 번 더 누르면 줄 맨 앞으로 이동합니다."],
    ["Shift+Tab, Ctrl+[", "선택한 줄을 내어씁니다."],
    ["Ctrl+]", "선택한 줄을 들여씁니다."],
    ["Alt+3 / Alt+4", "선택한 줄을 주석 처리 / 해제합니다."],
    ["Ctrl+C (Shell)", "실행 중인 프로그램을 멈춥니다."],
    ["Ctrl+F6", "Shell을 다시 시작합니다."],
    ["F6", "Shell에서 마지막 RESTART 위치로 이동합니다."],
    ["Alt+P / Alt+N (Shell)", "이전 / 다음 명령을 불러옵니다."],
  ];
  page(`
    <div class="container">
      <h1 class="page-title">사용법</h1>
      <section class="sec">
        <div class="headline"><h2>문제 풀기</h2></div>
        <ol class="help-list">
          <li>문제집에서 세트를 고르고 문제를 여세요.</li>
          <li>편집기에 코드를 작성하고 <b>▶ 실행</b> 버튼(또는 <b>F5</b>)을 눌러 실행하세요.</li>
          <li><code>input()</code>이 실행되면 Shell에서 값을 입력하고 Enter를 누르세요.</li>
          <li>실행 결과(예시)와 같은지 확인한 뒤 <b>제출</b>을 누르세요.</li>
          <li>막히면 문제 조건 옆의 <b>힌트</b>를 누르세요. 다 풀었으면 문제 아래 <b>정답 코드</b>와 내 코드를 비교해 보세요.</li>
          <li>시험 직전에는 문제집 화면의 <b>시험 모드</b>로 실제 시험처럼 시간을 재고 풀어 보세요.</li>
        </ol>
      </section>
      <section class="sec">
        <div class="headline"><h2>채점 결과</h2></div>
        <table class="table">
          <tbody>
            <tr><td class="w140">${verdictHtml({ verdict: "ac" })}</td><td>채점용 테스트(예시보다 많은 입력)를 모두 통과하고 문제 조건도 지켰습니다.</td></tr>
            <tr><td>${verdictHtml({ verdict: "wrong" })}</td><td>출력이 정답과 다릅니다. 괄호 안에 몇 번째 테스트에서 틀렸는지 표시됩니다. 줄 끝 공백과 아주 작은 소수 오차(예: 0.30000000000000004와 0.3)는 무시합니다.</td></tr>
            <tr><td>${verdictHtml({ verdict: "condition" })}</td><td>문제 조건(변수 이름, if~elif~else, 이중 for문, end 옵션 등)을 지키지 않았습니다. 괄호 안에 어떤 조건인지 표시됩니다.</td></tr>
            <tr><td>${verdictHtml({ verdict: "runtime" })}</td><td>실행 중에 에러가 났습니다. 괄호 안에 에러 이름이 표시됩니다.</td></tr>
            <tr><td>${verdictHtml({ verdict: "syntax" })}</td><td>문법이 틀려서 실행할 수 없습니다.</td></tr>
            <tr><td>${verdictHtml({ verdict: "tle" })}</td><td>정해진 시간 안에 끝나지 않았습니다. 무한 반복을 확인하세요.</td></tr>
            <tr><td>${verdictHtml({ verdict: "ole" })}</td><td>출력이 너무 많습니다.</td></tr>
          </tbody>
        </table>
        <p class="muted">채점할 때 입력값은 미리 넣어 두고, 출력에는 IDLE처럼 <code>키 입력: 110</code> 형태로 남깁니다. 프롬프트 문자열까지 똑같이 써야 합니다.</p>
      </section>
      <section class="sec">
        <div class="headline"><h2>단축키</h2></div>
        <table class="table">
          <tbody>${keys.map(([k, d]) => `<tr><td class="w200"><kbd>${esc(k)}</kbd></td><td>${esc(d)}</td></tr>`).join("")}</tbody>
        </table>
        <p class="muted">콜론(:) 뒤에서 Enter를 누르면 4칸 들여쓰기가 되고, Backspace는 들여쓰기를 4칸씩 지웁니다.</p>
      </section>
      <section class="sec">
        <div class="headline"><h2>참고</h2></div>
        <ul class="help-list">
          <li>코드와 제출 기록은 이 브라우저에만 저장됩니다. 다른 기기에서는 보이지 않습니다.</li>
          <li>편집기 줄 번호는 편집기 메뉴 <b>Options → Hide/Show Line Numbers</b>로 끄고 켤 수 있습니다.</li>
          <li>파이썬은 브라우저 안에서 실행됩니다(Pyodide). 처음 열 때 불러오는 데 몇 초 걸립니다.</li>
          <li>휴대폰에서 따옴표가 “ ” 로 바뀌어도 자동으로 " 로 고칩니다.</li>
          <li>Shell에서 <code>help(print)</code>처럼 설명을 볼 수 있고, <code>help()</code>를 입력하면 <code>help&gt;</code> 상태가 됩니다(빈 줄이나 <code>q</code>로 나가기). 50줄이 넘는 출력은 <b>Squeezed text</b> 버튼으로 접히며, 두 번 누르면 펼쳐집니다.</li>
        </ul>
      </section>
    </div>`);
}

// ── 시험 모드 ──
// 진행 중인 시험: hoj:exam:<세트> = {start, minutes, finished, results}
// 시험 코드: hoj:examcode:<세트>/<문항>, 지난 기록: hoj:examlog
let examTimer = null;
const examMinutes = (s) => s.exam_minutes || 45;
const examKey = (sid) => `hoj:exam:${sid}`;
const examCodeKey = (sid, pid) => `hoj:examcode:${sid}/${pid}`;
function readJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function writeJSON(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* 무시 */ }
}
const getExam = (sid) => readJSON(examKey(sid), null);
const timeLeft = (ex) => ex.start + ex.minutes * 60000 - Date.now();
const mmss = (ms) => {
  const t = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};
const starterOf = (p) => (Array.isArray(p.starter) ? p.starter.join("\n") + "\n" : (p.starter || ""));

async function examIntroPage(sid) {
  setNav("sets");
  const s = await loadSet(sid);
  if (isLocked(s, sid)) return location.replace(`#/set/${sid}`);
  const ex = getExam(sid);
  if (ex && !ex.finished) {
    location.replace(`#/exam/${sid}/${s.problems[0]}`);
    return;
  }
  const probs = await Promise.all(s.problems.map((pid) => loadProblem(sid, pid)));
  const total = probs.reduce((a, p) => a + (p.score || 0), 0);
  const logs = readJSON("hoj:examlog", []).filter((l) => l.set === sid).reverse();
  setTitle(`${s.title} 시험 모드`);
  page(`
    <div class="container">
      <h1 class="page-title">${esc(s.title)} 시험 모드</h1>
      <table class="table info">
        <thead><tr><th>시간</th><th>문항</th><th>배점</th></tr></thead>
        <tbody><tr><td>${examMinutes(s)}분</td><td>${s.problems.length}문항</td><td>${total ? `${total}점` : "-"}</td></tr></tbody>
      </table>
      <ul class="help-list">
        <li>시험 중에는 <b>제출, 힌트, 정답 코드</b>를 쓸 수 없습니다. IDLE에서 실행(F5)은 할 수 있습니다.</li>
        <li>문항은 위쪽 탭으로 오가며 풀 수 있고, 코드는 자동으로 저장됩니다.</li>
        <li>시간이 끝나거나 <b>시험 끝내기</b>를 누르면 모든 문항을 한꺼번에 채점합니다.</li>
        <li>맞았습니다를 받은 문항만 배점만큼 점수를 받습니다. 부분 점수는 없습니다.</li>
      </ul>
      <p><button type="button" class="btn btn-primary" id="start">시험 시작</button>
        <a class="btn" href="#/set/${esc(sid)}">돌아가기</a></p>
      ${logs.length ? `
      <section class="sec">
        <div class="headline"><h2>지난 시험</h2></div>
        <table class="table">
          <thead><tr><th>본 시간</th><th class="c w120">점수</th><th class="c w120"></th></tr></thead>
          <tbody>${logs.map((l, i) => `<tr><td>${when(l.time)}</td><td class="c">${l.score} / ${l.total}</td>
            <td class="c">${i === 0 && ex?.finished ? `<a href="#/exam/${esc(sid)}/result">결과 보기</a>` : ""}</td></tr>`).join("")}</tbody>
        </table>
      </section>` : ""}
    </div>`);
  main.querySelector("#start").addEventListener("click", () => {
    for (const [i, pid] of s.problems.entries()) {
      try { localStorage.setItem(examCodeKey(sid, pid), starterOf(probs[i])); } catch { /* 무시 */ }
    }
    writeJSON(examKey(sid), { start: Date.now(), minutes: examMinutes(s), finished: false });
    location.hash = `#/exam/${sid}/${s.problems[0]}`;
  });
}

async function examProblemPage(sid, pid) {
  setNav("sets");
  const [s, p] = await Promise.all([loadSet(sid), loadProblem(sid, pid)]);
  if (isLocked(s, sid)) return location.replace(`#/set/${sid}`);
  const ex = getExam(sid);
  if (!ex || ex.finished) {
    location.replace(`#/exam/${sid}`);
    return;
  }
  setTitle(`${s.title} 시험 ${pid}번`);
  const tabs = s.problems.map((id) =>
    `<li class="${id === pid ? "active" : ""}"><a href="#/exam/${esc(sid)}/${esc(id)}">${esc(id)}번</a></li>`).join("");
  page(`
    <div class="container wide">
      <div class="exam-bar">
        <span class="exam-name">${esc(s.title)} 시험</span>
        <span>남은 시간 <span class="timer"></span></span>
        <button type="button" class="btn btn-primary" id="finish">시험 끝내기</button>
      </div>
      <ul class="tabs">${tabs}</ul>
      <h1 class="prob-title">${esc(p.title)}</h1>
      <div class="prob-grid">
        <div class="prob-text">${statementHtml(p, pid, { hints: false })}</div>
        <div class="prob-ide">
          <div class="ide-host"></div>
          <div class="submit-row">
            <button type="button" class="btn" id="run" title="F5">▶ 실행</button>
          </div>
        </div>
      </div>
    </div>`, true);
  const filename = `C:\\Users\\HOJ\\Desktop\\${pid}.py`;
  currentIdle = new Idle(main.querySelector(".ide-host"), { filename, storageKey: examCodeKey(sid, pid), initial: starterOf(p) });
  main.querySelector("#run").addEventListener("click", () => currentIdle.run());

  const timer = main.querySelector(".timer");
  const tick = () => {
    const left = timeLeft(ex);
    timer.textContent = mmss(left);
    timer.classList.toggle("low", left < 5 * 60000);
    if (left <= 0) finishExam(sid, "시간이 끝났습니다.");
  };
  tick();
  examTimer = setInterval(tick, 1000);
  main.querySelector("#finish").addEventListener("click", () => {
    if (confirm("시험을 끝내고 채점할까요? 끝낸 뒤에는 코드를 고칠 수 없습니다.")) finishExam(sid);
  });
}

async function finishExam(sid, reason = "") {
  clearInterval(examTimer);
  const ex = getExam(sid);
  if (!ex || ex.finished) return;
  if (currentIdle) {
    currentIdle.save();
    currentIdle.destroy();
    currentIdle = null;
  }
  const s = await loadSet(sid);
  page(`
    <div class="container">
      <h1 class="page-title">${esc(s.title)} 시험 채점</h1>
      ${reason ? `<p class="lead">${esc(reason)}</p>` : ""}
      <p class="grading">채점 중입니다...</p>
    </div>`);
  const status = main.querySelector(".grading");
  const results = [];
  for (const [i, pid] of s.problems.entries()) {
    const p = await loadProblem(sid, pid);
    let code = "";
    try { code = localStorage.getItem(examCodeKey(sid, pid)) || ""; } catch { code = ""; }
    status.textContent = `채점 중입니다... (${i + 1} / ${s.problems.length})`;
    const empty = !code.trim() || code === starterOf(p);
    const r = empty ? { verdict: "empty" } : await gradeCode(p, code);
    results.push({ pid, title: p.title, score: p.score || 0, verdict: r.verdict, detail: r.detail || "", code });
  }
  const score = results.reduce((a, r) => a + (r.verdict === "ac" ? r.score : 0), 0);
  const total = results.reduce((a, r) => a + r.score, 0);
  writeJSON(examKey(sid), { ...ex, finished: true, end: Date.now(), results, score, total });
  const logs = readJSON("hoj:examlog", []);
  logs.push({ set: sid, title: s.title, time: ex.start, score, total });
  writeJSON("hoj:examlog", logs.slice(-200));
  location.replace(`#/exam/${sid}/result`);
}

async function examResultPage(sid) {
  setNav("sets");
  const s = await loadSet(sid);
  if (isLocked(s, sid)) return location.replace(`#/set/${sid}`);
  const ex = getExam(sid);
  if (!ex || !ex.finished) {
    location.replace(`#/exam/${sid}`);
    return;
  }
  setTitle(`${s.title} 시험 결과`);
  const verdict = (r) => (r.verdict === "empty" ? '<span class="muted">작성 안 함</span>' : verdictHtml(r));
  const probs = await Promise.all(ex.results.map((r) => loadProblem(sid, r.pid)));
  const used = Math.min(ex.minutes * 60000, (ex.end || Date.now()) - ex.start);
  page(`
    <div class="container">
      <h1 class="page-title">${esc(s.title)} 시험 결과</h1>
      <p class="exam-score">점수 <b>${ex.score}</b> / ${ex.total} <span class="muted">(걸린 시간 ${mmss(used)})</span></p>
      <table class="table">
        <thead><tr><th class="c w80">문항</th><th>제목</th><th>결과</th><th class="c w80">배점</th><th class="c w80">점수</th></tr></thead>
        <tbody>${ex.results.map((r) => `<tr>
          <td class="c">${esc(r.pid)}</td>
          <td><a href="#/problem/${esc(sid)}/${esc(r.pid)}">${esc(r.title)}</a></td>
          <td>${verdict(r)}</td>
          <td class="c">${r.score}</td>
          <td class="c">${r.verdict === "ac" ? r.score : 0}</td>
        </tr>`).join("")}</tbody>
      </table>
      ${ex.results.map((r, i) => `
      <section class="sec">
        <div class="headline"><h2>${esc(r.pid)}번 ${esc(r.title)}</h2></div>
        <div class="compare">
          <div><div class="compare-title">내 코드</div><pre class="source">${r.code.trim() ? highlight(r.code) : '<span class="muted">작성 안 함</span>'}</pre></div>
          <div><div class="compare-title">정답 코드</div><pre class="source">${highlight(solutionText(probs[i]))}</pre></div>
        </div>
      </section>`).join("")}
      <p><a class="btn btn-primary" href="#/exam/${esc(sid)}" id="again">다시 시험 보기</a>
        <a class="btn" href="#/set/${esc(sid)}">문제집으로</a></p>
    </div>`);
  // 다시 보기를 누르면 지난 결과는 기록(hoj:examlog)에만 남기고 시작 화면으로 간다.
  main.querySelector("#again").addEventListener("click", () => {
    try { localStorage.removeItem(examKey(sid)); } catch { /* 무시 */ }
  });
}

// ── 라우터 ──
async function route() {
  if (currentIdle) {
    currentIdle.destroy();
    currentIdle = null;
  }
  clearInterval(examTimer);
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  try {
    if (!parts.length) await homePage();
    else if (parts[0] === "set" && parts[1]) await setPage(parts[1]);
    else if (parts[0] === "problem" && parts[2]) await problemPage(parts[1], parts[2]);
    else if (parts[0] === "status") statusPage();
    else if (parts[0] === "source" && parts[1]) sourcePage(parts[1]);
    else if (parts[0] === "help") helpPage();
    else if (parts[0] === "exam" && parts[1] && parts[2] === "result") await examResultPage(parts[1]);
    else if (parts[0] === "exam" && parts[1] && parts[2]) await examProblemPage(parts[1], parts[2]);
    else if (parts[0] === "exam" && parts[1]) await examIntroPage(parts[1]);
    else errorPage(location.hash);
  } catch (err) {
    errorPage(String(err.message || err));
  }
}

window.addEventListener("hashchange", route);
route();
