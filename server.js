require('dotenv').config();
const express=require('express');
const session=require('express-session');
const path=require('path');
const fs=require('fs');
const helmet=require('helmet');
const rateLimit=require('express-rate-limit');
const multer=require('multer');
const {Client,GatewayIntentBits,EmbedBuilder}=require('discord.js');

const app=express();
const PORT=process.env.PORT||3000;
const upload=multer({dest:path.join(__dirname,'uploads'),limits:{fileSize:8*1024*1024}});
const client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMembers]});

const DATA=path.join(__dirname,'data');
const SETTINGS=path.join(DATA,'settings.json');
const USERS=path.join(DATA,'panel_users.json');
const SUBS=path.join(DATA,'subscribers.json');
const LOGS=path.join(DATA,'activity_logs.json');

if(!fs.existsSync(DATA)) fs.mkdirSync(DATA,{recursive:true});
function ensure(file,val){ if(!fs.existsSync(file)) fs.writeFileSync(file,JSON.stringify(val,null,2),'utf8'); }
ensure(SETTINGS,{appName:"DM Control Safe",developerDiscordId:"",monthlyPrice:9.99,currency:"EUR",siteDescription:"Safe member messaging panel",backgroundImageUrl:"",blurStrength:14,allowRoleMessagingOnly:true});
ensure(USERS,[{id:"1",email:process.env.OWNER_EMAIL||"owner@example.com",password:process.env.OWNER_PASSWORD||"ChangeMe123!",role:"owner",isActive:true}]);
ensure(SUBS,[]);
ensure(LOGS,[]);

const read=(f)=>JSON.parse(fs.readFileSync(f,'utf8'));
const write=(f,d)=>fs.writeFileSync(f,JSON.stringify(d,null,2),'utf8');
function addLog(entry){ const logs=read(LOGS); logs.unshift({id:String(Date.now()),time:new Date().toISOString(),...entry}); write(LOGS,logs.slice(0,1000)); }

app.set('view engine','ejs');
app.set('views',path.join(__dirname,'views'));
app.use('/static',express.static(path.join(__dirname,'public')));
app.use('/uploads',express.static(path.join(__dirname,'uploads')));
app.use(express.urlencoded({extended:true}));
app.use(express.json());
app.use(helmet({contentSecurityPolicy:false}));
app.use(session({secret:process.env.SESSION_SECRET||'change-this-session-secret',resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:'lax',secure:false,maxAge:1000*60*60*12}}));
app.use(rateLimit({windowMs:15*60*1000,max:400}));

function clean(v=''){ return String(v).trim(); }
function me(req){ return read(USERS).find(u=>u.id===req.session.userId)||null; }
function auth(req,res,next){ if(!req.session.userId) return res.redirect('/login'); next(); }
function ownerOrAdmin(req,res,next){ const u=me(req); if(!u||!['owner','admin'].includes(u.role)) return res.status(403).send('Forbidden'); next(); }
function owner(req,res,next){ const u=me(req); if(!u||u.role!=='owner') return res.status(403).send('Forbidden'); next(); }

async function developerProfile(){
  const settings=read(SETTINGS);
  const id=settings.developerDiscordId||process.env.DEVELOPER_DISCORD_ID||process.env.OWNER_DISCORD_ID||"";
  if(!id) return null;
  try{
    const u=await client.users.fetch(id);
    return {id:u.id,username:u.username,displayName:u.globalName||u.username,avatar:u.displayAvatarURL({size:256})};
  }catch{ return null; }
}
async function guildChoices(){
  return client.guilds.cache.map(g=>({id:g.id,name:g.name,members:g.memberCount||0})).sort((a,b)=>a.name.localeCompare(b.name));
}
async function guildData(gid){
  const guild=await client.guilds.fetch(gid);
  const members=await guild.members.fetch();
  const roles=guild.roles.cache.filter(r=>r.name!=='@everyone').sort((a,b)=>b.position-a.position).map(r=>({id:r.id,name:r.name,count:r.members.size}));
  const users=members.filter(m=>!m.user.bot).map(m=>({id:m.id,label:`${m.user.username} (${m.user.id})`})).sort((a,b)=>a.label.localeCompare(b.label));
  return {guild,roles,users};
}
async function sendSafe({actorEmail,guildId,targetType,roleId,singleUserId,multipleUserIds,plainText,useEmbed,title,description,color,imageUrl,footer}){
  const settings=read(SETTINGS);
  if(settings.allowRoleMessagingOnly && !['role','single','multiple'].includes(targetType)) throw new Error('الإرسال إلى الجميع غير متاح في هذه النسخة.');
  const guild=await client.guilds.fetch(guildId);
  const members=await guild.members.fetch();
  let targets=[];
  if(targetType==='single'&&singleUserId){ const m=members.get(singleUserId); if(m&&!m.user.bot) targets=[m]; }
  else if(targetType==='multiple'&&Array.isArray(multipleUserIds)){ targets=multipleUserIds.map(id=>members.get(id)).filter(Boolean).filter(m=>!m.user.bot); }
  else if(targetType==='role'&&roleId){ targets=members.filter(m=>!m.user.bot&&m.roles.cache.has(roleId)).map(m=>m); }
  else throw new Error('نوع الاستهداف غير صحيح');
  const payload={};
  if(useEmbed==='on'){
    const e=new EmbedBuilder().setColor(color||'#5865F2').setDescription(description||' ').setTimestamp();
    if(title) e.setTitle(title);
    if(footer) e.setFooter({text:footer});
    if(imageUrl) e.setImage(imageUrl);
    payload.embeds=[e];
    if(plainText) payload.content=plainText;
  }else payload.content=plainText||description||' ';
  let sent=0,failed=0,errors=[];
  for(const member of targets){
    try{ await member.send(payload); sent++; }catch(err){ failed++; errors.push(`${member.user.tag}: ${err.message}`); }
    await new Promise(r=>setTimeout(r,1200));
  }
  addLog({type:'message_send',actorEmail,guildId,targetType,roleId:roleId||'',singleUserId:singleUserId||'',multipleCount:Array.isArray(multipleUserIds)?multipleUserIds.length:0,sent,failed,title:title||'',plainTextPreview:(plainText||description||'').slice(0,160)});
  return {totalTargets:targets.length,sent,failed,errors:errors.slice(0,20)};
}

app.get('/login',(req,res)=>res.render('login',{error:null,settings:read(SETTINGS)}));
app.post('/login',rateLimit({windowMs:15*60*1000,max:25}),(req,res)=>{
  const email=clean(req.body.email).toLowerCase(), password=clean(req.body.password);
  const user=read(USERS).find(u=>clean(u.email).toLowerCase()===email && clean(u.password)===password && u.isActive);
  if(!user) return res.render('login',{error:'بيانات الدخول غير صحيحة.',settings:read(SETTINGS)});
  req.session.userId=user.id; addLog({type:'login',actorEmail:user.email,message:'Panel login success'}); res.redirect('/');
});
app.get('/logout',auth,(req,res)=>{ const u=me(req); if(u) addLog({type:'logout',actorEmail:u.email,message:'Panel logout'}); req.session.destroy(()=>res.redirect('/login')); });

app.get('/',auth,ownerOrAdmin,async (req,res)=>{
  const settings=read(SETTINGS), subs=read(SUBS), logs=read(LOGS).slice(0,30), users=read(USERS);
  res.render('dashboard',{currentUser:me(req),settings,guilds:await guildChoices(),subscribersCount:subs.filter(s=>s.active).length,subscribers:subs.slice(0,15),logs,users,developer:await developerProfile(),result:null});
});
app.get('/guild-data/:gid',auth,ownerOrAdmin,async (req,res)=>{
  try{ const d=await guildData(req.params.gid); res.json({ok:true,roles:d.roles,users:d.users,guildName:d.guild.name}); }
  catch(err){ res.status(500).json({ok:false,error:err.message}); }
});
app.post('/send',auth,ownerOrAdmin,upload.single('image'),async (req,res)=>{
  const currentUser=me(req), settings=read(SETTINGS), subs=read(SUBS), users=read(USERS);
  try{
    const imageUrl=req.file?`${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`:clean(req.body.imageUrl);
    const result=await sendSafe({actorEmail:currentUser.email,guildId:clean(req.body.guildId),targetType:clean(req.body.targetType),roleId:clean(req.body.roleId),singleUserId:clean(req.body.singleUserId),multipleUserIds:Array.isArray(req.body.multipleUserIds)?req.body.multipleUserIds:(req.body.multipleUserIds?[req.body.multipleUserIds]:[]),plainText:clean(req.body.plainText),useEmbed:req.body.useEmbed,title:clean(req.body.title),description:clean(req.body.description),color:clean(req.body.color||'#5865F2'),imageUrl,footer:clean(req.body.footer)});
    res.render('dashboard',{currentUser,settings,guilds:await guildChoices(),subscribersCount:subs.filter(s=>s.active).length,subscribers:subs.slice(0,15),logs:read(LOGS).slice(0,30),users,developer:await developerProfile(),result});
  }catch(err){
    res.render('dashboard',{currentUser,settings,guilds:await guildChoices(),subscribersCount:subs.filter(s=>s.active).length,subscribers:subs.slice(0,15),logs:read(LOGS).slice(0,30),users,developer:await developerProfile(),result:{error:err.message}});
  }
});
app.post('/settings',auth,owner,(req,res)=>{
  const s=read(SETTINGS);
  s.appName=clean(req.body.appName)||s.appName; s.siteDescription=clean(req.body.siteDescription)||s.siteDescription; s.monthlyPrice=Number(req.body.monthlyPrice||s.monthlyPrice); s.currency=clean(req.body.currency)||s.currency; s.backgroundImageUrl=clean(req.body.backgroundImageUrl); s.blurStrength=Number(req.body.blurStrength||s.blurStrength||14); s.developerDiscordId=clean(req.body.developerDiscordId); s.allowRoleMessagingOnly=req.body.allowRoleMessagingOnly==='on';
  write(SETTINGS,s); addLog({type:'settings_update',actorEmail:me(req).email,message:'Settings updated'}); res.redirect('/');
});
app.post('/users/add',auth,owner,(req,res)=>{ const u=read(USERS); u.push({id:String(Date.now()),email:clean(req.body.email).toLowerCase(),password:clean(req.body.password),role:clean(req.body.role)||'admin',isActive:true}); write(USERS,u); addLog({type:'panel_user_add',actorEmail:me(req).email,message:`Added panel user ${clean(req.body.email)}`}); res.redirect('/'); });
app.post('/users/toggle/:id',auth,owner,(req,res)=>{ const u=read(USERS); const t=u.find(x=>x.id===req.params.id); if(t) t.isActive=!t.isActive; write(USERS,u); addLog({type:'panel_user_toggle',actorEmail:me(req).email,message:`Toggled panel user ${t?t.email:req.params.id}`}); res.redirect('/'); });
app.post('/subscribers/add',auth,owner,(req,res)=>{ const s=read(SUBS); s.unshift({id:String(Date.now()),email:clean(req.body.email).toLowerCase(),name:clean(req.body.name),active:true,plan:'monthly',startedAt:new Date().toISOString()}); write(SUBS,s); addLog({type:'subscriber_add',actorEmail:me(req).email,message:`Added subscriber ${clean(req.body.email)}`}); res.redirect('/'); });
app.post('/subscribers/toggle/:id',auth,owner,(req,res)=>{ const s=read(SUBS); const t=s.find(x=>x.id===req.params.id); if(t) t.active=!t.active; write(SUBS,s); addLog({type:'subscriber_toggle',actorEmail:me(req).email,message:`Toggled subscriber ${t?t.email:req.params.id}`}); res.redirect('/'); });

client.once('ready',()=>console.log(`Bot ready as ${client.user.tag}`));
client.login(process.env.BOT_TOKEN);
app.listen(PORT,()=>console.log(`Panel: http://localhost:${PORT}`));
