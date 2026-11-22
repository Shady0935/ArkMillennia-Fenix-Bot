// Authentication and navigation are provided by dashboard/.
const BASE = '/extensions/anuncios', KEY = 'millenniafenix:anuncios:blocks:v1';
const $ = id => document.getElementById(id);
const labels = { text:'Texto', title:'Título', image:'Imagen', gallery:'Galería', field:'Campo', separator:'Separador', button:'Botón' };
let blocks = [], csrf = '', stream = null, active = false, draftTimer = 0, savedUploadRefs = '[]';
function icon(name) {
  const values={up:'arrow_upward',down:'arrow_downward',remove:'delete',upload:'upload',history:'history'};
  const symbol=document.createElement('span');symbol.className='material-symbols-outlined icon';symbol.setAttribute('aria-hidden','true');symbol.textContent=values[name]||'extension';return symbol;
}
function notice(message) { $('notice').textContent=message||''; $('notice').hidden=!message; }
async function request(url, options={}) {
  const response=await fetch(url==='/api/me'?url:BASE+url,{...options,headers:{...(options.body&&!(options.body instanceof FormData)?{'Content-Type':'application/json'}:{}),'X-CSRF-Token':csrf,...options.headers}});
  const body=await response.text();let data;
  try{data=body?JSON.parse(body):{};}catch{throw Error(`El servidor o el proxy rechazó la solicitud (HTTP ${response.status}).`);}
  if(!response.ok)throw Error(data.error||`No se pudo completar la solicitud (HTTP ${response.status}).`);return data;
}
async function uploadImage(file,onProgress) {
  const {uploadId,chunkSize}=await request('/api/upload/start',{method:'POST',body:JSON.stringify({size:file.size})});
  try {
    for(let offset=0,index=0;offset<file.size;offset+=chunkSize,index++) {
      const form=new FormData();form.append('chunk',file.slice(offset,Math.min(offset+chunkSize,file.size)),'fragmento.bin');
      const progress=await request(`/api/upload/${uploadId}/chunk/${index}`,{method:'PUT',body:form});
      onProgress(progress.received,file.size);
    }
    return await request(`/api/upload/${uploadId}/complete`,{method:'POST',body:JSON.stringify({})});
  } catch(error) {
    await request(`/api/upload/${uploadId}/cancel`,{method:'POST',body:JSON.stringify({})}).catch(()=>{});
    throw error;
  }
}
function action(fn) { return async(...args)=>{try{await fn(...args);}catch(error){notice(error.message);}}; }
function currentUploadRefs() {
  const files=new Set();
  for(const block of blocks){const urls=block?.type==='image'?[block.url]:block?.type==='gallery'&&Array.isArray(block.images)?block.images:[];for(const url of urls){const match=typeof url==='string'&&/^\/uploads\/([a-f0-9]{32}\.(?:png|jpg|gif|webp))$/.exec(url);if(match)files.add(match[1]);}}
  return JSON.stringify([...files].sort());
}
function save() {
  clearTimeout(draftTimer);
  const refs=currentUploadRefs();
  draftTimer=setTimeout(()=>request('/api/draft',{method:'PUT',body:JSON.stringify({blocks,color:$('color').value})}).then(async()=>{
    if(refs!==savedUploadRefs){savedUploadRefs=refs;await loadUploads();}
  }).catch(error=>notice('No se pudo guardar el borrador: '+error.message)),450);
  $('confirmation').hidden=true;preview();
}
window.addEventListener('pagehide',()=>{
  clearTimeout(draftTimer);
  if(!csrf||!blocks.length)return;
  fetch(BASE+'/api/draft',{method:'PUT',keepalive:true,headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({blocks,color:$('color').value})}).catch(()=>{});
});
function input(block,key,label,multiline=false) {
  const element=document.createElement('label');element.className='field';element.textContent=label;
  const field=document.createElement(multiline?'textarea':'input');field.value=block[key]||'';
  if(!multiline)field.type=key==='url'?'url':'text';
  field.maxLength=key==='content'?(block.type==='title'?256:40000):key==='value'?1024:key==='name'?256:key==='label'?80:2048;
  field.oninput=()=>{block[key]=field.value;save();};element.append(field);return element;
}
function tool(name,label,run,disabled=false) {
  const button=document.createElement('button');button.type='button';button.className='icon-button'+(name==='remove'?' delete':'');
  button.setAttribute('aria-label',label);button.title=label;button.disabled=disabled;button.append(icon(name));button.onclick=action(run);return button;
}
function render() {
  $('blocks').replaceChildren();$('block-count').textContent=`${blocks.length} / 20 bloques`;$('add').disabled=blocks.length>=20;
  blocks.forEach((block,index)=>{
    const row=document.createElement('div');row.className='block';
    const heading=document.createElement('div'),number=document.createElement('span'),title=document.createElement('strong');
    heading.className='block-heading';number.className='block-number';number.textContent=String(index+1).padStart(2,'0');title.textContent=labels[block.type];
    heading.append(number,title,
      tool('up','Subir bloque '+(index+1),()=>{[blocks[index-1],blocks[index]]=[blocks[index],blocks[index-1]];render();save();},index===0),
      tool('down','Bajar bloque '+(index+1),()=>{[blocks[index+1],blocks[index]]=[blocks[index],blocks[index+1]];render();save();},index===blocks.length-1),
      tool('remove','Eliminar bloque '+(index+1),()=>{blocks.splice(index,1);render();save();}));
    const fields=document.createElement('div');fields.className='block-fields';
    if(['text','title'].includes(block.type))fields.append(input(block,'content',block.type==='title'?'Título':'Texto',block.type==='text'));
    if(block.type==='title')fields.append(input(block,'url','Enlace opcional'));
    if(block.type==='field')fields.append(input(block,'name','Nombre'),input(block,'value','Valor',true));
    if(block.type==='button')fields.append(input(block,'label','Etiqueta'),input(block,'url','Enlace'));
    if(block.type==='image')fields.append(input(block,'url','Enlace de imagen'));
    if(block.type==='gallery') {
      const field=document.createElement('label');field.className='field';field.textContent='Imágenes · una URL por línea';
      const area=document.createElement('textarea');area.value=(block.images||[]).join('\n');area.setAttribute('aria-label','URLs de la galería');
      area.oninput=()=>{block.images=area.value.split('\n').map(value=>value.trim()).filter(Boolean);save();};field.append(area);fields.append(field);
    }
    if(['image','gallery'].includes(block.type)) {
      const upload=document.createElement('label');upload.className='upload-control';const uploadLabel=document.createElement('span');uploadLabel.textContent=block.type==='gallery'?'Subir imágenes':'Subir imagen';upload.append(icon('upload'),uploadLabel);
      const file=document.createElement('input');file.type='file';file.className='visually-hidden';file.setAttribute('aria-label',block.type==='gallery'?'Subir imágenes':'Subir imagen');
      file.accept='image/png,image/jpeg,image/gif,image/webp';file.multiple=block.type==='gallery';
      file.onchange=action(async()=>{
        if(!file.files.length)return;
        if(block.type==='gallery'&&(block.images.length+file.files.length)>20)throw Error('Máximo 20 imágenes por galería y anuncio.');
        const selected=[...file.files];if(selected.some(item=>item.size>8*1048576))throw Error('Cada imagen debe pesar 8 MiB o menos.');
        upload.setAttribute('aria-busy','true');file.disabled=true;
        try{
          for(let i=0;i<selected.length;i++){
            uploadLabel.textContent=`Subiendo ${i+1}/${selected.length} · 0%`;
            const result=await uploadImage(selected[i],(received,total)=>{uploadLabel.textContent=`Subiendo ${i+1}/${selected.length} · ${Math.floor(received/total*100)}%`;});
            if(block.type==='image')block.url=result.files[0].url;else block.images=[...block.images,result.files[0].url];
            save();
          }
          render();await loadUploads();
        } finally {upload.removeAttribute('aria-busy');file.disabled=false;}
      });upload.append(file);fields.append(upload);
    }
    if(block.type==='separator') { const line=document.createElement('hr');line.className='separator-setting';fields.append(line); }
    row.append(heading,fields);$('blocks').append(row);
  });preview();
}
function safeUrl(value,image=false) {
  if(typeof value!=='string')return '';
  if(image&&/^\/uploads\/[a-f0-9]{32}\.(png|jpg|gif|webp)$/.test(value))return BASE+value;
  try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:'';}catch{return '';}
}
function updatePageEstimate() {
  const images=blocks.reduce((count,block)=>count+(block.type==='image'&&block.url?1:block.type==='gallery'?(block.images||[]).length:0),0);
  const text=blocks.reduce((count,block)=>count+(block.content||'').length+(block.name||'').length+(block.value||'').length,0);
  const pages=Math.max(1,Math.ceil(images/10),Math.ceil(text/3500));
  const estimate=$('page-estimate');if(!estimate)return;
  estimate.textContent=images>20?`⚠️ ${images} imágenes · máximo 20 por anuncio`:pages>2?`⚠️ contenido supera el máximo de 2 mensajes`:`${images} ${images===1?'imagen':'imágenes'} · estimado: ${pages} ${pages===1?'mensaje':'mensajes'}`;
  estimate.classList.toggle('warning',images>20||pages>2);
}
function preview() {
  const target=$('preview');target.replaceChildren();target.style.borderColor=$('color').value;
  for(const block of blocks) {
    if(block.type==='separator'){target.append(document.createElement('hr'));continue;}
    if(['image','gallery'].includes(block.type)) {
      const gallery=document.createElement('div');gallery.className=block.type==='gallery'?'gallery':'';
      for(const value of block.type==='image'?[block.url]:block.images||[]) {
        const url=safeUrl(value,true);if(!url)continue;const image=document.createElement('img');image.src=url;image.alt='Imagen del anuncio';image.referrerPolicy='no-referrer';image.onerror=()=>{const error=document.createElement('span');error.className='preview-image-error';error.textContent='Imagen no encontrada · vuelve a subirla';image.replaceWith(error);};gallery.append(image);
      }if(gallery.childElementCount)target.append(gallery);continue;
    }
    if(block.type==='button') {
      if(!block.label&&!block.url)continue;const link=document.createElement('a');link.className='preview-button';link.textContent=block.label||'Enlace';link.href=safeUrl(block.url)||'#';link.target='_blank';link.rel='noopener noreferrer';target.append(link);continue;
    }
    if(block.type==='field') {
      if(!block.name&&!block.value)continue;const element=document.createElement('p');element.className='preview-field';const name=document.createElement('strong');name.textContent=block.name;const value=document.createElement('span');value.textContent=block.value;element.append(name,value);target.append(element);continue;
    }
    if(!block.content)continue;const element=document.createElement(block.type==='title'?'h3':'p');
    if(block.type==='title'&&safeUrl(block.url)){const link=document.createElement('a');link.textContent=block.content;link.href=safeUrl(block.url);link.target='_blank';link.rel='noopener noreferrer';element.append(link);}else element.textContent=block.content;target.append(element);
  }
  if(!target.childElementCount){const empty=document.createElement('span');empty.className='preview-empty';empty.textContent='Sin contenido';target.append(empty);}updatePageEstimate();
}
function syncStatus(synced) { $('sync-state').textContent=synced?'Sincronizado':'Pendiente';$('sync-state').classList.toggle('ready',synced); }
async function loadUploads() {
  const info=await request('/api/uploads/info');$('uploads').textContent=info.count+' '+(info.count===1?'imagen':'imágenes');$('storage').replaceChildren();
  const label=document.createElement('span'),value=document.createElement('span');label.textContent='Almacenamiento';value.textContent=`${info.totalSizeMB} / ${info.quotaMB} MiB`;$('storage').append(label,value);
  const library=$('upload-library');library.replaceChildren();const localRefs=new Set(JSON.parse(currentUploadRefs()));
  if(!info.files.length){const empty=document.createElement('p');empty.className='library-empty';empty.textContent='No hay imágenes subidas.';library.append(empty);return;}
  for(const file of info.files){
    const card=document.createElement('div');card.className='upload-card';
    const image=document.createElement('img');image.src=BASE+'/uploads/'+encodeURIComponent(file.name);image.alt='';image.loading='lazy';
    const details=document.createElement('div');details.className='upload-details';const name=document.createElement('strong');name.textContent=file.name;
    const inDraft=file.inDraft||localRefs.has(file.name);
    const meta=document.createElement('span');meta.textContent=`${(file.bytes/1048576).toFixed(2)} MiB${inDraft?' · En un borrador':file.inUse?' · En un anuncio activo':''}`;details.append(name,meta);
    const remove=tool('remove','Eliminar imagen',async()=>{if(!window.confirm('¿Eliminar esta imagen de forma permanente?'))return;await request('/api/upload/'+encodeURIComponent(file.name),{method:'DELETE'});notice('Imagen eliminada.');await loadUploads();},inDraft||file.inUse);
    if(inDraft)remove.title='Quita la imagen de los borradores guardados antes de eliminarla';
    if(file.inUse)remove.title='La imagen está en un anuncio activo';
    card.append(image,details,remove);library.append(card);
  }
}
async function loadHistory() {
  const history=await request('/api/history');$('history').replaceChildren();
  if(!history.length){const empty=document.createElement('div');empty.className='history-empty';empty.append(icon('history'),document.createTextNode('Sin envíos'));$('history').append(empty);return;}
  const wrapper=document.createElement('div'),table=document.createElement('table'),head=document.createElement('thead'),row=document.createElement('tr'),body=document.createElement('tbody');wrapper.className='table-wrap';
  for(const value of ['Fecha','Estado','Enviados','Fallidos','Omitidos']){const cell=document.createElement('th');cell.scope='col';cell.textContent=value;row.append(cell);}head.append(row);
  for(const job of history){const row=document.createElement('tr');const date=document.createElement('td');date.textContent=job.date?new Date(job.date).toLocaleString('es',{dateStyle:'short',timeStyle:'short'}):'—';
    const state=document.createElement('td'),badge=document.createElement('span');badge.className='status-badge'+(job.status==='completed'?' ready':job.status==='failed'?' failed':'');badge.textContent=({completed:'Completado',cancelled:'Cancelado',interrupted:'Interrumpido',failed:'Fallido',sending:'En curso'}[job.status]||'—');state.append(badge);row.append(date,state);
    for(const value of [job.enviados||0,job.fallidos||0,job.omitidos||0]){const cell=document.createElement('td');cell.textContent=value;row.append(cell);}body.append(row);
  }table.append(head,body);wrapper.append(table);$('history').append(wrapper);
}
function follow(id) {
  stream?.close();active=true;$('send').disabled=true;$('progress').hidden=false;$('cancel').disabled=false;$('progress-status').textContent='En curso';
  stream=new EventSource(BASE+'/api/announcement/'+encodeURIComponent(id)+'/progress');
  stream.onmessage=event=>{const job=JSON.parse(event.data);$('bar').value=job.total?job.procesados/job.total*100:0;$('progress-text').textContent=`${job.procesados} / ${job.total} · ${job.enviados} enviados · ${job.fallidos} fallidos · ${job.omitidos} omitidos`;
    if(job.done){stream.close();active=false;$('send').disabled=false;$('cancel').disabled=true;$('progress-status').textContent=({completed:'Completado',cancelled:'Cancelado',failed:'Fallido',interrupted:'Interrumpido'}[job.status]||'Finalizado');notice(job.error||'Envío completado.');loadHistory().catch(error=>notice(error.message));}};
  stream.onerror=()=>{stream.close();active=false;$('send').disabled=false;notice('Conexión interrumpida. Actualiza el historial antes de reenviar.');};
}
function validateDraft(){
  if(!blocks.length||!blocks.some(block=>block.content?.trim()||block.name?.trim()||block.url||block.images?.length||block.label?.trim()))throw Error('El anuncio está vacío.');
  const images=blocks.reduce((count,block)=>count+(block.type==='image'&&block.url?1:block.type==='gallery'?(block.images||[]).length:0),0);if(images>20)throw Error('Máximo 20 imágenes por anuncio.');
  if(blocks.some(block=>block.type==='gallery'&&(!block.images.length||block.images.length>20)))throw Error('Cada galería admite de 1 a 20 imágenes.');
}
$('add').onclick=action(()=>{if(blocks.length>=20)throw Error('Máximo 20 bloques.');blocks.push({type:$('type').value,content:'',url:'',name:'',value:'',label:'',images:[]});render();save();});$('color').oninput=save;
$('test-send').onclick=action(async()=>{validateDraft();$('test-send').disabled=true;try{const result=await request('/api/announcement/test',{method:'POST',body:JSON.stringify({blocks,color:$('color').value})});notice(`Prueba enviada solo a tu cuenta (${result.pages} ${result.pages===1?'mensaje':'mensajes'}).`);}finally{$('test-send').disabled=false;}});
$('send').onclick=action(async()=>{notice('');const status=await request('/api/announcement/status');if(status.isSending){follow(status.active.sendId);return;}if(!status.synced)throw Error('Sincroniza el consentimiento antes de enviar.');if(status.cooldownRemaining)throw Error(`Próximo envío disponible en ${status.cooldownRemaining} s.`);validateDraft();$('confirm-text').textContent=`Se enviará a ${status.consentCount} suscriptores. Los mensajes enviados no se pueden retirar.`;$('confirmation').hidden=false;});
$('confirm').onclick=action(async()=>{if(active)return;$('confirm').disabled=true;try{const result=await request('/api/announcement',{method:'POST',body:JSON.stringify({blocks,color:$('color').value})});$('confirmation').hidden=true;follow(result.sendId);}finally{$('confirm').disabled=false;}});
$('back').onclick=()=>{$('confirmation').hidden=true;};$('cancel').onclick=action(async()=>{await request('/api/announcement/cancel',{method:'POST'});notice('Cancelando envío.');});
$('consent-form').onsubmit=action(async event=>{event.preventDefault();const button=$('save-consent');button.disabled=true;try{const result=await request('/api/config',{method:'PUT',body:JSON.stringify({channelId:$('consent-channel').value.trim(),messageId:$('consent-message').value.trim(),emoji:$('consent-emoji').value.trim()})});$('count').textContent=result.users;syncStatus(true);notice(`Mensaje de consentimiento actualizado. ${result.users} suscriptores sincronizados.`);await loadUploads();}finally{button.disabled=false;}});
$('sync').onclick=action(async()=>{$('sync').disabled=true;try{const result=await request('/api/sync',{method:'POST'});$('count').textContent=result.users;syncStatus(true);notice('Consentimiento sincronizado.');}finally{$('sync').disabled=false;}});
$('cleanup').onclick=action(async()=>{const result=await request('/api/uploads/cleanup-old',{method:'POST'});notice(`${result.removed} imágenes eliminadas.`);await loadUploads();});$('refresh').onclick=action(loadHistory);
(async()=>{
  try{
    const session=await request('/api/me');if(!session.loggedIn)throw Error('Sesión caducada. Vuelve a entrar al panel.');csrf=session.csrf;
    let stored=await request('/api/draft');
    if(!stored){
      try{stored=JSON.parse(localStorage.getItem(KEY)||'null');if(stored&&Array.isArray(stored.blocks))await request('/api/draft',{method:'PUT',body:JSON.stringify(stored)});}catch{}
    }
    try{localStorage.removeItem(KEY);}catch{}
    if(stored&&Array.isArray(stored.blocks))blocks=stored.blocks.filter(block=>block&&labels[block.type]).slice(0,20).map(block=>({...block,images:Array.isArray(block.images)?block.images.filter(value=>typeof value==='string'):[]}));
    if(/^#[a-f0-9]{6}$/i.test(stored?.color))$('color').value=stored.color;
    if(!blocks.length)blocks=[{type:'text',content:''}];savedUploadRefs=currentUploadRefs();render();
    const [consents,config,status]=await Promise.all([request('/api/consents'),request('/api/config'),request('/api/announcement/status')]);$('count').textContent=consents.total;syncStatus(consents.synced);
    $('consent-channel').value=config.channelId||'';$('consent-message').value=config.messageId||'';$('consent-emoji').value=config.emoji||'✅';
    for(const [label,value] of [['Canal',config.channelId],['Mensaje',config.messageId],['Reacción',config.emoji],['Rol',config.adminRoleId||'Administradores']]){const row=document.createElement('div'),term=document.createElement('dt'),detail=document.createElement('dd');row.className='config-row';term.textContent=label;detail.textContent=value||'—';row.append(term,detail);$('config').append(row);}
    if(status.active)follow(status.active.sendId);await Promise.all([loadHistory(),loadUploads()]);
  }catch(error){notice(error.message);$('send').disabled=true;}
})();
