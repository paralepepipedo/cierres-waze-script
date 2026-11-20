// ==UserScript==
// @name         Cierres Waze · SGD
// @namespace    http://tampermonkey.net/
// @version      1.5.0
// @updateURL    https://raw.githubusercontent.com/paralepepipedo/cierres-waze-script/main/cierres-waze-sgd.user.js
// @downloadURL  https://raw.githubusercontent.com/paralepepipedo/cierres-waze-script/main/cierres-waze-sgd.user.js
// @description  v1.5: en «Por cerrar» cada fila muestra también las iniciales del analista. Actualización automática desde GitHub. v1.4: en la web, «Cambiar lector» (reintentar con IA o pasar al lector normal) y «Saltar» (deja el expediente para después). v1.3: baja los expedientes nuevos de tus emisores y los pasa a la web de uno en uno. Botón flotante en el SGD: lista los cierres ya cargados en Waze a los que falta cerrar el expediente, rellena los pasos y, cuando despachas, avisa a la web de Cierres Waze (paso 4). Avisa también de los rechazados que el emisor ya devolvió a tu bandeja.
// @author       Cierres Waze
// @match        https://sgd.mtt.cl/exedoc/*
// @match        https://cierres-waze.vercel.app/*
// @match        http://localhost:3100/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_openInTab
// @connect      cierres-waze.vercel.app
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

/*
 * Qué hace (y qué NO hace):
 *  - Pide a la web de Cierres Waze la lista de cierres Cargados en Waze con el SGD pendiente (solo lectura).
 *  - Al pulsar ▶ en un cierre: filtra el expediente en la bandeja, abre «Ver expediente», escribe «cierre cargado en Waze» y pulsa
 *    su «Agregar», abre «Destinatarios frecuentes», elige al emisor y pulsa el «Agregar» junto a la lista. Aquí se DETIENE.
 *  - El clic en «Despachar» y en «Sí» es SIEMPRE del usuario. Cuando lo detecta, avisa a la web y el paso 4 queda completo.
 *  - Si algo no está como espera, se detiene y dice qué faltó. Nunca adivina.
 *  - v1.1: al pulsar un expediente de la lista aparecen a su derecha ▶ (ejecutar) y ✔ («ya lo despaché», aviso manual a la web con confirmación),
 *    sin tener que ir al final del panel. Cuando hay error, el expediente sigue en la lista para poder usar el ✔.
 *  - v1.2: pestaña «Devueltos». La web entrega los cierres que rechazaste; cuando la bandeja del SGD está cargada, la extensión mira su
 *    primera hoja y los rechazados cuyo número aparece ahí (el emisor ya los devolvió) se cuentan en una pastilla naranja bajo el logo y
 *    se listan con un enlace a su ficha en la web para reasignarlos. No se guarda ningún conteo: sin bandeja cargada no hay pastilla.
 *  - v1.3: botón ⬇ del panel. Busca en la primera hoja de la bandeja (y en la siguiente si la hoja viene completa de nuevos) los expedientes NO LEÍDOS
 *    cuyo emisor esté en tu lista editable (⚙), omite los devueltos (rechazados de la web), abre cada uno, toma el PDF de la ÚLTIMA fila de
 *    «Documentos en trámite» (la misma petición del icono «Ver archivo») y lo guarda como copia dentro de Tampermonkey (nada se baja a tu disco).
 *    Pestaña «Descargados»: ▶ abre la web con el PDF, el lector (normal o IA) lo eliges tú, y «Guardar y continuar al siguiente» sigue con el resto.
 *    Al guardar el expediente en la web la copia se borra. Cada paso espera hasta 60 s y se reintenta una vez; un fallo no detiene a los demás.
 *  - v1.4: en la barra «Desde el SGD» de la web, «Cambiar lector» vuelve a abrir el modal (normal / IA) con el mismo PDF y el formulario limpio
 *    (para reintentar si Gemini falló, o pasar al lector normal) y «Saltar» deja ese expediente en la lista y carga el siguiente. Los saltados se
 *    ofrecen al final de la tanda.
 *  - v1.5: en «Por cerrar» la fila muestra, junto a la sigla del emisor, las iniciales del analista (p. ej. «PVC GGB»); la web las entrega en la
 *    lista de pendientes. Esta versión se actualiza sola desde GitHub (@updateURL): Tampermonkey la revisa cuando sube el número de @version.
 *  - La clave de la extensión (CW_CLAVE) es la misma de las demás extensiones del proyecto: no compartir este archivo fuera del equipo.
 */
(function () {
'use strict';

// ─── Web de Cierres Waze: la publicada (principal) y la local del PC (opcional, falla en silencio) ───────────────────────────
const CW_DESTINOS = [
    { id: 'vercel', nombre: 'Vercel', url: 'https://cierres-waze.vercel.app', principal: true,  espera: 8000 },
    { id: 'local',  nombre: 'local',  url: 'http://localhost:3100',           principal: false, espera: 2500 }
];
const CW_CLAVE = '1c10c6f972296738e4082b8e41ecd529d2b3fad4dedf49ab';
const TEXTO_COMENTARIO = 'cierre cargado en Waze';
const VERSION = (typeof GM_info !== 'undefined' && GM_info && GM_info.script && GM_info.script.version) || '1.3';

const K_PLAN = 'sgd_plan', K_PEND = 'sgd_pendientes', K_CACHE = 'sgd_cache', K_LOG = 'sgd_log', K_SENAL = 'sgd_senal_web';
const gget = (k, d) => { try { const v = GM_getValue(k, d); return v === undefined ? d : v; } catch (e) { return d; } };
const gset = (k, v) => { try { GM_setValue(k, v); } catch (e) { /* sin almacenamiento */ } };
const gdel = k => { try { GM_deleteValue(k); } catch (e) { /* nada */ } };

// ─── Descargas: lo que se guarda (lo comparten el SGD y la web, porque es el mismo script y el mismo almacenamiento) ───────────
// K_EMI: emisores a buscar (lista editable) · K_COLA: expedientes descargados (listos / fallidos) · K_PDF+clave: la copia de cada PDF (base64)
// K_CORRIDA: la descarga en curso (sobrevive a los cambios de página del SGD) · K_ABRIR: «abre este expediente en la web»
const K_EMI = 'dl_emisores', K_COLA = 'dl_cola', K_CORRIDA = 'dl_corrida', K_ABRIR = 'dl_abrir', K_PDF = 'dl_pdf_';
const claveExp = e => String(e).toUpperCase().replace(/[^A-Z0-9]/g, '_');                       // E200035/2026 → E200035_2026
const leerCola = () => { const v = gget(K_COLA, []); return Array.isArray(v) ? v.filter(x => x && x.exp) : []; };
const guardarCola = l => gset(K_COLA, l);
const pdfLeer = exp => gget(K_PDF + claveExp(exp), '');
const pdfBorrar = exp => gdel(K_PDF + claveExp(exp));
const quitarDeCola = exp => { guardarCola(leerCola().filter(x => x.exp !== exp)); pdfBorrar(exp); };
const listosDe = l => l.filter(x => x.estado === 'listo');
const aBase64 = buf => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) { s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); } return btoa(s); };
const deBase64 = b64 => { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) { u[i] = s.charCodeAt(i); } return u; };

// ─── En la web: pasar cada PDF al lector, cambiar «Guardar en revisión» por «Guardar y continuar al siguiente» y seguir con el resto ──
function iniciarWeb() {
    const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const MAX_IA_KB = 2048, ETQ_CONT = 'Guardar y continuar al siguiente', ETQ_ORIG = 'Guardar en revisión';
    // pendiente: expediente que debe cargarse en cuanto aparezca el formulario (puede haber PIN antes) · actual: el que está cargado en el formulario ahora
    const W = { pendiente: null, desde: 0, navegado: 0, actual: null, tanda: null, pausa: false, modal: null, abierto: false, toast: '', click: null, tm: 0, saltados: new Set() };
    const CSSW = `
:host { all: initial; }
* { box-sizing: border-box; font-family: "Segoe UI", Arial, sans-serif; }
#pil { position: fixed; left: 16px; bottom: 16px; z-index: 2147482000; display: none; align-items: center; gap: 6px; background: #0f9d8a; color: #fff; border: 2px solid #fff; border-radius: 20px; padding: 6px 12px; font-size: 12.5px; font-weight: 700; cursor: pointer; box-shadow: 0 3px 12px rgba(0,0,0,.3); }
#pil.falla { background: #c9f2da; color: #b00000; border-color: #d64545; }
#pil b { font-size: 14px; }
#pop { position: fixed; left: 16px; bottom: 62px; width: 340px; max-height: 60vh; z-index: 2147482001; display: none; flex-direction: column; background: #fff; border: 1px solid #b9c1ce; border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,.35); overflow: hidden; color: #1b2538; font-size: 13px; }
#pop.open { display: flex; }
.ph { background: #1b2538; color: #fff; padding: 9px 12px; display: flex; align-items: center; gap: 8px; } .ph span { flex: 1; } .ph button { background: none; border: 0; color: #fff; font-size: 16px; cursor: pointer; }
.pl { overflow: auto; padding: 8px 10px; } .pf { padding: 7px 12px; border-top: 1px solid #d9dee6; background: #fafbfc; font-size: 11.5px; color: #566; }
.rw { position: relative; border: 1px solid #d9dee6; border-radius: 8px; padding: 7px 50px 7px 10px; margin-bottom: 6px; } .rw small { display: block; color: #566; } .rw.fail { border-color: #f0b3b3; background: #fdeaea; border-left: 4px solid #d64545; }
.rw .go { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); width: 32px; height: 32px; border-radius: 50%; border: 0; background: #0f9d8a; color: #fff; cursor: pointer; font-size: 14px; }
.pill { font-size: 10.5px; padding: 1px 7px; border-radius: 9px; background: #e8eef6; margin-left: 4px; }
#barra { position: fixed; top: 8px; left: 50%; transform: translateX(-50%); z-index: 2147482002; }
.bts { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; } .btn:disabled { opacity: .45; cursor: not-allowed; }
.ext { display: flex; align-items: center; gap: 10px; background: linear-gradient(90deg, #e8faf6, #f1fbff); border: 1px solid #9fded3; border-radius: 10px; padding: 7px 12px; box-shadow: 0 4px 14px rgba(0,0,0,.2); min-width: 340px; color: #1b2538; font-size: 12.5px; }
.ext .pg { flex: 1; } .ext b { color: #0a6b5c; } .bar { height: 7px; background: #dbe5ea; border-radius: 4px; overflow: hidden; margin-top: 4px; } .bar i { display: block; height: 100%; background: #0f9d8a; }
.btn { border: 0; border-radius: 6px; padding: 7px 13px; font: inherit; font-weight: 600; cursor: pointer; background: #e3e8ef; color: #1b2538; } .btn.sm { padding: 4px 10px; font-size: 12px; }
.mbg { position: fixed; inset: 0; background: rgba(20,30,50,.5); display: flex; align-items: center; justify-content: center; z-index: 2147482003; padding: 14px; }
.modal { width: 400px; max-width: 100%; background: #fff; border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.4); overflow: hidden; color: #1b2538; font-size: 14px; }
.mh { padding: 12px 14px; font-weight: 700; border-bottom: 1px solid #d9dee6; } .mb { padding: 12px 14px; } .mb small { display: block; color: #566; margin-bottom: 8px; } .mf { padding: 10px 14px; background: #fafbfc; border-top: 1px solid #d9dee6; display: flex; justify-content: flex-end; }
.big { display: block; width: 100%; text-align: left; padding: 11px 12px; border-radius: 9px; border: 2px solid #d9dee6; margin-bottom: 8px; background: #fff; font-size: 13px; cursor: pointer; color: #1b2538; } .big b { display: block; font-size: 14px; }
.big.n { border-color: #a9d2f7; background: #f2f8ff; } .big.i { border-color: #cdbdf2; background: #f6f1ff; } .big:disabled { opacity: .5; cursor: not-allowed; } .big em { display: block; color: #8e1f1f; font-style: normal; margin-top: 3px; }
.av { border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; font-size: 12.5px; line-height: 1.4; } .av.warn { background: #fff1de; border: 1px solid #f3c68f; color: #8a4b00; }
#tst { position: fixed; left: 50%; bottom: 70px; transform: translateX(-50%); background: #1d6b3b; color: #fff; padding: 8px 16px; border-radius: 18px; font-size: 13px; z-index: 2147482004; display: none; max-width: 90vw; text-align: center; } #tst.on { display: block; }
`;
    const host = document.createElement('div'); host.id = 'cw-sgd-web';
    const sh = host.attachShadow({ mode: 'open' });
    sh.innerHTML = '<style>' + CSSW + '</style><div id="barra"></div><div id="pop"></div><button id="pil" type="button"></button><div id="mod"></div><div id="tst"></div>';
    document.documentElement.appendChild(host);
    const el = id => sh.getElementById(id);
    const formularioListo = () => !!document.getElementById('f-pdf') && !!document.getElementById('f-pdf-ia');
    const aviso = t => { W.toast = t; pintar(); setTimeout(() => { if (W.toast === t) { W.toast = ''; pintar(); } }, 5000); };

    function marcarFalta(it, motivo) {
        const l = leerCola().map(x => x.exp === it.exp ? Object.assign({}, x, { estado: 'fallo', motivo }) : x); guardarCola(l); pdfBorrar(it.exp);
    }
    function iniciarCarga(exp) {
        const it = leerCola().find(x => x.exp === exp && x.estado === 'listo');
        if (!it) { aviso('Esa copia ya no está en la lista.'); return; }
        W.pendiente = exp; W.desde = Date.now(); W.navegado = 0; W.abierto = false;
        if (!/^#\/nuevo/.test(location.hash)) { location.hash = '#/nuevo'; }
        pintar();
    }
    // Vuelve a «Nuevo ingreso» con el formulario limpio (la web lo reinicia cada vez que se entra) y pide elegir el lector para ese expediente.
    // Sirve para «Cambiar lector» y «Saltar»: así no se mezclan datos de un expediente con los de otro.
    function reabrir(exp) {
        W.pendiente = exp; W.desde = Date.now(); W.navegado = 0; W.modal = null; W.actual = null; W.abierto = false;
        if (location.hash !== '#/panel') { location.hash = '#/panel'; }
        setTimeout(() => { location.hash = '#/nuevo'; }, 300);
        pintar();
    }
    function cambiarLector() { if (W.actual) { reabrir(W.actual.exp); } }
    // el siguiente de la tanda: primero los que no se han saltado; si solo quedan saltados, se ofrecen de nuevo
    const siguienteDe = lista => lista.find(x => !W.saltados.has(x.exp)) || lista[0] || null;
    function saltar() {
        const cur = W.actual; if (!cur) { return; }
        const otros = listosDe(leerCola()).filter(x => x.exp !== cur.exp);
        if (!otros.length) { aviso('No hay otro expediente para saltar.'); return; }
        W.saltados.add(cur.exp);
        let sig = otros.find(x => !W.saltados.has(x.exp));
        if (!sig) { sig = otros[0]; W.saltados = new Set([cur.exp]); }
        aviso('↷ ' + cur.exp + ' queda en la lista del SGD para después');
        reabrir(sig.exp);
    }
    // Pone el PDF en el campo del lector elegido, igual que si lo hubieras elegido tú con «Elegir archivo»
    function cargar(it, ia) {
        const b64 = pdfLeer(it.exp);
        if (!b64) { W.modal = null; W.pendiente = null; marcarFalta(it, 'Falta la copia del PDF'); aviso('La copia de ' + it.exp + ' no está guardada: vuelve a descargarla desde el SGD (↻).'); return; }
        const inp = document.getElementById(ia ? 'f-pdf-ia' : 'f-pdf');
        if (!inp) { aviso('No encontré el campo para cargar el PDF. Abre «Nuevo ingreso» e inténtalo otra vez.'); return; }
        let u8; try { u8 = deBase64(b64); } catch (e) { W.modal = null; W.pendiente = null; marcarFalta(it, 'La copia del PDF está dañada'); aviso('La copia de ' + it.exp + ' está dañada: vuelve a descargarla desde el SGD (↻).'); return; }
        const f = new File([u8], it.archivo || (it.exp.replace(/\//g, '-') + '.pdf'), { type: 'application/pdf' });
        const dt = new DataTransfer(); dt.items.add(f); inp.files = dt.files;
        W.modal = null; W.pendiente = null; W.actual = it; W.pausa = false;
        if (!W.tanda) { W.tanda = { total: listosDe(leerCola()).length, hechos: 0 }; }
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        pintar(); actualizarBoton();
    }
    // «Guardar en revisión» ⇄ «Guardar y continuar al siguiente»: solo cuando hay un expediente del SGD cargado y quedan más después de él
    function actualizarBoton() {
        const b = document.querySelector('button[data-act="guardar"][data-next="ver"]'); if (!b) { return; }
        const t = b.textContent.trim(); if (t !== ETQ_ORIG && t !== ETQ_CONT) { return; }        // «Guardar cambios» (editar) no se toca
        const quedan = W.actual ? listosDe(leerCola()).filter(x => x.exp !== W.actual.exp).length : 0;
        const meta = W.actual && !W.pausa && quedan > 0 ? ETQ_CONT : ETQ_ORIG;
        if (t === meta) { return; }
        const tn = [...b.childNodes].reverse().find(n => n.nodeType === 3);
        if (tn) { tn.nodeValue = ' ' + meta; } else { b.appendChild(document.createTextNode(' ' + meta)); }
    }
    // El expediente quedó guardado en la web (la web pasa a la ficha del cierre o a «asignar»): se borra su copia y, si corresponde, sigue el siguiente
    function guardado(continuar) {
        const it = W.actual; W.actual = null; W.click = null; if (!it) { return; }
        quitarDeCola(it.exp);
        if (W.tanda) { W.tanda.hechos++; }
        W.saltados.delete(it.exp);
        const resto = listosDe(leerCola());
        if (!resto.length) { W.tanda = null; W.saltados = new Set(); }
        aviso('✔ ' + it.exp + ' guardado' + (resto.length ? ' · quedan ' + resto.length + ' del SGD' : ' · era el último del SGD'));
        if (continuar && resto.length) { W.pendiente = siguienteDe(resto).exp; W.desde = Date.now(); W.navegado = 0; setTimeout(() => { location.hash = '#/nuevo'; }, 400); }
        pintar();
    }

    function modalHTML(it) {
        const kb = it.kb || 0, grande = kb > MAX_IA_KB;
        const f = document.getElementById('f-exp'), sucio = !!(f && String(f.value || '').trim());
        const t = W.tanda || { total: listosDe(leerCola()).length, hechos: 0 };
        return '<div class="mbg"><div class="modal"><div class="mh">📄 ' + esc(it.exp) + (it.doc ? ' · ' + esc(it.doc) : '') + '</div><div class="mb">' +
            '<small>Expediente ' + (t.hechos + 1) + ' de ' + Math.max(t.total, t.hechos + 1) + ' desde el SGD · ' + esc(it.archivo || '') + ' (' + kb + ' KB)</small>' +
            (sucio ? '<div class="av warn">El formulario ya tiene datos escritos: al cargar el PDF se reemplazarán.</div>' : '') +
            '<button class="big n" data-a="normal" type="button"><b>Lector normal</b>Se lee en el navegador, sin enviarlo a ningún lado. Rápido y gratis.</button>' +
            '<button class="big i" data-a="ia" type="button"' + (grande ? ' disabled' : '') + '><b>Lector con IA · Gemini</b>Lee tablas y tramos repetidos. Tarda entre 5 y 20 segundos. Máximo 2 MB.' + (grande ? '<em>Este PDF pesa ' + kb + ' KB: no entra.</em>' : '') + '</button>' +
            '</div><div class="mf"><button class="btn" data-a="cancelar" type="button">Cancelar</button></div></div></div>';
    }
    function pintar() {
        const cola = leerCola(), listos = listosDe(cola), fallos = cola.filter(x => x.estado === 'fallo');
        const pil = el('pil');
        pil.style.display = listos.length || fallos.length ? 'flex' : 'none';
        pil.className = fallos.length ? 'falla' : '';
        pil.title = listos.length + ' expediente(s) del SGD listos para cargar' + (fallos.length ? ' · ' + fallos.length + ' sin descargar' : '');
        pil.innerHTML = '⬇ <b>' + listos.length + '</b> del SGD';
        const pop = el('pop'); pop.className = W.abierto ? 'open' : '';
        if (W.abierto) {
            pop.innerHTML = '<div class="ph"><span>Del SGD · listos para cargar <b>(' + listos.length + ')</b></span><button type="button" data-a="cerrar-pop">✕</button></div><div class="pl">' +
                (listos.length ? '' : '<div class="av warn">No hay copias listas.</div>') +
                listos.map(x => '<div class="rw"><b>' + esc(x.exp) + '</b><span class="pill">' + esc(x.emisor || '—') + '</span><small>' + esc(x.archivo || '') + '</small><button class="go" type="button" data-a="cargar" data-exp="' + esc(x.exp) + '" title="Cargar en Nuevo ingreso">▶</button></div>').join('') +
                fallos.map(x => '<div class="rw fail"><b>' + esc(x.exp) + '</b><small>' + esc(x.motivo || 'No se pudo descargar') + '</small></div>').join('') +
                '</div><div class="pf">Lo que no se descargó se reintenta desde el panel de la extensión en el SGD.</div>';
        }
        let barra = '';
        if (W.actual) {
            const quedan = listos.filter(x => x.exp !== W.actual.exp).length, t = W.tanda || { total: 1, hechos: 0 }, k = t.hechos + 1, tot = Math.max(t.total, k);
            barra = '<div class="ext"><span style="font-size:18px">😊</span><div class="pg"><b>Desde el SGD · ' + k + ' de ' + tot + (quedan === 0 ? ' · último' : '') + '</b><div class="bar"><i style="width:' + Math.round(k / tot * 100) + '%"></i></div></div><div class="bts"><button class="btn sm" type="button" data-a="lector" title="Vuelve a elegir el lector (normal o IA) con este mismo PDF y el formulario limpio">Cambiar lector</button><button class="btn sm" type="button" data-a="saltar"' + (quedan === 0 ? ' disabled' : '') + ' title="Deja este expediente en la lista del SGD y carga el siguiente">Saltar ›</button><button class="btn sm" type="button" data-a="pausa">' + (W.pausa ? 'Reanudar' : 'Pausar') + '</button></div></div>';
        }
        el('barra').innerHTML = barra;
        el('mod').innerHTML = W.modal ? modalHTML(W.modal) : '';
        const ts = el('tst'); ts.textContent = W.toast; ts.className = W.toast ? 'on' : '';
    }
    sh.addEventListener('click', ev => {
        const t = ev.target.closest('[data-a]'); if (!t) { return; } const a = t.dataset.a;
        if (a === 'normal' && W.modal) { cargar(W.modal, false); }
        else if (a === 'ia' && W.modal) { cargar(W.modal, true); }
        else if (a === 'cancelar') { W.modal = null; W.pendiente = null; pintar(); }
        else if (a === 'cargar') { iniciarCarga(t.dataset.exp); }
        else if (a === 'cerrar-pop') { W.abierto = false; pintar(); }
        else if (a === 'pausa') { W.pausa = !W.pausa; pintar(); actualizarBoton(); }
        else if (a === 'lector') { cambiarLector(); }
        else if (a === 'saltar') { saltar(); }
    });
    el('pil').addEventListener('click', () => { W.abierto = !W.abierto; pintar(); });

    // guardado: se anota el clic en «Guardar…» y, cuando la web pasa a la ficha del cierre (o a «asignar»), el expediente quedó guardado
    document.addEventListener('click', ev => { const b = ev.target && ev.target.closest ? ev.target.closest('[data-act="guardar"]') : null; if (b) { W.click = { t: Date.now(), cont: /continuar/i.test(b.textContent) }; } }, true);
    window.addEventListener('hashchange', ev => {
        const h = location.hash;
        // solo cuenta como «guardado» el paso desde «Nuevo ingreso» a la ficha del cierre (o a «asignar») justo después de pulsar «Guardar…»
        if (W.actual && W.click && Date.now() - W.click.t < 90000 && /#\/nuevo/.test((ev && ev.oldURL) || '') && /^#\/(cierre|asignar)\/\d+/.test(h)) { guardado(W.click.cont); return; }
        if (W.actual && !/^#\/nuevo/.test(h)) { W.actual = null; W.tanda = null; pintar(); }        // salió del formulario sin guardar: la copia sigue en la lista
    });
    new MutationObserver(() => { clearTimeout(W.tm); W.tm = setTimeout(actualizarBoton, 120); }).observe(document.documentElement, { childList: true, subtree: true });
    if (typeof GM_addValueChangeListener === 'function') { GM_addValueChangeListener(K_COLA, () => { pintar(); actualizarBoton(); }); }

    // espera a que aparezca el formulario de «Nuevo ingreso» (después del PIN la web vuelve al panel: se la lleva a «Nuevo ingreso»)
    setInterval(() => {
        if (W.pendiente && !W.modal) {
            const it = leerCola().find(x => x.exp === W.pendiente && x.estado === 'listo');
            if (!it || Date.now() - W.desde > 20 * 60000) { W.pendiente = null; pintar(); }
            else if (/^#\/nuevo/.test(location.hash) && formularioListo()) { W.modal = it; pintar(); }
            else if (!/^#\/nuevo/.test(location.hash) && document.querySelector('a[href="#/nuevo"]') && W.navegado < 3 && Date.now() - W.desde > 2500 * (W.navegado + 1)) { W.navegado++; location.hash = '#/nuevo'; }
        }
        actualizarBoton();
    }, 700);

    const ab = gget(K_ABRIR, null); gdel(K_ABRIR);
    if (ab && ab.exp && Date.now() - (ab.ts || 0) < 20 * 60000) { W.pendiente = ab.exp; W.desde = Date.now(); }
    pintar();
}

// ─── En la pestaña de la web solo se escucha: cuando se cierra un expediente, la página se actualiza sola ───────────────────
if (location.hostname === 'cierres-waze.vercel.app' || (location.hostname === 'localhost' && location.port === '3100')) {
    const avisar = v => {
        try { document.documentElement.setAttribute('data-cw-sgd', String((v && v.exp) || '')); document.dispatchEvent(new Event('cw-sgd-cerrado')); } catch (e) { /* nada */ }
    };
    let ultimo = (gget(K_SENAL, null) || {}).ts || 0;
    if (typeof GM_addValueChangeListener === 'function') {
        GM_addValueChangeListener(K_SENAL, (n, viejo, nuevo, remoto) => { if (remoto && nuevo && nuevo.ts && nuevo.ts !== ultimo) { ultimo = nuevo.ts; avisar(nuevo); } });
    } else {
        setInterval(() => { const v = gget(K_SENAL, null); if (v && v.ts > ultimo) { ultimo = v.ts; avisar(v); } }, 3000);
    }
    iniciarWeb();
    return;
}
if (!/^\/exedoc\//.test(location.pathname)) return;
if (window.top !== window.self) return;                       // solo la ventana principal, no marcos internos

// ─── Utilidades ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const visible = e => !!(e && (e.offsetWidth || e.offsetHeight || (e.getClientRects && e.getClientRects().length)));
const byId = id => document.getElementById(id);
const txt = e => String((e && (e.innerText != null ? e.innerText : e.textContent)) || '').replace(/\s+/g, ' ').trim();
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const pagina = () => /verExpediente\.seam/.test(location.pathname) ? 'ver' : /bandejaEntrada\.seam/.test(location.pathname) ? 'bandeja' : 'otra';

class Parar extends Error { constructor(m) { super(m); this.parar = true; } }

// Espera a que `fn` devuelva algo verdadero (consulta cada 150 ms). Si no ocurre en `ms`, el paso falla con un mensaje claro.
async function esperar(fn, ms, desc) {
    const t0 = Date.now(); let ultPint = 0;
    for (;;) {
        if (cancelado()) throw new Parar('__cancelado__');
        let v = null; try { v = fn(); } catch (e) { v = null; }
        if (v) { if (estado.lento) { estado.lento = null; } return v; }
        if (Date.now() - t0 > ms) { estado.lento = null; throw new Parar('No apareció ' + desc + ' después de ' + Math.round(ms / 1000) + ' s.'); }
        // durante una descarga, si el SGD tarda se dice en el panel (así no parece trabado)
        if (estado.corrida && Date.now() - t0 > 8000 && Date.now() - ultPint > 2000) { ultPint = Date.now(); estado.lento = { s: Math.round((Date.now() - t0) / 1000), max: Math.round(ms / 1000), que: desc }; pintar(); }
        await sleep(150);
    }
}
// Espera a que lo que devuelve `fn` no cambie durante `quieto` ms (por ejemplo, a que termine el filtro Ajax)
async function estable(fn, quieto, ms) {
    const t0 = Date.now(); let ult = null, desde = Date.now();
    for (;;) {
        if (cancelado()) throw new Parar('__cancelado__');
        let v; try { v = fn(); } catch (e) { v = 'error'; }
        if (v !== ult) { ult = v; desde = Date.now(); }
        if (Date.now() - desde >= quieto) return v;
        if (Date.now() - t0 > ms) return v;
        await sleep(120);
    }
}
const marcar = (e, clase) => { if (!e) return; try { e.scrollIntoView({ block: 'center' }); } catch (x) { /* nada */ } e.style.setProperty('outline', clase === 'espera' ? '3px dashed #2196f3' : '3px solid #fdd835', 'important'); e.style.setProperty('outline-offset', '2px', 'important'); };
const desmarcar = e => { if (e) { e.style.removeProperty('outline'); e.style.removeProperty('outline-offset'); } };
const soltarMarcas = () => { document.querySelectorAll('[style*="outline"]').forEach(e => { if (/fdd835|2196f3/i.test(e.getAttribute('style') || '')) desmarcar(e); }); };

// ─── Registro (se guarda entre páginas para poder diagnosticar) ───────────────────────────────────────────────────────────
let lineas = [];
try { lineas = (gget(K_LOG, []) || []).slice(-150); } catch (e) { lineas = []; }
function log(t) {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    lineas.push(p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '  ' + t);
    if (lineas.length > 150) lineas = lineas.slice(-150);
    gset(K_LOG, lineas);
    const el = ui && ui.shadow && ui.shadow.getElementById('log'); if (el) { el.textContent = lineas.slice(-60).join('\n'); el.scrollTop = el.scrollHeight; }
}

// ─── Comunicación con la web ──────────────────────────────────────────────────────────────────────────────────────────────
const enviar = (destino, ruta, cuerpo) => new Promise(res => {
    try {
        GM_xmlhttpRequest({
            method: 'POST', url: destino.url + ruta, timeout: destino.espera, anonymous: true,
            headers: { 'Content-Type': 'application/json', 'X-Extension-Key': CW_CLAVE }, data: JSON.stringify(cuerpo || {}),
            onload: r => { let j = null; try { j = JSON.parse(r.responseText); } catch (e) { /* no era JSON */ } res({ status: r.status, datos: j, destino }); },
            onerror: () => res({ status: 0, destino }), ontimeout: () => res({ status: 0, destino }), onabort: () => res({ status: 0, destino })
        });
    } catch (e) { res({ status: 0, destino }); }
});
// Prueba primero la web publicada y, si no responde o todavía no tiene esta función, la local del PC.
// `definitivo(r)`: respuestas que no se insisten en otro destino (por ejemplo, «el expediente no coincide»).
async function pedir(ruta, cuerpo, definitivo) {
    let ultimo = { status: 0 };
    for (const d of CW_DESTINOS) {
        const r = await enviar(d, ruta, cuerpo);
        log('web ' + d.nombre + ' ' + ruta + ' → ' + (r.status || 'sin respuesta'));
        if (r.status === 200 && r.datos) return r;
        if (definitivo && definitivo(r)) return r;
        if (r.status !== 0 || ultimo.status === 0) ultimo = r;
    }
    return ultimo;
}
const transitorio = st => st === 0 || st === 404 || st === 408 || st === 429 || st >= 500;

async function cargarLista(mostrar) {
    const r = await pedir('/api/extension/sgd/pendientes', {});
    if (r.status === 200 && r.datos && Array.isArray(r.datos.cierres)) {
        gset(K_CACHE, { ts: Date.now(), cierres: r.datos.cierres });
        if (mostrar) { estado.lista = r.datos.cierres; estado.listaError = ''; pintar(); }
        return r.datos.cierres;
    }
    if (mostrar) {
        estado.listaError = r.status === 401 ? 'La web rechazó la petición (código 401): la clave no coincide o la web publicada todavía no tiene esta función.' :
            r.status === 503 ? 'La web no tiene configurada la clave de la extensión.' :
            r.status === 404 ? 'La web publicada todavía no tiene esta función (falta publicarla) y la web local del PC no respondió.' :
            'No pude hablar con la web de Cierres Waze' + (r.status ? ' (código ' + r.status + ')' : '') + '. Se muestra la última lista guardada.';
        pintar();
    }
    return null;
}

// Rechazados de la web (solo lectura; no se guardan: la lista vive en memoria y se pide de nuevo al abrir el SGD, el panel o con ↻).
// `urlWeb` es la web que respondió (la publicada o, si no, la local) y es a la que apuntan los enlaces de «Devueltos».
async function cargarRechazados() {
    const r = await pedir('/api/extension/sgd/rechazados', {});
    if (r.status === 200 && r.datos && Array.isArray(r.datos.cierres)) {
        estado.rechazados = r.datos.cierres; estado.rechError = ''; estado.rechTs = Date.now(); estado.urlWeb = (r.destino && r.destino.url) || CW_DESTINOS[0].url;
    } else {
        estado.rechazados = null; estado.rechTs = Date.now();         // también se anota el intento fallido: se vuelve a probar a los 3 min, no cada segundo
        estado.rechError = r.status === 401 || r.status === 404 ? 'La web todavía no tiene la función de rechazados (falta publicarla).' : 'No pude hablar con la web de Cierres Waze' + (r.status ? ' (código ' + r.status + ')' : '') + '.';
    }
    recontar(true);
    return estado.rechazados;
}

// Aviso «expediente cerrado»: si no hay conexión se guarda y se reintenta solo (a los 7 días se descarta)
const leerPend = () => { const v = gget(K_PEND, []); return Array.isArray(v) ? v : []; };
async function enviarCerrado(a) {
    return pedir('/api/extension/sgd/cerrado', { cierre: a.id, exp: a.exp }, r => r.status === 409 || r.status === 400);
}
async function reintentarPendientes() {
    let l = leerPend().filter(x => x && x.aviso && Date.now() - (x.ts || 0) < 7 * 86400000);
    const queda = [];
    for (const x of l) {
        const r = await enviarCerrado(x.aviso);
        if (r.status === 200 || (r.status && !transitorio(r.status))) { log('aviso pendiente entregado: ' + x.aviso.exp + ' → ' + r.status); if (r.status === 200) gset(K_SENAL, { ts: Date.now(), exp: x.aviso.exp }); }
        else queda.push(x);
    }
    gset(K_PEND, queda);
}

// ─── Lo que la extensión sabe del SGD (lo visto en las páginas reales) ───────────────────────────────────────────────────────
const SEL = {
    tablaBandeja: 'idFormBandejaEntrada:expedienteList',
    menuBandeja: 'formMenuPrincipal:menuItemBandejaEntrada',
    comentario: 'formPanelObservaciones:idDecorateObservacion:observaciones',
    agregarComentario: 'formPanelObservaciones:agregarObservaciones',
    formFrecuentes: 'formDestinatario2',
    agregarDestinatario: 'formDestinatario2:agregarDestinatarioExpediente',
    despachar: 'idFormBotonesVerExpediente:despachar',
    dialogoDespachar: 'idConfirmDialogDespachar'
};
// filas de la bandeja que traen el botón «Ver expediente» (hay una por expediente; el encabezado y el filtro no lo traen)
const filasBandeja = () => {
    const t = byId(SEL.tablaBandeja); if (!t) return [];
    return [...t.querySelectorAll('tbody tr')].filter(tr => tr.querySelector('a[title="Ver Expediente"]') && visible(tr));   // solo las que se ven (el filtro puede ocultar o quitar filas)
};
const celdaTiene = (tr, exp) => [...tr.children].some(td => txt(td).toLowerCase() === exp.toLowerCase());
// campo del filtro «Expediente»: se busca por el encabezado de su columna, porque su nombre interno (j_idNNNfsp) puede cambiar
const filtroExpediente = () => {
    const t = byId(SEL.tablaBandeja); if (!t) return null;
    const ins = [...t.querySelectorAll('input.rich-filter-input')];
    return ins.find(i => { const c = i.closest('th,td'); return c && txt(c) === 'Expediente'; }) || null;
};
// Primera hoja de la bandeja: números de expediente de las filas que se ven. null = no se puede saber (no es la bandeja, o hay un filtro escrito
// y la tabla muestra solo una parte).
const numerosBandeja = () => {
    const t = byId(SEL.tablaBandeja); if (pagina() !== 'bandeja' || !t) return null;
    if ([...t.querySelectorAll('input.rich-filter-input')].some(i => i.value.trim())) return null;
    return filasBandeja().map(tr => { const td = [...tr.children].find(c => /^E?\d+\/\d{4}$/i.test(txt(c))); return td ? txt(td).toUpperCase() : ''; }).filter(Boolean);
};
// Devueltos = rechazados de la web cuyo número está en la primera hoja de la bandeja. Sin bandeja cargada o sin lista de la web no hay conteo.
const devueltos = () => {
    if (!estado.rechazados || !estado.vistos || !estado.vistos.length) return [];
    return estado.rechazados.filter(r => estado.vistos.includes(String(r.exp).toUpperCase()));
};
// Vuelve a mirar la bandeja y repinta solo si algo cambió. Mientras corre un plan la bandeja está filtrada: no se cuenta.
function recontar(forzar) {
    if (estado.plan || estado.corrida) return;
    const antes = estado.bandejaEn + '|' + devueltos().map(d => d.id).join(',');
    if (pagina() !== 'bandeja') { estado.vistos = null; estado.bandejaEn = 'otra'; }
    else {
        const n = numerosBandeja();
        if (n) { estado.vistos = n; estado.bandejaEn = n.length ? 'cargada' : 'vacia'; }
    }
    if (forzar || antes !== estado.bandejaEn + '|' + devueltos().map(d => d.id).join(',')) pintar();
}
// número del expediente que muestra la página «Ver expediente» (celda a la derecha de «Nº Expediente»)
const expedienteDePagina = () => {
    for (const td of document.querySelectorAll('td')) {
        if (/^n[º°o]\s*expediente$/i.test(txt(td)) && td.nextElementSibling) { const v = txt(td.nextElementSibling); if (/^E?\d+\/\d{4}$/i.test(v)) return v; }
    }
    return '';
};
const pestana = nombre => [...document.querySelectorAll('.rich-tab-header')].find(t => norm(txt(t)) === norm(nombre)) || null;
const selectFrecuentes = () => { const f = byId(SEL.formFrecuentes); const s = f && f.querySelector('select'); return s && visible(s) && s.options.length > 1 ? s : null; };

// ─── Plan en curso (sobrevive a los cambios de página del SGD) ───────────────────────────────────────────────────────────
// fase: 'corriendo' (rellenando) | 'esperando' (a que el usuario despache) | 'despachando' (el usuario confirmó «Sí»)
const VIDA_PLAN = 25 * 60 * 1000;
const leerPlan = () => { const p = gget(K_PLAN, null); return p && p.cierre && Date.now() - (p.ts || 0) < VIDA_PLAN ? p : null; };
const guardarPlan = p => { p.ts = Date.now(); gset(K_PLAN, p); estado.plan = p; };
const borrarPlan = () => { gdel(K_PLAN); estado.plan = null; soltarMarcas(); };
const cancelado = () => !!estado.cancelar;

// ─── Los pasos ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
// `en`: en qué página se hacen. `f(plan)` devuelve 'nav' si el clic cambia de página (el plan ya quedó guardado con el paso siguiente).
const PASOS = [
    { en: 'bandeja', t: 'Abrir la bandeja de entrada (pestaña Entrada)', f: async p => {
        const tab = await esperar(() => pestana('Entrada'), 4000, 'la pestaña «Entrada» de la bandeja').catch(e => { if (e.message === '__cancelado__') throw e; return null; });
        if (!tab) log('no se vio la pestaña «Entrada» como pestaña; se sigue con la tabla que haya');
        else if (/rich-tab-inactive/.test(tab.className)) { marcar(tab); await sleep(400); tab.click(); await sleep(800); desmarcar(tab); }
        // la bandeja no se llena sola si se entra directo a la dirección: hay que pulsar «Bandeja de entrada» del menú
        let n = 0; try { n = await esperar(() => filasBandeja().length, 6000, 'las filas de la bandeja'); } catch (e) { if (e.message === '__cancelado__') throw e; n = 0; }
        if (!n) {
            if ((p.intentosBandeja || 0) >= 1) throw new Parar('La bandeja de entrada está vacía: no hay expedientes pendientes (o no cargó).');
            const m = byId(SEL.menuBandeja); if (!m) throw new Parar('La bandeja no cargó y no encontré el menú «Bandeja de entrada».');
            p.intentosBandeja = (p.intentosBandeja || 0) + 1; guardarPlan(p); log('bandeja vacía: se pulsa «Bandeja de entrada» del menú');
            m.click(); return 'nav';
        }
        log('bandeja cargada: ' + n + ' filas');
    } },
    { en: 'bandeja', t: 'Escribir el expediente en el filtro', f: async p => {
        const inp = await esperar(filtroExpediente, 8000, 'el cuadro para filtrar por Expediente');
        marcar(inp); inp.focus();
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        set.call(inp, ''); set.call(inp, p.cierre.exp);
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: '0', keyCode: 48, which: 48 }));
        log('filtro escrito: ' + p.cierre.exp); await sleep(400); desmarcar(inp);
    } },
    { en: 'bandeja', t: 'Esperar la tabla filtrada y comprobar que hay UN solo expediente', f: async p => {
        const exp = p.cierre.exp;
        const t = byId(SEL.tablaBandeja); marcar(t, 'espera');
        // el filtro es Ajax: se espera a que la tabla quede solo con el expediente pedido y deje de cambiar
        const estadoTabla = () => { const f = filasBandeja(); return f.length + '|' + f.filter(tr => celdaTiene(tr, exp)).length; };
        await esperar(() => { const [n, e] = estadoTabla().split('|').map(Number); return n > 0 && n === e; }, 15000, 'la tabla filtrada con el expediente ' + exp).catch(e => { if (e.message === '__cancelado__') throw e; log('el filtro no dejó solo ese expediente (' + estadoTabla() + '); se comprueba igual'); });
        await estable(estadoTabla, 1000, 6000);
        desmarcar(t);
        const filas = filasBandeja(), exactas = filas.filter(tr => celdaTiene(tr, exp));
        if (exactas.length === 0) throw new Parar('El filtro no dejó ningún expediente ' + exp + ' (' + filas.length + ' filas visibles). ¿Ya fue despachado, está en otra pestaña o el número no coincide?');
        if (exactas.length > 1) throw new Parar('Hay ' + exactas.length + ' filas con el expediente ' + exp + ' y espero una sola. No sé cuál abrir.');
        marcar(exactas[0]); await sleep(500); desmarcar(exactas[0]); log('una fila con ' + exp);
    } },
    { en: 'bandeja', t: 'Pulsar «Ver expediente»', f: async p => {
        const fila = filasBandeja().filter(tr => celdaTiene(tr, p.cierre.exp));
        if (fila.length !== 1) throw new Parar('Se perdió la fila de ' + p.cierre.exp + ' antes de abrirla.');
        const a = fila[0].querySelector('a[title="Ver Expediente"]');
        marcar(a); await sleep(500);
        p.paso++; guardarPlan(p); log('se abre el expediente (el SGD tarda unos segundos)'); a.click(); return 'nav';
    } },
    { en: 'ver', t: 'Esperar a que abra la página del expediente y confirmar que es el correcto', f: async p => {
        await esperar(() => byId(SEL.comentario), 40000, 'la página del expediente');
        const e = await esperar(expedienteDePagina, 8000, 'el número del expediente en la página');
        if (e.toLowerCase() !== p.cierre.exp.toLowerCase()) throw new Parar('Se abrió el expediente ' + e + ' y yo buscaba ' + p.cierre.exp + '. Me detengo sin escribir nada.');
        log('página del expediente ' + e);
    } },
    { en: 'ver', t: 'Escribir «' + TEXTO_COMENTARIO + '» en el comentario', f: async p => {
        const ta = await esperar(() => byId(SEL.comentario), 8000, 'el cuadro de comentario');
        marcar(ta); ta.focus();
        const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        set.call(ta, TEXTO_COMENTARIO);
        ta.dispatchEvent(new Event('input', { bubbles: true })); ta.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(400);
        if (ta.value !== TEXTO_COMENTARIO) throw new Parar('El cuadro de comentario no aceptó el texto.');
        desmarcar(ta);
    } },
    { en: 'ver', t: 'Pulsar «Agregar» del comentario (no el botón de archivos)', f: async p => {
        const b = await esperar(() => byId(SEL.agregarComentario), 5000, 'el botón «Agregar» del comentario');
        const veces = () => norm(document.body.innerText).split(norm(TEXTO_COMENTARIO)).length - 1;
        const antes = veces();
        marcar(b); await sleep(600);
        p.paso++; guardarPlan(p);                       // si el SGD recarga la página al agregar, se continúa en el paso siguiente
        b.click(); await sleep(400); desmarcar(b);
        // listo cuando el cuadro quedó vacío o el comentario ya aparece una vez más en la lista
        const ok = await esperar(() => { const ta = byId(SEL.comentario); return !ta || ta.value === '' || veces() > antes; }, 12000, 'el comentario agregado a la lista').then(() => true).catch(e => { if (e.message === '__cancelado__') throw e; return false; });
        if (!ok) { p.paso--; guardarPlan(p); throw new Parar('Pulsé «Agregar» pero el comentario no apareció en la lista. Revísalo en el SGD.'); }
        return 'avanzado';
    } },
    { en: 'ver', t: 'Abrir la pestaña «Destinatarios frecuentes»', f: async p => {
        const tab = await esperar(() => pestana('Destinatarios frecuentes'), 10000, 'la pestaña «Destinatarios frecuentes»');
        if (!/rich-tab-active/.test(tab.className)) { marcar(tab); await sleep(500); tab.click(); await sleep(400); desmarcar(tab); }
        await esperar(selectFrecuentes, 15000, 'la lista desplegable de destinatarios frecuentes');
    } },
    { en: 'ver', t: 'Elegir al emisor en la lista desplegable', f: async p => {
        const sel = await esperar(selectFrecuentes, 10000, 'la lista desplegable de destinatarios frecuentes');
        if (!p.cierre.emisorNombre) throw new Parar('Este cierre (' + (p.cierre.emisor || 'sin sigla') + ') no tiene nombre de emisor en la web. Agrégalo en Configuración de la web y reintenta.');
        // se leen las opciones que tenga la lista en este momento: todas las palabras del nombre de la web deben estar en el nombre del SGD
        const partes = norm(p.cierre.emisorNombre).split(' ').filter(Boolean);
        const op = [...sel.options].filter(o => o.value && o.value !== '-1' && partes.every(w => norm(o.text).split(' ').includes(w)));
        if (!op.length) throw new Parar('En la lista del SGD no hay nadie que coincida con «' + p.cierre.emisorNombre + '» (' + (sel.options.length - 1) + ' opciones). Elígelo tú.');
        if (op.length > 1) throw new Parar('Hay ' + op.length + ' nombres en la lista que coinciden con «' + p.cierre.emisorNombre + '». Elígelo tú.');
        marcar(sel); await sleep(500);
        sel.value = op[0].value; sel.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(400); desmarcar(sel);
        if (sel.value !== op[0].value) throw new Parar('No logré dejar seleccionado a «' + op[0].text.trim() + '».');
        p.elegido = op[0].text.trim(); guardarPlan(p); log('elegido en la lista: ' + p.elegido);
    } },
    { en: 'ver', t: 'Pulsar el «Agregar» que está junto a la lista', f: async p => {
        const b = await esperar(() => byId(SEL.agregarDestinatario) || (byId(SEL.formFrecuentes) && byId(SEL.formFrecuentes).querySelector('input[type=button][value="Agregar"]')), 5000, 'el botón «Agregar» junto a la lista');
        const sel = byId(SEL.formFrecuentes).querySelector('select');
        if (!sel || !sel.value || sel.value === '-1') throw new Parar('La lista de destinatarios no tiene a nadie seleccionado.');
        const valor = sel.value;
        marcar(b); await sleep(600); b.click(); await sleep(400); desmarcar(b);
        // el destinatario queda agregado cuando la lista se reinicia o su nombre aparece fuera de la lista desplegable
        const fuera = () => { const nombre = norm(p.elegido); const copia = document.body.cloneNode(true); copia.querySelectorAll('select,option,script,style,textarea').forEach(x => x.remove()); return norm(copia.innerText || copia.textContent).includes(nombre); };
        const ok = await esperar(() => { const s = (byId(SEL.formFrecuentes) || document).querySelector('select'); return !s || s.value !== valor || fuera(); }, 12000, 'el destinatario agregado').then(() => true).catch(e => { if (e.message === '__cancelado__') throw e; return false; });
        p.agregadoConfirmado = ok; guardarPlan(p);
        log(ok ? 'destinatario agregado' : 'no pude confirmar que el destinatario quedó agregado: hay que revisarlo');
    } },
    { en: 'ver', t: 'Esperar a que tú pulses «Despachar» y confirmes «Sí»', f: async p => {
        const b = await esperar(() => byId(SEL.despachar), 8000, 'el botón «Despachar»');
        p.fase = 'esperando'; guardarPlan(p); marcar(b, 'espera'); armarDespacho(); pintar();
        return 'espera';
    } },
    { en: 'cualquiera', t: 'Avisar a la web que el expediente quedó cerrado en el SGD', f: async p => { await avisarWeb(p); return 'fin'; } }
];

// ─── Despachar: lo hace el usuario; la extensión solo lo detecta ─────────────────────────────────────────────────────────
let despachoArmado = false;
function armarDespacho() {
    if (despachoArmado) return; despachoArmado = true;
    document.addEventListener('click', ev => {
        const p = leerPlan(); if (!p || p.fase !== 'esperando') return;
        const b = ev.target && ev.target.closest ? ev.target.closest('input,button,a') : null; if (!b) return;
        if (b.id === SEL.despachar) { p.pulso = Date.now(); guardarPlan(p); log('el usuario pulsó «Despachar» (falta confirmar con «Sí»)'); return; }
        // El SGD saca el cuadro «¿Desea despachar el expediente?» de su contenedor al abrirlo, así que el «Sí» no se reconoce por dónde está
        // sino porque se pulsó «Despachar» hace poco (y no es el cuadro de «Rechazar»).
        if (!p.pulso || Date.now() - p.pulso > 3 * 60 * 1000) return;
        const valor = String(b.value || txt(b)).trim();
        const enRechazar = (() => { for (let e = b; e; e = e.parentElement) { if (/rechazar/i.test(e.id || '')) return true; } return false; })();
        if (/^s[ií]$/i.test(valor) && !enRechazar) {
            p.fase = 'despachando'; p.tDesp = Date.now(); guardarPlan(p); log('el usuario confirmó «Sí» en Despachar');
            soltarMarcas(); pintar();
            setTimeout(() => vigilarDespacho().catch(e => log('vigilar: ' + e.message)), 300);
        } else { log('clic en «' + valor.slice(0, 20) + '» después de Despachar (no se toma como confirmación)'); }
    }, true);
}
// Si la página no cambia después del «Sí», no se sabe si salió bien: se pregunta
async function vigilarDespacho() {
    const p = leerPlan(); if (!p || p.fase !== 'despachando') return;
    if (pagina() !== 'ver' || expedienteDePagina().toLowerCase() !== p.cierre.exp.toLowerCase()) { return despachoListo(p); }   // el SGD lo sacó de la página: se despachó
    for (let i = 0; i < 40; i++) {               // hasta 20 s: o el SGD cambia de página (ya se volvió a cargar este script) o muestra su mensaje
        if (hayMensajeDespachado()) { return despachoListo(p); }
        await sleep(500);
    }
    const q = leerPlan(); if (!q || q.fase !== 'despachando') return;
    estado.dudaDespacho = true; pintar();
}
// El SGD escribe «Expediente despachado» arriba de la bandeja cuando termina
const hayMensajeDespachado = () => /expediente\s+despachado/i.test(document.body ? document.body.innerText : '');
async function despachoListo(p) {
    p.fase = 'corriendo'; p.paso = PASOS.length - 1; guardarPlan(p);
    log('despachado: el SGD cambió de página');
    await continuar();
}
async function avisarWeb(p) {
    const a = { id: p.cierre.id, exp: p.cierre.exp };
    const r = await enviarCerrado(a);
    estado.resultado = { exp: a.exp, cierre: p.cierre, status: r.status, datos: r.datos, agregadoConfirmado: p.agregadoConfirmado !== false };
    if (r.status === 200) { gset(K_SENAL, { ts: Date.now(), exp: a.exp }); log('web: ' + (r.datos && r.datos.resultado) + ' ' + a.exp); }
    else if (r.status === 409 || r.status === 400) { log('la web rechazó el aviso: ' + JSON.stringify(r.datos || {})); }
    else { const l = leerPend(); l.push({ aviso: a, ts: Date.now() }); gset(K_PEND, l.slice(-50)); estado.resultado.encolado = true; log('sin conexión con la web: aviso guardado para reintentar'); }
    borrarPlan(); cargarLista(true).catch(() => {});
}

// ─── Motor: ejecuta los pasos y sigue en la página siguiente ────────────────────────────────────────────────────────────
let corriendo = false;
async function continuar() {
    if (corriendo) return; corriendo = true;
    try {
        for (;;) {
            let p = leerPlan(); if (!p) break;
            if (cancelado()) throw new Parar('__cancelado__');
            if (p.paso >= PASOS.length) { borrarPlan(); break; }
            const paso = PASOS[p.paso];
            if (paso.en !== 'cualquiera' && paso.en !== pagina()) {
                if (p.fase === 'esperando' || Date.now() - p.ts < 60000) break;       // recién se cambió de página: la que corresponde llega enseguida
                throw new Parar('Estoy en una página que no es la de este paso (' + pagina() + '). Vuelve a la bandeja o a «Ver expediente».');
            }
            delete p.detenido; delete p.error; estado.plan = p; estado.error = ''; pintar();
            log('paso ' + (p.paso + 1) + ': ' + paso.t);
            const r = await paso.f(p);
            p = leerPlan() || p;
            if (r === 'nav') { log('cambio de página: el plan sigue allí'); break; }
            if (r === 'espera' || r === 'fin') { break; }
            if (r !== 'avanzado') { p.paso = p.paso + 1; guardarPlan(p); }       // 'avanzado': el paso ya avanzó el plan por su cuenta
            pintar();
        }
    } catch (e) {
        if (e && e.message === '__cancelado__') { log('cancelado por el usuario'); estado.error = ''; estado.cancelado = true; borrarPlan(); }
        else { const p = leerPlan(); estado.error = (e && e.message) || String(e); estado.pasoError = p ? p.paso : -1; log('ERROR paso ' + (estado.pasoError + 1) + ': ' + estado.error); soltarMarcas(); if (p) { p.error = estado.error; p.detenido = true; gset(K_PLAN, p); } }
    } finally { corriendo = false; estado.cancelar = false; pintar(); }
}

function ejecutar(c) {
    if (corriendo || estado.plan || estado.corrida) return;
    estado.error = ''; estado.resultado = null; estado.cancelado = false; estado.dudaDespacho = false;
    const p = { cierre: { id: c.id, exp: c.exp, evento: c.evento, emisor: c.emisor, emisorNombre: c.emisorNombre, comuna: c.comuna }, paso: 0, fase: 'corriendo', nav: true };
    guardarPlan(p); log('=== ' + c.exp + ' · ' + c.evento + ' (extensión SGD ' + VERSION + ')');
    // fuera de la bandeja se parte pulsando «Bandeja de entrada» del menú (la página se recarga y el plan sigue)
    if (pagina() !== 'bandeja') {
        const m = byId(SEL.menuBandeja);
        if (!m) { estado.error = 'No encontré el menú «Bandeja de entrada». Abre la bandeja de entrada del SGD y vuelve a pulsar ▶.'; borrarPlan(); pintar(); return; }
        p.intentosBandeja = 1; guardarPlan(p); pintar(); log('se va a la bandeja de entrada'); m.click();
        setTimeout(() => { const q = leerPlan(); if (q && q.paso === 0 && !corriendo && !q.detenido) { q.detenido = true; q.error = 'El menú «Bandeja de entrada» no cambió de página. Abre la bandeja a mano y vuelve a pulsar ▶.'; gset(K_PLAN, q); estado.error = q.error; pintar(); } }, 12000);
        return;
    }
    pintar(); continuar();
}

// ─── Interfaz: botón flotante con el logo de Waze y panel (en un shadow DOM para no mezclarse con el SGD) ───────────────────
const estado = { lista: (gget(K_CACHE, null) || {}).cierres || [], listaError: '', plan: leerPlan(), error: '', resultado: null, cancelar: false, cancelado: false, dudaDespacho: false, abierto: false, sel: null, confirmar: null, avisoLista: '', toast: '',
    pest: 'cerrar', rechazados: null, rechError: '', rechTs: 0, urlWeb: '', vistos: null, bandejaEn: 'otra',
    // descargas (v1.3): corrida = la descarga en curso · dlModal: null | 'inicio' | 'config' · dlResultado = resumen de la última · lento = «el SGD está lento»
    corrida: null, errorDl: '', dlModal: null, dlResultado: null, lento: null, emiError: '', emiEdit: -1, emiBuscando: false, selDes: null, confirmarDes: null };
const ui = { shadow: null };
const LOGO = '<svg width="40" height="40" viewBox="0 0 64 64" aria-hidden="true"><path d="M32 5C17 5 6 15.5 6 29c0 7.5 3.5 13.5 8.5 17.5L12 56l10-4.5c3 1 6 1.5 10 1.5 15 0 26-10.5 26-24S47 5 32 5z" fill="#33ccff" stroke="#fff" stroke-width="3" stroke-linejoin="round"/><ellipse cx="24" cy="26" rx="3.4" ry="4.6" fill="#1b2538"/><ellipse cx="40" cy="26" rx="3.4" ry="4.6" fill="#1b2538"/><path d="M21 36c3 5 7 7 11 7s8-2 11-7" fill="none" stroke="#1b2538" stroke-width="3.2" stroke-linecap="round"/><circle cx="21" cy="52" r="5" fill="#1b2538" stroke="#fff" stroke-width="2"/><circle cx="43" cy="52" r="5" fill="#1b2538" stroke="#fff" stroke-width="2"/></svg>';
const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: "Segoe UI", Arial, sans-serif; }
#fab { position: fixed; right: 18px; bottom: 18px; width: 58px; height: 58px; border-radius: 50%; border: 3px solid #fff; background: #2196f3; box-shadow: 0 4px 14px rgba(0,0,0,.35); cursor: pointer; padding: 0; display: flex; align-items: center; justify-content: center; z-index: 2147483000; }
#fab:hover { transform: scale(1.06); }
#fab .b { position: absolute; top: -6px; right: -6px; background: #d64545; color: #fff; border-radius: 11px; font-size: 11px; font-weight: 700; min-width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; border: 2px solid #fff; }
#fab .d { position: absolute; bottom: -6px; right: -6px; background: #f08a1c; color: #fff; border-radius: 11px; font-size: 11px; font-weight: 700; min-width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; border: 2px solid #fff; }
#fab.act { animation: lat 1.2s infinite; }
@keyframes lat { 50% { box-shadow: 0 0 0 10px rgba(33,150,243,.35); } }
#panel { position: fixed; right: 18px; bottom: 88px; width: 390px; max-height: calc(100vh - 110px); background: #fff; border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,.4); border: 1px solid #b9c1ce; display: none; flex-direction: column; overflow: hidden; z-index: 2147483001; color: #1b2538; font-size: 14px; }
#panel.open { display: flex; }
.ph { background: #1b2538; color: #fff; padding: 10px 12px; display: flex; align-items: center; gap: 10px; }
.ph b { flex: 1; } .ph button { background: none; border: 0; color: #fff; font-size: 18px; cursor: pointer; }
.pb { padding: 10px 12px; overflow: auto; }
h4 { margin: 0 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #667; }
.tabs { display: flex; background: #eef1f5; border-bottom: 1px solid #d9dee6; }
.tab { flex: 1; border: 0; background: none; padding: 9px 6px; font: inherit; font-size: 13px; font-weight: 600; color: #566; cursor: pointer; border-bottom: 3px solid transparent; }
.tab.on { color: #1b2538; background: #fff; border-bottom-color: #2196f3; } .tab.dev.on { border-bottom-color: #f08a1c; }
.tab .n { display: inline-block; min-width: 20px; padding: 0 6px; border-radius: 10px; background: #d9dee6; color: #334; font-size: 11px; margin-left: 4px; }
.tab.dev .n.hay { background: #f08a1c; color: #fff; }
.row.dv { border-left: 4px solid #f08a1c; padding-right: 44px; text-decoration: none; color: inherit; display: block; }
.row.dv:hover { background: #fff6ea; } .row.dv .go { position: absolute; right: 12px; top: 50%; transform: translateY(-50%); font-size: 18px; color: #f08a1c; font-weight: 700; } .row.dv .mot { color: #8a4b00; }
.av.warn { background: #fff1de; border: 1px solid #f3c68f; color: #8a4b00; }
.sub { padding: 8px 12px; border-bottom: 1px solid #d9dee6; font-size: 12px; color: #566; display: flex; justify-content: space-between; align-items: center; background: #fafbfc; gap: 8px; }
.sub .btn { padding: 4px 10px; }
.lista { overflow: auto; padding: 8px 10px; flex: 1; min-height: 60px; }
.pie { padding: 8px 12px; border-top: 1px solid #d9dee6; font-size: 12px; color: #566; background: #fafbfc; }
.row { position: relative; border: 1px solid #d9dee6; border-radius: 8px; padding: 8px 100px 8px 10px; margin-bottom: 6px; cursor: pointer; min-height: 62px; }
.row:hover { background: #f2f8ff; } .row.sel { border-color: #2196f3; background: #e8f3ff; box-shadow: 0 0 0 2px rgba(33,150,243,.25); }
.row b { font-size: 13px; } .row small { display: block; color: #566; line-height: 1.35; }
.ra { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); display: none; gap: 8px; }
.row.sel .ra { display: flex; animation: entra .15s ease-out; }
@keyframes entra { from { opacity: 0; transform: translateY(-50%) translateX(10px); } }
.ib { width: 38px; height: 38px; border-radius: 50%; border: 0; cursor: pointer; font-size: 17px; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 6px rgba(0,0,0,.25); position: relative; padding: 0; }
.ib.play { background: #2e9e5b; color: #fff; } .ib.hecho { background: #fff; color: #2196f3; border: 2px solid #2196f3; }
.ib:hover { transform: scale(1.08); }
.ib[data-tip]:hover::after { content: attr(data-tip); position: absolute; right: calc(100% + 6px); top: 50%; transform: translateY(-50%); background: #333; color: #fff; font-size: 11px; padding: 4px 8px; border-radius: 4px; white-space: nowrap; z-index: 9; }
.conf { position: absolute; inset: 0; background: rgba(255,255,255,.97); border-radius: 8px; display: flex; align-items: center; gap: 8px; padding: 0 10px; z-index: 2; font-size: 12px; }
.conf span { flex: 1; } .btn.ok { background: #2e9e5b; color: #fff; } .btn.sm { padding: 6px 12px; }
.toast { position: absolute; left: 50%; bottom: 44px; transform: translateX(-50%); background: #1d6b3b; color: #fff; padding: 6px 14px; border-radius: 16px; font-size: 12px; z-index: 10; max-width: 90%; text-align: center; }
.pill { font-size: 10.5px; padding: 1px 7px; border-radius: 9px; background: #e8eef6; margin-left: 4px; } .pill.w { background: #fff1cc; color: #8a5a00; }
.btn { border: 0; border-radius: 6px; padding: 8px 14px; font: inherit; font-weight: 600; cursor: pointer; background: #e3e8ef; color: #1b2538; }
.btn.play { background: #2e9e5b; color: #fff; } .btn.red { background: #d64545; color: #fff; } .btn:disabled { opacity: .45; cursor: not-allowed; }
.acc { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
ol { list-style: none; margin: 8px 0 0; padding: 0; } li { display: flex; gap: 8px; padding: 4px 0; font-size: 12.5px; color: #667; }
li .s { width: 18px; text-align: center; flex: none; } li.run { color: #1b2538; font-weight: 600; } li.ok { color: #2e9e5b; } li.fail { color: #d64545; font-weight: 600; } li.wait { color: #0b6bc4; font-weight: 600; }
.av { border-radius: 8px; padding: 9px 11px; margin-top: 8px; font-size: 12.5px; line-height: 1.4; }
.av.err { background: #fdeaea; border: 1px solid #f0b3b3; color: #8e1f1f; } .av.info { background: #e8f3ff; border: 1px solid #a9d2f7; color: #0b4f8a; }
.av.ok { background: #e6f6ec; border: 1px solid #9bd5b0; color: #1d6b3b; } .av.ok b.g { font-size: 15px; }
#log { margin-top: 6px; background: #10151f; color: #b8f0c8; font: 11px/1.45 Consolas, monospace; padding: 6px 8px; border-radius: 6px; max-height: 120px; overflow: auto; white-space: pre-wrap; }
details summary { cursor: pointer; font-size: 12px; color: #556; margin-top: 8px; }
/* descargas (v1.3) */
#fab .g { position: absolute; bottom: -6px; left: -6px; background: #0f9d8a; color: #fff; border-radius: 11px; font-size: 11px; font-weight: 700; min-width: 22px; height: 22px; padding: 0 4px; display: flex; align-items: center; justify-content: center; border: 2px solid #fff; }
#fab .g.falla { background: #c9f2da; color: #d00000; border-color: #d64545; }
.ph .dlb { background: transparent; border: 0; color: rgba(255,255,255,.72); border-radius: 6px; width: 28px; height: 26px; padding: 0; display: flex; align-items: center; justify-content: center; cursor: pointer; }
.ph .dlb:hover { background: rgba(255,255,255,.14); color: #fff; } .ph .dlb:disabled { opacity: .35; cursor: not-allowed; }
.tab.des.on { border-bottom-color: #0f9d8a; } .tab.des .n.hay { background: #0f9d8a; color: #fff; }
.row.des.sel { border-color: #0f9d8a; background: #e7f7f4; box-shadow: 0 0 0 2px rgba(15,157,138,.22); }
.row.fail { border-color: #f0b3b3; background: #fdeaea; border-left: 4px solid #d64545; } .row.fail .ra { display: flex; } .row.fail .mot { color: #8e1f1f; }
.pill.r { background: #f7c9c9; color: #8e1f1f; } .rojo { color: #d00000; } .pill.ana { background: #dcebfb; color: #0b4f8a; }
.ib.go { background: #0f9d8a; color: #fff; } .ib.re { background: #f08a1c; color: #fff; } .ib.x { background: #fff; color: #666; border: 2px solid #ccd; font-size: 14px; }
.av.warn2 { background: #fff1de; border: 1px solid #f3c68f; color: #8a4b00; }
.bar { height: 8px; background: #e3e8ef; border-radius: 4px; overflow: hidden; margin: 8px 0 4px; } .bar > i { display: block; height: 100%; background: #0f9d8a; transition: width .3s; }
#modal .mbg { position: fixed; inset: 0; background: rgba(20,30,50,.45); display: flex; align-items: center; justify-content: center; padding: 14px; z-index: 2147483002; }
#modal .modal { width: 390px; max-width: 100%; max-height: 92vh; overflow: auto; background: #fff; border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.4); color: #1b2538; font-size: 14px; }
#modal .mh { padding: 12px 14px; font-weight: 700; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid #d9dee6; } #modal .mh .eng { margin-left: auto; cursor: pointer; font-size: 17px; background: none; border: 0; }
#modal .mb { padding: 12px 14px; } #modal .mf { padding: 10px 14px; background: #fafbfc; border-top: 1px solid #d9dee6; display: flex; justify-content: flex-end; gap: 8px; }
ul.em { list-style: none; margin: 0; padding: 0; } ul.em li { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border: 1px solid #d9dee6; border-radius: 7px; margin-bottom: 5px; font-size: 13px; }
ul.em li .nm { flex: 1; } ul.em li .ic { cursor: pointer; color: #667; font-size: 14px; background: none; border: 0; padding: 2px 4px; }
.inp { border: 1px solid #b9c1ce; border-radius: 6px; padding: 7px 9px; font-size: 13px; width: 100%; background: #fff; color: #1b2538; }
.lnk { background: none; border: 0; color: #0b6bc4; cursor: pointer; font: inherit; font-size: 12px; padding: 4px 0; }
`;
function montar() {
    if (ui.shadow) return;
    const host = document.createElement('div'); host.id = 'cw-sgd-host';
    ui.shadow = host.attachShadow({ mode: 'open' });
    ui.shadow.innerHTML = '<style>' + CSS + '</style><button id="fab" title="Cierres Waze: expedientes por cerrar en el SGD" aria-label="Abrir Cierres Waze"></button><div id="panel" role="dialog" aria-label="Cierres Waze en el SGD"></div><div id="modal"></div>';
    document.documentElement.appendChild(host);
    ui.shadow.getElementById('fab').addEventListener('click', () => { estado.abierto = !estado.abierto; pintar(); if (estado.abierto && !estado.plan) { cargarLista(true); if (Date.now() - estado.rechTs > 30000) cargarRechazados().catch(() => {}); } });
    const manejar = ev => {
        const t = ev.target.closest('[data-a]'); if (!t) return; const a = t.dataset.a;
        if (dlAccion(a, t)) return;
        if (a === 'cerrar') { estado.abierto = false; pintar(); }
        else if (a === 'fila') { estado.sel = Number(t.dataset.id); estado.confirmar = null; pintar(); }
        else if (a === 'play') { const c = estado.lista.find(x => x.id === Number(t.dataset.id)); if (c) { estado.sel = c.id; estado.avisoLista = ''; ejecutar(c); } }
        else if (a === 'hecho') { estado.sel = Number(t.dataset.id); estado.confirmar = Number(t.dataset.id); pintar(); }
        else if (a === 'si-manual') { const c = estado.lista.find(x => x.id === Number(t.dataset.id)); if (c) marcarManual(c); }
        else if (a === 'no-manual') { estado.confirmar = null; pintar(); }
        else if (a === 'act') { cargarLista(true); }
        else if (a === 't-cerrar') { estado.pest = 'cerrar'; pintar(); }
        else if (a === 't-dev') { estado.pest = 'dev'; pintar(); if (Date.now() - estado.rechTs > 30000) cargarRechazados().catch(() => {}); }
        else if (a === 'act-dev') { cargarRechazados().catch(() => {}); }
        else if (a === 'cancelar') {
            if (corriendo) { estado.cancelar = true; pintar(); }
            else {
                const p = estado.plan;
                if (p && estado.error) { estado.pest = 'cerrar'; estado.sel = p.cierre.id; }         // el expediente que falló queda seleccionado, con su ▶ y su ✔ a la vista
                if (p && estado.error) estado.avisoLista ='Me detuve en el paso ' + (p.paso + 1) + ' con ' + p.cierre.exp + ': ' + estado.error + ' Si el expediente sí se despachó en el SGD, pulsa ✔ en su fila.';
                borrarPlan(); estado.error = ''; pintar();
            }
        }
        else if (a === 'cerrar-res') { estado.resultado = null; estado.cancelado = false; estado.error = ''; pintar(); }
        else if (a === 'copiar') { try { navigator.clipboard.writeText(lineas.join('\n')); t.textContent = 'Copiado ✔'; } catch (e) { /* nada */ } }
        else if (a === 'si-despache') { const p = leerPlan(); if (p) { estado.dudaDespacho = false; despachoListo(p); } }
        else if (a === 'no-despache') { const p = leerPlan(); if (p) { p.fase = 'esperando'; guardarPlan(p); estado.dudaDespacho = false; log('el usuario indica que NO se despachó'); const b = byId(SEL.despachar); marcar(b, 'espera'); } pintar(); }
    };
    ui.shadow.getElementById('panel').addEventListener('click', manejar);
    ui.shadow.getElementById('modal').addEventListener('click', manejar);
    ui.shadow.getElementById('modal').addEventListener('keydown', ev => {
        if (ev.key !== 'Enter' || !ev.target) return;
        if (ev.target.id === 'emi-nuevo') dlAccion('emi-add', ev.target); else if (ev.target.id === 'emi-inp') dlAccion('emi-ok', { dataset: { i: String(estado.emiEdit) } });
    });
}
function pintar() {
    montar();
    const fab = ui.shadow.getElementById('fab'), panel = ui.shadow.getElementById('panel');
    const n = estado.lista.length;
    const nd = devueltos().length;
    const cola = leerCola(), nl = listosDe(cola).length, nf = cola.length - nl;
    fab.innerHTML = LOGO + (n ? '<span class="b" title="Por cerrar en el SGD">' + n + '</span>' : '') + (nd ? '<span class="d" title="Rechazados que el emisor ya devolvió">' + nd + '</span>' : '') +
        (nl || nf ? '<span class="g' + (nf ? ' falla' : '') + '" title="' + nl + ' descargado(s) listos para cargar en la web' + (nf ? ' · ' + nf + ' sin descargar (ver «Descargados»)' : '') + '">' + nl + '</span>' : '');
    fab.classList.toggle('act', !!estado.plan || !!estado.corrida);
    panel.classList.toggle('open', estado.abierto || !!estado.resultado || !!estado.error || !!estado.dudaDespacho || !!estado.corrida || !!estado.dlResultado || !!estado.errorDl);
    const l0 = panel.querySelector('.lista'), top = l0 ? l0.scrollTop : 0;             // la lista conserva su posición al repintar
    const cab = '<div class="ph">' + LOGO.replace('width="40" height="40"', 'width="26" height="26"') + '<b>Cierres Waze · SGD</b><button class="dlb" data-a="dl" title="Descargar expedientes nuevos"' + (estado.plan || estado.corrida ? ' disabled' : '') + '><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v10"/><path d="M8 10l4 4 4-4"/><path d="M5 19h14"/></svg></button><button data-a="cerrar" title="Cerrar">✕</button></div>';
    const reg = '<details><summary>Registro</summary><div id="log">' + esc(lineas.slice(-60).join('\n')) + '</div><div class="acc"><button class="btn" data-a="copiar">Copiar registro</button></div></details>';
    const p = estado.plan, r = estado.resultado;
    let h;
    if (r || p) h = cab + '<div class="pb">' + (r ? resultadoHTML(r) : ejecucionHTML(p)) + reg + '</div>';
    else if (estado.corrida || estado.errorDl) h = cab + '<div class="pb">' + corridaHTML() + reg + '</div>';
    else if (estado.dlResultado) h = cab + '<div class="pb">' + resultadoDlHTML(estado.dlResultado) + reg + '</div>';
    else h = cab + listaHTML(reg);
    if (estado.toast) h += '<div class="toast">' + esc(estado.toast) + '</div>';
    panel.innerHTML = h;
    // modal de descargas: solo se vuelve a escribir si cambió (así no se pierde lo que se está tipeando)
    const mh = estado.dlModal ? modalDlHTML() : '', mod = ui.shadow.getElementById('modal');
    if (mod.dataset.h !== mh) { mod.innerHTML = mh; mod.dataset.h = mh; }
    const l1 = panel.querySelector('.lista'); if (l1) l1.scrollTop = top;
    const lg = ui.shadow.getElementById('log'); if (lg) lg.scrollTop = lg.scrollHeight;
}
// Lista: encabezado y pie fijos, la lista se desplaza. Al pulsar un expediente aparecen a su derecha ▶ (ejecutar) y ✔ (ya lo despaché).
function pestanasHTML() {
    const nd = devueltos().length;
    return '<div class="tabs"><button class="tab' + (estado.pest === 'cerrar' ? ' on' : '') + '" data-a="t-cerrar">Por cerrar <span class="n">' + estado.lista.length + '</span></button>' +
        '<button class="tab dev' + (estado.pest === 'dev' ? ' on' : '') + '" data-a="t-dev">Devueltos <span class="n' + (nd ? ' hay' : '') + '">' + nd + '</span></button>' +
        '<button class="tab des' + (estado.pest === 'des' ? ' on' : '') + '" data-a="t-des">Descargados <span class="n' + (listosDe(leerCola()).length ? ' hay' : '') + '">' + listosDe(leerCola()).length + '</span></button></div>';
}
// Pestaña «Devueltos»: rechazados que el emisor ya devolvió (están en la primera hoja de la bandeja). Cada fila es un enlace a su ficha en la web.
const resumir = (t, n) => { t = String(t).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
function devueltosHTML(reg) {
    const dv = devueltos();
    let h = '<div class="sub"><span>Rechazados que el emisor ya devolvió <b>(' + dv.length + ')</b></span><button class="btn" data-a="act-dev" title="Pedir los rechazados de nuevo a la web">↻</button></div><div class="lista">';
    if (estado.rechError) h += '<div class="av err">' + esc(estado.rechError) + '</div>';
    else if (!estado.rechazados) h += '<div class="av info">Consultando la web…</div>';
    else if (estado.bandejaEn === 'otra') h += '<div class="av info">Aquí no puedo ver la bandeja. Pulsa «Bandeja de entrada» del SGD para contar los devueltos.</div>';
    else if (estado.bandejaEn === 'vacia') h += '<div class="av info">La bandeja del SGD está vacía: pulsa «Bandeja de entrada» para contar los devueltos.</div>';
    else if (!dv.length) h += '<div class="av ok">Ningún rechazado ha vuelto a tu bandeja (primera hoja).</div>';
    else {
        h += '<div class="av warn">Pulsa uno para abrir su ficha en la web y reasignarlo.</div>';
        h += dv.map(c => '<a class="row dv" href="' + esc((estado.urlWeb || CW_DESTINOS[0].url) + '/#/cierre/' + c.id) + '" target="_blank" rel="noopener"><b>' + esc(c.exp) + '</b><span class="pill">' + esc(c.emisor || '—') + '</span>' +
            '<small>' + esc(c.evento || c.actividad || 'Sin nombre de evento') + (c.comuna ? ' · ' + esc(c.comuna) : '') + '</small><small class="mot" title="' + esc(c.motivo) + '">Rechazado: ' + esc(resumir(c.motivo || 'sin motivo registrado', 130)) + '</small><span class="go">↗</span></a>').join('');
    }
    return h + reg + '</div><div class="pie">Se abre en una pestaña nueva: ' + esc((estado.urlWeb || CW_DESTINOS[0].url).replace(/^https?:\/\//, '')) + '</div>';
}
function listaHTML(reg) {
    const sel = estado.lista.find(c => c.id === estado.sel);
    if (estado.pest === 'dev') return pestanasHTML() + devueltosHTML(reg);
    if (estado.pest === 'des') return descargadosHTML(reg);
    let h = pestanasHTML() + '<div class="sub"><span>Cargados en Waze · falta cerrar en el SGD <b>(' + estado.lista.length + ')</b></span><button class="btn" data-a="act" title="Pedir la lista de nuevo a la web">↻</button></div><div class="lista">';
    if (estado.avisoLista) h += '<div class="av err" style="margin:0 0 8px">' + esc(estado.avisoLista) + '</div>';
    if (estado.listaError) h += '<div class="av info" style="margin:0 0 8px">' + esc(estado.listaError) + '</div>';
    if (estado.cancelado) h += '<div class="av info" style="margin:0 0 8px">Cancelado. No se despachó nada; lo que ya quedó escrito en el SGD sigue ahí.</div>';
    if (!estado.lista.length && !estado.listaError) h += '<div class="av ok" style="margin:0 0 8px">No queda ningún cierre pendiente en el SGD. 🎉</div>';
    h += estado.lista.map(c => {
        const conf = estado.confirmar === c.id ? '<div class="conf"><span>¿Marcar <b>' + esc(c.exp) + '</b> como cerrado en la web, sin ejecutar nada?</span><button class="btn ok sm" data-a="si-manual" data-id="' + c.id + '">Sí</button><button class="btn sm" data-a="no-manual">No</button></div>' : '';
        return '<div class="row' + (estado.sel === c.id ? ' sel' : '') + '" data-a="fila" data-id="' + c.id + '"><b>' + esc(c.exp) + '</b><span class="pill">' + esc(c.emisor || '—') + '</span>' +
            (c.analista ? '<span class="pill ana" title="Analista asignado">' + esc(c.analista) + '</span>' : '') +
            (c.emisorNombre ? '' : '<span class="pill w">sin nombre de emisor</span>') + '<small>' + esc(c.evento) + (c.comuna ? ' · ' + esc(c.comuna) : '') + '</small><small>Emisor: ' + esc(c.emisorNombre || '—') + '</small>' +
            '<div class="ra"><button class="ib play" data-a="play" data-id="' + c.id + '" data-tip="Ejecutar los pasos en el SGD">▶</button><button class="ib hecho" data-a="hecho" data-id="' + c.id + '" data-tip="Ya lo despaché: avisar a la web">✔</button></div>' + conf + '</div>';
    }).join('');
    h += reg + '</div><div class="pie">' + (sel ? 'Seleccionado: <b>' + esc(sel.exp) + '</b>' : 'Pulsa un expediente para ver sus acciones') + '</div>';
    return h;
}
// Aviso breve dentro del panel
function aviso(t) { estado.toast = t; pintar(); setTimeout(() => { if (estado.toast === t) { estado.toast = ''; pintar(); } }, 3200); }
// ✔ «Ya lo despaché»: se avisa a la web sin ejecutar nada (por si falló la detección o hubo un error y el expediente sí se despachó)
async function marcarManual(c) {
    estado.confirmar = null; estado.avisoLista = ''; log('marcado a mano como despachado: ' + c.exp);
    const a = { id: c.id, exp: c.exp };
    const r = await enviarCerrado(a);
    if (r.status === 200) { gset(K_SENAL, { ts: Date.now(), exp: a.exp }); log('web: ' + (r.datos && r.datos.resultado) + ' ' + a.exp); estado.lista = estado.lista.filter(x => x.id !== c.id); estado.sel = null; aviso('✔ ' + a.exp + ' marcado como cerrado en la web'); cargarLista(true).catch(() => {}); }
    else if (r.status === 409 || r.status === 400) { log('la web rechazó el aviso manual: ' + JSON.stringify(r.datos || {})); estado.avisoLista = 'La web no aceptó marcar ' + a.exp + (r.datos && r.datos.esperado ? ' (esperaba ' + r.datos.esperado + ')' : ' (código ' + r.status + ')') + '. Márcalo a mano en el paso 4 de la web.'; pintar(); }
    else { const l = leerPend(); l.push({ aviso: a, ts: Date.now() }); gset(K_PEND, l.slice(-50)); estado.lista = estado.lista.filter(x => x.id !== c.id); estado.sel = null; log('sin conexión con la web: aviso guardado para reintentar'); aviso('Sin conexión: el aviso de ' + a.exp + ' quedó guardado y se reintentará solo'); }
}
function ejecucionHTML(p) {
    let h = '<h4>Ejecutando</h4><b>' + esc(p.cierre.exp) + '</b> <span class="pill">' + esc(p.cierre.emisor || '—') + '</span><small style="display:block;color:#566">' + esc(p.cierre.evento) + '</small><ol>';
    h += PASOS.map((s, i) => {
        let c = '', ic = '○';
        if (i < p.paso) { c = 'ok'; ic = '✔'; }
        else if (i === p.paso) {
            if (estado.error) { c = 'fail'; ic = '✖'; }
            else if (i === 10 && (p.fase === 'esperando' || p.fase === 'despachando')) { c = 'wait'; ic = '⏳'; }
            else { c = 'run'; ic = '▶'; }
        }
        return '<li class="' + c + '"><span class="s">' + ic + '</span><span>' + esc(s.t) + '</span></li>';
    }).join('') + '</ol>';
    if (estado.error) h += '<div class="av err"><b>Me detuve en el paso ' + (p.paso + 1) + '.</b><br>' + esc(estado.error) + '<br><small>No toqué nada más. Puedes terminar tú a mano o cerrar e intentar de nuevo. Si el expediente sí se despachó, cierra y pulsa ✔ en su fila de la lista.</small></div>';
    else if (p.fase === 'esperando') h += '<div class="av info"><b>Todo listo.</b> Revisa el SGD, pulsa <b>Despachar</b> y confirma con <b>Sí</b>. Ese clic es tuyo: yo avisaré a la web cuando lo detecte.' + (p.agregadoConfirmado === false ? '<br><b>Ojo:</b> no pude confirmar que el destinatario quedó agregado; revísalo antes de despachar.' : '') + '<div class="acc"><button class="btn" data-a="si-despache" title="Si ya despachaste y no se detectó solo">Ya lo despaché (avisar a la web)</button></div></div>';
    else if (p.fase === 'despachando' && !estado.dudaDespacho) h += '<div class="av info">Confirmaste «Sí». Espero a que el SGD termine de despachar…</div>';
    if (estado.dudaDespacho) h += '<div class="av info"><b>El SGD no cambió de página.</b> No sé si se despachó. ¿Se despachó el expediente?<div class="acc"><button class="btn play" data-a="si-despache">Sí, se despachó</button><button class="btn" data-a="no-despache">No</button></div></div>';
    h += '<div class="acc"><button class="btn red" data-a="cancelar">' + (corriendo ? 'Cancelar' : 'Cerrar') + '</button></div>';
    return h;
}
function resultadoHTML(r) {
    const ok = r.status === 200, res = r.datos && r.datos.resultado;
    let h = '';
    if (ok) h += '<div class="av ok"><b class="g">✔ Despachaste el expediente ' + esc(r.exp) + '</b><br>' + (res === 'ya_cerrado' ? 'La web ya lo tenía marcado como cerrado en el SGD.' : 'La web lo marcó como <b>cerrado en el SGD</b>: el paso 4 quedó completo.') + '</div>';
    else if (r.encolado) h += '<div class="av info"><b class="g">✔ Despachaste el expediente ' + esc(r.exp) + '</b><br>Pero no pude avisar a la web (sin conexión). El aviso quedó guardado y se reintentará solo; si prefieres, márcalo a mano en el paso 4.</div>';
    else h += '<div class="av err"><b>Despachaste, pero la web no aceptó el aviso.</b><br>' + (r.status === 409 && r.datos && r.datos.esperado ? 'La web esperaba el expediente ' + esc(r.datos.esperado) + '.' : 'Código ' + r.status + '.') + ' Márcalo a mano en el paso 4 de la web.</div>';
    if (ok && r.agregadoConfirmado === false) h += '<div class="av info">Recuerda que no pude confirmar el destinatario antes de despachar.</div>';
    h += '<div class="acc"><button class="btn" data-a="cerrar-res">Entendido</button></div>';
    return h;
}

// ─── Arranque ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// ─── Descargas (v1.3): emisores a buscar, corrida de descarga y vistas ──────────────────────────────────────────────────────────
const leerEmisores = () => { const v = gget(K_EMI, null); return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()) : null; };
const guardarEmisores = l => gset(K_EMI, l);
// la columna «Emisor» trae «NOMBRE - CARGO - UNIDAD»: el nombre se compara solo con la parte de la persona
const nombreEmisorFila = t => String(t || '').split(' - ')[0].trim();
const coincideEmisor = (t, lista) => { const pal = norm(nombreEmisorFila(t)).split(' ').filter(Boolean); return lista.some(n => { const pa = norm(n).split(' ').filter(Boolean); return pa.length > 0 && pa.every(w => pal.includes(w)); }); };

async function traerEmisoresWeb(reemplazar) {
    estado.emiBuscando = true; estado.emiError = ''; pintar();
    const r = await pedir('/api/extension/sgd/emisores', {});
    estado.emiBuscando = false;
    if (r.status === 200 && r.datos && Array.isArray(r.datos.emisores)) {
        const nombres = r.datos.emisores.map(e => String(e.nombre || '').trim()).filter(Boolean);
        const sal = reemplazar ? [] : (leerEmisores() || []).slice();
        nombres.forEach(n => { if (!sal.some(x => norm(x) === norm(n))) sal.push(n); });
        guardarEmisores(sal);
        if (!nombres.length) estado.emiError = 'La web no tiene emisores con nombre. Agrégalos a mano.';
    } else {
        estado.emiError = r.status === 404 || r.status === 401 ? 'La web todavía no tiene esta función (falta publicarla). Agrega los emisores a mano.' : 'No pude hablar con la web' + (r.status ? ' (código ' + r.status + ')' : '') + '. Agrega los emisores a mano o reintenta.';
    }
    pintar();
}
async function abrirModalDl() {
    if (estado.plan || estado.corrida) return;
    estado.dlModal = 'inicio'; estado.emiError = ''; estado.emiConfirmaWeb = false; estado.abierto = true; pintar();
    if (leerEmisores() === null) { await traerEmisoresWeb(false); }
}
function abrirEnWeb(exp) {
    if (!leerCola().some(x => x.exp === exp && x.estado === 'listo')) { aviso('Esa copia ya no está en la lista.'); return; }
    gset(K_ABRIR, { exp, ts: Date.now() });
    const url = (estado.urlWeb || CW_DESTINOS[0].url) + '/#/nuevo';
    try { GM_openInTab(url, { active: true, insert: true }); } catch (e) { try { window.open(url, '_blank', 'noopener'); } catch (x) { /* nada */ } }
    aviso('Abriendo la web con ' + exp + '…');
}
function reintentarDes(exp) {
    const it = leerCola().find(x => x.exp === exp); if (!it) return;
    estado.pest = 'des'; iniciarCorrida([{ exp, emisor: it.emisor || '', intentos: 0 }], true);
}
function cerrarErrorDl() {
    const c = leerCorrida();
    if (c && c.fase === 'bajar') { while (c.i < c.cand.length) { registrarFallo(c, c.cand[c.i], 'No se llegó a descargar (la descarga se detuvo)'); } }
    estado.errorDl = ''; borrarCorrida(); pintar();
}
function dlAccion(a, t) {
    switch (a) {
    case 'dl': abrirModalDl(); return true;
    case 'dl-cancelar': estado.dlModal = null; estado.emiConfirmaWeb = false; pintar(); return true;
    case 'dl-ir': { if (!(leerEmisores() || []).length) return true; estado.dlModal = null; iniciarCorrida([], false); return true; }
    case 'emi-config': estado.dlModal = 'config'; estado.emiEdit = -1; estado.emiError = ''; pintar(); return true;
    case 'emi-listo': estado.dlModal = 'inicio'; estado.emiEdit = -1; estado.emiError = ''; estado.emiConfirmaWeb = false; pintar(); return true;
    case 'emi-edit': estado.emiEdit = Number(t.dataset.i); estado.emiError = ''; pintar(); setTimeout(() => { const i = ui.shadow.getElementById('emi-inp'); if (i) { i.focus(); i.select(); } }, 30); return true;
    case 'emi-ok': {
        const i = Number(t.dataset.i), inp = ui.shadow.getElementById('emi-inp'), v = inp ? inp.value.trim() : '', l = (leerEmisores() || []).slice();
        if (!v) { estado.emiError = 'El nombre no puede quedar vacío.'; pintar(); return true; }
        if (l.some((x, k) => k !== i && norm(x) === norm(v))) { estado.emiError = 'Ese nombre ya está en la lista.'; pintar(); return true; }
        l[i] = v; guardarEmisores(l); estado.emiEdit = -1; estado.emiError = ''; pintar(); return true;
    }
    case 'emi-del': { const l = (leerEmisores() || []).slice(); l.splice(Number(t.dataset.i), 1); guardarEmisores(l); estado.emiEdit = -1; estado.emiError = ''; pintar(); return true; }
    case 'emi-add': {
        const inp = ui.shadow.getElementById('emi-nuevo'), v = inp ? inp.value.trim() : '', l = (leerEmisores() || []).slice();
        if (!v) { return true; }
        if (l.some(x => norm(x) === norm(v))) { estado.emiError = 'Ese nombre ya está en la lista.'; pintar(); return true; }
        l.push(v); guardarEmisores(l); estado.emiError = ''; pintar(); return true;
    }
    case 'emi-web': estado.emiConfirmaWeb = true; pintar(); return true;
    case 'emi-web-no': estado.emiConfirmaWeb = false; pintar(); return true;
    case 'emi-web-si': estado.emiConfirmaWeb = false; traerEmisoresWeb(true); return true;
    case 't-des': estado.pest = 'des'; pintar(); return true;
    case 'fila-des': estado.selDes = t.dataset.exp; estado.confirmarDes = null; pintar(); return true;
    case 'abrir-web': abrirEnWeb(t.dataset.exp); return true;
    case 'quitar-des': estado.selDes = t.dataset.exp; estado.confirmarDes = t.dataset.exp; pintar(); return true;
    case 'si-quitar': quitarDeCola(t.dataset.exp); estado.confirmarDes = null; estado.selDes = null; aviso('Quitado de la lista'); return true;
    case 'no-quitar': estado.confirmarDes = null; pintar(); return true;
    case 'reintentar': reintentarDes(t.dataset.exp); return true;
    case 'dl-detener': detenerCorrida(); return true;
    case 'dl-cerrar': if (estado.errorDl) { cerrarErrorDl(); } else { estado.dlResultado = null; pintar(); } return true;
    case 'dl-ver': estado.dlResultado = null; estado.pest = 'des'; estado.abierto = true; pintar(); return true;
    }
    return false;
}

// La descarga en curso se guarda entre páginas (el SGD recarga la página al abrir cada expediente y al volver a la bandeja)
const leerCorrida = () => { const c = gget(K_CORRIDA, null); return c && c.fase && Date.now() - (c.ts || 0) < 40 * 60 * 1000 ? c : null; };
const guardarCorrida = c => { c.ts = Date.now(); gset(K_CORRIDA, c); estado.corrida = c; };
const borrarCorrida = () => { gdel(K_CORRIDA); estado.corrida = null; estado.lento = null; soltarMarcas(); };

function irABandeja(c) {
    const m = byId(SEL.menuBandeja); if (!m) throw new Parar('No encontré el menú «Bandeja de entrada». Abre la bandeja de entrada del SGD y vuelve a pulsar ⬇.');
    guardarCorrida(c); log('se va a la bandeja de entrada'); m.click();
    setTimeout(() => { const q = leerCorrida(); if (q && !q.error && pagina() !== 'bandeja' && !corriendo) { q.error = 'El menú «Bandeja de entrada» no cambió de página en 25 s.'; gset(K_CORRIDA, q); estado.errorDl = q.error; pintar(); } }, 25000);
    return 'nav';
}
function iniciarCorrida(cand, reintento) {
    if (corriendo || estado.plan || estado.corrida) return;
    estado.errorDl = ''; estado.dlResultado = null; estado.abierto = true; estado.cancelar = false; estado.confirmarDes = null;
    const c = { fase: reintento ? 'bajar' : 'buscar', cand: cand || [], i: 0, omitidosDev: 0, yaListos: 0, paginas: 0, ok: [], fallo: [], reintento: !!reintento, intentosBandeja: 0 };
    guardarCorrida(c); log('=== descarga de expedientes ' + (reintento ? '(reintento) ' : 'nuevos ') + '(extensión SGD ' + VERSION + ')'); pintar();
    if (pagina() !== 'bandeja') { try { irABandeja(c); } catch (e) { c.error = e.message; guardarCorrida(c); estado.errorDl = e.message; pintar(); } return; }
    continuarCorrida();
}
function detenerCorrida() {
    if (corriendo) { estado.cancelar = true; pintar(); return; }
    finCorrida(leerCorrida(), true);
}
function registrarFallo(c, it, motivo) {
    const cola = leerCola().filter(x => x.exp !== it.exp); pdfBorrar(it.exp);
    cola.push({ exp: it.exp, emisor: it.emisor || '', estado: 'fallo', motivo, ts: Date.now() }); guardarCola(cola);
    c.fallo.push({ exp: it.exp, motivo }); c.i++; guardarCorrida(c); log('NO descargado ' + it.exp + ': ' + motivo);
}
// un fallo se reintenta una vez; si vuelve a fallar queda en rojo y se sigue con el siguiente
function fallaItem(c, it, motivo) {
    if ((it.intentos || 0) < 1) { it.intentos = 1; guardarCorrida(c); log('falló ' + it.exp + ' (' + motivo + '): se reintenta una vez'); return 'reintentar'; }
    registrarFallo(c, it, motivo); return 'fallo';
}
function finCorrida(c, detenido) {
    if (c && detenido) { while (c.i < c.cand.length) { registrarFallo(c, c.cand[c.i], 'Detenido antes de descargarlo'); } }
    const res = { total: c ? c.cand.length : 0, ok: c ? c.ok.length : 0, fallo: c ? c.fallo.slice() : [], omitidos: c ? c.omitidosDev : 0, yaListos: c ? c.yaListos : 0, detenido: !!detenido, reintento: !!(c && c.reintento) };
    borrarCorrida(); estado.dlResultado = res; estado.abierto = true; if (res.ok || res.fallo.length) { estado.pest = 'des'; }
    log('fin de la descarga: ' + res.ok + ' de ' + res.total + (res.fallo.length ? ' · fallidos ' + res.fallo.length : '') + (detenido ? ' · detenida' : '')); pintar();
}

// Filas de la bandeja: número de expediente, si es NO LEÍDO (el SGD marca la celda con la clase «noleido») y el texto de la columna «Emisor»
const colEmisor = () => { const t = byId(SEL.tablaBandeja); const th = t && [...t.querySelectorAll('th')].find(x => /^emisor\b/i.test(txt(x))); return th ? [...th.parentElement.children].indexOf(th) : -1; };
function leerFilasBandeja() {
    const ce = colEmisor();
    return filasBandeja().map(tr => {
        const tds = [...tr.children], tdExp = tds.find(c => /^E?\d+\/\d{4}$/i.test(txt(c)));
        if (!tdExp) return null;
        let tdEm = ce >= 0 ? tds[ce] : null;
        if (!tdEm || !/ - /.test(txt(tdEm))) tdEm = tds[tds.length - 6] || tdEm;          // por si el encabezado no calzó con las columnas
        return { exp: txt(tdExp).toUpperCase(), nuevo: tds.some(c => c.classList.contains('noleido')), emisorTxt: txt(tdEm) };
    }).filter(Boolean);
}
const botonSiguiente = () => [...document.querySelectorAll('.rich-datascr-button')].find(b => txt(b) === '»' && !/dsbld/.test(b.className)) || null;
async function irPagina(btn, filas) {
    const antes = filas.map(f => f.exp).join(',');
    btn.click();
    await esperar(() => { const n = leerFilasBandeja().map(f => f.exp).join(','); return n && n !== antes; }, 60000, 'la hoja siguiente de la bandeja');
    await estable(() => leerFilasBandeja().map(f => f.exp).join(','), 800, 6000);
}
// La bandeja no se llena sola si se entra directo: si no hay filas, se pulsa «Bandeja de entrada» del menú (hasta 2 veces)
async function asegurarBandeja(c) {
    const tab = await esperar(() => pestana('Entrada'), 6000, 'la pestaña «Entrada»').catch(e => { if (e.message === '__cancelado__') throw e; return null; });
    if (tab && /rich-tab-inactive/.test(tab.className)) { tab.click(); await sleep(800); }
    let n = 0; try { n = await esperar(() => filasBandeja().length, 25000, 'las filas de la bandeja'); } catch (e) { if (e.message === '__cancelado__') throw e; n = 0; }
    if (!n) {
        if ((c.intentosBandeja || 0) >= 2) throw new Parar('La bandeja de entrada está vacía o no cargó.');
        c.intentosBandeja = (c.intentosBandeja || 0) + 1; return irABandeja(c);
    }
    if (c.intentosBandeja) { c.intentosBandeja = 0; guardarCorrida(c); }
    return null;
}

async function pasoBuscar(c) {
    const prep = await asegurarBandeja(c); if (prep === 'nav') return 'nav';
    const emi = leerEmisores() || [];
    if (!emi.length) throw new Parar('No hay emisores en la lista. Pulsa ⬇, luego ⚙, y agrega al menos uno.');
    const t = byId(SEL.tablaBandeja);
    if (t && [...t.querySelectorAll('input.rich-filter-input')].some(i => i.value.trim())) throw new Parar('La bandeja tiene un filtro escrito. Bórralo y vuelve a pulsar ⬇.');
    await cargarRechazados();
    if (!estado.rechazados) throw new Parar('No pude pedir a la web la lista de devueltos, así que no sé cuáles omitir. ' + (estado.rechError || '') + ' Reintenta en un momento.');
    const devueltos = new Set(estado.rechazados.map(r => String(r.exp).toUpperCase())), yaListos = new Set(listosDe(leerCola()).map(x => x.exp));
    const cand = [], vistos = new Set(); let omit = 0, ya = 0, pag = 0;
    for (;;) {
        pag++; c.paginas = pag; guardarCorrida(c); pintar();
        const filas = leerFilasBandeja();
        for (const f of filas) {
            if (!f.nuevo || !coincideEmisor(f.emisorTxt, emi) || vistos.has(f.exp)) continue;
            vistos.add(f.exp);
            if (devueltos.has(f.exp)) { omit++; continue; }
            if (yaListos.has(f.exp)) { ya++; continue; }
            cand.push({ exp: f.exp, emisor: nombreEmisorFila(f.emisorTxt), intentos: 0 });
        }
        // si la hoja viene completa de nuevos puede haber más en la siguiente; en cuanto hay una fila ya leída, se termina
        if (!filas.length || !filas.every(f => f.nuevo) || pag >= 20) break;
        const sig = botonSiguiente(); if (!sig) break;
        log('la hoja ' + pag + ' viene completa de nuevos: se revisa la siguiente');
        await irPagina(sig, filas);
    }
    c.cand = cand; c.omitidosDev = omit; c.yaListos = ya; c.i = 0; c.fase = 'bajar'; guardarCorrida(c);
    log('nuevos de tus emisores: ' + cand.length + ' · devueltos omitidos: ' + omit + (ya ? ' · ya descargados: ' + ya : ''));
    if (!cand.length) { finCorrida(c, false); return 'fin'; }
    return 'sigue';
}

async function pasoAbrir(c, it) {
    const prep = await asegurarBandeja(c); if (prep === 'nav') return 'nav';
    try {
        log('abriendo ' + it.exp + ' (' + (c.i + 1) + ' de ' + c.cand.length + ')'); pintar();
        const inp = await esperar(filtroExpediente, 60000, 'el cuadro para filtrar por Expediente');
        inp.focus();
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        set.call(inp, ''); set.call(inp, it.exp);
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: '0', keyCode: 48, which: 48 }));
        await sleep(400);
        const estadoTabla = () => { const f = filasBandeja(); return f.length + '|' + f.filter(tr => celdaTiene(tr, it.exp)).length; };
        await esperar(() => { const [n, e] = estadoTabla().split('|').map(Number); return n > 0 && n === e; }, 60000, 'la tabla filtrada con el expediente ' + it.exp);
        await estable(estadoTabla, 1000, 6000);
        const ex = filasBandeja().filter(tr => celdaTiene(tr, it.exp));
        if (ex.length !== 1) throw new Parar(ex.length ? 'Hay ' + ex.length + ' filas con el expediente ' + it.exp + ' y espero una sola.' : 'El filtro no dejó el expediente ' + it.exp + '.');
        const a = ex[0].querySelector('a[title="Ver Expediente"]');
        c.paso = 'ver'; guardarCorrida(c); log('se abre ' + it.exp + ' (el SGD tarda unos segundos)'); a.click();
        // si el SGD no cambia de página en 70 s, este expediente se da por fallido (se reintenta una vez)
        const idx = c.i;
        setTimeout(() => { const q = leerCorrida(); if (q && !q.error && !corriendo && pagina() === 'bandeja' && q.i === idx && q.paso === 'ver') { fallaItem(q, q.cand[q.i], 'El SGD no abrió el expediente en 70 s'); continuarCorrida(); } }, 70000);
        return 'nav';
    } catch (e) {
        if (e && e.message === '__cancelado__') throw e;
        return fallaItem(c, it, (e && e.message) || String(e));
    }
}

// Pide el PDF con el mismo envío del formulario que hace el icono «Ver archivo» (el SGD lo devuelve como archivo adjunto)
async function pedirPdf(form, idEnlace) {
    const p = new URLSearchParams();
    for (const e of form.elements) {
        if (!e.name || e.disabled || e.type === 'button' || e.type === 'submit' || e.type === 'file' || e.type === 'image') continue;
        if ((e.type === 'checkbox' || e.type === 'radio') && !e.checked) continue;
        if (e.tagName === 'SELECT' && e.multiple) { [...e.selectedOptions].forEach(o => p.append(e.name, o.value)); continue; }
        p.append(e.name, e.value);
    }
    p.append(form.id + ':j_idcl', idEnlace);
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 60000);
    let r, buf;
    try {
        r = await fetch(new URL(form.getAttribute('action') || location.href, location.href).href, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: p, signal: ctl.signal });
        buf = await r.arrayBuffer();
    } catch (e) { throw new Parar('El SGD no respondió al pedir el PDF' + (e && e.name === 'AbortError' ? ' (más de 60 s)' : '') + '.'); } finally { clearTimeout(tm); }
    if (r.status !== 200) throw new Parar('El SGD respondió con el código ' + r.status + ' al pedir el PDF.');
    const u = new Uint8Array(buf);
    if (!(u.length > 4 && String.fromCharCode(u[0], u[1], u[2], u[3], u[4]) === '%PDF-')) throw new Parar('El SGD no devolvió un PDF (tipo «' + ((r.headers.get('content-type') || 'desconocido').split(';')[0]) + '»).');
    if (u.length > 9 * 1024 * 1024) throw new Parar('El PDF pesa ' + Math.round(u.length / 1048576) + ' MB: es demasiado grande para guardar la copia.');
    return { buf, cd: r.headers.get('content-disposition') || '' };
}
function nombreArchivo(cd, exp) {
    let n = ''; const m1 = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(cd), m2 = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
    try { n = m1 ? decodeURIComponent(m1[1]) : (m2 ? m2[1] : ''); } catch (e) { n = m2 ? m2[1] : ''; }
    n = n.trim().replace(/[\\/:*?"<>|]/g, '_');
    if (!n) n = exp.replace(/\//g, '-') + '.pdf';
    return /\.pdf$/i.test(n) ? n : n + '.pdf';
}
async function pasoDescargar(c, it) {
    try {
        await esperar(() => byId(SEL.comentario), 60000, 'la página del expediente');
        const e = await esperar(expedienteDePagina, 30000, 'el número del expediente en la página');
        if (e.toLowerCase() !== it.exp.toLowerCase()) throw new Parar('Se abrió el expediente ' + e + ' y yo buscaba ' + it.exp + '.');
        const tabla = [...document.querySelectorAll('table')].find(t => /:tableDocumentos$/.test(t.id));
        if (!tabla) throw new Parar('No encontré la tabla «Documentos en trámite».');
        const trs = [...tabla.querySelectorAll(':scope > tbody > tr')].filter(tr => tr.children.length > 3), ult = trs[trs.length - 1];
        if (!ult) throw new Parar('«Documentos en trámite» no tiene filas.');
        const a = [...ult.querySelectorAll('a')].find(x => x.title === 'Ver archivo');
        if (!a) throw new Parar('La última fila de «Documentos en trámite» no tiene el icono «Ver archivo».');
        const form = tabla.closest('form'); if (!form) throw new Parar('No encontré el formulario de los documentos.');
        // resumen de la fila (mejor esfuerzo): tipo y número del documento, para mostrarlo en la lista
        const hdr = [...tabla.querySelectorAll('thead th')].map(th => norm(txt(th))), cel = [...ult.children].map(td => txt(td));
        const col = s => hdr.findIndex(h => h.includes(s));
        const doc = [cel[col('tipo')], cel[col('interno')]].filter(x => x && x.toLowerCase() !== 's/n').join(' ');
        log('pidiendo el PDF de la última fila de ' + it.exp);
        const pdf = await pedirPdf(form, a.id);
        const nombre = nombreArchivo(pdf.cd, it.exp), cola = leerCola().filter(x => x.exp !== it.exp);
        const archivo = cola.some(x => x.estado === 'listo' && x.archivo === nombre) ? it.exp.replace(/\//g, '-') + ' · ' + nombre : nombre;   // nombre repetido: se antepone el expediente
        gset(K_PDF + claveExp(it.exp), aBase64(pdf.buf));
        if (!pdfLeer(it.exp)) throw new Parar('No se pudo guardar la copia del PDF en Tampermonkey (¿falta espacio?).');
        cola.push({ exp: it.exp, emisor: it.emisor || '', archivo, kb: Math.round(pdf.buf.byteLength / 1024), doc, estado: 'listo', ts: Date.now() });
        guardarCola(cola);
        c.ok.push(it.exp); c.fallo = c.fallo.filter(x => x.exp !== it.exp); c.i++; guardarCorrida(c);
        log('descargado ' + it.exp + ' → ' + archivo + ' (' + Math.round(pdf.buf.byteLength / 1024) + ' KB)');
    } catch (e) {
        if (e && e.message === '__cancelado__') throw e;
        fallaItem(c, it, (e && e.message) || String(e));
    }
    return irABandeja(c);          // siempre se vuelve a la bandeja: sigue el siguiente o termina
}

async function continuarCorrida() {
    if (corriendo) return; corriendo = true;
    try {
        for (;;) {
            const c = leerCorrida(); if (!c || c.error) break;
            if (cancelado()) throw new Parar('__cancelado__');
            const pg = pagina();
            if (c.fase === 'buscar') {
                if (pg !== 'bandeja') { if (Date.now() - c.ts < 60000) break; throw new Parar('Estoy en una página que no es la bandeja de entrada. Abre la bandeja y vuelve a pulsar ⬇.'); }
                if (await pasoBuscar(c) === 'nav') break; continue;
            }
            if (c.fase === 'bajar') {
                if (c.i >= c.cand.length) { finCorrida(c, false); break; }
                const it = c.cand[c.i];
                if (pg === 'bandeja') { if (await pasoAbrir(c, it) === 'nav') break; }
                else if (pg === 'ver') { if (await pasoDescargar(c, it) === 'nav') break; }
                else { if (Date.now() - c.ts < 60000) break; throw new Parar('Estoy en una página que no es la bandeja ni «Ver expediente».'); }
                continue;
            }
            break;
        }
    } catch (e) {
        if (e && e.message === '__cancelado__') { log('descarga detenida por el usuario'); finCorrida(leerCorrida(), true); }
        else { const c = leerCorrida(), m = (e && e.message) || String(e); log('ERROR descarga: ' + m); soltarMarcas(); if (c) { c.error = m; gset(K_CORRIDA, c); } estado.errorDl = m; }
    } finally { corriendo = false; estado.cancelar = false; pintar(); }
}

// ─── Vistas de las descargas ──────────────────────────────────────────────────────────────────────────────────────────────────
function modalDlHTML() {
    const emi = leerEmisores() || [];
    const avisos = (estado.emiError ? '<div class="av err" style="margin:0 0 8px">' + esc(estado.emiError) + '</div>' : '') + (estado.emiBuscando ? '<div class="av info" style="margin:0 0 8px">Pidiendo la lista a la web…</div>' : '');
    if (estado.dlModal === 'config') {
        return '<div class="mbg"><div class="modal"><div class="mh">⚙ Emisores a buscar</div><div class="mb">' + avisos + '<ul class="em">' +
            emi.map((n, i) => estado.emiEdit === i
                ? '<li style="border-color:#2196f3;background:#f2f8ff"><input class="inp" id="emi-inp" value="' + esc(n) + '"><button class="btn ok sm" data-a="emi-ok" data-i="' + i + '">OK</button></li>'
                : '<li><span class="nm">' + esc(n) + '</span><button class="ic" data-a="emi-edit" data-i="' + i + '" title="Editar">✎</button><button class="ic" data-a="emi-del" data-i="' + i + '" title="Quitar">🗑</button></li>').join('') +
            (emi.length ? '' : '<li><span class="nm" style="color:#667">Sin emisores: agrega al menos uno.</span></li>') + '</ul>' +
            '<div style="display:flex;gap:6px;margin-top:8px"><input class="inp" id="emi-nuevo" placeholder="Nombre como aparece en el SGD…" autocomplete="off"><button class="btn play sm" data-a="emi-add">+ Agregar</button></div>' +
            '<div class="av warn2" style="margin-top:10px">El nombre debe coincidir con la columna «Emisor» del SGD. Da igual mayúsculas y tildes; basta con nombre y apellido.</div>' +
            (estado.emiConfirmaWeb ? '<div class="av info">Esto <b>reemplaza tu lista</b> por la de la web. ¿Seguir? <button class="btn ok sm" data-a="emi-web-si">Sí</button> <button class="btn sm" data-a="emi-web-no">No</button></div>' : '<button class="lnk" data-a="emi-web">↺ Volver a traer la lista desde la web</button>') +
            '</div><div class="mf"><button class="btn play" data-a="emi-listo">Listo</button></div></div></div>';
    }
    return '<div class="mbg"><div class="modal"><div class="mh">⬇ Descargar expedientes nuevos<button class="eng" data-a="emi-config" title="Configurar emisores">⚙</button></div><div class="mb">' +
        '<p style="margin:0 0 8px;font-size:13px;line-height:1.45">Voy a buscar en tu <b>bandeja de entrada</b> los expedientes <b>nuevos (no leídos)</b> enviados por:</p>' + avisos +
        '<ul class="em">' + emi.map(n => '<li>👤<span class="nm">' + esc(n) + '</span></li>').join('') + (emi.length ? '' : '<li><span class="nm" style="color:#667">Sin emisores. Pulsa ⚙ para agregarlos.</span></li>') + '</ul>' +
        '<div class="av info">Se omiten los <b>devueltos</b> (rechazados que ya volvieron). Cada expediente se abre, así que el SGD los marcará como leídos. Los PDF quedan como copia dentro de la extensión, no en tu disco.</div></div>' +
        '<div class="mf"><button class="btn" data-a="dl-cancelar">Cancelar</button><button class="btn play" data-a="dl-ir"' + (emi.length ? '' : ' disabled') + '>Buscar y descargar</button></div></div></div>';
}
function corridaHTML() {
    const c = estado.corrida;
    if (estado.errorDl) return '<div class="av err"><b>Me detuve.</b><br>' + esc(estado.errorDl) + '<br><small>Lo que ya se descargó quedó guardado en «Descargados». Los que faltaron quedarán en rojo para reintentar.</small></div><div class="acc"><button class="btn" data-a="dl-cerrar">Cerrar</button></div>';
    if (!c) return '';
    let h = '<h4>Descargando expedientes nuevos</h4>';
    if (c.fase === 'buscar') {
        h += '<b>Buscando en la bandeja…</b><small style="display:block;color:#566">' + (c.paginas ? 'Hoja ' + c.paginas + ' · ' : '') + 'pidiendo los devueltos a la web y revisando las filas no leídas</small><div class="bar"><i style="width:8%"></i></div>';
    } else {
        const n = c.cand.length, i = Math.min(c.i, n);
        h += '<b>' + (c.reintento ? 'Reintentando la descarga' : 'Hoja de la bandeja · ' + n + ' nuevos de tus emisores') + '</b>' + (c.omitidosDev ? '<small style="display:block;color:#566">Omitidos por estar devueltos: ' + c.omitidosDev + '</small>' : '') +
            '<div class="bar"><i style="width:' + (n ? Math.round(i / n * 100) : 0) + '%"></i></div><small style="color:#566">' + Math.min(i + 1, n) + ' de ' + n + (c.cand[c.i] ? ' · ' + esc(c.cand[c.i].exp) : '') + (c.fallo.length ? ' · fallidos: ' + c.fallo.length : '') + '</small>';
    }
    if (estado.lento) h += '<div class="av warn2">⏳ El SGD está lento: sigo esperando (' + estado.lento.s + ' s de ' + estado.lento.max + ' s). Si no responde, lo reintento una vez y, si vuelve a fallar, lo dejo en rojo y sigo con el siguiente.</div>';
    const f = c.fase === 'buscar' ? 1 : 2;
    h += '<ol>' + [['Pedir los devueltos a la web y leer la bandeja', 1], ['Abrir cada expediente, tomar el PDF de la última fila y volver', 2], ['Resumen', 3]].map(([t, k]) => '<li class="' + (k < f ? 'ok' : k === f ? 'run' : '') + '"><span class="s">' + (k < f ? '✔' : k === f ? '▶' : '○') + '</span><span>' + t + '</span></li>').join('') + '</ol>';
    h += '<div class="acc"><button class="btn red" data-a="dl-detener">' + (estado.cancelar ? 'Deteniendo…' : 'Detener') + '</button></div>';
    return h;
}
function resultadoDlHTML(r) {
    let h = '';
    if (!r.total) h += '<div class="av info"><b>No hay expedientes nuevos de tus emisores.</b>' + (r.omitidos ? '<br>' + r.omitidos + ' devuelto(s) omitido(s) (no cuentan).' : '') + (r.yaListos ? '<br>' + r.yaListos + ' ya estaban descargados.' : '') + '</div>';
    else h += '<div class="av ' + (r.fallo.length || r.detenido ? 'info' : 'ok') + '"><b>' + (r.detenido ? 'Descarga detenida: ' : '✔ ') + r.ok + ' de ' + r.total + ' descargados</b>' + (r.omitidos ? '<br>' + r.omitidos + ' devuelto(s) omitido(s) (no cuentan).' : '') + (r.yaListos ? '<br>' + r.yaListos + ' ya estaban descargados.' : '') + '</div>';
    if (r.fallo.length) h += '<div class="av err"><b>' + r.fallo.length + ' no se pudo descargar</b>' + r.fallo.slice(0, 6).map(f => '<br>' + esc(f.exp) + ' · ' + esc(f.motivo)).join('') + (r.fallo.length > 6 ? '<br>…' : '') + '<br><small>Quedaron en rojo en «Descargados» para reintentar.</small></div>';
    h += '<div class="acc">' + (r.ok || r.fallo.length ? '<button class="btn play" data-a="dl-ver">Ver Descargados</button>' : '') + '<button class="btn" data-a="dl-cerrar">Entendido</button></div>';
    return h;
}
function descargadosHTML(reg) {
    const cola = leerCola(), listos = listosDe(cola), fallos = cola.filter(x => x.estado !== 'listo');
    const conf = c => estado.confirmarDes === c.exp ? '<div class="conf"><span>¿Quitar <b>' + esc(c.exp) + '</b> de la lista? Se borra su copia.</span><button class="btn ok sm" data-a="si-quitar" data-exp="' + esc(c.exp) + '">Sí</button><button class="btn sm" data-a="no-quitar">No</button></div>' : '';
    let h = pestanasHTML() + '<div class="sub"><span>Listos para cargar en la web <b>(' + listos.length + ')</b>' + (fallos.length ? ' · <b class="rojo">Falta (' + fallos.length + ')</b>' : '') + '</span><button class="btn" data-a="dl" title="Buscar expedientes nuevos en la bandeja">Buscar más</button></div><div class="lista">';
    if (!cola.length) h += '<div class="av info" style="margin:0 0 8px">Nada descargado todavía. Pulsa el icono de descarga ⬇ del encabezado.</div>';
    h += listos.map(c => '<div class="row des' + (estado.selDes === c.exp ? ' sel' : '') + '" data-a="fila-des" data-exp="' + esc(c.exp) + '"><b>' + esc(c.exp) + '</b><span class="pill">' + esc(c.emisor || '—') + '</span>' +
        '<small>' + esc(c.doc || '') + '</small><small>' + esc(c.archivo || '') + (c.kb ? ' · ' + c.kb + ' KB' : '') + '</small>' +
        '<div class="ra"><button class="ib go" data-a="abrir-web" data-exp="' + esc(c.exp) + '" data-tip="Abrir en la web">▶</button><button class="ib x" data-a="quitar-des" data-exp="' + esc(c.exp) + '" data-tip="Quitar de la lista">✕</button></div>' + conf(c) + '</div>').join('');
    h += fallos.map(c => '<div class="row fail" data-a="fila-des" data-exp="' + esc(c.exp) + '"><b>' + esc(c.exp) + '</b><span class="pill r">no descargado</span><small class="mot">' + esc(c.motivo || 'No se pudo descargar') + '</small>' +
        '<div class="ra"><button class="ib re" data-a="reintentar" data-exp="' + esc(c.exp) + '" data-tip="Reintentar">↻</button><button class="ib x" data-a="quitar-des" data-exp="' + esc(c.exp) + '" data-tip="Quitar de la lista">✕</button></div>' + conf(c) + '</div>').join('');
    return h + reg + '</div><div class="pie">' + (listos.length ? 'Pulsa un expediente y luego ▶ para cargarlo en la web' : 'Las copias viven en Tampermonkey y se borran al guardar el expediente en la web') + '</div>';
}

(async function iniciar() {
    montar(); pintar();
    setTimeout(() => { reintentarPendientes().catch(e => log('reintento: ' + e.message)); }, 4000);
    const corridaPrev = leerCorrida();                          // durante una descarga cada página nueva no vuelve a pedir nada a la web
    if (typeof GM_addValueChangeListener === 'function') { GM_addValueChangeListener(K_COLA, () => { pintar(); }); }
    if (!corridaPrev) cargarLista(false).then(l => { if (l) { estado.lista = l; pintar(); } }).catch(() => {});
    // devueltos: se pide la lista de rechazados a la web y se vigila la bandeja (la lista de la bandeja aparece cuando el usuario pulsa «Bandeja de entrada»)
    let pidiendo = false;
    const pedirRechazados = () => { if (pidiendo) return; pidiendo = true; cargarRechazados().catch(() => {}).then(() => { pidiendo = false; }); };
    if (!corridaPrev) pedirRechazados();
    setInterval(() => { recontar(false); if (!estado.plan && !estado.corrida && Date.now() - estado.rechTs > 3 * 60 * 1000) pedirRechazados(); }, 1500);
    // si había una descarga en curso (el SGD cambió de página), se retoma donde iba; si se detuvo por un error, no se reintenta sola
    if (corridaPrev) {
        estado.corrida = corridaPrev; estado.abierto = true;
        if (corridaPrev.error) { estado.errorDl = corridaPrev.error; pintar(); return; }
        pintar(); log('se retoma la descarga (fase ' + corridaPrev.fase + ', ' + (corridaPrev.i || 0) + ' de ' + corridaPrev.cand.length + ', página ' + pagina() + ')');
        await continuarCorrida(); return;
    }
    if (gget(K_CORRIDA, null)) gdel(K_CORRIDA);
    const p = leerPlan();
    if (!p) { if (gget(K_PLAN, null)) gdel(K_PLAN); return; }
    estado.plan = p; estado.abierto = true;
    if (p.detenido) { estado.error = p.error || 'El plan se detuvo.'; estado.pasoError = p.paso; pintar(); return; }       // se detuvo por un error: no se reintenta solo al recargar
    pintar();
    log('se retoma el plan de ' + p.cierre.exp + ' (paso ' + (p.paso + 1) + ', fase ' + p.fase + ', página ' + pagina() + ')');
    if (p.fase === 'despachando') { armarDespacho(); await vigilarDespacho(); return; }
    if (p.fase === 'esperando') {
        if (pagina() === 'ver' && expedienteDePagina().toLowerCase() === p.cierre.exp.toLowerCase()) { armarDespacho(); marcar(byId(SEL.despachar), 'espera'); }
        else if (pagina() !== 'ver' && p.pulso && Date.now() - p.pulso < 20 * 60 * 1000) {
            // el usuario pulsó «Despachar» y el SGD lo sacó de la página: si muestra «Expediente despachado», se da por hecho
            for (let i = 0; i < 20 && !hayMensajeDespachado(); i++) await sleep(400);
            if (hayMensajeDespachado()) { log('el SGD muestra «Expediente despachado»'); await despachoListo(p); }
            else log('después de «Despachar» el SGD cambió de página pero no muestra «Expediente despachado»: queda esperando');
        }
        return;
    }
    await continuar();
})().catch(e => { try { log('inicio: ' + e.message); } catch (x) { /* nada */ } });

})();
