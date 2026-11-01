// 워커를 띄우고, 멈추지 않는 코드는 워커를 새로 만들어 끊는다.
export class Runtime {
  constructor(handlers) {
    this.h = handlers;
    this.version = "";
    this.start();
  }

  start() {
    this.ready = false;
    this.seq = 0;
    this.pending = new Map();
    this.worker = new Worker(new URL("./worker.js", import.meta.url));
    this.worker.onmessage = (e) => this.onMessage(e.data);
    this.worker.onerror = (e) => this.h.onFatal?.(e.message || "워커 오류");
  }

  restart() {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error("restart"));
    this.start();
  }

  onMessage(m) {
    switch (m.type) {
      case "ready":
        this.ready = true;
        this.version = m.version;
        this.h.onReady?.(m.version);
        break;
      case "fatal":
        this.h.onFatal?.(m.message);
        break;
      case "out":
        this.h.onOut?.(m.text, m.stream);
        break;
      case "input":
        this.h.onInput?.();
        break;
      case "progress":
        this.h.onProgress?.(m.i, m.n);
        break;
      case "result": {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (p) p.resolve(m.value);
        break;
      }
    }
  }

  call(type, payload = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type, id, ...payload });
    });
  }

  run(code, filename) { return this.call("run", { code, filename }); }
  shell(source) { return this.call("shell", { source }); }
  reset() { return this.call("reset"); }
  async check(code, filename) {
    const r = await this.call("check", { code, filename });
    return r ? JSON.parse(r) : null;
  }
  async grade(code, problem) {
    return JSON.parse(await this.call("grade", { code, problem: JSON.stringify(problem) }));
  }

  // 편집기 도우미: 프로그램이 오래 돌고 있으면 기다리지 않는다.
  quick(type, payload, fallback) {
    if (!this.ready) return Promise.resolve(fallback);
    return Promise.race([this.call(type, payload), new Promise((r) => setTimeout(() => r(fallback), 400))]);
  }
  calltip(expr) { return this.quick("calltip", { expr }, ""); }
  async complete(what) {
    const r = await this.quick("complete", { what }, null);
    return r ? JSON.parse(r) : null;
  }

  reply(value) { this.worker.postMessage({ type: "input-reply", value }); }
  interruptInput() { this.worker.postMessage({ type: "input-reply", interrupt: true }); }
  abortInput() { this.worker.postMessage({ type: "input-reply", abort: true }); }
}
