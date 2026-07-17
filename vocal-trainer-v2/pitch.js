let micStream=null,analyser=null,micBuf=null,rafId=null,micOn=false,lastRun=0;
const history=[],smoothCents=[];let lastGood=null,lastGoodAt=0;
let sessionState="idle",sessionStart=0,sessionSamples=[],countdownTimer=null;
const SESSION_MS=3000,COUNTDOWN_MS=850;

function median(a){if(!a.length)return null;const b=a.slice().sort((x,y)=>x-y),m=Math.floor(b.length/2);return b.length%2?b[m]:(b[m-1]+b[m])/2}
function resetDetector(){history.length=0;smoothCents.length=0;lastGood=null;lastGoodAt=0;sessionSamples=[];if(sessionState!=="countdown")sessionState="idle";const fill=$("listenFill");if(fill)fill.style.width="0%"}
function setListeningUI(text,pct){$("listenText").textContent=text;$("listenFill").style.width=Math.max(0,Math.min(100,pct))+"%"}

/* Детектор не угадывает любую ноту. Он ищет только выбранную цель,
   а также ту же ноту октавой ниже/выше. Для упражнения на удержание
   это заметно устойчивее универсального тюнера. */
function targetLockedPitch(buf,sr,target){
  let mean=0;for(let i=0;i<buf.length;i++)mean+=buf[i];mean/=buf.length;
  let rms=0;for(let i=0;i<buf.length;i++){const v=buf[i]-mean;rms+=v*v}rms=Math.sqrt(rms/buf.length);
  if(rms<0.0045)return null;
  let best=null;
  for(const oct of [-1,0,1]){
    const expected=target*Math.pow(2,oct);
    const minF=expected*Math.pow(2,-130/1200),maxF=expected*Math.pow(2,130/1200);
    let minLag=Math.max(2,Math.floor(sr/maxF)),maxLag=Math.min(Math.floor(sr/minF),Math.floor(buf.length/2)-2);
    for(let lag=minLag;lag<=maxLag;lag++){
      let xy=0,xx=0,yy=0;
      const n=Math.min(buf.length-lag,3072);
      for(let i=0;i<n;i++){
        const a=buf[i]-mean,b=buf[i+lag]-mean;
        xy+=a*b;xx+=a*a;yy+=b*b;
      }
      const corr=xy/Math.sqrt(xx*yy+1e-12);
      if(!best||corr>best.corr)best={lag,corr,oct};
    }
  }
  if(!best||best.corr<0.68)return null;
  const scoreAt=lag=>{
    let xy=0,xx=0,yy=0;const n=Math.min(buf.length-lag,3072);
    for(let i=0;i<n;i++){const a=buf[i]-mean,b=buf[i+lag]-mean;xy+=a*b;xx+=a*a;yy+=b*b}
    return xy/Math.sqrt(xx*yy+1e-12);
  };
  const y1=scoreAt(best.lag-1),y2=best.corr,y3=scoreAt(best.lag+1);
  const den=2*(2*y2-y1-y3);let refined=best.lag;
  if(Math.abs(den)>1e-9)refined+=(y3-y1)/den;
  const hz=sr/refined;
  const raw=1200*Math.log2(hz/target),oct=Math.round(raw/1200),cents=raw-oct*1200;
  if(Math.abs(cents)>150)return null;
  return {hz,cents,oct,clarity:best.corr,rms};
}

function stopMic(){micOn=false;sessionState="idle";if(countdownTimer)clearTimeout(countdownTimer);if(rafId)cancelAnimationFrame(rafId);if(micStream)micStream.getTracks().forEach(t=>t.stop());micStream=null;analyser=null;$("micBtn").textContent="Включить микрофон";$("listenBtn").disabled=true;$("needle").className="needle idle";$("needle").style.left="50%";$("vCents").textContent="—";$("vHz").textContent="—";$("vStab").textContent="—";$("verdict").textContent="Микрофон выключен.";setListeningUI("Сначала включите микрофон",0)}

$("micBtn").addEventListener("click",async()=>{
  if(micOn){stopMic();return}
  const ac=await ready();if(!ac)return;
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){setStatus("Браузер не даёт доступ к микрофону на этой странице.");return}
  try{
    micStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false,channelCount:1}})
  }catch(first){
    try{micStream=await navigator.mediaDevices.getUserMedia({audio:true})}
    catch(e){setStatus(e&&e.name==="NotAllowedError"?"Доступ к микрофону запрещён. Откройте страницу в Safari и разрешите микрофон.":"Микрофон не включился: "+(e.name||e));return}
  }
  const src=ac.createMediaStreamSource(micStream);analyser=ac.createAnalyser();analyser.fftSize=8192;analyser.smoothingTimeConstant=0;micBuf=new Float32Array(analyser.fftSize);src.connect(analyser);micOn=true;resetDetector();$("micBtn").textContent="Выключить микрофон";$("listenBtn").disabled=false;$("verdict").textContent="Микрофон готов. Послушайте эталон и нажмите «Слушать 3 секунды».";setListeningUI("Готов к попытке",0);setStatus("");loop()
});

$("listenBtn").addEventListener("click",()=>{
  if(!micOn||sessionState!=="idle")return;
  if(performance.now()<refUntil){$("verdict").textContent="Подождите, пока закончится эталон.";return}
  resetDetector();sessionState="countdown";$("listenBtn").disabled=true;setListeningUI("Вдохните… начинайте длинное «ааа»",0);$("verdict").textContent="Замер начнётся через мгновение.";
  countdownTimer=setTimeout(()=>{sessionState="recording";sessionStart=performance.now();sessionSamples=[];smoothCents.length=0;history.length=0;setListeningUI("Держите ноту: 3,0 с",0);$("verdict").innerHTML="<b>Пойте непрерывно.</b> Держите звук до заполнения полосы."},COUNTDOWN_MS)
});

function finishSession(){
  sessionState="idle";$("listenBtn").disabled=false;setListeningUI("Попытка завершена — можно повторить",100);
  if(sessionSamples.length<18){$("verdict").innerHTML='<span class="warn">Детектор слышал ноту слишком мало времени.</span> Держите телефон в 20–35 см и пойте непрерывное «ааа» чуть громче.';return}
  const cents=sessionSamples.map(x=>x.cents),avg=cents.reduce((a,b)=>a+b,0)/cents.length;
  const in10=Math.round(cents.filter(x=>Math.abs(x)<=10).length/cents.length*100),in20=Math.round(cents.filter(x=>Math.abs(x)<=20).length/cents.length*100),coverage=Math.round(sessionSamples.length/(SESSION_MS/50)*100);
  $("vCents").textContent=(avg>0?"+":"")+avg.toFixed(0)+"¢";$("vStab").textContent=in20+"%";
  const quality=in10>=70?"Отлично":in20>=70?"Хорошо":in20>=45?"Нестабильно":"Нужно повторить";
  $("verdict").innerHTML="<b>"+quality+".</b> Среднее "+(avg>0?"+":"")+avg.toFixed(0)+"¢; ±10¢ — "+in10+"%, ±20¢ — "+in20+"%. Нота распознана "+Math.min(100,coverage)+"% времени."
}

function showMeasurement(hz,cents,oct,now){
  const needle=$("needle"),clamped=Math.max(-50,Math.min(50,cents));needle.className="needle"+(Math.abs(cents)<=10?" good":"");needle.style.left=(clamped+50).toFixed(1)+"%";$("vHz").textContent=hz.toFixed(1)+" Гц";$("vCents").textContent=(cents>0?"+":"")+cents.toFixed(0)+"¢";
  history.push({t:now,cents});while(history.length&&now-history[0].t>2000)history.shift();if(history.length>8)$("vStab").textContent=Math.round(history.filter(x=>Math.abs(x.cents)<=20).length/history.length*100)+"%";
  if(sessionState!=="recording"){const [ru]=KEYS[currentKey].names[String(targetOff)];let msg=Math.abs(cents)<=10?"<b>Точно.</b>":cents<0?"Низите на "+Math.abs(cents).toFixed(0)+" центов.":"Завышаете на "+cents.toFixed(0)+" центов.";if(oct!==0)msg+=' <span class="warn">Это '+ru+' октавой '+(oct<0?'ниже':'выше')+'.</span>';$("verdict").innerHTML=msg}
}

function loop(){
  if(!micOn)return;rafId=requestAnimationFrame(loop);const now=performance.now();if(now-lastRun<50)return;lastRun=now;
  if(sessionState==="recording"){const elapsed=now-sessionStart,pct=elapsed/SESSION_MS*100;setListeningUI("Держите ноту: "+Math.max(0,(SESSION_MS-elapsed)/1000).toFixed(1)+" с",pct);if(elapsed>=SESSION_MS){finishSession();return}}
  if(now<refUntil)return;
  analyser.getFloatTimeDomainData(micBuf);const target=freqOf(currentKey,targetOff),res=targetLockedPitch(micBuf,ctx.sampleRate,target);
  if(!res){if(sessionState!=="recording"&&lastGood&&now-lastGoodAt<900){$("verdict").textContent="Держу последнее уверенное измерение…";return}if(sessionState!=="recording"){$("needle").className="needle idle";$("verdict").textContent="Жду выбранную ноту. Пойте непрерывное «ааа»."}return}
  smoothCents.push(res.cents);if(smoothCents.length>5)smoothCents.shift();const cents=median(smoothCents),hz=target*Math.pow(2,(res.oct*1200+cents)/1200);lastGood=hz;lastGoodAt=now;showMeasurement(hz,cents,res.oct,now);if(sessionState==="recording")sessionSamples.push({cents,hz,oct:res.oct})
}

window.addEventListener("error",e=>setStatus("Ошибка запуска: "+(e.message||"неизвестная ошибка")+". Обновите страницу."));selectKey(currentKey);setStatus("");