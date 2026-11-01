(() => {
  const KEY="hoj_quick_start_seen_v1";
  const style=document.createElement("style");
  style.textContent=`.hoj-quick-btn{position:fixed;right:18px;bottom:18px;z-index:9999;border:1px solid #00639f;background:#0076c0;color:#fff;padding:10px 14px;font:700 14px/1.2 sans-serif;box-shadow:0 4px 14px #0002;cursor:pointer}.hoj-guide{width:min(560px,calc(100% - 36px));border:1px solid #ddd;padding:24px;color:#333;font:14px/1.65 sans-serif}.hoj-guide::backdrop{background:#0006}.hoj-guide h2{margin:0 0 8px;font-size:22px}.hoj-guide li{margin:6px 0}.hoj-guide-actions{display:flex;gap:8px;justify-content:flex-end}.hoj-guide button{padding:8px 14px;border:1px solid #ccc;background:#fff;cursor:pointer;font:inherit}.hoj-guide .primary{background:#0076c0;color:#fff}.hoj-runtime-state{position:fixed;left:18px;bottom:18px;z-index:9998;background:#fff;border:1px solid #ddd;padding:8px 11px;color:#555;font:12px/1.4 sans-serif;display:none}@media(max-width:640px){.hoj-quick-btn{right:10px;bottom:10px}.hoj-runtime-state{left:10px;bottom:58px}}`;
  document.head.appendChild(style);
  const btn=document.createElement("button");
  btn.className="hoj-quick-btn";btn.type="button";btn.textContent="빠른 시작";
  const guide=document.createElement("dialog");guide.className="hoj-guide";guide.setAttribute("aria-label","HOJ 빠른 시작");
  guide.innerHTML='<h2>HOJ 빠른 시작</h2><p>아래 순서로 Python 코드를 실행하고 채점해 보세요.</p><ol><li><b>문제집</b>에서 연습 문제를 선택합니다.</li><li>IDLE 편집기에 코드를 작성합니다.</li><li><b>F5 실행</b>으로 결과를 확인합니다.</li><li><b>제출</b>을 눌러 출력과 문제 조건을 함께 채점합니다.</li><li>채점 결과를 보고 코드를 수정해 다시 제출합니다.</li></ol><div class="hoj-guide-actions"><button type="button" data-close>닫기</button><button type="button" class="primary" data-go>문제집 보기</button></div>';
  document.body.append(btn,guide);
  function show(){if(!guide.open)guide.showModal();try{localStorage.setItem(KEY,"1");}catch{}}
  btn.addEventListener("click",show);
  guide.querySelector("[data-close]").onclick=()=>guide.close();
  guide.querySelector("[data-go]").onclick=()=>{location.hash="#/";guide.close();};
  const runtime=document.createElement("div");runtime.className="hoj-runtime-state";runtime.setAttribute("role","status");runtime.textContent="Python 실행환경을 준비하고 있습니다…";document.body.appendChild(runtime);
  const update=()=>{runtime.style.display=[...document.querySelectorAll(".sh-out")].some(el=>el.textContent.trim()==="Python을 불러오는 중입니다...")?"block":"none";};
  new MutationObserver(update).observe(document.getElementById("main"),{subtree:true,childList:true,characterData:true});
  update();let seen=false;try{seen=!!localStorage.getItem(KEY);}catch{}if(!seen)setTimeout(show,700);
})();