// Night Shift design system: "after-hours print".
// Black page, bone type, one sodium-amber accent reserved for the action that moves you forward
// (buy, continue, pay, publish). One typeface, Archivo, used at two widths: ultra-condensed and
// heavy for flyer-style display, normal width for reading. Posters lead; when an event has no
// artwork it gets a generated typographic flyer (<Flyer>), so the page is never a grid of grey boxes.
// Every value still comes straight from the database: state is never hidden or prettified away.
import { statSync } from "node:fs";
import { raw } from "hono/html";
import type { Child, FC, PropsWithChildren } from "hono/jsx";
import { clockOffset } from "../clock.ts";
import { config } from "../config.ts";
import type { Event, User } from "../db/schema.ts";
import type { TimelineRow } from "../services/journal.ts";
import { countByStatus } from "../services/orders.ts";
import { fmtDuration, fmtStamp, money, TZ } from "../lib/time.ts";

const css = `
@font-face{font-family:Archivo;src:url(/fonts/archivo-latin-wdth-normal.woff2) format("woff2");font-weight:100 900;font-stretch:62% 125%;font-display:swap;
  unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:Archivo;src:url(/fonts/archivo-latin-ext-wdth-normal.woff2) format("woff2");font-weight:100 900;font-stretch:62% 125%;font-display:swap;
  unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
:root{
  color-scheme:dark;
  --black:#000;--char:#141414;--char-2:#1c1c1c;--line:#2a2a2a;--line-2:#3a3a3a;
  --fog:#8e8e8e;--bone:#ede8df;--sodium:#ffb238;--sodium-ink:#1a1000;
  --ok:#7fd18b;--bad:#ff6b5e;
  --display:Archivo,"Arial Narrow",system-ui,sans-serif;
  --mono:ui-monospace,"Cascadia Code",Consolas,monospace;
  --ease:cubic-bezier(.2,.7,.2,1);
}
@view-transition{navigation:auto}
::view-transition-old(root),::view-transition-new(root){animation-duration:.18s}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{background:var(--black);color:var(--bone);-webkit-text-size-adjust:100%}
body{margin:0;font:400 16px/1.55 var(--display);font-stretch:100%;min-height:100vh;display:flex;flex-direction:column}
a{color:inherit;text-decoration-color:var(--line-2);text-underline-offset:3px}
a:hover{text-decoration-color:currentColor}
:focus-visible{outline:2px solid var(--sodium);outline-offset:3px}
::selection{background:var(--sodium);color:var(--sodium-ink)}
img{display:block;max-width:100%}
.wrap{width:100%;max-width:1240px;margin:0 auto;padding:0 20px}
@media(min-width:900px){.wrap{padding:0 40px}}
.skip{position:absolute;left:-999px;top:8px;z-index:99}.skip:focus{left:8px}

/* ---------- type ---------- */
.display{font-stretch:62%;font-weight:850;text-transform:uppercase;line-height:.86;letter-spacing:-.005em;margin:0;text-wrap:balance}
h1{font-size:clamp(2.6rem,7vw,5.6rem)}
h1.display{font-size:clamp(3.2rem,10vw,8.5rem)}
h2{font-size:1.35rem;font-weight:700;letter-spacing:-.01em;margin:0 0 14px}
h2.display{font-size:clamp(2rem,4.5vw,3.2rem);margin-bottom:20px}
h3{font-size:1rem;font-weight:700;margin:0 0 8px}
p{margin:0 0 12px;max-width:68ch}
.lede{font-size:1.15rem;max-width:52ch}
.sub,.muted{color:var(--fog)}
.sub{margin:6px 0 24px}
.small{font-size:.875rem}
.tiny{font-size:.78rem}
.mono,code{font-family:var(--mono);font-size:.86em}
code{background:var(--char-2);padding:2px 6px;border-radius:3px}
.num{font-variant-numeric:tabular-nums}

/* ---------- buttons ---------- */
.btn,button{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:8px;font:600 .95rem/1 var(--display);font-stretch:100%;
  padding:12px 18px;border-radius:999px;border:1px solid var(--line-2);background:transparent;color:var(--bone);cursor:pointer;text-decoration:none;white-space:nowrap;
  transition:background .15s var(--ease),border-color .15s var(--ease),color .15s var(--ease),transform .08s}
.btn:hover,button:hover{border-color:var(--bone)}
.btn:active,button:active{transform:scale(.98)}
.btn.primary,button.primary{background:var(--sodium);border-color:var(--sodium);color:var(--sodium-ink)}
.btn.primary:hover,button.primary:hover{background:#ffc566;border-color:#ffc566}
.btn.solid,button.solid{background:var(--bone);border-color:var(--bone);color:#000}
.btn.ok,button.ok{background:var(--ok);border-color:var(--ok);color:#03200a}
.btn.danger,button.danger{color:var(--bad);border-color:#5a2420}
.btn.danger:hover,button.danger:hover{border-color:var(--bad)}
.btn.ghost,button.ghost{border-color:transparent;padding-left:8px;padding-right:8px}
.btn.sm,button.sm{padding:8px 13px;font-size:.84rem}
.btn.lg,button.lg{padding:16px 26px;font-size:1.05rem}
.btn.block,button.block{width:100%}
button:disabled,.btn[aria-disabled=true]{opacity:.4;cursor:not-allowed;transform:none}
button.busy{position:relative;color:transparent!important}
button.busy::after{content:"";position:absolute;width:16px;height:16px;border:2px solid var(--bone);border-right-color:transparent;border-radius:50%;animation:spin .7s linear infinite}
button.primary.busy::after{border-color:var(--sodium-ink);border-right-color:transparent}
@keyframes spin{to{transform:rotate(1turn)}}
form{margin:0}
form.inline{display:inline-flex;gap:8px;align-items:center;flex-wrap:wrap}

/* ---------- inputs ---------- */
label{display:block;font-size:.875rem;font-weight:600}
label>input,label>select,label>textarea{margin-top:6px}
.hint{font-weight:400;color:var(--fog)}
input,select,textarea{font:400 1rem/1.3 var(--display);font-stretch:100%;color:var(--bone);background:var(--char);border:1px solid var(--line);border-radius:6px;padding:12px 14px;width:100%;transition:border-color .15s}
input:hover,select:hover,textarea:hover{border-color:var(--line-2)}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--bone)}
input[type=checkbox],input[type=radio]{width:auto;accent-color:var(--sodium)}
textarea{min-height:110px;resize:vertical}
input::placeholder,textarea::placeholder{color:#5c5c5c}
form.inline input,form.inline select{width:auto}
.fields{display:grid;gap:18px}
.fields.two{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.check{display:flex;gap:10px;align-items:center;font-weight:500}
.err{color:var(--bad);font-size:.8rem;font-weight:500;display:block;margin-top:5px}
.drop{position:relative;display:grid;place-items:center;gap:4px;text-align:center;border:1px dashed var(--line-2);border-radius:8px;padding:24px;cursor:pointer;font-weight:400;color:var(--fog)}
.drop:hover,.drop:focus-within{border-color:var(--bone);color:var(--bone)}
.drop input{position:absolute;inset:0;opacity:0;cursor:pointer}
.drop strong{color:var(--bone)}

/* ---------- status ---------- */
.status{display:inline-flex;align-items:center;gap:7px;font-size:.8rem;font-weight:600;white-space:nowrap;color:var(--fog)}
.status::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
.status.ok{color:var(--ok)}.status.bad{color:var(--bad)}.status.warn{color:var(--sodium)}.status.info{color:#9db4ff}
.pill{display:inline-block;font-size:.75rem;font-weight:600;padding:3px 9px;border-radius:999px;border:1px solid var(--line-2);color:var(--fog)}
.pill.ok{color:var(--ok);border-color:#2b4a30}.pill.bad{color:var(--bad);border-color:#5a2420}.pill.warn{color:var(--sodium);border-color:#5a4214}
.tag{display:inline-block;font-size:.78rem;font-weight:700;padding:5px 10px;border-radius:999px;background:#000;color:var(--bone)}
.tag.hot{background:var(--sodium);color:var(--sodium-ink)}
.tag.out{color:var(--fog)}

/* ---------- flash / empty ---------- */
.flash{padding:14px 16px;border-radius:6px;margin:0 0 22px;font-weight:500;border:1px solid;animation:drop .25s var(--ease)}
.flash.ok{color:var(--ok);border-color:#2b4a30;background:#0d1a0f}
.flash.err{color:var(--bad);border-color:#5a2420;background:#1d0c0a}
@keyframes drop{from{opacity:0;transform:translateY(-6px)}}
.empty{border:1px dashed var(--line);border-radius:8px;padding:40px 20px;text-align:center;color:var(--fog)}
.empty strong{display:block;color:var(--bone);font-size:1.05rem;margin-bottom:4px}

/* ---------- generated flyer ---------- */
.flyer{container-type:inline-size;aspect-ratio:4/5;position:relative;overflow:hidden;border-radius:4px;background:var(--char);color:var(--bone);isolation:isolate}
.f-in{position:absolute;inset:0;padding:7cqi;display:flex;flex-direction:column;justify-content:space-between}
.flyer-img{aspect-ratio:4/5;width:100%;object-fit:cover;border-radius:4px;background:var(--char)}
.f-pre{font-size:3.8cqi;font-weight:600;opacity:.8}
.f-title{font-stretch:62%;font-weight:900;text-transform:uppercase;line-height:.84;font-size:17cqi;letter-spacing:-.01em;overflow-wrap:break-word;margin:0;max-width:none}
.f-date{font-stretch:62%;font-weight:800;text-transform:uppercase;font-size:7cqi;line-height:.95;margin-top:3cqi}
.f-acts{font-size:4cqi;font-weight:600;line-height:1.3}
.f-big{position:absolute;z-index:-1;font-stretch:62%;font-weight:900;line-height:.78;font-size:92cqi;right:-4cqi;bottom:-6cqi;color:transparent;-webkit-text-stroke:.5cqi currentColor;opacity:.3}
.flyer.v0 .f-big{opacity:.22}
.flyer.v1{background:var(--bone);color:#000}
.flyer.v2{background:#000;border:1px solid var(--line)}
.flyer.v2 .f-title{color:var(--sodium)}
.flyer.v3{background:#1b1712}
.flyer.v3 .f-title{font-size:21cqi;color:transparent;-webkit-text-stroke:.45cqi var(--bone)}

/* ---------- public chrome ---------- */
.pub-top{position:sticky;top:0;z-index:20;background:rgba(0,0,0,.86);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
.pub-top .wrap{display:flex;align-items:center;gap:24px;height:68px}
.mark{font-stretch:62%;font-weight:900;text-transform:uppercase;font-size:1.65rem;letter-spacing:-.01em;line-height:1;text-decoration:none;color:var(--bone);white-space:nowrap}
.mark span{color:var(--sodium);margin:0 .04em}
.pub-nav{display:flex;gap:22px;margin-left:auto;align-items:center;font-size:.95rem}
.pub-nav a{text-decoration:none;color:var(--fog)}
.pub-nav a:hover,.pub-nav a.on{color:var(--bone)}
main{flex:1}
.pub-main{padding:28px 0 96px}
.pub-foot{border-top:1px solid var(--line);padding:40px 0 48px;color:var(--fog);font-size:.875rem}
.pub-foot .wrap{display:grid;gap:28px;grid-template-columns:1fr}
@media(min-width:760px){.pub-foot .wrap{grid-template-columns:2fr 1fr 1fr}}
.pub-foot h3{color:var(--bone);font-size:.875rem}
.pub-foot ul{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.pub-foot a{text-decoration:none}.pub-foot a:hover{color:var(--bone)}

/* home: featured */
.feature{display:grid;gap:28px;align-items:end;margin-bottom:84px}
@media(min-width:860px){.feature{grid-template-columns:minmax(0,5fr) minmax(0,7fr);gap:56px}}
.feature .when{font-size:1.05rem;font-weight:600;margin-bottom:14px}
.feature h1{margin-bottom:18px}
.feature .acts{font-size:1.1rem;margin-bottom:22px;max-width:46ch}
.feature .buy{display:flex;align-items:center;gap:18px;flex-wrap:wrap;margin-top:26px}
.price{font-size:1.25rem;font-weight:700}
.price small{font-size:.85rem;font-weight:500;color:var(--fog);margin-right:4px}

/* home: grid */
.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:16px;border-top:1px solid var(--line);padding-top:22px}
.lineup-grid{display:grid;gap:36px 18px;grid-template-columns:repeat(2,minmax(0,1fr))}
@media(min-width:760px){.lineup-grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:48px 28px}}
@media(min-width:1100px){.lineup-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
.ev{display:block;text-decoration:none;color:inherit}
.ev .art{position:relative;overflow:hidden;border-radius:4px;margin-bottom:14px}
.ev .art>.flyer,.ev .art>.flyer-img{transition:transform .5s var(--ease)}
.ev:hover .art>.flyer,.ev:hover .art>.flyer-img{transform:scale(1.035)}
.ev .art .tag{position:absolute;right:10px;top:10px;z-index:2}
.ev .d{font-weight:700;font-size:.95rem}
.ev .t{font-weight:700;font-size:1.05rem;line-height:1.25;margin:2px 0 3px}
.ev .v{color:var(--fog);font-size:.9rem}
.ev .p{font-size:.9rem;margin-top:6px}

/* event page */
.event{display:grid;gap:36px}
@media(min-width:900px){.event{grid-template-columns:minmax(0,5fr) minmax(0,7fr);gap:64px;align-items:start}.event .poster-col{position:sticky;top:96px}}
.presents{color:var(--fog);font-weight:600;margin-bottom:10px}
.facts{display:grid;gap:14px;margin:28px 0 34px;padding:0;list-style:none}
.facts li{display:grid;grid-template-columns:22px 1fr;gap:12px;align-items:start}
.facts svg{margin-top:3px;color:var(--fog)}
.facts strong{display:block}
.block{border-top:1px solid var(--line);padding-top:24px;margin-top:40px}
.timetable{display:grid;margin:0;padding:0;list-style:none}
.timetable li{display:grid;grid-template-columns:72px 1fr auto;gap:12px;padding:12px 0;border-bottom:1px solid var(--line);align-items:baseline}
.timetable li:last-child{border-bottom:0}
.timetable .time{color:var(--fog);font-variant-numeric:tabular-nums}
.timetable .act{font-weight:700;font-size:1.1rem}
.timetable .role{color:var(--fog);font-size:.875rem}

/* tickets panel */
.tickets{border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--char);scroll-margin-top:90px}
.tickets>header{display:flex;justify-content:space-between;align-items:center;padding:18px 20px;border-bottom:1px solid var(--line)}
.tier{position:relative;display:grid;grid-template-columns:auto 1fr auto;gap:14px;align-items:center;padding:16px 20px;border-bottom:1px solid var(--line);cursor:pointer;font-weight:400;transition:background .15s}
.tier:hover{background:var(--char-2)}
.tier input{position:absolute;opacity:0;width:1px;height:1px}
.tier .dot{width:20px;height:20px;border:1.5px solid var(--line-2);border-radius:50%;display:grid;place-items:center}
.tier input:checked~.dot{border-color:var(--sodium)}
.tier input:checked~.dot::after{content:"";width:10px;height:10px;border-radius:50%;background:var(--sodium)}
.tier input:focus-visible~.dot{outline:2px solid var(--sodium);outline-offset:3px}
.tier:has(input:checked){background:var(--char-2)}
.tier .name{font-weight:700;font-size:1.02rem}
.tier .note{font-size:.84rem;color:var(--fog)}
.tier .note.hot{color:var(--sodium)}
.tier .amt{font-weight:700;font-size:1.05rem;font-variant-numeric:tabular-nums}
.tier.off{cursor:default}
.tier.off .name,.tier.off .amt{color:var(--fog)}
.tier.off .dot{border-style:dashed}
.tier.off:hover{background:transparent}
.tickets>footer{padding:18px 20px;display:grid;gap:16px}
.qty{display:flex;align-items:center;justify-content:space-between;gap:12px}
.stepper{display:inline-flex;align-items:center;border:1px solid var(--line-2);border-radius:999px}
.stepper button{border:0;border-radius:999px;width:40px;height:40px;padding:0;font-size:1.2rem}
.stepper input{width:44px;border:0;background:transparent;text-align:center;padding:0;font-weight:700;-moz-appearance:textfield;margin:0}
.stepper input::-webkit-inner-spin-button{-webkit-appearance:none}
.total{display:flex;justify-content:space-between;font-weight:700;font-size:1.1rem}
.buybar{display:none}
@media(max-width:899px){
  .buybar{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:30;padding:12px 20px calc(12px + env(safe-area-inset-bottom));background:rgba(0,0,0,.92);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-top:1px solid var(--line);align-items:center;justify-content:space-between;gap:12px}
  .has-buybar .pub-main{padding-bottom:120px}
}

/* checkout / order */
.steps{display:flex;gap:6px;margin:0 0 34px;padding:0;list-style:none;counter-reset:s;overflow-x:auto}
.steps li{counter-increment:s;flex:1;min-width:110px;padding-top:12px;border-top:2px solid var(--line);font-size:.84rem;color:var(--fog)}
.steps li::before{content:counter(s) ". "}
.steps li.done{border-color:var(--bone);color:var(--bone)}
.steps li.now{border-color:var(--sodium);color:var(--bone);font-weight:700}
.steps li.fail{border-color:var(--bad);color:var(--bad);font-weight:700}
.split{display:grid;gap:32px}
@media(min-width:900px){.split{grid-template-columns:minmax(0,7fr) minmax(0,4fr);gap:56px;align-items:start}.split>aside{position:sticky;top:96px}}
.summary{border:1px solid var(--line);border-radius:8px;padding:20px;background:var(--char)}
.summary .line{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid var(--line)}
.summary .line:last-child{border:0}
.summary .ev-head{display:grid;grid-template-columns:76px 1fr;gap:14px;margin-bottom:12px;align-items:center}
.pay{display:grid;gap:24px}
@media(min-width:640px){.pay{grid-template-columns:auto 1fr;align-items:center}}
.qr{background:#fff;padding:10px;border-radius:6px;width:176px}
.qr svg{display:block;width:100%;height:auto}
.amount{font-stretch:62%;font-weight:900;font-size:clamp(3.4rem,8vw,5rem);line-height:.9;font-variant-numeric:tabular-nums}
.paychoices{margin-top:44px}
.paygrid{display:grid;gap:16px}
@media(min-width:760px){.paygrid{grid-template-columns:1fr 1.3fr;align-items:start}}
.paygrid .card{margin:0}
.paygrid .amount{font-size:clamp(2.8rem,7vw,3.8rem);margin:6px 0 12px}
.seg label{position:relative;cursor:pointer;margin:0}
.seg label input{position:absolute;opacity:0;width:1px;height:1px}
.seg label span{display:block;text-align:center;padding:11px 8px;border-radius:999px;color:var(--fog);font-weight:600}
.seg label input:checked+span{background:var(--bone);color:#000}
.seg label input:focus-visible+span{outline:2px solid var(--sodium);outline-offset:2px}
.paytag{display:inline-block;padding:5px 12px;border-radius:999px;font-size:.8rem;font-weight:700;border:1.5px solid}
.paytag.paid{color:#1e6b2a;background:#1e6b2a14}
.paytag.due{color:#8a4b00;background:#ffb23833}
.countdown{font-variant-numeric:tabular-nums;font-weight:700}
.countdown.urgent{color:var(--bad)}

/* ticket stubs */
.stubs{display:grid;gap:28px;grid-template-columns:repeat(auto-fill,minmax(280px,1fr))}
.stub{background:var(--bone);color:#000;border-radius:10px;position:relative;overflow:hidden}
.stub .top{padding:22px 22px 18px}
.stub .ttl{font-stretch:62%;font-weight:900;text-transform:uppercase;font-size:2.4rem;line-height:.86;margin:0 0 10px}
.stub .meta{font-size:.86rem;font-weight:600;margin:0}
.stub .who{display:flex;justify-content:space-between;align-items:end;margin-top:16px;gap:8px;font-size:.86rem}
.stub .who strong{font-size:1.05rem;display:block}
.stub .bottom{position:relative;border-top:2px dashed #0003;padding:18px 22px 22px;display:grid;place-items:center;gap:8px}
.stub .bottom::before,.stub .bottom::after{content:"";position:absolute;top:-12px;width:22px;height:22px;border-radius:50%;background:var(--black)}
.stub .bottom::before{left:-11px}.stub .bottom::after{right:-11px}
.stub .bottom svg{width:200px;height:200px}
.stub .code{font-family:var(--mono);font-size:.75rem;color:#555}
.stub.void .bottom{opacity:.25}
.stub .stamp{position:absolute;top:62%;left:50%;transform:translate(-50%,-50%) rotate(-8deg);border:3px solid;border-radius:6px;padding:6px 14px;font-stretch:62%;font-weight:900;text-transform:uppercase;font-size:1.8rem;z-index:2;background:var(--bone)}
.stub .stamp.used{color:#1e6b2a}.stub .stamp.revoked{color:#b42318}

/* ---------- admin shell ---------- */
.admin{display:grid;grid-template-columns:minmax(0,1fr);min-height:100vh}
@media(min-width:960px){.admin{grid-template-columns:232px minmax(0,1fr)}}
.side{border-bottom:1px solid var(--line);background:#000;position:sticky;top:0;z-index:20}
.side-in{display:flex;align-items:center;gap:16px;padding:12px 20px;overflow-x:auto;scrollbar-width:none}
.side .mark{font-size:1.35rem}
.side nav{display:flex;gap:2px}
.side nav a{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 12px;border-radius:6px;text-decoration:none;color:var(--fog);font-weight:500;font-size:.92rem;white-space:nowrap}
.side nav a:hover{color:var(--bone);background:var(--char)}
.side nav a.on{color:var(--bone);background:var(--char-2)}
.side nav .sep{width:1px;background:var(--line);margin:4px 6px}
.badge{min-width:22px;padding:2px 7px;border-radius:999px;background:var(--sodium);color:var(--sodium-ink);font-size:.72rem;font-weight:800;text-align:center}
.side .me{display:flex;align-items:center;gap:10px;font-size:.84rem;color:var(--fog);margin-left:auto;white-space:nowrap}
@media(min-width:960px){
  .side{border-bottom:0;border-right:1px solid var(--line);height:100vh}
  .side-in{flex-direction:column;align-items:stretch;height:100%;padding:26px 14px;overflow:visible}
  .side .mark{padding:0 10px 20px}
  .side nav{flex-direction:column}
  .side nav .sep{height:1px;width:auto;margin:10px 12px}
  .side .me{margin:auto 0 0;padding:14px 10px 0;border-top:1px solid var(--line);flex-wrap:wrap}
}
.adm-main{padding:28px 20px 80px;min-width:0}
@media(min-width:960px){.adm-main{padding:40px 48px 80px}}
.adm-main>*{max-width:1200px}
.devclock{color:var(--sodium);font-family:var(--mono);font-size:.75rem}

/* admin building blocks */
.head{display:flex;gap:16px;align-items:flex-end;justify-content:space-between;flex-wrap:wrap;margin-bottom:28px}
.head .sub{margin:8px 0 0}
.adm-main h1{font-stretch:62%;font-weight:850;text-transform:uppercase;line-height:.9;font-size:clamp(2.2rem,4vw,3.2rem);margin:0}
.crumb{font-size:.875rem;margin-bottom:12px}.crumb a{color:var(--fog);text-decoration:none}.crumb a:hover{color:var(--bone)}
.card{background:var(--char);border:1px solid var(--line);border-radius:8px;padding:22px;margin-bottom:20px}
.card.flush{padding:0;overflow:hidden}
.card.flush>h2{padding:20px 22px 0}
.card.flush>.empty{margin:0 22px 22px}
.grid{display:grid;gap:20px;grid-template-columns:repeat(auto-fill,minmax(270px,1fr))}
.cols{display:grid;gap:20px;grid-template-columns:minmax(0,1fr)}
@media(min-width:960px){.cols{grid-template-columns:minmax(0,3fr) minmax(0,2fr)}.cols.even{grid-template-columns:1fr 1fr}}
.stack>*+*{margin-top:14px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.spread{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));border:1px solid var(--line);border-radius:8px;margin-bottom:32px;overflow:hidden}
.stat{padding:18px 20px;text-decoration:none;color:inherit;border-right:1px solid var(--line);display:block}
.stat:last-child{border-right:0}
.stat b{display:block;font-stretch:62%;font-weight:850;font-size:2.6rem;line-height:1;margin-bottom:6px;font-variant-numeric:tabular-nums}
.stat span{color:var(--fog);font-size:.84rem}
a.stat:hover{background:var(--char)}
.stat.alert b{color:var(--sodium)}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px}
.chips a{padding:7px 13px;border-radius:999px;border:1px solid var(--line);text-decoration:none;color:var(--fog);font-size:.84rem}
.chips a:hover{color:var(--bone);border-color:var(--line-2)}
.chips a.on{background:var(--bone);border-color:var(--bone);color:#000;font-weight:600}
table{border-collapse:collapse;width:100%;font-size:.92rem}
th{text-align:left;font-weight:600;font-size:.78rem;color:var(--fog);padding:12px 14px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:12px 14px;border-bottom:1px solid var(--line);vertical-align:middle}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover td{background:#ffffff06}
tr[data-href]{cursor:pointer}
.scroll{overflow-x:auto}
table.kv th{width:40%;font-size:.84rem;color:var(--fog);font-weight:500;white-space:normal}
.bar{height:4px;background:var(--line);border-radius:99px;overflow:hidden;margin-top:8px;max-width:200px}
.bar i{display:block;height:100%;background:var(--bone)}
.bar.hot i{background:var(--sodium)}
.big{font-stretch:62%;font-weight:900;font-size:2.4rem;line-height:1}
.data{max-width:340px;word-break:break-all;color:var(--fog);font-size:.75rem;font-family:var(--mono)}
details>summary{cursor:pointer;list-style:none}
details>summary::-webkit-details-marker{display:none}
.thumb{width:56px;flex:none}
.queue{display:grid;gap:16px}
.verify{display:grid;gap:22px;grid-template-columns:1fr;margin:0}
@media(min-width:900px){.verify{grid-template-columns:200px minmax(0,1fr) 260px;align-items:start}}
.verify .proof{background:#000;border:1px solid var(--line);border-radius:6px;min-height:140px;display:grid;place-items:center;overflow:hidden}
.verify .proof img{width:100%;max-height:260px;object-fit:contain}
.verify .decide{display:grid;gap:14px}
a.card{display:block;text-decoration:none;color:inherit;transition:border-color .15s}
a.card:hover{border-color:var(--line-2)}
.ev-row{display:flex;gap:14px;align-items:center;min-width:240px}
details{position:relative}
.card.pop{position:absolute;right:0;top:calc(100% + 8px);z-index:15;width:min(580px,88vw);margin:0;box-shadow:0 24px 60px #000;text-align:left;white-space:normal}
.door{max-width:560px;margin:0 auto}
.scan-result{border-radius:14px;padding:34px 20px;text-align:center;margin-bottom:14px;border:2px solid var(--line);background:var(--char);display:grid;gap:6px;justify-items:center}
.scan-result small{font:700 .82rem var(--mono);text-transform:uppercase;letter-spacing:.12em}
.scan-result b{display:block;font-stretch:62%;font-weight:900;text-transform:uppercase;font-size:clamp(3.4rem,17vw,5.2rem);line-height:.88}
.scan-result strong{font-size:1.5rem;line-height:1.15;color:var(--bone);overflow-wrap:anywhere}
.scan-result span{color:var(--bone);max-width:34ch;opacity:.85}
.scan-result.idle{padding:20px;border-style:dashed}.scan-result.idle b{font-size:2.2rem;color:var(--fog)}.scan-result.idle span{color:var(--fog)}
.scan-result.ok{background:#0d2412;border-color:var(--ok);color:var(--ok)}
.scan-result.due{background:#2b1c00;border-color:var(--sodium);color:var(--sodium)}
.scan-result.bad{background:#2a0d0a;border-color:var(--bad);color:var(--bad)}
.scan-actions{display:grid;gap:10px}
.scan-actions button,#scan-next{min-height:64px;font-size:1.2rem}
.reader{border-radius:14px;overflow:hidden;margin-bottom:12px;background:var(--char)}
.reader:empty{display:none}
.reader video{display:block;width:100%!important}
.door-tools{display:grid;gap:14px;margin-top:22px}
.door-tools .row{flex-wrap:nowrap}.door-tools .row input{flex:1;min-width:0;width:auto;font-size:1rem;padding:13px 14px}
.typed summary{cursor:pointer;color:var(--fog);font-size:.9rem;padding:6px 0}
.typed[open] summary{margin-bottom:10px}
.guests{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:10px;overflow:hidden}
.guest{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid var(--line);background:var(--char)}
.guest:last-child{border-bottom:0}
.guest>div{display:grid;gap:2px;min-width:0}
.guest strong{font-size:1.05rem;overflow-wrap:anywhere}

/* ---------- door: mode switch + walk-ins ---------- */
.seg{display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:4px;border:1px solid var(--line-2);border-radius:999px;margin:0 0 18px}
.seg a{text-align:center;padding:11px 8px;border-radius:999px;text-decoration:none;color:var(--fog);font-weight:600}
.seg a:hover{color:var(--bone)}
.seg a.on{background:var(--bone);color:#000}
.walkin{display:grid;gap:18px}
.walkin-price{display:block;font-stretch:62%;font-weight:850;font-size:3.4rem;line-height:1;margin-top:4px}
.walkin-qty .stepper button{width:52px;height:52px;font-size:1.4rem}
.walkin-qty .stepper input{font-size:1.3rem;width:52px}
.walkin-collect{margin:0;font-size:1.05rem}
.walkin-collect b{color:var(--sodium);font-size:1.25rem}
.walkin>button{width:100%}
details.void summary{cursor:pointer;color:var(--fog);font-size:.84rem;list-style:none}
details.void summary:hover{color:var(--bone)}
details.void[open] summary{margin-bottom:8px}
details.void form{display:grid;gap:8px;width:min(240px,52vw)}
details.void input{min-width:0;width:100%}


/* Email sign-in: one native input, six visual slots, no focus hopping. */
.sign-in{width:100%;max-width:480px;margin:clamp(30px,7vh,80px) auto 60px}
.sign-in-kicker{font:600 .75rem var(--mono);text-transform:uppercase;letter-spacing:.14em;color:var(--sodium);margin:0 0 26px}
.sign-in h1{font-size:clamp(2.6rem,8vw,4.2rem);font-stretch:75%;line-height:1;letter-spacing:-.04em;margin:0 0 18px}
.sign-in-intro{color:var(--fog);max-width:40ch;overflow-wrap:anywhere;margin:0 0 30px}
.sign-in-form{gap:12px}.sign-in-form>input{margin:0;min-height:56px;font-size:1rem}
.sign-in .sign-in-submit{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:56px;margin-top:12px;padding:15px 20px;border-radius:6px;font:700 1rem var(--display);cursor:pointer}
.sign-in-submit span{font-size:1.4rem;transition:transform .15s}.sign-in-submit:hover span{transform:translate(2px,-2px)}
.sign-in-submit:disabled{cursor:wait;opacity:.75}.sign-in-secondary{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:22px;font-size:.875rem}
.sign-in-secondary form{margin:0}.sign-in-secondary button{padding-left:0}.sign-in-back{display:inline-block;margin-top:38px;color:var(--fog);font-size:.875rem}
.otp{position:relative;height:66px;isolation:isolate}.otp input{position:absolute;inset:0;width:100%;height:100%;margin:0;z-index:2;font:500 1.8rem var(--mono);letter-spacing:.45em}
.otp-slots{display:none;height:100%;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;pointer-events:none}
.otp-enhanced .otp-slots{display:grid}.otp-enhanced input{background:transparent;border:0;color:transparent;caret-color:transparent;box-shadow:none;padding:0;letter-spacing:normal}
.otp-slots span{display:grid;place-items:center;border:1px solid var(--line-2);border-radius:6px;background:var(--char);color:var(--bone);font:500 1.8rem var(--mono);transition:border-color .15s,background .15s}
.otp-slots span.empty{color:#555;text-shadow:0 1px 8px #000}.otp-slots span.active{border-color:var(--sodium);background:var(--char-2)}
.otp-enhanced input::placeholder{color:transparent}.otp-enhanced:focus-within{outline:2px solid var(--sodium);outline-offset:5px;border-radius:6px}.otp-enhanced input:focus-visible{outline:none}
@media(max-width:380px){.otp-slots{gap:5px}.sign-in-secondary{align-items:flex-start;flex-direction:column}.otp{height:58px}}

@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
`;

/**
 * URL for a file in public/ with ?v=<last modified>, so phones fetch a fresh copy whenever the
 * file changes instead of running a stale cached script (the door phones would otherwise keep
 * yesterday's JavaScript after an update).
 */
export function asset(file: string) {
  try {
    return `/${file}?v=${Math.round(statSync(`public/${file}`).mtimeMs).toString(36)}`;
  } catch {
    return `/${file}`;
  }
}

// ---------- status vocabulary ----------
const TONE: Record<string, "ok" | "bad" | "warn" | "info" | ""> = {
  APPROVED: "ok", VALID: "ok", ON_SALE: "ok", ADMITTED: "ok", CHECKED_IN: "ok", published: "ok", open: "ok",
  REJECTED: "bad", EXPIRED: "bad", VOIDED: "bad", REVOKED: "bad", SOLD_OUT: "bad", INVALID: "bad", WRONG_EVENT: "bad", ALREADY_USED: "bad",
  SALES_CLOSED: "bad", CLOSED: "bad",
  AWAITING_PAYMENT: "warn", PAYMENT_DUE: "warn", CONFIRMED: "ok", CANCELLED: "bad",
  PENDING_VERIFICATION: "info",
};
const LABEL: Record<string, string> = {
  APPROVED: "Payment verified", CONFIRMED: "Confirmed", CANCELLED: "Cancelled", PAYMENT_DUE: "Not paid", VALID: "Valid", ON_SALE: "On sale", ADMITTED: "Admitted", CHECKED_IN: "Checked in", published: "Published",
  REJECTED: "Rejected", EXPIRED: "Expired", VOIDED: "Voided", REVOKED: "Revoked", SOLD_OUT: "Sold out", INVALID: "Invalid", WRONG_EVENT: "Wrong event",
  ALREADY_USED: "Already used", SALES_CLOSED: "Sales closed", CLOSED: "Closed", AWAITING_PAYMENT: "Awaiting payment",
  UPCOMING: "Upcoming", draft: "Draft", PENDING_VERIFICATION: "Screenshot to check",
};
export const statusLabel = (s: string) => LABEL[s] ?? s;

/** Status as a coloured dot + plain words. The raw value is in the tooltip for tracing. */
export const Status: FC<{ s: string }> = ({ s }) => (
  <span class={`status ${TONE[s] ?? ""}`} title={s}>
    {statusLabel(s)}
  </span>
);

export const Money: FC<{ cents: number }> = ({ cents }) => <>{money(cents)}</>;

export const Flash: FC<{ ok?: string | null; err?: string | null }> = ({ ok, err }) => (
  <>
    {ok && (
      <p class="flash ok" role="status">
        {ok}
      </p>
    )}
    {err && (
      <p class="flash err" role="alert">
        {err}
      </p>
    )}
  </>
);

export const FieldErr: FC<{ e?: Record<string, string>; k: string }> = ({ e, k }) =>
  e?.[k] ? <span class="err">{e[k]}</span> : null;

/** Live countdown (public/app.js). `ms` is computed server-side so it respects the dev clock. */
export const Countdown: FC<{ ms: number }> = ({ ms }) => (
  <span class="countdown" data-countdown={String(Math.max(0, ms))}>
    {fmtDuration(ms)}
  </span>
);

export const Empty: FC<PropsWithChildren<{ title?: string }>> = ({ title, children }) => (
  <div class="empty">
    {title && <strong>{title}</strong>}
    {children}
  </div>
);

// ---------- flyer ----------
const hash = (s: string) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
const dayNum = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "numeric" });
const flyerDate = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });

/**
 * The event's artwork. Uploaded poster if there is one; otherwise a typographic flyer generated
 * from the event itself, in one of four layouts chosen by the slug (stable per event).
 * `vt` sets a view-transition name so the poster morphs between the list and the event page.
 */
export const Flyer: FC<{ event: Event; vt?: boolean; acts?: string[] }> = ({ event, vt, acts = [] }) => {
  const style = vt ? `view-transition-name:p-${event.slug.replace(/[^a-z0-9-]/g, "")}` : undefined;
  if (event.posterKey) return <img class="flyer-img" src={`/media/${event.posterKey}`} alt={`${event.title} poster`} style={style} />;
  const v = hash(event.slug) % 4;
  // Fit the title: the longest word must fit the 86cqi line at ~0.42em per condensed glyph, capped for short titles.
  const longest = Math.max(...event.title.split(/s+/).map((w) => w.length), 1);
  const titleSize = Math.min(v === 3 ? 28 : 24, 84 / (longest * 0.42));
  return (
    <div class={`flyer v${v}`} style={style} role="img" aria-label={`${event.title} flyer`}>
      <span class="f-big" aria-hidden="true">
        {dayNum.format(event.startsAt)}
      </span>
      <div class="f-in">
        <div class="f-pre">{event.organizer} presents</div>
        <p class="f-title" style={`font-size:${titleSize.toFixed(1)}cqi`}>
          {event.title}
        </p>
        <div>
          {acts.length > 0 && <div class="f-acts">{acts.slice(0, 5).join(" / ")}</div>}
          <div class="f-date">
            {flyerDate.format(event.startsAt)}
            <br />
            {event.venueName}
          </div>
        </div>
      </div>
    </div>
  );
};

// ---------- timeline ----------
/** Journal rows as a table. `customerView` hides staff identities and internal data. */
export const Timeline: FC<{ rows: TimelineRow[]; customerView?: boolean }> = ({ rows, customerView }) => (
  <div class="scroll">
    <table>
      <thead>
        <tr>
          <th>When</th>
          <th>What happened</th>
          <th>Change</th>
          <th>By</th>
          {!customerView && <th>Details</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr>
            <td class="small num" style="white-space:nowrap">
              {fmtStamp(r.at).slice(5, 19)}
            </td>
            <td>
              <span class="mono small">{r.action}</span>
              {r.entityType === "ticket" && <span class="muted small"> ticket {r.entityId?.slice(0, 6)}</span>}
            </td>
            <td style="white-space:nowrap">
              {r.fromStatus && <Status s={r.fromStatus} />}
              {r.fromStatus && r.toStatus && <span class="muted"> to </span>}
              {r.toStatus && <Status s={r.toStatus} />}
            </td>
            <td class="small">
              {customerView ? (r.actor === "customer" ? "You" : r.actor === "system" ? "System" : config.brand.name) : r.actorName}
            </td>
            {!customerView && <td class="data">{r.data ?? ""}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export const ClockNote: FC = () => {
  const off = clockOffset();
  return off ? <span class="devclock">clock +{fmtDuration(off)}</span> : null;
};

const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#000"/><path d="M8 25V7h4l8 11V7h4v18h-4l-8-11v11z" fill="#ffb238"/></svg>',
  );

const Head: FC<{ title: string; head?: Child }> = ({ title, head }) => (
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#000000" />
    <title>{`${title} | ${config.brand.name}`}</title>
    <link rel="icon" href={FAVICON} />
    <link rel="preload" href="/fonts/archivo-latin-wdth-normal.woff2" as="font" type="font/woff2" crossorigin="anonymous" />
    {/* raw: JSX would HTML-escape quotes and ">" selectors inside <style>. css is a constant, never user input. */}
    <style>{raw(css)}</style>
    <script src={asset("app.js")} defer></script>
    {head}
  </head>
);

const Wordmark: FC<{ href: string }> = ({ href }) => (
  <a class="mark" href={href} aria-label={`${config.brand.name} home`}>
    Night<span>/</span>Shift
  </a>
);

type PageProps = PropsWithChildren<{ title: string; user?: User | null; path?: string; head?: Child; bodyClass?: string }>;

/** Public pages get the poster-led shell; pass `user` for the staff shell (sidebar, denser). */
export const Page: FC<PageProps> = ({ title, user, path = "", head, bodyClass, children }) =>
  user ? (
    <AdminShell title={title} user={user} path={path} head={head}>
      {children}
    </AdminShell>
  ) : (
    <html lang="en">
      <Head title={title} head={head} />
      <body class={bodyClass}>
        <a href="#main" class="btn sm skip">
          Skip to content
        </a>
        <header class="pub-top">
          <div class="wrap">
            <Wordmark href="/" />
            <nav class="pub-nav" aria-label="Main">
              <a href="/" class={path === "/" ? "on" : ""}>
                Events
              </a>
              <a href="/account" class={path === "/account" ? "on" : ""}>
                My tickets
              </a>
              <a href="/admin/login">MGMT</a>
            </nav>
          </div>
        </header>
        <main id="main" class="pub-main">
          <div class="wrap">{children}</div>
        </main>
        <footer class="pub-foot">
          <div class="wrap">
            <div>
              <Wordmark href="/" />
              <p style="margin-top:14px">Club nights, concerts and private parties in Beirut. Get your QR ticket in seconds. Pay by Whish, Neo or at the door.</p>
            </div>
            <div>
              <h3>Going out</h3>
              <ul>
                <li>
                  <a href="/">Upcoming events</a>
                </li>
                <li>
                  <a href="/account">Find my tickets</a>
                </li>
                <li>
                  <a href={`mailto:${config.brand.supportEmail}`}>Help with a ticket</a>
                </li>
              </ul>
            </div>
            <div>
              <h3>Organisers</h3>
              <ul>
                <li>
                  <a href="/admin/login">Staff login</a>
                </li>
                <li>
                  <a href="/admin/door">Door scanner</a>
                </li>
              </ul>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );

const AdminShell: FC<PropsWithChildren<{ title: string; user: User; path: string; head?: Child }>> = async ({ title, user, path, head, children }) => {
  const isAdmin = user.role === "ADMIN";
  const pending = isAdmin ? (await countByStatus(["PENDING_VERIFICATION"])) : 0;
  const link = (href: string, label: Child, exact = false) => {
    const on = exact ? path === href : path === href || path.startsWith(`${href}/`);
    return (
      <a href={href} class={on ? "on" : ""} aria-current={on ? "page" : undefined}>
        {label}
      </a>
    );
  };
  return (
    <html lang="en">
      <Head title={title} head={head} />
      <body>
        <div class="admin">
          <aside class="side">
            <div class="side-in">
              <Wordmark href={isAdmin ? "/admin" : "/admin/door"} />
              <nav aria-label="Staff">
                {isAdmin && (
                  <>
                    {link("/admin", "Events", true)}
                    {link(
                      "/admin/payments",
                      <>
                        Payments {pending > 0 && <span class="badge">{pending}</span>}
                      </>,
                    )}
                    {link("/admin/orders", "Orders")}
                    {link("/admin/comps", "Guest list")}
                  </>
                )}
                {link("/admin/door", "Door")}
                {isAdmin && (
                  <>
                    <span class="sep" aria-hidden="true"></span>
                    {link("/admin/analytics", "Analytics")}
                    {link("/admin/email", "Email")}
                    {link("/admin/staff", "Staff access")}
                    {link("/admin/trace", "Trace")}
                  </>
                )}
              </nav>
              <div class="me">
                <ClockNote />
                <span>{user.name}</span>
                <form method="post" action="/admin/logout">
                  <button class="sm ghost">Log out</button>
                </form>
              </div>
            </div>
          </aside>
          <main id="main" class="adm-main">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
};
