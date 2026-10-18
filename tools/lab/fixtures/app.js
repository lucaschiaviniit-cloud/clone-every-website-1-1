// Fixture source distributed to the browser, not reconstruction code.
document.getElementById('menu-toggle').addEventListener('click',event=>{
  const button=event.currentTarget,open=button.getAttribute('aria-expanded')!=='true';
  button.setAttribute('aria-expanded',String(open));document.getElementById('menu').hidden=!open;
});
const ctx=document.getElementById('canvas2d').getContext('2d');ctx.fillStyle='#214f42';ctx.fillRect(0,0,240,100);ctx.fillStyle='#a7ec55';ctx.fillRect(20,20,180,60);
const gl=document.getElementById('webgl').getContext('webgl',{preserveDrawingBuffer:true});if(gl){gl.clearColor(.15,.35,.25,1);gl.clear(gl.COLOR_BUFFER_BIT);}
document.getElementById('waapi-motion').animate([{transform:'rotate(0deg)',opacity:1},{transform:'rotate(90deg)',opacity:.5}],{duration:2000,iterations:Infinity});
customElements.define('lab-shadow',class extends HTMLElement{constructor(){super();this.attachShadow({mode:'open'}).innerHTML='<style>strong{color:#784218}</style><strong>Open shadow evidence</strong>';}});
localStorage.setItem('fixture-mode','nonsecret');sessionStorage.setItem('fixture-session','nonsecret');document.cookie='fixture=local; SameSite=Strict';
fetch('/api/status?mode=baseline&order=1').then(r=>{if(!r.ok)throw new Error('API unavailable');return r.json();}).then(data=>document.getElementById('status').textContent=data.label).catch(()=>document.getElementById('status').textContent='GET data unavailable').finally(()=>document.documentElement.dataset.ready='true');
