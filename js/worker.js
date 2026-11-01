// Pyodide 워커. 메인 스레드와 메시지로 실행/입력/채점을 주고받는다.
/* global loadPyodide */
// 사이트에 함께 올린 Pyodide(pyodide/)를 먼저 쓰고, 없으면 CDN에서 받는다.
// (학교망에서 CDN이 막혀도 동작하도록. tools/dist.py가 pyodide/를 넣는다.)
const CDN = "https://cdn.jsdelivr.net/pyodide/v0.27.2/full/";
let PYODIDE = new URL("../pyodide/", self.location.href).href;
try {
  importScripts(PYODIDE + "pyodide.js");
} catch {
  PYODIDE = CDN;
  importScripts(PYODIDE + "pyodide.js");
}

let runner = null;
let pendingInput = null;

self.jsEmit = (stream, text) => postMessage({ type: "out", stream, text });
self.jsProgress = (i, n) => postMessage({ type: "progress", i, n });
self.jsRequestInput = () =>
  new Promise((resolve) => {
    pendingInput = resolve;
    postMessage({ type: "input" });
  });

const ready = (async () => {
  const py = await loadPyodide({ indexURL: PYODIDE });
  for (const name of ["checker.py", "runner.py", "python-license.txt"]) {
    const res = await fetch(new URL("../py/" + name, self.location.href), { cache: "no-cache" });
    if (res.ok) py.FS.writeFile("/home/pyodide/" + name, await res.text());
    else if (name.endsWith(".py")) throw new Error(name + " (" + res.status + ")");
  }
  py.runPython("import sys; sys.path.insert(0, '/home/pyodide')");
  runner = py.pyimport("runner");
  postMessage({ type: "ready", version: runner.version() });
})().catch((err) => {
  postMessage({ type: "fatal", message: String(err && err.message ? err.message : err) });
});

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === "input-reply") {
    const resolve = pendingInput;
    pendingInput = null;
    if (resolve) resolve(m.interrupt ? null : m.abort ? { abort: true } : m.value);
    return;
  }
  await ready;
  if (!runner) return;
  let value = null;
  try {
    if (m.type === "run") await runner.run_program(m.code, m.filename);
    else if (m.type === "shell") value = await runner.shell_run(m.source);
    else if (m.type === "check") value = runner.check_syntax(m.code, m.filename);
    else if (m.type === "grade") value = await runner.grade(m.code, m.problem);
    else if (m.type === "reset") runner.reset_shell();
    else if (m.type === "calltip") value = runner.calltip(m.expr);
    else if (m.type === "complete") value = runner.completions(m.what);
  } catch (err) {
    postMessage({ type: "out", stream: "stderr", text: String(err) + "\n" });
  }
  postMessage({ type: "result", id: m.id, value });
};
